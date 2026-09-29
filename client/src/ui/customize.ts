// Customize Toolbars: choose a toolbar, then add, remove and reorder its buttons from the list
// of every command (by the buttons, double-click, or dragging). Changes apply as they're made.

import { h } from './dom.ts';
import { SEPARATOR, cloneLayout, type ToolbarLayout } from './toolbarLayout.ts';

export interface CatalogItem {
  id: string;
  label: string;
  category: string;
}

export interface CustomizeOptions {
  layout(): ToolbarLayout[];
  defaults: readonly ToolbarLayout[];
  catalog: CatalogItem[];
  icon(id: string): HTMLElement;
  apply(layout: ToolbarLayout[]): void;
  onClose(): void;
}

const ALL = 'All Commands';
type Drag = { from: 'catalog'; id: string } | { from: 'toolbar'; index: number };

export function showCustomize(options: CustomizeOptions): void {
  let layout = cloneLayout(options.layout());
  let current = 0;
  let category = ALL;
  let catalogSelection: string | null = null;
  let toolbarSelection = -1;
  let drag: Drag | null = null;

  const labelOf = new Map(options.catalog.map((item) => [item.id, item.label]));
  const categories = [ALL, ...new Set(options.catalog.map((item) => item.category))];
  const items = () => layout[current].items;

  // --- Controls ---
  const toolbarSelect = h('select', { class: 'wm-select', attrs: { 'aria-label': 'Toolbar' } });
  for (const [i, t] of layout.entries()) toolbarSelect.append(new Option(t.name, String(i)));
  const visible = h('input', { attrs: { type: 'checkbox' } });
  const categorySelect = h('select', { class: 'wm-select', attrs: { 'aria-label': 'Category' } });
  for (const c of categories) categorySelect.append(new Option(c, c));
  const catalogList = h('div', { class: 'wm-clist', attrs: { role: 'listbox', tabindex: '0', 'aria-label': 'Commands' } });
  const toolbarList = h('div', { class: 'wm-clist', attrs: { role: 'listbox', tabindex: '0', 'aria-label': 'Toolbar buttons' } });

  const button = (text: string, onClick: () => void, title?: string) => {
    const b = h('button', { class: 'wm-button', text, title, attrs: { type: 'button' } });
    b.addEventListener('click', onClick);
    return b;
  };
  const addButton = button('Add ›', () => add(catalogSelection));
  const removeButton = button('‹ Remove', () => remove());
  const upButton = button('Move Up', () => move(-1));
  const downButton = button('Move Down', () => move(1));
  const separatorButton = button('Separator', () => insert(SEPARATOR), 'Add a separator after the selected button');
  const resetButton = button('Reset Toolbar', () => reset(), 'Put back the toolbar as it was originally');
  const closeButton = button('Close', () => dialog.close());

  // --- Editing ---
  const commit = () => {
    options.apply(cloneLayout(layout));
    render();
  };
  const insert = (id: string, at = toolbarSelection >= 0 ? toolbarSelection + 1 : items().length) => {
    items().splice(at, 0, id);
    toolbarSelection = at;
    commit();
  };
  const add = (id: string | null) => {
    if (id && !items().includes(id)) insert(id);
  };
  const remove = () => {
    if (toolbarSelection < 0) return;
    items().splice(toolbarSelection, 1);
    toolbarSelection = Math.min(toolbarSelection, items().length - 1);
    commit();
  };
  const move = (delta: number) => {
    const i = toolbarSelection;
    const j = i + delta;
    if (i < 0 || j < 0 || j >= items().length) return;
    [items()[i], items()[j]] = [items()[j], items()[i]];
    toolbarSelection = j;
    commit();
  };
  const reset = () => {
    const fallback = options.defaults.find((t) => t.name === layout[current].name);
    if (fallback) layout[current] = { ...fallback, items: [...fallback.items] };
    toolbarSelection = -1;
    commit();
  };
  /** Drop at `index` in the toolbar list (from the catalog or within the toolbar). */
  const drop = (index: number) => {
    if (!drag) return;
    if (drag.from === 'catalog') {
      if (!items().includes(drag.id)) insert(drag.id, index);
    } else {
      const [id] = items().splice(drag.index, 1);
      const at = drag.index < index ? index - 1 : index;
      items().splice(at, 0, id);
      toolbarSelection = at;
      commit();
    }
    drag = null;
  };

  // --- Rendering ---
  const row = (id: string, text: string) => h('div', { class: 'wm-crow', attrs: { role: 'option' } }, id === SEPARATOR ? h('span', { class: 'wm-crow-sep' }) : options.icon(id), h('span', { text }));

  const renderCatalog = () => {
    catalogList.replaceChildren();
    const onToolbar = new Set(items());
    let lastCategory = '';
    for (const item of options.catalog) {
      if (category !== ALL && item.category !== category) continue;
      if (category === ALL && item.category !== lastCategory) {
        catalogList.append(h('div', { class: 'wm-cheader', text: item.category }));
        lastCategory = item.category;
      }
      const el = row(item.id, item.label);
      const used = onToolbar.has(item.id);
      if (used) {
        el.classList.add('used');
        el.title = `Already on the ${layout[current].name} toolbar`;
      }
      if (item.id === catalogSelection) el.classList.add('selected');
      el.draggable = !used;
      el.addEventListener('click', () => {
        catalogSelection = item.id;
        render();
      });
      el.addEventListener('dblclick', () => add(item.id));
      el.addEventListener('dragstart', (e) => {
        drag = { from: 'catalog', id: item.id };
        e.dataTransfer?.setData('text/plain', item.id);
      });
      catalogList.append(el);
    }
  };

  const renderToolbar = () => {
    toolbarList.replaceChildren();
    items().forEach((id, index) => {
      const el = row(id, id === SEPARATOR ? 'Separator' : (labelOf.get(id) ?? id));
      if (id === SEPARATOR) el.classList.add('separator');
      if (index === toolbarSelection) el.classList.add('selected');
      el.draggable = true;
      el.addEventListener('click', () => {
        toolbarSelection = index;
        render();
      });
      el.addEventListener('dblclick', () => {
        toolbarSelection = index;
        remove();
      });
      el.addEventListener('dragstart', (e) => {
        drag = { from: 'toolbar', index };
        e.dataTransfer?.setData('text/plain', id);
      });
      el.addEventListener('dragover', (e) => {
        if (!drag) return;
        e.preventDefault();
        const box = el.getBoundingClientRect();
        const after = e.clientY > box.top + box.height / 2;
        el.classList.toggle('drop-before', !after);
        el.classList.toggle('drop-after', after);
      });
      el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const after = el.classList.contains('drop-after');
        el.classList.remove('drop-before', 'drop-after');
        drop(after ? index + 1 : index);
      });
      toolbarList.append(el);
    });
    toolbarList.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  };

  const render = () => {
    visible.checked = layout[current].visible;
    renderCatalog();
    renderToolbar();
    addButton.disabled = !catalogSelection || items().includes(catalogSelection);
    removeButton.disabled = toolbarSelection < 0;
    upButton.disabled = toolbarSelection <= 0;
    downButton.disabled = toolbarSelection < 0 || toolbarSelection >= items().length - 1;
  };

  // Dropping on the list's empty space appends.
  toolbarList.addEventListener('dragover', (e) => drag && e.preventDefault());
  toolbarList.addEventListener('drop', (e) => {
    e.preventDefault();
    drop(items().length);
  });
  // Dragging a toolbar button back onto the command list removes it.
  catalogList.addEventListener('dragover', (e) => drag?.from === 'toolbar' && e.preventDefault());
  catalogList.addEventListener('drop', (e) => {
    e.preventDefault();
    if (drag?.from === 'toolbar') {
      toolbarSelection = drag.index;
      remove();
    }
    drag = null;
  });

  toolbarSelect.addEventListener('change', () => {
    current = Number(toolbarSelect.value);
    toolbarSelection = -1;
    render();
  });
  visible.addEventListener('change', () => {
    layout[current].visible = visible.checked;
    commit();
  });
  categorySelect.addEventListener('change', () => {
    category = categorySelect.value;
    catalogList.scrollTop = 0;
    render();
  });

  // Arrow keys move the selection in whichever list has focus; Delete removes.
  toolbarList.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (e.altKey) return move(e.key === 'ArrowDown' ? 1 : -1);
      toolbarSelection = Math.max(0, Math.min(items().length - 1, toolbarSelection + (e.key === 'ArrowDown' ? 1 : -1)));
      render();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      remove();
    }
  });
  catalogList.addEventListener('keydown', (e) => {
    const visibleIds = options.catalog.filter((i) => category === ALL || i.category === category).map((i) => i.id);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = catalogSelection ? visibleIds.indexOf(catalogSelection) : -1;
      catalogSelection = visibleIds[Math.max(0, Math.min(visibleIds.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))] ?? null;
      render();
      catalogList.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      add(catalogSelection);
    }
  });

  // --- Dialog ---
  const dialog = h('dialog', { class: 'wm-dialog wm-customize' });
  const title = h('div', { class: 'wm-dialog-title' }, h('span', { text: 'Customize Toolbars' }));
  const x = button('×', () => dialog.close());
  x.className = 'wm-dialog-close';
  x.setAttribute('aria-label', 'Close');
  title.append(x);
  dialog.append(
    title,
    h(
      'div',
      { class: 'wm-dialog-body' },
      h('div', { class: 'wm-customize-top' }, h('label', {}, 'Toolbar: ', toolbarSelect), h('label', {}, visible, ' Show this toolbar')),
      h(
        'div',
        { class: 'wm-customize-lists' },
        h('div', { class: 'wm-customize-pane' }, h('label', {}, 'Commands: ', categorySelect), catalogList),
        h('div', { class: 'wm-customize-buttons' }, addButton, removeButton, h('span', { class: 'wm-gap' }), upButton, downButton, separatorButton),
        h('div', { class: 'wm-customize-pane' }, h('div', { class: 'wm-pane-title', text: 'On the toolbar:' }), toolbarList),
      ),
      h('p', { class: 'wm-hint', text: 'Double-click or drag to add and remove buttons. Drag within the toolbar list to reorder.' }),
    ),
    h('div', { class: 'wm-dialog-buttons spread' }, resetButton, closeButton),
  );
  // Keys stay in the dialog: the document's handlers listen on the window.
  dialog.addEventListener('keydown', (e) => e.stopPropagation());
  dialog.addEventListener('close', () => {
    dialog.remove();
    options.onClose();
  });
  document.body.append(dialog);
  render();
  dialog.showModal();
  closeButton.focus();
}
