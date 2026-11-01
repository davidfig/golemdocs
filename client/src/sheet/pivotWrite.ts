// Writing a pivot table refreshed or changed here (docs/spreadsheets.md, M6). Its cells are in the sheet already; its
// parts are brought in line with the model: the table's location, its fields' places (each field's other settings kept
// as read), its row, column, filter and value fields, and its laid-out rows and columns (rowItems, colItems) taken away,
// since Excel lays them out again; the cache's values for the fields with items and what kinds of values the others hold,
// marked to be refreshed when the workbook opens, its records (now stale) dropped. A pivot made here gets both parts
// written whole, its relationships, and the workbook's `<pivotCaches>` entry for its cache.

import { el, elements, serializeXml } from '@golemdocs/docx';
import type { OpcPackage, XmlElement } from '@golemdocs/docx';
import type { Workbook } from './model/workbook.ts';
import type { Worksheet } from './model/worksheet.ts';
import type { CacheField, PivotTable } from './pivot.ts';
import { rangeName } from './refs.ts';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
const local = (e: XmlElement) => e.name.slice(e.name.indexOf(':') + 1);
const kid = (e: XmlElement | undefined, name: string) => (e ? [...elements(e)].find((c) => local(c) === name) : undefined);
const kids = (e: XmlElement | undefined, name: string) => (e ? [...elements(e)].filter((c) => local(c) === name) : []);

/** A pivot table definition's children, in the schema's order. */
const TABLE_ORDER = ['location', 'pivotFields', 'rowFields', 'rowItems', 'colFields', 'colItems', 'pageFields', 'dataFields', 'formats', 'conditionalFormats', 'chartFormats', 'pivotHierarchies', 'pivotTableStyleInfo', 'filters', 'rowHierarchiesUsage', 'colHierarchiesUsage', 'extLst'];

/** Puts a child in its place (by the order given), replacing one of its name; null takes it away. */
function setChild(root: XmlElement, name: string, child: XmlElement | null, order: string[]): void {
  const at = root.children.findIndex((c) => typeof c !== 'string' && local(c) === name);
  if (at >= 0) {
    if (child) root.children[at] = child;
    else root.children.splice(at, 1);
    return;
  }
  if (!child) return;
  const rank = order.indexOf(name);
  const next = root.children.findIndex((c) => typeof c !== 'string' && order.indexOf(local(c)) > rank);
  root.children.splice(next < 0 ? root.children.length : next, 0, child);
}

/** A cache field's `<sharedItems>`: its values (for a field with items), or only the kinds of values it holds. */
function sharedItems(prefix: string, field: CacheField, withValues: boolean): XmlElement {
  const values = withValues ? field.shared : [];
  const numbers = withValues ? values.filter((v): v is number => typeof v === 'number') : [];
  const s = field.summary;
  const hasNumbers = withValues ? numbers.length > 0 : !!s?.numbers;
  const hasStrings = withValues ? values.some((v) => typeof v === 'string' || typeof v === 'boolean') : (s?.strings ?? true);
  const blank = withValues ? values.includes(null) : !!s?.blank;
  const attrs: Record<string, string | number> = {};
  if (hasNumbers) {
    if (!hasStrings) {
      attrs.containsSemiMixedTypes = 0;
      attrs.containsString = 0;
    } else attrs.containsMixedTypes = 1;
    attrs.containsNumber = 1;
    if (withValues ? numbers.every(Number.isInteger) : s?.integers) attrs.containsInteger = 1;
    const min = withValues ? Math.min(...numbers) : s?.min;
    const max = withValues ? Math.max(...numbers) : s?.max;
    if (min !== null && min !== undefined) attrs.minValue = min;
    if (max !== null && max !== undefined) attrs.maxValue = max;
  }
  if (blank) attrs.containsBlank = 1;
  if (!withValues) return el(`${prefix}sharedItems`, attrs);
  attrs.count = values.length;
  return el(
    `${prefix}sharedItems`,
    attrs,
    values.map((v) => (v === null ? el(`${prefix}m`) : typeof v === 'number' ? el(`${prefix}n`, { v }) : typeof v === 'boolean' ? el(`${prefix}b`, { v: v ? 1 : 0 }) : el(`${prefix}s`, { v }))),
  );
}

/** A table definition brought in line with the model (see the top of the file). */
function syncTable(root: XmlElement, p: PivotTable): void {
  const prefix = root.name.slice(0, root.name.indexOf(':') + 1);
  const e = (name: string, attrs: Record<string, string | number | undefined> = {}, children: XmlElement[] = []) => el(`${prefix}${name}`, attrs, children);
  const location = kid(root, 'location') ?? e('location');
  location.attrs.ref = rangeName(p.location);
  const twoRows = p.colFields.length > 0;
  location.attrs.firstHeaderRow = '1';
  location.attrs.firstDataRow = String(twoRows ? 1 + p.colFields.length : 1);
  location.attrs.firstDataCol = '1';
  if (p.pageFields.length) {
    location.attrs.rowPageCount = String(p.pageFields.length);
    location.attrs.colPageCount = '1';
  } else {
    delete location.attrs.rowPageCount;
    delete location.attrs.colPageCount;
  }
  setChild(root, 'location', location, TABLE_ORDER);
  const old = kids(kid(root, 'pivotFields'), 'pivotField');
  const axisName = { row: 'axisRow', col: 'axisCol', page: 'axisPage' } as const;
  const dataFieldSet = new Set(p.dataFields.map((d) => d.field));
  const fields = p.fields.map((f, i) => {
    const field = old[i] ? structuredClone(old[i]) : e('pivotField', { showAll: 0 });
    if (f.axis) field.attrs.axis = axisName[f.axis];
    else delete field.attrs.axis;
    if (dataFieldSet.has(i)) field.attrs.dataField = '1';
    else delete field.attrs.dataField;
    const at = field.children.findIndex((c) => typeof c !== 'string' && local(c) === 'items');
    if (f.axis) {
      const items = f.items.map((x) => e('item', { x }));
      if (f.subtotal) items.push(e('item', { t: 'default' }));
      const list = e('items', { count: items.length }, items);
      if (at >= 0) field.children[at] = list;
      else field.children.unshift(list);
    } else if (at >= 0) field.children.splice(at, 1);
    return field;
  });
  setChild(root, 'pivotFields', e('pivotFields', { count: fields.length }, fields), TABLE_ORDER);
  const list = (name: string, xs: number[]) => (xs.length ? e(name, { count: xs.length }, xs.map((x) => e('field', { x }))) : null);
  setChild(root, 'rowFields', list('rowFields', p.rowFields), TABLE_ORDER);
  setChild(root, 'colFields', list('colFields', p.colFields), TABLE_ORDER);
  setChild(root, 'rowItems', null, TABLE_ORDER);
  setChild(root, 'colItems', null, TABLE_ORDER);
  setChild(root, 'pageFields', p.pageFields.length ? e('pageFields', { count: p.pageFields.length }, p.pageFields.map((f) => e('pageField', { fld: f.field, item: f.item ?? undefined, hier: -1 }))) : null, TABLE_ORDER);
  const oldData = kids(kid(root, 'dataFields'), 'dataField');
  const data = p.dataFields.map((d, i) => {
    const kept = oldData[i] && +(oldData[i].attrs.fld ?? -1) === d.field ? structuredClone(oldData[i]) : e('dataField', { baseField: 0, baseItem: 0 });
    kept.attrs.name = d.name;
    kept.attrs.fld = String(d.field);
    if (d.fn === 'sum') delete kept.attrs.subtotal;
    else kept.attrs.subtotal = d.fn;
    return kept;
  });
  setChild(root, 'dataFields', data.length ? e('dataFields', { count: data.length }, data) : null, TABLE_ORDER);
  if (p.rowFields.includes(-2)) root.attrs.dataOnRows = '1';
  else delete root.attrs.dataOnRows;
}

/** A cache brought in line with the model: its fields' values, refreshed when opened, its records dropped. */
async function syncCache(pkg: OpcPackage, part: string, root: XmlElement, p: PivotTable): Promise<void> {
  const prefix = root.name.slice(0, root.name.indexOf(':') + 1);
  const withItems = new Set(p.fields.flatMap((f, i) => (f.axis ? [i] : [])));
  const fields = kids(kid(root, 'cacheFields'), 'cacheField');
  p.cache.fields.forEach((f, i) => {
    const field = fields[i];
    if (!field) return;
    // A field with items lists its values; so does one that lists them already (another pivot of the same cache may
    // use it: the model's values are those and any new ones after them). Another only says what it holds.
    const old = kid(field, 'sharedItems');
    const listed = !!old && [...elements(old)].length > 0 && f.shared.length >= [...elements(old)].length;
    const withValues = withItems.has(i) || listed;
    if (!withValues && (!f.summary || (old && [...elements(old)].length))) return;
    const made = sharedItems(prefix, f, withValues);
    const at = field.children.findIndex((c) => c === old);
    if (at >= 0) field.children[at] = made;
    else field.children.push(made);
  });
  root.attrs.refreshOnLoad = '1';
  // The records were the old source's: they go, and Excel reads the source when it refreshes.
  const rels = await pkg.relationships(part);
  for (const rel of rels.list.filter((r) => r.type.endsWith('/pivotCacheRecords'))) {
    pkg.delete(rels.partName(rel));
    rels.remove(rel.id);
  }
  delete root.attrs['r:id'];
  root.attrs.saveData = '0';
  pkg.set(part, serializeXml(root), `${TYPE}.pivotCacheDefinition+xml`);
}

/** A new cache's part: its source and its fields (their values filled in by `syncCache`). */
function newCache(p: PivotTable): XmlElement {
  return el('pivotCacheDefinition', { xmlns: MAIN, 'xmlns:r': REL, refreshOnLoad: 1, saveData: 0, createdVersion: 6, refreshedVersion: 6, minRefreshableVersion: 3, recordCount: 0 }, [
    el('cacheSource', { type: 'worksheet' }, [el('worksheetSource', { ref: p.cache.ref, sheet: p.cache.sheet })]),
    el('cacheFields', { count: p.cache.fields.length }, p.cache.fields.map((f) => el('cacheField', { name: f.name, numFmtId: 0 }, [el('sharedItems')]))),
  ]);
}

/** A new table's part: its name, cache and look (its fields filled in by `syncTable`). */
function newTable(p: PivotTable, cacheId: number): XmlElement {
  return el(
    'pivotTableDefinition',
    {
      xmlns: MAIN,
      name: p.name,
      cacheId,
      applyNumberFormats: 0,
      applyBorderFormats: 0,
      applyFontFormats: 0,
      applyPatternFormats: 0,
      applyAlignmentFormats: 0,
      applyWidthHeightFormats: 1,
      dataCaption: p.dataCaption,
      updatedVersion: 6,
      minRefreshableVersion: 3,
      useAutoFormatting: 1,
      itemPrintTitles: 1,
      createdVersion: 6,
      indent: 0,
      outline: 1,
      outlineData: 1,
      multipleFieldFilters: 0,
    },
    [el('location', { ref: rangeName(p.location) }), el('pivotTableStyleInfo', { name: 'PivotStyleLight16', showRowHeaders: 1, showColHeaders: 1, showRowStripes: 0, showColStripes: 0, showLastColumn: 1 })],
  );
}

/** The workbook's `<pivotCaches>`, made when it has none. */
function pivotCaches(book: Workbook): XmlElement {
  const root = book.source!.workbookXml;
  let caches = kid(root, 'pivotCaches');
  if (!caches) {
    caches = el('pivotCaches');
    // After the calculation settings and anything Excel puts between them and the caches.
    const after = ['fileVersion', 'fileSharing', 'workbookPr', 'workbookProtection', 'bookViews', 'sheets', 'functionGroups', 'externalReferences', 'definedNames', 'calcPr', 'oleSize', 'customWorkbookViews'];
    let index = 0;
    root.children.forEach((c, k) => {
      if (typeof c !== 'string' && after.includes(local(c))) index = k + 1;
    });
    root.children.splice(index, 0, caches);
  }
  return caches;
}

/** Writes the parts of a sheet's pivot tables refreshed or changed here, making the parts of new ones. */
export async function writePivots(pkg: OpcPackage, book: Workbook, sheetPart: string, sheet: Worksheet): Promise<void> {
  const synced = new Set<string>();
  sheet.pivots = await Promise.all(
    sheet.pivots.map(async (p) => {
      if (!p.refreshed) return p;
      let pivot = p;
      if (!pivot.cache.part) {
        // A new cache: its part, the workbook's relationship to it, and its entry in <pivotCaches> under a new id.
        const part = pkg.uniqueName('xl/pivotCache/pivotCacheDefinition', 'xml');
        pkg.set(part, serializeXml(newCache(pivot)), `${TYPE}.pivotCacheDefinition+xml`);
        const rId = (await pkg.relationships(book.source!.workbookPart)).add(`${REL}/pivotCacheDefinition`, part);
        const caches = pivotCaches(book);
        const cacheId = Math.max(0, ...kids(caches, 'pivotCache').map((c) => +(c.attrs.cacheId ?? 0))) + 1;
        caches.children.push(el(`${caches.name.slice(0, caches.name.indexOf(':') + 1)}pivotCache`, { cacheId, 'r:id': rId }));
        if (!book.source!.workbookXml.attrs['xmlns:r']) book.source!.workbookXml.attrs['xmlns:r'] = REL;
        book.dirty = true;
        pivot = { ...pivot, cache: { ...pivot.cache, part, id: cacheId } };
      }
      if (!pivot.part) {
        const part = pkg.uniqueName('xl/pivotTables/pivotTable', 'xml');
        pkg.set(part, serializeXml(newTable(pivot, pivot.cache.id ?? 1)), `${TYPE}.pivotTable+xml`);
        (await pkg.relationships(sheetPart)).add(`${REL}/pivotTable`, part);
        (await pkg.relationships(part)).add(`${REL}/pivotCacheDefinition`, pivot.cache.part);
        pivot = { ...pivot, part };
      }
      const table = await pkg.xml(pivot.part);
      syncTable(table, pivot);
      pkg.set(pivot.part, serializeXml(table), `${TYPE}.pivotTable+xml`);
      if (!synced.has(pivot.cache.part) && pkg.has(pivot.cache.part)) {
        synced.add(pivot.cache.part);
        await syncCache(pkg, pivot.cache.part, await pkg.xml(pivot.cache.part), pivot);
      }
      return pivot;
    }),
  );
}
