// MHTML (.mht, .mhtml): a web page saved as one MIME message. Reading takes the message's HTML
// part (decoding its transfer encoding and character set) and hands it to the HTML reader;
// the page's images and stylesheets, which the model has nowhere to keep, are dropped. Writing
// puts the document's HTML in a single-part message.
import { t } from '../i18n/index.ts';

const decoders = new Map<string, TextDecoder>();

function decoderFor(charset: string | undefined): TextDecoder {
  const label = (charset ?? 'utf-8').toLowerCase();
  let decoder = decoders.get(label);
  if (!decoder) {
    try {
      decoder = new TextDecoder(label);
    } catch {
      decoder = new TextDecoder('utf-8');
    }
    decoders.set(label, decoder);
  }
  return decoder;
}

interface Part {
  headers: Map<string, string>;
  body: string;
}

/** Splits a message or part into its headers (names lower-cased, folded lines joined) and body. */
function splitPart(text: string): Part {
  const match = /\r?\n\r?\n/.exec(text);
  const head = match ? text.slice(0, match.index) : text;
  const body = match ? text.slice(match.index + match[0].length) : '';
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { headers, body };
}

const param = (header: string | undefined, name: string): string | undefined =>
  new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(header ?? '')?.slice(1, 3).find((v) => v !== undefined);

/** Decodes a part's body to bytes according to its Content-Transfer-Encoding. */
function decodeBody(body: string, encoding: string | undefined): Uint8Array {
  switch (encoding?.toLowerCase()) {
    case 'base64': {
      const binary = atob(body.replace(/[^A-Za-z0-9+/=]/g, ''));
      return Uint8Array.from(binary, (c) => c.charCodeAt(0));
    }
    case 'quoted-printable': {
      const joined = body.replace(/=\r?\n/g, '');
      const out: number[] = [];
      for (let i = 0; i < joined.length; i++) {
        const hex = joined[i] === '=' ? joined.slice(i + 1, i + 3) : '';
        if (/^[0-9a-f]{2}$/i.test(hex)) {
          out.push(parseInt(hex, 16));
          i += 2;
        } else out.push(joined.charCodeAt(i) & 0xff);
      }
      return Uint8Array.from(out);
    }
    default:
      return Uint8Array.from(body, (c) => c.charCodeAt(0) & 0xff);
  }
}

/** The HTML of the first text/html part of an MHTML message. */
export function mhtmlToHtml(bytes: Uint8Array): string {
  // Read as Latin-1 so bytes survive until each part's own charset is known.
  let raw = '';
  for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const message = splitPart(raw);
  if (!message.headers.has('content-type') && !/^mime-version:/im.test(raw.slice(0, 2000))) throw new Error(t('app.notMhtml'));

  const find = (part: Part): Part | null => {
    const type = part.headers.get('content-type') ?? 'text/plain';
    if (/^multipart\//i.test(type)) {
      const boundary = param(type, 'boundary');
      if (!boundary) return null;
      const pieces = part.body.split(`--${boundary}`).slice(1);
      for (const piece of pieces) {
        if (piece.startsWith('--')) break;
        const found = find(splitPart(piece.replace(/^\r?\n/, '')));
        if (found) return found;
      }
      return null;
    }
    return /^text\/html/i.test(type) ? part : null;
  };
  const html = find(message);
  if (!html) throw new Error(t('app.mhtmlNoHtml'));
  const charset = param(html.headers.get('content-type'), 'charset');
  return decoderFor(charset).decode(decodeBody(html.body, html.headers.get('content-transfer-encoding')));
}

/** A single-part MHTML message holding the page. */
export function htmlToMhtml(html: string, title: string): Uint8Array {
  const data = new TextEncoder().encode(html);
  let binary = '';
  for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
  const lines = btoa(binary).match(/.{1,76}/g) ?? [];
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
    ...lines,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return new TextEncoder().encode(message);
}
