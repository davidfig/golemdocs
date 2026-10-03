// Helpers for the files/formats/dashboard specs: building files to upload, reading ZIPs back,
// driving the File menu's file chooser, and dropping files on the window.

import type { Locator, Page } from '@playwright/test';
import { deflateRawSync, deflateSync, inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type App } from './fixtures';

// --- ZIP and PNG builders -----------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array | string;
  /** Stored as is (the default for `mimetype`-style entries); otherwise deflated. */
  store?: boolean;
}

/** A ZIP file from entries (local headers, then the central directory). */
export function buildZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.from(typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data);
    const name = Buffer.from(entry.name, 'utf8');
    const packed = entry.store ? data : deflateRawSync(data);
    const method = entry.store ? 0 : 8;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, packed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += local.length + name.length + packed.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

export interface ZipFile {
  name: string;
  bytes: Buffer;
}

/** Reads a ZIP through its central directory (stored and deflated entries). */
export function readZip(zip: Buffer): ZipFile[] {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a ZIP file: no end-of-central-directory record');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files: ZipFile[] = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = zip.readUInt16LE(at + 10);
    const packedSize = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const packed = zip.subarray(dataStart, dataStart + packedSize);
    files.push({ name, bytes: method === 0 ? Buffer.from(packed) : inflateRawSync(packed) });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/** A solid-colour PNG (8-bit RGB). */
export function buildPng(width: number, height: number, [r, g, b]: [number, number, number] = [200, 40, 40]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const body = Buffer.concat([head.subarray(4), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([head.subarray(0, 4), body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A small, hand-built Word document (a heading and two paragraphs). */
export function buildDocx(paragraphs: string[], title?: string): Buffer {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const body = paragraphs
    .map((p, i) => (i === 0 && title ? `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${esc(p)}</w:t></w:r></w:p>` : `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`))
    .join('');
  return buildZip([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    {
      name: 'word/document.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    },
  ]);
}

// --- Driving the app ---------------------------------------------------------------------------

export interface Upload {
  name: string;
  buffer: Buffer;
  mimeType?: string;
}

export const text = (name: string, content: string): Upload => ({ name, buffer: Buffer.from(content, 'utf8'), mimeType: 'application/octet-stream' });

/** A fixture from client/test/fixtures. */
export function fixture(name: string): Upload {
  return { name, buffer: readFileSync(resolve(process.cwd(), 'client/test/fixtures', name)), mimeType: 'application/octet-stream' };
}

const stemOf = (name: string): string => name.replace(/\.[^.]*$/, '');

/** Waits until the document called `name` (its stem) is open and laid out. */
export async function waitForOpen(app: App, name: string): Promise<void> {
  await app.page.waitForFunction((stem) => document.title.startsWith(stem), stemOf(name), { timeout: 30_000 });
  await app.ready();
  // The worker may rename the document (its own extension) once it has read it; a second look settles that.
  await app.settle();
}

/** File ▸ Import…, choosing `file` in the file chooser; resolves once the document is open. */
export async function importFile(app: App, file: Upload): Promise<void> {
  const [chooser] = await Promise.all([app.page.waitForEvent('filechooser'), app.menu('File', 'Import…')]);
  await chooser.setFiles({ name: file.name, mimeType: file.mimeType ?? 'application/octet-stream', buffer: file.buffer });
  await waitForOpen(app, file.name);
}

/** Drops `file` on the window, as if dragged from the desktop. */
export async function dropFile(page: Page, file: Upload, at = { x: 400, y: 400 }): Promise<void> {
  await page.evaluate(
    ({ name, base64, mimeType, at }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: mimeType }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true }));
    },
    { name: file.name, base64: file.buffer.toString('base64'), mimeType: file.mimeType ?? '', at },
  );
}

/** Drags `file` from the desktop over `target` (a folder, say) and drops it there. */
export async function dropFileOn(target: Locator, file: Upload): Promise<void> {
  await target.evaluate(
    (el, { name, base64, mimeType }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: mimeType }));
      const box = el.getBoundingClientRect();
      const at = { clientX: box.x + box.width / 2, clientY: box.y + Math.min(box.height / 2, 10), bubbles: true, cancelable: true, dataTransfer: dt };
      el.dispatchEvent(new DragEvent('dragenter', at));
      el.dispatchEvent(new DragEvent('dragover', at));
      el.dispatchEvent(new DragEvent('drop', at));
    },
    { name: file.name, base64: file.buffer.toString('base64'), mimeType: file.mimeType ?? '' },
  );
}

/** Drags several files from the desktop over `target` together and drops them there. */
export async function dropFilesOn(target: Locator, files: Upload[]): Promise<void> {
  await target.evaluate(
    (el, list) => {
      const dt = new DataTransfer();
      for (const { name, base64, mimeType } of list) dt.items.add(new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], name, { type: mimeType }));
      const box = el.getBoundingClientRect();
      const at = { clientX: box.x + box.width / 2, clientY: box.y + Math.min(box.height / 2, 10), bubbles: true, cancelable: true, dataTransfer: dt };
      el.dispatchEvent(new DragEvent('dragenter', at));
      el.dispatchEvent(new DragEvent('dragover', at));
      el.dispatchEvent(new DragEvent('drop', at));
    },
    files.map((file) => ({ name: file.name, base64: file.buffer.toString('base64'), mimeType: file.mimeType ?? '' })),
  );
}

/** The app's status line (the window hook main.ts exposes). */
export async function status(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { status: string }).status);
}

/** The value shown in the Document format selector. */
export async function formatLabel(page: Page): Promise<string> {
  return page.getByRole('combobox', { name: 'Document format' }).inputValue();
}

/** The toast (alert) text showing, if any. */
export async function toastText(page: Page): Promise<string> {
  return (await page.locator('.wm-toast:not([hidden])').textContent()) ?? '';
}

/** What a top-level menu lists: its visible items' names (shortcut text trimmed) and which are disabled; null when the menu itself isn't in the menu bar. */
export async function menuContents(app: App, title: string): Promise<{ items: string[]; disabled: string[] } | null> {
  const bar = app.menubar.getByRole('menuitem', { name: new RegExp(`^${title}$`) });
  if ((await bar.count()) === 0) return null;
  await bar.click();
  const menu = app.page.getByRole('menu').first();
  await menu.waitFor();
  const rows = await menu.getByRole('menuitem').evaluateAll((els) =>
    els
      .filter((el) => el.closest('[role=menu]') === el.closest('[role=menu]')?.ownerDocument.querySelector('[role=menu]'))
      .map((el) => ({ name: (el.textContent ?? '').replace(/\s+/g, ' ').trim(), disabled: el.getAttribute('aria-disabled') === 'true' })),
  );
  await app.page.keyboard.press('Escape');
  return { items: rows.map((r) => r.name), disabled: rows.filter((r) => r.disabled).map((r) => r.name) };
}

/** True when the menu lists an item whose name starts with `name` (and it isn't disabled unless `allowDisabled`). */
export function hasItem(menu: { items: string[]; disabled: string[] } | null, name: string, allowDisabled = false): boolean {
  if (!menu) return false;
  const found = menu.items.find((i) => i.startsWith(name));
  return found !== undefined && (allowDisabled || !menu.disabled.includes(found));
}

/** Waits for the layout to settle and the autosave to land (the status says so), then returns. */
export async function waitForSaved(page: Page, name = '.*'): Promise<void> {
  await expect.poll(() => status(page), { timeout: 15_000 }).toMatch(new RegExp(`Saved “${name}” in this browser`));
}

/** File ▸ Convert To ▸ `menuLabel` (e.g. 'OpenDocument Text (.odt)'); resolves once the document is open in that format. */
export async function convertTo(app: App, menuLabel: string, formatName: string): Promise<void> {
  await app.menu('File', 'Convert To', menuLabel);
  await expect.poll(() => formatLabel(app.page), { timeout: 30_000 }).toBe(formatName);
  await app.ready();
  await app.settle();
}

/** A new document with `lines` typed in (one paragraph each). */
export async function blankWith(app: App, ...lines: string[]): Promise<void> {
  await app.blank();
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await app.press('Enter');
    await app.type(lines[i]!);
  }
}
