// The command palette: a button at the top right that opens a searchable list of every command,
// with the ones used most recently on top. Rows come from the same registry as the menus.

import { t } from '../i18n/index.ts';
import type { Command, CommandRegistry } from './commands.ts';
import { h } from './dom.ts';
import { ICONS, iconElement } from './icons.ts';
import { tooltip } from './toolbar.ts';
import { closePopup, openPopup, popupOpenFor } from './popup.ts';

const STORAGE_KEY = 'golemdocs.recentCommands';
export const MAX_RECENT = 6;

/** `id` moved to the front of `recent`, without a duplicate, keeping at most `max`. */
export function pushRecent(recent: readonly string[], id: string, max = MAX_RECENT): string[] {
  return [id, ...recent.filter((r) => r !== id)].slice(0, max);
}

export function loadRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string').slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

function saveRecent(recent: readonly string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recent));
  } catch {
    // Storage unavailable: recents last for this session only.
  }
}

export interface PaletteEntry {
  id: string;
  label: string;
  category: string;
}

/** The entries whose label or category contains every word of `query`, prefix matches first. */
export function filterEntries<T extends PaletteEntry>(entries: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...entries];
  const scored: [number, number, T][] = [];
  entries.forEach((entry, index) => {
    const label = entry.label.toLowerCase();
    const haystack = `${label} ${entry.category.toLowerCase()}`;
    if (!words.every((w) => haystack.includes(w))) return;
    scored.push([label.startsWith(words[0]) ? 0 : 1, index, entry]);
  });
  return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((s) => s[2]);
}

export class CommandPalette {
  readonly el: HTMLButtonElement;
  private recent = loadRecent();

  constructor(
    private readonly registry: CommandRegistry,
    /** The label and category a command is listed under. */
    private readonly describe: (command: Command) => { label: string; category: string },
  ) {
    const title = tooltip(t('chrome.palette.label'), registry.get('tools.commandPalette').shortcutText);
    this.el = h('button', { class: 'wm-palette-button', attrs: { type: 'button', title, 'aria-label': t('chrome.palette.label'), 'aria-haspopup': 'dialog', 'aria-expanded': 'false' } });
    this.el.innerHTML = ICONS.commandPalette;
    this.el.addEventListener('mousedown', (e) => e.preventDefault()); // keep the document's focus
    this.el.addEventListener('click', () => this.toggle());
    registry.onExecute = (id) => {
      this.recent = pushRecent(this.recent, id);
      saveRecent(this.recent);
    };
  }

  toggle(): void {
    if (popupOpenFor(this.el)) closePopup();
    else this.open();
  }

  private open(): void {
    const { registry } = this;
    const entries = [...registry.all()]
      .filter((command) => command.id !== 'tools.commandPalette' && registry.isAvailable(command))
      .map((command) => ({ id: command.id, command, ...this.describe(command) }));

    const input = h('input', { class: 'wm-palette-input', attrs: { type: 'text', placeholder: t('chrome.palette.search'), 'aria-label': t('chrome.palette.search'), autocomplete: 'off', spellcheck: 'false' } });
    const list = h('div', { class: 'wm-list wm-palette-list', attrs: { role: 'listbox' } });
    const panel = h('div', { class: 'wm-command-palette', attrs: { role: 'dialog', 'aria-label': t('chrome.palette.label') } }, input, list);

    let rows: { el: HTMLElement; command: Command }[] = [];
    let active = -1;
    const setActive = (index: number) => {
      active = rows.length ? (index + rows.length) % rows.length : -1;
      rows.forEach((row, i) => row.el.classList.toggle('active', i === active));
      rows[active]?.el.scrollIntoView({ block: 'nearest' });
    };
    const run = (command: Command) => {
      if (!registry.isEnabled(command)) return;
      closePopup();
      registry.execute(command);
    };
    const add = (entry: (typeof entries)[number]) => {
      const { command } = entry;
      const enabled = registry.isEnabled(command);
      const row = h(
        'div',
        { class: enabled ? 'wm-option wm-palette-row' : 'wm-option wm-palette-row disabled', attrs: { role: 'option', 'aria-disabled': String(!enabled) } },
        h('span', { class: 'wm-palette-icon' }, iconElement(command.icon)),
        h('span', { class: 'wm-palette-label', text: entry.label }),
        h('span', { class: 'wm-palette-meta', text: command.shortcutText || entry.category }),
      );
      row.addEventListener('mousemove', () => setActive(rows.findIndex((r) => r.el === row)));
      row.addEventListener('click', () => run(command));
      rows.push({ el: row, command });
      list.append(row);
    };
    const render = () => {
      list.replaceChildren();
      rows = [];
      const query = input.value.trim();
      if (query) {
        for (const entry of filterEntries(entries, query)) add(entry);
        if (!rows.length) list.append(h('div', { class: 'wm-palette-empty', text: t('chrome.palette.none') }));
      } else {
        const recent = this.recent.map((id) => entries.find((e) => e.id === id)).filter((e) => e !== undefined);
        if (recent.length) {
          list.append(h('div', { class: 'wm-list-heading', text: t('chrome.palette.recent') }));
          recent.forEach(add);
        }
        list.append(h('div', { class: 'wm-list-heading', text: t('chrome.palette.all') }));
        entries.forEach(add);
      }
      setActive(rows.length ? 0 : -1);
    };

    input.addEventListener('input', render);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // the document's handlers listen on the window
      if (e.key === 'ArrowDown') setActive(active + 1);
      else if (e.key === 'ArrowUp') setActive(active - 1);
      else if (e.key === 'Enter' && rows[active]) run(rows[active].command);
      else if (e.key === 'Escape') closePopup();
      else return;
      e.preventDefault();
    });

    render();
    openPopup(this.el, panel, () => registry.focusEditor());
    input.focus();
  }
}
