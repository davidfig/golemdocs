// What the home page's clips share (record-war-and-peace.ts, record-workbook.ts): the command line, a Chromium on the GPU
// with the app's theme set, the frame-by-frame zoom, and the encoding.
//
// Playwright's own video recorder is far too blocky for text, so a clip steps the zoom one frame at a time, takes a sharp
// 2x screenshot of each step, and encodes those frames itself. It uses the ffmpeg that Playwright installs (VP8 WebM only:
// no H.264), or an `ffmpeg` on the PATH.

/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const arg = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};

export const URL = arg('url', 'http://localhost:5173');
export type Theme = 'light' | 'dark';
export const FPS = 30;
export const VIEWPORT = { width: 1280, height: 720 };

/** The themes asked for (`--theme light` or `dark`), both by default. */
function themes(): Theme[] {
  const theme = arg('theme', '');
  const list: Theme[] = theme === 'light' ? ['light'] : theme === 'dark' ? ['dark'] : ['light', 'dark'];
  if (process.argv.includes('--out') && list.length > 1) throw new Error('--out names one clip: add --theme light or --theme dark');
  return list;
}

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

/** A page of the app at `address` in `theme`, with its panels and notices out of the way. */
export async function openApp(browser: Browser, address: string, theme: Theme): Promise<Page> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  // Spelling marks, the pages and files sidebars and the signed-out notice would only add noise.
  await context.addInitScript((dark) => {
    try {
      // The theme is the app's own setting (ui/theme.ts), so the clip shows what someone using it sees: in the dark one, dark pages too.
      localStorage.setItem('golem.appearance', dark ? 'dark' : 'light');
      localStorage.setItem('golem.darkPages', dark ? 'on' : 'off');
      localStorage.setItem('word.spelling.asYouType', 'off');
      localStorage.setItem('word.pagesPanel', 'off');
      localStorage.setItem('word.filesPanel', 'off');
      localStorage.setItem('golem.sharedDeviceNotice.dismissed', '1');
    } catch {
      // No storage: the clip just shows them.
    }
  }, theme === 'dark');
  const page = await context.newPage();
  await page.goto(`${URL}/${address}`);
  await page.waitForFunction(() => (window as unknown as { loaded?: boolean }).loaded === true, null, { timeout: 60_000 });
  return page;
}

/** The Admin menu only shows for the developer's own account. */
export async function hideAdminMenu(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('[role=menubar] *')) if (el.textContent?.trim() === 'Admin') (el as HTMLElement).style.display = 'none';
  });
}

/** Writes frames (JPEG screenshots) to `file`, one after another. */
export class Frames {
  count = 0;

  constructor(
    private readonly page: Page,
    private readonly file: string,
  ) {}

  shot(): Promise<Buffer> {
    return this.page.screenshot({ type: 'jpeg', quality: 95 });
  }

  /** The same frame for `seconds`. */
  hold(frame: Buffer, seconds: number): void {
    for (let i = 0; i < Math.round(seconds * FPS); i++, this.count++) appendFileSync(this.file, frame);
  }

  zoom(): Promise<number> {
    return this.page.evaluate(() => (window as unknown as { camera: { zoom: number } }).camera.zoom);
  }

  /** Waits for the app to draw two frames. */
  settle(): Promise<void> {
    return this.page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  }

  /**
   * Zooms (Ctrl and the wheel, at the pointer) until `done`, one wheel notch per frame, so its speed does not depend on how
   * long a screenshot takes. `done` is told the zoom and how many notches it has turned; the count is returned.
   */
  async sweep(dy: number, done: (zoom: number, notches: number) => boolean): Promise<number> {
    await this.page.keyboard.down('Control');
    let i = 0;
    for (; i < 300 && !done(await this.zoom(), i); i++) {
      await this.page.mouse.wheel(0, dy);
      await this.settle();
      appendFileSync(this.file, await this.shot());
      this.count++;
    }
    await this.page.keyboard.up('Control');
    return i;
  }
}

/**
 * Records a clip in each theme asked for: `capture` drives the app and writes its frames, and they are encoded to
 * `client/public/home/<name>.webm`, or `<name>-dark.webm` for the dark theme (or to `--out`).
 */
export async function recordClips(name: string, capture: (frames: (page: Page) => Frames, browser: Browser, theme: Theme) => Promise<number>): Promise<void> {
  for (const theme of themes()) {
    const out = path.resolve(arg('out', path.join(root, `client/public/home/${name}${theme === 'dark' ? '-dark' : ''}.webm`)));
    const work = mkdtempSync(path.join(os.tmpdir(), 'golem-clip-'));
    try {
      const file = path.join(work, 'frames.mjpg');
      writeFileSync(file, '');
      const browser = await chromium.launch({ channel: 'chromium', args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
      let count: number;
      try {
        count = await capture((page) => new Frames(page, file), browser, theme);
      } finally {
        await browser.close();
      }
      const encode = spawnSync(
        findFfmpeg(),
        ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS), '-i', file, '-an', '-vf', 'scale=1920:1080:flags=lanczos', '-c:v', 'libvpx', '-crf', '6', '-b:v', '5M', '-pix_fmt', 'yuv420p', out],
        { stdio: 'inherit' },
      );
      if (encode.status !== 0) throw new Error('ffmpeg failed to encode the clip');
      console.log(`${path.relative(root, out)}: ${count} frames, ${(count / FPS).toFixed(1)} s`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}
