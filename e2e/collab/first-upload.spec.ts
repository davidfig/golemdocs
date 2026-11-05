// A document's first upload joins its room in the background, a few seconds after it was opened: nothing
// on screen may change because of it, the selection included.

import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { makePdf, movePaletteAside, selectBetween, settle, showPage } from '../pdf/helpers';
import { newPerson } from './helpers';

const firstUpload = (page: Page) => page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/documents', { timeout: 30_000 });

/** Past the upload and the room it joins. */
const afterRoomJoined = (page: Page) => page.waitForTimeout(2000);

test('a PDF just imported keeps its selection through the first upload', async ({ browser }) => {
  const person = await newPerson(browser, 'upload');
  await person.page.goto('/?doc=welcome');
  await person.app.ready();
  const chooser = person.page.waitForEvent('filechooser');
  await person.app.menu('File', 'Import…');
  await (await chooser).setFiles({ name: 'Plan.pdf', mimeType: 'application/pdf', buffer: makePdf() });
  await expect(person.page.locator('.wm-forms-palette')).toBeVisible();
  const uploaded = firstUpload(person.page);
  await movePaletteAside(person.page);
  await settle(person.page);
  await showPage(person.page, 0);
  expect(await selectBetween(person.page, 0, [41, 54], [120, 54])).toBe('Hello PDF ');
  await uploaded;
  await afterRoomJoined(person.page);
  expect(await person.app.selectedText()).toBe('Hello PDF ');
  await person.context.close();
});

test('a new document keeps its selection through the first upload', async ({ browser }) => {
  const person = await newPerson(browser, 'upload');
  await person.app.blank();
  const uploaded = firstUpload(person.page);
  await person.app.type('Some words');
  await person.page.keyboard.press('ControlOrMeta+a');
  await uploaded;
  await afterRoomJoined(person.page);
  expect(await person.app.selectedText()).toBe('Some words');
  await person.context.close();
});
