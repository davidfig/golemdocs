// What ai apps working in the vault are told (src/desktop/agentGuide.ts): the app's own guide in `.golemdocs/AGENTS.md`, written
// and kept up to date by the app, and the line that points the person's own instruction files at it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addPointers, GUIDE_PATH, GUIDE_VERSION, guideText, guideVersion, pointerState, withPointer, writeGuide, type GuideDisk } from '../src/desktop/agentGuide.ts';
import { en } from '../src/i18n/en/index.ts';
import { LOCALES } from '../src/i18n/locales.ts';

function folder(files: Record<string, string> = {}) {
  const map = new Map(Object.entries(files));
  const writes: string[] = [];
  const disk: GuideDisk = {
    read: async (path) => {
      const text = map.get(path);
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return new TextEncoder().encode(text);
    },
    write: async (path, data) => {
      writes.push(path);
      map.set(path, new TextDecoder().decode(data));
    },
  };
  return { disk, map, writes };
}

const LINE = 'See .golemdocs/AGENTS.md for how this folder is kept.';

test('the guide is written where it is missing, older or changed, and a newer app’s guide is left alone', async () => {
  const empty = folder();
  assert.equal(await writeGuide(empty.disk), true);
  assert.equal(empty.map.get(GUIDE_PATH), guideText());
  assert.equal(guideVersion(guideText()), GUIDE_VERSION);

  assert.equal(await writeGuide(empty.disk), false, 'the same guide is not written again');

  const edited = folder({ [GUIDE_PATH]: guideText().replace('Golem Docs', 'Something') });
  assert.equal(await writeGuide(edited.disk), true, 'the app’s own file is put back as it should be');

  const old = folder({ [GUIDE_PATH]: `<!-- golemdocs-guide 0 -->\nold` });
  assert.equal(await writeGuide(old.disk), true);

  const newer = folder({ [GUIDE_PATH]: `<!-- golemdocs-guide ${GUIDE_VERSION + 1} -->\nnewer` });
  assert.equal(await writeGuide(newer.disk), false, 'an older app never overwrites a newer guide');
  assert.match(newer.map.get(GUIDE_PATH)!, /newer/);
});

test('the guide tells an agent how the folder syncs, what each format becomes, and how to show the person a note', () => {
  const text = guideText();
  for (const needed of ['The file wins', 'trash for 30 days', 'ten or more files', 'golemdocs://open?file=', '[[Note]]', 'golem:live', '.golemdocs/', '<golem-embed', 'golem.notes(']) assert.ok(text.includes(needed), needed);
});

test('the person’s instruction files that lack the line are found, in any language, by the guide’s path', async () => {
  const { disk } = folder({ 'AGENTS.md': `# Mine\n\n${LINE}\n`, 'CLAUDE.md': '# Claude\n' });
  assert.deepEqual(await pointerState(disk), { present: ['AGENTS.md', 'CLAUDE.md'], missing: ['CLAUDE.md'] });
  assert.deepEqual(await pointerState(folder({ 'GEMINI.md': `Lies ${GUIDE_PATH}.` }).disk), { present: ['GEMINI.md'], missing: [] });
  assert.deepEqual(await pointerState(folder().disk), { present: [], missing: [] });
});

test('the line is added at the end of each file that lacks it, once, keeping what the person wrote', async () => {
  assert.equal(withPointer('# Mine\n\n- rule\n\n\n', LINE), `# Mine\n\n- rule\n\n${LINE}\n`);
  assert.equal(withPointer('', LINE), `${LINE}\n`);
  assert.equal(withPointer(`x\n\n${LINE}\n`, LINE), `x\n\n${LINE}\n`);

  const both = folder({ 'AGENTS.md': '# Mine\n- rule', 'CLAUDE.md': `@AGENTS.md\n\n${LINE}\n` });
  assert.deepEqual(await addPointers(both.disk, LINE, 'Instructions'), ['AGENTS.md']);
  assert.equal(both.map.get('AGENTS.md'), `# Mine\n- rule\n\n${LINE}\n`);
  assert.deepEqual(both.writes, ['AGENTS.md'], 'a file that has the line is not touched');
  assert.deepEqual(await addPointers(both.disk, LINE, 'Instructions'), [], 'a second time changes nothing');
});

test('a folder with no instruction file gets an AGENTS.md with a heading and the line', async () => {
  const none = folder();
  assert.deepEqual(await addPointers(none.disk, LINE, 'Instructions for ai apps'), ['AGENTS.md']);
  assert.equal(none.map.get('AGENTS.md'), `# Instructions for ai apps\n\n${LINE}\n`);
  await assert.rejects(addPointers(none.disk, 'no path here', 'x'), /must name/);
});

test('every language’s line names the guide’s path, so the app can tell the line is there', async () => {
  assert.ok(en['vault.agents.line'].includes(GUIDE_PATH));
  for (const tag of Object.keys(LOCALES)) {
    if (tag === 'en') continue;
    const { vault } = await import(`../src/i18n/locales/${tag}/vault.ts`);
    assert.ok((vault['vault.agents.line'] as string).includes(GUIDE_PATH), tag);
  }
});
