// A deck's design (docs/slides.md, M5): Slide › Background, Slide › Theme and Slide › Edit Master restyle a plain deck
// entirely, and the downloaded .pptx carries the background on the master, the new theme, dark pages and the master's title
// style, while every part the restyle did not touch comes back byte for byte.

import { writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { MOD, expect, test } from '../files/fixtures';
import { dropFile, fixture, readZip, waitForOpen } from '../files/helpers';

interface SlidesState {
  slides: { name: string; title: string; layout: string; shapes: { name: string }[] }[];
  current: number;
  selected: string[];
  masterView: boolean;
  canUndo: boolean;
}

const state = (page: Page): Promise<SlidesState> => page.evaluate(() => (window as unknown as { slidesEditor: { state(): SlidesState } }).slidesEditor.state());
const run = (page: Page, id: string): Promise<unknown> => page.evaluate((command) => (window as unknown as { golem: { commands: { run(id: string): Promise<boolean> } } }).golem.commands.run(command), id);

/** The XML of the slide whose title is `title`, in a downloaded deck. */
const slideXml = (bytes: Buffer, title: string): string =>
  readZip(bytes)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p.name))
    .map((p) => p.bytes.toString('utf8'))
    .find((xml) => xml.includes(title))!;

async function open(app: Parameters<typeof waitForOpen>[0], page: Page): Promise<void> {
  await app.goto('?doc=welcome');
  await dropFile(page, { ...fixture('slides/review.pptx'), name: 'review.pptx' });
  await waitForOpen(app, 'review.pptx');
  await expect.poll(async () => (await state(page))?.slides.length, { timeout: 20_000 }).toBe(2);
}

test('a plain deck is restyled: background for all, a theme with dark slides, and the master title', async ({ app, page }, testInfo) => {
  await open(app, page);

  // Background: a gradient for every slide, so the master holds it.
  await app.menu('Slide', 'Background');
  const background = page.getByRole('dialog', { name: 'Background' });
  await background.getByRole('radio', { name: 'Gradient' }).click();
  await background.getByRole('button', { name: 'Apply to All' }).click();
  await expect(background).toBeHidden();

  // Theme: the Blue colours, the Cambria fonts, dark slides.
  await app.menu('Slide', 'Theme');
  const theme = page.getByRole('dialog', { name: 'Theme' });
  await theme.getByRole('listbox', { name: 'Colors' }).getByRole('option', { name: 'Blue' }).click();
  await theme.getByRole('listbox', { name: 'Fonts' }).getByRole('option', { name: 'Cambria / Calibri' }).click();
  await theme.getByRole('radio', { name: 'Dark' }).click();
  await theme.getByRole('button', { name: 'Apply' }).click();
  await expect(theme).toBeHidden();

  // The master's title, made bold in master view, reaches the slides.
  await app.menu('Slide', 'Edit Master');
  await expect.poll(async () => (await state(page)).masterView).toBe(true);
  await expect(page.getByRole('region', { name: 'Slide Master' }).getByRole('button', { name: 'Close Master View' })).toBeVisible();
  // New Slide is about slides: it waits until master view is closed.
  await app.menu('Slide');
  await expect(page.getByRole('menu').getByRole('menuitem', { name: 'New Slide' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Home');
  await expect.poll(async () => (await state(page)).current).toBe(0);
  await page.keyboard.press('Tab');
  await expect.poll(async () => (await state(page)).selected).toEqual(['Title Placeholder 1']);
  await run(page, 'format.bold');
  await page.getByRole('button', { name: 'Close Master View' }).click();
  await expect.poll(async () => (await state(page)).masterView).toBe(false);
  expect((await state(page)).slides.length).toBe(2);

  const file = await app.download(() => app.menu('File', 'Download'));
  writeFileSync(testInfo.outputPath('restyled.pptx'), file.bytes);
  const parts = new Map(readZip(file.bytes).map((p) => [p.name, p.bytes.toString('utf8')]));
  const master = parts.get('ppt/slideMasters/slideMaster1.xml')!;
  expect(master).toMatch(/<p:cSld[^>]*><p:bg><p:bgPr><a:gradFill/);
  expect(master).toMatch(/<p:clrMap[^>]*bg1="dk1"/);
  expect(master).toMatch(/<p:titleStyle><a:lvl1pPr[^>]*>.*?<a:defRPr[^>]*b="1"/);
  const themeXml = parts.get('ppt/theme/theme1.xml')!;
  expect(themeXml).toContain('<a:accent1><a:srgbClr val="0F6FC6"/></a:accent1>');
  expect(themeXml).toMatch(/<a:majorFont><a:latin typeface="Cambria"/);
  for (const [name, xml] of parts) if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) expect(xml, name).not.toContain('<p:bg>');

  // Nothing else was rewritten: the layouts, the notes master and the package's other parts are as they came.
  const original = new Map(readZip(fixture('slides/review.pptx').buffer).map((p) => [p.name, p.bytes.toString('utf8')]));
  const changed = [...parts].filter(([name, xml]) => original.get(name) !== xml).map(([name]) => name);
  expect(changed.sort()).toEqual(['ppt/slideMasters/slideMaster1.xml', 'ppt/theme/theme1.xml']);
});

test("one slide's background is set, reset to the master's, and undone", async ({ app, page }) => {
  await open(app, page);
  await app.menu('Slide', 'Background');
  const dialog = page.getByRole('dialog', { name: 'Background' });
  await expect(dialog.getByRole('radio', { name: 'Solid' })).toHaveAttribute('aria-checked', 'true');
  // Picture with no picture chosen says so, and stays open.
  await dialog.getByRole('radio', { name: 'Picture' }).click();
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Choose a picture first.');
  await dialog.getByRole('radio', { name: 'Solid' }).click();
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog).toBeHidden();
  let file = await app.download(() => app.menu('File', 'Download'));
  let slide = slideXml(file.bytes, 'Quarterly review');
  expect(slide).toMatch(/<p:cSld[^>]*><p:bg><p:bgPr><a:solidFill>/);

  // Reset Background takes the slide's own away again.
  await app.menu('Slide', 'Background');
  await page.getByRole('dialog', { name: 'Background' }).getByRole('button', { name: 'Reset Background' }).click();
  file = await app.download(() => app.menu('File', 'Download'));
  slide = slideXml(file.bytes, 'Quarterly review');
  expect(slide).not.toContain('<p:bg>');
  // And undo puts it back.
  await page.keyboard.press(`${MOD}+z`);
  file = await app.download(() => app.menu('File', 'Download'));
  slide = slideXml(file.bytes, 'Quarterly review');
  expect(slide).toContain('<p:bg>');
});
