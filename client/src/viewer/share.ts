// The site's page for a document shared view-only (/view/?doc=<id>, view/index.html): the embeddable viewer, hosted by the site
// itself as satchel hosts it in a frame (one viewer, two hosts). The app sends a person here when they open a document shared with
// them as a viewer (`openShared` in main.ts). The page reads the file with the person's own session, and the server refuses them any
// change whatever the page does (a viewer's share, see server/src/sharing.ts).
//
// What it shows is the latest save, not each keystroke: it asks every half minute, and when the tab is looked at again, whether the
// file has changed (`If-None-Match`, answered 304 while it hasn't), and shows the newer one in place (`Viewer.reload`). While it is
// being edited the file is saved within seconds of each change (an editor's autosave, or a shared room's snapshot), so it catches up. See docs/architecture/viewer.md.

import { loadLocale, pickLocale, t } from '../i18n/index.ts';
import { h } from '../ui/dom.ts';
import { mount, type Viewer } from './viewer.ts';

/** How often the file is checked for a newer save while the page is in view. */
const CHECK_MS = 30_000;

interface SharedEntry {
  id: string;
  name: string;
  role: 'editor' | 'viewer';
}

/** A message in place of the document, with a link when there is something to do about it. */
function say(text: string, link?: { href: string; text: string }): void {
  const status = h('div', { class: 'wm-viewer-status', attrs: { role: 'status' } }, h('p', { text }));
  if (link) status.append(h('p', {}, Object.assign(h('a', { class: 'wm-button', text: link.text }), { href: link.href })));
  document.body.replaceChildren(h('div', { class: 'wm-viewer' }, h('div', { class: 'wm-viewer-view' }, status)));
}

async function start(): Promise<void> {
  const locale = pickLocale(navigator.languages ?? [navigator.language]);
  await loadLocale(locale).catch(() => undefined);
  document.documentElement.lang = locale;
  const id = new URLSearchParams(location.search).get('doc') ?? '';
  // Opening it in the app signs the person in first, and sends them back here.
  const inApp = { href: `/?doc=${encodeURIComponent(`shared:${id}`)}`, text: t('viewer.signIn') };
  if (!/^[\w-]+$/.test(id)) return say(t('app.sharedGone'));

  let entry: SharedEntry | undefined;
  let file: Response;
  try {
    const listing = await fetch('/api/shared', { cache: 'no-store' });
    if (listing.status === 401) return say(t('viewer.signInToView'), inApp);
    if (!listing.ok) throw new Error(`HTTP ${listing.status}`);
    entry = ((await listing.json()) as SharedEntry[]).find((d) => d.id === id);
    if (!entry) return say(t('app.sharedGone'));
    // Someone who may edit it is sent back to the app.
    if (entry.role !== 'viewer') return location.replace(`/?doc=${encodeURIComponent(`shared:${id}`)}`);
    file = await fetch(`/api/documents/${id}`, { cache: 'no-store' });
    if (file.status === 404) return say(t('app.sharedGone'));
    if (!file.ok) throw new Error(`HTTP ${file.status}`);
  } catch (error) {
    return say(t('app.openSharedFailed', { message: (error as Error).message }));
  }

  const title = t('viewer.viewOnlyTitle', { name: entry.name });
  document.title = title;
  let etag = file.headers.get('etag');
  const viewer: Viewer = mount(document.body, {
    bytes: await file.arrayBuffer(),
    name: entry.name,
    fontBase: '/fonts/',
    dark: matchMedia('(prefers-color-scheme: dark)').matches,
    locale,
    title,
    onError: (message) => console.error(message),
    // The page is the site's: a link opens in a tab of its own.
    onLink: (url) => void window.open(url, '_blank', 'noopener,noreferrer'),
  });

  let checking = false;
  const check = async (): Promise<void> => {
    if (checking || document.visibilityState !== 'visible') return;
    checking = true;
    try {
      const response = await fetch(`/api/documents/${id}`, { cache: 'no-store', headers: etag ? { 'if-none-match': etag } : {} });
      if (response.status === 200) {
        etag = response.headers.get('etag');
        viewer.reload(await response.arrayBuffer());
      }
      // 304: unchanged. Anything else (offline, no longer shared): what is shown stays.
    } catch {
      // Offline: tried again next time.
    } finally {
      checking = false;
    }
  };
  setInterval(() => void check(), CHECK_MS);
  document.addEventListener('visibilitychange', () => void check());
}

void start();
