// What the site's viewer pages share (share.ts for a document, folderPage.ts for a folder): a message in place of the document or the
// page, the person's own colors, printing, and Download.

import { t } from '../i18n/index.ts';
import { h } from '../ui/dom.ts';
import { FORMATS, kindFromName } from '../ui/formats.ts';
import { LoadingScreen } from '../ui/loadingScreen.ts';
import { printPdf } from '../ui/printPdf.ts';
import { saveFile } from '../ui/saveFile.ts';
import { pagesDark } from '../ui/theme.ts';
import { ConvertWorker, startConvertWorker } from '../desktop/convertClient.ts';
import { brandLink } from './pageHeader.ts';
import type { Viewer } from './viewer.ts';

/** How often the file is checked for a newer save while the page is in view. */
export const CHECK_MS = 30_000;
/** The same for a public link, which may be open in many places at once (every visitor of a page embedding it). */
export const PUBLIC_CHECK_MS = 120_000;

/** The page's own title, put back when the document is taken away. */
export const PAGE_TITLE = document.title;

/** A message, in `el` (the viewer's place); returns where to put anything more (the sign-in buttons). */
export function sayIn(el: HTMLElement, text: string): HTMLElement {
  const more = h('div', { class: 'wm-viewer-more' });
  const status = h('div', { class: 'wm-viewer-status', attrs: { role: 'status' } }, h('div', { class: 'wm-viewer-card' }, h('p', { text }), more));
  el.replaceChildren(h('div', { class: 'wm-viewer' }, h('div', { class: 'wm-viewer-view' }, status)));
  return more;
}

/** How long a load goes on before the loading screen's box shows (its delay in loadingScreen.css). */
const LOADING_DELAY_MS = 400;

/**
 * The editor's loading screen over `el` while `name` downloads, before the viewer has it. The returned function takes it away and
 * says whether the person has been kept waiting (the box was showing), so the viewer's own loading screen carries on at once.
 */
export function downloading(el: HTMLElement, name: string): () => boolean {
  const screen = new LoadingScreen(el);
  const started = performance.now();
  screen.show(name);
  return () => {
    screen.hide();
    return performance.now() - started >= LOADING_DELAY_MS;
  };
}

/**
 * A message in place of the whole page, under Golem Docs' header: a link that no longer works, a folder no longer shared, a failure.
 * With `home`, a button to Golem Docs under it, so the page is not a dead end; returns where to put anything more (the sign-in buttons).
 */
export function say(text: string, home = true): HTMLElement {
  const header = h('header', { class: 'wm-viewer-header' }, brandLink());
  const place = h('div', { class: 'wm-site-doc' });
  document.body.replaceChildren(h('div', { class: 'wm-viewer wm-site-page' }, header, place));
  const more = sayIn(place, text);
  if (home) more.append(h('a', { class: 'wm-button', text: t('viewer.goToGolemDocs'), attrs: { href: '/home' } }));
  return more;
}

/**
 * The colors the person chose in the app (ui/theme.ts, which this page shares the storage of: scheme, light or dark, High Contrast),
 * for `mount`'s `hostTheme`; `dark` is whether the pages are dark too (the app's Dark Pages).
 */
export const siteTheme = (): { hostTheme: true; dark: boolean } => ({ hostTheme: true, dark: pagesDark() });

/**
 * The bar's Print: the document shown, made into a PDF by the viewer's worker (as the editor's File › Print makes it), printed as the
 * app prints (ui/printPdf.ts). What happened is said through `tell` where the page can't show it otherwise.
 */
export async function printShown(viewer: Viewer, name: string, tell: (text: string) => void): Promise<void> {
  const pdfName = `${name.replace(/\.[^.]*$/, '') || 'document'}.pdf`;
  try {
    const outcome = await printPdf(pdfName, await viewer.pdf());
    if (outcome === 'preview') tell(t('app.printInPreview'));
    else if (outcome === 'saved') tell(t('app.printSavedInstead', { name: pdfName }));
    else if (outcome === 'blocked') tell(t('app.allowPopups'));
  } catch (error) {
    tell(t('app.printFailed', { message: (error as Error).message }));
  }
}

let converter: ConvertWorker | null = null;

/**
 * A stored document as the file its name says (the account keeps a .wdoc: `toVaultFile` turns it into that file, in the vault's
 * convert worker, started only when it is first asked for); null if it can't be converted.
 */
export const toFile = (bytes: Uint8Array, name: string): Promise<Uint8Array | null> => (converter ??= new ConvertWorker(startConvertWorker)).toFile(bytes, name);

/** Saves a stored document as the file its name says (`toFile`). */
export function downloader(): (bytes: Uint8Array, name: string) => Promise<void> {
  return async (bytes, name) => {
    try {
      const out = (await toFile(bytes, name)) ?? bytes;
      await saveFile(name, out, FORMATS[kindFromName(name)].mime);
    } catch (error) {
      console.error(error);
    }
  };
}
