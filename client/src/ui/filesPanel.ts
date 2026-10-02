// The files sidebar (View › Files Sidebar): the account's folders and documents as a tree to the
// left of the document, so another document is one click away without the dashboard. Folders open
// and close; a document opens in the editor. It lists what the dashboard does (see sync.ts).

import { treeRows, type Folder, type TreeRow } from '../folders.ts';
import { t } from '../i18n/index.ts';
import { loadLibrary, loadLocalLibrary, type LibraryEntry } from '../sync.ts';
import type { User } from '../auth.ts';
import { h, toggleClass } from './dom.ts';
import { fileIcon, setFileName } from './fileIcons.ts';
import { makeResizable } from './sidebarResize.ts';
import './filesPanel.css';

export interface FilesPanelHost {
  open(entry: LibraryEntry): void;
  account(): User | null;
  signedIn(): User | null;
  /** The open document's ids, to mark it. */
  current(): { localId: string | null; cloudId: string | null };
  close(): void;
  focusEditor(): void;
}

/** How long to wait after a change before listing again, so a run of saves is one listing. */
const REFRESH_DELAY = 3000;
/** Folders left open, kept in this browser. */
const OPEN_KEY = 'word.filesOpen';

export class FilesPanel {
  readonly el = h('aside', { class: 'wm-files', attrs: { 'aria-label': t('panels.files.label') } });
  private readonly tree = h('div', { class: 'wm-files-tree', attrs: { role: 'tree', 'aria-label': t('panels.files.label') } });
  private readonly empty = h('p', { class: 'wm-files-empty', text: t('panels.files.empty') });
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
    this.el.append(h('header', { class: 'wm-files-bar' }, h('h2', { text: t('panels.files.label') }), close), this.tree, this.empty);
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
    const el = h(
      'button',
      { class: `wm-files-row ${folder ? 'wm-files-folder' : 'wm-files-file'}`, attrs: { type: 'button', role: 'treeitem', 'data-row': id, tabindex: '-1', 'aria-level': String(row.depth + 1) }, title: name },
      h('span', { class: 'wm-files-twist', text: folder ? (row.open ? '▾' : '▸') : '' }),
      ...(folder ? [] : [fileIcon(name)]),
      folder ? h('span', { class: 'wm-files-name', text: name }) : setFileName(h('span', { class: 'wm-files-name' }), name),
    );
    el.style.paddingLeft = `${6 + row.depth * 14}px`;
    if (folder) el.setAttribute('aria-expanded', String(row.open));
    else {
      const { item } = row;
      const isCurrent = (here.localId !== null && item.local?.id === here.localId) || (here.cloudId !== null && item.cloud?.id === here.cloudId);
      toggleClass(el, 'wm-files-current', isCurrent);
      if (isCurrent) el.setAttribute('aria-current', 'true');
    }
    el.addEventListener('click', () => (folder ? this.toggleFolder(row.folder.id) : this.host.open(row.item)));
    return el;
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
