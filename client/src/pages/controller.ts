// Page view's working part (docs/html-pages.md): which pages open as pages, how a page is put together for its frame (its trust, its
// policy, its files inlined and its embeds filled), what its `golem` calls are answered with, how it follows the documents it read,
// and what it leaves for the people it is shared with. main.ts gives it the library and the app (`PageHost`); the frame is view.ts.

import { t } from '../i18n/index.ts';
import type { LiveResult } from '../live/result.ts';
import type { ChangedFile } from '../scripts/vault.ts';
import { normalizeFolder, within } from '@golemdocs/script/host';
import { composePage, embedAddresses, fillEmbeds, inlineFiles, isRelative, pageAsks, pageCsp, policyFor, resolvePath, typeOf } from './compose.ts';
import type { PageAsks, PageTrust } from './compose.ts';
import { answerKey } from './answers.ts';
import { resultHtml } from './embedHtml.ts';
import { PageRequests, sayLiveError } from './requests.ts';
import { fingerprint, SessionGrants, shouldReportOutside, trustOf } from './trust.ts';
import type { PageMemory, PageOrigin, PageView as PageViewKind } from './trust.ts';
import { PageViewer } from './view.ts';

/** A document in the vault, by its key in the library and its path (`Reports/q3.html`). */
export interface PageDocument {
  key: string;
  path: string;
}

/** What a shared page showed, kept for the people it is shared with (docs/html-pages.md §5). */
export interface PageResults {
  version: 1;
  /** The page's bytes they were made for. */
  hash: string;
  /** What each embed showed, as HTML, by address. */
  embeds: Record<string, string>;
  /** What each of its `golem` reads was answered with, by `op` and arguments (`answerKey`). */
  answers: Record<string, unknown>;
  /** The vault paths (and folders, ending in `/`) it read. */
  read: string[];
}


export interface PageHost {
  /** Every document this device has, with its path. */
  documents(): PageDocument[];
  /** A document's stored bytes. */
  read(key: string): Promise<Uint8Array | null>;
  /** A file of the vault as it is on disk, by path (a picture, a stylesheet, a script); null when there is none. */
  file(path: string): Promise<Uint8Array | null>;
  /** A page's HTML from its stored bytes (a page edited as a document is kept as one). */
  html(stored: Uint8Array, name: string): Promise<string>;
  /** What a live block of this address shows in the page `fromKey`, and the vault paths it read. */
  embed(address: string, fromKey: string | null): Promise<{ result: LiveResult; paths: string[] }>;
  /** What a live block of this address shows, from the top of the vault (a script's `sheet()` and `result()`). */
  produce(address: string): Promise<LiveResult>;
  /** Stores a document an own page changed (made, with its folders, when new). */
  store(file: ChangedFile): Promise<void>;
  /** A page changed documents: logged as a run of it, with what undoes it. */
  logged(page: { path: string; name: string }, files: readonly ChangedFile[]): void;
  /** Opens a vault document by path. */
  openPath(path: string): void;
  /** Opens a link that is not a vault file (`doc:`, the web, mail) as the app opens links. */
  openLink(href: string): void;
  /** Asks before a page that may read the person's documents opens an address on the web. */
  confirmLink(name: string, href: string): Promise<boolean>;
  /** Asks whether a page from elsewhere may read these folders. */
  askReads(name: string, folders: readonly string[]): Promise<'once' | 'always' | null>;
  /** Asks before a page from elsewhere is treated as the person's own. */
  confirmMine(name: string, asks: PageAsks): Promise<boolean>;
  /** Page, Document or Source was picked in the bar. */
  setView(view: PageViewKind): void;
  /**
   * Tells the account whether a page the person owns came from outside (true: this device saw it imported or downloaded) or is
   * theirs (false: Mark as Mine), so their other devices treat it the same. Resolves true once the account has it; false when the
   * page isn't the account's (or isn't theirs), or it couldn't be told.
   */
  setOutside(key: string, outside: boolean): Promise<boolean>;
  /** Keeps what a page showed for the people it is shared with (a page the account has, shared or not). */
  keepResults(key: string, results: PageResults): Promise<void>;
  status(text: string): void;
  error(text: string): void;
}

/** What is being shown. */
interface Shown {
  key: string | null;
  name: string;
  path: string;
  stored: Uint8Array;
  origin: Omit<PageOrigin, 'hash' | 'markedHash'>;
  hash: string;
  html: string;
  trust: PageTrust;
  asks: PageAsks;
  /** Folders it may read: null for none, [''] for all (an own page). */
  reads: string[] | null;
  scripts: boolean;
  requests: PageRequests;
  /** What its embeds show, by address. */
  embeds: Map<string, string>;
  /** Paths it read through embeds and its inlined files (its requests keep their own). */
  read: Set<string>;
  /** Its reads' answers, kept for its results. */
  answers: Map<string, unknown>;
}

/** Whether the file has, or may have (an old shell can't tell), the system's download mark. */
const isDownloaded = (origin: Pick<PageOrigin, 'downloaded'>): boolean => origin.downloaded !== false && origin.downloaded !== undefined;
const folderOfPath = (path: string): string => path.split('/').slice(0, -1).join('/');
const MAX_RESULTS_CHARS = 7_500_000;

export class PageController {
  readonly view: PageViewer;
  private shown: Shown | null = null;
  /** Allowed for this session only (by key or name, for the bytes it was allowed for): folders a foreign page may read, and pages marked as own. */
  private readonly once = new SessionGrants();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private keepTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by every show, so a slow one that finishes after another started is dropped. */
  private ticket = 0;

  constructor(
    parent: HTMLElement,
    private readonly host: PageHost,
    /** What this device remembers about pages (main.ts has it before this chunk is loaded). */
    readonly memory: PageMemory,
  ) {
    this.view = new PageViewer(parent, {
      request: (op, args) => this.request(op, args),
      navigate: (href) => void this.navigate(href),
      view: (view) => this.pickView(view),
      markMine: () => void this.markMine(),
      allowReads: () => void this.allowReads(),
    });
  }

  get active(): boolean {
    return this.view.active;
  }

  /** The stored bytes of the page shown (what a save keeps: page view never changes them). */
  get stored(): Uint8Array | null {
    return this.shown?.stored ?? null;
  }

  /** What the automation API reports. */
  state(): ReturnType<PageViewer['state']> & { path: string | null; read: string[]; embeds: Record<string, string> } {
    const s = this.shown;
    return { ...this.view.state(), path: s?.path ?? null, read: s ? this.readPaths(s) : [], embeds: s ? Object.fromEntries(s.embeds) : {} };
  }

  /** Shows a page; `keepScroll` keeps the place (the page or its trust changed). */
  async open(spec: { key: string | null; name: string; path: string; stored: Uint8Array; origin: Omit<PageOrigin, 'hash' | 'markedHash'> }, keepScroll = false): Promise<void> {
    const ticket = ++this.ticket;
    const html = await this.host.html(spec.stored, spec.name);
    const hash = await fingerprint(spec.stored);
    const id = spec.key ?? spec.name;
    const onceMarked = this.once.marked(id);
    const marked = onceMarked === hash ? onceMarked : spec.key ? this.memory.marked(spec.key) : null;
    const origin = { ...spec.origin, acceptedDownload: spec.key ? this.memory.acceptedDownload(spec.key) : false };
    const trust = trustOf({ ...origin, hash, markedHash: marked });
    const asks = pageAsks(html);
    const reads = trust === 'own' ? [''] : (this.once.reads(id, hash) ?? (spec.key ? this.memory.reads(spec.key, hash) : null));
    const policy = policyFor(trust, trust === 'foreign' && reads !== null, asks);
    const folder = folderOfPath(spec.path);
    const read = new Set<string>();
    // Inlining reads the vault. An own page reaches all of it. A foreign page allowed to read runs no scripts and has no network, so
    // its files come from its own folder (nothing it shows can leave). One not allowed to read runs its scripts with the network,
    // so it gets nothing from the vault at all: not even a picture beside it, which its script could send away.
    const inlined = trust === 'own' || reads !== null ? await inlineFiles(html, folder, (path) => this.fileAt(path), trust === 'own' ? null : folder) : { html, files: [] };
    for (const path of inlined.files) read.add(path);
    const embeds = new Map<string, string>();
    for (const address of embedAddresses(html)) embeds.set(address, await this.embedHtml(address, spec.key, reads, read));
    if (ticket !== this.ticket) return;
    const requests = new PageRequests(
      {
        vault: this.vault(),
        embed: (address) => this.resolveEmbed(address, spec.key),
        store: (file) => this.host.store(file),
        logged: (files) => this.host.logged({ path: spec.path, name: spec.name }, files),
      },
      { path: spec.path, name: spec.name, trust },
    );
    this.shown = { ...spec, hash, html, trust, asks, reads, scripts: policy.scripts, requests, embeds, read, answers: new Map() };
    const filled = fillEmbeds(inlined.html, embeds);
    const csp = pageCsp(policy);
    const scroll = keepScroll ? Math.round(this.view.scrollY) : 0;
    const compose = (token: string): string => composePage(filled, csp, policy.scripts ? { path: spec.path, trust, scroll, token } : null);
    if (spec.key) this.reportOutside(spec.key, { ...origin, hash });
    this.view.show({ name: spec.name, compose, trust, scripts: policy.scripts, forms: policy.forms, asks: asks.reads, allowed: trust === 'foreign' && reads !== null }, keepScroll);
    this.scheduleKeep();
  }

  close(): void {
    this.ticket++;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.keepTimer) clearTimeout(this.keepTimer);
    this.refreshTimer = this.keepTimer = null;
    this.shown = null;
    this.view.close();
  }

  /** A document was saved here or synced: the page shows it again if it is the page, or refreshes what it shows of it. */
  saved(key: string): void {
    const s = this.shown;
    if (!s) return;
    if (key === s.key) {
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => void this.reopen(), 300);
      return;
    }
    const path = this.host.documents().find((d) => d.key === key)?.path;
    if (!path || !this.reads(s, path)) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(path).catch((e: unknown) => console.error(e)), 300);
  }

  /** A page that was saved under a key (opened from the computer, then kept): what is known of it goes with it. */
  keyed(key: string): void {
    const s = this.shown;
    if (!s || s.key === key) return;
    if (s.key) this.memory.moved(s.key, key);
    else if (s.origin.imported) this.memory.setImported(key);
    if (this.once.marked(s.name) === s.hash) this.memory.markOwn(key, s.hash, isDownloaded(s.origin));
    const reads = this.once.reads(s.name, s.hash);
    if (reads) this.once.allowReads(key, s.hash, reads);
    s.key = key;
  }

  /** Tells the account, once for these bytes, that a page its owner has came from outside (see `shouldReportOutside`). */
  private reportOutside(key: string, origin: Omit<PageOrigin, 'markedHash'>): void {
    if (!shouldReportOutside(origin, this.memory.reported(key))) return;
    void this.host
      .setOutside(key, true)
      .then((sent) => {
        if (sent) this.memory.setReported(key, origin.hash);
      })
      .catch(() => undefined);
  }

  // --- Answers ---------------------------------------------------------------------------------

  private vault() {
    return {
      list: async (folder: string) => {
        const f = normalizeFolder(folder);
        const docs = this.host.documents().filter((d) => within(d.path, [f]) && d.path !== f);
        if (f && !docs.length) return null;
        const files = await Promise.all(docs.map(async (d) => ({ path: d.path, bytes: await this.host.read(d.key) })));
        return files.filter((x): x is { path: string; bytes: Uint8Array } => x.bytes !== null);
      },
      file: async (path: string) => {
        const doc = this.find(path);
        const bytes = doc ? await this.host.read(doc.key) : null;
        return bytes ? { path: doc!.path, bytes } : null;
      },
      produce: (address: string) => this.host.produce(address),
    };
  }

  private find(path: string): PageDocument | undefined {
    const p = normalizeFolder(path).toLowerCase();
    return this.host.documents().find((d) => d.path.toLowerCase() === p);
  }

  private async fileAt(path: string): Promise<{ bytes: Uint8Array; type: string } | null> {
    const bytes = await this.host.file(path);
    return bytes ? { bytes, type: typeOf(path) } : null;
  }

  private resolveEmbed(address: string, fromKey: string | null): Promise<{ result: LiveResult; paths: string[] }> {
    return this.host.embed(address, fromKey);
  }

  /** What an embed shows: a foreign page's reads checked against what it may read (nothing, until allowed). */
  private async embedHtml(address: string, fromKey: string | null, reads: string[] | null, read: Set<string>): Promise<string> {
    const say = (result: Extract<LiveResult, { kind: 'error' }>) => sayLiveError(result, address);
    if (reads === null) return resultHtml({ kind: 'error', code: 'notAllowed', detail: address }, () => t('pages.error.embedNotAllowed', { source: address }));
    try {
      const { result, paths } = await this.resolveEmbed(address, fromKey);
      // What a page not yet in the library reads can't be told: a page limited to some folders is shown none of it.
      const outside = paths.find((p) => !within(p.replace(/\/$/, ''), reads)) ?? (!reads.includes('') && !paths.length && result.kind !== 'error' ? address : undefined);
      if (outside !== undefined) return resultHtml({ kind: 'error', code: 'notAllowed', detail: outside }, () => t('pages.error.embedOutside', { source: address, path: outside }));
      for (const p of paths) read.add(p);
      return resultHtml(result, say);
    } catch (e) {
      return resultHtml({ kind: 'error', code: 'unreadable', detail: (e as Error).message }, say);
    }
  }

  private async request(op: string, args: unknown[]): Promise<unknown> {
    const s = this.shown;
    if (!s) throw new Error(t('pages.error.closed'));
    const value = await s.requests.handle(op, args);
    if (op === 'read' || op === 'notes' || op === 'sheet' || op === 'result' || op === 'embed') {
      s.answers.set(answerKey(op, args), value);
      this.scheduleKeep();
    }
    return value;
  }

  // --- Following what it read -------------------------------------------------------------------

  private readPaths(s: Shown): string[] {
    return [...new Set([...s.read, ...s.requests.read])].sort();
  }

  /** Whether the page read this path (itself, or a folder it is in). */
  private reads(s: Shown, path: string): boolean {
    const p = path.toLowerCase();
    return this.readPaths(s).some((r) => {
      const q = r.toLowerCase();
      return q.endsWith('/') ? q === '/' || p.startsWith(q) : q === p;
    });
  }

  private async reopen(): Promise<void> {
    const s = this.shown;
    if (!s?.key) return;
    const stored = await this.host.read(s.key);
    // The same bytes (its own save, or the account's copy of it): nothing to show again, and its scripts keep their state.
    if (!stored || this.shown !== s || (await fingerprint(stored)) === s.hash || this.shown !== s) return;
    await this.open({ key: s.key, name: s.name, path: s.path, stored, origin: s.origin }, true);
  }

  /** Something it read changed: its embeds are filled again and its scripts told (a page with none is shown again). */
  private async refresh(path: string): Promise<void> {
    const s = this.shown;
    if (!s) return;
    // A page with no scripts can't be told: it is shown again, its embeds filled afresh.
    if (!s.scripts) return this.open({ key: s.key, name: s.name, path: s.path, stored: s.stored, origin: s.origin }, true);
    const filled: Record<string, string> = {};
    for (const address of s.embeds.keys()) {
      const html = await this.embedHtml(address, s.key, s.reads, s.read);
      s.embeds.set(address, html);
      filled[address] = html;
    }
    if (this.shown !== s) return;
    this.view.update(filled, { path });
    this.scheduleKeep();
  }

  // --- Results for the people it is shared with -----------------------------------------------

  /** Keeps what the page shows (once things settle) for the people it is shared with: an own page the account has. */
  private scheduleKeep(): void {
    const s = this.shown;
    if (!s?.key || s.trust !== 'own') return;
    if (this.keepTimer) clearTimeout(this.keepTimer);
    this.keepTimer = setTimeout(() => {
      this.keepTimer = null;
      if (this.shown !== s || !s.key) return;
      const results: PageResults = { version: 1, hash: s.hash, embeds: Object.fromEntries(s.embeds), answers: Object.fromEntries(s.answers), read: this.readPaths(s) };
      if (JSON.stringify(results).length > MAX_RESULTS_CHARS) return;
      void this.host.keepResults(s.key, results).catch(() => undefined);
    }, 3_000);
  }

  // --- The bar -----------------------------------------------------------------------------------

  private pickView(view: PageViewKind): void {
    const s = this.shown;
    if (s?.key) this.memory.setView(s.key, view);
    if (view !== 'page') this.host.setView(view);
  }

  private async markMine(): Promise<void> {
    const s = this.shown;
    if (!s || s.trust === 'own') return;
    if (!(await this.host.confirmMine(s.name, s.asks))) return;
    if (s.key) {
      // Theirs on this device (for these bytes, and its file's download mark accepted), and in the account, for their others.
      this.memory.markOwn(s.key, s.hash, isDownloaded(s.origin));
      void this.host.setOutside(s.key, false).catch(() => false);
    } else this.once.markMine(s.name, s.hash);
    await this.open({ key: s.key, name: s.name, path: s.path, stored: s.stored, origin: s.key ? { ...s.origin, imported: false } : s.origin }, true);
  }

  private async allowReads(): Promise<void> {
    const s = this.shown;
    if (!s || s.trust === 'own' || !s.asks.reads.length) return;
    const answer = await this.host.askReads(s.name, s.asks.reads);
    if (!answer || this.shown !== s) return;
    if (answer === 'always' && s.key) this.memory.allowReads(s.key, s.hash, s.asks.reads);
    else this.once.allowReads(s.key ?? s.name, s.hash, s.asks.reads);
    await this.open({ key: s.key, name: s.name, path: s.path, stored: s.stored, origin: s.origin }, true);
  }

  /** A link in the page: a file beside it opens in the app; anything else opens as links do, asked first when the page may read. */
  private async navigate(href: string): Promise<void> {
    const s = this.shown;
    if (!s) return;
    if (isRelative(href)) {
      const path = resolvePath(folderOfPath(s.path), href);
      if (path && this.find(path)) return this.host.openPath(this.find(path)!.path);
      this.host.error(t('pages.error.noFile', { path: path ?? href }));
      return;
    }
    if (/^(javascript|data|blob|vbscript):/i.test(href.trim())) return;
    const mayRead = s.trust === 'own' || s.reads !== null;
    if (s.trust === 'foreign' && mayRead && !/^doc:/i.test(href) && !(await this.host.confirmLink(s.name, href))) return;
    this.host.openLink(href);
  }
}
