// Shared by the property/fuzz tests (ops, editor, client): a seeded PRNG and a runner that reports
// the failing seed so it can be replayed.
//
//   SEED=n         run only seed n (any fuzz test that uses `forSeeds`)
//   FUZZ_SEEDS=n   scale the number of seeds per test by n (deep runs)
//
// Keep this file dependency-free: the client tests load it with Node's type stripping.

export type Rand = (() => number) & {
  /** Integer in [0, n). */
  int(n: number): number;
  /** Integer in [a, b]. */
  range(a: number, b: number): number;
  bool(p?: number): boolean;
  pick<T>(items: readonly T[]): T;
};

/** Deterministic PRNG (mulberry32) with helpers. */
export function rng(seed: number): Rand {
  let s = seed | 0;
  const next = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = next as Rand;
  r.int = (n) => Math.floor(next() * n);
  r.range = (a, b) => a + Math.floor(next() * (b - a + 1));
  r.bool = (p = 0.5) => next() < p;
  r.pick = (items) => items[Math.floor(next() * items.length)];
  return r;
}

/** Seeds to run: SEED=n gives just that one; otherwise 1..count (times FUZZ_SEEDS). */
export function seedsFor(count: number): number[] {
  if (process.env.SEED) return [Number(process.env.SEED)];
  const scale = Number(process.env.FUZZ_SEEDS ?? 1) || 1;
  return Array.from({ length: Math.round(count * scale) }, (_, i) => i + 1);
}

/**
 * Runs `body` for each seed. A failure is rethrown naming the seed (and `what`), so
 * `SEED=<n> pnpm test` replays exactly it.
 */
export async function forSeeds(what: string, count: number, body: (seed: number, rand: Rand) => void | Promise<void>): Promise<void> {
  for (const seed of seedsFor(count)) {
    if (process.env.FUZZ_TRACE) console.error(`## seed ${seed}: ${what}`);
    try {
      await body(seed, rng(seed));
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      throw new Error(`[fuzz seed ${seed}] ${what} (replay: SEED=${seed})\n${e.message}`, { cause: e });
    }
  }
}

const WORDS = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau'.split(' ');
export const SYMBOLS = ['é', 'é', '中', '\u{1F600}', ' ', '"', "'", '&', '<', '>', '\\', '{', '}', '#', '*', '_', '|', '`', '~', '[', ']', '$', '%', '\t'];

/** Random prose: words, and now and then an awkward character. */
export function randomText(rand: Rand, maxWords = 6, awkward = 0.1): string {
  const n = rand.range(1, maxWords);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(rand.bool(awkward) ? rand.pick(SYMBOLS) : rand.pick(WORDS));
  return parts.join(' ');
}
