// Scripts (docs/live-blocks.md §8): the TypeScript stripper, the module linker, the sandbox's runtime and the app's side.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripTypes } from '../src/scripts/strip.ts';
import { ScriptSyntaxError } from '../src/scripts/tokens.ts';

/** The text with runs of white space made one space, to compare without the blanks the stripper leaves. */
const squash = (s: string): string => s.replace(/\s+/g, ' ').replace(/\s*([(){}[\],;:=<>!?.])\s*/g, '$1').trim();

/** Strips, checks the result parses as a module, and compares it. */
async function strips(ts: string, js: string): Promise<void> {
  const out = stripTypes(ts);
  assert.equal(squash(out), squash(js));
  assert.equal(out.split('\n').length, ts.split('\n').length, 'every line keeps its number');
  await import(`data:text/javascript,${encodeURIComponent(`export default 0;\nif (false) { ${out.replace(/^\s*(import|export)\b[^\n]*$/gm, '')} }`)}`);
}

test('annotations on variables, parameters and return types are deleted', async () => {
  await strips('const a: number = 1;\nlet b: string[], c: Map<string, number[]> = new Map();', 'const a = 1; let b, c = new Map();');
  await strips('function f(x: number, y?: string, ...rest: Array<{ a: 1 }>): Promise<void> { return x as never; }', 'function f(x, y, ...rest) { return x; }');
  await strips('const g = async (a: number, { b }: { b: string } = { b: "" }): Promise<number> => a;', 'const g = async (a, { b } = { b: "" }) => a;');
  await strips('const h = (x: unknown): x is string => typeof x === "string";', 'const h = (x) => typeof x === "string";');
  await strips('let d!: number;', 'let d;');
  await strips('for (let i: number = 0; i < 3; i++) {}', 'for (let i = 0; i < 3; i++) {}');
  await strips('try {} catch (e: unknown) {}', 'try {} catch (e) {}');
});

test('type aliases, interfaces, declare and type imports and exports are deleted', async () => {
  await strips('type A = { a: number } | string;\ninterface B<T> extends A { b: T }\nconst x = 1;', 'const x = 1;');
  await strips('export type C<T> = T extends string ? "s" : never;\nexport interface D { d(): void }\nexport const y = 2;', 'export const y = 2;');
  await strips("import type { A } from './a.ts';\nimport { type B, c } from './b.ts';\nimport d, { type E as F } from './d.ts';", "import { c } from './b.ts'; import d, { } from './d.ts';");
  await strips("export type { A } from './a.ts';\nexport { type B, c };", 'export { c };');
  await strips('declare const g: number;\ndeclare global { interface Window { x: 1 } }\ndeclare function h(): void;\nconst z = 3;', 'const z = 3;');
});

test('as, satisfies, the non-null mark and type arguments are deleted, and comparisons are left alone', async () => {
  await strips('const a = (b as unknown as string[])!.length satisfies number;', 'const a = (b).length;');
  await strips('const c = { d: 1 } as const;', 'const c = { d: 1 };');
  await strips('const e = f<string, number[]>(1) + g.h<A>`t`;', 'const e = f(1) + g.h `t`;');
  await strips('const i = a < b && c > (d);\nconst j = a < b;', 'const i = a < b && c > (d); const j = a < b;');
  await strips('if (!k) l!.m = n! + 1;', 'if (!k) l.m = n + 1;');
  await strips('if (a) !b;', 'if (a) !b;');
  await strips('const o = <T,>(p: T): T => p;', 'const o = (p) => p;');
  await strips('const as = 1; const satisfies = as;', 'const as = 1; const satisfies = as;');
});

test('classes keep their code and lose their types', async () => {
  await strips(
    `abstract class A<T> extends B<T> implements C, D<T> {
  private readonly x: number = 1;
  static y?: string;
  declare z: number;
  protected abstract w(): void;
  [key: string]: unknown;
  constructor(a: number) { super(a); }
  get v(): number { return this.x; }
  m<U>(u: U): U { return u; }
  n(a: string): void;
  n(a: unknown) {}
  arrow = (e: Event): void => {}
  q = 2
  r(s: number) {}
}`,
    `class A extends B {
  x = 1;
  static y;
  constructor(a) { super(a); }
  get v() { return this.x; }
  m(u) { return u; }
  n(a) {}
  arrow = (e) => {}
  q = 2
  r(s) {}
}`,
  );
});

test('object literal methods lose their types, and keys and ternaries stay', async () => {
  await strips('const o = { a: 1, b(x: number): number { return x; }, async c<T>(y: T) {}, get d(): string { return ""; }, e: { f: 2 }, g: h ? { i: 1 } : { j: 2 } };', 'const o = { a: 1, b(x) { return x; }, async c(y) {}, get d() { return ""; }, e: { f: 2 }, g: h ? { i: 1 } : { j: 2 } };');
  await strips('switch (a) { case 1: { break; } default: {} }\nlabel: { break label; }', 'switch (a) { case 1: { break; } default: {} } label: { break label; }');
});

test('strings, templates, comments and regular expressions are left as they are', async () => {
  await strips('const s = "a: number" + `${x as string}: ${`${y!}`}` + /a<b>: c/g.source; // x: number\n/* y as T */', 'const s = "a: number" + `${x}: ${`${y}`}` + /a<b>: c/g.source; // x: number\n/* y as T */');
});

test('syntax that makes code is an error with its line', () => {
  const fails = (ts: string, message: RegExp, line: number) => {
    assert.throws(
      () => stripTypes(ts),
      (e: unknown) => e instanceof ScriptSyntaxError && message.test(e.message) && e.line === line,
    );
  };
  fails('const a = 1;\nenum E { A }', /Enums/, 2);
  fails('\n\nnamespace N { }', /Namespaces/, 3);
  fails('class A { constructor(private x: number) {} }', /Parameter properties/, 1);
  fails('@dec class A {}', /Decorators/, 1);
  fails('const a = <string>b;', /as Type/, 1);
  fails("import x = require('x');", /import x =/, 1);
  fails('const a = "open', /not closed/, 1);
});

import { ScriptError, linkScript, resolvePath } from '../src/scripts/link.ts';
import { ScriptRunError, readMeta, runOnChannel, scriptToday, within } from '../src/scripts/host.ts';
import type { RunOptions } from '../src/scripts/host.ts';
import { nodeChannel } from '../src/scripts/nodeChannel.ts';

const vaultScripts = (files: Record<string, string>) => async (path: string) => files[path] ?? null;

async function run(files: Record<string, string>, entry: string, options: Partial<RunOptions> = {}) {
  const program = await linkScript(entry, vaultScripts(files));
  return runOnChannel(nodeChannel(), entry, {
    mode: 'produce',
    program: program.url,
    today: scriptToday(new Date(2026, 10, 11)),
    seed: 7,
    timeoutMs: 5_000,
    maxResultChars: 1_000_000,
    approve: async () => true,
    request: async () => null,
    ...options,
  });
}

test('the linker follows relative imports inside Scripts/ and refuses anything else', async () => {
  assert.equal(resolvePath('Scripts/a/b.ts', '../lib/c.ts'), 'Scripts/lib/c.ts');
  assert.equal(resolvePath('Scripts/b.ts', '../../x.ts'), null);
  const program = await linkScript('Scripts/main.ts', vaultScripts({ 'Scripts/main.ts': "import { two } from './lib/math';\nexport default () => two;", 'Scripts/lib/math.ts': 'export const two: number = 2;' }));
  assert.deepEqual(program.files, ['Scripts/main.ts', 'Scripts/lib/math.ts']);
  const rejects = async (files: Record<string, string>, message: RegExp) => assert.rejects(linkScript('Scripts/main.ts', vaultScripts(files)), (e: unknown) => e instanceof ScriptError && message.test(e.message));
  await rejects({ 'Scripts/main.ts': "import x from 'lodash';" }, /relative path/);
  await rejects({ 'Scripts/main.ts': "import x from '../Notes/x.ts';" }, /outside Scripts/);
  await rejects({ 'Scripts/main.ts': "import x from './gone.ts';" }, /no script Scripts\/gone\.ts/);
  await rejects({ 'Scripts/main.ts': "import './b.ts';", 'Scripts/b.ts': "import './main.ts';" }, /cycle: Scripts\/main\.ts → Scripts\/b\.ts → Scripts\/main\.ts/);
  await rejects({ 'Scripts/main.ts': '\nenum E { A }' }, /Scripts\/main\.ts, line 2: Enums/);
});

test('a producer runs in a worker, asks the app for what it reads, and gives a table', async () => {
  const asked: unknown[] = [];
  const outcome = await run(
    {
      'Scripts/reading.ts': `export const meta = { name: 'Reading list', reads: ['Books/'] };
interface Note { title: string; fields: Record<string, string> }
export default async function ({ notes, table }: any) {
  const books: Note[] = await notes('Books/');
  return table(['Title', 'Author'], books.filter((n) => n.fields.status === 'read').map((n) => [n.title, n.fields.author]));
}`,
    },
    'Scripts/reading.ts',
    {
      request: async (op, args, meta) => {
        asked.push([op, ...args, meta.reads]);
        return [
          { title: 'Dune', fields: { status: 'read', author: 'Herbert' } },
          { title: 'Emma', fields: { status: 'unread', author: 'Austen' } },
        ];
      },
    },
  );
  assert.deepEqual(outcome.meta, { name: 'Reading list', reads: ['Books'], writes: [], trigger: null });
  assert.deepEqual(asked, [['notes', 'Books/', ['Books']]]);
  assert.deepEqual(outcome.result, { kind: 'table', rows: [['Title', 'Author'], ['Dune', 'Herbert']], header: true });
  assert.equal(outcome.usesDate, false);
});

test('a producer cannot read the clock or the network, gets today from the app, and repeats its randomness', async () => {
  const files = {
    'Scripts/p.ts': `export default ({ today, value }: any) => value([typeof fetch, typeof indexedDB, today.iso, today.long, Math.random()].join('|'));`,
    'Scripts/clock.ts': `export default () => Date.now();`,
    'Scripts/date.ts': `export default () => new Date().getFullYear();`,
  };
  const first = await run(files, 'Scripts/p.ts');
  const again = await run(files, 'Scripts/p.ts');
  assert.match((first.result as { text: string }).text, /^undefined\|undefined\|2026-11-11\|Wednesday, November 11, 2026\|0\.\d+$/);
  assert.deepEqual(first.result, again.result);
  assert.equal(first.usesDate, true);
  for (const name of ['Scripts/clock.ts', 'Scripts/date.ts']) await assert.rejects(run(files, name), (e: unknown) => e instanceof ScriptRunError && /cannot read the clock/.test(e.message) && e.code === 'failed');
});

test('a run is ended when it takes too long, is refused when not allowed, and says where it failed', async () => {
  await assert.rejects(run({ 'Scripts/loop.ts': 'export default () => { for (;;) {} };' }, 'Scripts/loop.ts', { timeoutMs: 300 }), (e: unknown) => e instanceof ScriptRunError && e.code === 'timeout');
  await assert.rejects(run({ 'Scripts/a.ts': "export const meta = { writes: ['Diary/'] };\nexport default () => 1;" }, 'Scripts/a.ts', { approve: async (meta) => (meta.writes.length ? 'A producer cannot change files' : true) }), (e: unknown) => e instanceof ScriptRunError && e.code === 'denied');
  await assert.rejects(run({ 'Scripts/big.ts': "export default ({ value }: any) => value('x'.repeat(2000));" }, 'Scripts/big.ts', { maxResultChars: 1000 }), (e: unknown) => e instanceof ScriptRunError && e.code === 'tooLarge');
  await assert.rejects(run({ 'Scripts/err.ts': "export default async ({ read }: any) => {\n  await read('x');\n  throw new Error('no luck');\n};" }, 'Scripts/err.ts', { request: async () => { throw new Error('outside its grant'); } }), (e: unknown) => e instanceof ScriptRunError && /Scripts\/err\.ts, line 2: outside its grant/.test(e.message));
});

test('an action opens documents and sends back its edits; the clock is its own', async () => {
  const outcome = await run(
    {
      'Scripts/daily.ts': `export const meta = { name: 'Daily note', writes: ['Diary/'], trigger: { daily: '6:00' } };
export default async function ({ today, open, now }: any) {
  const doc = await open(\`Diary/\${today.year}/\${today.iso}.md\`, { create: true });
  if (doc.isEmpty) doc.append(\`# \${today.long}\\n\`);
  doc.setField('mood', 'calm');
  return typeof now === 'string' && Date.now() > 0 ? 'made' : 'no clock';
}`,
    },
    'Scripts/daily.ts',
    { mode: 'act', now: '2026-11-11T06:00:00.000Z', request: async (op, args) => ({ path: args[0], title: '2026-11-11', text: '', fields: {}, exists: false }) },
  );
  assert.deepEqual(outcome.meta.trigger, { daily: '06:00', weekly: undefined, changed: undefined });
  assert.equal(outcome.result, 'made');
  assert.deepEqual(outcome.edits, [{ path: 'Diary/2026/2026-11-11.md', create: true, ops: [{ op: 'append', markdown: '# Wednesday, November 11, 2026\n' }, { op: 'setField', key: 'mood', value: 'calm' }] }]);
});

test('a script’s meta is read as folders and a trigger', () => {
  assert.deepEqual(readMeta({ reads: '/Books/', writes: ['Diary', 3], trigger: { weekly: 'Mon 9:00' } }, 'Scripts/x.ts'), { name: 'x', reads: ['Books'], writes: ['Diary'], trigger: { daily: undefined, weekly: 'mon 9:00', changed: undefined } });
  assert.ok(within('Books/Dune.md', ['Books']));
  assert.ok(!within('Bookshelf/x.md', ['Books']));
  assert.ok(within('anything.md', ['']));
});

import { ScriptRequests, editedFiles, noteData, scriptResult, setFrontMatterField } from '../src/scripts/vault.ts';
import type { ScriptVault, VaultFile } from '../src/scripts/vault.ts';
import { readStoredText } from '../src/live/textSource.ts';
import { documentToMarkdown } from '../src/formats/markdown.ts';

function memoryVault(files: Record<string, string>): ScriptVault & { files: Record<string, Uint8Array> } {
  const stored: Record<string, Uint8Array> = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)]));
  const file = (path: string): VaultFile | null => (stored[path] ? { path, bytes: stored[path] } : null);
  return {
    files: stored,
    list: async (folder) => {
      const inside = Object.keys(stored).filter((p) => folder === '' || p.startsWith(`${folder}/`));
      return inside.length ? inside.map((p) => file(p)!) : null;
    },
    file: async (path) => file(path),
    produce: async () => ({ kind: 'value', text: '42' }),
  };
}

const markdownOf = async (bytes: Uint8Array, name: string) => {
  const stored = (await readStoredText(bytes, name, false))!;
  return { text: documentToMarkdown(stored.doc), frontMatter: stored.extensions.md?.frontMatter ?? '' };
};

test('requests read notes with their fields, only where the script asked to', async () => {
  const vault = memoryVault({ 'Books/Dune.md': '---\nauthor: Herbert\nstatus: read\n---\n# Dune\n\nSand.\n', 'Diary/a.md': 'secret' });
  const meta = { name: 'Reading', reads: ['Books'], writes: [], trigger: null };
  const requests = new ScriptRequests(vault, 'produce');
  const notes = (await requests.handle('notes', ['Books/'], meta)) as { title: string; fields: Record<string, string>; text: string }[];
  assert.deepEqual(notes.map((n) => [n.title, n.fields]), [['Dune', { author: 'Herbert', status: 'read' }]]);
  assert.match(notes[0].text, /# Dune\s+Sand\./);
  await assert.rejects(requests.handle('read', ['Diary/a.md'], meta), /did not ask to read Diary\/a\.md/);
  await assert.rejects(requests.handle('notes', ['/'], meta), /whole vault/);
  await assert.rejects(requests.handle('open', ['Books/Dune.md', false], meta), /producer cannot open/);
  assert.deepEqual(await requests.handle('sheet', ['Books/Budget.xlsx#Total'], meta), { kind: 'value', text: '42' });
  assert.deepEqual([...requests.read], ['Books/', 'Books/Budget.xlsx']);
});

test('an action’s edits are applied through the document, and checked against what it asked to change', async () => {
  const vault = memoryVault({ 'Diary/Plan.md': '---\nmood: tired\ntags:\n  - a\n---\n# Plan\n\nIntro.\n\n## Todo\n\n- one\n\n## Done\n\n- zero\n' });
  const meta = { name: 'Daily', reads: [], writes: ['Diary'], trigger: null };
  const changed = await editedFiles(
    [
      { path: 'Diary/Plan.md', create: false, ops: [{ op: 'appendToSection', heading: 'Todo', markdown: '- two' }, { op: 'setField', key: 'mood', value: 'calm' }, { op: 'append', markdown: 'The end.' }] },
      { path: 'Diary/2026/New.md', create: true, ops: [{ op: 'append', markdown: '# New\n\nHello **there**.' }, { op: 'setField', key: 'day', value: '2026-11-11' }] },
    ],
    meta,
    vault,
  );
  assert.deepEqual(changed.map((c) => [c.path, c.before !== null]), [['Diary/Plan.md', true], ['Diary/2026/New.md', false]]);
  const plan = await markdownOf(changed[0].after, 'Plan.md');
  assert.match(plan.text, /## Todo\s+- one\s+- two\s+## Done\s+- zero\s+The end\./);
  assert.equal(plan.frontMatter, 'mood: calm\ntags:\n  - a');
  const made = await markdownOf(changed[1].after, 'New.md');
  assert.match(made.text, /# New\s+Hello \*\*there\*\*\./);
  assert.equal(made.frontMatter, 'day: 2026-11-11');
  await assert.rejects(editedFiles([{ path: 'Books/x.md', create: true, ops: [] }], meta, vault), /did not ask to change Books\/x\.md/);
  await assert.rejects(editedFiles([{ path: 'Diary/Plan.md', create: false, ops: [{ op: 'replaceSection', heading: 'Nope', markdown: 'x' }] }], meta, vault), /no heading “Nope”/);
});

test('front matter fields are set, replaced and removed, and results become a block’s', async () => {
  assert.equal(setFrontMatterField('a: 1\nb:\n  - x\nc: 3', 'b', 'two words'), 'a: 1\nb: two words\nc: 3');
  assert.equal(setFrontMatterField('a: 1', 'c', 'x: y'), 'a: 1\nc: "x: y"');
  assert.equal(setFrontMatterField('a: 1\nb: 2', 'A', null), 'b: 2');
  assert.deepEqual(await scriptResult({ kind: 'table', rows: [['Item', 'Cost'], ['Rent', 2100]], header: true }), { kind: 'table', rows: [['Item', 'Cost'], ['Rent', '2100']], header: true, align: ['left', 'right'] });
  assert.deepEqual(await scriptResult(3), { kind: 'value', text: '3' });
  const blocks = await scriptResult({ kind: 'markdown', markdown: '- a\n- b' });
  assert.equal(blocks.kind, 'blocks');
  assert.equal((await noteData({ path: 'x.bin', bytes: new Uint8Array([0, 1, 2]) })), null);
});

// --- The app's runner -------------------------------------------------------------------------

import { ScriptRunner, covers, scriptText } from '../src/scripts/runner.ts';
import type { GrantStore, ScriptGrant } from '../src/scripts/runner.ts';

function memoryGrants(): GrantStore & { all: Map<string, ScriptGrant> } {
  const all = new Map<string, ScriptGrant>();
  return { all, get: (p) => all.get(p) ?? null, set: (p, g) => (g ? all.set(p, g) : all.delete(p)) };
}

test('the runner runs a producer only with a grant, asks when a person started it, and records what it read', async () => {
  const vault = memoryVault({
    'Books/Dune.md': '---\nauthor: Herbert\n---\n# Dune\n',
    'Books/Emma.md': '---\nauthor: Austen\n---\n# Emma\n',
    'Scripts/lib/names.ts': 'export const names = (ns: { title: string }[]): string[] => ns.map((n) => n.title);',
    'Scripts/books.ts': "import { names } from './lib/names.ts';\nexport const meta = { name: 'Books', reads: ['Books/'] };\nexport default async ({ notes, list }) => list(names(await notes('Books/')));",
    'Scripts/count.ts': "export const meta = { reads: [] };\nexport default async ({ result, today }) => { const r = await result('Scripts/books.ts'); return `${r.text.split('\\n').length} on ${today.iso}`; };",
    'Scripts/loop.ts': "export const meta = { reads: [] };\nexport default async ({ result }) => result('Scripts/loop.ts');",
    'Scripts/writer.ts': "export const meta = { writes: ['Books/'] };\nexport default () => 1;",
  });
  const grants = memoryGrants();
  const asked: string[] = [];
  let answer: 'once' | 'always' | null = 'always';
  const runner = new ScriptRunner({ vault, channel: nodeChannel, grants, ask: async (path) => (asked.push(path), answer), now: () => new Date(2026, 10, 11, 9) });
  // Not started by a person: refused, nothing asked.
  const refused = await runner.produce('Scripts/books.ts');
  assert.equal(refused.kind === 'error' && refused.code, 'notAllowed');
  assert.deepEqual(asked, []);
  // Started by a person: asked, and Always allow is kept.
  const shown = await runner.produce('Scripts/books.ts', { interactive: true });
  assert.equal(shown.kind, 'blocks');
  assert.deepEqual(asked, ['Scripts/books.ts']);
  assert.deepEqual(grants.get('Scripts/books.ts'), { reads: ['Books'], writes: [], trigger: '' });
  assert.deepEqual(runner.reads('Scripts/books.ts'), ['Scripts/lib/names.ts', 'Books/']);
  assert.equal((await runner.produce('Scripts/books.ts')).kind, 'blocks');
  // One producer reads another's result; the date makes it depend on the day.
  grants.set('Scripts/count.ts', { reads: [], writes: [], trigger: '' });
  assert.deepEqual(await runner.produce('Scripts/count.ts'), { kind: 'value', text: '2 on 2026-11-11' });
  assert.deepEqual(runner.reads('Scripts/count.ts'), ['Scripts/books.ts']);
  assert.ok(runner.usesDate.has('Scripts/count.ts'));
  // A cycle, a missing script, a producer that asks to write.
  grants.set('Scripts/loop.ts', { reads: [], writes: [], trigger: '' });
  const loop = await runner.produce('Scripts/loop.ts');
  assert.equal(loop.kind === 'error' && loop.code, 'script');
  assert.match(loop.kind === 'error' ? loop.detail ?? '' : '', /cycle/);
  assert.deepEqual(await runner.produce('Scripts/none.ts'), { kind: 'error', code: 'missing', detail: 'Scripts/none.ts' });
  answer = null;
  const writer = await runner.produce('Scripts/writer.ts', { interactive: true });
  assert.match(writer.kind === 'error' ? writer.detail ?? '' : '', /producer, which cannot ask to change/);
  // Asking for more than was allowed asks again.
  assert.equal(covers({ reads: ['Books'], writes: [], trigger: '' }, { name: 'x', reads: ['Books', 'Diary'], writes: [], trigger: null }), false);
  assert.equal(covers({ reads: [''], writes: [], trigger: '' }, { name: 'x', reads: ['Books', 'Diary'], writes: [], trigger: null }), true);
});

test('the runner runs an action and gives back the files it changed, unstored', async () => {
  const vault = memoryVault({
    'Scripts/daily.ts': "export const meta = { name: 'Daily', writes: ['Diary/'], trigger: { daily: '6:00' } };\nexport default async ({ today, open }) => { const d = await open(`Diary/${today.iso}.md`, { create: true }); if (d.isEmpty) d.append(`# ${today.long}`); return 'made'; };",
  });
  const grants = memoryGrants();
  const runner = new ScriptRunner({ vault, channel: nodeChannel, grants, ask: async () => 'always', now: () => new Date(2026, 10, 11, 6) });
  await assert.rejects(runner.act('Scripts/daily.ts'), /not been allowed/);
  const outcome = await runner.act('Scripts/daily.ts', { interactive: true });
  assert.equal(outcome.message, 'made');
  assert.deepEqual(outcome.files.map((f) => [f.path, f.before]), [['Diary/2026-11-11.md', null]]);
  assert.match((await markdownOf(outcome.files[0].after, 'x.md')).text, /# Wednesday, November 11, 2026/);
  assert.equal(grants.get('Scripts/daily.ts')?.trigger, 'daily 06:00');
  assert.equal(await scriptText(new TextEncoder().encode('const a = 1;')), 'const a = 1;');
});

// --- Schedules and the command line ---------------------------------------------------------------

import { lastDue, runId } from '../src/scripts/app.ts';
import { main as golem } from '../src/scripts/cli.ts';
import { mkdtemp, mkdir as makeDir, readFile as readDisk, rm, writeFile as writeDisk } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a schedule’s last due time, and its run id', () => {
  const wed9 = new Date(2026, 10, 11, 9, 0); // a Wednesday
  assert.deepEqual(lastDue({ daily: '06:00' }, wed9), new Date(2026, 10, 11, 6, 0));
  assert.deepEqual(lastDue({ daily: '10:30' }, wed9), new Date(2026, 10, 10, 10, 30));
  assert.deepEqual(lastDue({ weekly: 'mon 06:00' }, wed9), new Date(2026, 10, 9, 6, 0));
  assert.deepEqual(lastDue({ weekly: 'wed 10:00' }, wed9), new Date(2026, 10, 4, 10, 0));
  assert.deepEqual(lastDue({ daily: '08:00', weekly: 'wed 08:30' }, wed9), new Date(2026, 10, 11, 8, 30));
  assert.equal(lastDue({ changed: 'Inbox' }, wed9), null);
  assert.equal(runId('Scripts/daily.ts', new Date(2026, 10, 11, 6, 0)), 'Scripts/daily.ts@2026-11-11T06:00');
});

test('golem run prints a producer’s result and writes an action’s files to a vault folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'golem-'));
  try {
    await makeDir(join(dir, 'Scripts'));
    await makeDir(join(dir, 'Books'));
    await makeDir(join(dir, '.obsidian'));
    await writeDisk(join(dir, 'Books/Dune.md'), '---\nauthor: Herbert\n---\n# Dune\n');
    await writeDisk(join(dir, '.obsidian/hidden.md'), 'not for scripts');
    await writeDisk(join(dir, 'Scripts/books.ts'), "export const meta = { reads: ['/'] };\nexport default async ({ notes, table }) => table(['Book', 'Author'], (await notes('/')).map((n) => [n.title, n.fields.author ?? '']));");
    await writeDisk(join(dir, 'Scripts/log.ts'), "export const meta = { name: 'Log', writes: ['Log/'] };\nexport default async ({ open }) => { (await open('Log/Today.md', { create: true })).append('- ran'); return 'logged'; };");
    const out: string[] = [];
    const err: string[] = [];
    assert.equal(await golem(['run', 'Scripts/books.ts', '--vault', dir], '/', (l) => out.push(l), (l) => err.push(l)), 0);
    assert.equal(out.join('\n'), '| Book | Author |\n| --- | --- |\n| Dune | Herbert |');
    assert.match(err[0], /not sandboxed/);
    out.length = 0;
    assert.equal(await golem(['run', 'Scripts/log.ts', '--dry-run'], dir, (l) => out.push(l), () => undefined), 0);
    assert.deepEqual(out, ['would make Log/Today.md', 'logged']);
    await assert.rejects(readDisk(join(dir, 'Log/Today.md')));
    assert.equal(await golem(['run', join(dir, 'Scripts/log.ts')], dir, () => undefined, () => undefined), 0);
    assert.equal((await readDisk(join(dir, 'Log/Today.md'), 'utf8')).trim(), '- ran');
    assert.equal(await golem(['run'], dir, () => undefined, () => undefined), 2);
    assert.equal(await golem(['run', 'Scripts/none.ts'], dir, () => undefined, () => undefined), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an action fetches only from the sites its meta names, through the app; a producer cannot', async () => {
  const asked: string[] = [];
  const vault = Object.assign(
    memoryVault({
      'Scripts/weather.ts': "export const meta = { name: 'Weather', writes: ['Notes/'], network: ['api.example.com'] };\nexport default async ({ fetch, open }) => { const r = await fetch('https://api.example.com/today?city=Oslo'); (await open('Notes/Weather.md', { create: true })).append(`Today: ${(await r.json()).sky}`); return String(r.status); };",
      'Scripts/elsewhere.ts': "export const meta = { writes: ['Notes/'], network: ['api.example.com'] };\nexport default async ({ fetch }) => fetch('https://evil.example.org/');",
      'Scripts/plain.ts': "export const meta = { writes: ['Notes/'], network: ['api.example.com'] };\nexport default async ({ fetch }) => fetch('http://api.example.com/');",
      'Scripts/sky.ts': "export const meta = { network: ['api.example.com'] };\nexport default async ({ value }) => value(1);",
    }),
    {
      fetch: async (url: string, init: { method: string }) => {
        asked.push(`${init.method} ${url}`);
        return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"sky":"clear"}' };
      },
    },
  );
  const grants = memoryGrants();
  const runner = new ScriptRunner({ vault, channel: nodeChannel, grants, ask: async () => 'always' });
  const outcome = await runner.act('Scripts/weather.ts', { interactive: true });
  assert.deepEqual(asked, ['GET https://api.example.com/today?city=Oslo']);
  assert.equal(outcome.message, '200');
  assert.match((await markdownOf(outcome.files[0].after, 'x.md')).text, /Today: clear/);
  assert.deepEqual(grants.get('Scripts/weather.ts')?.network, ['api.example.com']);
  await assert.rejects(runner.act('Scripts/elsewhere.ts', { interactive: true }), /did not ask to fetch from evil\.example\.org/);
  await assert.rejects(runner.act('Scripts/plain.ts', { interactive: true }), /only https:\/\//);
  const sky = await runner.produce('Scripts/sky.ts', { interactive: true });
  assert.match(sky.kind === 'error' ? sky.detail ?? '' : '', /cannot use the network/);
  // A grant without the site does not cover a script that now asks for it.
  assert.equal(covers({ reads: [], writes: ['Notes'], trigger: '' }, { name: 'x', reads: [], writes: ['Notes'], trigger: null, network: ['api.example.com'] }), false);
  assert.throws(() => readMeta({ network: ['not a host'] }, 'Scripts/x.ts'), /host names/);
  assert.deepEqual(readMeta({ network: 'https://API.example.com/v1' }, 'Scripts/x.ts').network, ['api.example.com']);
});
