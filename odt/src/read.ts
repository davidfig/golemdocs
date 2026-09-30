// ODT -> WordDocument + OdtExtension.
//
// Styles: common paragraph and text styles become Word styles (built-in LibreOffice names map
// to Word's built-in ids, see names.ts); the paragraph default style becomes the document
// defaults. A paragraph's automatic style becomes its direct formatting, with the automatic
// style's text properties applied to every run (ODF formats the whole paragraph's text with
// them). Spans' automatic styles become run formatting.
//
// Lists: every independent text:list gets its own abstract numbering (so it counts from its
// own start); a list that continues another (text:continue-list / continue-numbering) reuses
// that list's numbering instance. Nesting depth is the level.
//
// Paragraph ids: every paragraph gets `w14:paraId`. An xml:id of the form "para-XXXXXXXX"
// (what writeOdt emits) is reused, so ids survive a round trip through ODT; the rest are
// numbered from 1, skipping ids in use.

import {
  commentEnd,
  commentReference,
  commentStart,
  mergeProperties,
  WordDocument,
  type AbstractNumbering,
  type Block,
  type Comment,
  type Drawing,
  type Hyperlink,
  type Inline,
  type NumberingLevel,
  type Paragraph,
  type ParagraphProperties,
  type Run,
  type RunContent,
  type RunProperties,
  type Style,
  type Table,
  type TableCell,
  type TableCellProperties,
  type TableRow,
  type XmlElement,
  type XmlNode,
} from '@word/docx';
import type {
  OdtBookmark,
  OdtExtension,
  OdtFragment,
  OdtProperties,
  OdtSection,
} from './extension.ts';
import { customStyleId, wordStyleFor } from './names.ts';
import {
  childElements,
  cloneXml,
  descendants,
  firstChild,
  fragment,
  imageExtension,
  lengthToTwips,
  OdtError,
  parseLength,
  parsePercent,
  textOf,
  toBase64,
  fromBase64,
} from './odf.ts';
import { openPackage, type OdfPackage } from './package.ts';
import { readCellProperties, readParagraphProperties, readTextProperties, type Unmapped } from './properties.ts';

const ID_ATTR = 'w14:paraId';
const MAX_ID = 0x80000000;
const formatId = (n: number) => n.toString(16).toUpperCase().padStart(8, '0');
/** The xml:id writeOdt gives paragraphs, carrying the paragraph id. */
const XML_ID = /^para-([0-9A-F]{8})$/;
/** Nesting deeper than this is flattened to text (garbage input can nest arbitrarily). */
const MAX_DEPTH = 48;
/** Repeat counts (rows, columns) are capped: a spreadsheet-style "1048576" would explode. */
const MAX_REPEAT = 256;

/** Text fields: their displayed text goes in the core, the element in the extension. */
const FIELDS = new Set(
  [
    'date', 'time', 'page-continuation', 'sender-firstname', 'sender-lastname', 'sender-initials', 'sender-title',
    'sender-position', 'sender-email', 'sender-phone-private', 'sender-fax', 'sender-company', 'sender-phone-work',
    'sender-street', 'sender-city', 'sender-postal-code', 'sender-country', 'sender-state-or-province', 'author-name',
    'author-initials', 'chapter', 'file-name', 'template-name', 'sheet-name', 'variable-set', 'variable-get',
    'variable-input', 'user-field-get', 'user-field-input', 'sequence', 'expression', 'text-input', 'initial-creator',
    'creation-date', 'creation-time', 'description', 'user-defined', 'print-time', 'print-date', 'printed-by', 'title',
    'subject', 'keywords', 'editing-cycles', 'editing-duration', 'modification-time', 'modification-date', 'creator',
    'page-count', 'paragraph-count', 'word-count', 'character-count', 'table-count', 'image-count', 'object-count',
    'page-variable-set', 'page-variable-get', 'placeholder', 'database-display', 'database-next', 'database-row-select',
    'database-row-number', 'database-name', 'conditional-text', 'hidden-text', 'reference-ref', 'bookmark-ref',
    'note-ref', 'sequence-ref', 'script', 'execute-macro', 'dde-connection', 'measure', 'table-formula',
    'bibliography-mark', 'hidden-paragraph',
  ].map((n) => `text:${n}`),
);
/** Indexes: their generated body paragraphs are kept in the core, the container in the extension. */
const INDEXES = new Set(
  ['table-of-content', 'illustration-index', 'table-index', 'object-index', 'user-index', 'alphabetical-index', 'bibliography'].map(
    (n) => `text:${n}`,
  ),
);
/** Declarations at the start of office:text, kept verbatim. */
const PROLOGUE = new Set([
  'text:variable-decls',
  'text:sequence-decls',
  'text:user-field-decls',
  'text:dde-connection-decls',
  'text:alphabetical-index-auto-mark-file',
  'office:forms',
]);
/** Inline elements that are only markers or change tracking, dropped. */
const DROPPED = new Set(['text:soft-page-break', 'text:number', 'text:change', 'text:change-start', 'text:change-end']);

type Part = 'content' | 'styles';

interface AutoStyles {
  /** `${family}:${name}` -> style (list styles use the family "list"). */
  byFamily: Map<string, XmlElement>;
  /** Every automatic style element by name, for preserving what a kept fragment uses. */
  byName: Map<string, XmlElement[]>;
}

interface ParagraphStyleInfo {
  styleId?: string;
  direct: ParagraphProperties;
  /** Text formatting of the paragraph's automatic style, applied to all its runs. */
  runBase: RunProperties;
  /** Font size of the paragraph (half-points), for percentage sizes in spans. */
  size: number;
  rest?: OdtProperties;
  breakAfter?: 'page' | 'column';
  masterPage?: string;
}

interface ParaCtx {
  p: Paragraph;
  id: string;
  offset: number;
  /** The last character was collapsible white space (or the paragraph just started). */
  lastSpace: boolean;
  size: number;
}

interface ListState {
  numId: number;
  abstract: AbstractNumbering;
  /** Levels that already have a numbered item (a start-value there restarts numbering). */
  seen: Set<number>;
}

export async function readOdt(bytes: Uint8Array): Promise<{ document: WordDocument; extension: OdtExtension }> {
  try {
    const pkg = await openPackage(bytes);
    const reader = new Reader(pkg, await WordDocument.create());
    return reader.read();
  } catch (e) {
    if (e instanceof OdtError) throw e;
    throw new OdtError(`could not read the OpenDocument file: ${(e as Error).message}`);
  }
}

class Reader {
  readonly ext: OdtExtension = { version: 1 };
  private readonly common = new Map<string, XmlElement>();
  private readonly defaults = new Map<string, XmlElement>();
  private readonly commonLists = new Map<string, XmlElement>();
  private readonly autos: Record<Part, AutoStyles> = {
    content: { byFamily: new Map(), byName: new Map() },
    styles: { byFamily: new Map(), byName: new Map() },
  };
  private readonly fonts = new Map<string, string>();
  /** `${family}:${odfName}` -> Word style id. */
  private readonly styleIds = new Map<string, string>();
  private part: Part = 'content';
  private defaultSize = 24;

  // Paragraph ids.
  private readonly reserved = new Set<string>();
  private readonly assigned = new Set<string>();
  private nextId = 1;
  /** Ids of paragraphs in creation order. */
  private readonly paragraphIds: string[] = [];

  // Lists.
  private readonly listsById = new Map<string, number>();
  private readonly lastListByStyle = new Map<string, number>();
  private nextAbstract: number;
  private nextInstance: number;

  // Anchors waiting for their end.
  /** office:name of each comment (and its replies' ids) whose office:annotation-end is still to come. */
  private readonly openAnnotations = new Map<string, string[]>();
  /** office:name -> comment id, for replies to find their parent. */
  private readonly annotationIds = new Map<string, string>();
  /** office:name of annotations that have an office:annotation-end somewhere. */
  private annotationEnds = new Set<string>();
  private nextComment = 0;
  private readonly openBookmarks = new Map<string, OdtBookmark>();

  private readonly memoParagraph = new Map<string, ParagraphStyleInfo>();
  private readonly memoSpan = new Map<string, RunProperties>();
  private readonly memoSize = new Map<string, number>();
  private readonly runKeys = new WeakMap<Run, string>();

  constructor(
    private readonly pkg: OdfPackage,
    private readonly doc: WordDocument,
  ) {
    this.nextAbstract = doc.numbering.abstracts.reduce((m, a) => Math.max(m, a.id), -1) + 1;
    this.nextInstance = doc.numbering.instances.reduce((m, a) => Math.max(m, a.id), 0) + 1;
  }

  read(): { document: WordDocument; extension: OdtExtension } {
    const { pkg, doc, ext } = this;
    if (pkg.meta !== undefined) ext.meta = pkg.meta;
    if (pkg.settings !== undefined) ext.settings = pkg.settings;
    if (Object.keys(pkg.namespaces).length) ext.namespaces = { ...pkg.namespaces };

    this.indexStyles();
    this.reserveIds();
    this.importStyles();

    const text = firstChild(firstChild(pkg.content, 'office:body'), 'office:text')!;
    this.part = 'content';
    for (const d of descendants(text)) if (d.name === 'office:annotation-end' && d.attrs['office:name']) this.annotationEnds.add(d.attrs['office:name']);
    const body: Block[] = [];
    this.readBlocks(text.children, body, true);
    if (!body.length) body.push(this.emptyParagraph());
    doc.body = body;

    this.importPage();
    return { document: doc, extension: clean(ext) };
  }

  // --- Styles ------------------------------------------------------------------------------

  private indexStyles(): void {
    const { pkg } = this;
    const roots: [XmlElement | undefined, Part][] = [
      [pkg.styles, 'styles'],
      [pkg.content, 'content'],
    ];
    const flat = pkg.styles === pkg.content;
    for (const [root, part] of roots) {
      if (!root) continue;
      for (const decl of childElements(firstChild(root, 'office:font-face-decls') ?? root, 'style:font-face')) {
        const name = decl.attrs['style:name'];
        if (name) this.fonts.set(name, (decl.attrs['svg:font-family'] ?? name).trim().replace(/^(['"])(.*)\1$/, '$2'));
      }
      const office = firstChild(root, 'office:styles');
      if (office) {
        for (const s of childElements(office)) {
          const name = s.attrs['style:name'];
          if (s.name === 'style:style' && name) this.common.set(`${s.attrs['style:family']}:${name}`, s);
          else if (s.name === 'style:default-style') this.defaults.set(s.attrs['style:family'] ?? '', s);
          else if (s.name === 'text:list-style' && name) this.commonLists.set(name, s);
        }
      }
      const automatic = firstChild(root, 'office:automatic-styles');
      // In a flat file both kinds of automatic style share one element: index it as both parts.
      const targets: Part[] = flat ? ['content', 'styles'] : [part];
      for (const target of targets) {
        for (const s of childElements(automatic ?? { name: '', attrs: {}, children: [] })) {
          const name = s.attrs['style:name'];
          if (!name) continue;
          const auto = this.autos[target];
          const family = s.name === 'text:list-style' ? 'list' : s.name === 'style:style' ? s.attrs['style:family'] : s.name;
          auto.byFamily.set(`${family}:${name}`, s);
          const list = auto.byName.get(name) ?? [];
          list.push(s);
          auto.byName.set(name, list);
        }
      }
      if (flat) break;
    }
  }

  private reserveIds(): void {
    for (const root of new Set([this.pkg.content, this.pkg.styles])) {
      if (!root) continue;
      for (const e of descendants(root)) {
        if (e.name !== 'text:p' && e.name !== 'text:h') continue;
        const match = XML_ID.exec(e.attrs['xml:id'] ?? '');
        if (match && parseInt(match[1], 16) < MAX_ID) this.reserved.add(match[1]);
      }
    }
  }

  private newParagraphId(xmlId: string | undefined): string {
    const match = XML_ID.exec(xmlId ?? '');
    let id: string;
    if (match && parseInt(match[1], 16) < MAX_ID && !this.assigned.has(match[1])) id = match[1];
    else {
      do id = formatId(this.nextId++);
      while (this.reserved.has(id) || this.assigned.has(id));
    }
    this.assigned.add(id);
    this.paragraphIds.push(id);
    return id;
  }

  private display(e: XmlElement): string {
    return e.attrs['style:display-name'] ?? e.attrs['style:name'] ?? '';
  }

  private importStyles(): void {
    const { doc, ext } = this;
    const defaultStyle = this.defaults.get('paragraph');
    const defaultText = firstChild(defaultStyle, 'style:text-properties');
    const defaultSize = parseLength(defaultText?.attrs['fo:font-size']);
    if (defaultSize !== undefined) this.defaultSize = Math.round(defaultSize * 2);

    // Document defaults: ODF's are single spacing and no margins, unlike Word's.
    const paragraphDefaults = readParagraphProperties(firstChild(defaultStyle, 'style:paragraph-properties'));
    const textDefaults = readTextProperties(defaultText, { fonts: this.fonts, baseSize: this.defaultSize });
    doc.styles.defaultParagraphProperties = paragraphDefaults.paragraph;
    const blankRun = doc.styles.defaultRunProperties ?? {};
    doc.styles.defaultRunProperties = {
      ...(blankRun.fonts && !textDefaults.run.fonts ? { fonts: blankRun.fonts } : {}),
      size: this.defaultSize,
      ...textDefaults.run,
    };
    if (paragraphDefaults.defaultTabStop !== undefined) doc.settings.defaultTabStop = paragraphDefaults.defaultTabStop;
    if (defaultStyle) {
      const extra = propertiesExtra([
        ['style:paragraph-properties', paragraphDefaults.rest],
        ['style:text-properties', textDefaults.rest],
      ]);
      if (extra) (ext.styles ??= {})['#default'] = { family: 'paragraph', ...extra };
    }

    // Ids first (parents may come after children).
    const used = new Map<string, string>();
    for (const s of doc.styles.styles) used.set(s.id, s.type);
    const taken = new Set<string>();
    for (const [key, e] of this.common) {
      const family = e.attrs['style:family'];
      if (family !== 'paragraph' && family !== 'text') continue;
      const known = wordStyleFor(family, this.display(e));
      let id = known?.[0] ?? customStyleId(this.display(e));
      const type = family === 'paragraph' ? 'paragraph' : 'character';
      if (taken.has(id) || (used.has(id) && used.get(id) !== type)) {
        const base = family === 'text' ? `${id}Char` : id;
        id = base;
        for (let n = 2; taken.has(id) || (used.has(id) && used.get(id) !== type); n++) id = `${base}${n}`;
      }
      taken.add(id);
      this.styleIds.set(key, id);
    }

    for (const [key, e] of this.common) {
      const family = e.attrs['style:family'] as 'paragraph' | 'text';
      const id = this.styleIds.get(key);
      if (!id) continue;
      const known = wordStyleFor(family, this.display(e));
      const parentName = e.attrs['style:parent-style-name'];
      const parentSize = parentName ? this.styleSize(family, parentName, new Set()) : this.defaultSize;
      const text = readTextProperties(firstChild(e, 'style:text-properties'), { fonts: this.fonts, baseSize: parentSize });
      const style: Style = {
        type: family === 'paragraph' ? 'paragraph' : 'character',
        id,
        name: known?.[1] ?? this.display(e),
        attrs: {},
      };
      const parent = parentName ? this.styleIds.get(`${family}:${parentName}`) : undefined;
      if (parent && parent !== id) style.basedOn = parent;
      const next = e.attrs['style:next-style-name'];
      if (family === 'paragraph' && next && this.styleIds.get(`paragraph:${next}`)) style.next = this.styleIds.get(`paragraph:${next}`);
      const sections: [string, Unmapped][] = [['style:text-properties', text.rest]];
      if (family === 'paragraph') {
        const para = readParagraphProperties(firstChild(e, 'style:paragraph-properties'));
        const outline = Number(e.attrs['style:default-outline-level']);
        if (outline >= 1) para.paragraph.outlineLevel = Math.min(outline, 9) - 1;
        else if (/^Heading[1-9]$/.test(id)) para.paragraph.outlineLevel = Number(id.slice(7)) - 1;
        if (Object.keys(para.paragraph).length) style.paragraphProperties = para.paragraph;
        sections.unshift(['style:paragraph-properties', para.rest]);
      }
      if (Object.keys(text.run).length) style.runProperties = text.run;
      if (!known) style.customStyle = true;

      // Unmapped style attributes and property elements.
      const mappedAttrs = new Set([
        'style:name', 'style:display-name', 'style:family', 'style:parent-style-name', 'style:next-style-name', 'style:default-outline-level',
      ]);
      const styleAttributes: Record<string, string> = {};
      for (const [k, v] of Object.entries(e.attrs)) if (!mappedAttrs.has(k) && !k.startsWith('xmlns')) styleAttributes[k] = v;
      for (const c of childElements(e)) {
        if (c.name !== 'style:paragraph-properties' && c.name !== 'style:text-properties') {
          sections.push(['', { attributes: {}, children: [c] }]); // '' = a child of the style itself
        }
      }
      const extra = propertiesExtra(sections);
      if (extra || Object.keys(styleAttributes).length) {
        (ext.styles ??= {})[e.attrs['style:name']] = {
          family,
          ...(Object.keys(styleAttributes).length ? { styleAttributes } : {}),
          ...extra,
        };
      }

      const existing = doc.styles.styles.findIndex((s) => s.id === id);
      if (existing >= 0) {
        const old = doc.styles.styles[existing];
        if (old.isDefault) style.isDefault = true;
        if (old.extra) style.extra = old.extra;
        if (!known) delete style.customStyle;
        doc.styles.styles[existing] = style;
      } else doc.styles.styles.push(style);
    }

    // What the core doesn't model, verbatim: outline style, notes configuration, graphic styles.
    const office = firstChild(this.pkg.styles ?? this.pkg.content, 'office:styles');
    for (const s of office ? childElements(office) : []) {
      const family = s.attrs['style:family'];
      if (s.name === 'style:style' && (family === 'paragraph' || family === 'text')) continue;
      if (s.name === 'style:default-style' && family === 'paragraph') continue;
      (ext.styleDefinitions ??= []).push(fragment(s));
    }
  }

  /** Effective font size (half-points) of a common style, percentages resolved up the chain. */
  private styleSize(family: string, name: string, seen: Set<string>): number {
    const key = `${family}:${name}`;
    const memo = this.memoSize.get(key);
    if (memo !== undefined) return memo;
    const e = this.common.get(key);
    if (!e || seen.has(key)) return this.defaultSize;
    seen.add(key);
    const parent = e.attrs['style:parent-style-name'];
    const parentSize = parent ? this.styleSize(family, parent, seen) : this.defaultSize;
    const size = sizeFrom(firstChild(e, 'style:text-properties'), parentSize);
    this.memoSize.set(key, size);
    return size;
  }

  private auto(family: string, name: string): XmlElement | undefined {
    return this.autos[this.part].byFamily.get(`${family}:${name}`);
  }

  private paragraphStyle(name: string | undefined): ParagraphStyleInfo {
    const key = `${this.part}|${name ?? ''}`;
    const memo = this.memoParagraph.get(key);
    if (memo) return memo;
    let info: ParagraphStyleInfo;
    const auto = name ? this.auto('paragraph', name) : undefined;
    if (auto) {
      const parent = auto.attrs['style:parent-style-name'];
      const parentSize = parent ? this.styleSize('paragraph', parent, new Set()) : this.defaultSize;
      const para = readParagraphProperties(firstChild(auto, 'style:paragraph-properties'));
      const text = readTextProperties(firstChild(auto, 'style:text-properties'), { fonts: this.fonts, baseSize: parentSize });
      const rest = propertiesExtra([
        ['style:paragraph-properties', para.rest],
        ['style:text-properties', text.rest],
      ]);
      info = {
        styleId: parent ? this.styleIds.get(`paragraph:${parent}`) : undefined,
        direct: para.paragraph,
        runBase: text.run,
        size: text.run.size ?? parentSize,
        rest,
        breakAfter: para.breakAfter,
        masterPage: auto.attrs['style:master-page-name'] || undefined,
      };
    } else {
      const id = name ? this.styleIds.get(`paragraph:${name}`) : undefined;
      info = { styleId: id, direct: {}, runBase: {}, size: name ? this.styleSize('paragraph', name, new Set()) : this.defaultSize };
    }
    this.memoParagraph.set(key, info);
    return info;
  }

  /** Run formatting of a text:span's (or text:a's) style. */
  private spanStyle(name: string | undefined, baseSize: number): RunProperties {
    if (!name) return {};
    const key = `${this.part}|${name}|${baseSize}`;
    const memo = this.memoSpan.get(key);
    if (memo) return memo;
    let run: RunProperties = {};
    const auto = this.auto('text', name);
    if (auto) {
      run = readTextProperties(firstChild(auto, 'style:text-properties'), { fonts: this.fonts, baseSize }).run;
      const parent = auto.attrs['style:parent-style-name'];
      const parentId = parent ? this.styleIds.get(`text:${parent}`) : undefined;
      if (parentId) run = { style: parentId, ...run };
    } else {
      const id = this.styleIds.get(`text:${name}`);
      if (id) run = { style: id };
    }
    this.memoSpan.set(key, run);
    return run;
  }

  /** Makes sure a Heading<n> style exists (for text:h without a style). */
  private ensureHeading(level: number): string {
    const id = `Heading${level}`;
    if (!this.doc.styles.styles.some((s) => s.id === id)) {
      this.doc.styles.styles.push({
        type: 'paragraph',
        id,
        name: `heading ${level}`,
        basedOn: 'Normal',
        next: 'Normal',
        paragraphProperties: { keepNext: true, keepLines: true, spacing: { before: 240, after: 120 }, outlineLevel: level - 1 },
        runProperties: { bold: true, size: Math.max(22, 36 - level * 2) },
        attrs: {},
      });
    }
    return id;
  }

  private outlineOf(styleId: string | undefined): number | undefined {
    const seen = new Set<string>();
    let style = this.doc.styles.styles.find((s) => s.id === (styleId ?? 'Normal'));
    while (style && !seen.has(style.id)) {
      seen.add(style.id);
      if (style.paragraphProperties?.outlineLevel !== undefined) return style.paragraphProperties.outlineLevel;
      const parent = style.basedOn;
      style = parent ? this.doc.styles.styles.find((s) => s.id === parent) : undefined;
    }
    return undefined;
  }

  // --- Blocks ------------------------------------------------------------------------------

  private emptyParagraph(): Paragraph {
    return { kind: 'paragraph', properties: {}, children: [], attrs: { [ID_ATTR]: this.newParagraphId(undefined) } };
  }

  private get lastParagraphId(): string | null {
    return this.paragraphIds.length ? this.paragraphIds[this.paragraphIds.length - 1] : null;
  }

  private readBlocks(nodes: XmlNode[], out: Block[], topLevel = false, depth = 0): void {
    for (const node of nodes) {
      if (typeof node === 'string') continue;
      this.readBlock(node, out, topLevel, depth);
    }
  }

  private readBlock(e: XmlElement, out: Block[], topLevel: boolean, depth: number): void {
    if (depth > MAX_DEPTH) {
      // Pathological nesting: keep the text.
      const p = this.emptyParagraph();
      const text = textOf(e).replace(/\s+/g, ' ').trim();
      if (text) p.children.push({ kind: 'run', properties: {}, content: [{ kind: 'text', text }], attrs: {} });
      out.push(p);
      return;
    }
    const name = e.name;
    if (name === 'text:p' || name === 'text:h') out.push(this.readParagraph(e));
    else if (name === 'text:list') this.readList(e, out, 0, null, depth);
    else if (name === 'table:table') out.push(this.readTable(e, depth));
    else if (name === 'text:section' || INDEXES.has(name)) this.readSection(e, out, depth);
    else if (name === 'text:numbered-paragraph') this.readBlocks(e.children, out, false, depth + 1);
    else if (name === 'text:soft-page-break' || name === 'text:tracked-changes' || DROPPED.has(name)) return;
    else if (PROLOGUE.has(name)) {
      if (topLevel) (this.ext.prologue ??= []).push(this.fragment(e));
    } else {
      // Page-anchored frames, shapes and anything else: kept verbatim after the last paragraph.
      (this.ext.objects ??= []).push({ placement: 'block', paragraphId: this.lastParagraphId, offset: 0, fragment: this.fragment(e) });
    }
  }

  private readSection(e: XmlElement, out: Block[], depth: number): void {
    const record: OdtSection = { element: e.name, attributes: { ...e.attrs }, firstParagraphId: '', lastParagraphId: '' };
    if (e.attrs['text:name']) record.name = e.attrs['text:name'];
    const styles = this.collectStyles({ name: e.name, attrs: e.attrs, children: [] });
    if (styles.length) record.styles = styles;
    const sections = (this.ext.sections ??= []);
    sections.push(record); // before its children, so nested sections follow their parent
    const before = this.paragraphIds.length;
    const content = (children: XmlNode[]) => {
      for (const c of children) {
        if (typeof c === 'string') continue;
        if (c.name.endsWith('-source') || c.name === 'office:dde-source') (record.prologue ??= []).push(this.fragment(c));
        else if (c.name === 'text:index-body' || c.name === 'text:index-title') content(c.children);
        else this.readBlock(c, out, false, depth + 1);
      }
    };
    content(e.children);
    if (this.paragraphIds.length === before) {
      sections.splice(sections.indexOf(record), 1);
      return;
    }
    record.firstParagraphId = this.paragraphIds[before];
    record.lastParagraphId = this.paragraphIds[this.paragraphIds.length - 1];
  }

  // --- Paragraphs --------------------------------------------------------------------------

  private readParagraph(e: XmlElement): Paragraph {
    const info = this.paragraphStyle(e.attrs['text:style-name']);
    const properties = clone(info.direct);
    if (info.styleId) properties.style = info.styleId;
    if (info.masterPage && this.paragraphIds.length && properties.pageBreakBefore === undefined) properties.pageBreakBefore = true;
    if (e.name === 'text:h') {
      const level = Math.min(Math.max(parseInt(e.attrs['text:outline-level'] ?? '1', 10) || 1, 1), 9);
      if (!e.attrs['text:style-name']) properties.style = this.ensureHeading(level);
      else if (this.outlineOf(properties.style) !== level - 1) properties.outlineLevel = level - 1;
    }
    const id = this.newParagraphId(e.attrs['xml:id']);
    const p: Paragraph = { kind: 'paragraph', properties, children: [], attrs: { [ID_ATTR]: id } };
    if (info.rest) (this.ext.paragraphs ??= {})[id] = clone(info.rest);
    const ctx: ParaCtx = { p, id, offset: 0, lastSpace: true, size: info.size };
    this.walk(e.children, p.children, info.runBase, ctx, 0, false);
    if (info.breakAfter) this.add(p.children, info.runBase, { kind: 'break', type: info.breakAfter }, ctx);
    if (!p.children.length && Object.keys(info.runBase).length) properties.runProperties = clone(info.runBase);
    return p;
  }

  /** Appends a run item, merging into the previous run when its formatting is the same. */
  private add(container: Inline[], props: RunProperties, item: RunContent, ctx: ParaCtx): void {
    const key = JSON.stringify(props);
    const last = container[container.length - 1];
    let run: Run;
    if (last && last.kind === 'run' && this.runKeys.get(last) === key) run = last;
    else {
      run = { kind: 'run', properties: clone(props), content: [], attrs: {} };
      this.runKeys.set(run, key);
      container.push(run);
    }
    const previous = run.content[run.content.length - 1];
    if (item.kind === 'text' && previous?.kind === 'text') previous.text += item.text;
    else run.content.push(item);
    ctx.offset += item.kind === 'text' ? item.text.length : 1;
  }

  private addText(container: Inline[], props: RunProperties, text: string, ctx: ParaCtx): void {
    if (text) this.add(container, props, { kind: 'text', text }, ctx);
  }

  /** ODF white-space rules: runs of spaces, tabs and newlines collapse to one space. */
  private collapse(text: string, ctx: ParaCtx): string {
    let out = '';
    for (const ch of text) {
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        if (!ctx.lastSpace) out += ' ';
        ctx.lastSpace = true;
      } else {
        out += ch;
        ctx.lastSpace = false;
      }
    }
    return out;
  }

  private walk(nodes: XmlNode[], container: Inline[], props: RunProperties, ctx: ParaCtx, depth: number, inLink: boolean): void {
    for (const node of nodes) {
      if (typeof node === 'string') {
        this.addText(container, props, this.collapse(node, ctx), ctx);
        continue;
      }
      if (depth > MAX_DEPTH) {
        this.addText(container, props, this.collapse(textOf(node), ctx), ctx);
        continue;
      }
      this.inline(node, container, props, ctx, depth, inLink);
    }
  }

  private inline(e: XmlElement, container: Inline[], props: RunProperties, ctx: ParaCtx, depth: number, inLink: boolean): void {
    const name = e.name;
    switch (name) {
      case 'text:span':
        this.walk(e.children, container, mergeProperties(props, this.spanStyle(e.attrs['text:style-name'], ctx.size)), ctx, depth + 1, inLink);
        return;
      case 'text:a': {
        const style = this.spanStyle(e.attrs['text:style-name'], ctx.size);
        const linkProps = style.style && !props.style ? mergeProperties(props, { style: style.style }) : props;
        const href = e.attrs['xlink:href'] ?? '';
        if (inLink || !href) {
          this.walk(e.children, container, linkProps, ctx, depth + 1, inLink);
          return;
        }
        const link: Hyperlink = { kind: 'hyperlink', children: [], attrs: {} };
        if (href.startsWith('#')) link.anchor = safeDecode(href.slice(1));
        else link.url = href;
        container.push(link);
        this.walk(e.children, link.children, linkProps, ctx, depth + 1, true);
        return;
      }
      case 'text:s': {
        const count = Math.min(Math.max(parseInt(e.attrs['text:c'] ?? '1', 10) || 1, 1), 10000);
        this.addText(container, props, ' '.repeat(count), ctx);
        ctx.lastSpace = false;
        return;
      }
      case 'text:tab':
        this.add(container, props, { kind: 'tab' }, ctx);
        ctx.lastSpace = false;
        return;
      case 'text:line-break':
        this.add(container, props, { kind: 'break' }, ctx);
        ctx.lastSpace = false;
        return;
      case 'office:annotation':
        this.annotation(e, container, ctx);
        return;
      case 'office:annotation-end': {
        const open = this.openAnnotations.get(e.attrs['office:name'] ?? '');
        if (open) {
          for (const id of open) this.closeComment(id, container, ctx);
          this.openAnnotations.delete(e.attrs['office:name']);
        }
        return;
      }
      case 'text:bookmark':
      case 'text:bookmark-start': {
        const bookmark: OdtBookmark = { name: e.attrs['text:name'] ?? '', paragraphId: ctx.id, offset: ctx.offset };
        (this.ext.bookmarks ??= []).push(bookmark);
        if (name === 'text:bookmark-start') this.openBookmarks.set(bookmark.name, bookmark);
        return;
      }
      case 'text:bookmark-end': {
        const open = this.openBookmarks.get(e.attrs['text:name'] ?? '');
        if (open) {
          open.end = { paragraphId: ctx.id, offset: ctx.offset };
          this.openBookmarks.delete(e.attrs['text:name']);
        }
        return;
      }
      case 'text:page-number':
      case 'text:page-count': {
        // Real fields in the core: PAGE / NUMPAGES with the displayed number as the result.
        const instr = name === 'text:page-number' ? ' PAGE ' : ' NUMPAGES ';
        const fieldChar = (type: 'begin' | 'separate' | 'end'): RunContent => ({
          kind: 'fieldChar',
          type,
          xml: { name: 'w:fldChar', attrs: { 'w:fldCharType': type }, children: [] },
        });
        this.add(container, props, fieldChar('begin'), ctx);
        this.add(container, props, { kind: 'instrText', text: instr }, ctx);
        this.add(container, props, fieldChar('separate'), ctx);
        this.addText(container, props, textOf(e), ctx);
        this.add(container, props, fieldChar('end'), ctx);
        ctx.lastSpace = false;
        return;
      }
      case 'draw:frame':
        if (this.frame(e, container, props, ctx)) return;
        this.inlineObject(e, ctx);
        return;
      case 'draw:a':
        this.walk(e.children, container, props, ctx, depth + 1, inLink);
        return;
      case 'text:ruby':
        this.walk(firstChild(e, 'text:ruby-base')?.children ?? [], container, props, ctx, depth + 1, inLink);
        return;
      case 'text:meta':
      case 'text:meta-field':
        this.walk(e.children, container, props, ctx, depth + 1, inLink);
        return;
    }
    if (DROPPED.has(name)) return;
    if (FIELDS.has(name)) {
      const text = textOf(e);
      (this.ext.fields ??= []).push({ paragraphId: ctx.id, offset: ctx.offset, text, fragment: this.fragment(e) });
      this.addText(container, props, text, ctx);
      ctx.lastSpace = false;
      return;
    }
    if (name.startsWith('draw:') || name.startsWith('dr3d:') || name === 'text:note' || !textOf(e).trim()) {
      // Shapes, notes, index and reference marks: kept verbatim at this position.
      this.inlineObject(e, ctx);
      return;
    }
    // Unknown container with text: keep the text.
    this.walk(e.children, container, props, ctx, depth + 1, inLink);
  }

  private inlineObject(e: XmlElement, ctx: ParaCtx): void {
    (this.ext.objects ??= []).push({ placement: 'inline', paragraphId: ctx.id, offset: ctx.offset, fragment: this.fragment(e) });
  }

  /**
   * An office:annotation becomes a comment in the core, its range marked in the text. A comment
   * with an office:annotation-end covers the text up to it; without one it is an empty range.
   * A reply (loext:parent-name) gets its own markers over the same range as its parent's.
   */
  private annotation(e: XmlElement, container: Inline[], ctx: ParaCtx): void {
    const id = String(this.nextComment++);
    const paragraphs: string[] = [];
    const collect = (nodes: XmlElement[]) => {
      for (const c of nodes) {
        if (c.name === 'text:p' || c.name === 'text:h') paragraphs.push(commentText(c));
        else if (c.name === 'text:list' || c.name === 'text:list-item' || c.name === 'text:list-header') collect(childElements(c));
      }
    };
    collect(childElements(e));
    const creator = firstChild(e, 'dc:creator');
    const comment: Comment = { id, author: creator ? textOf(creator) : '', paragraphs };
    const date = firstChild(e, 'dc:date');
    if (date) comment.date = textOf(date).trim();
    const initials = firstChild(e, 'meta:creator-initials') ?? firstChild(e, 'loext:sender-initials');
    if (initials) comment.initials = textOf(initials);
    if (e.attrs['loext:resolved'] === 'true') comment.resolved = true;
    const name = e.attrs['office:name'];
    const parentName = e.attrs['loext:parent-name'];
    const parent = parentName ? this.annotationIds.get(parentName) : undefined;
    if (parent) comment.parentId = parent;
    this.doc.comments.push(comment);
    if (name) this.annotationIds.set(name, id);

    this.openComment(id, container, ctx);
    if (parent && parentName && this.openAnnotations.has(parentName)) {
      // The parent's range is still open: this reply's markers end where it does.
      this.openAnnotations.get(parentName)!.push(id);
    } else if (!parent && name && this.annotationEnds.has(name)) {
      this.openAnnotations.set(name, [id]);
    } else this.closeComment(id, container, ctx);
  }

  private openComment(id: string, container: Inline[], ctx: ParaCtx): void {
    container.push(commentStart(id));
    ctx.offset++;
  }

  private closeComment(id: string, container: Inline[], ctx: ParaCtx): void {
    container.push(commentEnd(id), commentReference(id));
    ctx.offset += 2;
  }

  /** A picture frame becomes an inline drawing; returns false for anything else. */
  private frame(e: XmlElement, container: Inline[], props: RunProperties, ctx: ParaCtx): boolean {
    if (firstChild(e, 'draw:text-box') || firstChild(e, 'draw:object') || firstChild(e, 'draw:object-ole') || firstChild(e, 'draw:plugin')) {
      return false;
    }
    let data: Uint8Array | undefined;
    let ext: string | undefined;
    for (const image of childElements(e, 'draw:image')) {
      const href = (image.attrs['xlink:href'] ?? '').replace(/^\.\//, '');
      const binary = firstChild(image, 'office:binary-data');
      const candidate = binary ? decodeBinary(textOf(binary)) : this.pkg.files.get(href);
      const candidateExt = imageExtension(href, image.attrs['draw:mime-type']) ?? (binary ? sniffImage(candidate) : undefined);
      if (candidate && candidateExt) {
        data = candidate;
        ext = candidateExt;
        break;
      }
    }
    if (!data || !ext) return false;
    let part: string;
    try {
      part = this.doc.addImage(data, ext);
    } catch {
      return false;
    }
    const emu = (value: string | undefined) => {
      const points = parseLength(value);
      return points === undefined || points <= 0 ? 914400 : Math.round(points * 12700);
    };
    const drawing: Drawing = { kind: 'drawing', inline: true, width: emu(e.attrs['svg:width']), height: emu(e.attrs['svg:height']), image: part };
    if (e.attrs['draw:name']) drawing.name = e.attrs['draw:name'];
    const desc = firstChild(e, 'svg:desc') ?? firstChild(e, 'svg:title');
    if (desc && textOf(desc)) drawing.description = textOf(desc);
    // Keep how a floating picture was anchored and positioned.
    if ((e.attrs['text:anchor-type'] ?? 'paragraph') !== 'as-char') {
      const shell = { name: e.name, attrs: { ...e.attrs }, children: [] };
      (this.ext.imageFrames ??= []).push({ paragraphId: ctx.id, offset: ctx.offset, frame: this.fragment(shell) });
    }
    this.add(container, props, drawing, ctx);
    ctx.lastSpace = false;
    return true;
  }

  /** Verbatim XML plus the automatic styles and files it refers to. */
  private fragment(e: XmlElement): OdtFragment {
    const out: OdtFragment = { xml: fragment(e) };
    const styles = this.collectStyles(e);
    if (styles.length) out.styles = styles;
    const media: Record<string, string> = {};
    const mediaTypes: Record<string, string> = {};
    for (const d of descendants(e)) {
      const href = d.attrs['xlink:href'];
      if (!href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/')) continue;
      const path = href.replace(/^\.\//, '');
      const add = (p: string) => {
        const data = this.pkg.files.get(p);
        if (!data) return;
        media[p] = toBase64(data);
        const type = this.pkg.mediaTypes.get(p);
        if (type !== undefined) mediaTypes[p] = type;
      };
      if (this.pkg.files.has(path)) add(path);
      else {
        // An embedded object is a directory of files.
        const dir = path.endsWith('/') ? path : `${path}/`;
        for (const p of this.pkg.files.keys()) if (p.startsWith(dir)) add(p);
        const type = this.pkg.mediaTypes.get(dir);
        if (type !== undefined) mediaTypes[dir] = type;
      }
    }
    if (Object.keys(media).length) out.media = media;
    if (Object.keys(mediaTypes).length) out.mediaTypes = mediaTypes;
    return out;
  }

  /** Automatic styles an element (and the styles it uses) refers to, verbatim, in first-use order. */
  private collectStyles(e: XmlElement): string[] {
    const byName = this.autos[this.part].byName;
    const out: string[] = [];
    const seen = new Set<XmlElement>();
    const queue: XmlElement[] = [e];
    for (let i = 0; i < queue.length; i++) {
      for (const d of descendants(queue[i])) {
        for (const [key, value] of Object.entries(d.attrs)) {
          if (!key.endsWith('style-name') || key === 'style:parent-style-name') continue;
          for (const s of byName.get(value) ?? []) {
            if (seen.has(s)) continue;
            seen.add(s);
            out.push(fragment(s));
            queue.push(s);
          }
        }
      }
    }
    return out;
  }

  // --- Lists -------------------------------------------------------------------------------

  private readList(e: XmlElement, out: Block[], level: number, state: ListState | null, depth: number): void {
    if (!state) {
      const styleName = e.attrs['text:style-name'] ?? '';
      const continued = e.attrs['text:continue-list'];
      let numId: number | undefined;
      if (continued && this.listsById.has(continued)) numId = this.listsById.get(continued);
      else if (e.attrs['text:continue-numbering'] === 'true') numId = this.lastListByStyle.get(styleName);
      if (numId === undefined) numId = this.newList(styleName);
      const instance = this.doc.numbering.instances.find((n) => n.id === numId)!;
      const abstract = this.doc.numbering.abstracts.find((a) => a.id === instance.abstractId)!;
      state = { numId, abstract, seen: new Set() };
      this.lastListByStyle.set(styleName, numId);
      if (e.attrs['xml:id']) this.listsById.set(e.attrs['xml:id'], numId);
    }
    const lvl = Math.min(level, 8);
    const indent = state.abstract.levels[lvl]?.paragraphProperties?.indent?.left;
    const unnumbered = (blocks: Block[]) => {
      // Further paragraphs of an item line up with its text.
      for (const b of blocks) {
        if (b.kind !== 'paragraph' || indent === undefined) continue;
        if (b.properties.indent?.left === undefined) b.properties.indent = { ...b.properties.indent, left: indent };
      }
      out.push(...blocks);
    };
    for (const item of childElements(e)) {
      if (item.name === 'text:list-header') {
        const blocks: Block[] = [];
        this.readBlocks(item.children, blocks, false, depth + 1);
        unnumbered(blocks);
        continue;
      }
      if (item.name !== 'text:list-item') continue;
      const start = item.attrs['text:start-value'];
      if (start !== undefined && Number.isFinite(Number(start))) this.restart(state, lvl, Math.max(0, Math.round(Number(start))));
      let numbered = false;
      for (const c of childElements(item)) {
        if (c.name === 'text:list') {
          this.readList(c, out, level + 1, state, depth + 1);
          numbered = true; // a nested list first means this level shows no label
        } else if ((c.name === 'text:p' || c.name === 'text:h') && !numbered) {
          const p = this.readParagraph(c);
          p.properties.numbering = { id: state.numId, level: lvl };
          state.seen.add(lvl);
          out.push(p);
          numbered = true;
        } else {
          const blocks: Block[] = [];
          this.readBlock(c, blocks, false, depth + 1);
          unnumbered(blocks);
        }
      }
    }
  }

  /** text:start-value: the level's start if nothing was numbered there yet, else a restart. */
  private restart(state: ListState, level: number, start: number): void {
    if (!state.seen.has(level)) {
      const def = state.abstract.levels[level];
      if (def) def.start = start;
      return;
    }
    const id = this.nextInstance++;
    this.doc.numbering.instances.push({ id, abstractId: state.abstract.id, overrides: [{ level, startOverride: start }], attrs: {} });
    state.numId = id;
    state.seen = new Set();
  }

  private newList(styleName: string): number {
    const style = this.autos[this.part].byFamily.get(`list:${styleName}`) ?? this.commonLists.get(styleName);
    const abstract: AbstractNumbering = { id: this.nextAbstract++, multiLevelType: 'hybridMultilevel', levels: listLevels(style), attrs: {} };
    const id = this.nextInstance++;
    this.doc.numbering.abstracts.push(abstract);
    this.doc.numbering.instances.push({ id, abstractId: abstract.id, overrides: [], attrs: {} });
    return id;
  }

  // --- Tables ------------------------------------------------------------------------------

  private readTable(e: XmlElement, depth: number): Table {
    const tableStyle = this.auto('table', e.attrs['table:style-name'] ?? '') ?? this.common.get(`table:${e.attrs['table:style-name']}`);
    const tableProps = firstChild(tableStyle, 'style:table-properties');
    const table: Table = { kind: 'table', properties: {}, grid: [], rows: [] };
    const width = lengthToTwips(tableProps?.attrs['style:width']);
    const relWidth = parsePercent(tableProps?.attrs['style:rel-width']);
    if (relWidth !== undefined) table.properties.width = { w: String(Math.round(relWidth * 50)), type: 'pct' };
    else if (width !== undefined) table.properties.width = { w: String(width), type: 'dxa' };
    const align = tableProps?.attrs['table:align'];
    if (align === 'center') table.properties.justification = 'center';
    else if (align === 'right') table.properties.justification = 'right';
    const marginLeft = lengthToTwips(tableProps?.attrs['fo:margin-left']);
    if (marginLeft && align !== 'center' && align !== 'right') table.properties.indent = { w: String(marginLeft), type: 'dxa' };
    table.properties.layout = 'fixed';

    // Columns.
    const columns: { width?: number; rel?: number }[] = [];
    const rows: { e: XmlElement; header: boolean }[] = [];
    const collect = (parent: XmlElement, header: boolean) => {
      for (const c of childElements(parent)) {
        if (c.name === 'table:table-column') {
          const style = this.auto('table-column', c.attrs['table:style-name'] ?? '') ?? this.common.get(`table-column:${c.attrs['table:style-name']}`);
          const props = firstChild(style, 'style:table-column-properties');
          const col = { width: lengthToTwips(props?.attrs['style:column-width']), rel: parseFloat(props?.attrs['style:rel-column-width'] ?? '') || undefined };
          const repeat = Math.min(Math.max(parseInt(c.attrs['table:number-columns-repeated'] ?? '1', 10) || 1, 1), MAX_REPEAT);
          for (let i = 0; i < repeat; i++) columns.push(col);
        } else if (c.name === 'table:table-columns' || c.name === 'table:table-column-group' || c.name === 'table:table-header-columns') collect(c, header);
        else if (c.name === 'table:table-row') {
          const repeat = Math.min(Math.max(parseInt(c.attrs['table:number-rows-repeated'] ?? '1', 10) || 1, 1), MAX_REPEAT);
          for (let i = 0; i < repeat; i++) rows.push({ e: c, header });
        } else if (c.name === 'table:table-header-rows') collect(c, true);
        else if (c.name === 'table:table-rows' || c.name === 'table:table-row-group') collect(c, header);
      }
    };
    collect(e, false);

    // Rows (read first: they tell how many columns there really are).
    const vspans: ({ remaining: number; span: number; props: TableCellProperties } | undefined)[] = [];
    let maxColumns = columns.length;
    const built: { row: TableRow; cols: number[] }[] = [];
    for (const { e: rowEl, header } of rows) {
      const rowStyle = this.auto('table-row', rowEl.attrs['table:style-name'] ?? '');
      const rowProps = firstChild(rowStyle, 'style:table-row-properties');
      const row: TableRow = { kind: 'row', properties: {}, cells: [], attrs: {} };
      if (header) row.properties.header = true;
      const minHeight = lengthToTwips(rowProps?.attrs['style:min-row-height']);
      const exact = lengthToTwips(rowProps?.attrs['style:row-height']);
      if (exact !== undefined) row.properties.height = { val: exact, hRule: 'exact' };
      else if (minHeight !== undefined) row.properties.height = { val: minHeight, hRule: 'atLeast' };
      if (rowProps?.attrs['fo:keep-together'] === 'always') row.properties.cantSplit = true;

      const cols: number[] = [];
      let col = 0;
      let skip = 0;
      const cells: XmlElement[] = [];
      for (const c of childElements(rowEl)) {
        if (c.name !== 'table:table-cell' && c.name !== 'table:covered-table-cell') continue;
        const repeat = Math.min(Math.max(parseInt(c.attrs['table:number-columns-repeated'] ?? '1', 10) || 1, 1), MAX_REPEAT);
        for (let i = 0; i < repeat; i++) cells.push(c);
      }
      for (const c of cells) {
        if (skip > 0) {
          skip--;
          continue;
        }
        const v = vspans[col];
        if (c.name === 'table:covered-table-cell') {
          if (v && v.remaining > 0) {
            const cell: TableCell = { kind: 'cell', properties: { ...clone(v.props), vMerge: 'continue' }, children: [this.emptyParagraph()], attrs: {} };
            if (v.span > 1) cell.properties.gridSpan = v.span;
            row.cells.push(cell);
            cols.push(col);
            v.remaining--;
            skip = v.span - 1;
            col += v.span;
          } else {
            // Covered by nothing we know of: an empty cell keeps the grid square.
            row.cells.push({ kind: 'cell', properties: {}, children: [this.emptyParagraph()], attrs: {} });
            cols.push(col);
            col++;
          }
          continue;
        }
        const span = Math.min(Math.max(parseInt(c.attrs['table:number-columns-spanned'] ?? '1', 10) || 1, 1), MAX_REPEAT);
        const rowSpan = Math.min(Math.max(parseInt(c.attrs['table:number-rows-spanned'] ?? '1', 10) || 1, 1), MAX_REPEAT);
        const cellStyle = this.auto('table-cell', c.attrs['table:style-name'] ?? '') ?? this.common.get(`table-cell:${c.attrs['table:style-name']}`);
        const props = readCellProperties(firstChild(cellStyle, 'style:table-cell-properties'));
        const cell: TableCell = { kind: 'cell', properties: clone(props), children: [], attrs: {} };
        if (span > 1) cell.properties.gridSpan = span;
        if (rowSpan > 1) {
          cell.properties.vMerge = 'restart';
          for (let k = 0; k < span; k++) vspans[col + k] = undefined;
          vspans[col] = { remaining: rowSpan - 1, span, props };
        }
        this.readBlocks(c.children, cell.children, false, depth + 1);
        if (!cell.children.some((b) => b.kind === 'paragraph') || cell.children[cell.children.length - 1].kind !== 'paragraph') {
          cell.children.push(this.emptyParagraph());
        }
        row.cells.push(cell);
        cols.push(col);
        skip = span - 1;
        col += span;
      }
      maxColumns = Math.max(maxColumns, col);
      built.push({ row, cols });
    }

    // Grid widths: absolute where given, else relative widths shared out, else equal.
    const total = width ?? 9360;
    while (columns.length < maxColumns) columns.push({});
    const relSum = columns.reduce((s, c) => s + (c.width === undefined ? (c.rel ?? 0) : 0), 0);
    const known = columns.reduce((s, c) => s + (c.width ?? 0), 0);
    const unknownCount = columns.filter((c) => c.width === undefined).length;
    table.grid = columns.map((c) => {
      if (c.width !== undefined) return c.width;
      if (relSum > 0 && c.rel) return Math.round((Math.max(total - known, 0) * c.rel) / relSum);
      return Math.round(Math.max(total - known, 720 * unknownCount) / Math.max(unknownCount, 1));
    });
    for (const { row, cols } of built) {
      row.cells.forEach((cell, i) => {
        if (cell.kind !== 'cell') return;
        const span = cell.properties.gridSpan ?? 1;
        const w = table.grid.slice(cols[i], cols[i] + span).reduce((s, x) => s + x, 0);
        cell.properties = { width: { w: String(w), type: 'dxa' }, ...cell.properties };
      });
      table.rows.push(row);
    }
    if (!table.rows.length) {
      table.grid = table.grid.length ? table.grid : [total];
      table.rows.push({
        kind: 'row',
        properties: {},
        cells: [{ kind: 'cell', properties: {}, children: [this.emptyParagraph()], attrs: {} }],
        attrs: {},
      });
    }
    return table;
  }

  // --- Page setup and headers/footers --------------------------------------------------------

  private importPage(): void {
    const root = this.pkg.styles;
    if (!root) return;
    const masters = childElements(firstChild(root, 'office:master-styles') ?? { name: '', attrs: {}, children: [] }, 'style:master-page');
    if (!masters.length) return;
    const text = firstChild(firstChild(this.pkg.content, 'office:body'), 'office:text');
    const firstParagraph = text ? childElements(text).find((c) => c.name === 'text:p' || c.name === 'text:h') : undefined;
    this.part = 'content';
    const wanted = firstParagraph ? this.paragraphStyle(firstParagraph.attrs['text:style-name']).masterPage : undefined;
    const master =
      masters.find((m) => m.attrs['style:name'] === wanted) ?? masters.find((m) => m.attrs['style:name'] === 'Standard') ?? masters[0];
    this.part = 'styles';

    const layout = this.autos.styles.byFamily.get(`style:page-layout:${master.attrs['style:page-layout-name']}`);
    const section = this.doc.section;
    const page: NonNullable<OdtExtension['page']> = {};
    let marginTop: number | undefined;
    let marginBottom: number | undefined;
    const headerHeight = (style: XmlElement | undefined) => {
      const props = firstChild(style, 'style:header-footer-properties');
      if (!props) return 0;
      return (lengthToTwips(props.attrs['fo:min-height'] ?? props.attrs['svg:height']) ?? 0) + (lengthToTwips(props.attrs['fo:margin-bottom']) ?? 0) + (lengthToTwips(props.attrs['fo:margin-top']) ?? 0);
    };
    const shows = (name: string) => {
      const e = firstChild(master, name);
      return e && e.attrs['style:display'] !== 'false' ? e : undefined;
    };
    if (layout) {
      const props = firstChild(layout, 'style:page-layout-properties');
      const unmapped: [string, Unmapped][] = [];
      if (props) {
        const taken = new Set<string>();
        const get = (name: string) => {
          taken.add(name);
          return props.attrs[name];
        };
        const w = lengthToTwips(get('fo:page-width'));
        const h = lengthToTwips(get('fo:page-height'));
        const orientation = get('style:print-orientation');
        if (w !== undefined || h !== undefined) {
          section.pageSize = { w: w ?? section.pageSize?.w, h: h ?? section.pageSize?.h };
          if (orientation === 'landscape') section.pageSize.orient = 'landscape';
        }
        const margin = get('fo:margin');
        marginTop = lengthToTwips(get('fo:margin-top') ?? margin);
        marginBottom = lengthToTwips(get('fo:margin-bottom') ?? margin);
        const left = lengthToTwips(get('fo:margin-left') ?? margin);
        const right = lengthToTwips(get('fo:margin-right') ?? margin);
        const m = (section.margins ??= {});
        if (left !== undefined) m.left = left;
        if (right !== undefined) m.right = right;
        if (marginTop !== undefined) m.top = marginTop;
        if (marginBottom !== undefined) m.bottom = marginBottom;
        const format = get('style:num-format');
        if (format !== undefined) section.pageNumbering = { ...section.pageNumbering, fmt: NUM_FORMAT_IN[format] ?? 'decimal' };
        const rest: Unmapped = { attributes: {}, children: [] };
        for (const [k, v] of Object.entries(props.attrs)) if (!taken.has(k)) rest.attributes[k] = v;
        for (const c of childElements(props)) {
          const count = Number(c.attrs['fo:column-count']);
          if (c.name === 'style:columns' && count > 1) {
            section.columns = { num: count, space: lengthToTwips(c.attrs['fo:column-gap']) ?? 720 };
            if (childElements(c, 'style:column').length || firstChild(c, 'style:column-sep')) rest.children.push(c);
          } else if (c.name === 'style:columns') continue;
          else if (c.name === 'style:background-image' && !c.children.length && !c.attrs['xlink:href']) continue;
          else rest.children.push(c);
        }
        unmapped.push(['style:page-layout-properties', rest]);
      }
      // Header/footer heights: Word measures the header from the page edge and the body from
      // the page edge too; ODF puts the header inside the top margin area.
      const m = (section.margins ??= {});
      if (shows('style:header') || shows('style:header-first')) {
        m.header = marginTop ?? m.header;
        m.top = (marginTop ?? 0) + headerHeight(firstChild(layout, 'style:header-style'));
      }
      if (shows('style:footer') || shows('style:footer-first')) {
        m.footer = marginBottom ?? m.footer;
        m.bottom = (marginBottom ?? 0) + headerHeight(firstChild(layout, 'style:footer-style'));
      }
      const extra = propertiesExtra(unmapped);
      if (extra) page.layout = extra;
    }

    const masterAttributes: Record<string, string> = {};
    for (const [k, v] of Object.entries(master.attrs)) {
      if (k !== 'style:name' && k !== 'style:page-layout-name' && k !== 'style:display-name' && !k.startsWith('xmlns')) masterAttributes[k] = v;
    }
    if (Object.keys(masterAttributes).length) page.masterAttributes = masterAttributes;
    for (const c of childElements(master)) {
      const kind = { 'style:header': 'header', 'style:header-first': 'header', 'style:footer': 'footer', 'style:footer-first': 'footer' }[c.name] as
        | 'header'
        | 'footer'
        | undefined;
      if (kind && c.attrs['style:display'] !== 'false') {
        const hf = this.doc.addHeaderFooter(kind);
        const blocks: Block[] = [];
        this.readBlocks(c.children, blocks);
        hf.children = blocks.length ? blocks : [this.emptyParagraph()];
        const first = c.name.endsWith('-first');
        (kind === 'header' ? section.headers : section.footers).push({ type: first ? 'first' : 'default', part: hf.part });
        if (first) section.titlePage = true;
      } else if (!kind) (page.masterChildren ??= []).push(this.fragment(c));
    }
    if (Object.keys(page).length) this.ext.page = page;
  }
}

const NUM_FORMAT_IN: Record<string, string> = { '1': 'decimal', a: 'lowerLetter', A: 'upperLetter', i: 'lowerRoman', I: 'upperRoman', '': 'none' };

/** List levels 1-9 of an ODF list style (bullets where the style is missing). */
function listLevels(style: XmlElement | undefined): NumberingLevel[] {
  const levels: NumberingLevel[] = [];
  const defs = new Map<number, XmlElement>();
  for (const c of style ? childElements(style) : []) {
    const n = Number(c.attrs['text:level']);
    if (n >= 1 && n <= 9 && c.name.startsWith('text:list-level-style-')) defs.set(n - 1, c);
  }
  for (let l = 0; l < 9; l++) {
    const def = defs.get(l);
    const level: NumberingLevel = { level: l, start: 1, justification: 'left', attrs: {} };
    let left = 720 * (l + 1);
    let hanging = 360;
    let suffix: NumberingLevel['suffix'] = 'tab';
    if (def?.name === 'text:list-level-style-number') {
      const format = def.attrs['style:num-format'] ?? '1';
      level.format = NUM_FORMAT_IN[format] ?? 'decimal';
      const start = Number(def.attrs['text:start-value'] ?? 1);
      level.start = Number.isFinite(start) ? Math.max(0, Math.round(start)) : 1;
      const shown = Math.min(Math.max(Number(def.attrs['text:display-levels'] ?? 1) || 1, 1), l + 1);
      const numbers = format === '' ? '' : Array.from({ length: shown }, (_, k) => `%${l + 2 - shown + k}`).join('.');
      level.text = `${def.attrs['style:num-prefix'] ?? ''}${numbers}${def.attrs['style:num-suffix'] ?? ''}`;
    } else {
      level.format = 'bullet';
      level.text = def?.name === 'text:list-level-style-bullet' ? (def.attrs['text:bullet-char'] || '•') : '•';
    }
    const props = firstChild(def, 'style:list-level-properties');
    if (props) {
      const align = firstChild(props, 'style:list-level-label-alignment');
      if (props.attrs['text:list-level-position-and-space-mode'] === 'label-alignment' || align) {
        if (align) {
          left = lengthToTwips(align.attrs['fo:margin-left']) ?? left;
          const indent = lengthToTwips(align.attrs['fo:text-indent']);
          hanging = indent === undefined ? hanging : -indent;
          const follow = align.attrs['text:label-followed-by'];
          suffix = follow === 'space' ? 'space' : follow === 'nothing' ? 'nothing' : 'tab';
        }
      } else {
        const before = lengthToTwips(props.attrs['text:space-before']) ?? 0;
        const width = lengthToTwips(props.attrs['text:min-label-width']) ?? 0;
        left = before + width;
        hanging = width;
      }
    }
    level.suffix = suffix;
    level.paragraphProperties = { indent: hanging >= 0 ? { left, hanging } : { left, firstLine: -hanging } };
    levels.push(level);
  }
  return levels;
}

function sizeFrom(textProps: XmlElement | undefined, parentSize: number): number {
  const value = textProps?.attrs['fo:font-size'];
  const pct = parsePercent(value);
  if (pct !== undefined) return Math.round((parentSize * pct) / 100);
  const points = parseLength(value);
  return points === undefined ? parentSize : Math.round(points * 2);
}

/** Unmapped properties as the extension stores them, or undefined when there are none. */
function propertiesExtra(sections: [string, Unmapped][]): OdtProperties | undefined {
  const out: OdtProperties = {};
  for (const [element, rest] of sections) {
    if (Object.keys(rest.attributes).length) (out.attributes ??= {})[element] = { ...rest.attributes };
    const children = rest.children.map((c) => fragment(cloneXml(c)));
    if (children.length) (out.children ??= {})[element] = [...((out.children ?? {})[element] ?? []), ...children];
  }
  return out.attributes || out.children ? out : undefined;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeBinary(text: string): Uint8Array | undefined {
  try {
    return fromBase64(text);
  } catch {
    return undefined;
  }
}

/** Image type from magic bytes, for embedded binary data without a file name. */
function sniffImage(data: Uint8Array | undefined): string | undefined {
  if (!data || data.length < 4) return undefined;
  if (data[0] === 0x89 && data[1] === 0x50) return 'png';
  if (data[0] === 0xff && data[1] === 0xd8) return 'jpg';
  if (data[0] === 0x47 && data[1] === 0x49) return 'gif';
  return undefined;
}

/** Drops empty collections so the extension stays small. */
function clean(ext: OdtExtension): OdtExtension {
  for (const key of Object.keys(ext) as (keyof OdtExtension)[]) {
    const value = ext[key];
    if (Array.isArray(value) && !value.length) delete ext[key];
    else if (value && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) delete ext[key];
  }
  return ext;
}

/** The text of a comment's paragraph, with ODF's spaces, tabs and line breaks. */
function commentText(e: XmlElement): string {
  let out = '';
  for (const n of e.children) {
    if (typeof n === 'string') out += n;
    else if (n.name === 'text:s') out += ' '.repeat(Math.min(Math.max(parseInt(n.attrs['text:c'] ?? '1', 10) || 1, 1), 10000));
    else if (n.name === 'text:tab') out += '\t';
    else if (n.name === 'text:line-break') out += '\n';
    else out += commentText(n);
  }
  return out;
}
