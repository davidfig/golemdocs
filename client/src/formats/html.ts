// HTML <-> document model, hand-rolled: a forgiving tokenizer and tree builder (no DOMParser, so it
// runs in a web worker and in Node), a converter into the model, and an HTML5 writer.
//
// The model conventions are Markdown's (see markdown.ts), so HTML, Markdown and Word documents look
// and behave alike: headings are Heading1..6; <blockquote> paragraphs use "Quote" (nesting adds 720
// twips of left indent per level); a <pre> is one "Code" paragraph per line; <code>/<kbd>/<samp> runs
// use "InlineCode"; <ul>/<ol> get real numbering (one definition per list, "ListParagraph", level =
// nesting depth; further paragraphs of an item are un-numbered ListParagraph paragraphs); links are
// Hyperlink inlines in the "Hyperlink" character style; tables use TableGrid with header rows
// (<thead>, or leading rows of <th>), colspan/rowspan as gridSpan/vMerge; <img> becomes a Hyperlink
// to its src whose "ImagePlaceholder" run reads "[Image: alt]" unless the picture's bytes are at hand (a
// data: URI, or supplied by the caller for the address), when it is an inline picture; <hr> is
// an empty paragraph with a bottom border. Inline CSS (and <font>, align=, bgcolor=, valign=) maps to
// run properties (color, background, font family/size/weight/style, decoration, caps, super/sub)
// and paragraph properties (alignment, margins/indent, line height, shading, page break).
//
// What the model can't hold goes in the HtmlExtension, keyed by paragraph id (w14:paraId; the
// importer gives every paragraph one): the <head> verbatim, <html>/<body> attributes, each block's
// tag and attributes, containers that wrapped blocks (<section class="x">), and what can't be mapped
// (scripts, forms, iframes, svg, unknown elements, comments), kept verbatim and written back at
// their anchor instead of being shown in the editor. Anchors are paragraph ids, or "table:<id of the
// table's first paragraph>" for tables. Dropped: attributes of inline elements (span classes and ids,
// link titles and targets, image sizes, a link around an image), CSS from stylesheets and classes
// (the head keeps it, so it still applies to the exported page, but the editor doesn't show it),
// inline CSS the model has no property for (kept in the block's style attribute when the element is
// a block), and the position of an unmappable element within a line (it moves to the start or end
// of its paragraph). Pictures the reader can't get bytes for stay placeholders.
//
// Comments are <mark class="comment" data-comment-id="0" data-author="Ann" data-initials="A"
// data-date="2024-05-01T10:00:00Z" data-parent="0" data-resolved="true" data-comment="the text"
// title="Ann: the text"> around the commented text, one mark per comment (a reply is a mark of its own
// nested around the same text, with data-parent naming the comment it answers, and data-resolved goes
// on a thread's first comment). data-comment holds the comment's text (a new line for each
// paragraph); title is the same for a reader's tooltip, and is what is read back when there is no
// data-comment. A comment on no text is an empty mark. Elements around the text, a link or bold
// text, are inside or outside the mark as they were. Plain <mark> elements are highlights, as before.
//
// Export writes a complete HTML5 document. Without an extension (a Word or Markdown document) it adds
// a generated <style data-word-styles> block for the document's paragraph styles, which the importer
// reads back into styles, so pages the app wrote round-trip. Nothing here throws on odd input.

import { commentEnd, commentReference, commentStart, StyleResolver, WordDocument, fromMathML, isMathInline, mathInline, paragraphText, readMathInline, toMathML, type MathMLElement } from '@golemdocs/docx';
import { decodeDataUri, sniffImage, toDataUri } from './images.ts';
import type { ImageData } from './images.ts';
import type {
  Block,
  Hyperlink,
  Inline,
  NumberingLevel,
  Paragraph,
  ParagraphProperties,
  Run,
  RunContent,
  RunProperties,
  Style,
  Table,
  TableCell,
  TableCellProperties,
  TableRow,
} from '@golemdocs/docx';
import type { Comment } from '@golemdocs/docx';
import { commentMarker, RangeTracker } from './commentRanges.ts';
import { MONO_FONTS, styleFor } from './markdownStyles.ts';
import { t } from '../i18n/index.ts';

// --- Public types -----------------------------------------------------------------------------------

/** Attributes of an element, in source order. */
export type HtmlAttributes = Record<string, string>;

/** What the model can't hold about one paragraph and the elements that start at it. */
export interface HtmlBlock {
  /**
   * The paragraph's own element when it isn't what its style writes by default: "div", "dt",
   * "figcaption"... instead of <p>; or an element ("p") inside an <li> or table cell, which
   * otherwise hold bare text.
   */
  tag?: string;
  /** Attributes of that element (inline CSS the model took over is removed from `style`). */
  attrs?: HtmlAttributes;
  /** The element was empty: written empty rather than as a blank line (<p><br></p>). */
  empty?: boolean;
  /** Attributes of the <li> this paragraph is the first of. */
  item?: HtmlAttributes;
  /** Attributes of the <ul>/<ol> whose first item this is. */
  list?: HtmlAttributes;
  /** Attributes of the <blockquote> that starts here. */
  quote?: HtmlAttributes;
  /** Attributes of the <pre> that starts here. */
  pre?: HtmlAttributes;
  /** The <pre> held a single <code> element, with these attributes. */
  code?: HtmlAttributes;
  /** Attributes of the <table> (this is its first paragraph), <tr> or cell that starts here. */
  table?: HtmlAttributes;
  row?: HtmlAttributes;
  cell?: HtmlAttributes;
  /** The cell is a <th> outside the table's header rows. */
  th?: boolean;
}

/** A container element (<section>, <article>, <div>...) around a run of blocks. */
export interface HtmlWrapper {
  tag: string;
  attrs: HtmlAttributes;
  /** Anchors (paragraph id, or "table:<id>") of the first and last block it wrapped. */
  first: string;
  last: string;
}

/** Source HTML that can't be mapped (script, form, iframe, svg, comment...), written back verbatim. */
export interface HtmlFragment {
  html: string;
  /** The block it belongs to (paragraph id, or "table:<id>"); null for the start of the body. */
  anchor: string | null;
  /** Before or after the block's element, or inside it before or after its text. */
  place: 'before' | 'start' | 'end' | 'after';
  /** With place "after": how many of the containers ending at the block it comes after. */
  outside?: number;
}

/** The HTML-only parts of a document (JSON-serialisable). See the header comment. */
export interface HtmlExtension {
  /** The doctype, when it isn't <!DOCTYPE html>. */
  doctype?: string;
  htmlAttrs?: HtmlAttributes;
  /** Everything in <head> except the generated style block, verbatim, one element per line. */
  head?: string;
  bodyAttrs?: HtmlAttributes;
  /** The page had the generated <style data-word-styles> block (the app wrote it): regenerate it. */
  wordStyles?: boolean;
  /** Per paragraph id. */
  blocks?: Record<string, HtmlBlock>;
  /** Outermost first. */
  wrappers?: HtmlWrapper[];
  fragments?: HtmlFragment[];
}

// --- Model helpers ----------------------------------------------------------------------------------

const ID = 'w14:paraId';
const PAGE_TEXT_WIDTH = 9360;
const HEADER_FILL = 'F2F2F2';
const STYLE_MARK = 'data-word-styles';
const RULE_BORDER = { val: 'single', sz: 6, space: 1, color: 'A6A6A6' };

const formatId = (n: number): string => n.toString(16).toUpperCase().padStart(8, '0');
const idOf = (p: Paragraph): string => p.attrs[ID] ?? '';
const hasKeys = (o: object | undefined): boolean => !!o && Object.keys(o).length > 0;
/** A lookup table's own entry for a key (never an Object.prototype member such as "constructor"). */
const own = <T>(table: Record<string, T>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);
const MONO = MONO_FONTS.ascii;

const newParagraph = (properties: ParagraphProperties, children: Inline[] = []): Paragraph => ({
  kind: 'paragraph',
  properties,
  children,
  attrs: {},
});

const newRun = (properties: RunProperties, content: RunContent[]): Run => ({ kind: 'run', properties, content, attrs: {} });

/** The first paragraph in blocks, looking into tables and content controls. */
function firstParagraph(blocks: readonly Block[]): Paragraph | undefined {
  for (const block of blocks) {
    if (block.kind === 'paragraph') return block;
    if (block.kind === 'wrapper') {
      const p = firstParagraph(block.children);
      if (p) return p;
    } else if (block.kind === 'table') {
      for (const row of block.rows) {
        if (row.kind !== 'row') continue;
        for (const cell of row.cells) {
          if (cell.kind !== 'cell') continue;
          const p = firstParagraph(cell.children);
          if (p) return p;
        }
      }
    }
  }
  return undefined;
}

/** A block's anchor: its paragraph id, or "table:" and the id of a table's first paragraph. */
function anchorOf(block: Block): string {
  if (block.kind === 'paragraph') return idOf(block);
  if (block.kind === 'table') {
    const p = firstParagraph([block]);
    return p ? `table:${idOf(p)}` : '';
  }
  return '';
}

// --- Entities ---------------------------------------------------------------------------------------

const LATIN1 =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'.split(
    ' ',
  );
const GREEK = 'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho Sigmaf Sigma Tau Upsilon Phi Chi Psi Omega'.split(' ');
const OTHER_ENTITIES: Record<string, number> = {
  amp: 38, lt: 60, gt: 62, quot: 34, apos: 39, OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402,
  circ: 710, tilde: 732, ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205, lrm: 8206, rlm: 8207, hyphen: 8208,
  dash: 8208, ndash: 8211, mdash: 8212, horbar: 8213, lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221,
  bdquo: 8222, dagger: 8224, Dagger: 8225, bull: 8226, hellip: 8230, permil: 8240, prime: 8242, Prime: 8243, lsaquo: 8249,
  rsaquo: 8250, oline: 8254, frasl: 8260, euro: 8364, trade: 8482, larr: 8592, uarr: 8593, rarr: 8594, darr: 8595,
  harr: 8596, lArr: 8656, uArr: 8657, rArr: 8658, dArr: 8659, hArr: 8660, part: 8706, nabla: 8711, isin: 8712,
  notin: 8713, prod: 8719, sum: 8721, minus: 8722, lowast: 8727, radic: 8730, infin: 8734, cap: 8745, cup: 8746,
  int: 8747, there4: 8756, sim: 8764, asymp: 8776, ne: 8800, equiv: 8801, le: 8804, ge: 8805, sub: 8834, sup: 8835,
  loz: 9674, spades: 9824, clubs: 9827, hearts: 9829, diams: 9830, starf: 9733, star: 9734, check: 10003, cross: 10007,
  Tab: 9, NewLine: 10, thetasym: 977, upsih: 978, piv: 982,
};
const ENTITIES = new Map<string, string>();
LATIN1.forEach((name, i) => ENTITIES.set(name, String.fromCharCode(160 + i)));
GREEK.forEach((name, i) => {
  if (name === 'Sigmaf') {
    ENTITIES.set('sigmaf', String.fromCharCode(962));
    return;
  }
  ENTITIES.set(name, String.fromCharCode(913 + i));
  ENTITIES.set(name.toLowerCase(), String.fromCharCode(945 + i));
});
for (const [name, code] of Object.entries(OTHER_ENTITIES)) ENTITIES.set(name, String.fromCharCode(code));
/** Entities browsers also accept without the semicolon, longest first. */
const LEGACY = [...LATIN1, 'amp', 'lt', 'gt', 'quot', 'AMP', 'LT', 'GT', 'QUOT', 'COPY', 'REG'].sort((a, b) => b.length - a.length);
for (const upper of ['AMP', 'LT', 'GT', 'QUOT', 'COPY', 'REG']) ENTITIES.set(upper, ENTITIES.get(upper.toLowerCase())!);
// Windows-1252 for numeric references 0x80-0x9F, as browsers do.
const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';

function numericEntity(code: number): string {
  if (!Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
  if (code >= 0x80 && code <= 0x9f) return CP1252[code - 0x80];
  return String.fromCodePoint(code);
}

/** Decodes character references; in attributes, legacy ones followed by [A-Za-z0-9=] stay literal. */
function decode(s: string, attribute: boolean): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(?:#[xX]([0-9a-fA-F]+);?|#([0-9]+);?|([A-Za-z][A-Za-z0-9]*)(;?))/g, (m, hex, dec, name, semi, offset: number, all: string) => {
    if (hex !== undefined) return numericEntity(hex.length > 8 ? Infinity : parseInt(hex, 16));
    if (dec !== undefined) return numericEntity(dec.length > 8 ? Infinity : parseInt(dec, 10));
    if (semi) {
      const found = ENTITIES.get(name);
      if (found !== undefined) return found;
    }
    for (const legacy of LEGACY) {
      if (!name.startsWith(legacy)) continue;
      const rest = m.slice(legacy.length + 1);
      if (attribute) {
        const after = rest ? rest[0] : all[offset + m.length];
        if (after !== undefined && /[A-Za-z0-9=]/.test(after)) return m;
      }
      return ENTITIES.get(legacy)! + rest;
    }
    return m;
  });
}

// --- Tokenizer and tree builder --------------------------------------------------------------------

interface HElement {
  type: 'element';
  name: string;
  attrs: HtmlAttributes;
  children: HNode[];
  /** Source range of the element, for keeping it verbatim. */
  start: number;
  end: number;
}

interface HText {
  type: 'text';
  text: string;
}

interface HComment {
  type: 'comment';
  start: number;
  end: number;
}

type HNode = HElement | HText | HComment;

interface HtmlTree {
  source: string;
  doctype: string | null;
  htmlAttrs: HtmlAttributes;
  bodyAttrs: HtmlAttributes;
  head: (HElement | HComment)[];
  body: HElement;
}

const set = (s: string): Set<string> => new Set(s.split(' '));
const VOID = set('area base br col embed hr img input link meta param source track wbr keygen basefont bgsound frame');
const RAW_TEXT = set('script style xmp iframe noembed noframes noscript plaintext');
const ESCAPABLE_RAW = set('title textarea');
const HEAD_ONLY = set('title meta link style script base noscript template basefont bgsound');
const CLOSES_P = set(
  'address article aside blockquote center details dialog dir div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre listing section search summary table ul li dd dt xmp plaintext',
);
const SPECIAL = set(
  'address applet area article aside base blockquote body caption center col colgroup dd details dir div dl dt embed fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html iframe img input li link listing main marquee menu meta nav noembed noframes noscript object ol p param plaintext pre script search section select source style summary table tbody td template textarea tfoot th thead title tr track ul wbr xmp',
);
const P_STOPS = set('html table td th caption template object marquee applet button');
const DEFAULT_STOPS = set('html table td th caption template object marquee applet');
const TABLE_STOPS = set('html table');
const LI_STOPS = set('html ul ol menu dir table td th');
const DD_STOPS = set('html dl table td th');
const NO_STOPS = set('html');
const MAX_NESTING = 400;

const isHeadingTag = (name: string): boolean => name.length === 2 && name[0] === 'h' && name[1] >= '1' && name[1] <= '6';

interface Tag {
  name: string;
  attrs: HtmlAttributes;
  selfClosing: boolean;
  end: number;
}

/** A start tag at `lt`, or null when it never ends. */
function readTag(src: string, lt: number): Tag | null {
  const n = src.length;
  let q = lt + 1;
  while (q < n && !/[\s/>]/.test(src[q])) q++;
  const name = src.slice(lt + 1, q).toLowerCase();
  const attrs: HtmlAttributes = {};
  let selfClosing = false;
  for (;;) {
    while (q < n && /\s/.test(src[q])) q++;
    if (q >= n) return null;
    const c = src[q];
    if (c === '>') return { name, attrs, selfClosing, end: q + 1 };
    if (c === '/') {
      if (src[q + 1] === '>') return { name, attrs, selfClosing: true, end: q + 2 };
      q++;
      continue;
    }
    const s = q;
    q++;
    while (q < n && !/[\s/>=]/.test(src[q])) q++;
    const attr = src.slice(s, q).toLowerCase();
    while (q < n && /\s/.test(src[q])) q++;
    let value = '';
    if (src[q] === '=') {
      q++;
      while (q < n && /\s/.test(src[q])) q++;
      const quote = src[q];
      if (quote === '"' || quote === "'") {
        const close = src.indexOf(quote, q + 1);
        if (close < 0) return null;
        value = src.slice(q + 1, close);
        q = close + 1;
      } else {
        const vs = q;
        while (q < n && !/[\s>]/.test(src[q])) q++;
        value = src.slice(vs, q);
      }
    }
    if (attr !== '__proto__' && !Object.hasOwn(attrs, attr)) attrs[attr] = decode(value, true);
    selfClosing = false;
  }
}

/** Parses a document the way browsers do, simplified: implied head/body, implied end tags, raw text. */
function parseHtml(input: string): HtmlTree {
  const src = (input.charCodeAt(0) === 0xfeff ? input.slice(1) : input).replace(/\r\n?/g, '\n');
  const n = src.length;
  const body: HElement = { type: 'element', name: 'body', attrs: {}, children: [], start: 0, end: n };
  const tree: HtmlTree = { source: src, doctype: null, htmlAttrs: {}, bodyAttrs: {}, head: [], body };
  let mode: 'before' | 'head' | 'after' | 'body' = 'before';
  const stack: HElement[] = [body];
  const top = (): HElement => stack[stack.length - 1];

  const merge = (target: HtmlAttributes, attrs: HtmlAttributes): void => {
    for (const [k, v] of Object.entries(attrs)) if (!Object.hasOwn(target, k)) target[k] = v;
  };

  const addText = (text: string): void => {
    if (!text) return;
    if (mode !== 'body') {
      if (!/\S/.test(text)) return;
      mode = 'body';
    }
    const parent = top();
    const last = parent.children[parent.children.length - 1];
    if (last && last.type === 'text') last.text += text;
    else {
      if (!parent.children.length && (parent.name === 'pre' || parent.name === 'listing' || parent.name === 'textarea') && text[0] === '\n') {
        text = text.slice(1);
      }
      if (text) parent.children.push({ type: 'text', text });
    }
  };

  const addComment = (start: number, end: number): void => {
    const node: HComment = { type: 'comment', start, end };
    if (mode === 'body') top().children.push(node);
    else tree.head.push(node);
  };

  /** Pops stack[k] and everything above it: stack[k] ends at `end`, the others (implicitly closed) at `inner`. */
  const popTo = (k: number, end: number, inner: number): void => {
    for (let j = stack.length - 1; j >= k; j--) stack[j].end = j === k ? end : inner;
    stack.length = k;
  };

  const find = (name: string, stops: Set<string>): number => {
    for (let j = stack.length - 1; j > 0; j--) {
      if (stack[j].name === name) return j;
      if (stops.has(stack[j].name)) return -1;
    }
    return -1;
  };

  /** Closes the nearest open element named in `names` when nothing but the allowed elements is above it. */
  const closeOpen = (names: Set<string>, pass: (name: string) => boolean, pos: number): void => {
    for (let j = stack.length - 1; j > 0; j--) {
      const name = stack[j].name;
      if (names.has(name)) {
        popTo(j, pos, pos);
        return;
      }
      if (!pass(name)) return;
    }
  };

  const startTag = (tag: Tag, start: number): HElement | null => {
    const { name, attrs } = tag;
    if (name === 'html') {
      merge(tree.htmlAttrs, attrs);
      return null;
    }
    const element: HElement = { type: 'element', name, attrs, children: [], start, end: tag.end };
    if (mode !== 'body') {
      if (name === 'head') {
        if (mode === 'before') mode = 'head';
        return null;
      }
      if (name === 'body') {
        mode = 'body';
        merge(tree.bodyAttrs, attrs);
        return null;
      }
      if (HEAD_ONLY.has(name)) {
        tree.head.push(element);
        return element;
      }
      mode = 'body';
    }
    if (name === 'body') {
      merge(tree.bodyAttrs, attrs);
      return null;
    }
    if (name === 'head') return null;

    if (CLOSES_P.has(name)) {
      const k = find('p', P_STOPS);
      if (k > 0) popTo(k, start, start);
    }
    if (isHeadingTag(name) && isHeadingTag(top().name)) popTo(stack.length - 1, start, start);
    const notSpecial = (n: string): boolean => !SPECIAL.has(n) || n === 'address' || n === 'div' || n === 'p';
    if (name === 'li') closeOpen(set('li'), notSpecial, start);
    else if (name === 'dd' || name === 'dt') closeOpen(set('dd dt'), notSpecial, start);
    else if (name === 'td' || name === 'th') closeOpen(set('td th'), (n) => !set('tr table tbody thead tfoot').has(n), start);
    else if (name === 'tr') closeOpen(set('tr'), (n) => !set('table tbody thead tfoot').has(n), start);
    else if (name === 'thead' || name === 'tbody' || name === 'tfoot') closeOpen(set('thead tbody tfoot'), (n) => n !== 'table', start);
    else if (name === 'a') {
      const k = find('a', DEFAULT_STOPS);
      if (k > 0) popTo(k, start, start);
    } else if ((name === 'option' || name === 'optgroup') && top().name === 'option') popTo(stack.length - 1, start, start);

    top().children.push(element);
    const foreign = tag.selfClosing && stack.some((e) => e.name === 'svg' || e.name === 'math');
    const leaf = VOID.has(name) || RAW_TEXT.has(name) || ESCAPABLE_RAW.has(name) || foreign;
    if (!leaf && stack.length < MAX_NESTING) stack.push(element);
    return element;
  };

  const endTag = (name: string, start: number, end: number): void => {
    if (mode !== 'body') {
      if (name === 'head') mode = 'after';
      if (name === 'br') {
        mode = 'body';
        startTag({ name: 'br', attrs: {}, selfClosing: false, end }, start);
      }
      return;
    }
    if (name === 'body' || name === 'html' || name === 'head') return;
    if (name === 'br') {
      startTag({ name: 'br', attrs: {}, selfClosing: false, end }, start);
      return;
    }
    let stops = DEFAULT_STOPS;
    if (set('td th tr thead tbody tfoot caption colgroup').has(name)) stops = TABLE_STOPS;
    else if (name === 'table') stops = NO_STOPS;
    else if (name === 'li') stops = LI_STOPS;
    else if (name === 'dd' || name === 'dt') stops = DD_STOPS;
    else if (name === 'p') stops = P_STOPS;
    const k = find(name, stops);
    if (k > 0) popTo(k, end, start);
  };

  let i = 0;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      addText(decode(src.slice(i), false));
      break;
    }
    if (lt > i) addText(decode(src.slice(i, lt), false));
    i = lt;
    const next = src[lt + 1];
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 2);
      i = e < 0 ? n : e + 3;
      addComment(lt, i);
      continue;
    }
    if (next === '!' || next === '?') {
      const e = src.indexOf('>', lt + 2);
      i = e < 0 ? n : e + 1;
      const text = src.slice(lt, i);
      if (/^<!doctype/i.test(text)) {
        if (tree.doctype === null && mode === 'before') tree.doctype = text;
      } else addComment(lt, i);
      continue;
    }
    if (next === '/') {
      const c = src[lt + 2];
      if (c !== undefined && /[A-Za-z]/.test(c)) {
        let j = lt + 2;
        while (j < n && !/[\s/>]/.test(src[j])) j++;
        const e = src.indexOf('>', j);
        i = e < 0 ? n : e + 1;
        endTag(src.slice(lt + 2, j).toLowerCase(), lt, i);
        continue;
      }
      if (c === '>') {
        i = lt + 3;
        continue;
      }
      if (c !== undefined) {
        const e = src.indexOf('>', lt + 2);
        i = e < 0 ? n : e + 1;
        addComment(lt, i);
        continue;
      }
    }
    if (next !== undefined && /[A-Za-z]/.test(next)) {
      const tag = readTag(src, lt);
      if (tag) {
        const foreign = tag.selfClosing && stack.some((e) => e.name === 'svg' || e.name === 'math');
        const element = startTag(tag, lt);
        i = tag.end;
        if ((RAW_TEXT.has(tag.name) || ESCAPABLE_RAW.has(tag.name)) && !foreign) {
          const re = new RegExp(`</${tag.name}(?=[\\s/>]|$)`, 'gi');
          re.lastIndex = i;
          const m = tag.name === 'plaintext' ? null : re.exec(src);
          const contentEnd = m ? m.index : n;
          let end = n;
          if (m) {
            const gt = src.indexOf('>', m.index);
            end = gt < 0 ? n : gt + 1;
          }
          const text = src.slice(i, contentEnd);
          if (element) {
            element.children = text ? [{ type: 'text', text: ESCAPABLE_RAW.has(tag.name) ? decode(text, false) : text }] : [];
            element.end = end;
          }
          i = end;
        }
        continue;
      }
      // The tag runs into the end of the file (no '>', or a quote that never closes): browsers
      // drop it; the rest is kept as text. Stopping here also keeps a file of many unfinished tags
      // from being rescanned to its end once per '<'.
      addText(decode(src.slice(lt), false));
      break;
    }
    addText('<');
    i = lt + 1;
  }
  if (stack.length > 1) popTo(1, n, n);
  return tree;
}

// --- Element classes --------------------------------------------------------------------------------

const CONTAINERS = set('div section article main header footer aside nav figure address details center hgroup search dl');
const PARAGRAPHS = set('p h1 h2 h3 h4 h5 h6 figcaption summary dt dd caption legend');
const LISTS = set('ul ol menu dir');
const PRE_TAGS = set('pre listing xmp plaintext');
const TABLE_PARTS = set('thead tbody tfoot tr td th colgroup col');
const INLINE = set(
  'a b strong i em cite dfn var u ins s strike del sup sub code kbd samp tt mark span font small big abbr acronym bdi bdo time data q label nobr ruby rb rt rp rtc',
);
const BLOCKS = new Set([...CONTAINERS, ...PARAGRAPHS, ...LISTS, ...PRE_TAGS, ...TABLE_PARTS, 'blockquote', 'li', 'table', 'hr']);
const CONTENT_VOID = set('img br hr');
const TRANSPARENT = set('html body head');

const mapped = (name: string): boolean =>
  BLOCKS.has(name) || INLINE.has(name) || CONTENT_VOID.has(name) || TRANSPARENT.has(name) || name === 'wbr' || name.includes(':');

/** A <mark> that is a comment (the export's), not a highlight. */
const isCommentMark = (el: HElement): boolean => el.name === 'mark' && (el.attrs['data-comment-id'] !== undefined || /(^|\s)comment(\s|$)/.test(el.attrs.class ?? ''));

/** Whether an element holds block-level elements (looking through inline elements). */
function hasBlock(el: HElement): boolean {
  for (const child of el.children) {
    if (child.type !== 'element') continue;
    if (BLOCKS.has(child.name)) return true;
    if ((INLINE.has(child.name) || child.name.includes(':')) && hasBlock(child)) return true;
  }
  return false;
}

/** Whether an element holds unmappable content and nothing else (it is then kept verbatim whole). */
function rawOnly(el: HElement): boolean {
  let raw = false;
  const content = (node: HElement): boolean => {
    for (const child of node.children) {
      if (child.type === 'text') {
        if (/\S/.test(child.text)) return true;
      } else if (child.type === 'comment') raw = true;
      else if (!mapped(child.name)) raw = true;
      else if (CONTENT_VOID.has(child.name) || content(child)) return true;
    }
    return false;
  };
  return !content(el) && raw;
}

function textContent(node: HNode): string {
  if (node.type === 'text') return node.text;
  if (node.type === 'comment' || !mapped(node.name)) return '';
  return node.children.map(textContent).join('');
}

// --- CSS --------------------------------------------------------------------------------------------

/** Declarations of a style attribute or rule body, property names lowercased, !important dropped. */
function parseDecls(style: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  const flush = (end: number): void => {
    const piece = style.slice(start, end);
    const colon = piece.indexOf(':');
    if (colon > 0) {
      const prop = piece.slice(0, colon).trim().toLowerCase();
      const value = piece
        .slice(colon + 1)
        .replace(/\s*!\s*important\s*$/i, '')
        .trim();
      if (prop && value) out.push([prop, value]);
    }
    start = end + 1;
  };
  for (let i = 0; i < style.length; i++) {
    const c = style[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) flush(i);
  }
  flush(style.length);
  return out;
}

const formatDecls = (decls: readonly (readonly [string, string])[]): string => decls.map(([p, v]) => `${p}: ${v}`).join('; ');

const NAMED_COLORS: Record<string, string> = {
  black: '000000', white: 'FFFFFF', red: 'FF0000', lime: '00FF00', green: '008000', blue: '0000FF', yellow: 'FFFF00',
  cyan: '00FFFF', aqua: '00FFFF', magenta: 'FF00FF', fuchsia: 'FF00FF', silver: 'C0C0C0', gray: '808080', grey: '808080',
  maroon: '800000', olive: '808000', purple: '800080', teal: '008080', navy: '000080', orange: 'FFA500', pink: 'FFC0CB',
  brown: 'A52A2A', gold: 'FFD700', indigo: '4B0082', violet: 'EE82EE', darkblue: '00008B', darkred: '8B0000',
  darkgreen: '006400', darkgray: 'A9A9A9', darkgrey: 'A9A9A9', lightgray: 'D3D3D3', lightgrey: 'D3D3D3',
  lightblue: 'ADD8E6', lightgreen: '90EE90', lightyellow: 'FFFFE0', orangered: 'FF4500', crimson: 'DC143C',
  coral: 'FF7F50', salmon: 'FA8072', tomato: 'FF6347', steelblue: '4682B4', royalblue: '4169E1', dodgerblue: '1E90FF',
  skyblue: '87CEEB', slategray: '708090', slategrey: '708090', dimgray: '696969', dimgrey: '696969',
  whitesmoke: 'F5F5F5', beige: 'F5F5DC', khaki: 'F0E68C', tan: 'D2B48C', chocolate: 'D2691E', firebrick: 'B22222',
  forestgreen: '228B22', seagreen: '2E8B57', darkorange: 'FF8C00', turquoise: '40E0D0', plum: 'DDA0DD',
  lavender: 'E6E6FA', midnightblue: '191970', darkslategray: '2F4F4F', mediumblue: '0000CD', cornflowerblue: '6495ED',
};

/** RRGGBB; null for transparent; undefined when not a color this understands. */
function parseColor(value: string): string | null | undefined {
  const v = value.trim().toLowerCase();
  if (v === 'transparent') return null;
  const named = own(NAMED_COLORS, v);
  if (named) return named;
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) {
      if (h.length === 4 && h[3] === '0') return null;
      return (h[0] + h[0] + h[1] + h[1] + h[2] + h[2]).toUpperCase();
    }
    if (h.length === 6) return h.toUpperCase();
    if (h.length === 8) return h.slice(6) === '00' ? null : h.slice(0, 6).toUpperCase();
    return undefined;
  }
  m = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    const channel = (s: string): string => {
      const x = s.endsWith('%') ? (parseFloat(s) * 255) / 100 : parseFloat(s);
      return Math.max(0, Math.min(255, Math.round(x)))
        .toString(16)
        .toUpperCase()
        .padStart(2, '0');
    };
    return channel(m[1]) + channel(m[2]) + channel(m[3]);
  }
  return undefined;
}

const UNIT_POINTS: Record<string, number> = { pt: 1, px: 0.75, in: 72, cm: 72 / 2.54, mm: 72 / 25.4, pc: 12, q: 72 / 101.6 };

/** A CSS length in points; em and % are relative to `basePt`. */
function toPoints(value: string, basePt: number): number | undefined {
  const m = /^(-?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/i.exec(value.trim());
  if (!m) return undefined;
  const x = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (!unit) return x === 0 ? 0 : undefined;
  const perUnit = own(UNIT_POINTS, unit);
  if (perUnit !== undefined) return x * perUnit;
  if (unit === 'em') return x * basePt;
  if (unit === 'rem') return x * 12;
  if (unit === '%') return (x * basePt) / 100;
  if (unit === 'ex' || unit === 'ch') return (x * basePt) / 2;
  return undefined;
}

const twips = (pt: number): number => Math.round(pt * 20);
const round = (x: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
};
const pt = (tw: number): string => (tw === 0 ? '0' : `${round(tw / 20, 2)}pt`);

const FONT_SIZE_KEYWORDS: Record<string, number> = {
  'xx-small': 7, 'x-small': 7.5, small: 10, medium: 12, large: 13.5, 'x-large': 18, 'xx-large': 24, 'xxx-large': 36,
};
const FONT_TAG_SIZES = [8, 10, 12, 14, 18, 24, 36];
const GENERIC_FONTS: Record<string, string> = { serif: 'Times New Roman', 'sans-serif': 'Arial', monospace: MONO };

function fontFamily(value: string): string | undefined {
  const first = value.split(',')[0]?.trim().replace(/^["']|["']$/g, '').trim();
  if (!first) return undefined;
  const lower = first.toLowerCase();
  const generic = own(GENERIC_FONTS, lower);
  if (generic) return generic;
  if (/^(inherit|initial|unset|revert|system-ui|cursive|fantasy|emoji|math|fangsong|ui-.*)$/.test(lower) || first.startsWith('var(')) return undefined;
  return first;
}

const fontsOf = (name: string) => ({ ascii: name, hAnsi: name, eastAsia: name, cs: name });

/** Applies an inherited text property to run properties; false when it isn't one. */
function runCss(run: RunProperties, prop: string, value: string, basePt: number): boolean {
  const v = value.toLowerCase();
  switch (prop) {
    case 'color': {
      const color = parseColor(value);
      if (color === undefined) return false;
      if (color) run.color = { val: color };
      else delete run.color;
      return true;
    }
    case 'font-family': {
      const name = fontFamily(value);
      if (!name) return false;
      run.fonts = fontsOf(name);
      return true;
    }
    case 'font-size': {
      let size = own(FONT_SIZE_KEYWORDS, v);
      if (v === 'smaller') size = basePt / 1.2;
      else if (v === 'larger') size = basePt * 1.2;
      else if (size === undefined) size = toPoints(v, basePt) as number;
      if (size === undefined || !(size > 0)) return false;
      run.size = Math.max(1, Math.round(size * 2));
      run.sizeCs = run.size;
      return true;
    }
    case 'font-weight':
      if (v === 'bold' || v === 'bolder' || (/^\d+$/.test(v) && Number(v) >= 600)) run.bold = true;
      else if (v === 'normal' || v === 'lighter' || /^\d+$/.test(v)) run.bold = false;
      else return false;
      return true;
    case 'font-style':
      if (v === 'italic' || v.startsWith('oblique')) run.italic = true;
      else if (v === 'normal') run.italic = false;
      else return false;
      return true;
    case 'text-decoration':
    case 'text-decoration-line': {
      const words = v.split(/\s+/);
      if (words.includes('none')) {
        run.underline = { val: 'none' };
        run.strike = false;
        return true;
      }
      const underline = words.includes('underline');
      const strike = words.includes('line-through');
      if (!underline && !strike) return false;
      if (underline) run.underline = { val: words.includes('double') ? 'double' : 'single' };
      if (strike) run.strike = true;
      return true;
    }
    case 'text-transform':
      if (v === 'uppercase') run.caps = true;
      else if (v === 'none') run.caps = false;
      else return false;
      return true;
    case 'font-variant':
    case 'font-variant-caps':
      if (v === 'small-caps') run.smallCaps = true;
      else if (v === 'normal') run.smallCaps = false;
      else return false;
      return true;
  }
  return false;
}

/** Applies a paragraph box property; false when it isn't one. */
function paraCss(pp: ParagraphProperties, prop: string, value: string): boolean {
  const v = value.toLowerCase().trim();
  const length = (s: string): number | undefined => {
    const p = toPoints(s, 12);
    return p === undefined ? undefined : twips(p);
  };
  switch (prop) {
    case 'margin': {
      const parts = v.split(/\s+/);
      if (parts.length > 4) return false;
      const values = parts.map(length);
      if (values.some((x) => x === undefined)) return false;
      const [top, right = top, bottom = top, left = right] = values as number[];
      pp.spacing = { ...pp.spacing, before: top, after: bottom };
      pp.indent = { ...pp.indent, left, right };
      return true;
    }
    case 'margin-top':
    case 'margin-bottom': {
      const x = length(v);
      if (x === undefined) return false;
      pp.spacing = { ...pp.spacing, [prop === 'margin-top' ? 'before' : 'after']: x };
      return true;
    }
    case 'margin-left':
    case 'margin-right': {
      const x = length(v);
      if (x === undefined) return false;
      pp.indent = { ...pp.indent, [prop === 'margin-left' ? 'left' : 'right']: x };
      return true;
    }
    case 'text-indent': {
      const x = length(v);
      if (x === undefined) return false;
      const indent = { ...pp.indent };
      delete indent.firstLine;
      delete indent.hanging;
      if (x >= 0) indent.firstLine = x;
      else indent.hanging = -x;
      pp.indent = indent;
      return true;
    }
    case 'line-height': {
      if (v === 'normal') return true;
      if (/^\d*\.?\d+$/.test(v)) {
        pp.spacing = { ...pp.spacing, line: Math.round(parseFloat(v) * 240), lineRule: 'auto' };
        return true;
      }
      if (v.endsWith('%')) {
        const x = parseFloat(v);
        if (!Number.isFinite(x)) return false;
        pp.spacing = { ...pp.spacing, line: Math.round(x * 2.4), lineRule: 'auto' };
        return true;
      }
      const x = length(v);
      if (x === undefined || x <= 0) return false;
      pp.spacing = { ...pp.spacing, line: x, lineRule: 'exact' };
      return true;
    }
    case 'page-break-before':
    case 'break-before':
      if (v === 'always' || v === 'page') pp.pageBreakBefore = true;
      else if (v === 'auto') pp.pageBreakBefore = false;
      else return false;
      return true;
  }
  return false;
}

function parseAlign(value: string): string | undefined {
  switch (value.trim().toLowerCase()) {
    case 'left':
    case 'start':
      return 'left';
    case 'right':
    case 'end':
      return 'right';
    case 'center':
    case 'middle':
      return 'center';
    case 'justify':
      return 'both';
  }
  return undefined;
}

const shadingOf = (fill: string) => ({ val: 'clear', color: 'auto', fill });

// --- Import -----------------------------------------------------------------------------------------

interface LinkRef {
  el: HElement;
  url?: string;
  anchor?: string;
}

/** What an element passes down to its content. */
interface Ctx {
  run: RunProperties;
  link: LinkRef | null;
  /** Inside <code>/<kbd>/<samp>. */
  code: boolean;
  /** Whitespace is kept (white-space: pre, or inside <pre>). */
  preserve: boolean;
  /** Inside a <pre>: one Code paragraph per line. */
  pre: boolean;
  align?: string;
  heading: number;
  /** Blockquote depth. */
  quote: number;
  /** Nesting depth for the next list. */
  level: number;
  /** Level + 1 of the list item this is in (for its later paragraphs), or 0. */
  item: number;
  list: { numId: number; level: number } | null;
  /** Containers here can be recorded as wrappers (not inside lists, quotes, paragraphs). */
  flowLevel: boolean;
  /** Current font size in points, for em and %. */
  sizePt: number;
}

interface Item {
  numId: number;
  level: number;
  attrs?: HtmlAttributes;
  para: ParagraphProperties;
  style?: string;
  used: boolean;
}

interface ParaState {
  p: Paragraph;
  id: string;
  /** Made for an element (p, h1, div...): dropped at the end if it stayed empty and has no attributes. */
  explicit: boolean;
  /** Kept even when empty (hr). */
  keep: boolean;
  /** Has text, tabs or images. */
  content: boolean;
  hadBreak: boolean;
  /** At a point where a collapsible space would be dropped (paragraph start, after a space or break). */
  lastSpace: boolean;
  /** The text ends in a collapsible space (trimmed at the end of the line). */
  trailing: boolean;
  /** A <pre> line started by a newline. */
  fromNewline: boolean;
  linkEl: HElement | null;
  hyperlink: Hyperlink | null;
  run: Run | null;
  runKey: string;
}

type GroupKey = 'list' | 'quote' | 'pre' | 'code';

class Flow {
  readonly blocks: Block[] = [];
  para: ParaState | null = null;
  item: Item | null = null;
  pending: HtmlFragment[] = [];
  /** Attributes of groups (ul, blockquote, pre) waiting for their first paragraph. */
  groups: [GroupKey, HtmlAttributes][] = [];
  lastKey: string | null = null;

  constructor(readonly cell: boolean) {}
}

type Role = 'inline' | 'para' | 'item' | 'container' | 'group' | 'cell';

const BULLETS = ['•', '◦', '▪'];
const TYPE_FORMATS: Record<string, string> = { '1': 'decimal', a: 'lowerLetter', A: 'upperLetter', i: 'lowerRoman', I: 'upperRoman' };
const RUN_CSS_KEYS = ['fonts', 'size', 'sizeCs', 'color', 'bold', 'italic', 'underline', 'strike', 'caps', 'smallCaps', 'shading', 'highlight'] as const;
const PARA_CSS_KEYS = ['spacing', 'indent', 'justification', 'shading', 'pageBreakBefore'] as const;

/** Trims a trailing space from the last text of an inline list; true once it reached content. */
function trimEnd(children: Inline[]): boolean {
  for (let i = children.length - 1; i >= 0; i--) {
    const c = children[i];
    // Comment markers are not content: trailing space is trimmed from the text before them.
    if (commentMarker(c) || (c.kind === 'run' && c.content.length === 1 && c.content[0].kind === 'raw' && c.content[0].xml.name === 'w:commentReference')) continue;
    if (c.kind === 'run') {
      const last = c.content[c.content.length - 1];
      if (!last) {
        children.splice(i, 1);
        continue;
      }
      if (last.kind === 'text' && last.text.endsWith(' ')) {
        last.text = last.text.slice(0, -1);
        if (!last.text) c.content.pop();
        if (!c.content.length) children.splice(i, 1);
      }
      return true;
    }
    if (c.kind === 'hyperlink') {
      if (c.children.some((r) => r.kind === 'run' && r.properties.style === 'ImagePlaceholder')) return true;
      const hit = trimEnd(c.children);
      if (!c.children.length) children.splice(i, 1);
      if (hit) return true;
      continue;
    }
    return true;
  }
  return false;
}

/** Removes a final line break (browsers don't show a line for it); true when one was removed. */
function dropTrailingBreak(children: Inline[]): boolean {
  const c = children[children.length - 1];
  if (!c) return false;
  if (c.kind === 'run') {
    const last = c.content[c.content.length - 1];
    if (last?.kind !== 'break' || last.type) return false;
    c.content.pop();
    if (!c.content.length) children.pop();
    return true;
  }
  if (c.kind === 'hyperlink') {
    const removed = dropTrailingBreak(c.children);
    if (!c.children.length) children.pop();
    return removed;
  }
  return false;
}

class Importer {
  readonly info: Record<string, HtmlBlock> = {};
  readonly fragments: HtmlFragment[] = [];
  readonly wrappers: HtmlWrapper[] = [];
  /** How many wrappers end at each anchor. */
  private readonly wrapperEnds = new Map<string, number>();
  readonly used = new Set<string>();
  /** Paragraph styles defined by the generated style block, applied through class names. */
  readonly classStyles = new Set<string>();
  private readonly src: string;
  private nextId = 1;
  /** Comment ids as written in the page, and the ones they have in the document; those read. */
  private readonly commentIds = new Map<string, string>();
  private readonly commentDone = new Set<string>();
  private nextAbstract: number;
  private nextInstance: number;
  private readonly keys = new WeakMap<Ctx, string>();
  /** Pictures already added to the document, by the address they were found at. */
  private readonly embedded = new Map<string, { part: string; pixels: { w: number; h: number } }>();

  constructor(
    readonly doc: WordDocument,
    readonly tree: HtmlTree,
    private readonly images?: ImageSource,
  ) {
    this.src = tree.source;
    this.nextAbstract = doc.numbering.abstracts.reduce((m, a) => Math.max(m, a.id), -1) + 1;
    this.nextInstance = doc.numbering.instances.reduce((m, a) => Math.max(m, a.id), 0) + 1;
  }

  run(): HtmlExtension {
    const { tree, doc } = this;
    const ext: HtmlExtension = {};
    if (tree.doctype !== null && !/^<!doctype\s+html\s*>$/i.test(tree.doctype.trim())) ext.doctype = tree.doctype;
    if (hasKeys(tree.htmlAttrs)) ext.htmlAttrs = tree.htmlAttrs;
    const head: string[] = [];
    for (const node of tree.head) {
      if (node.type === 'element' && node.name === 'style' && Object.hasOwn(node.attrs, STYLE_MARK)) {
        this.wordStyles(textContentRaw(node));
        ext.wordStyles = true;
        continue;
      }
      head.push(this.src.slice(node.start, node.end).trim());
    }
    if (head.length) ext.head = head.join('\n');
    if (hasKeys(tree.bodyAttrs)) ext.bodyAttrs = tree.bodyAttrs;

    const flow = new Flow(false);
    const ctx: Ctx = {
      run: {},
      link: null,
      code: false,
      preserve: false,
      pre: false,
      heading: 0,
      quote: 0,
      level: 0,
      item: 0,
      list: null,
      flowLevel: true,
      sizePt: 12,
    };
    for (const child of tree.body.children) this.visit(child, flow, ctx);
    this.end(flow);
    if (!flow.blocks.length) {
      const p = this.paragraphWithId({});
      flow.blocks.push(p);
      this.entry(idOf(p)).empty = true;
    }
    doc.body = flow.blocks;
    this.install();
    if (hasKeys(this.info)) ext.blocks = this.info;
    if (this.wrappers.length) ext.wrappers = this.wrappers;
    if (this.fragments.length) ext.fragments = this.fragments;
    return ext;
  }

  // --- Blocks and paragraphs ---

  private entry(id: string): HtmlBlock {
    return (this.info[id] ??= {});
  }

  private paragraphWithId(props: ParagraphProperties): Paragraph {
    const p = newParagraph(props);
    p.attrs[ID] = formatId(this.nextId++);
    return p;
  }

  private resolvePending(flow: Flow, anchor: string): void {
    for (const f of flow.pending) {
      f.anchor = anchor;
      f.place = 'before';
    }
    flow.pending = [];
  }

  /** Starts a paragraph whose style comes from where it is (heading, list item, quote, pre). */
  private open(flow: Flow, ctx: Ctx, direct: ParagraphProperties, tag?: string, attrs?: HtmlAttributes, explicit = false): ParaState {
    this.close(flow);
    const props: ParagraphProperties = {};
    const item = flow.item;
    let isItem = false;
    if (ctx.pre) props.style = 'Code';
    else if (item && !item.used) {
      props.style = item.style ?? 'ListParagraph';
      props.numbering = { id: item.numId, level: item.level };
      item.used = true;
      isItem = true;
      Object.assign(props, { ...item.para, style: props.style, numbering: props.numbering });
    } else if (ctx.heading) props.style = `Heading${ctx.heading}`;
    else if (ctx.item) {
      props.style = 'ListParagraph';
      props.indent = { left: 720 * ctx.item };
    } else if (ctx.quote) {
      props.style = 'Quote';
      if (ctx.quote > 1) props.indent = { left: 720 * (ctx.quote - 1) };
    }
    if (ctx.align) props.justification = ctx.align;
    for (const [key, value] of Object.entries(direct) as [keyof ParagraphProperties, unknown][]) {
      if ((key === 'spacing' || key === 'indent') && props[key]) Object.assign(props, { [key]: { ...props[key], ...(value as object) } });
      else Object.assign(props, { [key]: value });
    }
    if (props.style) this.used.add(props.style);
    const p = this.paragraphWithId(props);
    const id = idOf(p);
    flow.blocks.push(p);
    const info: HtmlBlock = {};
    if (tag) info.tag = tag;
    if (attrs && hasKeys(attrs)) info.attrs = attrs;
    if (isItem && item?.attrs) info.item = item.attrs;
    for (const [key, value] of flow.groups) if (info[key] === undefined) info[key] = value;
    flow.groups = [];
    if (hasKeys(info)) this.info[id] = info;
    this.resolvePending(flow, id);
    flow.para = {
      p,
      id,
      explicit: explicit && !isItem,
      keep: false,
      content: false,
      hadBreak: false,
      lastSpace: true,
      trailing: false,
      fromNewline: false,
      linkEl: null,
      hyperlink: null,
      run: null,
      runKey: '',
    };
    return flow.para;
  }

  private ensure(flow: Flow, ctx: Ctx): ParaState {
    return flow.para ?? this.open(flow, ctx, {});
  }

  /** Removes the open paragraph; what was anchored to it waits for the next block. */
  private discard(flow: Flow, st: ParaState): void {
    const i = flow.blocks.lastIndexOf(st.p);
    if (i >= 0) flow.blocks.splice(i, 1);
    delete this.info[st.id];
    for (const f of this.fragments) {
      if (f.anchor === st.id) {
        f.anchor = null;
        f.place = 'before';
        flow.pending.push(f);
      }
    }
    if (flow.para === st) flow.para = null;
  }

  /** Finishes the open paragraph: trims the end of the line, drops empty elements. */
  private close(flow: Flow): void {
    const st = flow.para;
    if (!st) return;
    flow.para = null;
    if (st.trailing) trimEnd(st.p.children);
    dropTrailingBreak(st.p.children);
    if (st.explicit && !st.content && !st.hadBreak && !st.keep) {
      const info = this.info[st.id];
      const onlyTag = !info || Object.keys(info).every((k) => k === 'tag');
      if (onlyTag && !this.fragments.some((f) => f.anchor === st.id)) {
        this.discard(flow, st);
        return;
      }
      this.entry(st.id).empty = true;
    }
    flow.lastKey = st.id;
  }

  /** Anchors what is waiting after the last block, and after the containers that closed at it. */
  private resolveAfter(flow: Flow): void {
    if (!flow.pending.length) return;
    const key = flow.lastKey;
    const outside = key === null ? 0 : (this.wrapperEnds.get(key) ?? 0);
    for (const f of flow.pending) {
      f.anchor = key;
      f.place = 'after';
      if (outside) f.outside = outside;
    }
    flow.pending = [];
  }

  /** Ends a block list: closes its paragraph and anchors what is still waiting after its last block. */
  private end(flow: Flow): void {
    this.close(flow);
    this.resolveAfter(flow);
  }

  private addBlock(flow: Flow, block: Block): void {
    this.close(flow);
    flow.blocks.push(block);
    const key = anchorOf(block);
    flow.lastKey = key;
    this.resolvePending(flow, key);
  }

  // --- Inline content ---

  private runKey(ctx: Ctx): string {
    let key = this.keys.get(ctx);
    if (key === undefined) {
      key = JSON.stringify([ctx.run, ctx.code && !ctx.pre, !!ctx.link]);
      this.keys.set(ctx, key);
    }
    return key;
  }

  private runProps(ctx: Ctx): RunProperties {
    const props: RunProperties = JSON.parse(JSON.stringify(ctx.run));
    if (ctx.code && !ctx.pre) {
      props.style = 'InlineCode';
      props.fonts = { ...MONO_FONTS };
      this.used.add('InlineCode');
    } else if (ctx.link) {
      props.style = 'Hyperlink';
      this.used.add('Hyperlink');
    }
    return props;
  }

  private append(st: ParaState, ctx: Ctx, item: RunContent): void {
    const key = this.runKey(ctx);
    const linkEl = ctx.link?.el ?? null;
    let run = st.run;
    if (!run || st.runKey !== key || st.linkEl !== linkEl) {
      run = newRun(this.runProps(ctx), []);
      if (ctx.link) {
        if (st.linkEl !== linkEl || !st.hyperlink) {
          const h: Hyperlink = { kind: 'hyperlink', children: [], attrs: {} };
          if (ctx.link.anchor !== undefined) h.anchor = ctx.link.anchor;
          else h.url = ctx.link.url ?? '';
          st.p.children.push(h);
          st.hyperlink = h;
        }
        st.hyperlink.children.push(run);
      } else {
        st.hyperlink = null;
        st.p.children.push(run);
      }
      st.run = run;
      st.runKey = key;
      st.linkEl = linkEl;
    }
    const last = run.content[run.content.length - 1];
    if (item.kind === 'text' && last?.kind === 'text') last.text += item.text;
    else run.content.push(item);
  }

  /** Appends preserved text: tabs become tab items, newlines line breaks. */
  private appendPreserved(st: ParaState, ctx: Ctx, text: string): void {
    for (const part of text.split(/(\t|\n)/)) {
      if (!part) continue;
      if (part === '\t') this.append(st, ctx, { kind: 'tab' });
      else if (part === '\n') {
        this.append(st, ctx, { kind: 'break' });
        st.hadBreak = true;
      } else this.append(st, ctx, { kind: 'text', text: part });
      st.content = true;
    }
    st.lastSpace = false;
    st.trailing = false;
  }

  private text(flow: Flow, ctx: Ctx, text: string): void {
    if (ctx.pre) {
      const lines = text.split('\n');
      lines.forEach((line, k) => {
        let st = flow.para;
        if (k > 0 || !st) {
          st = this.open(flow, ctx, {});
          st.fromNewline = k > 0;
        }
        if (line) this.appendPreserved(st, ctx, line);
      });
      return;
    }
    if (ctx.preserve) {
      if (text) this.appendPreserved(this.ensure(flow, ctx), ctx, text);
      return;
    }
    let s = text.replace(/[ \t\n\r\f]+/g, ' ');
    if (!flow.para && (s === '' || s === ' ')) return;
    const st = this.ensure(flow, ctx);
    if (st.lastSpace && s[0] === ' ') s = s.slice(1);
    if (!s) return;
    this.append(st, ctx, { kind: 'text', text: s });
    st.content = true;
    st.lastSpace = s.endsWith(' ');
    st.trailing = st.lastSpace;
  }

  private lineBreak(flow: Flow, ctx: Ctx): void {
    if (ctx.pre) {
      this.text(flow, ctx, '\n');
      return;
    }
    const st = this.ensure(flow, ctx);
    if (st.trailing) {
      trimEnd(st.p.children);
      // The trim may have removed the open run (or link) along with its last space.
      if (st.run && !st.run.content.length) st.run = null;
      if (st.hyperlink && !st.hyperlink.children.length) {
        st.hyperlink = null;
        st.linkEl = null;
        st.run = null;
      }
    }
    this.append(st, ctx, { kind: 'break' });
    st.hadBreak = true;
    st.lastSpace = true;
    st.trailing = false;
  }

  /** A <math> element as an equation. */
  private equation(flow: Flow, ctx: Ctx, el: HElement): void {
    const convert = (e: HElement): MathMLElement => ({
      name: e.name,
      attrs: e.attrs,
      children: e.children.flatMap((c): (MathMLElement | string)[] => (c.type === 'element' ? [convert(c)] : c.type === 'text' ? [c.text] : [])),
    });
    const st = this.ensure(flow, ctx);
    st.p.children.push(mathInline(fromMathML(convert(el))));
    st.run = null;
    st.hyperlink = null;
    st.linkEl = null;
    st.content = true;
    st.lastSpace = false;
    st.trailing = false;
  }

  private image(flow: Flow, ctx: Ctx, el: HElement): void {
    const st = this.ensure(flow, ctx);
    const alt = (el.attrs.alt ?? '').replace(/\s+/g, ' ').trim();
    const src = (el.attrs.src ?? '').trim();
    const picture = this.picture(src, el, alt);
    if (picture) {
      this.append(st, ctx, picture);
      st.content = true;
      st.lastSpace = false;
      st.trailing = false;
      return;
    }
    const run = newRun({ style: 'ImagePlaceholder' }, [{ kind: 'text', text: alt ? `[Image: ${alt}]` : '[Image]' }]);
    this.used.add('ImagePlaceholder');
    st.p.children.push({ kind: 'hyperlink', url: src, children: [run], attrs: {} });
    st.run = null;
    st.hyperlink = null;
    st.linkEl = null;
    st.content = true;
    st.lastSpace = false;
    st.trailing = false;
  }

  /** The picture an <img> shows, when its bytes are at hand (a data: URI, or what the caller supplies for the address). */
  private picture(src: string, el: HElement, alt: string): RunContent | null {
    let known = this.embedded.get(src);
    if (!known) {
      const bytes = decodeDataUri(src) ?? this.images?.(src) ?? null;
      const image = bytes ? sniffImage(bytes) : null;
      if (!image) return null;
      try {
        known = { part: this.doc.addImage(image.bytes, image.type), pixels: { w: image.width, h: image.height } };
      } catch {
        return null;
      }
      this.embedded.set(src, known);
    }
    const { part, pixels } = known;
    // Size: the element's width and height (pixels), one of them keeping the picture's shape, else its own size; never wider than the page.
    const attr = (name: string): number => {
      const v = Number.parseFloat(el.attrs[name] ?? '');
      return v > 0 ? v : 0;
    };
    let w = attr('width');
    let h = attr('height');
    const ratio = pixels.w > 0 && pixels.h > 0 ? pixels.w / pixels.h : 0;
    if (w && !h) h = ratio ? w / ratio : w;
    else if (h && !w) w = ratio ? h * ratio : h;
    else if (!w && !h) {
      w = pixels.w || 96;
      h = pixels.h || 96;
    }
    const most = 624; // 6.5 inches at 96 dpi
    if (w > most) {
      h = (h * most) / w;
      w = most;
    }
    return { kind: 'drawing', inline: true, width: Math.round(w * 9525), height: Math.round(h * 9525), image: part, ...(alt && { description: alt }) };
  }

  /** Keeps source HTML verbatim, anchored where it was. */
  private raw(flow: Flow, ctx: Ctx, html: string): void {
    const f: HtmlFragment = { html, anchor: null, place: 'before' };
    this.fragments.push(f);
    let st = flow.para;
    if (!st && flow.item && !flow.item.used) st = this.ensure(flow, ctx);
    if (st) {
      f.anchor = st.id;
      f.place = st.content || st.hadBreak ? 'end' : 'start';
      return;
    }
    flow.pending.push(f);
  }

  private rawElement(flow: Flow, ctx: Ctx, el: HElement): void {
    this.raw(flow, ctx, this.src.slice(el.start, el.end).trim());
  }

  // --- Elements ---

  /** The context for an element's content, with its CSS and presentational attributes applied. */
  private styled(el: HElement, ctx: Ctx, role: Role): { ctx: Ctx; para: ParagraphProperties; cell: TableCellProperties; attrs: HtmlAttributes } {
    const attrs: HtmlAttributes = { ...el.attrs };
    const c: Ctx = { ...ctx, run: { ...ctx.run } };
    const para: ParagraphProperties = {};
    const cell: TableCellProperties = {};
    if (role !== 'inline' && role !== 'group' && attrs.align !== undefined) {
      const align = parseAlign(attrs.align);
      if (align) {
        c.align = align;
        delete attrs.align;
      }
    }
    if (el.name === 'font') {
      if (attrs.color !== undefined) {
        const color = parseColor(attrs.color);
        if (color) c.run.color = { val: color };
      }
      if (attrs.face !== undefined) {
        const name = fontFamily(attrs.face);
        if (name) c.run.fonts = fontsOf(name);
      }
      const size = /^([+-]?)(\d)$/.exec((attrs.size ?? '').trim());
      if (size) {
        const n = size[1] === '+' ? 3 + Number(size[2]) : size[1] === '-' ? 3 - Number(size[2]) : Number(size[2]);
        c.run.size = FONT_TAG_SIZES[Math.max(1, Math.min(7, n)) - 1] * 2;
        c.run.sizeCs = c.run.size;
      }
    }
    if (role === 'cell') {
      if (attrs.bgcolor !== undefined) {
        const color = parseColor(attrs.bgcolor);
        if (color) cell.shading = shadingOf(color);
        if (color !== undefined) delete attrs.bgcolor;
      }
      const valign = own(VALIGN, (attrs.valign ?? '').toLowerCase());
      if (valign) {
        cell.vAlign = valign;
        delete attrs.valign;
      }
    }
    if (el.name === 'a' && attrs.href !== undefined) {
      delete c.run.color;
      delete c.run.underline;
    }
    switch (el.name) {
      case 'b':
      case 'strong':
        c.run.bold = true;
        break;
      case 'i':
      case 'em':
      case 'cite':
      case 'dfn':
      case 'var':
        c.run.italic = true;
        break;
      case 'u':
      case 'ins':
        c.run.underline = { val: 'single' };
        break;
      case 's':
      case 'strike':
      case 'del':
        c.run.strike = true;
        break;
      case 'sup':
        c.run.vertAlign = 'superscript';
        break;
      case 'sub':
        c.run.vertAlign = 'subscript';
        break;
      case 'mark':
        if (!isCommentMark(el)) c.run.highlight = 'yellow';
        break;
      case 'code':
      case 'kbd':
      case 'samp':
      case 'tt':
        c.code = true;
        break;
    }
    if (attrs.style !== undefined) {
      const leftover: [string, string][] = [];
      for (const [prop, value] of parseDecls(attrs.style)) {
        if (!this.css(prop, value, c, para, cell, role)) leftover.push([prop, value]);
      }
      if (leftover.length) attrs.style = formatDecls(leftover);
      else delete attrs.style;
    }
    if (c.run.size && c.run.size !== ctx.run.size) c.sizePt = c.run.size / 2;
    return { ctx: c, para, cell, attrs };
  }

  private css(prop: string, value: string, c: Ctx, para: ParagraphProperties, cell: TableCellProperties, role: Role): boolean {
    const v = value.toLowerCase();
    switch (prop) {
      case 'text-align': {
        if (role === 'inline') return false;
        const align = parseAlign(v);
        if (!align) return false;
        c.align = align;
        return true;
      }
      case 'white-space':
        if (role === 'group') return false;
        if (v === 'pre' || v === 'pre-wrap' || v === 'break-spaces') c.preserve = true;
        else if (v === 'normal') c.preserve = c.pre;
        else return false;
        return true;
      case 'background':
      case 'background-color': {
        const color = parseColor(value);
        if (color === undefined) return false;
        if (role === 'inline') {
          if (color) c.run.shading = shadingOf(color);
          else delete c.run.shading;
        } else if (role === 'para' || role === 'item') {
          if (color) para.shading = shadingOf(color);
        } else if (role === 'cell') {
          if (color) cell.shading = shadingOf(color);
        } else return false;
        return true;
      }
      case 'vertical-align':
        if (role === 'inline') {
          if (v === 'super') c.run.vertAlign = 'superscript';
          else if (v === 'sub') c.run.vertAlign = 'subscript';
          else if (v === 'baseline') c.run.vertAlign = 'baseline';
          else return false;
          return true;
        }
        const valign = own(VALIGN, v);
        if (role === 'cell' && valign) {
          cell.vAlign = valign;
          return true;
        }
        return false;
    }
    if (role === 'para' || role === 'item') {
      if (paraCss(para, prop, value)) return true;
    }
    return runCss(c.run, prop, value, c.sizePt);
  }

  /** A paragraph style named by the generated style block among the element's classes (removed from them). */
  private classStyle(attrs: HtmlAttributes): string | undefined {
    if (!this.classStyles.size || attrs.class === undefined) return undefined;
    const classes = attrs.class.split(/\s+/).filter(Boolean);
    const found = classes.find((c) => this.classStyles.has(c));
    if (!found) return undefined;
    const rest = classes.filter((c) => c !== found);
    if (rest.length) attrs.class = rest.join(' ');
    else delete attrs.class;
    return found;
  }

  private visit(node: HNode, flow: Flow, ctx: Ctx): void {
    if (node.type === 'text') {
      this.text(flow, ctx, node.text);
      return;
    }
    if (node.type === 'comment') {
      this.raw(flow, ctx, this.src.slice(node.start, node.end));
      return;
    }
    const el = node;
    const name = el.name;
    if (name === 'br') this.lineBreak(flow, ctx);
    else if (name === 'wbr' || name === 'col' || name === 'colgroup') return;
    else if (name === 'img') this.image(flow, ctx, el);
    else if (name === 'math') this.equation(flow, ctx, el);
    else if (name === 'hr') this.rule(flow, ctx, el);
    else if (INLINE.has(name)) this.inline(el, flow, ctx);
    else if (PARAGRAPHS.has(name)) this.paragraph(el, flow, ctx);
    else if (CONTAINERS.has(name)) this.container(el, flow, ctx);
    else if (name === 'blockquote') this.quote(el, flow, ctx);
    else if (PRE_TAGS.has(name)) this.pre(el, flow, ctx);
    else if (LISTS.has(name)) this.list(el, flow, ctx);
    else if (name === 'li') this.item(el, flow, ctx);
    else if (name === 'table') this.table(el, flow, ctx);
    else if (TABLE_PARTS.has(name)) this.container(el, flow, ctx);
    else if (TRANSPARENT.has(name) || name.includes(':')) for (const child of el.children) this.visit(child, flow, ctx);
    else this.rawElement(flow, ctx, el);
  }

  private inline(el: HElement, flow: Flow, ctx: Ctx): void {
    const { ctx: c } = this.styled(el, ctx, 'inline');
    if (isCommentMark(el)) {
      this.commentMark(el, flow, c);
      return;
    }
    if (el.name === 'a' && el.attrs.href !== undefined) {
      const href = el.attrs.href.trim();
      c.link = href.length > 1 && href[0] === '#' ? { el, anchor: href.slice(1) } : { el, url: href };
    }
    if (el.name === 'q') this.text(flow, c, '“');
    for (const child of el.children) this.visit(child, flow, c);
    if (el.name === 'q') this.text(flow, c, '”');
  }

  /** Puts a comment marker in the paragraph, as text would go (the next text starts a new run). */
  private commentMarkers(flow: Flow, ctx: Ctx, markers: Inline[]): void {
    const st = this.ensure(flow, ctx);
    st.p.children.push(...markers);
    st.run = null;
    st.hyperlink = null;
    st.linkEl = null;
    st.content = true;
  }

  /** The id a comment written as `original` has in the document, made on first mention. */
  private commentId(original: string): string {
    let id = this.commentIds.get(original);
    if (id === undefined) {
      id = String(this.commentIds.size);
      this.commentIds.set(original, id);
    }
    return id;
  }

  /** A <mark class="comment">: the comment it makes, and markers around its content. */
  private commentMark(el: HElement, flow: Flow, ctx: Ctx): void {
    const a = el.attrs;
    const original = a['data-comment-id'] ?? `#${this.commentIds.size}`;
    // A comment repeated by an id already seen (its range split by a tool) is just its content.
    if (this.commentDone.has(original)) {
      for (const child of el.children) this.visit(child, flow, ctx);
      return;
    }
    this.commentDone.add(original);
    const id = this.commentId(original);
    const text = a['data-comment'] ?? a.title ?? '';
    const comment: Comment = { id, author: a['data-author'] ?? '', paragraphs: text.split(/\r\n?|\n/) };
    if (a['data-initials']) comment.initials = a['data-initials'];
    if (a['data-date']) comment.date = a['data-date'];
    if (a['data-parent'] !== undefined && a['data-parent'] !== original) comment.parentId = this.commentId(a['data-parent']);
    if (a['data-resolved'] !== undefined && a['data-resolved'] !== 'false') comment.resolved = true;
    this.doc.comments.push(comment);
    this.commentMarkers(flow, ctx, [commentStart(id)]);
    for (const child of el.children) this.visit(child, flow, ctx);
    this.commentMarkers(flow, ctx, [commentEnd(id), commentReference(id)]);
  }

  private paragraph(el: HElement, flow: Flow, ctx: Ctx): void {
    if (rawOnly(el)) {
      this.rawElement(flow, ctx, el);
      return;
    }
    this.close(flow);
    const { ctx: c, para, attrs } = this.styled(el, ctx, 'para');
    const heading = isHeadingTag(el.name) ? Number(el.name[1]) : 0;
    if (heading) c.heading = heading;
    c.flowLevel = false;
    const inline = (!!flow.item && !flow.item.used && !ctx.pre) || (flow.cell && !flow.blocks.length);
    const tag = inline || (el.name !== 'p' && !heading) ? el.name : undefined;
    const style = this.classStyle(attrs);
    if (style) para.style = style;
    this.open(flow, c, para, tag, attrs, true);
    for (const child of el.children) this.visit(child, flow, c);
    this.close(flow);
  }

  private rule(flow: Flow, ctx: Ctx, el: HElement): void {
    const { ctx: c, para, attrs } = this.styled(el, ctx, 'para');
    const st = this.open(flow, c, { ...para, borders: { bottom: { ...RULE_BORDER } } }, undefined, attrs, true);
    st.keep = true;
    this.close(flow);
  }

  private container(el: HElement, flow: Flow, ctx: Ctx): void {
    if (rawOnly(el)) {
      this.rawElement(flow, ctx, el);
      return;
    }
    if (!hasBlock(el) && !TABLE_PARTS.has(el.name)) {
      this.paragraph(el, flow, ctx);
      return;
    }
    const { ctx: c, attrs } = this.styled(el, ctx, 'container');
    if (el.name === 'center') c.align = 'center';
    this.close(flow);
    let wrapper: HtmlWrapper | null = null;
    const start = flow.blocks.length;
    if (ctx.flowLevel && !TABLE_PARTS.has(el.name)) {
      wrapper = { tag: el.name, attrs, first: '', last: '' };
      if (flow.lastKey !== null) this.resolveAfter(flow);
      this.wrappers.push(wrapper);
    }
    for (const child of el.children) this.visit(child, flow, c);
    this.close(flow);
    if (!wrapper) return;
    if (flow.lastKey !== null && flow.blocks.length > start) this.resolveAfter(flow);
    if (flow.blocks.length > start) {
      wrapper.first = anchorOf(flow.blocks[start]);
      wrapper.last = anchorOf(flow.blocks[flow.blocks.length - 1]);
      this.wrapperEnds.set(wrapper.last, (this.wrapperEnds.get(wrapper.last) ?? 0) + 1);
    } else this.wrappers.splice(this.wrappers.indexOf(wrapper), 1);
  }

  private quote(el: HElement, flow: Flow, ctx: Ctx): void {
    if (rawOnly(el)) {
      this.rawElement(flow, ctx, el);
      return;
    }
    this.close(flow);
    const { ctx: c, attrs } = this.styled(el, ctx, 'container');
    c.quote = ctx.quote + 1;
    c.flowLevel = false;
    const groups = flow.groups.length;
    if (hasKeys(attrs)) flow.groups.push(['quote', attrs]);
    for (const child of el.children) this.visit(child, flow, c);
    this.close(flow);
    flow.groups.length = Math.min(flow.groups.length, groups);
  }

  private pre(el: HElement, flow: Flow, ctx: Ctx): void {
    if (rawOnly(el)) {
      this.rawElement(flow, ctx, el);
      return;
    }
    this.close(flow);
    const { ctx: c, attrs } = this.styled(el, ctx, 'container');
    c.pre = true;
    c.preserve = true;
    c.flowLevel = false;
    const groups = flow.groups.length;
    if (hasKeys(attrs)) flow.groups.push(['pre', attrs]);
    const significant = el.children.filter((n) => n.type !== 'text' || n.text.trim() !== '');
    const code = significant.length === 1 && significant[0].type === 'element' && significant[0].name === 'code' ? significant[0] : null;
    if (code) flow.groups.push(['code', { ...code.attrs }]);
    this.open(flow, c, {});
    for (const child of code ? code.children : el.children) this.visit(child, flow, c);
    const st = flow.para;
    if (st && st.fromNewline && !st.content && !this.fragments.some((f) => f.anchor === st.id)) this.discard(flow, st);
    this.close(flow);
    flow.groups.length = Math.min(flow.groups.length, groups);
  }

  /** A numbering definition for one list, every level of one kind; returns the numId. */
  private newList(format: string, start: number, level: number): number {
    const levels: NumberingLevel[] = [];
    const bullet = format === 'bullet';
    for (let l = 0; l < 9; l++) {
      levels.push({
        level: l,
        start: l === level ? start : 1,
        format,
        suffix: 'tab',
        text: bullet ? BULLETS[l % 3] : `%${l + 1}.`,
        justification: 'left',
        paragraphProperties: { indent: { left: 720 * (l + 1), hanging: 360 } },
        attrs: {},
      });
    }
    const abstractId = this.nextAbstract++;
    const id = this.nextInstance++;
    this.doc.numbering.abstracts.push({ id: abstractId, multiLevelType: 'hybridMultilevel', levels, attrs: {} });
    this.doc.numbering.instances.push({ id, abstractId, overrides: [], attrs: {} });
    return id;
  }

  private list(el: HElement, flow: Flow, ctx: Ctx): void {
    if (rawOnly(el)) {
      this.rawElement(flow, ctx, el);
      return;
    }
    this.close(flow);
    // A nested list before any text of its item: the item still gets its (empty) paragraph first.
    if (flow.item && !flow.item.used) {
      this.ensure(flow, ctx);
      this.close(flow);
    }
    const { ctx: c, attrs } = this.styled(el, ctx, 'container');
    const ordered = el.name === 'ol';
    let format = ordered ? 'decimal' : 'bullet';
    let start = 1;
    if (ordered) {
      const type = attrs.type?.trim();
      const typeFormat = type === undefined ? undefined : own(TYPE_FORMATS, type);
      if (typeFormat) {
        format = typeFormat;
        delete attrs.type;
      }
      if (attrs.start !== undefined && /^\s*-?\d+\s*$/.test(attrs.start)) {
        start = Math.max(0, parseInt(attrs.start, 10));
        delete attrs.start;
      }
    }
    const level = Math.min(ctx.level, 8);
    c.list = { numId: this.newList(format, start, level), level };
    c.level = ctx.level + 1;
    c.flowLevel = false;
    const groups = flow.groups.length;
    if (hasKeys(attrs)) flow.groups.push(['list', attrs]);
    for (const child of el.children) this.visit(child, flow, c);
    this.close(flow);
    flow.groups.length = Math.min(flow.groups.length, groups);
  }

  private item(el: HElement, flow: Flow, ctx: Ctx): void {
    this.close(flow);
    const list = ctx.list ?? { numId: this.newList('bullet', 1, Math.min(ctx.level, 8)), level: Math.min(ctx.level, 8) };
    const { ctx: c, para, attrs } = this.styled(el, ctx, 'item');
    const style = this.classStyle(attrs);
    const previous = flow.item;
    const item: Item = { numId: list.numId, level: list.level, para, used: false };
    if (hasKeys(attrs)) item.attrs = attrs;
    if (style) item.style = style;
    flow.item = item;
    c.item = list.level + 1;
    c.level = Math.max(c.level, list.level + 1);
    c.heading = 0;
    c.quote = 0;
    c.flowLevel = false;
    for (const child of el.children) this.visit(child, flow, c);
    this.close(flow);
    if (!item.used) {
      this.ensure(flow, c);
      this.close(flow);
    }
    flow.item = previous;
  }

  // --- Tables ---

  private table(el: HElement, flow: Flow, ctx: Ctx): void {
    if (rawOnly(el)) {
      this.rawElement(flow, ctx, el);
      return;
    }
    this.close(flow);
    const { ctx: tctx, attrs } = this.styled(el, ctx, 'group');
    interface RowSource {
      el: HElement | null;
      header: boolean;
      cells: HElement[];
    }
    const rows: RowSource[] = [];
    let caption = '';
    let implicit: RowSource | null = null;
    const collect = (parent: HElement, header: boolean, isTable: boolean): void => {
      for (const child of parent.children) {
        if (child.type === 'text') {
          if (/\S/.test(child.text)) this.text(flow, ctx, child.text);
          continue;
        }
        if (child.type === 'comment') {
          this.raw(flow, ctx, this.src.slice(child.start, child.end));
          continue;
        }
        const name = child.name;
        if (name === 'tr') {
          implicit = null;
          rows.push({ el: child, header, cells: child.children.filter((c): c is HElement => c.type === 'element' && (c.name === 'td' || c.name === 'th')) });
        } else if (name === 'td' || name === 'th') {
          if (!implicit) {
            implicit = { el: null, header, cells: [] };
            rows.push(implicit);
          }
          implicit.cells.push(child);
        } else if (isTable && (name === 'thead' || name === 'tbody' || name === 'tfoot')) {
          implicit = null;
          collect(child, name === 'thead', false);
          implicit = null;
        } else if (isTable && name === 'caption') caption = textContent(child).replace(/\s+/g, ' ').trim();
        else if (name === 'colgroup' || name === 'col') continue;
        else this.visit(child, flow, ctx);
      }
    };
    collect(el, false, true);
    this.close(flow);
    if (!rows.some((r) => r.cells.length)) {
      this.rawElement(flow, ctx, el);
      return;
    }
    if (!rows.some((r) => r.header)) {
      for (const r of rows) {
        if (r.cells.length && r.cells.every((c) => c.name === 'th')) r.header = true;
        else break;
      }
    }

    const occupied: Map<number, number>[] = rows.map(() => new Map());
    const out: TableRow[] = [];
    const spans: number[] = [];
    const widths: [TableCell, number][] = [];
    let cols = 1;
    rows.forEach((r, ri) => {
      const rowStyled = r.el ? this.styled(r.el, tctx, 'group') : { ctx: tctx, attrs: {} as HtmlAttributes };
      const cells: TableCell[] = [];
      const occ = occupied[ri];
      let col = 0;
      const fill = (): void => {
        while (occ.has(col)) {
          const span = occ.get(col)!;
          const merged = this.mergedCell(span);
          cells.push(merged);
          widths.push([merged, span]);
          col += span;
        }
      };
      for (const cellEl of r.cells) {
        fill();
        const colspan = clampInt(cellEl.attrs.colspan, 1, 1, 1000);
        let rowspan = clampInt(cellEl.attrs.rowspan, 1, 0, 65534);
        if (rowspan === 0) rowspan = rows.length - ri;
        rowspan = Math.min(rowspan, rows.length - ri);
        const cell = this.cell(cellEl, rowStyled.ctx, r.header, colspan, rowspan > 1);
        cells.push(cell);
        widths.push([cell, colspan]);
        for (let k = 1; k < rowspan; k++) occupied[ri + k].set(col, colspan);
        col += colspan;
      }
      const lastOccupied = Math.max(-1, ...occ.keys());
      while (col <= lastOccupied) {
        if (occ.has(col)) fill();
        else {
          const empty = this.mergedCell(1);
          delete empty.properties.vMerge;
          cells.push(empty);
          widths.push([empty, 1]);
          col++;
        }
      }
      cols = Math.max(cols, col);
      const row: TableRow = { kind: 'row', properties: r.header ? { header: true } : {}, cells, attrs: {} };
      out.push(row);
      if (hasKeys(rowStyled.attrs)) {
        const first = firstParagraph(cells[0]?.children ?? []);
        if (first) this.entry(idOf(first)).row = rowStyled.attrs;
      }
      spans.push(col);
    });
    out.forEach((row, r) => {
      if (spans[r] < cols) row.properties.gridAfter = cols - spans[r];
    });
    const width = Math.floor(PAGE_TEXT_WIDTH / cols);
    for (const [cell, span] of widths) cell.properties.width = { w: String(width * span), type: 'dxa' };
    const table: Table = {
      kind: 'table',
      properties: { style: 'TableGrid', width: { w: '0', type: 'auto' }, look: { val: '0420', firstRow: true, noVBand: true } },
      grid: new Array<number>(cols).fill(width),
      rows: out,
    };
    if (caption) table.properties.caption = caption;
    this.used.add('TableGrid');
    this.addBlock(flow, table);
    const first = firstParagraph([table]);
    if (first && hasKeys(attrs)) this.entry(idOf(first)).table = attrs;
  }

  private mergedCell(span: number): TableCell {
    const properties: TableCellProperties = { vMerge: 'continue' };
    if (span > 1) properties.gridSpan = span;
    return { kind: 'cell', properties, children: [this.paragraphWithId({})], attrs: {} };
  }

  private cell(el: HElement, ctx: Ctx, header: boolean, colspan: number, restart: boolean): TableCell {
    const { ctx: c, cell: properties, attrs } = this.styled(el, ctx, 'cell');
    delete attrs.colspan;
    delete attrs.rowspan;
    const cctx: Ctx = { ...c, heading: 0, quote: 0, level: 0, item: 0, list: null, pre: false, link: null, flowLevel: true };
    const flow = new Flow(true);
    for (const child of el.children) this.visit(child, flow, cctx);
    this.close(flow);
    if (!flow.blocks.length) {
      this.ensure(flow, cctx);
      this.close(flow);
    }
    this.end(flow);
    const first = firstParagraph(flow.blocks);
    if (first) {
      const id = idOf(first);
      if (hasKeys(attrs)) this.entry(id).cell = attrs;
      if (el.name === 'th' && !header) this.entry(id).th = true;
    }
    if (colspan > 1) properties.gridSpan = colspan;
    if (restart) properties.vMerge = 'restart';
    if (header && !properties.shading) properties.shading = shadingOf(HEADER_FILL);
    return { kind: 'cell', properties, children: flow.blocks, attrs: {} };
  }

  // --- Styles ---

  /** Reads the generated style block back into the document's styles. */
  private wordStyles(css: string): void {
    const styles = this.doc.styles;
    const find = (id: string): Style => {
      let style = styles.styles.find((s) => s.id === id && s.type === 'paragraph');
      if (!style) {
        style = styleFor(id) ?? { type: 'paragraph', id, name: id, basedOn: 'Normal', attrs: {} };
        styles.styles.push(style);
      }
      return style;
    };
    for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, '').split('}')) {
      const brace = rule.indexOf('{');
      if (brace < 0) continue;
      const selector = rule.slice(0, brace).trim().replace(/\s+/g, ' ');
      const decls = parseDecls(rule.slice(brace + 1));
      const run: RunProperties = {};
      const para: ParagraphProperties = {};
      for (const [prop, value] of decls) {
        if (prop === 'text-align') {
          const align = parseAlign(value);
          if (align) para.justification = align;
        } else if (prop === 'background-color') {
          const color = parseColor(value);
          if (color) para.shading = shadingOf(color);
        } else if (!paraCss(para, prop, value)) runCss(run, prop, value, 12);
      }
      let id: string | undefined;
      if (selector === 'body') {
        const defaults = (styles.defaultRunProperties ??= {});
        for (const key of RUN_CSS_KEYS) delete defaults[key];
        Object.assign(defaults, run);
        styles.hasRunDefaults = true;
        continue;
      }
      if (selector === 'p') id = styles.styles.find((s) => s.type === 'paragraph' && s.isDefault)?.id ?? 'Normal';
      else if (/^h[1-6]$/.test(selector)) id = `Heading${selector[1]}`;
      else if (selector === 'blockquote p') id = 'Quote';
      else if (selector === 'pre') id = 'Code';
      else {
        const m = /^\.([A-Za-z_][\w-]*)$/.exec(selector);
        if (!m) continue;
        id = m[1];
        this.classStyles.add(id);
      }
      const style = find(id);
      const pp = { ...style.paragraphProperties };
      for (const key of PARA_CSS_KEYS) delete pp[key];
      style.paragraphProperties = { ...pp, ...para };
      if (selector !== 'p') {
        const rp = { ...style.runProperties };
        for (const key of RUN_CSS_KEYS) delete rp[key];
        style.runProperties = { ...rp, ...run };
      }
    }
  }

  private install(): void {
    const have = new Set(this.doc.styles.styles.map((s) => s.id));
    for (const id of this.used) {
      if (have.has(id)) continue;
      const style = styleFor(id);
      if (style) this.doc.styles.styles.push(style);
    }
  }
}

const VALIGN: Record<string, 'top' | 'center' | 'bottom'> = { top: 'top', middle: 'center', center: 'center', bottom: 'bottom' };

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !/^\s*\d+/.test(value)) return fallback;
  return Math.max(min, Math.min(max, parseInt(value, 10)));
}

function textContentRaw(el: HElement): string {
  return el.children.map((c) => (c.type === 'text' ? c.text : '')).join('');
}

/** Supplies the bytes of a picture by the address in its <img>; null when they aren't available. */
export type ImageSource = (src: string) => Uint8Array | null;

/**
 * Parses HTML into a new document plus what only HTML can express (see the header comment).
 * Every paragraph gets a w14:paraId. Never throws: whatever can't be mapped is kept verbatim.
 */
export async function htmlToDocument(source: string, images?: ImageSource): Promise<{ document: WordDocument; extension: HtmlExtension }> {
  try {
    const document = await WordDocument.create();
    const extension = new Importer(document, parseHtml(source), images).run();
    return { document, extension };
  } catch {
    // Safety net: the text without tags, one paragraph per line.
    const document = await WordDocument.create();
    const lines = decode(source.replace(/<[^>]*>/g, ''), false).split(/\r\n?|\n/);
    document.body = lines.map((line, i) => {
      const p = newParagraph({}, line ? [newRun({}, [{ kind: 'text', text: line }])] : []);
      p.attrs[ID] = formatId(i + 1);
      return p;
    });
    return { document, extension: {} };
  }
}

// --- Export -----------------------------------------------------------------------------------------

type Kind = { kind: 'heading'; level: number } | { kind: 'quote' } | { kind: 'code' } | { kind: 'normal' };

interface Mark {
  key: string;
  open: string;
  close: string;
}

interface Atom {
  t: 'text' | 'br' | 'tab' | 'html';
  s: string;
  marks: Mark[];
  link: { href: string } | null;
  /** The comments (ids, outermost first) whose range this is in. */
  cm?: readonly string[];
}

interface OpenList {
  numId: number;
  level: number;
  ordered: boolean;
  tag: string;
  ind: string;
  liOpen: boolean;
  liLine: number;
  /** Something was written inside the open <li> on lines of its own. */
  nested: boolean;
}

/** Where one block list (the body, a cell, a wrapper's content) is in its output. */
interface Level {
  ind: string;
  lists: OpenList[];
  quotes: number;
  quoteInd: string;
  pre: { ind: string; open: string; close: string; lines: string[]; after: string[] } | null;
  wrappers: { wrapper: HtmlWrapper; ind: string }[];
}

const CODE_STYLES = new Set(['code', 'sourcecode', 'htmlpreformatted', 'codeblock', 'preformattedtext', 'htmlcode', 'codechar', 'inlinecode']);
const QUOTE_STYLES = new Set(['quote', 'intensequote', 'blocktext', 'blockquote']);
const CONVENTION_STYLES = new Set(['Heading1', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6', 'Quote', 'Code', 'ListParagraph']);
const CONVENTION_CHAR = new Set(['Hyperlink', 'InlineCode', 'ImagePlaceholder']);
const MONO_RE = /courier|consolas|mono|menlo|monaco|source code|lucida console/i;
const SERIF_RE = /times|georgia|cambria|garamond|palatino|book antiqua|baskerville|minion|constantia|century|serif/i;
const TAB_HTML = '<span style="white-space: pre">\t</span>';
const HIGHLIGHTS: Record<string, string> = {
  yellow: 'FFFF00', green: '00FF00', cyan: '00FFFF', magenta: 'FF00FF', blue: '0000FF', red: 'FF0000', darkBlue: '000080',
  darkCyan: '008080', darkGreen: '008000', darkMagenta: '800080', darkRed: '800000', darkYellow: '808000',
  darkGray: '808080', lightGray: 'C0C0C0', black: '000000', white: 'FFFFFF',
};
const TYPE_ATTRS: Record<string, string> = { lowerLetter: 'a', upperLetter: 'A', lowerRoman: 'i', upperRoman: 'I' };

const escText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;');
const escAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function attrString(attrs: HtmlAttributes | undefined): string {
  if (!attrs) return '';
  let out = '';
  for (const [name, value] of Object.entries(attrs)) {
    if (!/^[^\s"'>/=]+$/.test(name)) continue;
    out += value === '' ? ` ${name}` : ` ${name}="${escAttr(value)}"`;
  }
  return out;
}

const hex = (color: string | undefined): string | undefined => (color && /^[0-9A-Fa-f]{6}$/.test(color) ? `#${color.toUpperCase()}` : undefined);

function cssFont(name: string): string {
  // Quotes, backslashes and angle brackets can't be in the name: in the <style> block, "</style>" would end it.
  const quoted = /^[A-Za-z][A-Za-z-]*$/.test(name) ? name : `"${name.replace(/["\\<>\r\n]/g, '')}"`;
  const generic = MONO_RE.test(name) ? 'monospace' : /sans/i.test(name) ? 'sans-serif' : SERIF_RE.test(name) ? 'serif' : 'sans-serif';
  return `${quoted}, ${generic}`;
}

function cssAlign(justification: string | undefined): string | undefined {
  switch (justification) {
    case 'both':
    case 'distribute':
      return 'justify';
    case 'center':
      return 'center';
    case 'right':
    case 'end':
      return 'right';
    case 'left':
    case 'start':
      return 'left';
  }
  return undefined;
}

function lineHeight(spacing: ParagraphProperties['spacing']): string | undefined {
  if (!spacing?.line) return undefined;
  if (!spacing.lineRule || spacing.lineRule === 'auto') return String(round(spacing.line / 240, 3));
  return pt(spacing.line);
}

const underlined = (r: RunProperties): boolean => !!r.underline?.val && r.underline.val !== 'none';
const struck = (r: RunProperties): boolean => !!(r.strike || r.doubleStrike);

class Writer {
  private readonly resolver: StyleResolver;
  private readonly info: Record<string, HtmlBlock>;
  private readonly fragments = new Map<string, HtmlFragment[]>();
  private readonly wrapperStarts = new Map<string, HtmlWrapper[]>();
  private readonly opened = new Set<HtmlWrapper>();
  private readonly usedStyles = new Set<string>();
  private readonly counts = new Map<string, number[]>();
  private readonly kinds = new Map<string | undefined, Kind>();
  private readonly marksCache = new Map<string, Mark[]>();
  private readonly normalId: string | undefined;
  private usedInlineCode = false;
  private readonly comments: Map<string, Comment>;

  constructor(
    readonly doc: WordDocument,
    readonly ext: HtmlExtension | undefined,
    private readonly options: HtmlWriteOptions = {},
  ) {
    this.resolver = new StyleResolver(doc.styles, doc.theme, doc.numbering);
    this.comments = new Map(doc.comments.map((c) => [c.id, c]));
    this.info = ext?.blocks ?? {};
    for (const f of ext?.fragments ?? []) {
      const key = f.anchor ?? '';
      const list = this.fragments.get(key);
      if (list) list.push(f);
      else this.fragments.set(key, [f]);
    }
    for (const w of ext?.wrappers ?? []) {
      if (!w.first) continue;
      const list = this.wrapperStarts.get(w.first);
      if (list) list.push(w);
      else this.wrapperStarts.set(w.first, [w]);
    }
    this.normalId = this.resolver.chain(undefined, 'paragraph').at(-1)?.id;
  }

  write(): string {
    const body: string[] = [];
    for (const f of this.fragments.get('') ?? []) body.push(f.html);
    this.blocks(this.doc.body, '', body);
    const ext = this.ext;
    const head: string[] = [];
    if (ext?.head !== undefined) head.push(ext.head);
    else {
      head.push('<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">', `<title>${escText(this.title())}</title>`);
    }
    if (!ext || ext.wordStyles) head.push(...this.styleBlock());
    let htmlAttrs = ext?.htmlAttrs;
    if (!ext) {
      const lang = this.doc.styles.defaultRunProperties?.lang?.val;
      if (lang) htmlAttrs = { lang };
    }
    return [
      ext?.doctype ?? '<!DOCTYPE html>',
      `<html${attrString(htmlAttrs)}>`,
      '<head>',
      ...head,
      '</head>',
      `<body${attrString(ext?.bodyAttrs)}>`,
      ...body,
      '</body>',
      '</html>',
      '',
    ].join('\n');
  }

  private title(): string {
    let fallback = '';
    for (const block of this.doc.body) {
      if (block.kind !== 'paragraph') continue;
      const text = paragraphText(block).replace(/\uFFFC/g, '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (this.classify(block).kind === 'heading') return text.slice(0, 120);
      if (!fallback) fallback = text.slice(0, 120);
    }
    return fallback || t('app.defaultTitle');
  }

  // --- Classification ---

  private classify(p: Paragraph): Kind {
    let kind = this.kinds.get(p.properties.style);
    if (!kind) {
      const chain = this.resolver.chain(p.properties.style, 'paragraph');
      for (let i = chain.length - 1; i >= 0 && !kind; i--) {
        const id = chain[i].id.toLowerCase().replace(/\s+/g, '');
        const name = (chain[i].name ?? '').toLowerCase().replace(/\s+/g, '');
        const heading = /^heading([1-6])$/.exec(id) ?? /^heading([1-6])$/.exec(name);
        if (heading) kind = { kind: 'heading', level: Number(heading[1]) };
        else if (id === 'title' || name === 'title') kind = { kind: 'heading', level: 1 };
        else if (QUOTE_STYLES.has(id) || QUOTE_STYLES.has(name)) kind = { kind: 'quote' };
        else if (CODE_STYLES.has(id) || CODE_STYLES.has(name)) kind = { kind: 'code' };
      }
      if (!kind) {
        const outline = this.resolver.paragraph({ style: p.properties.style }).outlineLevel;
        kind = outline !== undefined && outline >= 0 && outline <= 5 ? { kind: 'heading', level: outline + 1 } : { kind: 'normal' };
      }
      this.kinds.set(p.properties.style, kind);
    }
    const direct = p.properties.outlineLevel;
    if (kind.kind === 'normal' && direct !== undefined && direct >= 0 && direct <= 5) return { kind: 'heading', level: direct + 1 };
    return kind;
  }

  /** The class naming the paragraph's style, when it isn't one the tags already say. */
  private styleClass(p: Paragraph): string | undefined {
    const id = p.properties.style;
    if (!id || id === this.normalId || CONVENTION_STYLES.has(id)) return undefined;
    const style = this.resolver.style(id);
    if (!style || style.type !== 'paragraph' || !/^[A-Za-z_][\w-]*$/.test(id)) return undefined;
    this.usedStyles.add(id);
    return id;
  }

  private chainHas(p: Paragraph, id: string): boolean {
    return this.resolver.chain(p.properties.style, 'paragraph').some((s) => s.id.toLowerCase() === id);
  }

  /** The list level a paragraph is an item of, or undefined. */
  private listLevel(p: Paragraph, kind: Kind): { numId: number; level: number; def: NumberingLevel } | undefined {
    if (kind.kind === 'heading' || kind.kind === 'code') return undefined;
    const numbering = this.resolver.paragraph(p.properties).numbering;
    const numId = numbering?.id;
    if (!numId) return undefined;
    const level = Math.min(Math.max(numbering?.level ?? 0, 0), 8);
    const def = this.resolver.listLevel(numId, level);
    if (!def || def.format === 'none') return undefined;
    return { numId, level, def };
  }

  private isRule(p: Paragraph): boolean {
    if (p.children.length) return false;
    const bottom = this.resolver.paragraph(p.properties).borders?.bottom;
    return !!bottom?.val && bottom.val !== 'none' && bottom.val !== 'nil';
  }

  /** The list item number, counted the way Word does (instances of one definition share counters). */
  private count(numId: number, level: number, def: NumberingLevel): number {
    const instance = this.doc.numbering.instances.find((n) => n.id === numId);
    const restarts = !instance || instance.overrides.some((o) => o.startOverride !== undefined);
    const key = restarts ? `num:${numId}` : `abstract:${instance.abstractId}`;
    let counts = this.counts.get(key);
    if (!counts) this.counts.set(key, (counts = new Array<number>(9).fill(0)));
    counts[level] = counts[level] === 0 ? (def.start ?? 1) : counts[level] + 1;
    for (let l = level + 1; l < 9; l++) counts[l] = 0;
    return counts[level];
  }

  // --- CSS from properties ---

  /** Direct paragraph formatting as declarations. */
  private paraDecls(pp: ParagraphProperties, indent: boolean, align: boolean): [string, string][] {
    const decls: [string, string][] = [];
    const a = align ? cssAlign(pp.justification) : undefined;
    if (a) decls.push(['text-align', a]);
    if (pp.spacing?.before !== undefined) decls.push(['margin-top', pt(pp.spacing.before)]);
    if (pp.spacing?.after !== undefined) decls.push(['margin-bottom', pt(pp.spacing.after)]);
    if (indent && pp.indent) {
      const left = pp.indent.left ?? pp.indent.start;
      const right = pp.indent.right ?? pp.indent.end;
      if (left !== undefined) decls.push(['margin-left', pt(left)]);
      if (right !== undefined) decls.push(['margin-right', pt(right)]);
      if (pp.indent.hanging) decls.push(['text-indent', pt(-pp.indent.hanging)]);
      else if (pp.indent.firstLine !== undefined) decls.push(['text-indent', pt(pp.indent.firstLine)]);
    }
    const lh = lineHeight(pp.spacing);
    if (lh) decls.push(['line-height', lh]);
    const fill = hex(pp.shading?.fill);
    if (fill) decls.push(['background-color', fill]);
    if (pp.pageBreakBefore) decls.push(['break-before', 'page']);
    return decls;
  }

  /** A paragraph style's whole resolved formatting, for its rule in the style block. */
  private styleDecls(id: string | undefined, indent: boolean): string[] {
    const pp = this.resolver.paragraph({ style: id });
    const rp = this.resolver.run(id, {});
    const decls: string[] = [];
    const font = this.resolver.font(rp.fonts);
    if (font) decls.push(`font-family: ${cssFont(font)}`);
    if (rp.size) decls.push(`font-size: ${rp.size / 2}pt`);
    const color = hex(rp.color?.val);
    if (color) decls.push(`color: ${color}`);
    decls.push(`font-weight: ${rp.bold ? 'bold' : 'normal'}`, `font-style: ${rp.italic ? 'italic' : 'normal'}`);
    const decoration = [underlined(rp) ? 'underline' : '', struck(rp) ? 'line-through' : ''].filter(Boolean).join(' ');
    if (decoration) decls.push(`text-decoration: ${decoration}`);
    if (rp.caps) decls.push('text-transform: uppercase');
    if (rp.smallCaps) decls.push('font-variant: small-caps');
    const fill = hex(pp.shading?.fill);
    if (fill) decls.push(`background-color: ${fill}`);
    decls.push(...this.boxDecls(pp, indent));
    return decls;
  }

  private boxDecls(pp: ParagraphProperties, indent: boolean): string[] {
    const decls: string[] = [];
    const left = indent ? (pp.indent?.left ?? pp.indent?.start ?? 0) : 0;
    const right = indent ? (pp.indent?.right ?? pp.indent?.end ?? 0) : 0;
    decls.push(`margin: ${pt(pp.spacing?.before ?? 0)} ${pt(right)} ${pt(pp.spacing?.after ?? 0)} ${pt(left)}`);
    if (indent && pp.indent?.hanging) decls.push(`text-indent: ${pt(-pp.indent.hanging)}`);
    else if (indent && pp.indent?.firstLine) decls.push(`text-indent: ${pt(pp.indent.firstLine)}`);
    const lh = lineHeight(pp.spacing);
    if (lh) decls.push(`line-height: ${lh}`);
    const align = cssAlign(pp.justification);
    if (align) decls.push(`text-align: ${align}`);
    return decls;
  }

  private styleBlock(): string[] {
    const rules: string[] = [];
    const rule = (selector: string, decls: string[]): void => {
      if (decls.length) rules.push(`  ${selector} { ${decls.join('; ')}; }`);
    };
    const normal = this.normalId;
    const body = this.resolver.run(normal, {});
    const bodyDecls: string[] = [];
    const font = this.resolver.font(body.fonts);
    if (font) bodyDecls.push(`font-family: ${cssFont(font)}`);
    if (body.size) bodyDecls.push(`font-size: ${body.size / 2}pt`);
    const color = hex(body.color?.val);
    if (color) bodyDecls.push(`color: ${color}`);
    rule('body', bodyDecls);
    rule('p', this.boxDecls(this.resolver.paragraph({ style: normal }), true));
    for (let level = 1; level <= 6; level++) if (this.usedStyles.has(`Heading${level}`)) rule(`h${level}`, this.styleDecls(`Heading${level}`, true));
    if (this.usedStyles.has('Quote')) rule('blockquote p', this.styleDecls('Quote', true));
    if (this.usedStyles.has('Code')) rule('pre', this.styleDecls('Code', true));
    for (const id of this.usedStyles) {
      if (id === normal || CONVENTION_STYLES.has(id) || this.resolver.style(id)?.type !== 'paragraph' || !/^[A-Za-z_][\w-]*$/.test(id)) continue;
      const numbered = !!this.resolver.paragraph({ style: id }).numbering?.id;
      rule(`.${id}`, this.styleDecls(id, !numbered));
    }
    if (this.usedInlineCode) {
      const code = this.resolver.run(normal, { style: 'InlineCode' });
      const decls = ['font-family: ' + cssFont(this.resolver.font(code.fonts) ?? MONO)];
      const fill = hex(code.shading?.fill);
      if (fill) decls.push(`background-color: ${fill}`);
      rule('code', decls);
    }
    rules.push(
      '  blockquote { margin: 0; }',
      '  blockquote blockquote { margin-left: 36pt; }',
      '  table { border-collapse: collapse; }',
      '  th, td { border: 1px solid #000000; padding: 0 5.4pt; vertical-align: top; text-align: left; }',
      `  th { background-color: #${HEADER_FILL}; }`,
    );
    return [`<style ${STYLE_MARK}>`, ...rules, '</style>'];
  }

  // --- Inline content ---

  private marks(pStyle: string | undefined, props: RunProperties): Mark[] {
    const cacheKey = `${pStyle ?? ''}\u0000${JSON.stringify(props)}`;
    const cached = this.marksCache.get(cacheKey);
    if (cached) return cached;
    const eff = this.resolver.run(pStyle, props);
    const base = this.resolver.run(pStyle, props.style && CONVENTION_CHAR.has(props.style) ? { style: props.style } : {});
    const code = !!props.style && this.resolver.chain(props.style, 'character').some((s) => CODE_STYLES.has(s.id.toLowerCase()));
    if (code) this.usedInlineCode = true;
    const decls: string[] = [];
    const font = this.resolver.font(eff.fonts);
    if (!code && font && font !== this.resolver.font(base.fonts)) decls.push(`font-family: ${cssFont(font)}`);
    if (eff.size && eff.size !== base.size) decls.push(`font-size: ${eff.size / 2}pt`);
    const color = hex(eff.color?.val);
    if (color && color !== hex(base.color?.val)) decls.push(`color: ${color}`);
    const highlight = eff.highlight && eff.highlight !== 'none' && eff.highlight !== 'yellow' ? own(HIGHLIGHTS, eff.highlight) : undefined;
    const fill = hex(eff.shading?.fill);
    if (highlight && eff.highlight !== base.highlight) decls.push(`background-color: #${highlight}`);
    else if (!highlight && fill && fill !== hex(base.shading?.fill)) decls.push(`background-color: ${fill}`);
    if (base.bold && !eff.bold) decls.push('font-weight: normal');
    if (base.italic && !eff.italic) decls.push('font-style: normal');
    if ((underlined(base) && !underlined(eff)) || (struck(base) && !struck(eff))) decls.push('text-decoration: none');
    if (eff.caps && !base.caps) decls.push('text-transform: uppercase');
    else if (base.caps && !eff.caps) decls.push('text-transform: none');
    if (eff.smallCaps && !base.smallCaps) decls.push('font-variant: small-caps');
    if (base.vertAlign && base.vertAlign !== 'baseline' && eff.vertAlign !== base.vertAlign && (!eff.vertAlign || eff.vertAlign === 'baseline')) {
      decls.push('vertical-align: baseline');
    }
    const marks: Mark[] = [];
    const tag = (name: string): Mark => ({ key: name, open: `<${name}>`, close: `</${name}>` });
    if (decls.length) {
      const style = decls.join('; ');
      marks.push({ key: `span:${style}`, open: `<span style="${escAttr(style)}">`, close: '</span>' });
    }
    if (eff.bold && !base.bold) marks.push(tag('strong'));
    if (eff.italic && !base.italic) marks.push(tag('em'));
    if (underlined(eff) && !underlined(base)) marks.push(tag('u'));
    if (struck(eff) && !struck(base)) marks.push(tag('s'));
    if (eff.vertAlign !== base.vertAlign) {
      if (eff.vertAlign === 'superscript') marks.push(tag('sup'));
      else if (eff.vertAlign === 'subscript') marks.push(tag('sub'));
    }
    if (eff.highlight === 'yellow' && base.highlight !== 'yellow') marks.push(tag('mark'));
    if (code) marks.push(tag('code'));
    this.marksCache.set(cacheKey, marks);
    return marks;
  }

  /** `<img>` for a hyperlink made from an image placeholder, else null. */
  private imagePlaceholder(h: Hyperlink): string | null {
    if (h.url === undefined || !h.children.length) return null;
    let text = '';
    for (const c of h.children) {
      if (c.kind !== 'run' || c.properties.style !== 'ImagePlaceholder') return null;
      for (const item of c.content) if (item.kind === 'text') text += item.text;
    }
    const m = /^\[Image(?:: ([\s\S]*))?\]$/.exec(text);
    if (!m) return null;
    return `<img src="${escAttr(h.url)}" alt="${escAttr(m[1] ?? '')}">`;
  }

  /** The opening tag of a comment's <mark>. */
  private commentOpen(c: Comment): string {
    const text = c.paragraphs.join('\n');
    const attr = (name: string, value: string | undefined): string => (value ? ` ${name}="${escAttr(value).replace(/\r?\n/g, '&#10;')}"` : '');
    return (
      `<mark class="comment" data-comment-id="${escAttr(c.id)}"` +
      attr('data-author', c.author) +
      attr('data-initials', c.initials) +
      attr('data-date', c.date) +
      attr('data-parent', c.parentId) +
      (c.resolved ? ' data-resolved="true"' : '') +
      ` data-comment="${escAttr(text).replace(/\r?\n/g, '&#10;')}"` +
      attr('title', c.author ? `${c.author}: ${text}` : text) +
      '>'
    );
  }

  /** A paragraph's content as HTML. Outside <pre>, spaces HTML would collapse become &nbsp;. */
  private inline(p: Paragraph, pre: boolean): { html: string; empty: boolean; endsWithBreak: boolean } {
    const pStyle = p.properties.style;
    const atoms: Atom[] = [];
    const tracker = new RangeTracker((id) => this.comments.has(id));
    const commentless = this.comments.size === 0;
    const add = (atom: Atom): void => {
      if (tracker.ids.length) atom.cm = tracker.ids;
      atoms.push(atom);
    };
    const walk = (list: readonly Inline[], link: { href: string } | null): void => {
      for (const inline of list) {
        if (inline.kind === 'run') {
          const marks = this.marks(pStyle, inline.properties);
          for (const item of inline.content) {
            switch (item.kind) {
              case 'text':
                for (const part of item.text.split(/(\t)/)) {
                  if (part) add({ t: part === '\t' ? 'tab' : 'text', s: part, marks, link });
                }
                break;
              case 'tab':
                add({ t: 'tab', s: '\t', marks, link });
                break;
              case 'break':
                if (!item.type || item.type === 'textWrapping') add({ t: 'br', s: '', marks, link });
                break;
              case 'cr':
                add({ t: 'br', s: '', marks, link });
                break;
              case 'noBreakHyphen':
                add({ t: 'text', s: '\u2011', marks, link });
                break;
              case 'softHyphen':
                add({ t: 'text', s: '\u00ad', marks, link });
                break;
              case 'drawing': {
                const picture = item.image ? this.options.images?.get(item.image) : undefined;
                // Without the picture's bytes, the name it had in the package is all there is to point at.
                const name = picture ? (this.options.imageSrc?.(item.image!, picture) ?? toDataUri(picture)) : item.image ? item.image.slice(item.image.lastIndexOf('/') + 1) : '';
                const size = item.width && item.height ? ` width="${Math.round(item.width / 9525)}" height="${Math.round(item.height / 9525)}"` : '';
                add({ t: 'html', s: `<img src="${escAttr(name)}" alt="${escAttr(item.description || item.name || '')}"${size}>`, marks: [], link: null });
                break;
              }
              default:
                break;
            }
          }
        } else if (inline.kind === 'hyperlink') {
          const img = this.imagePlaceholder(inline);
          if (img !== null) add({ t: 'html', s: img, marks: [], link: null });
          else {
            const href = inline.url ?? (inline.anchor !== undefined ? `#${inline.anchor}` : undefined);
            walk(inline.children, href !== undefined ? { href } : link);
          }
        } else if (inline.kind === 'wrapper') walk(inline.children, link);
        else if (!commentless && commentMarker(inline)) {
          const point = tracker.marker(commentMarker(inline)!, atoms.length);
          if (point !== null) add({ t: 'html', s: `${this.commentOpen(this.comments.get(point)!)}</mark>`, marks: [], link: null });
        } else if (isMathInline(inline)) add({ t: 'html', s: toMathML(readMathInline(inline)), marks: [], link: null });
      }
    };
    walk(p.children, null);
    if (!pre) fixSpaces(atoms);

    let html = '';
    const open: Mark[] = [];
    let link: { href: string } | null = null;
    const openComments: string[] = [];
    const closeTo = (keep: number): void => {
      while (open.length > keep) html += open.pop()!.close;
    };
    for (const a of atoms) {
      const cm = a.cm ?? [];
      if (cm.length !== openComments.length || cm.some((id, i) => id !== openComments[i])) {
        // A comment's mark is outside the marks and link inside it, so they close and open again around its edges.
        closeTo(0);
        if (link) html += '</a>';
        link = null;
        let k = 0;
        while (k < openComments.length && k < cm.length && openComments[k] === cm[k]) k++;
        while (openComments.length > k) {
          openComments.pop();
          html += '</mark>';
        }
        for (const id of cm.slice(k)) {
          html += this.commentOpen(this.comments.get(id)!);
          openComments.push(id);
        }
      }
      if (a.link !== link) {
        closeTo(0);
        if (link) html += '</a>';
        link = a.link;
        if (link) html += `<a href="${escAttr(link.href)}">`;
      }
      if (a.t === 'html') {
        closeTo(0);
        html += a.s;
        continue;
      }
      let k = 0;
      while (k < open.length && k < a.marks.length && open[k].key === a.marks[k].key) k++;
      closeTo(k);
      for (const m of a.marks.slice(k)) {
        html += m.open;
        open.push(m);
      }
      if (a.t === 'text') html += escText(pre ? a.s : a.s.replace(/[\r\n]/g, ' '));
      else if (a.t === 'br') html += '<br>';
      else html += pre ? '\t' : TAB_HTML;
    }
    closeTo(0);
    if (link) html += '</a>';
    html += '</mark>'.repeat(openComments.length);
    const last = atoms[atoms.length - 1];
    return { html, empty: !atoms.length, endsWithBreak: last?.t === 'br' };
  }

  private frags(key: string, place: HtmlFragment['place'], outside = 0): string[] {
    if (!key) return [];
    return (this.fragments.get(key) ?? []).filter((f) => f.place === place && (f.outside ?? 0) === outside).map((f) => f.html);
  }

  /** A paragraph's element content: fragments at its start and end, the text, a <br> where one is needed. */
  private content(p: Paragraph, blankLine: boolean, empty: boolean): string {
    const id = idOf(p);
    const { html, empty: noText, endsWithBreak } = this.inline(p, false);
    let body = html;
    if (endsWithBreak) body += '<br>';
    else if (noText && blankLine && !empty) body = '<br>';
    return this.frags(id, 'start').join('') + body + this.frags(id, 'end').join('');
  }

  /** Attributes for a paragraph's element: the extension's, its style class, its direct formatting. */
  private paraAttrs(p: Paragraph, attrs: HtmlAttributes | undefined, indent: boolean, align = true, extraDecls: [string, string][] = []): string {
    const map: HtmlAttributes = { ...attrs };
    const cls = this.styleClass(p);
    if (cls) map.class = map.class ? `${cls} ${map.class}` : cls;
    const decls = [...extraDecls, ...this.paraDecls(p.properties, indent, align)];
    if (decls.length) map.style = map.style ? `${formatDecls(decls)}; ${map.style}` : formatDecls(decls);
    return attrString(map);
  }

  // --- Blocks ---

  private blocks(list: readonly Block[], ind: string, out: string[]): void {
    const flat: Block[] = [];
    const flatten = (blocks: readonly Block[]): void => {
      for (const b of blocks) {
        if (b.kind === 'wrapper') flatten(b.children);
        else if (b.kind !== 'raw') flat.push(b);
      }
    };
    flatten(list);
    const lv: Level = { ind, lists: [], quotes: 0, quoteInd: ind, pre: null, wrappers: [] };
    for (let i = 0; i < flat.length; i++) {
      const block = flat[i];
      const key = anchorOf(block);
      for (const w of (key && this.wrapperStarts.get(key)) || []) {
        if (this.opened.has(w)) continue;
        this.opened.add(w);
        this.closeGroups(lv, out);
        out.push(`${lv.ind}<${w.tag}${attrString(w.attrs)}>`);
        lv.wrappers.push({ wrapper: w, ind: lv.ind });
        lv.ind += '  ';
        lv.quoteInd = lv.ind;
      }
      if (block.kind === 'table') {
        this.closeGroups(lv, out);
        for (const html of this.frags(key, 'before')) out.push(lv.ind + html);
        this.table(block, lv.ind, out);
        for (const html of this.frags(key, 'after')) out.push(lv.ind + html);
      } else if (block.kind === 'paragraph') this.paragraph(block, flat[i + 1], lv, out);
      const closing = key ? lv.wrappers.findIndex((w) => w.wrapper.last === key) : -1;
      if (closing >= 0) {
        this.closeGroups(lv, out);
        let closed = 0;
        while (lv.wrappers.length > closing) {
          const w = lv.wrappers.pop()!;
          lv.ind = w.ind;
          out.push(`${lv.ind}</${w.wrapper.tag}>`);
          for (const html of this.frags(key, 'after', ++closed)) out.push(lv.ind + html);
        }
        lv.quoteInd = lv.ind;
      }
    }
    this.closeGroups(lv, out);
    while (lv.wrappers.length) {
      const w = lv.wrappers.pop()!;
      out.push(`${w.ind}</${w.wrapper.tag}>`);
    }
  }

  private closeGroups(lv: Level, out: string[]): void {
    this.closePre(lv, out);
    while (lv.lists.length) this.closeList(lv, out);
    this.closeQuotes(lv, 0, out);
  }

  private closePre(lv: Level, out: string[]): void {
    const pre = lv.pre;
    if (!pre) return;
    lv.pre = null;
    out.push(pre.ind + pre.open + pre.lines.join('\n') + pre.close);
    for (const html of pre.after) out.push(pre.ind + html);
  }

  private closeQuotes(lv: Level, depth: number, out: string[]): void {
    while (lv.quotes > depth) {
      lv.quotes--;
      out.push(`${lv.quoteInd}${'  '.repeat(lv.quotes)}</blockquote>`);
    }
  }

  private closeLi(list: OpenList, out: string[]): void {
    if (!list.liOpen) return;
    if (list.nested) out.push(`${list.ind}  </li>`);
    else out[list.liLine] += '</li>';
    list.liOpen = false;
  }

  private closeList(lv: Level, out: string[]): void {
    const list = lv.lists.pop();
    if (!list) return;
    this.closeLi(list, out);
    out.push(`${list.ind}</${list.tag}>`);
  }

  private paragraph(p: Paragraph, next: Block | undefined, lv: Level, out: string[]): void {
    const id = idOf(p);
    const info = (id && this.info[id]) || {};
    const kind = this.classify(p);
    if (p.properties.style) this.usedStyles.add(p.properties.style);

    if (kind.kind === 'code') {
      while (lv.lists.length) this.closeList(lv, out);
      this.closeQuotes(lv, 0, out);
      let pre = lv.pre;
      let lead = '';
      if (!pre) {
        for (const html of this.frags(id, 'before')) out.push(lv.ind + html);
        const open = `<pre${attrString(info.pre)}>` + (info.code ? `<code${attrString(info.code)}>` : '');
        pre = lv.pre = { ind: lv.ind, open, close: (info.code ? '</code>' : '') + '</pre>', lines: [], after: [] };
      } else lead = this.frags(id, 'before').join('');
      pre.lines.push(lead + this.frags(id, 'start').join('') + this.inline(p, true).html + this.frags(id, 'end').join(''));
      // Fragments after a line can't go inside the <pre>: they follow it.
      pre.after.push(...this.frags(id, 'after'));
      return;
    }
    this.closePre(lv, out);

    if (this.isRule(p)) {
      this.closeGroups(lv, out);
      for (const html of this.frags(id, 'before')) out.push(lv.ind + html);
      out.push(`${lv.ind}<hr${attrString(info.attrs)}>`);
      for (const html of this.frags(id, 'after')) out.push(lv.ind + html);
      return;
    }

    const item = this.listLevel(p, kind);
    if (item) {
      this.closeQuotes(lv, 0, out);
      this.listItem(p, next, item, info, lv, out);
      return;
    }
    if (kind.kind !== 'heading' && lv.lists.length && this.chainHas(p, 'listparagraph')) {
      const list = lv.lists[lv.lists.length - 1];
      const inner = `${list.ind}    `;
      for (const html of this.frags(id, 'before')) out.push(inner + html);
      const tag = info.tag ?? 'p';
      out.push(`${inner}<${tag}${this.paraAttrs(p, info.attrs, false)}>${this.content(p, true, !!info.empty)}</${tag}>`);
      for (const html of this.frags(id, 'after')) out.push(inner + html);
      list.nested = true;
      return;
    }
    while (lv.lists.length) this.closeList(lv, out);

    let ind = lv.ind;
    if (kind.kind === 'quote') {
      const depth = Math.min(8, 1 + Math.max(0, Math.round((p.properties.indent?.left ?? 0) / 720)));
      if (info.quote && lv.quotes) this.closeQuotes(lv, 0, out);
      this.closeQuotes(lv, depth, out);
      let first = true;
      while (lv.quotes < depth) {
        out.push(`${lv.quoteInd}${'  '.repeat(lv.quotes)}<blockquote${attrString(first ? info.quote : undefined)}>`);
        first = false;
        lv.quotes++;
      }
      ind = lv.quoteInd + '  '.repeat(lv.quotes);
    } else this.closeQuotes(lv, 0, out);

    const tag = kind.kind === 'heading' ? `h${kind.level}` : (info.tag ?? 'p');
    const indent = kind.kind !== 'quote';
    for (const html of this.frags(id, 'before')) out.push(ind + html);
    out.push(`${ind}<${tag}${this.paraAttrs(p, info.attrs, indent)}>${this.content(p, true, !!info.empty)}</${tag}>`);
    for (const html of this.frags(id, 'after')) out.push(ind + html);
  }

  private listItem(
    p: Paragraph,
    next: Block | undefined,
    { numId, level, def }: { numId: number; level: number; def: NumberingLevel },
    info: HtmlBlock,
    lv: Level,
    out: string[],
  ): void {
    const id = idOf(p);
    const ordered = def.format !== 'bullet';
    const lists = lv.lists;
    while (lists.length && lists[lists.length - 1].level > level) this.closeList(lv, out);
    let top = lists[lists.length - 1];
    if (top && top.level === level && (top.numId !== numId || top.ordered !== ordered || info.list)) {
      this.closeList(lv, out);
      top = lists[lists.length - 1];
    }
    const number = this.count(numId, level, def);
    if (!top || top.level < level) {
      const listInd = top ? `${top.ind}    ` : lv.ind;
      if (top) top.nested = true;
      const tag = ordered ? 'ol' : 'ul';
      const attrs: HtmlAttributes = {};
      if (ordered) {
        const type = own(TYPE_ATTRS, def.format ?? '');
        if (type) attrs.type = type;
        if (number !== 1) attrs.start = String(number);
      }
      for (const [k, v] of Object.entries(info.list ?? {})) if (!(ordered && (k === 'type' || k === 'start'))) attrs[k] = v;
      out.push(`${listInd}<${tag}${attrString(attrs)}>`);
      top = { numId, level, ordered, tag, ind: listInd, liOpen: false, liLine: -1, nested: false };
      lists.push(top);
    } else this.closeLi(top, out);

    for (const html of this.frags(id, 'before')) out.push(`${top.ind}  ${html}`);
    const wrap = info.tag ?? (this.continues(next) ? 'p' : undefined);
    const content = this.content(p, false, true);
    let line: string;
    if (wrap) line = `<li${attrString(info.item)}><${wrap}${this.paraAttrs(p, info.attrs, false)}>${content}</${wrap}>`;
    else line = `<li${this.paraAttrs(p, { ...info.item, ...info.attrs }, false)}>${content}`;
    out.push(`${top.ind}  ${line}`);
    top.liOpen = true;
    top.liLine = out.length - 1;
    top.nested = false;
    const after = this.frags(id, 'after');
    if (after.length) {
      for (const html of after) out.push(`${top.ind}    ${html}`);
      top.nested = true;
    }
  }

  /** Whether a block is a further paragraph of the list item before it. */
  private continues(block: Block | undefined): boolean {
    if (!block || block.kind !== 'paragraph') return false;
    const kind = this.classify(block);
    if (kind.kind === 'heading' || kind.kind === 'code' || this.listLevel(block, kind) || this.isRule(block)) return false;
    return this.chainHas(block, 'listparagraph');
  }

  private table(t: Table, ind: string, out: string[]): void {
    const first = firstParagraph([t]);
    const info = first ? this.info[idOf(first)] : undefined;
    out.push(`${ind}<table${attrString(info?.table)}>`);
    if (t.properties.caption) out.push(`${ind}  <caption>${escText(t.properties.caption)}</caption>`);
    const rows = t.rows.filter((r): r is TableRow => r.kind === 'row');
    const layout = rows.map((row) => {
      let col = row.properties.gridBefore ?? 0;
      return row.cells
        .filter((c): c is TableCell => c.kind === 'cell')
        .map((cell) => {
          const span = Math.max(1, cell.properties.gridSpan ?? 1);
          const entry = { cell, col, span };
          col += span;
          return entry;
        });
    });
    let headerRows = 0;
    while (headerRows < rows.length && rows[headerRows].properties.header) headerRows++;
    const sectionInd = headerRows ? `${ind}  ` : ind;
    rows.forEach((_, r) => {
      if (headerRows && r === 0) out.push(`${ind}  <thead>`);
      if (headerRows && r === headerRows) out.push(`${ind}  <tbody>`);
      const header = r < headerRows;
      const rowFirst = firstParagraph(layout[r][0]?.cell.children ?? []);
      out.push(`${sectionInd}  <tr${attrString(rowFirst ? this.info[idOf(rowFirst)]?.row : undefined)}>`);
      for (const { cell, col, span } of layout[r]) {
        if (cell.properties.vMerge === 'continue') continue;
        let rowspan = 1;
        if (cell.properties.vMerge === 'restart') {
          for (let r2 = r + 1; r2 < rows.length; r2++) {
            const below = layout[r2].find((e) => e.col === col);
            if (below?.cell.properties.vMerge !== 'continue') break;
            rowspan++;
          }
        }
        this.cell(cell, header, span, rowspan, `${sectionInd}    `, out);
      }
      out.push(`${sectionInd}  </tr>`);
      if (headerRows && r === headerRows - 1) out.push(`${ind}  </thead>`);
    });
    if (headerRows && rows.length > headerRows) out.push(`${ind}  </tbody>`);
    out.push(`${ind}</table>`);
  }

  private cell(cell: TableCell, header: boolean, span: number, rowspan: number, ind: string, out: string[]): void {
    const first = firstParagraph(cell.children);
    const info = first ? this.info[idOf(first)] : undefined;
    const tag = header || info?.th ? 'th' : 'td';
    const attrs: HtmlAttributes = {};
    if (span > 1) attrs.colspan = String(span);
    if (rowspan > 1) attrs.rowspan = String(rowspan);
    Object.assign(attrs, info?.cell);
    const decls: [string, string][] = [];
    const fill = hex(cell.properties.shading?.fill);
    if (fill && !(tag === 'th' && fill === `#${HEADER_FILL}`)) decls.push(['background-color', fill]);
    const valign = cell.properties.vAlign;
    if (valign === 'center' || valign === 'bottom') decls.push(['vertical-align', valign === 'center' ? 'middle' : 'bottom']);
    const blocks = cell.children.filter((b) => b.kind !== 'raw');
    const only = blocks.length === 1 && blocks[0].kind === 'paragraph' ? blocks[0] : undefined;
    if (only && this.inlineCell(only)) {
      const a = cssAlign(only.properties.justification);
      if (a) decls.unshift(['text-align', a]);
      if (decls.length) attrs.style = attrs.style ? `${formatDecls(decls)}; ${attrs.style}` : formatDecls(decls);
      const id = idOf(only);
      const content = this.frags(id, 'before').join('') + this.content(only, false, true) + this.frags(id, 'after').join('');
      out.push(`${ind}<${tag}${attrString(attrs)}>${content}</${tag}>`);
      return;
    }
    if (decls.length) attrs.style = attrs.style ? `${formatDecls(decls)}; ${attrs.style}` : formatDecls(decls);
    out.push(`${ind}<${tag}${attrString(attrs)}>`);
    this.blocks(cell.children, `${ind}  `, out);
    out.push(`${ind}</${tag}>`);
  }

  /** Whether a cell's only paragraph can be written as the cell's bare content. */
  private inlineCell(p: Paragraph): boolean {
    const info = this.info[idOf(p)];
    if (info?.tag || info?.attrs || info?.empty) return false;
    const kind = this.classify(p);
    if (kind.kind !== 'normal' || this.listLevel(p, kind) || this.isRule(p) || this.styleClass(p)) return false;
    return this.paraDecls(p.properties, true, false).length === 0;
  }
}

/** Makes spaces HTML would collapse or trim visible: doubled spaces and spaces at line ends become &nbsp;. */
function fixSpaces(atoms: Atom[]): void {
  let prevSpace = true;
  let last: Atom | null = null;
  const endLine = (): void => {
    if (last && last.s.endsWith(' ')) last.s = `${last.s.slice(0, -1)}\u00a0`;
    last = null;
  };
  for (const a of atoms) {
    if (a.t === 'text') {
      let s = '';
      for (const ch of a.s.replace(/[\r\n]/g, ' ')) {
        if (ch === ' ') {
          s += prevSpace ? '\u00a0' : ' ';
          prevSpace = !prevSpace;
        } else {
          s += ch;
          prevSpace = false;
        }
      }
      a.s = s;
      if (s) last = a;
    } else if (a.t === 'br') {
      endLine();
      prevSpace = true;
    } else {
      prevSpace = false;
      last = null;
    }
  }
  endLine();
}

export interface HtmlWriteOptions {
  /** The document's pictures by package part (see collectImages); without them, pictures are not written. */
  images?: Map<string, ImageData>;
  /** The address to write for a picture; by default the picture is embedded as a data: URI. */
  imageSrc?: (part: string, image: ImageData) => string;
}

/**
 * Writes the document as a complete HTML5 page: headings, paragraphs, lists (nested ul/ol from
 * the numbering), block quotes, preformatted blocks, tables, links, images and inline formatting
 * (tags for bold/italic/underline/strike/super/sub/code/mark, inline CSS for fonts and colours).
 * With the HTML extension from `htmlToDocument`, the head, html/body attributes, block tags and
 * attributes, wrapper containers and verbatim fragments come back for the paragraphs still there.
 */

export function documentToHtml(document: WordDocument, extension?: HtmlExtension, options: HtmlWriteOptions = {}): string {
  return new Writer(document, extension, options).write();
}
