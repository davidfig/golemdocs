// The questions page view asks (docs/html-pages.md §1): may a page from elsewhere read these folders, is it the person's own, and may
// it open an address on the web while it may read their documents.

import { t } from '../i18n/index.ts';
import { h } from '../ui/dom.ts';
import { showChoice } from '../ui/popup.ts';
import type { PageAsks } from './compose.ts';

const folderName = (folder: string): string => (folder ? `${folder}/` : t('pages.ask.wholeVault'));

/** Whether a page from elsewhere may read the folders it asks for: once, always on this device, or not. */
export function askReads(name: string, folders: readonly string[]): Promise<'once' | 'always' | null> {
  const body = h('div', {}, h('p', { text: t('pages.ask.body', { name }) }), h('ul', { class: 'wm-script-grant' }, ...folders.map((f) => h('li', { text: folderName(f) }))), h('p', { class: 'wm-hint', text: t('pages.ask.hint') }));
  return showChoice<'once' | 'always'>(t('pages.ask.title'), body, [
    { label: t('pages.ask.once'), value: 'once' },
    { label: t('pages.ask.always'), value: 'always', primary: true },
  ]);
}

/** Whether a page from elsewhere is the person's own after all. */
export async function confirmMine(name: string, asks: PageAsks): Promise<boolean> {
  const sites = asks.network.map((site) => h('li', { text: t('live.script.network', { site }) }));
  const body = h('div', {}, h('p', { text: t('pages.mine.body', { name }) }), sites.length ? h('ul', { class: 'wm-script-grant' }, ...sites) : null);
  return (await showChoice(t('pages.mine.title'), body, [{ label: t('pages.mine.confirm'), value: true, primary: true }], { role: 'alertdialog' })) === true;
}

/** Whether a page from elsewhere that may read the person's documents may open an address. */
export async function confirmLink(name: string, href: string): Promise<boolean> {
  const body = h('div', {}, h('p', { text: t('pages.link.body', { name }) }), h('p', { class: 'wm-page-link', text: href }));
  return (await showChoice(t('pages.link.title'), body, [{ label: t('pages.link.open'), value: true, primary: true }], { role: 'alertdialog' })) === true;
}
