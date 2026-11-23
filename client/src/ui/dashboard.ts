// The dashboard: every document at a glance, as a grid of first-page thumbnails. Signed in, that
// is the account's documents; signed out, the ones saved in this browser (sync.ts lists them). It
// is a plain DOM screen laid over the editor's canvas; File ▸ Open shows it, Esc or any open
// hides it.
//
// Nothing here is loaded before it is needed: what this browser has appears straight away, the
// rest of the account's documents once the catalogue arrives, and each thumbnail is fetched only
// when its card scrolls into view.

import { deleteSharedDocument, deleteSharedSubfolder, leaveSharedFolder, putSharedSubfolder, removeShare, renameCloudDocument, sharedFolderTree, type CloudDocument, type SharedFolder, type SharedFolderDocument, type SharedFolderTree } from '../cloud.ts';
import { canDrop, createFolder, moveEntries, outOfReach, removeFolderTree, updateFolders, withMoved, withoutDeleted, type Dragged } from '../folderOps.ts';
import { crossesEncryption, documentItems, folderItems as encryptionFolderItems, moveAcrossEncryption, showUnlock } from '../encryption/ui.ts';
import { isEncryptedFolder } from '../encryption/session.ts';
import { childFolders, deletionList, folderContents, folderOf, folderPath, isInside, itemsIn, outermost, type Folder } from '../folders.ts';
import { setDocumentDrag } from './documentDrag.ts';
import { warmOnHover } from './warmOnHover.ts';
import type { LibraryStore } from '../libraryStore.ts';
import { forgetSharedInCatalogue, type LibraryEntry } from '../sync.ts';
import type { User } from '../auth.ts';
import { formatSize, matchesSearch, relativeTime, syncBadge } from './dashboardFormat.ts';
import { t } from '../i18n/index.ts';
import { Thumbnails } from './dashboardThumbnails.ts';
import { h, isFileDrag, PADLOCK, PADLOCK_OPEN, smallIcon } from './dom.ts';
import { takeDropped, type Dropped } from '../storage/droppedFiles.ts';
import { fileIcon, setFileName, splitExtension } from './fileIcons.ts';
import { renamedFileName } from '../documentName.ts';
import { confirmDelete, deleteTitle } from './deleteDialog.ts';
import { pickFolder } from './folderPicker.ts';
import { ICONS, iconElement } from './icons.ts';
import { showPopupMenu, type PopupItem } from './popupMenu.ts';
import { onContextMenu } from './contextMenu.ts';
import { narrow } from './popup.ts';
import { chooseVaultFolders, type VaultChoice } from './vaultFoldersDialog.ts';
import { isTouchDevice, showInFileManagerLabel } from '../desktop/bridge.ts';
import { lastNewKind, newKindIconElement, newKindItems, newKindLabel, newMenuItems } from './newKinds.ts';
import type { DocumentKind } from './actions.ts';
import type { TrashActions } from './trashActions.ts';
import { trashKey, type TrashItem } from '../trash.ts';
import './dashboard.css';

const SIZE_KEY = 'golemdocs.dashboardIconSize';
const SIZE_MIN = 80;
const SIZE_MAX = 260;
const SIZE_DEFAULT = 120;
/** On a phone the default is smaller, so three cards fit across. */
const SIZE_DEFAULT_NARROW = 100;

/** What the dashboard asks of the application. */
export interface DashboardHost {
  /** Starts a blank document, to be filed in `folderId` (null: the top level) when it is first saved. */
  newDocument(folderId: string | null, docKind?: DocumentKind): void;
  /** The document open behind the dashboard (its ids in this browser and in the account), whose folder the dashboard starts in. */
  currentDocument(): { localId: string | null; cloudId: string | null };
  open(entry: LibraryEntry): void;
  /** Called as the dashboard opens: draws any thumbnail still waiting for a pause in typing (the open document's card shows it). Resolves when it is stored. */
  settleThumbnail?(): Promise<void>;
  /** The pointer is on this document: a chance to start fetching what opening it needs. */
  warm(entry: LibraryEntry): void;
  /** Asks for a file on this computer and opens it, to be filed in `folderId` when it is first saved. */
  importFile(folderId: string | null): void;
  importFolder(folderId: string | null): void;
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
  /** Gives a document a new file name (its extension kept); fails with why, if it could not. */
  rename(entry: LibraryEntry, name: string): Promise<void>;
  /** Opens a document someone else shared with the user. */
  openShared(doc: CloudDocument): void;
  /** Opens a document in a folder someone shared with the user: in the editor for an editor, in the viewer for a viewer. */
  openInSharedFolder(share: SharedFolder, doc: SharedFolderDocument): void;
  /** Starts a blank document in a folder shared with the user as an editor (`folderId`: the shared folder or one inside it). */
  newInSharedFolder(share: SharedFolder, folderId: string, docKind?: DocumentKind): void;
  /** Asks for files on this computer and adds them to a folder shared with the user as an editor. Resolves once they are in. */
  importIntoSharedFolder(share: SharedFolder, folderId: string): Promise<void>;
  /** Opens the sharing dialog for one of the user's own folders. */
  shareFolder?(folder: Folder): void;
  /** Whether Show in Finder applies (the desktop app keeps a vault folder here), and showing a document's file or a folder in it. */
  canShowInVault?(): boolean;
  showInVault?(item: { doc: LibraryEntry } | { folder: Folder }): void;
  /** In the desktop app: whether the vault keeps a copy of a folder shared with the user, and turning that on or off. */
  vaultCopy?: { get(share: SharedFolder): VaultChoice; set(share: SharedFolder, choice: VaultChoice): void };
  /** The trash, which Trash opens as a folder. */
  trash: TrashActions;
  /** The dashboard was closed without opening anything: give the editor back the keyboard. */
  closed(): void;
  /** The keys of the documents (library entries, and shared documents by id) with the search's words or #tags in them. */
  contentMatches?(query: string): Promise<ReadonlySet<string>>;
}

/** What is being dragged to a folder. */
// --- The screen -----------------------------------------------------------------------------

/** The folders and documents as listed before a delete took its items off the screen, which is what finding what is inside a folder needs. */
type Listed = { folders: Folder[]; entries: LibraryEntry[] };

/** A menu closed without moving the keyboard elsewhere (Escape, a click away) gives it back to where it was. */
function giveBack(to: Element | null): void {
  const at = document.activeElement;
  if ((!at || at === document.body) && to instanceof HTMLElement && to.isConnected) to.focus();
}

export class Dashboard {
  private readonly root: HTMLElement;
  private readonly search: HTMLInputElement;
  private contentKeys: ReadonlySet<string> = new Set();
  private contentFor = '';
  private contentTimer: number | undefined;
  private readonly notice: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly sharedTitle: HTMLElement;
  private readonly sharedGrid: HTMLElement;
  private readonly scroller: HTMLElement;
  private thumbnails!: Thumbnails;
  private readonly newFolderButton: HTMLButtonElement;
  /** New: makes a document of the type used last, whose picture it shows. */
  private readonly newButton: HTMLButtonElement;
  private readonly trashButton: HTMLButtonElement;
  private readonly emptyTrashButton: HTMLButtonElement;
  /** Looking in the trash rather than a folder. */
  private inTrash = false;
  /** Documents (`doc:<key>`) and folders (`folder:<id>`) ticked for a bulk Move or Delete. */
  private readonly selected = new Set<string>();
  /** Where a Shift-click range starts: the card ticked last. */
  private anchor: string | null = null;
  private readonly selectionBar: HTMLElement;
  private readonly selectionCount: HTMLElement;
  /** The folder being looked at (null: the top level). */
  private folderId: string | null = null;
  /** The folder (its id) or document (`doc:<key>`) whose name is being typed in place (a folder just made, or either being renamed). */
  private renaming: string | null = null;
  /** What has been typed in the name field so far (and where the caret is), kept when the cards are rebuilt under it. */
  private renameDraft: { id: string; value: string; start: number; end: number } | null = null;
  private dragged: Dragged | null = null;
  /** A listing came in during a drag: the cards are redrawn when it ends (redrawing the one being dragged would cancel the drag). */
  private redrawAfterDrag = false;
  /** While the cards are being replaced: the rename field losing its place isn't the user leaving it. */
  private rebuilding = false;
  private readonly crumbs: HTMLElement;
  /** Inside a folder someone shared with the user (docs/folder-sharing.md): the share, and the folder in it being looked at. */
  private sharedAt: { share: SharedFolder; folderId: string } | null = null;
  /** What is in the shared folder being looked at, once listed (for `sharedAt`'s share). */
  private sharedTree: SharedFolderTree | null = null;
  private readonly importButton: HTMLButtonElement;
  private readonly importFolderButton: HTMLButtonElement;
  private readonly newSplit: HTMLElement;
  /** Cards showing a "click again to confirm" button, and the timer that resets them. */
  private confirming: { button: HTMLButtonElement; label: string; icon?: string; iconOnly: boolean; timer: number } | null = null;

  /** `library`: the documents and folders, the same copy the Files Sidebar shows. */
  constructor(
    parent: HTMLElement,
    private readonly host: DashboardHost,
    private readonly library: LibraryStore,
  ) {
    host.trash.store.subscribe(() => {
      if (this.visible && this.inTrash && !this.dragged) this.render();
    });
    library.subscribe(() => {
      if (!this.visible) return;
      this.notice.textContent = library.problem ?? '';
      if (this.dragged) this.redrawAfterDrag = true;
      else this.render();
    });
    this.search = h('input', { class: 'wm-input wm-dash-search', attrs: { type: 'search', placeholder: t('panels.dashboard.search'), 'aria-label': t('panels.dashboard.search') } });
    this.notice = h('p', { class: 'wm-dash-notice', attrs: { role: 'status' } });
    this.grid = h('div', { class: 'wm-dash-grid' });
    this.crumbs = h('nav', { class: 'wm-dash-crumbs', attrs: { 'aria-label': t('panels.dashboard.location') } });
    const close = h('button', { class: 'wm-dash-close', text: '×', attrs: { type: 'button', 'aria-label': t('panels.dashboard.close'), title: t('panels.dashboard.close') } });
    close.addEventListener('click', () => this.dismiss());
    this.sharedTitle = h('h2', { class: 'wm-dash-section', text: t('panels.dashboard.sharedWithMe') });
    this.sharedGrid = h('div', { class: 'wm-dash-grid' });
    this.scroller = h('div', { class: 'wm-dash-scroll' }, this.notice, this.crumbs, this.grid, this.sharedTitle, this.sharedGrid);
    this.thumbnails = new Thumbnails(this.scroller);
    // Right click on the screen: a new document (of the type chosen), or an import, in the folder shown.
    this.scroller.addEventListener('contextmenu', (e) => {
      // A card's own menu was shown (cardMenu).
      if (e.defaultPrevented) return;
      if (e.target instanceof Element && e.target.closest('input, textarea')) return;
      e.preventDefault();
      const folderId = this.folderId;
      const before = document.activeElement;
      if (this.inTrash) {
        showPopupMenu([this.host.trash.emptyItem()], e.clientX, e.clientY, t('trash.title'), () => giveBack(before));
        return;
      }
      if (this.sharedAt) {
        const at = this.sharedAt;
        if (at.share.role !== 'editor') return;
        showPopupMenu(
          [...newMenuItems((kind) => this.newShared(at, kind)), 'separator', { label: t('panels.dashboard.import'), run: () => void this.importShared(at) }],
          e.clientX,
          e.clientY,
          t('panels.dashboard.newBlank'),
          () => giveBack(before),
        );
        return;
      }
      showPopupMenu(
        [
          ...newMenuItems((kind) => {
            this.hide();
            this.host.newDocument(folderId, kind);
          }),
          'separator',
          { label: t('panels.dashboard.import'), run: () => this.host.importFile(folderId) },
          { label: t('panels.dashboard.importFolder'), run: () => this.host.importFolder(folderId) },
          // As the Files pane's menu has them (filesPanel.ts, rootItems and folderItems).
          { label: t('panels.dashboard.newFolder'), run: () => this.newFolderButton.click() },
        ],
        e.clientX,
        e.clientY,
        t('panels.dashboard.newBlank'),
        () => giveBack(before),
      );
    });
    const action = (icon: string, label: string, aria: string, onClick: () => void): HTMLButtonElement => {
      const button = h('button', { class: 'wm-button wm-dash-action', attrs: { type: 'button', 'aria-label': aria } });
      this.setLabel(button, label, icon);
      button.addEventListener('click', onClick);
      return button;
    };
    const blank = action('new', t('panels.dashboard.newBlank'), t('panels.dashboard.newBlankLabel'), () => {
      if (this.sharedAt) return this.newShared(this.sharedAt);
      const folderId = this.folderId;
      this.hide();
      this.host.newDocument(folderId);
    });
    this.newButton = blank;
    this.showNewKind();
    // Stays up behind the file picker: hiding it would show the last open document.
    const importButton = action('import', t('panels.dashboard.import'), t('panels.dashboard.importLabel'), () => (this.sharedAt ? void this.importShared(this.sharedAt) : this.host.importFile(this.folderId)));
    const importFolderButton = action('import', t('panels.dashboard.importFolder'), t('panels.dashboard.importFolderLabel'), () => this.host.importFolder(this.folderId));
    this.importButton = importButton;
    this.importFolderButton = importFolderButton;
    this.newFolderButton = action('newFolder', t('panels.dashboard.newFolder'), t('panels.dashboard.newFolderLabel'), () => {
      if (this.sharedAt) return void this.newSharedFolder(this.sharedAt);
      // Not listed again afterwards: that would rebuild the name being typed.
      void this.run(async () => {
        const folder = await createFolder(this.host.account() !== null, t('panels.dashboard.newFolderName'), this.folderId);
        this.folders = [...this.folders, folder];
        this.renaming = folder.id;
      }, false);
    });
    this.trashButton = action('trash', t('trash.title'), t('trash.title'), () => this.showTrash());
    // A document or folder dragged onto Trash is deleted, as its Delete would (asking first).
    this.trashButton.addEventListener('dragover', (e) => {
      if (!this.dragged) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      this.trashButton.classList.add('wm-drop');
    });
    this.trashButton.addEventListener('dragleave', () => this.trashButton.classList.remove('wm-drop'));
    this.trashButton.addEventListener('drop', (e) => {
      this.trashButton.classList.remove('wm-drop');
      const item = this.dragged;
      this.dragged = null;
      if (!item) return;
      e.preventDefault();
      // Dragging one of the ticked ones takes them all, as Delete in the selection bar would.
      const key = item.kind === 'doc' ? `doc:${item.entry.key}` : `folder:${item.folder.id}`;
      const items = this.selected.has(key) ? this.selectedItems() : item.kind === 'doc' ? { docs: [item.entry], folders: [] } : { docs: [], folders: [item.folder] };
      void this.deleteItems(items, (before, chosen) => this.deleteSelection(before, chosen));
    });
    this.emptyTrashButton = action('trash', t('trash.emptyTrash'), t('trash.emptyTrash'), () => void this.host.trash.emptyAll());
    this.emptyTrashButton.classList.add('wm-danger');
    this.emptyTrashButton.hidden = true;
    const moveSelected = action('moveToFolder', t('panels.dashboard.move'), t('panels.dashboard.moveSelected'), () => this.moveSelection());
    const deleteSelected = this.deleteButton(() => this.selectedItems(), (before, items) => this.deleteSelection(before, items), 'trash');
    const clearSelection = action('close', t('panels.dashboard.clearSelection'), t('panels.dashboard.clearSelection'), () => this.setSelection([]));
    this.selectionCount = h('span', { class: 'wm-dash-selected', attrs: { role: 'status' } });
    this.selectionBar = h('div', { class: 'wm-dash-selection' }, this.selectionCount, moveSelected, deleteSelected, clearSelection);
    this.selectionBar.hidden = true;
    // The arrow beside New lists the types, last used first; New itself makes the one used last.
    const typeLabel = t('panels.dashboard.newBlank');
    const typeButton = h('button', { class: 'wm-button wm-dash-action wm-dash-new-arrow', title: typeLabel, attrs: { type: 'button', 'aria-label': typeLabel, 'aria-haspopup': 'true' } });
    typeButton.innerHTML = ICONS.dropdown;
    typeButton.addEventListener('click', () => {
      const box = typeButton.getBoundingClientRect();
      const folderId = this.folderId;
      const at = this.sharedAt;
      showPopupMenu(
        newKindItems((kind) => {
          if (at) return this.newShared(at, kind);
          this.hide();
          this.host.newDocument(folderId, kind);
        }),
        box.left,
        box.bottom,
        typeLabel,
        () => giveBack(typeButton),
      );
    });
    const newSplit = h('span', { class: 'wm-dash-split' }, blank, typeButton);
    this.newSplit = newSplit;
    const actions = h('div', { class: 'wm-dash-actions' }, newSplit, importButton, importFolderButton, this.newFolderButton, this.trashButton, this.emptyTrashButton, this.selectionBar);
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
    this.marqueeSelect(this.scroller);
    parent.append(this.root);

    this.search.addEventListener('input', () => {
      this.render();
      this.searchContent();
    });
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
    let size = narrow().matches ? SIZE_DEFAULT_NARROW : SIZE_DEFAULT;
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
    this.sharedAt = null;
    this.inTrash = false;
    this.renaming = null;
    this.selected.clear();
    // What the library has shows at once; the listing brings it up to date.
    this.folderId = this.currentFolder();
    this.notice.textContent = this.library.problem ?? '';
    this.showNewKind();
    this.render();
    // Once the menu or key that opened it is done with the focus (it hands it back as it closes).
    // Not on a phone or tablet, where focusing the search box pops up the on-screen keyboard.
    if (!isTouchDevice()) {
      setTimeout(() => {
        if (this.visible) this.search.focus({ preventScroll: true });
      }, 0);
    }
    await this.host.settleThumbnail?.();
    await this.refresh();
  }

  /** Opens Trash, as a folder of what was deleted (showing the dashboard first, if it isn't). */
  showTrash(): void {
    if (!this.visible) void this.show();
    this.search.value = '';
    this.inTrash = true;
    this.sharedAt = null;
    this.renaming = null;
    this.selected.clear();
    this.render();
    this.scroller.scrollTop = 0;
    void this.host.trash.store.refresh();
  }

  /** Back from Trash to the documents, at the top level. */
  private leaveTrash(): void {
    this.inTrash = false;
    this.folderId = null;
    this.search.value = '';
    this.render();
  }

  /** Shows on New the picture of the type it makes (the one used last), and names the type in its tooltip. */
  showNewKind(): void {
    const kind = lastNewKind();
    this.newButton.replaceChildren(newKindIconElement(kind, true), h('span', { text: t('panels.dashboard.newBlank') }));
    this.newButton.title = t('panels.dashboard.newKind', { type: newKindLabel(kind) });
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

  /** Asks the host which documents have the typed words or tags in them, and shows those too (after the typing stops). */
  private searchContent(): void {
    window.clearTimeout(this.contentTimer);
    const query = this.search.value.trim();
    if (!query || !this.host.contentMatches) {
      this.contentKeys = new Set();
      return;
    }
    this.contentTimer = window.setTimeout(() => {
      void this.host.contentMatches!(query).then(
        (keys) => {
          if (this.search.value.trim() !== query) return;
          this.contentKeys = new Set(keys);
          this.contentFor = query;
          if (this.visible) this.render();
        },
        () => {},
      );
    }, 200);
  }

  // --- Rendering ---------------------------------------------------------------------------

  private render(): void {
    this.redrawAfterDrag = false;
    const field = this.grid.querySelector<HTMLInputElement>('.wm-card-name-input');
    this.renameDraft =
      field && this.renaming ? { id: this.renaming, value: field.value, start: field.selectionStart ?? field.value.length, end: field.selectionEnd ?? field.value.length } : null;
    this.thumbnails.pause();
    // The cards are redrawn, so a pending "confirm" goes, and so must its timer (it would reset the next one early).
    this.resetConfirm();
    this.showActions();
    if (this.inTrash) return this.renderTrash();
    if (this.sharedAt) return this.renderSharedFolder();
    // Searching looks in every folder at once; otherwise this folder's own folders and documents.
    const searching = this.search.value.trim() !== '';
    if (this.folderId !== null && !this.folders.some((f) => f.id === this.folderId)) this.folderId = null;
    // What is in the documents is found a moment after the names are: `contentKeys` is for the text it was asked for.
    const inContent = (key: string) => this.contentFor === this.search.value.trim() && this.contentKeys.has(key);
    const shown = searching ? this.entries.filter((e) => matchesSearch(e, this.search.value) || inContent(e.key)) : itemsIn(this.entries, this.folders, this.folderId);
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
    const renameField = this.grid.querySelector<HTMLInputElement>('.wm-card-name-input');
    if (renameField) {
      renameField.focus({ preventScroll: false });
      const draft = this.renameDraft?.id === this.renaming ? this.renameDraft : null;
      if (draft) renameField.setSelectionRange(draft.start, draft.end);
      else renameField.select();
    }

    const sharedShown = this.shared.filter((d) => matchesSearch(d, this.search.value) || inContent(d.id));
    const foldersShown = this.library.sharedFolders.filter((f) => matchesSearch(f, this.search.value));
    this.sharedTitle.hidden = this.sharedGrid.hidden = sharedShown.length + foldersShown.length === 0;
    this.sharedGrid.replaceChildren(...foldersShown.map((f) => this.sharedFolderCard(f)), ...sharedShown.map((d) => this.sharedCard(d)));

    this.thumbnails.watch();
  }

  // --- Folders shared with the user (docs/folder-sharing.md) ------------------------------------

  /** Which action buttons show: everything for the user's own documents; inside a shared folder, what its role allows. */
  private showActions(): void {
    const at = this.sharedAt;
    const editor = !at || at.share.role === 'editor';
    this.newSplit.hidden = this.importButton.hidden = !editor || this.inTrash;
    this.importFolderButton.hidden = this.trashButton.hidden = !!at || this.inTrash;
    this.newFolderButton.hidden = !editor || this.inTrash || this.search.value.trim() !== '';
    const store = this.host.trash.store;
    this.emptyTrashButton.hidden = !this.inTrash;
    this.emptyTrashButton.disabled = !store.items.length || store.emptying !== null;
  }

  // --- Trash -------------------------------------------------------------------------------

  /** Trash: a card for each deleted document, newest first, under "Documents › Trash". */
  private renderTrash(): void {
    const trash = this.host.trash;
    const store = trash.store;
    const searching = this.search.value.trim() !== '';
    this.crumbs.hidden = false;
    const home = h('button', { class: 'wm-crumb', text: t('panels.dashboard.title'), attrs: { type: 'button' } });
    home.addEventListener('click', () => this.leaveTrash());
    this.crumbs.replaceChildren(home, h('span', { class: 'wm-crumb-sep', text: '›', attrs: { 'aria-hidden': 'true' } }), h('button', { class: 'wm-crumb', text: t('trash.title'), attrs: { type: 'button', 'aria-current': 'page', disabled: '' } }));
    this.notice.textContent = store.accountError !== null ? t('trash.accountFailed', { message: store.accountError }) : (this.library.problem ?? '');
    const shown = store.items.filter((item) => matchesSearch(item, this.search.value));
    const children: HTMLElement[] = [h('p', { class: 'wm-dash-empty', text: t('trash.note') })];
    if (!store.loaded) children.push(h('p', { class: 'wm-dash-empty', text: t('trash.loading') }));
    else if (!shown.length) children.push(h('p', { class: 'wm-dash-empty', text: searching ? t('panels.dashboard.noMatches') : t('trash.empty') }));
    children.push(...shown.map((item) => this.trashCard(item)));
    this.rebuilding = true;
    this.grid.replaceChildren(...children);
    this.rebuilding = false;
    this.sharedTitle.hidden = this.sharedGrid.hidden = true;
    this.thumbnails.watch();
  }

  /** A deleted document: open it (read-only), restore it, or delete it for good. The same commands as under Trash in the Files pane. */
  private trashCard(item: TrashItem): HTMLElement {
    const trash = this.host.trash;
    const art = h('div', { class: 'wm-thumb wm-trash-thumb' }, fileIcon(item.name));
    const open = h(
      'button',
      { class: 'wm-card-open', attrs: { type: 'button', 'aria-label': t('panels.dashboard.open', { name: item.name }) } },
      art,
      h('span', { class: 'wm-card-name', title: item.name }, fileIcon(item.name), setFileName(h('span', { class: 'wm-card-title' }), item.name)),
      h('span', { class: 'wm-card-meta', text: trash.meta(item) }),
    );
    open.addEventListener('click', () => trash.open(item));
    const badges = h('div', { class: 'wm-badges' }, h('span', { class: 'wm-badge', text: trash.source(item) }));
    const restore = this.iconButton('undo', t('trash.restore'));
    restore.addEventListener('click', () => void trash.restore(item));
    const forever = this.iconButton('trash', t('trash.deleteForever'));
    forever.addEventListener('click', () => void trash.deleteForever(item));
    const going = trash.store.going.has(trashKey(item));
    restore.disabled = forever.disabled = going;
    const card = h('article', { class: `wm-card${going ? ' wm-card-going' : ''}` }, open, badges, h('div', { class: 'wm-card-actions' }, restore, forever));
    this.cardMenu(card, () => trash.menu(item));
    return card;
  }

  /** A folder someone shared with the user: open it, or leave it. */
  private sharedFolderCard(share: SharedFolder): HTMLElement {
    const art = h('div', { class: 'wm-thumb wm-folder-art' }, h('div', { class: 'wm-folder-shape', attrs: { 'aria-hidden': 'true' } }));
    const by = share.owner.name ?? share.owner.email;
    const open = h(
      'button',
      { class: 'wm-card-open', attrs: { type: 'button', 'aria-label': t('panels.dashboard.openFolder', { name: share.name }) } },
      art,
      h('span', { class: 'wm-card-name', title: share.name }, h('span', { class: 'wm-card-title', text: share.name })),
      h('span', { class: 'wm-card-meta', text: by ? t('panels.dashboard.from', { name: by }) : '' }),
    );
    open.addEventListener('click', () => this.enterShared({ share, folderId: share.folderId }));
    const badges = h('div', { class: 'wm-badges' }, h('span', { class: 'wm-badge', text: share.role === 'viewer' ? t('panels.dashboard.viewOnly') : t('panels.dashboard.canEdit') }));
    const leave = this.confirmButton(
      t('panels.dashboard.leave'),
      async () => {
        await leaveSharedFolder(share);
        this.library.update({ sharedFolders: this.library.sharedFolders.filter((f) => f !== share) });
      },
      'leave',
      undefined,
      true,
    );
    const actions = h('div', { class: 'wm-card-actions' }, leave);
    const copy = this.host.vaultCopy;
    if (copy) {
      // What the vault folder keeps of it (under Shared/): a copy at all, and which of its folders. Named for the folder, for a screen reader.
      const vault = h('button', { class: 'wm-button', title: t('panels.dashboard.vaultNote'), attrs: { type: 'button', 'aria-label': t('panels.dashboard.vaultButtonOf', { name: share.name }) }, text: t('panels.dashboard.vaultButton') });
      vault.addEventListener('click', async () => {
        try {
          const tree = await sharedFolderTree(share);
          const choice = await chooseVaultFolders(share, tree, copy.get(share));
          if (choice) copy.set(share, choice);
        } catch (error) {
          this.notice.textContent = t('panels.dashboard.failed', { reason: error instanceof Error ? error.message : String(error) });
        }
      });
      actions.prepend(vault);
    }
    return h('article', { class: 'wm-card wm-folder' }, open, badges, actions);
  }

  /** Looks inside a shared folder (or a folder in it), listing what is there if it isn't yet. */
  private enterShared(at: { share: SharedFolder; folderId: string }): void {
    const same = this.sharedAt?.share === at.share;
    this.sharedAt = at;
    this.search.value = '';
    this.selected.clear();
    this.renaming = null;
    if (!same) this.sharedTree = null;
    this.render();
    this.scroller.scrollTop = 0;
    if (!same) void this.loadSharedTree();
  }

  /** Lists the shared folder being looked at again (after a change, or on entering it). */
  private async loadSharedTree(): Promise<void> {
    const at = this.sharedAt;
    if (!at) return;
    try {
      const tree = await sharedFolderTree(at.share);
      if (this.sharedAt?.share !== at.share) return;
      this.sharedTree = tree;
      // The folder looked at inside it may be gone: back to the top of the share.
      if (!tree.folders.some((f) => f.id === this.sharedAt!.folderId)) this.sharedAt = { share: at.share, folderId: at.share.folderId };
      this.notice.textContent = '';
    } catch (error) {
      if (this.sharedAt?.share !== at.share) return;
      // Gone (unshared, or the folder deleted): back to the user's own documents, saying why.
      this.sharedAt = null;
      this.notice.textContent = t('panels.dashboard.sharedFolderGone', { reason: (error as Error).message });
      void this.refresh();
    }
    if (this.visible) this.render();
  }

  /** "Documents › Projects › Notes" inside a shared folder: the first goes back to the user's own documents. */
  private renderSharedCrumbs(): void {
    const at = this.sharedAt!;
    this.crumbs.hidden = false;
    const folders = new Map((this.sharedTree?.folders ?? []).map((f) => [f.id, f]));
    const path: { id: string | null; name: string }[] = [];
    for (let id: string | null = at.folderId, depth = 0; id !== null && depth < 64; depth++) {
      const f = folders.get(id);
      path.unshift({ id, name: f?.name ?? at.share.name });
      id = f?.parentId ?? null;
    }
    const stops = [{ id: null as string | null, name: t('panels.dashboard.title') }, ...path];
    const parts: HTMLElement[] = [];
    stops.forEach((stop, i) => {
      if (i) parts.push(h('span', { class: 'wm-crumb-sep', text: '›', attrs: { 'aria-hidden': 'true' } }));
      const last = i === stops.length - 1;
      const crumb = h('button', { class: 'wm-crumb', text: stop.name, attrs: { type: 'button', ...(last ? { 'aria-current': 'page' } : {}) } });
      crumb.disabled = last;
      crumb.addEventListener('click', () => {
        if (stop.id === null) {
          this.sharedAt = null;
          this.sharedTree = null;
          this.folderId = null;
          this.render();
        } else this.enterShared({ share: at.share, folderId: stop.id });
      });
      parts.push(crumb);
    });
    this.crumbs.replaceChildren(...parts);
  }

  /** The cards inside a shared folder: its folders, then its documents. Nothing is dragged, selected or moved here. */
  private renderSharedFolder(): void {
    const at = this.sharedAt!;
    const tree = this.sharedTree;
    const searching = this.search.value.trim() !== '';
    this.renderSharedCrumbs();
    const children: HTMLElement[] = [];
    if (tree) {
      const folders = tree.folders.filter((f) => (searching ? f.parentId !== null && matchesSearch(f, this.search.value) : f.parentId === at.folderId));
      const docs = tree.documents.filter((d) => (searching ? matchesSearch(d, this.search.value) : d.folderId === at.folderId));
      children.push(...folders.map((f) => this.sharedSubfolderCard(at.share, f, tree)), ...docs.map((d) => this.sharedFolderDocCard(at.share, d)));
      if (!children.length) children.push(h('p', { class: 'wm-dash-empty', text: searching ? t('panels.dashboard.noMatches') : t('panels.dashboard.sharedFolderEmpty') }));
    }
    this.rebuilding = true;
    this.grid.replaceChildren(...children);
    this.rebuilding = false;
    const renameField = this.grid.querySelector<HTMLInputElement>('.wm-card-name-input');
    if (renameField) {
      renameField.focus();
      renameField.select();
    }
    this.sharedTitle.hidden = this.sharedGrid.hidden = true;
    this.thumbnails.watch();
  }

  /** A folder inside a shared folder: open it; rename or delete it if this user made it. */
  private sharedSubfolderCard(share: SharedFolder, folder: SharedFolderTree['folders'][number], tree: SharedFolderTree): HTMLElement {
    const art = h('div', { class: 'wm-thumb wm-folder-art' }, h('div', { class: 'wm-folder-shape', attrs: { 'aria-hidden': 'true' } }));
    const count = tree.documents.filter((d) => d.folderId === folder.id).length + tree.folders.filter((f) => f.parentId === folder.id).length;
    let open: HTMLElement;
    if (this.renaming === folder.id) {
      const input = this.nameField(folder.id, folder.name, t('panels.dashboard.folderName'), 255, (typed) => {
        const name = typed.trim();
        return name && name !== folder.name ? () => this.sharedChange(async () => void (await putSharedSubfolder(share, folder.id, name))) : null;
      });
      open = h('div', { class: 'wm-card-open' }, art, input);
    } else {
      open = h('button', { class: 'wm-card-open', attrs: { type: 'button', 'aria-label': t('panels.dashboard.openFolder', { name: folder.name }) } }, art, h('span', { class: 'wm-card-name', title: folder.name }, h('span', { class: 'wm-card-title', text: folder.name })), h('span', { class: 'wm-card-meta', text: t('panels.dashboard.items', { count }) }));
      open.addEventListener('click', () => this.enterShared({ share, folderId: folder.id }));
    }
    const actions = h('div', { class: 'wm-card-actions' });
    if (folder.createdByYou && share.role === 'editor') {
      const rename = this.iconButton('rename', t('panels.dashboard.rename'));
      rename.addEventListener('click', () => {
        this.renaming = folder.id;
        this.render();
      });
      actions.append(rename, this.confirmButton(t('panels.dashboard.deleteFolder'), () => this.sharedChange(() => deleteSharedSubfolder(share, folder.id)), 'trash', undefined, true));
    }
    return h('article', { class: 'wm-card wm-folder' }, open, actions);
  }

  /** A document in a shared folder: open it; rename or delete it if this user added it. */
  private sharedFolderDocCard(share: SharedFolder, doc: SharedFolderDocument): HTMLElement {
    const thumb = this.thumbnails.forShared(doc);
    const meta = [relativeTime(doc.updatedAt), formatSize(doc.size)].join(' · ');
    const id = `doc:${doc.id}`;
    let open: HTMLElement;
    if (this.renaming === id) {
      const input = this.nameField(id, splitExtension(doc.name)[0], t('chrome.title.label'), 120, (typed) => {
        const name = renamedFileName(doc.name, typed);
        return name ? () => this.sharedChange(async () => void (await renameCloudDocument(doc.id, name))) : null;
      });
      open = h('div', { class: 'wm-card-open' }, thumb, h('span', { class: 'wm-card-name' }, fileIcon(doc.name), input), h('span', { class: 'wm-card-meta', text: meta }));
    } else {
      open = h('button', { class: 'wm-card-open', attrs: { type: 'button', 'aria-label': t('panels.dashboard.open', { name: doc.name }) } }, thumb, h('span', { class: 'wm-card-name', title: doc.name }, fileIcon(doc.name), setFileName(h('span', { class: 'wm-card-title' }), doc.name)), h('span', { class: 'wm-card-meta', text: meta }));
      open.addEventListener('click', () => {
        this.hide();
        this.host.openInSharedFolder(share, doc);
      });
    }
    const badges = h('div', { class: 'wm-badges' });
    if (doc.createdByYou) badges.append(h('span', { class: 'wm-badge', text: t('panels.dashboard.addedByYou') }));
    const actions = h('div', { class: 'wm-card-actions' });
    if (doc.createdByYou && share.role === 'editor') {
      const rename = this.iconButton('rename', t('panels.dashboard.rename'));
      rename.addEventListener('click', () => {
        this.renaming = id;
        this.render();
      });
      actions.append(rename, this.confirmButton(t('panels.dashboard.delete'), () => this.sharedChange(() => deleteSharedDocument(doc.id)), 'trash', undefined, true));
    }
    return h('article', { class: 'wm-card' }, open, badges, actions);
  }

  /** Runs a change inside a shared folder, then lists it again (saying why, if it failed). */
  private async sharedChange(change: () => Promise<void>): Promise<void> {
    try {
      await change();
      this.notice.textContent = '';
    } catch (error) {
      this.notice.textContent = t('panels.dashboard.failed', { reason: error instanceof Error ? error.message : String(error) });
    }
    await this.loadSharedTree();
  }

  /** New, inside a shared folder: a blank document there. */
  private newShared(at: { share: SharedFolder; folderId: string }, kind?: DocumentKind): void {
    this.hide();
    this.host.newInSharedFolder(at.share, at.folderId, kind);
  }

  /** Import, inside a shared folder: files from this computer, added there. */
  private async importShared(at: { share: SharedFolder; folderId: string }): Promise<void> {
    await this.host.importIntoSharedFolder(at.share, at.folderId);
    if (this.sharedAt?.share === at.share) await this.loadSharedTree();
  }

  /** New Folder, inside a shared folder: made there at once and named in place. */
  private async newSharedFolder(at: { share: SharedFolder; folderId: string }): Promise<void> {
    const id = crypto.randomUUID();
    await this.sharedChange(async () => void (await putSharedSubfolder(at.share, id, t('panels.dashboard.newFolderName'), at.folderId)));
    if (this.sharedTree?.folders.some((f) => f.id === id)) {
      this.renaming = id;
      this.render();
    }
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
    const id = `doc:${entry.key}`;
    let open: HTMLElement;
    if (this.renaming === id) {
      // The name is typed without its extension, which stays (it decides how the document opens).
      const input = this.nameField(id, splitExtension(entry.name)[0], t('chrome.title.label'), 120, (typed) => {
        const name = renamedFileName(entry.name, typed);
        return name ? () => this.renameEntry(entry, name) : null;
      });
      open = h('div', { class: 'wm-card-open' }, thumb, h('span', { class: 'wm-card-name' }, fileIcon(entry.name), input), h('span', { class: 'wm-card-meta', text: meta }));
    } else {
      open = h('button', { class: 'wm-card-open', attrs: { type: 'button', 'aria-label': t('panels.dashboard.open', { name: entry.name }) } }, thumb, h('span', { class: 'wm-card-name', title: entry.name }, fileIcon(entry.name), setFileName(h('span', { class: 'wm-card-title' }), entry.name)), h('span', { class: 'wm-card-meta', text: meta }));
      warmOnHover(open, () => this.host.warm(entry));
      open.addEventListener('click', () => {
        this.hide();
        this.host.open(entry);
      });
    }

    const badges = h('div', { class: 'wm-badges' });
    // Audio or video in the vault too big for the account: opened, and shown in Finder, and nothing else (it is renamed, moved and deleted there).
    if (entry.vault) {
      badges.append(h('span', { class: 'wm-badge', text: t('media.vaultOnly'), title: t('media.vaultOnlyTip') }));
      const card = h('article', { class: 'wm-card' }, open, badges);
      this.cardMenu(card, () => [
        { label: t('panels.files.openItem'), run: () => open.click() },
        ...(this.host.canShowInVault?.() ? [{ label: showInFileManagerLabel(), run: () => this.host.showInVault?.({ doc: entry }) }] : []),
      ]);
      return card;
    }
    const sync = syncBadge(entry.state, this.host.account() !== null);
    if (sync) badges.append(h('span', { class: `wm-badge wm-badge-${sync.tone}`, text: sync.text }));
    // Encrypted (docs/encrypted-folders.md): a padlock, shut while locked (when its name says so too), open while unlocked.
    if (entry.encrypted) badges.append(smallIcon('wm-folder-lock wm-doc-lock', entry.locked ? PADLOCK : PADLOCK_OPEN));

    const remove = this.deleteButton(() => ({ docs: [entry], folders: [] }), () => this.host.delete([entry]), 'trash', true);
    const actions = h('div', { class: 'wm-card-actions' }, remove);
    let share: HTMLButtonElement | null = null;
    if (entry.cloud && !entry.encrypted) {
      share = this.iconButton('share', t('panels.dashboard.share'));
      share.addEventListener('click', () => this.host.share(entry.cloud!.id, entry.cloud!.name));
      actions.prepend(share);
    }
    const move = this.iconButton('moveToFolder', t('panels.dashboard.move'));
    move.addEventListener('click', () => this.pickFolder(t('panels.dashboard.moveTitle', { name: entry.name }), (id) => outOfReach(this.folders, { kind: 'doc', entry }, id), folderOf(entry, this.folders), (to) => this.relocate({ kind: 'doc', entry }, to)));
    actions.prepend(move);
    const rename = this.iconButton('rename', t('panels.dashboard.rename'));
    rename.addEventListener('click', () => {
      this.renaming = id;
      this.render();
    });
    if (!entry.locked) actions.prepend(rename);
    const card = h('article', { class: 'wm-card' }, open, badges, actions);
    // The same commands, in the same order, as a document's menu in the Files pane (filesPanel.ts, fileItems).
    this.cardMenu(card, () => [
      { label: t('panels.files.openItem'), run: () => open.click() },
      ...(this.host.canShowInVault?.() ? [{ label: showInFileManagerLabel(), run: () => this.host.showInVault?.({ doc: entry }) }] : []),
      ...(share ? [{ label: t('panels.dashboard.share'), run: () => share!.click() }] : []),
      ...(entry.locked ? [] : [{ label: t('panels.dashboard.rename'), run: () => rename.click() }]),
      { label: t('panels.dashboard.move'), run: () => move.click() },
      // Encrypt… or Decrypt… (a locked document opens by being unlocked, so Open stands for Unlock…).
      ...(entry.locked ? [] : documentItems(entry)),
      { label: t('panels.dashboard.delete'), run: () => remove.click() },
    ]);
    this.makeDraggable(card, { kind: 'doc', entry });
    this.makeSelectable(card, `doc:${entry.key}`, entry.name);
    return card;
  }

  /** A folder: open it, rename it, move it, or delete it (with what is in it). */
  private folderCard(folder: Folder): HTMLElement {
    // The folder's first few documents show through it as small pages.
    const minis = itemsIn(this.entries, this.folders, folder.id)
      .slice(0, 4)
      .map((entry) => this.thumbnails.forEntry(entry, `mini:${entry.key}`, 'wm-thumb wm-folder-mini'));
    const art = h('div', { class: 'wm-thumb wm-folder-art' }, h('div', { class: 'wm-folder-shape', attrs: { 'aria-hidden': 'true' } }, ...minis, ...(folder.encrypted ? [smallIcon('wm-folder-lock', folder.locked ? PADLOCK : PADLOCK_OPEN)] : [])));
    let open: HTMLElement;
    if (this.renaming === folder.id) {
      const input = this.nameField(folder.id, folder.name, t('panels.dashboard.folderName'), 255, (typed) => {
        const name = typed.trim();
        return name && name !== folder.name ? () => this.changeFolders([{ folder, name }]) : null;
      });
      open = h('div', { class: 'wm-card-open' }, art, input);
    } else {
      const count = itemsIn(this.entries, this.folders, folder.id).length + childFolders(this.folders, folder.id).length;
      open = h('button', { class: 'wm-card-open', attrs: { type: 'button', 'aria-label': t('panels.dashboard.openFolder', { name: folder.name }) } }, art, h('span', { class: 'wm-card-name', title: folder.name }, h('span', { class: 'wm-card-title', text: folder.name })), h('span', { class: 'wm-card-meta', text: t('panels.dashboard.items', { count }) }));
      open.addEventListener('click', () => {
        // A locked encrypted folder opens by being unlocked (docs/encrypted-folders.md).
        if (folder.locked) return void showUnlock();
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
      this.pickFolder(t('panels.dashboard.moveTitle', { name: folder.name }), (id) => isInside(this.folders, id, folder.id) || outOfReach(this.folders, { kind: 'folder', folder }, id), folder.parentId, (to) => this.relocate({ kind: 'folder', folder }, to)),
    );
    const remove = this.deleteButton(() => ({ docs: [], folders: [folder] }), (before) => this.deleteFolderTrees(before, [folder]), 'trash', true, t('panels.dashboard.deleteFolder'));
    // A locked folder inside an encrypted one (its name sealed) can only be unlocked or deleted.
    const sealedAway = !!folder.locked && isEncryptedFolder(folder.parentId);
    const actions = h('div', { class: 'wm-card-actions' }, ...(sealedAway ? [] : [rename, move]), remove);
    // A folder in the account can be shared, with what is in it (docs/folder-sharing.md); an encrypted one never is.
    let share: HTMLButtonElement | null = null;
    if (this.host.shareFolder && this.host.account() && !folder.encrypted) {
      share = this.iconButton('share', t('panels.dashboard.shareFolder'));
      share.addEventListener('click', () => this.host.shareFolder!(folder));
      actions.prepend(share);
    }
    const card = h('article', { class: 'wm-card wm-folder' }, open, actions);
    // The same commands, in the same order, as a folder's menu in the Files pane (filesPanel.ts, folderItems).
    const deleteFolder: PopupItem = { label: t('panels.dashboard.deleteFolder'), run: () => remove.click() };
    this.cardMenu(card, () => sealedAway ? [...encryptionFolderItems(folder), deleteFolder] : [
      { label: t('panels.files.openFolder'), run: () => open.click() },
      ...(this.host.canShowInVault?.() && !folder.encrypted ? [{ label: showInFileManagerLabel(), run: () => this.host.showInVault?.({ folder }) }] : []),
      ...(share ? [{ label: t('panels.dashboard.share'), run: () => share!.click() }] : []),
      { label: t('panels.dashboard.rename'), run: () => rename.click() },
      { label: t('panels.dashboard.move'), run: () => move.click() },
      ...encryptionFolderItems(folder),
      deleteFolder,
      'separator',
      ...newMenuItems((kind) => {
        this.hide();
        this.host.newDocument(folder.id, kind);
      }),
      'separator',
      { label: t('panels.dashboard.import'), run: () => this.host.importFile(folder.id) },
      { label: t('panels.dashboard.importFolder'), run: () => this.host.importFolder(folder.id) },
      {
        label: t('panels.dashboard.newFolder'),
        run: () =>
          void this.run(async () => {
            const made = await createFolder(this.host.account() !== null, t('panels.dashboard.newFolderName'), folder.id);
            this.folders = [...this.folders, made];
            this.search.value = '';
            this.folderId = folder.id;
            this.selected.clear();
            this.renaming = made.id;
          }, false),
      },
    ]);
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

  /** Dragging a box on the background ticks every card it touches (Ctrl/Cmd/Shift adds to what is ticked already). */
  private marqueeSelect(scroller: HTMLElement): void {
    scroller.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.pointerType !== 'mouse' || !(e.target instanceof Element)) return;
      if (e.target.closest('[data-select], button, input, a, select, textarea, .wm-dash-crumbs')) return;
      // Not on the scroll bar.
      if (e.clientX >= scroller.getBoundingClientRect().left + scroller.clientWidth) return;
      const bounds = (): DOMRect => scroller.getBoundingClientRect();
      const point = (ev: PointerEvent): { x: number; y: number } => ({ x: ev.clientX - bounds().left + scroller.scrollLeft, y: ev.clientY - bounds().top + scroller.scrollTop });
      const start = point(e);
      const base = e.ctrlKey || e.metaKey || e.shiftKey ? new Set(this.selected) : new Set<string>();
      let box: HTMLElement | null = null;
      let last = e;
      const update = (): void => {
        const now = point(last);
        const left = Math.min(start.x, now.x);
        const top = Math.min(start.y, now.y);
        const width = Math.abs(now.x - start.x);
        const height = Math.abs(now.y - start.y);
        if (!box) {
          if (width < 4 && height < 4) return;
          box = h('div', { class: 'wm-dash-marquee' });
          scroller.append(box);
        }
        Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
        const keys = new Set(base);
        for (const card of this.grid.querySelectorAll<HTMLElement>('[data-select]')) {
          const r = card.getBoundingClientRect();
          const x = r.left - bounds().left + scroller.scrollLeft;
          const y = r.top - bounds().top + scroller.scrollTop;
          if (x < left + width && x + r.width > left && y < top + height && y + r.height > top) keys.add(card.dataset.select!);
        }
        this.selected.clear();
        for (const key of keys) this.selected.add(key);
        this.syncSelection();
      };
      // Near the top or bottom edge the list scrolls under the box.
      const scroll = window.setInterval(() => {
        const r = bounds();
        const dy = last.clientY < r.top + 30 ? -16 : last.clientY > r.bottom - 30 ? 16 : 0;
        if (dy) {
          scroller.scrollTop += dy;
          update();
        }
      }, 30);
      const move = (ev: PointerEvent): void => {
        last = ev;
        update();
      };
      const end = (): void => {
        window.clearInterval(scroll);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        if (box) {
          box.remove();
          // The click that ends a drag must not also clear the selection.
          const swallow = (ev: Event): void => ev.stopPropagation();
          scroller.addEventListener('click', swallow, { capture: true, once: true });
          window.setTimeout(() => scroller.removeEventListener('click', swallow, true), 0);
        } else if (!base.size && this.selected.size) this.setSelection([]);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
      e.preventDefault();
    });
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
    const excluded = (id: string | null) =>
      folders.some((f) => isInside(this.folders, id, f.id) || outOfReach(this.folders, { kind: 'folder', folder: f }, id)) || docs.some((entry) => outOfReach(this.folders, { kind: 'doc', entry }, id));
    this.pickFolder(t('panels.dashboard.moveSelectedTitle', { count }), excluded, undefined, async (to) => {
      // Across the edge of an encrypted folder, each goes on its own, encrypted or decrypted (asked) on the way.
      const items: Dragged[] = [...docs.map((entry) => ({ kind: 'doc' as const, entry })), ...folders.map((folder) => ({ kind: 'folder' as const, folder }))];
      if (crossesEncryption(items, to)) {
        for (const item of items) if (item.kind === 'doc' ? folderOf(item.entry, this.folders) !== to : item.folder.parentId !== to) await this.relocate(item, to);
        this.selected.clear();
        return;
      }
      return this.run(async () => {
        await this.relocateEntries(docs.filter((entry) => folderOf(entry, this.folders) !== to), to);
        await this.changeFolders(folders.filter((folder) => folder.parentId !== to).map((folder) => ({ folder, parentId: to })));
        this.selected.clear();
      });
    });
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
    if (this.sharedAt) return this.renderSharedCrumbs();
    this.crumbs.hidden = searching || this.folderId === null;
    // Emptied, not only hidden: a folder's name must not stay in the page once it is gone (or locked: docs/encrypted-folders.md).
    if (this.crumbs.hidden) return void this.crumbs.replaceChildren();
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

  /**
   * The field a folder's or document's name is typed in, on its card. Enter or leaving it keeps the name, Escape doesn't;
   * `change` says what keeping `typed` does (null: nothing, as when it is empty or the same).
   */
  private nameField(id: string, value: string, label: string, maxLength: number, change: (typed: string) => (() => Promise<void>) | null): HTMLInputElement {
    const draft = this.renameDraft?.id === id ? this.renameDraft.value : null;
    const input = h('input', { class: 'wm-card-name-input', attrs: { type: 'text', value: draft ?? value, 'aria-label': label, maxlength: String(maxLength) } });
    let finished = false;
    const finish = (save: boolean) => {
      if (finished) return;
      finished = true;
      this.renaming = null;
      const run = save ? change(input.value) : null;
      if (run) void this.run(run);
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
    return input;
  }

  /** Renames a document, showing its new name at once; if saving fails, the lists fetched again put the old one back. */
  private async renameEntry(entry: LibraryEntry, name: string): Promise<void> {
    this.entries = this.entries.map((e) => (e.key === entry.key ? { ...e, name } : e));
    this.render();
    await this.host.rename(entry, name);
  }

  private relocate(item: Dragged, to: string | null): Promise<void> {
    // Into an encrypted folder, what isn't encrypted is encrypted first; out of one, it is decrypted, after asking (docs/encrypted-folders.md).
    return moveAcrossEncryption(item, to, () =>
      this.run(item.kind === 'doc' ? () => this.relocateEntries([item.entry], to) : () => this.changeFolders([{ folder: item.folder, parentId: to }])),
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
    // WebKit (Safari, the desktop app) starts no drag from a button inside a draggable card: the button has to be draggable itself.
    const open = el.querySelector<HTMLElement>(':scope > button.wm-card-open');
    if (open) open.draggable = true;
    el.addEventListener('dragstart', (e) => {
      this.dragged = item;
      el.classList.add('wm-dragging');
      if (e.dataTransfer) {
        if (item.kind === 'doc') setDocumentDrag(e.dataTransfer, item.entry.key, item.entry.name);
        else {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', item.folder.name);
        }
      }
    });
    el.addEventListener('dragend', () => {
      this.dragged = null;
      el.classList.remove('wm-dragging');
      if (this.redrawAfterDrag && this.visible) this.render();
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

  private pickFolder(title: string, excluded: (id: string | null) => boolean, current: string | null | undefined, pick: (id: string | null) => void): void {
    pickFolder(this.folders, title, excluded, current, pick);
  }

  /** A button that needs a second click, within a few seconds, to do something that can't be undone. */
  private confirmButton(label: string, run: () => Promise<void>, icon?: string, confirmLabel?: string, iconOnly = false): HTMLButtonElement {
    const button = h('button', { class: 'wm-button wm-danger', attrs: { type: 'button' } });
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
    const button = h('button', { class: 'wm-button wm-danger', attrs: { type: 'button' } });
    this.setLabel(button, label, icon, iconOnly);
    button.addEventListener('click', () => {
      this.resetConfirm();
      void this.deleteItems(what(), run);
    });
    return button;
  }

  /** Asks, in a dialog listing all that would go, whether to delete these; if so, takes them off the screen and runs `run`. */
  private async deleteItems({ docs, folders }: { docs: LibraryEntry[]; folders: Folder[] }, run: (before: Listed, items: { docs: LibraryEntry[]; folders: Folder[] }) => Promise<void>): Promise<void> {
    const lines = deletionList(this.folders, this.entries, folders, docs);
    if (!(await confirmDelete(deleteTitle(folders, docs, lines), lines))) return;
    // Gone from the screen at once; if it fails, the refresh below brings it back with the reason.
    const before = { folders: this.folders, entries: this.entries };
    // (A listing already on its way was asked for before the delete: the library drops it.)
    const left = withoutDeleted(before.folders, before.entries, folders, docs);
    this.library.update({ folders: left.folders, entries: left.entries });
    await run(before, { docs, folders }).then(
      () => this.refresh(),
      (error) => {
        this.notice.textContent = t('panels.dashboard.failed', { reason: error instanceof Error ? error.message : String(error) });
        void this.refresh();
      },
    );
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

  /** A right click (or Shift+F10, or a long press) on a card: its commands as a menu, so they are reachable without the small icons. */
  private cardMenu(card: HTMLElement, items: () => PopupItem[]): void {
    onContextMenu(card, (e) => {
      // A name being typed keeps the browser's own menu (copy, paste).
      if (e.target instanceof Element && e.target.closest('input, textarea')) return false;
      const before = document.activeElement;
      showPopupMenu(items(), e.clientX, e.clientY, t('panels.files.label'), () => giveBack(before));
    });
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
