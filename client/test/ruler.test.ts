import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rulerTicks } from '../src/ui/ruler.ts';

const labels = (from: number, to: number, px: number, metric: boolean) =>
  rulerTicks(from, to, px, metric).filter((t) => t.size === 'major').map((t) => t.label);

test('ruler: an inch is eight marks, with the half inch longer and the whole inch labelled', () => {
  const ticks = rulerTicks(0, 1, 96, false);
  assert.deepEqual(ticks.map((t) => t.size), ['major', 'minor', 'minor', 'minor', 'half', 'minor', 'minor', 'minor', 'major']);
  assert.deepEqual(ticks.filter((t) => t.label !== undefined).map((t) => t.label), [0, 1]);
});

test('ruler: a centimetre is ten marks with the half longer', () => {
  const ticks = rulerTicks(0, 1, 48, true);
  assert.equal(ticks.length, 11);
  assert.equal(ticks[5].size, 'half');
});

test('ruler: left of zero counts up again, as distances from the margin', () => {
  assert.deepEqual(labels(-2, 2, 96, false), [2, 1, 0, 1, 2]);
});

test('ruler: zoomed out, it drops the small marks and labels every few units', () => {
  const ticks = rulerTicks(0, 20, 3, false);
  assert.ok(ticks.every((t) => Number.isInteger(t.at)));
  assert.deepEqual(labels(0, 20, 3, false), [0, 10, 20]);
});
