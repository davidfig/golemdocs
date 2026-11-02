// SPDX-License-Identifier: MIT
// Find and replace.
import { type CommandResult, NO_CHANGE } from './types.ts';

import { paragraphText, type Paragraph } from '@golemdocs/docx';
import { type Operation, type Pos } from '@golemdocs/ops';
import { compileSearch, escapeReplacement, expandReplacement, findInText, type SearchOptions } from './pattern.ts';
import { EditorLinks } from './links.ts';

/** What a command asks to find: the text, and how it is read. */
export interface FindOptions {
  text: string;
  matchCase?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

const optionsOf = (o: FindOptions): SearchOptions => ({ text: o.text, caseSensitive: o.matchCase ?? false, wholeWord: o.wholeWord ?? false, regex: o.regex ?? false });

export abstract class EditorSearch extends EditorLinks {
  /** The matches in a paragraph (model offsets), not overlapping. */
  protected matches(paragraph: Paragraph, regex: RegExp, wholeWord: boolean): RegExpExecArray[] {
    return findInText(paragraphText(paragraph), regex, wholeWord);
  }

  protected find(query: FindOptions, backward: boolean): boolean {
    const options = optionsOf(query);
    const regex = compileSearch(options);
    const list = this.paragraphs();
    if (!regex || !list.length) return false;
    const [start, end] = this.ordered();
    const from = this.indexOf(backward ? start.paragraph : end.paragraph);
    // Every paragraph once from the selection, then the one it began in again for matches before it.
    for (let step = 0; step <= list.length; step++) {
      const k = (backward ? from - step : from + step) % list.length;
      const paragraph = list[(k + list.length) % list.length];
      let found = this.matches(paragraph, regex, options.wholeWord);
      if (step === 0) found = found.filter((m) => (backward ? m.index + m[0].length <= start.offset : m.index >= end.offset));
      else if (step === list.length) found = found.filter((m) => (backward ? m.index + m[0].length > start.offset : m.index < end.offset));
      const m = backward ? found[found.length - 1] : found[0];
      if (!m) continue;
      this.selection = { anchor: { paragraph, offset: m.index }, focus: { paragraph, offset: m.index + m[0].length } };
      return true;
    }
    return false;
  }

  protected replaceAll(query: FindOptions, replacement: string): CommandResult {
    const options = optionsOf(query);
    const regex = compileSearch(options);
    if (!regex) return { ...NO_CHANGE, replaced: 0 };
    const pattern = options.regex ? replacement : escapeReplacement(replacement);
    const ops: Operation[] = [];
    let count = 0;
    let after: Pos | null = null;
    // A selection that is one of the matches (Change All from the spelling check) stays put, after its replacement.
    const [start, end] = this.ordered();
    let staysAt: Pos | null = null;
    for (const paragraph of this.paragraphs()) {
      const id = this.replica.id(paragraph);
      const found = this.matches(paragraph, regex, options.wholeWord).map((m) => ({ at: m.index, length: m[0].length, text: expandReplacement(m, pattern) }));
      if (found.length && !after) after = { paragraph: id, offset: found[0].at + found[0].text.length };
      if (paragraph === start.paragraph && start.paragraph === end.paragraph) {
        const index = found.findIndex((f) => f.at === start.offset && f.length === end.offset - start.offset);
        if (index >= 0) {
          const shift = found.slice(0, index).reduce((n, f) => n + f.text.length - f.length, 0);
          staysAt = { paragraph: id, offset: start.offset + shift + found[index].text.length };
        }
      }
      // From the end, so earlier offsets stay valid as the text changes length.
      for (const f of found.reverse()) {
        // Inserted at the end of the match first, so the replacement looks like the last of the words it replaces.
        if (f.text) ops.push({ type: 'insertText', paragraph: id, offset: f.at + f.length, text: f.text });
        ops.push({ type: 'delete', paragraph: id, from: f.at, to: f.at + f.length });
        count++;
      }
    }
    if (!after) return { ...NO_CHANGE, replaced: 0 };
    after = staysAt ?? after;
    // The caret ends after the first replacement (or the selected one); the old selection's offsets may no longer hold.
    const change = this.replica.edit(ops, { before: this.selectionIds, after: { anchor: after, focus: after } });
    return { ...this.changed(change.applied, { anchor: after, focus: after }), replaced: count };
  }
}
