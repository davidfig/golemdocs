// Obsidian embeds in a Markdown note: `![[map.png]]` shows the picture and `![[Plan]]` shows the other note's text, both from the
// vault they were imported with; saving the note as Markdown writes the embeds back, not what they show.

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { buildPng, buildZip, status } from './helpers';

const dashboard = (page: Page) => page.locator('.wm-dashboard');
const imagesOnPage = (page: Page) => page.evaluate(() => (window as unknown as { pages: { images: unknown[] }[] }).pages.reduce((n, p) => n + p.images.length, 0));

test('a note shows the pictures and notes it embeds, and writes them back as embeds', async ({ app, page }) => {
  const home = 'Intro line.\n\n![[map.png]]\n\n![[Plan#Budget]]\n\nOutro line. See [[Plan]].\n';
  const zip = buildZip([
    { name: 'Vault/', data: '' },
    { name: 'Vault/Home.md', data: home },
    { name: 'Vault/Plan.md', data: '# Plan\n\nFirst point.\n\n## Budget\n\nTen dollars.\n\n## Risks\n\nNone.\n' },
    { name: 'Vault/map.png', data: buildPng(120, 60) },
  ]);
  await app.goto('?doc=welcome');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), app.menu('File', 'Import…')]);
  await chooser.setFiles({ name: 'vault.zip', mimeType: 'application/zip', buffer: zip });
  await expect.poll(() => status(page)).toBe('Imported documents: 3');
  await app.menu('File', 'Open…');
  await dashboard(page).getByRole('button', { name: 'Open folder Vault' }).click();
  await dashboard(page).getByRole('button', { name: 'Open Home.md' }).click();

  // The picture is on the page, the section's text is in place, and the link to the whole note is still a link.
  await expect.poll(() => imagesOnPage(page)).toBe(1);
  await expect.poll(() => app.text()).toContain('Ten dollars.');
  const text = await app.text();
  expect(text).not.toContain('map.png');
  expect(text).not.toContain('Risks');
  expect(text).toContain('Outro line. See Plan.');

  const file = await app.download(() => app.menu('File', 'Download'));
  expect(file.text.trim()).toBe(home.trim());
});
