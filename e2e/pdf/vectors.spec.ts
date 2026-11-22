import { expect, test } from '../fixtures';
import { look } from '../layout/helpers';
import { assemble, openPdf, showPage } from './helpers';

// A PDF's vector art in the page view: a shape filled with a gradient pattern (how a browser writes a banner or a
// swoosh) and a curved shape, both drawn as pictures of the page rather than left out or cut into strips.

/** A 400 x 300 page: a red-to-blue gradient band across y 200..260 (from the bottom) and a green circle at (100, 100), radius 40. */
function vectorPdf(): Buffer {
  const k = 0.5523 * 40;
  const circle = [`140 100 m`, `140 ${100 + k} ${100 + k} 140 100 140 c`, `${100 - k} 140 60 ${100 + k} 60 100 c`, `60 ${100 - k} ${100 - k} 60 100 60 c`, `${100 + k} 60 140 ${100 - k} 140 100 c`, 'f'].join(' ');
  const content = ['/Pattern cs /P scn 50 200 300 60 re f', `0 0.6 0 rg ${circle}`].join('\n');
  return assemble([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Pattern << /P 5 0 R >> >> /Contents 4 0 R >>',
    ['<< >>', content],
    '<< /PatternType 2 /Shading << /ShadingType 2 /ColorSpace /DeviceRGB /Coords [50 0 350 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> /Extend [true true] >> >>',
  ]);
}

test('a gradient-filled shape and a curve are drawn on the page', async ({ app }) => {
  await openPdf(app, vectorPdf(), 'vectors.pdf');
  const at = await showPage(app.page);
  // Points from the page's top left: the band's left and right ends, the circle's middle, and just outside it.
  const points = await Promise.all([at(60, 70), at(340, 70), at(100, 200), at(150, 200)]);
  const box = { x: 0, y: 0, width: app.page.viewportSize()!.width, height: app.page.viewportSize()!.height };
  await expect
    .poll(async () => {
      const [left, right, middle, outside] = await look<number[][]>(app.page, box, 'points', points.map((p) => [p.x, p.y]));
      return {
        leftRed: left[0] > 180 && left[2] < 90,
        rightBlue: right[2] > 180 && right[0] < 90,
        middleGreen: middle[1] > 120 && middle[0] < 60 && middle[2] < 60,
        outsideWhite: outside.every((c) => c > 230),
      };
    })
    .toEqual({ leftRed: true, rightBlue: true, middleGreen: true, outsideWhite: true });
});
