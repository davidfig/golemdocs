// The built viewer (`pnpm --filter @golemdocs/client build:viewer`, dist-viewer/) as a host app would run it: in an
// `<iframe sandbox="allow-scripts">` (an opaque origin, no `allow-same-origin`), with a strict Content-Security-Policy on both the
// host page and the viewer, served by a plain static server with nothing on the network. It must start its module layout worker,
// draw with WebGL and load its fonts, in Chromium and in WebKit (the engine of the desktop shell's WKWebView). The findings are in
// docs/architecture/viewer.md.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { docxFile, encodedPicture, epubFile, hostPage, htmlFile, pictureDocx, pictureEpub, pictureHtml, redBmp, redGif, redPng, redWebp, svgFile, svgzFile, ViewerHost } from './helpers';

const CLIENT = path.resolve(import.meta.dirname, '../../client');
const BUILT = path.join(CLIENT, 'dist-viewer');

/**
 * The viewer's policy: its own files only. They are named by origin, not `'self'`: in a frame with an opaque origin WebKit matches
 * `'self'` to nothing (Chromium to the frame's address). `worker-src data:` is for the worker's starter (see `startLayoutWorker`).
 */
const viewerCsp = (origin: string): string =>
  // `'wasm-unsafe-eval'` lets WebAssembly compile (and nothing else): HEIC photos need it where the browser can't decode them itself
  // (Chromium), as libheif does it there.
  `default-src 'none'; script-src ${origin} 'wasm-unsafe-eval'; worker-src ${origin} data:; connect-src ${origin}; style-src ${origin}; img-src ${origin} blob: data:; font-src ${origin}; base-uri 'none'; form-action 'none'`;
/** The host page's: its inline test script, and frames from itself. */
const HOST_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'";

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp', '.txt': 'text/plain' };

/** Serves the built viewer under /viewer/ and the host page at /host.html, as a host app's own protocol handler would. */
async function serve(): Promise<{ origin: string; served: string[]; missing: string[]; close(): Promise<void> }> {
  const served: string[] = [];
  const missing: string[] = [];
  let origin = '';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    served.push(url.pathname);
    if (url.pathname === '/host.html') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': HOST_CSP });
      return res.end(hostPage('/viewer/viewer.html', { sandbox: true }));
    }
    const file = url.pathname.startsWith('/viewer/') ? path.join(BUILT, decodeURIComponent(url.pathname.slice('/viewer/'.length))) : '';
    if (!file.startsWith(BUILT) || !existsSync(file) || !statSync(file).isFile()) {
      missing.push(url.pathname);
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      // A sandboxed frame's requests come from an opaque origin ("null"): its module scripts, worker and fonts are CORS requests.
      'access-control-allow-origin': '*',
      'content-security-policy': viewerCsp(origin),
    });
    res.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, served, missing, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** Share of a screenshot's pixels that are white (page) and dark (text), read in a page of its own. */
async function pixels(scratch: Page, png: Buffer): Promise<{ white: number; dark: number; red: number }> {
  return scratch.evaluate(async (b64) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let white = 0;
    let dark = 0;
    let red = 0;
    for (let i = 0; i < data.length; i += 4) {
      const v = (data[i] + data[i + 1] + data[i + 2]) / 3;
      if (data[i] > 180 && data[i + 1] < 90 && data[i + 2] < 90) red++;
      else if (v > 250) white++;
      else if (v < 110) dark++;
    }
    const total = data.length / 4;
    return { white: white / total, dark: dark / total, red: red / total };
  }, png.toString('base64'));
}

// One build, shared by the tests: they run one after the other.
// Each test opens some twenty files in turn, HEIC through libheif in Chromium among them: more than the default minute.
test.describe.configure({ mode: 'serial', timeout: 180_000 });
let built = false;
test.beforeAll(() => {
  if (built) return;
  // The viewer as a host bundles it (no type check: `pnpm --filter @golemdocs/client build:viewer` adds tsc).
  execFileSync(path.join(CLIENT, 'node_modules/.bin/vite'), ['build', '--config', 'vite.viewer.config.ts', '--logLevel', 'warn'], { cwd: CLIENT, stdio: 'inherit' });
  built = true;
});

/** Opens files in the sandboxed viewer in a browser, and checks what a host needs: the worker ran, WebGL drew, fonts came from the host. */
async function sandboxed(context: BrowserContext) {
  const server = await serve();
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    const remote: string[] = [];
    await context.route('**/*', (route) => {
      if (route.request().url().startsWith(server.origin)) return route.continue();
      remote.push(route.request().url());
      return route.abort();
    });
    const viewer = new ViewerHost(page);
    await page.goto(`${server.origin}/host.html`);
    // The frame really is sandboxed: it can't reach the host page.
    const reach = await page.evaluate(() => {
      try {
        return String((document.getElementById('viewer') as HTMLIFrameElement).contentWindow!.document);
      } catch (e) {
        return (e as Error).name;
      }
    });
    expect(reach).toBe('SecurityError');

    // The worker laid the document out (only it can), so it started.
    const opened = await viewer.open('Report.docx', await docxFile(2));
    expect(opened, JSON.stringify(errors)).toMatchObject({ type: 'golemdocs:opened', format: 'docx', pages: 2 });
    // WebGL drew a page with text on it, in fonts the host served.
    await page.waitForTimeout(500);
    const box = (await page.locator('#viewer').boundingBox())!;
    const shot = await page.screenshot({ clip: { x: box.x + box.width / 2 - 300, y: box.y + 60, width: 600, height: 300 } });
    const scratch = await context.newPage();
    const seen = await pixels(scratch, shot);
    expect(seen.white, 'a white page').toBeGreaterThan(0.3);
    expect(seen.dark, 'dark letters on it').toBeGreaterThan(0.001);
    expect(server.served).toContain('/viewer/fonts/manifest.json');
    expect(server.served.some((p) => /^\/viewer\/fonts\/calibri\/regular\.(json|webp)$/.test(p))).toBe(true);
    expect(server.served.some((p) => /layoutWorkerEntry-.*\.js$/.test(p))).toBe(true);

    // The keys reach it, find works, and a clicked link goes to the host.
    const canvas = viewer.frame.locator('canvas');
    await canvas.click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('ControlOrMeta+=');
    await expect(viewer.frame.locator('.wm-viewer-zoom')).toHaveText('110%');
    await page.keyboard.press('ControlOrMeta+0');
    await page.keyboard.press('ControlOrMeta+f');
    const query = viewer.frame.getByRole('searchbox');
    await query.fill('Page 2');
    await query.press('Enter');
    await expect(viewer.frame.getByRole('textbox', { name: 'Page number' })).toHaveValue('2');
    await viewer.open('Links.md', new TextEncoder().encode('[Open the example site](https://example.com/clicked)\n'));
    const before = (await viewer.messages()).length;
    const at = (await canvas.boundingBox())!;
    await page.mouse.click(at.x + (at.width - 612 * (96 / 72)) / 2 + 90 * (96 / 72), at.y + 24 + 80 * (96 / 72));
    expect((await viewer.waitFor('golemdocs:link', before)).url).toBe('https://example.com/clicked');

    // Keys the viewer has no use for go to the host; its own (find, zoom, Escape while find is open) don't.
    const keysFrom = (await viewer.messages()).length;
    await canvas.click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('f');
    await page.keyboard.press('Escape');
    await page.keyboard.press('ArrowLeft'); // the page fits the view, so ← doesn't scroll it
    await page.keyboard.press('ControlOrMeta+f');
    await expect(viewer.frame.getByRole('searchbox')).toBeFocused();
    await page.keyboard.press('Escape'); // closes find
    await expect(viewer.frame.getByRole('searchbox')).toBeHidden();
    await page.keyboard.press('ControlOrMeta+=');
    await page.keyboard.press('ControlOrMeta+-');
    await page.keyboard.press('ControlOrMeta+0');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Shift+F'); // a last one, so the ones before have surely arrived
    await viewer.waitFor('golemdocs:key', keysFrom + 3);
    const keys = (await viewer.messages()).slice(keysFrom).filter((m) => m.type === 'golemdocs:key');
    expect(keys.map((k) => k.key)).toEqual(['f', 'Escape', 'ArrowLeft', 'F']);
    expect(keys[0]).toEqual({ type: 'golemdocs:key', key: 'f', code: 'KeyF', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false });
    expect(keys[3]).toMatchObject({ key: 'F', code: 'KeyF', shiftKey: true });

    // In a frame narrower than the page (a mail client's reading pane), the page opens zoomed to fit the width: nothing to scroll
    // sideways, so ← → are the host's. Zoomed in past the width, they scroll the page again.
    const wide = page.viewportSize()!;
    await page.setViewportSize({ width: 700, height: wide.height });
    await viewer.open('Report.docx', await docxFile(2));
    await expect.poll(async () => parseInt((await viewer.frame.locator('.wm-viewer-zoom').textContent()) ?? '100', 10)).toBeLessThan(100);
    const narrowFrom = (await viewer.messages()).length;
    await canvas.click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ControlOrMeta+=');
    await page.keyboard.press('ControlOrMeta+=');
    await page.keyboard.press('ArrowLeft'); // scrolls now
    await page.keyboard.press('Shift+F');
    await viewer.waitFor('golemdocs:key', narrowFrom + 2);
    const narrowKeys = (await viewer.messages()).slice(narrowFrom).filter((m) => m.type === 'golemdocs:key');
    expect(narrowKeys.map((k) => k.key)).toEqual(['ArrowLeft', 'ArrowRight', 'F']);
    await page.setViewportSize(wide);

    // Formats read in lazily loaded chunks, and remote pictures, fetch nothing from elsewhere.
    expect(await viewer.open('page.html', htmlFile())).toMatchObject({ type: 'golemdocs:opened' });
    expect(await viewer.open('book.epub', await epubFile())).toMatchObject({ type: 'golemdocs:opened' });
    // A PDF's own pages draw from the font set too (its font programs, for writing PDFs, are not bundled and not asked for).
    const pdf = new Uint8Array(readFileSync(path.resolve(CLIENT, '../pdf/test/fixtures/libreoffice.pdf')));
    expect(await viewer.open('paper.pdf', pdf)).toMatchObject({ type: 'golemdocs:opened', format: 'pdf' });

    // Drawings and pictures, alone and inside documents, open and are drawn (each shows red), with no `blob:` address to read in
    // the worker or the page, which an opaque origin may not load in WebKit.
    const pictures: [string, Uint8Array, string][] = [
      ['drawing.svg', svgFile(), 'svg'],
      ['drawing.svgz', svgzFile(), 'svgz'],
      ['photo.png', redPng(), 'png'],
      ['photo.jpg', await encodedPicture(scratch, 'image/jpeg'), 'jpeg'],
      ['photo.webp', redWebp(), 'webp'],
      ['animation.gif', redGif(), ''],
      ['scan.bmp', redBmp(), ''],
      ['picture.docx', await pictureDocx(), 'docx'],
      ['picture.html', pictureHtml(), 'html'],
      ['picture.epub', await pictureEpub(), 'epub'],
    ];
    for (const [name, bytes, format] of pictures) {
      const result = await viewer.open(name, bytes);
      expect(result, `${name}: ${JSON.stringify(result)} ${JSON.stringify(errors)}`).toMatchObject({ type: 'golemdocs:opened', ...(format && { format }) });
      await expect
        .poll(async () => (await pixels(scratch, await page.screenshot({ clip: { x: box.x, y: box.y + 40, width: box.width, height: box.height - 40 } }))).red, { message: `${name} is drawn`, timeout: 10_000 })
        .toBeGreaterThan(0.005);
    }
    // A HEIC photo (an iPhone's) is turned into a picture every viewer shows, in the worker, with no Blob to read there either.
    const heic = new Uint8Array(readFileSync(path.resolve(CLIENT, 'test/fixtures/photo.heic')));
    expect(await viewer.open('photo.heic', heic), JSON.stringify(errors)).toMatchObject({ type: 'golemdocs:opened', pages: 1 });
    await page.waitForTimeout(500);
    expect(remote).toEqual([]);
    expect(server.missing).toEqual([]);
    // Of the server, only the viewer's own files.
    expect(server.served.filter((p) => p !== '/host.html' && !p.startsWith('/viewer/'))).toEqual([]);
    return { served: server.served, errors };
  } finally {
    await server.close();
  }
}

test('Chromium: the sandboxed viewer starts its worker, draws with WebGL and loads its fonts under a strict CSP', async ({ context }) => {
  await sandboxed(context);
});

test('WebKit: the sandboxed viewer starts its worker, draws with WebGL and loads its fonts under a strict CSP', async () => {
  let browser: Browser;
  try {
    // The project's Chromium options (its channel and GPU flags) are not WebKit's.
    browser = await webkit.launch({ channel: undefined, args: [] });
  } catch {
    test.skip(true, 'WebKit is not installed (pnpm exec playwright install webkit)');
    return;
  }
  try {
    await sandboxed(await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: [] }));
  } finally {
    await browser.close();
  }
});
