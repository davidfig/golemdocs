// Cutting a file into chunks by its content, so that a change to the file changes only the chunks it touches. A rolling
// hash of the last few bytes decides where each chunk ends (FastCDC: a gear hash, with a stricter test before the average
// size and a looser one after, which keeps the sizes close to it), so an insert or a delete moves the cuts near it and
// the ones after it fall in the same places as before. Each chunk is named by its SHA-256. Chunks are the unit this
// browser stores a document in and the unit a save sends to the server (see local.ts and library.ts).
//
// The algorithm is frozen: its name, `cdc1`, goes in every manifest, and a test pins where it cuts a known buffer.
// Changing it would make every stored chunk of every document different from what a save of the same file produces.

export const CHUNK_ALGO = 'cdc1';

/** No chunk is shorter than this (except the last), longer than MAX, and the average is about AVG. */
export const CHUNK_MIN = 128 * 1024;
export const CHUNK_AVG = 512 * 1024;
export const CHUNK_MAX = 2 * 1024 * 1024;

/** Files smaller than this are not chunked: saving them whole is cheap, and chunks would only add overhead. */
export const CHUNK_MIN_FILE = 2 * 1024 * 1024;

/** The cut test looks at this many low bits: more before the average size (harder to cut), fewer after (easier). */
const AVG_BITS = 19;
const MASK_STRICT = (1 << (AVG_BITS + 2)) - 1;
const MASK_LOOSE = (1 << (AVG_BITS - 2)) - 1;
/** Bytes the hash is warmed up on before a chunk's first possible cut (the low bits of the hash depend on the last 21 bytes). */
const WARM = 32;

/** 256 fixed pseudo-random numbers, one per byte value (mulberry32 from a fixed seed). */
const GEAR = (() => {
  const table = new Int32Array(256);
  let state = 0x9e3779b9;
  for (let i = 0; i < 256; i++) {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    table[i] = (t ^ (t >>> 14)) | 0;
  }
  return table;
})();

/** The length of the chunk that starts at `start`. */
function chunkLength(bytes: Uint8Array, start: number): number {
  const remaining = bytes.length - start;
  if (remaining <= CHUNK_MIN) return remaining;
  const max = Math.min(CHUNK_MAX, remaining);
  const normal = Math.min(CHUNK_AVG, max);
  let hash = 0;
  let i = start + CHUNK_MIN - WARM;
  for (; i < start + CHUNK_MIN; i++) hash = ((hash << 1) + GEAR[bytes[i]]) | 0;
  for (; i < start + normal; i++) {
    hash = ((hash << 1) + GEAR[bytes[i]]) | 0;
    if ((hash & MASK_STRICT) === 0) return i + 1 - start;
  }
  for (; i < start + max; i++) {
    hash = ((hash << 1) + GEAR[bytes[i]]) | 0;
    if ((hash & MASK_LOOSE) === 0) return i + 1 - start;
  }
  return max;
}

/** Where each chunk of the bytes ends (the offsets after them, the last being the length). */
export function cutPoints(bytes: Uint8Array): number[] {
  const ends: number[] = [];
  for (let start = 0; start < bytes.length; ) {
    start += chunkLength(bytes, start);
    ends.push(start);
  }
  return ends;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** One chunk of a file: its name (hash) and length. */
export interface ChunkRef {
  h: string;
  n: number;
}

/** What a file is made of: its chunks in order. */
export interface Manifest {
  algo: typeof CHUNK_ALGO;
  size: number;
  chunks: ChunkRef[];
}

/** The chunks of a file that are not among the `known` hashes: each distinct one once, with its bytes. */
export interface Chunked {
  manifest: Manifest;
  fresh: { hash: string; bytes: Uint8Array }[];
}

/** Cuts a file into chunks and names them. `fresh` holds (views of) the bytes of those not in `known`. */
export async function chunkBytes(bytes: Uint8Array, known: ReadonlySet<string> = new Set()): Promise<Chunked> {
  const ends = cutPoints(bytes);
  const refs: ChunkRef[] = new Array(ends.length);
  const parts: Uint8Array[] = new Array(ends.length);
  // Hashing is native and asynchronous: a few at a time keeps it busy without holding every digest promise at once.
  for (let first = 0; first < ends.length; first += 16) {
    const batch: Promise<void>[] = [];
    for (let i = first; i < Math.min(first + 16, ends.length); i++) {
      const part = bytes.subarray(i === 0 ? 0 : ends[i - 1], ends[i]);
      parts[i] = part;
      batch.push(sha256Hex(part).then((h) => void (refs[i] = { h, n: part.length })));
    }
    await Promise.all(batch);
  }
  const fresh: Chunked['fresh'] = [];
  const seen = new Set<string>();
  refs.forEach(({ h }, i) => {
    if (known.has(h) || seen.has(h)) return;
    seen.add(h);
    fresh.push({ hash: h, bytes: parts[i] });
  });
  return { manifest: { algo: CHUNK_ALGO, size: bytes.length, chunks: refs }, fresh };
}

/** The bytes a manifest describes, from a store of chunks by hash; null if one is missing. */
export function assemble(manifest: Manifest, chunk: (hash: string) => Uint8Array | undefined): Uint8Array | null {
  const out = new Uint8Array(manifest.size);
  let at = 0;
  for (const { h, n } of manifest.chunks) {
    const part = chunk(h);
    if (!part || part.length !== n) return null;
    out.set(part, at);
    at += n;
  }
  return at === manifest.size ? out : null;
}
