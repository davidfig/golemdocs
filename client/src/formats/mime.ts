// MIME messages: the parts of an email (.eml) or a saved web page (.mhtml). A message or part is
// headers, a blank line and a body; the body is text or bytes in a transfer encoding and a
// character set; a multipart body holds more parts between boundary lines.

const decoders = new Map<string, TextDecoder>();

export function decoderFor(charset: string | undefined): TextDecoder {
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

export interface Part {
  headers: Map<string, string>;
  body: string;
}

/** Splits a message or part into its headers (names lower-cased, folded lines joined) and body. */
export function splitPart(text: string): Part {
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

export const param = (header: string | undefined, name: string): string | undefined =>
  new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(header ?? '')?.slice(1, 3).find((v) => v !== undefined);

/** Decodes a part's body to bytes according to its Content-Transfer-Encoding. */
export function decodeBody(body: string, encoding: string | undefined): Uint8Array {
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


/** Every part of a message, depth first: a message without a multipart body is its own only part. */
export function flattenParts(message: Part): Part[] {
  const parts: Part[] = [];
  const walk = (part: Part): void => {
    const type = part.headers.get('content-type') ?? 'text/plain';
    const boundary = /^multipart\//i.test(type) ? param(type, 'boundary') : undefined;
    if (!boundary) {
      parts.push(part);
      return;
    }
    for (const piece of part.body.split(`--${boundary}`).slice(1)) {
      if (piece.startsWith('--')) break;
      walk(splitPart(piece.replace(/^\r?\n/, '')));
    }
  };
  walk(message);
  return parts;
}

/** The text of a part: transfer encoding undone, then its character set. */
export function partText(part: Part): string {
  return decoderFor(param(part.headers.get('content-type'), 'charset')).decode(decodeBody(part.body, part.headers.get('content-transfer-encoding')));
}

/** Header text with RFC 2047 encoded words ("=?utf-8?B?…?=", "=?iso-8859-1?Q?…?=") decoded. */
export function decodeWords(value: string): string {
  return value
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (whole, charset: string, encoding: string, text: string) => {
      try {
        const body = encoding.toLowerCase() === 'b' ? text : text.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, '=$1');
        return decoderFor(charset).decode(decodeBody(body, encoding.toLowerCase() === 'b' ? 'base64' : 'quoted-printable'));
      } catch {
        return whole;
      }
    });
}

/** A parameter of a header, such as a file name, with RFC 2231 continuations and encoding (filename*=utf-8''…) read. */
export function headerParam(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const star = new RegExp(`${name}\\*=([^']*)'[^']*'([^;\\s]+)`, 'i').exec(header);
  if (star) {
    try {
      // Percent escapes are bytes, in the named character set.
      const octets = star[2].replace(/%([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      return decoderFor(star[1] || 'utf-8').decode(Uint8Array.from(octets, (c) => c.charCodeAt(0) & 0xff));
    } catch {
      return decodeURIComponent(star[2]);
    }
  }
  const plain = param(header, name);
  return plain === undefined ? undefined : decodeWords(plain);
}

/** A message's headers in order, as written (names keep their case, folded lines joined). */
export function headerList(text: string): [string, string][] {
  const match = /\r?\n\r?\n/.exec(text);
  const head = match ? text.slice(0, match.index) : text;
  const out: [string, string][] = [];
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0 && !/\s/.test(line.slice(0, colon))) out.push([line.slice(0, colon), line.slice(colon + 1).trim()]);
  }
  return out;
}
