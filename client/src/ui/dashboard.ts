// The dashboard: every document at a glance, as a grid of first-page thumbnails. Signed in, that
// is the account's documents; signed out, the ones saved in this browser (sync.ts lists them). It
// is a plain DOM screen laid over the editor's canvas; File ▸ Dashboard shows it, Esc or any open
// hides it.
//
// Nothing here is loaded before it is needed: what this browser has appears straight away, the
// rest of the account's documents once the catalogue arrives, and each thumbnail is fetched only
// when its card scrolls into view.

import { thumbnailUrl } from '../cloud.ts';
import { getThumbnail } from '../storage/local.ts';
import { loadLibrary, loadLocalLibrary, type LibraryEntry } from '../sync.ts';
import type { User } from '../auth.ts';
import { formatSize, matchesSearch, relativeTime, syncBadge } from './dashboardFormat.ts';
import { h } from './dom.ts';
import './dashboard.css';

/** What the dashboard asks of the application. */
export interface DashboardHost {
  newDocument(): void;
  open(entry: LibraryEntry): void;
  /** Deletes the document everywhere: from the account and from this browser. */
  delete(entry: LibraryEntry): Promise<void>;
  /** Who is signed in (null: nobody), whose documents are shown. */
  account(): User | null;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** The dashboard was closed without opening anything: give the editor back the keyboard. */
  closed(): void;
}

// --- The screen -----------------------------------------------------------------------------

export class Dashboard {
  private readonly root: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly account: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly scroller: HTMLElement;
  private observer: IntersectionObserver | null = null;
  private objectUrls: string[] = [];
  private entries: LibraryEntry[] = [];
  /** Bumped on every show and refresh, so a slow answer never replaces a newer one. */
  private generation = 0;
  /** Cards showing a "click again to confirm" button, and the timer that resets them. */
  private confirming: { button: HTMLButtonElement; label: string; timer: number } | null = null;

  constructor(
    parent: HTMLElement,
    private readonly host: DashboardHost,
  ) {
    this.search = h('input', { class: 'wm-dash-search', attrs: { type: 'search', placeholder: 'Search documents', 'aria-label': 'Search documents' } });
    this.account = h('div', { class: 'wm-dash-account' });
    this.notice = h('p', { class: 'wm-dash-notice', attrs: { role: 'status' } });
    this.grid = h('div', { class: 'wm-dash-grid' });
    const close = h('button', { class: 'wm-dash-close', text: 'Back to document', attrs: { type: 'button' } });
    close.addEventListener('click', () => this.dismiss());
    this.scroller = h('div', { class: 'wm-dash-scroll' }, this.notice, this.grid);
    this.root = h(
      'section',
      { class: 'wm-dashboard', attrs: { 'aria-label': 'Documents' } },
      h('header', { class: 'wm-dash-head' }, h('h1', { text: 'Documents' }), this.search, this.account, close),
      this.scroller,
    );
    this.root.hidden = true;
    parent.append(this.root);

    this.search.addEventListener('input', () => this.render());
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.dismiss();
      }
    });
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  toggle(): void {
    if (this.visible) this.dismiss();
    else void this.show();
  }

  /** Shows the dashboard and refreshes it: what this browser has first, then the account's. */
  async show(): Promise<void> {
    this.root.hidden = false;
    this.search.value = '';
    const generation = ++this.generation;
    this.entries = await loadLocalLibrary(this.host.account());
    if (generation !== this.generation) return;
    this.notice.textContent = '';
    this.render();
    this.search.focus({ preventScroll: true });
    await this.refresh(generation);
  }

  /** Hides it (without opening anything). */
  dismiss(): void {
    if (!this.visible) return;
    this.hide();
    this.host.closed();
  }

  hide(): void {
    this.generation++;
    this.root.hidden = true;
    this.releaseThumbnails();
  }

  /** Lists the documents again (after the sign-in or an upload changed them), if it's showing. */
  refreshIfVisible(): void {
    if (this.visible) void this.refresh();
  }

  private async refresh(generation = ++this.generation): Promise<void> {
    const user = this.host.account();
    this.setAccount(user);
    const library = await loadLibrary(user);
    if (generation !== this.generation) return;
    this.entries = library.entries;
    this.notice.textContent = library.cloudProblem ?? '';
    this.render();
  }

  // --- Rendering ---------------------------------------------------------------------------

  private setAccount(user: User | null): void {
    const button = (text: string, run: () => Promise<void>) => {
      const b = h('button', { text, attrs: { type: 'button' } });
      b.addEventListener('click', () => void run().then(() => this.refresh()));
      return b;
    };
    if (user) {
      const who = user.email ?? user.name ?? 'your account';
      this.account.replaceChildren(h('span', { text: who }), button('Sign out', () => this.host.signOut()));
    } else {
      this.account.replaceChildren(h('span', { text: 'Saved in this browser' }), button('Sign in', () => this.host.signIn()));
    }
  }

  private releaseThumbnails(): void {
    this.observer?.disconnect();
    this.observer = null;
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls = [];
  }

  private render(): void {
    this.releaseThumbnails();
    this.confirming = null;
    const shown = this.entries.filter((e) => matchesSearch(e, this.search.value));

    const blank = h('button', { class: 'wm-card wm-card-new', attrs: { type: 'button', 'aria-label': 'New blank document' } }, h('span', { class: 'wm-plus', text: '+' }), h('span', { text: 'Blank document' }));
    blank.addEventListener('click', () => {
      this.hide();
      this.host.newDocument();
    });

    const cards = shown.map((entry) => this.card(entry));
    const children: (HTMLElement | string)[] = [blank, ...cards];
    if (!shown.length) {
      children.push(h('p', { class: 'wm-dash-empty', text: this.search.value.trim() ? 'No documents match your search.' : 'Documents you save will show up here.' }));
    }
    this.grid.replaceChildren(...children);

    this.observer = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          if (!record.isIntersecting) continue;
          this.observer?.unobserve(record.target);
          void this.loadThumbnail(record.target as HTMLElement);
        }
      },
      { root: this.scroller, rootMargin: '200px' },
    );
    for (const el of this.grid.querySelectorAll<HTMLElement>('.wm-thumb')) this.observer.observe(el);
  }

  private card(entry: LibraryEntry): HTMLElement {
    const thumb = h('div', { class: 'wm-thumb' }, h('div', { class: 'wm-thumb-empty', attrs: { 'aria-hidden': 'true' } }));
    this.entryFor.set(thumb, entry);

    const meta = [relativeTime(entry.updatedAt), formatSize(entry.size)].join(' · ');
    const open = h('button', { class: 'wm-card-open', attrs: { type: 'button', 'aria-label': `Open ${entry.name}` } }, thumb, h('span', { class: 'wm-card-name', text: entry.name, title: entry.name }), h('span', { class: 'wm-card-meta', text: meta }));
    open.addEventListener('click', () => {
      this.hide();
      this.host.open(entry);
    });

    const badges = h('div', { class: 'wm-badges' });
    const sync = syncBadge(entry.state, this.host.account() !== null);
    if (sync) badges.append(h('span', { class: `wm-badge wm-badge-${sync.tone}`, text: sync.text }));

    const actions = h('div', { class: 'wm-card-actions' }, this.confirmButton('Delete', () => this.host.delete(entry)));
    return h('article', { class: 'wm-card' }, open, badges, actions);
  }

  /** A button that needs a second click, within a few seconds, to do something that can't be undone. */
  private confirmButton(label: string, run: () => Promise<void>): HTMLButtonElement {
    const button = h('button', { class: 'wm-danger', text: label, attrs: { type: 'button' } });
    button.addEventListener('click', () => {
      if (this.confirming?.button === button) {
        clearTimeout(this.confirming.timer);
        this.confirming = null;
        button.disabled = true;
        run().then(
          () => this.refresh(),
          (error) => {
            this.notice.textContent = `Couldn’t do that: ${(error as Error).message}`;
            void this.refresh();
          },
        );
        return;
      }
      this.resetConfirm();
      button.textContent = 'Click again to confirm';
      this.confirming = { button, label, timer: window.setTimeout(() => this.resetConfirm(), 4000) };
    });
    return button;
  }

  private resetConfirm(): void {
    if (!this.confirming) return;
    clearTimeout(this.confirming.timer);
    this.confirming.button.textContent = this.confirming.label;
    this.confirming = null;
  }

  // --- Thumbnails --------------------------------------------------------------------------

  private readonly entryFor = new WeakMap<HTMLElement, LibraryEntry>();

  /** Fills a card's thumbnail: this device's when it has the current one, else the cloud's. */
  private async loadThumbnail(thumb: HTMLElement): Promise<void> {
    const entry = this.entryFor.get(thumb);
    if (!entry) return;
    const generation = this.generation;
    const cloudUrl = entry.cloud ? thumbnailUrl(entry.cloud) : null;
    const preferCloud = !entry.local || entry.state === 'cloud-ahead';

    let src: string | null = preferCloud ? cloudUrl : null;
    if (!src && entry.local) {
      const local = await getThumbnail(entry.local.id).catch(() => null);
      if (generation !== this.generation) return;
      if (local) {
        src = URL.createObjectURL(local.blob);
        this.objectUrls.push(src);
      }
    }
    src ??= cloudUrl;
    if (!src) return;

    const img = h('img', { attrs: { alt: '', decoding: 'async', draggable: 'false' } });
    img.addEventListener('load', () => thumb.replaceChildren(img), { once: true });
    img.src = src; // on failure the placeholder stays
  }
}
