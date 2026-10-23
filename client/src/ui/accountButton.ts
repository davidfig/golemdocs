// The person icon at the top right, beside the save indicator. It opens a panel with who is
// signed in, their sync subscription, and signing in or out.

import type { Action, ChromeHost, SubscriptionState, SyncStatus } from './actions.ts';
import { avatar } from './avatar.ts';
import { h, setAttr } from './dom.ts';
import { t } from '../i18n/index.ts';
import { sellsSubscriptions } from '../subscription.ts';
import { signInNote } from './signIn.ts';
import { closePopup, openPopup, popupOpenFor } from './popup.ts';

const SVG = 'http://www.w3.org/2000/svg';

/** A head and shoulders in the chrome's ink colour. */
function personIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of [
    ['circle', { cx: '8', cy: '5.2', r: '2.6' }],
    ['path', { d: 'M2.8 14c.4-2.8 2.5-4.4 5.2-4.4s4.8 1.6 5.2 4.4' }],
  ] as const) {
    const part = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attrs)) part.setAttribute(name, value);
    svg.append(part);
  }
  return svg;
}

export class AccountButton {
  readonly el: HTMLButtonElement;
  private status: SyncStatus | null = null;
  private subscription: SubscriptionState | null = null;
  private shownPicture: string | null = null;

  constructor(private readonly host: ChromeHost) {
    this.el = h('button', { class: 'wm-account', title: t('dialogs.account.label'), attrs: { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-label': t('dialogs.account.label') } }, personIcon());
    this.el.addEventListener('mousedown', (e) => e.preventDefault()); // keep the document's focus
    this.el.addEventListener('click', () => {
      if (popupOpenFor(this.el)) closePopup();
      else openPopup(this.el, this.panel(), () => this.host.focusEditor());
    });
  }

  update(status: SyncStatus, subscription: SubscriptionState | null): void {
    const changed = JSON.stringify(status) !== JSON.stringify(this.status) || subscription !== this.subscription;
    this.status = status;
    this.subscription = subscription;
    setAttr(this.el, 'data-signed-in', this.signedIn() ? 'true' : 'false');
    const picture = this.signedIn() ? (status.picture ?? null) : null;
    if (picture !== this.shownPicture) {
      this.shownPicture = picture;
      this.el.replaceChildren(picture ? avatar(picture, status.user, 19) : personIcon());
      setAttr(this.el, 'data-picture', picture ? 'true' : 'false');
    }
    if (changed && popupOpenFor(this.el)) openPopup(this.el, this.panel(), () => this.host.focusEditor());
  }

  private signedIn(): boolean {
    return this.status?.user != null && this.status.document !== 'signedOut';
  }

  private panel(): HTMLElement {
    const panel = h('div', { class: 'wm-sync-panel', attrs: { role: 'dialog', 'aria-label': t('dialogs.account.label') } });
    const run = (label: string, action: Action, primary = false) => {
      const button = h('button', { class: primary ? 'wm-sync-action wm-sync-primary' : 'wm-sync-action', text: label, attrs: { type: 'button' } });
      button.addEventListener('click', () => {
        closePopup();
        void Promise.resolve(this.host.perform(action)).catch((e: unknown) => this.host.notify((e as Error).message ?? String(e)));
      });
      return button;
    };
    if (!this.signedIn()) {
      panel.append(h('div', { class: 'wm-sync-title', text: t('dialogs.account.guest.title') }), h('p', { text: signInNote() }), run(t('dialogs.sync.signIn'), { kind: 'signIn' }, true));
      return panel;
    }
    const user = this.status?.user;
    panel.append(h('div', { class: 'wm-sync-title', text: user ? t('dialogs.sync.signedInAs', { user }) : t('dialogs.sync.signedInAsYou') }));
    // The phone apps say what the account has but offer nothing to buy or manage (sellsSubscriptions).
    const sells = sellsSubscriptions();
    if (this.subscription === 'active') panel.append(h('p', { text: t('dialogs.account.plan.active') }), ...(sells ? [run(t('dialogs.sync.manageSubscription'), { kind: 'manageSubscription' })] : []));
    else if (this.subscription === 'none') panel.append(h('p', { text: sells ? t('dialogs.account.plan.none') : t('dialogs.account.plan.notIncluded') }), ...(sells ? [run(t('dialogs.sync.subscribe'), { kind: 'subscribe' }, true)] : []));
    panel.append(h('hr'), run(t('dialogs.sync.signOut'), { kind: 'signOut' }));
    return panel;
  }
}
