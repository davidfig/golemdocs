import { expect, test } from '../fixtures';
import { decodePdf, editMode, makePdf, modeButton, openPdf, pageBoxes, pageCount, selectBetween, showPage } from './helpers';

type App = import('../fixtures').App;

const threePages = () =>
  makePdf({
    pages: [
      [{ text: 'Alpha page', x: 40, y: 240, size: 18 }],
      [{ text: 'Bravo page', x: 40, y: 240, size: 18 }],
      [{ text: 'Charlie page', x: 40, y: 240, size: 18 }],
    ],
  });

const op = (app: App, name: string) => app.page.locator(`.wm-pdftools-pages button[data-op="${name}"]`);
const save = async (app: App) => (await app.download(() => app.menu('File', 'Download'))).bytes;

/** The first word of each page, read by selecting across it (in Fill In mode, where a drag selects text). */
async function pageTexts(app: App): Promise<string[]> {
  await modeButton(app.page, 'Fill In').click();
  const boxes = await pageBoxes(app.page);
  const out: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    await showPage(app.page, i);
    // Each drag starts a little further along, so that a quick run of them is never read as a double-click.
    out.push((await selectBetween(app.page, i, [15 + i * 8, 15 + i * 8], [boxes[i].width - 2, boxes[i].height - 2])).trim());
  }
  await editMode(app.page);
  return out;
}

test.describe('Edit PDF: pages', () => {
  test.beforeEach(async ({ app }) => {
    await openPdf(app, threePages());
    await editMode(app.page);
    await showPage(app.page, 1);
  });

  test('the page buttons are there in Edit PDF mode only', async ({ app }) => {
    for (const name of ['rotateLeft', 'rotateRight', 'moveUp', 'moveDown', 'insert', 'duplicate', 'delete']) await expect(op(app, name)).toBeVisible();
    await modeButton(app.page, 'Fill In').click();
    await expect(op(app, 'delete')).toBeHidden();
  });

  test('Insert Blank adds a page', async ({ app }) => {
    await op(app, 'insert').click();
    await expect.poll(() => pageCount(app.page)).toBe(4);
    const texts = await pageTexts(app);
    expect(texts.filter((t) => t === '')).toHaveLength(1);
    expect(texts.filter(Boolean)).toEqual(['Alpha page', 'Bravo page', 'Charlie page']);
  });

  test('Duplicate copies the page in the middle of the view', async ({ app }) => {
    await op(app, 'duplicate').click();
    await expect.poll(() => pageCount(app.page)).toBe(4);
    const texts = await pageTexts(app);
    expect(texts.filter((t) => t === 'Bravo page')).toHaveLength(2);
    expect(texts).toContain('Alpha page');
    expect(texts).toContain('Charlie page');
  });

  test('Delete Page removes the page in the middle of the view', async ({ app }) => {
    await op(app, 'delete').click();
    await expect.poll(() => pageCount(app.page)).toBe(2);
    expect(await pageTexts(app)).toEqual(['Alpha page', 'Charlie page']);
  });

  test('Move Up and Move Down change the order of the pages', async ({ app }) => {
    await op(app, 'moveUp').click();
    await expect.poll(async () => (await pageTexts(app)).join()).toBe('Bravo page,Alpha page,Charlie page');
    await showPage(app.page, 2);
    await op(app, 'moveUp').click();
    await expect.poll(async () => (await pageTexts(app)).join()).toBe('Bravo page,Charlie page,Alpha page');
    await showPage(app.page, 0);
    await op(app, 'moveDown').click();
    await expect.poll(async () => (await pageTexts(app)).join()).toBe('Charlie page,Bravo page,Alpha page');
  });

  test('Rotate Right turns the page a quarter turn, Rotate Left turns it back', async ({ app }) => {
    const before = (await pageBoxes(app.page))[1];
    await op(app, 'rotateRight').click();
    await expect.poll(async () => (await pageBoxes(app.page))[1].width).toBe(before.height);
    expect((await pageBoxes(app.page))[1].height).toBe(before.width);
    expect(decodePdf(await save(app))).toMatch(/\/Rotate 90\b/);
    await op(app, 'rotateLeft').click();
    await expect.poll(async () => (await pageBoxes(app.page))[1].width).toBe(before.width);
  });

  test('Undo takes a page operation back, across the new file it made', async ({ app }) => {
    await op(app, 'delete').click();
    await expect.poll(() => pageCount(app.page)).toBe(2);
    await app.menu('Edit', 'Undo');
    await expect.poll(() => pageCount(app.page)).toBe(3);
    expect(await pageTexts(app)).toEqual(['Alpha page', 'Bravo page', 'Charlie page']);
    await app.menu('Edit', 'Redo');
    await expect.poll(() => pageCount(app.page)).toBe(2);
  });

  test('the downloaded PDF has the pages as arranged', async ({ app }) => {
    await op(app, 'delete').click();
    await expect.poll(() => pageCount(app.page)).toBe(2);
    await op(app, 'insert').click();
    await expect.poll(() => pageCount(app.page)).toBe(3);
    const bytes = await save(app);
    expect((decodePdf(bytes).match(/\/Type\s*\/Page\b/g) ?? []).length).toBeGreaterThanOrEqual(3);
    // Opened again it has three pages.
    await openPdf(app, bytes, 'arranged.pdf');
    expect(await pageCount(app.page)).toBe(3);
  });
});

test('text edits made before a page operation are kept by it', async ({ app }) => {
  await openPdf(app, threePages());
  await editMode(app.page);
  await showPage(app.page, 0);
  const at = await (await import('./helpers')).pointOnPage(app.page, 0, 60, 54);
  await app.page.mouse.click(at.x, at.y);
  const editor = app.page.getByRole('textbox', { name: 'Edit text' });
  await expect(editor).toBeFocused();
  await app.page.keyboard.press('ControlOrMeta+a');
  await app.page.keyboard.type('Edited alpha');
  await app.page.keyboard.press('Escape');
  await expect(editor).toBeHidden();
  await op(app, 'duplicate').click();
  await expect.poll(() => pageCount(app.page)).toBe(4);
  const texts = await pageTexts(app);
  expect(texts.filter((t) => t === 'Edited alpha')).toHaveLength(2);
  expect(texts).not.toContain('Alpha page');
});
