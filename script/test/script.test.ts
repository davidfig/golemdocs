// Scripts (docs/live-blocks.md §8): the TypeScript stripper, the module linker and the sandbox's runtime, run in a Node
// worker. The app's side (the vault, the runner) is tested in client/test/scripts.test.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripTypes } from '../src/strip.ts';
import { ScriptSyntaxError } from '../src/tokens.ts';

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

import { ScriptError, linkScript, resolvePath } from '../src/link.ts';
import { ScriptRunError, readMeta, runOnChannel, scriptToday, within } from '../src/host.ts';
import type { RunOptions } from '../src/host.ts';
import { nodeChannel } from '../src/nodeChannel.ts';

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

test('a script may import the package’s types: the import goes with the other types', async () => {
  const source = "import type { ProducerApi, ScriptMetaInput } from '@golemdocs/script';\nexport const meta: ScriptMetaInput = { reads: 'Books/' };\nexport default (api: ProducerApi) => api.value(1);";
  const program = await linkScript('Scripts/main.ts', vaultScripts({ 'Scripts/main.ts': source }));
  assert.deepEqual(program.files, ['Scripts/main.ts']);
  const outcome = await run({ 'Scripts/main.ts': source }, 'Scripts/main.ts');
  assert.deepEqual(outcome.result, { kind: 'value', text: '1' });
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
    { mode: 'act', now: '2026-11-11T06:00:00.000Z', request: async (_op, args) => ({ path: args[0], title: '2026-11-11', text: '', fields: {}, exists: false }) },
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

test('a script is answered and its result taken only once it is allowed, and it cannot ask for more while it runs', async () => {
  // Its own code runs in the runtime's worker, so it can post messages itself: before the person says yes, or a second meta.
  const post = "const post = async (m: any) => { if (typeof postMessage === 'function') postMessage(m); else (await import('node:' + 'worker_threads')).parentPort!.postMessage(m); };";
  const early = `export const meta = { writes: ['/'] };\n${post}\nsetTimeout(() => post({ type: 'request', id: 999, op: 'read', args: ['Secret/x.md'] }), 0);\nexport default () => 1;`;
  let served = 0;
  await assert.rejects(
    run({ 'Scripts/early.ts': early }, 'Scripts/early.ts', { mode: 'act', approve: () => new Promise((r) => setTimeout(() => r('no'), 300)), request: async () => void served++ }),
    (e: unknown) => e instanceof ScriptRunError && e.code === 'invalid',
  );
  assert.equal(served, 0);
  const done = `export const meta = { writes: ['/'] };\n${post}\nsetTimeout(() => post({ type: 'done', result: null, edits: [{ path: 'Diary/x.md', create: true, ops: [] }] }), 0);\nexport default () => 1;`;
  await assert.rejects(run({ 'Scripts/done.ts': done }, 'Scripts/done.ts', { mode: 'act', approve: () => new Promise((r) => setTimeout(() => r(true), 300)) }), (e: unknown) => e instanceof ScriptRunError && e.code === 'invalid');
  const widen = `export const meta = { writes: ['Inbox/'] };\n${post}\nexport default async () => { await post({ type: 'meta', meta: { writes: ['/'] } }); await new Promise(() => {}); };`;
  await assert.rejects(run({ 'Scripts/widen.ts': widen }, 'Scripts/widen.ts', { mode: 'act' }), (e: unknown) => e instanceof ScriptRunError && e.code === 'invalid' && /asked for more/.test(e.message));
});

test('the time limit does not count the time spent deciding, and many requests at once wait their turn', async () => {
  const outcome = await run({ 'Scripts/a.ts': "export default async ({ read }: any) => (await Promise.all(Array.from({ length: 50 }, (_, i) => read(`n${i}.md`)))).length;" }, 'Scripts/a.ts', {
    timeoutMs: 1_000,
    approve: () => new Promise((r) => setTimeout(() => r(true), 1_200)),
    request: async () => ({ path: 'x', title: 'x', text: '', fields: {} }),
  });
  assert.deepEqual(outcome.result, { kind: 'value', text: '50' });
});

test('a path with . or .. parts is inside no folder', () => {
  assert.ok(!within('Books/../Private/Budget.xlsx', ['Books']));
  assert.ok(!within('Books/./x.md', ['Books']));
  assert.ok(!within('Books//x.md', ['Books']));
  assert.ok(!within('../x.md', ['']));
  assert.ok(within('Books/x..y.md', ['Books']));
});

test('a producer cannot keep the clock from its top-level code, reach the real Date, or read the time and randomness another way', async () => {
  const tries = {
    'Scripts/top.ts': 'const now = Date.now;\nexport default () => now();',
    'Scripts/proto.ts': 'export default () => new (Object.getPrototypeOf(Date))().getTime();',
    'Scripts/ctor.ts': 'export default () => new (new Date(0).constructor as any)().getTime();',
    'Scripts/intl.ts': 'export default () => new Intl.DateTimeFormat().format();',
    'Scripts/origin.ts': 'export default () => performance.timeOrigin;',
    'Scripts/uuid.ts': 'export default () => crypto.randomUUID();',
  };
  for (const name of Object.keys(tries)) await assert.rejects(run(tries, name), (e: unknown) => e instanceof ScriptRunError && e.code === 'failed', name);
  const ok = { 'Scripts/ok.ts': "export default ({ value }: any) => value([new Date(0).toISOString(), Date.UTC(2026, 0, 1), crypto.getRandomValues(new Uint8Array(2)).join(',')].join('|'));" };
  const [a, b] = [await run(ok, 'Scripts/ok.ts'), await run(ok, 'Scripts/ok.ts')];
  assert.match((a.result as { text: string }).text, /^1970-01-01T00:00:00\.000Z\|1767225600000\|\d+,\d+$/);
  assert.deepEqual(a.result, b.result);
});

import { SCRIPT_MESSAGES, setScriptMessages } from '../src/messages.ts';

test('messages are said in the language the app gives, in the linker, the host and the sandbox alike', async () => {
  setScriptMessages({ ...SCRIPT_MESSAGES, at: '{path} — {message}', atLine: '{path} ({line}) — {message}', noScript: 'kein solches Skript', noClock: 'keine Uhr' });
  try {
    await assert.rejects(linkScript('Scripts/none.ts', vaultScripts({})), (e: unknown) => e instanceof ScriptError && e.message === 'Scripts/none.ts — kein solches Skript');
    const files = { 'Scripts/clock.ts': `export default () => Date.now();` };
    await assert.rejects(run(files, 'Scripts/clock.ts'), (e: unknown) => e instanceof ScriptRunError && /keine Uhr/.test(e.message) && /^Scripts\/clock\.ts \(1\) — /.test(e.message));
  } finally {
    setScriptMessages(SCRIPT_MESSAGES);
  }
});
