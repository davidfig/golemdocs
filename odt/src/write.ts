// WordDocument (+ OdtExtension) -> ODT: an ODF 1.3 package.
//
// Styles: Word paragraph and character styles become common styles (Word's built-in ids get
// LibreOffice's built-in names, see names.ts); document defaults become the paragraph default
// style. Direct paragraph formatting becomes automatic paragraph styles (P1...), direct run
// formatting automatic text styles (T1...), numbering definitions list styles (L1..., one
// per numbering instance in use). Styles used by headers and footers live in styles.xml with
// an "M" prefix, as the format requires.
//
// Every paragraph gets xml:id="para-<paragraph id>", which readOdt turns back into the same
// paragraph id, so extension anchors survive ODT round trips.
//
// Extension content is restored where its anchors still exist: annotations, bookmarks, fields
// and inline objects at their paragraph offsets, block objects after their paragraph, sections
// and indexes around their first..last paragraphs, frames around their pictures.

import {
  isMathInline,
  paragraphLength,
  paragraphText,
  parseXml,
  readMathInline,
  serializeXml,
  StyleResolver,
  toLatex,
  writeZip,
  type Block,
  type Comment,
  type Border,
  type Drawing,
  type Hyperlink,
  type Inline,
  type NumberingLevel,
  type Paragraph,
  type ParagraphProperties,
  type RunContent,
  type RunProperties,
  type Style,
  type Table,
  type TableCell,
  type TableProperties,
  type TableRow,
  type WordDocument,
  type XmlElement,
  type XmlNode,
} from '@golemdocs/docx';
import type { OdtExtension, OdtFragment, OdtImageFrame, OdtObject, OdtProperties } from './extension.ts';
import { odfStyleName } from './names.ts';
import {
  MANIFEST_NS,
  MIME_TEXT,
  ODF_NS,
  ODF_VERSION,
  descendants,
  el,
  fromBase64,
  mediaTypeFor,
  normalizeNamespaces,
  percent,
  twipsToLength,
} from './odf.ts';
import { writeCellProperties, writeParagraphProperties, writeTextProperties } from './properties.ts';

const ID_ATTR = 'w14:paraId';
const encoder = new TextEncoder();

export async function writeOdt(document: WordDocument, extension?: OdtExtension): Promise<Uint8Array> {
  const writer = new Writer(document, extension ?? { version: 1 }, await loadPictures(document));
  return writer.write();
}

/** Automatic styles of one part, deduplicated by content. */
class AutoStyles {
  readonly elements: XmlElement[] = [];
  private readonly byKey = new Map<string, string>();
  private readonly counters = new Map<string, number>();
  /** Numbering instance -> list style name. */
  readonly lists = new Map<number, string>();

  constructor(readonly prefix: string) {}

  private next(kind: string): string {
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    return `${this.prefix}${kind}${n}`;
  }

  /** Adds a style (an element without style:name) and returns its name. */
  add(kind: string, style: XmlElement): string {
    const key = `${kind}\u0000${serializeXml(style, false)}`;
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const name = this.next(kind);
    style.attrs = { 'style:name': name, ...style.attrs };
    this.elements.push(style);
    this.byKey.set(key, name);
    return name;
  }

  /** Adds preserved automatic styles under fresh names; returns old name -> new name. */
  preserve(styles: string[]): Map<string, string> {
    const renames = new Map<string, string>();
    const parsed: XmlElement[] = [];
    for (const source of styles) {
      const e = parseFragment(source);
      const name = e?.attrs['style:name'];
      if (!e || !name) continue;
      if (!renames.has(name)) renames.set(name, this.next('X'));
      e.attrs['style:name'] = renames.get(name)!;
      parsed.push(e);
    }
    for (const e of parsed) {
      renameStyleReferences(e, renames);
      this.elements.push(e);
    }
    return renames;
  }
}

function renameStyleReferences(root: XmlElement, renames: Map<string, string>): void {
  if (!renames.size) return;
  for (const e of descendants(root)) {
    for (const key of Object.keys(e.attrs)) {
      if (key.endsWith('style-name') && key !== 'style:parent-style-name' && renames.has(e.attrs[key])) e.attrs[key] = renames.get(e.attrs[key])!;
    }
  }
}

function parseFragment(xml: string): XmlElement | undefined {
  try {
    const e = parseXml(xml);
    normalizeNamespaces(e);
    return e;
  } catch {
    return undefined;
  }
}

/** Something to insert at an offset in a paragraph. */
interface Insertion {
  offset: number;
  /** Ends before starts at the same offset. */
  rank: number;
  seq: number;
  make: (sink: AutoStyles) => XmlElement | undefined;
}

/** A field element replacing the text it displays. */
interface Replacement {
  offset: number;
  length: number;
  fragment: OdtFragment;
}

/** An emitted block and the paragraph ids inside it. */
interface Entry {
  node: XmlElement;
  ids: string[];
}

interface ParagraphOptions {
  /** Paragraph properties from a table style, under the paragraph's own style. */
  layer?: ParagraphProperties;
  breakBefore?: boolean;
}

class Writer {
  private readonly resolver: StyleResolver;
  private readonly content = new AutoStyles('');
  private readonly master = new AutoStyles('M');
  private readonly files = new Map<string, { data: Uint8Array; type: string }>();
  private readonly directories = new Map<string, string>();
  private readonly pictures = new Map<string, string>();
  private readonly frameNames = new Set<string>();
  private readonly paragraphNames = new Map<string, string>();
  private readonly textNames = new Map<string, string>();
  private readonly styleById = new Map<string, Style>();
  private readonly paragraphs = new Map<string, { p: Paragraph; index: number }>();
  private readonly insertions = new Map<string, Insertion[]>();
  private readonly replacements = new Map<string, Replacement[]>();
  private readonly imageFrames = new Map<string, OdtImageFrame>();
  private readonly blockObjects = new Map<string, OdtObject[]>();
  private readonly lastListByCounter = new Map<string, string>();
  /** xml:ids written so far, by part (sink prefix): an id may appear only once in a part. */
  private readonly xmlIds = new Set<string>();
  private listCount = 0;
  private tableCount = 0;
  private imageCount = 0;
  /** A section break asked for a page break before the next paragraph. */
  private pendingBreak = false;

  constructor(
    private readonly doc: WordDocument,
    private readonly ext: OdtExtension,
    /** Picture bytes by package part (the model's media access is async, writing isn't). */
    private readonly pictureData: Map<string, Uint8Array>,
  ) {
    this.resolver = new StyleResolver(doc.styles, doc.theme, doc.numbering);
    for (const s of doc.styles.styles) this.styleById.set(s.id, s);
    this.nameStyles();
    this.indexParagraphs();
    this.indexAnchors();
    this.indexComments();
  }

  // --- Setup -------------------------------------------------------------------------------

  private nameStyles(): void {
    const used = { paragraph: new Set<string>(['Standard']), text: new Set<string>() };
    this.paragraphNames.set('Normal', 'Standard');
    for (const s of this.doc.styles.styles) {
      if (s.type !== 'paragraph' && s.type !== 'character') continue;
      if (s.type === 'paragraph' && s.id === 'Normal') continue;
      const family = s.type === 'paragraph' ? 'paragraph' : 'text';
      let [name] = odfStyleName(s.id, s.name);
      for (let n = 2; used[family].has(name); n++) name = `${odfStyleName(s.id, s.name)[0]}_${n}`;
      used[family].add(name);
      (family === 'paragraph' ? this.paragraphNames : this.textNames).set(s.id, name);
    }
  }

  private indexParagraphs(): void {
    let index = 0;
    const visit = (blocks: Block[]) => {
      for (const b of blocks) {
        if (b.kind === 'paragraph') {
          const id = b.attrs[ID_ATTR];
          if (id && !this.paragraphs.has(id)) this.paragraphs.set(id, { p: b, index: index++ });
        } else if (b.kind === 'table') {
          for (const row of b.rows) if (row.kind === 'row') for (const cell of row.cells) if (cell.kind === 'cell') visit(cell.children);
        } else if (b.kind === 'wrapper') visit(b.children);
      }
    };
    visit(this.doc.body);
    for (const hf of this.doc.headersFooters.values()) visit(hf.children);
  }

  /** Comments by id, and which of them have an end marker in the text. */
  private readonly commentsById = new Map<string, Comment>();
  private readonly commentEnds = new Set<string>();
  /** Comments whose office:annotation has been written, by id. */
  private readonly writtenComments = new Set<string>();

  private indexComments(): void {
    for (const c of this.doc.comments) if (!this.commentsById.has(c.id)) this.commentsById.set(c.id, c);
    const visitInlines = (inlines: Inline[]) => {
      for (const i of inlines) {
        if (i.kind === 'raw') {
          if (i.xml.name === 'w:commentRangeEnd' && i.xml.attrs['w:id'] !== undefined) this.commentEnds.add(i.xml.attrs['w:id']);
        } else if (i.kind === 'hyperlink' || i.kind === 'wrapper') visitInlines(i.children);
      }
    };
    const visit = (blocks: Block[]) => {
      for (const b of blocks) {
        if (b.kind === 'paragraph') visitInlines(b.children);
        else if (b.kind === 'table') {
          for (const row of b.rows) if (row.kind === 'row') for (const cell of row.cells) if (cell.kind === 'cell') visit(cell.children);
        } else if (b.kind === 'wrapper') visit(b.children);
      }
    };
    visit(this.doc.body);
    for (const hf of this.doc.headersFooters.values()) visit(hf.children);
  }

  /** The office:annotation for a comment's start marker; undefined if the comment doesn't exist. */
  commentStartElement(id: string): XmlElement | undefined {
    const c = this.commentsById.get(id);
    if (!c || this.writtenComments.has(id)) return undefined;
    this.writtenComments.add(id);
    const parent = c.parentId !== undefined && this.writtenComments.has(c.parentId) && c.parentId !== id ? c.parentId : undefined;
    const attrs: Record<string, string> = { 'office:name': commentName(id) };
    if (parent !== undefined) attrs['loext:parent-name'] = commentName(parent);
    if (c.resolved) attrs['loext:resolved'] = 'true';
    const children: XmlNode[] = [];
    if (c.author) children.push(el('dc:creator', {}, [c.author]));
    if (c.date) children.push(el('dc:date', {}, [c.date]));
    if (c.initials) children.push(el('loext:sender-initials', {}, [c.initials]));
    for (const line of c.paragraphs.length ? c.paragraphs : ['']) children.push(el('text:p', {}, commentLine(line)));
    return el('office:annotation', attrs, children);
  }

  /** The office:annotation-end for a comment's end marker, when its annotation is written and it isn't a reply. */
  commentEndElement(id: string): XmlElement | undefined {
    const c = this.commentsById.get(id);
    if (!c || !this.writtenComments.has(id)) return undefined;
    // A reply is a point after its parent's start: LibreOffice gives it no range of its own.
    if (c.parentId !== undefined && this.writtenComments.has(c.parentId)) return undefined;
    return el('office:annotation-end', { 'office:name': commentName(id) });
  }

  /** Where the extension's anchored content goes, dropping anchors that no longer exist. */
  private indexAnchors(): void {
    const { ext } = this;
    let seq = 0;
    const valid = (paragraphId: string | null | undefined, offset: number) => {
      const entry = paragraphId ? this.paragraphs.get(paragraphId) : undefined;
      return !!entry && Number.isInteger(offset) && offset >= 0 && offset <= paragraphLength(entry.p);
    };
    const after = (a: { paragraphId: string; offset: number }, b: { paragraphId: string; offset: number }) => {
      const ia = this.paragraphs.get(a.paragraphId)!.index;
      const ib = this.paragraphs.get(b.paragraphId)!.index;
      return ib > ia || (ib === ia && b.offset >= a.offset);
    };
    const insert = (paragraphId: string, offset: number, rank: number, make: Insertion['make']) => {
      const list = this.insertions.get(paragraphId) ?? [];
      list.push({ offset, rank, seq: seq++, make });
      this.insertions.set(paragraphId, list);
    };

    const bookmarkNames = new Set<string>();
    for (const b of ext.bookmarks ?? []) {
      if (!b.name || bookmarkNames.has(b.name) || !valid(b.paragraphId, b.offset)) continue;
      bookmarkNames.add(b.name);
      const ranged = !!b.end && valid(b.end.paragraphId, b.end.offset) && after(b, b.end);
      if (ranged) {
        insert(b.paragraphId, b.offset, 1, () => el('text:bookmark-start', { 'text:name': b.name }));
        insert(b.end!.paragraphId, b.end!.offset, 0, () => el('text:bookmark-end', { 'text:name': b.name }));
      } else insert(b.paragraphId, b.offset, 1, () => el('text:bookmark', { 'text:name': b.name }));
    }
    for (const o of ext.objects ?? []) {
      if (o.placement === 'inline') {
        if (valid(o.paragraphId, o.offset)) insert(o.paragraphId!, o.offset, 1, (sink) => this.restore(o.fragment, sink));
      } else if (o.paragraphId === null || this.paragraphs.has(o.paragraphId)) {
        const key = o.paragraphId ?? '';
        this.blockObjects.set(key, [...(this.blockObjects.get(key) ?? []), o]);
      }
    }
    for (const f of ext.fields ?? []) {
      if (!valid(f.paragraphId, f.offset)) continue;
      const text = paragraphText(this.paragraphs.get(f.paragraphId)!.p);
      if (text.slice(f.offset, f.offset + f.text.length) !== f.text) continue;
      const list = this.replacements.get(f.paragraphId) ?? [];
      list.push({ offset: f.offset, length: f.text.length, fragment: f.fragment });
      this.replacements.set(f.paragraphId, list);
    }
    for (const list of this.replacements.values()) {
      list.sort((a, b) => a.offset - b.offset);
      // Overlapping replacements can't both apply: keep the first.
      for (let i = 1; i < list.length; i++) {
        if (list[i].offset < list[i - 1].offset + list[i - 1].length) list.splice(i--, 1);
      }
    }
    for (const list of this.insertions.values()) list.sort((a, b) => a.offset - b.offset || a.rank - b.rank || a.seq - b.seq);
    for (const f of ext.imageFrames ?? []) this.imageFrames.set(`${f.paragraphId}:${f.offset}`, f);
  }

  /** A preserved fragment, its styles added to the part it goes in and its files to the package. */
  restore(f: OdtFragment, sink: AutoStyles): XmlElement | undefined {
    const e = parseFragment(f.xml);
    if (!e) return undefined;
    if (f.styles?.length) renameStyleReferences(e, sink.preserve(f.styles));
    for (const [path, data] of Object.entries(f.media ?? {})) {
      if (this.files.has(path) || !safePath(path)) continue;
      try {
        this.files.set(path, { data: fromBase64(data), type: f.mediaTypes?.[path] ?? guessType(path) });
      } catch {
        // Unreadable data: the object shows without it.
      }
    }
    for (const [path, type] of Object.entries(f.mediaTypes ?? {})) if (path.endsWith('/') && safePath(path)) this.directories.set(path, type);
    return e;
  }

  // --- Package -----------------------------------------------------------------------------

  async write(): Promise<Uint8Array> {
    const content = this.writeContent();
    const styles = this.writeStyles();
    const fonts = collectFonts([content, styles]);
    for (const root of [content, styles]) root.children.unshift(fontDecls(fonts));
    const meta = this.metaXml();
    const settings = this.settingsXml();

    const entries: Parameters<typeof writeZip>[0] = [
      { name: 'mimetype', data: encoder.encode(MIME_TEXT), compress: false },
      { name: 'content.xml', data: encoder.encode(serializeXml(content)) },
      { name: 'styles.xml', data: encoder.encode(serializeXml(styles)) },
      { name: 'meta.xml', data: encoder.encode(meta) },
    ];
    if (settings) entries.push({ name: 'settings.xml', data: encoder.encode(settings) });
    const reserved = new Set(['mimetype', 'content.xml', 'styles.xml', 'meta.xml', 'settings.xml', 'META-INF/manifest.xml']);
    for (const [path, file] of this.files) {
      if (reserved.has(path)) continue;
      entries.push({ name: path, data: file.data, compress: !/^image\/(png|jpeg|gif|webp)$/.test(file.type) });
    }
    entries.push({ name: 'META-INF/manifest.xml', data: encoder.encode(serializeXml(this.manifest(!!settings))) });
    return writeZip(entries);
  }

  private rootAttrs(): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (const [prefix, uri] of Object.entries(ODF_NS)) attrs[`xmlns:${prefix}`] = uri;
    for (const [prefix, uri] of Object.entries(this.ext.namespaces ?? {})) {
      // Prefixes starting with "xml" are reserved: declaring one makes the part malformed.
      if (/^[A-Za-z_][\w.-]*$/.test(prefix) && !/^xml/i.test(prefix) && !attrs[`xmlns:${prefix}`]) attrs[`xmlns:${prefix}`] = uri;
    }
    attrs['office:version'] = ODF_VERSION;
    return attrs;
  }

  private manifest(settings: boolean): XmlElement {
    const entry = (path: string, type: string) => el('manifest:file-entry', { 'manifest:full-path': path, 'manifest:media-type': type });
    const children = [
      el('manifest:file-entry', { 'manifest:full-path': '/', 'manifest:version': ODF_VERSION, 'manifest:media-type': MIME_TEXT }),
      entry('content.xml', 'text/xml'),
      entry('styles.xml', 'text/xml'),
      entry('meta.xml', 'text/xml'),
    ];
    if (settings) children.push(entry('settings.xml', 'text/xml'));
    for (const [path, type] of this.directories) children.push(entry(path, type));
    for (const [path, file] of this.files) children.push(entry(path, file.type));
    return el('manifest:manifest', { 'xmlns:manifest': MANIFEST_NS, 'manifest:version': ODF_VERSION }, children);
  }

  private metaXml(): string {
    if (this.ext.meta && parseFragment(this.ext.meta)?.name === 'office:document-meta') return this.ext.meta;
    return serializeXml(
      el('office:document-meta', { 'xmlns:office': ODF_NS.office, 'xmlns:meta': ODF_NS.meta, 'xmlns:dc': ODF_NS.dc, 'xmlns:xlink': ODF_NS.xlink, 'office:version': ODF_VERSION }, [
        el('office:meta', {}, [el('meta:generator', {}, ['Golem/1.0'])]),
      ]),
    );
  }

  private settingsXml(): string | undefined {
    if (this.ext.settings && parseFragment(this.ext.settings)?.name === 'office:document-settings') return this.ext.settings;
    return undefined;
  }

  // --- content.xml -------------------------------------------------------------------------

  private writeContent(): XmlElement {
    const sink = this.content;
    const text: XmlNode[] = [];
    for (const f of this.ext.prologue ?? []) {
      const e = this.restore(f, sink);
      if (e) text.push(e);
    }
    const entries = this.writeBlocks(this.doc.body, sink, undefined, true);

    // Block objects after the block holding their paragraph (or first, when anchored to none).
    const placed: Entry[] = [];
    for (const o of this.blockObjects.get('') ?? []) {
      const e = this.restore(o.fragment, sink);
      if (e) placed.push({ node: e, ids: [] });
    }
    for (const entry of entries) {
      placed.push(entry);
      for (const id of entry.ids) {
        for (const o of this.blockObjects.get(id) ?? []) {
          const e = this.restore(o.fragment, sink);
          if (e) placed.push({ node: e, ids: [] });
        }
      }
    }
    this.wrapSections(placed, sink);
    for (const entry of placed) text.push(entry.node);

    return el('office:document-content', this.rootAttrs(), [
      el('office:automatic-styles', {}, sink.elements),
      el('office:body', {}, [el('office:text', {}, text)]),
    ]);
  }

  /** Puts sections and indexes back around their paragraphs (innermost first). */
  private wrapSections(entries: Entry[], sink: AutoStyles): void {
    const sections = this.ext.sections ?? [];
    for (let s = sections.length - 1; s >= 0; s--) {
      const section = sections[s];
      const i = entries.findIndex((e) => e.ids.includes(section.firstParagraphId));
      const j = entries.findIndex((e) => e.ids.includes(section.lastParagraphId));
      if (i < 0 || j < i) continue;
      const attrs = { ...section.attributes };
      if (section.styles?.length) {
        const renames = sink.preserve(section.styles);
        const style = attrs['text:style-name'];
        if (style && renames.has(style)) attrs['text:style-name'] = renames.get(style)!;
      }
      const prologue: XmlElement[] = [];
      for (const f of section.prologue ?? []) {
        const e = this.restore(f, sink);
        if (e) prologue.push(e);
      }
      const inner = entries.slice(i, j + 1);
      const nodes = inner.map((e) => e.node);
      const wrapper =
        section.element === 'text:section'
          ? el(section.element, attrs, [...prologue, ...nodes])
          : el(section.element, attrs, [...prologue, el('text:index-body', {}, nodes)]);
      entries.splice(i, j - i + 1, { node: wrapper, ids: inner.flatMap((e) => e.ids) });
    }
  }

  // --- Blocks ------------------------------------------------------------------------------

  private writeBlocks(blocks: Block[], sink: AutoStyles, layer?: ParagraphProperties, topLevel = false): Entry[] {
    const flat: (Paragraph | Table)[] = [];
    const flatten = (list: Block[]) => {
      for (const b of list) {
        if (b.kind === 'wrapper') flatten(b.children);
        else if (b.kind !== 'raw') flat.push(b);
      }
    };
    flatten(blocks);

    const out: Entry[] = [];
    for (let i = 0; i < flat.length; i++) {
      const b = flat[i];
      if (b.kind === 'table') {
        out.push(this.writeTable(b, sink));
        continue;
      }
      const numbering = this.numberingOf(b);
      if (!numbering) {
        out.push({ node: this.writeParagraph(b, sink, this.paragraphOptions(layer)), ids: idsOf(b) });
        if (topLevel) this.noteSection(b);
        continue;
      }
      const items: { p: Paragraph; level: number }[] = [];
      while (i < flat.length) {
        const q = flat[i];
        const n = q.kind === 'paragraph' ? this.numberingOf(q) : undefined;
        if (!n || n.id !== numbering.id) break;
        items.push({ p: q as Paragraph, level: n.level });
        i++;
        if (topLevel && (q as Paragraph).properties.section) {
          this.noteSection(q as Paragraph);
          break;
        }
      }
      i--;
      out.push(this.writeList(items, numbering.id, sink, layer));
    }
    return out;
  }

  private paragraphOptions(layer: ParagraphProperties | undefined): ParagraphOptions {
    const options: ParagraphOptions = { layer };
    if (this.pendingBreak) {
      options.breakBefore = true;
      this.pendingBreak = false;
    }
    return options;
  }

  /** A section break (other than a continuous one) starts the next paragraph on a new page. */
  private noteSection(p: Paragraph): void {
    const section = p.properties.section;
    if (section && section.type !== 'continuous') this.pendingBreak = true;
  }

  private numberingOf(p: Paragraph): { id: number; level: number } | undefined {
    const resolved = this.resolver.paragraph(p.properties);
    const id = resolved.numbering?.id;
    if (!id) return undefined;
    const level = Math.min(Math.max(resolved.numbering?.level ?? 0, 0), 8);
    return this.resolver.listLevel(id, level) ? { id, level } : undefined;
  }

  private writeList(items: { p: Paragraph; level: number }[], numId: number, sink: AutoStyles, layer?: ParagraphProperties): Entry {
    const xmlId = `list${++this.listCount}`;
    const attrs: Record<string, string> = { 'xml:id': xmlId, 'text:style-name': this.listStyle(numId, sink) };
    // Word keeps counting across interruptions (and across instances sharing a definition).
    const instance = this.doc.numbering.instances.find((n) => n.id === numId);
    const counter = instance?.overrides.some((o) => o.startOverride !== undefined) ? `num:${numId}` : `abstract:${instance?.abstractId}`;
    const previous = this.lastListByCounter.get(counter);
    if (previous) attrs['text:continue-list'] = previous;
    this.lastListByCounter.set(counter, xmlId);

    const root = el('text:list', attrs);
    const stack: { list: XmlElement; level: number; item: XmlElement | null }[] = [{ list: root, level: 0, item: null }];
    const ids: string[] = [];
    for (const { p, level } of items) {
      while (stack[stack.length - 1].level > level) stack.pop();
      while (stack[stack.length - 1].level < level) {
        const top = stack[stack.length - 1];
        if (!top.item) {
          top.item = el('text:list-item');
          top.list.children.push(top.item);
        }
        const nested = el('text:list');
        top.item.children.push(nested);
        stack.push({ list: nested, level: top.level + 1, item: null });
      }
      const top = stack[stack.length - 1];
      top.item = el('text:list-item', {}, [this.writeParagraph(p, sink, this.paragraphOptions(layer))]);
      top.list.children.push(top.item);
      ids.push(...idsOf(p));
    }
    return { node: root, ids };
  }

  /** The list style for a numbering instance (levels with its overrides applied). */
  private listStyle(numId: number, sink: AutoStyles): string {
    const existing = sink.lists.get(numId);
    if (existing) return existing;
    const levels: XmlElement[] = [];
    for (let l = 0; l < 10; l++) {
      const def = this.resolver.listLevel(numId, Math.min(l, 8));
      levels.push(listLevel(l, def));
    }
    const name = sink.add('L', el('text:list-style', {}, levels));
    sink.lists.set(numId, name);
    return name;
  }

  // --- Paragraphs --------------------------------------------------------------------------

  private paragraphStyleName(id: string | undefined): string {
    const style = id ? this.styleById.get(id) : undefined;
    return (style?.type === 'paragraph' && this.paragraphNames.get(style.id)) || 'Standard';
  }

  private writeParagraph(p: Paragraph, sink: AutoStyles, options: ParagraphOptions): XmlElement {
    const id = p.attrs[ID_ATTR];
    const resolved = this.resolver.paragraph(p.properties);
    const outline = resolved.outlineLevel;
    const heading = outline !== undefined && outline >= 0 && outline < 9;

    const inline = new InlineWriter(this, sink, id, this.insertions.get(id ?? '') ?? [], this.replacements.get(id ?? '') ?? []);
    inline.walk(p.children, null);
    const children = inline.finish();

    const parent = this.paragraphStyleName(p.properties.style);
    const direct: ParagraphProperties = { ...p.properties };
    for (const key of ['style', 'numbering', 'section', 'runProperties', 'extra', 'outlineLevel'] as const) delete direct[key];
    if (options.layer) this.applyLayer(direct, p.properties.style, options.layer);
    if (options.breakBefore) direct.pageBreakBefore = true;
    const { attrs, children: propChildren } = writeParagraphProperties(direct);
    if (inline.breakAfter) attrs['fo:break-after'] = inline.breakAfter;
    const extras = id ? this.ext.paragraphs?.[id] : undefined;
    const paragraphProps = withExtras('style:paragraph-properties', attrs, propChildren, extras);
    // An empty paragraph's mark formatting sizes its line: keep it.
    let textProps: XmlElement | undefined;
    if (!inline.hasContent && p.properties.runProperties) {
      const t = writeTextProperties(p.properties.runProperties, (r) => this.font(r));
      textProps = withExtras('style:text-properties', t, [], extras);
    } else if (extras?.attributes?.['style:text-properties'] || extras?.children?.['style:text-properties']) {
      textProps = withExtras('style:text-properties', {}, [], extras);
    }
    const props = [paragraphProps, textProps].filter((e): e is XmlElement => !!e && (Object.keys(e.attrs).length > 0 || e.children.length > 0));
    const styleName = props.length ? sink.add('P', el('style:style', { 'style:family': 'paragraph', 'style:parent-style-name': parent }, props)) : parent;

    const attrs2: Record<string, string | undefined> = { 'text:style-name': styleName };
    if (heading) attrs2['text:outline-level'] = String(outline + 1);
    if (id && /^[0-9A-F]{8}$/.test(id) && !this.xmlIds.has(`${sink.prefix}:${id}`)) {
      this.xmlIds.add(`${sink.prefix}:${id}`);
      attrs2['xml:id'] = `para-${id}`;
    }
    return el(heading ? 'text:h' : 'text:p', attrs2, children);
  }

  /** Table-style paragraph formatting sits under the paragraph style: fill what the style leaves open. */
  private applyLayer(direct: ParagraphProperties, styleId: string | undefined, layer: ParagraphProperties): void {
    const chain: Record<string, unknown> = {};
    for (const s of this.resolver.chain(styleId, 'paragraph')) Object.assign(chain, s.paragraphProperties ?? {});
    const d = direct as Record<string, unknown>;
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined || key === 'numbering' || key === 'runProperties' || key === 'section' || key === 'extra') continue;
      if ((key === 'spacing' || key === 'indent') && typeof value === 'object') {
        const fromChain = (chain[key] ?? {}) as Record<string, unknown>;
        const own = { ...((d[key] ?? {}) as Record<string, unknown>) };
        for (const [sub, v] of Object.entries(value as Record<string, unknown>)) {
          if (fromChain[sub] === undefined && own[sub] === undefined) own[sub] = v;
        }
        if (Object.keys(own).length) d[key] = own;
      } else if (chain[key] === undefined && d[key] === undefined) d[key] = value;
    }
  }

  /** The Latin font of run formatting (theme fonts resolved). */
  font(run: RunProperties): string | undefined {
    return run.fonts ? this.resolver.font(run.fonts) : undefined;
  }

  /** The text style for a run: its character style, or an automatic style over it. */
  spanStyle(props: RunProperties, sink: AutoStyles, dropStyle?: string): string | null {
    const style = props.style && props.style !== dropStyle ? this.textNames.get(props.style) : undefined;
    const direct: RunProperties = { ...props };
    delete direct.style;
    delete direct.extra;
    const attrs = writeTextProperties(direct, (r) => this.font(r));
    if (!Object.keys(attrs).length) return style ?? null;
    return sink.add('T', el('style:style', { 'style:family': 'text', 'style:parent-style-name': style }, [el('style:text-properties', attrs)]));
  }

  /** The text:a style for a link: "Internet link" when its runs use the Hyperlink style. */
  linkStyle(link: Hyperlink): string | undefined {
    const first = firstRun(link.children);
    return first?.properties.style === 'Hyperlink' ? this.textNames.get('Hyperlink') : undefined;
  }

  /** A picture as a draw:frame, or undefined when the drawing has no picture. */
  frame(d: Drawing, sink: AutoStyles, paragraphId: string | undefined, offset: number): XmlElement | undefined {
    if (!d.image) return undefined;
    let path = this.pictures.get(d.image);
    if (!path) {
      const data = this.pictureData.get(d.image);
      if (!data) return undefined;
      const base = d.image.slice(d.image.lastIndexOf('/') + 1) || 'image';
      path = `Pictures/${base}`;
      for (let n = 2; this.files.has(path); n++) path = `Pictures/${n}-${base}`;
      this.files.set(path, { data, type: mediaTypeFor(path) });
      this.pictures.set(d.image, path);
    }
    let name = d.name || `Image${++this.imageCount}`;
    for (let n = 2; this.frameNames.has(name); n++) name = `${d.name || 'Image'}${n}`;
    this.frameNames.add(name);

    const saved = paragraphId ? this.imageFrames.get(`${paragraphId}:${offset}`) : undefined;
    let frame = saved ? this.restore(saved.frame, sink) : undefined;
    if (frame && frame.name === 'draw:frame') {
      frame.children = [];
    } else {
      const style = sink.add(
        'fr',
        el('style:style', { 'style:family': 'graphic' }, [
          el('style:graphic-properties', { 'style:vertical-pos': 'top', 'style:vertical-rel': 'baseline', 'style:horizontal-pos': 'center', 'style:horizontal-rel': 'paragraph' }),
        ]),
      );
      frame = el('draw:frame', { 'draw:style-name': style, 'text:anchor-type': 'as-char', 'draw:z-index': '0' });
    }
    frame.attrs['draw:name'] = name;
    frame.attrs['svg:width'] = emuToLength(d.width);
    frame.attrs['svg:height'] = emuToLength(d.height);
    frame.children.push(
      el('draw:image', { 'xlink:href': path, 'xlink:type': 'simple', 'xlink:show': 'embed', 'xlink:actuate': 'onLoad', 'draw:mime-type': mediaTypeFor(path) }),
    );
    if (d.description) frame.children.push(el('svg:desc', {}, [d.description]));
    return frame;
  }

  // --- Tables ------------------------------------------------------------------------------

  private tableProperties(t: Table): { props: TableProperties; layer: ParagraphProperties } {
    let props: TableProperties = {};
    let layer: ParagraphProperties = {};
    for (const s of this.resolver.chain(t.properties.style, 'table')) {
      props = { ...props, ...s.tableProperties, borders: { ...props.borders, ...s.tableProperties?.borders }, cellMargins: { ...props.cellMargins, ...s.tableProperties?.cellMargins } };
      layer = { ...layer, ...s.paragraphProperties, spacing: { ...layer.spacing, ...s.paragraphProperties?.spacing } };
    }
    const own = t.properties;
    props = { ...props, ...own, borders: { ...props.borders, ...own.borders }, cellMargins: { ...props.cellMargins, ...own.cellMargins } };
    if (!Object.keys(layer.spacing ?? {}).length) delete layer.spacing;
    return { props, layer };
  }

  private writeTable(t: Table, sink: AutoStyles): Entry {
    const n = ++this.tableCount;
    const { props, layer } = this.tableProperties(t);
    const rows = t.rows.filter((r): r is TableRow => r.kind === 'row');
    const cellsOf = (r: TableRow) => r.cells.filter((c): c is TableCell => c.kind === 'cell');
    const columnCount = Math.max(
      t.grid.length,
      ...rows.map((r) => (r.properties.gridBefore ?? 0) + cellsOf(r).reduce((s, c) => s + (c.properties.gridSpan ?? 1), 0) + (r.properties.gridAfter ?? 0)),
      1,
    );
    const textWidth = this.textWidth();
    const grid: number[] = [];
    for (let i = 0; i < columnCount; i++) grid.push(t.grid[i] ?? Math.round((t.grid.length ? 1440 : textWidth) / (t.grid.length ? 1 : columnCount)));
    const gridWidth = grid.reduce((s, w) => s + w, 0);

    // Table style.
    const tableAttrs: Record<string, string> = {};
    const width = props.width;
    if (width?.type === 'pct') {
      const pct = width.w?.endsWith('%') ? parseFloat(width.w) : Number(width.w) / 50;
      tableAttrs['style:width'] = twipsToLength(Math.round((textWidth * pct) / 100));
      tableAttrs['style:rel-width'] = percent(pct);
    } else if (width?.type === 'dxa' && Number(width.w) > 0) tableAttrs['style:width'] = twipsToLength(Number(width.w));
    else tableAttrs['style:width'] = twipsToLength(gridWidth);
    const justification = props.justification;
    tableAttrs['table:align'] = justification === 'center' ? 'center' : justification === 'right' || justification === 'end' ? 'right' : 'left';
    const indent = props.indent?.type === 'dxa' ? Number(props.indent.w) : 0;
    if (tableAttrs['table:align'] === 'left' && indent > 0) tableAttrs['fo:margin-left'] = twipsToLength(indent);
    const tableStyle = sink.add('Table', el('style:style', { 'style:family': 'table' }, [el('style:table-properties', tableAttrs)]));

    const children: XmlNode[] = [];
    for (const w of grid) {
      const col = sink.add('Col', el('style:style', { 'style:family': 'table-column' }, [el('style:table-column-properties', { 'style:column-width': twipsToLength(w) })]));
      children.push(el('table:table-column', { 'table:style-name': col }));
    }

    const tb = props.borders ?? {};
    const margins = props.cellMargins ?? {};
    const twips = (w: { w?: string; type?: string } | undefined) => (w && (w.type === 'dxa' || w.type === undefined) && w.w !== undefined && !Number.isNaN(Number(w.w)) ? Number(w.w) : undefined);
    const ids: string[] = [];
    const header: XmlElement[] = [];
    const body: XmlElement[] = [];

    // Grid position of each cell, for vertical merges.
    const layout = rows.map((r) => {
      let col = r.properties.gridBefore ?? 0;
      return cellsOf(r).map((c) => {
        const at = col;
        col += c.properties.gridSpan ?? 1;
        return at;
      });
    });
    rows.forEach((row, r) => {
      const rowAttrs: Record<string, string> = {};
      const height = row.properties.height;
      if (height?.val !== undefined) rowAttrs[height.hRule === 'exact' ? 'style:row-height' : 'style:min-row-height'] = twipsToLength(height.val);
      if (row.properties.cantSplit) rowAttrs['fo:keep-together'] = 'always';
      const rowStyle = Object.keys(rowAttrs).length ? sink.add('Row', el('style:style', { 'style:family': 'table-row' }, [el('style:table-row-properties', rowAttrs)])) : undefined;
      const cells: XmlElement[] = [];
      const empty = () => el('table:table-cell', { 'office:value-type': 'string' }, [el('text:p', { 'text:style-name': 'Standard' })]);
      for (let k = 0; k < (row.properties.gridBefore ?? 0); k++) cells.push(empty());
      cellsOf(row).forEach((cell, c) => {
        const span = cell.properties.gridSpan ?? 1;
        const col = layout[r][c];
        if (cell.properties.vMerge === 'continue') {
          for (let k = 0; k < span; k++) cells.push(el('table:covered-table-cell'));
          return;
        }
        let rowSpan = 1;
        if (cell.properties.vMerge === 'restart') {
          for (let below = r + 1; below < rows.length; below++) {
            const idx = layout[below].indexOf(col);
            const other = idx >= 0 ? cellsOf(rows[below])[idx] : undefined;
            if (other?.properties.vMerge !== 'continue') break;
            rowSpan++;
          }
        }
        const lastRow = r + rowSpan - 1 === rows.length - 1;
        const own = cell.properties.borders ?? {};
        const borders = {
          top: own.top ?? (r === 0 ? tb.top : tb.insideH),
          bottom: own.bottom ?? (lastRow ? tb.bottom : tb.insideH),
          left: own.left ?? own.start ?? (col === 0 ? (tb.left ?? tb.start) : tb.insideV),
          right: own.right ?? own.end ?? (col + span >= columnCount ? (tb.right ?? tb.end) : tb.insideV),
        } satisfies Record<string, Border | undefined>;
        const cm = cell.properties.margins ?? {};
        const cellMargins = {
          top: twips(cm.top) ?? twips(margins.top),
          bottom: twips(cm.bottom) ?? twips(margins.bottom),
          left: twips(cm.left ?? cm.start) ?? twips(margins.left ?? margins.start),
          right: twips(cm.right ?? cm.end) ?? twips(margins.right ?? margins.end),
        };
        const cellStyle = sink.add('Cell', el('style:style', { 'style:family': 'table-cell' }, [el('style:table-cell-properties', writeCellProperties(borders, cellMargins, cell.properties))]));
        const content = this.writeBlocks(cell.children, sink, layer);
        if (!content.length) content.push({ node: el('text:p', { 'text:style-name': 'Standard' }), ids: [] });
        for (const e of content) ids.push(...e.ids);
        cells.push(
          el(
            'table:table-cell',
            {
              'table:style-name': cellStyle,
              'table:number-columns-spanned': span > 1 ? span : undefined,
              'table:number-rows-spanned': rowSpan > 1 ? rowSpan : undefined,
              'office:value-type': 'string',
            },
            content.map((e) => e.node),
          ),
        );
        for (let k = 1; k < span; k++) cells.push(el('table:covered-table-cell'));
      });
      const filled = (row.properties.gridBefore ?? 0) + cellsOf(row).reduce((s, c) => s + (c.properties.gridSpan ?? 1), 0);
      for (let k = filled; k < columnCount; k++) cells.push(empty());
      const rowEl = el('table:table-row', { 'table:style-name': rowStyle }, cells);
      (row.properties.header && body.length === 0 ? header : body).push(rowEl);
    });
    if (header.length) children.push(el('table:table-header-rows', {}, header));
    children.push(...body);
    if (!header.length && !body.length) {
      children.push(el('table:table-row', {}, [el('table:table-cell', { 'office:value-type': 'string' }, [el('text:p', { 'text:style-name': 'Standard' })])]));
    }
    return { node: el('table:table', { 'table:name': `Table${n}`, 'table:style-name': tableStyle }, children), ids };
  }

  private textWidth(): number {
    const s = this.doc.section;
    return Math.max((s.pageSize?.w ?? 12240) - (s.margins?.left ?? 1440) - (s.margins?.right ?? 1440), 1440);
  }

  // --- styles.xml --------------------------------------------------------------------------

  private writeStyles(): XmlElement {
    const { doc, ext } = this;
    const office: XmlElement[] = [];

    // Defaults.
    const defaults = writeParagraphProperties(doc.styles.defaultParagraphProperties ?? {});
    defaults.attrs['style:tab-stop-distance'] = twipsToLength(doc.settings.defaultTabStop || 720);
    const defaultExtras = ext.styles?.['#default'];
    office.push(
      el('style:default-style', { 'style:family': 'paragraph' }, [
        withExtras('style:paragraph-properties', defaults.attrs, defaults.children, defaultExtras),
        withExtras('style:text-properties', writeTextProperties(doc.styles.defaultRunProperties ?? {}, (r) => this.font(r)), [], defaultExtras),
      ]),
    );

    let wroteStandard = false;
    for (const s of doc.styles.styles) {
      if (s.type === 'paragraph') {
        const name = this.paragraphNames.get(s.id)!;
        if (name === 'Standard') {
          if (s.id !== 'Normal' || wroteStandard) continue;
          wroteStandard = true;
        }
        office.push(this.commonStyle(s, name, 'paragraph'));
      } else if (s.type === 'character' && !s.isDefault) {
        office.push(this.commonStyle(s, this.textNames.get(s.id)!, 'text'));
      }
    }
    if (!wroteStandard) office.unshift(el('style:style', { 'style:name': 'Standard', 'style:family': 'paragraph', 'style:class': 'text' }));
    for (const source of ext.styleDefinitions ?? []) {
      const e = parseFragment(source);
      if (e) office.push(e);
    }

    // Master page, page layout and headers/footers.
    const sink = this.master;
    const section = doc.section;
    const find = (refs: { type: string; part: string }[], type: string) => {
      const ref = refs.find((r) => r.type === type);
      return ref ? doc.headersFooters.get(ref.part) : undefined;
    };
    const header = find(section.headers, 'default');
    const footer = find(section.footers, 'default');
    const headerFirst = section.titlePage ? find(section.headers, 'first') : undefined;
    const footerFirst = section.titlePage ? find(section.footers, 'first') : undefined;
    const layout = this.pageLayout(!!(header || headerFirst), !!(footer || footerFirst));
    const layoutName = sink.add('pm', layout);
    const part = (name: string, hf: typeof header) => (hf ? el(name, {}, this.writeBlocks(hf.children, sink).map((e) => e.node)) : undefined);
    const preserved = new Map<string, XmlElement>();
    const others: XmlElement[] = [];
    for (const f of ext.page?.masterChildren ?? []) {
      const e = this.restore(f, sink);
      if (!e) continue;
      if (/^style:(header|footer)(-left|-first)?$/.test(e.name)) preserved.set(e.name, e);
      else others.push(e);
    }
    const slots = [
      part('style:header', header),
      header ? preserved.get('style:header-left') : undefined,
      part('style:header-first', headerFirst),
      part('style:footer', footer),
      footer ? preserved.get('style:footer-left') : undefined,
      part('style:footer-first', footerFirst),
    ].filter((e): e is XmlElement => !!e);
    const masterAttrs: Record<string, string> = { 'style:name': 'Standard', 'style:page-layout-name': layoutName };
    for (const [k, v] of Object.entries(ext.page?.masterAttributes ?? {})) if (!(k in masterAttrs) && !k.startsWith('draw:')) masterAttrs[k] = v;
    const master = el('style:master-page', masterAttrs, [...slots, ...others]);

    return el('office:document-styles', this.rootAttrs(), [
      el('office:styles', {}, office),
      el('office:automatic-styles', {}, sink.elements),
      el('office:master-styles', {}, [master]),
    ]);
  }

  private commonStyle(s: Style, name: string, family: 'paragraph' | 'text'): XmlElement {
    const [, display] = odfStyleName(s.id, s.name);
    const extras = this.ext.styles?.[name]?.family === family ? this.ext.styles[name] : undefined;
    const names = family === 'paragraph' ? this.paragraphNames : this.textNames;
    const parentStyle = s.basedOn ? this.styleById.get(s.basedOn) : undefined;
    // Word's default character style isn't written, so it can't be a parent.
    const exported = parentStyle && parentStyle.type === s.type && !(s.type === 'character' && parentStyle.isDefault);
    const parent = exported ? names.get(parentStyle.id) : undefined;
    const nextStyle = s.next ? this.styleById.get(s.next) : undefined;
    const attrs: Record<string, string | undefined> = {
      'style:name': name,
      'style:display-name': display !== name ? display : undefined,
      'style:family': family,
      'style:parent-style-name': parent !== name ? parent : undefined,
      'style:next-style-name': family === 'paragraph' && nextStyle?.type === 'paragraph' ? names.get(nextStyle.id) : undefined,
    };
    const outline = s.paragraphProperties?.outlineLevel;
    if (family === 'paragraph' && outline !== undefined && outline >= 0 && outline < 9) attrs['style:default-outline-level'] = String(outline + 1);
    for (const [k, v] of Object.entries(extras?.styleAttributes ?? {})) if (attrs[k] === undefined) attrs[k] = v;
    const children: XmlElement[] = [];
    if (family === 'paragraph') {
      const pp: ParagraphProperties = { ...s.paragraphProperties };
      for (const key of ['numbering', 'section', 'runProperties', 'extra', 'outlineLevel'] as const) delete pp[key];
      const written = writeParagraphProperties(pp);
      children.push(withExtras('style:paragraph-properties', written.attrs, written.children, extras));
    }
    const run: RunProperties = { ...s.runProperties };
    delete run.style;
    children.push(withExtras('style:text-properties', writeTextProperties(run, (r) => this.font(r)), [], extras));
    for (const source of extras?.children?.[''] ?? []) {
      const e = parseFragment(source);
      if (e) children.push(e);
    }
    return el('style:style', attrs, children.filter((c) => Object.keys(c.attrs).length || c.children.length));
  }

  private pageLayout(hasHeader: boolean, hasFooter: boolean): XmlElement {
    const s = this.doc.section;
    const m = s.margins ?? {};
    const top = Math.max(m.top ?? 1440, 0);
    const bottom = Math.max(m.bottom ?? 1440, 0);
    const headerDistance = Math.max(Math.min(m.header ?? 720, top), 0);
    const footerDistance = Math.max(Math.min(m.footer ?? 720, bottom), 0);
    const attrs: Record<string, string> = {
      'fo:page-width': twipsToLength(s.pageSize?.w ?? 12240),
      'fo:page-height': twipsToLength(s.pageSize?.h ?? 15840),
      'style:print-orientation': s.pageSize?.orient === 'landscape' ? 'landscape' : 'portrait',
      'fo:margin-top': twipsToLength(hasHeader ? headerDistance : top),
      'fo:margin-bottom': twipsToLength(hasFooter ? footerDistance : bottom),
      'fo:margin-left': twipsToLength(Math.max(m.left ?? 1440, 0)),
      'fo:margin-right': twipsToLength(Math.max(m.right ?? 1440, 0)),
    };
    const format = s.pageNumbering?.fmt ? NUM_FORMAT_OUT[s.pageNumbering.fmt] : undefined;
    if (format !== undefined) attrs['style:num-format'] = format;
    const children: XmlElement[] = [];
    const extras = this.ext.page?.layout;
    const extraChildren = extras?.children?.['style:page-layout-properties'] ?? [];
    const columns = s.columns?.num ?? 1;
    if (columns > 1 && !extraChildren.some((c) => c.startsWith('<style:columns'))) {
      children.push(el('style:columns', { 'fo:column-count': columns, 'fo:column-gap': twipsToLength(s.columns?.space ?? 720) }));
    }
    const hf = (present: boolean, distance: number, margin: number) =>
      present
        ? [el('style:header-footer-properties', { 'fo:min-height': twipsToLength(Math.max(margin - distance, 0)), 'fo:margin-left': '0in', 'fo:margin-right': '0in', 'fo:margin-top': '0in', 'fo:margin-bottom': '0in' })]
        : [];
    return el('style:page-layout', {}, [
      withExtras('style:page-layout-properties', attrs, children, extras),
      el('style:header-style', {}, hf(hasHeader, headerDistance, top)),
      el('style:footer-style', {}, hf(hasFooter, footerDistance, bottom)),
    ]);
  }
}

const NUM_FORMAT_OUT: Record<string, string> = { decimal: '1', lowerLetter: 'a', upperLetter: 'A', lowerRoman: 'i', upperRoman: 'I', none: '' };

/** Symbol-font bullets (private-use code points) as the Unicode characters they draw. */
const SYMBOL_BULLETS: Record<string, string> = { '': '•', '': '▪', '': '➢', '': '✓', '': '❖', '': '◆', '': '■', '': '❑' };

/** One level of a list style from a Word numbering level. */
function listLevel(odfLevel: number, def: NumberingLevel | undefined): XmlElement {
  const level = odfLevel + 1;
  const ind = def?.paragraphProperties?.indent;
  const left = ind?.left ?? ind?.start ?? 720 * level;
  const indent = ind?.hanging !== undefined ? -ind.hanging : (ind?.firstLine ?? -360);
  const suffix = def?.suffix ?? 'tab';
  const properties = el('style:list-level-properties', { 'text:list-level-position-and-space-mode': 'label-alignment' }, [
    el('style:list-level-label-alignment', {
      'text:label-followed-by': suffix === 'space' ? 'space' : suffix === 'nothing' ? 'nothing' : 'listtab',
      'text:list-tab-stop-position': suffix === 'tab' ? twipsToLength(left) : undefined,
      'fo:text-indent': twipsToLength(indent),
      'fo:margin-left': twipsToLength(left),
    }),
  ]);
  if (!def || def.format === 'bullet') {
    let bullet = [...(def?.text ?? '•')][0] ?? '•';
    if (bullet >= '' && bullet <= '') bullet = SYMBOL_BULLETS[bullet] ?? '•';
    if (bullet === 'o' && def?.runProperties?.fonts?.ascii === 'Courier New') bullet = '◦';
    return el('text:list-level-style-bullet', { 'text:level': level, 'text:bullet-char': bullet }, [properties]);
  }
  const text = def.text ?? `%${Math.min(level, 9)}.`;
  const placeholders = [...text.matchAll(/%([1-9])/g)];
  let prefix = text;
  let suffixText = '';
  let shown = 1;
  if (placeholders.length) {
    const first = placeholders[0];
    const last = placeholders[placeholders.length - 1];
    prefix = text.slice(0, first.index);
    suffixText = text.slice(last.index! + last[0].length);
    shown = placeholders.length;
  }
  const format = placeholders.length ? (NUM_FORMAT_OUT[def.format ?? 'decimal'] ?? '1') : '';
  return el(
    'text:list-level-style-number',
    {
      'text:level': level,
      'style:num-prefix': prefix || undefined,
      'style:num-suffix': suffixText || undefined,
      'style:num-format': format,
      'text:display-levels': shown > 1 ? shown : undefined,
      'text:start-value': def.start !== undefined && def.start !== 1 ? def.start : undefined,
    },
    [properties],
  );
}

/** A properties element with the extension's unmapped attributes and children merged in (the core wins). */
function withExtras(name: string, attrs: Record<string, string>, children: XmlElement[], extras: OdtProperties | undefined): XmlElement {
  const merged = { ...attrs };
  for (const [k, v] of Object.entries(extras?.attributes?.[name] ?? {})) if (merged[k] === undefined) merged[k] = v;
  const kids = [...children];
  for (const source of extras?.children?.[name] ?? []) {
    const e = parseFragment(source);
    if (e && !kids.some((c) => c.name === e.name)) kids.push(e);
  }
  return el(name, merged, kids);
}

function collectFonts(roots: XmlElement[]): string[] {
  const fonts = new Set<string>();
  for (const root of roots) {
    for (const e of descendants(root)) {
      for (const key of ['style:font-name', 'style:font-name-asian', 'style:font-name-complex']) if (e.attrs[key]) fonts.add(e.attrs[key]);
    }
  }
  return [...fonts].sort();
}

function fontDecls(fonts: string[]): XmlElement {
  return el(
    'office:font-face-decls',
    {},
    fonts.map((name) => el('style:font-face', { 'style:name': name, 'svg:font-family': /[\s,]/.test(name) ? `'${name}'` : name })),
  );
}

function idsOf(p: Paragraph): string[] {
  const id = p.attrs[ID_ATTR];
  return id ? [id] : [];
}

function firstRun(inlines: Inline[]): Extract<Inline, { kind: 'run' }> | undefined {
  for (const i of inlines) {
    if (i.kind === 'run') return i;
    if (i.kind === 'hyperlink' || i.kind === 'wrapper') {
      const r = firstRun(i.children);
      if (r) return r;
    }
  }
  return undefined;
}

/** EMUs as a length: millimetres to 5 places is exact to the EMU (36000 per mm). */
function emuToLength(emu: number): string {
  const mm = Math.max(emu, 0) / 36000;
  const s = mm.toFixed(5);
  return `${s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s}mm`;
}

/** Whether a package path from the extension stays inside the package (no "..", absolute or drive paths). */
function safePath(path: string): boolean {
  return path !== '' && !path.startsWith('/') && !path.includes('\\') && !/^[A-Za-z]:/.test(path) && !path.split('/').some((part) => part === '..' || part === '.');
}

function guessType(path: string): string {
  if (path.endsWith('.xml')) return 'text/xml';
  const type = mediaTypeFor(path);
  return type === 'application/octet-stream' ? '' : type;
}

// --- Paragraph content ---------------------------------------------------------------------

type Piece = { link: Hyperlink | null; style: string | null; node: XmlNode; spaces?: number };

/**
 * Writes one paragraph's inline content, keeping model offsets (see @golemdocs/docx edit/text.ts)
 * so extension content lands at the right place, and ODF's white-space rules: a space after
 * a space (or at the start) is written as text:s so it isn't collapsed on reading.
 */
class InlineWriter {
  private readonly pieces: Piece[] = [];
  private pos = 0;
  private prevSpace = true;
  private next = 0;
  private skipUntil = 0;
  private replacementIndex = 0;
  private fieldDepth = 0;
  private field: { phase: 'instr' | 'result'; instr: string; capture?: { kind: string; text: string; style: string | null; link: Hyperlink | null } } | null = null;
  breakAfter: 'page' | 'column' | undefined;
  hasContent = false;

  constructor(
    private readonly w: Writer,
    private readonly sink: AutoStyles,
    private readonly paragraphId: string | undefined,
    private readonly insertions: Insertion[],
    private readonly replacements: Replacement[],
  ) {}

  walk(inlines: Inline[], link: Hyperlink | null, linkStyle?: string): void {
    for (const inline of inlines) {
      switch (inline.kind) {
        case 'run': {
          const style = this.w.spanStyle(inline.properties, this.sink, linkStyle ? 'Hyperlink' : undefined);
          for (const item of inline.content) this.item(item, style, link);
          break;
        }
        case 'hyperlink':
          if (link) this.walk(inline.children, link, linkStyle);
          else this.walk(inline.children, inline, this.w.linkStyle(inline));
          break;
        case 'wrapper':
          this.walk(inline.children, link, linkStyle);
          break;
        case 'raw': {
          const skip = this.at(null, link);
          const commentId = inline.xml.attrs['w:id'];
          if (commentId !== undefined && (inline.xml.name === 'w:commentRangeStart' || inline.xml.name === 'w:commentRangeEnd')) {
            const e = inline.xml.name === 'w:commentRangeStart' ? this.w.commentStartElement(commentId) : this.w.commentEndElement(commentId);
            if (e) this.pieces.push({ link, style: null, node: e });
          }
          // An equation is its LaTeX, as text.
          if (!skip && isMathInline(inline)) {
            const equation = readMathInline(inline);
            const latex = toLatex(equation);
            for (const ch of equation.display ? `$$${latex}$$` : `$${latex}$`) this.char(ch, null, link);
          }
          this.pos++;
          break;
        }
      }
    }
  }

  /** Flushes insertions due at the current position and starts a replacement there. Returns whether to skip it. */
  private at(style: string | null = null, link: Hyperlink | null = null): boolean {
    while (this.next < this.insertions.length && this.insertions[this.next].offset <= this.pos) {
      const e = this.insertions[this.next++].make(this.sink);
      if (e) this.pieces.push({ link, style: null, node: e });
    }
    while (this.replacementIndex < this.replacements.length && this.replacements[this.replacementIndex].offset < this.pos) this.replacementIndex++;
    const r = this.replacements[this.replacementIndex];
    if (r && r.offset === this.pos && this.pos >= this.skipUntil) {
      this.replacementIndex++;
      const e = this.w.restore(r.fragment, this.sink);
      if (e) {
        this.pieces.push({ link, style, node: e });
        this.prevSpace = false;
        this.hasContent = true;
        this.skipUntil = this.pos + r.length;
      }
    }
    return this.pos < this.skipUntil;
  }

  private item(item: RunContent, style: string | null, link: Hyperlink | null): void {
    if (item.kind === 'text' || item.kind === 'delText' || item.kind === 'instrText') {
      for (const ch of item.text) {
        // Surrogate pairs are two positions.
        for (let u = 0; u < ch.length; u++) {
          const skip = this.at(style, link);
          if (u === 0 && !skip) {
            if (item.kind === 'instrText') {
              if (this.field?.phase === 'instr' && this.fieldDepth === 1) this.field.instr += ch;
            } else if (item.kind === 'text') this.char(ch, style, link);
          }
          this.pos++;
        }
      }
      return;
    }
    const skip = this.at(style, link);
    if (!skip) this.object(item, style, link);
    this.pos++;
  }

  private object(item: RunContent, style: string | null, link: Hyperlink | null): void {
    switch (item.kind) {
      case 'tab':
        this.push(el('text:tab'), style, link);
        break;
      case 'break':
        if (item.type === 'page' || item.type === 'column') this.breakAfter = this.breakAfter === 'page' ? 'page' : item.type;
        else this.push(el('text:line-break'), style, link);
        break;
      case 'cr':
        this.push(el('text:line-break'), style, link);
        break;
      case 'noBreakHyphen':
        this.char('‑', style, link);
        break;
      case 'softHyphen':
        this.char('­', style, link);
        break;
      case 'symbol': {
        const code = parseInt(item.char ?? '', 16);
        if (code > 0) {
          const ch = String.fromCodePoint(code >= 0xf000 && code <= 0xf0ff ? code - 0xf000 : code);
          this.char(SYMBOL_BULLETS[String.fromCodePoint(code)] ?? ch, style, link);
        }
        break;
      }
      case 'drawing': {
        const frame = this.w.frame(item, this.sink, this.paragraphId, this.pos);
        if (frame) this.push(frame, style, link);
        break;
      }
      case 'fieldChar':
        this.fieldChar(item.type, style, link);
        break;
    }
  }

  /** Complex fields: PAGE and NUMPAGES become ODF page fields; others keep their result text. */
  private fieldChar(type: 'begin' | 'separate' | 'end', style: string | null, link: Hyperlink | null): void {
    if (type === 'begin') {
      this.fieldDepth++;
      if (this.fieldDepth === 1) this.field = { phase: 'instr', instr: '' };
    } else if (type === 'separate') {
      if (this.fieldDepth === 1 && this.field) {
        this.field.phase = 'result';
        const instr = this.field.instr.trim().split(/\s+/)[0]?.toUpperCase();
        const kind = instr === 'PAGE' ? 'text:page-number' : instr === 'NUMPAGES' ? 'text:page-count' : undefined;
        if (kind) this.field.capture = { kind, text: '', style, link };
      }
    } else {
      if (this.fieldDepth === 1 && this.field) {
        const capture = this.field.capture;
        this.field = null;
        if (capture) {
          const attrs = capture.kind === 'text:page-number' ? { 'text:select-page': 'current' } : {};
          this.push(el(capture.kind, attrs, capture.text ? [capture.text] : []), capture.style, capture.link);
        }
      }
      this.fieldDepth = Math.max(this.fieldDepth - 1, 0);
    }
  }

  private push(node: XmlNode, style: string | null, link: Hyperlink | null): void {
    this.pieces.push({ link, style, node });
    this.prevSpace = false;
    this.hasContent = true;
  }

  private char(ch: string, style: string | null, link: Hyperlink | null): void {
    const capture = this.field?.capture;
    if (capture) {
      capture.text += ch;
      return;
    }
    if (this.field?.phase === 'instr') return;
    this.hasContent = true;
    if (ch === ' ') {
      const last = this.pieces[this.pieces.length - 1];
      if (this.prevSpace) {
        if (last && last.spaces && last.style === style && last.link === link) last.spaces++;
        else this.pieces.push({ link, style, node: el('text:s'), spaces: 1 });
      } else this.text(' ', style, link);
      this.prevSpace = true;
      return;
    }
    if (ch === '\t') return this.push(el('text:tab'), style, link);
    if (ch === '\n' || ch === '\r' || ch === ' ') return this.push(el('text:line-break'), style, link);
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0xfffe || code === 0xffff) return;
    this.text(ch, style, link);
    this.prevSpace = false;
  }

  private text(s: string, style: string | null, link: Hyperlink | null): void {
    const last = this.pieces[this.pieces.length - 1];
    if (last && typeof last.node === 'string' && last.style === style && last.link === link) last.node += s;
    else this.pieces.push({ link, style, node: s });
  }

  /** Remaining insertions (at the paragraph's end) and the grouped content. */
  finish(): XmlNode[] {
    this.at();
    if (this.field?.capture) {
      const c = this.field.capture;
      this.field = null;
      for (const ch of c.text) this.char(ch, c.style, c.link);
    }
    const out: XmlNode[] = [];
    let i = 0;
    const pieces = this.pieces;
    while (i < pieces.length) {
      const link = pieces[i].link;
      let j = i;
      while (j < pieces.length && pieces[j].link === link) j++;
      const nodes = spans(pieces.slice(i, j));
      if (link && (link.url || link.anchor)) {
        const href = link.url ?? `#${link.anchor}`;
        out.push(el('text:a', { 'xlink:type': 'simple', 'xlink:href': href, 'text:style-name': this.w.linkStyle(link) }, nodes));
      } else out.push(...nodes);
      i = j;
    }
    return out;
  }
}

function spans(pieces: Piece[]): XmlNode[] {
  const out: XmlNode[] = [];
  let i = 0;
  while (i < pieces.length) {
    const style = pieces[i].style;
    let j = i;
    while (j < pieces.length && pieces[j].style === style) j++;
    const nodes = pieces.slice(i, j).map((p) => (p.spaces ? el('text:s', p.spaces > 1 ? { 'text:c': p.spaces } : {}) : p.node));
    if (style) out.push(el('text:span', { 'text:style-name': style }, nodes));
    else out.push(...nodes);
    i = j;
  }
  return out;
}

/** Loads every picture the document's drawings use (the model's media access is async). */
export async function loadPictures(doc: WordDocument): Promise<Map<string, Uint8Array>> {
  const parts = new Set<string>();
  const visitInlines = (inlines: Inline[]) => {
    for (const i of inlines) {
      if (i.kind === 'run') {
        for (const c of i.content) if (c.kind === 'drawing' && c.image) parts.add(c.image);
      } else if (i.kind === 'hyperlink' || i.kind === 'wrapper') visitInlines(i.children);
    }
  };
  const visit = (blocks: Block[]) => {
    for (const b of blocks) {
      if (b.kind === 'paragraph') visitInlines(b.children);
      else if (b.kind === 'table') {
        for (const row of b.rows) if (row.kind === 'row') for (const cell of row.cells) if (cell.kind === 'cell') visit(cell.children);
      } else if (b.kind === 'wrapper') visit(b.children);
    }
  };
  visit(doc.body);
  for (const hf of doc.headersFooters.values()) visit(hf.children);
  const out = new Map<string, Uint8Array>();
  for (const part of parts) {
    try {
      out.set(part, await doc.media(part));
    } catch {
      // A missing picture is left out.
    }
  }
  return out;
}

function commentName(id: string): string {
  return `__Annotation__${id}`;
}

/** One line of a comment as ODF paragraph content: runs of spaces, tabs and line breaks as elements. */
function commentLine(line: string): XmlNode[] {
  const out: XmlNode[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push(text);
    text = '';
  };
  const chars = [...line.replace(/\r\n?/g, '\n')];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '\t') (flush(), out.push(el('text:tab')));
    else if (ch === '\n') (flush(), out.push(el('text:line-break')));
    else if (ch === ' ') {
      let n = 1;
      while (chars[i + n] === ' ') n++;
      i += n - 1;
      // After text, one space is ordinary and the rest of the run are counted.
      const lead = text !== '' ? 1 : 0;
      if (lead) text += ' ';
      flush();
      if (n - lead > 0) out.push(el('text:s', { 'text:c': String(n - lead) }));
    } else if (ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0xfffe && ch.charCodeAt(0) !== 0xffff) text += ch;
  }
  flush();
  return out;
}
