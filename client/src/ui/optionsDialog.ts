// Tools ▸ Options: preferences that are not tied to one document. Each applies as it is changed and is
// kept (see drawingOptions.ts). So far: how the vector editor draws.

import { t } from '../i18n/index.ts';
import { SMOOTHING_LEVELS, lockGuidesOn, penPressureOn, pencilSmoothing, returnToSelectOn, selectAfterPencilOn, setLockGuides, setPenPressure, setPencilSmoothing, setReturnToSelect, setSelectAfterPencil, setShowGuides, showGuidesOn, type Smoothing } from './drawingOptions.ts';
import { h } from './dom.ts';
import { showDialog } from './popup.ts';

function check(label: string, on: boolean, set: (value: boolean) => void): HTMLElement {
  const box = h('input', { attrs: { type: 'checkbox' } });
  box.checked = on;
  box.addEventListener('change', () => set(box.checked));
  return h('label', {}, box, label);
}

/** The body of the dialog. */
export function optionsPanel(): HTMLElement {
  const smoothing = h('select', { attrs: { 'aria-label': t('dialogs.options.pencilSmoothing') } });
  for (const level of SMOOTHING_LEVELS) smoothing.append(h('option', { text: t(`dialogs.options.${level}`), attrs: { value: level } }));
  smoothing.value = pencilSmoothing();
  smoothing.addEventListener('change', () => setPencilSmoothing(smoothing.value as Smoothing));
  return h(
    'div',
    { class: 'wm-options' },
    h(
      'fieldset',
      {},
      h('legend', { text: t('dialogs.options.drawing') }),
      check(t('dialogs.options.selectAfterPencil'), selectAfterPencilOn(), setSelectAfterPencil),
      check(t('dialogs.options.returnToSelect'), returnToSelectOn(), setReturnToSelect),
      h('label', {}, t('dialogs.options.pencilSmoothing'), smoothing),
      check(t('dialogs.options.penPressure'), penPressureOn(), setPenPressure),
    ),
    h(
      'fieldset',
      {},
      h('legend', { text: t('dialogs.options.guides') }),
      check(t('dialogs.options.showGuides'), showGuidesOn(), setShowGuides),
      check(t('dialogs.options.lockGuides'), lockGuidesOn(), setLockGuides),
    ),
  );
}

export function showOptions(onClose: () => void): void {
  showDialog(t('dialogs.options.title'), optionsPanel(), onClose);
}
