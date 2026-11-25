// The fonts an SVG file embeds (src/vector/fonts.ts): read from its @font-face rules, loaded under names of their own, drawn with, and let go of.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { aliasedFamily, fontCss, loadFonts } from '../src/vector/fonts.ts';
import { paintScene } from '../src/vector/paint.ts';
import { sceneToPng } from '../src/formats/vectorDoc.ts';
import { parseFontFaces, parseStylesheet } from '../src/vector/style.ts';
import { readSvg } from '../src/vector/svgRead.ts';
import { writeSvg } from '../src/vector/svgWrite.ts';
import { FakeCanvas, FakeContext, installFakeCanvas } from './fakeCanvas.ts';

class FakeFace {
  static made: FakeFace[] = [];
  constructor(
    readonly family: string,
    readonly source: Uint8Array,
    readonly descriptors: Record<string, string>,
  ) {
    FakeFace.made.push(this);
  }
  async load(): Promise<this> {
    if (new TextDecoder().decode(this.source) === 'broken') throw new Error('not a font');
    return this;
  }
}

const added = new Set<FakeFace>();
const globals = globalThis as unknown as Record<string, unknown>;
let saved: [unknown, unknown];
beforeEach(() => {
  saved = [globals.FontFace, globals.document];
  globals.FontFace = FakeFace;
  globals.document = { fonts: { add: (f: FakeFace) => added.add(f), delete: (f: FakeFace) => added.delete(f) } };
  FakeFace.made = [];
  added.clear();
});
afterEach(() => {
  [globals.FontFace, globals.document] = saved;
});

const uri = (text: string): string => `data:font/ttf;base64,${btoa(text)}`;
const face = (family: string, text: string, more = ''): string => `@font-face{font-family:${family};${more}src:url(${uri(text)}) format("truetype")}`;
const svg = (css: string, body = ''): string => `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><defs><style>${css}</style></defs>${body}</svg>`;

test('font-face rules: family, weight and style, and only data: sources', () => {
  const css = `/* @font-face{font-family:No;src:url(data:,x)} */ @import url("a.css"); ${face("'Big  Face'", 'a', 'font-weight:600;font-style:italic;unicode-range:U+0-7F;')} text{fill:red} @font-face { font-family: Far; src: url(https://example.com/far.woff2), local(Far) } @font-face{font-family:Mixed;src:local("Mixed"),url('https://example.com/m.woff'),url("${uri('b')}")}`;
  assert.deepEqual(parseFontFaces(css), [
    { family: 'Big Face', weight: '600', style: 'italic', unicodeRange: 'U+0-7F', sources: [uri('a')] },
    { family: 'Mixed', sources: [uri('b')] },
  ]);
  // The other rules are read as before.
  assert.equal(parseStylesheet(css).length, 1);
});

test('family lists ask for the loaded names, quoted or not, in any case', () => {
  const aliases = new Map([['big face', 'golem-svg-0-0']]);
  assert.equal(aliasedFamily(`"Big Face", 'BIG FACE', Big  Face, Bigger, serif`, aliases), '"golem-svg-0-0", "golem-svg-0-0","golem-svg-0-0", Bigger, serif');
  assert.equal(aliasedFamily('Arial', undefined), 'Arial');
});

test('fonts are loaded with their weight and style, held once however often they are shown, and let go of', async () => {
  const scene = readSvg(svg(face('Face', 'regular') + face('Face', 'bold', 'font-weight:700;') + face('Other', 'broken')));
  const [one, two] = await Promise.all([loadFonts(scene), loadFonts(scene)]);
  assert.equal(added.size, 2);
  assert.deepEqual([...added].map((f) => [new TextDecoder().decode(f.source), f.descriptors]), [['regular', {}], ['bold', { weight: '700' }]]);
  assert.equal(new Set([...added].map((f) => f.family)).size, 1, 'the weights are one family');
  // A font that can't be read is left out, so its text falls back.
  assert.deepEqual([...one.aliases.keys()], ['face']);
  one.release();
  one.release();
  assert.equal(added.size, 2, 'still shown elsewhere');
  two.release();
  assert.equal(added.size, 0);
  (await loadFonts(scene)).release();
  assert.equal(FakeFace.made.length, 6, 'loaded again when shown again');
});

test('two drawings with different fonts of one name keep their own', async () => {
  const a = await loadFonts(readSvg(svg(face('Face', 'a'))));
  const b = await loadFonts(readSvg(svg(face('Face', 'b'))));
  assert.notEqual(a.aliases.get('face'), b.aliases.get('face'));
  a.release();
  assert.deepEqual([...added].map((f) => f.family), [b.aliases.get('face')]);
  b.release();
});

test('a drawing with no embedded font, or only one at an address, loads nothing', async () => {
  assert.equal(fontCss(readSvg(svg('text{fill:red}'))), '');
  const fonts = await loadFonts(readSvg(svg('@font-face{font-family:F;src:url(https://example.com/f.woff2)}')));
  assert.equal(fonts.aliases.size, 0);
  assert.equal(FakeFace.made.length, 0);
  fonts.release();
});

test('text is drawn in the embedded font, and the file keeps its rules as they were', async () => {
  const css = face('Face', 'a', 'font-weight:500;');
  const scene = readSvg(svg(css, '<text x="5" y="20" font-size="12" font-weight="500" font-family="Face, serif">ab</text>'));
  const fonts = await loadFonts(scene);
  const ctx = new FakeContext(new FakeCanvas(100, 50));
  paintScene(ctx as unknown as CanvasRenderingContext2D, scene, 100, 50, { fonts: fonts.aliases });
  assert.equal(ctx.ops('fillText')[0].font, `500 12px "${fonts.aliases.get('face')}", serif`);
  fonts.release();
  const written = writeSvg(scene);
  assert.ok(written.includes(css.replace(/"/g, '&quot;')) || written.includes(css), written);
  assert.ok(!written.includes('golem-svg'));
});

test('the picture of a drawing is drawn in its fonts, which are then let go of', async () => {
  const fake = installFakeCanvas();
  try {
    await sceneToPng(readSvg(svg(face('Face', 'a'), '<text font-family="Face">ab</text>')));
    assert.match(String(fake.canvases[0].ctx.ops('fillText')[0].font), /golem-svg/);
    assert.equal(added.size, 0);
  } finally {
    fake.restore();
  }
});
