// Audio and video for the media specs, made here rather than committed: a WAV is written byte by byte, and a WebM is recorded
// in the page from a canvas (Playwright's Chromium plays WAV, WebM and Ogg, but not H.264 or AAC).

import type { Page } from '@playwright/test';
import type { Upload } from '../files/helpers';
import type { App } from '../fixtures';

/** A mono 16-bit WAV of `seconds` of a 440 Hz tone that swells and fades three times (so its waveform has a shape). */
export function wav(name: string, seconds: number, rate = 8000): Upload {
  const n = seconds * rate;
  const buffer = Buffer.alloc(44 + n * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + n * 2, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buffer.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 12000 * Math.abs(Math.sin((i / n) * Math.PI * 3))), 44 + i * 2);
  return { name, buffer, mimeType: 'audio/wav' };
}

/** Records `seconds` of a counting, colour-changing canvas as WebM in the page, and drops it on the window as `name`. */
export async function dropRecordedVideo(page: Page, name: string, seconds = 2): Promise<void> {
  await page.evaluate(
    async ({ name, seconds }) => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 320, height: 180 });
      const context = canvas.getContext('2d')!;
      const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm;codecs=vp8' });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      let frame = 0;
      const draw = () => {
        frame++;
        context.fillStyle = `hsl(${frame * 6}, 70%, 50%)`;
        context.fillRect(0, 0, 320, 180);
      };
      draw();
      const timer = setInterval(draw, 33);
      recorder.start();
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      const stopped = new Promise((resolve) => (recorder.onstop = resolve));
      recorder.stop();
      await stopped;
      clearInterval(timer);
      const dt = new DataTransfer();
      dt.items.add(new File(chunks, name, { type: 'video/webm' }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: 400, clientY: 400, bubbles: true, cancelable: true }));
    },
    { name, seconds },
  );
}

/** What the media viewer shows (`window.mediaViewer`, main.ts). */
export interface PlayerState {
  active: boolean;
  name: string;
  kind: 'audio' | 'video' | null;
  currentTime: number;
  duration: number;
  video: boolean;
  failed: boolean;
  inPlace: boolean;
  playing?: boolean;
  muted?: boolean;
  captions?: boolean;
  hasCaptions?: boolean;
}

export const player = (page: Page): Promise<PlayerState> => page.evaluate(() => (window as unknown as { mediaViewer: { state(): PlayerState } }).mediaViewer.state());

/** Waits for `name` to be open in the player, its length known. */
export async function waitForMedia(app: App, name: string): Promise<void> {
  await app.page.waitForFunction(
    (wanted) => {
      const state = (window as unknown as { mediaViewer: { state(): PlayerState } }).mediaViewer.state();
      return state.active && state.name === wanted && (state.duration > 0 || state.failed);
    },
    name,
    { timeout: 30_000 },
  );
}
