// What Cloudflare is charging for this account, for the admin billing panel. Reads the account's
// billable usage (one record per service per charge period) and totals it by service.

import type { Env } from './cf.ts';
import { HttpError } from './http.ts';

export interface MonthCharges {
  /** ISO dates: the start of the month and its end (or now, for the current month). */
  from: string;
  to: string;
  /** Sum of every charge, in the summary's `currency`. */
  total: number;
  services: { name: string; cost: number }[];
}

export interface BillingSummary extends MonthCharges {
  currency: string;
  /** The months before this one, most recent first. */
  history: MonthCharges[];
}

/** How many earlier months are listed. */
const HISTORY_MONTHS = 5;

interface UsageRecord {
  BilledCost?: number;
  ContractedCost?: number;
  EffectiveCost?: number;
  BillingCurrency?: string;
  ServiceName?: string;
}

const CACHE_MS = 5 * 60 * 1000;
let cached: { at: number; summary: BillingSummary } | null = null;

export async function billingSummary(env: Env): Promise<BillingSummary> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.summary;
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || env.CF_ACCOUNT_ID.startsWith('REPLACE')) throw new HttpError(503, 'Cloudflare is not configured');

  const now = new Date();
  const monthStart = (back: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
  const months = await Promise.all(
    Array.from({ length: HISTORY_MONTHS + 1 }, (_, back) => chargesBetween(env, monthStart(back), back === 0 ? now : monthStart(back - 1))),
  );
  const [current, ...history] = months;
  const currency = months.find((m) => m.currency)?.currency ?? 'USD';
  const summary = { ...current.charges, currency, history: history.map((m) => m.charges) };
  cached = { at: Date.now(), summary };
  return summary;
}

async function chargesBetween(env: Env, from: Date, to: Date): Promise<{ currency: string; charges: MonthCharges }> {
  const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/billable-usage?${query}`, {
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}` },
  });
  const envelope = (await response.json().catch(() => null)) as { success?: boolean; result?: UsageRecord[]; errors?: { message: string }[] } | null;
  if (!response.ok || !envelope?.success) {
    const why = envelope?.errors?.map((e) => e.message).join('; ') || `status ${response.status}`;
    throw new HttpError(502, `Cloudflare billing request failed: ${why} (the API token needs Billing Read permission)`);
  }

  const byService = new Map<string, number>();
  let currency = '';
  let total = 0;
  for (const record of envelope.result ?? []) {
    const cost = record.BilledCost ?? record.EffectiveCost ?? record.ContractedCost ?? 0;
    if (record.BillingCurrency) currency = record.BillingCurrency;
    total += cost;
    const name = record.ServiceName || 'Other';
    byService.set(name, (byService.get(name) ?? 0) + cost);
  }
  const services = [...byService].map(([name, cost]) => ({ name, cost })).sort((a, b) => b.cost - a.cost);
  return { currency, charges: { from: from.toISOString(), to: to.toISOString(), total, services } };
}
