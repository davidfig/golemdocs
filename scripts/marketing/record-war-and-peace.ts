// pnpm record:home: re-records the clip on the home page's performance section
// (client/public/home/war-and-peace.webm): War and Peace in Page Grid, zooming from the whole book
// down to readable text and back.
//
// Run it again whenever the app's look changes. It needs the dev server on :5173 (`pnpm dev`, started
// by you), and drives the real app in Chromium, so it uses the GPU through Metal on a Mac.
//
//   pnpm record:home                       writes client/public/home/war-and-peace.webm
//   pnpm record:home --url http://localhost:5174 --out /tmp/clip.webm
//
// Playwright's own video recorder is far too blocky for text, so this steps the zoom one frame at a
// time, takes a sharp 2x screenshot of each step, and encodes those frames itself. It uses the ffmpeg
// that Playwright installs (VP8 WebM only: no H.264), or an `ffmpeg` on the PATH.

/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};

const URL = arg('url', 'http://localhost:5173');
const OUT = path.resolve(arg('out', path.join(root, 'client/public/home/war-and-peace.webm')));
const FPS = 30;
const VIEWPORT = { width: 1280, height: 720 };
/** The zoom the clip ends its zoom-in at (1 = 100%) and the one it zooms back out to. */
const ZOOM_IN = 1.3;
const ZOOM_OUT = 0.03;
/** Where the zoom is anchored, a point on a page of text. */
const ANCHOR = { x: 652, y: 395 };

function findFfmpeg(): string {
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache).filter((d) => d.startsWith('ffmpeg-')).sort().reverse()) {
      const bin = path.join(cache, dir, 'ffmpeg-mac');
      if (existsSync(bin)) return bin;
    }
  }
  return 'ffmpeg';
}

async function capture(frames: string): Promise<number> {
  writeFileSync(frames, '');
  const browser = await chromium.launch({ channel: 'chromium', args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
    // Spelling marks (the Russian names), the pages and files sidebars and the signed-out notice would only add noise.
    await context.addInitScript(() => {
      try {
        localStorage.setItem('word.spelling.asYouType', 'off');
        localStorage.setItem('word.pagesPanel', 'off');
        localStorage.setItem('word.filesPanel', 'off');
        localStorage.setItem('golem.sharedDeviceNotice.dismissed', '1');
      } catch {
        // No storage: the clip just shows them.
      }
    });
    const page = await context.newPage();
    await page.goto(`${URL}/?doc=war-and-peace`);
    await page.waitForFunction(() => (window as unknown as { loaded?: boolean }).loaded === true, null, { timeout: 60_000 });
    await page.waitForTimeout(1500);
    await page.getByRole('menubar').getByText('View', { exact: true }).click();
    await page.getByRole('menuitemradio', { name: /^Page Grid/ }).click();
    // The Admin menu only shows for the developer's own account.
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('[role=menubar] *')) if (el.textContent?.trim() === 'Admin') (el as HTMLElement).style.display = 'none';
    });
    await page.mouse.move(ANCHOR.x, ANCHOR.y);
    await page.waitForTimeout(2500);

    let count = 0;
    const shot = (): Promise<Buffer> => page.screenshot({ type: 'jpeg', quality: 95 });
    const hold = (frame: Buffer, seconds: number): void => {
      for (let i = 0; i < Math.round(seconds * FPS); i++, count++) appendFileSync(frames, frame);
    };
    const zoom = (): Promise<number> => page.evaluate(() => (window as unknown as { camera: { zoom: number } }).camera.zoom);
    const settle = (): Promise<void> => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    /** One wheel notch per frame, so the zoom speed does not depend on how long a screenshot takes. */
    const sweep = async (dy: number, done: (zoom: number) => boolean): Promise<void> => {
      await page.keyboard.down('Control');
      for (let i = 0; i < 300 && !done(await zoom()); i++) {
        await page.mouse.wheel(0, dy);
        await settle();
        appendFileSync(frames, await shot());
        count++;
      }
      await page.keyboard.up('Control');
    };

    hold(await shot(), 1.5);
    await sweep(-25, (z) => z >= ZOOM_IN);
    hold(await shot(), 2);
    await sweep(25, (z) => z <= ZOOM_OUT);
    hold(await shot(), 1);
    return count;
  } finally {
    await browser.close();
  }
}

const work = mkdtempSync(path.join(os.tmpdir(), 'golem-clip-'));
try {
  const frames = path.join(work, 'frames.mjpg');
  const count = await capture(frames);
  const encode = spawnSync(
    findFfmpeg(),
    ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS), '-i', frames, '-an', '-vf', 'scale=1920:1080:flags=lanczos', '-c:v', 'libvpx', '-crf', '6', '-b:v', '5M', '-pix_fmt', 'yuv420p', OUT],
    { stdio: 'inherit' },
  );
  if (encode.status !== 0) throw new Error('ffmpeg failed to encode the clip');
  console.log(`${path.relative(root, OUT)}: ${count} frames, ${(count / FPS).toFixed(1)} s`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
