// Round-trip and robustness fuzzing for the document formats (src/formats). Generated documents are
// exported and read back, and must keep what the format can hold; arbitrary bytes must never hang
// or throw anything but an Error. Every input comes from a seed: replay one with
// `SEED=n pnpm --filter @golemdocs/client test` (FUZZ_SEEDS=n for n times as many seeds).

import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { test } from 'node:test';
import { forSeeds, randomText, rng, seedsFor, type Rand } from '../../ops/test/fuzz.ts';
import { WordDocument } from '@golemdocs/docx';
import { exportDocument, importDocument, type Format } from '../src/formats/convert.ts';
import { isWdoc, readWdoc, WDOC_VERSION, writeWdoc, type Extensions } from '../src/formats/wdoc.ts';
import { documentToOutline, outlineToDocument, tidy, type ListItem, type Node, type Span } from '../src/formats/outline.ts';

const fonts = undefined as never;
const str = (b: Uint8Array) => new TextDecoder().decode(b);

// --- Generated outlines --------------------------------------------------------------------------

interface Profile {
  /** Node kinds to generate. */
  nodes: readonly Node['t'][];
  /** Span marks to generate. */
  marks: readonly ('bold' | 'italic' | 'code' | 'link' | 'strike' | 'underline' | 'sup' | 'sub')[];
  /** Characters that need escaping in some format (`#`, `*`, `\`...) in the text. */
  awkward: number;
  /** Line breaks inside paragraphs. */
  breaks?: boolean;
  /** Text and marks are not combined (reStructuredText cannot nest inline markup). */
  single?: boolean;
  /** Nested lists (one level). */
  nested?: boolean;
  /** Deepest heading level (RTF flattens the look of headings 4 and below into direct formatting). */
  maxHeading?: number;
  /** No two tables in a row (they merge in RTF, as in Word). */
  spacedTables?: boolean;
  /** Characters that cannot go in a code block (TeX's verbatim drops a % and the rest of the line). */
  avoidInCode?: RegExp;
  /** Text this format cannot hold as it is (TeX turns a backtick into a quote), replaced by a letter. */
  avoid?: RegExp;
}

const FULL: Profile = { nodes: ['heading', 'para', 'list', 'code', 'quote', 'table', 'rule'], marks: ['bold', 'italic', 'code', 'link'], awkward: 0.08, breaks: false, nested: true };

/** Words and awkward characters, on one line, starting with a word (a leading `*`, `#` or `|` is markup in some formats). */
function words(rand: Rand, max: number, awkward: number, avoid?: RegExp): string {
  let text = randomText(rand, max, awkward).replace(/[\t\u00a0]/g, ' ').replace(/ {2,}/g, ' ');
  if (avoid) text = text.replace(avoid, 'x');
  return /^\p{L}/u.test(text) ? text : 'w ' + text.trimStart();
}

/** Words with some marked, joined by plain spaces: text never starts or ends with a space inside a mark. */
function spans(rand: Rand, p: Profile, max = 6): Span[] {
  const out: Span[] = [];
  const n = rand.range(1, max);
  let previousMarked = false;
  for (let i = 0; i < n; i++) {
    if (i > 0) out.push({ text: ' ' });
    const text = words(rand, 2, p.awkward, p.avoid).trim() || 'x';
    const span: Span = { text };
    // Two marked words are never separated by just a space (formats mark the space too, which looks the same).
    if (p.marks.length && !previousMarked && rand.bool(0.35)) {
      const mark = rand.pick(p.marks);
      if (mark === 'link') span.link = 'https://example.com/' + rand.int(100);
      else span[mark] = true;
      if (!p.single && rand.bool(0.15) && mark !== 'code') {
        const other = rand.pick(p.marks.filter((m) => m !== 'link' && m !== 'code'));
        if (other) span[other] = true;
      }
    }
    previousMarked = Object.keys(span).length > 1;
    out.push(span);
    if (p.breaks && rand.bool(0.05) && i < n - 1) out.push({ text: '', br: true });
  }
  return tidy(out);
}

function listItems(rand: Rand, p: Profile, depth: number): ListItem[] {
  return Array.from({ length: rand.range(1, 3) }, () => ({
    spans: spans(rand, p, 3),
    children: p.nested && depth < 1 && rand.bool(0.25) ? [{ t: 'list', ordered: rand.bool(), start: 1, items: listItems(rand, p, depth + 1) }] : [],
  }));
}

function outline(rand: Rand, p: Profile): Node[] {
  const out: Node[] = [];
  let level = 0; // headings start at 1 and go down one level at a time (reStructuredText numbers them by first appearance)
  for (let i = rand.range(1, 7); i > 0; i--) {
    let t = rand.pick(p.nodes);
    // Two lists in a row are one list in most formats.
    if (t === 'list' && out.at(-1)?.t === 'list') t = 'para';
    if (t === 'rule' && out.length === 0) t = 'para'; // a file that starts with --- has front matter (see the todo below)
    if (t === 'table' && p.spacedTables && out.at(-1)?.t === 'table') t = 'para';
    switch (t) {
      case 'heading':
        level = rand.range(1, Math.min(level + 1, p.maxHeading ?? 4));
        out.push({ t, level, spans: spans(rand, { ...p, marks: [] }, 4) });
        break;
      case 'para':
        out.push({ t, spans: spans(rand, p) });
        break;
      case 'list':
        out.push({ t, ordered: rand.bool(), start: 1, items: listItems(rand, p, 0) });
        break;
      case 'code':
        out.push({ t, text: Array.from({ length: rand.range(1, 3) }, () => words(rand, 5, p.awkward * 2, p.avoid).trimEnd().replace(p.avoidInCode ?? /$^/, 'x')).join('\n') });
        break;
      case 'quote': // (no italic marks: a quote is italic already)
        out.push({ t, paras: Array.from({ length: rand.range(1, 2) }, () => spans(rand, { ...p, marks: p.marks.filter((m) => m !== 'italic') }, 4)) });
        break;
      case 'table': {
        const cols = rand.range(1, 3);
        out.push({ t, header: true, rows: Array.from({ length: rand.range(2, 3) }, () => Array.from({ length: cols }, () => [{ text: words(rand, 2, p.awkward, p.avoid).trim() || 'x' }])) });
        break;
      }
      case 'rule':
        out.push({ t });
        break;
    }
  }
  return out;
}

/** The outline of the model built from a generated outline: what any format that holds all of it must give back. */
async function generated(rand: Rand, p: Profile) {
  const document = await outlineToDocument(outline(rand, p));
  return { document, wanted: documentToOutline(document) };
}

/** JSON with object keys sorted (reading may build an object with its keys in another order). */
const canonical = (value: unknown): string => JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1))) : v));

const strip = (nodes: unknown, keys: string[]) => JSON.parse(JSON.stringify(nodes, (k, v) => (keys.includes(k) ? undefined : v)));

// --- Formats that hold an outline ------------------------------------------------------------------

interface Case {
  format: Format;
  profile: Profile;
  /** Outline keys the format can't hold. */
  ignore?: string[];
}

const NO_BACKTICK = /`/g; // TeX reads a backtick as an opening quote, so `x` comes back as ‘x

const TEXT_FORMATS: Case[] = [
  { format: 'md', profile: FULL },
  { format: 'tex', profile: { ...FULL, avoid: NO_BACKTICK, avoidInCode: /%/g }, ignore: ['lang'] },
  { format: 'adoc', profile: { ...FULL, avoid: /#/g } },
  { format: 'rst', profile: { ...FULL, single: true } },
  { format: 'org', profile: { ...FULL, avoid: /\]/g } },
  { format: 'mediawiki', profile: FULL },
  { format: 'textile', profile: FULL },
  { format: 'typst', profile: FULL },
  { format: 'docbook', profile: FULL },
  { format: 'jats', profile: FULL },
  // FictionBook has no lists or code blocks.
  { format: 'fb2', profile: { ...FULL, nodes: ['heading', 'para', 'quote', 'table', 'rule'] } },
  { format: 'html', profile: FULL },
  { format: 'epub', profile: FULL },
  { format: 'mhtml', profile: FULL },
];

const CASES: Case[] = [
  ...TEXT_FORMATS,
  // Word and OpenDocument hold all of it.
  { format: 'odt', profile: FULL },
  { format: 'docx', profile: FULL },
  // RTF flattens styles into direct formatting (a quote comes back italic, code as monospace text, a
  // rule as an empty paragraph), merges tables that touch, and does not read hyperlinks or header rows
  // back the way it writes them (see the todo tests below).
  { format: 'rtf', profile: { nodes: ['heading', 'para', 'list', 'table'], marks: ['bold', 'italic', 'code'], awkward: 0.08, nested: true, maxHeading: 3, spacedTables: true }, ignore: ['header'] },
];

const binary = new Set<Format>(['odt', 'docx', 'epub']);

for (const c of CASES) {
  test(`property: ${c.format} keeps an outline through export and import`, async () => {
    await forSeeds(`${c.format} outline round trip`, 60, async (seed, rand) => {
      const { document, wanted } = await generated(rand, c.profile);
      const file = await exportDocument(document, {}, c.format, fonts);
      const back = await importDocument(c.format, file);
      const got = documentToOutline(back.document);
      const a = strip(got, c.ignore ?? []);
      const b = strip(wanted, c.ignore ?? []);
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        const i = b.findIndex((node: unknown, k: number) => JSON.stringify(node) !== JSON.stringify(a[k]));
        assert.fail(`first difference at node ${i}\n  wanted: ${JSON.stringify(b[i])}\n  got:    ${JSON.stringify(a[i])}\nfile:\n${binary.has(c.format) ? '(binary)' : str(file)}`);
      }
    });
  });
}

for (const c of TEXT_FORMATS) {
  test(`property: ${c.format} export is stable once it has been read back`, async () => {
    // Write, read, write: the second file equals the first (nothing is added or lost on later trips).
    await forSeeds(`${c.format} export stability`, 40, async (seed, rand) => {
      const { document } = await generated(rand, c.profile);
      const first = await exportDocument(document, {}, c.format, fonts);
      const back = await importDocument(c.format, first);
      const second = await exportDocument(back.document, back.extensions, c.format, fonts);
      if (c.format === 'epub' || c.format === 'mhtml') return void assert.deepEqual(documentToOutline((await importDocument(c.format, second)).document), documentToOutline(back.document));
      assert.equal(str(second), str(first));
    });
  });
}

test('property: a Word document keeps its content exactly through write and read', async () => {
  await forSeeds('docx exact round trip', 60, async (seed, rand) => {
    const { document } = await generated(rand, FULL);
    const back = await WordDocument.read(await document.write());
    const a = canonical(back.body).replace(/,"relationshipId":"[^"]*"/g, ''); // links get their relationship ids when written
    const b = canonical(document.body);
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    assert.equal(a, b, `first difference at character ${i}\n  read back: …${a.slice(Math.max(0, i - 80), i + 100)}\n  original:  …${b.slice(Math.max(0, i - 80), i + 100)}`);
  });
});

// --- Plain text, CSV and TSV come back byte for byte ------------------------------------------------

const ENDINGS = ['\n', '\r\n', '\r'] as const;

/** Lines of text, with one kind of line ending (or none at the end), an optional byte order mark, in UTF-8 or UTF-16. */
function textFile(rand: Rand, lines: string[]): Uint8Array {
  const ending = rand.pick(ENDINGS);
  const text = lines.join(ending) + (rand.bool(0.7) ? ending : '');
  const encoding = rand.pick(['utf-8', 'utf-8', 'utf-16le', 'utf-16be'] as const);
  if (encoding === 'utf-8') {
    const body = new TextEncoder().encode(text);
    return rand.bool(0.2) ? Uint8Array.from([0xef, 0xbb, 0xbf, ...body]) : body;
  }
  const out = [encoding === 'utf-16le' ? [0xff, 0xfe] : [0xfe, 0xff]].flat();
  for (const unit of Array.from({ length: text.length }, (_, i) => text.charCodeAt(i))) out.push(...(encoding === 'utf-16le' ? [unit & 255, unit >> 8] : [unit >> 8, unit & 255]));
  return Uint8Array.from(out);
}

const sameBytes = (a: Uint8Array, b: Uint8Array, message: string) => assert.equal(Buffer.from(a).toString('hex'), Buffer.from(b).toString('hex'), message);

test('property: a text file comes back byte for byte, whatever its lines, endings and encoding', async () => {
  const handler = (await import('../src/formats/handlers/txt.ts')).default;
  await forSeeds('txt byte round trip', 200, async (seed, rand) => {
    const lines = Array.from({ length: rand.range(0, 6) }, () => (rand.bool(0.2) ? '' : randomText(rand, 8, 0.3).replace(/\u0000/g, '')));
    const bytes = textFile(rand, lines);
    const { document, extensions } = await handler.read(bytes);
    sameBytes(await handler.write(document, extensions, fonts), bytes, `lines ${JSON.stringify(lines)}`);
  });
});

/** One field of a CSV file, quoted only when it has to be. */
const field = (value: string, delimiter: string) => (/["\r\n]/.test(value) || value.includes(delimiter) ? `"${value.replace(/"/g, '""')}"` : value);

for (const [name, delimiter] of [['csv', ','], ['csv', ';'], ['csv', '|'], ['tsv', '\t']] as const) {
  test(`property: a ${name} file with the delimiter ${JSON.stringify(delimiter)} comes back byte for byte`, async () => {
    const { csv, tsv } = await import('../src/formats/handlers/csv.ts');
    const handler = name === 'csv' ? csv : tsv;
    await forSeeds(`${name} ${JSON.stringify(delimiter)} byte round trip`, 150, async (seed, rand) => {
      const columns = rand.range(2, 5);
      const cell = () => (rand.bool(0.15) ? '' : rand.bool(0.2) ? String(rand.int(1000)) : rand.bool(0.15) ? `${randomText(rand, 2, 0.2)}${delimiter}${randomText(rand, 2, 0)}` : rand.bool(0.1) ? `say "${randomText(rand, 2, 0)}"` : rand.bool(0.1) ? `${randomText(rand, 1, 0)}\n${randomText(rand, 1, 0)}` : randomText(rand, 3, 0.05));
      const rows = Array.from({ length: rand.range(2, 6) }, () => Array.from({ length: columns }, () => cell().replace(/\t/g, ' ').replace(/[\u0000 ]/g, ' ')));
      const ending = rand.pick(['\n', '\r\n'] as const);
      // Fields that embed a line break keep it as \n whatever the file's endings are, so keep it simple: a file with \n only when fields break lines.
      const lineEnding = rows.some((r) => r.some((f) => f.includes('\n'))) ? '\n' : ending;
      const text = rows.map((r) => r.map((f) => field(f, delimiter)).join(delimiter)).join(lineEnding) + (rand.bool(0.7) ? lineEnding : '');
      const bytes = new TextEncoder().encode(text);
      const { document, extensions } = await handler.read(bytes);
      const back = await handler.write(document, extensions, fonts);
      assert.equal(str(back), text, `rows ${JSON.stringify(rows)}`);
    });
  });
}

// --- .wdoc ---------------------------------------------------------------------------------------------

test('property: a .wdoc keeps its document, extensions and manifest', async () => {
  await forSeeds('wdoc round trip', 60, async (seed, rand) => {
    const { document } = await generated(rand, FULL);
    const docx = await document.write();
    const extensions: Extensions = {
      ...(rand.bool() && { md: { frontMatter: randomText(rand, 6, 0.3) } }),
      ...(rand.bool() && { txt: { lineEnding: rand.pick(['\r\n', '\r'] as const), bom: rand.bool() } }),
      ...(rand.bool() && { csv: { delimiter: rand.pick([';', '|'] as const) } }),
    };
    const bytes = await writeWdoc({ manifest: { version: WDOC_VERSION, lens: rand.pick(['md', 'txt', 'docx'] as const) } as never, document: docx, original: null, extensions });
    assert.ok(isWdoc(bytes));
    const back = await readWdoc(bytes);
    sameBytes(back.document!, docx, 'the document is stored untouched');
    assert.deepEqual(back.extensions, extensions);
  });
});

// --- Garbage in ----------------------------------------------------------------------------------------

const READABLE: Format[] = ['docx', 'odt', 'rtf', 'html', 'epub', 'mhtml', 'csv', 'tsv', 'tex', 'adoc', 'rst', 'org', 'mediawiki', 'textile', 'typst', 'docbook', 'jats', 'fb2', 'opml', 'eml', 'ipynb', 'md', 'txt', 'pdf', 'png', 'jpeg', 'webp'];
/** Formats that can be written without fonts (the others draw pages). */
const WRITABLE = new Set<Format>(READABLE.filter((f) => !['pdf', 'png', 'jpeg', 'webp'].includes(f)));

function randomBytes(rand: Rand, max: number): Uint8Array {
  const style = rand.int(4);
  const n = rand.int(max);
  const alphabet = '<>/{}[]\\|*_#-=`~"\':;,.&%$@! \n\r\tabcdefpxyz0123456789'.split('');
  return Uint8Array.from({ length: n }, () => (style === 0 ? rand.int(256) : style === 1 ? rand.pick(alphabet).charCodeAt(0) : style === 2 ? (rand.bool(0.1) ? rand.int(256) : rand.pick(alphabet).charCodeAt(0)) : rand.pick([0, 255, 0x50, 0x4b, 3, 4, 0x25, 0x7b, 0x3c])));
}

/** A valid file of some format with bytes changed, cut short, or repeated. */
function damaged(rand: Rand, file: Uint8Array): Uint8Array {
  let out = file.slice();
  for (let hits = rand.range(1, 12); hits > 0 && out.length; hits--) out[rand.int(out.length)] = rand.int(256);
  const r = rand();
  if (r < 0.3) out = out.subarray(0, rand.int(out.length + 1));
  else if (r < 0.4) out = Uint8Array.from([...out.subarray(0, rand.int(out.length)), ...out.subarray(rand.int(out.length))]);
  return out;
}

const time = () => performance.now();

/**
 * Reads each input as `format` in a worker thread: it must return, or fail with an Error, and reading
 * must not leave a document that cannot be written back. A worker that goes quiet for `stallMs` is
 * stopped. Returns what went wrong, naming the input.
 */
export async function misbehaviour(format: Format, inputs: Uint8Array[], write: boolean, stallMs = 4000): Promise<string[]> {
  const usable = inputs;
  const worker = new Worker(new URL('./fuzzWorker.ts', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 1024 } });
  const problems: string[] = [];
  const describe = (i: number) => `${format} input ${i} of ${usable.length} (${usable[i].length} bytes: ${JSON.stringify(Buffer.from(usable[i].subarray(0, 120)).toString('latin1'))}${usable[i].length > 120 ? '…' : ''})`;
  await new Promise<void>((resolve) => {
    let current = 0;
    let timer = setTimeout(stalled, 20_000); // the worker's first load
    function stalled() {
      problems.push(`${describe(current)} hung (no answer in ${stallMs} ms)`);
      void worker.terminate().then(() => resolve());
    }
    worker.on('message', (m: { start?: number; done?: number; error?: string; finished?: boolean }) => {
      clearTimeout(timer);
      if (m.start !== undefined) current = m.start;
      if (m.error) problems.push(`${describe(m.done ?? current)}: ${m.error}`);
      if (m.finished) return void worker.terminate().then(() => resolve());
      timer = setTimeout(stalled, stallMs);
    });
    worker.on('error', (e) => {
      clearTimeout(timer);
      problems.push(`${describe(current)} crashed the worker: ${e instanceof Error ? e.message : String(e)}`);
      resolve();
    });
    worker.postMessage({ format, inputs: usable, write });
  });
  return problems;
}

/** Real markup fragments, strung together: what bytes at random never manage to be. */
const SOUP = ['#', ':', ';', '*', '=', '|', '{|', '|}', '|-', '!', '-', '+', '\\', '\\begin{', '\\end{', '\\item ', '\\section{', '}', '{', '[', ']', '[[', ']]', '<', '>', '</', '<!--', '-->', '&', '&#x', '&amp;', '`', '```', '~~~', '_', '__', '**', '//', '^', '$', '$$', '%', '1.', 'a.', ' ', '  ', '\t', '\n', '\n\n', '\n', 'word', 'http://x.y', '---', '...', '+---+', '::', '.. ', '..', '|===', '====', '#+BEGIN_SRC', '#+END_SRC', '=begin', 'From: ', 'Content-Type: ', '--boundary', '{"cells":[', '{"cell_type":', '{\\rtf1', '\\par', '\\b ', '\\u', "\\'", '\\*\\', '<p>', '<table>', '<td>', '<li>', '<a href="', '"', "'", '\r\n', 'é', '\u{1F600}', '===', '~~~~', '::: ', '|a|b|', '| a | b |', '|---|---|', '> ', '>> ', '- ', '* * *', '1) ', '(x)', '@', 'h1. ', 'bq. ', '!img!', '"link":http://x'];

function soup(rand: Rand): Uint8Array {
  let text = '';
  for (let n = rand.range(1, rand.bool(0.2) ? 200 : 40); n > 0; n--) text += rand.pick(SOUP);
  return new TextEncoder().encode(text);
}

test('property: random bytes never hang or throw anything but an Error, in any format', async () => {
  const problems: string[] = [];
  const seeds = seedsFor(30);
  for (const format of READABLE) {
    const inputs = seeds.map((seed) => randomBytes(rng(seed * 7919 + format.length), format === 'pdf' ? 400 : 600));
    for (const problem of await misbehaviour(format, inputs, WRITABLE.has(format))) problems.push(`${problem}`);
  }
  assert.deepEqual(problems, [], 'replay: the seed of input k is k+1 (SEED=n runs only that input)');
});

test('property: strings of markup fragments never hang or throw anything but an Error', async () => {
  const problems: string[] = [];
  const seeds = seedsFor(200);
  for (const format of READABLE.filter((f) => !['pdf', 'png', 'jpeg', 'webp', 'docx', 'odt', 'epub', 'ipynb'].includes(f))) {
    const inputs = seeds.map((seed) => soup(rng(seed * 104729 + format.length)));
    for (const problem of await misbehaviour(format, inputs, true)) problems.push(problem);
  }
  assert.deepEqual(problems, []);
});

test('property: damaged files never hang or throw anything but an Error', async () => {
  // A valid file of each format, exported from a generated document, with bytes changed or cut off.
  const problems: string[] = [];
  const seeds = seedsFor(40);
  const documents = await Promise.all(seeds.map((seed) => generated(rng(seed), FULL)));
  for (const format of READABLE.filter((f) => WRITABLE.has(f))) {
    const inputs: Uint8Array[] = [];
    for (const [k, { document }] of documents.entries()) {
      const file = await exportDocument(document, {}, format, fonts);
      const rand = rng(seeds[k] * 31 + format.length);
      for (let i = 0; i < 3; i++) inputs.push(damaged(rand, file));
    }
    for (const problem of await misbehaviour(format, inputs, true)) problems.push(problem);
  }
  assert.deepEqual(problems, []);
});

test('property: damaged .wdoc files never hang or throw anything but an Error', async () => {
  await forSeeds('damaged wdoc', 60, async (seed, rand) => {
    const { document } = await generated(rand, FULL);
    const file = await writeWdoc({ manifest: { version: WDOC_VERSION, lens: 'docx' } as never, document: await document.write(), original: null, extensions: { md: { frontMatter: 'a: b' } } });
    const bad = damaged(rand, file);
    const started = time();
    try {
      await readWdoc(bad);
    } catch (error) {
      assert.ok(error instanceof Error, `threw ${String(error)}`);
    }
    assert.ok(time() - started < 5000, 'took too long');
  });
});

// --- Known bugs (found by the properties above) ------------------------------------------------------------
// Each is a minimal input that once failed to round-trip; the fixes stay covered here.

const roundTrip = async (format: Format, nodes: Node[]) => {
  const document = await outlineToDocument(nodes);
  const wanted = documentToOutline(document);
  const back = await importDocument(format, await exportDocument(document, {}, format, fonts));
  return { wanted, got: documentToOutline(back.document) };
};

const bugs: [string, Format, Node[], object?][] = [
  ['seed-independent repro: a document that starts with a rule and has another one: Markdown reads the block between them as front matter', 'md', [{ t: 'rule' }, { t: 'para', spans: [{ text: 'Hello' }] }, { t: 'rule' }, { t: 'para', spans: [{ text: 'World' }] }]],
  ['fuzz seed 1 (link profile): RTF written with a hyperlink reads back with the link empty and its text outside it', 'rtf', [{ t: 'para', spans: [{ text: 'a ' }, { text: 'link', link: 'https://example.com/' }, { text: ' b' }] }]],
  ['a table of only a header row loses its header flag in LaTeX', 'tex', [{ t: 'table', header: true, rows: [[[{ text: 'a' }], [{ text: 'b' }]]] }]],
  ['a table of only a header row loses its header flag in Org', 'org', [{ t: 'table', header: true, rows: [[[{ text: 'a' }], [{ text: 'b' }]]] }]],
  ['a table of only a header row loses its header flag in MediaWiki', 'mediawiki', [{ t: 'table', header: true, rows: [[[{ text: 'a' }], [{ text: 'b' }]]] }]],
  ['a table of only a header row loses its header flag in Textile', 'textile', [{ t: 'table', header: true, rows: [[[{ text: 'a' }], [{ text: 'b' }]]] }]],
  ['RTF writes a table header row (\\trhdr) but does not read it', 'rtf', [{ t: 'table', header: true, rows: [[[{ text: 'a' }]], [[{ text: 'b' }]]] }]],
  ['AsciiDoc reads text between two # signs as a highlight even with spaces inside them, dropping the signs', 'adoc', [{ t: 'para', spans: [{ text: 'a # b # c' }] }]],
  ['Org: a paragraph that starts with "* " is read back as a heading (not escaped on the way out)', 'org', [{ t: 'para', spans: [{ text: '** b' }] }]],
  ['Org: a paragraph that is just "|" (a table row when it starts a line) comes back empty', 'org', [{ t: 'para', spans: [{ text: '|' }] }]],
  ['Org: a "]" in link text ends the link early and is lost', 'org', [{ t: 'para', spans: [{ text: 'see ' }, { text: 'a ] b', link: 'https://example.com/' }] }]],
  ['LaTeX: a % in a code block is read back as a comment, dropping the rest of the line', 'tex', [{ t: 'code', text: 'x = 5 % 2\ny' }]],
  ['reStructuredText: bold italic text is written as ***x*** and read back as bold "*x" followed by "*"', 'rst', [{ t: 'para', spans: [{ text: 'a ' }, { text: 'b c', bold: true, italic: true }, { text: ' d' }] }]],
];

for (const [name, format, nodes] of bugs) {
  test(`${format}: ${name}`, async () => {
    const { wanted, got } = await roundTrip(format, nodes);
    assert.deepEqual(got, wanted);
  });
}

// Inputs that once made a reader loop forever. They run in a worker (which can be stopped).
const hangs: [string, Format, string][] = [
  ['AsciiDoc: a line that starts with |=== and goes on is read without looping', 'adoc', '|===x'],
  ['AsciiDoc: the same after a paragraph, with spaces after the |===', 'adoc', 'text\n|===  |a|b|\n'],
  ['MediaWiki: a list line whose markers mix a bullet or number with : or ; (`#:`, `*;`, common under list items) is read without looping', 'mediawiki', '#:'],
  ['MediaWiki: the same under a list item', 'mediawiki', '* item\n*: continued\n'],
];

for (const [name, format, input] of hangs) {
  test(`${format}: ${name}`, async () => {
    const problems = await misbehaviour(format, [new TextEncoder().encode(input)], false, 1500);
    assert.deepEqual(problems, [], JSON.stringify(input));
  });
}

// And they read as text, not as the syntax that stalled them.
test('adoc: a line starting |=== but not a table fence is text', async () => {
  const { importDocument } = await import('../src/formats/convert.ts');
  const { document } = await importDocument('adoc', new TextEncoder().encode('|===x\n'));
  assert.match(JSON.stringify(document), /\|===x/);
});

test('mediawiki: an indent under a list item, or on its own, is text', async () => {
  const { importDocument } = await import('../src/formats/convert.ts');
  const text = async (src: string) => JSON.stringify((await importDocument('mediawiki', new TextEncoder().encode(src))).document);
  assert.match(await text('#:\n'), /"/);
  const under = await text('* item\n*: continued\n');
  assert.match(under, /item/);
  assert.match(under, /continued/);
  assert.match(await text('#: only an indent\n'), /only an indent/);
});
