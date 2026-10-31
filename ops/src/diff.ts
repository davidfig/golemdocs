// SPDX-License-Identifier: MIT
// The edits that turn one document into another: a file changed on disk while it was open, put into
// the open document as operations (so the layout redoes only what changed, the caret and undo history
// move with the text, and nothing flashes) rather than by opening it again.
//
// Blocks are matched as wholes (a longest common subsequence of their content, paragraph ids aside);
// a paragraph that changed keeps its id and gets only the text between what it has in common with its
// new version at its start and end. Lists are matched by what they look like, not by number, since a
// file read again numbers its lists afresh. The result is checked by applying it to a copy: anything
// it can't reproduce exactly (styles, sections, comments, pictures...) gives null, and the caller opens
// the document again instead.

import {
  normalizeInlines,
  paragraphLength,
  paragraphsIn,
  paragraphText,
  splitInlines,
  type AbstractNumbering,
  type Block,
  type Inline,
  type NumberingInstance,
  type Paragraph,
  type WordDocument,
} from '@golemdocs/docx';
import { Engine } from './engine.ts';
import { blockKey } from './ids.ts';
import type { Operation } from './types.ts';

/** Text that the operations put in or changed: positions [from, to) of a paragraph (by id) once they are applied. */
export interface DocumentChange {
  paragraph: string;
  from: number;
  to: number;
}

export interface DocumentDiff {
  ops: Operation[];
  changes: DocumentChange[];
}

const ID_ATTRS = new Set(['w14:paraId', 'w14:textId']);
/** The most block pairs compared one by one; a larger changed stretch is replaced as a whole. */
const MAX_CELLS = 4_000_000;

/**
 * The operations that turn `doc` (an open document: its paragraphs have ids) into `next` (just read), or
 * null when operations can't (something besides the body changed, or a picture was added). `newId` gives
 * paragraph ids the open document doesn't use. `next` is normalized in place.
 */
export function diffDocuments(doc: WordDocument, next: WordDocument, newId: () => string): DocumentDiff | null {
  for (const key of ['styles', 'section', 'comments', 'properties', 'settings'] as const) {
    if (canonical(doc[key]) !== canonical(next[key])) return null;
  }
  if (canonical([...doc.headersFooters]) !== canonical([...next.headersFooters])) return null;
  if (paragraphsIn(next.body).length === 0) next.body.push({ kind: 'paragraph', properties: {}, children: [], attrs: {} });
  for (const p of paragraphsIn(next.body)) p.children = normalizeInlines(p.children);

  const oldLists = listSignatures(doc);
  const newLists = listSignatures(next);
  const a = doc.body.map((b) => canonical(b, oldLists.signature));
  const b = next.body.map((x) => canonical(x, newLists.signature));
  const segments = matchBlocks(a, b);

  // Lists: one in the file that matches one here (same look, same paragraphs) keeps its number; a new one gets a new definition.
  const listMap = new Map<number, number>();
  const pairUp = (from: Block, to: Block) => {
    const olds = paragraphsIn([from]);
    const news = paragraphsIn([to]);
    news.forEach((p, k) => {
      const id = p.properties.numbering?.id;
      const old = olds[k]?.properties.numbering?.id;
      if (id === undefined || old === undefined || listMap.has(id)) return;
      if (oldLists.signature(old) === newLists.signature(id)) listMap.set(id, old);
    });
  };
  // In a stretch that changed, the paragraphs are paired in order (the first with the first...): each keeps its id and gets only what changed in it.
  const pairings = new Map<Segment, Map<number, number>>();
  for (const s of segments) {
    if (s.kind === 'equal') {
      pairUp(doc.body[s.i], next.body[s.j]);
      continue;
    }
    const olds: number[] = [];
    const news: number[] = [];
    for (let i = s.i0; i < s.i1; i++) if (doc.body[i].kind === 'paragraph') olds.push(i);
    for (let j = s.j0; j < s.j1; j++) if (next.body[j].kind === 'paragraph') news.push(j);
    const pairs = new Map<number, number>();
    for (let k = 0; k < Math.min(olds.length, news.length); k++) {
      pairs.set(news[k], olds[k]);
      pairUp(doc.body[olds[k]], next.body[news[k]]);
    }
    pairings.set(s, pairs);
  }
  const ops: Operation[] = [];
  let instanceId = Math.max(0, ...doc.numbering.instances.map((x) => x.id)) + 1;
  let abstractId = Math.max(-1, ...doc.numbering.abstracts.map((x) => x.id)) + 1;
  for (const p of paragraphsIn(next.body)) {
    const id = p.properties.numbering?.id;
    if (id === undefined || listMap.has(id)) continue;
    const list = newLists.list(id);
    if (!list) {
      listMap.set(id, id); // no definition (numId 0 turns numbering off): as it is
      continue;
    }
    const fresh = { instance: { ...structuredClone(list.instance), id: instanceId, abstractId }, abstract: { ...structuredClone(list.abstract), id: abstractId } };
    ops.push({ type: 'setList', id: instanceId, list: fresh });
    listMap.set(id, instanceId++);
    abstractId++;
  }
  const renumber = (blocks: Block[]) => {
    for (const p of paragraphsIn(blocks)) {
      const n = p.properties.numbering;
      if (n?.id !== undefined) p.properties.numbering = { ...n, id: listMap.get(n.id) ?? n.id };
    }
    return blocks;
  };

  // The body as the operations leave it, so each one can be anchored to a paragraph that is there at that moment.
  const current: { key: string; paragraph: boolean; block: Block }[] = doc.body.map((x) => ({ key: blockKey(x), paragraph: x.kind === 'paragraph', block: x }));
  const taken = new Set<string>();
  const freshId = () => {
    let id = newId();
    while (taken.has(id)) id = newId();
    taken.add(id);
    return id;
  };
  const changes: DocumentChange[] = [];

  const remove = (block: Block): boolean => {
    const at = current.findIndex((c) => c.block === block);
    let anchor = -1;
    for (let k = at - 1; k >= 0 && anchor < 0; k--) if (current[k].paragraph) anchor = k;
    const before = anchor < 0;
    for (let k = at + 1; k < current.length && anchor < 0; k++) if (current[k].paragraph) anchor = k;
    if (anchor < 0) return false;
    ops.push({ type: 'removeBlocks', after: current[anchor].key, keys: [current[at].key], ...(before && { before: true }) });
    current.splice(at, 1);
    return true;
  };

  const insert = (at: number, blocks: Block[]): boolean => {
    const copies = renumber(structuredClone(blocks));
    if (hasDrawing(copies)) return false; // its picture is a part of the other package
    for (const p of paragraphsIn(copies)) {
      p.attrs = { ...p.attrs, 'w14:paraId': freshId() };
      changes.push({ paragraph: p.attrs['w14:paraId'], from: 0, to: paragraphLength(p) });
    }
    const left = current[at - 1];
    const right = current[at];
    if (left?.paragraph) ops.push({ type: 'insertBlocks', after: left.key, blocks: copies });
    else if (right?.paragraph) ops.push({ type: 'insertBlocks', after: right.key, blocks: copies, before: true });
    else return false;
    current.splice(at, 0, ...copies.map((x) => ({ key: blockKey(x), paragraph: x.kind === 'paragraph', block: x })));
    return true;
  };

  const change = (old: Paragraph, to: Paragraph): boolean => {
    const id = old.attrs['w14:paraId'];
    const [target] = renumber([structuredClone(to)]) as Paragraph[];
    if (canonical(old.properties) !== canonical(target.properties)) {
      ops.push({ type: 'setParagraphProperties', paragraph: id, properties: target.properties });
      changes.push({ paragraph: id, from: 0, to: paragraphLength(target) });
    }
    const before = paragraphText(old);
    const after = paragraphText(target);
    let start = 0;
    const most = Math.min(before.length, after.length);
    while (start < most && before.charCodeAt(start) === after.charCodeAt(start)) start++;
    if (start > 0 && isHighSurrogate(before.charCodeAt(start - 1))) start--;
    let end = 0;
    while (end < most - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++;
    if (end > 0 && isLowSurrogate(after.charCodeAt(after.length - end))) end--;
    // Text that reads the same but is formatted differently is changed too.
    if (start > 0 && canonical(splitInlines(old.children, start)[0]) !== canonical(splitInlines(target.children, start)[0])) start = 0;
    if (end > 0 && canonical(splitInlines(old.children, before.length - end)[1]) !== canonical(splitInlines(target.children, after.length - end)[1])) end = 0;
    const middle = splitInlines(splitInlines(target.children, start)[1], after.length - end - start)[0];
    if (hasDrawing(middle)) return false;
    if (before.length - end > start) ops.push({ type: 'delete', paragraph: id, from: start, to: before.length - end });
    if (after.length - end > start) {
      ops.push({ type: 'insertContent', paragraph: id, offset: start, content: middle });
      changes.push({ paragraph: id, from: start, to: after.length - end });
    }
    return true;
  };

  let pos = 0;
  for (const s of segments) {
    if (s.kind === 'equal') {
      pos++;
      continue;
    }
    const pairs = pairings.get(s)!;
    const kept = new Set(pairs.values());
    for (let i = s.i0; i < s.i1; i++) if (!kept.has(i) && !remove(doc.body[i])) return null;
    let at = pos;
    let group: Block[] = [];
    const flush = (): boolean => {
      if (group.length === 0) return true;
      const ok = insert(at, group);
      at += group.length;
      group = [];
      return ok;
    };
    for (let j = s.j0; j < s.j1; j++) {
      const i = pairs.get(j);
      if (i === undefined) {
        group.push(next.body[j]);
        continue;
      }
      if (!flush() || !change(doc.body[i] as Paragraph, next.body[j] as Paragraph)) return null;
      at++;
    }
    if (!flush()) return null;
    pos = at;
  }

  if (ops.length === 0) return { ops, changes };
  return reproduces(doc, next, ops) ? { ops, changes: changes.filter((c) => c.to > c.from) } : null;
}

/** A copy of `doc` whose body and lists can be changed without touching it (everything else is shared). */
export function copyDocument(doc: WordDocument): WordDocument {
  return Object.assign(Object.create(Object.getPrototypeOf(doc)) as WordDocument, doc, {
    body: structuredClone(doc.body),
    numbering: structuredClone(doc.numbering),
  });
}

/** Whether two documents' bodies are the same, paragraph ids and list numbers aside. */
export function sameBody(a: WordDocument, b: WordDocument): boolean {
  return canonical(a.body, listSignatures(a).signature) === canonical(b.body, listSignatures(b).signature);
}

/** Whether `ops` applied to a copy of `doc` give `next`'s body (paragraph ids and list numbers aside). */
function reproduces(doc: WordDocument, next: WordDocument, ops: Operation[]): boolean {
  const copy = copyDocument(doc);
  try {
    new Engine(copy).apply(ops);
  } catch {
    return false;
  }
  return sameBody(copy, next);
}

type Segment = { kind: 'equal'; i: number; j: number } | { kind: 'change'; i0: number; i1: number; j0: number; j1: number };

/** Matching blocks (equal strings) in order, and the stretches between them. */
function matchBlocks(a: string[], b: string[]): Segment[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const out: Segment[] = [];
  for (let k = 0; k < head; k++) out.push({ kind: 'equal', i: k, j: k });
  const i0 = head;
  const i1 = a.length - tail;
  const j0 = head;
  const j1 = b.length - tail;
  const n = i1 - i0;
  const m = j1 - j0;
  if (n > 0 || m > 0) {
    if (n === 0 || m === 0 || n * m > MAX_CELLS) out.push({ kind: 'change', i0, i1, j0, j1 });
    else {
      // Longest common subsequence, from the end, so it can be walked forwards.
      const w = m + 1;
      const table = new Uint32Array((n + 1) * w);
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          table[i * w + j] = a[i0 + i] === b[j0 + j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
        }
      }
      let i = 0;
      let j = 0;
      let from = { i: 0, j: 0 };
      const gap = () => {
        if (i > from.i || j > from.j) out.push({ kind: 'change', i0: i0 + from.i, i1: i0 + i, j0: j0 + from.j, j1: j0 + j });
      };
      while (i < n && j < m) {
        if (a[i0 + i] === b[j0 + j]) {
          gap();
          out.push({ kind: 'equal', i: i0 + i, j: j0 + j });
          i++;
          j++;
          from = { i, j };
        } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) i++;
        else j++;
      }
      i = n;
      j = m;
      gap();
    }
  }
  for (let k = tail; k > 0; k--) out.push({ kind: 'equal', i: a.length - k, j: b.length - k });
  return out;
}

/** Each list definition (numbering instance) as what it looks like, without its numbers. */
function listSignatures(doc: WordDocument): { signature: (id: number) => string; list: (id: number) => { instance: NumberingInstance; abstract: AbstractNumbering } | null } {
  const cache = new Map<number, string>();
  const list = (id: number) => {
    const instance = doc.numbering.instances.find((x) => x.id === id);
    const abstract = instance && doc.numbering.abstracts.find((x) => x.id === instance.abstractId);
    return instance && abstract ? { instance, abstract } : null;
  };
  const signature = (id: number) => {
    let s = cache.get(id);
    if (s === undefined) {
      const found = list(id);
      if (!found) s = `none:${id}`;
      else {
        const { id: _i, abstractId: _a, ...instance } = found.instance;
        const { id: _b, ...abstract } = found.abstract;
        s = canonical({ instance, abstract });
      }
      cache.set(id, s);
    }
    return s;
  };
  return { signature, list };
}

/** JSON with keys sorted, paragraph ids left out and (with `list`) list numbers replaced by what the list looks like. */
export function canonical(value: unknown, list?: (id: number) => string): string {
  const out: string[] = [];
  const walk = (v: unknown, key: string): void => {
    if (v === null || typeof v !== 'object') {
      out.push(v === undefined ? 'null' : JSON.stringify(v));
      return;
    }
    if (Array.isArray(v)) {
      out.push('[');
      v.forEach((x, k) => {
        if (k) out.push(',');
        walk(x, '');
      });
      out.push(']');
      return;
    }
    const record = v as Record<string, unknown>;
    out.push('{');
    let first = true;
    for (const k of Object.keys(record).sort()) {
      let x = record[k];
      if (x === undefined || (key === 'attrs' && ID_ATTRS.has(k))) continue;
      if (list && key === 'numbering' && k === 'id' && typeof x === 'number') x = list(x);
      if (!first) out.push(',');
      first = false;
      out.push(JSON.stringify(k), ':');
      walk(x, k);
    }
    out.push('}');
  };
  walk(value, '');
  return out.join('');
}

function hasDrawing(content: readonly (Block | Inline)[]): boolean {
  const walk = (v: unknown): boolean => {
    if (!v || typeof v !== 'object') return false;
    if (Array.isArray(v)) return v.some(walk);
    if ((v as { kind?: unknown }).kind === 'drawing') return true;
    return Object.values(v).some(walk);
  };
  return walk(content);
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;
