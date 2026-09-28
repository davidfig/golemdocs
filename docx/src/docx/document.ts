// A .docx file: reading, the in-memory model, and writing back.

import type {
  Block,
  HeaderFooter,
  Numbering,
  SectionProperties,
  Settings,
  StyleSheet,
  ThemeFonts,
} from '../model/types.ts';
import { CONTENT_TYPE, OpcPackage, PackageError, REL, contentTypeForExtension, type Relationships } from '../opc/package.ts';
import { DOCUMENT_NAMESPACES, NS } from '../xml/namespaces.ts';
import { child, el, elements, type XmlElement } from '../xml/xml.ts';
import { readBlocks, writeBlocks, type ContentWriteContext } from './content.ts';
import { readSection, writeSection } from './properties.ts';
import { readNumbering, readSettings, readStyles, readThemeFonts, writeNumbering, writeStyles } from './styles.ts';

export class WordDocument {
  /** Body content, in order. Section breaks live on paragraphs' `properties.section`. */
  body: Block[] = [];
  /** Properties of the last (or only) section. */
  section: SectionProperties = { headers: [], footers: [], attrs: {} };
  styles: StyleSheet = { styles: [], rootAttrs: {} };
  numbering: Numbering = { abstracts: [], instances: [], extra: [], rootAttrs: {} };
  /** Headers and footers by part name (see SectionProperties.headers/footers). */
  readonly headersFooters = new Map<string, HeaderFooter>();
  /** Read-only views of preserved parts. */
  theme: ThemeFonts = { major: {}, minor: {} };
  settings: Settings = { defaultTabStop: 720, evenAndOddHeaders: false };

  private rootAttrs: Record<string, string> = { ...DOCUMENT_NAMESPACES };
  private rootChildren: { before: XmlElement[]; after: XmlElement[] } = { before: [], after: [] };
  private bodyAttrs: Record<string, string> = {};
  private stylesPart?: string;
  private sectionAbsent = false;
  private numberingPart?: string;

  private constructor(
    readonly pkg: OpcPackage,
    readonly mainPart: string,
  ) {}

  // --- Reading -----------------------------------------------------------------------------

  static async read(bytes: Uint8Array): Promise<WordDocument> {
    const pkg = await OpcPackage.read(bytes);
    const main = (await pkg.relationships('')).byType(REL.officeDocument)[0];
    const mainPart = main && pkg.resolveName((await pkg.relationships('')).partName(main));
    if (!mainPart) throw new PackageError('not a Word document: no main document part');

    const doc = new WordDocument(pkg, mainPart);
    const rels = await pkg.relationships(mainPart);
    const ctx = { rels };

    const root = await pkg.xml(mainPart);
    if (root.name !== 'w:document') throw new PackageError(`unexpected main part root <${root.name}>`);
    doc.rootAttrs = { ...root.attrs };
    const body = child(root, 'w:body');
    let seenBody = false;
    for (const e of elements(root)) {
      if (e === body) seenBody = true;
      else (seenBody ? doc.rootChildren.after : doc.rootChildren.before).push(e);
    }
    if (body) {
      doc.bodyAttrs = { ...body.attrs };
      const children = body.children.filter((c) => typeof c !== 'string');
      const last = children[children.length - 1];
      const sectPr = last && typeof last !== 'string' && last.name === 'w:sectPr' ? last : undefined;
      doc.body = readBlocks({ ...body, children: children.filter((c) => c !== sectPr) }, ctx);
      if (sectPr) doc.section = readSection(sectPr, ctx);
      else doc.sectionAbsent = true;
    }

    const partFor = (type: string) => {
      const rel = rels.byType(type)[0];
      return rel && !rel.external ? pkg.resolveName(rels.partName(rel)) : undefined;
    };
    doc.stylesPart = partFor(REL.styles);
    doc.numberingPart = partFor(REL.numbering);
    const themePart = partFor(REL.theme);
    const settingsPart = partFor(REL.settings);
    if (doc.stylesPart) doc.styles = readStyles(await pkg.xml(doc.stylesPart), ctx);
    if (doc.numberingPart) doc.numbering = readNumbering(await pkg.xml(doc.numberingPart), ctx);
    if (themePart) doc.theme = readThemeFonts(await pkg.xml(themePart));
    if (settingsPart) doc.settings = readSettings(await pkg.xml(settingsPart));

    for (const kind of ['header', 'footer'] as const) {
      for (const rel of rels.byType(kind === 'header' ? REL.header : REL.footer)) {
        const part = pkg.resolveName(rels.partName(rel));
        if (!part || doc.headersFooters.has(part)) continue;
        const partRoot = await pkg.xml(part);
        doc.headersFooters.set(part, {
          kind,
          part,
          children: readBlocks(partRoot, { rels: await pkg.relationships(part) }),
          rootAttrs: { ...partRoot.attrs },
        });
      }
    }
    return doc;
  }

  // --- Creating ----------------------------------------------------------------------------

  /** A new, empty document with Word's default page setup and styles. */
  static async create(): Promise<WordDocument> {
    const { BLANK_STYLES, BLANK_SETTINGS, BLANK_SECTION } = await import('./blank.ts');
    const pkg = OpcPackage.create();
    const doc = new WordDocument(pkg, 'word/document.xml');
    (await pkg.relationships('')).add(REL.officeDocument, doc.mainPart);
    const rels = await pkg.relationships(doc.mainPart);

    doc.styles = BLANK_STYLES();
    doc.stylesPart = 'word/styles.xml';
    rels.add(REL.styles, doc.stylesPart);

    pkg.set('word/settings.xml', BLANK_SETTINGS(), CONTENT_TYPE.settings);
    rels.add(REL.settings, 'word/settings.xml');

    doc.section = BLANK_SECTION();
    doc.body = [{ kind: 'paragraph', properties: {}, children: [], attrs: {} }];
    return doc;
  }

  /** Adds an image to the package; reference the returned part name from a Drawing. */
  addImage(data: Uint8Array, extension: string): string {
    const ext = extension.replace(/^\./, '').toLowerCase();
    const contentType = contentTypeForExtension(ext);
    if (!contentType) throw new Error(`unsupported image type: ${extension}`);
    const part = this.pkg.uniqueName('word/media/image', ext);
    this.pkg.setDefaultContentType(ext, contentType);
    this.pkg.set(part, data);
    return part;
  }

  /** Adds an empty header or footer part. Reference it from a section's headers/footers. */
  addHeaderFooter(kind: 'header' | 'footer'): HeaderFooter {
    const part = this.pkg.uniqueName(`word/${kind}`, 'xml');
    const hf: HeaderFooter = {
      kind,
      part,
      children: [{ kind: 'paragraph', properties: {}, children: [], attrs: {} }],
      rootAttrs: { ...DOCUMENT_NAMESPACES },
    };
    this.headersFooters.set(part, hf);
    return hf;
  }

  /** Bytes of a media part (e.g. a Drawing's image). */
  media(part: string): Promise<Uint8Array> {
    return this.pkg.bytes(part);
  }

  // --- Writing -----------------------------------------------------------------------------

  async write(): Promise<Uint8Array> {
    const pkg = this.pkg;
    const rels = await pkg.relationships(this.mainPart);
    let nextId = maxDrawingId(this) + 1;
    const context = (partRels: Relationships): ContentWriteContext => ({ rels: partRels, nextDrawingId: () => nextId++ });

    const ctx = context(rels);
    const section = writeSection(this.section, ctx);
    // Keep a missing w:sectPr missing unless the section has since been given properties.
    const omitSection = this.sectionAbsent && !section.children.length && !Object.keys(section.attrs).length;
    const body = el('w:body', this.bodyAttrs, [...writeBlocks(this.body, ctx), ...(omitSection ? [] : [section])]);
    const root = el('w:document', withNamespaces(this.rootAttrs), [
      ...this.rootChildren.before,
      body,
      ...this.rootChildren.after,
    ]);
    pkg.set(this.mainPart, root, CONTENT_TYPE.document);

    if (this.stylesPart || this.styles.styles.length) {
      this.stylesPart ??= 'word/styles.xml';
      rels.add(REL.styles, this.stylesPart);
      const styles = writeStyles(this.styles, ctx);
      styles.attrs = withNamespaces(styles.attrs, ['w']);
      pkg.set(this.stylesPart, styles, CONTENT_TYPE.styles);
    }
    if (this.numberingPart || this.numbering.abstracts.length || this.numbering.instances.length) {
      this.numberingPart ??= 'word/numbering.xml';
      rels.add(REL.numbering, this.numberingPart);
      const numbering = writeNumbering(this.numbering, ctx);
      numbering.attrs = withNamespaces(numbering.attrs, ['w']);
      pkg.set(this.numberingPart, numbering, CONTENT_TYPE.numbering);
    }

    for (const hf of this.headersFooters.values()) {
      const partCtx = context(await pkg.relationships(hf.part));
      const partRoot = el(hf.kind === 'header' ? 'w:hdr' : 'w:ftr', withNamespaces(hf.rootAttrs), writeBlocks(hf.children, partCtx));
      pkg.set(hf.part, partRoot, hf.kind === 'header' ? CONTENT_TYPE.header : CONTENT_TYPE.footer);
    }
    return pkg.write();
  }
}

/** Makes sure the prefixes this code writes are declared on a part's root element. */
function withNamespaces(attrs: Record<string, string>, prefixes = ['w', 'r', 'wp']): Record<string, string> {
  const out = { ...attrs };
  for (const prefix of prefixes) {
    if (!out[`xmlns:${prefix}`]) out[`xmlns:${prefix}`] = NS[prefix as keyof typeof NS];
  }
  return out;
}

/** Highest wp:docPr id in use, so new drawings get unique ids. */
function maxDrawingId(doc: WordDocument): number {
  let max = 0;
  const visit = (xml: XmlElement) => {
    const stack = [xml];
    while (stack.length) {
      const e = stack.pop()!;
      if (e.name === 'wp:docPr') max = Math.max(max, Number(e.attrs.id) || 0);
      for (const c of e.children) if (typeof c !== 'string') stack.push(c);
    }
  };
  const walk = (blocks: Block[]) => {
    const stack: unknown[] = [...blocks];
    while (stack.length) {
      const node = stack.pop() as { kind: string; [k: string]: unknown };
      switch (node.kind) {
        case 'raw':
          visit(node.xml as XmlElement);
          break;
        case 'drawing':
          if (node.xml) visit(node.xml as XmlElement);
          break;
        case 'paragraph':
        case 'wrapper':
        case 'hyperlink':
        case 'cell':
          stack.push(...(node.children as unknown[]));
          break;
        case 'run':
          stack.push(...(node.content as unknown[]));
          break;
        case 'table':
          stack.push(...(node.rows as unknown[]));
          break;
        case 'row':
          stack.push(...(node.cells as unknown[]));
          break;
      }
    }
  };
  walk(doc.body);
  for (const hf of doc.headersFooters.values()) walk(hf.children);
  return max;
}
