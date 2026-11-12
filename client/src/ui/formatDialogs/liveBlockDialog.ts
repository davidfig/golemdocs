// Insert › Live Block: a built-in block (docs/live-blocks.md §7), set up without code. A folder list, a count or a timeline of a
// folder's notes (live/builtins.ts), or a CSV's or workbook's table filtered and sorted (live/tableQuery.ts); the dialog writes
// its address, shown as it is built so it can also be written by hand.

import { t } from '../../i18n/index.ts';
import { builtinAddress, writeOptions } from '../../live/builtinAddress.ts';
import type { BuiltinKind } from '../../live/builtinAddress.ts';
import { h, segmented } from '../dom.ts';
import { check, choice, field, numberInput, showForm } from './parts.ts';

export interface LiveBlockChoice {
  source: string;
  /** A count is a value, which goes in the line; a list, timeline or table is a table. */
  inline: boolean;
}

type Kind = BuiltinKind | 'table';

function text(label: string, value = '', placeholder = ''): HTMLInputElement {
  const input = h('input', { class: 'wm-input', attrs: { type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': label, placeholder } });
  input.value = value;
  return input;
}

/** Asks what to show; `folders` are the vault's folders as paths (`Novel/Characters`), `tables` its CSV files and workbooks. */
export function showLiveBlockDialog(folders: readonly string[], tables: readonly string[]): Promise<LiveBlockChoice | undefined> {
  let kind: Kind = 'list';
  let of: 'words' | 'notes' = 'words';
  const folder = choice(t('live.insert.folder'), [['', t('live.insert.wholeVault')], ...folders.map((f) => [f, f] as const)], folders[0] ?? '', () => paint());
  const columns = text(t('live.insert.columns'), '', t('live.insert.columnsHint'));
  const sort = text(t('live.insert.sort'), '', t('live.insert.sortHint'));
  const descending = check(t('live.insert.descending'), false);
  const whereField = text(t('live.insert.whereField'));
  const whereValue = text(t('live.insert.whereValue'));
  const goal = numberInput(t('live.insert.goal'), '', '1', '0');
  const date = text(t('live.insert.date'), 'date');
  const file = choice(t('live.insert.file'), tables.map((f) => [f, f] as const), tables[0] ?? '', () => paint());
  const part = text(t('live.insert.part'), '', t('live.insert.partHint'));
  const limit = numberInput(t('live.insert.limit'), '', '1', '1');
  const address = h('p', { class: 'wm-hint wm-live-address' });

  const kinds = segmented<Kind>(
    t('live.insert.kind'),
    [
      { value: 'list', text: t('live.insert.list') },
      { value: 'count', text: t('live.insert.count') },
      { value: 'timeline', text: t('live.insert.timeline') },
      { value: 'table', text: t('live.insert.table') },
    ],
    (value) => {
      kind = value;
      paint();
    },
  );
  const counts = segmented<'words' | 'notes'>(
    t('live.insert.countOf'),
    [
      { value: 'words', text: t('live.insert.words') },
      { value: 'notes', text: t('live.insert.notes') },
    ],
    (value) => {
      of = value;
      paint();
    },
  );

  const rows = {
    folder: field(t('live.insert.folder'), folder.el),
    file: field(t('live.insert.file'), file.el),
    part: field(t('live.insert.part'), part),
    limit: field(t('live.insert.limit'), limit),
    columns: field(t('live.insert.columns'), columns),
    sort: field(t('live.insert.sort'), sort),
    descending: descending.el,
    where: field(t('live.insert.whereField'), h('span', { class: 'wm-live-where' }, whereField, h('span', { text: t('live.insert.whereValue') }), whereValue)),
    of: h('div', { class: 'wm-fd-row' }, h('span', { text: t('live.insert.countOf') }), counts.el),
    goal: field(t('live.insert.goal'), goal),
    date: field(t('live.insert.date'), date),
  };

  const source = (): string => {
    const where = whereField.value.trim() ? `${whereField.value.trim()}${whereValue.value.trim() ? `:${whereValue.value.trim()}` : ''}` : undefined;
    if (kind === 'count') return builtinAddress('count', folder.value, { of: of === 'words' ? undefined : of, goal: goal.value, where });
    if (kind === 'timeline') return builtinAddress('timeline', folder.value, { date: date.value.trim() === 'date' ? undefined : date.value, columns: columns.value, where, order: descending.input.checked ? 'desc' : undefined });
    const by = sort.value.trim();
    const sorted = by ? `${descending.input.checked ? '-' : ''}${by}` : undefined;
    if (kind === 'table') return `${file.value}${part.value.trim() ? `#${part.value.trim()}` : ''}${writeOptions({ where, sort: sorted, columns: columns.value, limit: limit.value })}`;
    return builtinAddress('list', folder.value, { columns: columns.value, sort: by ? `${descending.input.checked ? '-' : ''}${by}` : undefined, where });
  };

  function paint(): void {
    kinds.set(kind);
    counts.set(of);
    const table = kind === 'table';
    rows.folder.hidden = table;
    rows.file.hidden = rows.part.hidden = rows.limit.hidden = !table;
    rows.columns.hidden = kind === 'count';
    rows.sort.hidden = kind !== 'list' && !table;
    columns.placeholder = t(table ? 'live.insert.columnsTableHint' : 'live.insert.columnsHint');
    sort.placeholder = t(table ? 'live.insert.sortTableHint' : 'live.insert.sortHint');
    rows.descending.hidden = kind === 'count';
    rows.of.hidden = rows.goal.hidden = kind !== 'count';
    rows.date.hidden = kind !== 'timeline';
    address.textContent = `![[${source()}]]`;
  }

  const body = [
    h('div', { class: 'wm-fd-row' }, h('span', { text: t('live.insert.kind') }), kinds.el),
    rows.folder,
    rows.file,
    rows.part,
    rows.of,
    rows.columns,
    rows.sort,
    rows.date,
    rows.descending,
    rows.where,
    rows.goal,
    rows.limit,
    h('p', { class: 'wm-hint', text: t('live.insert.addressHint') }),
    address,
  ];
  // Typing in any field changes the address shown.
  for (const input of [columns, sort, descending.input, whereField, whereValue, goal, date, part, limit]) input.addEventListener('input', paint);
  paint();
  return showForm<LiveBlockChoice>({
    title: t('live.insert.title'),
    className: 'wm-fd-live',
    body,
    okText: t('live.insert.ok'),
    first: () => kinds.el.querySelector('button') ?? folder.el,
    read: (message) => {
      if (kind === 'table' && !file.value) {
        message.textContent = t('live.insert.noTables');
        return null;
      }
      return { source: source(), inline: kind === 'count' };
    },
  });
}
