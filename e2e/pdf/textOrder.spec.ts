import { expect, test } from '../fixtures';
import { look } from '../layout/helpers';
import { assemble, openPdf, showPage } from './helpers';

// Text over text in another font keeps the order the page painted it in: a white caption over the dark halo a browser
// writes as a second font (a Type 3 font of the stroked letters) stays white. The page view draws text a face at a time,
// so without layers whichever font's atlas came last would end up on top.

/**
 * A 400 x 300 page with two capital I's at 300 points, each a black one with a white one painted over it in the other font:
 * Helvetica under Times on the left, Times under Helvetica on the right. Their stems overlap 0.10 to 0.21 em from the origin.
 */
function overlapPdf(): Buffer {
  const letter = (font: string, gray: number, x: number) => `BT /${font} 300 Tf ${gray} g ${x} 40 Td (I) Tj ET`;
  const content = [letter('H', 0, 40), letter('T', 1, 40), letter('T', 0, 220), letter('H', 1, 220)].join('\n');
  return assemble([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /H 5 0 R /T 6 0 R >> >> /Contents 4 0 R >>',
    ['<< >>', content],
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>',
  ]);
}

test('text painted over text in another font stays on top', async ({ app }) => {
  await openPdf(app, overlapPdf(), 'overlap.pdf');
  const at = await showPage(app.page);
  // 0.155 em right of each origin and 0.35 em above the baseline (y 40 from the bottom): inside both stems.
  // And 0.25 em right on the right: the black Times stem alone, so the black letters are drawn at all.
  const points = await Promise.all([at(40 + 46.5, 300 - 40 - 105), at(220 + 46.5, 300 - 40 - 105), at(220 + 75, 300 - 40 - 105)]);
  const box = { x: 0, y: 0, width: app.page.viewportSize()!.width, height: app.page.viewportSize()!.height };
  await expect
    .poll(async () => {
      const [left, right, under] = await look<number[][]>(app.page, box, 'points', points.map((p) => [p.x, p.y]));
      return { leftWhite: left.every((c) => c > 200), rightWhite: right.every((c) => c > 200), underBlack: under.every((c) => c < 60) };
    })
    .toEqual({ leftWhite: true, rightWhite: true, underBlack: true });
});
