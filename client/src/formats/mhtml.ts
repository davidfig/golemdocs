// MHTML (.mht, .mhtml): a web page saved as one MIME message. Reading takes the message's HTML
// part (decoding its transfer encoding and character set) and hands it to the HTML reader, with
// the message's pictures for its <img> tags; stylesheets, which the model has nowhere to keep,
// are dropped. Writing puts the document's HTML and pictures in one message.
import { t } from '../i18n/index.ts';
import { decodeBody, flattenParts, partText, splitPart } from './mime.ts';
import type { Part } from './mime.ts';

export interface Mhtml {
  html: string;
  /** The bytes of a page resource (a picture), by the address the page uses: absolute or relative to the page, or cid:. */
  resource(src: string): Uint8Array | null;
}

/** The first text/html part of an MHTML message, and its other parts as resources. */
export function readMhtml(bytes: Uint8Array): Mhtml {
  // Read as Latin-1 so bytes survive until each part's own charset is known.
  let raw = '';
  for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const message = splitPart(raw);
  if (!message.headers.has('content-type') && !/^mime-version:/im.test(raw.slice(0, 2000))) throw new Error(t('app.notMhtml'));

  const parts = flattenParts(message);
  const page = parts.find((p) => /^text\/html/i.test(p.headers.get('content-type') ?? 'text/plain'));
  if (!page) throw new Error(t('app.mhtmlNoHtml'));
  const html = partText(page);

  const resources = new Map<string, Part>();
  for (const part of parts) {
    if (part === page || !/^image\//i.test(part.headers.get('content-type') ?? '')) continue;
    const location = part.headers.get('content-location');
    if (location) resources.set(location, part);
    const id = part.headers.get('content-id')?.replace(/^<|>$/g, '');
    if (id) resources.set(`cid:${id}`, part);
  }
  const base = page.headers.get('content-location');
  const load = (part: Part) => decodeBody(part.body, part.headers.get('content-transfer-encoding'));
  return {
    html,
    resource(src) {
      const direct = resources.get(src) ?? resources.get(src.split('#')[0]);
      if (direct) return load(direct);
      // Relative to the page, as a browser resolves it.
      try {
        const absolute = new URL(src, base ?? 'file:///').href;
        const found = resources.get(absolute) ?? resources.get(decodeURI(absolute));
        return found ? load(found) : null;
      } catch {
        return null;
      }
    },
  };
}

/** A picture to put in a message: where the page refers to it, its type and its bytes. */
export interface MhtmlResource {
  location: string;
  mime: string;
  bytes: Uint8Array;
}

/** An MHTML message holding the page and its pictures. */
export function htmlToMhtml(html: string, title: string, resources: MhtmlResource[] = []): Uint8Array {
  const base64 = (data: Uint8Array): string[] => {
    let binary = '';
    for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
    return btoa(binary).match(/.{1,76}/g) ?? [];
  };
  const boundary = '----=_NextPart_golemdocs';
  const subject = /^[\x20-\x7e]*$/.test(title) ? title : `=?utf-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(title)))}?=`;
  const message = [
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/related; type="text/html"; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    'Content-Location: file:///document.html',
    '',
    ...base64(new TextEncoder().encode(html)),
    ...resources.flatMap((r) => ['', `--${boundary}`, `Content-Type: ${r.mime}`, 'Content-Transfer-Encoding: base64', `Content-Location: ${r.location}`, '', ...base64(r.bytes)]),
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return new TextEncoder().encode(message);
}
