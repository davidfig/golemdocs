// Rich Text Format -> document model. RTF is a stream of groups ({...}), control words (\b, \fs24)
// and text. This reads what word processors write for ordinary documents: character formatting
// (bold, italic, underline, strike, super/subscript, size, font, color, highlight), paragraph
// formatting (alignment, indents, spacing, headings, lists), tables, hyperlinks, page breaks,
// pictures (PNG and JPEG) and page setup. Anything else (headers, footers, shapes, text boxes,
// fields other than links) is skipped, keeping the text of a field's result.

import { WordDocument } from '@word/docx';
import type {
  Block,
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
import { t } from '../i18n/index.ts';

/** Destinations whose content is never body text. */
const SKIPPED = new Set([
  'info', 'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf', 'footnote', 'shp', 'shpinst', 'shptxt',
  'object', 'themedata', 'datastore', 'colorschememapping', 'latentstyles', 'rsidtbl', 'generator', 'xmlnstbl', 'filetbl', 'revtbl',
  'private', 'fchars', 'lchars', 'pgptbl', 'template', 'listtext', 'pntext', 'pntxta', 'pntxtb', 'bkmkstart', 'bkmkend', 'nonshppict', 'stylesheet',
  'operator', 'title', 'author', 'company', 'comment', 'panose', 'falt', 'fname', 'leveltext', 'levelnumbers', 'protusertbl', 'wgrffmtfilter',
]);

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

/** Windows code pages by number, as TextDecoder labels. */
function decoderFor(codePage: number): TextDecoder {
  try {
    return new TextDecoder(codePage === 65001 ? 'utf-8' : codePage === 10000 ? 'macintosh' : `windows-${codePage}`);
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

type Destination = 'body' | 'skip' | 'fonttbl' | 'colortbl' | 'stylesheet' | 'listtable' | 'listoverride' | 'fldinst' | 'fldrslt' | 'pict' | 'pn';

interface Frame {
  dest: Destination;
  char: CharState;
  para: ParaState;
  /** Bytes of \uN skipped after a Unicode escape (\ucN). */
  uc: number;
  /** Set on an \fldrslt that replaces a hyperlink: its runs are wrapped when the group closes. */
  link?: { url?: string; anchor?: string; runs: Inline[] };
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

class RtfReader {
  private pos = 0;
  private stack: Frame[] = [];
  private frame!: Frame;
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
  private pict: Picture | null = null;

  private readonly body: Block[] = [];
  private inlines: Inline[] = [];
  private text = '';
  private paragraphOpen = false;
  private rowCells: (TableCell | null)[] = [];
  private cellBlocks: Block[] = [];
  private rowDefs: CellDef[] = [];
  private pendingDef: CellDef = { right: 0, merge: null, fill: null };
  private tableRows: TableRow[] = [];
  private tableGrid: number[] = [];

  private used = new Set<string>();

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
        this.stack.push(this.frame);
        this.frame = { ...this.frame, char: { ...this.frame.char }, para: { ...this.frame.para }, link: undefined };
        // A group opened with \* is a destination we don't know unless a handler claims it.
        if (src.startsWith('\\*', this.pos)) {
          this.pos += 2;
          const word = this.peekWord();
          if (!word || !this.knownDestination(word)) this.frame.dest = 'skip';
        }
      } else if (c === '}') {
        this.pos++;
        depth--;
        this.close();
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
    return word === 'fldinst' || word === 'pn' || word === 'listtable' || word === 'listoverridetable' || word === 'shppict' || word === 'listlevel';
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
        const hex = this.src.slice(this.pos, this.pos + 2);
        this.pos += 2;
        const value = parseInt(hex, 16);
        if (Number.isNaN(value)) return;
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
    switch (this.frame.dest) {
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
    if (this.frame.link) this.frame.link.runs.push(run);
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
        if (link) f.link = { ...(link[1] ? { anchor: link[2] } : { url: link[2] }), runs: [] };
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
      const format = PN_FORMATS[word];
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
        c.size = param ?? this.defaultSize;
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
        this.pendingDef = { right: 0, merge: null, fill: null };
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
    if (def?.merge === 'continue') {
      // Fold the continuation into the cell it extends.
      const first = [...this.rowCells].reverse().find((c) => c);
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
    if (!cells.length) return;
    const grid = cells.flatMap((c) => {
      const span = c.properties.gridSpan ?? 1;
      return new Array<number>(span).fill(Math.round(Number(c.properties.width?.w ?? 0) / span));
    });
    if (grid.length > this.tableGrid.length) this.tableGrid = grid;
    this.tableRows.push({ kind: 'row', properties: {}, cells, attrs: {} });
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
