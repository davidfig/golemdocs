import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { N, PageDrawing, PdfDict, PdfDocument, PdfStream, PdfString, describeFont, encodePng, imageBytes, interpretPage, type PageDisplay } from '../src/index.ts';
import { paintColor, paintColorAt } from '../src/render/shading.ts';
import { fixture, load } from './helpers.ts';

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** A one-page document whose content stream is the given text. */
function withContent(content: string, size: [number, number] = [200, 100], setup?: (doc: PdfDocument, page: ReturnType<PdfDocument['addPage']>) => void): { doc: PdfDocument; display: PageDisplay } {
  const doc = PdfDocument.create();
  const page = doc.addPage(size);
  setup?.(doc, page);
  page.setContent(ascii(content));
  return { doc, display: interpretPage(page) };
}

/** Decodes a PNG made by encodePng (or imageBytes) to { width, height, channels, pixels }. */
function decodePng(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let p = 8;
  const idat: Buffer[] = [];
  let width = 0;
  let height = 0;
  let colorType = 0;
  while (p < bytes.length) {
    const len = v.getUint32(p);
    const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    if (type === 'IHDR') {
      width = v.getUint32(p + 8);
      height = v.getUint32(p + 12);
      colorType = bytes[p + 17];
    } else if (type === 'IDAT') idat.push(Buffer.from(bytes.subarray(p + 8, p + 8 + len)));
    p += 12 + len;
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : 4;
  const raw = inflateSync(Buffer.concat(idat));
  const rowBytes = width * channels;
  const pixels = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (rowBytes + 1)], 0, 'filter type 0');
    pixels.set(raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1)), y * rowBytes);
  }
  return { width, height, channels, pixels };
}

const near = (a: number, b: number, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test('text: standard-font glyphs at their PDF positions with the PDF advances', () => {
  const doc = PdfDocument.create();
  const page = doc.addPage([300, 200]);
  const helv = doc.standardFont('Helvetica');
  const d = page.draw({ origin: 'top-left' });
  d.text('Hi there', 72, 100, { font: helv, size: 12, color: [1, 0, 0] });
  d.text('Bold', 72, 120, { font: doc.standardFont('Times-BoldItalic'), size: 10, charSpacing: 1 });
  d.finish();
  const out = interpretPage(page);
  assert.equal(out.width, 300);
  assert.equal(out.height, 200);
  assert.equal(out.glyphRuns.length, 2);
  const [a, b] = out.glyphRuns;
  assert.equal(a.family, 'Helvetica');
  assert.equal(a.size, 12);
  assert.equal(a.color, 0xff0000);
  assert.equal(a.glyphs.map((g) => g.unicode).join(''), 'Hithere'); // spaces are not drawn
  near(a.glyphs[0].x, 72);
  near(a.glyphs[0].y, 100);
  near(a.glyphs[0].advance, (722 * 12) / 1000); // Helvetica H
  near(a.glyphs[1].x, 72 + (722 * 12) / 1000);
  // "there" starts after "Hi" and a space (278).
  near(a.glyphs[2].x, 72 + ((722 + 222 + 278) * 12) / 1000);
  assert.deepEqual([b.bold, b.italic, b.serif], [true, true, true]);
  near(b.glyphs[1].x - b.glyphs[0].x, (667 * 10) / 1000 + 1); // Times-BoldItalic B + Tc
});

test('text: colors in every space, alpha, invisible and rotated runs', () => {
  const { display } = withContent(
    [
      'BT /F1 10 Tf 0.5 g 10 90 Td (gray) Tj ET',
      'BT /F1 10 Tf 0 0 1 rg 10 80 Td (rgb) Tj ET',
      'BT /F1 10 Tf 1 0 0 0 k 10 70 Td (cmyk) Tj ET', // cyan
      'BT /F1 10 Tf /Sep cs 0.5 sc 10 60 Td (sep) Tj ET',
      'BT /F1 10 Tf /Idx cs 1 sc 10 50 Td (idx) Tj ET',
      'BT /F1 10 Tf 0 g 3 Tr 10 40 Td (invisible) Tj ET',
      'BT /F1 10 Tf 0 Tr 0.866 0.5 -0.5 0.866 100 20 Tm (rotated) Tj ET',
      'BT /F1 10 Tf 1 0 0 rg 1 Tr 10 30 Td (outline) Tj ET',
      '/A gs BT /F1 10 Tf 0 g 0 Tr 10 20 Td (alpha) Tj ET',
    ].join('\n'),
    [200, 100],
    (doc, page) => {
      page.addResource('Font', doc.standardFont('Helvetica').ref, 'F');
      const res = page.resources;
      const fonts = doc.dict(res.get('Font'))!;
      fonts.set('F1', fonts.get('F1') ?? [...fonts][0][1]);
      // Separation with an exponential tint transform to DeviceRGB: white to (1, 0, 0).
      const tint = new PdfDict({ FunctionType: 2, Domain: [0, 1], C0: [1, 1, 1], C1: [1, 0, 0], N: 1 });
      res.set('ColorSpace', new PdfDict({ Sep: [N('Separation'), N('Spot'), N('DeviceRGB'), tint], Idx: [N('Indexed'), N('DeviceRGB'), 1, new PdfString(new Uint8Array([0, 0, 0, 0, 255, 0]))] }));
      res.set('ExtGState', new PdfDict({ A: new PdfDict({ ca: 0.5 }) }));
    },
  );
  const byText = (t: string) => display.glyphRuns.find((r) => r.glyphs.map((g) => g.unicode).join('') === t);
  assert.equal(byText('gray')?.color, 0x808080);
  assert.equal(byText('rgb')?.color, 0x0000ff);
  assert.equal(byText('cmyk')?.color, 0x00ffff);
  assert.equal(byText('sep')?.color, 0xff8080);
  assert.equal(byText('outline')?.color, 0x000000); // stroke-only text uses the stroke color (default black)
  assert.equal(byText('invisible'), undefined);
  assert.equal(byText('rotated'), undefined);
  assert.ok(display.warnings.some((w) => /rotated/.test(w)));
  assert.equal(byText('alpha')?.alpha, 0.5);
});

test('paths: rectangles, strokes as thin rects, dashes, holes and clamping', () => {
  const { display } = withContent(
    [
      '1 0 0 rg 10 10 50 20 re f',
      '0 0 1 RG 4 w 0 50 m 100 50 l S', // horizontal
      '0 1 0 RG 2 w 150 0 m 150 100 l S', // vertical
      '0.5 G 1 w 20 70 30 10 re S', // stroked rectangle: four edges
      '0 g 100 10 m 140 10 l 140 30 l 100 30 l h f', // closed 4-point path
      '0 1 1 RG 1 w 100 60 m 130 90 l S', // diagonal: drawn in strips
      '1 0.5 0 rg 0 0 m 10 10 20 0 30 10 c f', // curve: filled in strips
      '0 g 160 10 30 30 re 170 20 10 10 re f*', // even-odd hole
      '1 0 1 rg -50 -50 20 20 re f', // outside the page
      '0 0 0 RG 1 w [4 4] 0 d 0 95 m 40 95 l S', // dashed
    ].join('\n'),
  );
  const at = (x: number, y: number) => display.rects.find((r) => r.x <= x && r.y <= y && r.x + r.w > x && r.y + r.h > y);
  // y is flipped: user (10,10) size 50x20 is display y 70..90.
  const red = display.rects.find((r) => r.color === 0xff0000)!;
  assert.deepEqual([red.x, red.y, red.w, red.h], [10, 70, 50, 20]);
  const blue = display.rects.find((r) => r.color === 0x0000ff)!;
  assert.deepEqual([blue.x, blue.y, blue.w, blue.h], [0, 48, 100, 4]);
  const green = display.rects.find((r) => r.color === 0x00ff00)!;
  assert.deepEqual([green.x, green.y, green.w, green.h], [149, 0, 2, 100]);
  assert.equal(display.rects.filter((r) => r.color === 0x808080).length, 4);
  const poly = display.rects.find((r) => r.x === 100 && r.color === 0 && r.h === 20)!;
  assert.equal(poly.w, 40);
  // The frame of the even-odd rectangle: its center is empty, its border is not.
  assert.equal(at(175, 75), undefined);
  assert.ok(at(162, 75));
  assert.ok(!display.rects.some((r) => r.color === 0xff00ff));
  for (const r of display.rects) assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 200.001 && r.y + r.h <= 100.001);
  const dashes = display.rects.filter((r) => r.y > 4 && r.y < 6 && r.h <= 1.01);
  assert.equal(dashes.length, 5); // 40pt of 4 on / 4 off
  // The diagonal is a band of strips along its line, about a point thick; the curve fills between itself and its chord.
  const cyan = display.rects.filter((r) => r.color === 0x00ffff);
  assert.ok(cyan.length > 20 && cyan.every((r) => r.x >= 99 && r.x + r.w <= 131 && r.y >= 9 && r.y + r.h <= 41.5), `${cyan.length} strips`);
  assert.ok(Math.abs(Math.min(...cyan.map((r) => r.x)) - 100) < 0.5 && Math.abs(Math.max(...cyan.map((r) => r.x + r.w)) - 130) < 0.5);
  const orange = display.rects.filter((r) => r.color === 0xff8000);
  assert.ok(orange.length > 3 && orange.every((r) => r.x >= -0.01 && r.x + r.w <= 30.01));
});

test('shapes that are not rectangles are filled in strips: a triangle and an ellipse keep their area', () => {
  const area = (rects: { w: number; h: number }[]) => rects.reduce((n, r) => n + r.w * r.h, 0);
  const triangle = withContent('1 0 0 rg 10 10 m 110 10 l 60 90 l f').display.rects.filter((r) => r.color === 0xff0000);
  assert.ok(Math.abs(area(triangle) - 4000) < 60, `${area(triangle)}`);
  // An ellipse of radii 50 and 30 drawn with four curves, and a half-size one cut out of it (even-odd).
  const ellipse = (cx: number, cy: number, rx: number, ry: number) => {
    const k = 0.5522847498307936;
    return `${cx + rx} ${cy} m ${cx + rx} ${cy + k * ry} ${cx + k * rx} ${cy + ry} ${cx} ${cy + ry} c ${cx - k * rx} ${cy + ry} ${cx - rx} ${cy + k * ry} ${cx - rx} ${cy} c ${cx - rx} ${cy - k * ry} ${cx - k * rx} ${cy - ry} ${cx} ${cy - ry} c ${cx + k * rx} ${cy - ry} ${cx + rx} ${cy - k * ry} ${cx + rx} ${cy} c h`;
  };
  const full = withContent(`0 0 1 rg ${ellipse(100, 50, 50, 30)} f`).display.rects.filter((r) => r.color === 0x0000ff);
  assert.ok(Math.abs(area(full) - Math.PI * 50 * 30) < 60, `${area(full)}`);
  const ring = withContent(`0 0 1 rg ${ellipse(100, 50, 50, 30)} ${ellipse(100, 50, 25, 15)} f*`).display.rects.filter((r) => r.color === 0x0000ff);
  assert.ok(Math.abs(area(ring) - Math.PI * (50 * 30 - 25 * 15)) < 60, `${area(ring)}`);
});

test('rects painted after text are marked as over', () => {
  const { display } = withContent('1 0 0 rg 0 0 100 100 re f\nBT /F1 12 Tf 0 g 10 50 Td (x) Tj ET\n0 0 1 rg 8 48 20 20 re f\n0 g 150 10 20 20 re f', [200, 100], (doc, page) => {
    page.addResource('Font', doc.standardFont('Helvetica').ref, 'F');
    const fonts = doc.dict(page.resources.get('Font'))!;
    fonts.set('F1', [...fonts][0][1]);
  });
  assert.equal(display.rects.find((r) => r.color === 0xff0000)!.over, false);
  assert.equal(display.rects.find((r) => r.color === 0x0000ff)!.over, true);
  assert.equal(display.rects.find((r) => r.x === 150)!.over, false);
});

test('page geometry: CropBox and rotation', () => {
  const doc = PdfDocument.create();
  const page = doc.addPage([200, 100]);
  page.rotation = 90;
  page.setContent(ascii('1 0 0 rg 10 20 100 50 re f'));
  const d = interpretPage(page);
  assert.deepEqual([d.width, d.height], [100, 200]);
  // Rotated 90 clockwise: user (x, y) -> display (y, x).
  const r = d.rects[0];
  assert.deepEqual([r.x, r.y, r.w, r.h], [20, 10, 50, 100]);

  const cropped = PdfDocument.create();
  const p2 = cropped.addPage([200, 100]);
  p2.cropBox = [50, 10, 150, 90];
  p2.setContent(ascii('0 g 60 20 10 10 re f'));
  const d2 = interpretPage(p2);
  assert.deepEqual([d2.width, d2.height], [100, 80]);
  assert.deepEqual([d2.rects[0].x, d2.rects[0].y], [10, 60]);
});

test('forms, annotations, optional content and hostile content', () => {
  const doc = PdfDocument.create();
  const page = doc.addPage([200, 100]);
  const form = doc.add(new PdfStream(new PdfDict({ Type: N('XObject'), Subtype: N('Form'), BBox: [0, 0, 20, 20], Matrix: [1, 0, 0, 1, 100, 50] }), ascii('0 1 0 rg 0 0 20 20 re f')));
  const hiddenLayer = doc.add(new PdfDict({ Type: N('OCG'), Name: PdfString.text('Hidden') }));
  doc.catalog.set('OCProperties', new PdfDict({ OCGs: [hiddenLayer], D: new PdfDict({ OFF: [hiddenLayer] }) }));
  page.resources.set('XObject', new PdfDict({ Fm: form }));
  page.resources.set('Properties', new PdfDict({ Hid: hiddenLayer }));
  const ap = doc.add(new PdfStream(new PdfDict({ Type: N('XObject'), Subtype: N('Form'), BBox: [0, 0, 10, 10] }), ascii('0 0 1 rg 0 0 10 10 re f')));
  page.dict.set('Annots', [doc.add(new PdfDict({ Type: N('Annot'), Subtype: N('Stamp'), Rect: [5, 5, 25, 15], AP: new PdfDict({ N: ap }) }))]);
  page.setContent(ascii('/Fm Do\n/OC /Hid BDC 1 0 0 rg 0 0 50 50 re f EMC\n((( q Q Q BT Tj ET /Nope Do [ ] 0 d 1 2 3 cm ) ] >> f f S'));
  const d = interpretPage(page);
  const colors = d.rects.map((r) => r.color.toString(16));
  assert.ok(colors.includes('ff00'), 'form drawn'); // green, at display y 30..50
  const green = d.rects.find((r) => r.color === 0x00ff00)!;
  assert.deepEqual([green.x, green.y, green.w, green.h], [100, 30, 20, 20]);
  assert.ok(!colors.includes('ff0000'), 'hidden layer not drawn');
  const stamp = d.rects.find((r) => r.color === 0x0000ff)!;
  assert.deepEqual([stamp.x, stamp.y, stamp.w, stamp.h], [5, 85, 20, 10]); // scaled 10x10 -> 20x10
});

test('a form that draws itself is drawn once, not to the depth limit over and over', () => {
  const doc = PdfDocument.create();
  const page = doc.addPage([200, 100]);
  const resources = new PdfDict();
  const self = doc.add(new PdfStream(new PdfDict({ Type: N('XObject'), Subtype: N('Form'), BBox: [0, 0, 20, 20], Resources: resources }), ascii(`0 1 0 rg 0 0 20 20 re f ${'/Me Do '.repeat(8)}`)));
  resources.set('XObject', new PdfDict({ Me: self }));
  page.resources.set('XObject', new PdfDict({ Me: self }));
  page.setContent(ascii('/Me Do'));
  const started = Date.now();
  const d = interpretPage(page);
  assert.ok(Date.now() - started < 2000, 'finishes quickly');
  assert.equal(d.rects.length, 1);
});

test('closing a subpath moves the current point back to its start: a curve after h starts there', () => {
  // A closed line along the bottom, then a curve from its start straight up the left edge.
  const { display } = withContent('1 w 10 10 m 150 10 l h 10 40 10 70 10 90 c S');
  const curve = display.rects.filter((r) => r.w < 5);
  assert.ok(curve.length > 0, 'the curve is drawn');
  for (const r of curve) assert.ok(r.x >= 9 && r.x + r.w <= 11, `curve piece at x ${r.x}..${r.x + r.w}, not along x = 10`);
});

test('images: JPEG passes through, raw pixels become PNG, placement and mirroring', () => {
  const doc = PdfDocument.create();
  const page = doc.addPage([200, 100]);
  const jpeg = fixture('img-rgb.jpg');
  const j = doc.embedImage(jpeg);
  const png = doc.embedImage(fixture('img-rgba.png'));
  const d = page.draw({ origin: 'top-left' });
  d.image(j, 10, 10, 40, 30);
  d.image(png, 60, 20, 32, 32);
  d.finish();
  page.addContent(ascii('q -20 0 0 -20 190 50 cm /Im2 Do Q'));
  const out = interpretPage(page);
  assert.equal(out.images.length, 3);
  const [a, b, c] = out.images;
  assert.deepEqual([a.x, a.y, a.w, a.h], [10, 10, 40, 30]);
  assert.deepEqual([b.x, b.y, b.w, b.h], [60, 20, 32, 32]);
  assert.equal(a.pixelWidth, j.width);
  assert.equal(c.flipX, true);
  assert.equal(c.flipY, true);

  const ja = imageBytes(doc, a)!;
  assert.equal(ja.mime, 'image/jpeg');
  assert.deepEqual([...ja.bytes], [...jpeg]);

  const pb = imageBytes(doc, b)!;
  assert.equal(pb.mime, 'image/png');
  const px = decodePng(pb.bytes);
  assert.equal(px.channels, 4);
  assert.equal(px.width, png.width);
  // Fixture pixel (x, y) = (16x, 16y, 8(x+y)), alpha 16x+y.
  const at = (x: number, y: number) => [...px.pixels.subarray((y * px.width + x) * 4, (y * px.width + x) * 4 + 4)];
  assert.deepEqual(at(3, 5), [48, 80, 64, 53]);
  assert.deepEqual(at(0, 0), [0, 0, 0, 0]);

  // The same image mirrored in both axes.
  const flipped = decodePng(imageBytes(doc, { stream: c.stream, flipX: true, flipY: true })!.bytes);
  const fat = (x: number, y: number) => [...flipped.pixels.subarray((y * flipped.width + x) * 4, (y * flipped.width + x) * 4 + 4)];
  assert.deepEqual(fat(px.width - 1 - 3, px.height - 1 - 5), at(3, 5));
});

test('images: other PNG layouts convert to the right pixels', () => {
  const doc = PdfDocument.create();
  for (const name of ['img-rgb.png', 'img-rgb-interlaced.png', 'img-gray16.png', 'img-gray1.png', 'img-palette-trns.png', 'img-rgba-interlaced.png']) {
    const src = doc.embedImage(fixture(name));
    const out = imageBytes(doc, src.ref);
    assert.ok(out, name);
    const px = decodePng(out!.bytes);
    assert.equal(px.width, src.width, name);
    assert.equal(px.height, src.height, name);
  }
  const rgb = decodePng(imageBytes(doc, doc.embedImage(fixture('img-rgb.png')).ref)!.bytes);
  assert.equal(rgb.channels, 3);
  assert.deepEqual([...rgb.pixels.subarray((5 * rgb.width + 3) * 3, (5 * rgb.width + 3) * 3 + 3)], [48, 80, 64]);
  const gray = decodePng(imageBytes(doc, doc.embedImage(fixture('img-gray16.png')).ref)!.bytes);
  assert.equal(gray.channels, 1);
  const pal = decodePng(imageBytes(doc, doc.embedImage(fixture('img-palette-trns.png')).ref)!.bytes);
  assert.equal(pal.channels, 4);
  // CMYK JPEGs still pass through.
  assert.equal(imageBytes(doc, doc.embedImage(fixture('img-cmyk.jpg')).ref)!.mime, 'image/jpeg');
});

test('images: inline images, stencil masks and unsupported codecs', () => {
  const doc = PdfDocument.create();
  const page = doc.addPage([100, 100]);
  // 2x2 RGB inline image, then a 8x1 stencil in the fill color.
  page.setContent(
    Uint8Array.from(
      [
        ...ascii('q 20 0 0 20 10 10 cm BI /W 2 /H 2 /CS /RGB /BPC 8 ID '),
        255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255,
        ...ascii('\nEI Q\n1 0 0 rg q 40 0 0 5 50 50 cm BI /W 8 /H 1 /IM true /BPC 1 ID '),
        0b10101010,
        ...ascii('\nEI Q'),
      ],
    ),
  );
  const out = interpretPage(page);
  assert.equal(out.images.length, 2);
  const px = decodePng(imageBytes(doc, out.images[0])!.bytes);
  assert.deepEqual([px.width, px.height, px.channels], [2, 2, 3]);
  assert.deepEqual([...px.pixels.subarray(0, 6)], [255, 0, 0, 0, 255, 0]);
  const stencil = decodePng(imageBytes(doc, out.images[1])!.bytes);
  assert.equal(stencil.channels, 4);
  assert.deepEqual([...stencil.pixels.subarray(0, 8)], [255, 0, 0, 0, 255, 0, 0, 255]); // sample 1 = unpainted, 0 = red
  assert.equal(out.images[1].maskColor, 0xff0000);

  const jpx = new PdfStream(new PdfDict({ Subtype: N('Image'), Width: 1, Height: 1, Filter: N('JPXDecode') }), new Uint8Array(4));
  assert.equal(imageBytes(doc, jpx), null);
  assert.equal(imageBytes(doc, new PdfStream(new PdfDict(), new Uint8Array(0))), null);
});

test('encodePng round-trips', () => {
  const pixels = Uint8Array.from({ length: 70000 * 3 }, (_, i) => (i * 7) & 0xff);
  const out = decodePng(encodePng(70000, 1, 3, pixels)); // spans several stored blocks
  assert.deepEqual([out.width, out.height, out.channels], [70000, 1, 3]);
  assert.deepEqual(out.pixels, pixels);
});

test('producer fixtures: every page interprets with text where the extractor finds it', () => {
  for (const name of ['libreoffice.pdf', 'chromium.pdf', 'reportlab.pdf', 'wkhtmltopdf.pdf', 'xelatex.pdf', 'pdflatex.pdf', 'matplotlib-type3.pdf', 'matplotlib-type42.pdf', 'objstm.pdf']) {
    const doc = load(name);
    const page = doc.pages[0];
    const display = interpretPage(page);
    const text = display.glyphRuns.flatMap((r) => r.glyphs.map((g) => g.unicode)).join('').replace(/\s+/g, '');
    const expected = page.extractText().text.replace(/\s+/g, '');
    assert.ok(text.length > 0, name);
    assert.ok(text.includes('quickbrownfox') || text.includes('Thequick'), `${name}: ${text.slice(0, 40)}`);
    // Positions agree with the text extractor's first item.
    const first = page.extractText().items.find((i) => i.text.trim());
    if (first) {
      const [dx, dy] = page.toDisplay(first.x, first.y);
      const run = display.glyphRuns[0];
      near(run.glyphs[0].x, dx, 0.05);
      near(run.glyphs[0].y, dy, 0.05);
    }
    void expected;
  }
  const image = load('image.pdf');
  const d = interpretPage(image.pages[0]);
  assert.ok(d.images.length >= 1);
  assert.equal(imageBytes(image, d.images[0])?.mime, 'image/png');
});

test('encrypted documents render once opened', () => {
  const doc = load('aes-256.pdf', { password: 'user' });
  assert.ok(interpretPage(doc.pages[0]).glyphRuns.length > 0);
});

test('PageDrawing output survives a save/load round trip', async () => {
  const doc = PdfDocument.create();
  const page = doc.addPage([200, 100]);
  const d = new PageDrawing(page, { origin: 'top-left' });
  d.rect(10, 10, 30, 20, { fill: [0, 1, 0] });
  d.finish();
  const back = PdfDocument.load(await doc.save());
  const out = interpretPage(back.pages[0]);
  assert.deepEqual([out.rects[0].x, out.rects[0].y, out.rects[0].w, out.rects[0].h, out.rects[0].color], [10, 10, 30, 20, 0x00ff00]);
});

test('TeX fonts are told apart by the style code in their names', () => {
  const doc = PdfDocument.create();
  // As LaTeX writes them: a subset prefix, and a descriptor that only says "symbolic".
  const style = (name: string) => {
    const descriptor = new PdfDict({ Type: N('FontDescriptor'), FontName: N(`ABCDEF+${name}`), Flags: 4, ItalicAngle: 0 });
    const s = describeFont(doc, new PdfDict({ Type: N('Font'), Subtype: N('Type1'), BaseFont: N(`ABCDEF+${name}`), FontDescriptor: descriptor }));
    return [s.serif, s.bold, s.italic, s.mono].map((b, i) => (b ? 'SBIM'[i] : '-')).join('');
  };
  assert.equal(style('SFRM1000'), 'S---');
  assert.equal(style('SFBX1200'), 'SB--');
  assert.equal(style('SFTI1000'), 'S-I-');
  assert.equal(style('SFTT0800'), '---M');
  assert.equal(style('SFSS1000'), '----');
  assert.equal(style('ECBI1000'), 'SBI-');
  assert.equal(style('CMR10'), 'S---');
  assert.equal(style('CMBX12'), 'SB--');
  assert.equal(style('CMMI10'), 'S-I-');
  assert.equal(style('CMITT10'), '--IM');
  assert.equal(style('CMSSBX10'), '-B--');
  // Names that only look like TeX codes are left alone.
  assert.equal(style('SFProText-Regular'), '----');
  assert.equal(style('SFNS'), '----');
});

/** A one-page document with a red-to-blue axial gradient pattern `/G` (left to right across 0..200) and Helvetica as `/F1`. */
function withGradient(content: string, extra?: (doc: PdfDocument, res: PdfDict) => void): { doc: PdfDocument; page: ReturnType<PdfDocument['addPage']> } {
  const doc = PdfDocument.create();
  const page = doc.addPage([200, 100]);
  page.addResource('Font', doc.standardFont('Helvetica').ref, 'F');
  const res = page.resources;
  const fonts = doc.dict(res.get('Font'))!;
  fonts.set('F1', fonts.get('F1') ?? [...fonts][0][1]);
  const shading = new PdfDict({ ShadingType: 2, ColorSpace: N('DeviceRGB'), Coords: [0, 0, 200, 0], Function: new PdfDict({ FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 }), Extend: [true, true] });
  res.set('Pattern', new PdfDict({ G: new PdfDict({ PatternType: 2, Shading: shading }) }));
  extra?.(doc, res);
  page.setContent(ascii(content));
  return { doc, page };
}

test('strips: false leaves curves and gradients to the caller, in painting order with the images', () => {
  const ellipse = '100 50 m 100 77.6 77.6 100 50 100 c 22.4 100 0 77.6 0 50 c 0 22.4 22.4 0 50 0 c 77.6 0 100 22.4 100 50 c f';
  const content = [`0 0 1 rg ${ellipse}`, '0 1 0 rg 120 10 30 30 re f', '/Pattern cs /G scn 150 60 40 30 re f', 'q 20 0 0 20 160 10 cm /Im Do Q', '0 g 1 w 0 0 m 200 100 l S'].join('\n');
  const setup = (doc: PdfDocument, res: PdfDict) => {
    const img = new PdfStream(new PdfDict({ Type: N('XObject'), Subtype: N('Image'), Width: 1, Height: 1, ColorSpace: N('DeviceRGB'), BitsPerComponent: 8 }), new Uint8Array([255, 0, 0]));
    res.set('XObject', new PdfDict({ Im: doc.add(img) }));
  };
  const { page } = withGradient(content, setup);
  // As before: the ellipse and the slanted line in strips; the gradient was never in them.
  const strips = interpretPage(page, { paths: true });
  assert.ok(strips.rects.length > 10);
  assert.deepEqual(strips.paths.map((p) => !!p.vectorOnly), [false, false, true, false]);
  const display = interpretPage(page, { paths: true, strips: false });
  const [curve, box, gradient, line] = display.paths;
  assert.ok(curve.vectorOnly && gradient.vectorOnly && line.vectorOnly);
  assert.ok(!box.vectorOnly);
  assert.equal(gradient.fill?.paint?.kind, 'axial');
  // Only the green box is still a rectangle.
  assert.equal(display.rects.length, 1);
  assert.equal(display.rects[0].color, 0x00ff00);
  // One painting order across paths and images: the image comes after the gradient and before the line.
  const [image] = display.images;
  assert.deepEqual([curve.order, box.order, gradient.order, image.order, line.order], [0, 1, 2, 3, 4]);
  assert.ok(!display.warnings.some((w) => w.includes('pattern')));
});

test('text painted with a gradient: each glyph in the gradient\'s color where it stands', () => {
  const { page } = withGradient('/Pattern cs /G scn BT /F1 20 Tf 10 40 Td (MMMMMMMMMMMMM) Tj ET');
  const [run] = interpretPage(page, { paths: true }).glyphRuns;
  const first = run.glyphs[0].color!;
  const last = run.glyphs[run.glyphs.length - 1].color!;
  // Red on the left, blue on the right, each glyph between.
  assert.ok(first >> 16 > 200 && (first & 255) < 60, first.toString(16));
  assert.ok(last >> 16 < 60 && (last & 255) > 200, last.toString(16));
  // The run as a whole: the gradient's middle.
  assert.equal(run.color, 0x800080);
});

test('a tiling pattern whose cell is an image keeps the image', () => {
  const { page } = withGradient('/Pattern cs /T scn 10 10 m 190 10 l 100 90 l h f', (doc, res) => {
    const img = new PdfStream(new PdfDict({ Type: N('XObject'), Subtype: N('Image'), Width: 2, Height: 1, ColorSpace: N('DeviceRGB'), BitsPerComponent: 8 }), new Uint8Array([255, 0, 0, 0, 0, 255]));
    const cell = new PdfStream(new PdfDict({ PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 200, 100], XStep: 202, YStep: 102, Resources: new PdfDict({ XObject: new PdfDict({ X: doc.add(img) }) }) }), ascii('q 200 0 0 100 0 0 cm /X Do Q'));
    (doc.dict(res.get('Pattern')) as PdfDict).set('T', doc.add(cell));
  });
  const display = interpretPage(page, { paths: true, strips: false });
  const [shape] = display.paths;
  const paint = shape.fill?.paint;
  assert.equal(paint?.kind, 'tiling');
  assert.equal(paint.kind === 'tiling' && paint.images?.length, 1);
  assert.ok(shape.vectorOnly);
  assert.deepEqual(display.warnings, []);
});

test('a paint\'s color at a point: along an axial gradient, out from a radial one', () => {
  const stops = [
    { offset: 0, color: 0xff0000 },
    { offset: 1, color: 0x0000ff },
  ];
  const axial = { kind: 'axial' as const, matrix: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number], x0: 0, y0: 0, x1: 100, y1: 0, stops, extend: [true, true] as [boolean, boolean] };
  assert.equal(paintColorAt(axial, 0, 50), 0xff0000);
  assert.equal(paintColorAt(axial, 50, 0), 0x800080);
  assert.equal(paintColorAt(axial, 500, 0), 0x0000ff);
  // Placed by its matrix: here moved 100 right.
  assert.equal(paintColorAt({ ...axial, matrix: [1, 0, 0, 1, 100, 0] }, 100, 0), 0xff0000);
  const radial = { kind: 'radial' as const, matrix: axial.matrix, x0: 50, y0: 50, r0: 0, x1: 50, y1: 50, r1: 50, stops, extend: axial.extend };
  assert.equal(paintColorAt(radial, 50, 50), 0xff0000);
  assert.equal(paintColorAt(radial, 100, 50), 0x0000ff);
  assert.equal(paintColor(radial), 0x800080);
});

test('outlined text: with paths, a stroked run says how it is stroked and where it comes among the shapes', () => {
  const doc = PdfDocument.create();
  const page = doc.addPage([200, 100]);
  const f = page.addResource('Font', doc.standardFont('Helvetica').ref, 'F');
  page.setContent(
    ascii(
      [
        '0 0 1 RG 2 w',
        `BT /${f} 20 Tf 1 0 0 rg 1 Tr 10 70 Td (halo) Tj ET`, // stroked only
        '0 1 0 rg 0 0 10 10 re f', // a shape after it
        `BT /${f} 20 Tf 1 0 0 rg 2 Tr 10 40 Td (both) Tj ET`, // filled and stroked
        `BT /${f} 20 Tf 0 Tr 10 10 Td (plain) Tj ET`,
      ].join('\n'),
    ),
  );
  const display = interpretPage(page, { paths: true });
  const byText = (t: string) => display.glyphRuns.find((r) => r.glyphs.map((g) => g.unicode).join('') === t)!;
  const halo = byText('halo').stroke!;
  assert.deepEqual([halo.color, halo.width, halo.only], [0x0000ff, 2, true]);
  assert.equal(byText('halo').color, 0x0000ff, 'stroke-only text still reports the stroke color as its color');
  const both = byText('both');
  assert.deepEqual([both.color, both.stroke!.only], [0xff0000, false]);
  assert.equal(byText('plain').stroke, undefined);
  // In painting order with the shape between them.
  const square = display.paths.find((p) => p.fill?.color === 0x00ff00)!;
  assert.ok(halo.order < square.order && square.order < both.stroke!.order);
  // Without paths, nothing changes.
  assert.equal(interpretPage(page).glyphRuns.some((r) => r.stroke), false);
});
