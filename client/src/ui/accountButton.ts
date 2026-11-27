// The account at the top right. Signed in, it is the person's picture (or a person icon) and opens a panel with who is signed
// in, their sync subscription, and signing out. Signed out, it is a "Sign in" button that asks to sign in straight away (the
// sign-in dialog says what signing in gives); on a phone, where a word has no room, it stays the person icon and its panel.

import type { Action, ChromeHost, SubscriptionState, SyncStatus } from './actions.ts';
import { avatar } from './avatar.ts';
import { h, setAttr } from './dom.ts';
import { t } from '../i18n/index.ts';
import { sellsSubscriptions } from '../subscription.ts';
import { signInNote } from './signIn.ts';
import { closePopup, openPopup, popupOpenFor } from './popup.ts';

const SVG = 'http://www.w3.org/2000/svg';

/** A phone's width (the same as the narrow layout in ui.css): no room for "Sign in", so the icon stays. */
const NARROW = '(max-width: 720px)';
const narrow = (): boolean => matchMedia(NARROW).matches;

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
  private readonly icon: HTMLSpanElement;
  private readonly signInText: HTMLSpanElement;

  constructor(private readonly host: ChromeHost) {
    this.icon = h('span', { class: 'wm-account-icon' }, personIcon());
    this.signInText = h('span', { class: 'wm-account-text', text: t('dialogs.account.signIn') });
    this.el = h('button', { class: 'wm-account', attrs: { type: 'button', 'data-signed-in': 'false', hidden: '' } }, this.icon, this.signInText);
    this.label(false);
    // Crossing into or out of a phone's width swaps "Sign in" and the icon: say which it is now.
    matchMedia(NARROW).addEventListener('change', () => this.label(this.signedIn()));
    this.el.addEventListener('mousedown', (e) => e.preventDefault()); // keep the document's focus
    this.el.addEventListener('click', () => {
      if (popupOpenFor(this.el)) return closePopup();
      if (!this.signedIn() && !narrow()) return void this.run({ kind: 'signIn' });
      openPopup(this.el, this.panel(), () => this.host.focusEditor());
    });
  }

  update(status: SyncStatus, subscription: SubscriptionState | null): void {
    const changed = JSON.stringify(status) !== JSON.stringify(this.status) || subscription !== this.subscription;
    this.status = status;
    this.subscription = subscription;
    setAttr(this.el, 'data-signed-in', this.signedIn() ? 'true' : 'false');
    // Not yet known whether anyone is signed in (and nobody was last time): show nothing rather than a "Sign in" that may vanish.
    this.el.hidden = status.checking === true && !this.signedIn();
    this.label(this.signedIn());
    const picture = this.signedIn() ? (status.picture ?? null) : null;
    if (picture !== this.shownPicture) {
      this.shownPicture = picture;
      this.icon.replaceChildren(picture ? avatar(picture, status.user, 19) : personIcon());
      setAttr(this.el, 'data-picture', picture ? 'true' : 'false');
    }
    if (changed && popupOpenFor(this.el)) openPopup(this.el, this.panel(), () => this.host.focusEditor());
  }

  /** Signed in: "Account", which opens a panel. Signed out: "Sign in", which asks at once (except on a phone: see the top). */
  private label(signedIn: boolean): void {
    this.el.title = signedIn || narrow() ? t('dialogs.account.label') : signInNote();
    this.el.setAttribute('aria-label', signedIn || narrow() ? t('dialogs.account.label') : t('dialogs.account.signIn'));
    if (signedIn || narrow()) {
      this.el.setAttribute('aria-haspopup', 'dialog');
      this.el.setAttribute('aria-expanded', String(popupOpenFor(this.el)));
    } else {
      this.el.removeAttribute('aria-haspopup');
      this.el.removeAttribute('aria-expanded');
    }
  }

  private run(action: Action): void {
    void Promise.resolve(this.host.perform(action)).catch((e: unknown) => this.host.notify((e as Error).message ?? String(e)));
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
        this.run(action);
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
