// Admin > Analytics: how many people use Golem Docs, from the sign-ins in the directory database.
// A user is one `user_id`, however many providers they signed in with; they joined at their
// earliest identity and were last seen at their latest login.

import type { Env } from './cf.ts';
import { isPaid } from './subscriptions.ts';

const DAY = 24 * 60 * 60 * 1000;

export interface UserAnalytics {
  /** Unique users ever. */
  total: number;
  /** Joined in the last 7 / 30 days. */
  newLast7: number;
  newLast30: number;
  /** Last signed in within the last 7 / 30 days (only the latest login is kept, not every one). */
  activeLast7: number;
  activeLast30: number;
  /** Users paying for sync now (a trial counts), and how many of them have said they will not renew. */
  paying: number;
  payingCancelling: number;
  /** Users who once had a subscription that has since ended. */
  formerlyPaid: number;
  /** Paying users who signed in in the last 30 days. */
  payingActiveLast30: number;
  /** Oldest month first: how many joined in it, how many users there were at its end, and how many of those who joined in it pay now. */
  history: { month: string; joined: number; total: number; paying: number }[];
  /** When this was worked out. */
  asOf: number;
}

/** `2026-10` (UTC) for a time. */
const monthOf = (time: number) => new Date(time).toISOString().slice(0, 7);

export async function userAnalytics(env: Env, now = Date.now()): Promise<UserAnalytics> {
  const { results } = await env.DIRECTORY.prepare(
    `SELECT MIN(i.created_at) AS joined, MAX(i.last_login_at) AS seen, s.status, s.current_period_end, s.cancel_at_period_end
       FROM identities i LEFT JOIN subscriptions s ON s.user_id = i.user_id GROUP BY i.user_id`,
  ).all<{ joined: number; seen: number; status: string | null; current_period_end: number | null; cancel_at_period_end: number | null }>();
  const joinedByMonth = new Map<string, { joined: number; paying: number }>();
  let newLast7 = 0;
  let newLast30 = 0;
  let activeLast7 = 0;
  let activeLast30 = 0;
  let paying = 0;
  let payingCancelling = 0;
  let formerlyPaid = 0;
  let payingActiveLast30 = 0;
  for (const row of results) {
    const { joined, seen } = row;
    const paid = row.status !== null && isPaid({ status: row.status, current_period_end: row.current_period_end }, now);
    const month = joinedByMonth.get(monthOf(joined)) ?? { joined: 0, paying: 0 };
    month.joined++;
    if (paid) month.paying++;
    joinedByMonth.set(monthOf(joined), month);
    if (paid) {
      paying++;
      if (row.cancel_at_period_end) payingCancelling++;
      if (now - seen <= 30 * DAY) payingActiveLast30++;
    } else if (row.status !== null) formerlyPaid++;
    if (now - joined <= 7 * DAY) newLast7++;
    if (now - joined <= 30 * DAY) newLast30++;
    if (now - seen <= 7 * DAY) activeLast7++;
    if (now - seen <= 30 * DAY) activeLast30++;
  }
  let total = 0;
  const history = [...joinedByMonth]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, m]) => ({ month, joined: m.joined, total: (total += m.joined), paying: m.paying }));
  return { total: results.length, newLast7, newLast30, activeLast7, activeLast30, paying, payingCancelling, formerlyPaid, payingActiveLast30, history, asOf: now };
}
