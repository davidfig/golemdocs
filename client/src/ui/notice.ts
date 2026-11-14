// The notes that come up at the bottom of the window by themselves (a new version, the reload offer, a sign-in that ran
// out, the shared-computer note). One place says what every such note does for the keyboard and screen readers: it is
// read out when it appears (`showNotice`), F6 reaches it (`main.ts` adds every `.wm-notice` showing to its regions), and
// when it goes while it has the keyboard (its close button, its own buttons) the keyboard goes back where it came from.

import { announce } from './announce.ts';

const cameFrom = new WeakMap<HTMLElement, HTMLElement>();
const watched = new WeakSet<HTMLElement>();

/** Shows or hides a note. Showing one that was hidden reads it out; hiding one that had the keyboard gives the keyboard back. */
export function showNotice(el: HTMLElement, shown: boolean): void {
  el.classList.add('wm-notice');
  if (!watched.has(el)) {
    watched.add(el);
    el.addEventListener('focusin', (e) => {
      const from = e.relatedTarget;
      if (from instanceof HTMLElement && !el.contains(from)) cameFrom.set(el, from);
    });
  }
  const was = !el.hidden;
  if (shown === was) return;
  if (!shown && el.contains(document.activeElement)) {
    el.hidden = true;
    const back = cameFrom.get(el);
    (back?.isConnected ? back : document.getElementById('input'))?.focus({ preventScroll: true });
    return;
  }
  el.hidden = !shown;
  if (shown) announce(el.querySelector('p')?.textContent ?? el.getAttribute('aria-label') ?? '');
}
