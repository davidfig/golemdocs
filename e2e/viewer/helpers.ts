// Helpers for the embeddable viewer's specs (docs/architecture/viewer.md): a host page that frames viewer.html and talks to it as a
// host would (postMessage), the sample files they open, and a record of every request the pages make.

import { crc32, deflateSync, gzipSync } from 'node:zlib';
import type { FrameLocator, Page } from '@playwright/test';
import { WordDocument, writeZip, type Paragraph } from '../../docx/src/index.ts';

/** What the viewer has said to its host, in order. */
export type ViewerMessage = { type: string; [key: string]: unknown };

/**
 * The host page: an iframe of `viewerUrl` (sandboxed to `allow-scripts` when `sandbox`), every message it sends kept in
 * `window.messages`, and `window.openFile(name, bytes)` to send it a file.
 */
export function hostPage(viewerUrl: string, options: { sandbox?: boolean; dark?: boolean } = {}): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Host</title>
<style>html, body { margin: 0; height: 100%; } iframe { border: 0; width: 100%; height: 100%; display: block; }</style>
</head><body>
<iframe id="viewer" ${options.sandbox ? 'sandbox="allow-scripts"' : ''} src="${viewerUrl}"></iframe>
<script>
  const frame = document.getElementById('viewer');
  window.messages = [];
  window.addEventListener('message', (event) => {
    // A sandboxed frame has no origin to check: the host checks that the message comes from its frame.
    if (event.source !== frame.contentWindow) return;
    window.messages.push(event.data);
  });
  window.openFile = (name, numbers) => {
    const bytes = new Uint8Array(numbers).buffer;
    frame.contentWindow.postMessage({ type: 'golemdocs:open', name, bytes, dark: ${options.dark ? 'true' : 'false'} }, '*', [bytes]);
  };
</script>
</body></html>`;
}

export class ViewerHost {
  /** Every URL either page asked for. */
  readonly requests: string[] = [];

  constructor(readonly page: Page) {
    page.on('request', (request) => this.requests.push(request.url()));
  }

  get frame(): FrameLocator {
    return this.page.frameLocator('#viewer');
  }

  messages(): Promise<ViewerMessage[]> {
    return this.page.evaluate(() => (window as unknown as { messages: ViewerMessage[] }).messages);
  }

  /** Waits for the first message of a type (after the first `from` messages). */
  async waitFor(type: string, from = 0, timeout = 30_000): Promise<ViewerMessage> {
    const handle = await this.page.waitForFunction(
      ([t, f]) => (window as unknown as { messages: ViewerMessage[] }).messages.slice(f as number).find((m) => m.type === t),
      [type, from] as const,
      { timeout },
    );
    return (await handle.jsonValue()) as ViewerMessage;
  }

  /** Sends a file and waits until it is open (or fails), returning what the viewer said. */
  async open(name: string, bytes: Uint8Array): Promise<ViewerMessage> {
    const from = (await this.messages()).length;
    await this.waitFor('golemdocs:ready');
    await this.page.evaluate(([n, b]) => (window as unknown as { openFile(name: string, bytes: readonly number[]): void }).openFile(n, b), [name, [...bytes]] as const);
    const handle = await this.page.waitForFunction(
      (f) => (window as unknown as { messages: ViewerMessage[] }).messages.slice(f).find((m) => m.type === 'golemdocs:opened' || m.type === 'golemdocs:error'),
      from,
      { timeout: 30_000 },
    );
    return (await handle.jsonValue()) as ViewerMessage;
  }

  /** Requests to anywhere but `origin`. */
  elsewhere(origin: string): string[] {
    return this.requests.filter((url) => !url.startsWith(origin) && !url.startsWith('data:') && !url.startsWith('blob:'));
  }
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A web page with a link, and pictures and a stylesheet from elsewhere (that must not be fetched). */
export const REMOTE_HTML = `<!doctype html><html><head><link rel="stylesheet" href="https://remote.example/style.css"></head><body>
<h1>Quarterly report</h1>
<p>See <a href="https://example.com/details">the details</a> for more.</p>
<p><img src="https://remote.example/chart.png" alt="chart"><img src="//remote.example/protocol-relative.png"></p>
<p style="background-image: url(https://remote.example/bg.png)">Plain text after the pictures.</p>
<p><a href="javascript:alert(1)">not a link to follow</a></p>
</body></html>`;

export const htmlFile = (): Uint8Array => encode(REMOTE_HTML);

/** An email whose HTML part shows a remote picture (a tracking pixel, say). */
export const emlFile = (): Uint8Array =>
  encode(
    [
      'From: Ada <ada@example.com>',
      'To: Bob <bob@example.com>',
      'Subject: Lunch',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Lunch at noon?',
      '--b1',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Lunch at noon?</p><img src="https://tracker.example/pixel.gif" width="1" height="1"><a href="https://example.com/menu">menu</a>',
      '--b1--',
      '',
    ].join('\r\n'),
  );

/** A saved web page (MHTML) whose picture is not in the file, so it would have to come from the network. */
export const mhtmlFile = (): Uint8Array =>
  encode(
    [
      'From: <Saved by Blink>',
      'Subject: Saved page',
      'MIME-Version: 1.0',
      'Content-Type: multipart/related; type="text/html"; boundary="b2"',
      '',
      '--b2',
      'Content-Type: text/html',
      'Content-Location: https://remote.example/page.html',
      '',
      '<html><body><p>Saved page text</p><img src="https://remote.example/missing.png"><img src="missing-relative.png"></body></html>',
      '--b2--',
      '',
    ].join('\r\n'),
  );

/** An e-book whose chapter points at a remote picture and stylesheet. */
export async function epubFile(): Promise<Uint8Array> {
  const file = (name: string, text: string, compress = true) => ({ name, data: encode(text), compress });
  return writeZip([
    file('mimetype', 'application/epub+zip', false),
    file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    file(
      'OEBPS/content.opf',
      '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Book</dc:title><dc:identifier id="id">x</dc:identifier><dc:language>en</dc:language></metadata><manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>',
    ),
    file('OEBPS/chapter.xhtml', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><link rel="stylesheet" href="https://remote.example/book.css"/></head><body><h1>Chapter One</h1><p>It was a dark night.</p><img src="https://remote.example/cover.jpg" alt="cover"/></body></html>'),
  ]);
}

/** A Word document of `count` pages, each starting with "Page N". */
export async function docxFile(count = 3): Promise<Uint8Array> {
  const doc = await WordDocument.create();
  const paragraphs: Paragraph[] = [];
  for (let n = 1; n <= count; n++) {
    paragraphs.push({ kind: 'paragraph', properties: { ...(n > 1 && { pageBreakBefore: true }) }, children: [{ kind: 'run', properties: {}, content: [{ kind: 'text', text: `Page ${n} of the report` }], attrs: {} }], attrs: {} } as Paragraph);
  }
  doc.body = paragraphs;
  return doc.write();
}

export const markdownFile = (): Uint8Array => encode('# Notes\n\nThe quick brown fox jumps over the lazy dog.\n\nSecond paragraph with a [link](https://example.com/md).\n');

/** A solid red PNG, `size` pixels square, made here (no encoder needed: zlib and a CRC). */
export function redPng(size = 64): Uint8Array {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) raw.set([230, 20, 20, 255], y * (size * 4 + 1) + 1 + x * 4);
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

const dataUrl = (bytes: Uint8Array, type: string): string => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;

/** A drawing: a red square, a blue circle, and a picture inside it (a data: PNG). */
export const svgFile = (): Uint8Array =>
  encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">` +
      `<rect width="400" height="300" fill="#e61414"/><circle cx="300" cy="150" r="60" fill="#1450e6"/>` +
      `<image x="20" y="20" width="80" height="80" href="${dataUrl(redPng(16), 'image/png')}"/></svg>`,
  );

/** The same drawing, gzip-compressed (.svgz). */
export const svgzFile = (): Uint8Array => new Uint8Array(gzipSync(svgFile()));

/** A Word document showing a red picture. */
export async function pictureDocx(): Promise<Uint8Array> {
  const doc = await WordDocument.create();
  const image = doc.addImage(redPng(), 'png');
  doc.body = [{ kind: 'paragraph', properties: {}, attrs: {}, children: [{ kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'drawing', inline: true, width: 200 * 12700, height: 200 * 12700, image, name: 'Picture 1' }] }] } as Paragraph];
  return doc.write();
}

/** A web page whose picture is in the file (a data: address). */
export const pictureHtml = (): Uint8Array => encode(`<!doctype html><html><body><p>A picture:</p><img src="${dataUrl(redPng(), 'image/png')}" width="200" height="200"></body></html>`);

/** An e-book whose chapter shows a picture packed in the book. */
export async function pictureEpub(): Promise<Uint8Array> {
  const file = (name: string, data: Uint8Array, compress = true) => ({ name, data, compress });
  return writeZip([
    file('mimetype', encode('application/epub+zip'), false),
    file('META-INF/container.xml', encode('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')),
    file(
      'OEBPS/content.opf',
      encode('<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Pictures</dc:title><dc:identifier id="id">p</dc:identifier><dc:language>en</dc:language></metadata><manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="i1" href="red.png" media-type="image/png"/></manifest><spine><itemref idref="c1"/></spine></package>'),
    ),
    file('OEBPS/chapter.xhtml', encode('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>A picture:</p><img src="red.png" width="200" height="200" alt="red"/></body></html>')),
    file('OEBPS/red.png', redPng(), false),
  ]);
}

/** A red 16×16 WebP, lossless, made once in Chromium (WebKit's canvas can't write WebP, so it is not encoded in the test). */
export const redWebp = (): Uint8Array =>
  new Uint8Array(
    Buffer.from(
      'UklGRgACAABXRUJQVlA4WAoAAAAgAAAADwAADwAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDhMEQAAAC8PwAMAB1CKmpei/4GI6H8AAA==',
      'base64',
    ),
  );

/** A red 1×1 GIF. */
export const redGif = (): Uint8Array => new Uint8Array(Buffer.from('R0lGODlhAQABAPAAAP8AAP///yH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64'));

/** A red BMP, `size` pixels square, 24-bit, uncompressed. */
export function redBmp(size = 32): Uint8Array {
  const row = Math.ceil((size * 3) / 4) * 4;
  const out = Buffer.alloc(54 + row * size);
  out.write('BM', 0, 'latin1');
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(size, 18);
  out.writeInt32LE(size, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(row * size, 34);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) out.set([20, 20, 230], 54 + y * row + x * 3);
  return new Uint8Array(out);
}

/** A red picture as JPEG, encoded by a browser page (Node has no encoder for it). */
export async function encodedPicture(page: Page, type: 'image/jpeg'): Promise<Uint8Array> {
  const b64 = await page.evaluate(async (mime) => {
    const canvas = new OffscreenCanvas(64, 64);
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#e61414';
    context.fillRect(0, 0, 64, 64);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: mime, quality: 0.95 })).arrayBuffer());
    let text = '';
    for (const b of bytes) text += String.fromCharCode(b);
    return btoa(text);
  }, type);
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
