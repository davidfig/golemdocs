// The small XML around a worksheet's cells (before `<sheetData>`: sheetPr, dimension, sheetViews, sheetFormatPr, cols; after
// `</sheetData>`: mergeCells, conditional formats, validation, hyperlinks, page setup, drawing...). The scanner keeps it as
// bytes; this reads what the model holds from it, and rebuilds it when the model changed something in it, keeping every
// element it does not model and Excel's required element order. See docs/spreadsheets.md, "Reading and writing .xlsx".

import { child, el, elements, parseXml, serializeXml } from '@golemdocs/docx';
import type { XmlElement } from '@golemdocs/docx';
import { charsToPoints, pointsToChars } from '../model/worksheet.ts';
import type { Worksheet } from '../model/worksheet.ts';
import { cellName, parseCell, parseRange, rangeName } from '../refs.ts';
import { conditionalElement, readConditional } from '../conditional.ts';
import { autoFilterElement, readAutoFilter } from '../filter.ts';
import { readValidations, validationsElement } from '../validation.ts';

const decoder = new TextDecoder();

/** The order CT_Worksheet requires its children in. */
const ORDER = [
  'sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData', 'sheetCalcPr', 'sheetProtection', 'protectedRanges', 'scenarios',
  'autoFilter', 'sortState', 'dataConsolidate', 'customSheetViews', 'mergeCells', 'phoneticPr', 'conditionalFormatting', 'dataValidations',
  'hyperlinks', 'printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks', 'customProperties', 'cellWatches',
  'ignoredErrors', 'smartTags', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'drawingHF', 'picture', 'oleObjects', 'controls',
  'webPublishItems', 'tableParts', 'extLst',
];

/** The worksheet's root element and its children other than sheetData, from the bytes around the cells. */
export function parseAround(prefix: Uint8Array, suffix: Uint8Array): XmlElement {
  const head = decoder.decode(prefix);
  const tail = decoder.decode(suffix);
  // The prefix ends with `<sheetData>` (or not at all, for `<sheetData/>`); make it a whole document with the tail.
  const open = head.replace(/<([\w]+:)?sheetData[^>]*>\s*$/, '');
  const close = tail.replace(/^\s*<\/([\w]+:)?sheetData>/, '').replace(/^\s*<([\w]+:)?sheetData\s*\/>/, '');
  const root = parseXml(open + '<sheetData/>' + close);
  return root;
}

/** Reads what the model holds from the XML around the cells. */
export function readAround(sheet: Worksheet, root: XmlElement): void {
  const format = child(root, 'sheetFormatPr');
  if (format) {
    if (format.attrs.defaultRowHeight) sheet.rowSizes.setDefault(+format.attrs.defaultRowHeight);
    if (format.attrs.defaultColWidth) sheet.colSizes.setDefault(charsToPoints(+format.attrs.defaultColWidth));
    else if (format.attrs.baseColWidth) sheet.colSizes.setDefault(charsToPoints(Math.ceil((+format.attrs.baseColWidth * 7 + 5) / 8) * 8 / 7));
  }
  for (const col of elements(child(root, 'cols') ?? el('x'))) {
    const min = +(col.attrs.min ?? 1) - 1;
    const max = Math.min(+(col.attrs.max ?? col.attrs.min ?? 1) - 1, sheet.colSizes.count - 1);
    // A <col> over the whole sheet (min 1, max 16384) is a style or width for every column: it becomes the default.
    const all = min === 0 && max >= sheet.colSizes.count - 1;
    for (let c = min; c <= max; c++) {
      if (col.attrs.width !== undefined && (col.attrs.customWidth === '1' || col.attrs.customWidth === 'true' || !all)) {
        if (all) {
          sheet.colSizes.setDefault(charsToPoints(+col.attrs.width));
          break;
        }
        sheet.colSizes.set(c, charsToPoints(+col.attrs.width));
      }
      if (col.attrs.hidden === '1' || col.attrs.hidden === 'true') sheet.colSizes.setHidden(c, true);
      if (col.attrs.style && col.attrs.style !== '0') sheet.colStyles.set(c, +col.attrs.style);
      const level = +(col.attrs.outlineLevel ?? 0);
      if (level || col.attrs.collapsed === '1') sheet.colOutline.set(c, { level, collapsed: col.attrs.collapsed === '1' });
      if (all && !col.attrs.style && !col.attrs.hidden) break;
    }
  }
  const view = child(child(root, 'sheetViews') ?? el('x'), 'sheetView');
  if (view) {
    if (view.attrs.showGridLines === '0' || view.attrs.showGridLines === 'false') sheet.view.gridlines = false;
    if (view.attrs.zoomScale) sheet.view.zoom = +view.attrs.zoomScale;
    if (view.attrs.rightToLeft === '1') sheet.view.rightToLeft = true;
    const pane = child(view, 'pane');
    if (pane && (pane.attrs.state === 'frozen' || pane.attrs.state === 'frozenSplit')) sheet.pane = { rows: +(pane.attrs.ySplit ?? 0), cols: +(pane.attrs.xSplit ?? 0) };
    const selection = [...elements(view)].filter((e) => e.name === 'selection').pop();
    const active = selection?.attrs.activeCell && parseCell(selection.attrs.activeCell);
    if (active) sheet.view.active = active;
  }
  sheet.conditional = readConditional(root);
  sheet.autoFilter = readAutoFilter(root);
  sheet.validations = readValidations(root);
  for (const merge of elements(child(root, 'mergeCells') ?? el('x'))) {
    const range = merge.attrs.ref && parseRange(merge.attrs.ref);
    if (range) sheet.merges.push(range);
  }
}

/**
 * The XML around the cells, rebuilt from the model where the model changed it (layout: column widths and styles, frozen
 * panes, merges, the dimension), everything else as it was.
 */
export function writeAround(sheet: Worksheet, root: XmlElement): { head: string; tail: string } {
  const set = (name: string, element: XmlElement | null) => {
    const at = root.children.findIndex((c) => typeof c !== 'string' && c.name === name);
    if (at >= 0) {
      if (element) root.children[at] = element;
      else root.children.splice(at, 1);
      return;
    }
    if (!element) return;
    const order = ORDER.indexOf(name);
    const next = root.children.findIndex((c) => typeof c !== 'string' && ORDER.indexOf(c.name) > order);
    root.children.splice(next < 0 ? root.children.length : next, 0, element);
  };
  const extent = sheet.grid;
  set('dimension', el('dimension', { ref: extent.rows && extent.cols ? `A1:${cellName(extent.rows - 1, extent.cols - 1)}` : 'A1' }));
  // Frozen panes: replace the first view's pane, keeping the view's other settings.
  const views = child(root, 'sheetViews') ?? el('sheetViews', {}, [el('sheetView', { workbookViewId: 0 })]);
  const view = child(views, 'sheetView')!;
  view.children = view.children.filter((c) => typeof c === 'string' || c.name !== 'pane');
  if (sheet.pane && (sheet.pane.rows || sheet.pane.cols)) {
    const { rows, cols } = sheet.pane;
    const activePane = rows && cols ? 'bottomRight' : rows ? 'bottomLeft' : 'topRight';
    view.children.unshift(el('pane', { xSplit: cols || undefined, ySplit: rows || undefined, topLeftCell: cellName(rows, cols), activePane, state: 'frozen' }));
    for (const s of elements(view)) if (s.name === 'selection' && !s.attrs.pane) s.attrs.pane = activePane;
  }
  if (!sheet.view.gridlines) view.attrs.showGridLines = '0';
  else delete view.attrs.showGridLines;
  set('sheetViews', views);
  const format = child(root, 'sheetFormatPr') ?? el('sheetFormatPr', {});
  format.attrs.defaultRowHeight = String(sheet.rowSizes.default);
  set('sheetFormatPr', format);
  set('cols', colsXml(sheet));
  set('autoFilter', sheet.autoFilter ? autoFilterElement(sheet.autoFilter) : null);
  set('tableParts', sheet.tables.length && sheet.tables.every((t) => t.rId) ? el('tableParts', { count: sheet.tables.length }, sheet.tables.map((t) => el('tablePart', { 'r:id': t.rId }))) : null);
  set('dataValidations', validationsElement(sheet.validations));
  // Conditional formats, from the model (their ranges and formulas move with inserted and deleted rows and columns).
  const cfAt = root.children.findIndex((c) => typeof c !== 'string' && c.name === 'conditionalFormatting');
  root.children = root.children.filter((c) => typeof c === 'string' || c.name !== 'conditionalFormatting');
  if (sheet.conditional.length) {
    const order = ORDER.indexOf('conditionalFormatting');
    const next = cfAt >= 0 ? cfAt : root.children.findIndex((c) => typeof c !== 'string' && ORDER.indexOf(c.name) > order);
    root.children.splice(next < 0 ? root.children.length : next, 0, ...sheet.conditional.map(conditionalElement));
  }
  set('mergeCells', sheet.merges.length ? el('mergeCells', { count: sheet.merges.length }, sheet.merges.map((m) => el('mergeCell', { ref: rangeName(m) }))) : null);
  const xml = serializeXml(root);
  const at = xml.search(/<sheetData\s*\/>/);
  return { head: xml.slice(0, at) + '<sheetData>', tail: '</sheetData>' + xml.slice(at).replace(/^<sheetData\s*\/>/, '') };
}

/** `<cols>`: runs of columns with the same width, hidden flag, style and outline. */
function colsXml(sheet: Worksheet): XmlElement | null {
  const special = new Set<number>([...sheet.colSizes.specials(), ...sheet.colStyles.keys(), ...sheet.colOutline.keys()]);
  const cols = [...special].sort((a, b) => a - b);
  const out: XmlElement[] = [];
  const describe = (c: number) => {
    const outline = sheet.colOutline.get(c);
    return {
      width: pointsToChars(sheet.colSizes.ownSize(c)),
      customWidth: sheet.colSizes.custom(c) ? 1 : undefined,
      hidden: sheet.colSizes.hidden(c) ? 1 : undefined,
      style: sheet.colStyles.get(c),
      outlineLevel: outline?.level || undefined,
      collapsed: outline?.collapsed ? 1 : undefined,
    };
  };
  for (let i = 0; i < cols.length; ) {
    const start = cols[i];
    const attrs = describe(start);
    const key = JSON.stringify(attrs);
    let end = start;
    while (i + 1 < cols.length && cols[i + 1] === end + 1 && JSON.stringify(describe(cols[i + 1])) === key) end = cols[++i];
    i++;
    out.push(el('col', { min: start + 1, max: end + 1, ...attrs }));
  }
  return out.length ? el('cols', {}, out) : null;
}
