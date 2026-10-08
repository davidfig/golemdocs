import { expect, test } from '../fixtures';
import { look, pictureBox } from '../layout/helpers';
import { clickOnPage, decodePdf, dragOnPage, editMode, makeEncryptedPdf, makePdf, makeScanPdf, modeButton, openPdf, pageCount, readBack, selectBetween, showPage, tool } from './helpers';

const sample = () =>
  makePdf({
    pages: [
      [
        { text: 'Hello PDF world', x: 40, y: 240, size: 18 },
        { text: 'Second line of text', x: 40, y: 200, size: 18 },
      ],
    ],
  });

type App = import('../fixtures').App;
const formatBox = (app: App) => app.page.locator('.wm-format-field input');

test.describe('Convert To, from a PDF', () => {
  test.beforeEach(async ({ app }) => openPdf(app, sample()));

  test('Word Document makes it an editable document with the PDF text', async ({ app }) => {
    await app.menu('File', 'Convert To', 'Word Document');
    await expect(formatBox(app)).toHaveValue('Word Document');
    await expect(app.page.locator('.wm-forms-palette')).toBeHidden();
    // The converted document is laid out a moment after the format changes.
    await expect.poll(() => app.text()).toContain('Hello PDF world');
    expect(await app.text()).toContain('Second line of text');
    // It is a real document now: typing works.
    await app.type('!');
    await expect.poll(() => app.text()).toContain('!');
  });

  test('Plain Text and Markdown carry the text over', async ({ app }) => {
    await app.menu('File', 'Convert To', 'Plain Text');
    await expect(formatBox(app)).toHaveValue('Plain Text');
    await expect.poll(() => app.text()).toContain('Hello PDF world');
    await app.menu('File', 'Convert To', 'Markdown');
    await expect(formatBox(app)).toHaveValue('Markdown');
    await expect.poll(() => app.text()).toContain('Second line of text');
  });

  test('converting back to PDF shows the original pages again', async ({ app }) => {
    await app.menu('File', 'Convert To', 'Word Document');
    await expect(formatBox(app)).toHaveValue('Word Document');
    await app.menu('File', 'Convert To', 'PDF');
    await expect(formatBox(app)).toHaveValue('PDF');
    await expect(app.page.locator('.wm-forms-palette')).toBeVisible();
    expect(await pageCount(app.page)).toBe(1);
  });

  test('downloading a PDF gives a .pdf file with the same pages', async ({ app }) => {
    const file = await app.download(() => app.menu('File', 'Download'));
    expect(file.name).toBe('sample.pdf');
    expect(file.text.startsWith('%PDF-')).toBe(true);
    expect(file.text).toContain('(Hello PDF world) Tj');
  });

  test('a document edited as Word downloads as .docx, not as the PDF', async ({ app }) => {
    await app.menu('File', 'Convert To', 'Word Document');
    await expect(formatBox(app)).toHaveValue('Word Document');
    const file = await app.download(() => app.menu('File', 'Download'));
    expect(file.name).toMatch(/\.docx$/);
    expect(file.bytes.subarray(0, 2).toString('latin1')).toBe('PK');
  });
});

test.describe('scanned and encrypted PDFs', () => {
  test('a scan (a page that is only a picture) opens, has no text to select, and its picture can be picked', async ({ app }) => {
    await openPdf(app, makeScanPdf());
    await showPage(app.page, 0);
    expect(await selectBetween(app.page, 0, [20, 20], [380, 280])).toBe('');
    await editMode(app.page);
    await expect(async () => {
      await clickOnPage(app.page, 0, 200, 150);
      await expect(app.page.locator('.wm-pdftools-frame')).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 15_000 });
    await expect(app.page.locator('.wm-forms-kind')).toHaveText(/Picture/);
    // No text to edit, but text can be added, and it is saved with the picture.
    await tool(app.page, 'text').click();
    // Choosing a tool puts the selected picture down; clicking the page before that has happened is lost.
    await expect(app.page.locator('.wm-pdftools-frame')).toBeHidden();
    await clickOnPage(app.page, 0, 60, 30);
    await expect(app.page.getByRole('textbox', { name: 'Edit text' })).toBeFocused();
    await app.page.keyboard.type('Scanned note');
    await app.page.keyboard.press('Escape');
    const bytes = (await app.download(() => app.menu('File', 'Download'))).bytes;
    expect(await readBack(app, bytes)).toContain('Scanned note');
  });

  test('a scan can be redacted: the picture under the box is covered', async ({ app }) => {
    await openPdf(app, makeScanPdf());
    await showPage(app.page, 0);
    await editMode(app.page);
    await tool(app.page, 'redact').click();
    await dragOnPage(app.page, 0, [40, 40], [360, 260]);
    const bytes = (await app.download(() => app.menu('File', 'Download'))).bytes;
    expect(decodePdf(bytes)).toMatch(/\b0 0 0 rg\b/);
  });

  test('an encrypted PDF opens with its text readable, and is saved unencrypted', async ({ app }) => {
    await openPdf(app, makeEncryptedPdf('Secret words'));
    await showPage(app.page, 0);
    expect(await selectBetween(app.page, 0, [20, 40], [300, 70])).toBe('Secret words');
    await modeButton(app.page, 'Edit PDF').click();
    await tool(app.page, 'rect').click();
    await clickOnPage(app.page, 0, 200, 200);
    const bytes = (await app.download(() => app.menu('File', 'Download'))).bytes;
    expect(bytes.toString('latin1')).not.toMatch(/\/Encrypt\b/);
    expect(await readBack(app, bytes)).toBe('Secret words');
  });
});

test.describe('vector art in a PDF', () => {
  test('becomes a drawing in the Word document: an SVG the editor paints, with a PNG beside it', async ({ app }) => {
    // A blue triangle, made of paths (no picture in the PDF).
    await openPdf(app, makePdf({ pages: [[{ text: 'Under the triangle', x: 40, y: 30, size: 14 }]], extraContent: '0 0.4 0.8 rg 100 60 m 300 60 l 200 240 l f' }));
    await app.menu('File', 'Convert To', 'Word Document');
    await expect(formatBox(app)).toHaveValue('Word Document');
    await app.page.waitForFunction(() => (window as unknown as { pages: { images: { svg?: string }[] }[] }).pages[0]?.images.some((i) => i.svg));
    const image = await app.page.evaluate(() => (window as unknown as { pages: { images: { part: string; svg?: string }[] }[] }).pages[0].images.find((i) => i.svg));
    expect(image?.part).toMatch(/\.png$/);
    expect(image?.svg).toMatch(/\.svg$/);
    // What is on screen is the triangle, drawn from the SVG: its lower middle is blue.
    const box = await pictureBox(app.page);
    await expect.poll(async () => (await look<number[][]>(app.page, box, 'points', [[box.x + 0.5 * box.width, box.y + 0.8 * box.height]]))[0]).toEqual([0, 102, 204]);
  });
});
