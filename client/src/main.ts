import './style.css';
import warAndPeaceUrl from '../../scripts/war-and-peace.txt?url';
import type { MoveTarget } from '@word/editor';
import { currentUser, signOut as signOutOfCloud, type User } from './auth.ts';
import { createChromeHost } from './chromeHost.ts';
import { CloudError, listDocuments, type CloudDocument } from './cloud.ts';
import { openFromCloud, uploadToCloud } from './library.ts';
import { clearAllSaved, getSaved, getThumbnail, listSaved, saveSaved, saveThumbnail, type SavedInfo } from './storage/local.ts';
import { capturePageThumbnail } from './thumbnail.ts';
import { CommentsPanel } from './ui/commentsPanel.ts';
import { FormLayer } from './ui/formLayer.ts';
import { Dashboard } from './ui/dashboard.ts';
import { showSignInDialog } from './ui/signIn.ts';
import { showConfirm } from './ui/popup.ts';
import { SharedDeviceNotice } from './ui/sharedDeviceNotice.ts';
import { arrangePages, columnsToFill, type Bounds } from './document/arrange.ts';
import { LayoutClient } from './layout/layoutClient.ts';
import { FONT_BASE, type DocumentSource, type LayoutUpdate, type RoomOptions, type SelectionUpdate, type WireCommand } from './layout/protocol.ts';
import { ImageRenderer } from './shapes/imageRenderer.ts';
import { AtlasLibrary } from './text/gpuFace.ts';
import { Camera, CSS_PX_PER_POINT } from './view/camera.ts';
import { GpuPage } from './view/gpuPage.ts';
import { PageRenderer } from './view/pageRenderer.ts';
import { SelectionLayer } from './view/selectionLayer.ts';
import { isFormat, type Format } from './formats/convert.ts';
import { sourceFromFile, stem } from './formats/source.ts';
import { FORMATS, kindFromName, mountChrome, type DocumentKind, type FormatState, type FormMode } from './ui/index.ts';

const PAGE_GAP = 18;
const CARET_BLINK_MS = 530;
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const input = document.getElementById('input') as HTMLTextAreaElement;
const statsEl = document.getElementById('stats') as HTMLDivElement;
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: true });
if (!gl) throw new Error('WebGL2 not supported');

const camera = new Camera();
const renderer = new PageRenderer(gl);
const atlases = new AtlasLibrary(gl, FONT_BASE, requestRender);
const selection = new SelectionLayer(gl);
// The document, layout and editing live in a worker; it streams pages here as GPU-ready
// buffers and answers input with page updates and selection geometry. This thread draws.
const worker = new LayoutClient((faces) => {
  for (const face of faces) atlases.define(face);
});

// Development convenience: the round-trip test corpus (pnpm --filter @word/docx corpus),
// served by a dev-only Vite plugin (see vite.config.ts), so builds never include it.
const CORPUS_URL = '/__corpus/';
let corpusNames: string[] = [];
if (import.meta.env.DEV) {
  void fetch(CORPUS_URL)
    .then((r) => (r.ok ? (r.json() as Promise<string[]>) : []))
    .then((names) => (corpusNames = names))
    .catch(() => {});
}

// --- Current document ------------------------------------------------------------------

/** Pages in display order, and every page the worker has sent that's still alive. */
let pages: GpuPage[] = [];
const pagesById = new Map<number, GpuPage>();
let bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
let grid = false;
let documentName = '';
/** What the open document is: Word, PDF, Markdown or text. It decides which tools are on offer. */
let documentKind: DocumentKind = 'docx';
/** A PDF is shown as its own pages, which take markup annotations. */
let annotating = false;
/** A PDF's pages: filling in its form, or editing the form itself. */
let formMode: FormMode = 'fill';
let status = '';
/** Collaboration status, when the document is open in a room. */
let roomStatus = '';
/** Latest edit round trip (command sent to its selection update), ms. */
let editLatency = '';
/** Layout finished for the current document. */
let loaded = false;
/** The camera has been placed for the current document. */
let cameraPlaced = false;
/** The user has scrolled or zoomed since opening (streaming then stops moving the camera). */
let userMoved = false;

/**
 * The format a source is opened as (everything but PDF, Markdown and text is a Word document).
 * A .wdoc says for itself once the worker has read it; until then, its name's extension.
 */
function kindOfSource(source: DocumentSource): DocumentKind {
  if (source.kind === 'wdoc') {
    const kind = kindFromName(source.name);
    return isFormat(kind) ? kind : 'docx';
  }
  return source.kind === 'pdf' || source.kind === 'md' || source.kind === 'txt' || source.kind === 'odt' || source.kind === 'html' ? source.kind : 'docx';
}

function setStatus(text: string): void {
  status = text;
  requestRender();
}

function open(source: DocumentSource, options: { grid?: boolean; localId?: string } = {}): void {
  const start = performance.now();
  let name = 'name' in source ? source.name : source.kind === 'welcome' ? 'Welcome to Golem Docs' : 'Fonts';
  let firstPage = 0;
  saveIfEdited(); // the worker is asked for the bytes now, before it switches documents
  current = { localId: options.localId ?? null, unsavedSince: 0 };
  for (const page of pagesById.values()) page.dispose(gl!);
  pagesById.clear();
  pages = [];
  selection.clear();
  commentsPanel.update([]);
  formLayer.update(null);
  formMode = 'fill';
  formLayer.setMode(formMode);
  selectionFormat = {};
  canUndo = canRedo = false;
  renderer.images?.clear();
  renderer.images = new ImageRenderer(gl!, { bytes: (part) => worker.media(part) }, requestRender);
  grid = options.grid ?? false;
  loaded = false;
  cameraPlaced = false;
  userMoved = false;
  editLatency = '';
  roomStatus = '';
  pendingNotice = null;
  documentName = name;
  documentKind = kindOfSource(source);
  annotating = false;
  setStatus(`Loading ${name}…`);

  worker.open(source, {
    opened(docName, format, fixedPages) {
      name = documentName = docName;
      documentKind = format;
      annotating = fixedPages;
      setStatus(`${name}: laying out…`);
    },
    layout(update) {
      if (!firstPage && update.pages.length) firstPage = performance.now() - start;
      applyLayout(update);
      if (update.selection) applySelection(update.selection);
      if (!loaded) setStatus(`${name}: laying out… ${pages.length.toLocaleString()} pages`);
    },
    done(count, t) {
      loaded = true;
      arrange();
      const glyphs = pages.reduce((n, p) => n + p.glyphCount, 0);
      setStatus(
        `${name}: ${count.toLocaleString()} pages, ${glyphs.toLocaleString()} glyphs · first page ${firstPage.toFixed(0)} ms, ` +
          `all ${(performance.now() - start).toFixed(0)} ms (worker: read ${t.read.toFixed(0)}, fonts ${t.fonts.toFixed(0)}, ` +
          `body ${t.body.toFixed(0)}, headers ${t.headers.toFixed(0)} ms)`,
      );
      if (pendingNotice) {
        setStatus(pendingNotice);
        pendingNotice = null;
      }
      if (current.localId) backfillThumbnail(current.localId);
    },
    selection(update) {
      applySelection(update);
    },
    room(people, version, unconfirmed) {
      roomStatus = `room ${new URLSearchParams(location.search).get('room')} · ${people} ${people === 1 ? 'person' : 'people'} · v${version}${unconfirmed ? ` · ${unconfirmed} unsent` : ''}`;
      requestRender();
    },
    error(message) {
      loaded = true;
      setStatus(`${name}: ${message}`);
    },
  }, roomOptions());
  focusInput();
}

// --- Collaboration ---------------------------------------------------------------------
// ?room=<name> opens the document in a collaboration room. Until there's a networked server,
// rooms live in a SharedWorker (./collab/devServer.ts) shared by this browser's tabs.

const USER_COLORS = [0xe8590c, 0x2f9e44, 0x7048e8, 0xd6336c, 0x1098ad, 0xf08c00];
const userColor = USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
const userName = `Guest ${Math.floor(Math.random() * 900 + 100)}`;

function roomOptions(): RoomOptions | undefined {
  const name = new URLSearchParams(location.search).get('room');
  if (!name || typeof SharedWorker === 'undefined') return undefined;
  const server = new SharedWorker(new URL('./collab/devServer.ts', import.meta.url), { type: 'module', name: 'word-collab' });
  return { name, port: server.port, user: userName, color: userColor };
}

/** Puts the document, as it is now, in a new room, and opens a second window on it. */
async function collaborate(): Promise<void> {
  const params = new URLSearchParams(location.search);
  if (documentKind !== 'docx') {
    setStatus('Switch the format to Word Document to collaborate');
    return;
  }
  if (!params.get('room')) {
    let bytes: Uint8Array;
    try {
      bytes = await worker.convert('docx');
    } catch (e) {
      setStatus(`Can't collaborate: ${(e as Error).message}`);
      return;
    }
    // Others join with just the room: its first member's copy is the document.
    const name = documentName.replace(/\.(docx|docm|dotx|txt)$/i, '') + '.docx';
    history.replaceState(null, '', `?${new URLSearchParams({ room: Math.random().toString(36).slice(2, 8), name })}`);
    open({ kind: 'docx', name, bytes: bytes.slice().buffer });
  }
  window.open(location.href, '_blank', 'popup,width=900,height=900');
}
window.addEventListener('pagehide', () => {
  saveIfEdited();
  worker.leave();
});

function applyLayout(update: LayoutUpdate): void {
  for (const encoded of update.pages) pagesById.set(encoded.id, new GpuPage(encoded, atlases));
  for (const { page, content } of update.overlays) pagesById.get(page)?.setOverlay(gl!, content);
  for (const id of update.drop) {
    pagesById.get(id)?.dispose(gl!);
    pagesById.delete(id);
  }
  pages = [];
  for (const id of update.order) {
    const page = pagesById.get(id);
    if (page) pages.push(page);
  }
  arrange();
}

/** Positions pages; places the camera the first time, and keeps a grid fitted while it grows. */
function arrange(): void {
  const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  bounds = arrangePages(pages, grid ? columnsToFill(pages, aspect, PAGE_GAP) : 1, PAGE_GAP);
  if (pages.length && (!cameraPlaced || (grid && !userMoved))) placeCamera();
  requestRender();
}

function placeCamera(): void {
  cameraPlaced = true;
  if (grid) {
    camera.fit(bounds, canvas.clientWidth, canvas.clientHeight);
  } else {
    // Word's view: first page at 100%, centered, with a little gray above it.
    camera.zoom = 1;
    const pointsPerCss = 1 / (camera.zoom * CSS_PX_PER_POINT);
    camera.x = bounds.x + bounds.width / 2 - (canvas.clientWidth / 2) * pointsPerCss;
    camera.y = bounds.y - 24 * pointsPerCss;
  }
}

function openFile(file: File): void {
  history.replaceState(null, '', location.pathname);
  chromeHost.openFile(file);
}

/** Opens a document by name; `keepRoom` keeps the URL's collaboration room (else it's left). */
function openSource(source: string, keepRoom = false): void {
  const params = new URLSearchParams(location.search);
  params.set('doc', source);
  if (!keepRoom) params.delete('room');
  const thenSaveToCloud = params.get('cloud') === '1';
  params.delete('cloud');
  history.replaceState(null, '', `?${params}`);
  if (source === 'war-and-peace') {
    open({ kind: 'text-url', name: 'War and Peace', url: warAndPeaceUrl }, { grid: true });
  } else if (source.startsWith('corpus:')) {
    const name = source.slice(7);
    open({ kind: 'docx-url', name, url: CORPUS_URL + encodeURIComponent(name) });
  } else if (source.startsWith('local:')) {
    void openLocal(source.slice(6), thenSaveToCloud);
  } else if (source.startsWith('cloud:')) {
    void openCloud(source.slice(6));
  } else if (source === 'welcome') {
    open({ kind: 'welcome' });
  } else {
    open({ kind: 'fonts' });
  }
}

// --- Saving ----------------------------------------------------------------------------
// Documents save themselves in this browser (IndexedDB) a moment after each edit, so there's no
// Save command and the app needs no account. The cloud is an opt-in extra: only Save to Cloud and
// Cloud Documents ask the user to sign in, and they save in the browser first, so leaving the
// page to sign in never loses work.

const AUTOSAVE_DELAY_MS = 1000;
/** Typing without a pause still saves this often. */
const AUTOSAVE_MAX_WAIT_MS = 10_000;

interface OpenDocument {
  /** Its id among the documents saved in this browser (null until first saved). */
  localId: string | null;
  /** When its oldest unsaved edit was made (performance.now()), or 0 when everything is saved. */
  unsavedSince: number;
}

/** A new one per open(), so a save finishing for the previous document can't touch this one. */
let current: OpenDocument = { localId: null, unsavedSince: 0 };
let autosaveTimer = 0;
/** Saves write one at a time, in order, so a new document's first saves don't each create a copy. */
let saving: Promise<unknown> = Promise.resolve();

/** Schedules a save for once editing pauses. */
function documentEdited(): void {
  const now = performance.now();
  if (!current.unsavedSince) current.unsavedSince = now;
  clearTimeout(autosaveTimer);
  const wait = Math.min(AUTOSAVE_DELAY_MS, current.unsavedSince + AUTOSAVE_MAX_WAIT_MS - now);
  autosaveTimer = window.setTimeout(() => void saveInBrowser(), Math.max(0, wait));
}

/** Saves now if there are unsaved edits (another document is opening, or the page is going away). */
function saveIfEdited(): void {
  if (current.unsavedSince) void saveInBrowser();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveIfEdited();
});

/** The open document's id in this browser, saving it first if it has unsaved edits or was never saved. */
function saveNow(): Promise<string | null> {
  const doc = current;
  return doc.unsavedSince || !doc.localId ? saveInBrowser() : saving.then(() => doc.localId);
}

/** Shown when the current document finishes loading, which would otherwise replace it. */
let pendingNotice: string | null = null;

let savedDocs: SavedInfo[] = [];
let cloudUser: User | null = null;
let cloudDocs: CloudDocument[] = [];

/** Refreshes what File ▸ Open Recent and Cloud Documents list (cloud parts stay empty when signed out or offline). */
async function refreshLibrary(): Promise<void> {
  savedDocs = await listSaved().catch(() => []);
  cloudUser = await currentUser().catch(() => null);
  cloudDocs = cloudUser ? await listDocuments().catch(() => []) : [];
  sharedDeviceNotice.update(cloudUser !== null);
}

/** Tells the user something now, or once the document being loaded has finished. */
function notify(message: string): void {
  if (loaded) setStatus(message);
  else pendingNotice = message;
}

/** Makes reloading the page reopen this document (not inside a collaboration room, where the room decides). */
function rememberInUrl(doc: string): void {
  const params = new URLSearchParams(location.search);
  if (params.get('room')) return;
  params.set('doc', doc);
  history.replaceState(null, '', `?${params}`);
}

/** The document's file name, with the extension of its current format. */
const fileName = () => stem(documentName) + FORMATS[documentKind].extensions[0];
const returnTo = (params: Record<string, string>) => `${location.pathname}?${new URLSearchParams(params)}`;

/**
 * Renders the first page as this saved copy's thumbnail (for the dashboard, and for the cloud
 * copy). Never fails the save: without a thumbnail the dashboard just shows a blank page.
 */
async function makeThumbnail(info: SavedInfo): Promise<void> {
  const page = pages[0];
  if (!page || !gl) return;
  try {
    const blob = await capturePageThumbnail(gl, renderer, page);
    if (blob) await saveThumbnail(info.id, blob, info.updatedAt);
  } catch {
    // no thumbnail this time
  } finally {
    requestRender(); // the capture drew into a scratch framebuffer; the canvas is unchanged, but be sure
  }
}

/** Documents saved before thumbnails existed get one when first opened again (once their images have arrived). */
function backfillThumbnail(id: string): void {
  window.setTimeout(async () => {
    if (current.localId !== id) return; // another document was opened meanwhile
    const info = (await listSaved().catch(() => [])).find((d) => d.id === id);
    if (!info) return;
    const existing = await getThumbnail(id).catch(() => null);
    if (existing?.forUpdatedAt === info.updatedAt) return;
    await makeThumbnail(info);
  }, 1500);
}

/** Set once the user clears this browser's data: nothing more is saved before the page reloads. */
let cleared = false;

/** Saves the open document in this browser. Returns its id, or null if that failed. */
function saveInBrowser(): Promise<string | null> {
  clearTimeout(autosaveTimer);
  if (cleared) return Promise.resolve(null);
  const doc = current;
  doc.unsavedSince = 0;
  const name = fileName();
  // Asked for now, while the worker still has this document.
  const bytes = worker.save();
  bytes.catch(() => {}); // handled below, once earlier saves are written
  const done = saving.then(async () => {
    const created = !doc.localId;
    try {
      const info = await saveSaved({ id: doc.localId ?? undefined, name, bytes: await bytes });
      doc.localId = info.id;
      if (doc === current) {
        await makeThumbnail(info);
        rememberInUrl(`local:${info.id}`);
        setStatus(`Saved “${info.name}” in this browser`);
      }
      // A new document changes what's listed; later saves only its order.
      if (created) void refreshLibrary();
      else savedDocs = await listSaved().catch(() => savedDocs);
      return info.id;
    } catch (e) {
      if (!doc.unsavedSince) doc.unsavedSince = performance.now(); // still unsaved: the next edit tries again
      if (doc === current) setStatus(`Save failed: ${(e as Error).message}`);
      return null;
    }
  });
  saving = done;
  return done;
}

/** Uploads a document already saved in this browser; asks to sign in if there's no session. */
async function sendToCloud(id: string): Promise<void> {
  setStatus('Saving to the cloud…');
  try {
    const doc = await uploadToCloud(id);
    notify(`Saved “${doc.name}” to the cloud`);
    void refreshLibrary();
  } catch (e) {
    if (e instanceof CloudError && e.status === 401) {
      notify('Sign in to save to the cloud');
      showSignInDialog(returnTo({ doc: `local:${id}`, cloud: '1' }));
    } else {
      notify(`Cloud save failed: ${(e as Error).message}`);
    }
  }
}

async function saveToCloud(): Promise<void> {
  const id = await saveNow();
  if (id) await sendToCloud(id);
}

async function signIn(options: { dashboard?: boolean } = {}): Promise<void> {
  // Signing in leaves the page, so keep the document first.
  const id = await saveNow();
  const back: Record<string, string> = options.dashboard ? { dashboard: '1' } : {};
  showSignInDialog(id ? returnTo({ doc: `local:${id}`, ...back }) : returnTo(back));
}

async function signOut(): Promise<void> {
  await signOutOfCloud().catch(() => {});
  await refreshLibrary();
  setStatus('Signed out');
}

/**
 * File ▸ Clear Local Data: deletes every document, thumbnail and setting kept in this browser,
 * then starts afresh (with the welcome document). Cloud documents and the sign-in stay.
 */
async function clearLocalData(): Promise<void> {
  const count = savedDocs.length;
  const what = count === 1 ? 'the one document' : `all ${count} documents`;
  const body = document.createElement('p');
  body.textContent =
    `This deletes ${count ? what : 'everything'} saved in this browser, along with your toolbar layout. ` +
    'It can’t be undone. Documents saved to the cloud are kept.';
  if (!(await showConfirm('Clear Local Data', body, 'Delete Everything'))) {
    focusInput();
    return;
  }
  cleared = true;
  clearTimeout(autosaveTimer);
  try {
    await saving.catch(() => {}); // a save still writing would otherwise land after the wipe
    await clearAllSaved();
    try {
      localStorage.clear();
    } catch {
      // storage blocked: nothing was kept there either
    }
  } catch (e) {
    cleared = false;
    setStatus(`Couldn’t clear local data: ${(e as Error).message}`);
    return;
  }
  location.replace(location.pathname);
}

async function openLocal(id: string, thenSaveToCloud: boolean): Promise<void> {
  const saved = await getSaved(id).catch(() => null);
  if (!saved) {
    open({ kind: 'blank', name: 'Document1' });
    pendingNotice = 'That document is no longer saved in this browser';
    return;
  }
  open(sourceFromFile(saved.info.name, saved.bytes) ?? { kind: 'docx', name: saved.info.name, bytes: saved.bytes }, { localId: id });
  if (thenSaveToCloud) await sendToCloud(id);
}

async function openCloud(id: string): Promise<void> {
  try {
    if (!cloudDocs.some((d) => d.id === id)) await refreshLibrary();
    const cloud = cloudDocs.find((d) => d.id === id);
    const name = cloud?.name ?? 'Document.docx';
    setStatus('Opening from the cloud…');
    const { info, bytes, usedBrowserCopy } = await openFromCloud({ id, name, updatedAt: cloud?.updatedAt });
    open(sourceFromFile(info.name, bytes) ?? { kind: 'docx', name: info.name, bytes }, { localId: info.id });
    rememberInUrl(`local:${info.id}`);
    if (usedBrowserCopy) pendingNotice = 'Opened your browser copy: it has changes the cloud doesn’t. Use Save to Cloud to sync them.';
    void refreshLibrary();
  } catch (e) {
    if (e instanceof CloudError && e.status === 401) showSignInDialog(returnTo({ doc: `cloud:${id}` }));
    else setStatus(`Couldn’t open from the cloud: ${(e as Error).message}`);
  }
}

/** Downloads a copy of the document as a file of the format it is edited as (an export: only what that format holds). */
async function download(): Promise<void> {
  try {
    const bytes = await worker.convert(documentKind as Format);
    const name = fileName();
    const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: FORMATS[documentKind].mime }));
    const link = Object.assign(document.createElement('a'), { href: url, download: name });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`Downloaded “${name}”`);
  } catch (e) {
    setStatus(`Download failed: ${(e as Error).message}`);
  }
}

/** What exporting to each format leaves out, for the notice shown after switching to it. */
const LOSSES: Partial<Record<DocumentKind, string>> = {
  md: 'fonts, colors, sizes, alignment and anything else Markdown can’t express',
  txt: 'all formatting, tables and images',
  html: 'page setup, headers and footers, comments and embedded pictures',
};

/** Said once the document has opened in its new format. */
function switchedNotice(to: Format): string {
  const { label, extensions } = FORMATS[to];
  if (to === 'pdf') return 'Now shown as PDF, which can’t be edited. Switch back to edit it; nothing was lost.';
  const lost = LOSSES[to];
  if (!lost) return `Now editing as ${label}. Nothing was lost.`;
  return `Now editing as ${label}. The document keeps everything else; only downloading a ${extensions[0]} file leaves out ${lost}.`;
}

/**
 * Switches the format the document is edited as (File ▸ Convert To, and the selector in the
 * chrome). It is the same document, saved in the app's own format (.wdoc), which keeps
 * everything it holds whatever it is edited as: switching Word → Markdown → Word gives back the
 * fonts and colors, and a Markdown document keeps its look as Word. Only a download (an export)
 * leaves out what its format can't express. Editing a PDF as anything else reflows its text;
 * the original pages are kept, and shown again as PDF while the text is unedited.
 */
async function convertTo(to: DocumentKind): Promise<void> {
  const from = documentKind;
  if (to === from) return;
  if (!isFormat(to) || !isFormat(from)) throw new Error(`${FORMATS[isFormat(to) ? from : to].label} isn’t supported yet`);
  if (new URLSearchParams(location.search).get('room')) {
    setStatus('Leave the collaboration room to switch formats');
    return;
  }
  setStatus(`Switching to ${FORMATS[to].label}…`);
  // Saved now, as the format to edit it as, in place of the document's last save.
  clearTimeout(autosaveTimer);
  const doc = current;
  doc.unsavedSince = 0;
  const name = stem(documentName) + FORMATS[to].extensions[0];
  const bytes = worker.save(to);
  bytes.catch(() => {});
  const done = saving.then(async () => saveSaved({ id: doc.localId ?? undefined, name, bytes: await bytes }));
  saving = done.catch(() => null);
  let info: SavedInfo;
  try {
    info = await done;
  } catch (e) {
    doc.unsavedSince = performance.now();
    throw e;
  }
  doc.localId = info.id;
  const source = sourceFromFile(name, (await bytes).slice().buffer);
  if (!source) throw new Error(`can’t open ${FORMATS[to].label}`);
  history.replaceState(null, '', location.pathname);
  open(source, { grid, localId: info.id });
  rememberInUrl(`local:${info.id}`);
  chrome.update({ documentName, kind: documentKind });
  pendingNotice = switchedNotice(to);
  void refreshLibrary();
  // A document in the cloud gets the change there too.
  if (info.cloudId) {
    uploadToCloud(info.id).then(
      () => void refreshLibrary(),
      (e: unknown) => notify(`The change is only in this browser (${(e as Error).message}). Use Save to Cloud to sync it.`),
    );
  }
}

// --- Selection and caret ---------------------------------------------------------------

let caretOn = true;
/** Formatting at the selection (from the worker), for the toolbar. */
let selectionFormat: FormatState = {};
let canUndo = false;
let canRedo = false;
let blinkTimer = 0;
/** When the last edit command was sent, for the latency readout. */
let editSent = 0;

function applySelection(update: SelectionUpdate): void {
  selection.update(update);
  commentsPanel.update(update.comments);
  selectionFormat = update.format;
  formLayer.update(update.fields ?? null);
  canUndo = update.canUndo;
  canRedo = update.canRedo;
  if (editSent) {
    editLatency = `edit → screen ${(performance.now() - editSent).toFixed(1)} ms (worker ${update.workerMs.toFixed(1)} ms)`;
    editSent = 0;
  }
  // Copy and cut read the selected text from `selection` (see the clipboard handlers).
  input.value = '';
  caretOn = true;
  clearInterval(blinkTimer);
  if (update.caret) {
    blinkTimer = window.setInterval(() => {
      caretOn = !caretOn;
      requestRender();
    }, CARET_BLINK_MS);
  }
  if (update.reveal && update.focus) reveal(update.focus);
  requestRender();
}

/** Scrolls so a caret (page-relative) is in view, with a margin. */
function reveal(caret: NonNullable<SelectionUpdate['focus']>): void {
  const page = pagesById.get(caret.page);
  if (!page) return;
  const pointsPerCss = 1 / (camera.zoom * CSS_PX_PER_POINT);
  const viewWidth = canvas.clientWidth * pointsPerCss;
  const viewHeight = canvas.clientHeight * pointsPerCss;
  const margin = 24 * pointsPerCss;
  const x = page.x + caret.x;
  const top = page.y + caret.y;
  const bottom = top + caret.height;
  if (top < camera.y + margin) camera.y = top - margin;
  else if (bottom > camera.y + viewHeight - margin) camera.y = bottom + margin - viewHeight;
  if (x < camera.x + margin) camera.x = x - margin;
  else if (x > camera.x + viewWidth - margin) camera.x = x + margin - viewWidth;
}

/** Commands that change a PDF's annotations (on its own pages, nothing else changes). */
const ANNOTATION_EDITS = new Set<WireCommand['kind']>(['annotate', 'delete', 'undo', 'redo', 'setFields']);

function send(command: WireCommand): void {
  if (command.kind !== 'move' && command.kind !== 'pointer' && command.kind !== 'selectAll') {
    editSent = performance.now();
    if (FORMATS[documentKind].editable || (annotating && ANNOTATION_EDITS.has(command.kind))) documentEdited();
  }
  worker.command(command);
}

function focusInput(): void {
  input.focus({ preventScroll: true });
}

// --- Rendering -------------------------------------------------------------------------

let frameQueued = false;

function requestRender(): void {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(render);
}

function render(): void {
  frameQueued = false;
  const start = performance.now();
  const caretVisible = caretOn && document.activeElement === input && document.hasFocus();
  camera.clamp(bounds, canvas.clientWidth, canvas.clientHeight);
  const stats = renderer.render(camera, pages, selection, caretVisible);
  const frameMs = performance.now() - start;
  chrome.update({
    documentName,
    kind: documentKind,
    hasSelection: selection.text.length > 0,
    zoom: camera.zoom,
    grid,
    statsVisible: !statsEl.hidden,
    format: selectionFormat,
    canUndo,
    canRedo,
    formMode: annotating ? formMode : null,
  });
  formLayer.position();
  statsEl.textContent =
    `${status}${roomStatus ? ` · ${roomStatus}` : ''}${editLatency ? ` · ${editLatency}` : ''}\n${stats.visiblePages}/${stats.pages.toLocaleString()} pages visible · ` +
    `${stats.glyphs.toLocaleString()} glyphs drawn · ${stats.drawCalls} draw calls · zoom ${Math.round(camera.zoom * 100)}% · ` +
    `CPU ${frameMs.toFixed(2)} ms/frame`;
  // Keep the (invisible) input at the caret, so IME candidate windows appear next to it.
  const caret = selection.caret;
  const page = caret && pagesById.get(caret.page);
  if (caret && page) {
    const scale = camera.zoom * CSS_PX_PER_POINT;
    input.style.left = `${(page.x + caret.x - camera.x) * scale}px`;
    input.style.top = `${(page.y + caret.y - camera.y) * scale}px`;
    input.style.height = `${caret.height * scale}px`;
  }
}

// Size the canvas in exact device pixels so glyph edges aren't resampled by the compositor.
new ResizeObserver(([entry]) => {
  const box = entry.devicePixelContentBoxSize?.[0];
  const cssWidth = entry.contentRect.width || 1;
  camera.width = box ? box.inlineSize : Math.round(cssWidth * (window.devicePixelRatio || 1));
  camera.height = box ? box.blockSize : Math.round(entry.contentRect.height * (window.devicePixelRatio || 1));
  // Derive the ratio from the backing store we actually got, so document scale always matches it.
  camera.dpr = camera.width / cssWidth;
  canvas.width = camera.width;
  canvas.height = camera.height;
  if (grid && !userMoved && pages.length) placeCamera();
  requestRender();
}).observe(canvas);

window.addEventListener('focus', requestRender);
window.addEventListener('blur', requestRender);
input.addEventListener('blur', requestRender);

// --- Pointer ---------------------------------------------------------------------------

/** The page under (or nearest to) a CSS point, and the point in its coordinates. */
function pageAt(cssX: number, cssY: number): { page: GpuPage; x: number; y: number } | null {
  const point = camera.toDocument(cssX, cssY);
  let best: GpuPage | null = null;
  let bestDistance = Infinity;
  for (const page of pages) {
    const dx = point.x < page.x ? page.x - point.x : point.x > page.x + page.width ? point.x - page.x - page.width : 0;
    const dy = point.y < page.y ? page.y - point.y : point.y > page.y + page.height ? point.y - page.y - page.height : 0;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      best = page;
      bestDistance = distance;
      if (distance === 0) break;
    }
  }
  return best && { page: best, x: point.x - best.x, y: point.y - best.y };
}

/** Clicks in quick succession at one spot (pointer events don't count them). */
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_PX = 4;
let lastClick = { time: 0, x: 0, y: 0, count: 0 };

function clickCount(e: PointerEvent): number {
  const near = Math.abs(e.clientX - lastClick.x) <= MULTI_CLICK_PX && Math.abs(e.clientY - lastClick.y) <= MULTI_CLICK_PX;
  const count = near && e.timeStamp - lastClick.time < MULTI_CLICK_MS ? lastClick.count + 1 : 1;
  lastClick = { time: e.timeStamp, x: e.clientX, y: e.clientY, count };
  return count;
}

let pan: { x: number; y: number } | null = null;
let selecting = false;
/** Latest drag position, sent once per frame. */
let pendingDrag: { x: number; y: number } | null = null;

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  if (e.button === 1 || (e.button === 0 && e.altKey)) {
    // Middle button (or Alt+drag) pans.
    pan = { x: e.clientX, y: e.clientY };
    e.preventDefault();
    return;
  }
  if (e.button !== 0) return;
  e.preventDefault();
  focusInput();
  const hit = pageAt(e.offsetX, e.offsetY);
  if (!hit) return;
  const clicks = clickCount(e);
  const unit = clicks === 2 ? 'word' : clicks >= 3 ? 'paragraph' : 'character';
  send({ kind: 'pointer', page: hit.page.id, x: hit.x, y: hit.y, extend: e.shiftKey && unit === 'character', unit });
  selecting = unit === 'character';
});

canvas.addEventListener('pointermove', (e) => {
  if (pan) {
    userMoved = true;
    camera.panBy(pan.x - e.clientX, pan.y - e.clientY);
    pan = { x: e.clientX, y: e.clientY };
    requestRender();
    return;
  }
  if (!selecting) return;
  if (!pendingDrag) {
    requestAnimationFrame(() => {
      const drag = pendingDrag;
      pendingDrag = null;
      const hit = drag && pageAt(drag.x, drag.y);
      if (hit && selecting) send({ kind: 'pointer', page: hit.page.id, x: hit.x, y: hit.y, extend: true });
    });
  }
  pendingDrag = { x: e.offsetX, y: e.offsetY };
});

const endPointer = () => {
  pan = null;
  selecting = false;
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

// Trackpad pinch arrives as ctrl+wheel; cmd/ctrl+wheel zooms with a mouse; plain wheel scrolls.
// Browsers don't flag macOS momentum events, so while a scroll is still coasting, cmd only takes
// over once the deltas grow again (fresh wheel/trackpad input); a decaying tail keeps scrolling.
const WHEEL_GESTURE_GAP_MS = 200;
let wheelZooming = false;
let lastWheelTime = -Infinity;
let lastWheelMagnitude = 0;
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? canvas.clientHeight : 1;
    userMoved = true;
    const zoomKey = e.ctrlKey || e.metaKey;
    const magnitude = Math.hypot(e.deltaX, e.deltaY) * unit;
    const coasting = e.timeStamp - lastWheelTime <= WHEEL_GESTURE_GAP_MS && magnitude <= lastWheelMagnitude * 1.1 + 1;
    if (!zoomKey) wheelZooming = false;
    else if (wheelZooming || !coasting) wheelZooming = true;
    lastWheelTime = e.timeStamp;
    lastWheelMagnitude = magnitude;
    if (wheelZooming) camera.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * unit * 0.01));
    else camera.panBy(e.deltaX * unit, e.deltaY * unit);
    requestRender();
  },
  { passive: false },
);

// --- Keyboard and text input -----------------------------------------------------------

/** Editing keys, as Word (Windows) and macOS text fields map them. */
function editingCommand(e: KeyboardEvent): WireCommand[] | null {
  const extend = e.shiftKey;
  const word = MAC ? e.altKey : e.ctrlKey;
  const line = MAC && e.metaKey;
  const move = (to: MoveTarget): WireCommand[] => [{ kind: 'move', to, extend }];
  switch (e.key) {
    case 'ArrowLeft':
      return move(line ? 'lineStart' : word ? 'wordLeft' : 'left');
    case 'ArrowRight':
      return move(line ? 'lineEnd' : word ? 'wordRight' : 'right');
    case 'ArrowUp':
      return move(line ? 'documentStart' : 'up');
    case 'ArrowDown':
      return move(line ? 'documentEnd' : 'down');
    case 'Home':
      return move(e.ctrlKey || e.metaKey ? 'documentStart' : 'lineStart');
    case 'End':
      return move(e.ctrlKey || e.metaKey ? 'documentEnd' : 'lineEnd');
    case 'Backspace':
      if (line) return [{ kind: 'move', to: 'lineStart', extend: true }, { kind: 'delete', direction: 'backward' }];
      return [{ kind: 'delete', direction: 'backward', unit: word ? 'word' : 'character' }];
    case 'Delete':
      return [{ kind: 'delete', direction: 'forward', unit: word ? 'word' : 'character' }];
    case 'Enter':
      return [{ kind: e.shiftKey ? 'insertLineBreak' : 'insertParagraph' }];
    case 'Tab':
      return [{ kind: 'insertText', text: '\t' }];
  }
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'a') return [{ kind: 'selectAll' }];
  if (mod && e.key.toLowerCase() === 'z') return [{ kind: e.shiftKey ? 'redo' : 'undo' }];
  if (e.ctrlKey && !MAC && e.key.toLowerCase() === 'y') return [{ kind: 'redo' }];
  return null;
}

function toggleGrid(): void {
  grid = !grid;
  cameraPlaced = false;
  userMoved = false;
  arrange();
}

/** View keys: zoom, grid, fit, page scrolling. */
function viewKey(e: KeyboardEvent): boolean {
  const mod = e.metaKey || e.ctrlKey;
  const cx = canvas.clientWidth / 2;
  const cy = canvas.clientHeight / 2;
  const viewHeight = canvas.clientHeight / (camera.zoom * CSS_PX_PER_POINT);
  if (mod && (e.key === '=' || e.key === '+')) camera.zoomAt(cx, cy, 1.25);
  else if (mod && e.key === '-') camera.zoomAt(cx, cy, 0.8);
  else if (mod && e.key === '0') camera.zoomAt(cx, cy, 1 / camera.zoom);
  else if (e.key === 'PageDown') camera.y += viewHeight * 0.9;
  else if (e.key === 'PageUp') camera.y -= viewHeight * 0.9;
  else if (e.altKey && e.code === 'KeyF') camera.fit(bounds, canvas.clientWidth, canvas.clientHeight);
  else if (e.altKey && e.code === 'KeyG') {
    toggleGrid();
    return true;
  } else return false;
  userMoved = true;
  requestRender();
  return true;
}

window.addEventListener('keydown', (e) => {
  if (dashboard.visible) return; // the dashboard has the keyboard; the document is behind it
  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
  if (e.isComposing) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    // Documents save themselves; the habit just saves a little sooner.
    e.preventDefault();
    if (current.unsavedSince || !current.localId) void saveInBrowser();
    else setStatus('All changes are saved in this browser');
    return;
  }
  if (viewKey(e)) {
    e.preventDefault();
    return;
  }
  const commands = editingCommand(e);
  if (!commands) return;
  e.preventDefault();
  if (document.activeElement !== input) focusInput();
  for (const command of commands) send(command);
});

// Typed text arrives as input events on the hidden textarea (after keyboard layouts, dead
// keys and IMEs have done their work), never as raw key presses.
input.addEventListener('beforeinput', (e) => {
  if (e.isComposing || e.inputType === 'insertCompositionText') return;
  if (e.inputType === 'insertText' || e.inputType === 'insertReplacementText') {
    e.preventDefault();
    const text = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
    if (text) send({ kind: 'insertText', text });
  }
});
input.addEventListener('compositionend', (e) => {
  if (e.data) send({ kind: 'insertText', text: e.data });
  input.value = '';
});
input.addEventListener('copy', (e) => {
  e.preventDefault();
  e.clipboardData?.setData('text/plain', selection.text);
});
input.addEventListener('cut', (e) => {
  e.preventDefault();
  e.clipboardData?.setData('text/plain', selection.text);
  if (selection.text) send({ kind: 'delete', direction: 'backward' });
});
input.addEventListener('paste', (e) => {
  e.preventDefault();
  const text = e.clipboardData?.getData('text/plain');
  if (text) send({ kind: 'insertText', text });
});

// --- Navigation ------------------------------------------------------------------------

// Menu bar and toolbars (./ui); chromeHost.ts maps their actions onto this app.
const chromeHost = createChromeHost({
  dashboard: () => dashboard.toggle(),
  canvas,
  camera,
  pages: () => pages,
  bounds: () => bounds,
  open: (source) => {
    history.replaceState(null, '', location.pathname);
    open(source);
  },
  openSample: openSource,
  collaborate,
  saveToCloud,
  download,
  convert: convertTo,
  signIn,
  signOut,
  clearLocalData,
  saved: () => savedDocs.map((d) => ({ id: d.id, label: d.name.replace(/&/g, '&&') })),
  cloud: () => ({
    signedIn: cloudUser !== null,
    user: cloudUser?.email ?? cloudUser?.name ?? null,
    documents: cloudDocs.map((d) => ({ id: d.id, label: d.name.replace(/&/g, '&&') })),
  }),
  send,
  annotating: () => annotating,
  setFormMode: (mode) => {
    formMode = mode;
    formLayer.setMode(mode);
    requestRender();
    if (mode === 'fill') focusInput();
  },
  author: () => cloudUser?.name ?? cloudUser?.email ?? userName,
  selectedText: () => selection.text,
  focusEditor: focusInput,
  notify: setStatus,
  toggleGrid,
  toggleStats: () => {
    statsEl.hidden = !statsEl.hidden;
    requestRender();
  },
  viewChanged: () => {
    userMoved = true;
    requestRender();
  },
  fonts: () =>
    fetch(`${FONT_BASE}manifest.json`)
      .then((r) => r.json() as Promise<{ families: { wordName: string }[] }>)
      .then((m) => m.families.map((f) => f.wordName)),
  samples: () => [
    { id: 'welcome', label: 'W&elcome to Golem Docs' },
    { id: 'fonts', label: '&Fonts' },
    { id: 'war-and-peace', label: '&War and Peace' },
    ...corpusNames.map((name) => ({ id: `corpus:${name}`, label: name.replace(/&/g, '&&') })),
  ],
});
const chrome = mountChrome(document.getElementById('chrome')!, { host: chromeHost, showUnimplemented: import.meta.env.DEV });

// The dashboard of all documents (File ▸ Dashboard). Opening a document from it goes through the
// same paths as File ▸ Open Recent and Cloud Documents.
const dashboard = new Dashboard(document.getElementById('viewport')!, {
  newDocument: () => void Promise.resolve(chromeHost.perform({ kind: 'new' })).then(focusInput),
  openLocal: (id) => openSource(`local:${id}`),
  openCloud: (id) => openSource(`cloud:${id}`),
  saveToCloud: async (id) => {
    await sendToCloud(id);
  },
  signIn: () => signIn({ dashboard: true }),
  signOut,
  closed: focusInput,
});

// Signed out, documents live only in this browser: offer to clear them (for shared computers).
const sharedDeviceNotice = new SharedDeviceNotice(document.body, () => void clearLocalData());

// Comments down the right of the editor; edits to them are ordinary (undoable) edits.
// A PDF's form fields, over its pages: filled in or arranged (see ui/formLayer.ts).
const formLayer = new FormLayer(document.getElementById('viewport')!, {
  camera,
  canvas,
  page: (id) => pagesById.get(id),
  pageAt: (x, y) => {
    const hit = pageAt(x, y);
    return hit && { page: hit.page, x: hit.x, y: hit.y };
  },
  change: (fields, merge) => send({ kind: 'setFields', fields, merge }),
  notify: setStatus,
});

const commentsPanel = new CommentsPanel(document.getElementById('viewport')!, {
  select: (id) => {
    send({ kind: 'selectComment', id });
    focusInput();
  },
  edit: (id, text) => send({ kind: 'editComment', id, text }),
  remove: (id) => send({ kind: 'deleteComment', id }),
});

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files[0];
  if (file) openFile(file);
});

// Debug/automation hooks.
Object.assign(window, { camera, requestRender, render, openSource, send, pageAt });
Object.defineProperties(window, {
  pages: { get: () => pages },
  loaded: { get: () => loaded },
  status: { get: () => status },
  roomStatus: { get: () => roomStatus },
  editLatency: { get: () => editLatency },
  selectionState: { get: () => ({ caret: selection.caret, text: selection.text, others: selection.others }) },
});

{
  const params = new URLSearchParams(location.search);
  const doc = params.get('doc');
  // Coming back from signing in on the dashboard: open it again.
  if (params.get('dashboard') === '1') {
    params.delete('dashboard');
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
    void dashboard.show();
  }
  void refreshLibrary();
  // Joining a room without a document: the room has it.
  if (!doc && params.get('room')) open({ kind: 'blank', name: params.get('name') ?? 'Document' });
  else if (doc) openSource(doc, true);
  // Nothing asked for: someone with no documents yet is welcomed with what Golem Docs is.
  else void listSaved().then(
    (saved) => openSource(saved.length ? 'fonts' : 'welcome', true),
    () => openSource('welcome', true),
  );
}
