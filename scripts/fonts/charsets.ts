// Writes the CJK charsets in scripts/fonts/charsets/, one file per atlas page, from the legacy
// standards the character sets are defined by:
//
//   ja       JIS X 0208 (6,879: kana, symbols, level 1 then level 2 kanji), then JIS X 0212 (6,067)
//   zh-Hant  Big5 (13,710: symbols and Bopomofo, level 1 (5,401, by frequency) then level 2 kanji)
//   ko       KS X 1001's 2,350 common syllables first, then jamo and symbols, then every other modern
//            Hangul syllable (11,172 in all: an IME can produce any of them), then KS X 1001's 4,888 hanja
//
// Decoded with the platform's TextDecoder, so no data file is needed. A page holds at most
// PAGE_GLYPHS glyphs, which is what fits a 2048 x 2048 atlas at 32 px/em (kanji fill their cell: ~3,300 fit) (see sources.ts), and the
// most used characters come first so the first page (the only one most documents load) is the useful one.
//
//   pnpm tsx scripts/fonts/charsets.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'charsets');
export const PAGE_GLYPHS = 3200;

const isHan = (c: number) => (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff);

/** Every character a double-byte encoding defines, in code order, for the given lead and trail bytes. */
function decode(label: string, leads: [number, number], trails: [number, number][], prefix: number[] = []): number[] {
  const decoder = new TextDecoder(label);
  const found: number[] = [];
  for (let lead = leads[0]; lead <= leads[1]; lead++) {
    for (const [from, to] of trails) {
      for (let trail = from; trail <= to; trail++) {
        const text = decoder.decode(Uint8Array.from([...prefix, lead, trail]));
        const cp = text.codePointAt(0)!;
        // Big5's user-defined area decodes to the private use area: no font has those.
        if (text.length === 1 && cp !== 0xfffd && cp > 0x7f && !(cp >= 0xe000 && cp <= 0xf8ff)) found.push(cp);
      }
    }
  }
  return found;
}

const unique = (list: number[]) => [...new Set(list)];

function pages(id: string, ordered: number[]): void {
  const cps = unique(ordered);
  for (let page = 0; page * PAGE_GLYPHS < cps.length; page++) {
    const chunk = cps.slice(page * PAGE_GLYPHS, (page + 1) * PAGE_GLYPHS).sort((a, b) => a - b);
    const lines: string[] = [];
    for (let i = 0; i < chunk.length; ) {
      let j = i;
      while (j + 1 < chunk.length && chunk[j + 1] === chunk[j] + 1) j++;
      lines.push(i === j ? `0x${chunk[i].toString(16).toUpperCase()}` : `[0x${chunk[i].toString(16).toUpperCase()}, 0x${chunk[j].toString(16).toUpperCase()}]`);
      i = j + 1;
    }
    writeFileSync(path.join(OUT, `${id}-${page + 1}.txt`), `${lines.join('\n')}\n`);
    console.log(`${id}-${page + 1}: ${chunk.length} characters`);
  }
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

mkdirSync(OUT, { recursive: true });

// Japanese. The kana, punctuation and full-width forms lead: every Japanese text uses them.
const jis0208 = decode('shift_jis', [0x81, 0xef], [[0x40, 0xfc]]);
const jis0212 = decode('euc-jp', [0xa1, 0xfe], [[0xa1, 0xfe]], [0x8f]);
pages('ja', [
  ...range(0x3000, 0x30ff),
  ...range(0xff01, 0xff9f),
  ...jis0208.filter((c) => !isHan(c)),
  ...jis0208.filter(isHan),
  ...jis0212,
]);

// Traditional Chinese. Big5's symbols come first, then level 1 (lead bytes A4-C6) and level 2 (C9-F9).
const big5 = decode('big5', [0xa1, 0xf9], [[0x40, 0x7e], [0xa1, 0xfe]]);
pages('zh-Hant', [
  ...range(0x3000, 0x303f),
  ...range(0x3100, 0x312f),
  ...range(0x31a0, 0x31bf),
  ...range(0xff01, 0xff5e),
  ...big5.filter((c) => !isHan(c)),
  ...big5.filter(isHan),
]);

// Korean. The 2,350 syllables of KS X 1001 (EUC-KR rows B0-C8) are the ones in everyday use, so they lead:
// page 1 is the only page most Korean documents load. Every other modern syllable follows (an IME can
// produce any of them), then the hanja (rows CA-FD).
const ksx1001 = decode('euc-kr', [0xa1, 0xfd], [[0xa1, 0xfe]]);
const isSyllable = (c: number) => c >= 0xac00 && c <= 0xd7a3;
const common = ksx1001.filter(isSyllable);
pages('ko', [
  ...common,
  ...range(0x3130, 0x318f),
  ...range(0x3000, 0x303f),
  ...range(0xff01, 0xff5e),
  ...ksx1001.filter((c) => !isSyllable(c) && !isHan(c)),
  ...range(0xac00, 0xd7a3),
  ...ksx1001.filter(isHan),
]);
