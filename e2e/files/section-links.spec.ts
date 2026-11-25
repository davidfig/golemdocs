// Links to a heading: `[[Note#Heading]]` opens the note at it (or moves there, in the note that is open), and `[text](#heading)`
// moves within the document.

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { buildZip, status } from './helpers';

const dashboard = (page: Page) => page.locator('.wm-dashboard');
const caret = (page: Page) => page.evaluate(() => (window as unknown as { selectionState: { at: { focus: [number, number] } | null } }).selectionState.at?.focus[0] ?? null);

/** Ctrl/Cmd+clicks the link at the start of the caret's line. */
async function followAtCaret(page: Page): Promise<void> {
  const box = await page.evaluate(() => {
    const el = document.querySelector('#input')!.getBoundingClientRect();
    return { x: el.left, y: el.top, h: el.height };
  });
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.click(box.x + 12, box.y + Math.max(4, box.h / 2));
  await page.keyboard.up('ControlOrMeta');
}

test('a link with a section goes to that heading, in this note or another', async ({ app, page }) => {
  const zip = buildZip([
    { name: 'Vault/', data: '' },
    { name: 'Vault/Home.md', data: '[[Home#Later|Later on]]\n\n[Anchored](#next-steps)\n\n[[Plan#Budget|The budget]]\n\n## Next steps\n\nDo it.\n\n## Later\n\nMaybe.\n' },
    { name: 'Vault/Plan.md', data: '# Plan\n\nFirst point.\n\n## Budget\n\nTen dollars.\n' },
  ]);
  await app.goto('?doc=welcome');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), app.menu('File', 'Import…')]);
  await chooser.setFiles({ name: 'vault.zip', mimeType: 'application/zip', buffer: zip });
  await expect.poll(() => status(page)).toBe('Imported documents: 2');
  await app.menu('File', 'Open…');
  await dashboard(page).getByRole('button', { name: 'Open folder Vault' }).click();
  await dashboard(page).getByRole('button', { name: 'Open Home.md' }).click();
  await expect.poll(() => app.text()).toContain('Maybe.');

  await app.press('ControlOrMeta+Home');
  await app.idle();
  await followAtCaret(page);
  await expect.poll(() => caret(page)).toBe(5);

  await app.press('ControlOrMeta+Home');
  await app.press('ArrowDown');
  await app.idle();
  await followAtCaret(page);
  await expect.poll(() => caret(page)).toBe(3);

  await app.press('ControlOrMeta+Home');
  await app.press('ArrowDown');
  await app.press('ArrowDown');
  await app.idle();
  await followAtCaret(page);
  // Not app.text() before the caret is read: it selects everything to read it.
  await expect.poll(() => status(page)).toContain('Plan.md');
  await expect.poll(() => caret(page)).toBe(2);
  expect(await app.text()).toContain('Ten dollars.');
});
