// Undo history kept on the device (docs/undo-history.md): Undo and Redo still work after a reload, and edits brought back from
// the edit journal undo as one more step.

import { MOD } from '../fixtures';
import { expect, test } from './fixtures';
import { blankWith, waitForSaved } from './helpers';

test('Undo after a reload takes back what was typed before it, and Redo puts it back', async ({ app, page }) => {
  await blankWith(app, 'kept');
  await waitForSaved(page);
  await app.press('Enter');
  await app.type('second line');
  // A pause, so the two lines are two undo steps (typing within a moment of the last undoes with it).
  await waitForSaved(page);
  await page.waitForTimeout(1600);
  await app.press('Enter');
  await app.type('third line');
  await waitForSaved(page);
  await page.reload();
  await app.ready();
  await expect.poll(() => app.text()).toContain('third line');
  await app.press(`${MOD}+z`);
  await expect.poll(() => app.text()).not.toContain('third line');
  expect(await app.text()).toContain('second line');
  await app.press(`${MOD}+z`);
  await expect.poll(() => app.text()).not.toContain('second line');
  expect(await app.text()).toContain('kept');
  await app.press(`${MOD}+Shift+z`);
  await expect.poll(() => app.text()).toContain('second line');
});

test('edits brought back after a reload, before they were saved, undo as one step on top of the saved ones', async ({ app, page }) => {
  await blankWith(app, 'kept');
  await app.press('Enter');
  await app.type('saved line');
  await waitForSaved(page);
  await app.type(' and more', 20);
  // Each key is an edit, kept under a key of its own (`golemdocs.journal.<doc>.<session>.<n>`): all nine are kept before the reload.
  const kept = () => page.evaluate(() => Object.keys(localStorage).filter((k) => /^golemdocs\.journal\..*\.\d+$/.test(k)).length);
  await expect.poll(kept).toBeGreaterThanOrEqual(' and more'.length);
  // Reloaded before the autosave: the last words come back from the edit journal.
  await page.reload();
  await app.ready();
  await expect.poll(() => app.text()).toContain('saved line and more');
  await app.press(`${MOD}+z`);
  await expect.poll(() => app.text()).not.toContain('and more');
  expect(await app.text()).toContain('saved line');
  await app.press(`${MOD}+z`);
  await expect.poll(() => app.text()).not.toContain('saved line');
});
