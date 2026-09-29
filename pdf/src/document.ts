// A PDF file as an editable object graph (§7.5, §7.7). Objects load lazily from the source
// bytes on first access and are cached; edits happen in place on the returned objects (or
// through set/add/delete). Saving writes either a complete, renumbered file or an
// incremental update appended to the original bytes.

import { EncryptionError, StandardSecurityHandler } from './crypt/standard.ts';
import { flateEncode } from './filters/filters.ts';
import { N, PdfDict, PdfName, PdfRef, PdfStream, PdfString, dictOf, type PdfObject } from './core/objects.ts';
import { Parser, PdfSyntaxError } from './core/parser.ts';
import { ByteWriter, writeObject } from './core/serialize.ts';
import { findHeader, findStartXref, objectStreamIndex, readXref, reconstructXref, type XrefData, type XrefEntry } from './core/xref.ts';
import { decodeStream } from './filters/filters.ts';
import { PdfPage, INHERITABLE } from './page.ts';
import { EmbeddedFont, StandardFontResource, type PdfFont } from './write/fonts.ts';
import { embedImage, embedPixels, type PdfImage } from './write/images.ts';
import { readOutline, setOutline, type OutlineEntry, type OutlineItem } from './write/navigation.ts';

export class PdfError extends Error {}

export interface LoadOptions {
  /** User or owner password for encrypted documents (default: the empty password). */
  password?: string;
}

export interface SaveOptions {
  /** Append changes to the original bytes instead of rewriting the file (default false). */
  incremental?: boolean;
  /** Pack non-stream objects into compressed object streams (PDF 1.5+; default true for full saves). */
  objectStreams?: boolean;
  /** Flate-compress streams that have no filter (default true). */
  compress?: boolean;
}

interface ObjectStreamData {
  data: Uint8Array;
  first: number;
  index: [number, number][];
}

const EMPTY = new Uint8Array(0);

export class PdfDocument {
  /** Header version, raised by the catalog's /Version if that is newer. */
  version = '1.7';
  trailer: PdfDict;
  /** Problems worked around while reading (damaged xref, bad objects, ...). */
  readonly warnings: string[] = [];
  /** The xref was rebuilt by scanning the file. */
  recovered = false;
  /** Present when the source was encrypted (the in-memory document is decrypted). */
  readonly security?: StandardSecurityHandler;

  private readonly source: Uint8Array;
  private xref: XrefData;
  private readonly objects = new Map<number, PdfObject>();
  /** Objects replaced, added or deleted through the API (in-place edits are found by diffing). */
  private readonly touched = new Set<number>();
  private readonly deleted = new Set<number>();
  private readonly objectStreams = new Map<number, ObjectStreamData | null>();
  private readonly loading = new Set<number>();
  private encryptNum = -1;
  private nextNum: number;
  private pageList?: PdfPage[];
  private readonly beforeSave: (() => void)[] = [];
  private readonly standardFonts = new Map<string, StandardFontResource>();

  private constructor(source: Uint8Array, xref: XrefData) {
    this.source = source;
    this.xref = xref;
    this.trailer = xref.trailer;
    this.nextNum = Math.max(xref.trailer.number('Size') ?? 0, ...xref.entries.keys()) + 1;
  }

  // --- opening and creating -----------------------------------------------------------------

  static load(bytes: Uint8Array, options: LoadOptions = {}): PdfDocument {
    const source = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const header = findHeader(source);
    if (!header) throw new PdfError('not a PDF file (no %PDF- header)');
    let xref: XrefData;
    let warning: string | undefined;
    try {
      xref = readXref(source, findStartXref(source), header.offset);
    } catch (e) {
      warning = `xref unreadable (${(e as Error).message}); rebuilt by scanning`;
      xref = reconstructXref(source);
    }
    const doc = new PdfDocument(source, xref);
    doc.version = header.version;
    if (warning) {
      doc.recovered = true;
      doc.warnings.push(warning);
    }
    if (!(doc.resolve(doc.trailer.get('Root')) instanceof PdfDict)) doc.recover('trailer has no usable /Root');
    if (!(doc.resolve(doc.trailer.get('Root')) instanceof PdfDict)) doc.findCatalog();
    if (!(doc.resolve(doc.trailer.get('Root')) instanceof PdfDict)) throw new PdfError('no document catalog');

    const encrypt = doc.trailer.get('Encrypt');
    if (encrypt !== undefined && encrypt !== null) {
      if (encrypt instanceof PdfRef) doc.encryptNum = encrypt.num;
      const dict = doc.resolve(encrypt);
      if (!(dict instanceof PdfDict)) throw new EncryptionError('invalid /Encrypt dictionary');
      const id = doc.resolve(doc.trailer.get('ID'));
      const id0 = Array.isArray(id) && id[0] instanceof PdfString ? id[0].bytes : EMPTY;
      const handler = new StandardSecurityHandler(dict, id0, options.password ?? '', (o) => doc.resolve(o));
      (doc as { security?: StandardSecurityHandler }).security = handler;
      if (!handler.authenticated) doc.warn('embedded files are encrypted and stay so without the password');
      // Anything loaded before the handler existed (the catalog) must be reloaded decrypted.
      for (const num of [...doc.objects.keys()]) if (num !== doc.encryptNum) doc.objects.delete(num);
    }
    const catalogVersion = doc.catalog.name('Version');
    if (catalogVersion && /^\d\.\d$/.test(catalogVersion) && catalogVersion > doc.version) doc.version = catalogVersion;
    return doc;
  }

  /** A new document with an empty page tree. */
  static create(): PdfDocument {
    const doc = new PdfDocument(EMPTY, { entries: new Map([[0, { type: 0 }]]), trailer: new PdfDict(), startxref: -1, usesXrefStream: false });
    doc.nextNum = 1;
    const pages = doc.add(new PdfDict({ Type: N('Pages'), Kids: [], Count: 0 }));
    doc.trailer.set('Root', doc.add(new PdfDict({ Type: N('Catalog'), Pages: pages })));
    return doc;
  }

  // --- objects ------------------------------------------------------------------------------------

  /** The object with this reference (or number); null if missing or free. */
  get(ref: PdfRef | number): PdfObject {
    const num = typeof ref === 'number' ? ref : ref.num;
    const cached = this.objects.get(num);
    if (cached !== undefined) return cached;
    if (this.deleted.has(num)) return null;
    const obj = this.load(num);
    this.objects.set(num, obj);
    return obj;
  }

  /** Follows references (and chains of them). */
  resolve(o: PdfObject | undefined): PdfObject | undefined {
    for (let depth = 0; o instanceof PdfRef && depth < 32; depth++) o = this.get(o);
    return o instanceof PdfRef ? null : o;
  }

  /** Resolves to a dictionary (a stream's dictionary counts), or undefined. */
  dict(o: PdfObject | undefined): PdfDict | undefined {
    return dictOf(this.resolve(o));
  }

  /** Resolves to an array, or undefined. */
  array(o: PdfObject | undefined): PdfObject[] | undefined {
    const r = this.resolve(o);
    return Array.isArray(r) ? r : undefined;
  }

  /** Resolves to a number, or undefined. */
  number(o: PdfObject | undefined): number | undefined {
    const r = this.resolve(o);
    return typeof r === 'number' ? r : undefined;
  }

  /** Adds a new indirect object. */
  add(o: PdfObject): PdfRef {
    const ref = new PdfRef(this.nextNum++, 0);
    this.objects.set(ref.num, o);
    this.touched.add(ref.num);
    return ref;
  }

  /** Replaces an indirect object. */
  set(ref: PdfRef, o: PdfObject): void {
    this.objects.set(ref.num, o);
    this.deleted.delete(ref.num);
    this.touched.add(ref.num);
    this.pageList = undefined;
  }

  /** Frees an indirect object (references to it become null). */
  delete(ref: PdfRef): void {
    this.objects.delete(ref.num);
    this.deleted.add(ref.num);
    this.touched.add(ref.num);
    this.pageList = undefined;
  }

  /** Decoded stream data (filters applied up to any image codec). */
  streamData(o: PdfObject | undefined): Uint8Array {
    const s = this.resolve(o);
    if (!(s instanceof PdfStream)) return EMPTY;
    const r = decodeStream(s, (x) => this.resolve(x));
    if (r.error) this.warn(`stream data damaged (${r.error})`);
    return r.data;
  }

  /** Object numbers in use (loaded, added, or listed in the xref). */
  *objectNumbers(): IterableIterator<number> {
    const seen = new Set<number>();
    for (const [num, e] of this.xref.entries) {
      if (e.type !== 0 && !this.deleted.has(num)) {
        seen.add(num);
        yield num;
      }
    }
    for (const num of this.objects.keys()) if (!seen.has(num)) yield num;
  }

  private warn(message: string): void {
    if (this.warnings.length < 100) this.warnings.push(message);
  }

  private load(num: number): PdfObject {
    const entry = this.xref.entries.get(num);
    if (!entry || entry.type === 0) return null;
    if (this.loading.has(num)) return null; // cycle (e.g. a /Length that refers to its own stream)
    this.loading.add(num);
    try {
      return this.loadEntry(num, entry);
    } catch (e) {
      if (!(e instanceof PdfSyntaxError || e instanceof PdfError || e instanceof RangeError)) throw e;
      if (!this.recovered) {
        this.recover(`object ${num}: ${(e as Error).message}`);
        this.loading.delete(num);
        return this.load(num);
      }
      this.warn(`object ${num} unreadable: ${(e as Error).message}`);
      return null;
    } finally {
      this.loading.delete(num);
    }
  }

  private loadEntry(num: number, entry: XrefEntry): PdfObject {
    if (entry.type === 1) {
      const parser = new Parser(this.source, entry.offset, { resolveLength: (ref) => this.number(ref) });
      const r = parser.parseIndirect();
      if (r.num !== num) throw new PdfError(`xref points object ${num} at object ${r.num}`);
      if (this.security && num !== this.encryptNum) return this.security.decryptObject(r.object, num, r.gen);
      return r.object;
    }
    if (entry.type === 2) {
      const stm = this.objectStream(entry.stream);
      if (!stm) return null;
      let slot = stm.index[entry.index];
      if (!slot || slot[0] !== num) slot = stm.index.find(([n]) => n === num) ?? slot;
      if (!slot) return null;
      return new Parser(stm.data, stm.first + slot[1]).parseObject();
    }
    return null;
  }

  private objectStream(num: number): ObjectStreamData | null {
    let s = this.objectStreams.get(num);
    if (s !== undefined) return s;
    const stream = this.get(num);
    s = null;
    if (stream instanceof PdfStream) {
      const data = this.streamData(stream);
      s = { data, first: this.number(stream.dict.get('First')) ?? 0, index: objectStreamIndex(stream, data) };
    }
    this.objectStreams.set(num, s);
    return s;
  }

  /** Rebuilds the xref by scanning; objects already loaded stay as they are. */
  private recover(reason: string): void {
    if (this.recovered || !this.source.length) return;
    this.recovered = true;
    this.warn(`${reason}; xref rebuilt by scanning`);
    const rebuilt = reconstructXref(this.source);
    for (const [num, e] of rebuilt.entries) this.xref.entries.set(num, e);
    this.objectStreams.clear();
    // Objects that failed to load before are worth another try with the rebuilt table.
    for (const [num, o] of this.objects) if (o === null && !this.touched.has(num)) this.objects.delete(num);
    const rootOk = this.resolve(this.trailer.get('Root')) instanceof PdfDict;
    for (const [k, v] of rebuilt.trailer) if (!this.trailer.has(k) || (k === 'Root' && !rootOk)) this.trailer.set(k, v);
    this.nextNum = Math.max(this.nextNum, ...this.xref.entries.keys()) + 1;
  }

  /** Last resort for a missing /Root: the last object that looks like a catalog. */
  private findCatalog(): void {
    let found: number | undefined;
    for (const num of this.objectNumbers()) {
      const d = this.dict(this.get(num));
      if (d?.name('Type') === 'Catalog' && d.has('Pages')) found = num;
    }
    if (found !== undefined) {
      const e = this.xref.entries.get(found);
      this.trailer.set('Root', new PdfRef(found, e?.type === 1 ? e.gen : 0));
    }
  }

  // --- document structure ---------------------------------------------------------------------

  get catalog(): PdfDict {
    const c = this.dict(this.trailer.get('Root'));
    if (!c) throw new PdfError('no document catalog');
    return c;
  }

  /** The document information dictionary, created on demand if `create` is set. */
  info(create = false): PdfDict | undefined {
    const i = this.dict(this.trailer.get('Info'));
    if (i || !create) return i;
    const d = new PdfDict();
    this.trailer.set('Info', this.add(d));
    return d;
  }

  /** Metadata from the information dictionary (Title, Author, Subject, Keywords, Creator, Producer). */
  getMetadata(key: string): string | undefined {
    const v = this.resolve(this.info()?.get(key));
    return v instanceof PdfString ? v.text : undefined;
  }

  setMetadata(key: string, value: string | Date | undefined): void {
    const info = this.info(true)!;
    info.set(key, value === undefined ? undefined : value instanceof Date ? PdfString.text(formatDate(value)) : PdfString.text(value));
  }

  get pages(): PdfPage[] {
    if (!this.pageList) this.pageList = this.collectPages();
    return this.pageList;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  private collectPages(): PdfPage[] {
    const out: PdfPage[] = [];
    const root = this.catalog.get('Pages');
    const visited = new Set<number>();
    const walk = (node: PdfObject | undefined, depth: number) => {
      if (depth > 64) return;
      if (node instanceof PdfRef) {
        if (visited.has(node.num)) return;
        visited.add(node.num);
      }
      const d = this.dict(node);
      if (!d) return;
      const kids = this.array(d.get('Kids'));
      if (d.name('Type') === 'Pages' || (kids && d.name('Type') !== 'Page')) {
        for (const k of kids ?? []) walk(k, depth + 1);
      } else if (node instanceof PdfRef) {
        out.push(new PdfPage(this, node, d));
      } else {
        // A page written directly inside Kids: make it indirect so it can be referenced.
        const ref = this.add(d);
        out.push(new PdfPage(this, ref, d));
      }
    };
    walk(root, 0);
    return out;
  }

  /** Invalidates the cached page list (after editing the page tree by hand). */
  invalidatePages(): void {
    this.pageList = undefined;
  }

  /** Adds a page (default US Letter) at `index` (default: the end). */
  addPage(size: [number, number] = [612, 792], index = this.pages.length): PdfPage {
    const dict = new PdfDict({ Type: N('Page'), MediaBox: [0, 0, size[0], size[1]], Resources: new PdfDict() });
    return this.insertPageDict(this.add(dict), dict, index);
  }

  private insertPageDict(ref: PdfRef, dict: PdfDict, index: number): PdfPage {
    const pages = this.pages;
    index = Math.max(0, Math.min(index, pages.length));
    let parentRef: PdfRef;
    let at: number;
    if (pages.length === 0) {
      parentRef = this.pagesRoot();
      at = this.array(this.dict(parentRef)!.get('Kids'))?.length ?? 0;
    } else {
      const neighbor = pages[index < pages.length ? index : pages.length - 1];
      const p = neighbor.dict.get('Parent');
      if (!(p instanceof PdfRef)) throw new PdfError('page without /Parent');
      parentRef = p;
      const kids = this.array(this.dict(p)?.get('Kids')) ?? [];
      const pos = kids.findIndex((k) => neighbor.ref.equals(k));
      at = index < pages.length ? pos : pos + 1;
    }
    const parent = this.dict(parentRef)!;
    let kids = this.array(parent.get('Kids'));
    if (!kids) parent.set('Kids', (kids = []));
    kids.splice(at, 0, ref);
    dict.set('Parent', parentRef);
    this.adjustCounts(parentRef, 1);
    this.pageList = undefined;
    return this.pages[index];
  }

  /** The root /Pages node, which must be indirect for kids to point back at it. */
  private pagesRoot(): PdfRef {
    const p = this.catalog.get('Pages');
    if (p instanceof PdfRef && this.dict(p)) return p;
    const d = this.dict(p) ?? new PdfDict({ Type: N('Pages'), Kids: [], Count: 0 });
    const ref = this.add(d);
    this.catalog.set('Pages', ref);
    return ref;
  }

  private adjustCounts(node: PdfObject | undefined, delta: number): void {
    const seen = new Set<number>();
    while (node instanceof PdfRef && !seen.has(node.num)) {
      seen.add(node.num);
      const d = this.dict(node);
      if (!d) return;
      d.set('Count', (this.number(d.get('Count')) ?? 0) + delta);
      node = d.get('Parent');
    }
  }

  /** Removes the page at `index` from the page tree (its objects are dropped on a full save). */
  removePage(index: number): void {
    const page = this.pages[index];
    if (!page) throw new RangeError(`no page ${index}`);
    const parentRef = page.dict.get('Parent');
    const kids = this.array(this.dict(parentRef)?.get('Kids'));
    const pos = kids?.findIndex((k) => page.ref.equals(k)) ?? -1;
    if (!kids || pos < 0) throw new PdfError('page not found in its parent');
    kids.splice(pos, 1);
    this.adjustCounts(parentRef, -1);
    this.pageList = undefined;
  }

  /** Moves a page to a new position. */
  movePage(from: number, to: number): void {
    const page = this.pages[from];
    if (!page) throw new RangeError(`no page ${from}`);
    page.materializeInherited();
    this.removePage(from);
    this.insertPageDict(page.ref, page.dict, to);
  }

  /**
   * Copies pages from another document (or this one) into this document, with everything
   * they reference. Links to pages that aren't copied become null.
   */
  copyPages(source: PdfDocument, indices: number[] = source.pages.map((_, i) => i), at = this.pages.length): PdfPage[] {
    const map = new Map<string, PdfRef>();
    const srcPages = indices.map((i) => {
      const p = source.pages[i];
      if (!p) throw new RangeError(`no page ${i}`);
      return p;
    });
    const targets = srcPages.map((p) => {
      const ref = new PdfRef(this.nextNum++, 0);
      map.set(p.ref.key, ref);
      return ref;
    });
    const copier = new ObjectCopier(source, this, map);
    const out: PdfPage[] = [];
    srcPages.forEach((p, i) => {
      const dict = p.dict.clone();
      for (const key of INHERITABLE) if (!dict.has(key)) {
        const v = p.inherited(key);
        if (v !== undefined) dict.set(key, v);
      }
      dict.delete('Parent');
      const copy = copier.copy(dict) as PdfDict;
      this.objects.set(targets[i].num, copy);
      this.touched.add(targets[i].num);
      out.push(this.insertPageDict(targets[i], copy, at + i));
    });
    return out;
  }

  // --- resources for writing -------------------------------------------------------------------

  /**
   * One of the 14 standard fonts (Helvetica, Times-Roman, Courier, their bold/italic faces,
   * Symbol, ZapfDingbats). Not embedded; WinAnsi encoded, so it covers Latin-1 and the
   * Windows-1252 extras only. Common aliases (Arial, TimesNewRoman, ...) are accepted.
   */
  standardFont(name: string): PdfFont {
    let f = this.standardFonts.get(name);
    if (!f) {
      f = new StandardFontResource(this, name);
      this.standardFonts.set(name, f);
    }
    return f;
  }

  /** Embeds a TrueType or OpenType font; TrueType outlines are subset to the glyphs used when saving. */
  embedFont(bytes: Uint8Array): EmbeddedFont {
    return new EmbeddedFont(this, bytes);
  }

  /** Embeds a JPEG or PNG. */
  embedImage(bytes: Uint8Array): PdfImage {
    return embedImage(this, bytes);
  }

  /** Embeds raw 8-bit pixels (gray, RGB, or RGBA with the alpha as a soft mask). */
  embedPixels(pixels: { width: number; height: number; channels: 1 | 3 | 4; data: Uint8Array }): PdfImage {
    return embedPixels(this, pixels);
  }

  /** The document outline (bookmarks). */
  get outline(): OutlineEntry[] {
    return readOutline(this);
  }

  /** Replaces the document outline. */
  setOutline(items: OutlineItem[]): void {
    setOutline(this, items);
  }

  // --- saving ------------------------------------------------------------------------------------

  /** Registers work to run before every save (embedded fonts write their subsets). */
  onBeforeSave(fn: () => void): void {
    this.beforeSave.push(fn);
  }

  async save(options: SaveOptions = {}): Promise<Uint8Array> {
    for (const fn of this.beforeSave) fn();
    return options.incremental ? this.saveIncremental(options) : this.saveFull(options);
  }

  private async saveFull(options: SaveOptions): Promise<Uint8Array> {
    const compress = options.compress ?? true;
    const useObjStm = options.objectStreams ?? true;

    // Renumber everything reachable from the trailer, in discovery order.
    const numbers = new Map<number, number>();
    const order: PdfObject[] = [];
    const queue: PdfObject[] = [];
    const visitRef = (ref: PdfRef): PdfRef => {
      let n = numbers.get(ref.num);
      if (n === undefined) {
        n = order.length + 1;
        numbers.set(ref.num, n);
        const obj = this.get(ref);
        order.push(obj);
        queue.push(obj);
      }
      return new PdfRef(n, 0);
    };
    const trailer = new PdfDict();
    for (const key of ['Root', 'Info']) {
      const v = this.trailer.get(key);
      if (v instanceof PdfRef) trailer.set(key, visitRef(v));
      else if (v instanceof PdfDict) {
        const ref = this.add(v);
        this.trailer.set(key, ref);
        trailer.set(key, visitRef(ref));
      }
    }
    const scan = (o: PdfObject) => {
      if (o instanceof PdfRef) visitRef(o);
      else if (Array.isArray(o)) o.forEach(scan);
      else if (o instanceof PdfDict) for (const v of o.entries.values()) scan(v);
      else if (o instanceof PdfStream) for (const v of o.dict.entries.values()) scan(v);
    };
    for (let q = 0; q < queue.length; q++) scan(queue[q]); // (shift() would be quadratic)
    const mapRef = (r: PdfRef) => new PdfRef(numbers.get(r.num) ?? 0, 0);

    // Streams (compressed as needed), then everything else in object streams or plain.
    const encoded = await Promise.all(order.map((o) => (o instanceof PdfStream ? this.encodeForSave(o, compress) : null)));
    let version = this.version;
    const w = new ByteWriter();
    const offsets: XrefRows = new Map([[0, { type: 0, a: 0, b: 65535 }]]);
    const packable: number[] = [];
    const writeIndirect = (num: number, obj: PdfObject) => {
      offsets.set(num, { type: 1, a: w.length, b: 0 });
      w.text(`${num} 0 obj\n`);
      writeObject(w, obj, { mapRef });
      w.text('\nendobj\n');
    };
    if (useObjStm && version < '1.5') version = '1.5';
    w.text(`%PDF-${version}\n%\xe2\xe3\xcf\xd3\n`);
    order.forEach((obj, i) => {
      const num = i + 1;
      const enc = encoded[i];
      if (enc) writeIndirect(num, enc);
      else if (useObjStm) packable.push(num);
      else writeIndirect(num, obj);
    });

    let nextNum = order.length + 1;
    if (useObjStm) {
      for (let start = 0; start < packable.length; start += 200) {
        const chunk = packable.slice(start, start + 200);
        const body = new ByteWriter();
        const header: string[] = [];
        chunk.forEach((num, index) => {
          header.push(`${num} ${body.length}`);
          writeObject(body, order[num - 1], { mapRef });
          body.byte(0x0a);
          offsets.set(num, { type: 2, a: nextNum, b: index });
        });
        const head = header.join(' ') + '\n';
        const data = new Uint8Array(head.length + body.length);
        for (let i = 0; i < head.length; i++) data[i] = head.charCodeAt(i);
        data.set(body.data, head.length);
        const dict = new PdfDict({ Type: N('ObjStm'), N: chunk.length, First: head.length });
        const stm = compress ? new PdfStream(dict.set('Filter', N('FlateDecode')), await flateEncode(data)) : new PdfStream(dict, data);
        writeIndirect(nextNum++, stm);
      }
    }

    trailer.set('ID', this.newId());
    if (useObjStm) await this.writeXrefStream(w, offsets, nextNum, trailer, compress);
    else this.writeXrefTable(w, offsets, trailer, 0);
    return w.data.slice();
  }

  /** A stream as it will be written: compressed if it has no filter and compression helps. */
  private async encodeForSave(s: PdfStream, compress: boolean): Promise<PdfStream> {
    if (!compress || s.dict.has('Filter') || s.data.length < 32) return s;
    const data = await flateEncode(s.data);
    if (data.length >= s.data.length) return s;
    const dict = s.dict.clone();
    dict.delete('DecodeParms');
    dict.set('Filter', N('FlateDecode'));
    return new PdfStream(dict, data);
  }

  private newId(): PdfObject[] {
    const random = crypto.getRandomValues(new Uint8Array(16));
    const old = this.resolve(this.trailer.get('ID'));
    const first = Array.isArray(old) && old[0] instanceof PdfString ? old[0] : new PdfString(random, true);
    return [new PdfString(first.bytes, true), new PdfString(random, true)];
  }

  private writeXrefTable(w: ByteWriter, rows: XrefRows, trailer: PdfDict, size: number, prev?: number): void {
    const start = w.length;
    w.text('xref\n');
    for (const [first, run] of subsections(rows)) {
      w.text(`${first} ${run.length}\n`);
      for (const r of run) w.text(`${String(r.a).padStart(10, '0')} ${String(r.b).padStart(5, '0')} ${r.type === 1 ? 'n' : 'f'}\r\n`);
    }
    const t = trailer.clone();
    t.set('Size', Math.max(size, maxKey(rows) + 1));
    if (prev !== undefined) t.set('Prev', prev);
    w.text('trailer\n');
    writeObject(w, t);
    w.text(`\nstartxref\n${start}\n%%EOF\n`);
  }

  private async writeXrefStream(w: ByteWriter, rows: XrefRows, selfNum: number, trailer: PdfDict, compress: boolean, prev?: number): Promise<void> {
    const start = w.length;
    rows.set(selfNum, { type: 1, a: start, b: 0 });
    const size = Math.max(maxKey(rows) + 1, trailer.number('Size') ?? 0);
    let maxA = 0;
    let maxB = 0;
    for (const r of rows.values()) {
      maxA = Math.max(maxA, r.a);
      maxB = Math.max(maxB, r.b);
    }
    const aBytes = Math.max(1, Math.ceil(Math.log2(maxA + 1) / 8));
    const bBytes = Math.max(1, Math.ceil(Math.log2(maxB + 1) / 8));
    const index: number[] = [];
    const data: number[] = [];
    for (const [first, run] of subsections(rows)) {
      index.push(first, run.length);
      for (const r of run) {
        data.push(r.type);
        for (let b = aBytes - 1; b >= 0; b--) data.push(Math.floor(r.a / 256 ** b) & 0xff);
        for (let b = bBytes - 1; b >= 0; b--) data.push(Math.floor(r.b / 256 ** b) & 0xff);
      }
    }
    const dict = trailer.clone();
    dict.set('Type', N('XRef')).set('Size', size).set('W', [1, aBytes, bBytes]).set('Index', index);
    if (prev !== undefined) dict.set('Prev', prev);
    let bytes: Uint8Array = Uint8Array.from(data);
    if (compress) {
      bytes = await flateEncode(bytes);
      dict.set('Filter', N('FlateDecode'));
    }
    w.text(`${selfNum} 0 obj\n`);
    writeObject(w, new PdfStream(dict, bytes));
    w.text(`\nendobj\nstartxref\n${start}\n%%EOF\n`);
  }

  private async saveIncremental(options: SaveOptions): Promise<Uint8Array> {
    if (!this.source.length) return this.saveFull(options);
    if (this.security) throw new EncryptionError('incremental save of an encrypted document is not supported; save in full (unencrypted)');
    const compress = options.compress ?? true;
    const changed = new Set<number>();
    for (const num of this.touched) changed.add(num);
    for (const [num, obj] of this.objects) {
      if (changed.has(num)) continue;
      if (!deepEqual(obj, this.loadOriginal(num))) changed.add(num);
    }
    const w = new ByteWriter();
    w.bytes(this.source);
    const last = this.source[this.source.length - 1];
    if (last !== 10 && last !== 13) w.byte(0x0a);
    if (!changed.size && !this.recovered) return w.data.slice();

    const rows: XrefRows = new Map();
    const genOf = (num: number) => {
      const e = this.xref.entries.get(num);
      return e?.type === 1 ? e.gen : 0;
    };
    for (const num of [...changed].sort((a, b) => a - b)) {
      if (this.deleted.has(num)) {
        rows.set(num, { type: 0, a: 0, b: Math.min(65535, genOf(num) + 1) });
        continue;
      }
      let obj = this.objects.get(num) ?? null;
      if (obj instanceof PdfStream) obj = await this.encodeForSave(obj, compress);
      const gen = genOf(num);
      rows.set(num, { type: 1, a: w.length, b: gen });
      w.text(`${num} ${gen} obj\n`);
      writeObject(w, obj);
      w.text('\nendobj\n');
    }
    const trailer = new PdfDict([...this.trailer].filter(([k]) => ['Root', 'Info', 'ID'].includes(k)));
    trailer.set('ID', this.newId());
    const prev = this.xref.startxref;
    if (this.recovered || prev < 0) {
      // The original xref can't be chained to: write a complete one for the whole file.
      for (const num of this.objectNumbers()) {
        if (rows.has(num)) continue;
        const e = this.xref.entries.get(num);
        if (e?.type === 1) rows.set(num, { type: 1, a: e.offset, b: e.gen });
        else if (e?.type === 2) rows.set(num, { type: 2, a: e.stream, b: e.index });
      }
      rows.set(0, { type: 0, a: 0, b: 65535 });
      const selfNum = this.nextNum++;
      await this.writeXrefStream(w, rows, selfNum, trailer, compress);
      return w.data.slice();
    }
    const size = Math.max(this.nextNum, this.trailer.number('Size') ?? 0);
    if (this.xref.usesXrefStream) {
      const selfNum = this.nextNum++;
      trailer.set('Size', size + 1);
      await this.writeXrefStream(w, rows, selfNum, trailer, compress, prev);
    } else this.writeXrefTable(w, rows, trailer, size, prev);
    return w.data.slice();
  }

  /** Re-parses an object's original definition, bypassing the cache. */
  private loadOriginal(num: number): PdfObject | undefined {
    const e = this.xref.entries.get(num);
    if (!e || e.type === 0) return undefined;
    try {
      return this.loadEntry(num, e);
    } catch {
      return undefined;
    }
  }
}

interface XrefRow {
  type: 0 | 1 | 2;
  a: number;
  b: number;
}

/** Cross-reference rows by object number (sparse: object numbers can be huge). */
type XrefRows = Map<number, XrefRow>;

/** Runs of consecutive object numbers, as xref subsections. */
function subsections(rows: XrefRows): [number, XrefRow[]][] {
  const out: [number, XrefRow[]][] = [];
  let expect = -1;
  for (const num of [...rows.keys()].sort((a, b) => a - b)) {
    if (num !== expect) out.push([num, []]);
    out[out.length - 1][1].push(rows.get(num)!);
    expect = num + 1;
  }
  return out;
}

function maxKey(rows: XrefRows): number {
  let m = 0;
  for (const k of rows.keys()) m = Math.max(m, k);
  return m;
}

/** Deep-copies objects between documents, following references. */
class ObjectCopier {
  constructor(
    readonly from: PdfDocument,
    readonly to: PdfDocument,
    readonly map: Map<string, PdfRef>,
  ) {}

  copy(o: PdfObject): PdfObject {
    if (o instanceof PdfRef) {
      const known = this.map.get(o.key);
      if (known) return known;
      const target = this.from.get(o);
      const d = dictOf(target);
      // Other pages (and the page tree) aren't pulled in through links or annotations.
      const type = d?.name('Type');
      if (type === 'Page' || type === 'Pages' || type === 'Catalog') return null;
      const ref = this.to.add(null);
      this.map.set(o.key, ref);
      this.to.set(ref, this.copy(target));
      return ref;
    }
    if (Array.isArray(o)) return o.map((x) => this.copy(x));
    if (o instanceof PdfDict) {
      const d = new PdfDict();
      for (const [k, v] of o) d.set(k, this.copy(v));
      return d;
    }
    if (o instanceof PdfStream) return new PdfStream(this.copy(o.dict) as PdfDict, o.data);
    return o;
  }
}

/** Structural equality (names by identity, strings and stream data by bytes). */
export function deepEqual(a: PdfObject | undefined, b: PdfObject | undefined): boolean {
  if (a === b) return true;
  if (a instanceof PdfRef) return a.equals(b);
  if (a instanceof PdfString) return b instanceof PdfString && bytesEqual(a.bytes, b.bytes);
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (a instanceof PdfDict) {
    if (!(b instanceof PdfDict) || a.size !== b.size) return false;
    for (const [k, v] of a) if (!deepEqual(v, b.get(k))) return false;
    return true;
  }
  if (a instanceof PdfStream) {
    if (!(b instanceof PdfStream) || !bytesEqual(a.data, b.data)) return false;
    // /Length is rewritten on save; compare the rest.
    const da = a.dict.clone();
    const db = b.dict.clone();
    da.delete('Length');
    db.delete('Length');
    return deepEqual(da, db);
  }
  if (typeof a === 'number' && typeof b === 'number') return a === b || (Number.isNaN(a) && Number.isNaN(b));
  return a instanceof PdfName && b instanceof PdfName ? a === b : false;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Formats a date as a PDF date string (§7.9.4): D:YYYYMMDDHHmmSS+HH'mm'. */
export function formatDate(d: Date): string {
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const tz = off === 0 ? 'Z' : `${off > 0 ? '+' : '-'}${pad(Math.trunc(off / 60))}'${pad(off % 60)}'`;
  return `D:${pad(d.getFullYear(), 4)}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${tz}`;
}

/** Parses a PDF date string; undefined if it isn't one. */
export function parseDate(s: string): Date | undefined {
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?'?/.exec(s.trim());
  if (!m) return undefined;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', sign, th = '00', tm = '00'] = m;
  let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  if (sign === '+' || sign === '-') ms -= (sign === '+' ? 1 : -1) * (+th * 60 + +tm) * 60000;
  else if (!sign) ms = new Date(+y, +mo - 1, +d, +h, +mi, +se).getTime(); // no zone: local time
  return new Date(ms);
}
