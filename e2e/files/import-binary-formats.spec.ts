// File ▸ Import… with the binary formats: Word (hand-built and legacy .doc), pictures, and their menus.

import { expect, test } from './fixtures';
import { buildDocx, buildPng, fixture, formatLabel, hasItem, importFile, menuContents, status, text, waitForOpen } from './helpers';

test('a Word document opens with its paragraphs', async ({ app }) => {
  await app.goto('?doc=welcome');
  await importFile(app, { name: 'letter.docx', buffer: buildDocx(['Dear reader', 'First paragraph.', 'Second paragraph.'], 'Dear reader') });
  expect(await app.text()).toBe('Dear reader\nFirst paragraph.\nSecond paragraph.');
  expect(await formatLabel(app.page)).toBe('Word Document');
  await expect(app.page).toHaveTitle('letter.docx - Golem Docs');
  // Word documents get the full set of menus.
  const insert = await menuContents(app, 'Insert');
  for (const item of ['Picture', 'Table', 'Comment', 'Footnote', 'Equation']) expect(hasItem(insert, item)).toBe(true);
  expect(hasItem(await menuContents(app, 'Format'), 'Borders and Shading')).toBe(true);
});

test('a Word document with no text opens as an empty document', async ({ app }) => {
  await app.goto('?doc=welcome');
  await importFile(app, { name: 'empty.docx', buffer: buildDocx([]) });
  expect(await app.text()).toBe('');
  expect(await formatLabel(app.page)).toBe('Word Document');
});

test('a damaged Word document reports an error and keeps the current document', async ({ app }) => {
  await app.goto('?doc=welcome');
  const [chooser] = await Promise.all([app.page.waitForEvent('filechooser'), app.menu('File', 'Import…')]);
  await chooser.setFiles({ name: 'broken.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('this is not a zip file at all') });
  await expect.poll(() => status(app.page), { timeout: 20_000 }).toContain('broken.docx');
  await expect.poll(() => status(app.page)).not.toContain('laying out');
});

const LEGACY: [string, string][] = [
  ['word97.doc', 'Report Title\nIntro with bold, italic, a link and code.'],
  ['textutil.doc', 'Main Title\nPlain paragraph with bold, italic, underline, strike, red, x2 and H2O.'],
  ['picture.doc', 'Before'],
];
for (const [name, start] of LEGACY) {
  test(`a legacy Word 97 file (${name}) opens as a Word document with its text`, async ({ app }) => {
    await app.goto('?doc=welcome');
    await importFile(app, fixture(name));
    expect(await formatLabel(app.page)).toBe('Word Document');
    // Select All can land before the imported text has been laid out.
    await expect.poll(() => app.text()).toContain(start);
  });
}

test('a PNG opens as a picture document with picture tools and no text formatting', async ({ app }) => {
  await app.goto('?doc=welcome');
  await importFile(app, { name: 'red.png', buffer: buildPng(60, 40) });
  expect(await formatLabel(app.page)).toBe('PNG Image');
  await expect(app.page).toHaveTitle('red.png - Golem Docs');
  const picture = await menuContents(app, 'Picture');
  expect(picture?.items).toEqual(expect.arrayContaining(['Rotate Left', 'Crop…', 'Resize…', 'Grayscale']));
  expect(await menuContents(app, 'Format')).toBeNull();
  expect(await menuContents(app, 'Table')).toBeNull();
  expect(hasItem(await menuContents(app, 'Insert'), 'Picture')).toBe(false);
});

test('an SVG opens as a vector drawing', async ({ app }) => {
  await app.goto('?doc=welcome');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="30"><rect width="50" height="30" fill="#2a8"/></svg>';
  await importFile(app, text('shape.svg', svg));
  expect(await formatLabel(app.page)).toBe('SVG Drawing');
  await expect(app.page).toHaveTitle('shape.svg - Golem Docs');
});

test('a picture that is not a picture is refused', async ({ app }) => {
  await app.goto('?doc=welcome');
  const [chooser] = await Promise.all([app.page.waitForEvent('filechooser'), app.menu('File', 'Import…')]);
  await chooser.setFiles({ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('not really a png') });
  await expect.poll(() => status(app.page)).toContain('Opening PNG files isn’t supported yet (fake.png)');
  await waitForOpen(app, 'Welcome to Golem Docs');
});

test('a picture made from a document downloads as a PNG and opens again', async ({ app }) => {
  await app.blank();
  await app.type('Picture me');
  await app.menu('File', 'Convert To', 'PNG Image (.png)');
  await expect.poll(() => formatLabel(app.page)).toBe('PNG Image');
  await app.ready();
  const file = await app.download(() => app.menu('File', 'Download'));
  expect(file.name).toBe('Document1.png');
  expect([...file.bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await importFile(app, { name: 'again.png', buffer: file.bytes });
  expect(await formatLabel(app.page)).toBe('PNG Image');
});
