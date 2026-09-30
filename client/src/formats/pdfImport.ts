// PDF -> editable document: the page-structure recovery of @word/pdf (reflow), expressed in the
// DOCX model so the result is an ordinary document (styles, real lists, page setup).

import {
  WordDocument,
  pointsToHalfPoints,
  pointsToTwips,
  type AbstractNumbering,
  type Inline,
  type NumberingLevel,
  type Paragraph,
  type ParagraphProperties,
  type Run,
  type RunProperties,
  type Style,
} from '@word/docx';
import { placedFrom, type Placed } from './pdfPlaced.ts';
import { PdfDocument, analyzeDocument, type PdfEdit, type ReflowBlock, type ReflowIndent, type ReflowSpacing, type ReflowListFormat, type ReflowMargins, type ReflowRun } from '@word/pdf';

export interface PdfImportOptions {
  /** User or owner password for encrypted PDFs. */
  password?: string;
  /** Start a new page where each PDF page began (default false: text reflows freely). */
  pageBreaks?: boolean;
  /** The PDF's edits: the text boxes and pictures among them are placed on their pages, as floating drawings. */
  edits?: readonly PdfEdit[];
}

/** Word names of the families we ship (see client/public/fonts). */
const MONO = /courier|mono|consolas|menlo|typewriter|cmtt|lucida ?console|inconsolata/i;
const SANS = /arial|helvet|verdana|tahoma|sans|gothic|myriad|frutiger|univers|cmss|avenir|roboto|lato|trebuchet|arimo|swiss/i;
const SERIF = /times|serif|roman|garamond|palatino|book|century|minion|cmr|cmbx|cmti|cmsl|lmr|charter|nimbusrom|utopia|tinos|antiqua|lm ?roman/i;
const NAMED: [RegExp, string][] = [
  [/georgia/i, 'Georgia'],
  [/cambria/i, 'Cambria'],
  [/calibri|carlito/i, 'Calibri'],
  [/segoe/i, 'Segoe UI'],
  [/comic/i, 'Comic Sans MS'],
];

/** The Word font name to use for a PDF font, or undefined to leave the document default. */
export function wordFontFor(fontName: string): string | undefined {
  const name = fontName.replace(/[-,](bold|italic|oblique|regular|roman|light|medium|semibold|black|bd|it).*$/i, '');
  for (const [pattern, family] of NAMED) if (pattern.test(name)) return family;
  if (MONO.test(name)) return 'Courier New';
  if (SANS.test(name)) return 'Arial';
  if (SERIF.test(name)) return 'Times New Roman';
  return undefined;
}

/** `heading`: the run keeps its size and color (the heading style's are only a default), but not its weight. */
function runOf(r: ReflowRun, styled: boolean, heading = false): Run {
  const properties: RunProperties = {};
  if (styled || heading) {
    const family = wordFontFor(r.fontName);
    if (family) properties.fonts = { ascii: family, hAnsi: family, cs: family };
    if (r.bold && !heading) properties.bold = true;
    properties.size = pointsToHalfPoints(r.size);
    properties.sizeCs = properties.size;
  }
  if (r.italic) properties.italic = true;
  if (r.color && r.color !== '000000') properties.color = { val: r.color };
  else if (heading) properties.color = { val: '000000' };
  // A newline is a line break the PDF had and the layout keeps (a title of several lines).
  const content = r.text.split('\n').flatMap((text, i): Run['content'] => [...(i ? [{ kind: 'break' as const }] : []), ...(text ? [{ kind: 'text' as const, text }] : [])]);
  return { kind: 'run', properties, content, attrs: {} };
}

function indentOf({ left, firstLine, right }: ReflowIndent): NonNullable<ParagraphProperties['indent']> {
  return {
    left: pointsToTwips(left),
    ...(right ? { right: pointsToTwips(right) } : {}),
    ...(firstLine > 0 ? { firstLine: pointsToTwips(firstLine) } : {}),
    ...(firstLine < 0 ? { hanging: pointsToTwips(-firstLine) } : {}),
  };
}

// --- Numbering -------------------------------------------------------------------------------------

/** Where the PDF put a block vertically: its line pitch exactly, and the gap above it. */
function spacingOf(spacing: ReflowSpacing | undefined): ParagraphProperties {
  if (!spacing) return {};
  return { contextualSpacing: false, spacing: { before: pointsToTwips(spacing.before), after: 0, line: pointsToTwips(spacing.line), lineRule: 'exact' } };
}

const BULLETS = ['•', '◦', '▪'];
const DEEP_FORMATS = ['lowerLetter', 'lowerRoman', 'decimal'];

function levelOf(l: number, format: string, text: string): NumberingLevel {
  return {
    level: l,
    start: 1,
    format,
    text,
    suffix: 'tab',
    justification: 'left',
    paragraphProperties: { indent: { left: 720 * (l + 1), hanging: 360 } },
    attrs: {},
  };
}

class Lists {
  private readonly abstracts = new Map<string, AbstractNumbering>();
  private bulletInstance?: number;

  constructor(private readonly doc: WordDocument) {}

  private abstract(key: string, make: () => NumberingLevel[]): AbstractNumbering {
    let a = this.abstracts.get(key);
    if (!a) {
      a = { id: this.doc.numbering.abstracts.length, multiLevelType: 'hybridMultilevel', levels: make(), attrs: {} };
      this.doc.numbering.abstracts.push(a);
      this.abstracts.set(key, a);
    }
    return a;
  }

  private instance(abstractId: number, start?: number): number {
    const id = this.doc.numbering.instances.length + 1;
    this.doc.numbering.instances.push({
      id,
      abstractId,
      overrides: start === undefined ? [] : [{ level: 0, startOverride: start }],
      attrs: {},
    });
    return id;
  }

  bullets(): number {
    if (this.bulletInstance === undefined) {
      const a = this.abstract('bullet', () => Array.from({ length: 9 }, (_, l) => levelOf(l, 'bullet', BULLETS[l % 3])));
      this.bulletInstance = this.instance(a.id);
    }
    return this.bulletInstance;
  }

  /** A fresh numbered list (counting restarts at `start`). */
  numbered(format: ReflowListFormat, marker: string, start: number): number {
    const pattern = marker.startsWith('(') ? '(%1)' : marker.endsWith(')') ? '%1)' : '%1.';
    const a = this.abstract(`${format}${pattern}`, () =>
      Array.from({ length: 9 }, (_, l) => levelOf(l, l === 0 ? format : DEEP_FORMATS[(l - 1) % 3], pattern.replace('%1', `%${l + 1}`))),
    );
    return this.instance(a.id, start);
  }
}

// --- Styles and page setup -----------------------------------------------------------------------

/** The blank template defines Heading1-3; add Heading4 the way Word's Normal template has it. */
function ensureHeading4(doc: WordDocument): void {
  if (doc.styles.styles.some((s) => s.id === 'Heading4')) return;
  const style: Style = {
    type: 'paragraph',
    id: 'Heading4',
    name: 'heading 4',
    basedOn: 'Normal',
    next: 'Normal',
    paragraphProperties: { keepNext: true, keepLines: true, spacing: { before: 40, after: 0 }, outlineLevel: 3 },
    runProperties: { italic: true, color: { val: '2F5496' } },
    attrs: {},
  };
  doc.styles.styles.push(style);
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];

function setupPage(doc: WordDocument, sizes: { width: number; height: number; margins: ReflowMargins }[]): void {
  if (!sizes.length) return;
  const first = sizes[0];
  // At least half an inch, unless the PDF's text really runs closer to the edge (a footer near the bottom).
  const clamp = (n: number, max: number) => Math.min(Math.max(n, Math.min(36, n)), max);
  const margins = {
    left: clamp(median(sizes.map((s) => s.margins.left)), first.width * 0.3),
    right: clamp(median(sizes.map((s) => s.margins.right)), first.width * 0.3),
    top: clamp(median(sizes.map((s) => s.margins.top)), first.height * 0.3),
    bottom: clamp(median(sizes.map((s) => s.margins.bottom)), first.height * 0.3),
  };
  doc.section.pageSize = {
    w: pointsToTwips(first.width),
    h: pointsToTwips(first.height),
    ...(first.width > first.height ? { orient: 'landscape' as const } : {}),
  };
  doc.section.margins = {
    top: pointsToTwips(margins.top),
    right: pointsToTwips(margins.right),
    bottom: pointsToTwips(margins.bottom),
    left: pointsToTwips(margins.left),
    header: pointsToTwips(Math.min(36, margins.top / 2)),
    footer: pointsToTwips(Math.min(36, margins.bottom / 2)),
    gutter: 0,
  };
}

// --- Import ----------------------------------------------------------------------------------------

/** Reflows a PDF into an editable document. Throws PdfError / PasswordError for unreadable or locked files. */
export async function pdfToDocument(bytes: Uint8Array, options: PdfImportOptions = {}): Promise<WordDocument> {
  const pdf = PdfDocument.load(bytes, { password: options.password });
  const placed = placedFrom(pdf, options.edits ?? []);
  // Things placed on a page need the text to stay on its page too: each PDF page starts a Word page.
  const { blocks, pages, firstPage } = analyzeDocument(pdf, { pageBreaks: options.pageBreaks || placed.length > 0 });
  return blocksToDocument(blocks, pages, placed.length ? { placed, firstPage } : undefined);
}

export async function blocksToDocument(
  blocks: ReflowBlock[],
  pages: { width: number; height: number; margins: ReflowMargins }[],
  positioned?: { placed: Placed[]; firstPage: number },
): Promise<WordDocument> {
  const doc = await WordDocument.create();
  setupPage(doc, pages);
  ensureHeading4(doc);
  const lists = new Lists(doc);

  const body: Paragraph[] = [];
  let breakBefore = false;
  // Current numbered list: its instance, the format it counts in, and the last top-level number.
  let numbered: { id: number; format: ReflowListFormat; last?: number } | undefined;

  // Placed things (text boxes, pictures) float on the page they were on: each hangs on the first
  // paragraph of its page, or on a paragraph of its own where the page has no text.
  const placedOn = new Map<number, Placed[]>();
  for (const p of positioned?.placed ?? []) placedOn.set(p.page, [...(placedOn.get(p.page) ?? []), p]);
  let currentPage = -1;
  let waiting: Placed[] = [];
  const drawingRuns = (items: Placed[]): Inline[] =>
    items.flatMap((item) => {
      const content = item.build(doc);
      return content ? [{ kind: 'run' as const, properties: {}, content: [content], attrs: {} }] : [];
    });

  const push = (properties: ParagraphProperties, runs: ReflowRun[], styled: boolean, heading = false) => {
    if (breakBefore) {
      properties.pageBreakBefore = true;
      breakBefore = false;
    }
    const children: Inline[] = runs.map((r) => runOf(r, styled, heading));
    if (waiting.length) children.push(...drawingRuns(waiting));
    waiting = [];
    body.push({ kind: 'paragraph', properties, children, attrs: {} });
  };
  /** Moves to a PDF page, giving pages passed on the way that have only placed things a page of their own. */
  const goTo = (page: number) => {
    for (let q = currentPage + 1; q < page; q++) {
      const items = placedOn.get(q);
      if (!items) continue;
      breakBefore = body.length > 0;
      waiting = items;
      push({}, [], false);
    }
    currentPage = page;
    waiting = placedOn.get(page) ?? [];
    breakBefore = body.length > 0;
  };
  if (positioned) goTo(positioned.firstPage);

  for (const b of blocks) {
    if (b.kind !== 'listItem') numbered = undefined;
    switch (b.kind) {
      case 'pageBreak':
        if (positioned && b.page !== undefined) goTo(b.page);
        else breakBefore = body.length > 0;
        break;
      case 'heading': {
        // The style carries the weight; the runs keep the size, font and color the PDF had.
        const properties: ParagraphProperties = { style: `Heading${b.level}`, ...(b.align ? { justification: b.align } : {}), ...spacingOf(b.spacing) };
        if (b.indent) properties.indent = indentOf(b.indent);
        push(properties, b.runs, false, true);
        break;
      }
      case 'paragraph': {
        const properties: ParagraphProperties = spacingOf(b.spacing);
        if (b.align) properties.justification = b.align;
        if (b.indent) properties.indent = indentOf(b.indent);
        push(properties, b.runs, true);
        break;
      }
      case 'listItem': {
        let id: number;
        if (!b.ordered) {
          numbered = undefined;
          id = lists.bullets();
        } else {
          const format = b.format ?? 'decimal';
          // A new list starts after anything else, or when a top-level number stops counting up.
          const restart =
            !numbered || numbered.format !== format || (b.level === 0 && b.start !== undefined && numbered.last !== undefined && b.start <= numbered.last);
          if (restart) numbered = { id: lists.numbered(format, b.marker, b.start ?? 1), format };
          if (b.level === 0) numbered!.last = b.start;
          id = numbered!.id;
        }
        const properties: ParagraphProperties = { style: 'ListParagraph', numbering: { id, level: b.level }, ...spacingOf(b.spacing) };
        // The PDF's own marker and text positions, not the list level's default steps.
        if (b.indent) properties.indent = indentOf(b.indent);
        push(properties, b.runs, true);
        break;
      }
    }
  }
  if (positioned) goTo(Math.max(currentPage, ...placedOn.keys()) + 1);
  doc.body = body.length ? body : [{ kind: 'paragraph', properties: {}, children: [], attrs: {} }];
  return doc;
}
