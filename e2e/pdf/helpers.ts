// Helpers for the PDF end-to-end tests: hand-written minimal PDFs, opening one through File ▸ Import,
// mapping page points to screen positions, and reading the PDFs the app downloads.

import type { Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { App } from '../fixtures';
import { expect } from '../fixtures';

/** Serializes objects 1..n (strings, or [dict, streamBody]) into a PDF with a correct xref table. */
export function assemble(objects: (string | [string, string])[], root = 1): Buffer {
  let out = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    const body = typeof o === 'string' ? o : `${o[0].replace(/>>\s*$/, '')} /Length ${o[1].length} >>\nstream\n${o[1]}\nendstream`;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${root} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export interface PdfText {
  text: string;
  x: number;
  /** Baseline from the bottom of the page (PDF user space). */
  y: number;
  size?: number;
}

export interface PdfOptions {
  /** One entry per page: the lines of text on it. */
  pages?: PdfText[][];
  width?: number;
  height?: number;
  /** Extra content stream operators appended to every page (e.g. a rectangle). */
  extraContent?: string;
  /** AcroForm fields, as widget objects (see `formFields`). */
  fields?: FormField[];
}

export type FormField =
  | { kind: 'text'; name: string; rect: [number, number, number, number]; value?: string }
  | { kind: 'checkbox'; name: string; rect: [number, number, number, number]; checked?: boolean }
  | { kind: 'radio'; name: string; rect: [number, number, number, number][]; states: string[]; value?: string }
  | { kind: 'choice'; name: string; rect: [number, number, number, number]; options: string[]; value?: string };

const esc = (s: string): string => s.replace(/([\\()])/g, '\\$1');

/** A PDF with Helvetica text (and, optionally, a form) on each page. */
export function makePdf(options: PdfOptions = {}): Buffer {
  const { width = 400, height = 300, extraContent = '' } = options;
  const pages = options.pages ?? [[{ text: 'Hello PDF world', x: 40, y: 240, size: 18 }]];
  const fields = options.fields ?? [];
  // Object numbering: 1 catalog, 2 pages, 3 font, 4 zapf, 5.. pages then contents then widgets.
  const n = pages.length;
  const firstPage = 5;
  const firstContent = firstPage + n;
  const firstWidget = firstContent + n;
  const objs: (string | [string, string])[] = [];
  // Widgets all go on page 1. Radios and others with kids get a parent object.
  const fieldObjs: string[] = [];
  const widgetRefs: number[] = [];
  const fieldRefs: number[] = [];
  let next = firstWidget;
  const add = (s: string): number => {
    fieldObjs.push(s);
    return next++;
  };
  const rectStr = (r: number[]) => `[${r.join(' ')}]`;
  const page1 = firstPage;
  for (const f of fields) {
    if (f.kind === 'text') {
      { const r = add(`<< /Type /Annot /Subtype /Widget /FT /Tx /T (${esc(f.name)}) /V (${esc(f.value ?? '')}) /Rect ${rectStr(f.rect)} /P ${page1} 0 R /F 4 /DA (/Helv 12 Tf 0 g) /MK << /BC [0 0 0] >> >>`); widgetRefs.push(r); fieldRefs.push(r); }
    } else if (f.kind === 'checkbox') {
      const on = f.checked ? '/Yes' : '/Off';
      const r = add(`<< /Type /Annot /Subtype /Widget /FT /Btn /T (${esc(f.name)}) /V ${on} /AS ${on} /Rect ${rectStr(f.rect)} /P ${page1} 0 R /F 4 /MK << /BC [0 0 0] >> /AP << /N << /Yes ${next + 1} 0 R /Off ${next + 2} 0 R >> >> >>`);
      widgetRefs.push(r);
      fieldRefs.push(r);
      // Appearance streams are added below right after this widget.
      fieldObjs.push('@AP-YES', '@AP-OFF');
      next += 2;
    } else if (f.kind === 'radio') {
      const parent = next++;
      fieldObjs.push('@PARENT');
      const kids: number[] = [];
      f.rect.forEach((r, i) => {
        const state = f.states[i];
        const isOn = f.value === state;
        kids.push(add(`<< /Type /Annot /Subtype /Widget /Parent ${parent} 0 R /AS /${isOn ? state : 'Off'} /Rect ${rectStr(r)} /P ${page1} 0 R /F 4 /MK << /BC [0 0 0] >> /AP << /N << /${state} ${next + 1} 0 R /Off ${next + 2} 0 R >> >> >>`));
        fieldObjs.push('@AP-YES', '@AP-OFF');
        next += 2;
      });
      fieldObjs[parent - firstWidget] = `<< /FT /Btn /Ff 32768 /T (${esc(f.name)}) /V /${f.value ?? 'Off'} /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] >>`;
      widgetRefs.push(...kids);
      fieldRefs.push(parent);
    } else {
      const opts = f.options.map((o) => `(${esc(o)})`).join(' ');
      { const r = add(`<< /Type /Annot /Subtype /Widget /FT /Ch /Ff 131072 /T (${esc(f.name)}) /V (${esc(f.value ?? '')}) /Opt [${opts}] /Rect ${rectStr(f.rect)} /P ${page1} 0 R /F 4 /DA (/Helv 12 Tf 0 g) /MK << /BC [0 0 0] >> >>`); widgetRefs.push(r); fieldRefs.push(r); }
    }
  }
  const catalog = fields.length ? `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [${fieldRefs.map((r) => `${r} 0 R`).join(' ')}] /DA (/Helv 12 Tf 0 g) /DR << /Font << /Helv 3 0 R >> >> >> >>` : '<< /Type /Catalog /Pages 2 0 R >>';
  objs.push(catalog);
  objs.push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${firstPage + i} 0 R`).join(' ')}] /Count ${n} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats >>');
  pages.forEach((_, i) => {
    const annots = i === 0 && widgetRefs.length ? ` /Annots [${widgetRefs.map((r) => `${r} 0 R`).join(' ')}]` : '';
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R /Helv 3 0 R >> >> /Contents ${firstContent + i} 0 R${annots} >>`);
  });
  pages.forEach((lines) => {
    const ops = lines.map((l) => `BT /F1 ${l.size ?? 12} Tf ${l.x} ${l.y} Td (${esc(l.text)}) Tj ET`).join('\n');
    objs.push(['<< >>', `${ops}\n${extraContent}`]);
  });
  for (const f of fieldObjs) {
    if (f === '@AP-YES') objs.push(['<< /Type /XObject /Subtype /Form /BBox [0 0 12 12] >>', '0 0 12 12 re S 2 2 m 10 10 l S']);
    else if (f === '@AP-OFF') objs.push(['<< /Type /XObject /Subtype /Form /BBox [0 0 12 12] >>', '0 0 12 12 re S']);
    else if (f === '@PARENT') objs.push('<< >>');
    else objs.push(f);
  }
  return assemble(objs);
}

/** Loads a page of the running app's state. */
export interface PageBox {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Opens PDF bytes through File ▸ Import and waits for the pages to be laid out. */
export async function openPdf(app: App, bytes: Buffer | Uint8Array, name = 'sample.pdf'): Promise<void> {
  const page = app.page;
  await app.goto('?doc=welcome');
  const chooser = page.waitForEvent('filechooser');
  await app.menu('File', 'Import…');
  await (await chooser).setFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await page.waitForFunction(() => (window as unknown as { loaded: boolean }).loaded === true && (window as unknown as { pages: unknown[] }).pages.length > 0, null, { timeout: 30_000 });
  await expect(page.locator('.wm-forms-palette')).toBeVisible();
  await movePaletteAside(page);
  await settle(page);
}

/** The tools panel starts over the top left of the page, where the text is: put it at the right edge (as a drag by its grip would). */
export async function movePaletteAside(page: Page): Promise<void> {
  await page.locator('.wm-forms-palette').evaluate((el) => {
    const parent = (el as HTMLElement).offsetParent as HTMLElement | null;
    const left = Math.max(8, (parent?.clientWidth ?? window.innerWidth) - el.getBoundingClientRect().width - 8);
    (el as HTMLElement).style.inset = `8px auto auto ${left}px`;
  });
}

export async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

export async function pageCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { pages: unknown[] }).pages.length);
}

/** Every page's box (points, document space), in display order. */
export async function pageBoxes(page: Page): Promise<PageBox[]> {
  return page.evaluate(() => (window as unknown as { pages: PageBox[] }).pages.map((p) => ({ id: p.id, x: p.x, y: p.y, width: p.width, height: p.height })));
}

/**
 * Scrolls and zooms so page `index` fills the view, and returns where a page point (points from the
 * top left) is on screen, in viewport coordinates.
 */
export async function showPage(page: Page, index = 0): Promise<(x: number, y: number) => Promise<{ x: number; y: number }>> {
  await page.evaluate((i) => {
    const w = window as unknown as { camera: { fit(b: object, w: number, h: number, p: number): void }; pages: PageBox[]; requestRender(): void; canvas?: HTMLCanvasElement };
    const canvas = document.getElementById('canvas') as HTMLCanvasElement;
    w.camera.fit(w.pages[i], canvas.clientWidth, canvas.clientHeight, 40);
    w.requestRender();
  }, index);
  await settle(page);
  return (x, y) => pointOnPage(page, index, x, y);
}

/** Viewport coordinates of a point on page `index` (points from its top left) at the current camera. */
export async function pointOnPage(page: Page, index: number, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([i, px, py]) => {
      const w = window as unknown as { camera: { x: number; y: number; zoom: number }; pages: PageBox[] };
      const p = w.pages[i];
      const scale = w.camera.zoom * (96 / 72);
      const r = document.getElementById('canvas')!.getBoundingClientRect();
      return { x: r.left + (p.x + px - w.camera.x) * scale, y: r.top + (p.y + py - w.camera.y) * scale };
    },
    [index, x, y] as const,
  );
}

export async function zoomOf(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { camera: { zoom: number } }).camera.zoom);
}

/** Text a PDF draws, read from its content streams' (...) Tj strings, in file order. Only works on uncompressed output. */
export function shownText(pdf: string): string[] {
  return [...pdf.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)].map((m) => m[1]);
}

export function countOf(pdf: string, pattern: RegExp): number {
  return [...pdf.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))].length;
}

/** A valid PNG of a solid color (default 40x30 red), for add-picture tests. */
export function tinyPng(width = 40, height = 30, rgb: [number, number, number] = [255, 0, 0]): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2; // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** The PDF's bytes as text, followed by every Flate stream inflated (object streams and content), so dictionaries and operators can be searched. */
export function decodePdf(bytes: Buffer): string {
  const raw = bytes.toString('latin1');
  let out = raw;
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    try {
      out += `\n${inflateSync(bytes.subarray(start, end)).toString('latin1')}`;
    } catch {
      try {
        // A trailing newline before `endstream` is not part of the data.
        out += `\n${inflateSync(bytes.subarray(start, end - 1)).toString('latin1')}`;
      } catch {
        /* not Flate (an image, or plain content already in `raw`) */
      }
    }
    re.lastIndex = end + 'endstream'.length;
  }
  return out;
}

/**
 * Opens the PDF bytes in a fresh app session and reads every character of page `index` by dragging a
 * selection across it. The way to check what text a saved file really shows.
 */
export async function readBack(app: App, bytes: Buffer, index = 0): Promise<string> {
  await openPdf(app, bytes, 'readback.pdf');
  const at = await showPage(app.page, index);
  const box = (await pageBoxes(app.page))[index];
  const from = await at(15, 15);
  const to = await at(box.width - 1, box.height - 1);
  await app.page.mouse.move(from.x, from.y);
  await app.page.mouse.down();
  await app.page.mouse.move(to.x, to.y, { steps: 8 });
  await app.page.mouse.up();
  await settle(app.page);
  return app.selectedText();
}

/** The Fill In / Edit PDF buttons at the top right. */
export const modeButton = (page: Page, mode: 'Fill In' | 'Edit PDF') => page.getByRole('button', { name: mode, exact: true });

export async function editMode(page: Page): Promise<void> {
  await modeButton(page, 'Edit PDF').click();
  await expect(modeButton(page, 'Edit PDF')).toHaveAttribute('aria-pressed', 'true');
}

/** A tool button of the Edit PDF palette (`text`, `rect`, `ellipse`, `line`, `whiteout`, `redact`, `check`, `cross`, `date`). */
export const tool = (page: Page, name: string) => page.locator(`.wm-pdftools-section button[data-tool="${name}"]`);

/** Drags across page `index`, between two points given in points from the page's top left. */
export async function dragOnPage(page: Page, index: number, from: [number, number], to: [number, number]): Promise<void> {
  const a = await pointOnPage(page, index, ...from);
  const b = await pointOnPage(page, index, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
}

export async function clickOnPage(page: Page, index: number, x: number, y: number): Promise<void> {
  const p = await pointOnPage(page, index, x, y);
  await page.mouse.click(p.x, p.y);
}

/**
 * The current version of every object of a PDF that was saved by appending updates: later copies win,
 * and objects inside object streams are included. Returns each object's dictionary text by number.
 */
export function finalObjects(bytes: Buffer): Map<number, string> {
  const objects = new Map<number, string>();
  const raw = bytes.toString('latin1');
  const re = /(\d+) (\d+) obj\b([\s\S]*?)endobj/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const body = m[3];
    const streamAt = body.indexOf('stream');
    const dict = streamAt >= 0 && body.lastIndexOf('>>', streamAt) >= 0 ? body.slice(0, streamAt) : body;
    if (/\/Type\s*\/ObjStm/.test(dict) && streamAt >= 0) {
      const start = m.index + m[0].indexOf('stream', m[1].length) + 'stream'.length;
      const data = bytes.subarray(start + (raw[start] === '\r' ? 2 : 1), raw.indexOf('endstream', start));
      let inflated = '';
      try {
        inflated = inflateSync(data).toString('latin1');
      } catch {
        try {
          inflated = inflateSync(data.subarray(0, data.length - 1)).toString('latin1');
        } catch {
          continue;
        }
      }
      const n = Number(/\/N\s+(\d+)/.exec(dict)![1]);
      const first = Number(/\/First\s+(\d+)/.exec(dict)![1]);
      const header = inflated.slice(0, first).trim().split(/\s+/).map(Number);
      for (let i = 0; i < n; i++) {
        const num = header[i * 2];
        const off = header[i * 2 + 1];
        const end = i + 1 < n ? header[(i + 1) * 2 + 1] : inflated.length - first;
        objects.set(num, inflated.slice(first + off, first + end).trim());
      }
    } else objects.set(Number(m[1]), dict.trim());
  }
  return objects;
}

/** The fields reachable from the catalog's AcroForm /Fields (so a deleted field, left behind in the file, isn't counted), by name. */
export function fieldDicts(bytes: Buffer): Record<string, string> {
  const objects = finalObjects(bytes);
  const roots = [...bytes.toString('latin1').matchAll(/\/Root\s+(\d+) 0 R/g)];
  const root = objects.get(Number(roots[roots.length - 1][1])) ?? '';
  let acro = /\/AcroForm\s*(\d+) 0 R/.exec(root) ? objects.get(Number(/\/AcroForm\s*(\d+) 0 R/.exec(root)![1])) ?? '' : root;
  const refsIn = (text: string, key: string): number[] => {
    const m = new RegExp(`/${key}\\s*\\[([^\\]]*)\\]`).exec(text);
    return m ? [...m[1].matchAll(/(\d+) 0 R/g)].map((r) => Number(r[1])) : [];
  };
  const out: Record<string, string> = {};
  const visit = (num: number): void => {
    const dict = objects.get(num);
    if (!dict) return;
    const name = /\/T\s*\(((?:\\.|[^\\)])*)\)/.exec(dict);
    if (name) out[name[1]] = dict;
    for (const kid of refsIn(dict, 'Kids')) visit(kid);
  };
  for (const ref of refsIn(acro, 'Fields')) visit(ref);
  return out;
}

/** A dictionary's /Rect as numbers. */
export function rectIn(dict: string): number[] {
  return /\/Rect\s*\[([^\]]*)\]/.exec(dict)![1].trim().split(/\s+/).map(Number);
}

/** The annotation dictionaries of one subtype (`Highlight`, `Underline`, `StrikeOut`, `Text`, `Square`...) that pages of a saved PDF still list (an annotation deleted since is left behind in the file, unreferenced, and isn't counted). */
export function annotations(bytes: Buffer, subtype: string): string[] {
  const objects = finalObjects(bytes);
  const listed = new Set<number>();
  for (const dict of objects.values()) {
    if (!/\/Type\s*\/Page\b/.test(dict)) continue;
    let list = /\/Annots\s*\[([^\]]*)\]/.exec(dict)?.[1];
    const ref = /\/Annots\s*(\d+) 0 R/.exec(dict);
    if (list === undefined && ref) list = /\[([^\]]*)\]/.exec(objects.get(Number(ref[1])) ?? '')?.[1];
    for (const m of (list ?? '').matchAll(/(\d+) 0 R/g)) listed.add(Number(m[1]));
  }
  return [...listed].map((n) => objects.get(n) ?? '').filter((d) => new RegExp(`/Subtype\\s*/${subtype}\\b`).test(d));
}

/** Selects text on page `index` by dragging between two points (points from the page's top left). */
export async function selectBetween(page: Page, index: number, from: [number, number], to: [number, number]): Promise<string> {
  await dragOnPage(page, index, from, to);
  await settle(page);
  // The selection arrives from the layout worker, which can lag the mouse: read until it stops changing.
  const read = () => page.evaluate(() => (window as unknown as { selectionState: { text: string } }).selectionState.text);
  let text = await read();
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(60);
    const next = await read();
    if (next === text) break;
    text = next;
  }
  return text;
}

/** A one-page PDF that is only a picture (like a scan): a gray image drawn over the page, and no text. */
export function makeScanPdf(): Buffer {
  const pixels = Buffer.alloc(20 * 20, 0x99).toString('latin1');
  return assemble([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',
    ['<< >>', 'q 300 0 0 200 50 50 cm /Im1 Do Q'],
    ['<< /Type /XObject /Subtype /Image /Width 20 /Height 20 /ColorSpace /DeviceGray /BitsPerComponent 8 >>', pixels],
  ]);
}

/** A PDF encrypted with the standard handler (RC4, 40-bit, empty user password) whose only page shows `text`. */
export function makeEncryptedPdf(text = 'Secret words'): Buffer {
  const md5 = (b: Buffer): Buffer => createHash('md5').update(b).digest();
  const rc4 = (key: Buffer, data: Buffer): Buffer => {
    const s = Array.from({ length: 256 }, (_, i) => i);
    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + s[i] + key[i % key.length]) & 255;
      [s[i], s[j]] = [s[j], s[i]];
    }
    const out = Buffer.alloc(data.length);
    let a = 0;
    let b = 0;
    for (let k = 0; k < data.length; k++) {
      a = (a + 1) & 255;
      b = (b + s[a]) & 255;
      [s[a], s[b]] = [s[b], s[a]];
      out[k] = data[k] ^ s[(s[a] + s[b]) & 255];
    }
    return out;
  };
  const pad = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');
  const owner = md5(Buffer.from('owner'));
  const owner32 = Buffer.concat([owner, owner]);
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(-4);
  const id = Buffer.from('0123456789abcdef', 'latin1');
  const key = md5(Buffer.concat([pad, owner32, permissions, id])).subarray(0, 5);
  const user = rc4(key, pad);
  const objectKey = (n: number): Buffer => md5(Buffer.concat([key, Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, 0, 0])])).subarray(0, 10);
  const content = rc4(objectKey(4), Buffer.from(`BT /F1 18 Tf 40 240 Td (${text}) Tj ET`, 'latin1')).toString('latin1');
  const hex = (b: Buffer) => `<${b.toString('hex')}>`;
  const pdf = assemble([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents 4 0 R >>',
    ['<< >>', content],
    `<< /Filter /Standard /V 1 /R 2 /O ${hex(owner32)} /U ${hex(user)} /P -4 >>`,
  ]);
  // Add the /Encrypt and /ID entries to the trailer.
  return Buffer.from(pdf.toString('latin1').replace(/trailer\n<< \/Size (\d+) \/Root 1 0 R >>/, `trailer\n<< /Size $1 /Root 1 0 R /Encrypt 5 0 R /ID [${hex(id)} ${hex(id)}] >>`), 'latin1');
}
