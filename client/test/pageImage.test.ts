// A document drawn as a picture (src/formats/pageImage.ts): real layout with the real fonts, drawn on a
// recording fake canvas (test/fakeCanvas.ts), so what is checked is where and how each thing is drawn.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { WordDocument, type Paragraph, type Run } from '@word/docx';
import { FontSet } from '@word/layout';
import { documentToImage } from '../src/formats/pageImage.ts';
import { installFakeCanvas } from './fakeCanvas.ts';

const FONT_DIR = path.resolve(import.meta.dirname, '../public/fonts');
const hasFonts = existsSync(path.join(FONT_DIR, 'manifest.json'));
const skip = hasFonts ? {} : { skip: 'run `pnpm fonts` first' };
const fonts = hasFonts ? await FontSet.load(async (p) => JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8'))) : null;

const run = (text: string, properties: Run['properties'] = {}): Run => ({ kind: 'run', properties, content: [{ kind: 'text', text }], attrs: {} });
const paragraph = (children: Paragraph['children'], properties: Paragraph['properties'] = {}): Paragraph => ({ kind: 'paragraph', properties, children, attrs: {} });

let fake: ReturnType<typeof installFakeCanvas>;
beforeEach(() => {
  fake = installFakeCanvas();
});
afterEach(() => fake.restore());

async function draw(body: Paragraph[], type: 'png' | 'jpeg' | 'webp' = 'png') {
  const doc = await WordDocument.create();
  doc.body = body;
  const bytes = await documentToImage(doc, fonts!, type);
  const canvas = fake.canvases[0]!;
  return { bytes, canvas, ctx: canvas.ctx, text: new TextDecoder().decode(bytes) };
}

const chars = (ctx: { ops(op: string): { args: unknown[] }[] }) => ctx.ops('fillText').map((c) => c.args[0] as string);

test('a one-page document is a white canvas at twice the page size in points, encoded as asked', skip, async () => {
  const { canvas, ctx, text } = await draw([paragraph([run('Hi')])], 'webp');
  assert.deepEqual([canvas.width, canvas.height], [1224, 1584]);
  assert.equal(text, 'encoded:image/webp');
  const first = ctx.calls[0]!;
  assert.equal(first.op, 'fillRect');
  assert.equal(first.fillStyle, '#fff');
  assert.deepEqual(first.args, [0, 0, 1224, 1584]);
});

test('each glyph is drawn as its character at the laid-out position, inside a page clip at that page’s scale', skip, async () => {
  const { ctx } = await draw([paragraph([run('Hello')])]);
  assert.deepEqual(chars(ctx), ['H', 'e', 'l', 'l', 'o']);
  const xs = ctx.ops('fillText').map((c) => c.args[1] as number);
  const ys = ctx.ops('fillText').map((c) => c.args[2] as number);
  assert.ok(xs.every((x, i) => i === 0 || x > xs[i - 1]!), 'left to right');
  assert.ok(Math.abs(xs[0]! - 72) < 0.5, `starts at the 1 inch margin (${xs[0]})`);
  assert.equal(new Set(ys).size, 1, 'one baseline');
  assert.ok(ys[0]! > 72 && ys[0]! < 120);

  const ops = ctx.calls.map((c) => c.op);
  assert.deepEqual(ops.slice(1, 6), ['save', 'translate', 'scale', 'beginPath', 'rect']);
  assert.deepEqual(ctx.ops('translate')[0]!.args, [0, 0]);
  assert.deepEqual(ctx.ops('scale')[0]!.args, [2, 2]);
  assert.deepEqual(ctx.ops('rect')[0]!.args, [0, 0, 612, 792]);
  assert.equal(ops.at(-1), 'restore');
});

test('bold, italic, colour, size and family reach the canvas font and fill', skip, async () => {
  const { ctx } = await draw([
    paragraph([
      run('B', { bold: true }),
      run('I', { italic: true }),
      run('R', { color: { val: 'FF0000' } }),
      run('M', { fonts: { ascii: 'Courier New', hAnsi: 'Courier New' }, size: 40 }),
      run('P'),
    ]),
  ]);
  const by = Object.fromEntries(ctx.ops('fillText').map((c) => [c.args[0] as string, c]));
  assert.ok((by.B!.font as string).startsWith('bold '));
  assert.ok(!(by.B!.font as string).includes('italic'));
  assert.ok((by.I!.font as string).startsWith('italic '));
  assert.ok(!(by.I!.font as string).includes('bold'));
  assert.ok(!(by.P!.font as string).startsWith('bold') && !(by.P!.font as string).startsWith('italic'));
  assert.equal(by.R!.fillStyle, 'rgba(255,0,0,1)');
  assert.notEqual(by.P!.fillStyle, by.R!.fillStyle);
  assert.match(by.M!.font as string, /"Courier New", Courier, monospace$/);
  assert.match(by.M!.font as string, /^20px /, 'size 40 half-points is 20 px in page units');
});

test('a page break makes a second page: its own clip, offset by the first page’s height', skip, async () => {
  const doc = await WordDocument.create();
  doc.body = [paragraph([run('one')]), paragraph([{ kind: 'run', properties: {}, content: [{ kind: 'break', type: 'page' } as any], attrs: {} }, run('two')])];
  await documentToImage(doc, fonts!, 'png');
  const ctx = fake.canvases[0]!.ctx;
  assert.equal(ctx.ops('translate').length, 2);
  assert.deepEqual(ctx.ops('translate')[1]!.args, [0, 792 * 2]);
  assert.equal(fake.canvases[0]!.height, 792 * 2 * 2);
  assert.equal(ctx.ops('save').length, 2);
  assert.equal(ctx.ops('restore').length, 2);
  assert.ok(chars(ctx).join('').endsWith('two'));
});

test('a very long document is drawn at a smaller scale so no side passes the canvas limit', skip, async () => {
  const body = Array.from({ length: 1400 }, (_, i) => paragraph([run(`Line ${i}`)]));
  const { canvas, ctx } = await draw(body);
  assert.ok(canvas.height <= 16000, `height ${canvas.height}`);
  const scale = ctx.ops('scale')[0]!.args[0] as number;
  assert.ok(scale < 2 && scale > 0);
  assert.ok(Math.abs(canvas.width - 612 * scale) <= 1);
});

test('nothing is decoded when the document has no pictures, and an empty document still yields a page', skip, async () => {
  const { canvas } = await draw([]);
  assert.deepEqual([canvas.width, canvas.height], [1224, 1584]);
  assert.equal(fake.bitmaps.length, 0);
});
