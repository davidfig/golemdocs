// The app's one tooltip, in place of the browser's own. Anything with a `title` attribute gets it
// (the first time the pointer moves over the element the title is taken off, so the browser's tip
// never shows), and the canvas can ask for one at the pointer (`pointerTip`). Showing waits a moment,
// then follows quickly while the pointer moves along a toolbar; pressing, typing (not a modifier alone), scrolling or leaving
// the window hides it.

import { placeTip } from './tooltipPlacement.ts';
import './tooltip.css';

/** How long the pointer rests on something before its tip shows. */
const SHOW_DELAY_MS = 500;
/** The delay right after another tip was showing (moving between toolbar buttons), and how long that lasts. */
const WARM_DELAY_MS = 60;
const WARM_WINDOW_MS = 400;

let el: HTMLDivElement | null = null;
/** What the tip is for: an element with a title, or the pointer itself (`pointerTip`). */
let source: Element | 'pointer' | null = null;
let text = '';
let at = { x: 0, y: 0 };
let timer = 0;
let visible = false;
let hiddenAt = -Infinity;
/** The element that was pressed: no tip until the pointer goes to something else. */
let pressed: Element | null = null;
let started = false;
const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Shift', 'Alt']);

function tipElement(): HTMLDivElement {
  if (!el) {
    el = document.createElement('div');
    el.className = 'wm-tip';
    el.setAttribute('role', 'tooltip');
    el.setAttribute('popover', 'manual'); // the top layer: above dialogs
    el.hidden = true;
    document.body.append(el);
  }
  return el;
}

function hide(): void {
  clearTimeout(timer);
  source = null;
  if (!visible || !el) return;
  visible = false;
  hiddenAt = performance.now();
  el.classList.remove('shown');
  el.hidden = true;
  try {
    el.hidePopover?.();
  } catch {
    // not showing
  }
}

function show(): void {
  const tip = tipElement();
  if (!source || !text || (source !== 'pointer' && !source.isConnected)) return;
  tip.textContent = text;
  tip.hidden = false;
  try {
    tip.showPopover?.();
  } catch {
    // already showing
  }
  const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
  const rect = source === 'pointer' ? null : source.getBoundingClientRect();
  const { left, top } = placeTip({ width: tip.offsetWidth, height: tip.offsetHeight }, rect ?? at, viewport);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  visible = true;
  requestAnimationFrame(() => tip.classList.add('shown'));
}

function begin(next: Element | 'pointer', message: string, x: number, y: number): void {
  hide();
  source = next;
  text = message;
  at = { x, y };
  timer = window.setTimeout(show, performance.now() - hiddenAt < WARM_WINDOW_MS ? WARM_DELAY_MS : SHOW_DELAY_MS);
}

/**
 * The tip text of an element with a `title`, moving the title to `data-tip` so the browser doesn't
 * show its own. An element with only a title and no other name keeps its accessible name as an aria-label.
 */
function takeText(target: Element): string {
  const title = target.getAttribute('title');
  if (title !== null) {
    target.removeAttribute('title');
    if (title) {
      target.setAttribute('data-tip', title);
      const named = target.hasAttribute('aria-label') && !target.hasAttribute('data-tip-label');
      if (!named && !target.hasAttribute('aria-labelledby') && !target.textContent?.trim()) {
        target.setAttribute('aria-label', title);
        target.setAttribute('data-tip-label', '');
      }
    } else target.removeAttribute('data-tip');
  }
  return target.getAttribute('data-tip') ?? '';
}

/**
 * Shows `message` at the point (window coordinates) after the usual delay, until the pointer leaves
 * what it is about (call again with null), or something else takes over. For things with no element of
 * their own, like a link in the document canvas. Asking again with the same message keeps it as it is.
 */
export function pointerTip(message: string | null, x: number, y: number): void {
  if (!message) {
    if (source === 'pointer') hide();
    return;
  }
  if (source === 'pointer' && text === message) {
    at = { x, y };
    return;
  }
  begin('pointer', message, x, y);
}

/** Starts the tooltips for the page; once. */
export function initTooltips(): void {
  if (started) return;
  started = true;
  document.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType === 'touch') return;
      const target = e.target instanceof Element ? e.target.closest('[title],[data-tip]') : null;
      if (target !== pressed) pressed = null;
      if (!target) {
        if (source && source !== 'pointer') hide();
        return;
      }
      const message = takeText(target);
      if (target === source || target === pressed) return;
      if (!message) return hide();
      begin(target, message, e.clientX, e.clientY);
    },
    true,
  );
  document.addEventListener(
    'pointerdown',
    (e) => {
      pressed = e.target instanceof Element ? e.target.closest('[title],[data-tip]') : null;
      hide();
    },
    true,
  );
  for (const type of ['wheel', 'blur']) window.addEventListener(type, hide, true);
  // A modifier on its own (Cmd or Ctrl to follow a link) doesn't hide it: only typing does.
  window.addEventListener('keydown', (e) => !MODIFIER_KEYS.has(e.key) && hide(), true);
  document.addEventListener('scroll', hide, true);
  document.addEventListener('visibilitychange', hide);
  document.documentElement.addEventListener('pointerleave', hide);
}
