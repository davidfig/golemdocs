// The files sidebar (View › Files Sidebar): the account's folders and documents as a tree to the
// left of the document, so another document is one click away without the dashboard. Folders open
// and close; a document opens in the editor. It lists what the dashboard does (see sync.ts).

import { takeDropped, type Dropped } from '../storage/droppedFiles.ts';
import { warmOnHover } from './warmOnHover.ts';
import { canDrop, createFolder, moveEntries, removeFolderTree, updateFolder, withMoved, withoutDeleted, type Dragged } from '../folderOps.ts';
import { deletionList, folderOf, isInside, treeRows, type Folder, type TreeRow } from '../folders.ts';
import { t } from '../i18n/index.ts';
import { loadLibrary, loadLocalLibrary, type LibraryEntry } from '../sync.ts';
import type { User } from '../auth.ts';
import { h, isFileDrag, toggleClass } from './dom.ts';
import { fileIcon, setFileName } from './fileIcons.ts';
import { confirmDelete, deleteTitle } from './deleteDialog.ts';
import { pickFolder } from './folderPicker.ts';
import { showPopupMenu, type PopupItem } from './popupMenu.ts';
import { makeResizable } from './sidebarResize.ts';
import './filesPanel.css';

export interface FilesPanelHost {
  open(entry: LibraryEntry): void;
  /** The pointer is on this document: a chance to start fetching what opening it needs. */
  warm(entry: LibraryEntry): void;
  /** Starts a blank document, to be filed in `folderId` (null: the top level) when it is first saved. */
  newDocument(folderId: string | null): void;
  /** Asks for a file on this computer and opens it, to be filed in `folderId` when it is first saved. */
  importFile(folderId: string | null): void;
  /** Opens a file dropped from the computer, to be filed in `folderId` (null: the top level) when it is first saved. */
  /** Opens a dropped file, or imports several (or a folder), filed in `folderId`. */
  dropFile(drop: Dropped, folderId: string | null): void;
  /** Folders or documents were changed here (made, renamed, moved or deleted): other views of them catch up. */
  changed?(): void;
  /** Deletes the document everywhere: from the account and from this browser. */
  delete(entries: LibraryEntry[], folderIds?: string[]): Promise<void>;
  /** Opens the sharing dialog for a cloud document the user owns. */
  share(cloudId: string, name: string): void;
  account(): User | null;
  signedIn(): User | null;
  /** The open document's ids, to mark it. */
  current(): { localId: string | null; cloudId: string | null };
  close(): void;
  focusEditor(): void;
}

/** How long to wait after a change before listing again, so a run of saves is one listing. */
const REFRESH_DELAY = 3000;
/** What is being dragged onto a folder. */
/** Folders left open, kept in this browser. */
const OPEN_KEY = 'word.filesOpen';

export class FilesPanel {
  readonly el = h('aside', { class: 'wm-files', attrs: { 'aria-label': t('panels.files.label') } });
  private readonly tree = h('div', { class: 'wm-files-tree', attrs: { role: 'tree', 'aria-label': t('panels.files.label') } });
  private readonly empty = h('p', { class: 'wm-files-empty', text: t('panels.files.empty') });
  private readonly notice = h('p', { class: 'wm-files-notice', attrs: { role: 'status' } });
  /** The folder being renamed in place. */
  private renaming: string | null = null;
  /** What has been typed in the folder name field so far (and where the caret is), kept when the rows are rebuilt under it. */
  private renameDraft: { folder: string; value: string; start: number; end: number } | null = null;
  private dragged: Dragged | null = null;
  private entries: LibraryEntry[] = [];
  private folders: Folder[] = [];
  private readonly expanded = new Set<string>();
  private generation = 0;
  private timer = 0;
  /** The open document the tree was last opened up to, so a folder closed afterwards stays closed. */
  private revealed = '';
  /** The row Tab goes to in the tree (one row at a time is in the tab order): the last one focused. */
  private tabStop: string | null = null;

  constructor(parent: HTMLElement, private readonly host: FilesPanelHost) {
    this.el.hidden = true;
    try {
      for (const id of JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]')) if (typeof id === 'string') this.expanded.add(id);
    } catch {
      // Storage unavailable: the folders start closed.
    }
    const close = h('button', { class: 'wm-files-close', text: '×', attrs: { type: 'button', 'aria-label': t('panels.files.close') }, title: t('panels.files.close') });
    close.addEventListener('click', () => host.close());
    this.el.append(h('header', { class: 'wm-files-bar' }, h('h2', { text: t('panels.files.label') }), close), this.notice, this.tree, this.empty);
    this.notice.hidden = true;
    this.el.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('.wm-files-row')) return;
      e.preventDefault();
      this.menuAt(e.clientX, e.clientY, this.rootItems());
    });
    this.makeDropTarget(this.tree, null);
    // Keys typed here stay here: the document's handlers listen on the window.
    this.el.addEventListener('keydown', (e) => this.key(e));
    this.tree.addEventListener('focusin', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.wm-files-row');
      if (row?.dataset.row) this.setTabStop(row);
    });
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
      void this.refresh();
    } else this.generation++;
  }

  /** Lists again soon, if it's showing (something was saved, uploaded or moved). */
  refreshSoon(): void {
    if (!this.visible) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.refresh(), REFRESH_DELAY);
  }

  /** Lists what this browser has at once, then the account's. */
  async refresh(): Promise<void> {
    clearTimeout(this.timer);
    const generation = ++this.generation;
    const start = await loadLocalLibrary(this.host.account());
    if (generation !== this.generation) return;
    this.entries = start.entries;
    this.folders = start.folders;
    this.render();
    this.reveal();
    const library = await loadLibrary(this.host.account(), this.host.signedIn());
    if (generation !== this.generation) return;
    this.entries = library.entries;
    // Unless they couldn't be listed: what is on screen is better than none.
    if (library.folders) this.folders = library.folders;
    this.render();
    this.reveal();
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
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify([...this.expanded]));
      } catch {
        // Storage unavailable: they stay open for this session only.
      }
      this.render();
    }
    this.tree.querySelector<HTMLElement>(`[data-row="d:${CSS.escape(entry.key)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  private render(): void {
    const field = this.tree.querySelector<HTMLInputElement>('input.wm-files-rename');
    this.renameDraft =
      field && this.renaming ? { folder: this.renaming, value: field.value, start: field.selectionStart ?? field.value.length, end: field.selectionEnd ?? field.value.length } : null;
    const focused = this.el.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.row : undefined;
    const here = this.host.current();
    const rows = treeRows(this.folders, this.entries, this.expanded);
    this.tree.replaceChildren(...rows.map((row) => this.row(row, here)));
    this.empty.hidden = rows.length > 0;
    const stop =
      (this.tabStop && this.tree.querySelector<HTMLElement>(`[data-row="${CSS.escape(this.tabStop)}"]`)) ??
      this.tree.querySelector<HTMLElement>('.wm-files-current') ??
      this.tree.querySelector<HTMLElement>('.wm-files-row');
    if (stop) stop.tabIndex = 0;
    if (focused) this.tree.querySelector<HTMLElement>(`[data-row="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }

  private row(row: TreeRow<LibraryEntry>, here: { localId: string | null; cloudId: string | null }): HTMLElement {
    const folder = row.kind === 'folder';
    const id = folder ? `f:${row.folder.id}` : `d:${row.item.key}`;
    const name = folder ? row.folder.name : row.item.name;
    const renaming = folder && this.renaming === row.folder.id;
    const label = renaming ? this.renameInput(row.folder) : folder ? h('span', { class: 'wm-files-name', text: name }) : setFileName(h('span', { class: 'wm-files-name' }), name);
    const el = h(
      // A field can't be inside a button.
      renaming ? 'div' : 'button',
      { class: `wm-files-row ${folder ? 'wm-files-folder' : 'wm-files-file'}`, attrs: { ...(renaming ? {} : { type: 'button' }), role: 'treeitem', 'data-row': id, tabindex: '-1', 'aria-level': String(row.depth + 1) }, title: name },
      // A file's icon sits in the column of its sibling folders' chevrons, so the indent shows the hierarchy.
      folder ? h('span', { class: 'wm-files-twist', text: row.open ? '▾' : '▸' }) : fileIcon(name),
      label,
    );
    if (renaming) {
      el.style.paddingLeft = `${6 + row.depth * 18}px`;
      el.setAttribute('aria-expanded', String(row.open));
      const draft = this.renameDraft?.folder === row.folder.id ? this.renameDraft : null;
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
      if (folder) this.toggleFolder(row.folder.id);
      else this.host.open(row.item);
    });
    el.addEventListener('contextmenu', (event) => {
      const e = event as MouseEvent;
      e.preventDefault();
      el.focus({ preventScroll: true });
      this.menuAt(e.clientX, e.clientY, folder ? this.folderItems(row.folder, row.open) : this.fileItems(row.item), el);
    });
    this.makeDraggable(el, folder ? { kind: 'folder', folder: row.folder } : { kind: 'doc', entry: row.item });
    // Dropped on a document, a thing goes in the folder that document is in.
    this.makeDropTarget(el, folder ? row.folder.id : folderOf(row.item, this.folders));
    return el;
  }

  private renameInput(folder: Folder): HTMLInputElement {
    const draft = this.renameDraft?.folder === folder.id ? this.renameDraft.value : null;
    const input = h('input', { class: 'wm-files-rename', attrs: { type: 'text', value: draft ?? folder.name, 'aria-label': t('panels.dashboard.folderName'), maxlength: '255' } });
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
    const items: PopupItem[] = [
      { label: t('panels.files.openItem'), run: () => this.host.open(entry) },
      ...(entry.cloud ? [{ label: t('panels.dashboard.share'), run: () => this.host.share(entry.cloud!.id, entry.cloud!.name) }] : []),
      { label: t('panels.dashboard.move'), run: () => pickFolder(document.body, this.folders, t('panels.dashboard.moveTitle', { name: entry.name }), () => false, folderOf(entry, this.folders), (to) => void this.relocate({ kind: 'doc', entry }, to)) },
      'separator',
      { label: t('panels.dashboard.delete'), run: () => void this.ask([], [entry], () => this.host.delete([entry])) },
    ];
    return items;
  }

  private folderItems(folder: Folder, open: boolean): PopupItem[] {
    return [
      { label: open ? t('panels.files.closeFolder') : t('panels.files.openFolder'), run: () => this.toggleFolder(folder.id) },
      'separator',
      { label: t('panels.dashboard.newBlank'), run: () => this.host.newDocument(folder.id) },
      { label: t('panels.dashboard.import'), run: () => this.host.importFile(folder.id) },
      { label: t('panels.dashboard.newFolder'), run: () => void this.newFolder(folder.id) },
      'separator',
      { label: t('panels.dashboard.rename'), run: () => this.startRename(folder.id) },
      { label: t('panels.dashboard.move'), run: () => pickFolder(document.body, this.folders, t('panels.dashboard.moveTitle', { name: folder.name }), (id) => isInside(this.folders, id, folder.id), folder.parentId, (to) => void this.relocate({ kind: 'folder', folder }, to)) },
      'separator',
      { label: t('panels.dashboard.deleteFolder'), run: () => void this.ask([folder], [], (before) => removeFolderTree(before.folders, before.entries, [folder], (entries, folderIds) => this.host.delete(entries, folderIds))) },
    ];
  }

  /** What a right click on the empty part offers: the same as on the Documents screen, at the top level. */
  private rootItems(): PopupItem[] {
    return [
      { label: t('panels.dashboard.newBlank'), run: () => this.host.newDocument(null) },
      { label: t('panels.dashboard.import'), run: () => this.host.importFile(null) },
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
      // A listing already on its way was asked for before the delete: it would bring these back.
      this.generation++;
      clearTimeout(this.timer);
      const left = withoutDeleted(before.folders, before.entries, folders, docs);
      this.folders = left.folders;
      this.entries = left.entries;
      this.render();
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
    // The Documents screen shows the same folders and documents.
    this.host.changed?.();
    await this.refresh();
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
    return this.run(async () => {
      if (item.kind === 'folder') await this.changeFolder(item.folder, { parentId: to });
      else {
        this.entries = withMoved(this.entries, [item.entry], to);
        this.render();
        await moveEntries([item.entry], to);
      }
      if (to !== null) this.toggleFolder(to, true);
    });
  }

  private canDrop(item: Dragged, to: string | null): boolean {
    return canDrop(this.folders, item, to);
  }

  private makeDraggable(el: HTMLElement, item: Dragged): void {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      this.dragged = item;
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.kind === 'doc' ? item.entry.name : item.folder.name);
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

  private toggleFolder(id: string, open = !this.expanded.has(id)): void {
    if (open === this.expanded.has(id)) return;
    if (open) this.expanded.add(id);
    else this.expanded.delete(id);
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...this.expanded]));
    } catch {
      // Storage unavailable: they stay open for this session only.
    }
    this.render();
  }

  /** Makes `row` the one Tab reaches in the tree. */
  private setTabStop(row: HTMLElement): void {
    for (const el of this.tree.querySelectorAll<HTMLElement>('.wm-files-row[tabindex="0"]')) if (el !== row) el.tabIndex = -1;
    row.tabIndex = 0;
    this.tabStop = row.dataset.row ?? null;
  }

  private key(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'Escape') {
      this.host.focusEditor();
      return;
    }
    const rows = [...this.tree.querySelectorAll<HTMLElement>('.wm-files-row')];
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
