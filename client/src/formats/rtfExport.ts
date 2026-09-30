// Document model -> Rich Text Format. Writes each run's effective formatting (styles resolved),
// so the file looks the same wherever it is opened, plus a stylesheet for headings so word
// processors still see them as headings. Tables, hyperlinks, lists, page breaks, PNG and JPEG
// pictures, page setup and comments are kept; tracked changes, footnotes, headers and footers,
// and text boxes are dropped (their body text stays). A comment is written as Word's RTF
// annotation: {\*\atrfstart N}range{\*\atrfend N}, then its initials, author and
// {\*\annotation{\*\atnref N}{\*\atndate DTTM}{\*\atnparent P}...text}. A reply names its parent with
// \atnparent. There is no RTF form of "resolved", so that is not kept.

import { isMathInline, readMathInline, StyleResolver, toLatex } from '@word/docx';
import type { Block, Comment, Inline, NumberingLevel, Paragraph, Run, RunContent, Table, TableCell, WordDocument } from '@word/docx';
import { HIGHLIGHTS } from './rtfImport.ts';

/** An ISO 8601 date as an RTF DTTM (minute, hour, day, month, year since 1900 and weekday, packed in 32 bits), in UTC. */
export function isoToDttm(iso: string | undefined): number | undefined {
  const time = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(time)) return undefined;
  const d = new Date(time);
  const year = d.getUTCFullYear() - 1900;
  if (year < 0 || year > 511) return undefined;
  return (d.getUTCMinutes() | (d.getUTCHours() << 6) | (d.getUTCDate() << 11) | ((d.getUTCMonth() + 1) << 16) | (year << 20) | (d.getUTCDay() << 29)) >>> 0;
}

const LIST_NFC: Record<string, number> = { decimal: 0, upperRoman: 1, lowerRoman: 2, upperLetter: 3, lowerLetter: 4, decimalZero: 22, bullet: 23, none: 255 };
const TITLE_STYLE = 7;
const QUOTE_STYLE = 8;

/** RTF text: ASCII as is (with the special characters escaped), everything else as \uN. */
export function escapeRtf(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const ch = text[i];
    if (ch === '\\' || ch === '{' || ch === '}') out += `\\${ch}`;
    else if (code === 10) out += '\\line ';
    else if (code === 9) out += '\\tab ';
    else if (code < 32 || code === 127) continue;
    else if (code < 127) out += ch;
    else out += `\\u${code > 32767 ? code - 65536 : code}?`;
  }
  return out;
}

const hex = (value: number) => value.toString(16).padStart(2, '0');

export async function documentToRtf(doc: WordDocument): Promise<Uint8Array> {
  const images = new Map<string, Uint8Array>();
  const collect = async (inlines: readonly Inline[]): Promise<void> => {
    for (const inline of inlines) {
      if (inline.kind === 'run') {
        for (const item of inline.content) {
          if (item.kind === 'drawing' && item.image && /\.(png|jpe?g)$/i.test(item.image) && !images.has(item.image)) {
            images.set(item.image, await doc.media(item.image).catch(() => new Uint8Array()));
          }
        }
      } else if (inline.kind === 'hyperlink' || inline.kind === 'wrapper') await collect(inline.children);
    }
  };
  const walk = async (blocks: readonly Block[]): Promise<void> => {
    for (const block of blocks) {
      if (block.kind === 'paragraph') await collect(block.children);
      else if (block.kind === 'wrapper') await walk(block.children);
      else if (block.kind === 'table') {
        for (const row of block.rows) if (row.kind === 'row') for (const cell of row.cells) if (cell.kind === 'cell') await walk(cell.children);
      }
    }
  };
  await walk(doc.body);
  return new TextEncoder().encode(new RtfWriter(doc, images).write());
}

class RtfWriter {
  private readonly resolver: StyleResolver;
  private readonly fonts: string[] = [];
  private readonly colors: string[] = [];
  private readonly lists = new Set<number>();
  /** Comments by model id, with the number each is written under. */
  private readonly comments = new Map<string, { comment: Comment; number: number }>();
  private readonly written = new Set<string>();

  constructor(
    private readonly doc: WordDocument,
    private readonly images: Map<string, Uint8Array>,
  ) {
    this.resolver = new StyleResolver(doc.styles, doc.theme, doc.numbering);
    this.fontIndex(this.resolver.font(doc.styles.defaultRunProperties?.fonts) ?? 'Calibri');
    doc.comments.forEach((comment, number) => this.comments.set(comment.id, { comment, number }));
  }

  private fontIndex(name: string): number {
    let i = this.fonts.indexOf(name);
    if (i < 0) i = this.fonts.push(name) - 1;
    return i;
  }

  /** Colour table index (1-based; 0 is "auto") for an RRGGBB colour. */
  private colorIndex(rgb: string): number {
    const value = rgb.toUpperCase();
    let i = this.colors.indexOf(value);
    if (i < 0) i = this.colors.push(value) - 1;
    return i + 1;
  }

  write(): string {
    const body = this.blocks(this.doc.body);
    const { pageSize: size, margins } = this.doc.section;
    const page =
      `\\paperw${size?.w ?? 12240}\\paperh${size?.h ?? 15840}` +
      `\\margl${margins?.left ?? 1440}\\margr${margins?.right ?? 1440}\\margt${margins?.top ?? 1440}\\margb${margins?.bottom ?? 1440}` +
      (size?.orient === 'landscape' ? '\\landscape' : '');
    const fonts = this.fonts.map((name, i) => `{\\f${i}\\fnil ${escapeRtf(name)};}`).join('');
    const colors = this.colors
      .map((c) => `\\red${parseInt(c.slice(0, 2), 16)}\\green${parseInt(c.slice(2, 4), 16)}\\blue${parseInt(c.slice(4, 6), 16)};`)
      .join('');
    const styles =
      [1, 2, 3, 4, 5, 6].map((n) => `{\\s${n}\\sbasedon0\\snext0 heading ${n};}`).join('') +
      `{\\s${TITLE_STYLE}\\sbasedon0\\snext0 Title;}{\\s${QUOTE_STYLE}\\sbasedon0\\snext0 Quote;}`;
    return (
      `{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1{\\fonttbl${fonts}}{\\colortbl;${colors}}{\\stylesheet{\\s0 Normal;}${styles}}` +
      `${this.listTables()}{\\*\\generator Golem Docs}\\viewkind1${page}\\fs${this.defaultSize()}\n${body}}`
    );
  }

  private defaultSize(): number {
    return this.doc.styles.defaultRunProperties?.size ?? 22;
  }

  // --- Blocks -------------------------------------------------------------------------------

  private blocks(blocks: readonly Block[]): string {
    let out = '';
    for (const block of blocks) {
      if (block.kind === 'paragraph') out += `${this.paragraph(block, false)}\\par\n`;
      else if (block.kind === 'table') out += this.table(block);
      else if (block.kind === 'wrapper') out += this.blocks(block.children);
    }
    return out;
  }

  private paragraph(p: Paragraph, inTable: boolean): string {
    const props = this.resolver.paragraph(p.properties);
    let out = '\\pard\\plain';
    if (inTable) out += '\\intbl';
    const style = p.properties.style ?? props.style;
    const heading = /^Heading([1-6])$/.exec(style ?? '');
    if (heading) out += `\\s${heading[1]}`;
    else if (style === 'Title') out += `\\s${TITLE_STYLE}`;
    else if (style === 'Quote') out += `\\s${QUOTE_STYLE}`;
    const numbering = props.numbering;
    const level = numbering?.id ? this.resolver.listLevel(numbering.id, numbering.level ?? 0) : undefined;
    if (numbering?.id && level && level.format !== 'none') {
      this.lists.add(numbering.id);
      out += `\\ls${numbering.id}\\ilvl${Math.min(numbering.level ?? 0, 8)}`;
    }
    switch (props.justification) {
      case 'center':
        out += '\\qc';
        break;
      case 'right':
      case 'end':
        out += '\\qr';
        break;
      case 'both':
      case 'distribute':
        out += '\\qj';
        break;
      default:
        out += '\\ql';
    }
    const indent = props.indent;
    const left = indent?.left ?? indent?.start;
    const right = indent?.right ?? indent?.end;
    if (left) out += `\\li${left}`;
    if (right) out += `\\ri${right}`;
    if (indent?.hanging) out += `\\fi-${indent.hanging}`;
    else if (indent?.firstLine) out += `\\fi${indent.firstLine}`;
    const spacing = props.spacing;
    if (spacing?.before) out += `\\sb${spacing.before}`;
    if (spacing?.after) out += `\\sa${spacing.after}`;
    if (spacing?.line) {
      const fixed = spacing.lineRule === 'exact' || spacing.lineRule === 'atLeast';
      out += `\\sl${spacing.lineRule === 'exact' ? -spacing.line : spacing.line}\\slmult${fixed ? 0 : 1}`;
    }
    if (props.keepNext) out += '\\keepn';
    if (props.keepLines) out += '\\keep';
    if (props.pageBreakBefore) out += '\\pagebb';
    if (props.outlineLevel !== undefined && props.outlineLevel < 9) out += `\\outlinelevel${props.outlineLevel}`;
    return `${out} ${this.inlines(p.children, style)}`;
  }

  private inlines(inlines: readonly Inline[], style: string | undefined, link = false): string {
    let out = '';
    for (const inline of inlines) {
      switch (inline.kind) {
        case 'run':
          out += this.run(inline, style, link);
          for (const item of inline.content) if (item.kind === 'raw' && item.xml.name === 'w:commentReference') out += this.annotation(item.xml.attrs['w:id']);
          break;
        case 'hyperlink': {
          const content = this.inlines(inline.children, style, true);
          // The instruction is RTF text: its own backslashes ("\l" for a bookmark) are written escaped.
          const target = inline.url ? `HYPERLINK "${escapeRtf(inline.url)}"` : inline.anchor ? `HYPERLINK \\\\l "${escapeRtf(inline.anchor)}"` : null;
          out += target ? `{\\field{\\*\\fldinst ${target}}{\\fldrslt ${content}}}` : content;
          break;
        }
        case 'wrapper':
          if (inline.shell.name !== 'w:del' && inline.shell.name !== 'w:moveFrom') out += this.inlines(inline.children, style, link);
          break;
        case 'raw':
          if (inline.xml.name === 'w:commentRangeStart' || inline.xml.name === 'w:commentRangeEnd') {
            const known = this.comments.get(inline.xml.attrs['w:id'] ?? '');
            if (known) out += `{\\*\\atrf${inline.xml.name === 'w:commentRangeStart' ? 'start' : 'end'} ${known.number}}`;
          } else if (isMathInline(inline)) {
            // An equation is its LaTeX, as text.
            const equation = readMathInline(inline);
            out += escapeRtf(equation.display ? '$$' + toLatex(equation) + '$$' : '$' + toLatex(equation) + '$');
          }
          break;
      }
    }
    return out;
  }

  /** A comment's annotation, written where its reference is. */
  private annotation(id: string | undefined): string {
    const known = id === undefined ? undefined : this.comments.get(id);
    if (!known || this.written.has(known.comment.id)) return '';
    this.written.add(known.comment.id);
    const { comment, number } = known;
    const parent = comment.parentId === undefined ? undefined : this.comments.get(comment.parentId);
    // A parent is written before its replies, even if a reply's reference comes first.
    const first = parent && parent !== known && !this.written.has(parent.comment.id) ? this.annotation(parent.comment.id) : '';
    const date = isoToDttm(comment.date);
    const paragraphs = comment.paragraphs.length ? comment.paragraphs : [''];
    return (
      first +
      (comment.initials ? `{\\*\\atnid ${escapeRtf(comment.initials)}}` : '') +
      `{\\*\\atnauthor ${escapeRtf(comment.author)}}\\chatn` +
      `{\\*\\annotation{\\*\\atnref ${number}}` +
      (date !== undefined ? `{\\*\\atndate ${date}}` : '') +
      (parent ? `{\\*\\atnparent ${parent.number}}` : '') +
      '{\\*\\atnicn}' +
      paragraphs.map((text, i) => `\\pard\\plain ${i === 0 ? '{\\chatn }' : ''}${escapeRtf(text)}\\par`).join('') +
      '}'
    );
  }

  private run(run: Run, style: string | undefined, link: boolean): string {
    const content = run.content.map((item) => this.content(item)).join('');
    if (!content) return '';
    const r = this.resolver.run(style, run.properties);
    let codes = '\\plain';
    const font = this.resolver.font(r.fonts);
    if (font) codes += `\\f${this.fontIndex(font)}`;
    codes += `\\fs${r.size ?? this.defaultSize()}`;
    if (r.bold) codes += '\\b';
    if (r.italic) codes += '\\i';
    const underline = r.underline?.val && r.underline.val !== 'none' ? r.underline.val : link ? 'single' : null;
    if (underline) codes += underline === 'double' ? '\\uldb' : underline === 'dotted' ? '\\uld' : underline === 'words' ? '\\ulw' : underline === 'thick' ? '\\ulth' : '\\ul';
    if (r.strike) codes += '\\strike';
    if (r.doubleStrike) codes += '\\striked1';
    if (r.vertAlign === 'superscript') codes += '\\super';
    else if (r.vertAlign === 'subscript') codes += '\\sub';
    if (r.caps) codes += '\\caps';
    if (r.smallCaps) codes += '\\scaps';
    if (r.vanish) codes += '\\v';
    const color = r.color?.val && r.color.val !== 'auto' ? r.color.val : link && !r.color ? '0563C1' : null;
    if (color && /^[0-9a-f]{6}$/i.test(color)) codes += `\\cf${this.colorIndex(color)}`;
    const highlight = r.highlight ? HIGHLIGHTS.find(([name]) => name === r.highlight) : undefined;
    if (highlight) codes += `\\highlight${this.colorIndex(`${hex(highlight[1])}${hex(highlight[2])}${hex(highlight[3])}`)}`;
    return `{${codes} ${content}}`;
  }

  private content(item: RunContent): string {
    switch (item.kind) {
      case 'text':
        return escapeRtf(item.text);
      case 'tab':
        return '\\tab ';
      case 'break':
        return item.type === 'page' ? '\\page ' : item.type === 'column' ? '\\column ' : '\\line ';
      case 'noBreakHyphen':
        return '\\_';
      case 'softHyphen':
        return '\\-';
      case 'symbol': {
        const code = item.char ? parseInt(item.char, 16) : NaN;
        if (Number.isNaN(code)) return '';
        // Symbol-font characters live in the private-use area; the bullet is the common one.
        if (code >= 0xf000) return code === 0xf0b7 ? '\\u8226?' : `\\u${code - 0xf000}?`;
        return escapeRtf(String.fromCharCode(code));
      }
      case 'drawing':
        return this.picture(item);
      default:
        return '';
    }
  }

  private picture(item: Extract<RunContent, { kind: 'drawing' }>): string {
    const data = item.image ? this.images.get(item.image) : undefined;
    if (!data?.length || !item.image) return '';
    const blip = /\.png$/i.test(item.image) ? 'pngblip' : 'jpegblip';
    // EMU to twips (635 per twip) for the goal size, to pixels (9525 per pixel) for the source size.
    let body = '';
    for (let i = 0; i < data.length; i++) body += hex(data[i]);
    return (
      `{\\pict\\${blip}\\picw${Math.round(item.width / 9525)}\\pich${Math.round(item.height / 9525)}` +
      `\\picwgoal${Math.round(item.width / 635)}\\pichgoal${Math.round(item.height / 635)}\n${body}}`
    );
  }

  // --- Tables -------------------------------------------------------------------------------

  private table(table: Table): string {
    let out = '';
    const borders =
      table.properties.style === 'TableGrid' ||
      Object.values(table.properties.borders ?? {}).some((b) => !!b && !Array.isArray(b) && typeof b === 'object' && 'val' in b && b.val !== 'nil' && b.val !== 'none');
    const edges = '\\clbrdrt\\brdrs\\brdrw10\\clbrdrl\\brdrs\\brdrw10\\clbrdrb\\brdrs\\brdrw10\\clbrdrr\\brdrs\\brdrw10';
    for (const row of table.rows) {
      if (row.kind !== 'row') continue;
      let defs = '\\trowd\\trgaph108\\trleft0';
      if (row.properties.header) defs += '\\trhdr';
      if (row.properties.cantSplit) defs += '\\trkeep';
      let right = 0;
      let col = 0;
      let content = '';
      for (const cell of row.cells) {
        if (cell.kind !== 'cell') continue;
        const span = cell.properties.gridSpan ?? 1;
        right += cellWidth(cell, table.grid, col, span);
        col += span;
        const fill = cell.properties.shading?.fill;
        if (borders) defs += edges;
        if (fill && /^[0-9a-f]{6}$/i.test(fill)) defs += `\\clcbpat${this.colorIndex(fill)}`;
        if (cell.properties.vAlign === 'center') defs += '\\clvertalc';
        else if (cell.properties.vAlign === 'bottom') defs += '\\clvertalb';
        defs += `\\cellx${right}`;
        content += this.cell(cell);
      }
      out += `${defs}\n${content}\\row\n`;
    }
    return out;
  }

  private cell(cell: TableCell): string {
    const parts: string[] = [];
    const walk = (blocks: readonly Block[]): void => {
      for (const block of blocks) {
        if (block.kind === 'paragraph') parts.push(this.paragraph(block, true));
        else if (block.kind === 'wrapper') walk(block.children);
        else if (block.kind === 'table') {
          // Nested tables are flattened to their paragraphs.
          for (const row of block.rows) if (row.kind === 'row') for (const c of row.cells) if (c.kind === 'cell') walk(c.children);
        }
      }
    };
    walk(cell.children);
    return `${parts.length ? parts.join('\\par\n') : '\\pard\\intbl '}\\cell\n`;
  }

  // --- Lists --------------------------------------------------------------------------------

  private listTables(): string {
    if (!this.lists.size) return '';
    let defs = '';
    let overrides = '';
    for (const id of [...this.lists].sort((a, b) => a - b)) {
      let levels = '';
      for (let l = 0; l < 9; l++) levels += this.listLevel(this.resolver.listLevel(id, l), l);
      defs += `{\\list\\listtemplateid${id}${levels}\\listid${id}}\n`;
      overrides += `{\\listoverride\\listid${id}\\listoverridecount0\\ls${id}}\n`;
    }
    return `{\\*\\listtable\n${defs}}{\\*\\listoverridetable\n${overrides}}`;
  }

  private listLevel(level: NumberingLevel | undefined, index: number): string {
    const format = level?.format ?? 'decimal';
    const text = level?.text ?? (format === 'bullet' ? '\u2022' : `%${index + 1}.`);
    // \leveltext is a length byte, then the label's characters with \'NN standing for level NN+1's number.
    let label = '';
    let length = 0;
    const numbers: number[] = [];
    for (let i = 0; i < text.length; i++) {
      const m = /^%([1-9])/.exec(text.slice(i));
      if (m) {
        label += `\\'${hex(Number(m[1]) - 1)}`;
        numbers.push(length + 1);
        i++;
      } else {
        const code = text.charCodeAt(i);
        if (code < 32 || code >= 127) label += `\\uc0\\u${code > 32767 ? code - 65536 : code}\\uc1 `;
        else if ('\\{};'.includes(text[i])) label += `\\'${hex(code)}`;
        else label += text[i];
      }
      length++;
    }
    const indent = level?.paragraphProperties?.indent;
    return (
      `{\\listlevel\\levelnfc${LIST_NFC[format] ?? 0}\\leveljc0\\levelfollow0\\levelstartat${level?.start ?? 1}` +
      `{\\leveltext\\'${hex(length)}${label};}{\\levelnumbers${numbers.map((n) => `\\'${hex(n)}`).join('')};}` +
      `\\fi-${indent?.hanging ?? 360}\\li${indent?.left ?? 720 * (index + 1)}}\n`
    );
  }
}

function cellWidth(cell: TableCell, grid: readonly number[], col: number, span: number): number {
  const w = cell.properties.width;
  if (w?.type === 'dxa' && Number(w.w) > 0) return Number(w.w);
  let total = 0;
  for (let i = col; i < col + span; i++) total += grid[i] ?? 0;
  return total > 0 ? total : 2000 * span;
}
