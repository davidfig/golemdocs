// Page view (docs/html-pages.md §2): an HTML page shown in a sandboxed frame over the document area, under a bar the page cannot
// draw over. The bar names the file and where it came from, switches to the page's document or source, and, for a page from
// elsewhere, offers to let it read or to mark it as the person's own. The frame has an opaque origin (no `allow-same-origin`):
// no cookies, storage or account, and no way into the app but messages, which only come from this frame and are all checked.

import { t } from '../i18n/index.ts';
import { h } from '../ui/dom.ts';
import { pageBar } from './pageBar.ts';
import type { PageBar } from './pageBar.ts';
import { frameMessage, newToken } from './compose.ts';
import type { PageTrust } from './compose.ts';
import type { PageView as PageViewKind } from './trust.ts';
import './pages.css';

export interface PageShow {
  name: string;
  /** The frame's whole page (composePage) for one load, given that load's secret (`RuntimeStart.token`). */
  compose(token: string): string;
  trust: PageTrust;
  /** Its scripts run (an own page, or a foreign one that may read nothing). */
  scripts: boolean;
  /** It may post forms (an own page in the app; never one from elsewhere or one shared with the viewer). */
  forms: boolean;
  /** For a foreign page: what it asks to read, and whether that was allowed. */
  asks: string[];
  allowed: boolean;
  /** Shown to someone it is shared with (the site's viewer): its name only, no trust, choices or views. */
  shared?: boolean;
}

export interface PageViewHooks {
  /** A `golem` call from the page; resolves with what to send back, rejects with why not. */
  request(op: string, args: unknown[]): Promise<unknown>;
  /** A link in the page was followed. */
  navigate(href: string): void;
  /** Page, Document or Source was picked. */
  view(view: PageViewKind): void;
  markMine(): void;
  allowReads(): void;
}

export class PageViewer {
  readonly el: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly title: HTMLElement;
  private readonly badge: HTMLElement;
  private readonly note: HTMLElement;
  private readonly mineButton: HTMLButtonElement;
  private readonly allowButton: HTMLButtonElement;
  private readonly views: PageBar;
  private frame: HTMLIFrameElement | null = null;
  private shown: PageShow | null = null;
  /** Loads of the frame still expected from setting its page; any other is the page moving itself on. */
  private expectedLoads = 0;
  /** The secret of the frame's current load; null while it is leaving (nothing is answered then). A new one each load. */
  private token: string | null = null;
  /** Where the page was scrolled to, kept through a reload. */
  scrollY = 0;
  private readonly onMessage = (e: MessageEvent): void => this.message(e);

  constructor(
    parent: HTMLElement,
    private readonly hooks: PageViewHooks,
  ) {
    this.el = h('div', { class: 'wm-page-view', attrs: { role: 'region', tabindex: '-1' } });
    this.el.hidden = true;
    this.views = pageBar((view) => this.hooks.view(view));
    this.title = this.views.title;
    this.badge = h('span', { class: 'wm-page-badge' });
    this.views.extras.append(this.badge);
    this.allowButton = h('button', { class: 'wm-button', text: t('pages.allowReads'), attrs: { type: 'button' } });
    this.allowButton.addEventListener('click', () => this.hooks.allowReads());
    this.mineButton = h('button', { class: 'wm-button', text: t('pages.markMine'), attrs: { type: 'button' } });
    this.mineButton.addEventListener('click', () => this.hooks.markMine());
    this.note = h('div', { class: 'wm-page-note', attrs: { role: 'status' } });
    this.views.actions.append(this.allowButton, this.mineButton);
    this.bar = this.views.el;
    this.el.append(this.bar, this.note);
    parent.append(this.el);
  }

  get active(): boolean {
    return this.shown !== null;
  }

  get name(): string | null {
    return this.shown?.name ?? null;
  }

  get trust(): PageTrust | null {
    return this.shown?.trust ?? null;
  }

  /** What the automation API reports. */
  state(): { active: boolean; name: string | null; trust: PageTrust | null; scripts: boolean; allowed: boolean; asks: string[] } {
    return { active: this.active, name: this.name, trust: this.trust, scripts: this.shown?.scripts ?? false, allowed: this.shown?.allowed ?? false, asks: this.shown?.asks ?? [] };
  }

  /** Shows a page (or shows it again, after it or its trust changed), keeping its scroll position when `keepScroll`. */
  show(page: PageShow, keepScroll = false): void {
    if (!keepScroll) this.scrollY = 0;
    this.shown = page;
    this.el.hidden = false;
    this.el.setAttribute('aria-label', page.name);
    this.title.textContent = page.name;
    this.badge.textContent = page.trust === 'own' ? t('pages.trust.own') : t('pages.trust.foreign');
    this.badge.classList.toggle('wm-page-badge-foreign', page.trust === 'foreign');
    this.badge.hidden = !!page.shared;
    this.views.switch.hidden = !!page.shared;
    this.mineButton.hidden = page.trust === 'own' || !!page.shared;
    this.allowButton.hidden = page.trust === 'own' || page.allowed || !page.asks.length || !!page.shared;
    this.note.textContent =
      page.trust === 'own' ? '' : page.allowed ? t('pages.note.foreignReads', { folders: page.asks.map((f) => f || '/').join(', ') }) : page.asks.length ? t('pages.note.foreignAsks', { folders: page.asks.map((f) => f || '/').join(', ') }) : t('pages.note.foreign');
    this.note.hidden = page.trust === 'own' || !!page.shared;
    this.views.setView('page');
    this.frame?.remove();
    // A new frame each time: whatever the last page left running ends with it.
    const frame = h('iframe', { class: 'wm-page-frame', attrs: { title: page.name, referrerpolicy: 'no-referrer' } });
    // Scripts only where they may run; forms only for an own page (the policy's form-action says where to).
    frame.setAttribute('sandbox', [page.scripts ? 'allow-scripts' : '', page.scripts && page.forms ? 'allow-forms' : ''].filter(Boolean).join(' '));
    this.frame = frame;
    this.expectedLoads = 1;
    frame.addEventListener('load', () => {
      if (this.frame !== frame) return;
      if (this.expectedLoads > 0) {
        this.expectedLoads--;
        return;
      }
      // The page went somewhere else in its frame: it is shown again as it is, not wherever it went, with a new secret.
      this.expectedLoads = 1;
      this.token = newToken();
      frame.srcdoc = this.shown!.compose(this.token);
    });
    this.token = newToken();
    frame.srcdoc = page.compose(this.token);
    this.el.append(frame);
    window.removeEventListener('message', this.onMessage);
    window.addEventListener('message', this.onMessage);
  }

  /** Sends the page what its embeds now show, and that something it read changed. */
  update(filled: Record<string, string>, detail: unknown): void {
    const target = this.frame?.contentWindow;
    const token = this.token;
    if (!target || !token || !this.shown?.scripts) return;
    target.postMessage({ golem: 1, token, type: 'embeds', filled }, '*');
    target.postMessage({ golem: 1, token, type: 'changed', detail }, '*');
  }

  focus(): void {
    this.el.focus();
  }

  /** Hides the page (it may be shown again). */
  close(): void {
    window.removeEventListener('message', this.onMessage);
    this.frame?.remove();
    this.frame = null;
    this.token = null;
    this.shown = null;
    this.el.hidden = true;
  }

  /** Done with it for good: closed, and its element taken out of the page. */
  destroy(): void {
    this.close();
    this.el.remove();
  }

  private message(e: MessageEvent): void {
    const frame = this.frame;
    // Only this frame, only messages shaped like the runtime's, and only with this load's secret: anything else is ignored.
    const token = this.token;
    const m = frame && e.source === frame.contentWindow ? frameMessage(e.data, token) : null;
    if (!frame || !m) return;
    // Answered only while the same load is there: not to whatever the frame went on to meanwhile.
    const reply = (body: { ok: true; value: unknown } | { ok: false; error: string }) => {
      if (this.frame === frame && token && this.token === token) frame.contentWindow?.postMessage({ golem: 1, token, type: 'reply', id: m.id, ...body }, '*');
    };
    switch (m.type) {
      case 'request':
        if (typeof m.id !== 'number' || typeof m.op !== 'string') return;
        void this.hooks.request(m.op, Array.isArray(m.args) ? m.args : []).then(
          (value) => reply({ ok: true, value }),
          (error: unknown) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
        );
        return;
      case 'navigate':
        if (typeof m.href === 'string') this.hooks.navigate(m.href);
        return;
      case 'scroll':
        if (typeof m.y === 'number' && Number.isFinite(m.y)) this.scrollY = Math.max(0, m.y);
        return;
      case 'leaving':
        // The page is going (it reloads, or moves on): nothing more is answered until it is shown again, with a new secret.
        this.token = null;
        return;
      case 'escape':
        // Out of the page to its region (F6 and Tab go on from there); never onto one of the bar's buttons, where a page could
        // otherwise put the next key the person presses.
        this.el.focus();
        return;
    }
  }
}
