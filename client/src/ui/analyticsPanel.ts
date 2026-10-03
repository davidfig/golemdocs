// The body of Admin > Analytics (admins only): how many unique users there are, how many are new or
// recently signed in, and how the number grew month by month, from the server's /api/admin/analytics.

import { getLocale, t } from '../i18n/index.ts';
import { h } from './dom.ts';

interface Analytics {
  total: number;
  newLast7: number;
  newLast30: number;
  activeLast7: number;
  activeLast30: number;
  paying: number;
  payingCancelling: number;
  formerlyPaid: number;
  payingActiveLast30: number;
  history: { month: string; joined: number; total: number; paying: number }[];
  asOf: number;
}

export function analyticsPanel(): HTMLElement {
  const body = h('div', { class: 'wm-analytics' }, h('p', { text: t('panels.analytics.loading') }));
  void load(body);
  return body;
}

async function load(body: HTMLElement): Promise<void> {
  try {
    const response = await fetch('/api/admin/analytics');
    if (!response.ok) {
      const error = ((await response.json().catch(() => null)) as { error?: string } | null)?.error;
      throw new Error(error ?? t('panels.analytics.status', { status: response.status }));
    }
    render(body, (await response.json()) as Analytics);
  } catch (error) {
    body.replaceChildren(h('p', { class: 'wm-billing-error', text: t('panels.analytics.failed', { reason: error instanceof Error ? error.message : String(error) }) }));
  }
}

function render(body: HTMLElement, a: Analytics): void {
  const number = new Intl.NumberFormat(getLocale());
  const stat = (label: string, value: number, big = false) =>
    h('div', { class: big ? 'wm-analytics-stat big' : 'wm-analytics-stat' }, h('strong', { text: number.format(value) }), h('span', { text: label }));
  const month = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString(getLocale(), { month: 'long', year: 'numeric', timeZone: 'UTC' });
  // Newest month first, like the other admin lists.
  const cell = (value: number) => h('td', { class: 'wm-analytics-number', text: number.format(value) });
  const head = (label: string, right = true) => h('th', { class: right ? 'wm-analytics-number' : '', text: label });
  const percent = new Intl.NumberFormat(getLocale(), { style: 'percent', maximumFractionDigits: 1 });
  const rows = [...a.history].reverse().map((m) => h('tr', {}, h('td', { text: month(m.month) }), cell(m.joined), cell(m.total), cell(m.paying)));
  body.replaceChildren(
    stat(t('panels.analytics.total'), a.total, true),
    h(
      'div',
      { class: 'wm-analytics-stats' },
      stat(t('panels.analytics.new7'), a.newLast7),
      stat(t('panels.analytics.new30'), a.newLast30),
      stat(t('panels.analytics.active7'), a.activeLast7),
      stat(t('panels.analytics.active30'), a.activeLast30),
    ),
    h(
      'div',
      { class: 'wm-analytics-stats' },
      stat(t('panels.analytics.paying'), a.paying),
      h('div', { class: 'wm-analytics-stat' }, h('strong', { text: a.total ? percent.format(a.paying / a.total) : '–' }), h('span', { text: t('panels.analytics.conversion') })),
      stat(t('panels.analytics.cancelling'), a.payingCancelling),
      stat(t('panels.analytics.formerlyPaid'), a.formerlyPaid),
      stat(t('panels.analytics.payingActive30'), a.payingActiveLast30),
    ),
    h('h4', { text: t('panels.analytics.history') }),
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, head(t('panels.analytics.month'), false), head(t('panels.analytics.joined')), head(t('panels.analytics.totalCol')), head(t('panels.analytics.payingCol')))),
      h('tbody', {}, ...rows),
    ),
    h('small', { text: t('panels.analytics.asOf', { time: new Date(a.asOf).toLocaleString(getLocale()) }) }),
  );
}
