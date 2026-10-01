// File ▸ Share ▸ Get Link, and the live "?room=" sessions it makes. Such a room is served by a
// SharedWorker (client/src/collab/devServer.ts), so the people in these tests are tabs of ONE
// browser profile: each test's `roomPair` is two pages of the same context.

import { test, expect, App, MOD } from '../fixtures';
import { addComment, commentTexts, commentsTitle, expectText, getRoomLink, others, roomPair, selectForward } from './helpers';

test.describe('Get Link', () => {
  test('the dialog offers a link; Get Link puts the document in a room and shows the link', async ({ app, page }) => {
    await app.blank();
    await app.type('shared text');
    await app.menu('File', 'Share');
    const dialog = page.locator('dialog.wm-share');
    await expect(dialog.getByText('Anyone with this link can open the document and edit it with you.')).toBeVisible();
    const field = dialog.getByLabel('Link to this shared document');
    await expect(field).toHaveValue('');
    await expect(field).toHaveAttribute('readonly', '');
    await dialog.getByRole('button', { name: 'Get Link' }).click();
    await expect(field).toHaveValue(/\/\?room=[a-z0-9]+&name=Document1\.docx$/);
    await expect(dialog.getByRole('button', { name: 'Copy Link' })).toBeVisible();
    // The page itself is now in that room, with its text.
    await expect(page).toHaveURL(/\?room=[a-z0-9]+&name=Document1\.docx$/);
    expect(await field.inputValue()).toBe(page.url());
  });

  test('Copy Link puts the link on the clipboard', async ({ app, page }) => {
    await app.blank();
    await app.menu('File', 'Share');
    const dialog = page.locator('dialog.wm-share');
    await dialog.getByRole('button', { name: 'Get Link' }).click();
    await dialog.getByRole('button', { name: 'Copy Link' }).click();
    await expect(dialog.getByRole('status').first()).toHaveText('Copied');
    const link = await dialog.getByLabel('Link to this shared document').inputValue();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  });

  test('a document already in a room shows its link at once', async ({ app, page }) => {
    await app.blank();
    const link = await getRoomLink(app);
    await app.menu('File', 'Share');
    const dialog = page.locator('dialog.wm-share');
    await expect(dialog.getByLabel('Link to this shared document')).toHaveValue(link);
    await expect(dialog.getByRole('button', { name: 'Copy Link' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Get Link' })).toHaveCount(0);
  });

  test('Done and Escape close the dialog', async ({ app, page }) => {
    await app.blank();
    await app.menu('File', 'Share');
    const dialog = page.locator('dialog.wm-share');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);
    await app.menu('File', 'Share');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('only Word documents can be shared live', async ({ app, page }) => {
    await app.blank();
    await app.type('plain');
    await app.menu('File', 'Convert To', 'Markdown');
    await expect(page.getByRole('combobox', { name: 'Document format' })).toHaveValue(/Markdown/);
    await app.menu('File', 'Share');
    const dialog = page.locator('dialog.wm-share');
    await expect(dialog.getByText('Switch the format to Word Document to collaborate')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Get Link' })).toHaveCount(0);
  });

  test('a guest can get a link too (no account needed)', async ({ browser }) => {
    const { signedOutContext } = await import('./helpers');
    const context = await signedOutContext(browser);
    const app = new App(await context.newPage());
    await app.blank();
    await app.type('guest text');
    const link = await getRoomLink(app);
    expect(link).toMatch(/\?room=/);
    await context.close();
  });
});

test.describe('two people in one room', () => {
  test('a late joiner gets the whole document', async ({ browser }) => {
    const { a, b, context } = await roomPair(browser, 'first line');
    await a.press('Enter');
    await a.type('second line');
    await expectText(a, 'first line\nsecond line');
    // Someone else arrives later still.
    const c = new App(await context.newPage());
    await c.page.goto(a.page.url());
    await c.ready();
    await expectText(c, 'first line\nsecond line');
    await expectText(b, 'first line\nsecond line');
    await context.close();
  });

  test('typing in either page reaches the other', async ({ browser }) => {
    const { a, b, context } = await roomPair(browser, 'Hello');
    await expectText(b, 'Hello');
    await a.type(' from A');
    await expectText(b, 'Hello from A');
    await b.press(`${MOD}+End`);
    await b.type('!');
    await expectText(a, 'Hello from A!');
    await b.press('Enter');
    await b.type('B line');
    await expectText(a, 'Hello from A!\nB line');
    await context.close();
  });

  test('both typing at once converge to the same text', async ({ browser }) => {
    const { a, b, context } = await roomPair(browser, 'start');
    await a.press('Enter');
    await a.type('middle');
    await a.press('Enter');
    await a.type('end');
    await expectText(b, 'start\nmiddle\nend');
    // A types at the top while B types at the bottom, at the same time.
    await a.focus();
    await a.press(`${MOD}+Home`);
    await b.focus();
    await b.press(`${MOD}+End`);
    await Promise.all([a.page.keyboard.type('AAAA', { delay: 20 }), b.page.keyboard.type('BBBB', { delay: 20 })]);
    await expect.poll(async () => (await a.text()) === (await b.text()), { message: 'both pages hold the same text' }).toBe(true);
    const text = await a.text();
    expect(text).toContain('AAAAstart');
    expect(text.endsWith('endBBBB')).toBe(true);
    await context.close();
  });

  test('typing at the same spot at once keeps every character and ends up identical', async ({ browser }) => {
    const { a, b, context } = await roomPair(browser, 'base');
    await expectText(b, 'base');
    await a.focus();
    await b.focus();
    await Promise.all([a.page.keyboard.type('1111', { delay: 15 }), b.page.keyboard.type('2222', { delay: 15 })]);
    await expect.poll(async () => (await a.text()) === (await b.text())).toBe(true);
    const text = await a.text();
    expect(text.replace(/[^1]/g, '')).toBe('1111');
    expect(text.replace(/[^2]/g, '')).toBe('2222');
    expect(text).toContain('base');
    await context.close();
  });

  test('deleting text propagates, including a selection replaced by typing', async ({ browser }) => {
    const { a, b, context } = await roomPair(browser, 'one two three');
    await expectText(b, 'one two three');
    await a.press('Home');
    await a.press('Shift+ArrowRight', 4); // "one "
    await a.press('Delete');
    await expectText(b, 'two three');
    await b.press(`${MOD}+a`);
    await b.type('replaced');
    await expectText(a, 'replaced');
    await context.close();
  });

  test('undo only undoes your own edits', async ({ browser }) => {
    const { a, b, context } = await roomPair(browser, '');
    await a.type('AAA');
    await expectText(b, 'AAA');
    await b.press(`${MOD}+End`);
    await b.press('Enter');
    await b.type('BBB');
    await expectText(a, 'AAA\nBBB');
    await a.focus();
    await a.page.keyboard.press(`${MOD}+z`);
    await expectText(b, '\nBBB'); // A's typing is gone; B's line is still there
    await expectText(a, '\nBBB');
    await b.focus();
    await b.page.keyboard.press(`${MOD}+z`);
    await b.page.keyboard.press(`${MOD}+z`);
    await expectText(a, '');
    await context.close();
  });

  test('formatting travels: bold made in one page shows in the other', async ({ browser }) => {
    const { a, b, context } = await roomPair(browser, 'Hello world');
    await expectText(b, 'Hello world');
    await a.press('Home');
    await a.press('Shift+ArrowRight', 5);
    await a.page.keyboard.press(`${MOD}+b`);
    await b.focus();
    await b.press(`${MOD}+Home`);
    await b.press('ArrowRight');
    await expect(b.toolbarButton('Bold')).toHaveAttribute('aria-pressed', 'true');
    await b.press(`${MOD}+End`);
    await expect(b.toolbarButton('Bold')).toHaveAttribute('aria-pressed', 'false');
    await context.close();
  });

  test('a table inserted in one page appears in the other', async ({ browser }) => {
    const { a, b, context } = await roomPair(browser, 'above');
    await expectText(b, 'above');
    await a.press('Enter');
    await a.menu('Insert', 'Table');
    const dialog = a.page.getByRole('dialog', { name: 'Insert Table' });
    await dialog.getByLabel('Number of columns').first().fill('2');
    await dialog.getByLabel('Number of rows').first().fill('2');
    await dialog.getByRole('button', { name: 'OK' }).click();
    await a.focus();
    await a.type('cell one');
    await expect.poll(async () => (await b.text()).includes('cell one')).toBe(true);
    await expect.poll(async () => (await b.text()) === (await a.text()), { message: 'both pages hold the same text' }).toBe(true);
    // The table's cells are separate paragraphs: more lines than the two we typed.
    expect((await b.text()).split('\n').length).toBeGreaterThan(3);
    await context.close();
  });

  test('comments propagate both ways, with replies and resolving', async ({ browser }) => {
    const { a, b, context } = await roomPair(browser, 'alpha beta');
    await expectText(b, 'alpha beta');
    await a.press('Home');
    await selectForward(a, 5);
    await addComment(a, 'from A');
    await expect(commentsTitle(b.page)).toHaveText('Comments (1)');
    expect(await commentTexts(b.page)).toEqual(['from A']);
    // B replies to it.
    await b.page.locator('.wm-comments .wm-comment').click();
    await b.page.getByPlaceholder('Reply…').fill('from B');
    await b.page.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(commentsTitle(a.page)).toHaveText('Comments (2)');
    // A resolves the thread; B sees it marked.
    await a.page.locator('.wm-comments .wm-comment').click();
    await a.page.getByRole('button', { name: 'Resolve' }).click();
    await b.page.getByLabel('Show resolved').check();
    await expect(b.page.locator('.wm-comments .wm-comment-resolved')).toHaveCount(1);
    await context.close();
  });

  test('a comment deleted in one page disappears from the other', async ({ browser }) => {
    const { a, b, context } = await roomPair(browser, 'alpha beta');
    await expectText(b, 'alpha beta');
    await a.press('Home');
    await selectForward(a, 5);
    await addComment(a, 'to be removed');
    await expect(commentsTitle(b.page)).toHaveText('Comments (1)');
    await a.page.getByRole('button', { name: 'Delete' }).click();
    await expect(commentsTitle(b.page)).toHaveText('Comments (0)');
    await context.close();
  });
});

test.describe('presence', () => {
  test('each page sees the other as a named, coloured caret', async ({ browser }) => {
    const { a, b, context } = await roomPair(browser, 'Hello');
    await expect.poll(async () => (await others(a.page)).length).toBe(1);
    await expect.poll(async () => (await others(b.page)).length).toBe(1);
    const [seenByA] = await others(a.page);
    const [seenByB] = await others(b.page);
    expect(seenByA!.name).toMatch(/^Guest \d{3}$/);
    expect(seenByB!.name).toMatch(/^Guest \d{3}$/);
    expect(seenByA!.name).not.toBe(seenByB!.name);
    expect(seenByA!.height).toBeGreaterThan(0);
    expect(seenByA!.color).toBeGreaterThan(0);
    await context.close();
  });

  test('a remote caret follows the other person moving through the text', async ({ browser }) => {
    const { a, b, context } = await roomPair(browser, 'one two three');
    await expectText(b, 'one two three');
    await b.press('Home');
    const atStart = await expect.poll(async () => (await others(a.page))[0]?.x).toBeDefined();
    void atStart;
    const x0 = (await others(a.page))[0]!.x;
    await b.press('End');
    await expect.poll(async () => (await others(a.page))[0]?.x ?? 0).toBeGreaterThan(x0 + 20);
    await b.press('Enter');
    const y0 = (await others(a.page))[0]!.y;
    await b.type('next line');
    await expect.poll(async () => (await others(a.page))[0]?.y ?? 0).toBeGreaterThanOrEqual(y0);
    await context.close();
  });

  test('the caret of someone who leaves is removed', async ({ browser }) => {
    const { a, b, context } = await roomPair(browser, 'Hello');
    await expect.poll(async () => (await others(a.page)).length).toBe(1);
    await b.page.close();
    await expect.poll(async () => (await others(a.page)).length).toBe(0);
    await context.close();
  });

  test('a newcomer appears, and the third person is seen by both', async ({ browser }) => {
    const { a, b, context } = await roomPair(browser, 'Hello');
    const c = new App(await context.newPage());
    await c.page.goto(a.page.url());
    await c.ready();
    await expect.poll(async () => (await others(a.page)).length).toBe(2);
    await expect.poll(async () => (await others(b.page)).length).toBe(2);
    await expect.poll(async () => (await others(c.page)).length).toBe(2);
    const names = (await others(a.page)).map((o) => o.name);
    expect(new Set(names).size).toBe(2);
    await context.close();
  });
});
