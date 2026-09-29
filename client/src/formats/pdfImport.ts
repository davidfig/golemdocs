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
import { PdfDocument, analyzeDocument, type ReflowBlock, type ReflowListFormat, type ReflowMargins, type ReflowRun } from '@word/pdf';

export interface PdfImportOptions {
  /** User or owner password for encrypted PDFs. */
  password?: string;
  /** Start a new page where each PDF page began (default false: text reflows freely). */
  pageBreaks?: boolean;
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

function runOf(r: ReflowRun, styled: boolean): Run {
  const properties: RunProperties = {};
  if (styled) {
    const family = wordFontFor(r.fontName);
    if (family) properties.fonts = { ascii: family, hAnsi: family, cs: family };
    if (r.bold) properties.bold = true;
    properties.size = pointsToHalfPoints(r.size);
    properties.sizeCs = properties.size;
  }
  if (r.italic) properties.italic = true;
  if (r.color && r.color !== '000000') properties.color = { val: r.color };
  return { kind: 'run', properties, content: [{ kind: 'text', text: r.text }], attrs: {} };
}

// --- Numbering -------------------------------------------------------------------------------------

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
  const clamp = (n: number, max: number) => Math.min(Math.max(n, 36), max);
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
  const { blocks, pages } = analyzeDocument(pdf, { pageBreaks: options.pageBreaks });
  return blocksToDocument(blocks, pages);
}

export async function blocksToDocument(
  blocks: ReflowBlock[],
  pages: { width: number; height: number; margins: ReflowMargins }[],
): Promise<WordDocument> {
  const doc = await WordDocument.create();
  setupPage(doc, pages);
  ensureHeading4(doc);
  const lists = new Lists(doc);

  const body: Paragraph[] = [];
  let breakBefore = false;
  // Current numbered list: its instance, the format it counts in, and the last top-level number.
  let numbered: { id: number; format: ReflowListFormat; last?: number } | undefined;

  const push = (properties: ParagraphProperties, runs: ReflowRun[], styled: boolean) => {
    if (breakBefore) {
      properties.pageBreakBefore = true;
      breakBefore = false;
    }
    const children: Inline[] = runs.map((r) => runOf(r, styled));
    body.push({ kind: 'paragraph', properties, children, attrs: {} });
  };

  for (const b of blocks) {
    if (b.kind !== 'listItem') numbered = undefined;
    switch (b.kind) {
      case 'pageBreak':
        breakBefore = body.length > 0;
        break;
      case 'heading': {
        // The style carries size, weight and color; runs keep only what the style doesn't imply.
        const runs = b.runs.map((r) => ({ ...r, bold: false }));
        push({ style: `Heading${b.level}`, ...(b.align ? { justification: b.align } : {}) }, runs, false);
        break;
      }
      case 'paragraph': {
        const properties: ParagraphProperties = {};
        if (b.align) properties.justification = b.align;
        if (b.indent) {
          const { left, firstLine } = b.indent;
          properties.indent = {
            left: pointsToTwips(left),
            ...(firstLine > 0 ? { firstLine: pointsToTwips(firstLine) } : {}),
            ...(firstLine < 0 ? { hanging: pointsToTwips(-firstLine) } : {}),
          };
        }
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
        push({ style: 'ListParagraph', numbering: { id, level: b.level } }, b.runs, true);
        break;
      }
    }
  }
  doc.body = body.length ? body : [{ kind: 'paragraph', properties: {}, children: [], attrs: {} }];
  return doc;
}
