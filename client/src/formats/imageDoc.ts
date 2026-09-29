// A picture as a document: a page exactly the size of the picture, with the picture on it. Opening
// an image file makes one of these, so everything a document has (zoom and pan, saving, thumbnails,
// printing, conversion to PDF or Word) works on it, and the picture tools change the picture
// (see ui/imageTools.ts). The PNG, JPEG and WebP "formats" read a picture file into one and write
// the picture back out, as the same type or converted.

import { WordDocument, el } from '@word/docx';
import type { Block, Inline, RunContent } from '@word/docx';
import { sniffImage } from './images.ts';
import type { ImageData, ImageType } from './images.ts';

/** Twips per pixel of a picture: the page shows it at 96 dpi. */
const TWIPS_PER_PIXEL = 15;
/** The largest page Word allows, twips. Bigger pictures keep their pixels and are shown smaller. */
const LARGEST_PAGE = 31680;
/** Tiny pictures are shown at least this large (an inch on the long side), twips. */
const SMALLEST_PAGE = 1440;

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';

/** The size in twips a picture's page has. */
export function pageSizeFor(width: number, height: number): { w: number; h: number } {
  let w = Math.max(width, 1) * TWIPS_PER_PIXEL;
  let h = Math.max(height, 1) * TWIPS_PER_PIXEL;
  const scale = Math.max(w, h) > LARGEST_PAGE ? LARGEST_PAGE / Math.max(w, h) : Math.max(w, h) < SMALLEST_PAGE ? SMALLEST_PAGE / Math.max(w, h) : 1;
  w = Math.max(Math.round(w * scale), 1);
  h = Math.max(Math.round(h * scale), 1);
  return { w, h };
}

/** A document that is one page showing `image`, filling it. */
export async function imageToDocument(image: ImageData): Promise<WordDocument> {
  const doc = await WordDocument.create();
  const part = doc.addImage(image.bytes, image.type);
  const { w, h } = pageSizeFor(image.width, image.height);
  // Twips to points to EMUs.
  const cx = String(w * 635);
  const cy = String(h * 635);
  const name = 'Picture';
  // Floating at the page's corner, so the (empty) paragraph under it can't push the picture off the page.
  const anchor = el('wp:anchor', { distT: 0, distB: 0, distL: 0, distR: 0, simplePos: 0, relativeHeight: 0, behindDoc: 0, locked: 0, layoutInCell: 1, allowOverlap: 1 }, [
    el('wp:simplePos', { x: 0, y: 0 }),
    el('wp:positionH', { relativeFrom: 'page' }, [el('wp:posOffset', {}, ['0'])]),
    el('wp:positionV', { relativeFrom: 'page' }, [el('wp:posOffset', {}, ['0'])]),
    el('wp:extent', { cx, cy }),
    el('wp:effectExtent', { l: 0, t: 0, r: 0, b: 0 }),
    el('wp:wrapNone'),
    el('wp:docPr', { id: 1, name }),
    el('wp:cNvGraphicFramePr', {}, [el('a:graphicFrameLocks', { 'xmlns:a': A, noChangeAspect: 1 })]),
    el('a:graphic', { 'xmlns:a': A }, [
      el('a:graphicData', { uri: PIC }, [
        el('pic:pic', { 'xmlns:pic': PIC }, [
          el('pic:nvPicPr', {}, [el('pic:cNvPr', { id: 0, name }), el('pic:cNvPicPr')]),
          el('pic:blipFill', {}, [el('a:blip'), el('a:stretch', {}, [el('a:fillRect')])]),
          el('pic:spPr', {}, [el('a:xfrm', {}, [el('a:off', { x: 0, y: 0 }), el('a:ext', { cx, cy })]), el('a:prstGeom', { prst: 'rect' }, [el('a:avLst')])]),
        ]),
      ]),
    ]),
  ]);
  const drawing: RunContent = { kind: 'drawing', inline: false, width: w * 635, height: h * 635, image: part, name, xml: el('w:drawing', {}, [anchor]) };
  doc.body = [
    { kind: 'paragraph', properties: { spacing: { before: 0, after: 0, line: 240, lineRule: 'auto' } }, children: [{ kind: 'run', properties: { size: 2, sizeCs: 2 }, content: [drawing], attrs: {} }], attrs: {} },
  ];
  doc.section.pageSize = { w, h };
  doc.section.margins = { top: 0, right: 0, bottom: 0, left: 0, header: 0, footer: 0, gutter: 0 };
  return doc;
}

/** The first picture in a document: its package part, and its bytes' type. */
export async function firstPicture(doc: WordDocument): Promise<{ part: string; image: ImageData } | null> {
  const inlines = async (list: readonly Inline[]): Promise<{ part: string; image: ImageData } | null> => {
    for (const inline of list) {
      if (inline.kind === 'run') {
        for (const item of inline.content) {
          if (item.kind !== 'drawing' || !item.image) continue;
          const image = sniffImage(await doc.media(item.image).catch(() => new Uint8Array(0)));
          if (image) return { part: item.image, image };
        }
      } else if (inline.kind === 'hyperlink' || inline.kind === 'wrapper') {
        const found = await inlines(inline.children);
        if (found) return found;
      }
    }
    return null;
  };
  const blocks = async (list: readonly Block[]): Promise<{ part: string; image: ImageData } | null> => {
    for (const block of list) {
      let found: { part: string; image: ImageData } | null = null;
      if (block.kind === 'paragraph') found = await inlines(block.children);
      else if (block.kind === 'wrapper') found = await blocks(block.children);
      else if (block.kind === 'table') {
        for (const row of block.rows) {
          if (row.kind !== 'row') continue;
          for (const cell of row.cells) if (cell.kind === 'cell' && !found) found = await blocks(cell.children);
        }
      }
      if (found) return found;
    }
    return null;
  };
  return blocks(doc.body);
}

/** Whether a document is a picture's own page (see imageToDocument): edge-to-edge, nothing but the picture. */
export async function isPictureDocument(doc: WordDocument): Promise<boolean> {
  const m = doc.section.margins;
  if (!m || m.top || m.right || m.bottom || m.left || doc.body.length !== 1) return false;
  return (await firstPicture(doc)) !== null;
}

export const IMAGE_TYPES: readonly ImageType[] = ['png', 'jpeg', 'webp'];
