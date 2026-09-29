// CJK word boundaries and grapheme clusters for caret movement (src/segment.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cjkWords, graphemeAt, hasCjk, hasCombining, isWordBoundary, segmentAt, type Segment } from '../src/segment.ts';

test('hasCjk recognises Han, kana, Hangul and Bopomofo but not Latin', () => {
  for (const s of ['漢', 'ひらがな', 'カタカナ', 'ｶﾀ', '한글', 'ㄅ', 'a漢b', '𠀀']) assert.equal(hasCjk(s), true, s);
  for (const s of ['', 'hello', 'Ünïcödé', '12 34', 'Привет', 'العربية']) assert.equal(hasCjk(s), false, s);
});

test('hasCombining recognises marks, joiners, skin tones, flags and jamo', () => {
  for (const s of ['é', 'a‍b', '👍🏽', '🇫🇷', '가', 'क्']) assert.equal(hasCombining(s), true, JSON.stringify(s));
  for (const s of ['', 'abc', 'é' /* precomposed */, '漢字', '😀']) assert.equal(hasCombining(s), false, JSON.stringify(s));
});

test('text with no CJK gets no word segments (callers keep their plain rules)', () => {
  assert.equal(cjkWords('just latin words'), null);
  assert.equal(cjkWords(''), null);
});

test('CJK text is cut into consecutive segments that cover it exactly', () => {
  for (const text of ['今日は天気がいいです。', 'hello 世界 world', '한국어 문장입니다', 'ＡＢＣ漢字123']) {
    const segments = cjkWords(text)!;
    assert.equal(segments[0]!.start, 0);
    assert.equal(segments.at(-1)!.end, text.length);
    for (let i = 1; i < segments.length; i++) assert.equal(segments[i]!.start, segments[i - 1]!.end, `${text} @ ${i}`);
    assert.ok(segments.every((s) => s.end > s.start));
  }
});

test('mixed text separates words from spaces and punctuation', () => {
  const text = 'hello 世界, ok';
  const segments = cjkWords(text)!;
  const flags = segments.map((s) => [text.slice(s.start, s.end), s.word]);
  const spaces = flags.filter(([t]) => t === ' ');
  assert.ok(spaces.length >= 2 && spaces.every(([, w]) => w === false));
  assert.deepEqual(flags.find(([t]) => t === 'hello'), ['hello', true]);
  assert.ok(flags.some(([t, w]) => w === false && t === ','));
});

test('results are cached per text: the same array comes back', () => {
  const a = cjkWords('キャッシュ確認');
  assert.equal(cjkWords('キャッシュ確認'), a);
  for (let i = 0; i < 40; i++) cjkWords(`漢${i}`); // pushes past the cache size (32)
  assert.notEqual(cjkWords('キャッシュ確認'), a, 'evicted, so recomputed');
  assert.deepEqual(cjkWords('キャッシュ確認'), a, '... to an equal result');
});

const S = (start: number, end: number, word = true): Segment => ({ start, end, word });

test('segmentAt finds the segment holding an offset, none at or past the end', () => {
  const segs = [S(0, 2), S(2, 3, false), S(3, 7)];
  assert.equal(segmentAt(segs, 0), segs[0]);
  assert.equal(segmentAt(segs, 1), segs[0]);
  assert.equal(segmentAt(segs, 2), segs[1]);
  assert.equal(segmentAt(segs, 6), segs[2]);
  assert.equal(segmentAt(segs, 7), undefined);
  assert.equal(segmentAt(segs, -1), undefined);
  assert.equal(segmentAt([], 0), undefined);
});

test('isWordBoundary is true at segment starts, the end, and outside; false inside a segment', () => {
  const segs = [S(0, 3), S(3, 5)];
  assert.equal(isWordBoundary(segs, 0), true);
  assert.equal(isWordBoundary(segs, 1), false);
  assert.equal(isWordBoundary(segs, 2), false);
  assert.equal(isWordBoundary(segs, 3), true);
  assert.equal(isWordBoundary(segs, 4), false);
  assert.equal(isWordBoundary(segs, 5), true, 'the end of the text');
  assert.equal(isWordBoundary([], 0), true);
});

test('graphemeAt: combining sequences are one unit, in UTF-16 offsets', () => {
  const t = 'aéb'; // a, e + acute, b
  assert.deepEqual(graphemeAt(t, 1), [1, 3]);
  assert.deepEqual(graphemeAt(t, 2), [1, 3], 'inside the cluster: the whole cluster');
  assert.deepEqual(graphemeAt(t, 0), [0, 1]);
  assert.deepEqual(graphemeAt(t, 3), [3, 4]);
  const family = '👨‍👩‍👧x'; // man ZWJ woman ZWJ girl
  assert.deepEqual(graphemeAt(family, 0), [0, family.length - 1]);
  assert.deepEqual(graphemeAt('🇫🇷🇩🇪', 0), [0, 4], 'a flag is a pair of regional indicators');
  assert.deepEqual(graphemeAt('🇫🇷🇩🇪', 4), [4, 8]);
  assert.deepEqual(graphemeAt('👍🏽!', 0), [0, 4], 'skin tone modifier joins its base');
});

test('graphemeAt: text with nothing combinable is left to the caller', () => {
  assert.equal(graphemeAt('plain text', 3), null);
  assert.equal(graphemeAt('', 0), null);
  assert.equal(graphemeAt('漢字', 0), null);
  assert.equal(graphemeAt('😀😀', 0), null, 'a code point pair is stepped by the caller');
});

test('graphemeAt: an offset past the end has no cluster', () => {
  assert.equal(graphemeAt('é', 5), null);
});

// Without Intl.Segmenter (older engines) words fall back to runs of one script class, and graphemes to the caller.
test('without Intl.Segmenter: words are runs of one script class', async () => {
  const intl = Intl as unknown as { Segmenter?: unknown };
  const real = intl.Segmenter;
  delete intl.Segmenter;
  try {
    // A query string makes a fresh copy of the module, which reads Intl.Segmenter again; a variable keeps tsc from resolving it.
    const url = '../src/segment.ts?no-segmenter';
    const fresh = (await import(url)) as typeof import('../src/segment.ts');
    const cut = (text: string) => fresh.cjkWords(text)!.map((s) => [text.slice(s.start, s.end), s.word]);
    assert.deepEqual(cut('漢字かな'), [['漢字', true], ['かな', true]], 'Han then hiragana');
    assert.deepEqual(cut('カタカナひらがな'), [['カタカナ', true], ['ひらがな', true]]);
    assert.deepEqual(cut('한국어 漢字'), [['한국어', true], [' ', false], ['漢字', true]]);
    assert.deepEqual(cut('漢, 字'), [['漢', true], [',', false], [' ', false], ['字', true]], 'punctuation stands alone, spaces are not words');
    assert.deepEqual(cut('漢abc12'), [['漢', true], ['abc', true], ['12', true]]);
    assert.deepEqual(cut("漢don't"), [['漢', true], ["don't", true]], 'apostrophes stay inside a latin word');
    assert.deepEqual(cut('漢éx'), [['漢', true], ['éx', true]], 'a combining mark stays with its base');
    assert.deepEqual(cut('ㄅㄆ漢'), [['ㄅㄆ', true], ['漢', true]], 'bopomofo');
    assert.deepEqual(cut('漢😀𠀀'), [['漢', true], ['😀', false], ['𠀀', true]], 'astral code points are stepped whole');
    assert.equal(fresh.graphemeAt('é', 0), null, 'no grapheme segmenter: the caller steps by code point');
  } finally {
    intl.Segmenter = real;
  }
});
