import { test, expect } from '../fixtures';
import { makePdf, openPdf, showPage, editMode, clickOnPage, decodePdf } from './helpers';

for (const [name, extra] of [['A', 'q\n1 0 0 rg\n50 50 100 40 re\nf\nQ'], ['B', '1 0 0 rg\n50 50 100 40 re\nf'], ['C', 'q 1 0 0 rg 50 50 100 40 re f Q']]) {
  test('probe ' + name, async ({ app }) => {
    await openPdf(app, makePdf({ pages: [[{ text: 'Hello PDF world', x: 40, y: 240, size: 18 }]], extraContent: extra }));
    await showPage(app.page, 0);
    await editMode(app.page);
    await clickOnPage(app.page, 0, 100, 230);
    const f = app.page.locator('.wm-pdftools-frame');
    await expect(f).toBeVisible();
    const scale = (await app.page.evaluate(() => (window as any).camera.zoom)) * 96 / 72;
    const box = (await f.boundingBox())!;
    const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await app.page.mouse.move(c.x, c.y);
    await app.page.mouse.down();
    await app.page.mouse.move(c.x + 100 * scale, c.y - 50 * scale, { steps: 5 });
    await app.page.mouse.up();
    await app.page.waitForTimeout(1500);
    const d = await app.download(() => app.menu('File', 'Download'));
    const t = decodePdf(d.bytes);
    console.log('CONTENT', name, t.split('\n').filter((l) => /\bre\b|\bcm\b/.test(l)).join(' ; '));
  });
}
