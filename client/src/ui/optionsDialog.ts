// Tools ▸ Options: preferences that are not tied to one document. Each applies as it is changed and is
// kept (see drawingOptions.ts). So far: how the vector editor draws.

import { t } from '../i18n/index.ts';
import { SMOOTHING_LEVELS, lockGuidesOn, penPressureOn, pencilSmoothing, returnToSelectOn, selectAfterPencilOn, setLockGuides, setPenPressure, setPencilSmoothing, setReturnToSelect, setSelectAfterPencil, setShowGuides, showGuidesOn, type Smoothing } from './drawingOptions.ts';
import { AUTOCORRECT_KEYS } from '../layout/autocorrect.ts';
import { autoCorrectOptions, setAutoCorrect } from './autoCorrect.ts';
import { h } from './dom.ts';
import { choiceButton } from './dropdown.ts';
import { desktopMenu } from '../desktop/bridge.ts';
import { IS_MAC } from './shortcuts.ts';
import { inAppMenuOnMac, keepMenuInFullScreen, setInAppMenuOnMac, setKeepMenuInFullScreen } from './fullScreen.ts';
import { scrollPastEndOn, setScrollPastEnd } from './scrollOptions.ts';
import { showDialog } from './popup.ts';
import { showReplacements } from './replacementsDialog.ts';
import { LIVE_LIMIT_CHOICES, liveLimitMb, setLiveLimitMb } from '../live/backgroundLimit.ts';

function check(label: string, on: boolean, set: (value: boolean) => void): HTMLElement {
  const box = h('input', { attrs: { type: 'checkbox' } });
  box.checked = on;
  box.addEventListener('change', () => set(box.checked));
  return h('label', {}, box, label);
}

/** The body of the dialog. */
export function optionsPanel(): HTMLElement {
  const smoothing = choiceButton({ label: t('dialogs.options.pencilSmoothing'), groups: () => [{ values: SMOOTHING_LEVELS }], name: (v) => t(`dialogs.options.${v as Smoothing}`), width: 120 }, (v) => {
    smoothing.set(v);
    setPencilSmoothing(v as Smoothing);
  });
  smoothing.set(pencilSmoothing());
  const editList = h('button', { class: 'wm-button', text: t('dialogs.options.editReplacements'), attrs: { type: 'button' } });
  editList.addEventListener('click', () => showReplacements());
  const liveLimit = choiceButton(
    { label: t('dialogs.options.liveLimit'), groups: () => [{ values: LIVE_LIMIT_CHOICES.map(String) }], name: (v) => (v === '0' ? t('dialogs.options.liveNever') : t('dialogs.options.liveMb', { mb: v })), width: 160 },
    (v) => {
      liveLimit.set(v);
      setLiveLimitMb(Number(v));
    },
  );
  liveLimit.set(String(liveLimitMb()));
  return h(
    'div',
    { class: 'wm-options' },
    h('fieldset', {}, h('legend', { text: t('dialogs.options.view') }), check(t('dialogs.options.fullScreenMenu'), keepMenuInFullScreen(), setKeepMenuInFullScreen), check(t('dialogs.options.scrollPastEnd'), scrollPastEndOn(), setScrollPastEnd), ...(IS_MAC && desktopMenu() ? [check(t('dialogs.options.macInAppMenu'), inAppMenuOnMac(), setInAppMenuOnMac)] : [])),
    h('fieldset', {}, h('legend', { text: t('dialogs.options.autocorrect') }), ...AUTOCORRECT_KEYS.map((rule) => check(t(`dialogs.options.${rule}`), autoCorrectOptions()[rule], (on) => setAutoCorrect(rule, on))), editList),
    h(
      'fieldset',
      {},
      h('legend', { text: t('dialogs.options.drawing') }),
      check(t('dialogs.options.selectAfterPencil'), selectAfterPencilOn(), setSelectAfterPencil),
      check(t('dialogs.options.returnToSelect'), returnToSelectOn(), setReturnToSelect),
      h('label', {}, t('dialogs.options.pencilSmoothing'), smoothing.el),
      check(t('dialogs.options.penPressure'), penPressureOn(), setPenPressure),
    ),
    h(
      'fieldset',
      {},
      h('legend', { text: t('dialogs.options.guides') }),
      check(t('dialogs.options.showGuides'), showGuidesOn(), setShowGuides),
      check(t('dialogs.options.lockGuides'), lockGuidesOn(), setLockGuides),
    ),
    h('fieldset', {}, h('legend', { text: t('dialogs.options.live') }), h('label', {}, t('dialogs.options.liveLimit'), liveLimit.el), h('p', { class: 'wm-hint', text: t('dialogs.options.liveHint') })),
  );
}

export function showOptions(onClose: () => void): void {
  showDialog(t('dialogs.options.title'), optionsPanel(), onClose);
}
