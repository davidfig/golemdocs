// SPDX-License-Identifier: MIT
// Position maps: how an applied operation moves positions, and how to move positions and
// operations through a sequence of them (rebasing pending edits over remote ones, keeping
// undo history and selections valid while others edit).

import { END, type Operation, type Pos } from './types.ts';

export type PosMap =
  | { kind: 'identity' }
  /** `length` positions inserted at `at`. */
  | { kind: 'insert'; paragraph: string; at: number; length: number }
  | { kind: 'delete'; paragraph: string; from: number; to: number }
  /** Positions after `at` moved to the start of paragraph `id`. */
  | { kind: 'split'; paragraph: string; at: number; id: string }
  /** `next` was appended to `paragraph`, which had `length` positions. */
  | { kind: 'merge'; paragraph: string; next: string; length: number }
  /** Paragraphs removed; positions in them go to `to`. */
  | { kind: 'remove'; ids: string[]; to: Pos };

export interface Mapped extends Pos {
  /** The position was inside removed content (it's now where that content was). */
  deleted: boolean;
}

/**
 * Maps a position through one map. `assoc` decides which side a position exactly at an
 * insertion or split goes to: -1 stays before, 1 moves after.
 */
export function mapPos(map: PosMap, pos: Pos, assoc: -1 | 1 = 1): Mapped {
  const { paragraph, offset } = pos;
  switch (map.kind) {
    case 'insert':
      if (paragraph === map.paragraph && (offset > map.at || (offset === map.at && assoc > 0))) {
        return { paragraph, offset: offset + map.length, deleted: false };
      }
      break;
    case 'delete':
      if (paragraph === map.paragraph) {
        if (offset >= map.to) return { paragraph, offset: offset - (map.to - map.from), deleted: false };
        if (offset > map.from) return { paragraph, offset: map.from, deleted: true };
      }
      break;
    case 'split':
      if (paragraph === map.paragraph && (offset > map.at || (offset === map.at && assoc > 0))) {
        return { paragraph: map.id, offset: offset - map.at, deleted: false };
      }
      break;
    case 'merge':
      if (paragraph === map.next) return { paragraph: map.paragraph, offset: offset + map.length, deleted: false };
      break;
    case 'remove':
      if (map.ids.includes(paragraph)) return { ...map.to, deleted: true };
      break;
  }
  return { paragraph, offset, deleted: false };
}

/**
 * A sequence of maps. A mirror pairs a map that removed content with a later one that put the
 * same content back (undoing a pending insert, then reapplying it rebased), so positions
 * inside that content are recovered rather than collapsed.
 */
export class Mapping {
  readonly maps: PosMap[] = [];
  private readonly mirrors = new Map<number, number>();

  get length(): number {
    return this.maps.length;
  }

  append(map: PosMap): number {
    this.maps.push(map);
    return this.maps.length - 1;
  }

  appendAll(maps: readonly PosMap[]): void {
    for (const map of maps) this.maps.push(map);
  }

  /** Marks map `b` as restoring what map `a` removed. */
  mirror(a: number, b: number): void {
    this.mirrors.set(a, b);
  }

  /** Maps a position through maps [from, to). */
  map(pos: Pos, assoc: -1 | 1 = 1, from = 0, to = this.maps.length): Mapped {
    let current: Mapped = { ...pos, deleted: false };
    let deleted = false;
    let recover: { at: number; offset: number } | null = null;
    for (let i = from; i < to; i++) {
      const map = this.maps[i];
      if (recover && recover.at === i && map.kind === 'insert') {
        current = { paragraph: map.paragraph, offset: map.at + recover.offset, deleted: false };
        recover = null;
        continue;
      }
      const mirror = this.mirrors.get(i);
      if (
        !recover &&
        mirror !== undefined &&
        mirror > i &&
        mirror < to &&
        map.kind === 'delete' &&
        current.paragraph === map.paragraph &&
        current.offset > map.from &&
        current.offset < map.to
      ) {
        recover = { at: mirror, offset: current.offset - map.from };
      }
      current = mapPos(map, current, assoc);
      if (current.deleted && !recover) deleted = true;
    }
    return { ...current, deleted };
  }
}

/**
 * Moves an operation through maps [from, to): the operation as it would have been written
 * against the document after them. Operations whose target is gone map to nothing; a delete
 * whose ends now fall in different paragraphs becomes two.
 */
export function mapOperation(op: Operation, mapping: Mapping, from = 0, to = mapping.length): Operation[] {
  const at = (paragraph: string, offset: number, assoc: -1 | 1) => mapping.map({ paragraph, offset }, assoc, from, to);
  /** Where a paragraph went (-1: the paragraph itself, not text split off it), or null if removed. */
  const paragraphOf = (id: string) => {
    const mapped = at(id, 0, -1);
    return mapped.deleted && mapped.paragraph !== id ? null : mapped.paragraph;
  };
  switch (op.type) {
    case 'insertText':
    case 'insertItem':
    case 'insertContent': {
      const pos = at(op.paragraph, op.offset, 1);
      return [{ ...op, paragraph: pos.paragraph, offset: pos.offset }];
    }
    case 'delete':
    case 'formatText': {
      // Text inserted at either end isn't included; split apart by someone else's Enter, the
      // operation applies on both sides of the new break.
      const a = at(op.paragraph, op.from, 1);
      const b = op.to >= END ? null : at(op.paragraph, op.to, -1);
      if (!b) return [{ ...op, paragraph: a.paragraph, from: a.offset, to: END }];
      if (a.paragraph === b.paragraph) return b.offset > a.offset ? [{ ...op, paragraph: a.paragraph, from: a.offset, to: b.offset }] : [];
      return [{ ...op, paragraph: a.paragraph, from: a.offset, to: END }, ...(b.offset > 0 ? [{ ...op, paragraph: b.paragraph, from: 0, to: b.offset }] : [])];
    }
    case 'split': {
      const pos = at(op.paragraph, op.offset, 1);
      return [{ ...op, paragraph: pos.paragraph, offset: pos.offset }];
    }
    case 'merge': {
      const paragraph = paragraphOf(op.paragraph);
      const next = paragraphOf(op.next);
      return paragraph && next && paragraph !== next ? [{ ...op, paragraph, next }] : [];
    }
    case 'removeBetween': {
      const after = paragraphOf(op.after);
      const before = paragraphOf(op.before);
      return after && before && after !== before ? [{ ...op, after, before }] : [];
    }
    case 'insertBlocks':
    case 'removeBlocks': {
      const after = paragraphOf(op.after);
      return after ? [{ ...op, after }] : [];
    }
    case 'insertRow':
    case 'removeRow':
    case 'insertCell':
    case 'removeCell':
    case 'setTableGrid':
    case 'setCellProperties': {
      const paragraph = paragraphOf(op.paragraph);
      return paragraph ? [{ ...op, paragraph }] : [];
    }
    case 'setParagraphProperties': {
      const paragraph = paragraphOf(op.paragraph);
      return paragraph ? [{ ...op, paragraph }] : [];
    }
    case 'setComment':
    case 'setStyle':
    case 'setList':
    case 'setDocumentSection':
    case 'setDocumentProperties':
      return [op];
  }
}
