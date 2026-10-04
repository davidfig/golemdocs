// Helpers shared by the layout, table, math and picture specs.

import { deflateSync, inflateRawSync, inflateSync } from 'node:zlib';
import { expect, type Locator, type Page } from '@playwright/test';
import type { App } from '../fixtures';

// --- What the page hooks say --------------------------------------------------------------

export interface PageBox {
  width: number;
  height: number;
}

/** The laid-out pages, in points (612 × 792 is Letter). */
export async function pageBoxes(page: Page): Promise<PageBox[]> {
  return page.evaluate(() => (window as unknown as { pages: { width: number; height: number }[] }).pages.map((p) => ({ width: p.width, height: p.height })));
}

export async function pageCount(page: Page): Promise<number> {
  return (await pageBoxes(page)).length;
}

export async function caretOf(page: Page): Promise<{ page: number; x: number; y: number; height: number } | null> {
  return page.evaluate(() => (window as unknown as { selectionState: { caret: { page: number; x: number; y: number; height: number } | null } }).selectionState.caret);
}

// --- Menus (radio and check items have their own roles) --------------------------------------

/** Opens a top-level menu and returns the open menu panel. */
export async function openMenu(app: App, title: string): Promise<Locator> {
  await app.menubar.getByRole('menuitem', { name: new RegExp(`^${title}$`) }).click();
  return app.page.getByRole('menu').last();
}

/** Opens `Menu ▸ Submenu…` and returns the innermost open menu. */
export async function openSubmenu(app: App, title: string, ...path: string[]): Promise<Locator> {
  await openMenu(app, title);
  for (const name of path) await app.page.getByRole('menu').getByRole('menuitem', { name: new RegExp(`^${name}`) }).first().click();
  return app.page.getByRole('menu').last();
}

export function menuItem(app: App, name: string | RegExp): Locator {
  return app.page.getByRole('menu').getByRole('menuitem', { name }).first();
}

/** Clicks a menu path whose last item may be a menuitem, or a radio/check item. */
export async function choose(app: App, title: string, ...path: string[]): Promise<void> {
  await openMenu(app, title);
  for (const name of path) {
    await app.page
      .getByRole('menu')
      .last()
      .locator('[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox]')
      .filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) })
      .first()
      .click();
  }
}

export async function isMenuItemEnabled(app: App, title: string, ...path: string[]): Promise<boolean> {
  await openMenu(app, title);
  for (const name of path.slice(0, -1)) await app.page.getByRole('menu').getByRole('menuitem', { name: new RegExp(`^${name}`) }).first().click();
  const last = path[path.length - 1];
  const item = app.page.getByRole('menu').last().locator('[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox]').filter({ hasText: new RegExp(`^${last}`) }).first();
  const disabled = await item.getAttribute('aria-disabled');
  await app.page.keyboard.press('Escape');
  await app.page.keyboard.press('Escape');
  return disabled !== 'true';
}

// --- Dialogs ---------------------------------------------------------------------------------

export function dialog(app: App, name: string | RegExp): Locator {
  return app.page.getByRole('dialog', { name });
}

export async function setField(dlg: Locator, label: string, value: string | number): Promise<void> {
  await dlg.getByRole('spinbutton', { name: label, exact: true }).fill(String(value));
}

// --- Page setup and columns --------------------------------------------------------------------

export interface PageSetupValues {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  gutter?: number;
  header?: number;
  footer?: number;
  width?: number;
  height?: number;
  orientation?: 'portrait' | 'landscape';
  paper?: string;
  apply?: 'section' | 'document' | 'forward';
}

/** File ▸ Page Setup…, fills what is given, and presses OK (returns the dialog's locator if `ok` is false). */
export async function pageSetup(app: App, values: PageSetupValues, ok = true): Promise<Locator> {
  await app.menu('File', 'Page Setup…');
  const dlg = dialog(app, 'Page Setup');
  await dlg.waitFor();
  await dlg.getByRole('tab', { name: 'Margins' }).click();
  for (const key of ['top', 'bottom', 'left', 'right', 'gutter', 'header', 'footer'] as const) {
    if (values[key] !== undefined) await setField(dlg, label(key), values[key]!);
  }
  if (values.orientation) await dlg.getByRole('radio', { name: values.orientation === 'landscape' ? 'Landscape' : 'Portrait' }).check();
  if (values.paper || values.width !== undefined || values.height !== undefined) {
    await dlg.getByRole('tab', { name: 'Paper' }).click();
    if (values.paper) await dlg.getByRole('combobox', { name: /Paper size/ }).selectOption(values.paper);
    if (values.width !== undefined) await setField(dlg, 'Width', values.width);
    if (values.height !== undefined) await setField(dlg, 'Height', values.height);
  }
  if (values.apply) await dlg.getByRole('combobox', { name: /Apply to/ }).selectOption(values.apply);
  if (ok) {
    await dlg.getByRole('button', { name: 'OK' }).click();
    await dlg.waitFor({ state: 'detached' });
  }
  return dlg;
}

const label = (key: string): string => key[0].toUpperCase() + key.slice(1);

/** Reads every field of the open Page Setup dialog (inches). */
export async function readPageSetup(app: App): Promise<Record<string, number | string>> {
  await app.menu('File', 'Page Setup…');
  const dlg = dialog(app, 'Page Setup');
  await dlg.waitFor();
  const out: Record<string, number | string> = {};
  await dlg.getByRole('tab', { name: 'Margins' }).click();
  for (const key of ['top', 'bottom', 'left', 'right', 'gutter', 'header', 'footer'] as const) out[key] = Number(await dlg.getByRole('spinbutton', { name: label(key), exact: true }).inputValue());
  out.orientation = (await dlg.getByRole('radio', { name: 'Landscape' }).isChecked()) ? 'landscape' : 'portrait';
  await dlg.getByRole('tab', { name: 'Paper' }).click();
  out.width = Number(await dlg.getByRole('spinbutton', { name: 'Width', exact: true }).inputValue());
  out.height = Number(await dlg.getByRole('spinbutton', { name: 'Height', exact: true }).inputValue());
  out.paper = await dlg.getByRole('combobox', { name: /Paper size/ }).inputValue();
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await dlg.waitFor({ state: 'detached' });
  return out;
}

export interface ColumnsValues {
  preset?: 'One' | 'Two' | 'Three';
  count?: number;
  spacing?: number;
  line?: boolean;
  apply?: 'section' | 'document' | 'forward';
}

/** Format ▸ Columns…, fills what is given, and presses OK. */
export async function columns(app: App, values: ColumnsValues, ok = true): Promise<Locator> {
  await app.menu('Format', 'Columns…');
  const dlg = dialog(app, 'Columns');
  await dlg.waitFor();
  if (values.preset) await dlg.getByRole('button', { name: values.preset, exact: true }).click();
  if (values.count !== undefined) await dlg.getByRole('spinbutton', { name: 'Number of columns', exact: true }).fill(String(values.count));
  if (values.spacing !== undefined) await dlg.getByRole('spinbutton', { name: /Spacing between columns/ }).fill(String(values.spacing));
  if (values.line !== undefined) await dlg.getByRole('checkbox', { name: 'Line between' }).setChecked(values.line);
  if (values.apply) await dlg.getByRole('combobox', { name: /Apply to/ }).selectOption(values.apply);
  if (ok) {
    await dlg.getByRole('button', { name: 'OK' }).click();
    await dlg.waitFor({ state: 'detached' });
  }
  return dlg;
}

// --- Downloads: a minimal zip reader (no dependencies) ---------------------------------------------

/** The files of a zip (DOCX, ODT...) by name, as buffers. */
export function unzip(zip: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip');
  const count = zip.readUInt16LE(end + 10);
  let p = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLength = zip.readUInt16LE(p + 28);
    const extra = zip.readUInt16LE(p + 30);
    const comment = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLength);
    const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(data, data + size);
    files.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    p += 46 + nameLength + extra + comment;
  }
  return files;
}

/** Downloads the open (Word) document in its own format and returns word/document.xml (and the rest of the package). */
export async function docx(app: App): Promise<{ xml: string; files: Map<string, Buffer> }> {
  const file = await app.download(() => app.menu('File', 'Download'));
  const files = unzip(file.bytes);
  return { xml: files.get('word/document.xml')!.toString('utf8'), files };
}

/** Switches the open document to another format (Convert To, by the start of its menu label, e.g. 'Markdown') and downloads it as text. */
export async function convertedText(app: App, label: string): Promise<string> {
  await app.menu('File', 'Convert To', label);
  await expect(app.page.getByRole('combobox', { name: /Format/ }).or(app.page.locator('body'))).toBeVisible();
  return (await app.download(() => app.menu('File', 'Download'))).text;
}

/** The attributes of the first element of `tag` in an XML string, e.g. `attrs(xml, 'w:pgSz')`. */
export function attrs(xml: string, tag: string, nth = 0): Record<string, string> {
  const found = [...xml.matchAll(new RegExp(`<${tag}(\\s[^>]*?)?/?>`, 'g'))][nth];
  if (!found) return {};
  return Object.fromEntries([...(found[1] ?? '').matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
}

export const count = (xml: string, tag: string): number => [...xml.matchAll(new RegExp(`<${tag}[\\s>/]`, 'g'))].length;

// --- PNGs made in the test --------------------------------------------------------------------

function crc32(buf: Buffer): number {
  let c: number;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** An RGBA PNG of `width` × `height`; `pixel(x, y)` gives [r, g, b, a] (default: a left-to-right red-to-blue gradient). */
export function makePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number] = (x) => [Math.round((255 * (width - 1 - x)) / Math.max(1, width - 1)), 40, Math.round((255 * x) / Math.max(1, width - 1)), 255]): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw.set([r, g, b, a], y * (width * 4 + 1) + 1 + x * 4);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function pngSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** The decoded RGBA pixels of a PNG made by `makePng` or by the browser (8-bit RGBA/RGB, any filters). */
export function pngPixels(bytes: Buffer): { width: number; height: number; data: Uint8Array } {
  const { width, height } = pngSize(bytes);
  const colorType = bytes[25];
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 4 ? 2 : 0;
  if (!channels || bytes[24] !== 8) throw new Error('unsupported PNG');
  const parts: Buffer[] = [];
  for (let p = 8; p < bytes.length; ) {
    const len = bytes.readUInt32BE(p);
    if (bytes.toString('latin1', p + 4, p + 8) === 'IDAT') parts.push(bytes.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = new Uint8Array(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = (line[i] + add) & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (channels >= 3) out.set([line[x * channels], line[x * channels + 1], line[x * channels + 2], channels === 4 ? line[x * channels + 3] : 255], o);
      else out.set([line[x * channels], line[x * channels], line[x * channels], channels === 2 ? line[x * channels + 1] : 255], o);
    }
    prev = line;
  }
  return { width, height, data: out };
}

// --- Mouse: where a point on a page is on the screen -----------------------------------------------

/** The page's position in the document (points) and the camera, as the app keeps them. */
export async function screenPoint(page: Page, pageIndex: number, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ pageIndex, x, y }) => {
      const w = window as unknown as { pages: { x: number; y: number }[]; camera: { x: number; y: number; zoom: number } };
      const p = w.pages[pageIndex];
      const rect = document.getElementById('canvas')!.getBoundingClientRect();
      const k = w.camera.zoom * (96 / 72);
      return { x: rect.left + (p.x + x - w.camera.x) * k, y: rect.top + (p.y + y - w.camera.y) * k };
    },
    { pageIndex, x, y },
  );
}

// --- Tables in the saved Word file ------------------------------------------------------------------

export interface Cell {
  text: string;
  span: number;
  vMerge?: 'restart' | 'continue';
}

/** The tables of a document.xml as rows of cells (the text of a cell's paragraphs joined by newlines). */
export function tables(xml: string): Cell[][][] {
  const out: Cell[][][] = [];
  for (const tbl of xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? []) {
    out.push(
      (tbl.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) ?? []).map((tr) =>
        (tr.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []).map((tc) => {
          const span = Number(/<w:gridSpan w:val="(\d+)"/.exec(tc)?.[1] ?? 1);
          const vm = /<w:vMerge(?: w:val="(\w+)")?\/>/.exec(tc);
          return {
            text: (tc.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) ?? []).map((p) => [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')).join('\n'),
            span,
            vMerge: vm ? (vm[1] === 'restart' ? 'restart' : 'continue') : undefined,
          } as Cell;
        }),
      ),
    );
  }
  return out;
}

/** Just the text of the first table: rows of strings. */
export async function firstTable(app: App): Promise<string[][]> {
  const t = tables((await docx(app)).xml)[0];
  return t ? t.map((row) => row.map((c) => c.text)) : [];
}

/** Inserts a table through Insert ▸ Table… */
export async function insertTable(app: App, columns: number, rows: number): Promise<void> {
  await app.menu('Insert', 'Table…');
  const dlg = dialog(app, 'Insert Table');
  await dlg.getByRole('spinbutton', { name: 'Number of columns' }).fill(String(columns));
  await dlg.getByRole('spinbutton', { name: 'Number of rows' }).fill(String(rows));
  await dlg.getByRole('button', { name: 'OK' }).click();
  await dlg.waitFor({ state: 'detached' });
  // The table arrives from the layout worker; the caret is in its first cell once the Table menu comes alive.
  await expect.poll(() => isMenuItemEnabled(app, 'Table', 'Select Table')).toBe(true);
  await app.focus();
}

/** Types `cells` row by row, tabbing between them (a Tab after the last cell adds a row, so none is typed after it). */
export async function fillCells(app: App, cells: string[][]): Promise<void> {
  const flat = cells.flat();
  for (let i = 0; i < flat.length; i++) {
    if (flat[i]) await app.type(flat[i]);
    if (i < flat.length - 1) await app.press('Tab');
  }
}

// --- Opening files ---------------------------------------------------------------------------------

/** File ▸ Import… with a file made in the test. */
export async function importFile(app: App, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  const [chooser] = await Promise.all([app.page.waitForEvent('filechooser'), app.menu('File', 'Import…')]);
  await chooser.setFiles(file);
}

// --- Picture documents ---------------------------------------------------------------------------------

export type Rgba = [number, number, number, number];

export const WHITE: Rgba = [255, 255, 255, 255];

/** Opens a PNG made in the test as a picture document (File ▸ Import…) and waits for its page. */
export async function openPicture(app: App, png: Buffer, name = 'picture.png'): Promise<void> {
  await app.blank();
  await importFile(app, { name, mimeType: 'image/png', buffer: png });
  await app.menubar.getByRole('menuitem', { name: 'Picture' }).waitFor();
  await app.page.waitForFunction(() => (window as unknown as { pages: unknown[] }).pages.length === 1);
}

/** The open picture document downloaded and decoded. */
export async function currentPicture(app: App): Promise<{ width: number; height: number; data: Uint8Array; bytes: Buffer }> {
  const file = await app.download(() => app.menu('File', 'Download'));
  return { ...pngPixels(file.bytes), bytes: file.bytes };
}

export function pixelAt(img: { width: number; data: Uint8Array }, x: number, y: number): Rgba {
  const o = (Math.round(y) * img.width + Math.round(x)) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
}

export const isReddish = (p: Rgba): boolean => p[0] > 170 && p[1] < 130 && p[2] < 130;
export const isWhite = (p: Rgba): boolean => p[0] > 250 && p[1] > 250 && p[2] > 250;

/** Waits until the downloaded picture satisfies `check` (the picture tools replace the document asynchronously). */
export async function expectPicture(app: App, check: (img: { width: number; height: number; data: Uint8Array }) => boolean | Promise<boolean>): Promise<void> {
  await expect
    .poll(async () => {
      const img = await currentPicture(app);
      return check(img);
    }, { timeout: 20_000 })
    .toBe(true);
}

/** Screen position of a pixel of the open picture (a picture `pictureWidth` pixels wide, shown as the first page). */
export async function pictureToScreen(page: Page, pictureWidth: number, x: number, y: number): Promise<{ x: number; y: number }> {
  const widthPt = await page.evaluate(() => (window as unknown as { pages: { width: number }[] }).pages[0].width);
  const pt = widthPt / pictureWidth;
  return screenPoint(page, 0, x * pt, y * pt);
}

// --- A drawing tablet's pen ---------------------------------------------------------------

/** One point of a pen stroke, on screen, and how hard the pen is pressed there (0 to 1). */
export interface PenPoint {
  x: number;
  y: number;
  pressure: number;
}

/**
 * Draws a stroke with a pen, as a tablet sends it: real input through the browser's DevTools protocol,
 * with `pointerType` pen and its pressure, so the page sees what a Wacom pen would give it.
 */
export async function penStroke(page: Page, points: readonly PenPoint[]): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const send = (type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', p: PenPoint, pressed: boolean) =>
    cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, pointerType: 'pen', force: pressed ? p.pressure : 0, button: type === 'mouseMoved' ? (pressed ? 'left' : 'none') : 'left', buttons: pressed ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
  await send('mouseMoved', points[0], false);
  await send('mousePressed', points[0], true);
  for (const p of points.slice(1)) await send('mouseMoved', p, true);
  await send('mouseReleased', points[points.length - 1], false);
  await cdp.detach();
}

/**
 * Rubs the pen's eraser end along the points. The DevTools protocol has no eraser button, so these are
 * pen pointer events made in the page (button 5, `buttons` 32), sent where a real pen's would go.
 */
export async function penEraser(page: Page, points: readonly { x: number; y: number }[]): Promise<void> {
  await page.evaluate((pts) => {
    const fire = (type: string, p: { x: number; y: number }, pressed: boolean) => {
      const target = document.elementFromPoint(p.x, p.y) ?? document.body;
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'pen', isPrimary: true, clientX: p.x, clientY: p.y, button: type === 'pointermove' ? -1 : 5, buttons: pressed ? 32 : 0, pressure: pressed ? 0.6 : 0 }));
    };
    fire('pointerdown', pts[0], true);
    for (const p of pts.slice(1)) fire('pointermove', p, true);
    fire('pointerup', pts[pts.length - 1], false);
  }, points as { x: number; y: number }[]);
}
