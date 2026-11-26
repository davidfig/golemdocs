// Tools ▸ Word Count: the statistics of the document (or of the selected text), as in Word 2003, and, for a document whose
// writing is kept (wordHistory.ts), its progress: the words written today, this week, this month and this year, and a chart (or
// a table) of them by day or by month. It also says what the status bar's word count shows (ui/footerWords.ts).
// The counts come from the layout worker (see layout/wordCount.ts); this asks for them and shows them.

import { getLocale, t, type MessageKey } from '../i18n/index.ts';
import type { WireCommand, WordStats } from '../layout/protocol.ts';
import { WORD_PERIODS, addDays, dateOf, firstDayOfWeek, periodStart, progressBars, writtenBetween, type DocumentWords, type WordPeriod } from '../wordHistory.ts';
import { h, segmented } from './dom.ts';
import { choiceButton } from './dropdown.ts';
import { footerWordPeriod, onFooterWordPeriodChange, setFooterWordPeriod } from './footerWords.ts';
import { dialogTitleBar } from './popup.ts';
import { progressChart, type ProgressBar } from './progressChart.ts';

const ROWS: { key: keyof Omit<WordStats, 'selection' | 'table'>; label: MessageKey }[] = [
  { key: 'pages', label: 'wordCount.pages' },
  { key: 'words', label: 'wordCount.words' },
  { key: 'charactersWithoutSpaces', label: 'wordCount.charactersWithoutSpaces' },
  { key: 'charactersWithSpaces', label: 'wordCount.charactersWithSpaces' },
  { key: 'paragraphs', label: 'wordCount.paragraphs' },
  { key: 'lines', label: 'wordCount.lines' },
];

/** How far back the chart looks. */
export type ProgressRange = 'week' | 'month' | 'year' | 'all';
const RANGES: readonly ProgressRange[] = ['week', 'month', 'year', 'all'];
const PERIODS_WRITTEN = ['today', 'week', 'month', 'year'] as const;

const CHART_WIDTH = 384;
const CHART_HEIGHT = 150;

/** The days (or months) a range shows, ending today: `by` day or month, from `from` to `to`. */
export function rangeSpan(range: ProgressRange, today: string, firstDay: string | null): { from: string; to: string; by: 'day' | 'month' } {
  if (range === 'week') return { from: addDays(today, -6), to: today, by: 'day' };
  if (range === 'month') return { from: addDays(today, -29), to: today, by: 'day' };
  const date = dateOf(today);
  if (range === 'year') {
    date.setDate(1);
    date.setMonth(date.getMonth() - 11);
    return { from: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`, to: today, by: 'month' };
  }
  const first = firstDay && firstDay < today ? firstDay : today;
  return { from: `${first.slice(0, 7)}-01`, to: today, by: 'month' };
}

export class WordCountDialog {
  private dialog: HTMLDialogElement | null = null;
  private values = new Map<string, HTMLElement>();
  private note: HTMLElement | null = null;
  private progress: HTMLElement | null = null;
  private range: ProgressRange = 'month';
  private asTable = false;
  private stop: (() => void)[] = [];

  constructor(
    private readonly host: {
      send(command: WireCommand): void;
      focusEditor(): void;
      /** The open document's word history, when its writing is kept (not a book, a PDF or a document only read here). */
      words(): DocumentWords | null;
    },
  ) {}

  /** Opens the dialog and asks for the counts. */
  open(): void {
    if (this.dialog) return;
    this.values.clear();
    const table = h('table', { class: 'wm-stats' });
    for (const { key, label } of ROWS) {
      const value = h('td', { class: 'wm-stat-value', text: '…' });
      this.values.set(key, value);
      table.append(h('tr', {}, h('th', { text: t(label), attrs: { scope: 'row' } }), value));
    }
    this.note = h('div', { class: 'wm-find-message', attrs: { role: 'status' } });
    const ok = h('button', { class: 'wm-button', text: t('wordCount.close'), attrs: { type: 'button' } });
    const words = this.host.words();
    this.progress = words ? h('div', { class: 'wm-writing' }) : null;
    const footerChoice = choiceButton({ label: t('wordCount.footer'), groups: () => [{ values: [...WORD_PERIODS] }], name: (v) => t(`wordCount.footer.${v as WordPeriod}`), fill: true }, (v) => {
      footerChoice.set(v);
      setFooterWordPeriod(v as WordPeriod);
    });
    footerChoice.set(footerWordPeriod());
    this.stop.push(onFooterWordPeriodChange(() => footerChoice.set(footerWordPeriod())));
    const dialog = h(
      'dialog',
      { class: 'wm-dialog wm-link wm-wordcount', attrs: { 'aria-label': t('wordCount.title') } },
      dialogTitleBar(t('wordCount.title'), () => dialog.close()),
      h(
        'form',
        { attrs: { method: 'dialog' } },
        h(
          'div',
          { class: 'wm-dialog-body wm-link-body' },
          h('label', { text: t('wordCount.statistics') }),
          table,
          this.note,
          ...(this.progress ? [h('h3', { class: 'wm-writing-heading', text: t('wordCount.progress') }), this.progress] : []),
          h('label', { class: 'wm-wordcount-footer' }, h('span', { text: t('wordCount.footer') }), footerChoice.el),
        ),
        h('div', { class: 'wm-dialog-buttons' }, ok),
      ),
    );
    // Keys stay in the dialog: the document's handlers listen on the window.
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    ok.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      this.dialog = null;
      this.progress = null;
      for (const stop of this.stop.splice(0)) stop();
      this.host.focusEditor();
    });
    this.dialog = dialog;
    document.body.append(dialog);
    dialog.showModal();
    ok.focus();
    this.host.send({ kind: 'countWords' });
    if (words) {
      this.stop.push(words.onChange(() => this.showProgress(words)));
      this.showProgress(words);
      // The days before the history began, from the document's kept versions (once).
      void words.fillFromVersions().then((n) => {
        if (n) this.showProgress(words);
      });
    }
  }

  /** The counts (null: this document has none to give). */
  report(stats: WordStats | null): void {
    if (!this.dialog) return;
    for (const { key } of ROWS) this.values.get(key)!.textContent = stats ? stats[key].toLocaleString() : '—';
    if (this.note) this.note.textContent = stats?.selection ? t('wordCount.selection') : '';
  }

  private showProgress(words: DocumentWords): void {
    const box = this.progress;
    if (!box) return;
    const locale = getLocale();
    const numbers = new Intl.NumberFormat(locale);
    const signed = new Intl.NumberFormat(locale, { signDisplay: 'exceptZero' });
    const days = words.history();
    const today = words.today();
    const weekStart = firstDayOfWeek(locale);

    // Today, this week, this month and this year.
    const totals = h('table', { class: 'wm-stats' });
    for (const period of PERIODS_WRITTEN) {
      const written = writtenBetween(days, periodStart(period, today, weekStart)!, today);
      totals.append(h('tr', {}, h('th', { text: t(`wordCount.period.${period}`), attrs: { scope: 'row' } }), h('td', { class: 'wm-stat-value', text: signed.format(written) })));
    }

    const ranges = segmented(
      t('wordCount.range'),
      RANGES.map((r) => ({ value: r, text: t(`wordCount.range.${r}`) })),
      (r) => {
        this.range = r;
        this.showProgress(words);
      },
    );
    ranges.set(this.range);
    ranges.el.classList.add('wm-writing-ranges');
    const views = segmented(
      t('wordCount.view'),
      [
        { value: 'chart', text: t('wordCount.view.chart') },
        { value: 'table', text: t('wordCount.view.table') },
      ],
      (v) => {
        this.asTable = v === 'table';
        this.showProgress(words);
      },
    );
    views.set(this.asTable ? 'table' : 'chart');
    views.el.classList.add('wm-writing-views');

    const span = rangeSpan(this.range, today, days[0]?.day ?? null);
    const bars = progressBars(days, span.from, span.to, span.by);
    const dayName = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
    const monthName = new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric' });
    const nameOf = (key: string) => (span.by === 'day' ? dayName.format(dateOf(key)) : monthName.format(dateOf(`${key}-01`)));
    const total = bars.reduce((sum, b) => sum + b.written, 0);

    let body: HTMLElement | SVGSVGElement;
    if (!days.length) {
      body = h('p', { class: 'wm-hint', text: t('wordCount.empty') });
    } else if (this.asTable) {
      const rows = bars.filter((b) => b.written !== 0).reverse();
      body = rows.length
        ? h(
            'div',
            { class: 'wm-writing-table' },
            h(
              'table',
              { class: 'wm-stats' },
              h('thead', {}, h('tr', {}, h('th', { text: t(span.by === 'day' ? 'wordCount.column.day' : 'wordCount.column.month'), attrs: { scope: 'col' } }), h('th', { class: 'wm-stat-value', text: t('wordCount.column.written'), attrs: { scope: 'col' } }))),
              h('tbody', {}, ...rows.map((b) => h('tr', {}, h('th', { text: nameOf(b.key), attrs: { scope: 'row' } }), h('td', { class: 'wm-stat-value', text: signed.format(b.written) })))),
            ),
          )
        : h('p', { class: 'wm-hint', text: t('wordCount.noneInRange') });
    } else {
      const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short' });
      const shortMonth = new Intl.DateTimeFormat(locale, { month: 'short' });
      const every = span.by === 'day' ? (bars.length <= 7 ? 1 : 7) : Math.ceil(bars.length / 12);
      const chartBars: ProgressBar[] = bars.map((b, i) => ({
        written: b.written,
        label: (bars.length - 1 - i) % every !== 0 ? null : span.by === 'day' ? (bars.length <= 7 ? weekday.format(dateOf(b.key)) : dayName.format(dateOf(b.key))) : shortMonth.format(dateOf(`${b.key}-01`)),
        title: t('wordCount.bar', { date: nameOf(b.key), count: b.written, n: signed.format(b.written) }),
      }));
      const best = bars.reduce((a, b) => (b.written > a.written ? b : a), bars[0]!);
      const summary = t(span.by === 'day' ? 'wordCount.summary.days' : 'wordCount.summary.months', {
        from: nameOf(bars[0]!.key),
        to: nameOf(bars.at(-1)!.key),
        count: total,
        n: signed.format(total),
        most: best.written > 0 ? nameOf(best.key) : '—',
        best: numbers.format(Math.max(0, best.written)),
      });
      body = h('div', { class: 'wm-writing-chart-box' }, progressChart(chartBars, { width: CHART_WIDTH, height: CHART_HEIGHT, summary, format: (n) => numbers.format(n) }));
    }
    // A choice redraws the section: the focus stays on the control it was on.
    const group = box.contains(document.activeElement) ? (['wm-writing-ranges', 'wm-writing-views'] as const).find((c) => document.activeElement?.closest(`.${c}`)) : undefined;
    box.replaceChildren(totals, h('div', { class: 'wm-writing-controls' }, ranges.el, views.el), body);
    if (group) box.querySelector<HTMLElement>(`.${group} [aria-checked="true"]`)?.focus();
  }
}
