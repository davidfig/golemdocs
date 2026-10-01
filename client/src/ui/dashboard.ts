// The dashboard: every document at a glance, as a grid of first-page thumbnails. Signed in, that
// is the account's documents; signed out, the ones saved in this browser (sync.ts lists them). It
// is a plain DOM screen laid over the editor's canvas; File ▸ Open shows it, Esc or any open
// hides it.
//
// Nothing here is loaded before it is needed: what this browser has appears straight away, the
// rest of the account's documents once the catalogue arrives, and each thumbnail is fetched only
// when its card scrolls into view.

import { removeShare, thumbnailUrl, type CloudDocument } from '../cloud.ts';
import { createFolder, moveEntry, removeFolder, updateFolder } from '../folderOps.ts';
import { childFolders, folderOf, folderPath, folderTree, isInside, itemsIn, type Folder } from '../folders.ts';
import { getThumbnail } from '../storage/local.ts';
import { loadLibrary, loadLocalLibrary, type LibraryEntry } from '../sync.ts';
import type { User } from '../auth.ts';
import { formatSize, matchesSearch, relativeTime, syncBadge } from './dashboardFormat.ts';
import { t } from '../i18n/index.ts';
import { h } from './dom.ts';
import './dashboard.css';

/** What the dashboard asks of the application. */
export interface DashboardHost {
  /** Starts a blank document, to be filed in `folderId` (null: the top level) when it is first saved. */
  newDocument(folderId: string | null): void;
  open(entry: LibraryEntry): void;
  /** Asks for a file on this computer and opens it, to be filed in `folderId` when it is first saved. */
  importFile(folderId: string | null): void;
  /** Deletes the document everywhere: from the account and from this browser. */
  delete(entry: LibraryEntry): Promise<void>;
  /** Whose cloud documents are shown: who is signed in, if they have sync (null: nobody, or no sync). */
  account(): User | null;
  /** Who is signed in, with or without sync. */
  signedIn(): User | null;
  /** Pay for sync (signing in first if needed). */
  subscribe(): Promise<void>;
  /** Opens the sharing dialog for a cloud document the user owns. */
  share(cloudId: string, name: string): void;
  /** Opens a document someone else shared with the user. */
  openShared(doc: CloudDocument): void;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** The dashboard was closed without opening anything: give the editor back the keyboard. */
  closed(): void;
}

/** What is being dragged to a folder. */
type Dragged = { kind: 'doc'; entry: LibraryEntry } | { kind: 'folder'; folder: Folder };

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
  private folders: Folder[] = [];
  /** The folder being looked at (null: the top level). */
  private folderId: string | null = null;
  /** The folder whose name is being typed in place (just made, or being renamed). */
  private renaming: string | null = null;
  private dragged: Dragged | null = null;
  /** While the cards are being replaced: the rename field losing its place isn't the user leaving it. */
  private rebuilding = false;
  private readonly crumbs: HTMLElement;
  /** Bumped on every show and refresh, so a slow answer never replaces a newer one. */
  private generation = 0;
  /** Cards showing a "click again to confirm" button, and the timer that resets them. */
  private confirming: { button: HTMLButtonElement; label: string; timer: number } | null = null;

  constructor(
    parent: HTMLElement,
    private readonly host: DashboardHost,
  ) {
    this.search = h('input', { class: 'wm-dash-search', attrs: { type: 'search', placeholder: t('panels.dashboard.search'), 'aria-label': t('panels.dashboard.search') } });
    this.account = h('div', { class: 'wm-dash-account' });
    this.notice = h('p', { class: 'wm-dash-notice', attrs: { role: 'status' } });
    this.grid = h('div', { class: 'wm-dash-grid' });
    this.crumbs = h('nav', { class: 'wm-dash-crumbs', attrs: { 'aria-label': t('panels.dashboard.location') } });
    const close = h('button', { class: 'wm-dash-close', text: '×', attrs: { type: 'button', 'aria-label': t('panels.dashboard.close'), title: t('panels.dashboard.close') } });
    close.addEventListener('click', () => this.dismiss());
    this.sharedTitle = h('h2', { class: 'wm-dash-section', text: t('panels.dashboard.sharedWithMe') });
    this.sharedGrid = h('div', { class: 'wm-dash-grid' });
    this.scroller = h('div', { class: 'wm-dash-scroll' }, this.notice, this.crumbs, this.grid, this.sharedTitle, this.sharedGrid);
    this.root = h(
      'section',
      { class: 'wm-dashboard', attrs: { 'aria-label': t('panels.dashboard.title') } },
      h('header', { class: 'wm-dash-head' }, h('h1', { text: t('panels.dashboard.title') }), this.search, this.account, close),
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
    this.folderId = null;
    this.renaming = null;
    const generation = ++this.generation;
    const start = await loadLocalLibrary(this.host.account());
    if (generation !== this.generation) return;
    this.entries = start.entries;
    this.folders = start.folders;
    this.shared = start.shared;
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
    const identity = this.host.signedIn();
    this.setAccount(identity, user !== null);
    const library = await loadLibrary(user, identity);
    if (generation !== this.generation) return;
    this.entries = library.entries;
    this.folders = library.folders;
    this.shared = library.shared;
    this.notice.textContent = library.cloudProblem ?? '';
    this.render();
  }

  // --- Rendering ---------------------------------------------------------------------------

  private setAccount(user: User | null, syncs = user !== null): void {
    const button = (text: string, run: () => Promise<void>) => {
      const b = h('button', { text, attrs: { type: 'button' } });
      b.addEventListener('click', () =>
        void run().then(
          () => this.refresh(),
          (error: unknown) => {
            this.notice.textContent = t('panels.dashboard.failed', { reason: error instanceof Error ? error.message : String(error) });
          },
        ),
      );
      return b;
    };
    if (user) {
      const who = user.email ?? user.name ?? t('panels.dashboard.yourAccount');
      // Signed in without sync: their documents are in this browser, and Subscribe keeps them in the account.
      this.account.replaceChildren(
        h('span', { text: who }),
        ...(syncs ? [] : [button(t('panels.dashboard.subscribe'), () => this.host.subscribe())]),
        button(t('panels.dashboard.signOut'), () => this.host.signOut()),
      );
    } else {
      this.account.replaceChildren(h('span', { text: t('panels.dashboard.savedHere') }), button(t('panels.dashboard.signIn'), () => this.host.signIn()));
    }
  }

  private releaseThumbnails(): void {
    this.observer?.disconnect();
    this.observer = null;
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls = [];
    this.loaded.clear();
  }

  private render(): void {
    this.observer?.disconnect();
    this.observer = null;
    // The cards are redrawn, so a pending "confirm" goes, and so must its timer (it would reset the next one early).
    if (this.confirming) clearTimeout(this.confirming.timer);
    this.confirming = null;
    // Searching looks in every folder at once; otherwise this folder's own folders and documents.
    const searching = this.search.value.trim() !== '';
    if (this.folderId !== null && !this.folders.some((f) => f.id === this.folderId)) this.folderId = null;
    const shown = searching ? this.entries.filter((e) => matchesSearch(e, this.search.value)) : itemsIn(this.entries, this.folders, this.folderId);
    const shownFolders = searching ? this.folders.filter((f) => matchesSearch(f, this.search.value)) : childFolders(this.folders, this.folderId);
    this.renderCrumbs(searching);

    const blank = h('button', { class: 'wm-card wm-card-new', attrs: { type: 'button', 'aria-label': t('panels.dashboard.newBlankLabel') } }, h('span', { class: 'wm-plus', text: '+' }), h('span', { text: t('panels.dashboard.newBlank') }));
    blank.addEventListener('click', () => {
      const folderId = this.folderId;
      this.hide();
      this.host.newDocument(folderId);
    });

    const importTile = h('button', { class: 'wm-card wm-card-new', attrs: { type: 'button', 'aria-label': t('panels.dashboard.importLabel') } }, h('span', { class: 'wm-plus', text: '↑' }), h('span', { text: t('panels.dashboard.import') }));
    importTile.addEventListener('click', () => {
      // Stays up behind the file picker: hiding it would show the last open document.
      this.host.importFile(this.folderId);
    });

    const newFolder = h('button', { class: 'wm-card wm-card-new', attrs: { type: 'button', 'aria-label': t('panels.dashboard.newFolderLabel') } }, h('span', { class: 'wm-plus', text: '+' }), h('span', { text: t('panels.dashboard.newFolder') }));
    newFolder.addEventListener('click', () => {
      // Not listed again afterwards: that would rebuild the name being typed.
      void this.run(async () => {
        const folder = await createFolder(this.host.account() !== null, t('panels.dashboard.newFolderName'), this.folderId);
        this.folders = [...this.folders, folder];
        this.renaming = folder.id;
      }, false);
    });

    const cards = shown.map((entry) => this.card(entry));
    const children: (HTMLElement | string)[] = [blank, importTile, ...(searching ? [] : [newFolder]), ...shownFolders.map((f) => this.folderCard(f)), ...cards];
    if (!shown.length && !shownFolders.length) {
      children.push(h('p', { class: 'wm-dash-empty', text: this.search.value.trim() ? t('panels.dashboard.noMatches') : t('panels.dashboard.empty') }));
    }
    this.rebuilding = true;
    this.grid.replaceChildren(...children);
    this.rebuilding = false;
    const renameField = this.grid.querySelector<HTMLInputElement>('.wm-folder-name-input');
    if (renameField) {
      renameField.focus({ preventScroll: false });
      renameField.select();
    }

    const sharedShown = this.shared.filter((d) => matchesSearch(d, this.search.value));
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
    this.reuseThumbnail(thumb, `shared:${doc.id}`, thumbnailUrl(doc) ?? '');
    const by = doc.owner?.name ?? doc.owner?.email;
    const meta = [by ? t('panels.dashboard.from', { name: by }) : null, relativeTime(doc.updatedAt)].filter(Boolean).join(' · ');
    const open = h('button', { class: 'wm-card-open', attrs: { type: 'button', 'aria-label': t('panels.dashboard.open', { name: doc.name }) } }, thumb, h('span', { class: 'wm-card-name', text: doc.name, title: doc.name }), h('span', { class: 'wm-card-meta', text: meta }));
    open.addEventListener('click', () => {
      this.hide();
      this.host.openShared(doc);
    });
    const badges = h('div', { class: 'wm-badges' }, h('span', { class: 'wm-badge', text: doc.role === 'viewer' ? t('panels.dashboard.viewOnly') : t('panels.dashboard.canEdit') }));
    const actions = h('div', { class: 'wm-card-actions' });
    const user = this.host.account();
    if (user) {
      const userId = user.id;
      actions.append(
        this.confirmButton(t('panels.dashboard.leave'), async () => {
          await removeShare(doc.id, userId);
        }),
      );
    }
    return h('article', { class: 'wm-card' }, open, badges, actions);
  }

  private card(entry: LibraryEntry): HTMLElement {
    const thumb = h('div', { class: 'wm-thumb' }, h('div', { class: 'wm-thumb-empty', attrs: { 'aria-hidden': 'true' } }));
    this.entryFor.set(thumb, entry);
    this.reuseThumbnail(thumb, entry.key, this.thumbSignature(entry));

    const meta = [relativeTime(entry.updatedAt), formatSize(entry.size)].join(' · ');
    const open = h('button', { class: 'wm-card-open', attrs: { type: 'button', 'aria-label': t('panels.dashboard.open', { name: entry.name }) } }, thumb, h('span', { class: 'wm-card-name', text: entry.name, title: entry.name }), h('span', { class: 'wm-card-meta', text: meta }));
    open.addEventListener('click', () => {
      this.hide();
      this.host.open(entry);
    });

    const badges = h('div', { class: 'wm-badges' });
    const sync = syncBadge(entry.state, this.host.account() !== null);
    if (sync) badges.append(h('span', { class: `wm-badge wm-badge-${sync.tone}`, text: sync.text }));

    const actions = h('div', { class: 'wm-card-actions' }, this.confirmButton(t('panels.dashboard.delete'), () => this.host.delete(entry)));
    if (entry.cloud) {
      const share = h('button', { text: t('panels.dashboard.share'), attrs: { type: 'button' } });
      share.addEventListener('click', () => this.host.share(entry.cloud!.id, entry.cloud!.name));
      actions.prepend(share);
    }
    const move = h('button', { text: t('panels.dashboard.move'), attrs: { type: 'button' } });
    move.addEventListener('click', () => this.pickFolder(t('panels.dashboard.moveTitle', { name: entry.name }), () => false, folderOf(entry, this.folders), (to) => this.relocate({ kind: 'doc', entry }, to)));
    actions.prepend(move);
    const card = h('article', { class: 'wm-card' }, open, badges, actions);
    this.makeDraggable(card, { kind: 'doc', entry });
    return card;
  }

  /** A folder: open it, rename it, move it, or delete it (what is in it moves up). */
  private folderCard(folder: Folder): HTMLElement {
    const art = h('div', { class: 'wm-thumb wm-folder-art' }, h('div', { class: 'wm-folder-shape', attrs: { 'aria-hidden': 'true' } }));
    let open: HTMLElement;
    if (this.renaming === folder.id) {
      const input = h('input', { class: 'wm-folder-name-input', attrs: { type: 'text', value: folder.name, 'aria-label': t('panels.dashboard.folderName'), maxlength: '255' } });
      let finished = false;
      const finish = (save: boolean) => {
        if (finished) return;
        finished = true;
        this.renaming = null;
        const name = input.value.trim();
        if (save && name && name !== folder.name) void this.run(() => this.changeFolder(folder, { name }));
        else this.render();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') {
          e.stopPropagation();
          finish(false);
        }
      });
      input.addEventListener('blur', () => {
        if (!this.rebuilding) finish(true);
      });
      open = h('div', { class: 'wm-card-open' }, art, input);
    } else {
      const count = itemsIn(this.entries, this.folders, folder.id).length + childFolders(this.folders, folder.id).length;
      open = h('button', { class: 'wm-card-open', attrs: { type: 'button', 'aria-label': t('panels.dashboard.openFolder', { name: folder.name }) } }, art, h('span', { class: 'wm-card-name', text: folder.name, title: folder.name }), h('span', { class: 'wm-card-meta', text: t('panels.dashboard.items', { count }) }));
      open.addEventListener('click', () => {
        this.search.value = '';
        this.folderId = folder.id;
        this.render();
        this.scroller.scrollTop = 0;
      });
    }

    const rename = h('button', { text: t('panels.dashboard.rename'), attrs: { type: 'button' } });
    rename.addEventListener('click', () => {
      this.renaming = folder.id;
      this.render();
    });
    const move = h('button', { text: t('panels.dashboard.move'), attrs: { type: 'button' } });
    move.addEventListener('click', () =>
      this.pickFolder(t('panels.dashboard.moveTitle', { name: folder.name }), (id) => isInside(this.folders, id, folder.id), folder.parentId, (to) => this.relocate({ kind: 'folder', folder }, to)),
    );
    const actions = h('div', { class: 'wm-card-actions' }, rename, move, this.confirmButton(t('panels.dashboard.deleteFolder'), () => removeFolder(this.host.account() !== null, folder)));
    const card = h('article', { class: 'wm-card wm-folder' }, open, actions);
    this.makeDraggable(card, { kind: 'folder', folder });
    this.makeDropTarget(card, folder.id);
    return card;
  }

  /** "Documents › A › B": where this is, and a way back up (a place to drop things, too). */
  private renderCrumbs(searching: boolean): void {
    this.crumbs.hidden = searching || this.folderId === null;
    if (this.crumbs.hidden) return;
    const path = folderPath(this.folders, this.folderId);
    const stops: { id: string | null; name: string }[] = [{ id: null, name: t('panels.dashboard.title') }, ...path.map((f) => ({ id: f.id, name: f.name }))];
    const parts: HTMLElement[] = [];
    stops.forEach((stop, i) => {
      if (i) parts.push(h('span', { class: 'wm-crumb-sep', text: '›', attrs: { 'aria-hidden': 'true' } }));
      const last = i === stops.length - 1;
      const crumb = h('button', { class: 'wm-crumb', text: stop.name, attrs: { type: 'button', ...(last ? { 'aria-current': 'page' } : {}) } });
      crumb.disabled = last;
      crumb.addEventListener('click', () => {
        this.folderId = stop.id;
        this.render();
      });
      if (!last) this.makeDropTarget(crumb, stop.id);
      parts.push(crumb);
    });
    this.crumbs.replaceChildren(...parts);
  }

  /** Runs a change to the folders, then lists everything again (showing why, if it failed). */
  private async run(change: () => Promise<void>, reload = true): Promise<void> {
    try {
      await change();
      this.notice.textContent = '';
    } catch (error) {
      this.notice.textContent = t('panels.dashboard.failed', { reason: error instanceof Error ? error.message : String(error) });
    }
    // Shown at once from what is known (a folder just made is typed in), then as the account has it.
    this.render();
    if (reload) await this.refresh();
  }

  private relocate(item: Dragged, to: string | null): Promise<void> {
    return this.run(
      item.kind === 'doc'
        ? async () => {
            await moveEntry(item.entry, to);
            // Shown in its new place at once, before the lists are fetched again.
            const { entry } = item;
            if (entry.cloud) entry.cloud.folderId = to;
            if (entry.local) {
              if (to === null) delete entry.local.folderId;
              else entry.local.folderId = to;
            }
          }
        : () => this.changeFolder(item.folder, { parentId: to }),
    );
  }

  /** Renames and/or moves a folder, and shows it so at once. */
  private async changeFolder(folder: Folder, change: { name?: string; parentId?: string | null }): Promise<void> {
    const next = await updateFolder(this.host.account() !== null, folder, change);
    this.folders = this.folders.map((f) => (f.id === next.id ? next : f));
  }

  /** Whether the thing being dragged may go in `to` (null: the top level): somewhere new, and never into itself. */
  private canDrop(item: Dragged, to: string | null): boolean {
    if (item.kind === 'doc') return folderOf(item.entry, this.folders) !== to;
    return item.folder.parentId !== to && to !== item.folder.id && !isInside(this.folders, to, item.folder.id);
  }

  private makeDraggable(el: HTMLElement, item: Dragged): void {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      this.dragged = item;
      el.classList.add('wm-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.kind === 'doc' ? item.entry.name : item.folder.name);
      }
    });
    el.addEventListener('dragend', () => {
      this.dragged = null;
      el.classList.remove('wm-dragging');
    });
  }

  private makeDropTarget(el: HTMLElement, folderId: string | null): void {
    const accepts = () => this.dragged !== null && this.canDrop(this.dragged, folderId);
    el.addEventListener('dragover', (e) => {
      if (!accepts()) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      el.classList.add('wm-drop');
    });
    el.addEventListener('dragleave', () => el.classList.remove('wm-drop'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('wm-drop');
      const item = this.dragged;
      if (!item || !accepts()) return;
      e.preventDefault();
      this.dragged = null;
      void this.relocate(item, folderId);
    });
  }

  /**
   * Asks which folder to move something to: a list of every folder (and the top level), except
   * those `excluded` and the one it is in already.
   */
  private pickFolder(title: string, excluded: (id: string) => boolean, current: string | null, pick: (id: string | null) => void): void {
    const choices = [{ id: null as string | null, name: t('panels.dashboard.title'), depth: 0 }, ...folderTree(this.folders).filter((n) => !excluded(n.folder.id)).map((n) => ({ id: n.folder.id as string | null, name: n.folder.name, depth: n.depth + 1 }))];
    const close = () => backdrop.remove();
    const buttons = choices.map((choice) => {
      const b = h('button', { class: 'wm-move-choice', text: choice.name, attrs: { type: 'button' } });
      b.style.paddingLeft = `${10 + choice.depth * 16}px`;
      b.disabled = choice.id === current;
      b.addEventListener('click', () => {
        close();
        pick(choice.id);
      });
      return b;
    });
    const cancel = h('button', { text: t('panels.dashboard.cancel'), attrs: { type: 'button' } });
    cancel.addEventListener('click', close);
    const dialog = h('div', { class: 'wm-move', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title } }, h('h2', { text: title }), h('div', { class: 'wm-move-list' }, ...buttons), h('div', { class: 'wm-move-actions' }, cancel));
    const backdrop = h('div', { class: 'wm-move-backdrop' }, dialog);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close();
    });
    backdrop.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    });
    this.root.append(backdrop);
    (buttons.find((b) => !b.disabled) ?? cancel).focus();
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
            this.notice.textContent = t('panels.dashboard.failed', { reason: error instanceof Error ? error.message : String(error) });
            void this.refresh();
          },
        );
        return;
      }
      this.resetConfirm();
      button.textContent = t('panels.dashboard.confirm');
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

  /** Thumbnails already on screen, so a re-render (the cloud catalogue arriving) doesn't reload them. */
  private readonly loaded = new Map<string, { signature: string; img: HTMLImageElement }>();

  /** What decides which image a card shows; when it is unchanged the loaded image is still right. */
  private thumbSignature(entry: LibraryEntry): string {
    const cloudUrl = entry.cloud ? thumbnailUrl(entry.cloud) : null;
    const preferCloud = !entry.local || entry.state === 'cloud-ahead';
    return `${preferCloud ? 'cloud' : 'local'}|${cloudUrl}|${entry.local?.id}|${entry.local?.updatedAt}`;
  }

  /** Puts back the image a previous render already loaded for this card, if it is still current. */
  private reuseThumbnail(thumb: HTMLElement, key: string, signature: string): void {
    thumb.dataset.thumbKey = key;
    thumb.dataset.thumbSignature = signature;
    const cached = this.loaded.get(key);
    if (cached?.signature === signature) {
      thumb.replaceChildren(cached.img);
      thumb.dataset.thumbDone = '1';
    }
  }

  /** Fills a card's thumbnail: this device's when it has the current one, else the cloud's. */
  private async loadThumbnail(thumb: HTMLElement): Promise<void> {
    if (thumb.dataset.thumbDone) return;
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
    img.addEventListener(
      'load',
      () => {
        thumb.replaceChildren(img);
        thumb.dataset.thumbDone = '1';
        const { thumbKey, thumbSignature } = thumb.dataset;
        if (thumbKey && thumbSignature !== undefined) this.loaded.set(thumbKey, { signature: thumbSignature, img });
      },
      { once: true },
    );
    img.src = src; // on failure the placeholder stays
  }
}
