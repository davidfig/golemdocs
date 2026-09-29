// Applies operations to a document.
//
// Application is deterministic: the same operations on the same document give the same
// result on every client (collaboration relies on it). Operations that no longer make sense
// (their paragraph is gone, say, after rebasing) do nothing rather than fail, the same way
// everywhere. Paragraphs are normalized whenever they change (see normalizeInlines), and
// once on load, so documents that hold the same content are the same, however they got there.

import {
  deleteText,
  formatText,
  inlinesLength,
  insertInlines,
  insertItem,
  insertText,
  normalizeInlines,
  paragraphLength,
  paragraphsIn,
  runsIn,
  splitContent,
  type Block,
  type Paragraph,
  type WordDocument,
} from '@word/docx';
import { blockKey, DocumentIndex } from './ids.ts';
import type { PosMap } from './mapping.ts';
import type { Operation, RunFormat } from './types.ts';

/** The result of applying one operation. */
export interface Step {
  /** Operations that undo it (empty if it did nothing). */
  inverse: Operation[];
  map: PosMap;
}

/** The result of applying operations. */
export interface Applied {
  steps: Step[];
  /** Undoes all of them (in order). */
  inverse: Operation[];
  maps: PosMap[];
  /** Paragraphs whose layout changed (for LayoutSession.invalidate). */
  changed: Set<Paragraph>;
  /** Section breaks changed: everything must be laid out again. */
  structural: boolean;
  /** Styles or list definitions changed (style caches must be dropped). */
  styles: boolean;
}

const clone = <T>(value: T): T => structuredClone(value);
const IDENTITY: PosMap = { kind: 'identity' };
const NOTHING: Step = { inverse: [], map: IDENTITY };

export class Engine {
  readonly index: DocumentIndex;

  constructor(readonly doc: WordDocument) {
    // There's always a paragraph to put the caret in (the same on every client).
    if (paragraphsIn(doc.body).length === 0) doc.body.push({ kind: 'paragraph', properties: {}, children: [], attrs: {} });
    this.index = new DocumentIndex(doc);
    for (const p of paragraphsIn(doc.body)) p.children = normalizeInlines(p.children);
  }

  apply(ops: readonly Operation[]): Applied {
    const changed = new Set<Paragraph>();
    const steps: Step[] = [];
    const state = { structural: false, styles: false };
    for (const op of ops) steps.push(this.step(op, changed, state));
    const inverse: Operation[] = [];
    for (let i = steps.length - 1; i >= 0; i--) inverse.push(...steps[i].inverse);
    return { steps, inverse, maps: steps.map((s) => s.map), changed, structural: state.structural, styles: state.styles };
  }

  private step(op: Operation, changed: Set<Paragraph>, state: { structural: boolean; styles: boolean }): Step {
    const index = this.index;
    switch (op.type) {
      case 'insertText':
      case 'insertItem':
      case 'insertContent': {
        const p = index.paragraph(op.paragraph);
        if (!p) return NOTHING;
        const offset = clamp(op.offset, paragraphLength(p));
        let length: number;
        if (op.type === 'insertText') {
          if (!op.text) return NOTHING;
          insertText(p, offset, op.text);
          length = op.text.length;
        } else if (op.type === 'insertItem') {
          insertItem(p, offset, clone(op.item));
          length = 1;
        } else {
          const content = clone(op.content);
          length = inlinesLength(content);
          if (length === 0) return NOTHING;
          insertInlines(p, offset, content);
        }
        p.children = normalizeInlines(p.children);
        changed.add(p);
        return {
          inverse: [{ type: 'delete', paragraph: op.paragraph, from: offset, to: offset + length }],
          map: { kind: 'insert', paragraph: op.paragraph, at: offset, length },
        };
      }
      case 'delete': {
        const p = index.paragraph(op.paragraph);
        if (!p) return NOTHING;
        const length = paragraphLength(p);
        const from = clamp(op.from, length);
        const to = clamp(op.to, length);
        if (to <= from) return NOTHING;
        const removed = deleteText(p, from, to);
        changed.add(p);
        return {
          inverse: [{ type: 'insertContent', paragraph: op.paragraph, offset: from, content: clone(removed) }],
          map: { kind: 'delete', paragraph: op.paragraph, from, to },
        };
      }
      case 'split': {
        const p = index.paragraph(op.paragraph);
        const container = p && index.container(p);
        if (!p || !container || index.has(op.id)) return NOTHING;
        const offset = clamp(op.offset, paragraphLength(p));
        const next: Paragraph = {
          kind: 'paragraph',
          properties: clone(op.properties),
          children: splitContent(p, offset),
          attrs: { ...clone(op.attrs ?? {}), 'w14:paraId': op.id },
        };
        container.splice(container.indexOf(p) + 1, 0, next);
        index.added([next], container);
        changed.add(p);
        changed.add(next);
        if (op.properties.section) state.structural = true;
        return {
          inverse: [{ type: 'merge', paragraph: op.paragraph, next: op.id }],
          map: { kind: 'split', paragraph: op.paragraph, at: offset, id: op.id },
        };
      }
      case 'merge': {
        const p = index.paragraph(op.paragraph);
        const next = index.paragraph(op.next);
        const container = p && index.container(p);
        if (!p || !next || !container || index.container(next) !== container || container[container.indexOf(p) + 1] !== next) {
          return NOTHING;
        }
        const length = paragraphLength(p);
        const { 'w14:paraId': _, ...attrs } = next.attrs;
        const inverse: Operation = { type: 'split', paragraph: op.paragraph, offset: length, id: op.next, properties: clone(next.properties), attrs: clone(attrs) };
        p.children = normalizeInlines([...p.children, ...next.children]);
        container.splice(container.indexOf(next), 1);
        index.removed([next]);
        changed.add(p);
        if (next.properties.section) state.structural = true;
        return { inverse: [inverse], map: { kind: 'merge', paragraph: op.paragraph, next: op.next, length } };
      }
      case 'removeBetween': {
        const after = index.paragraph(op.after);
        const before = index.paragraph(op.before);
        const container = after && index.container(after);
        if (!after || !before || !container || index.container(before) !== container) return NOTHING;
        const i = container.indexOf(after);
        const j = container.indexOf(before);
        if (j <= i + 1) return NOTHING;
        const removed = container.splice(i + 1, j - i - 1);
        const paragraphs = paragraphsIn(removed);
        index.removed(removed);
        changed.add(after);
        changed.add(before);
        if (paragraphs.some((x) => x.properties.section)) state.structural = true;
        return {
          inverse: [{ type: 'insertBlocks', after: op.after, blocks: clone(removed) }],
          map: removeMap(paragraphs, op.after, paragraphLength(after)),
        };
      }
      case 'insertBlocks': {
        const after = index.paragraph(op.after);
        const container = after && index.container(after);
        if (!after || !container || op.blocks.length === 0 || index.conflicts(op.blocks)) return NOTHING;
        const blocks: Block[] = clone(op.blocks);
        const at = container.indexOf(after) + 1;
        container.splice(at, 0, ...blocks);
        index.added(blocks, container);
        const paragraphs = paragraphsIn(blocks);
        changed.add(after);
        for (const x of paragraphs) changed.add(x);
        const following = container[at + blocks.length];
        if (following?.kind === 'paragraph') changed.add(following);
        if (paragraphs.some((x) => x.properties.section)) state.structural = true;
        return { inverse: [{ type: 'removeBlocks', after: op.after, keys: blocks.map(blockKey) }], map: IDENTITY };
      }
      case 'removeBlocks': {
        const after = index.paragraph(op.after);
        const container = after && index.container(after);
        if (!after || !container) return NOTHING;
        // Each key in order, searching on from the previous match (normally they're adjacent).
        const removed: Block[] = [];
        let from = container.indexOf(after) + 1;
        for (const key of op.keys) {
          const i = container.findIndex((b, k) => k >= from && b !== after && blockKey(b) === key);
          if (i < 0) continue;
          removed.push(container[i]);
          container.splice(i, 1);
          from = i;
        }
        if (removed.length === 0) return NOTHING;
        const paragraphs = paragraphsIn(removed);
        index.removed(removed);
        changed.add(after);
        const following = container[container.indexOf(after) + 1];
        if (following?.kind === 'paragraph') changed.add(following);
        if (paragraphs.some((x) => x.properties.section)) state.structural = true;
        return {
          inverse: [{ type: 'insertBlocks', after: op.after, blocks: clone(removed) }],
          map: removeMap(paragraphs, op.after, paragraphLength(after)),
        };
      }
      case 'formatText': {
        const p = index.paragraph(op.paragraph);
        if (!p) return NOTHING;
        const length = paragraphLength(p);
        const from = clamp(op.from, length);
        const to = clamp(op.to, length);
        const keys = Object.keys(op.format) as (keyof RunFormat)[];
        if (to <= from || keys.length === 0) return NOTHING;
        // The inverse puts back each run's old values, merging neighbors that had the same.
        const inverse: Operation[] = [];
        for (const run of runsIn(p, from, to)) {
          const old: RunFormat = {};
          for (const key of keys) (old as Record<string, unknown>)[key] = run.properties[key] === undefined ? null : clone(run.properties[key]);
          const last = inverse.at(-1);
          if (last?.type === 'formatText' && last.to === run.from && JSON.stringify(last.format) === JSON.stringify(old)) last.to = run.to;
          else inverse.push({ type: 'formatText', paragraph: op.paragraph, from: run.from, to: run.to, format: old });
        }
        if (inverse.length === 0) return NOTHING;
        formatText(p, from, to, (properties) => {
          const props = properties as Record<string, unknown>;
          for (const key of keys) {
            const value = op.format[key];
            if (value === null || value === undefined) delete props[key];
            else props[key] = clone(value);
          }
          // Keys in one order, however the changes came, so the same formatting is the same run.
          const entries = Object.entries(props).sort(([a], [b]) => runKeyOrder(a) - runKeyOrder(b));
          for (const [key] of entries) delete props[key];
          for (const [key, value] of entries) props[key] = value;
        });
        changed.add(p);
        return { inverse, map: IDENTITY };
      }
      case 'setParagraphProperties': {
        const p = index.paragraph(op.paragraph);
        if (!p) return NOTHING;
        const old = p.properties;
        p.properties = clone(op.properties);
        changed.add(p);
        if (JSON.stringify(old.section) !== JSON.stringify(op.properties.section)) state.structural = true;
        return { inverse: [{ type: 'setParagraphProperties', paragraph: op.paragraph, properties: clone(old) }], map: IDENTITY };
      }
      case 'setStyle': {
        // A new sheet object, so style caches keyed on it (layout, toolbar) know it changed.
        const sheet = this.doc.styles;
        const i = sheet.styles.findIndex((x) => x.id === op.id);
        const old = i >= 0 ? sheet.styles[i] : null;
        if (!old && !op.style) return NOTHING;
        const styles = [...sheet.styles];
        if (op.style) {
          const style = { ...clone(op.style), id: op.id };
          if (i >= 0) styles[i] = style;
          else styles.push(style);
        } else styles.splice(i, 1);
        this.doc.styles = { ...sheet, styles };
        state.structural = true;
        state.styles = true;
        return { inverse: [{ type: 'setStyle', id: op.id, style: old && clone(old) }], map: IDENTITY };
      }
      case 'setList': {
        const numbering = this.doc.numbering;
        const instance = numbering.instances.find((x) => x.id === op.id);
        const abstract = instance && numbering.abstracts.find((x) => x.id === instance.abstractId);
        const old = instance && abstract ? { instance, abstract } : null;
        if (!instance && !op.list) return NOTHING;
        const instances = numbering.instances.filter((x) => x.id !== op.id);
        let abstracts = instance ? numbering.abstracts.filter((x) => x.id !== instance.abstractId) : numbering.abstracts;
        if (op.list) {
          const list = clone(op.list);
          instances.push({ ...list.instance, id: op.id });
          abstracts = [...abstracts.filter((x) => x.id !== list.abstract.id), list.abstract];
        }
        this.doc.numbering = { ...numbering, instances, abstracts };
        state.structural = true;
        state.styles = true;
        return { inverse: [{ type: 'setList', id: op.id, list: old && clone(old) }], map: IDENTITY };
      }
      case 'setComment': {
        const comments = this.doc.comments;
        const i = comments.findIndex((c) => c.id === op.id);
        const old = i >= 0 ? comments[i] : null;
        if (!old && !op.comment) return NOTHING;
        if (op.comment) {
          const comment = { ...clone(op.comment), id: op.id };
          if (i >= 0) comments[i] = comment;
          else comments.push(comment);
        } else comments.splice(i, 1);
        return { inverse: [{ type: 'setComment', id: op.id, comment: old && clone(old) }], map: IDENTITY };
      }
    }
  }
}

/** Run properties in the order Word writes them (unknown ones last). */
const RUN_KEYS = [
  'style', 'fonts', 'bold', 'boldCs', 'italic', 'italicCs', 'caps', 'smallCaps', 'strike', 'doubleStrike', 'outline', 'shadow',
  'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'scale', 'kern', 'position', 'size',
  'sizeCs', 'highlight', 'underline', 'effect', 'border', 'shading', 'vertAlign', 'rtl', 'cs', 'emphasis', 'lang', 'specVanish', 'extra',
];
const runKeyOrder = (key: string) => {
  const i = RUN_KEYS.indexOf(key);
  return i < 0 ? RUN_KEYS.length : i;
};

const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);

/** Positions in removed paragraphs go to the end of the paragraph before them. */
function removeMap(removed: Paragraph[], after: string, afterLength: number): PosMap {
  return { kind: 'remove', ids: removed.map((x) => x.attrs['w14:paraId']), to: { paragraph: after, offset: afterLength } };
}
