// Schema-driven reading and writing of property elements (w:rPr, w:pPr, w:tblPr, ...).
//
// Each schema lists the element's children in the order the OOXML schema requires. Word
// rejects out-of-order children, so the writer always emits in that order, slotting preserved
// (unmodeled) elements back in: by their own schema position when known, otherwise directly
// after the element they followed in the original file.

import type { Relationships } from '../opc/package.ts';
import type { Preserved } from '../model/types.ts';
import { parseMeasure, type Unit } from '../model/units.ts';
import { el, elements, type XmlElement } from '../xml/xml.ts';

export interface ReadContext {
  /** Relationships of the part being read (to resolve r:id references). */
  rels: Relationships;
}

export interface WriteContext {
  /** Relationships of the part being written (new references are added here). */
  rels: Relationships;
}

export type AttrType = Unit | 'string' | 'bool';
export type AttrSpec = Record<string, AttrType>;

export interface Field {
  /** Qualified element name, e.g. "w:b". */
  name: string;
  /** Property key in the model object. */
  key: string;
  /** Returns undefined if the element can't be modeled; it is then preserved verbatim. */
  read(element: XmlElement, ctx: ReadContext): unknown;
  write(value: any, ctx: WriteContext): XmlElement | XmlElement[] | undefined;
}

export class Schema {
  readonly byName: Map<string, Field>;
  readonly order: Map<string, number>;

  /** `order` lists every child element name in schema sequence, modeled or not. */
  constructor(
    readonly fields: Field[],
    order: string[],
  ) {
    this.byName = new Map(fields.map((f) => [f.name, f]));
    this.order = new Map(order.map((name, i) => [name, i]));
    for (const field of fields) {
      if (!this.order.has(field.name)) throw new Error(`schema order is missing ${field.name}`);
    }
  }
}

export function parseOnOff(value: string | undefined): boolean {
  return value === undefined || !(value === '0' || value === 'false' || value === 'off');
}

/**
 * Reads attributes: w:-prefixed ones in `spec` become typed fields under their local name,
 * everything else is kept under its qualified name (":name" for unprefixed attributes).
 */
export function readAttrs(element: XmlElement, spec: AttrSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const qualified in element.attrs) {
    const raw = element.attrs[qualified];
    const colon = qualified.indexOf(':');
    if (colon < 0) {
      out[`:${qualified}`] = raw;
      continue;
    }
    const local = qualified.slice(colon + 1);
    const type = qualified.startsWith('w:') ? spec[local] : undefined;
    if (type === undefined) out[qualified] = raw;
    else if (type === 'string') out[local] = raw;
    else if (type === 'bool') out[local] = parseOnOff(raw);
    else {
      const n = parseMeasure(raw, type);
      if (n === undefined) out[qualified] = raw;
      else out[local] = n;
    }
  }
  return out;
}

export function writeAttrs(value: Record<string, unknown>, spec: AttrSpec): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const key in value) {
    const v = value[key];
    if (v === undefined || key === 'extra') continue;
    if (key.startsWith(':')) attrs[key.slice(1)] = String(v);
    else if (key.includes(':')) attrs[key] = String(v);
    else if (key in spec) attrs[`w:${key}`] = spec[key] === 'bool' ? (v ? '1' : '0') : String(v);
  }
  return attrs;
}

/** Reads a property container's children into a model object. */
export function readProps<T>(
  schema: Schema,
  container: XmlElement,
  ctx: ReadContext,
  special?: (child: XmlElement, out: any) => boolean,
): T {
  const out: any = {};
  let lastKnown: string | null = null;
  for (const child of elements(container)) {
    if (special?.(child, out)) {
      lastKnown = child.name;
      continue;
    }
    const field = schema.byName.get(child.name);
    const value = field ? field.read(child, ctx) : undefined;
    if (field && value !== undefined && out[field.key] === undefined) {
      out[field.key] = value;
      lastKnown = child.name;
    } else {
      (out.extra ??= []).push({ xml: child, after: lastKnown } satisfies Preserved);
    }
  }
  return out as T;
}

/** Orders children by schema position; preserved elements keep their place. */
export function orderChildren(schema: Schema, known: XmlElement[], extra: Preserved[] | undefined): XmlElement[] {
  if (!extra?.length) return known.sort((a, b) => (schema.order.get(a.name) ?? 0) - (schema.order.get(b.name) ?? 0));
  const keyed: { key: number; seq: number; xml: XmlElement }[] = [];
  let seq = 0;
  for (const xml of known) keyed.push({ key: schema.order.get(xml.name) ?? Infinity, seq: seq++, xml });
  for (const item of extra) {
    const own = schema.order.get(item.xml.name);
    const key = own ?? (item.after === null ? -0.5 : (schema.order.get(item.after) ?? Infinity) + 0.5);
    keyed.push({ key, seq: seq++, xml: item.xml });
  }
  keyed.sort((a, b) => a.key - b.key || a.seq - b.seq);
  return keyed.map((k) => k.xml);
}

/** Writes a model object as a property container, or undefined if there's nothing to write. */
export function writeProps(
  schema: Schema,
  name: string,
  props: any,
  ctx: WriteContext,
  options: { attrs?: Record<string, string>; prepend?: XmlElement[]; keepEmpty?: boolean } = {},
): XmlElement | undefined {
  if (!props) return undefined;
  const known: XmlElement[] = [...(options.prepend ?? [])];
  for (const field of schema.fields) {
    const value = props[field.key];
    if (value === undefined) continue;
    const written = field.write(value, ctx);
    if (Array.isArray(written)) known.push(...written);
    else if (written) known.push(written);
  }
  const children = orderChildren(schema, known, props.extra);
  const attrs = options.attrs ?? {};
  if (!children.length && !Object.keys(attrs).length && !options.keepEmpty) return undefined;
  return el(name, attrs, children);
}

// --- Field constructors ------------------------------------------------------------------

/** On/off element: <w:b/> is true, <w:b w:val="0"/> is false. */
export function onOff(name: string, key: string): Field {
  return {
    name,
    key,
    read: (e) => parseOnOff(e.attrs['w:val']),
    write: (v: boolean) => (v ? el(name) : el(name, { 'w:val': '0' })),
  };
}

/** Element holding a single w:val. */
export function val(name: string, key: string, type: AttrType = 'string'): Field {
  return {
    name,
    key,
    read: (e) => {
      const raw = e.attrs['w:val'];
      if (raw === undefined || Object.keys(e.attrs).length > 1 || e.children.length) return undefined;
      if (type === 'string') return raw;
      if (type === 'bool') return parseOnOff(raw);
      return parseMeasure(raw, type);
    },
    write: (v) => el(name, { 'w:val': type === 'bool' ? (v ? '1' : '0') : String(v) }),
  };
}

/** Element whose attributes form an object (w:spacing, w:ind, w:shd, borders, ...). */
export function attrs(name: string, key: string, spec: AttrSpec): Field {
  return {
    name,
    key,
    read: (e) => (e.children.some((c) => typeof c !== 'string') ? undefined : readAttrs(e, spec)),
    write: (v) => el(name, writeAttrs(v, spec)),
  };
}

/** Element whose children form a nested property object (w:pBdr, w:numPr, w:rPr, ...). */
export function group(name: string, key: string, schema: Schema): Field {
  return {
    name,
    key,
    read: (e, ctx) => (Object.keys(e.attrs).length ? undefined : readProps(schema, e, ctx)),
    write: (v, ctx) => writeProps(schema, name, v, ctx, { keepEmpty: true }),
  };
}

/** Element holding a list of same-named attribute-only children (w:tabs/w:tab). */
export function list(name: string, key: string, itemName: string, spec: AttrSpec): Field {
  return {
    name,
    key,
    read: (e) => {
      const items: unknown[] = [];
      for (const c of elements(e)) {
        if (c.name !== itemName || c.children.length) return undefined;
        items.push(readAttrs(c, spec));
      }
      return items;
    },
    write: (items: Record<string, unknown>[]) => el(name, {}, items.map((item) => el(itemName, writeAttrs(item, spec)))),
  };
}

/** Custom reader/writer. */
export function custom(
  name: string,
  key: string,
  read: (e: XmlElement, ctx: ReadContext) => unknown,
  write: (v: any, ctx: WriteContext) => XmlElement | XmlElement[] | undefined,
): Field {
  return { name, key, read, write };
}
