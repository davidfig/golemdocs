// Where the person is in each book (an EPUB), so it opens there on every device. A place is the text at the top of the
// view (a paragraph's index among the book's paragraphs, and an offset in it), which means the same thing on a phone and
// a computer even though their pages differ, with the page it was on there for showing. A book is known by the hash of
// its text (the layout worker's `bookKey`): the same book finds the same place whatever file it came in.
//
// The place is kept in this browser at once, and in the account (/api/reading, server/src/reading.ts) for people with
// sync. The latest reading wins, wherever it was: going back to reread a chapter on the phone moves the computer back too.

import type { TextPlace } from './viewMemory.ts';

export interface ReadingPlace {
  /** The text at the top of the view. */
  place: TextPlace;
  /** The page it was on, and how many there were, where it was read (for "page 12 of 300"; pages differ by device). */
  page: number;
  pages: number;
  /** When it was read there (ms since 1970). */
  at: number;
}

const STORAGE_KEY = 'golemdocs.reading';
export const MAX_BOOKS = 500;

const whole = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;

/** A stored place, or null if it isn't one. */
export function cleanPlace(v: unknown): ReadingPlace | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  const place = o.place;
  if (!Array.isArray(place) || place.length !== 2 || !place.every(whole)) return null;
  if (!whole(o.page) || !whole(o.pages) || typeof o.at !== 'number' || !Number.isFinite(o.at)) return null;
  return { place: [place[0], place[1]], page: o.page, pages: o.pages, at: o.at };
}

/** A place as the account keeps it (text), and back. */
export const encodePlace = (r: ReadingPlace): string => JSON.stringify({ place: r.place, page: r.page, pages: r.pages });
/** `readAt` and `now` are the server's clock: the reading is put on this device's clock by how long ago it was. */
export function decodePlace(text: string | null, readAt: number | null, now: number, here = Date.now()): ReadingPlace | null {
  if (!text || readAt === null) return null;
  try {
    return cleanPlace({ ...(JSON.parse(text) as object), at: here - Math.max(0, now - readAt) });
  } catch {
    return null;
  }
}

/** The later of two readings (the first when they tie). */
export const later = (a: ReadingPlace | null, b: ReadingPlace | null): ReadingPlace | null => (!a ? b : !b ? a : b.at > a.at ? b : a);

/** Whether two places are the same text (when they were read aside). */
export const samePlace = (a: ReadingPlace | null, b: ReadingPlace | null): boolean => !!a && !!b && a.place[0] === b.place[0] && a.place[1] === b.place[1];

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readAll(storage: Store | null): [string, ReadingPlace][] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const rows: [string, ReadingPlace][] = [];
    for (const row of parsed) {
      const place = Array.isArray(row) && typeof row[0] === 'string' ? cleanPlace(row[1]) : null;
      if (place) rows.push([(row as [string, unknown])[0], place]);
    }
    return rows;
  } catch {
    return [];
  }
}

/** Where this browser last left a book. */
export function localPlace(book: string, storage: Store | null = safeStorage()): ReadingPlace | null {
  return readAll(storage).find(([key]) => key === book)?.[1] ?? null;
}

/** Keeps a book's place in this browser, most recent first, at most `max` books. */
export function keepLocalPlace(book: string, place: ReadingPlace, storage: Store | null = safeStorage(), max = MAX_BOOKS): void {
  try {
    const rows = [[book, place] as [string, ReadingPlace], ...readAll(storage).filter(([key]) => key !== book)].slice(0, max);
    storage?.setItem(STORAGE_KEY, JSON.stringify(rows));
  } catch {
    // Storage unavailable or full: the place is simply not remembered here.
  }
}

/** Where the account keeps places. */
export interface ReadingApi {
  get(book: string): Promise<ReadingPlace | null>;
  put(book: string, place: ReadingPlace, leaving?: boolean): Promise<void>;
}

export const serverReading: ReadingApi = {
  async get(book) {
    const response = await fetch(`/api/reading?book=${book}`);
    if (!response.ok) throw new Error(String(response.status));
    const body = (await response.json()) as { place: string | null; readAt: number | null; now: number };
    return decodePlace(body.place, body.readAt, body.now);
  },
  async put(book, place, leaving = false) {
    const response = await fetch('/api/reading', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      // How long ago, not when: the server's clock decides which reading is the latest.
      body: JSON.stringify({ book, place: encodePlace(place), age: Math.max(0, Date.now() - place.at) }),
      // Leaving the page: sent even as it goes.
      keepalive: leaving,
    });
    if (response.status === 401 || response.status === 402 || response.status === 403) throw new ReadingRefused();
    if (!response.ok) throw new Error(String(response.status));
  },
};

/** The account won't keep places (signed out, or no sync): this browser keeps them alone. */
export class ReadingRefused extends Error {}

/** How long reading has to stay on a page before the account is told (turning pages quickly sends only the last). */
const SEND_MS = 4000;

/**
 * One open book's place: kept here as the person reads, sent to the account a few seconds after they stop, and checked
 * against the account when they come back to it (another device may have read on since).
 */
export class BookReading {
  /** The place last kept, here or from the account. */
  current: ReadingPlace | null;
  private unsent: ReadingPlace | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  /** The account said no: places stay in this browser. */
  private refused = false;

  constructor(
    readonly book: string,
    /** Whether the account keeps places (signed in, with sync). */
    private readonly synced: () => boolean,
    private readonly api: ReadingApi = serverReading,
    private readonly storage: Store | null = safeStorage(),
  ) {
    this.current = localPlace(book, storage);
  }

  /** The account's place when it was read later than this browser's (another device read on), else null. Offline: null. */
  async fromAccount(): Promise<ReadingPlace | null> {
    if (!this.synced() || this.closed || this.refused) return null;
    // What was read here while offline goes first.
    if (this.unsent) await this.send();
    const theirs = await this.api.get(this.book).catch(() => null);
    return this.takeIfLater(theirs);
  }

  /**
   * The person is reading here now. `landed`: this is where the view was put for `current` (opening the book there, or
   * going to a later reading from elsewhere), not moved since.
   */
  read(place: Omit<ReadingPlace, 'at'>, at = Date.now(), landed = false): void {
    if (this.closed) return;
    if (landed && this.current) {
      // On another screen the view starts a little differently, but it is the same reading, as old as it was, and
      // nothing to send (sending it as new would win over a later reading elsewhere).
      this.current = { ...place, at: this.current.at };
      keepLocalPlace(this.book, this.current, this.storage);
      return;
    }
    const reading: ReadingPlace = { ...place, at };
    // The same text (a resize, a zoom): nothing new to tell anyone, but the page shown may differ.
    const moved = !samePlace(this.current, reading);
    this.current = moved ? reading : { ...reading, at: this.current!.at };
    keepLocalPlace(this.book, this.current, this.storage);
    if (!moved) return;
    this.unsent = this.current;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.send(), SEND_MS);
  }

  /** Sends what hasn't been sent (`leaving`: the page is going away, or the book is closed). */
  async send(leaving = false): Promise<void> {
    clearTimeout(this.timer);
    const place = this.unsent;
    this.unsent = null;
    if (!place || !this.synced() || this.refused) return;
    await this.api.put(this.book, place, leaving).catch((e: unknown) => {
      if (e instanceof ReadingRefused) this.refused = true;
      // Offline: tried again with the next page turned, or when the person comes back to the book.
      else if (!this.unsent) this.unsent = place;
    });
  }

  /** Stops, sending the last place. */
  close(): void {
    if (this.closed) return;
    void this.send(true);
    this.closed = true;
  }

  private takeIfLater(theirs: ReadingPlace | null): ReadingPlace | null {
    if (!theirs || this.closed || this.unsent) return null;
    if (this.current && (theirs.at <= this.current.at || samePlace(theirs, this.current))) return null;
    this.current = theirs;
    keepLocalPlace(this.book, theirs, this.storage);
    return theirs;
  }
}
