// SPDX-License-Identifier: MIT
// List numbering: turns a paragraph's numbering reference into its label ("3.", "iv)", "•").
// Feed paragraphs in document order; counters carry state between them.

import type { NumberingReference } from './types.ts';
import type { StyleResolver } from './resolve.ts';

/**
 * The labels of lists of check boxes (Markdown task lists). They are never drawn as text (no font has them):
 * the layout draws a box in their place, and a click on it changes the list from one to the other.
 */
export const CHECKBOX = { unchecked: '\u2610', checked: '\u2611' } as const;

const ROMAN: [number, string][] = [
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
  [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
];

function roman(n: number): string {
  let out = '';
  for (const [value, digits] of ROMAN) {
    while (n >= value) {
      out += digits;
      n -= value;
    }
  }
  return out;
}

/** Word's letter numbering: a..z, then aa..zz, aaa.. (repeats the letter). */
function letters(n: number): string {
  if (n < 1) return '';
  const letter = String.fromCharCode(97 + ((n - 1) % 26));
  return letter.repeat(Math.floor((n - 1) / 26) + 1);
}

function ordinalSuffix(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return 'th';
  return ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
}

/** Word's largest list number (w:start is at most 32767); beyond it letters and roman numerals would only balloon. */
const MAX_SPELLED = 32767;

export function formatNumber(n: number, format = 'decimal'): string {
  if (n > MAX_SPELLED && /Letter$|Roman$/.test(format)) return String(n);
  switch (format) {
    case 'none':
      return '';
    case 'decimalZero':
      return n < 10 ? `0${n}` : String(n);
    case 'lowerLetter':
      return letters(n);
    case 'upperLetter':
      return letters(n).toUpperCase();
    case 'lowerRoman':
      return roman(n);
    case 'upperRoman':
      return roman(n).toUpperCase();
    case 'ordinal':
      return `${n}${ordinalSuffix(n)}`;
    default:
      return String(n);
  }
}

export interface ListLabel {
  text: string;
  /** What separates the label from the text. */
  suffix: 'tab' | 'space' | 'nothing';
  level: number;
}

/** A saved counter state (see ListCounter.snapshot). Treat as opaque and immutable. */
export type ListState = ReadonlyMap<string, readonly number[]>;

export class ListCounter {
  /** Current counts per list and level. */
  private readonly counts = new Map<string, number[]>();
  private saved: ListState | null = null;

  constructor(private readonly resolver: StyleResolver) {}

  /** The current state, to resume counting from later (layout restarting mid-document). */
  snapshot(): ListState {
    if (!this.saved) this.saved = new Map([...this.counts].map(([key, counts]) => [key, [...counts]]));
    return this.saved;
  }

  restore(state: ListState): void {
    this.counts.clear();
    for (const [key, counts] of state) this.counts.set(key, [...counts]);
    this.saved = state;
  }

  static sameState(a: ListState, b: ListState): boolean {
    if (a === b) return true;
    if (a.size !== b.size) return false;
    for (const [key, counts] of a) {
      const other = b.get(key);
      if (!other || other.some((n, i) => n !== counts[i])) return false;
    }
    return true;
  }

  /**
   * The label for the next paragraph with this numbering reference (already resolved through
   * its style), or undefined if it isn't a list item.
   */
  next(ref: NumberingReference | undefined): ListLabel | undefined {
    if (!ref?.id) return undefined;
    const ilvl = Math.min(Math.max(ref.level ?? 0, 0), 8);
    const numbering = this.resolver.numbering;
    const instance = numbering?.instances.find((n) => n.id === ref.id);
    if (!instance) return undefined;
    const definition = this.resolver.listLevel(ref.id, ilvl);
    if (!definition) return undefined;

    // Instances of one abstract definition share counters unless they restart numbering with
    // startOverride; overriding a level's format alone keeps counting (as Word does).
    const restarts = instance.overrides.some((o) => o.startOverride !== undefined);
    const key = restarts ? `num:${instance.id}` : `abstract:${instance.abstractId}`;
    this.saved = null;
    let counts = this.counts.get(key);
    if (!counts) {
      counts = new Array(9).fill(0);
      this.counts.set(key, counts);
    }

    const levels = Array.from({ length: 9 }, (_, l) => this.resolver.listLevel(ref.id, l));
    counts[ilvl] = counts[ilvl] === 0 ? (definition.start ?? 1) : counts[ilvl] + 1;
    // Deeper levels restart (unless their lvlRestart says otherwise).
    for (let l = ilvl + 1; l < 9; l++) {
      // lvlRestart: 0 = never; N = restart after level N (1-based) or any level above it.
      const restart = levels[l]?.restart;
      if (restart === undefined || (restart !== 0 && ilvl < restart)) counts[l] = 0;
    }

    let text = definition.text ?? '';
    if (definition.format !== 'bullet') {
      text = text.replace(/%([1-9])/g, (_, d: string) => {
        const l = Number(d) - 1;
        const n = counts![l] || (levels[l]?.start ?? 1);
        const format = definition.isLegal && l < ilvl ? 'decimal' : levels[l]?.format;
        return formatNumber(n, format);
      });
    }
    return { text, suffix: definition.suffix ?? 'tab', level: ilvl };
  }
}
