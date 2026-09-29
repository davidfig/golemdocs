// Reading and writing document content: blocks (paragraphs, tables), inlines (runs,
// hyperlinks) and run content (text, tabs, breaks, fields, drawings).

import type {
  Block,
  Drawing,
  FieldChar,
  Hyperlink,
  Inline,
  Paragraph,
  Raw,
  Run,
  RunContent,
  Table,
  TableCell,
  TableRow,
  Wrapper,
} from '../model/types.ts';
import { REL } from '../opc/package.ts';
import { child, cloneElement, el, elements, textContent, type XmlElement, type XmlNode } from '../xml/xml.ts';
import type { ReadContext, WriteContext } from './codec.ts';
import {
  readCellProperties,
  readParagraphProperties,
  readRowProperties,
  readRunProperties,
  readTableProperties,
  writeCellProperties,
  writeParagraphProperties,
  writeRowProperties,
  writeRunProperties,
  writeTableProperties,
} from './properties.ts';

/** Tables nested deeper than this are preserved as raw XML instead of modeled (Word allows ~63). */
const MAX_TABLE_DEPTH = 64;

export interface ContentWriteContext extends WriteContext {
  /** Allocates a document-unique id for new drawings (wp:docPr/@id). */
  nextDrawingId(): number;
}

const raw = (xml: XmlElement): Raw => ({ kind: 'raw', xml });

// --- Wrappers ----------------------------------------------------------------------------

const isProperties = (node: XmlNode) => typeof node !== 'string' && node.name.endsWith('Pr');

function readWrapper<T>(
  e: XmlElement,
  contentElement: string | null,
  readContent: (container: XmlElement) => T[],
): Wrapper<T> | Raw {
  if (contentElement) {
    const content = child(e, contentElement);
    if (!content) return raw(e);
    const shell: XmlElement = {
      name: e.name,
      attrs: e.attrs,
      children: e.children.map((c) => (c === content ? { name: content.name, attrs: content.attrs, children: [] } : c)),
    };
    return { kind: 'wrapper', shell, contentElement, children: readContent(content) };
  }
  const shell: XmlElement = { name: e.name, attrs: e.attrs, children: e.children.filter(isProperties) };
  const content: XmlElement = { name: e.name, attrs: e.attrs, children: e.children.filter((c) => !isProperties(c)) };
  return { kind: 'wrapper', shell, contentElement: null, children: readContent(content) };
}

function writeWrapper<T>(wrapper: Wrapper<T>, written: XmlElement[]): XmlElement {
  const shell = cloneElement(wrapper.shell);
  if (wrapper.contentElement) {
    const holder = shell.children.find((c): c is XmlElement => typeof c !== 'string' && c.name === wrapper.contentElement);
    if (holder) holder.children = written;
    else shell.children.push(el(wrapper.contentElement, {}, written));
  } else {
    shell.children.push(...written);
  }
  return shell;
}

// --- Blocks ------------------------------------------------------------------------------

export function readBlocks(container: XmlElement, ctx: ReadContext, depth = 0): Block[] {
  const blocks: Block[] = [];
  for (const e of elements(container)) {
    switch (e.name) {
      case 'w:p':
        blocks.push(readParagraph(e, ctx));
        break;
      case 'w:tbl':
        blocks.push(depth >= MAX_TABLE_DEPTH ? raw(e) : readTable(e, ctx, depth + 1));
        break;
      case 'w:sdt':
        blocks.push(readWrapper(e, 'w:sdtContent', (c) => readBlocks(c, ctx, depth)));
        break;
      case 'w:customXml':
        blocks.push(readWrapper(e, null, (c) => readBlocks(c, ctx, depth)));
        break;
      default:
        blocks.push(raw(e));
    }
  }
  return blocks;
}

export function writeBlocks(blocks: Block[], ctx: ContentWriteContext): XmlElement[] {
  return blocks.map((block) => writeBlock(block, ctx));
}

function writeBlock(block: Block, ctx: ContentWriteContext): XmlElement {
  switch (block.kind) {
    case 'paragraph':
      return writeParagraph(block, ctx);
    case 'table':
      return writeTable(block, ctx);
    case 'wrapper':
      return writeWrapper(block, writeBlocks(block.children, ctx));
    case 'raw':
      return block.xml;
  }
}

// --- Paragraphs --------------------------------------------------------------------------

export function readParagraph(e: XmlElement, ctx: ReadContext): Paragraph {
  const pPr = child(e, 'w:pPr');
  return {
    kind: 'paragraph',
    properties: pPr ? readParagraphProperties(pPr, ctx) : {},
    children: readInlines(e, ctx),
    attrs: { ...e.attrs },
  };
}

export function writeParagraph(p: Paragraph, ctx: ContentWriteContext): XmlElement {
  const pPr = writeParagraphProperties(p.properties, ctx);
  return el('w:p', p.attrs, [...(pPr ? [pPr] : []), ...writeInlines(p.children, ctx)]);
}

const INLINE_WRAPPERS = new Set([
  'w:ins',
  'w:del',
  'w:moveFrom',
  'w:moveTo',
  'w:smartTag',
  'w:customXml',
  'w:fldSimple',
  'w:dir',
  'w:bdo',
]);

export function readInlines(container: XmlElement, ctx: ReadContext): Inline[] {
  const inlines: Inline[] = [];
  for (const e of elements(container)) {
    if (e.name === 'w:pPr') continue;
    if (e.name === 'w:r') inlines.push(readRun(e, ctx));
    else if (e.name === 'w:hyperlink') inlines.push(readHyperlink(e, ctx));
    else if (e.name === 'w:sdt') inlines.push(readWrapper(e, 'w:sdtContent', (c) => readInlines(c, ctx)));
    else if (INLINE_WRAPPERS.has(e.name)) inlines.push(readWrapper(e, null, (c) => readInlines(c, ctx)));
    else inlines.push(raw(e));
  }
  return inlines;
}

export function writeInlines(inlines: Inline[], ctx: ContentWriteContext): XmlElement[] {
  return inlines.map((inline) => {
    switch (inline.kind) {
      case 'run':
        return writeRun(inline, ctx);
      case 'hyperlink':
        return writeHyperlink(inline, ctx);
      case 'wrapper':
        return writeWrapper(inline, writeInlines(inline.children, ctx));
      case 'raw':
        return inline.xml;
    }
  });
}

function readHyperlink(e: XmlElement, ctx: ReadContext): Hyperlink | Raw {
  const { 'r:id': id, 'w:anchor': anchor, ...attrs } = e.attrs;
  let url: string | undefined;
  if (id !== undefined) {
    const rel = ctx.rels.byId(id);
    if (!rel || !rel.external) return raw(e); // unresolvable: keep untouched
    url = rel.target;
  }
  return { kind: 'hyperlink', url, anchor, children: readInlines(e, ctx), attrs, relationshipId: id };
}

function writeHyperlink(link: Hyperlink, ctx: ContentWriteContext): XmlElement {
  const attrs: Record<string, string> = {};
  if (link.url !== undefined) {
    const existing = link.relationshipId !== undefined ? ctx.rels.byId(link.relationshipId) : undefined;
    attrs['r:id'] =
      existing?.external && existing.target === link.url ? existing.id : ctx.rels.add(REL.hyperlink, link.url, true);
  }
  if (link.anchor !== undefined) attrs['w:anchor'] = link.anchor;
  return el('w:hyperlink', { ...attrs, ...link.attrs }, writeInlines(link.children, ctx));
}

// --- Runs --------------------------------------------------------------------------------

export function readRun(e: XmlElement, ctx: ReadContext): Run {
  const content: RunContent[] = [];
  let properties = {};
  for (const c of elements(e)) {
    switch (c.name) {
      case 'w:rPr':
        properties = readRunProperties(c, ctx);
        break;
      case 'w:t':
        content.push({ kind: 'text', text: readText(c) });
        break;
      case 'w:tab':
        content.push({ kind: 'tab' });
        break;
      case 'w:br': {
        const { 'w:type': type, 'w:clear': clear, ...rest } = c.attrs;
        if (Object.keys(rest).length) content.push(raw(c));
        else content.push({ kind: 'break', type: type as never, clear: clear as never });
        break;
      }
      case 'w:cr':
        content.push({ kind: 'cr' });
        break;
      case 'w:noBreakHyphen':
        content.push({ kind: 'noBreakHyphen' });
        break;
      case 'w:softHyphen':
        content.push({ kind: 'softHyphen' });
        break;
      case 'w:sym':
        content.push({ kind: 'symbol', font: c.attrs['w:font'], char: c.attrs['w:char'] });
        break;
      case 'w:fldChar': {
        const type = c.attrs['w:fldCharType'];
        if (type === 'begin' || type === 'separate' || type === 'end') content.push({ kind: 'fieldChar', type, xml: c });
        else content.push(raw(c));
        break;
      }
      case 'w:instrText':
        content.push({ kind: 'instrText', text: readText(c) });
        break;
      case 'w:delText':
        content.push({ kind: 'delText', text: readText(c) });
        break;
      case 'w:drawing':
        content.push(readDrawing(c, ctx));
        break;
      default:
        content.push(raw(c));
    }
  }
  return { kind: 'run', properties, content, attrs: { ...e.attrs } };
}

/** Without xml:space="preserve", Word drops leading and trailing whitespace. */
function readText(e: XmlElement): string {
  const text = textContent(e);
  return e.attrs['xml:space'] === 'preserve' ? text : text.replace(/^[ \t\n]+|[ \t\n]+$/g, '');
}

/** xml:space="preserve" is needed when whitespace at the edges or runs of spaces must survive. */
function textElement(name: string, text: string): XmlElement {
  const preserve = /^\s|\s$|\s\s/.test(text) ? { 'xml:space': 'preserve' } : {};
  return el(name, preserve, text ? [text] : []);
}

export function writeRun(run: Run, ctx: ContentWriteContext): XmlElement {
  const children: XmlElement[] = [];
  const rPr = writeRunProperties(run.properties, ctx);
  if (rPr) children.push(rPr);
  for (const c of run.content) {
    switch (c.kind) {
      case 'text':
        children.push(textElement('w:t', c.text));
        break;
      case 'tab':
        children.push(el('w:tab'));
        break;
      case 'break':
        children.push(el('w:br', { 'w:type': c.type, 'w:clear': c.clear }));
        break;
      case 'cr':
        children.push(el('w:cr'));
        break;
      case 'noBreakHyphen':
        children.push(el('w:noBreakHyphen'));
        break;
      case 'softHyphen':
        children.push(el('w:softHyphen'));
        break;
      case 'symbol':
        children.push(el('w:sym', { 'w:font': c.font, 'w:char': c.char }));
        break;
      case 'fieldChar':
        children.push(writeFieldChar(c));
        break;
      case 'instrText':
        children.push(textElement('w:instrText', c.text));
        break;
      case 'delText':
        children.push(textElement('w:delText', c.text));
        break;
      case 'drawing':
        children.push(writeDrawing(c, ctx));
        break;
      case 'raw':
        children.push(c.xml);
        break;
    }
  }
  return el('w:r', run.attrs, children);
}

function writeFieldChar(c: FieldChar): XmlElement {
  if (c.xml.attrs['w:fldCharType'] === c.type) return c.xml;
  return { ...c.xml, attrs: { ...c.xml.attrs, 'w:fldCharType': c.type } };
}

// --- Drawings ----------------------------------------------------------------------------

function findDescendant(root: XmlElement, name: string): XmlElement | undefined {
  const stack: XmlElement[] = [root];
  while (stack.length) {
    const e = stack.pop()!;
    if (e.name === name) return e;
    for (let i = e.children.length - 1; i >= 0; i--) {
      const c = e.children[i];
      if (typeof c !== 'string') stack.push(c);
    }
  }
  return undefined;
}

export function readDrawing(e: XmlElement, ctx: ReadContext): Drawing | Raw {
  const container = child(e, 'wp:inline') ?? child(e, 'wp:anchor');
  const extent = container && child(container, 'wp:extent');
  if (!container || !extent) return raw(e);
  const docPr = child(container, 'wp:docPr');
  const blip = findDescendant(container, 'a:blip');
  const textBox = findDescendant(container, 'w:txbxContent');
  const rel = blip?.attrs['r:embed'] ? ctx.rels.byId(blip.attrs['r:embed']) : undefined;
  return {
    kind: 'drawing',
    inline: container.name === 'wp:inline',
    width: Number(extent.attrs.cx),
    height: Number(extent.attrs.cy),
    image: rel && !rel.external ? ctx.rels.partName(rel) : undefined,
    name: docPr?.attrs.name,
    description: docPr?.attrs.descr,
    ...(textBox && { textBox: readBlocks(textBox, ctx) }),
    xml: e,
  };
}

export function writeDrawing(d: Drawing, ctx: ContentWriteContext): XmlElement {
  if (!d.xml) return newPictureDrawing(d, ctx);
  const xml = cloneElement(d.xml);
  const container = child(xml, 'wp:inline') ?? child(xml, 'wp:anchor')!;
  const size = { cx: String(Math.round(d.width)), cy: String(Math.round(d.height)) };
  const extent = child(container, 'wp:extent')!;
  if (extent.attrs.cx !== size.cx || extent.attrs.cy !== size.cy) {
    extent.attrs = { ...extent.attrs, ...size };
    const spExtent = findDescendant(container, 'pic:spPr');
    const xfrmExt = spExtent && findDescendant(spExtent, 'a:ext');
    if (xfrmExt) xfrmExt.attrs = { ...xfrmExt.attrs, ...size };
  }
  const docPr = child(container, 'wp:docPr');
  if (docPr) {
    if (d.name !== undefined) docPr.attrs.name = d.name;
    if (d.description !== undefined) docPr.attrs.descr = d.description;
    else delete docPr.attrs.descr;
  }
  const textBox = d.textBox && findDescendant(container, 'w:txbxContent');
  if (textBox) textBox.children = writeBlocks(d.textBox!, ctx);
  if (d.image) {
    const blip = findDescendant(container, 'a:blip');
    if (blip) {
      const current = blip.attrs['r:embed'] ? ctx.rels.byId(blip.attrs['r:embed']) : undefined;
      if (!current || ctx.rels.partName(current) !== d.image) blip.attrs['r:embed'] = ctx.rels.add(REL.image, d.image);
    }
  }
  return xml;
}

/** A new inline picture, in the same shape Word produces. */
function newPictureDrawing(d: Drawing, ctx: ContentWriteContext): XmlElement {
  if (!d.image) throw new Error('new drawings must reference an image part');
  const id = ctx.nextDrawingId();
  const cx = String(Math.round(d.width));
  const cy = String(Math.round(d.height));
  const name = d.name ?? `Picture ${id}`;
  const rId = ctx.rels.add(REL.image, d.image);
  return el('w:drawing', {}, [
    el('wp:inline', { distT: 0, distB: 0, distL: 0, distR: 0 }, [
      el('wp:extent', { cx, cy }),
      el('wp:effectExtent', { l: 0, t: 0, r: 0, b: 0 }),
      el('wp:docPr', { id, name, descr: d.description }),
      el('wp:cNvGraphicFramePr', {}, [
        el('a:graphicFrameLocks', { 'xmlns:a': 'http://schemas.openxmlformats.org/drawingml/2006/main', noChangeAspect: 1 }),
      ]),
      el('a:graphic', { 'xmlns:a': 'http://schemas.openxmlformats.org/drawingml/2006/main' }, [
        el('a:graphicData', { uri: 'http://schemas.openxmlformats.org/drawingml/2006/picture' }, [
          el('pic:pic', { 'xmlns:pic': 'http://schemas.openxmlformats.org/drawingml/2006/picture' }, [
            el('pic:nvPicPr', {}, [el('pic:cNvPr', { id: 0, name }), el('pic:cNvPicPr')]),
            el('pic:blipFill', {}, [el('a:blip', { 'r:embed': rId }), el('a:stretch', {}, [el('a:fillRect')])]),
            el('pic:spPr', {}, [
              el('a:xfrm', {}, [el('a:off', { x: 0, y: 0 }), el('a:ext', { cx, cy })]),
              el('a:prstGeom', { prst: 'rect' }, [el('a:avLst')]),
            ]),
          ]),
        ]),
      ]),
    ]),
  ]);
}

// --- Tables ------------------------------------------------------------------------------

function readTable(e: XmlElement, ctx: ReadContext, depth: number): Table {
  const table: Table = { kind: 'table', properties: {}, grid: [], rows: [] };
  if (!child(e, 'w:tblGrid')) table.noGrid = true;
  for (const c of elements(e)) {
    if (c.name === 'w:tblPr') table.properties = readTableProperties(c, ctx);
    else if (c.name === 'w:tblGrid') {
      for (const g of elements(c)) {
        if (g.name === 'w:gridCol') table.grid.push(Number(g.attrs['w:w'] ?? 0));
        else (table.gridExtra ??= []).push(g);
      }
    } else if (c.name === 'w:tr') table.rows.push(readRow(c, ctx, depth));
    else table.rows.push(raw(c));
  }
  return table;
}

function readRow(e: XmlElement, ctx: ReadContext, depth: number): TableRow {
  const row: TableRow = { kind: 'row', properties: {}, cells: [], attrs: { ...e.attrs } };
  for (const c of elements(e)) {
    if (c.name === 'w:tblPrEx') row.exceptions = c;
    else if (c.name === 'w:trPr') row.properties = readRowProperties(c, ctx);
    else if (c.name === 'w:tc') row.cells.push(readCell(c, ctx, depth));
    else row.cells.push(raw(c));
  }
  return row;
}

function readCell(e: XmlElement, ctx: ReadContext, depth: number): TableCell {
  const tcPr = child(e, 'w:tcPr');
  const content: XmlElement = { name: e.name, attrs: e.attrs, children: e.children.filter((c) => c !== tcPr) };
  return {
    kind: 'cell',
    properties: tcPr ? readCellProperties(tcPr, ctx) : {},
    children: readBlocks(content, ctx, depth),
    attrs: { ...e.attrs },
  };
}

function writeTable(table: Table, ctx: ContentWriteContext): XmlElement {
  const grid =
    table.grid.length || table.gridExtra || !table.noGrid
      ? [el('w:tblGrid', {}, [...table.grid.map((w) => el('w:gridCol', { 'w:w': Math.round(w) })), ...(table.gridExtra ?? [])])]
      : [];
  const rows = table.rows.map((row) => (row.kind === 'raw' ? row.xml : writeRow(row, ctx)));
  return el('w:tbl', {}, [writeTableProperties(table.properties, ctx, true)!, ...grid, ...rows]);
}

function writeRow(row: TableRow, ctx: ContentWriteContext): XmlElement {
  const children: XmlElement[] = [];
  if (row.exceptions) children.push(row.exceptions);
  const trPr = writeRowProperties(row.properties, ctx);
  if (trPr) children.push(trPr);
  for (const cell of row.cells) children.push(cell.kind === 'raw' ? cell.xml : writeCell(cell, ctx));
  return el('w:tr', row.attrs, children);
}

function writeCell(cell: TableCell, ctx: ContentWriteContext): XmlElement {
  const tcPr = writeCellProperties(cell.properties, ctx);
  const blocks = writeBlocks(cell.children, ctx);
  // A cell needs at least one paragraph. Existing content is left exactly as it was.
  if (!blocks.length) blocks.push(el('w:p'));
  return el('w:tc', cell.attrs, [...(tcPr ? [tcPr] : []), ...blocks]);
}
