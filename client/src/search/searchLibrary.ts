// Searching every document the person has by what is in it. Each document has an index (see
// `buildIndex` in @golemdocs/docx) kept in this browser, made once from the document and made again
// only when it changes, so a search reads indexes and never documents. One path serves everyone:
// signed out, the documents are this browser's; signed in, an account's documents come with an
// index kept in the cloud next to each, which is fetched in place of reading the document, so a
// second computer doesn't do the work again. Where documents come from and where indexes are kept
// is passed in (main.ts knows both), so none of this needs a browser to test.

import { INDEX_VERSION, buildIndex, parseQuery, searchIndex, tagsOf, type DocIndex, type ParsedQuery } from '@golemdocs/docx';
import type { StoredIndex } from '../storage/local.ts';

/** A document that can be searched. */
export interface SearchableDocument {
  /** What its index is kept under: stable while the document exists. */
  key: string;
  name: string;
  updatedAt: number;
  size: number;
  /**
   * Which version of the document this is: `c:` and the account's `updatedAt` for the account's copy,
   * `l:` and the browser copy's for one that has changes the account doesn't. An index made for another
   * stamp is out of date.
   */
  stamp: string;
  /** Whose it is, when it isn't theirs ("shared by …"). */
  place?: string;
  /** Making its index takes the network (no copy of it is in this browser), so it waits until a person searches. */
  remote?: boolean;
  /** The document's bytes (a .docx, or the app's .wdoc around one), to make its index from. */
  bytes(): Promise<ArrayBuffer>;
  /** The account's index of it, if the account has one: asked for before reading the document. `at` is the version it is for. */
  fromCloud?(): Promise<{ index: DocIndex; at: number } | null>;
}

/** Where indexes are kept. */
export interface IndexStore {
  list(): Promise<Map<string, StoredIndex>>;
  put(key: string, stored: StoredIndex): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
}

export interface SearchHit {
  key: string;
  name: string;
  place?: string;
  updatedAt: number;
  score: number;
  /** The paragraph that matches best (from 0) and the text around the match; absent when only the name matches. */
  paragraph?: number;
  text?: string;
  /** How many paragraphs match. */
  paragraphs: number;
}

export interface SearchResult {
  query: ParsedQuery;
  hits: SearchHit[];
  /** Documents whose index isn't made yet, so a search can't see inside them: a later one will. */
  pending: number;
}

export interface IndexProgress {
  done: number;
  total: number;
}

/** Documents bigger than this aren't read for an index (they'd freeze the page, and aren't prose). */
const MAX_BYTES = 6_000_000;
const CONCURRENCY = 3;

/** Lets the page draw and answer between documents: an index of a large library takes a while. */
const breathe = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export class SearchLibrary {
  private indexes: Map<string, StoredIndex> | null = null;
  private loading: Promise<Map<string, StoredIndex>> | null = null;
  /** Bumped by `sync`: a pass that is no longer the latest stops. */
  private pass = 0;
  private running: Promise<void> | null = null;
  private readonly listeners = new Set<(progress: IndexProgress | null) => void>();

  /**
   * `build` makes the index of a document's bytes (in a worker, in the page: see indexClient.ts); it may take the
   * bytes over, so nothing here uses them afterwards.
   */
  constructor(
    private readonly store: IndexStore,
    private readonly build: (bytes: ArrayBuffer) => Promise<DocIndex>,
  ) {}

  /** Calls `listener` while documents are being indexed (and with null when that is over). */
  subscribe(listener: (progress: IndexProgress | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private announce(progress: IndexProgress | null): void {
    for (const listener of [...this.listeners]) listener(progress);
  }

  private async load(): Promise<Map<string, StoredIndex>> {
    if (this.indexes) return this.indexes;
    this.loading ??= this.store.list().then((all) => (this.indexes = all));
    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  /** The documents that need an index made (or made again). */
  async missing(docs: readonly SearchableDocument[]): Promise<SearchableDocument[]> {
    const all = await this.load();
    // An index made by an older version has no links in it: made again.
    return docs.filter((d) => all.get(d.key)?.stamp !== d.stamp || all.get(d.key)?.index.v !== INDEX_VERSION);
  }

  /** Makes the index of one document: the account's if it has one, else read from the document. Null when it can't be had now (offline). */
  private async make(doc: SearchableDocument): Promise<StoredIndex | null> {
    if (doc.size > MAX_BYTES) return { stamp: doc.stamp, index: buildIndex([]) };
    if (doc.fromCloud) {
      const found = await doc.fromCloud().catch(() => null);
      if (found) return { stamp: `c:${found.at}`, index: found.index };
    }
    return { stamp: doc.stamp, index: await this.build(await doc.bytes()) };
  }

  /**
   * Brings the indexes up to date for `docs`, a few at a time, and forgets those of documents that are gone.
   * A newer call takes over from one still running. Resolves when this pass is over, however it ended.
   * With `remote` false, documents that need the network wait (the page does this unasked; a search asks for them).
   */
  sync(docs: readonly SearchableDocument[], { remote = true }: { remote?: boolean } = {}): Promise<void> {
    const pass = ++this.pass;
    const run = async () => {
      const all = await this.load();
      const keep = new Set(docs.map((d) => d.key));
      const gone = [...all.keys()].filter((k) => !keep.has(k));
      if (gone.length) {
        for (const k of gone) all.delete(k);
        await this.store.remove(gone).catch(() => {});
      }
      // The ones changed most recently first: they are what is searched for most.
      const todo = (await this.missing(docs)).filter((d) => remote || !d.remote).sort((a, b) => b.updatedAt - a.updatedAt);
      if (!todo.length) return;
      let done = 0;
      let next = 0;
      this.announce({ done, total: todo.length });
      const worker = async () => {
        for (let doc = todo[next++]; doc && pass === this.pass; doc = todo[next++]) {
          try {
            const stored = await this.make(doc);
            if (stored && pass === this.pass) {
              all.set(doc.key, stored);
              await this.store.put(doc.key, stored);
            }
          } catch (e) {
            console.error('indexing failed', doc.name, e);
          }
          this.announce({ done: ++done, total: todo.length });
          await breathe();
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
    };
    const previous = this.running ?? Promise.resolve();
    // One pass at a time: a newer one waits for the older to notice it was replaced and stop.
    const mine = previous.then(run, run).finally(() => {
      if (this.running === mine) {
        this.running = null;
        this.announce(null);
      }
    });
    this.running = mine;
    return mine;
  }

  /** The titles each of `docs` links to, as written in its links (from its index, so none is read; a document with no index yet is absent). */
  async links(docs: readonly SearchableDocument[]): Promise<Map<string, string[]>> {
    const all = await this.load();
    const out = new Map<string, string[]>();
    for (const doc of docs) {
      const titles = Object.keys(all.get(doc.key)?.index.l ?? {});
      if (titles.length) out.set(doc.key, titles);
    }
    return out;
  }

  /** Whether documents are being indexed now. */
  get busy(): boolean {
    return this.running !== null;
  }

  /** Searches `docs` for `text`: words that must all be in a document, and `#tags` that it must use. Best matches first. */
  async search(text: string, docs: readonly SearchableDocument[]): Promise<SearchResult> {
    const query = parseQuery(text);
    if (!query.words.length && !query.tags.length) return { query, hits: [], pending: 0 };
    const all = await this.load();
    const hits: SearchHit[] = [];
    let pending = 0;
    for (const doc of docs) {
      const stored = all.get(doc.key);
      // An index for another version still finds what was there; a document with none can only be found by its name.
      if (stored?.stamp !== doc.stamp) pending++;
      const hit = stored ? searchIndex(stored.index, query, doc.name) : query.tags.length ? null : searchIndex(buildIndex([]), query, doc.name);
      if (!hit) continue;
      hits.push({
        key: doc.key,
        name: doc.name,
        ...(doc.place && { place: doc.place }),
        updatedAt: doc.updatedAt,
        score: hit.score,
        ...(hit.paragraphs > 0 && { paragraph: hit.paragraph, text: hit.text }),
        paragraphs: hit.paragraphs,
      });
    }
    hits.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
    return { query, hits, pending };
  }

  /** The tags used in `docs`, with how many documents use each, the most used first. */
  async tags(docs: readonly SearchableDocument[]): Promise<{ tag: string; documents: number }[]> {
    const all = await this.load();
    const counts = new Map<string, number>();
    for (const doc of docs) {
      const stored = all.get(doc.key);
      if (stored) for (const tag of tagsOf(stored.index).keys()) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts].map(([tag, documents]) => ({ tag, documents })).sort((a, b) => b.documents - a.documents || a.tag.localeCompare(b.tag));
  }

  /** Forgets what is kept in memory (a different account is signed in, or the storage was cleared). */
  reset(): void {
    this.pass++;
    this.indexes = null;
  }
}
