// A document as a picture: lays it out and draws its pages, one under the other, on a canvas. Text
// is drawn with the browser's own fonts (a serif, sans or monospace stand-in, see standardFonts.ts),
// each glyph at its laid-out position, so wrapping and page breaks match the editor.

import type { WordDocument } from '@word/docx';
import { layoutDocument, type FontSet, type GlyphList } from '@word/layout';
import { decodeImage, encodeCanvas, makeCanvas, type OutputType } from './imageCodec.ts';
import { standardFamily } from './standardFonts.ts';

/** Pixels per point: 2 is 144 dpi. */
const SCALE = 2;
/** Browsers refuse canvases much beyond this many pixels on a side. */
const LARGEST_SIDE = 16000;

const CSS_FAMILY = { Times: '"Times New Roman", Times, serif', Helvetica: 'Helvetica, Arial, sans-serif', Courier: '"Courier New", Courier, monospace' } as const;

/** Layout's packed little-endian RGBA8 as a CSS color. */
function css(packed: number): string {
  return `rgba(${packed & 0xff},${(packed >> 8) & 0xff},${(packed >> 16) & 0xff},${(packed >>> 24) / 255})`;
}

export async function documentToImage(doc: WordDocument, fonts: FontSet, type: OutputType): Promise<Uint8Array> {
  const layout = await layoutDocument(doc, fonts);
  const pages = layout.pages;
  const width = Math.max(1, ...pages.map((p) => p.width));
  const height = Math.max(1, pages.reduce((sum, p) => sum + p.height, 0));
  const scale = Math.min(SCALE, LARGEST_SIDE / width, LARGEST_SIDE / height);
  const { canvas, context: ctx } = makeCanvas(width * scale, height * scale);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const bitmaps = new Map<string, ImageBitmap | null>();
  const bitmapFor = async (part: string): Promise<ImageBitmap | null> => {
    if (!bitmaps.has(part)) bitmaps.set(part, await doc.media(part).then((bytes) => decodeImage(bytes)).catch(() => null));
    return bitmaps.get(part)!;
  };

  let top = 0;
  for (const page of pages) {
    ctx.save();
    ctx.translate(0, top * scale);
    ctx.scale(scale, scale);
    ctx.beginPath();
    ctx.rect(0, 0, page.width, page.height);
    ctx.clip();

    const rects = (list: typeof page.background) => {
      for (let i = 0; i < list.count; i++) {
        const [x, y, w, h] = list.rect(i);
        ctx.fillStyle = css(list.color(i));
        ctx.fillRect(x, y, w, h);
      }
    };
    const images = async (behind: boolean) => {
      for (const item of page.images) {
        const bitmap = item.behind === behind ? await bitmapFor(item.part) : null;
        if (bitmap) ctx.drawImage(bitmap, item.x, item.y, item.width, item.height);
      }
    };

    rects(page.background);
    await images(true);
    ctx.textBaseline = 'alphabetic';
    for (const list of page.glyphs.values() as Iterable<GlyphList>) {
      const { font, metrics } = list;
      const bold = font.face.weight >= 600 || font.syntheticBold;
      const italic = font.face.italic || font.syntheticItalic;
      for (let i = 0; i < list.count; i++) {
        const code = metrics.layout.glyphs[list.glyph(i)]?.unicode;
        if (code === undefined) continue;
        ctx.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${list.size(i)}px ${CSS_FAMILY[standardFamily(font)]}`;
        ctx.fillStyle = css(list.color(i));
        ctx.fillText(String.fromCodePoint(code), list.x(i), list.y(i));
      }
    }
    await images(false);
    rects(page.foreground);
    ctx.restore();
    top += page.height;
  }
  for (const bitmap of bitmaps.values()) bitmap?.close();
  return encodeCanvas(canvas, type);
}
