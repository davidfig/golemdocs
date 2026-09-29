// The dashboard: every document at a glance, as a grid of first-page thumbnails. It lists what is
// saved in this browser and, when signed in, what is in the cloud (matched up by sync.ts). It is a
// plain DOM screen laid over the editor's canvas; File ▸ Dashboard shows it, Esc or any open hides it.
//
// Nothing here is loaded before it is needed: the browser's documents appear straight away, the
// cloud's follow once the catalogue arrives, and each thumbnail is fetched only when its card
// scrolls into view.

import { deleteDocument, removeShare, thumbnailUrl, type CloudDocument } from '../cloud.ts';
import { deleteSaved, getThumbnail } from '../storage/local.ts';
import { loadLibrary, loadLocalLibrary, type LibraryEntry } from '../sync.ts';
import type { User } from '../auth.ts';
import { formatSize, matchesSearch, opensFromCloud, relativeTime, syncBadge } from './dashboardFormat.ts';
import { h } from './dom.ts';
import './dashboard.css';

/** What the dashboard asks of the application. */
export interface DashboardHost {
  newDocument(): void;
  openLocal(id: string): void;
  openCloud(id: string): void;
  /** Saves a browser document to the cloud (asks the user to sign in if they haven't). */
  saveToCloud(localId: string): Promise<void>;
  /** Opens the sharing dialog for a cloud document the user owns. */
  share(cloudId: string, name: string): void;
  /** Opens a document someone else shared with the user. */
  openShared(doc: CloudDocument): void;
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
  private readonly sharedTitle: HTMLElement;
  private readonly sharedGrid: HTMLElement;
  private shared: CloudDocument[] = [];
  private readonly scroller: HTMLElement;
  private observer: IntersectionObserver | null = null;
  private objectUrls: string[] = [];
  private entries: LibraryEntry[] = [];
  private user: User | null = null;
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
    this.sharedTitle = h('h2', { class: 'wm-dash-section', text: 'Shared with me' });
    this.sharedGrid = h('div', { class: 'wm-dash-grid' });
    this.scroller = h('div', { class: 'wm-dash-scroll' }, this.notice, this.grid, this.sharedTitle, this.sharedGrid);
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

  /** Shows the dashboard and refreshes it: the browser's documents first, then the cloud's. */
  async show(): Promise<void> {
    this.root.hidden = false;
    this.search.value = '';
    const generation = ++this.generation;
    this.entries = await loadLocalLibrary();
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

  private async refresh(generation = ++this.generation): Promise<void> {
    this.setAccount(this.user, true);
    const library = await loadLibrary();
    if (generation !== this.generation) return;
    this.entries = library.entries;
    this.shared = library.shared;
    this.user = library.user;
    this.notice.textContent = library.cloudProblem ?? '';
    this.setAccount(library.user, false);
    this.render();
  }

  // --- Rendering ---------------------------------------------------------------------------

  private setAccount(user: User | null, busy: boolean): void {
    const button = (text: string, run: () => Promise<void>) => {
      const b = h('button', { text, attrs: { type: 'button' } });
      b.addEventListener('click', () => void run().then(() => this.refresh()));
      return b;
    };
    if (user) {
      const who = user.email ?? user.name ?? 'your account';
      this.account.replaceChildren(h('span', { text: busy ? `Syncing ${who}…` : `Signed in as ${who}` }), button('Sign out', () => this.host.signOut()));
    } else {
      this.account.replaceChildren(h('span', { text: 'Only documents on this device' }), button('Sign in to sync', () => this.host.signIn()));
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

    const sharedShown = this.shared.filter((d) => d.name.toLowerCase().includes(this.search.value.trim().toLowerCase()));
    this.sharedTitle.hidden = this.sharedGrid.hidden = sharedShown.length === 0;
    this.sharedGrid.replaceChildren(...sharedShown.map((d) => this.sharedCard(d)));

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
    for (const el of this.scroller.querySelectorAll<HTMLElement>('.wm-thumb')) this.observer.observe(el);
  }

  /** A document someone else shared: open it, or leave it. */
  private sharedCard(doc: CloudDocument): HTMLElement {
    const thumb = h('div', { class: 'wm-thumb' }, h('div', { class: 'wm-thumb-empty', attrs: { 'aria-hidden': 'true' } }));
    this.sharedThumbs.set(thumb, doc);
    const by = doc.owner?.name ?? doc.owner?.email;
    const meta = [by ? `From ${by}` : null, relativeTime(doc.updatedAt)].filter(Boolean).join(' · ');
    const open = h('button', { class: 'wm-card-open', attrs: { type: 'button', 'aria-label': `Open ${doc.name}` } }, thumb, h('span', { class: 'wm-card-name', text: doc.name, title: doc.name }), h('span', { class: 'wm-card-meta', text: meta }));
    open.addEventListener('click', () => {
      this.hide();
      this.host.openShared(doc);
    });
    const badges = h('div', { class: 'wm-badges' }, h('span', { class: 'wm-badge', text: doc.role === 'viewer' ? 'View only' : 'Can edit' }));
    const actions = h('div', { class: 'wm-card-actions' });
    if (this.user) {
      const userId = this.user.id;
      actions.append(
        this.confirmButton('Leave', async () => {
          await removeShare(doc.id, userId);
        }),
      );
    }
    return h('article', { class: 'wm-card' }, open, badges, actions);
  }

  private card(entry: LibraryEntry): HTMLElement {
    const thumb = h('div', { class: 'wm-thumb' }, h('div', { class: 'wm-thumb-empty', attrs: { 'aria-hidden': 'true' } }));
    this.entryFor.set(thumb, entry);

    const meta = [relativeTime(entry.updatedAt), formatSize(entry.size)].join(' · ');
    const open = h('button', { class: 'wm-card-open', attrs: { type: 'button', 'aria-label': `Open ${entry.name}` } }, thumb, h('span', { class: 'wm-card-name', text: entry.name, title: entry.name }), h('span', { class: 'wm-card-meta', text: meta }));
    open.addEventListener('click', () => {
      this.hide();
      if (opensFromCloud(entry)) this.host.openCloud(entry.cloud!.id);
      else this.host.openLocal(entry.local!.id);
    });

    const badges = h('div', { class: 'wm-badges' });
    if (entry.local) badges.append(h('span', { class: 'wm-badge', text: 'This device' }));
    if (entry.cloud || entry.local?.cloudId) badges.append(h('span', { class: 'wm-badge', text: 'Cloud' }));
    const sync = syncBadge(entry.state);
    if (sync) badges.append(h('span', { class: `wm-badge wm-badge-${sync.tone}`, text: sync.text }));

    const actions = h('div', { class: 'wm-card-actions' });
    if (entry.local && !entry.cloud && !entry.local.cloudId) {
      const save = h('button', { text: 'Save to cloud', attrs: { type: 'button' } });
      save.addEventListener('click', () => {
        save.disabled = true;
        void this.host.saveToCloud(entry.local!.id).finally(() => void this.refresh());
      });
      actions.append(save);
    }
    if (entry.local) {
      actions.append(this.confirmButton(entry.cloud ? 'Remove from this device' : 'Delete', async () => {
        await deleteSaved(entry.local!.id);
      }));
    }
    if (entry.cloud) {
      const share = h('button', { text: 'Share…', attrs: { type: 'button' } });
      share.addEventListener('click', () => this.host.share(entry.cloud!.id, entry.cloud!.name));
      actions.append(share);
      actions.append(this.confirmButton('Delete from cloud', async () => {
        await deleteDocument(entry.cloud!.id);
      }));
    }

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
  private readonly sharedThumbs = new WeakMap<HTMLElement, CloudDocument>();

  /** Fills a card's thumbnail: this device's when it has the current one, else the cloud's. */
  private async loadThumbnail(thumb: HTMLElement): Promise<void> {
    const shared = this.sharedThumbs.get(thumb);
    if (shared) return this.showThumbnail(thumb, thumbnailUrl(shared));
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
    this.showThumbnail(thumb, src ?? cloudUrl);
  }

  private showThumbnail(thumb: HTMLElement, src: string | null): void {
    if (!src) return;
    const img = h('img', { attrs: { alt: '', decoding: 'async', draggable: 'false' } });
    img.addEventListener('load', () => thumb.replaceChildren(img), { once: true });
    img.src = src; // on failure the placeholder stays
  }
}
