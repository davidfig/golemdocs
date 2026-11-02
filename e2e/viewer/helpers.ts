// Helpers for the embeddable viewer's specs (docs/architecture/viewer.md): a host page that frames viewer.html and talks to it as a
// host would (postMessage), the sample files they open, and a record of every request the pages make.

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
