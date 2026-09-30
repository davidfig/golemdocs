// Equations in PDF and picture export: the math font is embedded (PDF) or drawn from its outlines (picture).

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { mathInline, parseLatex, WordDocument, type Paragraph } from '@word/docx';
import { FontSet } from '@word/layout';
import { extractText, PdfDocument } from '@word/pdf';
import { documentToImage } from '../src/formats/pageImage.ts';
import { documentToPdf } from '../src/formats/pdfExport.ts';
import { installFakeCanvas } from './fakeCanvas.ts';

const FONT_DIR = path.resolve(import.meta.dirname, '../public/fonts');
const hasFonts = existsSync(path.join(FONT_DIR, 'libertinus-math', 'regular.ttf'));
const skip = hasFonts ? {} : { skip: 'run `pnpm fonts` first' };
const json = async (p: string) => JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8'));
const file = async (p: string) => new Uint8Array(readFileSync(path.join(FONT_DIR, p)));
const fonts = hasFonts ? await FontSet.load(json, file) : null;

const run = (text: string) => ({ kind: 'run' as const, properties: {}, attrs: {}, content: [{ kind: 'text' as const, text }] });
const equation = (latex: string) => mathInline(parseLatex(latex).equation);
const paragraph = (...children: Paragraph['children']): Paragraph => ({ kind: 'paragraph', properties: {}, attrs: {}, children });

async function documentWith(...children: Paragraph['children']): Promise<WordDocument> {
  const doc = await WordDocument.create();
  doc.body = [paragraph(...children)];
  return doc;
}

test('PDF: an equation is embedded in the math font and its text can be copied', skip, async () => {
  const doc = await documentWith(run('Ratio '), equation('\\frac{a}{b} \\le \\sqrt{x}'), run(' end'));
  const bytes = await documentToPdf(doc, fonts!);
  const text = extractText(PdfDocument.load(bytes).pages[0]).text;
  assert.ok(text.includes('Ratio'), text);
  // a, b and x in math italic, and the ≤ sign; the sign of the root and the bars have no character.
  for (const ch of ['𝑎', '𝑏', '𝑥', '≤']) assert.ok(text.includes(ch), `${ch} in ${JSON.stringify(text)}`);
});

test('PDF: a subset of the math font is written, not the whole file', skip, async () => {
  const doc = await documentWith(equation('x'));
  const bytes = await documentToPdf(doc, fonts!);
  assert.ok(bytes.length < 200_000, `${bytes.length} bytes`);
});

test('PDF: without the font file an equation is left out, and the rest still exports', skip, async () => {
  const noFiles = await FontSet.load(json);
  const doc = await documentWith(run('Kept '), equation('\\frac{a}{b}'));
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (...a: unknown[]) => void warnings.push(a.join(' '));
  try {
    const bytes = await documentToPdf(doc, noFiles);
    const text = extractText(PdfDocument.load(bytes).pages[0]).text;
    assert.ok(text.includes('Kept'));
    assert.ok(!text.includes('𝑎'));
    assert.ok(warnings.some((w) => /math font/.test(w)), warnings.join('\n'));
  } finally {
    console.warn = warn;
  }
});

let fake: ReturnType<typeof installFakeCanvas>;
const globals = globalThis as unknown as { Path2D?: unknown };
beforeEach(() => {
  fake = installFakeCanvas();
  globals.Path2D = class {
    constructor(readonly d: string) {}
  };
});
afterEach(() => {
  fake.restore();
  delete globals.Path2D;
});

test('picture: equation glyphs are filled from their outlines at their size and position', skip, async () => {
  const doc = await documentWith(equation('\\frac{a}{b}'));
  await documentToImage(doc, fonts!, 'png');
  const ctx = fake.canvases[0]!.ctx;
  const fills = ctx.ops('fill');
  // a and b, each a path from the font.
  assert.equal(fills.length, 2);
  for (const f of fills) assert.match((f.args[0] as { d: string }).d, /^M/);
  // Each fill is drawn in a frame scaled by size/unitsPerEm, flipped (y up in the font).
  const scales = ctx.ops('scale').filter((c) => (c.args[1] as number) < 0);
  assert.equal(scales.length, 2);
  for (const s of scales) assert.ok(Math.abs(s.args[0] as number) > 0 && Math.abs((s.args[0] as number) + (s.args[1] as number)) < 1e-9);
});
