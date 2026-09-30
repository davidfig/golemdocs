import { expect, test } from '../fixtures';
import { annotations, clickOnPage, makePdf, openPdf, pointOnPage, selectBetween, showPage } from './helpers';

// Helvetica 18 pt baselines at 240 and 200 from the bottom of a 300 pt page: 60 and 100 from the top.
const sample = () =>
  makePdf({
    pages: [
      [
        { text: 'Hello PDF world', x: 40, y: 240, size: 18 },
        { text: 'Second line of text', x: 40, y: 200, size: 18 },
      ],
    ],
  });

/** Where "Hello PDF " ends (points from the left) at 18 pt Helvetica is about 40 + 87. */
const HELLO: [[number, number], [number, number]] = [
  [41, 54],
  [120, 54],
];

type App = import('../fixtures').App;
const btn = (app: App, name: string) => app.page.getByRole('button', { name, exact: true });
const save = async (app: App) => (await app.download(() => app.menu('File', 'Download'))).bytes;
/** Waits until the PDF the app would download now holds `count` annotations of a kind (edits reach the worker a moment after the click). */
const expectAnnotations = (app: App, subtype: string, count: number) => expect.poll(async () => annotations(await save(app), subtype).length, { timeout: 15_000 }).toBe(count);

test.describe('marking up a PDF', () => {
  test.beforeEach(async ({ app }) => {
    await openPdf(app, sample());
    await showPage(app.page, 0);
  });

  test('dragging across text selects exactly the characters between the ends', async ({ app }) => {
    expect(await selectBetween(app.page, 0, ...HELLO)).toBe('Hello PDF ');
  });

  test('a drag over two lines selects both, with a line break between', async ({ app }) => {
    expect(await selectBetween(app.page, 0, [41, 54], [200, 94])).toBe('Hello PDF world\nSecond line of text');
  });

  test('a click without dragging selects nothing', async ({ app }) => {
    await clickOnPage(app.page, 0, 60, 54);
    expect(await app.selectedText()).toBe('');
  });

  test('double-clicking a word selects that word', async ({ app }) => {
    const at = await pointOnPage(app.page, 0, 100, 54);
    await app.page.mouse.dblclick(at.x, at.y);
    await expect.poll(async () => (await app.selectedText()).trim()).toBe('PDF');
  });

  test('Highlight writes a highlight annotation over the selected text', async ({ app }) => {
    await selectBetween(app.page, 0, ...HELLO);
    await btn(app, 'Highlight').click();
    await expectAnnotations(app, 'Highlight', 1);
    const found = annotations(await save(app), 'Highlight');
    expect(found).toHaveLength(1);
    // Yellow by default, covering the start of the first line (x from 40).
    expect(found[0]).toMatch(/\/C\s*\[1 1 0\]/);
    expect(Number(/\/Rect\s*\[\s*([\d.]+)/.exec(found[0])![1])).toBeCloseTo(40, 0);
  });

  test('Underline and Strikethrough write their own annotations', async ({ app }) => {
    await selectBetween(app.page, 0, ...HELLO);
    await btn(app, 'Underline').click();
    await selectBetween(app.page, 0, [41, 94], [120, 94]);
    await btn(app, 'Strikethrough').click();
    await expectAnnotations(app, 'StrikeOut', 1);
    const bytes = await save(app);
    expect(annotations(bytes, 'Underline')).toHaveLength(1);
    expect(annotations(bytes, 'StrikeOut')).toHaveLength(1);
    expect(annotations(bytes, 'Highlight')).toHaveLength(0);
  });

  test('Undo takes a highlight away and Redo puts it back', async ({ app }) => {
    await selectBetween(app.page, 0, ...HELLO);
    await btn(app, 'Highlight').click();
    await expectAnnotations(app, 'Highlight', 1);
    await app.menu('Edit', 'Undo');
    await expectAnnotations(app, 'Highlight', 0);
    await app.menu('Edit', 'Redo');
    await expectAnnotations(app, 'Highlight', 1);
  });

  test('clicking a highlight selects it and Delete removes it', async ({ app }) => {
    await selectBetween(app.page, 0, ...HELLO);
    await btn(app, 'Highlight').click();
    await expectAnnotations(app, 'Highlight', 1);
    await clickOnPage(app.page, 0, 60, 54);
    await app.page.keyboard.press('Delete');
    await expectAnnotations(app, 'Highlight', 0);
  });

  test('marking up does not change the text on the page', async ({ app }) => {
    await selectBetween(app.page, 0, ...HELLO);
    await btn(app, 'Highlight').click();
    await expectAnnotations(app, 'Highlight', 1);
    const bytes = await save(app);
    expect(bytes.toString('latin1')).toContain('(Hello PDF world) Tj');
  });

  test('Insert ▸ Comment on a PDF asks for a note and puts a note annotation on the page', async ({ app }) => {
    await clickOnPage(app.page, 0, 60, 54);
    app.page.once('dialog', (d) => void d.accept('Check this wording'));
    await app.menu('Insert', 'Comment');
    await expectAnnotations(app, 'Text', 1);
    const [note] = annotations(await save(app), 'Text');
    expect(note).toContain('(Check this wording)');
  });

  test('cancelling the note prompt adds nothing', async ({ app }) => {
    await clickOnPage(app.page, 0, 60, 54);
    app.page.once('dialog', (d) => void d.dismiss());
    await app.menu('Insert', 'Comment');
    // Edits are handled in order, so once a later highlight is in the file, a note that was going to arrive would have.
    await selectBetween(app.page, 0, ...HELLO);
    await btn(app, 'Highlight').click();
    await expectAnnotations(app, 'Highlight', 1);
    expect(annotations(await save(app), 'Text')).toHaveLength(0);
  });

  test('a highlight survives a download and opens again', async ({ app }) => {
    await selectBetween(app.page, 0, ...HELLO);
    await btn(app, 'Highlight').click();
    await expectAnnotations(app, 'Highlight', 1);
    const bytes = await save(app);
    await openPdf(app, bytes, 'marked.pdf');
    await showPage(app.page, 0);
    // The highlight is selectable again: click it, delete it, and the next save has none.
    await clickOnPage(app.page, 0, 60, 54);
    await app.page.keyboard.press('Delete');
    await expectAnnotations(app, 'Highlight', 0);
  });
});
