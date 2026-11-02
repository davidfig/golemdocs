// SPDX-License-Identifier: MIT
// Formatting the selection: text, paragraphs, case.
import { type Position, type Command, type CommandResult, NO_CHANGE } from './types.ts';
import { WORD } from './segment.ts';
import type { RunProperties } from '@golemdocs/docx';
import type { RunFormat } from '@golemdocs/ops';

import { paragraphLength, paragraphText, runPropertiesAt, runsIn, OBJECT_CHAR, type Paragraph } from '@golemdocs/docx';
import { type Operation } from '@golemdocs/ops';
import { cjkWords, segmentAt } from './segment.ts';
import { EditorSearch } from './search.ts';

/** Run properties with a formatting change made. */
export function withFormat(properties: RunProperties, format: RunFormat): RunProperties {
  const out = structuredClone(properties) as Record<string, unknown>;
  for (const [key, value] of Object.entries(format)) {
    if (value === null || value === undefined) delete out[key];
    else out[key] = structuredClone(value);
  }
  return out as RunProperties;
}

export abstract class EditorFormatting extends EditorSearch {
  /** Paragraphs the selection touches, in order (the end one only if the selection reaches into it). */
  selectedParagraphs(): Paragraph[] {
    const [start, end] = this.ordered();
    const list = this.paragraphs();
    const last = end.offset === 0 && end.paragraph !== start.paragraph ? this.indexOf(end.paragraph) - 1 : this.indexOf(end.paragraph);
    return list.slice(this.indexOf(start.paragraph), last + 1);
  }

  /** The word a caret is inside (not at either edge of), if any. */
  protected wordAround(pos: Position): [Position, Position] | null {
    const text = paragraphText(pos.paragraph);
    const cjk = cjkWords(text);
    if (cjk) {
      const s = segmentAt(cjk, pos.offset);
      return s?.word && s.start < pos.offset ? this.wordAt(pos) : null;
    }
    if (!WORD.test(text[pos.offset - 1] ?? '') || !WORD.test(text[pos.offset] ?? '')) return null;
    return this.wordAt(pos);
  }

  protected formatText(command: Extract<Command, { kind: 'formatText' }>): CommandResult {
    const { format } = command;
    const ops = [...(command.define ?? [])];
    const formatRange = (p: Paragraph, from: number, to: number) => {
      const id = this.replica.id(p);
      if (typeof format !== 'function') {
        ops.push({ type: 'formatText', paragraph: id, from, to, format });
        return;
      }
      for (const run of runsIn(p, from, to)) {
        const change = format(run.properties, p);
        if (!change) continue;
        const last = ops.at(-1);
        if (last?.type === 'formatText' && last.paragraph === id && last.to === run.from && JSON.stringify(last.format) === JSON.stringify(change)) last.to = run.to;
        else ops.push({ type: 'formatText', paragraph: id, from: run.from, to: run.to, format: change });
      }
    };
    /** An empty paragraph's mark carries the formatting typed text there gets. */
    const formatMark = (p: Paragraph) => {
      const current = p.properties.runProperties ?? {};
      const change = typeof format === 'function' ? format(current, p) : format;
      if (change) ops.push(this.setProperties(p, { runProperties: withFormat(current, change) }));
    };

    if (this.collapsed) {
      const at = this.selection.focus;
      const word = this.wordAround(at);
      if (word) formatRange(at.paragraph, word[0].offset, word[1].offset);
      else if (paragraphLength(at.paragraph) === 0) formatMark(at.paragraph);
      else {
        // Nothing to format yet: it applies to what's typed next here.
        const current = withFormat(runPropertiesAt(at.paragraph, at.offset) ?? {}, this.pending ?? {});
        const change = typeof format === 'function' ? format(current, at.paragraph) : format;
        if (change) this.pending = { ...this.pending, ...change };
        return ops.length ? this.editInPlace(ops) : NO_CHANGE;
      }
      return this.editInPlace(ops);
    }
    const [start, end] = this.ordered();
    for (const p of this.selectedParagraphs()) {
      const from = p === start.paragraph ? start.offset : 0;
      const to = p === end.paragraph ? end.offset : paragraphLength(p);
      if (paragraphLength(p) === 0) formatMark(p);
      else if (to > from) formatRange(p, from, to);
    }
    return this.editInPlace(ops);
  }

  protected changeCaseOps(change: (text: string) => string): Operation[] {
    let [start, end] = this.ordered();
    if (this.collapsed) {
      const word = this.wordAround(start);
      if (!word) return [];
      [start, end] = word;
    }
    const ops: Operation[] = [];
    for (const p of this.selectedParagraphs()) {
      const from = p === start.paragraph ? start.offset : 0;
      const to = p === end.paragraph ? end.offset : paragraphLength(p);
      const text = paragraphText(p);
      const changed = change(text.slice(from, to));
      if (changed.length !== to - from) continue;
      const id = this.replica.id(p);
      // Each run's text is replaced by a run with its formatting; objects (tabs, fields) stay.
      for (const run of runsIn(p, from, to)) {
        if (run.nested) continue;
        let a = run.from;
        while (a < run.to) {
          let b = a;
          while (b < run.to && text[b] !== OBJECT_CHAR) b++;
          const next = changed.slice(a - from, b - from);
          if (b > a && next !== text.slice(a, b)) {
            ops.push({ type: 'delete', paragraph: id, from: a, to: b });
            ops.push({ type: 'insertContent', paragraph: id, offset: a, content: [{ kind: 'run', properties: structuredClone(run.properties), content: [{ kind: 'text', text: next }], attrs: {} }] });
          }
          a = b + 1;
        }
      }
    }
    return ops;
  }

  /** Applies operations that don't move text as one local edit, keeping the selection. */
  protected editInPlace(ops: Operation[]): CommandResult {
    if (ops.length === 0) return NO_CHANGE;
    const selection = this.selectionIds;
    const change = this.replica.edit(ops, { before: selection, after: selection });
    return this.changed(change.applied, selection);
  }
}
