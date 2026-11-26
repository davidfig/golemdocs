// Insert › Function (⇧F3): find a function by searching or by category, read what it does and the arguments it takes
// (the function help in the app's language, formula/help/), and choose it to start typing it. A modal dialog of the
// shared parts (dialogParts.ts, the drop-down list, the list box).

import { h } from '../ui/dom.ts';
import { t, type MessageKey } from '../i18n/index.ts';
import { choiceButton } from '../ui/dropdown.ts';
import { listBox } from '../ui/listBox.ts';
import { CATALOGUE } from './formula/functions/catalogue.ts';
import { functionHelp, type FunctionHelp } from './formula/help/index.ts';
import { button, field, modal } from './dialogParts.ts';

const ALL = 'all';

/** The function chosen (its name), or null if the dialog was closed. */
export function askFunction(locale: string): Promise<string | null> {
  // Opened at once, so what is typed next goes into its search box; the help fills in when it has come.
  let help: FunctionHelp = {};
  const categories = [ALL, ...Object.keys(CATALOGUE)];
  const everything = Object.values(CATALOGUE).flat().sort();
  return new Promise((resolve) => {
    let chosen: string | null = null;
    const search = field(t('sheet.fn.search'));
    search.type = 'search';
    const syntax = h('div', { class: 'wm-function-syntax', attrs: { 'aria-live': 'polite' } });
    const description = h('p', { class: 'wm-function-description' });
    const empty = h('div', { class: 'wm-find-message', text: t('sheet.fn.none'), attrs: { hidden: '' } });
    const show = (name: string) => {
      const entry = help[name];
      syntax.replaceChildren(h('b', { text: name }), h('span', { text: `(${entry?.[0] ?? ''})` }));
      description.textContent = entry?.[1] ?? '';
    };
    const list = listBox(t('sheet.fn.functions'), { rows: 9, onPick: show, onChoose: (name) => finish(name) });
    let category = ALL;
    const refresh = () => {
      const query = search.value.trim().toUpperCase();
      const pool = category === ALL ? everything : [...CATALOGUE[category]].sort();
      // A function named what was typed first, then those whose names start with it or hold it, then those it describes.
      const rank = (n: string) => (n === query ? 0 : n.startsWith(query) ? 1 : n.includes(query) ? 2 : help[n]?.[1].toUpperCase().includes(query) ? 3 : 4);
      const names = query ? pool.filter((n) => rank(n) < 4).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)) : pool;
      list.set(names.map((choice) => ({ choice })));
      empty.hidden = names.length > 0;
      if (names.length) show(names[0]);
      else {
        syntax.replaceChildren();
        description.textContent = '';
      }
    };
    const pick = choiceButton({ label: t('sheet.fn.category'), groups: () => [{ values: categories }], name: (v) => t(`sheet.fn.cat.${v}` as MessageKey), fill: true }, (v) => {
      category = v;
      pick.set(v);
      refresh();
    });
    pick.set(ALL);
    search.addEventListener('input', refresh);
    // Down from the search box goes into the list; Enter there chooses the picked function.
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        list.focus();
      } else if (e.key === 'Enter' && list.value) {
        e.preventDefault();
        finish(list.value);
      }
    });
    const ok = button(t('sheet.fn.ok'), true);
    const cancel = button(t('sheet.fn.cancel'));
    const dialog = modal(
      t('sheet.fn.title'),
      [h('label', { text: t('sheet.fn.search') }), search, h('label', { text: t('sheet.fn.category') }), pick.el, h('label', { text: t('sheet.fn.functions') }), list.el, empty, syntax, description],
      [ok, cancel],
      () => resolve(chosen),
    );
    const finish = (name: string) => {
      chosen = name || null;
      dialog.close();
    };
    ok.addEventListener('click', () => finish(list.value));
    cancel.addEventListener('click', () => dialog.close());
    refresh();
    search.focus();
    void functionHelp(locale).then((loaded) => {
      help = loaded;
      // A search typed meanwhile may match descriptions too now; otherwise the picked function gets its help.
      if (search.value.trim()) refresh();
      else if (list.value) show(list.value);
    });
  });
}
