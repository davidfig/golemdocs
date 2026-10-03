// The dashboard: every document at a glance, as a grid of first-page thumbnails. Signed in, that
// is the account's documents; signed out, the ones saved in this browser (sync.ts lists them). It
// is a plain DOM screen laid over the editor's canvas; File ▸ Open shows it, Esc or any open
// hides it.
//
// Nothing here is loaded before it is needed: what this browser has appears straight away, the
// rest of the account's documents once the catalogue arrives, and each thumbnail is fetched only
// when its card scrolls into view.

import { removeShare, type CloudDocument } from '../cloud.ts';
import { canDrop, createFolder, moveEntries, removeFolderTree, updateFolders, withMoved, withoutDeleted, type Dragged } from '../folderOps.ts';
import { childFolders, deletionList, folderContents, folderOf, folderPath, isInside, itemsIn, outermost, type Folder } from '../folders.ts';
import { warmOnHover } from './warmOnHover.ts';
import type { LibraryStore } from '../libraryStore.ts';
import { forgetSharedInCatalogue, type LibraryEntry } from '../sync.ts';
import type { User } from '../auth.ts';
import { formatSize, matchesSearch, relativeTime, syncBadge } from './dashboardFormat.ts';
import { t } from '../i18n/index.ts';
import { Thumbnails } from './dashboardThumbnails.ts';
import { h, isFileDrag } from './dom.ts';
import { takeDropped, type Dropped } from '../storage/droppedFiles.ts';
import { fileIcon, setFileName } from './fileIcons.ts';
import { confirmDelete, deleteTitle } from './deleteDialog.ts';
import { pickFolder } from './folderPicker.ts';
import { iconElement } from './icons.ts';
import './dashboard.css';

const SIZE_KEY = 'golemdocs.dashboardIconSize';
const SIZE_MIN = 80;
const SIZE_MAX = 260;
const SIZE_DEFAULT = 120;

/** What the dashboard asks of the application. */
export interface DashboardHost {
  /** Starts a blank document, to be filed in `folderId` (null: the top level) when it is first saved. */
  newDocument(folderId: string | null): void;
  /** The document open behind the dashboard (its ids in this browser and in the account), whose folder the dashboard starts in. */
  currentDocument(): { localId: string | null; cloudId: string | null };
  open(entry: LibraryEntry): void;
  /** The pointer is on this document: a chance to start fetching what opening it needs. */
  warm(entry: LibraryEntry): void;
  /** Asks for a file on this computer and opens it, to be filed in `folderId` when it is first saved. */
  importFile(folderId: string | null): void;
  /** Opens a file dropped from the computer, to be filed in `folderId` (null: the top level) when it is first saved; imports several, or a folder, there. */
  dropFile(drop: Dropped, folderId: string | null): void;
  /** Deletes the document everywhere: from the account and from this browser. */
  delete(entries: LibraryEntry[], folderIds?: string[]): Promise<void>;
  /** Whose cloud documents are shown: who is signed in, if they have sync (null: nobody, or no sync). */
  account(): User | null;
  /** Who is signed in, with or without sync. */
  signedIn(): User | null;
  /** Opens the sharing dialog for a cloud document the user owns. */
  share(cloudId: string, name: string): void;
  /** Opens a document someone else shared with the user. */
  openShared(doc: CloudDocument): void;
  /** The dashboard was closed without opening anything: give the editor back the keyboard. */
  closed(): void;
}

/** What is being dragged to a folder. */
// --- The screen -----------------------------------------------------------------------------

/** The folders and documents as listed before a delete took its items off the screen, which is what finding what is inside a folder needs. */
type Listed = { folders: Folder[]; entries: LibraryEntry[] };

export class Dashboard {
  private readonly root: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly notice: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly sharedTitle: HTMLElement;
  private readonly sharedGrid: HTMLElement;
  private readonly scroller: HTMLElement;
  private thumbnails!: Thumbnails;
  private readonly newFolderButton: HTMLButtonElement;
  /** Documents (`doc:<key>`) and folders (`folder:<id>`) ticked for a bulk Move or Delete. */
  private readonly selected = new Set<string>();
  /** Where a Shift-click range starts: the card ticked last. */
  private anchor: string | null = null;
  private readonly selectionBar: HTMLElement;
  private readonly selectionCount: HTMLElement;
  /** The folder being looked at (null: the top level). */
  private folderId: string | null = null;
  /** The folder whose name is being typed in place (just made, or being renamed). */
  private renaming: string | null = null;
  /** What has been typed in the folder name field so far (and where the caret is), kept when the cards are rebuilt under it. */
  private renameDraft: { folder: string; value: string; start: number; end: number } | null = null;
  private dragged: Dragged | null = null;
  /** While the cards are being replaced: the rename field losing its place isn't the user leaving it. */
  private rebuilding = false;
  private readonly crumbs: HTMLElement;
  /** Cards showing a "click again to confirm" button, and the timer that resets them. */
  private confirming: { button: HTMLButtonElement; label: string; icon?: string; iconOnly: boolean; timer: number } | null = null;

  /** `library`: the documents and folders, the same copy the Files Sidebar shows. */
  constructor(
    parent: HTMLElement,
    private readonly host: DashboardHost,
    private readonly library: LibraryStore,
  ) {
    library.subscribe(() => {
      if (!this.visible) return;
      this.notice.textContent = library.problem ?? '';
      this.render();
    });
    this.search = h('input', { class: 'wm-dash-search', attrs: { type: 'search', placeholder: t('panels.dashboard.search'), 'aria-label': t('panels.dashboard.search') } });
    this.notice = h('p', { class: 'wm-dash-notice', attrs: { role: 'status' } });
    this.grid = h('div', { class: 'wm-dash-grid' });
    this.crumbs = h('nav', { class: 'wm-dash-crumbs', attrs: { 'aria-label': t('panels.dashboard.location') } });
    const close = h('button', { class: 'wm-dash-close', text: '×', attrs: { type: 'button', 'aria-label': t('panels.dashboard.close'), title: t('panels.dashboard.close') } });
    close.addEventListener('click', () => this.dismiss());
    this.sharedTitle = h('h2', { class: 'wm-dash-section', text: t('panels.dashboard.sharedWithMe') });
    this.sharedGrid = h('div', { class: 'wm-dash-grid' });
    this.scroller = h('div', { class: 'wm-dash-scroll' }, this.notice, this.crumbs, this.grid, this.sharedTitle, this.sharedGrid);
    this.thumbnails = new Thumbnails(this.scroller);
    const action = (icon: string, label: string, aria: string, onClick: () => void): HTMLButtonElement => {
      const button = h('button', { class: 'wm-dash-action', attrs: { type: 'button', 'aria-label': aria } });
      this.setLabel(button, label, icon);
      button.addEventListener('click', onClick);
      return button;
    };
    const blank = action('new', t('panels.dashboard.newBlank'), t('panels.dashboard.newBlankLabel'), () => {
      const folderId = this.folderId;
      this.hide();
      this.host.newDocument(folderId);
    });
    // Stays up behind the file picker: hiding it would show the last open document.
    const importButton = action('import', t('panels.dashboard.import'), t('panels.dashboard.importLabel'), () => this.host.importFile(this.folderId));
    this.newFolderButton = action('newFolder', t('panels.dashboard.newFolder'), t('panels.dashboard.newFolderLabel'), () => {
      // Not listed again afterwards: that would rebuild the name being typed.
      void this.run(async () => {
        const folder = await createFolder(this.host.account() !== null, t('panels.dashboard.newFolderName'), this.folderId);
        this.folders = [...this.folders, folder];
        this.renaming = folder.id;
      }, false);
    });
    const moveSelected = action('moveToFolder', t('panels.dashboard.move'), t('panels.dashboard.moveSelected'), () => this.moveSelection());
    const deleteSelected = this.deleteButton(() => this.selectedItems(), (before, items) => this.deleteSelection(before, items), 'trash');
    const clearSelection = action('close', t('panels.dashboard.clearSelection'), t('panels.dashboard.clearSelection'), () => this.setSelection([]));
    this.selectionCount = h('span', { class: 'wm-dash-selected', attrs: { role: 'status' } });
    this.selectionBar = h('div', { class: 'wm-dash-selection' }, this.selectionCount, moveSelected, deleteSelected, clearSelection);
    this.selectionBar.hidden = true;
    const actions = h('div', { class: 'wm-dash-actions' }, blank, importButton, this.newFolderButton, this.selectionBar);
    const size = this.sizeSlider();
    this.root = h(
      'section',
      { class: 'wm-dashboard', attrs: { 'aria-label': t('panels.dashboard.title') } },
      h('header', { class: 'wm-dash-head' }, h('h1', { text: t('panels.dashboard.title') }), this.search, size, close),
      actions,
      this.scroller,
    );
    this.root.hidden = true;
    this.takeFiles(this.root);
    parent.append(this.root);

    this.search.addEventListener('input', () => this.render());
    // On the document, so Escape closes it whatever has the focus; the folder name field and the
    // "move to" list handle (and stop) their own Escape first.
    document.addEventListener('keydown', (e) => {
      if (!this.visible || e.defaultPrevented) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        // The first Esc drops a selection; the next closes.
        if (this.selected.size) this.setSelection([]);
        else this.dismiss();
      } else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey) && (e.target === this.search ? !this.search.value : !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement))) {
        e.preventDefault();
        this.setSelection([...this.grid.querySelectorAll<HTMLElement>('[data-select]')].map((el) => el.dataset.select!));
      }
    });
  }

  /** The icon-size slider: sets the card width (remembered in this browser). */
  private sizeSlider(): HTMLElement {
    let size = SIZE_DEFAULT;
    try {
      const saved = Number(localStorage.getItem(SIZE_KEY));
      if (saved >= SIZE_MIN && saved <= SIZE_MAX) size = saved;
    } catch {
      // Storage blocked: the default size.
    }
    const apply = (value: number): void => this.root.style.setProperty('--wm-card-size', `${value}px`);
    const range = h('input', { class: 'wm-dash-size', attrs: { type: 'range', min: String(SIZE_MIN), max: String(SIZE_MAX), step: '10', value: String(size), 'aria-label': t('panels.dashboard.iconSize'), title: t('panels.dashboard.iconSize') } });
    range.addEventListener('input', () => {
      const value = Number(range.value);
      apply(value);
      try {
        localStorage.setItem(SIZE_KEY, String(value));
      } catch {
        // Not remembered.
      }
    });
    queueMicrotask(() => apply(size));
    return range;
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  toggle(): void {
    if (this.visible) this.dismiss();
    else void this.show();
  }

  /**
   * Shows the dashboard and refreshes it: what this browser has first, then the account's.
   * It is a step in the browser's history (so Back closes it); `step` is false when Forward is what brought it here.
   */
  async show(step = true): Promise<void> {
    if (step && !this.visible && !history.state?.dashboard) history.pushState({ dashboard: true }, '', location.href);
    this.root.hidden = false;
    this.search.value = '';
    this.folderId = null;
    this.renaming = null;
    this.selected.clear();
    // What the library has shows at once; the listing brings it up to date.
    this.folderId = this.currentFolder();
    this.notice.textContent = this.library.problem ?? '';
    this.render();
    // Once the menu or key that opened it is done with the focus (it hands it back as it closes).
    setTimeout(() => {
      if (this.visible) this.search.focus({ preventScroll: true });
    }, 0);
    await this.refresh();
  }

  /** The folder the open document is in (null: the top level, or it isn't saved yet), so Open starts where it is. */
  private currentFolder(): string | null {
    const { localId, cloudId } = this.host.currentDocument();
    const entry = this.entries.find((e) => (localId !== null && e.key === localId) || (cloudId !== null && e.cloud?.id === cloudId));
    return entry ? folderOf(entry, this.folders) : null;
  }

  /** Hides it (without opening anything), undoing its step in history unless Back is what closed it. */
  dismiss(step = true): void {
    if (!this.visible) return;
    this.hide();
    if (step && history.state?.dashboard) history.back();
    this.host.closed();
  }

  hide(): void {
    this.root.hidden = true;
    this.thumbnails.release();
  }

  private refresh(): Promise<void> {
    return this.library.refresh();
  }

  /** The documents, folders and what others shared, as the library has them; a change set here shows wherever the library does. */
  private get entries(): LibraryEntry[] {
    return this.library.entries;
  }

  private set entries(entries: LibraryEntry[]) {
    this.library.update({ entries });
  }

  private get folders(): Folder[] {
    return this.library.folders;
  }

  private set folders(folders: Folder[]) {
    this.library.update({ folders });
  }

  private get shared(): CloudDocument[] {
    return this.library.shared;
  }

  // --- Rendering ---------------------------------------------------------------------------

  private render(): void {
    const field = this.grid.querySelector<HTMLInputElement>('.wm-folder-name-input');
    this.renameDraft =
      field && this.renaming ? { folder: this.renaming, value: field.value, start: field.selectionStart ?? field.value.length, end: field.selectionEnd ?? field.value.length } : null;
    this.thumbnails.pause();
    // The cards are redrawn, so a pending "confirm" goes, and so must its timer (it would reset the next one early).
    this.resetConfirm();
    // Searching looks in every folder at once; otherwise this folder's own folders and documents.
    const searching = this.search.value.trim() !== '';
    if (this.folderId !== null && !this.folders.some((f) => f.id === this.folderId)) this.folderId = null;
    const shown = searching ? this.entries.filter((e) => matchesSearch(e, this.search.value)) : itemsIn(this.entries, this.folders, this.folderId);
    const shownFolders = searching ? this.folders.filter((f) => matchesSearch(f, this.search.value)) : childFolders(this.folders, this.folderId);
    this.renderCrumbs(searching);

    this.newFolderButton.hidden = searching;

    const cards = shown.map((entry) => this.card(entry));
    const children: (HTMLElement | string)[] = [...shownFolders.map((f) => this.folderCard(f)), ...cards];
    if (!shown.length && !shownFolders.length) {
      children.push(h('p', { class: 'wm-dash-empty', text: this.search.value.trim() ? t('panels.dashboard.noMatches') : t('panels.dashboard.empty') }));
    }
    this.rebuilding = true;
    this.grid.replaceChildren(...children);
    this.rebuilding = false;
    this.syncSelection();
    const renameField = this.grid.querySelector<HTMLInputElement>('.wm-folder-name-input');
    if (renameField) {
      renameField.focus({ preventScroll: false });
      const draft = this.renameDraft?.folder === this.renaming ? this.renameDraft : null;
      if (draft) renameField.setSelectionRange(draft.start, draft.end);
      else renameField.select();
    }

    const sharedShown = this.shared.filter((d) => matchesSearch(d, this.search.value));
    this.sharedTitle.hidden = this.sharedGrid.hidden = sharedShown.length === 0;
    this.sharedGrid.replaceChildren(...sharedShown.map((d) => this.sharedCard(d)));

    this.thumbnails.watch();
  }

  /** A document someone else shared: open it, or leave it. */
  private sharedCard(doc: CloudDocument): HTMLElement {
    const thumb = this.thumbnails.forShared(doc);
    const by = doc.owner?.name ?? doc.owner?.email;
    const meta = [by ? t('panels.dashboard.from', { name: by }) : null, relativeTime(doc.updatedAt)].filter(Boolean).join(' · ');
    const open = h('button', { class: 'wm-card-open', attrs: { type: 'button', 'aria-label': t('panels.dashboard.open', { name: doc.name }) } }, thumb, h('span', { class: 'wm-card-name', title: doc.name }, fileIcon(doc.name), setFileName(h('span', { class: 'wm-card-title' }), doc.name)), h('span', { class: 'wm-card-meta', text: meta }));
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
        this.confirmButton(
          t('panels.dashboard.leave'),
          async () => {
            await removeShare(doc.id, userId);
            forgetSharedInCatalogue(doc.id);
          },
          'leave',
          undefined,
          true,
        ),
      );
    }
    return h('article', { class: 'wm-card' }, open, badges, actions);
  }

  private card(entry: LibraryEntry): HTMLElement {
    const thumb = this.thumbnails.forEntry(entry);

    const meta = [relativeTime(entry.updatedAt), formatSize(entry.size)].join(' · ');
    const open = h('button', { class: 'wm-card-open', attrs: { type: 'button', 'aria-label': t('panels.dashboard.open', { name: entry.name }) } }, thumb, h('span', { class: 'wm-card-name', title: entry.name }, fileIcon(entry.name), setFileName(h('span', { class: 'wm-card-title' }), entry.name)), h('span', { class: 'wm-card-meta', text: meta }));
    warmOnHover(open, () => this.host.warm(entry));
    open.addEventListener('click', () => {
      this.hide();
      this.host.open(entry);
    });

    const badges = h('div', { class: 'wm-badges' });
    const sync = syncBadge(entry.state, this.host.account() !== null);
    if (sync) badges.append(h('span', { class: `wm-badge wm-badge-${sync.tone}`, text: sync.text }));

    const actions = h('div', { class: 'wm-card-actions' }, this.deleteButton(() => ({ docs: [entry], folders: [] }), () => this.host.delete([entry]), 'trash', true));
    if (entry.cloud) {
      const share = this.iconButton('share', t('panels.dashboard.share'));
      share.addEventListener('click', () => this.host.share(entry.cloud!.id, entry.cloud!.name));
      actions.prepend(share);
    }
    const move = this.iconButton('moveToFolder', t('panels.dashboard.move'));
    move.addEventListener('click', () => this.pickFolder(t('panels.dashboard.moveTitle', { name: entry.name }), () => false, folderOf(entry, this.folders), (to) => this.relocate({ kind: 'doc', entry }, to)));
    actions.prepend(move);
    const card = h('article', { class: 'wm-card' }, open, badges, actions);
    this.makeDraggable(card, { kind: 'doc', entry });
    this.makeSelectable(card, `doc:${entry.key}`, entry.name);
    return card;
  }

  /** A folder: open it, rename it, move it, or delete it (what is in it moves up). */
  private folderCard(folder: Folder): HTMLElement {
    // The folder's first few documents show through it as small pages.
    const minis = itemsIn(this.entries, this.folders, folder.id)
      .slice(0, 4)
      .map((entry) => this.thumbnails.forEntry(entry, `mini:${entry.key}`, 'wm-thumb wm-folder-mini'));
    const art = h('div', { class: 'wm-thumb wm-folder-art' }, h('div', { class: 'wm-folder-shape', attrs: { 'aria-hidden': 'true' } }, ...minis));
    let open: HTMLElement;
    if (this.renaming === folder.id) {
      const draft = this.renameDraft?.folder === folder.id ? this.renameDraft.value : null;
      const input = h('input', { class: 'wm-folder-name-input', attrs: { type: 'text', value: draft ?? folder.name, 'aria-label': t('panels.dashboard.folderName'), maxlength: '255' } });
      let finished = false;
      const finish = (save: boolean) => {
        if (finished) return;
        finished = true;
        this.renaming = null;
        const name = input.value.trim();
        if (save && name && name !== folder.name) void this.run(() => this.changeFolders([{ folder, name }]));
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
      open = h('button', { class: 'wm-card-open', attrs: { type: 'button', 'aria-label': t('panels.dashboard.openFolder', { name: folder.name }) } }, art, h('span', { class: 'wm-card-name', title: folder.name }, h('span', { class: 'wm-card-title', text: folder.name })), h('span', { class: 'wm-card-meta', text: t('panels.dashboard.items', { count }) }));
      open.addEventListener('click', () => {
        this.search.value = '';
        this.folderId = folder.id;
        this.selected.clear();
        this.render();
        this.scroller.scrollTop = 0;
      });
    }

    const rename = this.iconButton('rename', t('panels.dashboard.rename'));
    rename.addEventListener('click', () => {
      this.renaming = folder.id;
      this.render();
    });
    const move = this.iconButton('moveToFolder', t('panels.dashboard.move'));
    move.addEventListener('click', () =>
      this.pickFolder(t('panels.dashboard.moveTitle', { name: folder.name }), (id) => isInside(this.folders, id, folder.id), folder.parentId, (to) => this.relocate({ kind: 'folder', folder }, to)),
    );
    const actions = h('div', { class: 'wm-card-actions' }, rename, move, this.deleteButton(() => ({ docs: [], folders: [folder] }), (before) => this.deleteFolderTrees(before, [folder]), 'trash', true, t('panels.dashboard.deleteFolder')));
    const card = h('article', { class: 'wm-card wm-folder' }, open, actions);
    this.makeDraggable(card, { kind: 'folder', folder });
    this.makeDropTarget(card, folder.id);
    this.makeSelectable(card, `folder:${folder.id}`, folder.name);
    return card;
  }

  // --- Selection ---------------------------------------------------------------------------

  /** A tick box on the card (and Ctrl/Cmd-click on it) to add it to the selection. */
  private makeSelectable(card: HTMLElement, key: string, name: string): void {
    card.dataset.select = key;
    const box = h('input', { class: 'wm-select', attrs: { type: 'checkbox', 'aria-label': t('panels.dashboard.select', { name }) } });
    box.checked = this.selected.has(key);
    card.classList.toggle('wm-selected', box.checked);
    box.addEventListener('change', () => this.toggleSelected(key, box.checked));
    card.append(box);
    // Ctrl/Cmd-click anywhere on the card ticks it instead of opening it; Shift-click ticks everything from the last one ticked.
    card.addEventListener(
      'click',
      (e) => {
        if (!(e.ctrlKey || e.metaKey || e.shiftKey) || e.target === box) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey && this.anchor !== null) this.selectRange(this.anchor, key);
        else this.toggleSelected(key, !this.selected.has(key));
      },
      true,
    );
  }

  /** Ticks every card from `from` to `to`, in the order shown (keeping what is ticked already). */
  private selectRange(from: string, to: string): void {
    const keys = [...this.grid.querySelectorAll<HTMLElement>('[data-select]')].map((el) => el.dataset.select!);
    const a = keys.indexOf(from);
    const b = keys.indexOf(to);
    if (a < 0 || b < 0) return this.toggleSelected(to, true);
    for (const key of keys.slice(Math.min(a, b), Math.max(a, b) + 1)) this.selected.add(key);
    this.anchor = to;
    this.syncSelection();
  }

  private toggleSelected(key: string, on: boolean): void {
    this.anchor = key;
    if (on) this.selected.add(key);
    else this.selected.delete(key);
    this.syncSelection();
  }

  private setSelection(keys: string[]): void {
    this.anchor = null;
    this.selected.clear();
    for (const key of keys) this.selected.add(key);
    this.syncSelection();
  }

  /** Drops what is no longer listed, then shows the ticks and the Move / Delete buttons to match. */
  private syncSelection(): void {
    const present = new Set<string>();
    for (const card of this.grid.querySelectorAll<HTMLElement>('[data-select]')) {
      const key = card.dataset.select!;
      present.add(key);
      const on = this.selected.has(key);
      card.classList.toggle('wm-selected', on);
      const box = card.querySelector<HTMLInputElement>('.wm-select');
      if (box) box.checked = on;
    }
    for (const key of [...this.selected]) if (!present.has(key)) this.selected.delete(key);
    this.grid.classList.toggle('wm-selecting', this.selected.size > 0);
    this.selectionBar.hidden = this.selected.size === 0;
    this.selectionCount.textContent = t('panels.dashboard.selected', { count: this.selected.size });
    this.resetConfirm();
    for (const b of this.selectionBar.querySelectorAll('button')) b.disabled = false;
  }

  private selectedItems(): { docs: LibraryEntry[]; folders: Folder[] } {
    return {
      docs: this.entries.filter((e) => this.selected.has(`doc:${e.key}`)),
      folders: this.folders.filter((f) => this.selected.has(`folder:${f.id}`)),
    };
  }

  private moveSelection(): void {
    const selected = this.selectedItems();
    const count = selected.docs.length + selected.folders.length;
    // What is inside a ticked folder goes with it, rather than being taken out of it.
    const { folders, items: docs } = outermost(this.folders, { folders: selected.folders, items: selected.docs });
    if (!count) return;
    // A folder can't go into itself or anything inside it.
    const excluded = (id: string) => folders.some((f) => isInside(this.folders, id, f.id));
    this.pickFolder(t('panels.dashboard.moveSelectedTitle', { count }), excluded, undefined, (to) =>
      this.run(async () => {
        await this.relocateEntries(docs.filter((entry) => folderOf(entry, this.folders) !== to), to);
        await this.changeFolders(folders.filter((folder) => folder.parentId !== to).map((folder) => ({ folder, parentId: to })));
        this.selected.clear();
      }),
    );
  }

  /** Deletes what was ticked when Delete was confirmed (the screen, and so the selection, has already lost them). */
  private async deleteSelection(before: Listed, { docs, folders }: { docs: LibraryEntry[]; folders: Folder[] }): Promise<void> {
    this.selected.clear();
    // Folders go with the documents in them (once each), and with the selected documents: one call.
    const inFolders = new Set(folders.flatMap((f) => folderContents(before.folders, before.entries, f).items));
    const loose = docs.filter((e) => !inFolders.has(e));
    if (folders.length) await this.deleteFolderTrees(before, folders, loose);
    else await this.host.delete(loose);
  }

  /** Deletes folders with everything in them (their documents and subfolders), and `alsoDocs`, in one call. */
  private deleteFolderTrees(before: Listed, folders: Folder[], alsoDocs: LibraryEntry[] = []): Promise<void> {
    return removeFolderTree(before.folders, before.entries, folders, (entries, folderIds) => this.host.delete([...alsoDocs, ...entries], folderIds));
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
        this.selected.clear();
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
      item.kind === 'doc' ? () => this.relocateEntries([item.entry], to) : () => this.changeFolders([{ folder: item.folder, parentId: to }]),
    );
  }

  private async relocateEntries(entries: LibraryEntry[], to: string | null): Promise<void> {
    // Shown in their new place at once; if saving fails, the lists fetched again put them back.
    this.entries = withMoved(this.entries, entries, to);
    this.render();
    await moveEntries(entries, to);
  }

  /** Renames and/or moves folders, and shows them so at once. */
  private async changeFolders(changes: { folder: Folder; name?: string; parentId?: string | null }[]): Promise<void> {
    if (!changes.length) return;
    const shown = changes.map(({ folder, ...change }) => ({ ...folder, ...change }));
    this.folders = this.folders.map((f) => shown.find((n) => n.id === f.id) ?? f);
    this.render();
    const next = await updateFolders(this.host.account() !== null, changes);
    this.folders = this.folders.map((f) => next.find((n) => n.id === f.id) ?? f);
  }

  /** Whether the thing being dragged may go in `to` (null: the top level): somewhere new, and never into itself. */
  private canDrop(item: Dragged, to: string | null): boolean {
    return canDrop(this.folders, item, to);
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

  /** A folder (or crumb) that takes documents and folders dragged here, and files dropped from the computer. */
  private makeDropTarget(el: HTMLElement, folderId: string | null): void {
    const accepts = (e: DragEvent) => (this.dragged !== null ? this.canDrop(this.dragged, folderId) : isFileDrag(e));
    el.addEventListener('dragover', (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = this.dragged ? 'move' : 'copy';
      el.classList.add('wm-drop');
    });
    el.addEventListener('dragleave', () => el.classList.remove('wm-drop'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('wm-drop');
      if (!accepts(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const item = this.dragged;
      this.dragged = null;
      if (item) void this.relocate(item, folderId);
      else this.dropFiles(e, folderId);
    });
  }

  /** Anywhere else on the dashboard, a file from the computer goes in the folder being looked at. */
  private takeFiles(el: HTMLElement): void {
    el.addEventListener('dragover', (e) => {
      if (this.dragged || !isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    el.addEventListener('drop', (e) => {
      if (this.dragged || !isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      this.dropFiles(e, this.folderId);
    });
  }

  /** Opens a file dropped from the computer, as dropping it on a document does, and files it in `folderId` (several, or a folder, are imported there). */
  private dropFiles(e: DragEvent, folderId: string | null): void {
    const drop = takeDropped(e.dataTransfer);
    if (drop) this.host.dropFile(drop, folderId);
  }

  private pickFolder(title: string, excluded: (id: string) => boolean, current: string | null | undefined, pick: (id: string | null) => void): void {
    pickFolder(this.root, this.folders, title, excluded, current, pick);
  }

  /** A button that needs a second click, within a few seconds, to do something that can't be undone. */
  private confirmButton(label: string, run: () => Promise<void>, icon?: string, confirmLabel?: string, iconOnly = false): HTMLButtonElement {
    const button = h('button', { class: 'wm-danger', attrs: { type: 'button' } });
    this.setLabel(button, label, icon, iconOnly);
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
      this.setLabel(button, confirmLabel ?? t('panels.dashboard.confirm'), icon);
      this.confirming = { button, label, icon, iconOnly, timer: window.setTimeout(() => this.resetConfirm(), 4000) };
    });
    return button;
  }

  /** A Delete button: asks first, in a dialog listing everything that would go, then runs `run`. */
  private deleteButton(what: () => { docs: LibraryEntry[]; folders: Folder[] }, run: (before: Listed, items: { docs: LibraryEntry[]; folders: Folder[] }) => Promise<void>, icon?: string, iconOnly = false, label = t('panels.dashboard.delete')): HTMLButtonElement {
    const button = h('button', { class: 'wm-danger', attrs: { type: 'button' } });
    this.setLabel(button, label, icon, iconOnly);
    button.addEventListener('click', async () => {
      this.resetConfirm();
      const { docs, folders } = what();
      const lines = deletionList(this.folders, this.entries, folders, docs);
      if (!(await confirmDelete(deleteTitle(folders, docs, lines), lines))) return;
      // Gone from the screen at once; if it fails, the refresh below brings it back with the reason.
      const before = { folders: this.folders, entries: this.entries };
      // (A listing already on its way was asked for before the delete: the library drops it.)
      const left = withoutDeleted(before.folders, before.entries, folders, docs);
      this.library.update({ folders: left.folders, entries: left.entries });
      run(before, { docs, folders }).then(
        () => this.refresh(),
        (error) => {
          this.notice.textContent = t('panels.dashboard.failed', { reason: error instanceof Error ? error.message : String(error) });
          void this.refresh();
        },
      );
    });
    return button;
  }

  /** A button's text, with its icon in front when it has one. */
  private setLabel(button: HTMLButtonElement, label: string, icon?: string, iconOnly = false): void {
    if (iconOnly && icon) {
      button.replaceChildren(iconElement(icon));
      button.title = label;
      button.setAttribute('aria-label', label);
      return;
    }
    button.removeAttribute('title');
    button.removeAttribute('aria-label');
    button.replaceChildren(...(icon ? [iconElement(icon)] : []), h('span', { text: label }));
  }

  /** A card action shown as an icon, named by its tooltip and accessible label. */
  private iconButton(icon: string, label: string): HTMLButtonElement {
    const button = h('button', { class: 'wm-icon-action', attrs: { type: 'button', title: label, 'aria-label': label } });
    button.append(iconElement(icon));
    return button;
  }

  private resetConfirm(): void {
    if (!this.confirming) return;
    clearTimeout(this.confirming.timer);
    this.setLabel(this.confirming.button, this.confirming.label, this.confirming.icon, this.confirming.iconOnly);
    this.confirming = null;
  }
}
