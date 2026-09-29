// East Asian text: which characters need the CJK fonts, which language a run is in, and the
// line breaking rules (kinsoku) of Japanese and Chinese typography.

/** The languages we ship CJK fonts for. */
export type CjkLang = 'ja' | 'zh-Hant' | 'ko';

/** Characters drawn from the CJK fonts when the run's own font lacks them. */
export function isCjk(code: number): boolean {
  if (code < 0x1100) return false;
  return (
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x3130 && code <= 0x318f) ||
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xd7b0 && code <= 0xd7ff) ||
    (code >= 0xffa0 && code <= 0xffdc) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3000 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x3100 && code <= 0x312f) ||
    (code >= 0x31a0 && code <= 0x31bf) ||
    (code >= 0x31f0 && code <= 0x31ff)
  );
}

const SET = (chars: string) => new Set([...chars].map((c) => c.codePointAt(0)!));

/** Characters that may not start a line. */
const NO_LINE_START = SET(
  '）］｝〕〉》」』】〙〗’”、。，．・：；？！゛゜ーゝゞヽヾ々ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ…‥％‰°′″℃',
);
/** Characters that may not end a line. */
const NO_LINE_END = SET('（［｛〔〈《「『【〘〖‘“＄￥£');

export const noLineStart = (code: number): boolean => NO_LINE_START.has(code);
export const noLineEnd = (code: number): boolean => NO_LINE_END.has(code);

/** Characters set on a full-width cell, where a line may break on either side. */
function isIdeographic(code: number): boolean {
  // Everything isCjk covers, minus half-width kana and forms (which behave like Latin text) and
  // Hangul, which is broken at spaces like Latin.
  return isCjk(code) && !(code >= 0xff61 && code <= 0xff9f) && !isHangul(code);
}

/** Hangul syllables and jamo (any width). */
export function isHangul(code: number): boolean {
  return (
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x3130 && code <= 0x318f) ||
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xd7b0 && code <= 0xd7ff) ||
    (code >= 0xffa0 && code <= 0xffdc)
  );
}

/**
 * Whether a line may break between two adjacent characters because of CJK text: between any two
 * ideographic characters and at Latin/CJK boundaries, except before characters that can't start
 * a line and after ones that can't end it. (Breaks at spaces are the caller's.)
 */
export function cjkBreakBetween(before: number, after: number): boolean {
  if (!isIdeographic(before) && !isIdeographic(after)) return false;
  if (noLineStart(after) || noLineEnd(before)) return false;
  // Never split a Latin word, or put a break next to a space (spaces have their own rule).
  if (before === 0x20 || after === 0x20 || before < 0x20 || after < 0x20) return false;
  return true;
}

const JA_FONTS = /^(ms\s?p?(mincho|gothic)|ms ui gothic|yu (gothic|mincho)|meiryo|hiragino|ipa|takao|vl gothic|noto (sans|serif) (cjk )?jp|游ゴシック|游明朝|ＭＳ|メイリオ)/i;
const KO_FONTS = /^(malgun gothic|batang(che)?|gulim(che)?|dotum(che)?|gungsuh(che)?|nanum|apple sd gothic neo|noto (sans|serif) (cjk )?kr|맑은 고딕|바탕|굴림|돋움|궁서)/i;
const TC_FONTS = /^(p?mingliu|microsoft jhenghei|dfkai|noto (sans|serif) (cjk )?tc|新細明體|細明體|微軟正黑體|標楷體|pingfang tc|pingfang hk)/i;

/** The language a East Asian font name is for, when it's one we have a catalog for (Simplified Chinese isn't). */
export function langOfFontName(name: string | undefined): CjkLang | undefined {
  if (!name) return undefined;
  const n = name.trim().toLowerCase();
  if (JA_FONTS.test(n)) return 'ja';
  if (TC_FONTS.test(n)) return 'zh-Hant';
  if (KO_FONTS.test(n)) return 'ko';
  return undefined;
}

/** The catalog for a BCP 47 language tag, if we have one. */
export function langOfTag(tag: string | undefined): CjkLang | undefined {
  if (!tag) return undefined;
  const t = tag.toLowerCase();
  if (t === 'ja' || t.startsWith('ja-')) return 'ja';
  if (t === 'ko' || t.startsWith('ko-')) return 'ko';
  if (t === 'zh-tw' || t === 'zh-hk' || t === 'zh-mo' || t.startsWith('zh-hant')) return 'zh-Hant';
  return undefined;
}
