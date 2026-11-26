// The media viewer with a screen reader or the keyboard alone: its controls have names and roles, the position is spoken as a
// time, F6 reaches the player, and Tab goes through its controls.

import { expect, test } from '../files/fixtures';
import { dropFile } from '../files/helpers';
import { wav, waitForMedia } from '../media/helpers';

test('the player and its controls are named, and the position is a slider spoken as a time', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, wav('named.wav', 75));
  await waitForMedia(app, 'named.wav');
  const region = page.getByRole('region', { name: 'named.wav' });
  const bar = region.getByRole('toolbar', { name: 'Playback controls' });
  for (const name of ['Play', 'Back 10 Seconds', 'Forward 10 Seconds', 'Mute']) await expect(bar.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(bar.getByRole('slider', { name: 'Volume' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Speed' })).toBeVisible();
  const position = bar.getByRole('slider', { name: 'Position' });
  await expect(position).toHaveAttribute('aria-valuetext', '0 seconds of 1 minute 15 seconds');
  await region.focus();
  await page.keyboard.press('l');
  await expect(position).toHaveAttribute('aria-valuetext', '10 seconds of 1 minute 15 seconds');
  // Play becomes Pause while it plays.
  await page.evaluate(() => ((document.querySelector('.wm-media audio') as HTMLAudioElement).muted = true));
  await bar.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(bar.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
});

test('F6 reaches the player, and Tab goes through its controls in order', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, wav('keys.wav', 10));
  await waitForMedia(app, 'keys.wav');
  const region = page.getByRole('region', { name: 'keys.wav' });
  // Away to the menu bar, then F6 until the player has the keyboard.
  await page.keyboard.press('F10');
  for (let i = 0; i < 8 && !(await region.evaluate((el) => el.contains(document.activeElement))); i++) await page.keyboard.press('F6');
  await expect.poll(() => region.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await region.focus();
  const names: string[] = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    names.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? ''));
  }
  expect(names).toEqual(['Play', 'Back 10 Seconds', 'Forward 10 Seconds', 'Position', 'Mute', 'Volume']);
});

test('the audio editor is reached and worked by keyboard, and its waveform is a slider that says what is selected', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, wav('edit.wav', 10));
  await waitForMedia(app, 'edit.wav');
  const open = page.getByRole('button', { name: 'Edit Audio' });
  await open.focus();
  await page.keyboard.press('Enter');
  const region = page.getByRole('region', { name: 'Editing edit.wav' });
  const wave = region.getByRole('slider', { name: 'Waveform' });
  await expect(wave).toBeFocused();
  await expect(wave).toHaveAttribute('aria-valuetext', '0 seconds of 10 seconds');
  const bar = region.getByRole('toolbar', { name: 'Audio editing tools' });
  await expect(bar.getByRole('button', { name: 'Delete Selection' })).toBeDisabled();
  await page.keyboard.press('Shift+End');
  await expect(wave).toHaveAttribute('aria-valuetext', '0 seconds to 10 seconds selected');
  for (const name of ['Play', 'Delete Selection', 'Trim to Selection', 'Silence Selection', 'Zoom In', 'Zoom Out', 'Zoom to Selection', 'Zoom to Whole File', 'Done']) await expect(bar.getByRole('button', { name, exact: true })).toBeEnabled();
  for (const name of ['Record', 'Label…', 'Spectrogram']) await expect(bar.getByRole('button', { name: name.replace('…', '') })).toBeEnabled();
  // An effect's dialog is named, starts in its first field, and gives the keyboard back.
  await app.menu('Audio', 'Effects', 'Equalizer');
  const dialog = page.getByRole('dialog', { name: 'Equalizer' });
  await expect(dialog.getByRole('slider', { name: '31 Hz' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(wave).toBeFocused();
  // A label by keyboard: it is made, and gone to.
  await page.keyboard.press('l');
  await page.getByRole('dialog', { name: 'Label' }).getByLabel('Text').fill('All of it');
  await page.keyboard.press('Enter');
  await expect(wave).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.press('[');
  await expect(wave).toHaveAttribute('aria-valuetext', '0 seconds to 10 seconds selected');
  await page.keyboard.press('Escape');
  await expect(wave).toHaveAttribute('aria-valuetext', '0 seconds of 10 seconds');
  // Away to the menu bar, then F6 until the editor has the keyboard.
  await page.keyboard.press('F10');
  for (let i = 0; i < 8 && !(await region.evaluate((el) => el.contains(document.activeElement))); i++) await page.keyboard.press('F6');
  await expect.poll(() => region.evaluate((el) => el.contains(document.activeElement))).toBe(true);
});
