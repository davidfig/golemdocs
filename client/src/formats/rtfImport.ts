// Rich Text Format -> document model. RTF is a stream of groups ({...}), control words (\b, \fs24)
// and text. This reads what word processors write for ordinary documents: character formatting
// (bold, italic, underline, strike, super/subscript, size, font, color, highlight), paragraph
// formatting (alignment, indents, spacing, headings, lists), tables, hyperlinks, page breaks,
// pictures (PNG and JPEG) and page setup. Anything else (headers, footers, shapes, text boxes,
// fields other than links) is skipped, keeping the text of a field's result. Annotations (Word's
// comments) become comments in the shared model, with their range markers in the text.

import { WordDocument, commentEnd, commentReference, commentRanges, commentStart, insertInlines, paragraphsIn } from '@word/docx';
import type {
  Block,
  Comment,
  Inline,
  Paragraph,
  ParagraphProperties,
  Run,
  RunContent,
  RunProperties,
  Table,
  TableCell,
  TableRow,
} from '@word/docx';
import { styleFor } from './markdownStyles.ts';
import { dttmToIso } from './commentRanges.ts';
import { t } from '../i18n/index.ts';

/** Destinations whose content is never body text. */
const SKIPPED = new Set([
  'info', 'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf', 'footnote', 'shp', 'shpinst', 'shptxt',
  'object', 'themedata', 'datastore', 'colorschememapping', 'latentstyles', 'rsidtbl', 'generator', 'xmlnstbl', 'filetbl', 'revtbl',
  'private', 'fchars', 'lchars', 'pgptbl', 'template', 'listtext', 'pntext', 'pntxta', 'pntxtb', 'bkmkstart', 'bkmkend', 'nonshppict', 'stylesheet',
  'operator', 'title', 'author', 'company', 'comment', 'panose', 'falt', 'fname', 'leveltext', 'levelnumbers', 'protusertbl', 'wgrffmtfilter',
]);

/** Destinations of an annotation: its range markers, author, id and the annotation itself. */
const ANNOTATION_WORDS = new Set(['annotation', 'atrfstart', 'atrfend', 'atnid', 'atnauthor', 'atnref', 'atndate', 'atnparent', 'atnicn']);

export const HIGHLIGHTS:[string, number, number, number][] = [
  ['black', 0, 0, 0], ['blue', 0, 0, 255], ['cyan', 0, 255, 255], ['green', 0, 255, 0], ['magenta', 255, 0, 255], ['red', 255, 0, 0],
  ['yellow', 255, 255, 0], ['white', 255, 255, 255], ['darkBlue', 0, 0, 128], ['darkCyan', 0, 128, 128], ['darkGreen', 0, 128, 0],
  ['darkMagenta', 128, 0, 128], ['darkRed', 128, 0, 0], ['darkYellow', 128, 128, 0], ['darkGray', 128, 128, 128], ['lightGray', 192, 192, 192],
];

/** The control words that change how the text after them looks. */
const CHARACTER_WORDS = new Set([
  'plain', 'b', 'i', 'ul', 'uld', 'uldb', 'ulw', 'ulth', 'ulwave', 'uldash', 'uldashd', 'ulhwave', 'ulldash', 'ulnone', 'strike', 'striked',
  'super', 'sub', 'nosupersub', 'caps', 'scaps', 'v', 'fs', 'f', 'cf', 'highlight', 'chcbpat',
]);

const LIST_FORMATS: Record<number, string> = { 0: 'decimal', 1: 'upperRoman', 2: 'lowerRoman', 3: 'upperLetter', 4: 'lowerLetter', 22: 'decimalZero', 23: 'bullet', 255: 'none' };
const PN_FORMATS: Record<string, string> = { pndec: 'decimal', pnucrm: 'upperRoman', pnlcrm: 'lowerRoman', pnucltr: 'upperLetter', pnlcltr: 'lowerLetter', pnlvlblt: 'bullet' };

/** Code pages whose TextDecoder label isn't "windows-" and the number. */
const CODE_PAGE_LABELS: Record<number, string> = { 65001: 'utf-8', 10000: 'macintosh', 932: 'shift_jis', 936: 'gbk', 950: 'big5', 949: 'euc-kr', 54936: 'gb18030', 866: 'ibm866' };

/** Windows code pages by number, as TextDecoder labels. */
function decoderFor(codePage: number): TextDecoder {
  try {
    return new TextDecoder(CODE_PAGE_LABELS[codePage] ?? `windows-${codePage}`);
  } catch {
    return new TextDecoder('windows-1252');
  }
}

interface CharState {
  bold: boolean;
  italic: boolean;
  underline: string | null;
  strike: boolean;
  doubleStrike: boolean;
  vertAlign: 'baseline' | 'superscript' | 'subscript';
  caps: boolean;
  smallCaps: boolean;
  hidden: boolean;
  size: number;
  font: number;
  color: number;
  highlight: number;
}

interface ParaState {
  align: string | undefined;
  left: number;
  right: number;
  first: number;
  before: number;
  after: number;
  line: number;
  lineMult: boolean;
  keepNext: boolean;
  keepLines: boolean;
  pageBefore: boolean;
  style: number | undefined;
  outline: number | undefined;
  list: number | undefined;
  level: number;
  inTable: boolean;
}

type Destination = 'body' | 'skip' | 'fonttbl' | 'colortbl' | 'stylesheet' | 'listtable' | 'listoverride' | 'fldinst' | 'fldrslt' | 'pict' | 'pn' | 'annotation' | 'atnfield';

interface Frame {
  dest: Destination;
  char: CharState;
  para: ParaState;
  /** Bytes of \uN skipped after a Unicode escape (\ucN). */
  uc: number;
  /** Set on an \fldrslt that replaces a hyperlink: its runs are wrapped when the group closes. */
  link?: { url?: string; anchor?: string; runs: Inline[] };
  /** The link of an enclosing \fldrslt: runs in a group nested inside the result (as our own writer makes) join it too. */
  inLink?: { url?: string; anchor?: string; runs: Inline[] };
}

interface Picture {
  format: string | null;
  hex: string;
  width: number;
  height: number;
  goalW: number;
  goalH: number;
  scaleX: number;
  scaleY: number;
}

interface CellDef {
  right: number;
  merge: 'first' | 'continue' | null;
  fill: number | null;
}

export async function rtfToDocument(bytes: Uint8Array): Promise<WordDocument> {
  const doc = await WordDocument.create();
  new RtfReader(doc, latin1(bytes)).read();
  return doc;
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}

const newRun = (properties: RunProperties, content: RunContent[]): Run => ({ kind: 'run', properties, content, attrs: {} });

/** Groups nested deeper than this share their parent's state (real files nest a few dozen deep at most). */
const MAX_GROUP_DEPTH = 1000;

class RtfReader {
  private pos = 0;
  private stack: Frame[] = [];
  private frame!: Frame;
  /** Groups opened past MAX_GROUP_DEPTH, not yet closed. */
  private tooDeep = 0;
  private decoder = decoderFor(1252);
  private pendingBytes: number[] = [];
  private skipChars = 0;

  private defaultFont = 0;
  private defaultSize = 24;
  private readonly fonts = new Map<number, string>();
  private readonly colors: (string | null)[] = [];
  private colorParts: [number, number, number] | null = null;
  private fontName = '';
  private fontIndex = 0;
  private styleNames = new Map<number, string>();
  private styleIndex = -1;
  private styleName = '';

  // Lists: \listtable definitions and \listoverride numbers, then plain \pn lists.
  private readonly lists = new Map<number, { levels: { format: string; start: number }[] }>();
  private currentList: { levels: { format: string; start: number }[] } | null = null;
  private currentListId = 0;
  private overrideListId = 0;
  private readonly overrides = new Map<number, number>();
  private usedOverrides = new Set<number>();
  /** The kind of list an old-style \pn description gives the next paragraph. */
  private pnKind: string | null = null;
  private pnList: { format: string; id: number; last: number } | null = null;
  private paragraphs = 0;
  private nextAbstract = 1;
  private nextInstance = 1000;

  private fldinst = '';
  /** Set by \trhdr: the row being read repeats as a header. */
  private rowHeader = false;
  private pict: Picture | null = null;

  private readonly body: Block[] = [];
  private inlines: Inline[] = [];
  private text = '';
  private paragraphOpen = false;
  private rowCells: (TableCell | null)[] = [];
  /** The row's last cell that isn't a merged continuation (what a \clmrg cell widens). */
  private rowLastCell: TableCell | null = null;
  private cellBlocks: Block[] = [];
  private rowDefs: CellDef[] = [];
  private pendingDef: CellDef = { right: 0, merge: null, fill: null };
  private tableRows: TableRow[] = [];
  private tableGrid: number[] = [];

  private used = new Set<string>();

  // Annotations: RTF ids (atnref / atrfstart) to model ids, and the comment being read.
  private readonly comments: Comment[] = [];
  private readonly commentIds = new Map<string, string>();
  private readonly rangeStarted = new Set<string>();
  private readonly rangeEnded = new Set<string>();
  private pendingInitials = '';
  private pendingAuthor = '';
  private atnField: { name: string; text: string } | null = null;
  private annotation: { depth: number; paragraphs: string[]; current: string; ref: string; date?: string; parent: string } | null = null;
  /** Replies that gave no range: they get their parent's, once the body is read. */
  private readonly repliesToPlace: { comment: Comment; parentKey: string }[] = [];

  constructor(
    private readonly doc: WordDocument,
    private readonly src: string,
  ) {}

  read(): void {
    const src = this.src;
    const n = src.length;
    this.frame = {
      dest: 'body',
      char: { bold: false, italic: false, underline: null, strike: false, doubleStrike: false, vertAlign: 'baseline', caps: false, smallCaps: false, hidden: false, size: 24, font: 0, color: 0, highlight: 0 },
      para: this.plainPara(),
      uc: 1,
    };
    // Skip anything before the opening brace and require the RTF signature.
    const start = src.indexOf('{\\rtf');
    if (start < 0) throw new Error(t('app.notRtf'));
    this.pos = start + 1;
    let depth = 1;
    while (this.pos < n && depth > 0) {
      const c = src[this.pos];
      if (c === '{') {
        this.pos++;
        depth++;
        if (this.stack.length >= MAX_GROUP_DEPTH) {
          this.tooDeep++;
          continue;
        }
        this.stack.push(this.frame);
        this.frame = { ...this.frame, char: { ...this.frame.char }, para: { ...this.frame.para }, link: undefined, inLink: this.frame.link ?? this.frame.inLink };
        // A group opened with \* is a destination we don't know unless a handler claims it.
        if (src.startsWith('\\*', this.pos)) {
          this.pos += 2;
          const word = this.peekWord();
          if (!word || !this.knownDestination(word)) this.frame.dest = 'skip';
        }
      } else if (c === '}') {
        this.pos++;
        depth--;
        if (this.tooDeep > 0) this.tooDeep--;
        else this.close();
      } else if (c === '\\') {
        this.control();
      } else if (c === '\r' || c === '\n') {
        this.pos++;
      } else {
        this.pos++;
        this.character(c.charCodeAt(0));
      }
    }
    this.endParagraph(true);
    this.finish();
  }

  // --- Tokens -------------------------------------------------------------------------------

  private peekWord(): string | null {
    const m = /^\\([a-z]+)/i.exec(this.src.slice(this.pos, this.pos + 40));
    return m ? m[1] : null;
  }

  private knownDestination(word: string): boolean {
    return ANNOTATION_WORDS.has(word) || word === 'fldinst' || word === 'pn' || word === 'listtable' || word === 'listoverridetable' || word === 'shppict' || word === 'listlevel';
  }

  private control(): void {
    const src = this.src;
    const next = src[this.pos + 1];
    if (next === undefined) {
      this.pos++;
      return;
    }
    if (!/[a-z]/i.test(next)) {
      this.pos += 2;
      this.symbol(next);
      return;
    }
    let i = this.pos + 1;
    while (i < src.length && /[a-z]/i.test(src[i])) i++;
    const word = src.slice(this.pos + 1, i);
    let param: number | null = null;
    const m = /^-?\d+/.exec(src.slice(i, i + 12));
    if (m) {
      param = Number(m[0]);
      i += m[0].length;
    }
    if (src[i] === ' ') i++;
    this.pos = i;
    this.word(word, param);
  }

  /** Control symbols: \\ \{ \} \~ \- \_ \' \* and the line break written as a backslash. */
  private symbol(c: string): void {
    switch (c) {
      case '\\':
      case '{':
      case '}':
        this.character(c.charCodeAt(0));
        return;
      case '\'': {
        // Exactly two hex digits; anything else isn't a byte and stays text.
        const hex = this.src.slice(this.pos, this.pos + 2);
        if (!/^[0-9a-f]{2}$/i.test(hex)) return;
        this.pos += 2;
        const value = parseInt(hex, 16);
        if (this.skipChars > 0) {
          this.skipChars--;
          return;
        }
        this.pendingBytes.push(value);
        return;
      }
      case '~':
        this.emitText(' ');
        return;
      case '_':
        this.emitContent({ kind: 'noBreakHyphen' });
        return;
      case '-':
        this.emitContent({ kind: 'softHyphen' });
        return;
      case '\r':
      case '\n':
        this.endParagraph(false);
        return;
    }
  }

  private character(code: number): void {
    if (this.skipChars > 0) {
      this.skipChars--;
      return;
    }
    if (code >= 0x80) {
      this.pendingBytes.push(code);
      return;
    }
    this.flushBytes();
    this.emitText(String.fromCharCode(code));
  }

  private flushBytes(): void {
    if (!this.pendingBytes.length) return;
    const text = this.decoder.decode(new Uint8Array(this.pendingBytes));
    this.pendingBytes = [];
    this.emitText(text);
  }

  // --- Text sinks ---------------------------------------------------------------------------

  private emitText(text: string): void {
    if (this.pendingBytes.length && text !== undefined) {
      // Bytes decode together (multi-byte code pages), before whatever follows them.
      const pending = this.decoder.decode(new Uint8Array(this.pendingBytes));
      this.pendingBytes = [];
      this.route(pending);
    }
    this.route(text);
  }

  private route(text: string): void {
    if (!text) return;
    if (this.annotation && (this.frame.dest === 'annotation' || this.frame.dest === 'body' || this.frame.dest === 'fldrslt')) {
      this.annotation.current += text;
      return;
    }
    switch (this.frame.dest) {
      case 'atnfield':
        if (this.atnField) this.atnField.text += text;
        return;
      case 'body':
      case 'fldrslt':
        this.paragraphOpen = true;
        this.text += text;
        return;
      case 'fonttbl':
        this.tableText(text, ';', (name) => this.fonts.set(this.fontIndex, name.trim()), 'font');
        return;
      case 'colortbl':
        for (const ch of text) if (ch === ';') this.endColor();
        return;
      case 'stylesheet':
        this.tableText(text, ';', (name) => {
          if (this.styleIndex >= 0) this.styleNames.set(this.styleIndex, name.trim());
          this.styleIndex = -1;
        }, 'style');
        return;
      case 'fldinst':
        this.fldinst += text;
        return;
      case 'pict':
        this.pictData(text);
        return;
    }
  }

  private tableText(text: string, sep: string, done: (name: string) => void, which: 'font' | 'style'): void {
    for (const ch of text) {
      if (ch === sep) {
        done(which === 'font' ? this.fontName : this.styleName);
        this.fontName = '';
        this.styleName = '';
      } else if (which === 'font') this.fontName += ch;
      else this.styleName += ch;
    }
  }

  private emitContent(item: RunContent): void {
    if (this.annotation && this.frame.dest !== 'atnfield') {
      this.annotation.current += item.kind === 'tab' ? '\t' : item.kind === 'break' ? '\n' : item.kind === 'noBreakHyphen' ? '-' : '';
      return;
    }
    if (this.frame.dest !== 'body' && this.frame.dest !== 'fldrslt') return;
    this.flushText();
    this.paragraphOpen = true;
    this.pushRun([item]);
  }

  private flushText(): void {
    if (!this.text) return;
    const text = this.text;
    this.text = '';
    this.pushRun([{ kind: 'text', text }]);
  }

  private runProperties(): RunProperties {
    const c = this.frame.char;
    const p: RunProperties = {};
    if (c.bold) p.bold = true;
    if (c.italic) p.italic = true;
    if (c.underline) p.underline = { val: c.underline };
    if (c.strike) p.strike = true;
    if (c.doubleStrike) p.doubleStrike = true;
    if (c.vertAlign !== 'baseline') p.vertAlign = c.vertAlign;
    if (c.caps) p.caps = true;
    if (c.smallCaps) p.smallCaps = true;
    if (c.hidden) p.vanish = true;
    if (c.size !== this.defaultSize) {
      p.size = c.size;
      p.sizeCs = c.size;
    }
    if (c.font !== this.defaultFont) {
      const name = this.fonts.get(c.font);
      if (name) p.fonts = { ascii: name, hAnsi: name, eastAsia: name, cs: name };
    }
    const color = c.color > 0 ? this.colors[c.color] : null;
    if (color) p.color = { val: color };
    if (c.highlight > 0) {
      const hex = this.colors[c.highlight];
      if (hex) p.highlight = nearestHighlight(hex);
    }
    return p;
  }

  private pushRun(content: RunContent[]): void {
    const run = newRun(this.runProperties(), content);
    const link = this.frame.link ?? this.frame.inLink;
    if (link) link.runs.push(run);
    else this.inlines.push(run);
  }

  // --- Control words ------------------------------------------------------------------------

  private word(word: string, param: number | null): void {
    const f = this.frame;
    const c = f.char;
    const p = f.para;
    const on = param !== 0;
    this.flushBytes();
    // Text so far keeps the formatting it was written with.
    if (CHARACTER_WORDS.has(word)) this.flushText();
    switch (word) {
      // Header
      case 'ansicpg':
        if (param) this.decoder = decoderFor(param);
        return;
      case 'deff':
        this.defaultFont = param ?? 0;
        c.font = this.defaultFont;
        return;
      case 'uc':
        f.uc = param ?? 1;
        return;
      case 'u': {
        this.flushBytes();
        let code = param ?? 0;
        if (code < 0) code += 65536;
        this.route(String.fromCharCode(code));
        this.skipChars = f.uc;
        return;
      }
      case 'bin': {
        // Raw bytes follow the word; step over them.
        this.pos += Math.max(param ?? 0, 0);
        return;
      }

      // Structure
      case 'fonttbl':
        f.dest = 'fonttbl';
        return;
      case 'colortbl':
        f.dest = 'colortbl';
        this.colorParts = null;
        return;
      case 'stylesheet':
        f.dest = 'stylesheet';
        return;
      case 'listtable':
        f.dest = 'listtable';
        return;
      case 'listoverridetable':
        f.dest = 'listoverride';
        return;
      case 'field':
        return;
      case 'fldinst':
        f.dest = 'fldinst';
        this.fldinst = '';
        return;
      case 'fldrslt': {
        // An instruction such as `HYPERLINK "url"`, or `HYPERLINK \l "bookmark"` for a place in the document.
        const link = /^\s*HYPERLINK\s+(\\l\s+)?"([^"]+)"/i.exec(this.fldinst);
        f.dest = 'fldrslt';
        if (link && !this.annotation) f.link = { ...(link[1] ? { anchor: link[2] } : { url: link[2] }), runs: [] };
        this.fldinst = '';
        return;
      }
      case 'pict':
        f.dest = 'pict';
        this.pict = { format: null, hex: '', width: 0, height: 0, goalW: 0, goalH: 0, scaleX: 100, scaleY: 100 };
        return;
      case 'pn':
        f.dest = 'pn';
        return;
      case 'shppict':
        return;
      case 'atrfstart':
      case 'atrfend':
      case 'atnid':
      case 'atnauthor':
      case 'atnref':
      case 'atndate':
      case 'atnparent':
      case 'atnicn':
        if (f.dest === 'body' || f.dest === 'fldrslt' || f.dest === 'annotation') {
          if (f.dest !== 'annotation') this.flushText();
          f.dest = 'atnfield';
          this.atnField = { name: word, text: param !== null ? String(param) : '' };
        }
        return;
      case 'annotation':
        if ((f.dest === 'body' || f.dest === 'fldrslt') && !this.annotation) {
          this.flushText();
          f.dest = 'annotation';
          f.link = undefined;
          this.annotation = { depth: this.stack.length, paragraphs: [], current: '', ref: '', parent: '' };
        }
        return;
    }
    if (f.dest === 'fonttbl') {
      if (word === 'f') this.fontIndex = param ?? 0;
      return;
    }
    if (f.dest === 'colortbl') {
      const parts = (this.colorParts ??= [-1, -1, -1]);
      if (word === 'red') parts[0] = param ?? 0;
      else if (word === 'green') parts[1] = param ?? 0;
      else if (word === 'blue') parts[2] = param ?? 0;
      return;
    }
    if (f.dest === 'stylesheet') {
      if (word === 's') this.styleIndex = param ?? 0;
      return;
    }
    if (f.dest === 'listtable') {
      this.listTableWord(word, param);
      return;
    }
    if (f.dest === 'listoverride') {
      if (word === 'listid') this.overrideListId = param ?? 0;
      else if (word === 'ls') this.overrides.set(param ?? 0, this.overrideListId);
      return;
    }
    if (f.dest === 'pn') {
      const format = Object.hasOwn(PN_FORMATS, word) ? PN_FORMATS[word] : undefined;
      if (format) this.pnKind = format;
      return;
    }
    if (f.dest === 'pict') {
      this.pictWord(word, param);
      return;
    }
    if (f.dest === 'skip') return;
    if (SKIPPED.has(word)) {
      f.dest = 'skip';
      return;
    }

    switch (word) {
      // Character formatting
      case 'plain':
        c.bold = c.italic = c.strike = c.doubleStrike = c.caps = c.smallCaps = c.hidden = false;
        c.underline = null;
        c.vertAlign = 'baseline';
        c.size = this.defaultSize;
        c.font = this.defaultFont;
        c.color = 0;
        c.highlight = 0;
        return;
      case 'b':
        c.bold = on;
        return;
      case 'i':
        c.italic = on;
        return;
      case 'ul':
      case 'uld':
      case 'uldb':
      case 'ulw':
      case 'ulth':
      case 'ulwave':
      case 'uldash':
      case 'uldashd':
      case 'ulhwave':
      case 'ulldash':
        c.underline = on ? ({ ul: 'single', uld: 'dotted', uldb: 'double', ulw: 'words', ulth: 'thick', ulwave: 'wave', uldash: 'dash', uldashd: 'dotDash', ulhwave: 'wavyHeavy', ulldash: 'dashLong' }[word] ?? 'single') : null;
        return;
      case 'ulnone':
        c.underline = null;
        return;
      case 'strike':
        c.strike = on;
        return;
      case 'striked':
        c.doubleStrike = on;
        return;
      case 'super':
        c.vertAlign = on ? 'superscript' : 'baseline';
        return;
      case 'sub':
        c.vertAlign = on ? 'subscript' : 'baseline';
        return;
      case 'nosupersub':
        c.vertAlign = 'baseline';
        return;
      case 'caps':
        c.caps = on;
        return;
      case 'scaps':
        c.smallCaps = on;
        return;
      case 'v':
        c.hidden = on;
        return;
      case 'fs':
        c.size = param !== null && param > 0 ? param : this.defaultSize;
        return;
      case 'f':
        c.font = param ?? 0;
        return;
      case 'cf':
        c.color = param ?? 0;
        return;
      case 'highlight':
      case 'chcbpat':
        c.highlight = param ?? 0;
        return;

      // Paragraph formatting
      case 'pard':
        Object.assign(p, this.plainPara());
        return;
      case 'ql':
        p.align = undefined;
        return;
      case 'qc':
        p.align = 'center';
        return;
      case 'qr':
        p.align = 'right';
        return;
      case 'qj':
        p.align = 'both';
        return;
      case 'li':
      case 'lin':
        p.left = param ?? 0;
        return;
      case 'ri':
      case 'rin':
        p.right = param ?? 0;
        return;
      case 'fi':
        p.first = param ?? 0;
        return;
      case 'sb':
        p.before = param ?? 0;
        return;
      case 'sa':
        p.after = param ?? 0;
        return;
      case 'sl':
        p.line = param ?? 0;
        return;
      case 'slmult':
        p.lineMult = on;
        return;
      case 'keepn':
        p.keepNext = on;
        return;
      case 'keep':
        p.keepLines = on;
        return;
      case 'pagebb':
        p.pageBefore = on;
        return;
      case 's':
        p.style = param ?? undefined;
        return;
      case 'outlinelevel':
        p.outline = param ?? undefined;
        return;
      case 'ls':
        p.list = param ?? undefined;
        return;
      case 'ilvl':
        p.level = param ?? 0;
        return;
      case 'intbl':
        p.inTable = true;
        return;

      // Content
      case 'par':
      case 'sect':
        if (this.annotation) {
          if (f.dest === 'annotation' || f.dest === 'body' || f.dest === 'fldrslt') {
            this.annotation.paragraphs.push(this.annotation.current);
            this.annotation.current = '';
          }
          return;
        }
        this.endParagraph(false);
        return;
      case 'line':
        this.emitContent({ kind: 'break' });
        return;
      case 'page':
        this.emitContent({ kind: 'break', type: 'page' });
        return;
      case 'column':
        this.emitContent({ kind: 'break', type: 'column' });
        return;
      case 'tab':
        this.emitContent({ kind: 'tab' });
        return;
      case 'emdash':
        return this.emitText('—');
      case 'endash':
        return this.emitText('–');
      case 'emspace':
        return this.emitText(' ');
      case 'enspace':
        return this.emitText(' ');
      case 'qmspace':
        return this.emitText(' ');
      case 'bullet':
        return this.emitText('•');
      case 'lquote':
        return this.emitText('‘');
      case 'rquote':
        return this.emitText('’');
      case 'ldblquote':
        return this.emitText('“');
      case 'rdblquote':
        return this.emitText('”');

      // Tables
      case 'trowd':
        this.rowDefs = [];
        this.rowHeader = false;
        this.pendingDef = { right: 0, merge: null, fill: null };
        return;
      case 'trhdr':
        this.rowHeader = true;
        return;
      case 'clmgf':
        this.pendingDef.merge = 'first';
        return;
      case 'clmrg':
        this.pendingDef.merge = 'continue';
        return;
      case 'clcbpat':
        this.pendingDef.fill = param;
        return;
      case 'cellx':
        this.pendingDef.right = param ?? 0;
        this.rowDefs.push(this.pendingDef);
        this.pendingDef = { right: 0, merge: null, fill: null };
        return;
      case 'cell':
      case 'nestcell':
        this.endCell();
        return;
      case 'row':
      case 'nestrow':
        this.endRow();
        return;

      // Page setup
      case 'paperw':
      case 'paperh': {
        const size = (this.doc.section.pageSize ??= {});
        size[word === 'paperw' ? 'w' : 'h'] = param ?? 0;
        return;
      }
      case 'landscape':
        (this.doc.section.pageSize ??= {}).orient = 'landscape';
        return;
      case 'margl':
      case 'margr':
      case 'margt':
      case 'margb': {
        const margins = (this.doc.section.margins ??= {});
        margins[{ margl: 'left', margr: 'right', margt: 'top', margb: 'bottom' }[word] as 'left'] = param ?? 0;
        return;
      }
    }
  }

  private plainPara(): ParaState {
    return { align: undefined, left: 0, right: 0, first: 0, before: 0, after: 0, line: 0, lineMult: false, keepNext: false, keepLines: false, pageBefore: false, style: undefined, outline: undefined, list: undefined, level: 0, inTable: false };
  }

  // --- Lists --------------------------------------------------------------------------------

  private listTableWord(word: string, param: number | null): void {
    if (word === 'list') {
      this.currentList = { levels: [] };
    } else if (word === 'listid') {
      this.currentListId = param ?? 0;
      if (this.currentList) this.lists.set(this.currentListId, this.currentList);
    } else if (word === 'listlevel') {
      this.currentList?.levels.push({ format: 'decimal', start: 1 });
    } else if (word === 'levelnfc' || word === 'levelnfcn') {
      const level = this.currentList?.levels.at(-1);
      if (level) level.format = LIST_FORMATS[param ?? 0] ?? 'decimal';
    } else if (word === 'levelstartat') {
      const level = this.currentList?.levels.at(-1);
      if (level) level.start = param ?? 1;
    }
  }

  private numberingLevels(levels: { format: string; start: number }[]) {
    return Array.from({ length: 9 }, (_, l) => {
      const def = levels[l] ?? levels[0] ?? { format: 'decimal', start: 1 };
      return {
        level: l,
        start: def.start,
        format: def.format,
        suffix: 'tab' as const,
        text: def.format === 'bullet' ? ['•', '◦', '▪'][l % 3] : `%${l + 1}.`,
        justification: 'left',
        paragraphProperties: { indent: { left: 720 * (l + 1), hanging: 360 } },
        attrs: {},
      };
    });
  }

  /** The numbering instance for `\lsN`, defined the first time a paragraph uses it. */
  private listInstance(ls: number): number | undefined {
    if (this.usedOverrides.has(ls)) return ls + 1000;
    const list = this.lists.get(this.overrides.get(ls) ?? -1);
    if (!list) return undefined;
    const abstractId = this.nextAbstract++;
    this.doc.numbering.abstracts.push({ id: abstractId, multiLevelType: 'hybridMultilevel', levels: this.numberingLevels(list.levels), attrs: {} });
    this.doc.numbering.instances.push({ id: ls + 1000, abstractId, overrides: [], attrs: {} });
    this.usedOverrides.add(ls);
    return ls + 1000;
  }

  /** A list made from the old \pn description; consecutive items of one kind share a list. */
  private pnInstance(format: string): number {
    const list = this.pnList;
    if (list && list.format === format && list.last === this.paragraphs - 1) {
      list.last = this.paragraphs;
      return list.id;
    }
    const abstractId = this.nextAbstract++;
    const id = this.nextInstance++;
    this.doc.numbering.abstracts.push({ id: abstractId, multiLevelType: 'hybridMultilevel', levels: this.numberingLevels([{ format, start: 1 }]), attrs: {} });
    this.doc.numbering.instances.push({ id, abstractId, overrides: [], attrs: {} });
    this.pnList = { format, id, last: this.paragraphs };
    return id;
  }

  // --- Colours, pictures --------------------------------------------------------------------

  private endColor(): void {
    const parts = this.colorParts;
    this.colorParts = null;
    if (!parts || parts.some((v) => v < 0)) this.colors.push(null);
    else this.colors.push(parts.map((v) => Math.min(v, 255).toString(16).padStart(2, '0')).join('').toUpperCase());
  }

  private pictWord(word: string, param: number | null): void {
    const pict = this.pict;
    if (!pict) return;
    if (word === 'pngblip') pict.format = 'png';
    else if (word === 'jpegblip') pict.format = 'jpeg';
    else if (word === 'picw') pict.width = param ?? 0;
    else if (word === 'pich') pict.height = param ?? 0;
    else if (word === 'picwgoal') pict.goalW = param ?? 0;
    else if (word === 'pichgoal') pict.goalH = param ?? 0;
    else if (word === 'picscalex') pict.scaleX = param ?? 100;
    else if (word === 'picscaley') pict.scaleY = param ?? 100;
  }

  private pictData(text: string): void {
    if (this.pict) this.pict.hex += text.replace(/[^0-9a-f]/gi, '');
  }

  private finishPicture(): void {
    const pict = this.pict;
    this.pict = null;
    if (!pict?.format || pict.hex.length < 8) return;
    const data = new Uint8Array(pict.hex.length >> 1);
    for (let i = 0; i < data.length; i++) data[i] = parseInt(pict.hex.slice(i * 2, i * 2 + 2), 16);
    const twips = (goal: number, scale: number, pixels: number) => (goal > 0 ? (goal * scale) / 100 : pixels * 15);
    const width = twips(pict.goalW, pict.scaleX, pict.width) * 635;
    const height = twips(pict.goalH, pict.scaleY, pict.height) * 635;
    if (!(width > 0 && height > 0)) return;
    const image = this.doc.addImage(data, pict.format);
    this.paragraphOpen = true;
    this.flushText();
    this.pushRun([{ kind: 'drawing', inline: true, width, height, image }]);
  }

  // --- Groups -------------------------------------------------------------------------------

  private close(): void {
    this.flushBytes();
    const closing = this.frame;
    if (closing.dest === 'pict') this.finishPicture();
    if (closing.dest === 'atnfield') this.finishAtnField();
    if (this.annotation && this.stack.length === this.annotation.depth) this.finishAnnotation();
    if (closing.dest === 'fldrslt' && closing.link) {
      this.flushText();
      const { url, anchor, runs } = closing.link;
      closing.link = undefined;
      // The runs of the result were collected apart; they become one hyperlink.
      const link: Inline = { kind: 'hyperlink', ...(url !== undefined ? { url } : { anchor }), children: runs, attrs: {} };
      this.paragraphOpen = true;
      this.inlines.push(link);
    } else if (closing.dest === 'body' || closing.dest === 'fldrslt') {
      this.flushText();
    }
    const previous = this.stack.pop();
    if (!previous) return;
    this.frame = previous;
    this.skipChars = 0;
  }

  // --- Annotations --------------------------------------------------------------------------

  /** The model id for an RTF annotation id, allocated on first sight. */
  private commentId(rtfId: string): string {
    let id = this.commentIds.get(rtfId);
    if (id === undefined) this.commentIds.set(rtfId, (id = String(this.commentIds.size)));
    return id;
  }

  private pushInline(inline: Inline): void {
    this.paragraphOpen = true;
    const link = this.frame.link ?? this.frame.inLink;
    if (link) link.runs.push(inline);
    else this.inlines.push(inline);
  }

  private finishAtnField(): void {
    const field = this.atnField;
    this.atnField = null;
    if (!field) return;
    const text = field.text.trim();
    switch (field.name) {
      case 'atnid':
        this.pendingInitials = text;
        return;
      case 'atnauthor':
        this.pendingAuthor = text;
        return;
      case 'atrfstart':
        if (!this.rangeStarted.has(text)) {
          this.rangeStarted.add(text);
          this.pushInline(commentStart(this.commentId(text)));
        }
        return;
      case 'atrfend':
        if (!this.rangeEnded.has(text)) {
          this.rangeEnded.add(text);
          const id = this.commentId(text);
          this.pushInline(commentEnd(id));
          this.pushInline(commentReference(id));
        }
        return;
    }
    const annotation = this.annotation;
    if (!annotation) return;
    if (field.name === 'atnref') annotation.ref = text;
    else if (field.name === 'atnparent') annotation.parent = text;
    else if (field.name === 'atndate') annotation.date = dttmToIso(Number(text));
  }

  private finishAnnotation(): void {
    const a = this.annotation!;
    this.annotation = null;
    if (a.current || !a.paragraphs.length) a.paragraphs.push(a.current);
    // An annotation with no \atnref cannot be matched to a range: it gets its own key.
    const key = a.ref || `annotation${this.comments.length}`;
    const id = this.commentId(key);
    if (this.comments.some((c) => c.id === id)) return;
    const comment: Comment = { id, author: this.pendingAuthor, paragraphs: a.paragraphs };
    if (this.pendingInitials) comment.initials = this.pendingInitials;
    if (a.date) comment.date = a.date;
    const reply = !!a.parent && a.parent !== key;
    this.pendingAuthor = this.pendingInitials = '';
    this.comments.push(comment);
    const started = this.rangeStarted.has(key);
    const ended = this.rangeEnded.has(key);
    if (reply) this.repliesToPlace.push({ comment, parentKey: a.parent });
    if (ended) return;
    this.rangeEnded.add(key);
    if (reply && !started) return;
    // A range that never ended stops here; a comment with no range is an empty one at its reference.
    if (!started) this.pushInline(commentStart(id));
    this.pushInline(commentEnd(id));
    this.pushInline(commentReference(id));
  }

  /** Comment markers for replies that have no range go over their parent's; markers of comments that never appeared are dropped. */
  private placeComments(): void {
    // A reply's parent is found by its RTF id, so it may be written after the reply.
    const byId = new Set(this.comments.map((c) => c.id));
    for (const { comment, parentKey } of this.repliesToPlace) {
      const parentId = this.commentIds.get(parentKey);
      if (parentId !== undefined && parentId !== comment.id && byId.has(parentId)) comment.parentId = parentId;
    }
    const valid = byId;
    const strip = (inlines: Inline[]): Inline[] => {
      const out: Inline[] = [];
      for (const inline of inlines) {
        if (inline.kind === 'raw') {
          const id = inline.xml.attrs['w:id'];
          if (id !== undefined && /^w:commentRange(Start|End)$/.test(inline.xml.name) && !valid.has(id)) continue;
        } else if (inline.kind === 'run') {
          if (inline.content.some((c) => c.kind === 'raw' && c.xml.name === 'w:commentReference' && !valid.has(c.xml.attrs['w:id'] ?? ''))) continue;
        } else if (inline.kind === 'hyperlink' || inline.kind === 'wrapper') inline.children = strip(inline.children);
        out.push(inline);
      }
      return out;
    };
    const all = paragraphsIn(this.body);
    for (const p of all) p.children = strip(p.children);
    if (!this.repliesToPlace.length) return;
    const ranges = commentRanges(all);
    for (const { comment } of this.repliesToPlace) {
      const { id, parentId } = comment;
      // Only replies that gave no range of their own (they have no markers yet).
      if (parentId === undefined || ranges.has(id)) continue;
      const range = ranges.get(parentId);
      if (!range) continue;
      // End first: when both are in one paragraph the start sits before it, so its offset holds.
      insertInlines(range.end.paragraph, range.end.offset, [commentEnd(id), commentReference(id)]);
      insertInlines(range.start.paragraph, range.start.offset - 1, [commentStart(id)]);
      // Markers inserted before a later reply's anchors shift them: read the ranges again.
      for (const [k, v] of commentRanges(all)) ranges.set(k, v);
    }
  }

  // --- Paragraphs, cells, rows --------------------------------------------------------------

  private endParagraph(final: boolean): void {
    this.flushBytes();
    this.flushText();
    if (final && !this.paragraphOpen && !this.inlines.length) return;
    if (this.frame.dest !== 'body' && !final) return;
    const p = this.frame.para;
    const properties: ParagraphProperties = {};
    const name = p.style === undefined ? undefined : this.styleNames.get(p.style)?.toLowerCase();
    const heading = name && /^heading ([1-6])$/.exec(name);
    if (heading) properties.style = `Heading${heading[1]}`;
    else if (name === 'title') properties.style = 'Title';
    else if (name === 'quote') properties.style = 'Quote';
    if (properties.style) this.used.add(properties.style);
    if (p.align) properties.justification = p.align;
    const indent: NonNullable<ParagraphProperties['indent']> = {};
    if (p.left) indent.left = p.left;
    if (p.right) indent.right = p.right;
    if (p.first > 0) indent.firstLine = p.first;
    else if (p.first < 0) indent.hanging = -p.first;
    if (Object.keys(indent).length) properties.indent = indent;
    const spacing: NonNullable<ParagraphProperties['spacing']> = {};
    if (p.before) spacing.before = p.before;
    if (p.after) spacing.after = p.after;
    if (p.line !== 0) {
      spacing.line = Math.abs(p.line);
      spacing.lineRule = p.lineMult ? 'auto' : p.line < 0 ? 'exact' : 'atLeast';
    }
    if (Object.keys(spacing).length) properties.spacing = spacing;
    if (p.keepNext) properties.keepNext = true;
    if (p.keepLines) properties.keepLines = true;
    if (p.pageBefore) properties.pageBreakBefore = true;
    if (p.outline !== undefined && !heading && p.outline <= 8) properties.outlineLevel = p.outline;
    const numId = p.list !== undefined && p.list > 0 ? this.listInstance(p.list) : this.pnKind ? this.pnInstance(this.pnKind) : undefined;
    if (numId !== undefined) {
      properties.style ??= 'ListParagraph';
      this.used.add(properties.style);
      properties.numbering = { id: numId, level: Math.min(p.level, 8) };
    }
    const paragraph: Paragraph = { kind: 'paragraph', properties, children: this.inlines, attrs: {} };
    this.inlines = [];
    this.paragraphOpen = false;
    if (p.inTable) this.cellBlocks.push(paragraph);
    else {
      this.flushTable();
      this.body.push(paragraph);
    }
    // A \pn description applies to the one paragraph it is written in.
    this.pnKind = null;
    this.paragraphs++;
  }

  private endCell(): void {
    this.flushBytes();
    this.flushText();
    if (this.inlines.length || this.paragraphOpen) this.endParagraph(false);
    const blocks = this.cellBlocks;
    this.cellBlocks = [];
    const index = this.rowCells.length;
    const def = this.rowDefs[index];
    const before = index > 0 ? (this.rowDefs[index - 1]?.right ?? 0) : 0;
    const width = Math.max((def?.right ?? before + 2000) - before, 200);
    const cell: TableCell = {
      kind: 'cell',
      properties: { width: { w: String(width), type: 'dxa' } },
      children: blocks.length ? blocks : [{ kind: 'paragraph', properties: {}, children: [], attrs: {} }],
      attrs: {},
    };
    const fill = def?.fill && def.fill > 0 ? this.colors[def.fill] : null;
    if (fill) cell.properties.shading = { val: 'clear', color: 'auto', fill };
    this.rowCells.push(def?.merge === 'continue' ? null : cell);
    if (def?.merge !== 'continue') this.rowLastCell = cell;
    else {
      // Fold the continuation into the cell it extends.
      const first = this.rowLastCell;
      if (first) {
        first.properties.gridSpan = (first.properties.gridSpan ?? 1) + 1;
        first.properties.width = { w: String(Number(first.properties.width?.w ?? 0) + width), type: 'dxa' };
      }
    }
  }

  private endRow(): void {
    this.flushBytes();
    if (this.inlines.length || this.cellBlocks.length) this.endCell();
    const cells = this.rowCells.filter((c): c is TableCell => c !== null);
    this.rowCells = [];
    this.rowLastCell = null;
    if (!cells.length) return;
    const grid = cells.flatMap((c) => {
      const span = c.properties.gridSpan ?? 1;
      return new Array<number>(span).fill(Math.round(Number(c.properties.width?.w ?? 0) / span));
    });
    if (grid.length > this.tableGrid.length) this.tableGrid = grid;
    this.tableRows.push({ kind: 'row', properties: this.rowHeader ? { header: true } : {}, cells, attrs: {} });
    this.rowHeader = false;
  }

  private flushTable(): void {
    if (!this.tableRows.length) return;
    const border = { val: 'single', sz: 4, space: 0, color: 'auto' };
    const table: Table = {
      kind: 'table',
      properties: {
        width: { w: '0', type: 'auto' },
        borders: { top: border, left: border, bottom: border, right: border, insideH: border, insideV: border },
      },
      grid: this.tableGrid,
      rows: this.tableRows,
    };
    this.tableRows = [];
    this.tableGrid = [];
    this.body.push(table);
  }

  private finish(): void {
    this.flushTable();
    // A table at the very end of a document is followed by an empty paragraph, as Word requires.
    if (!this.body.length || this.body.at(-1)?.kind === 'table') {
      this.body.push({ kind: 'paragraph', properties: {}, children: [], attrs: {} });
    }
    this.doc.body = this.body;
    this.placeComments();
    this.doc.comments = this.comments;
    const have = new Set(this.doc.styles.styles.map((s) => s.id));
    for (const id of this.used) {
      if (have.has(id)) continue;
      const style = styleFor(id);
      if (style) this.doc.styles.styles.push(style);
    }
    const name = this.fonts.get(this.defaultFont);
    if (name) {
      const defaults = (this.doc.styles.defaultRunProperties ??= {});
      defaults.fonts = { ...defaults.fonts, ascii: name, hAnsi: name, eastAsia: name, cs: name };
      defaults.size = this.defaultSize;
      defaults.sizeCs = this.defaultSize;
      this.doc.styles.hasRunDefaults = true;
    }
    if (this.doc.section.pageSize?.h !== undefined && this.doc.section.pageSize.w !== undefined) {
      const { w, h } = this.doc.section.pageSize;
      // \paperw and \paperh are portrait dimensions unless \landscape swaps them.
      if (this.doc.section.pageSize.orient === 'landscape' && w < h) this.doc.section.pageSize = { ...this.doc.section.pageSize, w: h, h: w };
    }
  }
}

function nearestHighlight(hex: string): string {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  let best = 'yellow';
  let distance = Infinity;
  for (const [name, hr, hg, hb] of HIGHLIGHTS) {
    const d = (r - hr) ** 2 + (g - hg) ** 2 + (b - hb) ** 2;
    if (d < distance) {
      distance = d;
      best = name;
    }
  }
  return best;
}
