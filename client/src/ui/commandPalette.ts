// The command palette: a button at the top right that opens a searchable list of every command,
// with the ones used most recently on top. Rows come from the same registry as the menus. A search
// also finds the user's documents by title, so one can be opened from here.

import { t } from '../i18n/index.ts';
import type { ListedDocument } from './actions.ts';
import type { Command, CommandRegistry } from './commands.ts';
import { announce } from './announce.ts';
import { h, uniqueId } from './dom.ts';
import { fileIcon } from './fileIcons.ts';
import { ICONS, iconElement } from './icons.ts';
import { optionGroup, pickOption } from './listBox.ts';
import { tooltip } from './toolbar.ts';
import { closePopup, openPopup, popupOpenFor } from './popup.ts';

const STORAGE_KEY = 'golemdocs.recentCommands';
export const MAX_RECENT = 6;
/** The most documents one search lists: a big library would otherwise draw thousands of rows on every keystroke. */
export const MAX_DOCUMENTS = 50;

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

/**
 * What a search lists: commands and at most `MAX_DOCUMENTS` documents, ranked together. On equal
 * terms a command comes first, so a document can't take over Enter from a command it always ran.
 */
export function searchEntries<T extends PaletteEntry>(commands: readonly T[], documents: readonly T[], query: string): T[] {
  return filterEntries([...commands, ...filterEntries(documents, query).slice(0, MAX_DOCUMENTS)], query);
}

/** A row of the list: a command or a document. */
interface PaletteRow extends PaletteEntry {
  meta: string;
  /** The whole of what may be cut short in the row. */
  title?: string;
  icon: () => HTMLElement;
  enabled: () => boolean;
  run: () => void;
}

export class CommandPalette {
  readonly el: HTMLButtonElement;
  private recent = loadRecent();

  constructor(
    private readonly registry: CommandRegistry,
    /** The label and category a command is listed under. */
    private readonly describe: (command: Command) => { label: string; category: string },
    /** The documents a search can find. */
    private readonly documents: () => ListedDocument[],
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
      .map((command): PaletteRow => {
        const { label, category } = this.describe(command);
        return { id: command.id, label, category, meta: command.shortcutText || category, icon: () => iconElement(command.icon), enabled: () => registry.isEnabled(command), run: () => registry.execute(command) };
      });
    // Found by title alone (no category): searching "document" shouldn't list them all.
    const documents = this.documents().map((doc, index): PaletteRow => ({ id: `document:${index}`, label: doc.name, category: '', meta: doc.folder, title: doc.folder ? `${doc.folder} / ${doc.name}` : doc.name, icon: () => fileIcon(doc.name), enabled: () => true, run: doc.open }));

    // A combo box: the focus stays in the search box, and the row the arrows are on is its active descendant.
    const list = h('div', { class: 'wm-list wm-palette-list', attrs: { role: 'listbox', id: uniqueId('wm-palette-list'), 'aria-label': t('chrome.palette.label') } });
    const input = h('input', {
      class: 'wm-palette-input',
      attrs: { type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-autocomplete': 'list', 'aria-controls': list.id, placeholder: t('chrome.palette.search'), 'aria-label': t('chrome.palette.search'), autocomplete: 'off', spellcheck: 'false' },
    });
    const panel = h('div', { class: 'wm-command-palette', attrs: { role: 'dialog', 'aria-label': t('chrome.palette.label') } }, input, list);

    let rows: { el: HTMLElement; entry: PaletteRow }[] = [];
    let active = -1;
    const setActive = (index: number) => {
      active = rows.length ? (index + rows.length) % rows.length : -1;
      rows.forEach((row, i) => row.el.classList.toggle('active', i === active));
      pickOption(list, rows[active]?.el ?? null, input);
      rows[active]?.el.scrollIntoView({ block: 'nearest' });
    };
    const run = (entry: PaletteRow) => {
      if (!entry.enabled()) return;
      closePopup();
      entry.run();
    };
    const add = (entry: PaletteRow) => {
      const enabled = entry.enabled();
      const row = h(
        'div',
        { class: enabled ? 'wm-option wm-palette-row' : 'wm-option wm-palette-row disabled', attrs: { role: 'option', 'aria-disabled': String(!enabled), ...(entry.title && { title: entry.title }) } },
        h('span', { class: 'wm-palette-icon' }, entry.icon()),
        h('span', { class: 'wm-palette-label', text: entry.label }),
        h('span', { class: 'wm-palette-meta', text: entry.meta }),
      );
      row.addEventListener('mousemove', () => setActive(rows.findIndex((r) => r.el === row)));
      row.addEventListener('click', () => run(entry));
      rows.push({ el: row, entry });
      into.append(row);
    };
    let into: HTMLElement = list;
    const heading = (text: string) => {
      into = optionGroup(text).group;
      list.append(into);
    };
    const render = () => {
      list.replaceChildren();
      into = list;
      rows = [];
      const query = input.value.trim();
      if (query) {
        for (const entry of searchEntries(entries, documents, query)) add(entry);
        if (!rows.length) list.append(h('div', { class: 'wm-palette-empty', text: t('chrome.palette.none') }));
      } else {
        const recent = this.recent.map((id) => entries.find((e) => e.id === id)).filter((e) => e !== undefined);
        if (recent.length) {
          heading(t('chrome.palette.recent'));
          recent.forEach(add);
        }
        heading(t('chrome.palette.all'));
        entries.forEach(add);
      }
      setActive(rows.length ? 0 : -1);
    };

    // How many rows a search found is said once typing pauses, since the list shows it only to the eye.
    let countTimer = 0;
    input.addEventListener('input', () => {
      render();
      window.clearTimeout(countTimer);
      countTimer = window.setTimeout(() => {
        if (input.isConnected) announce(input.value.trim() ? (rows.length ? t('a11y.palette.found', { count: rows.length }) : t('chrome.palette.none')) : '');
      }, 400);
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // the document's handlers listen on the window
      if (e.key === 'ArrowDown') setActive(active + 1);
      else if (e.key === 'ArrowUp') setActive(active - 1);
      else if (e.key === 'Enter' && rows[active]) run(rows[active].entry);
      else if (e.key === 'Escape') closePopup();
      else return;
      e.preventDefault();
    });

    render();
    openPopup(this.el, panel, () => registry.focusEditor());
    input.focus();
  }
}
