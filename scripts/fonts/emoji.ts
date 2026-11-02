// Generates the color emoji pages from Noto Color Emoji (see EMOJI in sources.ts).
//
//   pnpm fonts:emoji
//
// Output (next to the MSDF atlases, listed in the same manifest):
//   client/public/fonts/emoji-<n>/regular.webp     sprite atlas (RGBA, lossy WebP)
//   client/public/fonts/emoji-<n>/regular.json     glyph layout, as msdf-atlas-gen's JSON with atlas.type "color"
//   client/public/fonts/emoji-<n>/coverage.json    the page keys it holds (emojiPageKey), as ranges
//   client/public/fonts/emoji-<n>/LICENSE.txt
//
// Each emoji (a character, or a sequence: ZWJ, flag, keycap, skin tone) is one sprite. Sprites sit in a grid of
// cells whose size is a multiple of 8, with `padding` clear pixels around each, so the renderer can mipmap the
// atlas three levels down without neighbors bleeding in. Pages are cut by page key: an emoji's first code point,
// and its skin tone, so the sequences starting with one character and tone are always on one page.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { download } from './download.ts';
import { EMOJI } from './sources.ts';
import { readEmojiFont, type EmojiGlyph } from './ttf-emoji.ts';
import { readFontMetrics } from './ttf-metrics.ts';
import { EMOJI_GROUP, emojiPageKey } from '../../layout/src/fonts/emoji.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', '..', 'client', 'public', 'fonts');
const ATLAS_WIDTH = 2048;
const ZWJ = 0x200d;

/** The RGI ZWJ sequences (without U+FE0F), as comma-joined code points. */
function readZwjList(file: string): Set<string> {
  const out = new Set<string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const field = line.split(';')[0].trim();
    if (!field || field.startsWith('#')) continue;
    out.add(field.split(/\s+/).map((h) => parseInt(h, 16)).filter((cp) => cp !== 0xfe0f).join(','));
  }
  return out;
}

const isEmojiStart = (cp: number) => /\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}/u.test(String.fromCodePoint(cp));

/** The sequences to draw: emoji only (not the font's plain digits), and each ZWJ glyph under its RGI spelling, not its backwards one. */
function pickSequences(glyphs: EmojiGlyph[], rgi: Set<string>): EmojiGlyph[] {
  const byGlyph = new Map<number, EmojiGlyph[]>();
  for (const g of glyphs) {
    if (g.sequence.length === 1 && !isEmojiStart(g.sequence[0])) continue;
    const list = byGlyph.get(g.glyph);
    if (list) list.push(g);
    else byGlyph.set(g.glyph, [g]);
  }
  const out: EmojiGlyph[] = [];
  for (const spellings of byGlyph.values()) {
    const joined = spellings.filter((g) => g.sequence.includes(ZWJ));
    const listed = joined.filter((g) => rgi.has(g.sequence.join(',')));
    for (const g of spellings) if (!g.sequence.includes(ZWJ) || (listed.length ? listed.includes(g) : g === joined[0])) out.push(g);
  }
  return out;
}

async function main(): Promise<void> {
  console.log('Fetching emoji sources…');
  const fontPath = await download(EMOJI.font.url, EMOJI.font.sha256);
  const licensePath = await download(EMOJI.licenseFile.url, EMOJI.licenseFile.sha256);
  const zwjPath = await download(EMOJI.zwjSequences.url, EMOJI.zwjSequences.sha256);
  const fontData = readFileSync(fontPath);
  const font = readEmojiFont(fontData);
  const glyphs = pickSequences(font.glyphs, readZwjList(zwjPath));

  // Group by page key, then fill pages in key order.
  const groups = new Map<number, EmojiGlyph[]>();
  for (const g of glyphs) {
    const key = emojiPageKey(g.sequence);
    const list = groups.get(key);
    if (list) list.push(g);
    else groups.set(key, [g]);
  }
  const pages: { keys: number[]; glyphs: EmojiGlyph[] }[] = [];
  const sprites = (list: EmojiGlyph[]) => new Set(list.map((g) => g.glyph)).size;
  for (const key of [...groups.keys()].sort((a, b) => a - b)) {
    const group = groups.get(key)!;
    if (sprites(group) > EMOJI.perPage) throw new Error(`emoji page key ${key.toString(16)} has ${group.length} sprites, more than a page holds`);
    let page = pages[pages.length - 1];
    if (!page || sprites([...page.glyphs, ...group]) > EMOJI.perPage) pages.push((page = { keys: [], glyphs: [] }));
    page.keys.push(key);
    page.glyphs.push(...group);
  }

  // Every bitmap in the font has the same box (136 x 128 at 109 ppem for Noto): one cell size fits all.
  const scale = EMOJI.height / Math.max(...glyphs.map((g) => g.bitmap.height));
  const spriteW = Math.round(Math.max(...glyphs.map((g) => g.bitmap.width)) * scale);
  const spriteH = EMOJI.height;
  const cellW = Math.ceil((spriteW + 2 * EMOJI.padding) / 8) * 8;
  const cellH = Math.ceil((spriteH + 2 * EMOJI.padding) / 8) * 8;
  const columns = Math.floor(ATLAS_WIDTH / cellW);
  const metrics = readFontMetrics(fontData);

  const families = [];
  for (const [p, page] of pages.entries()) {
    const id = `emoji-${p + 1}`;
    const dir = path.join(OUT, id);
    mkdirSync(dir, { recursive: true });
    const cellOf = new Map<number, number>();
    for (const g of page.glyphs) if (!cellOf.has(g.glyph)) cellOf.set(g.glyph, cellOf.size);
    const width = columns * cellW;
    const height = Math.ceil(cellOf.size / columns) * cellH;
    const placed = new Map<number, EmojiGlyph>();
    for (const g of page.glyphs) if (!placed.has(g.glyph)) placed.set(g.glyph, g);
    const composites = await Promise.all(
      [...placed.values()].map(async (g) => {
        const cell = cellOf.get(g.glyph)!;
        const w = Math.round(g.bitmap.width * scale);
        const h = Math.round(g.bitmap.height * scale);
        return { input: await sharp(g.bitmap.png).resize(w, h, { kernel: 'lanczos3' }).png().toBuffer(), left: (cell % columns) * cellW + EMOJI.padding, top: Math.floor(cell / columns) * cellH + EMOJI.padding };
      }),
    );
    const atlas = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(composites).png().toBuffer();
    writeFileSync(path.join(dir, 'regular.webp'), await sharp(atlas).webp({ quality: 85, alphaQuality: 90, effort: 6, smartSubsample: true }).toBuffer());

    const em = (px: number) => Math.round((px / font.ppem) * 1e4) / 1e4;
    const layout = {
      atlas: { type: 'color', distanceRange: 0, size: Math.round(font.ppem * scale * 100) / 100, width, height, yOrigin: 'top' },
      metrics: { emSize: 1, lineHeight: 0, ascender: 0, descender: 0, underlineY: 0, underlineThickness: 0 },
      glyphs: page.glyphs.map((g) => {
        const cell = cellOf.get(g.glyph)!;
        const left = (cell % columns) * cellW + EMOJI.padding;
        const top = Math.floor(cell / columns) * cellH + EMOJI.padding;
        const { width: bw, height: bh, bearingX, bearingY } = g.bitmap;
        return {
          ...(g.sequence.length === 1 ? { unicode: g.sequence[0] } : { sequence: g.sequence }),
          advance: Math.round(g.advance * 1e4) / 1e4,
          planeBounds: { left: em(bearingX), top: em(-bearingY), right: em(bearingX + bw), bottom: em(bh - bearingY) },
          atlasBounds: { left, top, right: left + Math.round(bw * scale), bottom: top + Math.round(bh * scale) },
        };
      }),
    };
    writeFileSync(path.join(dir, 'regular.json'), JSON.stringify(layout));

    const ranges: [number, number][] = [];
    for (const key of page.keys) {
      const last = ranges[ranges.length - 1];
      if (last && key === last[1] + 1) last[1] = key;
      else ranges.push([key, key]);
    }
    writeFileSync(path.join(dir, 'coverage.json'), JSON.stringify(ranges.flat()));
    copyFileSync(licensePath, path.join(dir, 'LICENSE.txt'));
    for (const file of readdirSync(dir)) if (!['regular.webp', 'regular.json', 'coverage.json', 'LICENSE.txt'].includes(file)) rmSync(path.join(dir, file));
    console.log(`  ${id}: ${cellOf.size} sprites, ${page.glyphs.length} sequences, ${width}x${height}`);

    families.push({
      id,
      wordName: `Noto Color Emoji (${p + 1})`,
      substitute: 'Noto Color Emoji',
      license: EMOJI.license,
      licenseFile: `${id}/LICENSE.txt`,
      aliases: {},
      faces: [{ weight: 400, italic: false, atlas: `${id}/regular.webp`, layout: `${id}/regular.json`, metrics }],
      page: { group: EMOJI_GROUP, order: p, coverage: `${id}/coverage.json` },
    });
  }
  // Pages left over from an earlier run with more of them.
  for (const dir of readdirSync(OUT)) {
    const n = /^emoji-(\d+)$/.exec(dir);
    if (n && Number(n[1]) > pages.length) rmSync(path.join(OUT, dir), { recursive: true });
  }

  const manifestPath = path.join(OUT, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error('run `pnpm fonts` first: the emoji pages join its manifest');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { families: { page?: { group: string } }[] };
  manifest.families = [...manifest.families.filter((f) => f.page?.group !== EMOJI_GROUP), ...families];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${pages.length} emoji pages`);
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
