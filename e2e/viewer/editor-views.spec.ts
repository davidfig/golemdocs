// A shared folder's workbooks, CSV files, decks, audio and HTML pages open on the shared page the way the app shows them (viewer/editorViews.ts):
// the spreadsheet editor, the slides editor, the media player and page view, each read-only, not as a document the layout worker made of them.
// The bar keeps what applies: no page buttons for any, and no zoom, Find or Print for audio and video.

import { test, expect } from '../fixtures';
import { CLIENT_ORIGIN } from '../ports.ts';
import { fixture } from '../files/helpers';
import { wav } from '../media/helpers';
import { newPerson, signedOutContext } from '../collab/helpers';

const headers = { origin: CLIENT_ORIGIN };

test('a shared folder shows workbooks, CSV, decks, audio and pages in their own views, read-only', async ({ browser }) => {
  const owner = await newPerson(browser, 'owner');
  await owner.page.goto('/?doc=welcome');
  await owner.app.ready();
  const folderId = crypto.randomUUID();
  expect((await owner.page.request.put(`/api/folders/${folderId}`, { data: { name: 'Kinds', parentId: null }, headers })).status()).toBe(201);
  const add = async (name: string, data: Buffer) => {
    const response = await owner.page.request.post(`/api/documents?name=${encodeURIComponent(name)}&folder=${folderId}`, { data, headers });
    expect(response.status(), await response.text()).toBe(201);
  };
  await add('Notes.xlsx', fixture('sheets/notes.xlsx').buffer);
  await add('Releases.csv', Buffer.from('Version,Date\n0.48.0,2026-11-25\n0.47.0,2026-11-25\n'));
  await add('Review.pptx', fixture('slides/review.pptx').buffer);
  await add('Tone.wav', wav('Tone.wav', 2).buffer);
  await add('Dashboard.html', Buffer.from('<!doctype html><html><body><h1 id="title">Waiting</h1><script>document.getElementById("title").textContent = "Ran";</script></body></html>'));
  const { token } = (await (await owner.page.request.put(`/api/folders/${folderId}/link`, { headers })).json()) as { token: string };

  const stranger = await signedOutContext(browser);
  const page = await stranger.newPage();
  const open = async (path: string) => {
    await page.goto(`/view?pf=${token}&path=${encodeURIComponent(path)}`);
    await expect(page).toHaveTitle(`${path} (view only) · Kinds`);
  };
  const toolbar = page.getByRole('toolbar');

  // A workbook in the spreadsheet editor, with its own Find; nothing of it can be typed into.
  await open('Notes.xlsx');
  const sheet = page.locator('.wm-sheet');
  await expect(sheet).toBeVisible();
  await expect(page.locator('.wm-viewer-pages')).toBeHidden();
  await expect(toolbar.getByRole('button', { name: 'Find' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Print' })).toBeVisible();
  await expect(sheet.getByRole('tab')).not.toHaveCount(0);
  // A double-click on a cell, or typing, opens no cell editor.
  await page.locator('.wm-folder-doc canvas').first().dblclick({ position: { x: 120, y: 70 } });
  await page.keyboard.type('changed');
  await expect(page.locator('.wm-sheet-editor')).toBeHidden();

  // A CSV file too.
  await open('Releases.csv');
  await expect(page.locator('.wm-sheet')).toBeVisible();

  // A deck in the slides editor, without a Find it doesn't have.
  await open('Review.pptx');
  await expect(page.locator('.wm-slides')).toBeVisible();
  await expect(page.locator('.wm-slides-canvas')).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Find' })).toBeHidden();
  await expect(toolbar.getByRole('button', { name: 'Print' })).toBeVisible();

  // Audio in the media player: its own controls, and nothing to zoom, find or print, and no status bar.
  await open('Tone.wav');
  await expect(page.locator('.wm-media')).toBeVisible();
  await expect(page.locator('.wm-media audio, .wm-media video')).toHaveCount(1);
  await expect(toolbar.getByRole('button', { name: 'Zoom In' })).toBeHidden();
  await expect(toolbar.getByRole('button', { name: 'Print' })).toBeHidden();
  await expect(toolbar.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
  await expect(page.locator('.wm-folder-doc .wm-footer')).toBeHidden();

  // An HTML page as the page it makes, its script run in the sandboxed frame (pages/view.ts, as on a shared page's own address).
  await open('Dashboard.html');
  await expect(page.locator('.wm-page-view')).toBeVisible();
  await expect(page.frameLocator('.wm-page-frame').getByRole('heading', { name: 'Ran' })).toBeVisible();

  // F6 from the Files panel reaches the editor showing the file (here the spreadsheet editor's own field), and back.
  await open('Notes.xlsx');
  await expect(page.locator('.wm-sheet')).toBeVisible();
  await page.getByRole('navigation', { name: 'Files' }).getByRole('link', { name: 'Notes.xlsx' }).focus();
  await page.keyboard.press('F6');
  await expect(page.locator('.wm-sheet-input')).toBeFocused();
  await page.keyboard.press('F6');
  await expect(page.getByRole('navigation', { name: 'Files' }).getByRole('link', { name: 'Notes.xlsx' })).toBeFocused();
  await owner.context.close();
  await stranger.close();
});
