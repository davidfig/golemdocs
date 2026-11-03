// A workbook in a room is edited by one session at a time (another person, or another device of the same account), as a PDF or a
// picture is: whoever opened it first holds it; the others watch it, read-only, and see it again each time it is saved; and a
// watcher can take it over.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import type { App } from '../fixtures';
import { dropFile, waitForOpen } from '../files/helpers';
import { newPerson, roomOf, secondDevice } from './helpers';

type SheetState = { loaded: boolean; active: { row: number; col: number }; content: { input: string }; info: { name: string } | null };
const state = (page: Page): Promise<SheetState> => page.evaluate(() => (window as unknown as { sheetEditor: { state(): SheetState } }).sheetEditor.state());
const banner = (app: App) => app.page.locator('.wm-watch');

/** Clicks the middle of a cell (once the workbook is open: a watcher opens it again after each save). */
async function clickCell(page: Page, row: number, col: number): Promise<void> {
  const where = () => page.evaluate(([r, c]) => (window as unknown as { sheetEditor: { pointOf(r: number, c: number): { x: number; y: number } | null } }).sheetEditor.pointOf(r, c), [row, col]);
  await expect.poll(async () => (await state(page)).loaded && (await where()) !== null, { timeout: 30_000 }).toBe(true);
  const at = (await where())!;
  const box = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.click(box.x + at.x, box.y + at.y);
}

/** What a cell holds, as typed. */
async function cell(page: Page, row: number, col: number): Promise<string> {
  await clickCell(page, row, col);
  await expect.poll(async () => {
    const { active } = await state(page);
    return active.row === row && active.col === col;
  }).toBe(true);
  return (await state(page)).content.input;
}

test('a workbook is held by one device: the other watches it, sees each save, can not type, and can take it over', async ({ browser }) => {
  const person = await newPerson(browser, 'sheet');
  await person.page.goto('/?doc=welcome');
  await person.app.ready();
  await dropFile(person.page, { name: 'plan.xlsx', buffer: readFileSync(resolve(process.cwd(), 'client/test/fixtures/sheets/scenarios.xlsx')), mimeType: 'application/octet-stream' });
  await waitForOpen(person.app, 'plan.xlsx');
  await expect.poll(async () => (await state(person.page)).loaded).toBe(true);
  const { context, a, b } = await secondDevice(browser, person);
  await expect.poll(async () => (await state(b.page)).loaded, { timeout: 30_000 }).toBe(true);
  await expect(banner(b)).toBeVisible();
  await expect.poll(async () => (await roomOf(a.page))?.watching).toBe(false);
  // The watcher's typing goes nowhere.
  await clickCell(b.page, 0, 1);
  await b.page.keyboard.type('7');
  await b.page.keyboard.press('Enter');
  await expect.poll(() => cell(b.page, 0, 1)).toBe('10');
  // The holder's change reaches the watcher once it is saved.
  await clickCell(a.page, 0, 1);
  await a.page.keyboard.type('99');
  await a.page.keyboard.press('Enter');
  await expect.poll(() => cell(b.page, 0, 1), { timeout: 30_000 }).toBe('99');
  // Taken over: the watcher holds it and types; the one who held it watches and sees it.
  await b.page.getByRole('button', { name: 'Take over', exact: true }).click();
  await expect(banner(b)).toBeHidden({ timeout: 30_000 });
  await expect(banner(a)).toBeVisible();
  await clickCell(b.page, 1, 1);
  await b.page.keyboard.type('5');
  await b.page.keyboard.press('Enter');
  await expect.poll(() => cell(a.page, 1, 1), { timeout: 30_000 }).toBe('5');
  await expect.poll(() => cell(a.page, 0, 1)).toBe('99');
  await context.close();
});
