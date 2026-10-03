// Shared harness for tests that drive the layout worker's message protocol in Node: the worker
// module is loaded through Vite (it uses import.meta.glob) with `self` and `fetch` stood in for.
// Font metrics and spelling dictionaries are fetched by URL: they are served from public/.
// One worker per test file (node --test runs each file in its own process).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { N, PageDrawing, PdfDict, PdfDocument, PdfString } from '../../pdf/src/index.ts';
import { createServer, type ViteDevServer } from 'vite';
import type { Format } from '../src/formats/convert.ts';
import type { DocumentSource, FromWorker, SelectionUpdate, ToWorker, WireCommand } from '../src/layout/protocol.ts';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const FIXTURES = path.resolve(ROOT, '../pdf/test/fixtures');

export const posted: FromWorker[] = [];
let listeners: (() => void)[] = [];
let server: ViteDevServer | undefined;
let post: (message: ToWorker) => void;
let nextDoc = 1;
let nextRequest = 1;

export const send = (message: ToWorker): void => post(message);

/** Resolves with the first message of `type` (already posted or still to come) that matches. */
export function waitFor<T extends FromWorker['type']>(type: T, match: (m: Extract<FromWorker, { type: T }>) => boolean = () => true, from = 0): Promise<Extract<FromWorker, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no '${type}' message; got ${posted.map((m) => m.type).join(', ')}`)), 20000);
    timer.unref();
    const check = () => {
      const found = posted.slice(from).find((m): m is Extract<FromWorker, { type: T }> => m.type === type && match(m as Extract<FromWorker, { type: T }>));
      if (!found) return false;
      clearTimeout(timer);
      resolve(found);
      return true;
    };
    if (!check()) {
      const listener = () => {
        if (check()) listeners = listeners.filter((l) => l !== listener);
      };
      listeners.push(listener);
    }
  });
}

export const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
export const decode = (buffer: ArrayBuffer | null): string => new TextDecoder().decode(buffer ?? new ArrayBuffer(0));
export const fixture = (name: string): ArrayBuffer => {
  const file = readFileSync(path.join(FIXTURES, name));
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
};

/** Starts the worker (call from `before`). */
export async function startWorker(): Promise<void> {
  const self = {
    postMessage(message: FromWorker) {
      posted.push(message);
      for (const l of [...listeners]) l();
    },
    onmessage: null as ((event: { data: ToWorker }) => void) | null,
  };
  Object.assign(globalThis, { self });
  globalThis.fetch = (async (url: string | URL | Request) => {
    try {
      return new Response(readFileSync(path.join(ROOT, 'public', String(url))), { status: 200 });
    } catch {
      return new Response(null, { status: 404 });
    }
  }) as typeof fetch;
  server = await createServer({ root: ROOT, appType: 'custom', server: { middlewareMode: true, hmr: false, watch: null }, logLevel: 'silent', optimizeDeps: { noDiscovery: true } });
  await server.ssrLoadModule('/src/layout/layoutWorker.ts');
  post = (message) => self.onmessage!({ data: message });
  post({ type: 'locale', locale: 'en' });
}

/** Stops it (call from `after`). */
export async function stopWorker(): Promise<void> {
  // Vite's close can wait forever on its esbuild service; don't let that hold the test process open.
  await Promise.race([server?.close(), new Promise((r) => setTimeout(r, 3000).unref())]);
  // Nor what it leaves running: once this file's results are out, its process ends (this timer only
  // fires if something else is keeping it alive). The runner's own --test-force-exit would do this
  // for every file, but it also stops the run before the others have all reported.
  setTimeout(() => process.exit(), 2000).unref();
}

/** Opens a document under a fresh id and waits for its first full layout (or its error). */
export async function openDoc(source: DocumentSource): Promise<number> {
  const doc = nextDoc++;
  send({ type: 'open', doc, source });
  await Promise.race([waitFor('done', (m) => m.doc === doc), waitFor('error', (m) => m.doc === doc).then((e) => Promise.reject(new Error(e.message)))]);
  return doc;
}

export const openMarkdown = (text: string, name = 'Test.md') => openDoc({ kind: 'md', name, bytes: bytes(text) });
export const openBlank = () => openDoc({ kind: 'blank', name: 'Blank.docx' });

export const command = (doc: number, c: WireCommand): void => send({ type: 'command', doc, command: c });

/** The selection state carried by a message: a `selection` message, or the one a `layout` update brings with it. */
const selectionOf = (m: FromWorker, doc: number): SelectionUpdate | null => ((m.type === 'selection' || m.type === 'layout') && m.doc === doc ? (m.type === 'layout' ? (m.selection ?? null) : m) : null);

/** Sends a command and resolves with the first selection update it produces (alone or with a layout). */
export async function run(doc: number, c: WireCommand, match: (s: SelectionUpdate) => boolean = () => true): Promise<SelectionUpdate> {
  const from = posted.length;
  command(doc, c);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no selection after '${c.kind}'; got ${posted.slice(from).map((m) => m.type).join(', ')}`)), 20000);
    timer.unref();
    const check = () => {
      for (const m of posted.slice(from)) {
        const s = selectionOf(m, doc);
        if (s && match(s)) {
          clearTimeout(timer);
          resolve(s);
          return true;
        }
      }
      return false;
    };
    if (!check()) {
      const listener = () => {
        if (check()) listeners = listeners.filter((l) => l !== listener);
      };
      listeners.push(listener);
    }
  });
}

/** The document's current selection state, asked for with a harmless command (which queues behind earlier ones). */
export const selection = (doc: number): Promise<SelectionUpdate> => run(doc, { kind: 'getProperties' }, (s) => s.docProperties !== undefined);

/** Exports the document in a format and returns the file. Errors surface as a rejection. */
export async function convert(doc: number, to: Format): Promise<ArrayBuffer> {
  const request = nextRequest++;
  send({ type: 'convert', doc, request, to });
  const saved = await waitFor('saved', (m) => m.request === request);
  assert.equal(saved.error, undefined, `convert to ${to}`);
  assert.ok(saved.bytes);
  return saved.bytes;
}

/** The document as plain text (what the exporter writes for .txt). */
export const text = async (doc: number): Promise<string> => decode(await convert(doc, 'txt'));

/** Asks for an image part's bytes. */
export async function media(doc: number, part: string): Promise<ArrayBuffer | null> {
  const request = nextRequest++;
  send({ type: 'media', doc, request, part });
  return (await waitFor('media', (m) => m.request === request)).bytes;
}

/** Runs `body` with console.error silenced (the worker logs errors it also reports). */
export async function quietly<T>(body: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await body();
  } finally {
    console.error = original;
  }
}

/** A 400x300 PDF with two Courier 12pt lines, "First line of text" and "Second line here", from (40, 50) and (40, 70) down the page. */
export async function samplePdf(): Promise<ArrayBuffer> {
  const doc = PdfDocument.create();
  const page = doc.addPage([400, 300]);
  const d = new PageDrawing(page, { origin: 'top-left' });
  d.text('First line of text', 40, 50, { font: doc.standardFont('Courier'), size: 12 });
  d.text('Second line here', 40, 70, { font: doc.standardFont('Courier'), size: 12 });
  d.finish();
  const saved = await doc.save();
  return saved.slice().buffer as ArrayBuffer;
}

/** A one-page PDF with a text field "name" holding "Ann" (box 100,700 to 300,720 in PDF user space, page 600x800). */
export async function formPdf(): Promise<ArrayBuffer> {
  const doc = PdfDocument.create();
  const page = doc.addPage([600, 800]);
  const field = doc.add(new PdfDict({ Type: N('Annot'), Subtype: N('Widget'), Rect: [100, 700, 300, 720], P: page.ref, T: PdfString.text('name'), FT: N('Tx'), V: PdfString.text('Ann'), DA: PdfString.text('/Helv 11 Tf 0 g') } as never));
  page.dict.set('Annots', [field]);
  doc.catalog.set('AcroForm', doc.add(new PdfDict({ Fields: [field] })));
  const saved = await doc.save();
  return saved.slice().buffer as ArrayBuffer;
}

/** The id of the first page the worker sent for a document, and how many pages the latest layout lists. */
export function pageIds(doc: number): number[] {
  const layouts = posted.filter((m): m is Extract<FromWorker, { type: 'layout' }> => m.type === 'layout' && m.doc === doc);
  return layouts.length ? [...layouts[layouts.length - 1].order] : [];
}

/** Runs an assistant tool on the document and answers with what it said. */
export async function agent(doc: number, name: string, args: object | string = {}): Promise<string> {
  return (await agentResult(doc, name, args)).result;
}

/** Runs an assistant tool, and answers with its whole result: what it said, and any pictures it fetched. */
export async function agentResult(doc: number, name: string, args: object | string = {}): Promise<{ result: string; images?: string[] }> {
  const request = nextRequest++;
  const json = typeof args === 'string' ? args : JSON.stringify(args);
  send({ type: 'agent', doc, request, name, args: json });
  // Not the shared timeout, which is unref'd: an unanswered tool call would end the run silently.
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer to ${name} ${json}`)), 15000)));
  try {
    return await Promise.race([waitFor('agentResult', (m) => m.request === request), late]);
  } finally {
    clearTimeout(timer!);
  }
}
