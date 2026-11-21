// The list of zoom sizes the status bar's zoom opens (and the Zoom box's choices), shared by the editor and the viewer so the two
// offer the same sizes in the same order.

import { t } from '../i18n/index.ts';
import { zoomPercent } from '../view/camera.ts';
import type { ZoomTarget } from './actions.ts';
import { h } from './dom.ts';
import { closePopup, openPopup, popupOpenFor } from './popup.ts';

export const zoomPresets = (): { label: string; to: ZoomTarget }[] => [
  { label: '500%', to: 5 },
  { label: '200%', to: 2 },
  { label: '150%', to: 1.5 },
  { label: '100%', to: 1 },
  { label: '75%', to: 0.75 },
  { label: '50%', to: 0.5 },
  { label: '25%', to: 0.25 },
  { label: '10%', to: 0.1 },
  { label: t('chrome.zoom.pageWidth'), to: 'pageWidth' },
  { label: t('chrome.zoom.wholePage'), to: 'wholePage' },
  { label: t('chrome.zoom.allPages'), to: 'allPages' },
];

/** The list of sizes, shown by `owner` with the size `zoom` (1 = 100%) marked; a second click closes it. `choose` gets the size picked. */
export function showZoomList(owner: HTMLElement, zoom: number, choose: (to: ZoomTarget) => void): void {
  if (popupOpenFor(owner)) return closePopup();
  const current = `${zoomPercent(zoom)}%`;
  const list = h('div', { class: 'wm-list', attrs: { role: 'listbox', 'aria-label': t('chrome.control.zoom') } });
  for (const preset of zoomPresets()) {
    const chosen = preset.label === current;
    const row = h('div', { class: chosen ? 'wm-option active' : 'wm-option', text: preset.label, attrs: { role: 'option', 'aria-selected': String(chosen) } });
    row.addEventListener('pointerenter', () => {
      for (const other of list.children) other.classList.toggle('active', other === row);
    });
    row.addEventListener('click', () => {
      closePopup();
      choose(preset.to);
    });
    list.append(row);
  }
  openPopup(owner, list);
}
