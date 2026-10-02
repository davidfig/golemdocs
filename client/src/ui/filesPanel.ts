// The files sidebar (View › Files Sidebar): the account's folders and documents as a tree to the
// left of the document, so another document is one click away without the dashboard. Folders open
// and close; a document opens in the editor. It lists what the dashboard does (see sync.ts).

import { createFolder, moveEntry, removeFolderTree, updateFolder } from '../folderOps.ts';
import { deletionList, folderOf, isInside, treeRows, type Folder, type TreeRow } from '../folders.ts';
import { t } from '../i18n/index.ts';
import { loadLibrary, loadLocalLibrary, type LibraryEntry } from '../sync.ts';
import type { User } from '../auth.ts';
import { h, toggleClass } from './dom.ts';
import { fileIcon, setFileName } from './fileIcons.ts';
import { confirmDelete, deleteTitle } from './deleteDialog.ts';
import { pickFolder } from './folderPicker.ts';
import { showPopupMenu, type PopupItem } from './popupMenu.ts';
import { makeResizable } from './sidebarResize.ts';
import './filesPanel.css';

export interface FilesPanelHost {
  open(entry: LibraryEntry): void;
  /** Starts a blank document, to be filed in `folderId` (null: the top level) when it is first saved. */
  newDocument(folderId: string | null): void;
  /** Asks for a file on this computer and opens it, to be filed in `folderId` when it is first saved. */
  importFile(folderId: string | null): void;
  /** Deletes the document everywhere: from the account and from this browser. */
  delete(entry: LibraryEntry): Promise<void>;
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
type Dragged = { kind: 'doc'; entry: LibraryEntry } | { kind: 'folder'; folder: Folder };

/** Folders left open, kept in this browser. */
const OPEN_KEY = 'word.filesOpen';

export class FilesPanel {
  readonly el = h('aside', { class: 'wm-files', attrs: { 'aria-label': t('panels.files.label') } });
  private readonly tree = h('div', { class: 'wm-files-tree', attrs: { role: 'tree', 'aria-label': t('panels.files.label') } });
  private readonly empty = h('p', { class: 'wm-files-empty', text: t('panels.files.empty') });
  private readonly notice = h('p', { class: 'wm-files-notice', attrs: { role: 'status' } });
  /** The folder being renamed in place. */
  private renaming: string | null = null;
  private dragged: Dragged | null = null;
  private entries: LibraryEntry[] = [];
  private folders: Folder[] = [];
  private readonly expanded = new Set<string>();
  private generation = 0;
  private timer = 0;

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
    parent.append(this.el);
    makeResizable(this.el, { key: 'word.filesWidth', min: 140, max: 480, initial: 200 });
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  setVisible(visible: boolean): void {
    if (this.el.hidden === !visible) return;
    this.el.hidden = !visible;
    if (visible) void this.refresh();
    else this.generation++;
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
    const library = await loadLibrary(this.host.account(), this.host.signedIn());
    if (generation !== this.generation) return;
    this.entries = library.entries;
    // Unless they couldn't be listed: what is on screen is better than none.
    if (library.folders) this.folders = library.folders;
    this.render();
  }

  /** Marks the open document again (another was opened, or it was just saved for the first time). */
  mark(): void {
    if (!this.visible) return;
    const here = this.host.current();
    for (const el of this.tree.querySelectorAll<HTMLElement>('.wm-files-file')) {
      const entry = this.entries.find((e) => `d:${e.key}` === el.dataset.row);
      const on = !!entry && ((here.localId !== null && entry.local?.id === here.localId) || (here.cloudId !== null && entry.cloud?.id === here.cloudId));
      toggleClass(el, 'wm-files-current', on);
      if (on) el.setAttribute('aria-current', 'true');
      else el.removeAttribute('aria-current');
    }
  }

  private render(): void {
    const focused = this.el.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.row : undefined;
    const here = this.host.current();
    const rows = treeRows(this.folders, this.entries, this.expanded);
    this.tree.replaceChildren(...rows.map((row) => this.row(row, here)));
    this.empty.hidden = rows.length > 0;
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
      queueMicrotask(() => {
        const input = el.querySelector('input');
        input?.focus();
        input?.select();
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
    if (folder) this.makeDropTarget(el, row.folder.id);
    return el;
  }

  private renameInput(folder: Folder): HTMLInputElement {
    const input = h('input', { class: 'wm-files-rename', attrs: { type: 'text', value: folder.name, 'aria-label': t('panels.dashboard.folderName'), maxlength: '255' } });
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
    input.addEventListener('blur', () => finish(true));
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
      { label: t('panels.dashboard.delete'), run: () => void this.ask([], [entry], () => this.host.delete(entry)) },
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
      { label: t('panels.dashboard.deleteFolder'), run: () => void this.ask([folder], [], () => removeFolderTree(this.host.account() !== null, this.folders, this.entries, folder, (entry) => this.host.delete(entry))) },
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
  private async ask(folders: Folder[], docs: LibraryEntry[], remove: () => Promise<void>): Promise<void> {
    const lines = deletionList(this.folders, this.entries, folders, docs);
    if (await confirmDelete(deleteTitle(folders, docs, lines), lines)) await this.run(remove);
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
    const next = await updateFolder(this.host.account() !== null, folder, change);
    this.folders = this.folders.map((f) => (f.id === next.id ? next : f));
  }

  private relocate(item: Dragged, to: string | null): Promise<void> {
    return this.run(async () => {
      if (item.kind === 'folder') await this.changeFolder(item.folder, { parentId: to });
      else {
        await moveEntry(item.entry, to);
        if (item.entry.cloud) item.entry.cloud.folderId = to;
        if (item.entry.local) {
          if (to === null) delete item.entry.local.folderId;
          else item.entry.local.folderId = to;
        }
      }
      if (to !== null) this.toggleFolder(to, true);
    });
  }

  private canDrop(item: Dragged, to: string | null): boolean {
    if (item.kind === 'doc') return folderOf(item.entry, this.folders) !== to;
    return item.folder.parentId !== to && to !== item.folder.id && !isInside(this.folders, to, item.folder.id);
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

  private makeDropTarget(el: HTMLElement, folderId: string | null): void {
    const accepts = () => this.dragged !== null && this.canDrop(this.dragged, folderId);
    el.addEventListener('dragover', (e) => {
      if (!accepts()) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      el.classList.add('wm-drop');
    });
    el.addEventListener('dragleave', () => el.classList.remove('wm-drop'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('wm-drop');
      const item = this.dragged;
      if (!item || !accepts()) return;
      e.preventDefault();
      e.stopPropagation();
      this.dragged = null;
      void this.relocate(item, folderId);
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
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  }
}
