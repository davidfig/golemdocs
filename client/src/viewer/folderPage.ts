// The site's page for a shared folder (docs/folder-sharing.md): /view?f=<token> for a person it was shared with view-only, and
// /view?pf=<token> for its public link, which anyone may open. `&path=` names the file shown (a path inside the folder) and the
// address's `#` a heading in it, so every file has an address of its own and Back goes to the one before.
//
// The page shows the folder's files as a tree (a `nav` of nested lists, ordinary links and disclosure sections, so the keyboard and
// a screen reader work it as any page's) beside the viewer, which shows one file at a time. A `doc:` link in a file opens the
// folder's file it names, in this tab (`resolveFolderLink`): only the folder's own files are ever found, so a link to anything outside
// it says so and goes nowhere. F6 moves between the tree and the document.
//
// Everything asked for is the share's token and a path in the folder (`/api/folder-view|folder-public/<token>[/file?path=]`), never
// an id. As the document page does, it checks every half minute (two minutes for a public link) and when the tab is looked at again:
// the tree, and the file shown (`If-None-Match`). When access ends the document and tree go and nothing more is asked.

import { t } from '../i18n/index.ts';
import { CHEVRON_ICON, h, iconButton } from '../ui/dom.ts';
import { mountSignIn } from '../ui/signIn.ts';
import { firstFile, folderTree, resolveFolderLink, type TreeFolder } from './folderLinks.ts';
import { savedViewMode } from '../ui/viewMode.ts';
import { CHECK_MS, downloader, downloading, highContrast, PAGE_TITLE, PUBLIC_CHECK_MS, say, sayIn } from './page.ts';
import { followSaves, type LiveLine } from './live.ts';
import { checkOutcome } from './protocol.ts';
import { mount, type Viewer } from './viewer.ts';

interface TreeFile {
  path: string;
  updatedAt: number;
  size: number;
}

interface FolderTreeResponse {
  name: string;
  folders: string[];
  files: TreeFile[];
}

/** A panel beside the page: the icon of the Files button. */
const ICON_FILES = 'M1.5 2.5H10.5V9.5H1.5ZM4.5 2.5V9.5';
/** How long a note in the bar (a link that goes outside the folder) stays. */
const NOTE_MS = 6000;

const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

const headingOf = (hash: string): string => {
  try {
    return decodeURIComponent(hash.replace(/^#/, ''));
  } catch {
    return hash.replace(/^#/, '');
  }
};

/** A section's chevron: drawn, not typed, and turned while open (viewer.css). */
function chevron(): SVGSVGElement {
  const button = iconButton('', CHEVRON_ICON, '');
  const icon = button.querySelector('svg')!;
  icon.classList.add('wm-folder-chevron');
  return icon;
}

export async function showFolder(params: URLSearchParams, locale: string): Promise<void> {
  const isPublic = params.has('pf');
  const key = isPublic ? 'pf' : 'f';
  const token = params.get(key) ?? '';
  const gone = isPublic ? t('viewer.folderLinkGone') : t('viewer.folderGone');
  if (!/^[\w-]+$/.test(token)) return void say(gone);
  const api = `/api/${isPublic ? 'folder-public' : 'folder-view'}/${encodeURIComponent(token)}`;
  // Signing in comes straight back to the same file.
  const signInHere = (): void => void mountSignIn(say(t('viewer.signInToViewFolder')), location.pathname + location.search + location.hash);
  const urlFor = (path: string, section = ''): string =>
    `/view?${key}=${encodeURIComponent(token)}&path=${encodeURIComponent(path)}${section ? `#${encodeURIComponent(section)}` : ''}`;

  let tree: FolderTreeResponse;
  try {
    const response = await fetch(api, { cache: 'no-store' });
    if (response.status === 401) return signInHere();
    // Unknown, someone else's, no longer shared, or the owner's subscription ended: all the same to the page.
    if (response.status === 404 || response.status === 403) return void say(gone);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    tree = (await response.json()) as FolderTreeResponse;
  } catch (error) {
    return void say(t('app.openSharedFailed', { message: (error as Error).message }));
  }

  // --- The page: a bar with the folder's name, the tree, and the document -------------------------
  const nav = h('nav', { class: 'wm-folder-tree', attrs: { id: 'wm-folder-tree', 'aria-label': t('viewer.files') } });
  const docEl = h('div', { class: 'wm-folder-doc' });
  const toggle = iconButton('wm-tbutton', ICON_FILES, t('viewer.files'));
  toggle.setAttribute('aria-controls', nav.id);
  const folderName = h('h1', { class: 'wm-viewer-title wm-folder-name' });
  const note = h('span', { class: 'wm-find-message', attrs: { role: 'status' } });
  const head = h('header', { class: 'wm-viewer-bar wm-folder-head' }, toggle, folderName, note);
  document.body.replaceChildren(h('div', { class: 'wm-viewer wm-folder-page' }, head, h('div', { class: 'wm-folder-body' }, nav, docEl)));

  const narrow = matchMedia('(max-width: 640px)');
  const setOpen = (open: boolean): void => {
    nav.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  };
  setOpen(!narrow.matches);
  toggle.addEventListener('click', () => {
    setOpen(nav.hidden);
    if (!nav.hidden) focusTree();
  });

  let noteTimer = 0;
  const tell = (text: string): void => {
    clearTimeout(noteTimer);
    note.textContent = text;
    noteTimer = window.setTimeout(() => (note.textContent = ''), NOTE_MS);
  };

  // --- The tree ----------------------------------------------------------------------------------
  const links = new Map<string, HTMLAnchorElement>();
  let shownPath = '';
  const markCurrent = (): void => {
    for (const [path, link] of links) {
      if (path === shownPath) {
        link.setAttribute('aria-current', 'page');
        // Its folders open, so it can be seen.
        for (let up = link.parentElement; up && up !== nav; up = up.parentElement) if (up instanceof HTMLDetailsElement) up.open = true;
      } else link.removeAttribute('aria-current');
    }
  };
  function renderTree(): void {
    folderName.textContent = tree.name;
    // Folders closed by the person stay closed when the tree is drawn again.
    const closed = new Set([...nav.querySelectorAll('details')].filter((d) => !d.open).map((d) => d.dataset.path));
    links.clear();
    const list = (folder: TreeFolder<TreeFile>): HTMLElement =>
      h('ul', {}, ...folder.folders.map((f) => h('li', {}, section(f))), ...folder.files.map((file) => h('li', {}, link(file))));
    const section = (folder: TreeFolder<TreeFile>): HTMLElement => {
      const details = h('details', {}, h('summary', {}, chevron() as unknown as Node, h('span', { text: folder.name })), list(folder));
      details.dataset.path = folder.path;
      details.open = !closed.has(folder.path);
      return details;
    };
    const link = (file: TreeFile): HTMLElement => {
      const a = h('a', { text: fileName(file.path), title: file.path, attrs: { href: urlFor(file.path) } });
      a.addEventListener('click', (e) => {
        // A new tab or window, as any link.
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        if (narrow.matches) setOpen(false);
        void go(file.path, '', true);
      });
      links.set(file.path, a);
      return a;
    };
    const top = folderTree(tree.folders, tree.files);
    const empty = !tree.files.length && !tree.folders.length;
    nav.replaceChildren(empty ? h('p', { class: 'wm-hint', text: t('viewer.folderEmpty') }) : list(top));
    markCurrent();
  }
  const focusTree = (): void => {
    if (nav.hidden) setOpen(true);
    (links.get(shownPath) ?? nav.querySelector<HTMLElement>('a, summary'))?.focus();
  };

  // --- The document ------------------------------------------------------------------------------
  const save = downloader();
  let viewer: Viewer | null = null;
  let shown: { path: string; etag: string | null; stored: Uint8Array | null } | null = null;
  let opening = 0;
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const contrast = highContrast();
  // Print Layout or Flow, as the person chose it in the editor; one picked here stays for the next file opened. The page grid is
  // left when another file opens, as in the editor.
  let view = savedViewMode();

  // The live line for the file shown (live.ts): each save of it makes the page check at once.
  let live: LiveLine | null = null;
  const close = (): void => {
    live?.stop();
    live = null;
    viewer?.destroy();
    viewer = null;
    shown = null;
  };

  async function go(path: string, section: string, push: boolean): Promise<void> {
    if (push) history.pushState(null, '', urlFor(path, section));
    const ticket = ++opening;
    close();
    shownPath = path;
    markCurrent();
    if (!tree.files.some((f) => f.path === path)) return void sayIn(docEl, tree.files.length ? t('viewer.fileGone') : t('viewer.folderEmpty'));
    let response: Response;
    // The loading screen, from when the file is asked for until its last byte is in (a message put in its place takes it away).
    docEl.replaceChildren();
    const loaded = downloading(docEl, fileName(path));
    try {
      response = await fetch(`${api}/file?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
      if (ticket !== opening) return;
      if (response.status === 401) return end('signedOut');
      // Gone since the tree was read: the tree is read again, which also tells whether the whole folder went.
      if (response.status === 404 || response.status === 403) {
        sayIn(docEl, t('viewer.fileGone'));
        return void check(true);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (ticket === opening) sayIn(docEl, t('app.openSharedFailed', { message: (error as Error).message }));
      return;
    }
    const bytes = await response.arrayBuffer().catch(() => null);
    const waited = loaded();
    if (ticket !== opening || ended) return;
    if (!bytes) return void sayIn(docEl, t('app.openSharedFailed', { message: '' }));
    const name = fileName(path);
    const title = t('viewer.viewOnlyTitle', { name });
    document.title = `${title} · ${tree.name}`;
    // A copy for Download: the viewer is handed the bytes, which go to its worker.
    const opened = { path, etag: response.headers.get('etag'), stored: isPublic ? new Uint8Array(bytes.slice(0)) : null };
    shown = opened;
    live = followSaves(`${api}/live?path=${encodeURIComponent(path)}`, () => void check());
    docEl.replaceChildren();
    viewer = mount(docEl, {
      bytes,
      name,
      fontBase: '/fonts/',
      dark,
      locale,
      title,
      contrast,
      statusBar: true,
      view,
      onView: (picked) => {
        if (picked !== 'grid') view = picked;
      },
      waited,
      heading: section || undefined,
      onError: (message) => console.error(message),
      onDownload: isPublic ? () => void (opened.stored && save(opened.stored, name)) : undefined,
      // A web link opens in a tab of its own; a link to another document opens it here, if it is the folder's.
      onLink: (url) => void window.open(url, '_blank', 'noopener,noreferrer'),
      onDocLink: (address) => {
        const found = resolveFolderLink(address, tree.name, tree.files, path);
        if (!found) return tell(t('viewer.notShared'));
        void go(found.file.path, found.section, true);
      },
    });
  }

  // --- Keeping up, and the end of access -----------------------------------------------------------
  let checking = false;
  let ended = false;
  async function check(force = false): Promise<void> {
    if (checking || ended || (!force && document.visibilityState !== 'visible')) return;
    checking = true;
    try {
      const response = await fetch(api, { cache: 'no-store' }).catch(() => null);
      const outcome = checkOutcome(response?.status ?? null);
      if (outcome === 'ended' || outcome === 'signedOut') return end(outcome);
      if (outcome === 'newer') {
        const next = (await response!.json()) as FolderTreeResponse;
        if (JSON.stringify(next) !== JSON.stringify(tree)) {
          tree = next;
          renderTree();
        }
      }
      const was = shown;
      if (!was) return;
      const file = await fetch(`${api}/file?path=${encodeURIComponent(was.path)}`, { cache: 'no-store', headers: was.etag ? { 'if-none-match': was.etag } : {} }).catch(() => null);
      if (shown !== was) return;
      const fileOutcome = checkOutcome(file?.status ?? null);
      if (fileOutcome === 'newer') {
        was.etag = file!.headers.get('etag');
        const newer = await file!.arrayBuffer();
        if (shown !== was) return;
        if (was.stored) was.stored = new Uint8Array(newer.slice(0));
        viewer?.reload(newer);
      } else if (fileOutcome === 'signedOut') {
        end('signedOut');
      } else if (fileOutcome === 'ended') {
        // The folder is still shared (its tree was just read), so only this file went.
        close();
        sayIn(docEl, t('viewer.fileGone'));
      }
      // Unchanged, offline or a server error: what is shown stays, and the next check tries again.
    } catch {
      // Broke off on the way: tried again next time.
    } finally {
      checking = false;
    }
  }

  function end(outcome: 'ended' | 'signedOut'): void {
    // Access is over: the document goes, pages, text and worker with it, and the tree, and nothing more is asked.
    ended = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onShown);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('popstate', onPopState);
    close();
    document.title = PAGE_TITLE;
    if (outcome === 'ended') say(gone);
    else signInHere();
  }

  const onShown = (): void => void check();
  // F6 moves between the tree (with the bar) and the document.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'F6' || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const inTree = nav.contains(document.activeElement) || head.contains(document.activeElement);
    if (inTree) docEl.querySelector<HTMLElement>('.wm-viewer-input')?.focus();
    else focusTree();
  };
  const onPopState = (): void => {
    const here = new URLSearchParams(location.search).get('path') ?? firstFile(tree.files)?.path ?? '';
    void go(here, headingOf(location.hash), false);
  };
  const timer = setInterval(() => void check(), isPublic ? PUBLIC_CHECK_MS : CHECK_MS);
  document.addEventListener('visibilitychange', onShown);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('popstate', onPopState);

  renderTree();
  const asked = params.get('path');
  const start = asked ?? firstFile(tree.files)?.path ?? '';
  // The address names the file shown, so it can be shared or bookmarked.
  if (!asked && start) history.replaceState(null, '', urlFor(start, headingOf(location.hash)));
  await go(start, headingOf(location.hash), false);
}
