// The site's page for a document shared view-only (/view?s=<token>, view/index.html): the embeddable viewer, hosted by the site
// itself as satchel hosts it in a frame (one viewer, two hosts). The app sends a person here when they open a document shared with
// them as a viewer (`openShared` in main.ts). The address is the share's own random token (`shares.view_token`), never the document's
// id, and so is everything the page asks for (`/api/view/<token>`); the server answers it only for the person it was shared with, and
// refuses them any change whatever the page does (see server/src/sharing.ts).
//
// A document's public link is the same page at /view?p=<token> (`public_links.token`, read from `/api/public/<token>`): anyone may
// open it, signed in or not, and it has a Download button, which saves the document as the file its name says (the account keeps
// a .wdoc: `toVaultFile` turns it into that file, in the vault's convert worker, started only when it is first clicked). Other sites embed it in a frame as /view?p=<token>&embed, which shows the
// document's name alone in the bar.
//
// What it shows is the latest save, not each keystroke: it asks every half minute, and when the tab is looked at again, whether the
// file has changed (`If-None-Match`, answered 304 while it hasn't), and shows the newer one in place (`Viewer.reload`). While it is
// being edited the file is saved within seconds of each change (an editor's autosave, or a shared room's snapshot), so it catches
// up. See docs/architecture/viewer.md.
//
// A shared folder is the same page at /view?f=<token> (a person's view-only share) or /view?pf=<token> (its public link), with
// `&path=` for the file shown: see folderPage.ts.

import { loadLocale, pickLocale, t } from '../i18n/index.ts';
import { mountSignIn } from '../ui/signIn.ts';
import { showFolder } from './folderPage.ts';
import { CHECK_MS, downloader, highContrast, PAGE_TITLE, PUBLIC_CHECK_MS, say } from './page.ts';
import { checkOutcome } from './protocol.ts';
import { mount, type Viewer } from './viewer.ts';

async function start(): Promise<void> {
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
  const signInHere = (): void => void mountSignIn(say(t('viewer.signInToView')), `/view?s=${encodeURIComponent(token)}`);

  let name: string;
  let file: Response;
  try {
    const info = await fetch(api, { cache: 'no-store' });
    if (info.status === 401) return signInHere();
    // Unknown, someone else's, or no longer shared view-only: all the same to the page.
    if (info.status === 404) return void say(gone);
    if (!info.ok) throw new Error(`HTTP ${info.status}`);
    name = ((await info.json()) as { name: string }).name;
    file = await fetch(`${api}/file`, { cache: 'no-store' });
    if (file.status === 404) return void say(gone);
    if (!file.ok) throw new Error(`HTTP ${file.status}`);
  } catch (error) {
    return void say(t('app.openSharedFailed', { message: (error as Error).message }));
  }

  const title = embedded ? name : t('viewer.viewOnlyTitle', { name });
  document.title = title;
  let etag = file.headers.get('etag');
  const bytes = await file.arrayBuffer();
  // A copy for Download: the viewer is handed the bytes, which go to its worker.
  let stored = isPublic ? new Uint8Array(bytes.slice(0)) : null;
  const save = downloader();
  const download = async (): Promise<void> => {
    if (stored) await save(stored, name);
  };
  const viewer: Viewer = mount(document.body, {
    bytes,
    name,
    fontBase: '/fonts/',
    dark: matchMedia('(prefers-color-scheme: dark)').matches,
    locale,
    title,
    contrast: highContrast(),
    onError: (message) => console.error(message),
    onDownload: isPublic ? () => void download() : undefined,
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
  // A tab looked at again checks at once: one whose access ended while it was in the background clears as soon as it is seen.
  const onShown = (): void => void check();
  document.addEventListener('visibilitychange', onShown);
}

void start();
