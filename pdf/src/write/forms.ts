// Interactive form fields (§12.7): text boxes, check boxes, radio buttons and choice lists, as a
// plain layer the app can fill in, rearrange, save as JSON and write back into the file.
//
// readFields lists the fillable fields, one entry per widget (the box on the page; a field shown
// in two places, or a radio group, has several). applyFields makes the document's fields exactly
// a given list: values, names and boxes change in place, new fields are added and missing ones
// removed. Push buttons and signature fields are left alone. Text and choice fields get a fresh
// appearance stream when their value or box changes, so every viewer shows the new value.

import { N, PdfDict, PdfName, PdfRef, PdfStream, PdfString, type PdfObject } from '../core/objects.ts';
import type { PdfDocument } from '../document.ts';
import type { Box } from '../page.ts';
import type { PdfFont } from './fonts.ts';

export type FieldKind = 'text' | 'checkbox' | 'radio' | 'choice';

/** One widget of a form field, in the page's default user space (points, y up). */
export interface FormField {
  /** Stable within the layer: the widget's object ("12 0") for fields read from the file. */
  id: string;
  /** The field's fully qualified name (parent names joined with dots). Widgets of one field share it. */
  name: string;
  kind: FieldKind;
  /** Zero-based page index. */
  page: number;
  rect: Box;
  /**
   * The field's value, shared by its widgets. Text and choice: the text. Check box and radio:
   * the on state that is selected (see `onState`), or '' when off.
   */
  value: string;
  /** Check box and radio: the state this widget turns the field to when it's on. */
  onState?: string;
  /** Choice: the options, as the value stored and the text shown. */
  options?: { value: string; label: string }[];
  /** Choice: a drop-down (combo box) rather than a list. */
  combo?: boolean;
  /** Text: more than one line. */
  multiline?: boolean;
  maxLength?: number;
  readOnly?: boolean;
  /** Text size in points; 0 or missing: fit the box. */
  fontSize?: number;
}

// Field flags (§12.7.4, Table 226, 228, 230).
const READ_ONLY = 1 << 0;
const MULTILINE = 1 << 12;
const RADIO = 1 << 15;
const PUSHBUTTON = 1 << 16;
const COMBO = 1 << 17;

const idOf = (ref: PdfRef) => `${ref.num} ${ref.gen}`;

/** A widget as found in the document, with the field it belongs to. */
interface Entry {
  field: FormField;
  widgetRef: PdfRef;
  widget: PdfDict;
  /** The terminal field: the widget itself when the two are merged. */
  terminal: PdfDict;
  terminalRef: PdfRef;
  /** The terminal field's parent field, if any. */
  parent: PdfDict | undefined;
  /** The name of the parent field ('' for a top-level field). */
  parentName: string;
}

interface Inherited {
  ft?: string;
  ff: number;
  v?: PdfObject;
  da?: string;
  opt?: PdfObject;
  maxLen?: number;
}

function acroForm(doc: PdfDocument): PdfDict | undefined {
  try {
    return doc.dict(doc.catalog.get('AcroForm'));
  } catch {
    return undefined;
  }
}

function text(doc: PdfDocument, o: PdfObject | undefined): string | undefined {
  const r = doc.resolve(o);
  if (r instanceof PdfString) return r.text;
  if (r instanceof PdfStream) return new TextDecoder().decode(doc.streamData(r));
  return undefined;
}

/** Every widget of a fillable field, keyed by its object, in field-tree order. */
function entries(doc: PdfDocument): Map<string, Entry> {
  const out = new Map<string, Entry>();
  const acro = acroForm(doc);
  if (!acro) return out;
  const pageOf = new Map<string, number>();
  doc.pages.forEach((page, index) => {
    for (const ref of doc.array(page.dict.get('Annots')) ?? []) if (ref instanceof PdfRef) pageOf.set(idOf(ref), index);
  });
  const seen = new Set<string>();

  const visit = (ref: PdfObject, parent: PdfDict | undefined, parentName: string, inherited: Inherited, depth: number) => {
    if (!(ref instanceof PdfRef) || depth > 32 || seen.has(idOf(ref))) return;
    seen.add(idOf(ref));
    const dict = doc.dict(ref);
    if (!dict) return;
    const partial = text(doc, dict.get('T'));
    const name = partial === undefined ? parentName : parentName ? `${parentName}.${partial}` : partial;
    const here: Inherited = {
      ft: dict.name('FT') ?? inherited.ft,
      ff: doc.number(dict.get('Ff')) ?? inherited.ff,
      v: dict.has('V') ? dict.get('V') : inherited.v,
      da: text(doc, dict.get('DA')) ?? inherited.da,
      opt: dict.has('Opt') ? dict.get('Opt') : inherited.opt,
      maxLen: doc.number(dict.get('MaxLen')) ?? inherited.maxLen,
    };
    const kids = doc.array(dict.get('Kids')) ?? [];
    // Kids with names are fields of their own; kids without are this field's widgets.
    const fieldKids = kids.filter((k) => doc.dict(k)?.has('T'));
    if (fieldKids.length) {
      for (const kid of fieldKids) visit(kid, dict, name, here, depth + 1);
      return;
    }
    const widgets: PdfObject[] = kids.length ? kids : [ref];
    const kind = kindOf(here);
    if (!kind) return;
    for (const w of widgets) {
      if (!(w instanceof PdfRef)) continue;
      const widget = doc.dict(w);
      const page = pageOf.get(idOf(w));
      if (!widget || page === undefined) continue;
      const nums = (doc.array(widget.get('Rect')) ?? []).map((x) => doc.number(x) ?? 0);
      if (nums.length !== 4) continue;
      const field: FormField = {
        id: idOf(w),
        name,
        kind,
        page,
        rect: [Math.min(nums[0], nums[2]), Math.min(nums[1], nums[3]), Math.max(nums[0], nums[2]), Math.max(nums[1], nums[3])],
        value: '',
      };
      const da = text(doc, widget.get('DA')) ?? here.da;
      const size = da ? /(-?\d*\.?\d+)\s+Tf/.exec(da) : null;
      if (size) field.fontSize = Math.max(0, Number(size[1]));
      if (here.ff & READ_ONLY) field.readOnly = true;
      if (kind === 'checkbox' || kind === 'radio') {
        const states = [...(doc.dict(doc.dict(widget.get('AP'))?.get('N'))?.keys() ?? [])].filter((s) => s !== 'Off');
        field.onState = states[0] ?? 'Yes';
        const v = doc.resolve(here.v);
        const state = v instanceof PdfName ? v.name : widget.name('AS');
        field.value = state && state !== 'Off' ? state : '';
      } else {
        const v = doc.resolve(here.v);
        field.value = (Array.isArray(v) ? text(doc, v[0]) : text(doc, v)) ?? '';
        if (kind === 'text') {
          if (here.ff & MULTILINE) field.multiline = true;
          if (here.maxLen !== undefined) field.maxLength = here.maxLen;
        } else {
          field.combo = (here.ff & COMBO) !== 0;
          field.options = (doc.array(here.opt) ?? []).map((o) => {
            const pair = doc.array(o);
            if (pair) return { value: text(doc, pair[0]) ?? '', label: text(doc, pair[1]) ?? text(doc, pair[0]) ?? '' };
            const t = text(doc, o) ?? '';
            return { value: t, label: t };
          });
        }
      }
      out.set(field.id, { field, widgetRef: w, widget, terminal: dict, terminalRef: ref, parent, parentName });
    }
  };

  for (const ref of doc.array(acro.get('Fields')) ?? []) visit(ref, undefined, '', { ff: 0 }, 0);
  return out;
}

function kindOf(i: Inherited): FieldKind | null {
  if (i.ft === 'Tx') return 'text';
  if (i.ft === 'Ch') return 'choice';
  if (i.ft === 'Btn') return i.ff & PUSHBUTTON ? null : i.ff & RADIO ? 'radio' : 'checkbox';
  return null;
}

/** The fillable form fields, one per widget, in page order (each page's in tab order). */
export function readFields(doc: PdfDocument): FormField[] {
  const found = entries(doc);
  const out: FormField[] = [];
  doc.pages.forEach((page) => {
    for (const ref of doc.array(page.dict.get('Annots')) ?? []) {
      const e = ref instanceof PdfRef ? found.get(idOf(ref)) : undefined;
      if (e) out.push(e.field);
    }
  });
  return out;
}

/** Whether an annotation is the widget of a fillable field (what readFields lists). */
export function isFieldWidget(doc: PdfDocument, annot: PdfDict): boolean {
  if (annot.name('Subtype') !== 'Widget') return false;
  let ft: string | undefined;
  let ff: number | undefined;
  let node: PdfDict | undefined = annot;
  for (let depth = 0; node && depth < 32 && (ft === undefined || ff === undefined); depth++) {
    ft ??= node.name('FT');
    ff ??= doc.number(node.get('Ff'));
    node = doc.dict(node.get('Parent'));
  }
  return kindOf({ ft, ff: ff ?? 0 }) !== null;
}

/**
 * Makes the document's fillable fields exactly `fields`: widgets read from the file keep their
 * object and change in place, new ones are added (each as a field of its own), and ones no longer
 * listed are removed from their page and from the field tree. Other annotations stay.
 */
export function applyFields(doc: PdfDocument, fields: readonly FormField[]): void {
  const current = entries(doc);
  const wanted = new Map(fields.map((f) => [f.id, f]));
  if (!current.size && !fields.length) return;
  const acro = ensureAcroForm(doc);
  let valuesChanged = false;

  // Removed widgets: off their page and out of the field tree.
  const removedFromPage = new Map<number, Set<string>>();
  for (const [id, e] of current) {
    if (wanted.has(id)) continue;
    const set = removedFromPage.get(e.field.page) ?? new Set();
    set.add(id);
    removedFromPage.set(e.field.page, set);
    if (e.widget === e.terminal) removeKid(doc, acro, e.parent, e.terminalRef);
    else {
      const kids = (doc.array(e.terminal.get('Kids')) ?? []).filter((k) => !(k instanceof PdfRef && idOf(k) === id));
      if (kids.length) e.terminal.set('Kids', kids);
      else removeKid(doc, acro, e.parent, e.terminalRef);
    }
  }
  for (const [index, ids] of removedFromPage) {
    const page = doc.pages[index];
    const refs = doc.array(page.dict.get('Annots')) ?? [];
    const kept = refs.filter((r) => !(r instanceof PdfRef && ids.has(idOf(r))));
    if (kept.length) page.dict.set('Annots', kept);
    else page.dict.delete('Annots');
  }

  // Changed fields: one name and value per terminal field, then each widget's box and look.
  const renamed = new Set<PdfDict>();
  const revalued = new Set<PdfDict>();
  for (const [id, e] of current) {
    const want = wanted.get(id);
    if (!want) continue;
    const was = e.field;
    if (want.name !== was.name && !renamed.has(e.terminal)) {
      renamed.add(e.terminal);
      rename(doc, acro, e, want.name);
    }
    const valueChanged = want.value !== was.value;
    if (valueChanged && !revalued.has(e.terminal)) {
      revalued.add(e.terminal);
      valuesChanged = true;
      e.terminal.set('V', valueObject(want));
    }
    const shape = want.kind === 'text' && !!want.multiline !== !!was.multiline;
    if (shape) {
      const ff = inheritedFlags(doc, e.widget);
      e.terminal.set('Ff', want.multiline ? ff | MULTILINE : ff & ~MULTILINE);
    }
    const options = want.kind === 'choice' && JSON.stringify(want.options ?? []) !== JSON.stringify(was.options ?? []);
    if (options) e.terminal.set('Opt', optArray(want));
    const moved = !sameBox(want.rect, was.rect);
    if (moved) e.widget.set('Rect', [...want.rect]);
    if (want.kind === 'checkbox' || want.kind === 'radio') {
      if (valueChanged) e.widget.set('AS', N(want.onState && want.value === want.onState ? want.onState : 'Off'));
    } else if (valueChanged || moved || shape || options || want.fontSize !== was.fontSize) {
      e.widget.set('AP', new PdfDict({ N: doc.add(textAppearance(doc, acro, want)) }));
    }
  }
  // New fields, each a merged field and widget at the top of the tree.
  const added: PdfRef[] = [];
  for (const f of fields) {
    if (current.has(f.id)) continue;
    const page = doc.pages[f.page];
    if (!page) continue;
    const dict = new PdfDict({
      Type: N('Annot'),
      Subtype: N('Widget'),
      P: page.ref,
      F: 4,
      T: PdfString.text(f.name),
      Rect: [...f.rect],
      MK: new PdfDict({ BC: [0.45, 0.45, 0.45] }),
    });
    const flags = (f.readOnly ? READ_ONLY : 0) | (f.kind === 'text' && f.multiline ? MULTILINE : 0) | (f.kind === 'radio' ? RADIO : 0) | (f.kind === 'choice' && f.combo ? COMBO : 0);
    if (flags) dict.set('Ff', flags);
    if (f.kind === 'checkbox' || f.kind === 'radio') {
      const on = f.onState || 'Yes';
      dict.set('FT', N('Btn'));
      dict.set('V', N(f.value === on ? on : 'Off'));
      dict.set('AS', N(f.value === on ? on : 'Off'));
      const [w, h] = [f.rect[2] - f.rect[0], f.rect[3] - f.rect[1]];
      dict.set('AP', new PdfDict({ N: new PdfDict({ [on]: doc.add(checkAppearance(w, h, true)), Off: doc.add(checkAppearance(w, h, false)) }) }));
    } else {
      dict.set('FT', N(f.kind === 'text' ? 'Tx' : 'Ch'));
      dict.set('DA', PdfString.text(`/Helv ${fmt(f.fontSize ?? 0)} Tf 0 g`));
      if (f.value) dict.set('V', valueObject(f));
      if (f.kind === 'text' && f.maxLength) dict.set('MaxLen', f.maxLength);
      if (f.kind === 'choice') dict.set('Opt', optArray(f));
      dict.set('AP', new PdfDict({ N: doc.add(textAppearance(doc, acro, f)) }));
    }
    if (f.value) valuesChanged = true;
    const ref = doc.add(dict);
    added.push(ref);
    page.dict.set('Annots', [...(doc.array(page.dict.get('Annots')) ?? []), ref]);
  }
  if (added.length) acro.set('Fields', [...(doc.array(acro.get('Fields')) ?? []), ...added]);
  // Other viewers redraw fields in their own fonts (ours only cover Latin-1).
  if (valuesChanged) acro.set('NeedAppearances', true);
}

/** The document's interactive form dictionary, created if missing, with a Helvetica for fields. */
function ensureAcroForm(doc: PdfDocument): PdfDict {
  let acro = acroForm(doc);
  if (!acro) {
    acro = new PdfDict({ Fields: [] });
    doc.catalog.set('AcroForm', doc.add(acro));
  }
  if (!acro.has('DA')) acro.set('DA', PdfString.text('/Helv 0 Tf 0 g'));
  return acro;
}

/** The font resources field appearances use: the form's Helv, or a Helvetica of our own. */
function helvetica(doc: PdfDocument, acro: PdfDict): { resources: PdfDict; font: PdfFont } {
  const font = doc.standardFont('Helvetica');
  const dr = doc.dict(acro.get('DR'));
  const existing = doc.dict(dr?.get('Font'))?.get('Helv');
  return { resources: new PdfDict({ Font: new PdfDict({ Helv: existing ?? font.ref }) }), font };
}

/** Takes a field out of its parent's Kids (or the form's Fields), and the parent too when that empties it. */
function removeKid(doc: PdfDocument, acro: PdfDict, parent: PdfDict | undefined, ref: PdfRef): void {
  const holder = parent ?? acro;
  const key = parent ? 'Kids' : 'Fields';
  const kids = (doc.array(holder.get(key)) ?? []).filter((k) => !(k instanceof PdfRef && k.equals(ref)));
  holder.set(key, kids);
  if (parent && !kids.length) {
    const grandparent = doc.dict(parent.get('Parent'));
    const parentRef = findRef(doc, grandparent ?? acro, grandparent ? 'Kids' : 'Fields', parent);
    if (parentRef) removeKid(doc, acro, grandparent, parentRef);
  }
}

function findRef(doc: PdfDocument, holder: PdfDict, key: string, target: PdfDict): PdfRef | undefined {
  for (const k of doc.array(holder.get(key)) ?? []) if (k instanceof PdfRef && doc.dict(k) === target) return k;
  return undefined;
}

/** Renames a terminal field: under its parent when the new name keeps the parent's, else at the top. */
function rename(doc: PdfDocument, acro: PdfDict, e: Entry, name: string): void {
  if (e.parentName && name.startsWith(`${e.parentName}.`)) {
    e.terminal.set('T', PdfString.text(name.slice(e.parentName.length + 1)));
    return;
  }
  if (e.parent) {
    removeKid(doc, acro, e.parent, e.terminalRef);
    // Keep what it inherited from the parents it's leaving.
    for (const key of ['FT', 'Ff', 'DA', 'Opt', 'MaxLen', 'V']) {
      if (e.terminal.has(key)) continue;
      let node: PdfDict | undefined = e.parent;
      for (let depth = 0; node && depth < 32; depth++) {
        if (node.has(key)) {
          e.terminal.set(key, node.get(key));
          break;
        }
        node = doc.dict(node.get('Parent'));
      }
    }
    e.terminal.delete('Parent');
    acro.set('Fields', [...(doc.array(acro.get('Fields')) ?? []), e.terminalRef]);
  }
  e.terminal.set('T', PdfString.text(name));
}

/** A field's flags, from it or the nearest parent that has them. */
function inheritedFlags(doc: PdfDocument, widget: PdfDict): number {
  let node: PdfDict | undefined = widget;
  for (let depth = 0; node && depth < 32; depth++) {
    const ff = doc.number(node.get('Ff'));
    if (ff !== undefined) return ff;
    node = doc.dict(node.get('Parent'));
  }
  return 0;
}

function optArray(f: FormField): PdfObject[] {
  return (f.options ?? []).map((o) => (o.label === o.value ? PdfString.text(o.value) : [PdfString.text(o.value), PdfString.text(o.label)]));
}

function valueObject(f: FormField): PdfObject {
  if (f.kind === 'checkbox' || f.kind === 'radio') return N(f.value || 'Off');
  return PdfString.text(f.value);
}

const sameBox = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-3);

/** A text or choice field's look: its value in Helvetica, fitted to the box. */
function textAppearance(doc: PdfDocument, acro: PdfDict, f: FormField): PdfStream {
  const w = f.rect[2] - f.rect[0];
  const h = f.rect[3] - f.rect[1];
  const { resources, font } = helvetica(doc, acro);
  const shown = f.kind === 'choice' ? (f.options?.find((o) => o.value === f.value)?.label ?? f.value) : f.value;
  const pad = 2;
  const ops = ['/Tx BMC', 'q', `${pad / 2} ${pad / 2} ${fmt(w - pad)} ${fmt(h - pad)} re W n`];
  if (shown) {
    ops.push('BT', '0 g');
    if (f.multiline) {
      const size = f.fontSize || 10;
      const lines = wrap(font, shown, size, w - pad * 2);
      const leading = size * 1.15;
      ops.push(`/Helv ${fmt(size)} Tf`, `${fmt(leading)} TL`, `${pad} ${fmt(h - pad - (size * font.ascent) / 1000)} Td`);
      lines.forEach((line, i) => ops.push(`${i ? 'T* ' : ''}<${hex(font.encode(line))}> Tj`));
    } else {
      let size = f.fontSize || Math.min(12, Math.max(4, (h - pad) * 0.7));
      if (!f.fontSize) while (size > 4 && font.widthOf(shown, size) > w - pad * 2) size -= 0.5;
      const y = (h - (size * (font.ascent + font.descent)) / 1000) / 2;
      ops.push(`/Helv ${fmt(size)} Tf`, `${pad} ${fmt(y)} Td`, `<${hex(font.encode(shown))}> Tj`);
    }
    ops.push('ET');
  }
  ops.push('Q', 'EMC');
  const dict = new PdfDict({ Type: N('XObject'), Subtype: N('Form'), BBox: [0, 0, w, h], Resources: resources });
  return new PdfStream(dict, new TextEncoder().encode(ops.join('\n')));
}

/** A new check box's look: a border, and a tick when on. */
function checkAppearance(w: number, h: number, on: boolean): PdfStream {
  const ops = ['0.45 G 0.75 w', `0.5 0.5 ${fmt(w - 1)} ${fmt(h - 1)} re S`];
  if (on) {
    const s = Math.min(w, h);
    const [ox, oy] = [(w - s) / 2, (h - s) / 2];
    const p = (x: number, y: number) => `${fmt(ox + x * s)} ${fmt(oy + y * s)}`;
    ops.push(`0 G ${fmt(Math.max(1, s / 9))} w 1 J 1 j`, `${p(0.22, 0.52)} m ${p(0.42, 0.3)} l ${p(0.78, 0.74)} l S`);
  }
  const dict = new PdfDict({ Type: N('XObject'), Subtype: N('Form'), BBox: [0, 0, w, h], Resources: new PdfDict() });
  return new PdfStream(dict, new TextEncoder().encode(ops.join('\n')));
}

/** Text broken into lines no wider than `width`, at spaces where it can be and newlines always. */
function wrap(font: PdfFont, text: string, size: number, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\r\n?|\n/)) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (line && font.widthOf(next, size) > width) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
