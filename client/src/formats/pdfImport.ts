// PDF -> editable document: the page-structure recovery of @golemdocs/pdf (reflow), expressed in the
// DOCX model so the result is an ordinary document (styles, real lists, page setup).

import {
  WordDocument,
  fieldContents,
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
} from '@golemdocs/docx';
import { placedFrom, type Placed } from './pdfPlaced.ts';
import { PdfDocument, analyzeDocument, type ReflowRunningLine, type PdfEdit, type ReflowBlock, type ReflowIndent, type ReflowSpacing, type ReflowListFormat, type ReflowMargins, type ReflowRun } from '@golemdocs/pdf';

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

/** `heading`: the run keeps its size, color, weight and slant (the heading style's are only a default). */
function runOf(r: ReflowRun, styled: boolean, heading = false): Run {
  const properties: RunProperties = {};
  if (styled || heading) {
    const family = wordFontFor(r.fontName);
    if (family) properties.fonts = { ascii: family, hAnsi: family, cs: family };
    // The heading styles (Calibri Light, one of them italic) carry no weight of their own: the PDF's text keeps its own.
    if (r.bold) properties.bold = true;
    else if (heading) properties.bold = false;
    properties.size = pointsToHalfPoints(r.size);
    properties.sizeCs = properties.size;
  }
  if (r.italic) properties.italic = true;
  else if (heading) properties.italic = false;
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

/** `fixedPages`: each PDF page is a Word page of its own, so its text must not spill onto another. */
function setupPage(doc: WordDocument, sizes: { width: number; height: number; margins: ReflowMargins }[], fixedPages: boolean): void {
  if (!sizes.length) return;
  const first = sizes[0];
  // Where the PDF's text runs (however near the edge, as a footer can be), but never more than 30% of the page.
  const clamp = (n: number, max: number) => Math.min(n, max);
  const margins = {
    left: clamp(median(sizes.map((s) => s.margins.left)), first.width * 0.3),
    // Another font's letters run a few percent wider than the PDF's: with a page to itself the text gets that much more room, so a line the PDF broke by hand is not broken twice.
    right: clamp(median(sizes.map((s) => s.margins.right)), first.width * 0.3),
    top: clamp(median(sizes.map((s) => s.margins.top)), first.height * 0.3),
    // Lines a point or two taller than the PDF's would push the last one onto a new page: leave room.
    bottom: clamp(median(sizes.map((s) => s.margins.bottom)), fixedPages ? 36 : first.height * 0.3),
  };
  if (fixedPages) margins.right = Math.max(0, margins.right - 0.06 * Math.max(0, first.width - margins.left - margins.right));
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

// --- Headers and footers -----------------------------------------------------------------------------

/** A PAGE or NUMPAGES field showing `shown` (what the PDF's first page had there). */
const fieldRun = (instruction: 'PAGE' | 'NUMPAGES', shown: string, properties: RunProperties): Run => ({ kind: 'run', properties, attrs: {}, content: fieldContents(instruction, [{ kind: 'text', text: shown }]) });

/** The text of a page number, with its numbers as fields: the first is the page, the next the page count ("3 of 10", "3/10"). */
function pageNumberRuns(r: ReflowRun): Run[] {
  const base = runOf(r, true);
  const out: Run[] = [];
  let seen = 0;
  for (const part of r.text.split(/(\d+)/)) {
    if (/^\d+$/.test(part)) out.push(fieldRun(seen++ === 0 ? 'PAGE' : 'NUMPAGES', part, base.properties));
    else if (part) out.push({ ...base, content: [{ kind: 'text', text: part }] });
  }
  return out;
}

/**
 * The running head and foot of the PDF as the document's own header and footer: a line is a paragraph,
 * its pieces at the same distances across the page (tab stops), and a page number is a field.
 */
function addRunning(doc: WordDocument, running: { header: ReflowRunningLine[]; footer: ReflowRunningLine[] }, pageWidth: number, pageHeight: number): void {
  const margins = doc.section.margins;
  if (!margins) return;
  const left = (margins.left ?? 0) / 20;
  const textRight = pageWidth - (margins.right ?? 0) / 20;
  for (const kind of ['header', 'footer'] as const) {
    const lines = running[kind];
    if (!lines.length) continue;
    lines.sort((a, b) => a.y - b.y);
    const part = doc.addHeaderFooter(kind);
    let previousY = 0;
    part.children = lines.map((line, i): Paragraph => {
      const segments = line.segments;
      const children: Inline[] = [];
      segments.forEach((segment, k) => {
        if (k > 0) children.push({ kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'tab' }] });
        for (const r of segment.runs) children.push(...(segment.pageNumber ? pageNumberRuns(r) : [runOf(r, true)]));
      });
      const height = line.size * 1.2;
      const before = i === 0 ? 0 : Math.max(0, line.y - previousY - height);
      previousY = line.y;
      return {
        kind: 'paragraph',
        properties: {
          contextualSpacing: false,
          // A field's result is drawn in the paragraph's own character formatting.
          runProperties: runOf(segments[0].runs[0], true).properties,
          spacing: { before: pointsToTwips(before), after: 0, line: pointsToTwips(height), lineRule: 'exact' },
          // The line may run past the body's edges (a page number at the page's right): the paragraph does too, with a little room so the last word is not pushed down by rounding.
          indent: { left: pointsToTwips(segments[0].x - left), ...(segments[segments.length - 1].x1 > textRight ? { right: -pointsToTwips(segments[segments.length - 1].x1 - textRight + 8) } : {}) },
          tabs: segments.slice(1).map((segment) => ({ val: 'left' as const, pos: pointsToTwips(segment.x - left) })),
        },
        children,
        attrs: {},
      };
    });
    // The first line's box starts about where its text does; the last one ends just below its baseline.
    const first = lines[0];
    const last = lines[lines.length - 1];
    if (kind === 'header') margins.header = pointsToTwips(Math.max(0, first.y - 0.95 * first.size));
    else margins.footer = pointsToTwips(Math.max(0, pageHeight - last.y - 0.3 * last.size));
    (kind === 'header' ? doc.section.headers : doc.section.footers).push({ type: 'default', part: part.part });
  }
}

// --- Import ----------------------------------------------------------------------------------------

/** Reflows a PDF into an editable document. Throws PdfError / PasswordError for unreadable or locked files. */
export async function pdfToDocument(bytes: Uint8Array, options: PdfImportOptions = {}): Promise<WordDocument> {
  const pdf = PdfDocument.load(bytes, { password: options.password });
  const placed = placedFrom(pdf, options.edits ?? []);
  await Promise.all(placed.map((p) => p.prepare?.()));
  // Things placed on a page need the text to stay on its page too: each PDF page starts a Word page.
  const { blocks, pages, firstPage, running } = analyzeDocument(pdf, { pageBreaks: options.pageBreaks || placed.length > 0 });
  return blocksToDocument(blocks, pages, placed.length ? { placed, firstPage } : undefined, running);
}

export async function blocksToDocument(
  blocks: ReflowBlock[],
  pages: { width: number; height: number; margins: ReflowMargins }[],
  positioned?: { placed: Placed[]; firstPage: number },
  running?: { header: ReflowRunningLine[]; footer: ReflowRunningLine[] },
): Promise<WordDocument> {
  const doc = await WordDocument.create();
  setupPage(doc, pages, blocks.some((b) => b.kind === 'pageBreak'));
  if (running) addRunning(doc, running, pages[0]?.width ?? 612, pages[0]?.height ?? 792);
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

  /** Points the page's text starts below the section's top margin (the margin is kept to a third of the page, the text may start lower), for the first paragraph of the page. */
  let extraTop = 0;
  const extraTopOf = (page: number) => (pages[page] ? Math.max(0, pages[page].margins.top - (doc.section.margins?.top ?? 0) / 20) : 0);
  const push = (properties: ParagraphProperties, runs: ReflowRun[], styled: boolean, heading = false) => {
    if (breakBefore) {
      properties.pageBreakBefore = true;
      breakBefore = false;
    }
    if (extraTop > 0) {
      properties.spacing = { ...properties.spacing, before: (properties.spacing?.before ?? 0) + pointsToTwips(extraTop) };
      extraTop = 0;
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
    extraTop = extraTopOf(page);
  };
  if (positioned) goTo(positioned.firstPage);
  else extraTop = extraTopOf(0);

  for (const b of blocks) {
    if (b.kind !== 'listItem') numbered = undefined;
    switch (b.kind) {
      case 'pageBreak':
        if (positioned && b.page !== undefined) goTo(b.page);
        else {
          breakBefore = body.length > 0;
          if (b.page !== undefined) extraTop = extraTopOf(b.page);
        }
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
  if (positioned) {
    // A page left with things no paragraph picked up (a PDF with no text on it) gets a paragraph of its own.
    if (waiting.length) push({}, [], false);
    goTo(Math.max(currentPage, ...placedOn.keys()) + 1);
  }
  doc.body = body.length ? body : [{ kind: 'paragraph', properties: {}, children: [], attrs: {} }];
  return doc;
}
