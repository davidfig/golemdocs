// Dragging a picture from the Files sidebar onto an open document asks whether to insert the picture or a link to it.

import type { Page } from '@playwright/test';
import fs from 'node:fs';
import { expect, test } from './fixtures';
import { blankWith, buildPng, importFile, waitForSaved, readZip } from './helpers';

const row = (page: Page, name: string) => page.locator('.wm-files .wm-files-file', { hasText: name });

for (const [name, buffer] of [['photo.png', buildPng(40, 30)], ['dot.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="8"/></svg>')], ['shot.jpg', fs.readFileSync('./pdf/test/fixtures/img-cmyk.jpg')]] as const) {
  test(`a ${name} dragged from the Files sidebar onto a Word document is asked about, and Insert puts the picture in`, async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await blankWith(app, 'A document');
    await waitForSaved(page, 'Document1.docx');
    await importFile(app, { name, buffer });
    await waitForSaved(page, name);
    await app.menu('View', 'Files Sidebar');
    await row(page, 'Document1').click();
    await expect.poll(() => app.text()).toContain('A document');
    const box = (await page.locator('#viewport canvas').first().boundingBox())!;
    await row(page, name).dragTo(page.locator('#viewport canvas').first(), { targetPosition: { x: box.width / 2, y: 120 } });
    const popup = page.getByRole('dialog', { name: `What should be done with ${name}?` });
    await expect(popup).toBeVisible();
    await popup.getByRole('button', { name: 'Insert in the document' }).click();
    await expect(popup).toBeHidden();
    const file = await app.download(() => app.menu('File', 'Download'));
    expect(readZip(file.bytes).filter((f) => f.name.startsWith('word/media/'))).not.toHaveLength(0);
  });
}

test('a picture that was cropped in the picture tools can be dragged in too', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await blankWith(app, 'A document');
  await waitForSaved(page, 'Document1.docx');
  await importFile(app, { name: 'edited.jpg', buffer: fs.readFileSync('./pdf/test/fixtures/img-cmyk.jpg') });
  await app.menu('Picture', 'Crop…');
  await page.locator('.wm-crop').getByRole('button', { name: 'Crop', exact: true }).click();
  await waitForSaved(page, 'edited.jpg');
  await app.menu('View', 'Files Sidebar');
  await row(page, 'Document1').click();
  await expect.poll(() => app.text()).toContain('A document');
  const box = (await page.locator('#viewport canvas').first().boundingBox())!;
  await row(page, 'edited.jpg').last().dragTo(page.locator('#viewport canvas').first(), { targetPosition: { x: box.width / 2, y: 120 } });
  const popup = page.getByRole('dialog', { name: 'What should be done with edited.jpg?' });
  await popup.getByRole('button', { name: 'Insert in the document' }).click();
  await expect(popup).toBeHidden();
  const file = await app.download(() => app.menu('File', 'Download'));
  expect(readZip(file.bytes).filter((f) => f.name.startsWith('word/media/'))).not.toHaveLength(0);
});

test('a HEIC photo, cropped, can be dragged in too', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await blankWith(app, 'A document');
  await waitForSaved(page, 'Document1.docx');
  await importFile(app, { name: 'edited.heic', buffer: fs.readFileSync('./client/test/fixtures/photo-turned.heic') });
  await app.menu('Picture', 'Crop…');
  await page.locator('.wm-crop').getByRole('button', { name: 'Crop', exact: true }).click();
  await waitForSaved(page, 'edited.jpg');
  await app.menu('View', 'Files Sidebar');
  await row(page, 'Document1').click();
  await expect.poll(() => app.text()).toContain('A document');
  const box = (await page.locator('#viewport canvas').first().boundingBox())!;
  await row(page, 'edited.jpg').last().dragTo(page.locator('#viewport canvas').first(), { targetPosition: { x: box.width / 2, y: 120 } });
  const popup = page.getByRole('dialog', { name: 'What should be done with edited.jpg?' });
  await popup.getByRole('button', { name: 'Insert in the document' }).click();
  await expect(popup).toBeHidden();
  const file = await app.download(() => app.menu('File', 'Download'));
  expect(readZip(file.bytes).filter((f) => f.name.startsWith('word/media/'))).not.toHaveLength(0);
});
