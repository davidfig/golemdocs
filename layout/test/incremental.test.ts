// Incremental layout must produce exactly what a fresh layout of the edited document does.
// Random edits (typing, deleting, Enter, Backspace at a paragraph start) on long documents
// with lists, tables, keep-with-next and page breaks; after each one the session re-lays
// out incrementally and every page body is compared with a full layout.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  deleteText,
  findContainer,
  insertBlockAfter,
  insertText,
  mergeParagraphs,
  paragraphLength,
  paragraphsIn,
  removeBlock,
  splitParagraph,
  WordDocument,
  type Paragraph,
  type Run,
} from '@word/docx';
import { FontSet, LayoutSession, layoutDocument, packColor, type PageLayout } from '../src/index.ts';

const FONT_DIR = path.resolve(import.meta.dirname, '../../client/public/fonts');
const CORPUS = path.resolve(import.meta.dirname, '../../.cache/docx-corpus');
const hasFonts = existsSync(path.join(FONT_DIR, 'manifest.json'));
const skip = hasFonts ? {} : { skip: 'run `pnpm fonts` first' };
const fonts = hasFonts ? await FontSet.load(async (p) => JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8'))) : null;

/** Deterministic PRNG (mulberry32). */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A page body's content as comparable data. */
function describe(page: PageLayout): string {
  const parts: string[] = [`${page.width}x${page.height} #${page.number}`];
  for (const [key, list] of [...page.glyphs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (list.count) parts.push(`${key}:${list.count}:${Buffer.from(list.bytes).toString('base64')}`);
  }
  parts.push(`bg:${Buffer.from(page.background.bytes).toString('base64')}`);
  parts.push(`fg:${Buffer.from(page.foreground.bytes).toString('base64')}`);
  parts.push(`img:${JSON.stringify(page.images)}`);
  parts.push(`lines:${page.lines.map((l) => `${l.start}-${l.end}@${l.y.toFixed(3)}`).join(',')}`);
  return parts.join('\n');
}

const WORDS = 'the quick brown fox jumps over a lazy dog while seven wizards box quietly and then some'.split(' ');

async function editAndCompare(doc: WordDocument, seed: number, edits: number): Promise<{ incremental: number[]; full: number[]; converged: number }> {
  const session = await LayoutSession.create(doc, fonts!);
  await session.run({ mergeOverlays: false });
  const rand = random(seed);
  const incremental: number[] = [];
  const full: number[] = [];
  let converged = 0;
  for (let e = 0; e < edits; e++) {
    const paragraphs = paragraphsIn(doc.body);
    const p = paragraphs[Math.floor(rand() * paragraphs.length)];
    const length = paragraphLength(p);
    const at = Math.floor(rand() * (length + 1));
    const kind = rand();
    const changed: Paragraph[] = [p];
    let structural = false;
    let label: string;
    if (kind < 0.4) {
      const words = Array.from({ length: 1 + Math.floor(rand() * 12) }, () => WORDS[Math.floor(rand() * WORDS.length)]);
      insertText(p, at, ` ${words.join(' ')} `);
      label = 'insert';
    } else if (kind < 0.65) {
      deleteText(p, at, Math.min(length, at + 1 + Math.floor(rand() * 40)));
      label = 'delete';
    } else if (kind < 0.85) {
      const container = findContainer(doc.body, p)!;
      structural = !!p.properties.section;
      const next = splitParagraph(p, at, doc.styles);
      insertBlockAfter(container, p, next);
      changed.push(next);
      label = 'split';
    } else {
      // Backspace at the start of the next paragraph in the same container.
      const container = findContainer(doc.body, p)!;
      const next = container[container.indexOf(p) + 1];
      if (!next || next.kind !== 'paragraph') continue;
      structural = !!(p.properties.section || next.properties.section);
      mergeParagraphs(p, next);
      removeBlock(container, next);
      label = 'merge';
    }

    const t0 = performance.now();
    session.invalidate(changed, { structural });
    const result = await session.run({ mergeOverlays: false });
    incremental.push(performance.now() - t0);
    if (result.convergedAt >= 0) converged++;

    const t1 = performance.now();
    const reference = await layoutDocument(doc, fonts!, { mergeOverlays: false });
    full.push(performance.now() - t1);

    const where = `edit ${e} (${label}) in paragraph ${paragraphs.indexOf(p)} at ${at}: restarted at ${result.from}, converged at ${result.convergedAt}, added ${result.added.length}, removed ${result.removed.length}`;
    if (session.pages.length !== reference.pages.length) {
      const firstDiff = reference.pages.findIndex((r, i) => !session.pages[i] || describe(session.pages[i]) !== describe(r));
      const al = session.pages[firstDiff] ? describe(session.pages[firstDiff]).split('\n') : [];
      const bl = describe(reference.pages[firstDiff]).split('\n');
      const k = al.findIndex((x, j) => x !== bl[j]);
      const brief = (x: string | undefined) => (x && x.length > 300 ? x.slice(0, 120) + '…' + x.slice(-150) : x);
      assert.fail(`${where}: ${session.pages.length} pages vs ${reference.pages.length}; first difference on page ${firstDiff}: ${brief(al[k])} VS ${brief(bl[k])}`);
    }
    for (let i = 0; i < reference.pages.length; i++) {
      assert.equal(session.pages[i].index, i, `edit ${e} (${label}): page ${i} index`);
      const a = describe(session.pages[i]);
      const b = describe(reference.pages[i]);
      if (a !== b) {
        const al = a.split('\n');
        const bl = b.split('\n');
        const k = al.findIndex((x, j) => x !== bl[j]);
        assert.fail(`${where}: page ${i} differs: ${al[k]?.slice(0, 200)} vs ${bl[k]?.slice(0, 200)}`);
      }
    }
  }
  return { incremental, full, converged };
}

/** STRESS=n multiplies the number of edits and changes the seeds (for occasional deeper runs). */
const STRESS = Number(process.env.STRESS ?? 1);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const run = (text: string): Run => ({ kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'text', text }] });

test('incremental layout matches full layout: long plain document', skip, async () => {
  const doc = await WordDocument.create();
  const rand = random(7);
  doc.body = Array.from({ length: 400 }, (_, i): Paragraph => {
    const heading = i % 25 === 0;
    const words = Array.from({ length: heading ? 4 : 20 + Math.floor(rand() * 120) }, () => WORDS[Math.floor(rand() * WORDS.length)]);
    return {
      kind: 'paragraph',
      properties: heading ? { style: 'Heading1' } : i % 97 === 50 ? { pageBreakBefore: true } : {},
      children: [run(words.join(' '))],
      attrs: {},
    };
  });
  const { incremental, full, converged } = await editAndCompare(doc, 1 + STRESS * 1000, 60 * STRESS);
  console.log(`plain: incremental median ${median(incremental).toFixed(1)} ms vs full ${median(full).toFixed(1)} ms; converged ${converged}/${incremental.length}`);
});

/** A long document of paragraphs (some headings, a few page breaks); `sections` shapes its sections. */
async function columnsDocument(seed: number, shape: (doc: WordDocument, paragraphs: Paragraph[]) => void): Promise<WordDocument> {
  const doc = await WordDocument.create();
  const rand = random(seed);
  const paragraphs = Array.from({ length: 300 }, (_, i): Paragraph => {
    const heading = i % 30 === 0;
    const words = Array.from({ length: heading ? 4 : 15 + Math.floor(rand() * 90) }, () => WORDS[Math.floor(rand() * WORDS.length)]);
    return { kind: 'paragraph', properties: heading ? { style: 'Heading1' } : i % 89 === 40 ? { pageBreakBefore: true } : {}, children: [run(words.join(' '))], attrs: {} };
  });
  doc.body = paragraphs;
  shape(doc, paragraphs);
  return doc;
}

test('incremental layout matches full layout: two columns with a line between them', skip, async () => {
  const doc = await columnsDocument(11, (d) => {
    d.section = { ...d.section, columns: { num: 2, space: 720, sep: true } };
  });
  const { incremental, full, converged } = await editAndCompare(doc, 3 + STRESS * 1000, 60 * STRESS);
  console.log(`two columns: incremental median ${median(incremental).toFixed(1)} ms vs full ${median(full).toFixed(1)} ms; converged ${converged}/${incremental.length}`);
});

test('incremental layout matches full layout: sections with different columns', skip, async () => {
  const doc = await columnsDocument(13, (d, paragraphs) => {
    // One column, then three continuous columns, then two on a new page, then (the last section) one again.
    const base = d.section;
    paragraphs[60].properties.section = { ...base, columns: { num: 1 } };
    paragraphs[140].properties.section = { ...base, type: 'continuous', columns: { num: 3, space: 360, sep: true } };
    paragraphs[220].properties.section = { ...base, type: 'nextPage', columns: { num: 2, space: 720 } };
    d.section = { ...base, type: 'continuous', columns: { num: 1 } };
  });
  const { incremental, full, converged } = await editAndCompare(doc, 5 + STRESS * 1000, 60 * STRESS);
  console.log(`mixed sections: incremental median ${median(incremental).toFixed(1)} ms vs full ${median(full).toFixed(1)} ms; converged ${converged}/${incremental.length}`);
});

for (const name of ['bug65649.docx', 'Numbering.docx', 'bug59058.docx', 'TestTableColumns.docx', '60329.docx', 'ThreeColHeadFoot.docx']) {
  const file = path.join(CORPUS, name);
  test(`incremental layout matches full layout: ${name}`, hasFonts && existsSync(file) ? {} : { skip: 'needs fonts and the corpus' }, async () => {
    const doc = await WordDocument.read(readFileSync(file));
    const { incremental, full, converged } = await editAndCompare(doc, name.length + STRESS * 1000, 25 * STRESS);
    console.log(`${name}: incremental median ${median(incremental).toFixed(1)} ms vs full ${median(full).toFixed(1)} ms; converged ${converged}/${incremental.length}`);
  });
}

test('a newer edit supersedes a running layout, and the next run is still exact', skip, async () => {
  const doc = await WordDocument.create();
  const rand = random(3);
  doc.body = Array.from({ length: 600 }, (): Paragraph => ({
    kind: 'paragraph',
    properties: {},
    children: [run(Array.from({ length: 60 }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' '))],
    attrs: {},
  }));
  const session = await LayoutSession.create(doc, fonts!);
  await session.run({ mergeOverlays: false });
  const paragraphs = paragraphsIn(doc.body);

  // Enter near the start shifts every page after it: a long run.
  const first = paragraphs[2];
  const second = splitParagraph(first, 5);
  insertBlockAfter(doc.body, first, second);
  session.invalidate([first, second]);
  let slices = 0;
  let shownMidway = 0;
  const result = await session.run({
    mergeOverlays: false,
    sliceMs: 0,
    onSlice: () => {
      slices++;
      if (slices === 3) {
        // While it runs: pages so far are new, the rest still old.
        shownMidway = session.displayPages.length;
        insertText(paragraphs[300], 0, 'typed while laying out ');
        session.invalidate([paragraphs[300]]);
      }
    },
  });
  assert.equal(result.completed, false, 'superseded');
  assert.ok(shownMidway > 0);
  assert.ok(session.needsLayout);
  const done = await session.run({ mergeOverlays: false });
  assert.ok(done.completed);
  const reference = await layoutDocument(doc, fonts!, { mergeOverlays: false });
  assert.equal(session.pages.length, reference.pages.length);
  session.pages.forEach((p, i) => assert.equal(describe(p), describe(reference.pages[i]), `page ${i}`));
});

test('after a table style changes, its tables are laid out with the new style', skip, async () => {
  const doc = await WordDocument.create();
  const shaded = (fill: string) => ({ type: 'table' as const, id: 'Shaded', attrs: {}, cellProperties: { shading: { fill } } });
  doc.styles = { ...doc.styles, styles: [...doc.styles.styles, shaded('FF0000')] };
  const cell = { kind: 'cell' as const, properties: {}, attrs: {}, children: [{ kind: 'paragraph' as const, properties: {}, children: [run('cell')], attrs: {} }] };
  doc.body = [
    { kind: 'table', properties: { style: 'Shaded' }, grid: [4000], rows: [{ kind: 'row', properties: {}, attrs: {}, cells: [cell] }] },
    { kind: 'paragraph', properties: {}, children: [], attrs: {} },
  ];
  const fills = (page: PageLayout) => Array.from({ length: page.background.count }, (_, i) => page.background.color(i));
  const session = await LayoutSession.create(doc, fonts!);
  await session.run({ mergeOverlays: false });
  assert.ok(fills(session.pages[0]).includes(packColor(0xff0000)));
  doc.styles = { ...doc.styles, styles: [...doc.styles.styles.filter((s) => s.id !== 'Shaded'), shaded('0000FF')] };
  session.invalidateStyles();
  await session.run({ mergeOverlays: false });
  assert.deepEqual(fills(session.pages[0]), [packColor(0x0000ff)]);
});
