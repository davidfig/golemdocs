// Audio and video open in the media viewer (client/src/media): played, never edited. A small file is kept like any other; a file
// over 50 MB plays from where it is. Captions come from a .vtt or .srt file beside it, and a link can name a moment.

import { expect, test } from '../files/fixtures';
import { dropFile, formatLabel, text } from '../files/helpers';
import { dropRecordedVideo, player, wav, waitForMedia } from './helpers';

test('a dropped WAV opens in the player, with its waveform, and is kept like any other file', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, wav('tone.wav', 12));
  await waitForMedia(app, 'tone.wav');
  const state = await player(page);
  expect(state.kind).toBe('audio');
  expect(state.video).toBe(false);
  expect(Math.round(state.duration)).toBe(12);
  expect(await formatLabel(page)).toBe('Audio');
  await expect(page.locator('.wm-media-wave')).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Position' })).toHaveAttribute('aria-valuetext', '0 seconds of 12 seconds');
  // Saved in this browser: it opens again from there after a reload.
  await expect.poll(() => new URL(page.url()).searchParams.get('doc') ?? '').toMatch(/^local:/);
  await page.reload();
  await app.ready();
  await waitForMedia(app, 'tone.wav');
  expect(Math.round((await player(page)).duration)).toBe(12);
});

test('the player is driven from the keyboard', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, wav('keys.wav', 30));
  await waitForMedia(app, 'keys.wav');
  const region = page.getByRole('region', { name: 'keys.wav' });
  await expect(region).toBeFocused();
  const at = async () => Math.round((await player(page)).currentTime);
  await page.keyboard.press('l');
  expect(await at()).toBe(10);
  await page.keyboard.press('ArrowRight');
  expect(await at()).toBe(15);
  await page.keyboard.press('j');
  expect(await at()).toBe(5);
  await page.keyboard.press('End');
  expect(await at()).toBe(30);
  await page.keyboard.press('Home');
  expect(await at()).toBe(0);
  await page.keyboard.press('m');
  expect((await player(page)).muted).toBe(true);
  await expect(page.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('>');
  await expect(page.getByRole('button', { name: 'Speed' })).toContainText('1.25×');
});

test('the Playback menu plays and pauses, and the document menus offer nothing that edits', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropRecordedVideo(page, 'clip.webm');
  await waitForMedia(app, 'clip.webm');
  expect((await player(page)).video).toBe(true);
  expect(await formatLabel(page)).toBe('Video');
  await expect(page.getByRole('button', { name: 'Full Screen' })).toBeVisible();
  await page.evaluate(() => ((document.querySelector('.wm-media video') as HTMLVideoElement).muted = true));
  await app.menu('Playback', 'Play or Pause');
  await expect.poll(async () => (await player(page)).playing).toBe(true);
  await app.menu('Playback', 'Play or Pause');
  await expect.poll(async () => (await player(page)).playing).toBe(false);
  // Nothing to undo, find or convert.
  expect(await app.run('edit.undo')).toBe(false);
  expect(await app.run('edit.find')).toBe(false);
});

test('captions come from a SubRip file beside the audio, and show under the waveform', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, text('talk.srt', '1\n00:00:00,500 --> 00:00:05,000\nHello from the captions\n'));
  await app.page.waitForFunction(() => document.title.startsWith('talk'));
  await dropFile(page, wav('talk.wav', 8));
  await waitForMedia(app, 'talk.wav');
  const captions = page.getByRole('button', { name: 'Captions' });
  await expect(captions).toBeVisible();
  await page.getByRole('region', { name: 'talk.wav' }).focus();
  await page.keyboard.press('c');
  await expect(captions).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => ((document.querySelector('.wm-media audio') as HTMLAudioElement).currentTime = 2));
  await expect(page.locator('.wm-media-cue')).toHaveText('Hello from the captions');
});

test('Copy Link to This Moment copies a link that opens the file at that time', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, wav('moment.wav', 20));
  await waitForMedia(app, 'moment.wav');
  await page.getByRole('region', { name: 'moment.wav' }).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await app.menu('Edit', 'Copy Link to This Moment');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('[[moment.wav#t=0:10]]');
  // A note that links there: following the link opens the audio at 0:10.
  await dropFile(page, text('notes.md', '# Notes\n\nSee [[moment.wav#t=0:10]] here.\n'));
  await app.page.waitForFunction(() => document.title.startsWith('notes'));
  await app.ready();
  await app.idle();
  await page.evaluate(() => window.golem.doc.select(1, 6, 6));
  await app.run('insert.link');
  await page.getByRole('button', { name: 'Open link' }).click();
  await waitForMedia(app, 'moment.wav');
  await expect.poll(async () => Math.round((await player(page)).currentTime)).toBe(10);
});

test('a file the browser cannot read says so, rather than showing an empty player', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, { name: 'broken.mp4', buffer: Buffer.from('this is not a video'), mimeType: 'video/mp4' });
  await waitForMedia(app, 'broken.mp4');
  await expect(page.getByRole('alert').filter({ hasText: 'broken.mp4 can’t be played here.' })).toBeVisible();
});

test('audio over 50 MB plays from the file and is not copied into the browser', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  // 51 MB of silence, made in the page: a WAV header and zeros.
  await page.evaluate(() => {
    const size = 51 * 1024 * 1024;
    const header = new DataView(new ArrayBuffer(44));
    const ascii = (at: number, s: string) => [...s].forEach((c, i) => header.setUint8(at + i, c.charCodeAt(0)));
    ascii(0, 'RIFF');
    header.setUint32(4, 36 + size, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    header.setUint32(16, 16, true);
    header.setUint16(20, 1, true);
    header.setUint16(22, 1, true);
    header.setUint32(24, 44100, true);
    header.setUint32(28, 88200, true);
    header.setUint16(32, 2, true);
    header.setUint16(34, 16, true);
    ascii(36, 'data');
    header.setUint32(40, size, true);
    const dt = new DataTransfer();
    dt.items.add(new File([header.buffer, new Uint8Array(size)], 'long.wav', { type: 'audio/wav' }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: 400, clientY: 400, bubbles: true, cancelable: true }));
  });
  await waitForMedia(app, 'long.wav');
  const state = await player(page);
  expect(state.inPlace).toBe(true);
  expect(Math.round(state.duration)).toBe(Math.round((51 * 1024 * 1024) / 88200));
  await expect(page.getByText('long.wav is over 50 MB, so it plays from this computer')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('doc')).toBeNull();
});
