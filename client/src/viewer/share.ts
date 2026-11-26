// The site's page for a document shared view-only (/view?s=<token>, view/index.html): the embeddable viewer, hosted by the site
// itself as satchel hosts it in a frame (one viewer, two hosts). The app sends a person here when they open a document shared with
// them as a viewer (`openShared` in main.ts). The address is the share's own random token (`shares.view_token`), never the document's
// id, and so is everything the page asks for (`/api/view/<token>`); the server answers it only for the person it was shared with, and
// refuses them any change whatever the page does (see server/src/sharing.ts).
//
// A document's public link is the same page at /view?p=<token> (`public_links.token`, read from `/api/public/<token>`): anyone may
// open it, signed in or not. Both have a Download button (a person who can view it could read it anyway), which saves the document as the file its name says (the account keeps
// a .wdoc: `toVaultFile` turns it into that file, in the vault's convert worker, started only when it is first clicked). Other sites embed it in a frame as /view?p=<token>&embed, which shows the
// document's name alone in the bar.
//
// What it shows is the latest save, not each keystroke. The document's room tells the page of each save over a live line (live.ts),
// and the page then asks for the file (`If-None-Match`, answered 304 while it hasn't changed) and shows the newer one in place
// (`Viewer.reload`). While it is being edited the file is saved within seconds of each change (an editor's autosave, or a shared
// room's snapshot), so it follows the edits. It also asks every half minute, and when the tab is looked at again, which is how it
// hears that access ended and how it keeps up without the line. See docs/architecture/viewer.md.
//
// A shared folder is the same page at /view?f=<token> (a person's view-only share) or /view?pf=<token> (its public link), with
// `&path=` for the file shown: see folderPage.ts.
//
// /view?frame is the embeddable viewer waiting for a file by message (./host.ts): the app frames it to show a document in its trash.

import { loadLocale, pickLocale, t } from '../i18n/index.ts';
import { mountSignIn } from '../ui/signIn.ts';
import { showFolder } from './folderPage.ts';
import { savedViewMode } from '../ui/viewMode.ts';
import { CHECK_MS, downloader, downloading, PAGE_TITLE, printShown, PUBLIC_CHECK_MS, say, siteTheme } from './page.ts';
import { brandLink, PageHeader, type Sharer } from './pageHeader.ts';
import { hostViewer } from './host.ts';
import { followSaves } from './live.ts';
import { checkOutcome } from './protocol.ts';
import { h } from '../ui/dom.ts';
import { mount, type Viewer } from './viewer.ts';

async function start(): Promise<void> {
  // Framed by the app, which sends the file itself (a document in the trash: ui/trashPreview.ts). The words come with it.
  if (new URLSearchParams(location.search).has('frame')) return hostViewer();
  const locale = pickLocale(navigator.languages ?? [navigator.language]);
  await loadLocale(locale).catch(() => undefined);
  document.documentElement.lang = locale;
  const params = new URLSearchParams(location.search);
  // A shared folder: its files, and links between them (folderPage.ts).
  if (params.has('f') || params.has('pf')) return showFolder(params, locale);
  const isPublic = params.has('p');
  const embedded = isPublic && params.has('embed');
  const token = params.get(isPublic ? 'p' : 's') ?? '';
  const gone = isPublic ? t('viewer.linkGone') : t('app.sharedGone');
  if (!/^[\w-]+$/.test(token)) return void say(gone);
  const api = `/api/${isPublic ? 'public' : 'view'}/${encodeURIComponent(token)}`;
  // Signing in comes straight back here.
  const signInHere = (): void => void mountSignIn(say(t('viewer.signInToView'), false), `/view?s=${encodeURIComponent(token)}`);

  let name: string;
  let owner: Sharer | undefined;
  let file: Response;
  // The page: Golem Docs' header over the document (embedded in another site's page, the viewer alone).
  const header = embedded ? null : new PageHeader();
  const place = embedded ? document.body : h('div', { class: 'wm-site-doc' });
  // The loading screen, from when the file is asked for until its last byte is in.
  let loaded = (): boolean => false;
  try {
    const info = await fetch(api, { cache: 'no-store' });
    if (info.status === 401) return signInHere();
    // Unknown, someone else's, or no longer shared view-only: all the same to the page.
    if (info.status === 404) return void say(gone);
    if (!info.ok) throw new Error(`HTTP ${info.status}`);
    ({ name, owner } = (await info.json()) as { name: string; owner?: Sharer });
    if (header) {
      header.setTitle(name);
      header.setSharer(owner);
      document.body.replaceChildren(h('div', { class: 'wm-viewer wm-site-page' }, header.el, place));
    }
    loaded = downloading(place, name);
    file = await fetch(`${api}/file`, { cache: 'no-store' });
    if (file.status === 404) return void say(gone);
    if (!file.ok) throw new Error(`HTTP ${file.status}`);
  } catch (error) {
    return void say(t('app.openSharedFailed', { message: (error as Error).message }));
  }

  const title = embedded ? name : t('viewer.viewOnlyTitle', { name });
  document.title = title;
  let etag = file.headers.get('etag');
  const bytes = await file.arrayBuffer().catch(() => null);
  const waited = loaded();
  if (!bytes) return void say(t('app.openSharedFailed', { message: '' }));
  // A copy for Download: the viewer is handed the bytes, which go to its worker.
  let stored: Uint8Array | null = new Uint8Array(bytes.slice(0));
  const save = downloader();
  const download = async (): Promise<void> => {
    if (stored) await save(stored, name);
  };
  // Embedded, the bar ends with Golem Docs' mark, which opens the document's own page in a tab.
  const mark = embedded ? brandLink('wm-viewer-mark') : null;
  if (mark) {
    mark.href = `/view?p=${encodeURIComponent(token)}`;
    mark.target = '_blank';
    mark.rel = 'noopener';
    mark.title = t('viewer.openInGolemDocs');
  }
  const viewer: Viewer = mount(place, {
    bytes,
    name,
    fontBase: '/fonts/',
    ...siteTheme(),
    locale,
    title,
    // The header shows the name; embedded, the bar does.
    barTitle: embedded,
    barEnd: mark ? [mark] : [],
    // Embedded in another site's page the viewer stays compact, as in a mail client's pane.
    statusBar: !embedded,
    // Embedded too: the embed code's frame allows it (`allowfullscreen`, ui/shareDialog.ts).
    fullScreen: true,
    view: savedViewMode(),
    waited,
    onError: (message) => console.error(message),
    onDownload: () => void download(),
    // Printing opens the browser's dialog over the page: not in another site's.
    onPrint: embedded ? undefined : () => void printShown(viewer, name, (text) => header?.tell(text)),
    // The page is the site's: a link opens in a tab of its own.
    onLink: (url) => void window.open(url, '_blank', 'noopener,noreferrer'),
  });

  let checking = false;
  let ended = false;
  const check = async (): Promise<void> => {
    if (checking || ended || document.visibilityState !== 'visible') return;
    checking = true;
    try {
      const response = await fetch(`${api}/file`, { cache: 'no-store', headers: etag ? { 'if-none-match': etag } : {} }).catch(() => null);
      const outcome = checkOutcome(response?.status ?? null);
      if (outcome === 'newer') {
        etag = response!.headers.get('etag');
        const newer = await response!.arrayBuffer();
        if (stored) stored = new Uint8Array(newer.slice(0));
        viewer.reload(newer);
      } else if (outcome === 'ended' || outcome === 'signedOut') {
        // Access is over: the document goes, pages, text and worker with it (not just hidden), and nothing more is asked.
        ended = true;
        clearInterval(timer);
        live.stop();
        document.removeEventListener('visibilitychange', onShown);
        viewer.destroy();
        stored = null;
        document.title = PAGE_TITLE;
        if (outcome === 'ended') say(gone);
        else signInHere();
      }
      // Unchanged, offline or a server error: what is shown stays, and the next check tries again.
    } catch {
      // The newer file broke off on the way: tried again next time.
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => void check(), isPublic ? PUBLIC_CHECK_MS : CHECK_MS);
  // Each save, as it goes in.
  const live = followSaves(`${api}/live`, () => void check());
  // A tab looked at again checks at once: one whose access ended while it was in the background clears as soon as it is seen.
  const onShown = (): void => void check();
  document.addEventListener('visibilitychange', onShown);
}

void start();
