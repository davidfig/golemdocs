// Scripts in the app (docs/live-blocks.md §8): the vault as scripts see it, the runner, schedules and `golem run`. The
// stripper, linker and sandbox runtime are tested in the script package (script/test/script.test.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readMeta } from '@golemdocs/script/host';
import { nodeChannel } from '@golemdocs/script/nodeChannel';

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
  assert.match(loop.kind === 'error' ? loop.detail ?? '' : '', /depends on this document/);
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

import { lastDue, runId, ScriptsApp } from '../src/scripts/app.ts';
import type { ScriptsHost } from '../src/scripts/app.ts';
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

/** A library for ScriptsApp: documents by path, and what each read returns (to change a note while an action runs). */
function memoryHost(files: Record<string, string>, readHook?: (path: string, reads: number) => string | undefined) {
  const stored = new Map(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)]));
  const reads = new Map<string, number>();
  const log = { asked: 0, errors: [] as string[] };
  const host: ScriptsHost = {
    documents: () => [...stored.keys()].map((path) => ({ key: path, path })),
    read: async (key) => {
      const n = (reads.get(key) ?? 0) + 1;
      reads.set(key, n);
      const changed = readHook?.(key, n);
      if (changed !== undefined) stored.set(key, new TextEncoder().encode(changed));
      return stored.get(key) ?? null;
    },
    produce: async () => ({ kind: 'value', text: '' }),
    saveOpen: async () => undefined,
    store: async (path, bytes) => (stored.set(path, bytes), path),
    fetch: async () => ({ status: 200, headers: {}, body: '' }),
    remove: async (key) => void stored.delete(key),
    claim: async () => true,
    ask: async () => (log.asked++, 'once'),
    status: () => undefined,
    error: (text) => void log.errors.push(text),
    say: { running: (n) => n, ran: (n) => n, failed: (n, m) => `${n}: ${m}`, paused: (n) => n, off: (n) => n, undone: (n) => n, undoChanged: (p) => p, undoGone: () => '' },
  };
  return { host, stored, log };
}

const APPEND = "export const meta = { name: 'Stamp', reads: ['Inbox/'], writes: ['Inbox/'] };\nexport default async ({ open }) => { (await open('Inbox/a.md')).append('stamped'); };";

test('an action whose note changed while it ran runs once more on the new note, without asking again', async () => {
  // The note's second read (the check after the first run) finds it edited elsewhere.
  const { host, stored, log } = memoryHost({ 'Scripts/stamp.ts': APPEND, 'Inbox/a.md': 'first\n' }, (path, n) => (path === 'Inbox/a.md' && n === 2 ? 'first\n\nedited elsewhere\n' : undefined));
  const app = new ScriptsApp(host, nodeChannel);
  const run = await app.act('Scripts/stamp.ts', 'hand');
  assert.equal(run?.ok, true, log.errors.join());
  assert.equal(log.asked, 1);
  const text = (await markdownOf(stored.get('Inbox/a.md')!, 'a.md')).text;
  assert.match(text, /edited elsewhere[\s\S]*stamped/);
});

test('an action fails, writing nothing, when its note changes again during the second run', async () => {
  const { host, stored, log } = memoryHost({ 'Scripts/stamp.ts': APPEND, 'Inbox/a.md': 'first\n' }, (path, n) => (path === 'Inbox/a.md' ? `edit ${n}\n` : undefined));
  const app = new ScriptsApp(host, nodeChannel);
  const run = await app.act('Scripts/stamp.ts', 'hand');
  assert.equal(run?.ok, false);
  assert.match(log.errors.join(), /Inbox\/a\.md changed while Stamp ran/);
  assert.doesNotMatch(new TextDecoder().decode(stored.get('Inbox/a.md')!), /stamped/);
});

test('an action’s own save is known as its own, even when the store reports it before it returns', async () => {
  // The app's store reports the save (sourceSaved → saved) before it returns the key: the action must not start itself again.
  const { host } = memoryHost({ 'Scripts/stamp.ts': APPEND, 'Inbox/a.md': 'first\n' });
  const store = host.store;
  host.store = async (path, bytes, key) => {
    const k = await store(path, bytes, key);
    app.saved(k);
    return k;
  };
  const app = new ScriptsApp(host, nodeChannel);
  const run = await app.act('Scripts/stamp.ts', 'hand');
  assert.equal(run?.ok, true);
  const inside = app as unknown as { changedKeys: Map<string, number>; writtenBy: Map<string, unknown>; changedTimer: ReturnType<typeof setTimeout> | null };
  clearTimeout(inside.changedTimer!);
  assert.equal(inside.changedKeys.get('Inbox/a.md'), 1);
  assert.equal(inside.changedKeys.get('Inbox/a.md\u0000Scripts/stamp.ts'), -1);
  assert.equal(inside.writtenBy.size, 0);
});

test('Undo This Run keeps what would put back a file that changed since, and counts the run undone only when all went back', async () => {
  const { host, stored } = memoryHost({ 'Scripts/stamp.ts': APPEND, 'Inbox/a.md': 'first\n' });
  const app = new ScriptsApp(host, nodeChannel);
  const run = (await app.act('Scripts/stamp.ts', 'hand'))!;
  const after = stored.get('Inbox/a.md')!;
  stored.set('Inbox/a.md', new TextEncoder().encode('changed by hand\n'));
  await assert.rejects(app.undo(run));
  assert.ok(app.canUndo(run));
  stored.set('Inbox/a.md', after);
  await app.undo(run);
  assert.equal(new TextDecoder().decode(stored.get('Inbox/a.md')!), 'first\n');
  assert.ok(!app.canUndo(run));
});

import { scriptState } from '../src/scripts/state.ts';
import { grantOf } from '../src/scripts/runner.ts';

test('a scheduled run whose claim got no answer is asked about again on the next tick', async () => {
  // Script state is kept in browser storage: one in memory, for this test.
  const g = globalThis as { localStorage?: Storage };
  if (!g.localStorage?.setItem) {
    const items = new Map<string, string>();
    g.localStorage = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), removeItem: (k: string) => void items.delete(k), clear: () => items.clear(), key: () => null, length: 0 } as Storage;
  }
  const DAILY = "export const meta = { name: 'Daily', writes: ['Inbox/'], trigger: { daily: '06:00' } };\nexport default async ({ open }) => { (await open('Inbox/a.md')).append('ran'); };";
  const { host, stored } = memoryHost({ 'Scripts/daily.ts': DAILY, 'Inbox/a.md': 'first\n' });
  const answers: (boolean | 'offline')[] = ['offline', true, true];
  host.claim = async () => {
    const next = answers.shift();
    if (next === 'offline') throw new Error('offline');
    return next ?? true;
  };
  const app = new ScriptsApp(host, nodeChannel);
  const meta = readMeta({ name: 'Daily', writes: ['Inbox/'], trigger: { daily: '06:00' } }, 'Scripts/daily.ts');
  scriptState.grants.set('Scripts/daily.ts', grantOf(meta));
  await app.tick(new Date(2026, 10, 13, 7, 0)); // first look: from the next one on
  await app.tick(new Date(2026, 10, 14, 7, 0)); // due, claim gets no answer
  assert.doesNotMatch(new TextDecoder().decode(stored.get('Inbox/a.md')!), /ran/);
  await app.tick(new Date(2026, 10, 14, 7, 1)); // asked again: runs
  assert.match((await markdownOf(stored.get('Inbox/a.md')!, 'a.md')).text, /ran/);
});
