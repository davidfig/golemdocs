// The body of View > Cloudflare Billing (admins only): this month's Cloudflare charges by service,
// from the server's /api/admin/billing.

import { h } from './dom.ts';

interface Billing {
  currency: string;
  from: string;
  to: string;
  total: number;
  services: { name: string; cost: number }[];
}

export function billingPanel(): HTMLElement {
  const body = h('div', { class: 'wm-billing' }, h('p', { text: 'Loading…' }));
  void load(body);
  return body;
}

async function load(body: HTMLElement): Promise<void> {
  try {
    const response = await fetch('/api/admin/billing');
    if (!response.ok) {
      const error = ((await response.json().catch(() => null)) as { error?: string } | null)?.error;
      throw new Error(error ?? `status ${response.status}`);
    }
    render(body, (await response.json()) as Billing);
  } catch (error) {
    body.replaceChildren(h('p', { class: 'wm-billing-error', text: `Couldn't get billing: ${error instanceof Error ? error.message : error}` }));
  }
}

function render(body: HTMLElement, billing: Billing): void {
  const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: billing.currency, minimumFractionDigits: 2, maximumFractionDigits: 4 });
  const month = new Date(billing.from).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const rows = billing.services.map((s) => h('tr', {}, h('td', { text: s.name }), h('td', { class: 'wm-billing-cost', text: money.format(s.cost) })));
  body.replaceChildren(
    h('p', {}, h('strong', { text: `${month} so far: ${money.format(billing.total)}` })),
    rows.length ? h('table', {}, h('tbody', {}, ...rows)) : h('p', { text: 'No charges yet this month.' }),
    h('small', { text: `As of ${new Date(billing.to).toLocaleString()}. Cloudflare may take a while to report usage.` }),
  );
}
