// Admin > Analytics: unique users and how their number grew; only admins can read it.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { userAnalytics } from '../src/analytics.ts';
import { world, type World } from './harness.ts';

let w: World;
const ADMIN = 'admin@example.com';
const DAY = 86400_000;
const NOW = Date.UTC(2026, 9, 15, 12);

beforeEach(async () => {
  w = world();
  w.env.ADMIN_EMAILS = ADMIN;
  await w.signUp(ADMIN, 'admin');
});
afterEach(() => w.restore());

const identity = (provider: string, subject: string, user: string, joined: number, seen: number) =>
  w.env.DIRECTORY.prepare('INSERT INTO identities (provider, subject, user_id, email_verified, created_at, last_login_at) VALUES (?, ?, ?, 0, ?, ?)').bind(provider, subject, user, joined, seen).run();

test('a user with several sign-ins counts once, joined at their first and seen at their last', async () => {
  await w.env.DIRECTORY.prepare('DELETE FROM identities').run();
  await identity('google', 'a', 'u1', NOW - 60 * DAY, NOW - 40 * DAY);
  await identity('github', 'a', 'u1', NOW - 3 * DAY, NOW - 1 * DAY);
  await identity('google', 'b', 'u2', NOW - 20 * DAY, NOW - 20 * DAY);
  await identity('google', 'c', 'u3', NOW - 2 * DAY, NOW - 2 * DAY);
  const a = await userAnalytics(w.env, NOW);
  assert.equal(a.total, 3);
  assert.equal(a.newLast7, 1);
  assert.equal(a.newLast30, 2);
  assert.equal(a.activeLast7, 2);
  assert.equal(a.activeLast30, 3);
});

test('history lists the months oldest first, with the running total', async () => {
  await w.env.DIRECTORY.prepare('DELETE FROM identities').run();
  await identity('google', 'a', 'u1', Date.UTC(2026, 7, 31, 23), NOW);
  await identity('google', 'b', 'u2', Date.UTC(2026, 9, 1), NOW);
  await identity('google', 'c', 'u3', Date.UTC(2026, 9, 9), NOW);
  const { history } = await userAnalytics(w.env, NOW);
  assert.deepEqual(history, [
    { month: '2026-08', joined: 1, total: 1, paying: 0 },
    { month: '2026-10', joined: 2, total: 3, paying: 0 },
  ]);
});

const subscribe = (user: string, status: string, periodEnd: number | null, cancelling = 0) =>
  w.env.DIRECTORY.prepare('INSERT INTO subscriptions (user_id, polar_id, status, current_period_end, cancel_at_period_end, modified_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0)').bind(user, `sub_${user}`, status, periodEnd, cancelling).run();

test('paying users are counted by who pays now, with those who left and the month each joined', async () => {
  await w.env.DIRECTORY.prepare('DELETE FROM identities').run();
  await identity('google', 'a', 'u1', Date.UTC(2026, 8, 3), NOW - 1 * DAY); // active
  await identity('google', 'b', 'u2', Date.UTC(2026, 9, 2), NOW - 90 * DAY); // trialing, will not renew, long gone
  await identity('google', 'c', 'u3', Date.UTC(2026, 9, 3), NOW); // canceled and ended
  await identity('google', 'd', 'u4', Date.UTC(2026, 9, 4), NOW); // "active" but its period ran out long ago
  await identity('google', 'e', 'u5', Date.UTC(2026, 9, 5), NOW); // never subscribed
  await subscribe('u1', 'active', NOW + 20 * DAY);
  await subscribe('u2', 'trialing', NOW + 5 * DAY, 1);
  await subscribe('u3', 'canceled', NOW - 10 * DAY);
  await subscribe('u4', 'active', NOW - 10 * DAY);
  const a = await userAnalytics(w.env, NOW);
  assert.equal(a.total, 5);
  assert.equal(a.paying, 2);
  assert.equal(a.payingCancelling, 1);
  assert.equal(a.formerlyPaid, 2);
  assert.equal(a.payingActiveLast30, 1);
  assert.deepEqual(a.history.map((m) => [m.month, m.joined, m.paying]), [['2026-09', 1, 1], ['2026-10', 4, 1]]);
});

test('only admins can read analytics', async () => {
  await w.signUp('alice@example.com', 'alice');
  const r = await w.call(ADMIN, 'GET', '/api/admin/analytics');
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as any).total, 2);
  assert.equal((await w.call('alice@example.com', 'GET', '/api/admin/analytics')).status, 403);
  assert.equal((await w.call(null, 'GET', '/api/admin/analytics')).status, 401);
});
