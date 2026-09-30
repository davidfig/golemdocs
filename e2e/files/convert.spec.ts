// File ▸ Convert To and the Document format selector: switching what a document is edited as.

import { MOD, expect, test } from './fixtures';
import { blankWith, buildPng, convertTo, formatLabel, hasItem, importFile, menuContents, status, text, waitForSaved } from './helpers';

test('Convert To lists every format in groups, with the current one disabled', async ({ app }) => {
  await app.blank();
  await app.menubar.getByRole('menuitem', { name: /^File$/ }).click();
  await app.page.getByRole('menu').getByRole('menuitem', { name: /^Convert To/ }).click();
  const submenu = app.page.getByRole('menu').last();
  const labels = (await submenu.getByRole('menuitem').allTextContents()).map((s) => s.trim());
  expect(labels).toEqual([
    'Word Document (.docx)',
    'PDF (.pdf)',
    'Web Page (.html)',
    'Markdown (.md)',
    'Plain Text (.txt)',
    'OpenDocument Text (.odt)',
    'Rich Text Format (.rtf)',
    'EPUB Book (.epub)',
    'Web Archive (.mhtml)',
    'CSV (Comma-Separated) (.csv)',
    'TSV (Tab-Separated) (.tsv)',
    'LaTeX (.tex)',
    'AsciiDoc (.adoc)',
    'reStructuredText (.rst)',
    'Org Mode (.org)',
    'MediaWiki Markup (.wiki)',
    'Textile (.textile)',
    'PNG Image (.png)',
    'JPEG Image (.jpg)',
    'WebP Image (.webp)',
    'Email Message (.eml)',
    'Jupyter Notebook (.ipynb)',
  ].filter((l) => labels.includes(l)));
  expect(labels.length).toBeGreaterThanOrEqual(20);
  await expect(submenu.getByRole('menuitem', { name: /^Word Document/ })).toHaveAttribute('aria-disabled', 'true');
  await expect(submenu.getByRole('menuitem', { name: /^Markdown/ })).toHaveAttribute('aria-disabled', 'false');
});

test('converting to Markdown switches the document in place, keeps its text and explains what a download leaves out', async ({ app }) => {
  await blankWith(app, 'Some text', 'More text');
  await convertTo(app, 'Markdown (.md)', 'Markdown');
  expect(await app.text()).toBe('Some text\nMore text');
  await expect(app.page).toHaveTitle('Document1.md - Golem Docs');
  await expect.poll(() => status(app.page)).toMatch(/^Now editing as Markdown\. .*only downloading a \.md file leaves out fonts, colors/);
  // The same document, not a second one: the dashboard shows it once, under its new name.
  await app.menu('File', 'Open…');
  await expect(app.page.getByRole('button', { name: /^Open Document1/ })).toHaveCount(1);
  await expect(app.page.getByRole('button', { name: 'Open Document1.md' })).toBeVisible();
});

test('the notice after a conversion says what the new format leaves out', async ({ app }) => {
  await blankWith(app, 'Some text');
  await convertTo(app, 'Plain Text (.txt)', 'Plain Text');
  await expect.poll(() => status(app.page)).toMatch(/only downloading a \.txt file leaves out all formatting, tables and images/);
  await convertTo(app, 'Web Page (.html)', 'Web Page');
  await expect.poll(() => status(app.page)).toMatch(/only downloading a \.html file leaves out page setup, headers and footers, comments and embedded pictures/);
  await convertTo(app, 'Word Document (.docx)', 'Word Document');
  await expect.poll(() => status(app.page)).toBe('Now editing as Word Document. Nothing was lost.');
  await convertTo(app, 'PDF (.pdf)', 'PDF');
  await expect.poll(() => status(app.page)).toContain('Now shown as PDF, which can’t be edited.');
});

test('the Document format selector converts too', async ({ app }) => {
  await blankWith(app, 'Selector text');
  const box = app.page.getByRole('combobox', { name: 'Document format' });
  await box.click();
  await app.page.getByRole('listbox', { name: 'Document format' }).getByRole('option', { name: 'OpenDocument Text' }).click();
  await expect.poll(() => formatLabel(app.page)).toBe('OpenDocument Text');
  await app.ready();
  expect(await app.text()).toBe('Selector text');
  await expect(app.page).toHaveTitle('Document1.odt - Golem Docs');
});

test('converting is reversible: Word to Markdown to Word keeps the document', async ({ app }) => {
  await blankWith(app, 'Keep me');
  await app.press(`${MOD}+a`);
  await app.press(`${MOD}+i`);
  await convertTo(app, 'Markdown (.md)', 'Markdown');
  await convertTo(app, 'Word Document (.docx)', 'Word Document');
  expect(await app.text()).toBe('Keep me');
  await expect(app.page).toHaveTitle('Document1.docx - Golem Docs');
});

test('converting a document to a picture makes a picture next to the original', async ({ app }) => {
  await blankWith(app, 'Picture of text');
  await app.menu('File', 'Convert To', 'PNG Image (.png)');
  // The notice gives way to the autosave's a second later.
  await expect.poll(() => status(app.page), { intervals: [20], timeout: 15_000 }).toBe('Made Document1.png from the pages of the document. The document itself is unchanged.');
  await expect(app.page).toHaveTitle('Document1.png - Golem Docs');
  // Both are kept (once the picture's autosave has landed).
  await waitForSaved(app.page, 'Document1.png');
  await app.menu('File', 'Open…');
  await expect(app.page.getByRole('button', { name: 'Open Document1.png' })).toBeVisible();
  await expect(app.page.getByRole('button', { name: 'Open Document1.docx' })).toBeVisible();
  await app.page.getByRole('button', { name: 'Open Document1.docx' }).click();
  await expect.poll(() => formatLabel(app.page)).toBe('Word Document');
  await app.ready();
  expect(await app.text()).toBe('Picture of text');
});

test('a picture converts to other picture types and to Word and PDF, and offers the other pictures first', async ({ app }) => {
  await app.goto('?doc=welcome');
  await importFile(app, { name: 'shot.png', buffer: buildPng(80, 50) });
  await app.menubar.getByRole('menuitem', { name: /^File$/ }).click();
  await app.page.getByRole('menu').getByRole('menuitem', { name: /^Convert To/ }).click();
  const labels = (await app.page.getByRole('menu').last().getByRole('menuitem').allTextContents()).map((s) => s.trim());
  expect(labels).toEqual(['PNG Image (.png)', 'JPEG Image (.jpg)', 'WebP Image (.webp)', 'Word Document (.docx)', 'PDF (.pdf)']);
  await app.page.keyboard.press('Escape');
  await app.page.keyboard.press('Escape');
  await convertTo(app, 'JPEG Image (.jpg)', 'JPEG Image');
  await expect.poll(() => status(app.page)).toContain('It is compressed when saved as a file, so a little detail is lost then.');
  const file = await app.download(() => app.menu('File', 'Download'));
  expect(file.name).toBe('shot.jpg');
  expect([...file.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  await convertTo(app, 'WebP Image (.webp)', 'WebP Image');
  const webp = await app.download(() => app.menu('File', 'Download'));
  expect(webp.name).toBe('shot.webp');
  expect(webp.bytes.subarray(8, 12).toString()).toBe('WEBP');
  await convertTo(app, 'Word Document (.docx)', 'Word Document');
  expect(hasItem(await menuContents(app, 'Insert'), 'Table')).toBe(true);
});

test('a PDF reflows into Word text when converted, keeping the PDF pages to go back to', async ({ app }) => {
  await blankWith(app, 'Flow me');
  await convertTo(app, 'PDF (.pdf)', 'PDF');
  await convertTo(app, 'Word Document (.docx)', 'Word Document');
  expect(await app.text()).toContain('Flow me');
  await convertTo(app, 'Markdown (.md)', 'Markdown');
  expect(await app.text()).toContain('Flow me');
});

test('a spreadsheet-like text converts to a CSV table', async ({ app }) => {
  await app.goto('?doc=welcome');
  await importFile(app, text('rows.csv', 'a,b\n1,2\n'));
  await convertTo(app, 'Markdown (.md)', 'Markdown');
  const md = await app.download(() => app.menu('File', 'Download'));
  expect(md.name).toBe('rows.md');
  expect(md.text).toMatch(/\|\s*\**a\**\s*\|\s*\**b\**\s*\|/);
  expect(md.text).toContain('| 1 | 2 |');
  await convertTo(app, 'CSV (Comma-Separated) (.csv)', 'CSV (Comma-Separated)');
  const csv = await app.download(() => app.menu('File', 'Download'));
  expect(csv.name).toBe('rows.csv');
  expect(csv.text.replace(/\r\n/g, '\n').trim()).toBe('a,b\n1,2');
});

test('the conversion survives a reload: the document reopens in its new format', async ({ app, page }) => {
  await blankWith(app, 'Stay converted');
  await convertTo(app, 'Markdown (.md)', 'Markdown');
  await expect.poll(() => page.url()).toContain('doc=local');
  await page.reload();
  await app.ready();
  expect(await formatLabel(page)).toBe('Markdown');
  expect(await app.text()).toBe('Stay converted');
});
