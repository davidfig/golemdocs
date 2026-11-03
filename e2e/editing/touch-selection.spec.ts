// A finger on the document (main.ts, touchDown/touchMove/touchUp): a tap puts the caret at the end of the word it lands in, a long
// press or a double tap selects the word, and the finger, still down, drags the selection on.

import type { Page } from '@playwright/test';
import { expect, test, type App } from '../fixtures';
import { lineGaps } from './helpers';

const LINE = 'alpha beta gamma';

test.use({ hasTouch: true });

/** A finger: put down at a point, moved, lifted (real touches, through the browser's devtools protocol). */
async function finger(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const fire = (type: string, at?: { x: number; y: number }) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: at ? [{ x: at.x, y: at.y }] : [] });
  return {
    down: (at: { x: number; y: number }) => fire('touchStart', at),
    move: (at: { x: number; y: number }) => fire('touchMove', at),
    up: () => fire('touchEnd'),
  };
}

async function tap(app: App, at: { x: number; y: number }): Promise<void> {
  const f = await finger(app.page);
  await f.down(at);
  await f.up();
}

async function oneLine(app: App) {
  await app.blank();
  await app.type(LINE);
  return lineGaps(app, LINE.length);
}

const between = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: a.y });

test('a tap inside a word puts the caret at the end of the word', async ({ app }) => {
  const gaps = await oneLine(app);
  await tap(app, between(gaps[7], gaps[8])); // inside "beta"
  await app.settle();
  await app.type('|');
  await expect.poll(() => app.text()).toBe('alpha beta| gamma');
});

test('a long press selects the word, and dragging on selects more', async ({ app, page }) => {
  const gaps = await oneLine(app);
  const f = await finger(page);
  await f.down(between(gaps[7], gaps[8]));
  await expect.poll(() => app.selectedText()).toBe('beta');
  await f.move(between(gaps[13], gaps[14]));
  await f.move(gaps[16]);
  await expect.poll(() => app.selectedText()).toBe('beta gamma');
  await f.up();
});

test('a double tap selects the word even when the second tap lands a little apart', async ({ app }) => {
  const gaps = await oneLine(app);
  await tap(app, between(gaps[6], gaps[7]));
  await tap(app, { x: between(gaps[8], gaps[9]).x, y: gaps[8].y + 4 });
  await expect.poll(() => app.selectedText()).toBe('beta');
});

/** The middle of a handle's knob: below the line at the end, above it at the start. */
async function knob(page: Page, which: 'start' | 'end') {
  const box = (await page.locator(`.wm-sel-handle.${which}`).boundingBox())!;
  return { x: box.x + box.width / 2, y: which === 'end' ? box.y + box.height + 5 : box.y - 5 };
}

async function longPressBeta(app: App) {
  const gaps = await oneLine(app);
  const f = await finger(app.page);
  await f.down(between(gaps[7], gaps[8]));
  await expect.poll(() => app.selectedText()).toBe('beta');
  await f.up();
  await expect(app.page.locator('.wm-sel-handle.end')).toBeVisible();
  return gaps;
}

test('a selection made with a finger has handles; dragging the end one moves the end', async ({ app, page }) => {
  const gaps = await longPressBeta(app);
  const at = await knob(page, 'end');
  const f = await finger(page);
  await f.down(at);
  await f.move({ x: at.x + 20, y: at.y });
  await f.move({ x: gaps[16].x + 2, y: at.y });
  await expect.poll(() => app.selectedText()).toBe('beta gamma');
  await f.up();
});

test('dragging the start handle moves the start', async ({ app, page }) => {
  const gaps = await longPressBeta(app);
  const at = await knob(page, 'start');
  const f = await finger(page);
  await f.down(at);
  await f.move({ x: at.x - 20, y: at.y });
  await f.move({ x: gaps[0].x - 2, y: at.y });
  await expect.poll(() => app.selectedText()).toBe('alpha beta');
  await f.up();
});

test('a tap on a handle without dragging is an ordinary tap', async ({ app, page }) => {
  await longPressBeta(app);
  await tap(app, await knob(page, 'end'));
  await expect.poll(() => app.selectedText()).toBe('');
  await expect(page.locator('.wm-sel-handles')).toBeHidden();
});

test('a mouse selection has no handles', async ({ app, page }) => {
  const gaps = await oneLine(app);
  await page.mouse.dblclick(between(gaps[7], gaps[8]).x, gaps[7].y);
  await expect.poll(() => app.selectedText()).toBe('beta');
  await expect(page.locator('.wm-sel-handles')).toBeHidden();
});

test('a finger selecting near the top of the view scrolls the document and selects on', async ({ app, page }) => {
  await app.blank();
  await app.type(Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n'));
  await app.settle();
  const gaps = await lineGaps(app, 4); // on the last line, "line 80"
  const f = await finger(page);
  await f.down(between(gaps[1], gaps[2]));
  await expect.poll(() => app.selectedText()).toBe('line');
  const canvas = (await page.locator('#canvas').boundingBox())!;
  await f.move({ x: gaps[0].x - 4, y: canvas.y + 5 });
  await expect.poll(() => app.selectedText(), { timeout: 15_000 }).toMatch(/^line 1\n/);
  await f.up();
});
