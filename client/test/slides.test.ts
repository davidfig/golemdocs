// Slides (docs/slides.md): the deck model read from and written back to .pptx, inheritance, colours, geometry, text layout and
// editing, structure changes with undo, the scene a slide is drawn from, and decks as outlines.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ZipArchive, el, parseXml, serializeXml } from '@golemdocs/docx';
import { blankDeck } from '../src/slides/blank.ts';
import { Deck, paragraphText } from '../src/slides/deck.ts';
import { resolveColor, DEFAULT_MAP } from '../src/slides/color.ts';
import { defaultTheme } from '../src/slides/theme.ts';
import { builtins, customGeometry, presetGeometry, presetNames } from '../src/slides/geometry.ts';
import { SHAPE_CHOICES } from '../src/slides/shapeChoices.ts';
import { History, Transaction } from '../src/slides/history.ts';
import { addSlide, deleteShapes, deleteSlides, duplicateSlide, moveSlides, newShape, newTable, reorder, setFill, setFrame, setHidden, setHighlight, setLine, isHidden, setNotes, treeOf } from '../src/slides/edit.ts';
import { autoNumber, bulletTexts, layoutText, ROUGH_MEASURE } from '../src/slides/textLayout.ts';
import { deleteRange, insertMultiline, insertText, paragraphsOf, plainText, runsIn, splitParagraph, textBetween, wordAt } from '../src/slides/textEdit.ts';
import { slideScene } from '../src/slides/scene.ts';
import { slideShapes } from '../src/slides/shapes.ts';
import { at, kid, kids } from '../src/slides/ooxml.ts';
import { deckFromMarkdown, deckMarkdown, outlineSlides } from '../src/slides/outline.ts';
import { hiddenAt, readBuilds } from '../src/slides/present.ts';
import { scenesToPdf } from '../src/vector/pdfOut.ts';
import { PdfDocument } from '@golemdocs/pdf';
import type { Paragraph, RunStyle } from '../src/slides/textStyle.ts';

const scene = (deck: Deck, i = 0) => slideScene(deck, deck.slides[i], { measure: ROUGH_MEASURE, family: (f) => f.family, number: i + 1, prompts: true });

test('a blank deck reads back: one Title Slide, six layouts, a theme and a notes master', async () => {
  const deck = await Deck.read(await blankDeck());
  assert.equal(deck.slides.length, 1);
  assert.equal(deck.masters.length, 1);
  assert.deepEqual(
    deck.layoutsOf(deck.masters[0]).map((l) => at(l.xml, 'p:cSld')?.attrs.name),
    ['Title Slide', 'Title and Content', 'Section Header', 'Two Content', 'Title Only', 'Blank'],
  );
  assert.equal(deck.width, 12192000);
  assert.ok(deck.notesMaster);
  assert.equal(deck.masters[0].theme.minor.latin, 'Aptos');
});

test('writing a deck nothing changed in keeps every part as it was', async () => {
  const bytes = await blankDeck();
  const deck = await Deck.read(bytes);
  const out = await deck.write();
  const a = ZipArchive.read(bytes);
  const b = ZipArchive.read(out);
  assert.deepEqual([...b.entries.keys()].sort(), [...a.entries.keys()].sort());
  for (const [name, entry] of a.entries) assert.deepEqual(await b.entries.get(name)!.read(), await entry.read(), name);
});

test('placeholders take their place from the layout, and text styles from the master', async () => {
  const deck = await Deck.read(await blankDeck());
  const shapes = slideShapes(deck, deck.slides[0]);
  const title = shapes.find((s) => s.placeholder?.type === 'ctrTitle')!;
  assert.deepEqual([title.frame.x, title.frame.y, title.frame.w], [1524000, 1122363, 9144000]);
  // The master's placeholders are not shown on slides.
  assert.ok(shapes.every((s) => s.part === deck.slides[0]));
  const { views } = scene(deck);
  const titleView = views.find((v) => v.shape.placeholder?.type === 'ctrTitle')!;
  // Empty: its prompt shows, at the layout's 60 pt, centred.
  assert.equal(titleView.text?.prompt, true);
  const first = titleView.text!.body.paragraphs[0];
  assert.equal(first.runs[0].style.size, 60);
  assert.equal(first.align, 'ctr');
  // Without prompts (a show, an export), nothing is drawn for it.
  const plain = slideScene(deck, deck.slides[0], { measure: ROUGH_MEASURE, family: (f) => f.family, number: 1 });
  assert.equal(plain.views.find((v) => v.shape.placeholder?.type === 'ctrTitle')?.text?.prompt, false);
});

test('scheme colours go through the colour map and their changes', () => {
  const ctx = { theme: defaultTheme(), map: DEFAULT_MAP };
  const tx1 = resolveColor(parseXml('<a:schemeClr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" val="tx1"/>'), ctx)!;
  assert.deepEqual([tx1.r, tx1.g, tx1.b], [0, 0, 0]);
  const half = resolveColor(parseXml('<a:srgbClr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" val="FF0000"><a:lumMod val="50000"/><a:alpha val="40000"/></a:srgbClr>'), ctx)!;
  assert.deepEqual([half.r, half.g, half.b], [128, 0, 0]);
  assert.equal(half.a, 0.4);
  const tinted = resolveColor(parseXml('<a:srgbClr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" val="000000"><a:tint val="0"/></a:srgbClr>'), ctx)!;
  assert.deepEqual([tinted.r, tinted.g, tinted.b], [255, 255, 255]);
});

test('custom geometry: guides, lines and arcs', () => {
  const geom = parseXml(`<a:custGeom xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:gdLst><a:gd name="half" fmla="*/ w 1 2"/></a:gdLst><a:pathLst><a:path w="100" h="100"><a:moveTo><a:pt x="0" y="50"/></a:moveTo><a:arcTo wR="50" hR="50" stAng="10800000" swAng="10800000"/><a:lnTo><a:pt x="0" y="50"/></a:lnTo><a:close/></a:path></a:pathLst></a:custGeom>`);
  const g = customGeometry(geom, 200, 200);
  const cmds = g.paths[0].commands;
  const last = cmds.filter((c) => c[0] === 'C').pop()!;
  // A half turn over the top from the left end lands on the right end.
  assert.ok(Math.abs(last[5] - 200) < 1e-6 && Math.abs(last[6] - 100) < 1e-6, JSON.stringify(last));
  assert.equal(builtins(200, 100).get('ss'), 100);
});

test('every preset shape draws, and its outline and text box stay near its box', () => {
  const names = presetNames();
  assert.equal(names.length, 187);
  for (const name of names) {
    for (const [w, h] of [[300, 200], [100, 400], [0, 50]]) {
      const g = presetGeometry(name, undefined, w, h);
      assert.ok(g.paths.length > 0, name);
      for (const p of g.paths) {
        assert.equal(p.commands[0]?.[0], 'M', name);
        for (const c of p.commands) for (const v of c.slice(1) as number[]) assert.ok(Number.isFinite(v) && Math.abs(v) < 1500, `${name} ${w}x${h}: ${v}`);
      }
      for (const v of Object.values(g.text)) assert.ok(Number.isFinite(v), name);
    }
  }
  assert.equal(presetGeometry('line', undefined, 10, 10).open, true);
  assert.equal(presetGeometry('rect', undefined, 10, 10).open, false);
  // A name the standard doesn't have is its box.
  assert.equal(presetGeometry('nonesuch', undefined, 10, 10).paths[0].commands.length, 5);
  // The gear is the standard's, not a box.
  assert.ok(presetGeometry('gear9', undefined, 100, 100).paths[0].commands.length > 25);
});

test('every shape Insert offers is in the preset table', () => {
  const names = new Set(presetNames());
  for (const name of SHAPE_CHOICES) assert.ok(names.has(name), name);
});

const prstGeom = (name: string, guides: Record<string, number>) =>
  parseXml(`<a:prstGeom xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" prst="${name}"><a:avLst>${Object.entries(guides).map(([k, v]) => `<a:gd name="${k}" fmla="val ${v}"/>`).join('')}</a:avLst></a:prstGeom>`);

test('preset shapes follow their adjustments and the standard outlines', () => {
  // A rounded rectangle's corner is its adjustment of the short side.
  const round = presetGeometry('roundRect', prstGeom('roundRect', { adj: 25000 }), 400, 200).paths[0].commands;
  assert.deepEqual(round[0], ['M', 0, 50]);
  // The same adjustment under its other name.
  assert.deepEqual(presetGeometry('roundRect', prstGeom('roundRect', { adj1: 25000 }), 400, 200).paths[0].commands, round);
  // A guide that isn't an adjustment is not the file's to change.
  assert.deepEqual(presetGeometry('roundRect', prstGeom('roundRect', { x1: 7 }), 400, 200), presetGeometry('roundRect', undefined, 400, 200));
  // An up arrow (missing from the standard's file) is a down arrow the other way up.
  const flat = (name: string, flip: boolean) => new Set(presetGeometry(name, undefined, 80, 200).paths[0].commands.filter((c) => c[0] !== 'Z').map((c) => `${c[1]},${flip ? 200 - (c[2] as number) : c[2]}`));
  assert.deepEqual(flat('upArrow', false), flat('downArrow', true));
  // Parts of a shape are shaded and stroked as the standard says.
  const can = presetGeometry('can', undefined, 100, 100).paths;
  assert.deepEqual(can.map((p) => [p.fill, p.stroke, p.shade]), [[true, false, undefined], [true, false, 'lighten'], [false, true, undefined]]);
});

test('arcs: in a stretched path space, of no height, and drawn on after a close', () => {
  const ns = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  const custom = (w: string, body: string) => customGeometry(parseXml(`<a:custGeom ${ns}><a:pathLst><a:path ${w}>${body}</a:path></a:pathLst></a:custGeom>`), 400, 100).paths[0].commands;
  const near = (c: unknown[], x: number, y: number) => assert.ok(Math.abs((c.at(-2) as number) - x) < 1e-3 && Math.abs((c.at(-1) as number) - y) < 1e-3, JSON.stringify(c));
  // An eighth of a circle in a 100 × 100 space stretched four times as wide.
  const eighth = custom('w="100" h="100"', '<a:moveTo><a:pt x="100" y="50"/></a:moveTo><a:arcTo wR="50" hR="50" stAng="0" swAng="2700000"/>');
  near(eighth.at(-1)!.slice(), (50 + 50 * Math.SQRT1_2) * 4, 50 + 50 * Math.SQRT1_2);
  // A quarter turn with no height is a line along its width.
  near(custom('', '<a:moveTo><a:pt x="100" y="0"/></a:moveTo><a:arcTo wR="100" hR="0" stAng="5400000" swAng="5400000"/>').at(-1)!.slice(), 0, 0);
  const on = custom('', '<a:moveTo><a:pt x="5" y="5"/></a:moveTo><a:lnTo><a:pt x="9" y="5"/></a:lnTo><a:close/><a:lnTo><a:pt x="5" y="9"/></a:lnTo>');
  assert.deepEqual(on, [['M', 5, 5], ['L', 9, 5], ['Z'], ['M', 5, 5], ['L', 5, 9]]);
});

const style = (over: Partial<RunStyle> = {}): RunStyle => ({ font: 'Calibri', size: 20, bold: false, italic: false, underline: false, strike: false, color: { r: 0, g: 0, b: 0, a: 1 }, baseline: 0, caps: 'none', spacing: 0, highlight: null, link: null, ...over });
const paragraph = (text: string, over: Partial<Paragraph> = {}): Paragraph => ({ level: 0, align: 'l', marL: 0, indent: 0, lineSpacing: {}, spaceBefore: {}, spaceAfter: {}, bullet: null, runs: [{ kind: 'text', text, style: style(), element: null }], end: style(), defTab: 914400, tabs: [], element: null, ...over });

test('text breaks into lines at spaces, and a long word between characters', () => {
  // 20 pt = 26.67 px; the rough measure gives each character half that.
  const laid = layoutText([paragraph('aaaa bbbb cccc')], { width: 13.33 * 10, measure: ROUGH_MEASURE });
  assert.deepEqual(laid.lines.map((l) => [l.start, l.end]), [[0, 10], [10, 14]]);
  const long = layoutText([paragraph('abcdefghijklmnop')], { width: 13.33 * 5, measure: ROUGH_MEASURE });
  assert.ok(long.lines.length >= 3);
  const centred = layoutText([paragraph('ab', { align: 'ctr' })], { width: 200, measure: ROUGH_MEASURE });
  assert.ok(Math.abs(centred.lines[0].left - (200 - 26.67) / 2) < 0.5);
});

test('numbered paragraphs count along their level and start again after a shallower one', () => {
  const auto = { kind: 'auto' as const, char: '', scheme: 'arabicPeriod', startAt: 1, font: null, color: null, size: { pct: 1 } };
  const texts = bulletTexts([paragraph('a', { bullet: auto }), paragraph('b', { bullet: auto }), paragraph('c', { bullet: auto, level: 1 }), paragraph('d', { bullet: auto })]);
  assert.deepEqual(texts, ['1.', '2.', '1.', '3.']);
  assert.equal(autoNumber('romanUcPeriod', 4), 'IV.');
  assert.equal(autoNumber('alphaLcParenR', 28), 'ab)');
});

const body = (...lines: string[]) =>
  el('p:txBody', {}, [el('a:bodyPr'), el('a:lstStyle'), ...lines.map((l) => el('a:p', {}, [el('a:r', {}, [el('a:rPr', { lang: 'en-US', b: '1' }), el('a:t', {}, [l])]), el('a:endParaRPr', { lang: 'en-US' })]))]);

test('typing joins the run before the caret and keeps its look', () => {
  const b = body('Hello');
  insertText(paragraphsOf(b)[0], 5, ' world');
  const p = paragraphsOf(b)[0];
  assert.equal(plainText(p), 'Hello world');
  assert.equal(kids(p, 'a:r').length, 1);
  assert.equal(kid(kids(p, 'a:r')[0], 'a:rPr')?.attrs.b, '1');
});

test('Enter splits a paragraph, Backspace across paragraphs joins them', () => {
  const b = body('one two');
  const at2 = splitParagraph(b, { p: 0, o: 3 });
  assert.deepEqual(at2, { p: 1, o: 0 });
  assert.deepEqual(paragraphsOf(b).map(plainText), ['one', ' two']);
  deleteRange(b, { p: 0, o: 3 }, { p: 1, o: 1 });
  assert.deepEqual(paragraphsOf(b).map(plainText), ['onetwo']);
  const end = insertMultiline(b, { p: 0, o: 3 }, ' A\nB ');
  assert.deepEqual(paragraphsOf(b).map(plainText), ['one A', 'B two']);
  assert.deepEqual(end, { p: 1, o: 2 });
  assert.equal(textBetween(b, { p: 0, o: 4 }, { p: 1, o: 1 }), 'A\nB');
});

test('formatting part of a run splits it exactly', () => {
  const b = body('abcdef');
  const runs = runsIn(b, { p: 0, o: 2 }, { p: 0, o: 4 });
  assert.deepEqual(runs.map((r) => paragraphText({ name: 'a:p', attrs: {}, children: [r] })), ['cd']);
  assert.deepEqual(kids(paragraphsOf(b)[0], 'a:r').map((r) => paragraphText({ name: 'a:p', attrs: {}, children: [r] })), ['ab', 'cd', 'ef']);
  assert.deepEqual(wordAt('hello world', 7), [6, 11]);
});

test('slides added, copied, moved, hidden and deleted, and undone', async () => {
  const deck = await Deck.read(await blankDeck());
  const history = new History();
  const layouts = deck.layoutsOf(deck.masters[0]);
  let tx = new Transaction(deck, 'add');
  await addSlide(deck, layouts[1], 1, tx);
  history.commit(tx);
  assert.equal(deck.slides.length, 2);
  assert.equal(deck.slides[1].layout, layouts[1]);
  // The new slide has the layout's title and content placeholders, empty.
  assert.equal(kids(treeOf(deck.slides[1]), 'p:sp').length, 2);
  tx = new Transaction(deck, 'copy');
  await duplicateSlide(deck, deck.slides[1], tx);
  history.commit(tx);
  assert.equal(deck.slides.length, 3);
  tx = new Transaction(deck, 'move');
  const last = deck.slides[2];
  await moveSlides(deck, [last], 0, tx);
  history.commit(tx);
  assert.equal(deck.slides[0], last);
  tx = new Transaction(deck, 'hide');
  setHidden(deck.slides[0], true, tx);
  history.commit(tx);
  assert.ok(isHidden(deck.slides[0]));
  tx = new Transaction(deck, 'delete');
  await deleteSlides(deck, [deck.slides[0]], tx);
  history.commit(tx);
  assert.equal(deck.slides.length, 2);
  // Undo all the way back.
  while (history.canUndo) {
    history.undo(deck);
    await deck.loadSlides();
  }
  assert.equal(deck.slides.length, 1);
  history.redo(deck);
  await deck.loadSlides();
  assert.equal(deck.slides.length, 2);
  // Written and read again: the slides are there, and the deleted ones' parts are not.
  const again = await Deck.read(await deck.write());
  assert.equal(again.slides.length, 2);
});

test('shapes moved, ordered and deleted; notes written', async () => {
  const deck = await Deck.read(await blankDeck());
  const slide = deck.slides[0];
  const tx = new Transaction(deck, 'edit');
  tx.touch(slide);
  const tree = treeOf(slide);
  const box = newShape(tree, 'ellipse', { x: 100, y: 200, w: 300, h: 400, rot: 0, flipH: false, flipV: false }, 'Oval');
  tree.children.push(box);
  setFrame(box, { x: 1000, y: 2000, w: 3000, h: 4000, rot: 45, flipH: true, flipV: false });
  const xfrm = at(box, 'p:spPr/a:xfrm')!;
  assert.equal(xfrm.attrs.rot, '2700000');
  assert.equal(xfrm.attrs.flipH, '1');
  assert.equal(kid(xfrm, 'a:off')?.attrs.x, '1000');
  reorder(slide, [box], 'back', tx);
  const shapes = kids(tree).filter((e) => e.name === 'p:sp');
  assert.equal(shapes[0], box);
  deleteShapes(slide, [box], tx);
  assert.ok(!kids(tree).includes(box));
  assert.ok(await setNotes(deck, slide, 'Say hello\nthen go', tx));
  assert.equal(deck.notesText(slide), 'Say hello\nthen go');
  const again = await Deck.read(await deck.write());
  assert.equal(again.notesText(again.slides[0]), 'Say hello\nthen go');
});

test('a slide scene draws its background, shapes and text', async () => {
  const deck = await Deck.read(await blankDeck());
  const slide = deck.slides[0];
  const tx = new Transaction(deck, 'edit');
  tx.touch(slide);
  const title = kids(treeOf(slide), 'p:sp')[0];
  insertText(paragraphsOf(kid(title, 'p:txBody')!)[0], 0, 'Quarterly review');
  const { scene: s, views } = scene(deck);
  assert.equal(s.width, 12192000 / 9525);
  const view = views.find((v) => v.shape.element === title)!;
  assert.equal(view.text?.prompt, false);
  assert.equal(view.text?.laid.lines.length, 1);
  const texts = JSON.stringify(s.children);
  // Drawn a piece (a word and its space) at a time.
  assert.ok(texts.includes('"Quarterly "') && texts.includes('"review"'));
  // As a PDF, a page per scene.
  const pdf = await scenesToPdf([s, s], 'Deck');
  assert.equal(PdfDocument.load(pdf).pageCount, 2);
});

test('a deck as an outline, and an outline as a deck', async () => {
  const markdown = '# Plan\n\n- First\n  - Detail\n- Second\n\n# Next steps\n\nShip it';
  assert.deepEqual(
    outlineSlides(markdown).map((s) => [s.title, s.lines.map((l) => `${l.level}${l.bullet ? '-' : ''}${l.text}`)]),
    [
      ['Plan', ['0-First', '1-Detail', '0-Second']],
      ['Next steps', ['0Ship it']],
    ],
  );
  const deck = await Deck.read(await deckFromMarkdown(markdown));
  assert.equal(deck.slides.length, 2);
  const md = deckMarkdown(deck);
  assert.match(md, /^# Plan/);
  assert.match(md, /- First\n {2}- Detail\n- Second/);
  assert.match(md, /# Next steps\n\nShip it/);
});

test('click animations: shapes come in click by click', () => {
  const slide = parseXml(`<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:timing><p:tnLst><p:par><p:cTn id="1" nodeType="tmRoot"><p:childTnLst><p:seq><p:cTn id="2" nodeType="mainSeq"><p:childTnLst>
    <p:par><p:cTn id="3"><p:childTnLst><p:par><p:cTn id="4" presetClass="entr" nodeType="clickEffect"><p:childTnLst><p:set><p:cBhvr><p:tgtEl><p:spTgt spid="5"/></p:tgtEl></p:cBhvr></p:set></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>
    <p:par><p:cTn id="6"><p:childTnLst><p:par><p:cTn id="7" presetClass="exit" nodeType="clickEffect"><p:childTnLst><p:set><p:cBhvr><p:tgtEl><p:spTgt spid="5"/></p:tgtEl></p:cBhvr></p:set></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>
  </p:childTnLst></p:cTn></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing></p:sld>`);
  const builds = readBuilds(slide);
  assert.equal(builds.steps.length, 2);
  assert.deepEqual([...hiddenAt(builds, 0)], ['5']);
  assert.deepEqual([...hiddenAt(builds, 1)], []);
  assert.deepEqual([...hiddenAt(builds, 2)], ['5']);
  void serializeXml;
});

test('a highlight goes in its place among run properties, and replaces the one before', () => {
  const rPr = parseXml('<a:rPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:solidFill/><a:latin typeface="Arial"/><a:hlinkClick/></a:rPr>');
  setHighlight(rPr, { r: 255, g: 255, b: 0, a: 1 });
  setHighlight(rPr, { r: 0, g: 255, b: 0, a: 1 });
  assert.deepEqual(kids(rPr).map((c) => c.name), ['a:solidFill', 'a:highlight', 'a:latin', 'a:hlinkClick']);
  assert.equal(at(rPr, 'a:highlight/a:srgbClr')?.attrs.val, '00FF00');
  setHighlight(rPr, null);
  assert.deepEqual(kids(rPr).map((c) => c.name), ['a:solidFill', 'a:latin', 'a:hlinkClick']);
});

test('a table frame takes no fill or outline, and a group no outline', async () => {
  const deck = await Deck.read(await blankDeck());
  const table = newTable(treeOf(deck.slides[0]), 2, 2, { x: 0, y: 0, w: 1000, h: 0, rot: 0, flipH: false, flipV: false }, 'Table');
  const before = serializeXml(table);
  setFill(table, { r: 255, g: 0, b: 0, a: 1 });
  setLine(table, { r: 255, g: 0, b: 0, a: 1 }, 12700);
  assert.equal(serializeXml(table), before);
  const group = el('p:grpSp', {}, [el('p:grpSpPr')]);
  setLine(group, { r: 255, g: 0, b: 0, a: 1 }, 12700);
  assert.equal(kids(kid(group, 'p:grpSpPr')).length, 0);
});
