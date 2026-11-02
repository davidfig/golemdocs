// The site's page for a document shared view-only (/view/?s=<token>, view/index.html): the embeddable viewer, hosted by the site
// itself as satchel hosts it in a frame (one viewer, two hosts). The app sends a person here when they open a document shared with
// them as a viewer (`openShared` in main.ts). The address is the share's own random token (`shares.view_token`), never the document's
// id, and so is everything the page asks for (`/api/view/<token>`); the server answers it only for the person it was shared with, and
// refuses them any change whatever the page does (see server/src/sharing.ts).
//
// What it shows is the latest save, not each keystroke: it asks every half minute, and when the tab is looked at again, whether the
// file has changed (`If-None-Match`, answered 304 while it hasn't), and shows the newer one in place (`Viewer.reload`). While it is
// being edited the file is saved within seconds of each change (an editor's autosave, or a shared room's snapshot), so it catches
// up. See docs/architecture/viewer.md.

import { loadLocale, pickLocale, t } from '../i18n/index.ts';
import { h } from '../ui/dom.ts';
import { mountSignIn } from '../ui/signIn.ts';
import { checkOutcome } from './protocol.ts';
import { mount, type Viewer } from './viewer.ts';

/** How often the file is checked for a newer save while the page is in view. */
const CHECK_MS = 30_000;

/** A message in place of the document; returns where to put anything more (the sign-in buttons). */
function say(text: string): HTMLElement {
  const more = h('div');
  const status = h('div', { class: 'wm-viewer-status', attrs: { role: 'status' } }, h('div', {}, h('p', { text }), more));
  document.body.replaceChildren(h('div', { class: 'wm-viewer' }, h('div', { class: 'wm-viewer-view' }, status)));
  return more;
}

/** The page's own title, put back when the document is taken away. */
const PAGE_TITLE = document.title;

async function start(): Promise<void> {
  const locale = pickLocale(navigator.languages ?? [navigator.language]);
  await loadLocale(locale).catch(() => undefined);
  document.documentElement.lang = locale;
  const token = new URLSearchParams(location.search).get('s') ?? '';
  if (!/^[\w-]+$/.test(token)) return void say(t('app.sharedGone'));
  const api = `/api/view/${encodeURIComponent(token)}`;
  // Signing in comes straight back here.
  const signInHere = (): void => void mountSignIn(say(t('viewer.signInToView')), `/view/?s=${encodeURIComponent(token)}`);

  let name: string;
  let file: Response;
  try {
    const info = await fetch(api, { cache: 'no-store' });
    if (info.status === 401) return signInHere();
    // Unknown, someone else's, or no longer shared view-only: all the same to the page.
    if (info.status === 404) return void say(t('app.sharedGone'));
    if (!info.ok) throw new Error(`HTTP ${info.status}`);
    name = ((await info.json()) as { name: string }).name;
    file = await fetch(`${api}/file`, { cache: 'no-store' });
    if (file.status === 404) return void say(t('app.sharedGone'));
    if (!file.ok) throw new Error(`HTTP ${file.status}`);
  } catch (error) {
    return void say(t('app.openSharedFailed', { message: (error as Error).message }));
  }

  const title = t('viewer.viewOnlyTitle', { name });
  document.title = title;
  let etag = file.headers.get('etag');
  const viewer: Viewer = mount(document.body, {
    bytes: await file.arrayBuffer(),
    name,
    fontBase: '/fonts/',
    dark: matchMedia('(prefers-color-scheme: dark)').matches,
    locale,
    title,
    onError: (message) => console.error(message),
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
        viewer.reload(await response!.arrayBuffer());
      } else if (outcome === 'ended' || outcome === 'signedOut') {
        // Access is over: the document goes, pages, text and worker with it (not just hidden), and nothing more is asked.
        ended = true;
        clearInterval(timer);
        document.removeEventListener('visibilitychange', onShown);
        viewer.destroy();
        document.title = PAGE_TITLE;
        if (outcome === 'ended') say(t('app.sharedGone'));
        else signInHere();
      }
      // Unchanged, offline or a server error: what is shown stays, and the next check tries again.
    } catch {
      // The newer file broke off on the way: tried again next time.
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => void check(), CHECK_MS);
  // A tab looked at again checks at once: one whose access ended while it was in the background clears as soon as it is seen.
  const onShown = (): void => void check();
  document.addEventListener('visibilitychange', onShown);
}

void start();
