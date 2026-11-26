// A document's word history: how many words it had at the end of each day someone wrote in it, so Tools › Word Count can show
// the progress made day by day and the status bar the words written today, this week, this month or this year.
//
// A day is a row { day, words, start }: `words` is the count at the end of the day (the last one seen), `start` the count when
// the day's writing began (the first one seen that day, by whichever device). What was written on a day is `words - start`;
// a day with no start (filled in from a kept version) is measured from the day before it. So edits made elsewhere between two
// sessions (in another app, by an agent in the vault) are not counted as written in the app, and a day's count is always the
// app's own (the server counts versions with the same rules, docx/src/edit/wordCount.ts, but a document converted from
// Markdown or HTML can count a little differently there).
//
// Days are the writer's own calendar (local dates). Rows are kept on this device (storage/wordStore.ts) and, for documents in the
// account, with the document there (/api/documents/:id/words, server/src/wordCounts.ts), where everyone who can edit a shared
// document adds to one history. Only days with writing are kept: opening a document and reading it leaves nothing behind.

import { CloudError, cloudVersionWords, cloudWordDays, keepCloudWordDays, listCloudVersions, type CloudVersion } from './cloud.ts';
import { getLocale } from './i18n/index.ts';
import type { WordRecord, WordStore } from './storage/wordStore.ts';

export interface WordDay {
  /** yyyy-mm-dd, on the writer's calendar. */
  day: string;
  words: number;
  start: number | null;
}

/** What the status bar's word count says: the document's words, or the words written in a span of time up to today. */
export type WordPeriod = 'total' | 'today' | 'week' | 'month' | 'year';
export const WORD_PERIODS: readonly WordPeriod[] = ['total', 'today', 'week', 'month', 'year'];

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** A date's day on this computer's calendar. */
export const dayOf = (date: Date): string => `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** A day as a local date (noon, so a change of clocks can't move it to another day). */
export function dateOf(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!, 12);
}

export function addDays(day: string, n: number): string {
  const date = dateOf(day);
  date.setDate(date.getDate() + n);
  return dayOf(date);
}

/** The first day of the week where the person is: 1 Monday … 7 Sunday (Monday when the browser can't say). */
export function firstDayOfWeek(locale = getLocale()): number {
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const first = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay;
    return first && first >= 1 && first <= 7 ? first : 1;
  } catch {
    return 1;
  }
}

/** The first day of a period that ends today (`total` has none: null). */
export function periodStart(period: WordPeriod, today: string, firstDay = firstDayOfWeek()): string | null {
  if (period === 'total') return null;
  if (period === 'today') return today;
  if (period === 'month') return `${today.slice(0, 7)}-01`;
  if (period === 'year') return `${today.slice(0, 4)}-01-01`;
  // getDay: 0 Sunday … 6 Saturday; firstDay: 1 Monday … 7 Sunday.
  const weekday = dateOf(today).getDay() || 7;
  return addDays(today, -((weekday - firstDay + 7) % 7));
}

/** Each day's words written (negative when more was cut than written), oldest first. */
export function dailyProgress(days: readonly WordDay[]): { day: string; written: number; words: number }[] {
  const sorted = [...days].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return sorted.map((d, i) => ({ day: d.day, written: d.words - (d.start ?? sorted[i - 1]?.words ?? d.words), words: d.words }));
}

/** The words written from `from` to `to` (both included). */
export function writtenBetween(days: readonly WordDay[], from: string, to: string): number {
  let sum = 0;
  for (const d of dailyProgress(days)) if (d.day >= from && d.day <= to) sum += d.written;
  return sum;
}

/** What the status bar shows for a period: the words written in it, or (`total`) the document's words. */
export function periodWords(period: WordPeriod, days: readonly WordDay[], total: number, today: string, firstDay = firstDayOfWeek()): number {
  const from = periodStart(period, today, firstDay);
  return from === null ? total : writtenBetween(days, from, today);
}

/** The bars of a chart of progress: one per day, or (`month` buckets) per month, from `from` to `to` with empty ones filled in. */
export function progressBars(days: readonly WordDay[], from: string, to: string, by: 'day' | 'month'): { key: string; written: number }[] {
  const written = new Map<string, number>();
  for (const d of dailyProgress(days)) {
    if (d.day < from || d.day > to) continue;
    const key = by === 'day' ? d.day : d.day.slice(0, 7);
    written.set(key, (written.get(key) ?? 0) + d.written);
  }
  const out: { key: string; written: number }[] = [];
  if (by === 'day') {
    for (let day = from; day <= to; day = addDays(day, 1)) out.push({ key: day, written: written.get(day) ?? 0 });
  } else {
    let [y, m] = from.split('-').map(Number) as [number, number];
    const end = to.slice(0, 7);
    for (let key = `${pad(y, 4)}-${pad(m)}`; key <= end; key = `${pad(y, 4)}-${pad(m)}`) {
      out.push({ key, written: written.get(key) ?? 0 });
      if (++m > 12) {
        m = 1;
        y++;
      }
    }
  }
  return out;
}

/** The account's days with this device's unsent ones on top (they are later); a start, once known anywhere, is kept. */
export function mergeDays(account: readonly WordDay[], pending: readonly WordDay[]): WordDay[] {
  const byDay = new Map(account.map((d) => [d.day, d]));
  for (const mine of pending) {
    const theirs = byDay.get(mine.day);
    byDay.set(mine.day, { ...mine, start: theirs?.start ?? mine.start });
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

/** Where a document's history is kept in the account. */
export interface WordApi {
  get(id: string): Promise<WordDay[]>;
  put(id: string, days: readonly WordDay[], options?: { fill?: boolean; leaving?: boolean }): Promise<void>;
  versions(id: string): Promise<Pick<CloudVersion, 'version' | 'sealed'>[]>;
  versionWords(id: string, version: number): Promise<number | null>;
}

export const cloudWordApi: WordApi = {
  get: cloudWordDays,
  put: keepCloudWordDays,
  versions: listCloudVersions,
  versionWords: cloudVersionWords,
};

/** How long after the last change a count is sent to the account (a burst of typing sends only its end). */
const SEND_MS = 20_000;
/** How long after the last change a count is kept on this device. */
const KEEP_MS = 1500;
/** Days filled in from versions at most, the latest first. */
export const MAX_FILLED_DAYS = 60;

/** Where an open document's history is kept: on this device under `key`, and in the account under `cloudId` while `sync()`. */
export interface WordPlace {
  /** `cloud:<id>` or `local:<id>`; null until the document has been saved at all. */
  key: string | null;
  cloudId: string | null;
}

/**
 * The open document's word history. It is told the document's word count as it changes (`count`), keeps the day's row on this
 * device a moment later and sends it to the account a little after that, and answers the history with what it learned.
 */
export class DocumentWords {
  private days = new Map<string, WordDay>();
  /** Days changed here and not yet taken by the account. */
  private pending = new Set<string>();
  private keepTimer: ReturnType<typeof setTimeout> | undefined;
  private sendTimer: ReturnType<typeof setTimeout> | undefined;
  /** The last count seen, and on which day: a day that begins while the document is open starts from it. */
  private last: { day: string; words: number } | null = null;
  /** The count when this session first saw today's text (whether or not anything has been written yet). */
  private sessionStart = new Map<string, number>();
  private closed = false;
  /** The account won't keep it (no sync, read-only, an encrypted document): this device keeps it alone. */
  private refused = false;
  private filled = false;
  private loaded: Promise<void>;
  private readonly listeners = new Set<() => void>();

  constructor(
    private place: WordPlace,
    private readonly store: WordStore,
    /** Whether the account keeps histories (signed in with sync, and the document is not encrypted). */
    private readonly sync: () => boolean,
    private readonly api: WordApi = cloudWordApi,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.loaded = this.load();
  }

  /** Calls `listener` whenever the history changes (a count, or the account's days arriving). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves once this device's and the account's days are in. */
  ready(): Promise<void> {
    return this.loaded;
  }

  history(): WordDay[] {
    return [...this.days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  }

  today(): string {
    return dayOf(this.now());
  }

  /** The document's words now. */
  count(words: number): void {
    if (this.closed) return;
    const today = this.today();
    if (!this.sessionStart.has(today)) {
      // A new day: if the document was open at midnight, the day starts where the last one ended.
      this.sessionStart.set(today, this.last && this.last.day !== today ? this.last.words : words);
    }
    this.last = { day: today, words };
    const row = this.days.get(today);
    const start = row?.start ?? this.sessionStart.get(today)!;
    // Nothing written today (just opened, or read): nothing to keep.
    if (!row && words === start) return;
    if (row && row.words === words && row.start === start) return;
    this.days.set(today, { day: today, words, start });
    this.pending.add(today);
    this.changed();
    clearTimeout(this.keepTimer);
    this.keepTimer = setTimeout(() => void this.keep(), KEEP_MS);
    clearTimeout(this.sendTimer);
    this.sendTimer = setTimeout(() => void this.send(), SEND_MS);
  }

  /** The document was saved somewhere new (first saved here, or first uploaded): its history moves with it. */
  async moved(place: WordPlace): Promise<void> {
    if (place.key === this.place.key && place.cloudId === this.place.cloudId) return;
    const old = this.place.key;
    this.place = place;
    // Everything this device knew goes to the account under the new id.
    if (place.cloudId) for (const day of this.days.keys()) this.pending.add(day);
    await this.keep();
    if (old && old !== place.key) await this.store.delete(old).catch(() => {});
    void this.send();
  }

  /** Keeps what changed on this device, and sends it (`leaving`: the page is going, or the document is closed). */
  async flush(leaving = false): Promise<void> {
    // Leaving: the request goes first, while the page is still there to send it (kept alive); this device's copy after.
    if (leaving) {
      const sending = this.send(true);
      await this.keep();
      await sending;
      return;
    }
    await this.keep();
    await this.send();
  }

  close(): void {
    if (this.closed) return;
    void this.flush(true);
    this.closed = true;
    this.listeners.clear();
  }

  /**
   * Fills in the days before the history began from the document's kept versions (the last one of each day), counted by the
   * server, at most `MAX_FILLED_DAYS` of them. Once per document per device.
   */
  async fillFromVersions(): Promise<number> {
    await this.loaded;
    const id = this.place.cloudId;
    if (!id || !this.sync() || this.refused || this.filled || this.closed) return 0;
    this.filled = true;
    let versions: Pick<CloudVersion, 'version' | 'sealed'>[];
    try {
      versions = await this.api.versions(id);
    } catch {
      this.filled = false;
      return 0;
    }
    // The last version of each day that has no row, latest days first.
    const lastOfDay = new Map<string, number>();
    for (const v of versions) {
      if (v.sealed) continue;
      const day = dayOf(new Date(v.version));
      if (this.days.has(day)) continue;
      if ((lastOfDay.get(day) ?? -1) < v.version) lastOfDay.set(day, v.version);
    }
    const wanted = [...lastOfDay].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, MAX_FILLED_DAYS);
    const found: WordDay[] = [];
    for (const [day, version] of wanted) {
      if (this.closed) return 0;
      const words = await this.api.versionWords(id, version).catch(() => null);
      if (words !== null) found.push({ day, words, start: null });
    }
    if (!found.length) {
      await this.saveRecord();
      return 0;
    }
    for (const d of found) if (!this.days.has(d.day)) this.days.set(d.day, d);
    await this.saveRecord();
    this.changed();
    await this.api.put(id, found, { fill: true }).catch((e: unknown) => this.refusedBy(e));
    return found.length;
  }

  private async load(): Promise<void> {
    const key = this.place.key;
    const record = key ? await this.store.get(key).catch(() => null) : null;
    if (record) {
      for (const d of record.days) {
        // A count that came in while this was loading is later; the day's start, though, is the one kept.
        const mine = this.pending.has(d.day) ? this.days.get(d.day) : undefined;
        this.days.set(d.day, mine ? { ...mine, start: d.start ?? mine.start } : d);
      }
      for (const day of record.pending) this.pending.add(day);
      this.filled = record.filled;
    }
    this.changed();
    await this.fromAccount();
  }

  private async fromAccount(): Promise<void> {
    const id = this.place.cloudId;
    if (!id || !this.sync() || this.refused) return;
    let theirs: WordDay[];
    try {
      theirs = await this.api.get(id);
    } catch (e) {
      this.refusedBy(e);
      return;
    }
    if (this.closed) return;
    const mine = [...this.pending].map((day) => this.days.get(day)!).filter(Boolean);
    this.days = new Map(mergeDays(theirs, mine).map((d) => [d.day, d]));
    await this.saveRecord();
    this.changed();
    if (this.pending.size) void this.send();
  }

  private async keep(): Promise<void> {
    clearTimeout(this.keepTimer);
    await this.saveRecord();
  }

  private async saveRecord(): Promise<void> {
    const key = this.place.key;
    if (!key) return;
    const record: WordRecord = { days: this.history(), pending: [...this.pending], filled: this.filled, at: Date.now() };
    await this.store.put(key, record).catch(() => {});
  }

  private async send(leaving = false): Promise<void> {
    clearTimeout(this.sendTimer);
    const id = this.place.cloudId;
    if (!id || !this.sync() || this.refused || !this.pending.size) return;
    const sent = [...this.pending];
    const days = sent.map((day) => this.days.get(day)!).filter(Boolean);
    try {
      // One request holds at most 120 days (server/src/wordCounts.ts); more is sent the next time.
      await this.api.put(id, days.slice(-120), { leaving });
    } catch (e) {
      this.refusedBy(e);
      return; // offline: sent with the next change, or the next time the document opens
    }
    // What changed again while this was on its way stays to be sent.
    for (const d of days.slice(-120)) if (this.days.get(d.day)?.words === d.words) this.pending.delete(d.day);
    if (leaving) return;
    await this.saveRecord();
    if (this.pending.size > 0 && sent.length > 120) this.sendTimer = setTimeout(() => void this.send(), 0);
  }

  private refusedBy(e: unknown): void {
    // 401/402/403: not signed in, no sync, read-only. 409: encrypted. 404: not in the account (any more).
    if (e instanceof CloudError && [401, 402, 403, 404, 409].includes(e.status)) this.refused = true;
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}
