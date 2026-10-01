import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WordDocument, type Paragraph, type Run } from '@golemdocs/docx';
import { FontSet, layoutDocument, LayoutSession } from '../src/index.ts';

// A synthetic manifest: two Latin families, each with a core atlas and an extra page for the characters its core lacks.

const bounds = { left: 0, top: 0, right: 1, bottom: 1 };
const glyph = (unicode: number, advance: number) => ({ unicode, advance, planeBounds: bounds, atlasBounds: bounds });
const chars = (s: string) => [...s].map((c) => c.codePointAt(0)!);

const metrics = {
  unitsPerEm: 1000,
  hhea: { ascender: 750, descender: -250, lineGap: 0 },
  typo: { ascender: 750, descender: -250, lineGap: 0, useTypoMetrics: false },
  win: { ascent: 750, descent: 250 },
  xHeight: 500,
  capHeight: 700,
  underline: { position: -100, thickness: 50 },
  strikeout: { position: 300, size: 50 },
  subscript: { xSize: 0, ySize: 0, xOffset: 0, yOffset: 0 },
  superscript: { xSize: 0, ySize: 0, xOffset: 0, yOffset: 0 },
};

const CORE = 'abc ';
/** What each extra page holds: characters the core lacks. */
const EXTRA: Record<string, string> = { calibri: '▸☃', arial: '☃' };

function makeFonts() {
  const files: Record<string, unknown> = {};
  const loaded: string[] = [];
  const faces = (id: string, glyphs: ReturnType<typeof glyph>[]) =>
    [false, true].map((bold) => {
      const name = `${id}/${bold ? 'bold' : 'regular'}`;
      files[`${name}.json`] = { atlas: { type: 'msdf', distanceRange: 4, size: 32, width: 64, height: 64, yOrigin: 'bottom' }, metrics: { emSize: 32, lineHeight: 1, ascender: 1, descender: -0.25, underlineY: -0.1, underlineThickness: 0.05 }, glyphs };
      return { weight: bold ? 700 : 400, italic: false, atlas: `${name}.png`, layout: `${name}.json`, metrics };
    });
  const families = ['calibri', 'arial'].flatMap((id) => {
    files[`${id}-extra/coverage.json`] = chars(EXTRA[id]).sort((a, b) => a - b).flatMap((c) => [c, c]);
    const base = { substitute: id, license: '', licenseFile: '', aliases: {} };
    return [
      { ...base, id, wordName: id === 'calibri' ? 'Calibri' : 'Arial', faces: faces(id, chars(CORE).map((c) => glyph(c, 0.5))) },
      {
        ...base,
        id: `${id}-extra`,
        wordName: `${id} (extra)`,
        faces: faces(`${id}-extra`, chars(EXTRA[id]).map((c) => glyph(c, 0.75))),
        page: { group: id, order: 0, coverage: `${id}-extra/coverage.json` },
      },
    ];
  });
  files['manifest.json'] = { atlas: { type: 'msdf', size: 32, pxrange: 4, yOrigin: 'bottom', generator: 'test' }, families };
  return FontSet.load(async (path) => {
    if (path.endsWith('.json') && path !== 'manifest.json' && !path.endsWith('coverage.json')) loaded.push(path.replace('.json', ''));
    if (!(path in files)) throw new Error(`no file ${path}`);
    return files[path];
  }).then((fonts) => ({ fonts, loaded }));
}

const run = (text: string, properties: Run['properties'] = {}): Run => ({ kind: 'run', properties: { size: 20, ...properties }, content: [{ kind: 'text', text }], attrs: {} });
const paragraph = (...children: Run[]): Paragraph => ({ kind: 'paragraph', properties: {}, children, attrs: {} });

async function layout(fonts: FontSet, ...children: Run[]) {
  const doc = await WordDocument.create();
  doc.body = [paragraph(...children)];
  const result = await layoutDocument(doc, fonts);
  return result.pages[0];
}

test('text the core atlas covers loads no extra page', async () => {
  const { fonts, loaded } = await makeFonts();
  const page = await layout(fonts, run('abc'));
  assert.deepEqual([...page.glyphs.keys()].map((k) => k.split('/')[0]), ['calibri']);
  assert.ok(!loaded.some((id) => id.includes('extra')));
});

test('a character the core lacks draws from the extra page, in the run\'s style only', async () => {
  const { fonts, loaded } = await makeFonts();
  const page = await layout(fonts, run('a▸'));
  const used = [...page.glyphs.keys()].map((k) => k.split('/')[0]);
  assert.ok(used.includes('calibri') && used.includes('calibri-extra'), used.join());
  assert.deepEqual(loaded.filter((id) => id.includes('extra')), ['calibri-extra/regular'], 'the bold face stays unloaded');
  const bold = await layout(fonts, run('▸', { bold: true }));
  assert.ok([...bold.glyphs.keys()].some((k) => k.startsWith('calibri-extra') && k.includes('700')), [...bold.glyphs.keys()].join());
});

test('the run\'s own family\'s extra page is tried before the fallback family\'s', async () => {
  const { fonts } = await makeFonts();
  // ☃ is on both pages: an Arial run takes Arial's, a Calibri run Calibri's.
  const arial = await layout(fonts, run('☃', { fonts: { ascii: 'Arial', hAnsi: 'Arial' } }));
  assert.deepEqual([...arial.glyphs.keys()].map((k) => k.split('/')[0]), ['arial-extra']);
  const calibri = await layout(fonts, run('☃'));
  assert.deepEqual([...calibri.glyphs.keys()].map((k) => k.split('/')[0]), ['calibri-extra']);
});

test('a character only the fallback family\'s extra page has is drawn from it', async () => {
  const { fonts } = await makeFonts();
  const page = await layout(fonts, run('▸', { fonts: { ascii: 'Arial', hAnsi: 'Arial' } }));
  assert.deepEqual([...page.glyphs.keys()].map((k) => k.split('/')[0]), ['calibri-extra']);
});

test('extra pages are not fonts to choose', async () => {
  const { fonts } = await makeFonts();
  assert.ok(!fonts.isKnown('calibri (extra)'));
  assert.deepEqual(fonts.pages('calibri').map((f) => f.id), ['calibri-extra']);
});

test('text typed later loads its extra page first', async () => {
  const { fonts, loaded } = await makeFonts();
  const doc = await WordDocument.create();
  doc.body = [paragraph(run('abc'))];
  const session = await LayoutSession.create(doc, fonts);
  await session.ensurePages('abc é');
  assert.ok(!loaded.some((id) => id.includes('extra')), 'no page covers é, and the core has no use for one');
  await session.ensurePages('☃');
  assert.ok(loaded.includes('calibri-extra/regular'));
  await session.ensurePages('☃');
  assert.equal(loaded.filter((id) => id === 'calibri-extra/regular').length, 1, 'loaded once');
});
