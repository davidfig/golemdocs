// Spelling and grammar marks for the lines of a plain text file. The checking is done by the layout worker (it owns the dictionaries
// and the words the person added or ignored); this keeps the answers per line text, asks for the lines on screen a batch at a time
// a moment after they appear, and draws again when answers arrive.

import type { SpellIssue, TextMark } from '../layout/protocol.ts';

export interface SpellDeps {
  /** What to underline in a file of this name (null: nothing: the person turned it off, or the file is not prose). */
  enabled(name: string): { spelling: boolean; grammar: boolean } | null;
  check(texts: string[], sample: string, what: { spelling: boolean; grammar: boolean }, at?: { index: number; offset: number }): Promise<{ marks: TextMark[][]; issue: SpellIssue | null; loading: boolean }>;
  /** Draw again: marks have arrived. */
  redraw(): void;
}

const BATCH = 200;
/** A longer line is not checked (it is a data line, not a sentence). */
const MAX_LINE = 2000;
const KEPT = 6000;
const HAS_WORDS = /\p{L}{2}/u;

export class TextSpell {
  private marks = new Map<string, readonly TextMark[]>();
  private wanted = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private sample = '';
  private what: { spelling: boolean; grammar: boolean } | null = null;

  constructor(private readonly deps: SpellDeps) {}

  /** A file was opened or what counts as a mistake changed: forget the answers; `sample` is the beginning of the file (it says its language). */
  reset(name: string, sample = this.sample): void {
    this.generation++;
    clearTimeout(this.timer);
    this.marks.clear();
    this.wanted.clear();
    this.sample = sample;
    this.what = this.deps.enabled(name);
  }

  get active(): boolean {
    return this.what !== null;
  }

  /** The marks of a line's text, or undefined while they are not known (they are asked for, and the view drawn again). */
  marksOf(text: string): readonly TextMark[] | undefined {
    if (!this.what || text.length > MAX_LINE || !HAS_WORDS.test(text)) return undefined;
    const known = this.marks.get(text);
    if (known) return known;
    if (!this.wanted.has(text)) {
      this.wanted.add(text);
      this.later(120);
    }
    return undefined;
  }

  private later(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), ms);
  }

  private async flush(): Promise<void> {
    const what = this.what;
    if (!what || !this.wanted.size) return;
    const generation = this.generation;
    const texts = [...this.wanted].slice(0, BATCH);
    for (const text of texts) this.wanted.delete(text);
    const answer = await this.deps.check(texts, this.sample, what);
    if (generation !== this.generation) return;
    if (answer.loading) {
      // A dictionary could not be loaded now: ask again a little later.
      for (const text of texts) this.wanted.add(text);
      this.later(3000);
      return;
    }
    if (this.marks.size > KEPT) this.marks.clear();
    texts.forEach((text, i) => this.marks.set(text, answer.marks[i] ?? []));
    this.deps.redraw();
    if (this.wanted.size) this.later(0);
  }

  /** What is wrong in each of some lines, whatever the live checking is set to (for the Spelling and Grammar dialog). */
  async scan(texts: string[], grammar: boolean): Promise<TextMark[][]> {
    return (await this.deps.check(texts, this.sample, { spelling: true, grammar })).marks;
  }

  /** The problem at an offset of a line, with its suggestions, whatever the live checking is set to. */
  async describe(text: string, offset: number, grammar: boolean): Promise<SpellIssue | null> {
    return (await this.deps.check([text], this.sample, { spelling: true, grammar }, { index: 0, offset })).issue;
  }

  /** What is wrong at an offset of a line (for the right-click menu). */
  async issueAt(text: string, offset: number): Promise<SpellIssue | null> {
    const what = this.what;
    if (!what) return null;
    return (await this.deps.check([text], this.sample, what, { index: 0, offset })).issue;
  }
}
