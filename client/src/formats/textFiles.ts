// Text files as bytes: which encoding a file is in (UTF-8, UTF-16 with a byte order mark, or
// Windows-1252 when it isn't valid UTF-8), writing text back in that encoding, and telling text
// files from binary ones. Also the file extensions that are plain text: data, configuration, logs
// and source code, which open as text documents and keep their own extension when saved.

export type TextEncoding = 'utf-8' | 'windows-1252' | 'utf-16le' | 'utf-16be';

/** Text of a file's bytes, and what it was encoded as. A byte order mark says UTF-8 or UTF-16; else UTF-8 if it is valid, else Windows-1252. */
export function decodeText(bytes: Uint8Array): { text: string; encoding: TextEncoding; bom: boolean } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le', bom: true };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be', bom: true };
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes).replace(/^﻿/, ''), encoding: 'utf-8', bom };
  } catch {
    return { text: decodeWindows1252(bytes), encoding: 'windows-1252', bom: false };
  }
}

/** Windows-1252's 0x80-0x9F, which Latin-1 has as control characters (the five holes stay controls). Spelled out rather than asked of TextDecoder, which some runtimes answer as Latin-1. */
const HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
const WINDOWS_1252 = new Map<string, number>([...HIGH].map((c, i) => [c, 0x80 + i]));

function decodeWindows1252(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...Array.from(bytes.subarray(i, i + 8192), (b) => (b >= 0x80 && b <= 0x9f ? HIGH.charCodeAt(b - 0x80) : b)));
  }
  return out;
}

/** Text as bytes in an encoding, with a UTF-8 byte order mark when `bom`. Windows-1252 writes what it can and "?" for the rest. */
export function encodeText(text: string, encoding: TextEncoding = 'utf-8', bom = false): Uint8Array {
  if (encoding === 'windows-1252') {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = WINDOWS_1252.get(text[i]) ?? (text.charCodeAt(i) < 256 ? text.charCodeAt(i) : 63);
    return bytes;
  }
  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    const little = encoding === 'utf-16le';
    const out = new Uint8Array(2 + text.length * 2);
    const view = new DataView(out.buffer);
    view.setUint16(0, 0xfeff, little);
    for (let i = 0; i < text.length; i++) view.setUint16(2 + i * 2, text.charCodeAt(i), little);
    return out; // UTF-16 always carries its byte order mark: it is how the encoding is known when read again
  }
  const encoded = new TextEncoder().encode(text);
  if (!bom) return encoded;
  const out = new Uint8Array(encoded.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(encoded, 3);
  return out;
}

/** A text file this size or larger opens in the large-text viewer instead of as a document (see docs/large-text-files.md). */
export const LARGE_TEXT_BYTES = 8 * 1024 * 1024;

/** Whether a file of this kind and size opens in the large-text viewer rather than as a document (a table of 500,000 rows is no better than 500,000 paragraphs). */
export const opensAsLargeText = (kind: string, size: number): boolean => (kind === 'txt' || kind === 'csv' || kind === 'tsv') && size >= LARGE_TEXT_BYTES;

/** The bytes of a text file as UTF-8, whatever it was in (UTF-16 and Windows-1252 files are converted; UTF-8 is used as it is, less its byte order mark). */
export function toUtf8(bytes: Uint8Array): Uint8Array {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return encodeText(decodeText(bytes).text);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return encodeText(decodeText(bytes).text);
  }
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
}

/** Whether bytes are text a person could read and edit: no NUL bytes (outside UTF-16 text) and almost no control characters. */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (!bytes.length) return true;
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return true;
  const sample = bytes.subarray(0, 16384);
  let control = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 32 && b !== 9 && b !== 10 && b !== 13 && b !== 12 && b !== 27) control++;
  }
  return control / sample.length < 0.02;
}

/** Extensions of files that are text, apart from the document formats with their own readers. */
export const TEXT_EXTENSIONS: readonly string[] = [
  // Documents and notes
  'txt', 'text', 'log', 'nfo', 'srt', 'vtt', 'ics', 'vcf', 'bib',
  // Data and configuration
  'json', 'jsonc', 'json5', 'geojson', 'jsonl', 'ndjson', 'xml', 'xsd', 'xsl', 'xslt', 'rss', 'atom', 'plist', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties',
  'gitignore', 'gitattributes', 'editorconfig', 'dockerfile', 'diff', 'patch',
  // Source code
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'py', 'pyw', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'groovy', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'fs', 'vb',
  'php', 'phtml', 'pl', 'pm', 'r', 'jl', 'lua', 'swift', 'm', 'mm', 'dart', 'hs', 'ml', 'clj', 'cljs', 'ex', 'exs', 'erl', 'elm', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'sql', 'graphql', 'gql', 'proto', 'css', 'scss', 'sass', 'less', 'styl', 'vue', 'svelte', 'astro',
];

const TEXT_EXTENSION = new RegExp(`\\.(${TEXT_EXTENSIONS.join('|')})$`, 'i');

/** Whether a file name has one of the text extensions. */
export const isTextName = (name: string): boolean => TEXT_EXTENSION.test(name);

/** A name that ends in an extension of some kind ("notes.foo"), which a text file keeps when saved. */
export const hasExtension = (name: string): boolean => /\.[A-Za-z0-9_+-]{1,12}$/.test(name);
