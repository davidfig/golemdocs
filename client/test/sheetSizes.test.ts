import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sizes } from '../src/sheet/model/sizes.ts';

/** A seeded generator, so a failure repeats. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('uniform sizes are arithmetic', () => {
  const sizes = new Sizes(1_048_576, 15);
  assert.equal(sizes.position(1000), 15000);
  assert.equal(sizes.indexAt(15000), 1000);
  assert.equal(sizes.indexAt(14999.9), 999);
  assert.equal(sizes.indexAt(1e12), 1_048_575);
  assert.equal(sizes.total(), 1_048_576 * 15);
  assert.ok(sizes.uniform);
});

test('sizes, hidden and structure changes agree with a plain array', () => {
  const next = random(7);
  const count = 500;
  const sizes = new Sizes(count, 15);
  let own: (number | null)[] = Array(count).fill(null);
  let hidden: boolean[] = Array(count).fill(false);
  for (let step = 0; step < 2000; step++) {
    const i = Math.floor(next() * count);
    const op = next();
    if (op < 0.4) {
      const size = next() < 0.2 ? null : Math.round(next() * 40);
      sizes.set(i, size);
      own[i] = size;
    } else if (op < 0.6) {
      const h = next() < 0.5;
      sizes.setHidden(i, h);
      hidden[i] = h;
    } else if (op < 0.7) {
      const n = 1 + Math.floor(next() * 5);
      sizes.insert(i, n);
      own = [...own.slice(0, i), ...Array(n).fill(null), ...own.slice(i)].slice(0, count);
      hidden = [...hidden.slice(0, i), ...Array(n).fill(false), ...hidden.slice(i)].slice(0, count);
    } else if (op < 0.8) {
      const n = Math.min(count - i, 1 + Math.floor(next() * 5));
      sizes.remove(i, n);
      own = [...own.slice(0, i), ...own.slice(i + n), ...Array(n).fill(null)];
      hidden = [...hidden.slice(0, i), ...hidden.slice(i + n), ...Array(n).fill(false)];
    }
    if (step % 50 === 0) {
      let at = 0;
      for (let k = 0; k < count; k++) {
        const size = hidden[k] ? 0 : (own[k] ?? 15);
        assert.equal(sizes.size(k), size, `size ${k} at step ${step}`);
        assert.ok(Math.abs(sizes.position(k) - at) < 1e-6, `position ${k} at step ${step}`);
        if (size > 0) assert.equal(sizes.indexAt(at + size / 2), k, `indexAt inside ${k}`);
        at += size;
      }
    }
  }
});

test('a state taken out comes back the same', () => {
  const sizes = new Sizes(100, 15);
  sizes.set(3, 30);
  sizes.setHidden(5, true);
  const back = Sizes.from(100, sizes.state());
  assert.equal(back.position(10), sizes.position(10));
  assert.deepEqual([...back.specials()], [3, 5]);
});
