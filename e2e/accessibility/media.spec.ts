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
