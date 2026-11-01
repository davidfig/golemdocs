// Writing a pivot table refreshed here (docs/spreadsheets.md, M6). Its cells are in the sheet already; its parts are
// brought in line with them: the table's location and its row and column fields' items (in the new order), and its laid-out
// rows and columns (rowItems, colItems) taken away, since Excel lays them out again; the cache's values for those fields,
// marked to be refreshed when the workbook opens, and its records (now stale) dropped. Everything else in both parts stays.

import { el, elements, serializeXml } from '@golemdocs/docx';
import type { OpcPackage, XmlElement } from '@golemdocs/docx';
import type { CacheField, PivotTable } from './pivot.ts';
import { rangeName } from './refs.ts';

const TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
const local = (e: XmlElement) => e.name.slice(e.name.indexOf(':') + 1);
const kid = (e: XmlElement | undefined, name: string) => (e ? [...elements(e)].find((c) => local(c) === name) : undefined);
const kids = (e: XmlElement | undefined, name: string) => (e ? [...elements(e)].filter((c) => local(c) === name) : []);

/** A cache field's `<sharedItems>`, with the flags Excel needs for the kinds of values in it. */
function sharedItems(old: XmlElement | undefined, values: CacheField['shared']): XmlElement {
  const prefix = old ? old.name.slice(0, old.name.indexOf(':') + 1) : '';
  const numbers = values.filter((v): v is number => typeof v === 'number');
  const strings = values.some((v) => typeof v === 'string' || typeof v === 'boolean');
  const blank = values.includes(null);
  const attrs: Record<string, string | number> = {};
  if (numbers.length) {
    if (!strings) {
      attrs.containsSemiMixedTypes = 0;
      attrs.containsString = 0;
    } else attrs.containsMixedTypes = 1;
    attrs.containsNumber = 1;
    if (numbers.every(Number.isInteger)) attrs.containsInteger = 1;
    attrs.minValue = Math.min(...numbers);
    attrs.maxValue = Math.max(...numbers);
  }
  if (blank) attrs.containsBlank = 1;
  attrs.count = values.length;
  return el(
    `${prefix}sharedItems`,
    attrs,
    values.map((v) => (v === null ? el(`${prefix}m`) : typeof v === 'number' ? el(`${prefix}n`, { v }) : typeof v === 'boolean' ? el(`${prefix}b`, { v: v ? 1 : 0 }) : el(`${prefix}s`, { v }))),
  );
}

/** Writes the parts of a sheet's pivot tables that were refreshed here. */
export async function writePivots(pkg: OpcPackage, pivots: PivotTable[]): Promise<void> {
  const caches = new Map<string, PivotTable>();
  for (const p of pivots) {
    if (!p.refreshed || !pkg.has(p.part)) continue;
    const root = await pkg.xml(p.part);
    const prefix = root.name.slice(0, root.name.indexOf(':') + 1);
    const location = kid(root, 'location');
    if (location) {
      location.attrs.ref = rangeName(p.location);
      const twoRows = p.colFields.some((f) => f !== -2) || p.dataFields.length > 1;
      location.attrs.firstHeaderRow = '1';
      location.attrs.firstDataRow = twoRows ? '2' : '1';
      location.attrs.firstDataCol = '1';
    }
    const axis = new Set([...p.rowFields, ...p.colFields.filter((f) => f !== -2)]);
    kids(kid(root, 'pivotFields'), 'pivotField').forEach((f, i) => {
      if (!axis.has(i)) return;
      const items = p.fields[i].items.map((x) => el(`${prefix}item`, { x }));
      if (p.fields[i].subtotal) items.push(el(`${prefix}item`, { t: 'default' }));
      const list = el(`${prefix}items`, { count: items.length }, items);
      const at = f.children.findIndex((c) => typeof c !== 'string' && local(c) === 'items');
      if (at >= 0) f.children[at] = list;
      else f.children.unshift(list);
    });
    root.children = root.children.filter((c) => typeof c === 'string' || (local(c) !== 'rowItems' && local(c) !== 'colItems'));
    pkg.set(p.part, serializeXml(root), `${TYPE}.pivotTable+xml`);
    caches.set(p.cache.part, p);
  }
  for (const [part, p] of caches) {
    if (!pkg.has(part)) continue;
    const root = await pkg.xml(part);
    const axis = new Set([...p.rowFields, ...p.colFields.filter((f) => f !== -2)]);
    kids(kid(root, 'cacheFields'), 'cacheField').forEach((f, i) => {
      if (!axis.has(i)) return;
      const old = kid(f, 'sharedItems');
      const made = sharedItems(old, p.cache.fields[i].shared);
      const at = f.children.findIndex((c) => c === old);
      if (at >= 0) f.children[at] = made;
      else f.children.push(made);
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
}
