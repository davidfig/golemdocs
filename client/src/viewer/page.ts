// What the site's viewer pages share (share.ts for a document, folderPage.ts for a folder): a message in place of the document, the
// app's High Contrast choice, and Download.

import { h } from '../ui/dom.ts';
import { FORMATS, kindFromName } from '../ui/formats.ts';
import { LoadingScreen } from '../ui/loadingScreen.ts';
import { saveFile } from '../ui/saveFile.ts';
import { ConvertWorker, startConvertWorker } from '../desktop/convertClient.ts';

/** How often the file is checked for a newer save while the page is in view. */
export const CHECK_MS = 30_000;
/** The same for a public link, which may be open in many places at once (every visitor of a page embedding it). */
export const PUBLIC_CHECK_MS = 120_000;

/** The page's own title, put back when the document is taken away. */
export const PAGE_TITLE = document.title;

/** A message, in `el` (the viewer's place); returns where to put anything more (the sign-in buttons). */
export function sayIn(el: HTMLElement, text: string): HTMLElement {
  const more = h('div');
  const status = h('div', { class: 'wm-viewer-status', attrs: { role: 'status' } }, h('div', {}, h('p', { text }), more));
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

/** A message in place of the whole page. */
export const say = (text: string): HTMLElement => sayIn(document.body, text);

/**
 * The person chose High Contrast in the app (`golem.theme`, ui/theme.ts, which this page doesn't load: it would restyle the page
 * as the app). The site's page shares the app's storage; Screen Reader Mode (`golem.screenReader`) is read by the viewer itself.
 */
export function highContrast(): boolean {
  try {
    return localStorage.getItem('golem.theme') === 'contrast';
  } catch {
    return false;
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
