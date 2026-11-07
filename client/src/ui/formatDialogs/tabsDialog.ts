// Format › Tabs: the tab stops of the selected paragraphs.

import { t } from '../../i18n/index.ts';
import type { TabChoice } from '../actions.ts';
import { h } from '../dom.ts';
import { listBox } from '../listBox.ts';
import { choice, field, numberInput, round, showForm, twipsPerUnit, unitName } from './parts.ts';

/** Asks for tab stops: resolves with all of them, or `undefined` on Cancel. `current` is undefined when the paragraphs differ (they then start with none). */
export function showTabsDialog(current: readonly TabChoice[] | undefined, defaultStop: number): Promise<TabChoice[] | undefined> {
  const tabs: TabChoice[] = [...(current ?? [])];
  const unit = unitName();
  const position = numberInput(t('format.tabs.position'), '', '0.25', '0');
  const align = choice(
    t('format.tabs.alignment'),
    (['left', 'center', 'right', 'decimal'] as const).map((a) => [a, t(`format.tabs.align.${a}`)] as const),
    'left',
  );
  const leader = choice(
    t('format.tabs.leader'),
    (['none', 'dot', 'hyphen', 'underscore'] as const).map((l) => [l, t(`format.tabs.leader.${l}`)] as const),
    'none',
  );
  const text = (tab: TabChoice) => `${round(tab.pos / twipsPerUnit())} ${unit}`;
  const list = listBox(t('format.tabs.stops'), {
    rows: 6,
    onPick: () => {
      const tab = tabs[list.index];
      if (!tab) return;
      position.value = round(tab.pos / twipsPerUnit());
      align.set(tab.align);
      leader.set(tab.leader);
    },
  });
  const show = (pick?: number) => {
    list.set(tabs.length ? tabs.map(text) : [{ note: t('format.tabs.empty') }]);
    if (pick !== undefined && pick >= 0) list.pick(pick);
    clear.disabled = clearAll.disabled = !tabs.length;
  };
  const message = () => document.querySelector<HTMLElement>('dialog.wm-fd-tabs .wm-find-message')!;
  const set = h('button', { class: 'wm-button', text: t('format.tabs.set'), attrs: { type: 'button' } });
  const clear = h('button', { class: 'wm-button', text: t('format.tabs.clear'), attrs: { type: 'button' } });
  const clearAll = h('button', { class: 'wm-button', text: t('format.tabs.clearAll'), attrs: { type: 'button' } });
  /** Adds what the fields say; true when they say something. */
  const add = (): boolean => {
    if (position.value.trim() === '') return true;
    const pos = Math.round(Number(position.value) * twipsPerUnit());
    if (!(pos >= 0 && pos <= 31680)) {
      message().textContent = t('format.bad');
      return false;
    }
    message().textContent = '';
    const entry: TabChoice = { pos, align: align.value as TabChoice['align'], leader: leader.value as TabChoice['leader'] };
    const at = tabs.findIndex((tab) => tab.pos === pos);
    if (at >= 0) tabs[at] = entry;
    else tabs.push(entry);
    tabs.sort((a, b) => a.pos - b.pos);
    show(tabs.indexOf(entry));
    return true;
  };
  set.addEventListener('click', () => {
    add();
    position.focus();
  });
  clear.addEventListener('click', () => {
    const at = list.index;
    if (at < 0 || !tabs[at]) return;
    tabs.splice(at, 1);
    position.value = '';
    show(Math.min(at, tabs.length - 1));
  });
  clearAll.addEventListener('click', () => {
    tabs.length = 0;
    position.value = '';
    show();
  });
  show(tabs.length ? 0 : undefined);

  return showForm<TabChoice[]>({
    title: t('format.tabs.title'),
    className: 'wm-fd-tabs',
    body: [
      h(
        'div',
        { class: 'wm-fd-columns' },
        h('div', { class: 'wm-page-tab' }, field(t('format.tabs.position'), position, unit), h('label', { text: t('format.tabs.stops') }), list.el),
        h('div', { class: 'wm-page-tab' }, field(t('format.tabs.alignment'), align.el), field(t('format.tabs.leader'), leader.el), h('p', { class: 'wm-hint', text: t('format.tabs.default', { value: `${round(defaultStop / twipsPerUnit())} ${unit}` }) })),
      ),
      h('div', { class: 'wm-fd-row' }, set, clear, clearAll),
    ],
    first: () => position,
    read() {
      // What was typed but not yet Set counts, as OK in Word's does.
      if (!add()) return null;
      return tabs;
    },
  });
}
