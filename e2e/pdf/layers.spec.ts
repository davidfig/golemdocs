import { expect, test } from '../fixtures';
import { look } from '../layout/helpers';
import { assemble, openPdf, showPage } from './helpers';

// A poster as a browser prints one: a photo taller than the page, a fade over it (a tiling pattern whose cell is an image),
// a solid panel over its foot, and a logo and lettering over the panel. Each is seen where the page paints it.

const image = (rgb: string, rest = ''): [string, string] => [`<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode ${rest} >>`, `${rgb}>`];

function posterPdf(): Buffer {
  const content = [
    '.5 0 0 -.5 0 300 cm',
    'q 0 0 800 600 re W* n',
    'q 800 0 0 -720 0 500 cm /Photo Do Q',
    '/Pattern cs /Fade scn 0 300 800 100 re f',
    '.2 .2 .2 rg 0 400 800 200 re f',
    'q 100 0 0 -100 650 550 cm /Logo Do Q',
    '1 1 0 rg BT /F1 160 Tf 1 0 0 -1 40 550 Tm (III) Tj ET',
    'Q',
  ].join('\n');
  return assemble([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >> >> /XObject << /Photo 5 0 R /Logo 6 0 R >> /Pattern << /Fade 7 0 R >> >> /Contents 4 0 R >>',
    ['<< >>', content],
    image('ff0000'),
    image('00ff00'),
    // Blue, half see-through: purple over the photo.
    ['<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 400 300] /XStep 402 /YStep 302 /Matrix [1 0 0 -1 0 300] /Resources << /XObject << /X 8 0 R >> >> >>', 'q 400 0 0 -300 0 300 cm /X Do Q'],
    image('0000ff', '/SMask 9 0 R'),
    ['<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode >>', '80>'],
  ]);
}

test('a photo, a fade, a panel, a logo and lettering are drawn in the order the page paints them, inside the page', async ({ app }) => {
  await openPdf(app, posterPdf(), 'poster.pdf');
  const at = await showPage(app.page);
  const spots = await Promise.all([at(200, -15), at(200, 50), at(200, 175), at(250, 250), at(350, 250), at(200, 215)]);
  const row = await Promise.all([at(20, 250), at(150, 250)]);
  const box = { x: 0, y: 0, width: app.page.viewportSize()!.width, height: app.page.viewportSize()!.height };
  await expect
    .poll(async () => {
      const [above, photo, fade, panel, logo, top] = await look<number[][]>(app.page, box, 'points', spots.map((p) => [p.x, p.y]));
      const text = await look<number[][]>(app.page, box, 'row', { y: row[0].y, from: row[0].x, to: row[1].x });
      const near = (p: number[], q: number[]): boolean => p.every((v, i) => Math.abs(v - q[i]) < 12);
      return {
        outside: near(above, [255, 0, 0]),
        photo: near(photo, [255, 0, 0]),
        fade: near(fade, [127, 0, 128]),
        panel: near(panel, [51, 51, 51]) && near(top, [51, 51, 51]),
        logo: near(logo, [0, 255, 0]),
        text: text.some((p) => near(p, [255, 255, 0])),
      };
    })
    .toEqual({ outside: false, photo: true, fade: true, panel: true, logo: true, text: true });
});
