// What a PDF's editor added to its pages (text boxes and pictures), as Word drawings that float
// at the same place on the same page: a text box is a text box, a picture a picture, anchored to
// the page's corner so reflowing the text around them doesn't move them.

import { el, pointsToHalfPoints, type Paragraph, type RunContent, type WordDocument, type XmlElement } from '@word/docx';
import { imageBytes, interpretPage, type ImageEdit, type PdfDocument, type PdfEdit, type PdfPage, type TextBoxEdit } from '@word/pdf';
import { sniffImage, type ImageType } from './images.ts';
import { wordFontFor } from './pdfImport.ts';

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const WPS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';
const EMU = 12700;

/** Something to put on a page: made once the document exists (a picture is added to its package). */
export interface Placed {
  /** Zero-based PDF page. */
  page: number;
  build(doc: WordDocument): RunContent | null;
}

/** A box on a page: points from its top-left corner. */
interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

function frameOf(page: PdfPage, box: readonly number[]): Frame {
  const [cx0, , , cy1] = page.cropBox;
  return { x: box[0] - cx0, y: cy1 - box[3], width: Math.max(box[2] - box[0], 1), height: Math.max(box[3] - box[1], 1) };
}

/** The pictures the pages draw, and the text boxes and pictures the editor added to them, as things to place. */
export function placedFrom(pdf: PdfDocument, edits: readonly PdfEdit[]): Placed[] {
  const out: Placed[] = [];
  let z = 0;
  pdf.pages.forEach((page, index) => {
    const { images, width, height } = interpretPage(page);
    for (const image of images) {
      if (image.w < 4 || image.h < 4) continue;
      const frame: Frame = { x: image.x, y: image.y, width: image.w, height: image.h };
      // Covering most of the page: a background, under the text.
      const behind = image.w * image.h > 0.6 * width * height;
      const order = ++z;
      out.push({
        page: index,
        build: (doc) => {
          const found = imageBytes(pdf, image, { flipX: image.flipX, flipY: image.flipY, ...(image.maskColor !== undefined && { maskColor: image.maskColor }) });
          return found ? pictureDrawing(doc, found.bytes, found.mime === 'image/png' ? 'png' : 'jpeg', frame, order, behind) : null;
        },
      });
    }
  });
  for (const e of edits) {
    const page = pdf.pages[e.page];
    if (!page || (e.kind !== 'textbox' && e.kind !== 'image')) continue;
    const frame = frameOf(page, e.box);
    const order = ++z;
    if (e.kind === 'image') out.push({ page: e.page, build: (doc) => editPicture(doc, e, frame, order) });
    else if (e.text.trim()) out.push({ page: e.page, build: () => textBoxDrawing(e, frame, order) });
  }
  return out;
}

function anchor(frame: Frame, id: number, name: string, order: number, graphic: XmlElement, behind = false): RunContent {
  const cx = String(Math.round(frame.width * EMU));
  const cy = String(Math.round(frame.height * EMU));
  const xml = el('wp:anchor', { distT: 0, distB: 0, distL: 0, distR: 0, simplePos: 0, relativeHeight: order, behindDoc: behind ? 1 : 0, locked: 0, layoutInCell: 1, allowOverlap: 1 }, [
    el('wp:simplePos', { x: 0, y: 0 }),
    el('wp:positionH', { relativeFrom: 'page' }, [el('wp:posOffset', {}, [String(Math.round(frame.x * EMU))])]),
    el('wp:positionV', { relativeFrom: 'page' }, [el('wp:posOffset', {}, [String(Math.round(frame.y * EMU))])]),
    el('wp:extent', { cx, cy }),
    el('wp:effectExtent', { l: 0, t: 0, r: 0, b: 0 }),
    el('wp:wrapNone'),
    el('wp:docPr', { id, name }),
    el('wp:cNvGraphicFramePr'),
    graphic,
  ]);
  return { kind: 'drawing', inline: false, width: Math.round(frame.width * EMU), height: Math.round(frame.height * EMU), name, xml: el('w:drawing', {}, [xml]) };
}

function editPicture(doc: WordDocument, edit: ImageEdit, frame: Frame, order: number): RunContent | null {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(edit.data), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  const image = sniffImage(bytes);
  return image ? pictureDrawing(doc, bytes, image.type, frame, order, false) : null;
}

function pictureDrawing(doc: WordDocument, bytes: Uint8Array, type: ImageType, frame: Frame, order: number, behind: boolean): RunContent {
  const part = doc.addImage(bytes, type);
  const cx = String(Math.round(frame.width * EMU));
  const cy = String(Math.round(frame.height * EMU));
  const name = `Picture ${order}`;
  const graphic = el('a:graphic', { 'xmlns:a': A }, [
    el('a:graphicData', { uri: PIC }, [
      el('pic:pic', { 'xmlns:pic': PIC }, [
        el('pic:nvPicPr', {}, [el('pic:cNvPr', { id: 0, name }), el('pic:cNvPicPr')]),
        el('pic:blipFill', {}, [el('a:blip'), el('a:stretch', {}, [el('a:fillRect')])]),
        el('pic:spPr', {}, [el('a:xfrm', {}, [el('a:off', { x: 0, y: 0 }), el('a:ext', { cx, cy })]), el('a:prstGeom', { prst: 'rect' }, [el('a:avLst')])]),
      ]),
    ]),
  ]);
  const drawing = anchor(frame, order, name, order, graphic, behind);
  return drawing.kind === 'drawing' ? { ...drawing, image: part } : drawing;
}

const hex = (rgb: readonly number[]) => rgb.map((c) => Math.round(Math.min(Math.max(c, 0), 1) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();

function textBoxDrawing(edit: TextBoxEdit, frame: Frame, order: number): RunContent {
  const family = wordFontFor(edit.font) ?? edit.font.replace(/-.*$/, '');
  const bold = edit.bold ?? /bold/i.test(edit.font);
  const italic = edit.italic ?? /oblique|italic/i.test(edit.font);
  const paragraphs: Paragraph[] = edit.text.split(/\r\n?|\n/).map((line) => ({
    kind: 'paragraph',
    properties: { spacing: { before: 0, after: 0, line: 240, lineRule: 'auto' } },
    children: [
      {
        kind: 'run',
        properties: {
          fonts: { ascii: family, hAnsi: family, cs: family },
          ...(bold && { bold: true }),
          ...(italic && { italic: true }),
          size: pointsToHalfPoints(edit.size),
          sizeCs: pointsToHalfPoints(edit.size),
          ...(hex(edit.color) !== '000000' && { color: { val: hex(edit.color) } }),
        },
        content: [{ kind: 'text', text: line }],
        attrs: {},
      },
    ],
    attrs: {},
  }));
  const cx = String(Math.round(frame.width * EMU));
  const cy = String(Math.round(frame.height * EMU));
  const name = `Text Box ${order}`;
  const graphic = el('a:graphic', { 'xmlns:a': A }, [
    el('a:graphicData', { uri: WPS }, [
      el('wps:wsp', { 'xmlns:wps': WPS }, [
        el('wps:cNvSpPr', { txBox: 1 }),
        el('wps:spPr', {}, [el('a:xfrm', {}, [el('a:off', { x: 0, y: 0 }), el('a:ext', { cx, cy })]), el('a:prstGeom', { prst: 'rect' }, [el('a:avLst')]), el('a:noFill'), el('a:ln', {}, [el('a:noFill')])]),
        el('wps:txbx', {}, [el('w:txbxContent')]),
        el('wps:bodyPr', { rot: 0, vert: 'horz', wrap: 'square', lIns: 0, tIns: 0, rIns: 0, bIns: 0, anchor: 't' }, [el('a:noAutofit')]),
      ]),
    ]),
  ]);
  const drawing = anchor(frame, order, name, order, graphic);
  return drawing.kind === 'drawing' ? { ...drawing, textBox: paragraphs } : drawing;
}
