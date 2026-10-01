// Property tests for the editor: random command sequences keep the selection valid, undo and
// redo restore the document exactly, and editors collaborating through a server converge.
// Replay a failure with `SEED=n pnpm --filter @golemdocs/editor test`.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { paragraphLength, paragraphsIn, paragraphText, WordDocument, type Paragraph } from '@golemdocs/docx';
import { FontSet, LayoutSession } from '@golemdocs/layout';
import { CollabServer, Replica, type ClientMessage, type ServerMessage } from '@golemdocs/ops';
import { Editor, type Command, type MoveTarget } from '../src/index.ts';
import { forSeeds, randomText, rng, type Rand } from '../../ops/test/fuzz.ts';

const FONT_DIR = path.resolve(import.meta.dirname, '../../client/public/fonts');
const hasFonts = existsSync(path.join(FONT_DIR, 'manifest.json'));
const skip = hasFonts ? {} : { skip: 'run `pnpm fonts` first' };
const fonts = hasFonts ? await FontSet.load(async (p) => JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8'))) : null;

const canon = (value: unknown): unknown => (Array.isArray(value) ? value.map(canon) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, canon(v)])) : value);
const body = (doc: WordDocument) => JSON.stringify(canon(doc.body));

function randomDocument(rand: Rand): Paragraph[] {
  const n = rand.range(1, 6);
  return Array.from({ length: n }, () => {
    const text = rand.bool(0.15) ? '' : Array.from({ length: rand.range(1, 4) }, () => randomText(rand, 8, 0.05)).join(' ');
    return { kind: 'paragraph', properties: {}, children: text ? [{ kind: 'run', properties: rand.bool(0.2) ? { bold: true } : {}, attrs: {}, content: [{ kind: 'text', text }] }] : [], attrs: {} } as Paragraph;
  });
}

async function newEditor(bytes: Uint8Array, seed: number, clientId?: string) {
  const doc = await WordDocument.read(bytes);
  const replica = new Replica(doc, { clientId, random: rng(seed) });
  const session = await LayoutSession.create(doc, fonts!);
  await session.run();
  return { editor: new Editor(replica, session), session, doc, replica };
}

const MOVES: MoveTarget[] = ['left', 'right', 'wordLeft', 'wordRight', 'up', 'down', 'lineStart', 'lineEnd', 'documentStart', 'documentEnd'];

/** A random command, and whether it edits the document. */
function randomCommand(editor: Editor, rand: Rand): { command: Command; edits: boolean } {
  const r = rand();
  if (r < 0.3) return { command: { kind: 'insertText', text: randomText(rand, 3, 0.15) }, edits: true };
  if (r < 0.38) return { command: { kind: 'insertParagraph' }, edits: true };
  if (r < 0.52) return { command: { kind: 'delete', direction: rand.bool() ? 'backward' : 'forward', unit: rand.bool(0.25) ? 'word' : 'character' }, edits: true };
  if (r < 0.7) return { command: { kind: 'move', to: rand.pick(MOVES), extend: rand.bool(0.4) }, edits: false };
  if (r < 0.76) {
    const ps = editor.paragraphs();
    const i = rand.int(ps.length);
    const length = paragraphLength(ps[i]);
    const from = rand.int(length + 1);
    return { command: { kind: 'select', paragraph: i, from, to: rand.range(from, length) }, edits: false };
  }
  if (r < 0.82) return { command: { kind: 'formatText', format: { bold: rand.bool() ? true : null } }, edits: true };
  if (r < 0.86) return { command: { kind: 'insertLineBreak' }, edits: true };
  if (r < 0.9) return { command: { kind: 'changeCase', change: (t: string) => t.toUpperCase() }, edits: true };
  if (r < 0.93) return { command: { kind: 'selectAll' }, edits: false };
  return { command: { kind: 'insertText', text: rand.pick(['a', 'b', ' ', 'é']) }, edits: true };
}

/** The selection must point at paragraphs of the document, at offsets inside them. */
function checkSelection(editor: Editor, what: string): void {
  const ps = new Set(paragraphsIn(editor.doc.body));
  for (const end of ['anchor', 'focus'] as const) {
    const pos = editor.selection[end];
    assert.ok(ps.has(pos.paragraph), `${what}: ${end} is in a paragraph that is not in the document`);
    const length = paragraphLength(pos.paragraph);
    assert.ok(Number.isInteger(pos.offset) && pos.offset >= 0 && pos.offset <= length, `${what}: ${end} offset ${pos.offset} outside 0..${length}`);
  }
  assert.deepEqual(editor.paragraphs(), paragraphsIn(editor.doc.body), `${what}: the editor's paragraph list is stale`);
}

async function bytesOf(paragraphs: Paragraph[]): Promise<Uint8Array> {
  const doc = await WordDocument.create();
  doc.body = paragraphs;
  return doc.write();
}

test('property: any command sequence keeps the selection valid; undo and redo restore the document', skip, async () => {
  await forSeeds('editor commands', 250, async (seed, rand) => {
    const { editor, session, doc } = await newEditor(await bytesOf(randomDocument(rand)), seed);
    const states = [body(doc)];
    const trail: string[] = [];
    for (let i = 0; i < 40; i++) {
      const { command, edits } = randomCommand(editor, rand);
      const before = body(doc);
      const textBefore = paragraphsIn(doc.body).map(paragraphText).join('\n');
      const collapsed = editor.collapsed;
      const caret = editor.selection.focus.offset;
      const caretParagraph = editor.selection.focus.paragraph;
      trail.push(command.kind + (command.kind === 'insertText' ? JSON.stringify(command.text) : ''));
      const result = editor.apply(command);
      await session.run();
      const what = `after ${i + 1} commands (${trail.join(', ')})`;
      checkSelection(editor, what);
      if (!edits) assert.equal(body(doc), before, `${what}: a non-editing command changed the document`);
      else if (body(doc) !== before) states.push(body(doc));
      if (command.kind === 'insertText' && collapsed && !/[\n\r]/.test(command.text) && result.edited) {
        assert.equal(paragraphsIn(doc.body).map(paragraphText).join('\n').length, textBefore.length + command.text.length, `${what}: typed text length`);
        assert.equal(editor.selection.focus.paragraph, caretParagraph, `${what}: caret stays in its paragraph when typing`);
        assert.equal(editor.selection.focus.offset, caret + command.text.length, `${what}: caret moves past typed text`);
      }
      if (rand.bool(0.08)) {
        // Undo something and redo it: the document is as it was, the selection valid throughout.
        const at = body(doc);
        if (editor.undo().edited) {
          checkSelection(editor, `${what}, then undo`);
          editor.redo();
          await session.run();
          checkSelection(editor, `${what}, then undo and redo`);
          assert.equal(body(doc), at, `${what}: undo then redo changed the document`);
        }
      }
    }
    const final = body(doc);
    let guard = 0;
    while (editor.undo().edited) {
      await session.run();
      checkSelection(editor, 'while undoing everything');
      assert.ok(guard++ < 1000);
    }
    assert.equal(body(doc), states[0], `everything undone (${trail.join(', ')})`);
    while (editor.redo().edited) {
      await session.run();
      checkSelection(editor, 'while redoing everything');
      assert.ok(guard++ < 2000);
    }
    assert.equal(body(doc), final, 'everything redone');
  });
});

test('property: editors collaborating through a server converge and keep valid selections', skip, async () => {
  await forSeeds('collaborating editors', 100, async (seed, rand) => {
    const bytes = await bytesOf(randomDocument(rand));
    const server = new CollabServer();
    interface Peer {
      editor: Editor;
      session: LayoutSession;
      outbox: ClientMessage[];
      inbox: ServerMessage[];
    }
    const peers: Peer[] = [];
    for (let c = 0; c < 2 + (seed % 2); c++) {
      const made = await newEditor(bytes, seed * 17 + c, `e${c}`);
      const peer: Peer = { editor: made.editor, session: made.session, outbox: [], inbox: [] };
      server.connect((m) => peer.inbox.push(structuredClone(m)));
      made.replica.connect((m) => peer.outbox.push(structuredClone(m)), 0);
      peers.push(peer);
    }
    const deliver = async (peer: Peer, which: 'out' | 'in') => {
      if (which === 'out') {
        const m = peer.outbox.shift();
        if (m) server.submit(m);
      } else {
        const m = peer.inbox.shift();
        if (!m) return;
        peer.editor.receive(m);
        await peer.session.run();
        checkSelection(peer.editor, `peer ${peers.indexOf(peer)} after receiving v${m.version}`);
      }
    };
    for (let i = 0; i < 80; i++) {
      const peer = rand.pick(peers);
      const r = rand();
      if (r < 0.5) {
        peer.editor.apply(randomCommand(peer.editor, rand).command);
        await peer.session.run();
        checkSelection(peer.editor, `peer ${peers.indexOf(peer)} after a command`);
      } else if (r < 0.56) {
        peer.editor.undo();
        await peer.session.run();
        checkSelection(peer.editor, 'after undo');
      } else if (r < 0.6) {
        peer.editor.redo();
        await peer.session.run();
        checkSelection(peer.editor, 'after redo');
      } else await deliver(peer, r < 0.8 ? 'out' : 'in');
    }
    for (let guard = 0; guard < 5000; guard++) {
      const busy = peers.filter((p) => p.outbox.length || p.inbox.length);
      if (!busy.length) break;
      const peer = rand.pick(busy);
      await deliver(peer, peer.inbox.length && (rand.bool() || !peer.outbox.length) ? 'in' : 'out');
    }
    const first = body(peers[0].editor.doc);
    peers.forEach((peer, c) => assert.equal(body(peer.editor.doc), first, `editor ${c} diverged`));
    // The laid-out text agrees with the model.
    for (const peer of peers) checkSelection(peer.editor, 'at the end');
  });
});

test('property: a remote insertion before the caret moves it along, and one after leaves it', skip, async () => {
  await forSeeds('caret through a remote insertion', 100, async (seed, rand) => {
    const bytes = await bytesOf(randomDocument(rand));
    const server = new CollabServer();
    const a = await newEditor(bytes, seed * 3, 'a');
    const b = await newEditor(bytes, seed * 3 + 1, 'b');
    const toA: ServerMessage[] = [];
    const toB: ServerMessage[] = [];
    const fromB: ClientMessage[] = [];
    server.connect((m) => toA.push(structuredClone(m)));
    server.connect((m) => toB.push(structuredClone(m)));
    a.replica.connect(() => {}, 0);
    b.replica.connect((m) => fromB.push(structuredClone(m)), 0);
    // A's caret somewhere; B types in the same paragraph, before it, after it, or at the same place.
    const index = rand.int(a.editor.paragraphs().length);
    const length = paragraphLength(a.editor.paragraphs()[index]);
    const caret = rand.int(length + 1);
    a.editor.apply({ kind: 'select', paragraph: index, from: caret, to: caret });
    const at = rand.int(length + 1);
    const text = randomText(rand, 2, 0);
    b.editor.apply({ kind: 'select', paragraph: index, from: at, to: at });
    b.editor.apply({ kind: 'insertText', text });
    for (const m of fromB) server.submit(m);
    for (const m of toA) a.editor.receive(m);
    await a.session.run();
    const focus = a.editor.selection.focus;
    assert.equal(a.editor.paragraphs().indexOf(focus.paragraph), index, 'the caret stays in its paragraph');
    // Text inserted exactly at the caret goes before or after it; anywhere else the answer is fixed.
    if (at < caret) assert.equal(focus.offset, caret + text.length, `B typed at ${at}, before the caret at ${caret}`);
    else if (at > caret) assert.equal(focus.offset, caret, `B typed at ${at}, after the caret at ${caret}`);
    else assert.ok(focus.offset === caret || focus.offset === caret + text.length, `B typed at the caret (${caret})`);
    assert.equal(body(a.doc), body(b.doc));
  });
});
