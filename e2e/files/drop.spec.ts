// Dragging a file from the desktop onto the window: documents open, pictures ask whether to go in
// the open document or open on their own.

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { blankWith, buildPng, dropFile, formatLabel, importFile, readZip, status, text, waitForOpen } from './helpers';

const choice = (page: Page, name: string) => page.getByRole('dialog', { name: `What should be done with ${name}?` });

test('dropping a text file opens it', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, text('dropped.txt', 'from the desktop'));
  await waitForOpen(app, 'dropped.txt');
  expect(await app.text()).toBe('from the desktop');
  expect(await formatLabel(page)).toBe('Plain Text');
});

test('dropping a Markdown file, a CSV and an HTML page opens each in its own format', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, text('one.md', '# One'));
  await waitForOpen(app, 'one.md');
  expect(await formatLabel(page)).toBe('Markdown');
  await dropFile(page, text('two.csv', 'a,b\n1,2\n'));
  await waitForOpen(app, 'two.csv');
  expect(await formatLabel(page)).toBe('CSV (Comma-Separated)');
  await dropFile(page, text('three.html', '<p>Three</p>'));
  await waitForOpen(app, 'three.html');
  expect(await formatLabel(page)).toBe('Web Page');
  expect(await app.text()).toBe('Three');
});

test('dropping a Word document opens it', async ({ app, page }) => {
  // Made by the app itself: download a document, then drop the file.
  await blankWith(app, 'Word from a drop');
  const file = await app.download(() => app.menu('File', 'Download'));
  await dropFile(page, { name: 'fromdrop.docx', buffer: file.bytes });
  await waitForOpen(app, 'fromdrop.docx');
  expect(await app.text()).toBe('Word from a drop');
});

test('the document that was open is kept when another is dropped on it', async ({ app, page }) => {
  await blankWith(app, 'work in progress');
  await dropFile(page, text('other.txt', 'other'));
  await waitForOpen(app, 'other.txt');
  await app.menu('File', 'Open Recent');
  await expect(page.getByRole('menu').last().getByRole('menuitem', { name: /Document1/ })).toBeVisible();
});

test('dropping a picture on a document asks whether to insert it or open it', async ({ app, page }) => {
  await blankWith(app, 'A document');
  await dropFile(page, { name: 'photo.png', buffer: buildPng(40, 30), mimeType: 'image/png' });
  const popup = choice(page, 'photo.png');
  await expect(popup).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Insert in the document' })).toBeFocused();
  await expect(popup.getByRole('button', { name: 'Open as a picture' })).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Cancel' })).toBeVisible();
});

test('choosing Insert puts the picture in the document', async ({ app, page }) => {
  await blankWith(app, 'A document');
  await dropFile(page, { name: 'photo.png', buffer: buildPng(40, 30), mimeType: 'image/png' });
  await choice(page, 'photo.png').getByRole('button', { name: 'Insert in the document' }).click();
  await expect(choice(page, 'photo.png')).toBeHidden();
  // Still the same document, now with a picture in it.
  expect(await formatLabel(page)).toBe('Word Document');
  await expect(page).toHaveTitle('Document1 - Golem Docs');
  const file = await app.download(() => app.menu('File', 'Download'));
  const media = readZip(file.bytes).filter((f) => f.name.startsWith('word/media/'));
  expect(media.length).toBe(1);
  expect([...media[0]!.bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
});

test('choosing Open opens the picture as a document of its own', async ({ app, page }) => {
  await blankWith(app, 'A document');
  await dropFile(page, { name: 'photo.png', buffer: buildPng(40, 30), mimeType: 'image/png' });
  await choice(page, 'photo.png').getByRole('button', { name: 'Open as a picture' }).click();
  await waitForOpen(app, 'photo.png');
  expect(await formatLabel(page)).toBe('PNG Image');
});

test('Cancel, Escape and a click elsewhere all dismiss the picture question and change nothing', async ({ app, page }) => {
  await blankWith(app, 'Untouched');
  const drop = () => dropFile(page, { name: 'photo.png', buffer: buildPng(40, 30), mimeType: 'image/png' });

  await drop();
  await choice(page, 'photo.png').getByRole('button', { name: 'Cancel' }).click();
  await expect(choice(page, 'photo.png')).toBeHidden();

  await drop();
  await expect(choice(page, 'photo.png')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(choice(page, 'photo.png')).toBeHidden();

  await drop();
  await expect(choice(page, 'photo.png')).toBeVisible();
  await page.mouse.click(1100, 600);
  await expect(choice(page, 'photo.png')).toBeHidden();

  expect(await formatLabel(page)).toBe('Word Document');
  expect(await app.text()).toBe('Untouched');
});

test('a picture dropped on a Markdown document opens as a picture, since Markdown holds no pictures', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await importFile(app, text('notes.md', '# Notes'));
  await dropFile(page, { name: 'photo.png', buffer: buildPng(20, 20), mimeType: 'image/png' });
  await waitForOpen(app, 'photo.png');
  expect(await formatLabel(page)).toBe('PNG Image');
  await expect(page.getByRole('dialog', { name: /What should be done/ })).toHaveCount(0);
});

test('a picture dropped on a picture opens as a picture', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await importFile(app, { name: 'first.png', buffer: buildPng(20, 20) });
  await dropFile(page, { name: 'second.png', buffer: buildPng(30, 20, [10, 120, 200]), mimeType: 'image/png' });
  await waitForOpen(app, 'second.png');
  await expect(page.getByRole('dialog', { name: /What should be done/ })).toHaveCount(0);
});

test('an SVG dropped on a document is offered the same choice', async ({ app, page }) => {
  await blankWith(app, 'Vector');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="8"/></svg>';
  await dropFile(page, { name: 'dot.svg', buffer: Buffer.from(svg), mimeType: 'image/svg+xml' });
  await expect(choice(page, 'dot.svg')).toBeVisible();
  await choice(page, 'dot.svg').getByRole('button', { name: 'Open as a picture' }).click();
  // An SVG opens as a vector drawing of its own kind, not as a picture.
  await waitForOpen(app, 'dot.svg');
  expect(await formatLabel(page)).toBe('SVG Drawing');
});

test('dropping a file of a type that cannot be opened says so and keeps the document', async ({ app, page }) => {
  await blankWith(app, 'Keep me');
  await dropFile(page, { name: 'archive.bin', buffer: Buffer.from([0, 255, 0, 1, 2, 3, 0, 0, 9]) });
  await expect.poll(() => status(page)).toBe('Opening BIN files isn’t supported yet (archive.bin)');
  await app.focus();
  expect(await app.text()).toBe('Keep me');
});

test('several files dropped together are all imported, and the open document stays', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['first file'], 'a.txt'));
    dt.items.add(new File(['second file'], 'b.txt'));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: 300, clientY: 300, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => status(page)).toContain('Imported documents: 2');
  expect(await page.title()).toMatch(/^Welcome/);
  await app.menu('File', 'Open Recent');
  const recent = page.getByRole('menu').last();
  await expect(recent.getByRole('menuitem', { name: /a\.txt/ })).toBeVisible();
  await expect(recent.getByRole('menuitem', { name: /b\.txt/ })).toBeVisible();
});

test('dropping something that is not a file (dragged text) does nothing', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'just some text');
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await app.settle();
  await expect(page).toHaveTitle('Welcome to Golem Docs - Golem Docs');
});
