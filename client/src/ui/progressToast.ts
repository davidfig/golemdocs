// A card at the bottom right of the window for work that takes a while (importing a ZIP): what is
// being done, a progress bar and a Cancel button. It doesn't block anything; the work goes on
// behind it, and it is taken away when the work ends.

import { t } from '../i18n/index.ts';
import { h } from './dom.ts';
import './progressToast.css';

export interface Progress {
  /** Aborts when Cancel is pressed. */
  readonly signal: AbortSignal;
  /** Moves the bar to `done` of `total`, with `detail` (or "done of total") under the title. */
  update(done: number, total: number, detail?: string): void;
  /** Takes the card away. */
  close(): void;
}

/** Shows the card with `title` and returns what drives it. A second card stacks above the first. */
export function showProgress(title: string): Progress {
  const abort = new AbortController();
  const detail = h('div', { class: 'wm-progress-detail' });
  const bar = h('div', { class: 'wm-progress-bar' });
  const cancel = h('button', { class: 'wm-progress-cancel', text: t('menus.dialog.cancel'), attrs: { type: 'button' } });
  const card = h(
    'div',
    { class: 'wm-progress', attrs: { role: 'status', 'aria-live': 'polite' } },
    h('div', { class: 'wm-progress-title', text: title }),
    detail,
    h('div', { class: 'wm-progress-track', attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' } }, bar),
    cancel,
  );
  cancel.addEventListener('click', () => {
    abort.abort();
    cancel.disabled = true;
  });
  const stack = (document.querySelector('.wm-progress-stack') as HTMLElement | null) ?? document.body.appendChild(h('div', { class: 'wm-progress-stack' }));
  stack.append(card);
  const track = bar.parentElement!;
  const update = (done: number, total: number, text?: string): void => {
    const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    bar.style.width = `${percent}%`;
    track.setAttribute('aria-valuenow', String(percent));
    detail.textContent = text ?? t('app.importProgress', { done, total });
  };
  update(0, 0, '');
  return {
    signal: abort.signal,
    update,
    close: () => {
      card.remove();
      if (!stack.firstChild) stack.remove();
    },
  };
}
