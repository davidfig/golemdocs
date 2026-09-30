// Email messages (.eml) as documents. Reading shows the subject as a title, then who it is from and to,
// when it was sent, and the body: the HTML part when there is one (with its inline pictures), else the
// plain text (quotes as quotes, hard-wrapped paragraphs joined, links made links), then a list of the
// attachments. Writing makes a message of the document: the same headers, the body as text and HTML
// (pictures inline), and the original attachments, which are kept with the document for that.

import { WordDocument, paragraphText } from '@word/docx';
import type { Block, Inline, Paragraph, Style } from '@word/docx';
import { t } from '../i18n/index.ts';
import { documentToHtml, htmlToDocument } from './html.ts';
import { MIME, collectImages } from './images.ts';
import { decodeBody, decodeWords, flattenParts, headerList, headerParam, partText, splitPart } from './mime.ts';
import type { Part } from './mime.ts';
import { styleFor } from './markdownStyles.ts';
import { outlineToDocument, tidy } from './outline.ts';
import type { Node, Span } from './outline.ts';
import { documentToText } from './plainText.ts';
import type { EmlExtension } from './wdoc.ts';

export interface Email {
  headers: [string, string][];
  subject: string;
  html: string | null;
  text: string | null;
  attachments: { name: string; type: string; bytes: Uint8Array }[];
  /** An inline picture by the address its <img> has (`cid:…`). */
  resource(src: string): Uint8Array | null;
}

const value = (headers: [string, string][], name: string): string => headers.find(([n]) => n.toLowerCase() === name)?.[1] ?? '';

export function readEml(bytes: Uint8Array): Email {
  // Latin-1, so bytes survive until each part's own character set is known.
  let raw = '';
  for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
  raw = raw.replace(/^ï»¿/, '').replace(/^From [^\r\n]*\r?\n/, '');
  const headers = headerList(raw);
  if (!headers.some(([n]) => /^(from|to|subject|date|mime-version|received|message-id)$/i.test(n))) throw new Error(t('app.notEmail'));
  const message = splitPart(raw);
  const email: Email = { headers, subject: decodeWords(value(headers, 'subject')), html: null, text: null, attachments: [], resource: () => null };
  const resources = new Map<string, Part>();
  for (const part of flattenParts(message)) {
    const type = (part.headers.get('content-type') ?? 'text/plain').split(';')[0].trim().toLowerCase();
    const disposition = part.headers.get('content-disposition') ?? '';
    const name = headerParam(disposition, 'filename') ?? headerParam(part.headers.get('content-type'), 'name');
    const attached = /^\s*attachment/i.test(disposition) || (!!name && !/^image\//.test(type) && !part.headers.has('content-id'));
    const id = part.headers.get('content-id')?.replace(/^<|>$/g, '');
    if (!attached && type === 'text/html' && email.html === null) email.html = partText(part);
    else if (!attached && type === 'text/plain' && email.text === null) {
      const text = partText(part);
      email.text = /format\s*=\s*"?flowed/i.test(part.headers.get('content-type') ?? '') ? unflow(text) : text;
    } else if (id && !attached) resources.set(`cid:${id}`, part);
    else if (attached || (name && type !== 'text/html' && type !== 'text/plain')) {
      email.attachments.push({ name: name ?? `attachment.${type.split('/')[1] ?? 'bin'}`, type, bytes: decodeBody(part.body, part.headers.get('content-transfer-encoding')) });
    }
  }
  email.resource = (src) => {
    const part = resources.get(src);
    return part ? decodeBody(part.body, part.headers.get('content-transfer-encoding')) : null;
  };
  return email;
}

/** format=flowed: a line that ends in a space continues on the next, when that is at the same quote depth (a signature marker "-- " does not). */
function unflow(text: string): string {
  const out: string[] = [];
  const depth = (line: string) => /^>*/.exec(line)![0].length;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const last = out.at(-1);
    if (last !== undefined && / $/.test(last) && !/^(>* ?)-- $/.test(last) && line.trim() && depth(line) === depth(last)) out[out.length - 1] = last + line.replace(/^>+ ?/, '');
    else out.push(line);
  }
  return out.join('\n');
}

// --- The body of a plain-text message --------------------------------------------------------------

const URL = /https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'"]/g;

/** Text with its web addresses made links. */
function linkify(text: string): Span[] {
  const spans: Span[] = [];
  let last = 0;
  for (const m of text.matchAll(URL)) {
    if (m.index > last) spans.push({ text: text.slice(last, m.index) });
    spans.push({ text: m[0], link: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans;
}

/** Lines that were wrapped by the sender (each nearly as long as the wrap width) run together; others keep their breaks. */
function paragraphSpans(lines: string[]): Span[] {
  const wrapped = lines.length > 1 && lines.slice(0, -1).every((l) => l.length >= 55 && l.length <= 100);
  const spans: Span[] = [];
  lines.forEach((line, i) => {
    if (i > 0) spans.push(wrapped ? { text: ' ' } : { text: '', br: true });
    spans.push(...linkify(line.trimEnd()));
  });
  return tidy(spans);
}

function bodyNodes(text: string): Node[] {
  const nodes: Node[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].trim()) {
      i++;
      continue;
    }
    const quoted = lines[i].startsWith('>');
    const group: string[] = [];
    while (i < lines.length && lines[i].trim() && lines[i].startsWith('>') === quoted) group.push(lines[i++].replace(quoted ? /^(>\s?)+/ : /^/, ''));
    if (quoted) {
      // Blank lines inside a quote (">") separate its paragraphs.
      const paras: string[][] = [[]];
      for (const l of group) {
        if (l.trim()) paras.at(-1)!.push(l);
        else paras.push([]);
      }
      nodes.push({ t: 'quote', paras: paras.filter((p) => p.length).map(paragraphSpans) });
    } else nodes.push({ t: 'para', spans: paragraphSpans(group) });
  }
  return nodes;
}

// --- Reading into a document -----------------------------------------------------------------------

const KB = 1024;
const sizeText = (n: number): string => (n < KB ? `${n} B` : n < KB * KB ? `${Math.round(n / KB)} KB` : `${(n / KB / KB).toFixed(1)} MB`);

const run = (text: string, bold = false): Inline => ({ kind: 'run', properties: bold ? { bold: true } : {}, content: [{ kind: 'text', text }], attrs: {} });
const para = (children: Inline[], style?: string, extra: Paragraph['properties'] = {}): Paragraph => ({ kind: 'paragraph', properties: { ...(style && { style }), ...extra }, children, attrs: {} });

/** The paragraph styles the message's own blocks use (the header lines, the attachment list). */
const EMAIL_STYLES: Style[] = ['EmailHeader', 'EmailAttachment'].map((id) => ({
  type: 'paragraph',
  id,
  name: id === 'EmailHeader' ? 'Email Header' : 'Email Attachment',
  basedOn: 'Normal',
  paragraphProperties: { spacing: { before: 0, after: 0 } },
  runProperties: { color: { val: '595959' } },
  attrs: {},
}));

function headerBlocks(mail: Email): Block[] {
  const blocks: Block[] = [para([run(mail.subject || t('app.untitled'))], 'Heading1')];
  for (const name of ['From', 'To', 'Cc', 'Date']) {
    const text = decodeWords(value(mail.headers, name.toLowerCase())).replace(/\s+/g, ' ');
    if (text) blocks.push(para([run(`${name}: `, true), run(text)], 'EmailHeader'));
  }
  // The header block ends in a rule.
  blocks.push(para([], 'EmailHeader', { borders: { bottom: { val: 'single', sz: 6, space: 1, color: 'A6A6A6' } }, spacing: { before: 60, after: 240 } }));
  return blocks;
}

function attachmentBlocks(mail: Email): Block[] {
  if (!mail.attachments.length) return [];
  return [
    para([run(t('app.emailAttachments'), true)], 'EmailAttachment', { spacing: { before: 240, after: 60 } }),
    ...mail.attachments.map((a) => para([run(`• ${a.name} (${a.type}, ${sizeText(a.bytes.length)})`)], 'EmailAttachment')),
  ];
}

export async function emailToDocument(bytes: Uint8Array): Promise<{ document: WordDocument; extension: EmlExtension }> {
  const mail = readEml(bytes);
  const document = mail.html !== null ? (await htmlToDocument(mail.html, (src) => mail.resource(src))).document : await outlineToDocument(bodyNodes(mail.text ?? ''));
  document.body = [...headerBlocks(mail), ...document.body, ...attachmentBlocks(mail)];
  const have = new Set(document.styles.styles.map((s) => s.id));
  for (const style of [styleFor('Heading1'), ...EMAIL_STYLES]) if (style && !have.has(style.id)) document.styles.styles.push(style);
  const attachments = mail.attachments.map((a) => ({ name: a.name, type: a.type, data: toBase64(a.bytes) }));
  return { document, extension: { headers: mail.headers.filter(([n]) => KEPT.has(n.toLowerCase())), ...(attachments.length && { attachments }) } };
}

/** The headers written back: who, when and which message, not the trail of servers and signatures it passed through. */
const KEPT = new Set(['from', 'to', 'cc', 'bcc', 'reply-to', 'sender', 'date', 'message-id', 'in-reply-to', 'references', 'subject']);

// --- Writing a document as a message ---------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

const wrap = (base64: string): string => (base64.match(/.{1,76}/g) ?? []).join('\r\n');
const utf8Base64 = (text: string): string => wrap(toBase64(new TextEncoder().encode(text)));
/** A header value, as an encoded word when it isn't plain ASCII. */
const encodeWords = (text: string, plain = /^[\x20-\x7e]*$/): string => (plain.test(text) ? text : `=?utf-8?B?${toBase64(new TextEncoder().encode(text))}?=`);
/** A header parameter's value, quoted: a quote or backslash in it would end or garble the quotes, so such a value is encoded too. */
const quotedParam = (text: string): string => `"${encodeWords(text, /^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/)}"`;

export async function documentToEml(doc: WordDocument, ext: EmlExtension | undefined): Promise<Uint8Array> {
  // The message's own blocks (the header lines, the attachment list) are made from the headers on the way out, not written into the body.
  let start = 0;
  if (doc.body[0]?.kind === 'paragraph' && doc.body[0].properties.style === 'Heading1') start = 1;
  while (doc.body[start]?.kind === 'paragraph' && (doc.body[start] as Paragraph).properties.style === 'EmailHeader') start++;
  let end = doc.body.length;
  while (end > start && doc.body[end - 1].kind === 'paragraph' && (doc.body[end - 1] as Paragraph).properties.style === 'EmailAttachment') end--;
  const subject = start > 0 && doc.body[0].kind === 'paragraph' ? paragraphText(doc.body[0] as Paragraph).trim() : '';
  const whole = doc.body;
  let text: string;
  let html: string;
  const images = await collectImages(doc);
  const ids = new Map([...images.keys()].map((part, i) => [part, `image${i + 1}@golemdocs`]));
  try {
    doc.body = whole.slice(start, end);
    text = documentToText(doc);
    html = documentToHtml(doc, undefined, { images, imageSrc: (part) => `cid:${ids.get(part)}` });
  } finally {
    doc.body = whole;
  }

  const headers: [string, string][] = ext?.headers.filter(([n]) => n.toLowerCase() !== 'subject') ?? [];
  const finalSubject = subject || decodeWords(ext?.headers.find(([n]) => n.toLowerCase() === 'subject')?.[1] ?? '');
  if (!headers.some(([n]) => n.toLowerCase() === 'date')) headers.push(['Date', new Date().toUTCString().replace('GMT', '+0000')]);
  const boundary = (kind: string) => `----=_${kind}_golemdocs`;
  const lines: string[] = [...headers.map(([n, v]) => `${n}: ${v}`), `Subject: ${encodeWords(finalSubject)}`, 'MIME-Version: 1.0'];
  const part = (type: string, body: string, encoding = 'base64', extra: string[] = []): string[] => [`Content-Type: ${type}`, `Content-Transfer-Encoding: ${encoding}`, ...extra, '', body];
  const textPart = part('text/plain; charset="utf-8"', utf8Base64(text));
  const htmlPart = part('text/html; charset="utf-8"', utf8Base64(html));
  const related = images.size
    ? [`Content-Type: multipart/related; type="text/html"; boundary="${boundary('related')}"`, '', `--${boundary('related')}`, ...htmlPart, ...[...images].flatMap(([p, image]) => ['', `--${boundary('related')}`, ...part(MIME[image.type], wrap(toBase64(image.bytes)), 'base64', [`Content-ID: <${ids.get(p)}>`, 'Content-Disposition: inline'])]), '', `--${boundary('related')}--`]
    : htmlPart;
  const alternative = [`Content-Type: multipart/alternative; boundary="${boundary('alt')}"`, '', `--${boundary('alt')}`, ...textPart, '', `--${boundary('alt')}`, ...related, '', `--${boundary('alt')}--`];
  const attachments = ext?.attachments ?? [];
  if (!attachments.length) lines.push(...alternative);
  else {
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary('mixed')}"`, '', `--${boundary('mixed')}`, ...alternative);
    for (const a of attachments) lines.push('', `--${boundary('mixed')}`, ...part(`${a.type}; name=${quotedParam(a.name)}`, wrap(a.data), 'base64', [`Content-Disposition: attachment; filename=${quotedParam(a.name)}`]));
    lines.push('', `--${boundary('mixed')}--`);
  }
  return new TextEncoder().encode(`${lines.join('\r\n')}\r\n`);
}
