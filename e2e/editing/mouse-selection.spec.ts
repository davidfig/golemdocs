import { test, expect, type App } from '../fixtures';
import { DOC, caretClient, clickAt, lineGaps, waitCaretSettled, tool } from './helpers';

const LINE = 'alpha beta gamma';

async function oneLine(app: App, text = LINE) {
  await app.blank();
  await app.type(text);
  return lineGaps(app, text.length);
}

test.describe('mouse on the canvas', () => {
  test('a click puts the caret between the characters nearest to it', async ({ app }) => {
    const gaps = await oneLine(app);
    await clickAt(app, gaps[6]); // before "beta"
    await app.type('|');
    await expect.poll(() => app.text()).toBe('alpha |beta gamma');
  });

  test('a click past the end of the line puts the caret at the end; before the start, at the start', async ({ app }) => {
    const gaps = await oneLine(app);
    await clickAt(app, { x: gaps[16].x + 120, y: gaps[0].y });
    await app.type('>');
    await clickAt(app, { x: gaps[0].x - 20, y: gaps[0].y });
    await app.type('<');
    await expect.poll(() => app.text()).toBe('<alpha beta gamma>');
  });

  test('a click in the middle of a character goes to the nearer side', async ({ app }) => {
    const gaps = await oneLine(app);
    // Just right of the gap after "alpha" is still nearer to that gap than the next one.
    await clickAt(app, { x: gaps[5].x + 1, y: gaps[5].y });
    await app.type('|');
    await expect.poll(() => app.text()).toBe('alpha| beta gamma');
  });

  test('a click on another paragraph moves the caret there', async ({ app }) => {
    await app.blank();
    await app.type('first paragraph');
    await waitCaretSettled(app);
    const firstY = (await caretClient(app)).y;
    await app.press('Enter');
    await app.type('second paragraph');
    await expect.poll(async () => (await caretClient(app)).y).toBeGreaterThan(firstY);
    await waitCaretSettled(app);
    const bottom = await caretClient(app);
    await app.press('ArrowUp');
    await app.press('Home');
    await waitCaretSettled(app);
    const top = await caretClient(app);
    expect(bottom.y).toBeGreaterThan(top.y);
    await clickAt(app, { x: top.x + 500, y: bottom.y });
    await app.type('!');
    await expect.poll(() => app.text()).toBe('first paragraph\nsecond paragraph!');
    await clickAt(app, { x: top.x + 500, y: top.y });
    await app.type('?');
    await expect.poll(() => app.text()).toBe('first paragraph?\nsecond paragraph!');
  });

  test('a click below the last line lands on the nearest line, at the clicked column', async ({ app }) => {
    const gaps = await oneLine(app);
    await clickAt(app, gaps[10]);
    await clickAt(app, { x: gaps[3].x, y: gaps[3].y + 300 });
    await app.type('!');
    await expect.poll(() => app.text()).toBe('alp!ha beta gamma');
  });

  test('double-click selects the word under the pointer', async ({ app }) => {
    const gaps = await oneLine(app);
    await clickAt(app, { x: (gaps[6].x + gaps[10].x) / 2, y: gaps[0].y }, { clickCount: 2 });
    await expect.poll(async () => (await app.selectedText()).trim()).toBe('beta');
  });

  test('double-click on the first and the last word', async ({ app }) => {
    const gaps = await oneLine(app);
    await clickAt(app, { x: (gaps[0].x + gaps[5].x) / 2, y: gaps[0].y }, { clickCount: 2 });
    await expect.poll(async () => (await app.selectedText()).trim()).toBe('alpha');
    // A pause longer than the multi-click interval starts counting again.
    await app.page.waitForTimeout(600);
    await clickAt(app, { x: (gaps[11].x + gaps[16].x) / 2, y: gaps[0].y }, { clickCount: 2 });
    await expect.poll(async () => (await app.selectedText()).trim()).toBe('gamma');
  });

  test('typing after a double-click replaces the word', async ({ app }) => {
    const gaps = await oneLine(app);
    await clickAt(app, { x: (gaps[6].x + gaps[10].x) / 2, y: gaps[0].y }, { clickCount: 2 });
    await expect.poll(async () => (await app.selectedText()).trim()).toBe('beta');
    await app.type('X');
    await expect.poll(async () => (await app.text()).replace(/\s+/g, ' ')).toMatch(/^alpha X ?gamma$/);
  });

  test('triple-click selects the whole paragraph, and only that one', async ({ app }) => {
    await app.blank();
    await app.type('alpha beta');
    await app.press('Enter');
    await app.type('gamma delta');
    await app.press('Enter');
    await app.type('epsilon');
    // Put the pointer on the middle paragraph.
    await app.press('ArrowUp');
    await app.press('Home');
    await app.press('ArrowRight', 3);
    await waitCaretSettled(app);
    const at = await caretClient(app);
    await clickAt(app, at, { clickCount: 3 });
    await expect.poll(async () => (await app.selectedText()).replace(/\n$/, '')).toBe('gamma delta');
  });

  test('dragging selects the text between the press and the release', async ({ app }) => {
    const gaps = await oneLine(app);
    await app.page.mouse.move(gaps[2].x, gaps[2].y);
    await app.page.mouse.down();
    await app.page.mouse.move(gaps[6].x, gaps[6].y, { steps: 5 });
    await app.page.mouse.move(gaps[9].x, gaps[9].y, { steps: 5 });
    await app.page.mouse.up();
    await expect.poll(() => app.selectedText()).toBe('pha bet');
  });

  test('dragging backwards selects too, and typing replaces the selection', async ({ app }) => {
    const gaps = await oneLine(app);
    await app.page.mouse.move(gaps[16].x, gaps[16].y);
    await app.page.mouse.down();
    await app.page.mouse.move(gaps[11].x, gaps[11].y, { steps: 6 });
    await app.page.mouse.up();
    await expect.poll(() => app.selectedText()).toBe('gamma');
    await app.type('omega');
    await expect.poll(() => app.text()).toBe('alpha beta omega');
  });

  test('dragging across paragraphs selects their text and the break between them', async ({ app }) => {
    await app.blank();
    await app.type('first');
    await waitCaretSettled(app);
    const firstY = (await caretClient(app)).y;
    await app.press('Enter');
    await app.type('second');
    await expect.poll(async () => (await caretClient(app)).y).toBeGreaterThan(firstY);
    await waitCaretSettled(app);
    const end = await caretClient(app);
    await app.press(`${DOC}+Home`);
    await waitCaretSettled(app);
    const start = await caretClient(app);
    await app.page.mouse.move(start.x + 10, start.y);
    await app.page.mouse.down();
    await app.page.mouse.move(end.x - 10, end.y, { steps: 8 });
    await app.page.mouse.up();
    await expect.poll(() => app.selectedText()).toMatch(/^.+\n.+$/);
  });

  test('Shift+click extends the selection from the caret', async ({ app }) => {
    const gaps = await oneLine(app);
    await clickAt(app, gaps[0]);
    await clickAt(app, gaps[5], { modifiers: ['Shift'] });
    await expect.poll(() => app.selectedText()).toBe('alpha');
    await clickAt(app, gaps[10], { modifiers: ['Shift'] });
    await expect.poll(() => app.selectedText()).toBe('alpha beta');
  });

  test('Shift+click before the anchor selects backwards', async ({ app }) => {
    const gaps = await oneLine(app);
    await clickAt(app, gaps[16]);
    await clickAt(app, gaps[11], { modifiers: ['Shift'] });
    await expect.poll(() => app.selectedText()).toBe('gamma');
  });

  test('a plain click clears the selection', async ({ app }) => {
    const gaps = await oneLine(app);
    await app.press(`${DOC}+a`);
    await expect.poll(() => app.selectedText()).toBe(LINE);
    await clickAt(app, gaps[4]);
    await expect.poll(() => app.selectedText()).toBe('');
  });

  test('clicking a toolbar button keeps the selection and the typing focus in the document', async ({ app }) => {
    const gaps = await oneLine(app);
    await clickAt(app, { x: (gaps[0].x + gaps[5].x) / 2, y: gaps[0].y }, { clickCount: 2 });
    await tool(app, 'Bold').click();
    await expect.poll(() => app.selectedText()).toMatch(/^alpha/);
    await expect(tool(app, 'Bold')).toHaveAttribute('aria-pressed', 'true');
    await app.type('Z');
    await expect.poll(() => app.text()).toMatch(/^Zbeta gamma|^Z beta gamma/);
  });
});
