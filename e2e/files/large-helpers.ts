// Helpers for the large-text editor's specs. Its text is drawn on the canvas by the GPU, so there is no text in the page to read:
// the specs read what is on screen through `window.textEditor` (see main.ts), and click and drag at the canvas positions it gives.

import type { Page } from '@playwright/test';
import { expect, type App } from './fixtures';
import { importFile } from './helpers';

export interface LargeState {
  lines: number;
  indexed: boolean;
  zoom: number;
  columns: number;
  wrap: boolean;
  caret: { line: number; col: number };
  anchor: { line: number; col: number };
  selected: string | null;
  topLine: number;
  visible: { line: number; text: string }[];
  version: number;
  glyphs: number;
  chunks: number;
  drawCalls: number;
  filtering: boolean;
  current: number;
  cameraX: number;
  composing: string | null;
  frameMs: number;
  slowestMs: number;
  marks: { line: number; text: string; kind: number }[];
  remotes: { line: number; col: number }[];
}

export const viewer = (page: Page) => page.locator('.wm-large');
/** The status bar (the same one documents have). */
export const largeStatus = (page: Page) => page.locator('#footer .wm-footer-items');
export const wrapToggle = (page: Page) => page.locator('#footer').getByRole('button', { name: 'Wrap long lines' });
export const findBox = (page: Page) => viewer(page).getByRole('textbox', { name: 'Find' });
export const message = (page: Page) => viewer(page).locator('.wm-large-message');

export const state = (page: Page): Promise<LargeState> => page.evaluate(() => (window as unknown as { textEditor: { state(): LargeState } }).textEditor.state());

/** The text of a line, if it is on screen (else undefined). */
export async function lineText(page: Page, line: number): Promise<string | undefined> {
  return (await state(page)).visible.find((v) => v.line === line)?.text;
}

/** Waits for a line on screen to have this text (or match it). */
export async function expectLine(page: Page, line: number, expected: string | RegExp): Promise<void> {
  await expect.poll(() => lineText(page, line), { timeout: 10_000, message: `line ${line + 1}` }).toMatch(typeof expected === 'string' ? new RegExp(`^${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) : expected);
}

/** Where a line and column are in the window, in CSS pixels (the middle of the row). */
export async function pointOf(page: Page, line: number, col: number): Promise<{ x: number; y: number }> {
  const at = await page.evaluate(([l, c]) => (window as unknown as { textEditor: { pointOf(l: number, c: number): { x: number; y: number } | null } }).textEditor.pointOf(l, c), [line, col] as const);
  if (!at) throw new Error('no such position');
  const box = (await page.locator('#canvas').boundingBox())!;
  return { x: box.x + at.x, y: box.y + at.y };
}

/** Where a line's number is in the window. */
export async function numberOf(page: Page, line: number): Promise<{ x: number; y: number }> {
  const at = await page.evaluate((l) => (window as unknown as { textEditor: { numberPoint(l: number): { x: number; y: number } | null } }).textEditor.numberPoint(l), line);
  if (!at) throw new Error('no such line');
  const box = (await page.locator('#canvas').boundingBox())!;
  return { x: box.x + at.x, y: box.y + at.y };
}

/** Clicks with the keys held down (the mouse has no option for it). */
async function click(page: Page, at: { x: number; y: number }, options: { clickCount?: number; modifiers?: ('Shift' | 'Control' | 'Meta' | 'Alt')[] } = {}): Promise<void> {
  for (const key of options.modifiers ?? []) await page.keyboard.down(key);
  await page.mouse.click(at.x, at.y, { clickCount: options.clickCount });
  for (const key of options.modifiers ?? []) await page.keyboard.up(key);
}

/** Clicks at a line and column (half a pixel in, so it lands on that boundary's character). */
export async function clickAt(page: Page, line: number, col: number, options: { clickCount?: number; modifiers?: ('Shift' | 'Control' | 'Meta' | 'Alt')[] } = {}): Promise<void> {
  const at = await pointOf(page, line, col);
  await click(page, { x: at.x + 0.5, y: at.y }, options);
}

export async function clickNumber(page: Page, line: number, options: { modifiers?: ('Shift')[] } = {}): Promise<void> {
  await click(page, await numberOf(page, line), options);
}

/** Drags from one position to another. */
export async function dragFrom(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const a = await pointOf(page, from[0], from[1]);
  const b = await pointOf(page, to[0], to[1]);
  await page.mouse.move(a.x + 0.5, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x + 0.5, b.y, { steps: 6 });
  await page.mouse.up();
}

/** Imports a big file and waits until it is shown and indexed. */
export async function openBigFile(app: App, name: string, buffer: Buffer, lines: number): Promise<void> {
  await app.goto('?doc=welcome');
  await importFile(app, { name, buffer });
  await expect(viewer(app.page)).toBeVisible();
  await expect(largeStatus(app.page)).toContainText(`${lines.toLocaleString('en-US')} lines`, { timeout: 30_000 });
  await expect.poll(async () => (await state(app.page)).indexed, { timeout: 30_000 }).toBe(true);
  // Something is drawn.
  await expect.poll(async () => (await state(app.page)).glyphs, { timeout: 15_000 }).toBeGreaterThan(0);
}

/** The status bar says how many lines the file has (the specs turn it off by default). */
export const statusBarOn = (target: Page | import('@playwright/test').BrowserContext): Promise<void> => target.addInitScript(() => localStorage.setItem('word.footer', 'on'));
