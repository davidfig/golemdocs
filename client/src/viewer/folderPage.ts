// The site's page for a shared folder (docs/folder-sharing.md): /view?f=<token> for a person it was shared with view-only, and
// /view?pf=<token> for its public link, which anyone may open. `&path=` names the file shown (a path inside the folder) and the
// address's `#` a heading in it, so every file has an address of its own and Back goes to the one before.
//
// The page has Golem Docs' header (pageHeader.ts) over the folder's files and the viewer, which shows one file at a time. The files are
// the app's Files panel (fileRows.css) holding a tree: a `nav` of nested lists, ordinary links and disclosure sections, so the keyboard
// and a screen reader work it as any page's. A `doc:` link in a file opens the
// folder's file it names, in this tab (`resolveFolderLink`): only the folder's own files are ever found, so a link to anything outside
// it says so and goes nowhere. F6 moves between the tree and the document.
//
// Everything asked for is the share's token and a path in the folder (`/api/folder-view|folder-public/<token>[/file?path=]`), never
// an id. As the document page does, it checks every half minute (two minutes for a public link) and when the tab is looked at again:
// the tree, and the file shown (`If-None-Match`). When access ends the document and tree go and nothing more is asked.
//
// Both pages download and print: the bar's Download saves the file shown and its Print prints it, and the header's Download All saves every file of the
// folder as one ZIP, in its folders, each converted to the file its name says as Download does (`storage/archive.ts`, which the
// app's File › Download All uses too). A person with view access could read every file anyway, so withholding it protects nothing.

import { t } from '../i18n/index.ts';
import { chevronIcon, CLOSE_ICON, h, iconButton } from '../ui/dom.ts';
import { fileIcon, setFileName } from '../ui/fileIcons.ts';
import { BASIC_ICONS, iconSpan } from '../ui/iconKit.ts';
import '../ui/fileRows.css';
import { mountSignIn } from '../ui/signIn.ts';
import { archivePlace, firstFile, folderTree, resolveFolderLink, type TreeFolder } from './folderLinks.ts';
import { archiveFiles, zipDocuments, type ArchiveDoc } from '../storage/archive.ts';
import { saveFile } from '../ui/saveFile.ts';
import { savedViewMode } from '../ui/viewMode.ts';
import { CHECK_MS, downloader, downloading, PAGE_TITLE, printShown, PUBLIC_CHECK_MS, say, sayIn, siteTheme, toFile } from './page.ts';
import { PageHeader, type Sharer } from './pageHeader.ts';
import { sharedPageHtml, showSharedPage, type SharedPage } from './sharedPage.ts';
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
  /** Who shared it: a person's share only (a public link names nobody). */
  owner?: Sharer;
}

/** A panel beside the page: the icon of the Files button. */
const ICON_FILES = 'M1.5 2.5H10.5V9.5H1.5ZM4.5 2.5V9.5';

const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

const headingOf = (hash: string): string => {
  try {
    return decodeURIComponent(hash.replace(/^#/, ''));
  } catch {
    return hash.replace(/^#/, '');
  }
};

/** A row's indent in the tree, as the app's Files panel indents its rows. */
const indent = (depth: number): string => `${6 + depth * 18}px`;

export async function showFolder(params: URLSearchParams, locale: string): Promise<void> {
  const isPublic = params.has('pf');
  const key = isPublic ? 'pf' : 'f';
  const token = params.get(key) ?? '';
  const gone = isPublic ? t('viewer.folderLinkGone') : t('viewer.folderGone');
  if (!/^[\w-]+$/.test(token)) return void say(gone);
  const api = `/api/${isPublic ? 'folder-public' : 'folder-view'}/${encodeURIComponent(token)}`;
  // Signing in comes straight back to the same file.
  const signInHere = (): void => void mountSignIn(say(t('viewer.signInToViewFolder'), false), location.pathname + location.search + location.hash);
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

  // --- The page: Golem Docs' header, the Files panel and the document -------------------------------
  const panel = h('div', { class: 'wm-files wm-folder-files', attrs: { id: 'wm-folder-files' } });
  const nav = h('nav', { class: 'wm-files-tree wm-folder-tree', attrs: { 'aria-label': t('viewer.files') } });
  const docEl = h('div', { class: 'wm-site-doc wm-folder-doc' });
  const toggle = iconButton('wm-tbutton wm-viewer-files', ICON_FILES, t('viewer.files'));
  toggle.setAttribute('aria-controls', panel.id);
  const folderName = h('h2', { class: 'wm-folder-name' });
  const closePanel = iconButton('wm-files-close', CLOSE_ICON, t('panels.files.close'));
  panel.append(h('div', { class: 'wm-files-bar' }, folderName, closePanel), nav);
  // Says what it does in words, beside its icon: Download All isn't plain from an icon alone. Named too, as a phone hides the words.
  const downloadAllButton = h('button', { class: 'wm-tbutton wm-tbutton-words', title: t('viewer.downloadAll'), attrs: { type: 'button', 'aria-label': t('viewer.downloadAll') } }, iconSpan(BASIC_ICONS.downloadAll), h('span', { text: t('viewer.downloadAll') }));
  const header = new PageHeader({ start: [toggle], tools: [downloadAllButton] });
  header.setSharer(tree.owner);
  const head = header.el;
  document.body.replaceChildren(h('div', { class: 'wm-viewer wm-site-page wm-folder-page' }, head, h('div', { class: 'wm-folder-body' }, panel, docEl)));

  const narrow = matchMedia('(max-width: 640px)');
  const setOpen = (open: boolean): void => {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  };
  setOpen(!narrow.matches);
  toggle.addEventListener('click', () => {
    setOpen(panel.hidden);
    if (!panel.hidden) focusTree();
  });
  closePanel.addEventListener('click', () => {
    setOpen(false);
    toggle.focus();
  });

  /** A note in the header; one that stays (`lasting`) is for progress, replaced by the next. */
  const tell = (text: string, lasting = false): void => header.tell(text, lasting);

  // --- Download All ------------------------------------------------------------------------------
  let zipping = false;
  async function downloadAll(): Promise<void> {
    if (zipping || ended) return;
    zipping = true;
    downloadAllButton.setAttribute('aria-disabled', 'true');
    try {
      const files = tree.files;
      if (!files.length) return tell(t('viewer.folderEmpty'));
      const docs: ArchiveDoc[] = [];
      for (const [i, file] of files.entries()) {
        tell(t('viewer.downloadingAll', { done: i + 1, count: files.length }), true);
        const response = await fetch(`${api}/file?path=${encodeURIComponent(file.path)}`, { cache: 'no-store' });
        if (response.status === 401) return end('signedOut');
        // Gone since the tree was read: left out (the next check redraws the tree).
        if (response.status === 404 || response.status === 403) continue;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        docs.push({ ...archivePlace(file.path), bytes: new Uint8Array(await response.arrayBuffer()) });
        if (ended) return;
      }
      tell(t('viewer.zippingAll'), true);
      const converted = await archiveFiles(docs, toFile);
      const zip = await zipDocuments(converted.docs);
      if (ended) return;
      if (await saveFile(`${tree.name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'folder'}.zip`, zip, 'application/zip'))
        tell(converted.kept.length ? t('viewer.downloadedAllSomeKept', { names: converted.kept.join(', ') }) : t('viewer.downloadedAll', { count: docs.length }));
      else tell('');
    } catch (error) {
      if (!ended) tell(t('app.downloadFailed', { message: (error as Error).message }));
    } finally {
      zipping = false;
      downloadAllButton.removeAttribute('aria-disabled');
    }
  }
  downloadAllButton.addEventListener('click', () => void downloadAll());

  // --- The tree ----------------------------------------------------------------------------------
  const links = new Map<string, HTMLAnchorElement>();
  let shownPath = '';
  const markCurrent = (): void => {
    for (const [path, link] of links) {
      link.classList.toggle('wm-files-current', path === shownPath);
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
    const list = (folder: TreeFolder<TreeFile>, depth: number): HTMLElement =>
      h('ul', {}, ...folder.folders.map((f) => h('li', {}, section(f, depth))), ...folder.files.map((file) => h('li', {}, link(file, depth))));
    const section = (folder: TreeFolder<TreeFile>, depth: number): HTMLElement => {
      const summary = h('summary', { class: 'wm-files-row', title: folder.name }, h('span', { class: 'wm-files-twist' }, chevronIcon() as unknown as Node), h('span', { class: 'wm-files-name', text: folder.name }));
      summary.style.paddingLeft = indent(depth);
      const details = h('details', {}, summary, list(folder, depth + 1));
      details.dataset.path = folder.path;
      details.open = !closed.has(folder.path);
      return details;
    };
    const link = (file: TreeFile, depth: number): HTMLElement => {
      const name = fileName(file.path);
      // A file's icon sits in the column of its sibling folders' chevrons, as in the app's Files panel.
      const a = h('a', { class: 'wm-files-row', title: file.path, attrs: { href: urlFor(file.path) } }, fileIcon(name), setFileName(h('span', { class: 'wm-files-name' }), name));
      a.style.paddingLeft = indent(depth);
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
    nav.replaceChildren(empty ? h('p', { class: 'wm-hint', text: t('viewer.folderEmpty') }) : list(top, 0));
    markCurrent();
  }
  const focusTree = (): void => {
    if (panel.hidden) setOpen(true);
    (links.get(shownPath) ?? nav.querySelector<HTMLElement>('a, summary'))?.focus();
  };

  // --- The document ------------------------------------------------------------------------------
  const save = downloader();
  let viewer: Viewer | null = null;
  // An HTML page shows as the page it makes, as on a shared page's own address (sharedPage.ts, docs/html-pages.md §5).
  let page: SharedPage | null = null;
  let shown: { path: string; etag: string | null; stored: Uint8Array | null } | null = null;
  let opening = 0;
  const theme = siteTheme();
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
    page?.destroy();
    page = null;
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
    header.setTitle(name, tree.name);
    // A copy for Download: the viewer is handed the bytes, which go to its worker.
    const opened = { path, etag: response.headers.get('etag'), stored: new Uint8Array(bytes.slice(0)) as Uint8Array | null };
    shown = opened;
    live = followSaves(`${api}/live?path=${encodeURIComponent(path)}`, () => void check());
    docEl.replaceChildren();
    const pageHtml = await sharedPageHtml(new Uint8Array(bytes), name);
    if (ticket !== opening || ended) return;
    if (pageHtml !== null) {
      const shownPage = await showSharedPage(docEl, { results: `${api}/page?path=${encodeURIComponent(path)}`, name, title, html: pageHtml });
      if (ticket !== opening || ended) return shownPage.destroy();
      page = shownPage;
      return;
    }
    const shownViewer = (viewer = mount(docEl, {
      bytes,
      name,
      fontBase: '/fonts/',
      ...theme,
      locale,
      title,
      // The header shows the name.
      barTitle: false,
      fullScreen: true,
      statusBar: true,
      view,
      onView: (picked) => {
        if (picked !== 'grid') view = picked;
      },
      waited,
      heading: section || undefined,
      onError: (message) => console.error(message),
      onDownload: () => void (opened.stored && save(opened.stored, name)),
      onPrint: () => void printShown(shownViewer, name, tell),
      // A web link opens in a tab of its own; a link to another document opens it here, if it is the folder's.
      onLink: (url) => void window.open(url, '_blank', 'noopener,noreferrer'),
      onDocLink: (address) => {
        const found = resolveFolderLink(address, tree.name, tree.files, path);
        if (!found) return tell(t('viewer.notShared'));
        void go(found.file.path, found.section, true);
      },
    }));
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
        const html = await sharedPageHtml(new Uint8Array(newer), fileName(was.path));
        if (shown !== was) return;
        if (page && html !== null) await page.reload(html);
        // It became a page, or stopped being one: opened again, shown as what it is now.
        else if (!!page !== (html !== null)) await go(was.path, '', false);
        else viewer?.reload(newer);
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
    if (inTree) {
      if (viewer) viewer.focus();
      else docEl.querySelector<HTMLElement>('.wm-page-view')?.focus();
    }
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
