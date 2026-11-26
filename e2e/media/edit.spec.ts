// Audio editing (client/src/media/edit): a WAV's waveform is selected, cut, pasted and undone, and saved as the file itself.

import { readFile } from 'node:fs/promises';
import { Mp3Writer } from '../../client/src/media/edit/mp3.ts';
import { expect, test } from '../files/fixtures';
import { dropFile, type Upload } from '../files/helpers';
import type { App } from '../fixtures';
import { player, wav, waitForMedia } from './helpers';

async function edit(app: App, name: string, seconds: number): Promise<void> {
  await app.goto('?doc=welcome');
  await dropFile(app.page, wav(name, seconds));
  await waitForMedia(app, name);
  await app.menu('Audio', 'Edit Audio');
  await expect(app.page.getByRole('slider', { name: 'Waveform' })).toBeFocused();
}

/** Drags across part of the waveform, from and to a share of its width. */
async function drag(app: App, from: number, to: number): Promise<void> {
  const box = (await app.page.getByRole('slider', { name: 'Waveform' }).boundingBox())!;
  const y = box.y + box.height / 2;
  await app.page.mouse.move(box.x + box.width * from, y);
  await app.page.mouse.down();
  await app.page.mouse.move(box.x + box.width * to, y, { steps: 4 });
  await app.page.mouse.up();
}

test('what is selected is deleted, undone, redone, and kept through Done and a reload', async ({ app, page }) => {
  await edit(app, 'cut.wav', 12);
  const wave = page.getByRole('slider', { name: 'Waveform' });
  await expect(wave).toHaveAttribute('aria-valuemax', '12');
  await drag(app, 0.25, 0.75);
  await page.keyboard.press('Delete');
  await expect(wave).toHaveAttribute('aria-valuemax', '6');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(wave).toHaveAttribute('aria-valuemax', '12');
  expect(await app.run('edit.redo')).toBe(true);
  await expect(wave).toHaveAttribute('aria-valuemax', '6');
  await page.getByRole('button', { name: 'Done' }).press('Enter');
  await waitForMedia(app, 'cut.wav');
  await expect.poll(async () => Math.round((await player(page)).duration)).toBe(6);
  await expect.poll(() => new URL(page.url()).searchParams.get('doc') ?? '').toMatch(/^local:/);
  await page.waitForTimeout(1500); // the autosave
  await page.reload();
  await app.ready();
  await waitForMedia(app, 'cut.wav');
  expect(Math.round((await player(page)).duration)).toBe(6);
});

test('cut, paste, trim and silence, from the keys and the Audio menu', async ({ app, page }) => {
  await edit(app, 'menu.wav', 8);
  const wave = page.getByRole('slider', { name: 'Waveform' });
  await page.keyboard.press('ControlOrMeta+a');
  await expect(wave).toHaveAttribute('aria-valuetext', '0 seconds to 8 seconds selected');
  // Everything can't go: the file would be empty.
  await page.keyboard.press('Delete');
  await expect(wave).toHaveAttribute('aria-valuemax', '8');
  await drag(app, 0, 0.5);
  await page.keyboard.press('ControlOrMeta+x');
  await expect(wave).toHaveAttribute('aria-valuemax', '4');
  await page.keyboard.press('ControlOrMeta+v');
  await page.keyboard.press('End');
  await page.keyboard.press('ControlOrMeta+v');
  await expect(wave).toHaveAttribute('aria-valuemax', '12');
  await drag(app, 0.5, 1);
  await app.menu('Audio', 'Silence Selection');
  await expect(wave).toHaveAttribute('aria-valuemax', '12');
  await app.menu('Audio', 'Trim to Selection');
  await expect(wave).toHaveAttribute('aria-valuemax', '6');
  await app.menu('Audio', 'Zoom In');
  await app.menu('Audio', 'Edit Audio');
  await expect.poll(async () => Math.round((await player(page)).duration)).toBe(6);
});

test('the selection plays and stops', async ({ app, page }) => {
  await edit(app, 'play.wav', 10);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await player(page)).playing).toBe(true);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await player(page)).playing).toBe(false);
  // A short selection stops by itself.
  await drag(app, 0.5, 0.55);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await player(page)).playing).toBe(true);
  await expect.poll(async () => (await player(page)).playing).toBe(false);
});

test('what can’t be decoded says so', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, { name: 'broken.mp3', buffer: Buffer.alloc(4000, 7), mimeType: 'audio/mpeg' });
  await expect.poll(() => page.evaluate(() => (window as unknown as { mediaViewer: { state(): { name: string } } }).mediaViewer.state().name)).toBe('broken.mp3');
  await app.menu('Audio', 'Edit Audio');
  await expect(page.getByText('broken.mp3 can’t be edited here')).toBeVisible();
});

/** An MP3 of a tone. */
async function mp3(name: string, seconds: number): Promise<Upload> {
  const wasm = new Uint8Array(await readFile('client/node_modules/wasm-media-encoders/wasm/mp3.wasm'));
  const writer = await Mp3Writer.open(wasm, 44100, 1, 96);
  writer.put([Float32Array.from({ length: seconds * 44100 }, (_, i) => Math.sin((i / 44100) * 2 * Math.PI * 440) * 0.5)]);
  return { name, buffer: Buffer.from(writer.finish()), mimeType: 'audio/mpeg' };
}

async function openToEdit(app: App, file: Upload): Promise<void> {
  await app.goto('?doc=welcome');
  await dropFile(app.page, file);
  await waitForMedia(app, file.name);
  await expect.poll(() => new URL(app.page.url()).searchParams.get('doc') ?? '').toMatch(/^local:/);
  await app.menu('Audio', 'Edit Audio');
  await expect(app.page.getByRole('slider', { name: 'Waveform' })).toBeFocused();
}

test('an MP3’s edits wait for Save, come back after a reload, and are saved as an MP3 of the length shown', async ({ app, page }) => {
  await openToEdit(app, await mp3('song.mp3', 10));
  const wave = page.getByRole('slider', { name: 'Waveform' });
  await expect(wave).toHaveAttribute('aria-valuemax', '10');
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeDisabled();
  await drag(app, 0, 0.5);
  await page.keyboard.press('Delete');
  await expect(wave).toHaveAttribute('aria-valuemax', '5');
  await expect(save).toBeEnabled();
  // Undone, there is nothing to save; redone, there is.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(save).toBeDisabled();
  expect(await app.run('edit.redo')).toBe(true);
  await page.waitForTimeout(1500); // the draft
  await page.reload();
  await app.ready();
  await waitForMedia(app, 'song.mp3');
  expect(Math.round((await player(page)).duration)).toBe(10); // the file is as it was
  await app.menu('Audio', 'Edit Audio');
  await expect(wave).toHaveAttribute('aria-valuemax', '5');
  await page.getByRole('button', { name: 'Done' }).press('Enter');
  await page.getByRole('dialog', { name: 'Save' }).getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => Math.round((await player(page)).duration)).toBe(5);
  await page.waitForTimeout(1500);
  await page.reload();
  await app.ready();
  await waitForMedia(app, 'song.mp3');
  expect(Math.abs((await player(page)).duration - 5)).toBeLessThan(0.05);
  await app.menu('Audio', 'Edit Audio');
  await expect(wave).toHaveAttribute('aria-valuemax', '5');
  await expect(save).toBeDisabled();
});

test('Don’t Save throws a lossy file’s edits away', async ({ app, page }) => {
  await openToEdit(app, await mp3('keep.mp3', 4));
  await drag(app, 0, 0.5);
  await page.keyboard.press('Delete');
  await page.getByRole('button', { name: 'Done' }).press('Enter');
  await page.getByRole('button', { name: 'Don’t Save' }).click();
  await waitForMedia(app, 'keep.mp3');
  await app.menu('Audio', 'Edit Audio');
  await expect(page.getByRole('slider', { name: 'Waveform' })).toHaveAttribute('aria-valuemax', '4');
});

test('audio in another lossy format is saved as a FLAC, which can be edited in place', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  // Opus in WebM is the only kind Chromium records; named as audio it is decoded all the same.
  await page.evaluate(async () => {
    const context = new AudioContext();
    const out = context.createMediaStreamDestination();
    const tone = context.createOscillator();
    tone.connect(out);
    tone.start();
    const recorder = new MediaRecorder(out.stream, { mimeType: 'audio/webm;codecs=opus' });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const stopped = new Promise((resolve) => (recorder.onstop = resolve));
    recorder.stop();
    await stopped;
    const dt = new DataTransfer();
    dt.items.add(new File(chunks, 'voice.opus', { type: 'audio/ogg' }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: 400, clientY: 400, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => new URL(page.url()).searchParams.get('doc') ?? '').toMatch(/^local:/);
  await app.menu('Audio', 'Edit Audio');
  const wave = page.getByRole('slider', { name: 'Waveform' });
  await expect(wave).toBeFocused();
  await drag(app, 0, 0.5);
  await page.keyboard.press('Delete');
  await page.getByRole('button', { name: 'Save', exact: true }).press('Enter');
  await waitForMedia(app, 'voice.flac');
  await expect.poll(async () => (await player(page)).duration).toBeLessThan(2);
  await app.menu('Audio', 'Edit Audio');
  await expect(wave).toBeFocused();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+c');
  await page.keyboard.press('End');
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(async () => Number(await wave.getAttribute('aria-valuemax'))).toBeGreaterThan(1);
  const doubled = Number(await wave.getAttribute('aria-valuemax'));
  await page.getByRole('button', { name: 'Done' }).press('Enter');
  await waitForMedia(app, 'voice.flac');
  await expect.poll(async () => Math.round((await player(page)).duration)).toBe(doubled);
});

test('effects and generated sound change the length they say, and undo', async ({ app, page }) => {
  await edit(app, 'fx.wav', 8);
  const wave = page.getByRole('slider', { name: 'Waveform' });
  const effect = async (name: string, fill: Record<string, string> = {}, submenu = 'Effects'): Promise<void> => {
    await app.menu('Audio', submenu, name);
    const dialog = page.getByRole('dialog', { name: name.replace('…', '') });
    for (const [label, value] of Object.entries(fill)) await dialog.getByLabel(label).fill(value);
    await dialog.getByRole('button', { name: 'OK' }).click();
    await expect(dialog).toHaveCount(0);
  };
  await effect('Speed and Pitch…', { 'Speed (percent)': '200' });
  await expect(wave).toHaveAttribute('aria-valuemax', '4');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(wave).toHaveAttribute('aria-valuemax', '8');
  await page.keyboard.press('Home');
  await effect('Tone…', { 'Duration (seconds)': '2' }, 'Generate');
  await expect(wave).toHaveAttribute('aria-valuemax', '10');
  await expect(wave).toHaveAttribute('aria-valuetext', '0 seconds to 2 seconds selected');
  await page.keyboard.press('End');
  await effect('Silence…', { 'Duration (seconds)': '3' }, 'Generate');
  await expect(wave).toHaveAttribute('aria-valuemax', '13');
  await page.keyboard.press('Home');
  await effect('Change Volume…', { 'Volume change (decibels)': '-6' });
  await effect('Normalize…');
  await effect('Equalizer…');
  await effect('Compressor…');
  for (const name of ['Fade In', 'Fade Out', 'Reverse']) await app.menu('Audio', 'Effects', name);
  await expect(wave).toHaveAttribute('aria-valuemax', '13');
  // A number out of range is refused, saying what it may be.
  await app.menu('Audio', 'Effects', 'Change Volume…');
  const dialog = page.getByRole('dialog', { name: 'Change Volume' });
  await dialog.getByLabel('Volume change (decibels)').fill('900');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog.getByRole('alert')).toContainText('-60 to 60');
  await dialog.getByLabel('Volume change (decibels)').fill('3');
  await dialog.getByRole('button', { name: 'Preview' }).click();
  await expect(dialog.getByRole('button', { name: 'Stop' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Stop' }).click();
  await expect(dialog.getByRole('button', { name: 'Preview' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // Noise is sampled before it is reduced.
  await app.menu('Audio', 'Effects', 'Reduce Noise…');
  await expect(page.getByText('First select a part that is only noise')).toBeVisible();
  await drag(app, 0.1, 0.3);
  await app.menu('Audio', 'Effects', 'Take Noise Sample');
  await effect('Reduce Noise…');
  await expect(wave).toHaveAttribute('aria-valuemax', '13');
});

test('labels are kept as captions beside the file, move with edits, and can be gone to', async ({ app, page }) => {
  await edit(app, 'talk.wav', 10);
  const wave = page.getByRole('slider', { name: 'Waveform' });
  await drag(app, 0.5, 0.6);
  await page.keyboard.press('l');
  const dialog = page.getByRole('dialog', { name: 'Label' });
  await dialog.getByLabel('Text').fill('The second half');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await drag(app, 0, 0.2);
  await page.keyboard.press('Delete');
  await expect(wave).toHaveAttribute('aria-valuemax', '8');
  await page.keyboard.press('Home');
  await page.keyboard.press(']');
  await expect(wave).toHaveAttribute('aria-valuetext', '3 seconds to 4 seconds selected');
  await page.waitForTimeout(2500); // the labels' file, and the autosave
  await page.reload();
  await app.ready();
  await waitForMedia(app, 'talk.wav');
  await expect.poll(async () => (await player(page)).hasCaptions).toBe(true);
  await app.menu('Audio', 'Edit Audio');
  await expect(wave).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press(']');
  await expect(wave).toHaveAttribute('aria-valuetext', '3 seconds to 4 seconds selected');
  await page.keyboard.press('l');
  await expect(dialog.getByLabel('Text')).toHaveValue('The second half');
  await dialog.getByRole('button', { name: 'Delete Label' }).click();
  await page.keyboard.press('Home');
  await page.keyboard.press(']');
  await expect(wave).not.toHaveAttribute('aria-valuetext', /selected/);
});

test('the spectrogram shows and hides', async ({ app, page }) => {
  await edit(app, 'picture.wav', 5);
  const button = page.getByRole('button', { name: 'Spectrogram' });
  const picture = (): Promise<string> => page.locator('.wm-audio-wave canvas').evaluate((c) => (c as HTMLCanvasElement).toDataURL());
  const before = await picture();
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(picture).not.toBe(before);
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
});

test('a new recording takes the place of the silence it starts with, and is saved', async ({ app, page }) => {
  // A tone stands in for the microphone.
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const out = context.createMediaStreamDestination();
      const tone = context.createOscillator();
      tone.connect(out);
      tone.start();
      return out.stream;
    };
  });
  await app.goto('?doc=welcome');
  await app.menu('File', 'New Audio Recording');
  const wave = page.getByRole('slider', { name: 'Waveform' });
  await expect(wave).toBeFocused();
  await page.keyboard.press('r');
  await expect(page.getByRole('button', { name: 'Stop Recording' })).toBeVisible();
  await page.waitForTimeout(2500);
  await page.keyboard.press('r');
  await expect(page.getByRole('button', { name: 'Record', exact: true })).toBeVisible();
  await expect.poll(async () => Number(await wave.getAttribute('aria-valuemax'))).toBeGreaterThanOrEqual(2);
  // Recording again, left without stopping: it is in the file all the same.
  await page.keyboard.press('End');
  await page.keyboard.press('r');
  await expect(page.getByRole('button', { name: 'Stop Recording' })).toBeVisible();
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: 'Done' }).press('Enter');
  await waitForMedia(app, 'Recording.wav');
  await expect.poll(async () => (await player(page)).duration).toBeGreaterThan(3.5);
  await page.waitForTimeout(1500);
  await page.reload();
  await app.ready();
  await waitForMedia(app, 'Recording.wav');
  expect((await player(page)).duration).toBeGreaterThan(3.5);
});

test('a microphone that isn’t allowed says so', async ({ app, page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('no', 'NotAllowedError');
    };
  });
  await edit(app, 'quiet.wav', 3);
  await app.menu('Audio', 'Record');
  await expect(page.getByText('isn’t allowed to use the microphone')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record', exact: true })).toBeEnabled();
});
