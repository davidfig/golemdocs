// An HTML page shared view-only or by its public link (docs/html-pages.md §5), shown as a page on the site's viewer page (share.ts).
// The person it is shared with can't read the owner's vault, so the page shows what its owner's app kept when it last showed the page
// (`/api/view/<token>/page`, `PageResults`): its embeds as they were, and its `golem` reads answered with what they were answered then.
// Anything else it asks for is refused, and it changes nothing. Its frame is sandboxed as in the app (an opaque origin), so whatever
// the page does, it can't reach the reader's session or the site.

import { t } from '../i18n/index.ts';
import { composePage, fillEmbeds, isPageHtml, pageAsks, pageCsp, policyFor } from '../pages/compose.ts';
import type { PageResults } from '../pages/controller.ts';
import { answerKey } from '../pages/answers.ts';
import { PageViewer } from '../pages/view.ts';
import { toFile } from './page.ts';

/** A page's HTML from the stored bytes (a .wdoc when it was last edited as a document); null when it is not a page. */
export async function sharedPageHtml(bytes: Uint8Array, name: string): Promise<string | null> {
  if (!/\.(html?|xhtml)$/i.test(name)) return null;
  const file = bytes[0] === 0x50 && bytes[1] === 0x4b ? await toFile(bytes, name).catch(() => null) : bytes;
  if (!file) return null;
  const html = new TextDecoder().decode(file).replace(/^\uFEFF/, '');
  return isPageHtml(html) ? html : null;
}

/** The results a page's owner kept (read from `url`), or null when there are none. */
async function results(url: string): Promise<PageResults | null> {
  const response = await fetch(url, { cache: 'no-store' }).catch(() => null);
  if (!response?.ok) return null;
  const parsed = (await response.json().catch(() => null)) as PageResults | null;
  return parsed && typeof parsed === 'object' && parsed.embeds && parsed.answers ? parsed : null;
}

export interface SharedPage {
  /** Shows a newer save of the page (and what its owner kept for it). */
  reload(html: string): Promise<void>;
  destroy(): void;
}

/**
 * Shows a shared page in `el`, under a bar with its title. `results` is where what its owner's app kept is read: `<api>/page` for a
 * shared page, `<api>/page?path=` for one in a shared folder.
 */
export async function showSharedPage(el: HTMLElement, spec: { results: string; name: string; title: string; html: string }): Promise<SharedPage> {
  let kept = await results(spec.results);
  const notShared = (): never => {
    throw new Error(t('pages.error.notShared'));
  };
  const view = new PageViewer(el, {
    async request(op, args) {
      if (op === 'edit') throw new Error(t('pages.error.foreignEdit', { name: spec.name }));
      const key = answerKey(op, args);
      return kept && Object.prototype.hasOwnProperty.call(kept.answers, key) ? kept.answers[key] : notShared();
    },
    navigate(href) {
      // A file beside it is in the owner's vault, not here; the web opens in a tab of its own.
      if (/^(https?|mailto):/i.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
    },
    view: () => {},
    markMine: () => {},
    allowReads: () => {},
  });
  const show = (html: string, keepScroll: boolean): void => {
    const missing = `<span class="golem-embed-error" role="note">${t('pages.error.notShared').replace(/</g, '&lt;')}</span>`;
    const filled = new Map<string, string>();
    for (const m of html.matchAll(/<golem-embed\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      const src = (m[1] ?? m[2] ?? '').trim();
      filled.set(src, kept?.embeds[src] ?? missing);
    }
    // The owner's page, run as the owner wrote it, but with nothing of the reader's to read: the policy of an own page.
    const policy = policyFor('own', false, pageAsks(html));
    view.show({ name: spec.title, srcdoc: composePage(fillEmbeds(html, filled), pageCsp(policy), { path: spec.name, trust: 'own', scroll: keepScroll ? Math.round(view.scrollY) : 0 }), trust: 'own', scripts: true, asks: [], allowed: false, shared: true }, keepScroll);
  };
  show(spec.html, false);
  return {
    async reload(html) {
      kept = await results(spec.results);
      show(html, true);
    },
    destroy: () => view.close(),
  };
}
