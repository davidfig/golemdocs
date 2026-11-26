// The files sidebar (View › Files Sidebar): the account's folders and documents as a tree to the
// left of the document, so another document is one click away without the dashboard. Folders open
// and close; a document opens in the editor. It lists what the dashboard does (see sync.ts).
// Trash is pinned below the tree, always in view: a document or folder dragged onto it is deleted,
// and opening it shows what was deleted in place of the tree (trashActions.ts), with a way back.

import { takeDropped, type Dropped } from '../storage/droppedFiles.ts';
import { warmOnHover } from './warmOnHover.ts';
import { canDrop, createFolder, moveEntries, outOfReach, removeFolderTree, updateFolder, withMoved, withoutDeleted, type Dragged } from '../folderOps.ts';
import { documentItems, folderItems as encryptionFolderItems, moveAcrossEncryption, showUnlock } from '../encryption/ui.ts';
import { isEncryptedFolder } from '../encryption/session.ts';
import { deletionList, folderOf, isInside, treeRows, type Folder, type TreeRow } from '../folders.ts';
import { t } from '../i18n/index.ts';
import type { LibraryStore } from '../libraryStore.ts';
import type { LibraryEntry } from '../sync.ts';
import type { User } from '../auth.ts';
import { chevronIcon, CLOSE_ICON, h, iconButton, isFileDrag, PADLOCK, PADLOCK_OPEN, smallIcon, toggleClass } from './dom.ts';
import { setDocumentDrag } from './documentDrag.ts';
import { fileIcon, setFileName, splitExtension } from './fileIcons.ts';
import { renamedFileName } from '../documentName.ts';
import { confirmDelete, deleteTitle } from './deleteDialog.ts';
import { pickFolder } from './folderPicker.ts';
import { showPopupMenu, type PopupItem } from './popupMenu.ts';
import { onContextMenu } from './contextMenu.ts';
import { showInFileManagerLabel } from '../desktop/bridge.ts';
import { newMenuItems } from './newKinds.ts';
import type { DocumentKind } from './actions.ts';
import { makeResizable } from './sidebarResize.ts';
import { parseFilesView, ScrollRestore, type FilesView } from './scrollRestore.ts';
import { iconElement } from './icons.ts';
import type { TrashActions } from './trashActions.ts';
import { trashKey, type TrashItem } from '../trash.ts';
import './fileRows.css';
import './filesPanel.css';

export interface FilesPanelHost {
  open(entry: LibraryEntry): void;
  /** The pointer is on this document: a chance to start fetching what opening it needs. */
  warm(entry: LibraryEntry): void;
  /** Starts a blank document, to be filed in `folderId` (null: the top level) when it is first saved. */
  newDocument(folderId: string | null, docKind?: DocumentKind): void;
  /** Asks for a file on this computer and opens it, to be filed in `folderId` when it is first saved. */
  importFile(folderId: string | null): void;
  /** Asks for a folder on this computer and imports its documents, filed in `folderId`. */
  importFolder(folderId: string | null): void;
  /** Opens a file dropped from the computer, to be filed in `folderId` (null: the top level) when it is first saved. */
  /** Opens a dropped file, or imports several (or a folder), filed in `folderId`. */
  dropFile(drop: Dropped, folderId: string | null): void;
  /** Deletes the document everywhere: from the account and from this browser. */
  delete(entries: LibraryEntry[], folderIds?: string[]): Promise<void>;
  /** Opens the sharing dialog for a cloud document the user owns. */
  share(cloudId: string, name: string): void;
  /** Opens the sharing dialog for a folder of the account, with what is in it (docs/folder-sharing.md). */
  shareFolder?(folder: Folder): void;
  /** Whether Show in Finder applies (the desktop app keeps a vault folder here), and showing a document's file or a folder in it. */
  canShowInVault?(): boolean;
  showInVault?(item: { doc: LibraryEntry } | { folder: Folder }): void;
  /** Gives a document a new file name (its extension kept); fails with why, if it could not. */
  rename(entry: LibraryEntry, name: string): Promise<void>;
  account(): User | null;
  signedIn(): User | null;
  /** The open document's ids, to mark it. */
  current(): { localId: string | null; cloudId: string | null };
  /** The trash, shown as the tree's last entry. */
  trash: TrashActions;
  close(): void;
  focusEditor(): void;
}

/** How long to wait after a change before listing again, so a run of saves is one listing. */
/** What is being dragged onto a folder. */
/** Folders left open, kept in this browser. */
const OPEN_KEY = 'word.filesOpen';
/** Whether Trash was showing and how far the documents and Trash were scrolled, kept in this browser. */
const VIEW_KEY = 'word.filesView';

/** The padlock of an encrypted folder or document: shut while locked, open while unlocked (none for anything else). */
function lockOf(item: { encrypted?: boolean; locked?: boolean }): HTMLElement[] {
  if (!item.encrypted) return [];
  return [smallIcon(item.locked ? 'wm-files-lock' : 'wm-files-lock wm-files-unlocked', item.locked ? PADLOCK : PADLOCK_OPEN)];
}

export class FilesPanel {
  readonly el = h('aside', { class: 'wm-files', attrs: { 'aria-label': t('panels.files.label') } });
  private readonly tree = h('div', { class: 'wm-files-tree', attrs: { role: 'tree', 'aria-label': t('panels.files.label') } });
  private readonly empty = h('p', { class: 'wm-files-empty', text: t('panels.files.empty') });
  private readonly notice = h('p', { class: 'wm-files-notice', attrs: { role: 'status' } });
  private readonly title = h('h2', { text: t('panels.files.label') });
  /** Back from Trash to the documents. */
  private readonly back = iconButton('wm-files-close', 'M7.5 2L3.5 6l4 4', t('panels.files.backToFiles'));
  private readonly collapse = iconButton('wm-files-close', 'M4 1.5H10.5V8M1.5 4H8V10.5H1.5ZM3.5 7.25H6', t('panels.files.collapseAll'));
  /** Trash, below the tree. */
  private readonly trashEntry = h('button', { class: 'wm-files-trash-entry', attrs: { type: 'button' }, title: t('trash.note') }, iconElement('trash'), h('span', { class: 'wm-files-name', text: t('trash.title') }));
  /** What was deleted, shown in place of the tree while Trash is open. */
  private readonly trashList = h('div', { class: 'wm-files-trash-list', attrs: { role: 'tree', 'aria-label': t('trash.title') } });
  private readonly trashNote = h('p', { class: 'wm-files-empty' });
  private readonly emptyTrash = h('button', { class: 'wm-button wm-danger', text: t('trash.emptyTrash'), attrs: { type: 'button' } });
  private readonly trashView = h('div', { class: 'wm-files-trash-view' }, this.trashNote, this.trashList, h('div', { class: 'wm-files-trash-actions' }, this.emptyTrash));
  /** Looking in Trash rather than at the documents. */
  private inTrash = false;
  /** Trash was just opened before it was listed: the keyboard goes to its first document once there is one. */
  private focusTrash = false;
  /** The folder (its id) or document (`doc:<key>`) being renamed in place. */
  private renaming: string | null = null;
  /** What has been typed in the name field so far (and where the caret is), kept when the rows are rebuilt under it. */
  private renameDraft: { id: string; value: string; start: number; end: number } | null = null;
  private dragged: Dragged | null = null;
  private readonly expanded = new Set<string>();
  /** The open document the tree was last opened up to, so a folder closed afterwards stays closed. */
  private revealed = '';
  /** The row Tab goes to in the tree (one row at a time is in the tab order): the last one focused. */
  private tabStop: string | null = null;
  /** Where the documents and Trash were scrolled to before the page was loaded, until they are put back there. */
  private treeRestore = new ScrollRestore(null);
  private trashRestore = new ScrollRestore(null);

  /** `library`: the documents and folders, the same copy the Documents screen shows. */
  constructor(
    parent: HTMLElement,
    private readonly host: FilesPanelHost,
    private readonly library: LibraryStore,
  ) {
    library.subscribe(() => {
      if (!this.visible) return;
      this.render();
      this.reveal();
    });
    host.trash.store.subscribe(() => {
      if (this.visible) this.render();
    });
    this.el.hidden = true;
    try {
      for (const id of JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]')) if (typeof id === 'string') this.expanded.add(id);
    } catch {
      // Storage unavailable: the folders start closed.
    }
    this.inTrash = this.loadView().trash;
    // The collapse button is a stacked box with a minus: the usual sign for closing every folder in a tree.
    const close = iconButton('wm-files-close', CLOSE_ICON, t('panels.files.close'));
    close.addEventListener('click', () => host.close());
    this.collapse.addEventListener('click', () => this.collapseAll());
    this.back.addEventListener('click', () => this.leaveTrash());
    this.back.hidden = true;
    this.trashView.hidden = true;
    this.trashEntry.addEventListener('click', () => this.enterTrash());
    onContextMenu(this.trashEntry, (e) => this.menuAt(e.clientX, e.clientY, [{ label: t('panels.files.openItem'), run: () => this.enterTrash() }, this.host.trash.emptyItem()], this.trashEntry));
    this.makeTrashTarget(this.trashEntry);
    this.emptyTrash.addEventListener('click', () => void this.host.trash.emptyAll());
    this.el.append(h('header', { class: 'wm-files-bar' }, this.back, this.title, this.collapse, close), this.notice, this.empty, this.tree, this.trashView, this.trashEntry);
    this.notice.hidden = true;
    // Right click, or a long press on a touch screen.
    onContextMenu(this.el, (e) => {
      if ((e.target as HTMLElement).closest('.wm-files-row, .wm-files-trash-entry, input, button')) return false;
      this.menuAt(e.clientX, e.clientY, this.inTrash ? [this.host.trash.emptyItem()] : this.rootItems());
    });
    this.makeDropTarget(this.tree, null);
    // Keys typed here stay here: the document's handlers listen on the window.
    this.el.addEventListener('keydown', (e) => this.key(e));
    for (const list of [this.tree, this.trashList]) {
      list.addEventListener('focusin', (e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>('.wm-files-row');
        if (row?.dataset.row) this.setTabStop(row);
      });
    }
    for (const [list, restore] of [
      [this.tree, () => this.treeRestore],
      [this.trashList, () => this.trashRestore],
    ] as const) {
      // Scrolling by the person (not the rows being drawn, or the list being put back) is kept for the next load.
      for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) list.addEventListener(type, () => restore().cancel(), { passive: true });
      list.addEventListener('scroll', () => {
        if (!restore().pending && this.visible) this.saveView();
      });
    }
    parent.append(this.el);
    makeResizable(this.el, { key: 'word.filesWidth', min: 140, max: 480, initial: 200 });
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  setVisible(visible: boolean): void {
    if (this.el.hidden === !visible) return;
    this.el.hidden = !visible;
    if (visible) {
      this.revealed = '';
      // A hidden list forgets how far it was scrolled: it goes back to where it was.
      this.loadView();
      // What the library has shows at once; the listing brings it up to date.
      this.render();
      this.reveal();
      void this.refresh();
      if (this.inTrash) void this.host.trash.store.refresh();
    }
  }

  /** File › Trash with the sidebar showing: opens Trash there. */
  showTrash(): void {
    this.enterTrash();
  }

  /** Shows what was deleted in place of the tree, with the keyboard on the first of it (or on the way back, if there is none). */
  private enterTrash(): void {
    this.inTrash = true;
    this.saveView();
    this.render();
    void this.host.trash.store.refresh();
    const first = this.trashList.querySelector<HTMLElement>('.wm-files-row');
    (first ?? this.back).focus();
    this.focusTrash = !first && !this.host.trash.store.loaded;
  }

  /** Back to the documents, with the keyboard on Trash. */
  private leaveTrash(): void {
    this.inTrash = false;
    this.focusTrash = false;
    this.saveView();
    this.render();
    this.trashEntry.focus();
  }

  /** Lists everything again. */
  refresh(): Promise<void> {
    return this.library.refresh();
  }

  /** The documents and folders, as the library has them; a change set here shows wherever the library does. */
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

  /** Marks the open document again (another was opened, or it was just saved for the first time). */
  mark(): void {
    if (!this.visible) return;
    const here = this.host.current();
    // Found once, not once per row: this runs whenever saving's progress changes, and a big import
    // makes for thousands of rows.
    const entry = this.entries.find((e) => (here.localId !== null && e.local?.id === here.localId) || (here.cloudId !== null && e.cloud?.id === here.cloudId));
    const row = entry ? `d:${entry.key}` : null;
    for (const el of this.tree.querySelectorAll<HTMLElement>('.wm-files-current')) {
      if (el.dataset.row === row) continue;
      el.classList.remove('wm-files-current');
      el.removeAttribute('aria-current');
    }
    const el = row ? this.tree.querySelector<HTMLElement>(`[data-row="${CSS.escape(row)}"]`) : null;
    if (el) {
      toggleClass(el, 'wm-files-current', true);
      el.setAttribute('aria-current', 'true');
    }
    this.reveal();
  }

  /** Opens the folders the open document is in and scrolls to it, once for each document that is opened. */
  private reveal(): void {
    const here = this.host.current();
    const key = `${here.localId}|${here.cloudId}`;
    if (key === this.revealed) return;
    const entry = this.entries.find((e) => (here.localId !== null && e.local?.id === here.localId) || (here.cloudId !== null && e.cloud?.id === here.cloudId));
    if (!entry) return; // not listed yet: tried again when it is
    this.revealed = key;
    const opened: string[] = [];
    for (let id = folderOf(entry, this.folders); id !== null && !opened.includes(id); id = this.folders.find((f) => f.id === id)?.parentId ?? null) opened.push(id);
    const closed = opened.filter((id) => !this.expanded.has(id));
    if (closed.length) {
      for (const id of closed) this.expanded.add(id);
      this.saveExpanded();
      this.render();
    }
    this.tree.querySelector<HTMLElement>(`[data-row="d:${CSS.escape(entry.key)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  private render(): void {
    const field = this.tree.querySelector<HTMLInputElement>('input.wm-files-rename');
    this.renameDraft =
      field && this.renaming ? { id: this.renaming, value: field.value, start: field.selectionStart ?? field.value.length, end: field.selectionEnd ?? field.value.length } : null;
    const focused = this.el.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.row : undefined;
    const here = this.host.current();
    const rows = treeRows(this.folders, this.entries, this.expanded);
    this.tree.replaceChildren(...rows.map((row) => this.row(row, here)));
    this.empty.hidden = rows.length > 0 || this.inTrash;
    this.showWhere();
    if (this.inTrash) this.renderTrash();
    const stop =
      (this.tabStop && this.tree.querySelector<HTMLElement>(`[data-row="${CSS.escape(this.tabStop)}"]`)) ??
      this.tree.querySelector<HTMLElement>('.wm-files-current') ??
      this.tree.querySelector<HTMLElement>('.wm-files-row');
    if (stop) stop.tabIndex = 0;
    if (focused) this.tree.querySelector<HTMLElement>(`[data-row="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
    if (!this.inTrash) this.treeRestore.apply(this.tree);
  }

  private row(row: TreeRow<LibraryEntry>, here: { localId: string | null; cloudId: string | null }): HTMLElement {
    const folder = row.kind === 'folder';
    const id = folder ? `f:${row.folder.id}` : `d:${row.item.key}`;
    const name = folder ? row.folder.name : row.item.name;
    const renaming = this.renaming === (folder ? row.folder.id : `doc:${row.item.key}`);
    const label = renaming ? this.renameInput(row) : folder ? h('span', { class: 'wm-files-name', text: name }) : setFileName(h('span', { class: 'wm-files-name' }), name);
    const el = h(
      // A field can't be inside a button.
      renaming ? 'div' : 'button',
      { class: `wm-files-row ${folder ? 'wm-files-folder' : 'wm-files-file'}`, attrs: { ...(renaming ? {} : { type: 'button' }), role: 'treeitem', 'data-row': id, tabindex: '-1', 'aria-level': String(row.depth + 1) }, title: name },
      // A file's icon sits in the column of its sibling folders' chevrons, so the indent shows the hierarchy.
      folder ? h('span', { class: 'wm-files-twist' }, chevronIcon() as unknown as Node) : fileIcon(name),
      label,
      // Encrypted: a padlock, shut while locked (when the name also says so, so the padlock is not the only sign), open while unlocked.
      ...(lockOf(folder ? row.folder : row.item)),
    );
    if (renaming) {
      el.style.paddingLeft = `${6 + row.depth * 18}px`;
      if (folder) el.setAttribute('aria-expanded', String(row.open));
      const draft = this.renameDraft?.id === this.renaming ? this.renameDraft : null;
      queueMicrotask(() => {
        const input = el.querySelector('input');
        input?.focus();
        if (draft) input?.setSelectionRange(draft.start, draft.end);
        else input?.select();
      });
      return el;
    }
    el.style.paddingLeft = `${6 + row.depth * 18}px`;
    if (folder) el.setAttribute('aria-expanded', String(row.open));
    else {
      const { item } = row;
      if (item.vault) {
        el.classList.add('wm-files-inplace');
        el.setAttribute('aria-description', t('media.vaultOnly'));
        el.title = `${name}\n${t('media.vaultOnlyTip')}`;
        el.append(h('span', { class: 'wm-files-where', attrs: { 'aria-hidden': 'true' } }, computerIcon()));
      }
      const isCurrent = (here.localId !== null && item.local?.id === here.localId) || (here.cloudId !== null && item.cloud?.id === here.cloudId);
      toggleClass(el, 'wm-files-current', isCurrent);
      if (isCurrent) el.setAttribute('aria-current', 'true');
    }
    if (!folder) warmOnHover(el, () => this.host.warm(row.item));
    el.addEventListener('click', (event) => {
      const e = event as MouseEvent;
      // Command-click (like a right click) opens the menu instead.
      if (e.metaKey) {
        e.preventDefault();
        this.menuAt(e.clientX, e.clientY, folder ? this.folderItems(row.folder, row.open) : this.fileItems(row.item));
        return;
      }
      // A locked encrypted folder opens by being unlocked (a locked document does, through `open`).
      if (folder && row.folder.locked) void showUnlock();
      else if (folder) this.toggleFolder(row.folder.id);
      else this.host.open(row.item);
    });
    onContextMenu(el, (e) => {
      el.focus({ preventScroll: true });
      this.menuAt(e.clientX, e.clientY, folder ? this.folderItems(row.folder, row.open) : this.fileItems(row.item), el);
    });
    // A vault-only file stays where it is in the vault (it can still be dragged onto a note, as a link).
    if (folder || !row.item.vault) this.makeDraggable(el, folder ? { kind: 'folder', folder: row.folder } : { kind: 'doc', entry: row.item });
    // Dropped on a document, a thing goes in the folder that document is in.
    this.makeDropTarget(el, folder ? row.folder.id : folderOf(row.item, this.folders));
    return el;
  }

  /** Shows the documents or Trash, and the header for whichever it is. */
  private showWhere(): void {
    const trash = this.inTrash;
    this.tree.hidden = trash;
    this.trashView.hidden = !trash;
    this.trashEntry.hidden = trash;
    this.back.hidden = !trash;
    this.collapse.hidden = trash;
    this.title.textContent = trash ? t('trash.title') : t('panels.files.label');
  }

  /** What was deleted, newest first, with what to say when there is nothing (or it is still being listed). */
  private renderTrash(): void {
    const store = this.host.trash.store;
    const active = document.activeElement as HTMLElement | null;
    const focused = active && this.trashList.contains(active) ? active.dataset.row : undefined;
    const at = focused ? [...this.trashList.querySelectorAll<HTMLElement>('.wm-files-row')].findIndex((r) => r.dataset.row === focused) : -1;
    const note = store.accountError !== null ? t('trash.accountFailed', { message: store.accountError }) : !store.loaded ? t('trash.loading') : !store.items.length ? t('trash.empty') : '';
    this.trashNote.textContent = note;
    this.trashNote.hidden = !note;
    const rows = store.items.map((item) => this.trashRow(item));
    this.trashList.replaceChildren(...rows);
    this.emptyTrash.disabled = !store.items.length || store.emptying !== null;
    this.trashRestore.apply(this.trashList);
    const stop = (this.tabStop && rows.find((r) => r.dataset.row === this.tabStop)) ?? rows[0];
    if (stop) stop.tabIndex = 0;
    if (this.focusTrash && store.loaded) {
      this.focusTrash = false;
      if (document.activeElement === this.back) rows[0]?.focus();
      return;
    }
    if (focused === undefined) return;
    // The row with the keyboard is redrawn: it keeps it, or (gone, restored or deleted) the one now in its place does.
    const again = rows.find((r) => r.dataset.row === focused) ?? rows[Math.min(at, rows.length - 1)];
    (again ?? this.back).focus({ preventScroll: true });
  }

  /** A deleted document in Trash: opens read-only; its menu restores it or deletes it for good. */
  private trashRow(item: TrashItem): HTMLElement {
    const trash = this.host.trash;
    const going = trash.store.going.has(trashKey(item));
    const detail = `${trash.meta(item)} · ${trash.source(item)}`;
    const el = h(
      'button',
      { class: 'wm-files-row wm-files-trashed', attrs: { type: 'button', role: 'treeitem', 'data-row': `t:${trashKey(item)}`, tabindex: '-1', 'aria-level': '1', 'aria-description': detail }, title: `${item.name}\n${detail}` },
      fileIcon(item.name),
      setFileName(h('span', { class: 'wm-files-name' }), item.name),
    );
    toggleClass(el, 'wm-files-going', going);
    el.addEventListener('click', (event) => {
      const e = event as MouseEvent;
      if (e.metaKey) {
        e.preventDefault();
        this.menuAt(e.clientX, e.clientY, trash.menu(item), el);
        return;
      }
      trash.open(item);
    });
    onContextMenu(el, (e) => {
      el.focus({ preventScroll: true });
      this.menuAt(e.clientX, e.clientY, trash.menu(item), el);
    });
    return el;
  }

  /** Trash takes documents and folders dragged onto it: they are deleted, as Delete in their menus would (asking first). */
  private makeTrashTarget(el: HTMLElement): void {
    el.addEventListener('dragover', (e) => {
      if (!this.dragged) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      el.classList.add('wm-drop');
    });
    el.addEventListener('dragleave', () => el.classList.remove('wm-drop'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('wm-drop');
      const item = this.dragged;
      this.dragged = null;
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();
      if (item.kind === 'doc') {
        if (!item.entry.vault) void this.ask([], [item.entry], () => this.host.delete([item.entry]));
      } else void this.ask([item.folder], [], (before) => removeFolderTree(before.folders, before.entries, [item.folder], (entries, folderIds) => this.host.delete(entries, folderIds)));
    });
  }

  /** The field a folder's or document's name is typed in, in its row. A document's is typed without its extension, which stays. */
  private renameInput(row: TreeRow<LibraryEntry>): HTMLInputElement {
    const id = row.kind === 'folder' ? row.folder.id : `doc:${row.item.key}`;
    const value = row.kind === 'folder' ? row.folder.name : splitExtension(row.item.name)[0];
    const draft = this.renameDraft?.id === id ? this.renameDraft.value : null;
    const label = row.kind === 'folder' ? t('panels.dashboard.folderName') : t('chrome.title.label');
    const input = h('input', { class: 'wm-files-rename', attrs: { type: 'text', value: draft ?? value, 'aria-label': label, maxlength: row.kind === 'folder' ? '255' : '120' } });
    let finished = false;
    const finish = (save: boolean) => {
      if (finished) return;
      finished = true;
      this.renaming = null;
      const change = save ? this.renameChange(row, input.value) : null;
      if (change) void this.run(change);
      else this.render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      }
    });
    // Listing again rebuilds the rows and drops this field, which blurs it: that is not the person leaving it, so only a field still in the page is done.
    input.addEventListener('blur', () =>
      setTimeout(() => {
        if (input.isConnected) finish(true);
      }, 0),
    );
    return input;
  }

  // --- Menus ---------------------------------------------------------------------------------

  private menuAt(x: number, y: number, items: PopupItem[], returnTo?: HTMLElement): void {
    showPopupMenu(items, x, y, t('panels.files.label'), () => returnTo?.focus({ preventScroll: true }));
  }

  private fileItems(entry: LibraryEntry): PopupItem[] {
    // Audio or video in the vault only: renamed, moved and deleted in Finder, not here.
    if (entry.vault) return [{ label: t('panels.files.openItem'), run: () => this.host.open(entry) }, ...(this.host.canShowInVault?.() ? [{ label: showInFileManagerLabel(), run: () => this.host.showInVault?.({ doc: entry }) }] : [])];
    const items: PopupItem[] = [
      { label: t('panels.files.openItem'), run: () => this.host.open(entry) },
      ...(this.host.canShowInVault?.() ? [{ label: showInFileManagerLabel(), run: () => this.host.showInVault?.({ doc: entry }) }] : []),
      ...(entry.cloud && !entry.encrypted ? [{ label: t('panels.dashboard.share'), run: () => this.host.share(entry.cloud!.id, entry.cloud!.name) }] : []),
      ...(entry.locked ? [] : [{ label: t('panels.dashboard.rename'), run: () => this.startRename(`doc:${entry.key}`) }]),
      { label: t('panels.dashboard.move'), run: () => pickFolder(this.folders, t('panels.dashboard.moveTitle', { name: entry.name }), (id) => outOfReach(this.folders, { kind: 'doc', entry }, id), folderOf(entry, this.folders), (to) => void this.relocate({ kind: 'doc', entry }, to)) },
      // Encrypt… or Decrypt… (a locked document opens by being unlocked, so Open stands for Unlock…).
      ...(entry.locked ? [] : documentItems(entry)),
      { label: t('panels.dashboard.delete'), run: () => void this.ask([], [entry], () => this.host.delete([entry])) },
    ];
    return items;
  }

  private folderItems(folder: Folder, open: boolean): PopupItem[] {
    const deleteFolder: PopupItem = { label: t('panels.dashboard.deleteFolder'), run: () => void this.ask([folder], [], (before) => removeFolderTree(before.folders, before.entries, [folder], (entries, folderIds) => this.host.delete(entries, folderIds))) };
    // A locked folder inside an encrypted one can be unlocked or deleted, nothing else (docs/encrypted-folders.md).
    if (folder.locked && isEncryptedFolder(folder.parentId)) return [...encryptionFolderItems(folder), deleteFolder];
    return [
      { label: open ? t('panels.files.closeFolder') : t('panels.files.openFolder'), run: () => this.toggleFolder(folder.id) },
      ...(this.host.canShowInVault?.() && !folder.encrypted ? [{ label: showInFileManagerLabel(), run: () => this.host.showInVault?.({ folder }) }] : []),
      ...(this.host.shareFolder && this.host.account() && !folder.encrypted ? [{ label: t('panels.dashboard.share'), run: () => this.host.shareFolder!(folder) }] : []),
      { label: t('panels.dashboard.rename'), run: () => this.startRename(folder.id) },
      { label: t('panels.dashboard.move'), run: () => pickFolder(this.folders, t('panels.dashboard.moveTitle', { name: folder.name }), (id) => isInside(this.folders, id, folder.id) || outOfReach(this.folders, { kind: 'folder', folder }, id), folder.parentId, (to) => void this.relocate({ kind: 'folder', folder }, to)) },
      ...encryptionFolderItems(folder),
      deleteFolder,
      'separator',
      ...newMenuItems((kind) => this.host.newDocument(folder.id, kind)),
      'separator',
      { label: t('panels.dashboard.import'), run: () => this.host.importFile(folder.id) },
      { label: t('panels.dashboard.importFolder'), run: () => this.host.importFolder(folder.id) },
      { label: t('panels.dashboard.newFolder'), run: () => void this.newFolder(folder.id) },
    ];
  }

  /** What a right click on the empty part offers: the same as on the Documents screen, at the top level. */
  private rootItems(): PopupItem[] {
    return [
      ...newMenuItems((kind) => this.host.newDocument(null, kind)),
      'separator',
      { label: t('panels.dashboard.import'), run: () => this.host.importFile(null) },
      { label: t('panels.dashboard.importFolder'), run: () => this.host.importFolder(null) },
      { label: t('panels.dashboard.newFolder'), run: () => void this.newFolder(null) },
    ];
  }

  // --- Changes -------------------------------------------------------------------------------

  /** Asks, in a dialog listing all that would go, whether to delete these; if so, runs `remove`. */
  private async ask(folders: Folder[], docs: LibraryEntry[], remove: (before: { folders: Folder[]; entries: LibraryEntry[] }) => Promise<void>): Promise<void> {
    const lines = deletionList(this.folders, this.entries, folders, docs);
    if (await confirmDelete(deleteTitle(folders, docs, lines), lines)) {
      // Gone from the list at once; if it fails, the list fetched again brings it back with the reason.
      const before = { folders: this.folders, entries: this.entries };
      // (A listing already on its way was asked for before the delete: the library drops it.)
      const left = withoutDeleted(before.folders, before.entries, folders, docs);
      this.library.update({ folders: left.folders, entries: left.entries });
      await this.run(() => remove(before));
    }
    else this.host.focusEditor();
  }

  /** Runs a change, shows why if it failed, and lists everything again. */
  private async run(change: () => Promise<void>): Promise<void> {
    try {
      await change();
      this.notice.hidden = true;
    } catch (error) {
      this.notice.textContent = t('panels.dashboard.failed', { reason: error instanceof Error ? error.message : String(error) });
      this.notice.hidden = false;
    }
    this.render();
    await this.refresh();
  }

  /** What keeping `typed` as a row's name does (null: nothing, as when it is empty or the same). */
  private renameChange(row: TreeRow<LibraryEntry>, typed: string): (() => Promise<void>) | null {
    if (row.kind === 'folder') {
      const { folder } = row;
      const name = typed.trim();
      return name && name !== folder.name ? () => this.changeFolder(folder, { name }) : null;
    }
    const entry = row.item;
    const name = renamedFileName(entry.name, typed);
    if (!name) return null;
    return async () => {
      // Shown under its new name at once; if saving fails, the list fetched again puts the old one back.
      this.entries = this.entries.map((e) => (e.key === entry.key ? { ...e, name } : e));
      await this.host.rename(entry, name);
    };
  }

  private startRename(id: string): void {
    this.renaming = id;
    this.render();
  }

  /** A new folder in `parentId`, open and ready to be named. */
  private async newFolder(parentId: string | null): Promise<void> {
    await this.run(async () => {
      const folder = await createFolder(this.host.account() !== null, t('panels.dashboard.newFolderName'), parentId);
      this.folders = [...this.folders, folder];
      if (parentId !== null) this.toggleFolder(parentId, true);
      this.renaming = folder.id;
    });
    // `run` lists again, which rebuilds the field: keep it up.
  }

  private async changeFolder(folder: Folder, change: { name?: string; parentId?: string | null }): Promise<void> {
    this.folders = this.folders.map((f) => (f.id === folder.id ? { ...f, ...change } : f));
    this.render();
    const next = await updateFolder(this.host.account() !== null, folder, change);
    this.folders = this.folders.map((f) => (f.id === next.id ? next : f));
  }

  private relocate(item: Dragged, to: string | null): Promise<void> {
    // Into an encrypted folder, what isn't encrypted is encrypted first; out of one, it is decrypted, after asking (docs/encrypted-folders.md).
    return moveAcrossEncryption(item, to, () =>
      this.run(async () => {
        if (item.kind === 'folder') await this.changeFolder(item.folder, { parentId: to });
        else {
          this.entries = withMoved(this.entries, [item.entry], to);
          this.render();
          await moveEntries([item.entry], to);
        }
        if (to !== null) this.toggleFolder(to, true);
      }),
    );
  }

  private canDrop(item: Dragged, to: string | null): boolean {
    return canDrop(this.folders, item, to);
  }

  private makeDraggable(el: HTMLElement, item: Dragged): void {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      this.dragged = item;
      if (e.dataTransfer) {
        if (item.kind === 'doc') setDocumentDrag(e.dataTransfer, item.entry.key, item.entry.name);
        else {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', item.folder.name);
        }
      }
    });
    el.addEventListener('dragend', () => (this.dragged = null));
  }

  /**
   * A row (or the tree, for the top level) that takes documents and folders dragged here, and files
   * dropped from the computer, into `folderId`. The folder's own row lights up, whichever row it is over.
   */
  private makeDropTarget(el: HTMLElement, folderId: string | null): void {
    const isRow = el !== this.tree;
    const accepts = (e: DragEvent) => (this.dragged !== null ? this.canDrop(this.dragged, folderId) : isFileDrag(e));
    const lit = (): HTMLElement => (folderId === null ? this.tree : (this.tree.querySelector<HTMLElement>(`[data-row="f:${CSS.escape(folderId)}"]`) ?? el));
    el.addEventListener('dragover', (e) => {
      if (!accepts(e)) {
        // Over a row, a thing that can't go in its folder goes nowhere (not to the top level behind it).
        if (isRow && (this.dragged || isFileDrag(e))) e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = this.dragged ? 'move' : 'copy';
      lit().classList.add('wm-drop');
    });
    el.addEventListener('dragleave', () => lit().classList.remove('wm-drop'));
    el.addEventListener('drop', (e) => {
      lit().classList.remove('wm-drop');
      if (!accepts(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const item = this.dragged;
      this.dragged = null;
      if (item) return void this.relocate(item, folderId);
      const drop = takeDropped(e.dataTransfer);
      if (!drop) return;
      if (folderId !== null) this.toggleFolder(folderId, true);
      this.host.dropFile(drop, folderId);
    });
  }

  /** Closes every folder, so only the top level shows. */
  private collapseAll(): void {
    if (!this.expanded.size) return;
    this.expanded.clear();
    this.saveExpanded();
    this.render();
  }

  private toggleFolder(id: string, open = !this.expanded.has(id)): void {
    if (open === this.expanded.has(id)) return;
    if (open) this.expanded.add(id);
    else this.expanded.delete(id);
    this.saveExpanded();
    this.render();
  }

  /** What was saved of the sidebar's place; each list is put back where it was scrolled to as its rows come. */
  private loadView(): FilesView {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(VIEW_KEY);
    } catch {
      // Storage unavailable: the documents show, at the top.
    }
    const view = parseFilesView(saved);
    this.treeRestore = new ScrollRestore(view.treeScroll);
    this.trashRestore = new ScrollRestore(view.trashScroll);
    return view;
  }

  /** Keeps whether Trash is showing and how far each list is scrolled (a hidden list, or one still being put back, keeps what was saved). */
  private saveView(): void {
    try {
      const before = parseFilesView(localStorage.getItem(VIEW_KEY));
      const tree = this.treeRestore.pending || this.tree.hidden ? before.treeScroll : this.tree.scrollTop;
      const trash = this.trashRestore.pending || this.trashView.hidden ? before.trashScroll : this.trashList.scrollTop;
      localStorage.setItem(VIEW_KEY, JSON.stringify({ trash: this.inTrash, treeScroll: tree, trashScroll: trash }));
    } catch {
      // Storage unavailable: the sidebar starts at the top next time.
    }
  }

  private saveExpanded(): void {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...this.expanded]));
    } catch {
      // Storage unavailable: they stay open for this session only.
    }
  }

  /** Makes `row` the one Tab reaches in its tree. */
  private setTabStop(row: HTMLElement): void {
    for (const el of (row.closest('[role="tree"]') ?? this.tree).querySelectorAll<HTMLElement>('.wm-files-row[tabindex="0"]')) if (el !== row) el.tabIndex = -1;
    row.tabIndex = 0;
    this.tabStop = row.dataset.row ?? null;
  }

  private key(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'Escape') {
      // In Trash, Escape goes back to the documents; there, to the document.
      if (this.inTrash) this.leaveTrash();
      else this.host.focusEditor();
      return;
    }
    const rows = [...(this.inTrash ? this.trashList : this.tree).querySelectorAll<HTMLElement>('.wm-files-row')];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const folderOf = (el: HTMLElement | undefined) => (el?.dataset.row?.startsWith('f:') ? el.dataset.row.slice(2) : null);
    const moveTo = (i: number) => rows[Math.max(0, Math.min(rows.length - 1, i))]?.focus();
    switch (e.key) {
      case 'ArrowDown':
        moveTo(at + 1);
        break;
      case 'ArrowUp':
        moveTo(at - 1);
        break;
      case 'Home':
        moveTo(0);
        break;
      case 'End':
        moveTo(rows.length - 1);
        break;
      case 'ArrowRight': {
        const id = folderOf(rows[at]);
        if (id) this.toggleFolder(id, true);
        break;
      }
      case 'ArrowLeft': {
        const id = folderOf(rows[at]);
        if (id && this.expanded.has(id)) this.toggleFolder(id, false);
        else {
          // To the folder it is in: the nearest row above that is less deep.
          const level = Number(rows[at]?.getAttribute('aria-level') ?? 1);
          let parent = at - 1;
          while (parent >= 0 && Number(rows[parent]!.getAttribute('aria-level')) >= level) parent--;
          if (parent >= 0) moveTo(parent);
        }
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  }
}

/** A small computer, beside a file that is on this computer only (drawn, not typed: see AGENTS.md). */
function computerIcon(): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(NS, 'svg');
  icon.setAttribute('viewBox', '0 0 12 12');
  icon.setAttribute('width', '12');
  icon.setAttribute('height', '12');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M1.5 2.5h9v6h-9zM4 10.5h4M6 8.5v2');
  icon.append(path);
  return icon;
}
