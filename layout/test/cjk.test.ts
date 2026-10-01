import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WordDocument, type Paragraph, type Run } from '@golemdocs/docx';
import { FontSet, isCjk, langOfFontName, langOfTag, layoutDocument, LayoutSession, noLineEnd, noLineStart, type PageLayout } from '../src/index.ts';

// A synthetic manifest: a Latin family and CJK pages with a few glyphs each, so nothing here needs the real atlases.

const bounds = { left: 0, top: 0, right: 1, bottom: 1 };
const glyph = (unicode: number, advance: number) => ({ unicode, advance, planeBounds: bounds, atlasBounds: bounds });
const chars = (s: string) => [...s].map((c) => c.codePointAt(0)!);

const metrics = (ascent: number, descent: number) => ({
  unitsPerEm: 1000,
  hhea: { ascender: ascent, descender: -descent, lineGap: 0 },
  typo: { ascender: ascent, descender: -descent, lineGap: 0, useTypoMetrics: false },
  win: { ascent, descent },
  xHeight: 500,
  capHeight: 700,
  underline: { position: -100, thickness: 50 },
  strikeout: { position: 300, size: 50 },
  subscript: { xSize: 0, ySize: 0, xOffset: 0, yOffset: 0 },
  superscript: { xSize: 0, ySize: 0, xOffset: 0, yOffset: 0 },
});

const layoutJson = (glyphs: ReturnType<typeof glyph>[]) => ({
  atlas: { type: 'msdf', distanceRange: 4, size: 32, width: 64, height: 64, yOrigin: 'bottom' },
  metrics: { emSize: 32, lineHeight: 1, ascender: 1, descender: -0.25, underlineY: -0.1, underlineThickness: 0.05 },
  glyphs,
});

const LATIN = [glyph(0x20, 0.5), ...chars('abcABC').map((c) => glyph(c, 0.5))];
const SHARED = '、。「」あ（'; // punctuation and kana on the first page of both languages

interface PageSpec {
  id: string;
  lang: 'ja' | 'zh-Hans' | 'zh-Hant' | 'ko';
  order: number;
  text: string;
  advance: number;
}
const PAGES: PageSpec[] = [
  { id: 'noto-sans-jp-1', lang: 'ja', order: 0, text: '日本語' + SHARED, advance: 1 },
  { id: 'noto-sans-jp-2', lang: 'ja', order: 1, text: '字', advance: 1 },
  { id: 'noto-sans-jp-3', lang: 'ja', order: 2, text: '猫', advance: 1 },
  { id: 'noto-sans-sc-1', lang: 'zh-Hans', order: 0, text: '日本語' + SHARED, advance: 1.3 },
  { id: 'noto-sans-sc-2', lang: 'zh-Hans', order: 1, text: '汉', advance: 1.3 },
  { id: 'noto-sans-tc-1', lang: 'zh-Hant', order: 0, text: '日本語' + SHARED, advance: 1.1 },
  { id: 'noto-sans-tc-2', lang: 'zh-Hant', order: 1, text: '漢', advance: 1.1 },
  { id: 'noto-sans-kr-1', lang: 'ko', order: 0, text: '한글가나다' + '日本語' + SHARED, advance: 1.2 },
];

function makeFonts() {
  const files: Record<string, unknown> = {};
  const loaded: string[] = [];
  const family = (id: string, wordName: string, glyphs: ReturnType<typeof glyph>[], m: ReturnType<typeof metrics>, page?: object) => {
    files[`${id}/layout.json`] = layoutJson(glyphs);
    return {
      id,
      wordName,
      substitute: id,
      license: '',
      licenseFile: '',
      aliases: {},
      faces: [{ weight: 400, italic: false, atlas: `${id}/atlas.png`, layout: `${id}/layout.json`, metrics: m }],
      ...(page && { page }),
    };
  };
  const families = [
    family('calibri', 'Calibri', LATIN, metrics(750, 250)),
    ...PAGES.map((page) => {
      files[`${page.id}/coverage.json`] = chars(page.text).sort((a, b) => a - b).flatMap((c) => [c, c]);
      return family(page.id, page.id, chars(page.text).map((c) => glyph(c, page.advance)), metrics(1160, 288), {
        group: page.lang,
        order: page.order,
        coverage: `${page.id}/coverage.json`,
      });
    }),
  ];
  files['manifest.json'] = { atlas: { type: 'msdf', size: 32, pxrange: 4, yOrigin: 'bottom', generator: 'test' }, families };
  return FontSet.load(async (path) => {
    if (path.endsWith('layout.json')) loaded.push(path.split('/')[0]);
    if (!(path in files)) throw new Error(`no file ${path}`);
    return files[path];
  }).then((fonts) => ({ fonts, loaded }));
}

const run = (text: string, properties: Run['properties'] = {}): Run => ({ kind: 'run', properties: { size: 20, ...properties }, content: [{ kind: 'text', text }], attrs: {} });
/** A paragraph 5 ems (50 pt at 10 pt) wide: 468 pt of text width less the right indent. */
const narrow = (children: Paragraph['children']): Paragraph => ({
  kind: 'paragraph',
  properties: { indent: { right: (468 - 50) * 20 }, spacing: { line: 240, lineRule: 'auto', before: 0, after: 0 } },
  children,
  attrs: {},
});

async function layout(paragraph: Paragraph, fonts: FontSet, lang?: 'ja' | 'zh-Hans' | 'zh-Hant' | 'ko') {
  if (lang) fonts.defaultCjkLang = lang;
  const doc = await WordDocument.create();
  doc.body = [paragraph];
  const result = await layoutDocument(doc, fonts);
  const page = result.pages[0];
  const text = (paragraph.children[0] as Run).content.map((c) => (c.kind === 'text' ? c.text : '')).join('');
  return { page, lines: page.lines.map((l) => ({ ...l, text: text.slice(l.start, l.end) })) };
}
const keys = (page: PageLayout) => [...page.glyphs.keys()];

test('character classes', () => {
  assert.ok(isCjk(0x65e5) && isCjk(0x3042) && isCjk(0x3002) && isCjk(0xff08) && isCjk(0x3105));
  assert.ok(!isCjk(0x61) && !isCjk(0x201c) && !isCjk(0xe9));
  assert.ok(noLineStart(0x3002) && noLineStart(0x300d) && noLineStart(0x3063) && !noLineStart(0x65e5));
  assert.ok(noLineEnd(0x300c) && noLineEnd(0xff08) && !noLineEnd(0x300d));
});

test('language from a font name or a language tag', () => {
  for (const name of ['MS Mincho', 'MS Gothic', 'MS PGothic', 'Yu Gothic', 'Meiryo', 'Hiragino Kaku Gothic Pro', 'MS UI Gothic']) assert.equal(langOfFontName(name), 'ja', name);
  for (const name of ['PMingLiU', 'MingLiU', 'Microsoft JhengHei', 'DFKai-SB', 'Noto Sans CJK TC']) assert.equal(langOfFontName(name), 'zh-Hant', name);
  for (const name of ['SimSun', 'NSimSun', 'SimHei', 'KaiTi', 'FangSong', 'Microsoft YaHei', 'DengXian', 'PingFang SC', 'Noto Sans SC', '宋体', '微软雅黑']) assert.equal(langOfFontName(name), 'zh-Hans', name);
  assert.equal(langOfFontName('Calibri'), undefined);
  assert.equal(langOfTag('ja-JP'), 'ja');
  for (const tag of ['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant-TW']) assert.equal(langOfTag(tag), 'zh-Hant', tag);
  for (const tag of ['zh', 'zh-CN', 'zh-SG', 'zh-Hans', 'zh-Hans-CN']) assert.equal(langOfTag(tag), 'zh-Hans', tag);
  assert.equal(langOfTag('en-US'), undefined);
});

test('CJK characters draw from the language page and advance by its glyphs', async () => {
  const { fonts } = await makeFonts();
  const { page, lines } = await layout(narrow([run('日本')]), fonts);
  assert.equal(page.glyphCount, 2);
  assert.deepEqual(keys(page).map((k) => k.split('/')[0]), ['noto-sans-jp-1']);
  const stops = lines[0].stops;
  assert.ok(Math.abs(stops[1] - stops[0] - 10) < 0.01 && Math.abs(stops[2] - stops[1] - 10) < 0.01, 'advance is 1em');
});

test('fallback pages have distinct keys and Latin text never uses them', async () => {
  const { fonts } = await makeFonts();
  const { page } = await layout(narrow([run('abc日字')]), fonts);
  const ks = keys(page);
  assert.equal(new Set(ks).size, ks.length);
  assert.ok(ks.some((k) => k.startsWith('calibri')) && ks.some((k) => k.startsWith('noto-sans-jp-1')) && ks.some((k) => k.startsWith('noto-sans-jp-2')));
  const latin = await layout(narrow([run('abc')]), fonts);
  assert.deepEqual(keys(latin.page).map((k) => k.split('/')[0]), ['calibri']);
});

test('wraps between ideographs', async () => {
  const { fonts } = await makeFonts();
  const { lines } = await layout(narrow([run('日本語日本語日本語日本語')]), fonts);
  assert.deepEqual(lines.map((l) => l.text), ['日本語日本', '語日本語日', '本語']);
});

test('no line starts with closing punctuation or ends with an opening bracket', async () => {
  const { fonts } = await makeFonts();
  // 。 would start the second line: 本 comes down with it.
  let r = await layout(narrow([run('日本語日本。語日本語')]), fonts);
  assert.equal(r.lines[0].text, '日本語日');
  assert.ok(r.lines[1].text.startsWith('本。'));
  // 「 would end the first line: it goes down to its text.
  r = await layout(narrow([run('日本語日「本語日本')]), fonts);
  assert.equal(r.lines[0].text, '日本語日');
  assert.ok(r.lines[1].text.startsWith('「'));
  // Whatever the text, the rules hold on every line.
  r = await layout(narrow([run('日本、日本。日「本」日（本）語。、日「本」語語、。日')]), fonts);
  for (const l of r.lines) {
    assert.ok(!'、。」）'.includes(l.text[0]), `line starts with ${l.text[0]}`);
    assert.ok(!'「（'.includes(l.text[l.text.length - 1]), `line ends with ${l.text.at(-1)}`);
  }
});

test('a line may break at a Latin to CJK boundary', async () => {
  const { fonts } = await makeFonts();
  const { lines } = await layout(narrow([run('日abcabcabcabc')]), fonts);
  assert.equal(lines[0].text, '日', 'the Latin word moves down whole');
});

test('language: East Asian font, run language, then the default', async () => {
  const { fonts } = await makeFonts();
  const page = async (properties: Run['properties'], lang?: 'ja' | 'zh-Hans' | 'zh-Hant' | 'ko') => keys((await layout(narrow([run('日', properties)]), fonts, lang)).page)[0].split('/')[0];
  assert.equal(await page({ fonts: { eastAsia: 'MS Mincho' } }, 'zh-Hant'), 'noto-sans-jp-1');
  assert.equal(await page({ fonts: { eastAsia: 'PMingLiU' } }, 'ja'), 'noto-sans-tc-1');
  assert.equal(await page({ lang: { eastAsia: 'zh-TW' } }, 'ja'), 'noto-sans-tc-1');
  assert.equal(await page({ lang: { eastAsia: 'ja-JP' } }, 'zh-Hant'), 'noto-sans-jp-1');
  assert.equal(await page({ fonts: { eastAsia: 'SimSun' } }, 'zh-Hant'), 'noto-sans-sc-1');
  assert.equal(await page({ lang: { eastAsia: 'zh-CN' } }, 'ja'), 'noto-sans-sc-1');
  assert.equal(await page({}, 'zh-Hans'), 'noto-sans-sc-1');
  assert.equal(await page({}, 'zh-Hant'), 'noto-sans-tc-1');
  assert.equal(await page({}, 'ja'), 'noto-sans-jp-1');
  // Same glyph, different language, different advance.
  const tc = await layout(narrow([run('日')]), fonts, 'zh-Hant');
  assert.ok(Math.abs(tc.lines[0].stops[1] - tc.lines[0].stops[0] - 11) < 0.01);
});

test('a Chinese form falls back to the other for characters its pages lack', async () => {
  const { fonts, loaded } = await makeFonts();
  const hans = await layout(narrow([run('汉漢', { lang: { eastAsia: 'zh-CN' } })]), fonts);
  assert.deepEqual(keys(hans.page).map((k) => k.split('/')[0]).sort(), ['noto-sans-sc-2', 'noto-sans-tc-2']);
  assert.ok(!loaded.includes('noto-sans-jp-1'));
  const hant = await layout(narrow([run('汉漢', { lang: { eastAsia: 'zh-TW' } })]), fonts);
  assert.deepEqual(keys(hant.page).map((k) => k.split('/')[0]).sort(), ['noto-sans-sc-2', 'noto-sans-tc-2']);
});

test('only pages whose coverage intersects the text are loaded', async () => {
  const { fonts, loaded } = await makeFonts();
  await layout(narrow([run('日字')]), fonts, 'ja');
  assert.ok(loaded.includes('noto-sans-jp-1') && loaded.includes('noto-sans-jp-2'));
  assert.ok(!loaded.includes('noto-sans-jp-3'), 'no character on page 3');
  assert.ok(!loaded.some((id) => id.includes('-tc-')), 'the other language stays unloaded');
  // Text typed later loads its page first (see LayoutSession.ensurePages).
  const doc = await WordDocument.create();
  const session = await LayoutSession.create(doc, fonts);
  await session.ensurePages('猫');
  assert.ok(loaded.includes('noto-sans-jp-3'));
  await session.ensurePages('abc');
  assert.equal(loaded.filter((id) => id === 'noto-sans-jp-3').length, 1);
});

test('a character in no page keeps a space advance', async () => {
  const { fonts } = await makeFonts();
  const { lines, page } = await layout(narrow([run('日ん日')]), fonts);
  assert.equal(page.glyphCount, 2);
  const s = lines[0].stops;
  assert.ok(Math.abs(s[2] - s[1] - 5) < 0.01, `missing glyph advances like a space, got ${s[2] - s[1]}`);
});

test('line height follows the CJK face', async () => {
  const { fonts } = await makeFonts();
  const latin = await layout(narrow([run('abc')]), fonts);
  const cjk = await layout(narrow([run('abc日')]), fonts);
  assert.ok(Math.abs(latin.lines[0].height - 10) < 0.01, `${latin.lines[0].height}`);
  assert.ok(Math.abs(cjk.lines[0].height - 14.48) < 0.01, `${cjk.lines[0].height}`);
});

test('regular and bold text in one face with no bold stay distinct fonts', async () => {
  const { fonts } = await makeFonts();
  const { page } = await layout(narrow([run('日'), run('本', { bold: true })]), fonts);
  const pageKeys = keys(page).filter((k) => k.startsWith('noto-sans-jp-1'));
  assert.equal(pageKeys.length, 2, 'the bold and the regular glyph have their own font');
  assert.ok(pageKeys.some((k) => k.includes('+bold')) && pageKeys.some((k) => !k.includes('+bold')));
});

test('Hangul is CJK text, and language selection knows Korean', async () => {
  for (const c of [0xac00, 0xd7a3, 0x1100, 0x3131, 0xa960, 0xd7b0, 0xffa1]) assert.ok(isCjk(c), c.toString(16));
  for (const name of ['Malgun Gothic', 'Batang', 'BatangChe', 'Gulim', 'GulimChe', 'Dotum', 'DotumChe', 'Gungsuh', 'GungsuhChe', 'NanumGothic', 'Nanum Myeongjo', 'Apple SD Gothic Neo', 'Noto Sans KR', 'Noto Sans CJK KR']) assert.equal(langOfFontName(name), 'ko', name);
  for (const tag of ['ko', 'ko-KR', 'KO-kr']) assert.equal(langOfTag(tag), 'ko', tag);
  const { fonts } = await makeFonts();
  const page = async (properties: Run['properties'], lang?: 'ja' | 'zh-Hans' | 'zh-Hant' | 'ko') => keys((await layout(narrow([run('한', properties)]), fonts, lang)).page)[0].split('/')[0];
  assert.equal(await page({ fonts: { eastAsia: 'Malgun Gothic' } }, 'ja'), 'noto-sans-kr-1');
  assert.equal(await page({ lang: { eastAsia: 'ko-KR' } }, 'zh-Hant'), 'noto-sans-kr-1');
  assert.equal(await page({}, 'ko'), 'noto-sans-kr-1');
  const ko = await layout(narrow([run('한')]), fonts, 'ko');
  assert.ok(Math.abs(ko.lines[0].stops[1] - ko.lines[0].stops[0] - 12) < 0.01);
});

test('Korean breaks at spaces, not between syllables; hanja still break', async () => {
  const { fonts } = await makeFonts();
  // 5 ems per line at 1.2em per syllable: 4 syllables fit.
  let r = await layout(narrow([run('한글가나 다한글가')]), fonts, 'ko');
  assert.deepEqual(r.lines.map((l) => l.text), ['한글가나 ', '다한글가'], 'words stay whole');
  r = await layout(narrow([run('한글가 나다한 글가나다')]), fonts, 'ko');
  assert.ok(r.lines.length > 1);
  assert.equal(r.lines[0].text, '한글가 ', 'breaks after the space');
  r = await layout(narrow([run('日本語日本語日本語日本語')]), fonts, 'ko');
  assert.ok(r.lines.length > 1, 'hanja break freely');
  // No break between Hangul and Latin.
  r = await layout(narrow([run('한abc')]), fonts, 'ko');
  assert.equal(r.lines.length, 1);
  r = await layout(narrow([run('한글가abcd')]), fonts, 'ko');
  assert.ok(r.lines[0].text.startsWith('한글가a'), 'no break between Hangul and Latin');
});
