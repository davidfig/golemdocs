// Keeping live blocks up to date across the vault (docs/live-blocks.md §5-6). The vault graph is the search index's list of
// the sources each document's live blocks show (docx search/links.ts, kept apart from its other links), turned around: from a
// source to the documents that depend on it. When a source is saved, its dependents are updated after a pause in editing, and theirs
// after them, in order, each once. A document is also checked when it is opened, and after a sync brings in a changed source.
//
// The app's side (where documents are kept, the open one, uploads) comes in as `KeeperDeps`, so this is testable alone.

import type { LiveOptions, LiveOwner } from './owner.ts';
import { builtinReads } from './builtinAddress.ts';
import { buttonScript, isScriptSource, scriptPathOf } from './scriptAddress.ts';
import type { SourceFile } from './sources.ts';
import type { LiveResult } from './result.ts';
import type { UpdateReport } from './update.ts';
import type { StoredLookup, StoredSource, StoredUpdater } from './storedLookup.ts';

/** How long after the last save of a source its dependents wait (the open sheet saves every second or two while edited). */
export const LIVE_PAUSE_MS = 30_000;
/** A chain of documents updating each other stops this deep: deeper is a cycle the index could not see, or a mistake. */
const MAX_DEPTH = 10;

/** How an update of one document went. */
export type UpdateOutcomeKind = 'written' | 'unchanged' | 'notNow';

export interface KeeperEntry {
  key: string;
  name: string;
}

export interface KeeperDeps<E extends KeeperEntry> {
  /** The documents there are. */
  entries(): readonly E[];
  /** Whose blocks to update (owner.ts); absent, every block counts as the person's. */
  owner?(): Promise<LiveOwner>;
  /** For each document with live blocks, the titles of their sources as written. */
  links(): Promise<ReadonlyMap<string, readonly string[]>>;
  /** The document a title names, as written in the document `from` (its folder counts for plain and relative titles). */
  find(title: string, from: E): E | undefined;
  /** The documents in the folder a path names, as written in `from`, and in its subfolders; null when there is no such folder. */
  folder(path: string, from: E): readonly E[] | null;
  /** A document's stored bytes, or null. */
  read(entry: E): Promise<ArrayBuffer | null>;
  /** A drawing's SVG and a picture of it, for a source that is one (null when it is not a drawing), where updates run on the page. */
  drawing(bytes: Uint8Array): Promise<SourceFile['drawing'] | null>;
  /**
   * Runs an update away from the page (the live worker, docs/live-blocks.md §6): the document and its sources' bytes are
   * handed over, and only the new bytes come back. Missing: updates run on the page.
   */
  updater?: StoredUpdater;
  /** A script's result for a block in `from` (docs/live-blocks.md §8); missing where scripts can't run. */
  script?(from: E, path: string): Promise<LiveResult>;
  /**
   * What a script's last run read (vault paths; a folder ends in `/`) and the scripts it is made of: a block showing it
   * depends on those as on its source.
   */
  scriptReads?(path: string): readonly string[];
  /** A button block's label, from its action (docs/live-blocks.md §8). */
  button?(path: string): Promise<LiveResult>;
  /** A document exported as a PDF (for a live export), from its stored bytes; null when that can't be done now. */
  exportPdf?(entry: E, bytes: Uint8Array): Promise<Uint8Array | null>;
  /** Whether a document's blocks may be updated now (not while others edit it, say); yes when missing. Asked before it is read. */
  writable?(entry: E): boolean;
  /** Stores a document's new bytes (and shows them, if it is the open one); false when that can't be done now. */
  write(entry: E, bytes: Uint8Array): Promise<boolean>;
  /** Told how each update of a document went (including when nothing needed doing). */
  report?(entry: E, report: UpdateReport): void;
}

export class LiveKeeper<E extends KeeperEntry> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Set<string>();
  private running: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: KeeperDeps<E>,
    private readonly pause = LIVE_PAUSE_MS,
  ) {}

  /** A document was saved: what depends on it is updated once editing pauses. */
  saved(key: string): void {
    this.pending.add(key);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.pause);
  }

  /** Updates now what is waiting (the app is hidden, the source closed); resolves when done. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const keys = [...this.pending];
    this.pending.clear();
    if (keys.length) this.running = this.running.then(() => this.dependentsOf(keys)).catch((e: unknown) => console.error(e));
    return this.running;
  }

  /** Brings one document's blocks up to date (opening it, or after a sync changed it); whether it was rewritten. */
  check(key: string, options: LiveOptions = {}): Promise<boolean> {
    return this.outcome(key, options).then((outcome) => outcome === 'written');
  }

  /**
   * The same, saying whether the document was rewritten, needed nothing, or could not be done now (it could not be read or
   * written, or the update failed): background updates try the last again later.
   */
  outcome(key: string, options: LiveOptions = {}): Promise<UpdateOutcomeKind> {
    const run = this.running.then(async () => {
      const entry = this.deps.entries().find((e) => e.key === key);
      return entry ? this.update(entry, options) : 'unchanged';
    });
    this.running = run.then(
      () => undefined,
      () => undefined,
    );
    return run.catch((): UpdateOutcomeKind => 'notNow');
  }

  /**
   * What a block of this address shows, its document found from the top of the vault (`/Books/Budget.xlsx#Total`): a
   * script reads a sheet so. Seen from `from`, or from any document.
   */
  async produce(address: string, from?: E): Promise<LiveResult> {
    const at = from ?? this.deps.entries()[0];
    if (!at) return { kind: 'error', code: 'missing', detail: address };
    const { resultOf, sourceLookupOf } = await import('./stored.ts');
    return resultOf(address, sourceLookupOf(this.lookup(at, await this.deps.links()), (bytes) => this.deps.drawing(bytes)));
  }

  /** Whether a document has live blocks (so opening it is worth a check). */
  async mayHaveLive(key: string): Promise<boolean> {
    return ((await this.deps.links()).get(key) ?? []).length > 0;
  }

  /** The documents a document's blocks show, as written (for the public link's note: visitors see their last results). */
  async tableSources(key: string): Promise<string[]> {
    return [...new Set(((await this.deps.links()).get(key) ?? []).map((title) => title.split('#')[0].trim()))];
  }

  /** The documents whose blocks show any of these documents (for updates in the background). */
  async dependentsOfKeys(keys: string[]): Promise<E[]> {
    return this.dependents(keys, await this.deps.links());
  }

  /** The documents a document's blocks read (for what an update loads). */
  async sourcesOf(entry: E): Promise<E[]> {
    const titles = (await this.deps.links()).get(entry.key) ?? [];
    const out = new Map<string, E>();
    for (const title of titles) for (const found of this.reads(title, entry)) out.set(found.key, found);
    return [...out.values()];
  }

  /** Updates what depends on the sources, then what depends on those, each document once, in order. */
  private async dependentsOf(sources: string[]): Promise<void> {
    const links = await this.deps.links();
    const done = new Set<string>(sources);
    let wave = sources;
    for (let depth = 0; wave.length && depth < MAX_DEPTH; depth++) {
      const next: string[] = [];
      for (const entry of this.dependents(wave, links)) {
        if (done.has(entry.key)) continue;
        done.add(entry.key);
        if ((await this.update(entry).catch(() => 'notNow')) === 'written') next.push(entry.key);
      }
      wave = next;
    }
  }

  /** The documents that link to any of the sources. */
  private dependents(sources: string[], links: ReadonlyMap<string, readonly string[]>): E[] {
    const wanted = new Set(sources);
    const entries = this.deps.entries();
    const out: E[] = [];
    for (const [key, titles] of links) {
      const entry = entries.find((e) => e.key === key);
      if (entry && titles.some((title) => this.reads(title, entry).some((e) => wanted.has(e.key)))) out.push(entry);
    }
    return out;
  }

  /** The documents a block's source reads, from where `from` is: the file it names, or a built-in block's folder or document. */
  private reads(title: string, from: E): E[] {
    // A button: its action's file (its name is the button's label).
    const button = buttonScript(title);
    if (button) return [this.deps.find(`/${button}`, from)].filter((e): e is E => !!e && e.key !== from.key);
    // A script: itself and what its last run read, found from the top of the vault as scripts name them.
    if (isScriptSource(title)) {
      const script = scriptPathOf(title);
      const paths = [script, ...(this.deps.scriptReads?.(script) ?? [])];
      const found = paths.flatMap((path) => (path.endsWith('/') ? (this.deps.folder(`/${path.slice(0, -1)}`, from) ?? []) : [this.deps.find(`/${path}`, from)].filter((e): e is E => !!e)));
      return found.filter((e) => e.key !== from.key);
    }
    const builtin = builtinReads(title);
    if (!builtin) {
      const found = this.deps.find(title, from);
      return found ? [found] : [];
    }
    const document = builtin.document !== null ? this.deps.find(builtin.document, from) : undefined;
    return [...(document ? [document] : []), ...(this.deps.folder(builtin.folder, from) ?? [])].filter((e) => e.key !== from.key);
  }

  /** Updates one document's blocks from its stored bytes; whether it changed. */
  private async update(entry: E, options: LiveOptions = {}): Promise<UpdateOutcomeKind> {
    if (this.deps.writable?.(entry) === false) return 'notNow';
    // Whose blocks to update: only the person's own (owner.ts).
    const owner = await this.deps.owner?.();
    if (owner) options = { ...options, owner };
    const bytes = await this.deps.read(entry);
    if (!bytes) return 'notNow';
    const links = await this.deps.links();
    const { bytes: next, report } = await this.updater(new Uint8Array(bytes), entry.name, this.lookup(entry, links), options);
    // Told every time, so a block that works again stops saying it didn't.
    this.deps.report?.(entry, report);
    if (!next) return 'unchanged';
    return (await this.deps.write(entry, next)) ? 'written' : 'notNow';
  }

  /** Where an update runs: the live worker, or the page (reading and writing documents, and the producers, are fetched then). */
  private readonly updater: StoredUpdater = (bytes, name, lookup, options) =>
    this.deps.updater ? this.deps.updater(bytes, name, lookup, options) : import('./stored.ts').then(({ updateFromStored }) => updateFromStored(bytes, name, lookup, (b) => this.deps.drawing(b), options));

  /** Finds the sources a document's blocks name, from where that document is, as stored. */
  private lookup(from: E, links: ReadonlyMap<string, readonly string[]>): StoredLookup {
    // The documents handed out, by key (a live export is asked for by key).
    const handed = new Map<string, E>();
    const source = async (found: E): Promise<StoredSource | null> => {
      const stored = await this.deps.read(found);
      if (!stored) return null;
      handed.set(found.key, found);
      return { name: found.name, key: found.key, stored: new Uint8Array(stored) };
    };
    const lookup: StoredLookup = {
      file: async (title) => {
        const found = this.deps.find(title, from);
        if (!found) return null;
        // A source that shows, through its own blocks, the document being updated (or is it): the block says so instead.
        if (this.reaches(found, from.key, links)) return { name: found.name, key: found.key, stored: new Uint8Array(), cycle: true };
        return source(found);
      },
      // A folder's documents, for built-in blocks: never the document being updated, nor one that shows it.
      folder: async (path) => {
        const entries = this.deps.folder(path, from);
        if (!entries) return null;
        const sources = await Promise.all(entries.filter((e) => !this.reaches(e, from.key, links)).map(source));
        return sources.filter((s): s is StoredSource => s !== null);
      },
      // A whole document as a PDF, for a live export: from its stored bytes, as the document opens.
      exportPdf: async (key, stored) => {
        const found = handed.get(key);
        return found && this.deps.exportPdf ? this.deps.exportPdf(found, stored) : null;
      },
    };
    if (this.deps.script) lookup.script = (path) => this.deps.script!(from, path);
    if (this.deps.button) lookup.button = (path) => this.deps.button!(path);
    return lookup;
  }

  /** Whether `start` is the document `target`, or shows it through live blocks, directly or through others. */
  private reaches(start: E, target: string, links: ReadonlyMap<string, readonly string[]>): boolean {
    const seen = new Set<string>();
    const walk = (entry: E, depth: number): boolean => {
      if (entry.key === target) return true;
      if (seen.has(entry.key) || depth > MAX_DEPTH) return false;
      seen.add(entry.key);
      for (const title of links.get(entry.key) ?? []) for (const next of this.reads(title, entry)) if (walk(next, depth + 1)) return true;
      return false;
    };
    return walk(start, 0);
  }
}
