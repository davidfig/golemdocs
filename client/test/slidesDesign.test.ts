// A deck's design (docs/slides.md, M5): backgrounds written as `p:bg`, theme colours and fonts swapped in the theme part, dark
// pages by the colour map, master and layout text styles that every slide inherits, and master view's pages drawn.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ZipArchive } from '@golemdocs/docx';
import { blankDeck } from '../src/slides/blank.ts';
import { Deck } from '../src/slides/deck.ts';
import { deckFromMarkdown } from '../src/slides/outline.ts';
import { History, Transaction } from '../src/slides/history.ts';
import { treeOf } from '../src/slides/edit.ts';
import { at, kid, kids } from '../src/slides/ooxml.ts';
import { backgroundFill, slideShapes } from '../src/slides/shapes.ts';
import { colorContext, slideScene } from '../src/slides/scene.ts';
import { ROUGH_MEASURE } from '../src/drawingml/textLayout.ts';
import { placeholderOf } from '../src/slides/shapes.ts';
import {
  COLOR_SCHEMES,
  FONT_PAIRS,
  backgroundOf,
  currentDesign,
  inheritedStyleOf,
  levelOf,
  levelRunOf,
  levelsIn,
  readOtherTheme,
  setBackground,
  setBackgroundEverywhere,
  setDarkPages,
  setThemeColors,
  setThemeFonts,
} from '../src/slides/design.ts';
import type { PagePart } from '../src/slides/deck.ts';

const viewsOf = (deck: Deck, page: PagePart) => slideScene(deck, page, { measure: ROUGH_MEASURE, family: (f) => f.family, number: 1 }).views;
const childNames = (e: { children: unknown[] } | undefined) => kids(e as never).map((c) => c.name);

/** The parts of two packages that differ (by bytes). */
async function changedParts(a: Uint8Array, b: Uint8Array): Promise<string[]> {
  const za = ZipArchive.read(a);
  const zb = ZipArchive.read(b);
  const out: string[] = [];
  for (const [name, entry] of zb.entries) {
    const before = za.entries.get(name);
    if (!before || Buffer.compare(Buffer.from(await before.read()), Buffer.from(await entry.read())) !== 0) out.push(name);
  }
  return out.sort();
}

test('a solid background goes first in the slide, is drawn, and comes off again', async () => {
  const bytes = await blankDeck();
  const deck = await Deck.read(bytes);
  const slide = deck.slides[0];
  const history = new History();
  const tx = new Transaction(deck, 'Background');
  setBackground(slide, { kind: 'solid', color: '#123456' }, tx);
  history.commit(tx);
  assert.equal(childNames(kid(slide.xml, 'p:cSld'))[0], 'p:bg');
  assert.deepEqual(backgroundOf(slide), { kind: 'solid', color: '#123456' });
  assert.deepEqual(backgroundFill(deck, slide, colorContext(deck, slide)).color, { r: 0x12, g: 0x34, b: 0x56, a: 1 });
  // Only the slide is written anew.
  assert.deepEqual(await changedParts(bytes, await deck.write()), ['ppt/slides/slide1.xml']);
  history.undo(deck);
  assert.equal(at(slide.xml, 'p:cSld/p:bg'), undefined);
  const reset = new Transaction(deck, 'Background');
  setBackground(slide, { kind: 'gradient', from: '#ff0000', to: '#0000ff', angle: 90 }, reset);
  assert.deepEqual(backgroundOf(slide), { kind: 'gradient', from: '#FF0000', to: '#0000FF', angle: 90 });
  setBackground(slide, null, reset);
  assert.equal(backgroundOf(slide), null);
});

test('a picture background relates its picture, and lets it go when replaced', async () => {
  const deck = await Deck.read(await blankDeck());
  const slide = deck.slides[0];
  const media = deck.addMedia(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'png');
  const tx = new Transaction(deck, 'Background');
  setBackground(slide, { kind: 'picture', media }, tx);
  const rId = at(slide.xml, 'p:cSld/p:bg/p:bgPr/a:blipFill/a:blip')!.attrs['r:embed'];
  assert.equal(deck.target(slide, rId), media);
  assert.equal(backgroundFill(deck, slide, colorContext(deck, slide)).kind, 'picture');
  setBackground(slide, { kind: 'solid', color: '#ffffff' }, tx);
  assert.equal(slide.rels.byId(rId), undefined);
});

test('Apply to All puts the background on the master and takes it off every slide and layout', async () => {
  const deck = await Deck.read(await deckFromMarkdown('# One\n\n# Two\n\n# Three'));
  const master = deck.masters[0];
  const tx = new Transaction(deck, 'Background');
  setBackground(deck.slides[1], { kind: 'solid', color: '#00ff00' }, tx);
  setBackground(deck.layoutsOf(master)[1], { kind: 'solid', color: '#ff00ff' }, tx);
  setBackgroundEverywhere(deck, master, { kind: 'solid', color: '#202020' }, tx);
  assert.deepEqual(backgroundOf(master), { kind: 'solid', color: '#202020' });
  for (const slide of deck.slides) {
    assert.equal(at(slide.xml, 'p:cSld/p:bg'), undefined);
    assert.deepEqual(backgroundFill(deck, slide, colorContext(deck, slide)).color, { r: 0x20, g: 0x20, b: 0x20, a: 1 });
  }
  for (const layout of deck.layoutsOf(master)) assert.equal(at(layout.xml, 'p:cSld/p:bg'), undefined);
});

test('a theme swap changes the colours and fonts every slide shows, writes only the theme, and undoes', async () => {
  const bytes = await deckFromMarkdown('# Plan\n\n- First');
  const deck = await Deck.read(bytes);
  const master = deck.masters[0];
  const theme = deck.themePart(master)!;
  const history = new History();
  const tx = new Transaction(deck, 'Theme');
  const green = COLOR_SCHEMES.find((s) => s.id === 'green')!;
  const times = FONT_PAIRS.find((f) => f.id === 'times')!;
  setThemeColors(theme, green, tx);
  setThemeFonts(theme, times, tx);
  deck.refreshThemes();
  history.commit(tx);
  assert.equal(currentDesign(master).colors.accent1, '549E39');
  assert.equal(master.theme.major.latin, 'Times New Roman');
  // Each scheme colour is a plain RGB value, in the scheme's order.
  assert.deepEqual(childNames(at(theme.xml, 'a:themeElements/a:clrScheme')).slice(0, 4), ['a:dk1', 'a:lt1', 'a:dk2', 'a:lt2']);
  const title = viewsOf(deck, deck.slides[0]).find((v) => placeholderOf(v.shape.element)?.type === 'title' || placeholderOf(v.shape.element)?.type === 'ctrTitle')!;
  assert.equal(title.text!.body.paragraphs[0].runs[0].style.font, 'Times New Roman');
  assert.deepEqual(await changedParts(bytes, await deck.write()), ['ppt/theme/theme1.xml']);
  // Read back, the deck has the new theme.
  const again = await Deck.read(await deck.write());
  assert.equal(again.masters[0].theme.minor.latin, 'Arial');
  history.undo(deck);
  deck.refreshThemes();
  assert.equal(master.theme.major.latin, 'Aptos Display');
});

test('dark pages swap the colour map, so the background and text take the dark and light colours', async () => {
  const deck = await Deck.read(await blankDeck());
  const master = deck.masters[0];
  const tx = new Transaction(deck, 'Theme');
  setDarkPages(master, true, tx);
  deck.refreshThemes();
  assert.equal(master.colorMap.bg1, 'dk1');
  assert.equal(master.colorMap.tx1, 'lt1');
  assert.equal(currentDesign(master).dark, true);
  setDarkPages(master, false, tx);
  deck.refreshThemes();
  assert.equal(master.colorMap.bg1, 'lt1');
});

test("another deck's theme is read for its colours and fonts", async () => {
  const other = await Deck.read(await blankDeck());
  const tx = new Transaction(other, 'Theme');
  setThemeColors(other.themePart(other.masters[0])!, COLOR_SCHEMES.find((s) => s.id === 'violet')!, tx);
  const found = await readOtherTheme(await other.write(), 'Other');
  assert.equal(found?.colors.colors.accent1, 'AD84C6');
  assert.equal(found?.colors.name, 'Violet');
  assert.equal(found?.fonts.major, 'Aptos Display');
});

test("a master's title style, changed through its placeholder, reaches every slide's title", async () => {
  const bytes = await deckFromMarkdown('# One\n\n- a\n\n# Two\n\n- b');
  const deck = await Deck.read(bytes);
  const master = deck.masters[0];
  const titlePh = kids(treeOf(master), 'p:sp').find((sp) => placeholderOf(sp)?.type === 'title')!;
  const list = inheritedStyleOf(master, titlePh, true)!;
  assert.equal(list.name, 'p:titleStyle');
  const tx = new Transaction(deck, 'Format');
  tx.touch(master);
  for (const level of levelsIn(kid(titlePh, 'p:txBody')!)) {
    const rPr = levelRunOf(list, level);
    rPr.attrs = { ...rPr.attrs, b: '1', sz: '5000' };
    levelOf(list, level).attrs.algn = 'r';
  }
  for (const slide of deck.slides) {
    const title = viewsOf(deck, slide).find((v) => ['title', 'ctrTitle'].includes(placeholderOf(v.shape.element)?.type ?? ''))!;
    const p = title.text!.body.paragraphs[0];
    assert.equal(p.runs[0].style.bold, true, slide.name);
    // The title slide's layout sets its own size and alignment, which win there, as in PowerPoint.
    if (slide.layout.xml.attrs.type !== 'title') {
      assert.equal(p.runs[0].style.size, 50);
      assert.equal(p.align, 'r');
    }
  }
  assert.deepEqual(await changedParts(bytes, await deck.write()), ['ppt/slideMasters/slideMaster1.xml']);
});

test("a layout placeholder's list style is made in its place, after the body settings", async () => {
  const deck = await Deck.read(await blankDeck());
  const layout = deck.layoutsOf(deck.masters[0])[1];
  const ph = kids(treeOf(layout), 'p:sp').find((sp) => placeholderOf(sp)?.type === 'title')!;
  const body = kid(ph, 'p:txBody')!;
  body.children = body.children.filter((c) => typeof c === 'string' || c.name !== 'a:lstStyle');
  const list = inheritedStyleOf(layout, ph, true)!;
  assert.equal(list.name, 'a:lstStyle');
  assert.deepEqual(childNames(body).slice(0, 2), ['a:bodyPr', 'a:lstStyle']);
  levelRunOf(list, 2);
  levelRunOf(list, 0);
  assert.deepEqual(childNames(list), ['a:lvl1pPr', 'a:lvl3pPr']);
  // A slide's own shapes pass nothing on.
  assert.equal(inheritedStyleOf(deck.slides[0], kids(treeOf(deck.slides[0]), 'p:sp')[0], true), undefined);
});

test("master view's pages: a master shows its own placeholders, a layout the master's other shapes and its own", async () => {
  const deck = await Deck.read(await blankDeck());
  const master = deck.masters[0];
  const layout = deck.layoutsOf(master)[1];
  const masterShapes = slideShapes(deck, master);
  assert.ok(masterShapes.length > 0 && masterShapes.every((s) => s.part === master));
  assert.ok(masterShapes.some((s) => s.placeholder?.type === 'title'));
  const layoutShapes = slideShapes(deck, layout);
  assert.ok(layoutShapes.some((s) => s.part === layout && s.placeholder?.type === 'title'));
  assert.ok(layoutShapes.every((s) => s.part === layout || !s.placeholder));
  // A layout placeholder inherits from the master's, so moving the master's title moves the layout's unless it has its own place.
  const scene = slideScene(deck, layout, { measure: ROUGH_MEASURE, family: (f) => f.family, number: 1, prompts: true });
  assert.ok(scene.views.length >= layoutShapes.length);
});
