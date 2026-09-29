import './style.css';
import warAndPeaceUrl from '../../scripts/war-and-peace.txt?url';
import type { MoveTarget } from '@word/editor';
import { deskColor, onThemeChange } from './ui/theme.ts';
import { FrameMonitor, debugFlags, onDebugFlagsChange } from './debug.ts';
import { currentUser, signOut as signOutOfCloud, type User } from './auth.ts';
import { createChromeHost } from './chromeHost.ts';
import { CloudError, deleteDocument, documentUrl, listDocuments, listShared, saveDocument, type CloudDocument } from './cloud.ts';
import { openFromCloud, uploadToCloud } from './library.ts';
import {
  adoptGuestDocuments,
  clearAllSaved,
  deleteOwnedBy,
  deleteSaved,
  getSaved,
  getThumbnail,
  listSaved,
  markSynced,
  ownedBy,
  saveSaved,
  saveThumbnail,
  type SavedInfo,
} from './storage/local.ts';
import { hasUnsentChanges, mergeLibrary, type LibraryEntry } from './sync.ts';
import { capturePageThumbnail } from './thumbnail.ts';
import { CommentsPanel } from './ui/commentsPanel.ts';
import { FormLayer } from './ui/formLayer.ts';
import { PointerLayer } from './ui/pointerLayer.ts';
import { showShareDialog } from './ui/shareDialog.ts';
import { showSignInDialog } from './ui/signIn.ts';
import { Dashboard } from './ui/dashboard.ts';
import { opensFromCloud } from './ui/dashboardFormat.ts';
import { showConfirm } from './ui/popup.ts';
import { SharedDeviceNotice } from './ui/sharedDeviceNotice.ts';
import { arrangePages, columnsToFill, nearestPage, type Bounds } from './document/arrange.ts';
import { LayoutClient } from './layout/layoutClient.ts';
import { FONT_BASE, type DocumentSource, type LayoutUpdate, type RoomOptions, type RoomState, type SelectionUpdate, type WireCommand } from './layout/protocol.ts';
import { ImageRenderer } from './shapes/imageRenderer.ts';
import { AtlasLibrary } from './text/gpuFace.ts';
import { Camera, CSS_PX_PER_POINT } from './view/camera.ts';
import { GpuPage } from './view/gpuPage.ts';
import { PageRenderer, type FrameStats } from './view/pageRenderer.ts';
import { getLocale, initLocale, t, type MessageKey } from './i18n/index.ts';
import { FindDialog } from './ui/findDialog.ts';
import { SpellDialog } from './ui/spellDialog.ts';
import { opensLink, showLinkDialog } from './ui/linkDialog.ts';
import { SelectionLayer } from './view/selectionLayer.ts';
import { isFormat, type Format } from './formats/convert.ts';
import { sourceFromFile, stem } from './formats/source.ts';
import { FORMATS, kindFromName, mountChrome, type DocumentKind, type DocumentSync, type FormatState, type FormMode, type SyncStatus } from './ui/index.ts';

// Every string the UI builds goes through t(): the language has to be loaded first. Started here
// and awaited once the worker is running, so it doesn't hold up starting the worker.
const localeReady = initLocale();
// Who is signed in decides whether a saved document joins its room, so ask straight away too.
const accountLookup = currentUser().catch(() => null);

const PAGE_GAP = 18;
const CARET_BLINK_MS = 530;
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const input = document.getElementById('input') as HTMLTextAreaElement;
const statusPanelsEl = document.getElementById('statusPanels') as HTMLElement;
const renderInfoEl = document.getElementById('renderInfo') as HTMLElement;
const renderStatsEl = renderInfoEl.querySelector('.debug-stats') as HTMLElement;
const renderLight = document.getElementById('renderLight') as HTMLSpanElement;
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: true });
if (!gl) {
  await localeReady;
  throw new Error(t('app.webglUnsupported'));
}

// A new canvas is black until it is first drawn to: paint the desk at once, before pages arrive.
{
  const [r, g, b] = deskColor();
  gl.clearColor(r, g, b, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

const camera = new Camera();
const renderer = new PageRenderer(gl);
const atlases = new AtlasLibrary(gl, FONT_BASE, requestRender);
const selection = new SelectionLayer(gl);
// The document, layout and editing live in a worker; it streams pages here as GPU-ready
// buffers and answers input with page updates and selection geometry. This thread draws.
const worker = new LayoutClient((faces) => {
  for (const face of faces) atlases.define(face);
});
await localeReady;

// The document to carry on with is read from this browser while the rest of the page is built.
const LAST_DOC_KEY = 'golemdocs.lastDoc';
function lastDoc(): string | null {
  try {
    return localStorage.getItem(LAST_DOC_KEY);
  } catch {
    return null;
  }
}
let earlySaved: { id: string; saved: Promise<Awaited<ReturnType<typeof getSaved>>> } | null = null;
{
  const params = new URLSearchParams(location.search);
  const wanted = params.get('doc') ?? (params.get('room') ? null : lastDoc());
  if (wanted?.startsWith('local:')) earlySaved = { id: wanted.slice(6), saved: getSaved(wanted.slice(6)).catch(() => null) };
}

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
let room: { id: string; people: number; version: number; unsent: number } | null = null;
/** Latest edit round trip (command sent to its selection update), ms. */
let editTimes: { total: number; worker: number } | null = null;
/** How long the current document took to open, ms. */
let loadTimes: { pages: number; glyphs: number; firstPage: number; total: number; read: number; fonts: number; body: number; headers: number } | null = null;
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
  return source.kind === 'pdf' || source.kind === 'md' || source.kind === 'txt' || source.kind === 'odt' || source.kind === 'rtf' || source.kind === 'epub' || source.kind === 'csv' || source.kind === 'tex' || source.kind === 'adoc' || source.kind === 'rst' || source.kind === 'org' || source.kind === 'tsv' || source.kind === 'mhtml' || source.kind === 'html' ? source.kind : 'docx';
}

function setStatus(text: string): void {
  status = text;
  requestRender();
}

function open(source: DocumentSource, options: { grid?: boolean; localId?: string; cloudId?: string; shared?: CloudDocument } = {}): void {
  const start = performance.now();
  let name = 'name' in source ? source.name : source.kind === 'welcome' ? t('app.welcomeName') : t('app.fontsName');
  let firstPage = 0;
  saveIfEdited(); // the worker is asked for the bytes now, before it switches documents
  current = {
    localId: options.localId ?? null,
    unsavedSince: 0,
    builtIn: source.kind === 'welcome' || source.kind === 'fonts',
    room: null,
    roomRequested: false,
    shared: options.shared?.role === 'editor' || options.shared?.role === 'viewer' ? { id: options.shared.id, role: options.shared.role, dirty: false, uploading: false, error: null } : null,
  };
  showSync();
  for (const page of pagesById.values()) page.dispose(gl!);
  pagesById.clear();
  pages = [];
  selection.clear();
  commentsPanel.update([]);
  comments = [];
  formLayer.update(null);
  pointerLayer.update([]);
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
  editTimes = null;
  room = null;
  loadTimes = null;
  pendingNotice = null;
  documentName = name;
  documentKind = kindOfSource(source);
  annotating = false;
  sharedDeviceNotice.update({ welcome: source.kind === 'welcome' });
  setStatus(t('app.loading', { name }));

  const requestedRoom = roomOptions() ?? networkRoom(options.cloudId ?? options.shared?.id);
  current.roomRequested = requestedRoom !== undefined;
  worker.open(source, {
    opened(docName, format, fixedPages, outdated) {
      name = documentName = docName;
      documentKind = format;
      annotating = fixedPages;
      if (outdated) pendingNotice = outdatedPages();
      setStatus(t('app.layingOut', { name }));
    },
    layout(update) {
      if (!firstPage && update.pages.length) firstPage = performance.now() - start;
      applyLayout(update);
      if (update.selection) applySelection(update.selection);
      if (!loaded) setStatus(t('app.layingOutPages', { name, count: pages.length, pages: pages.length.toLocaleString(getLocale()) }));
    },
    done(count, times) {
      loaded = true;
      arrange();
      const glyphs = pages.reduce((n, p) => n + p.glyphCount, 0);
      loadTimes = { pages: count, glyphs, firstPage, total: performance.now() - start, read: times.read, fonts: times.fonts, body: times.body, headers: times.headers };
      setStatus(t('app.ready', { name }));
      if (pendingNotice) {
        setStatus(pendingNotice);
        pendingNotice = null;
      }
      if (current.localId) backfillThumbnail(current.localId);
    },
    selection(update) {
      applySelection(update);
    },
    roomReplace() {
      const doc = current;
      if (doc.localId && doc.unsavedSince === 0) void openLocal(doc.localId);
    },
    roomState(state) {
      const doc = current;
      const was = doc.room;
      doc.room = state;
      const text = describeRoom(state);
      if (text !== lastRoomText) notify(text || t('app.editingAlone'));
      lastRoomText = text;
      // The server saves while several people are editing: an upload from here would be refused.
      if (state.mode !== 'solo' && doc.localId) dirty.delete(doc.localId);
      // Back to saving from here: the server's last version is what this copy now continues from.
      if (was && was.mode !== 'solo' && state.mode === 'solo') void resumeAfterRoom(doc);
      if (state.mode === 'offline') notify(t('app.roomLost'));
      showSync();
      requestRender();
    },
    pointers(list) {
      pointerLayer.update(list);
    },
    remoteEdit() {
      // Other people's edits are part of this document too, so they're kept in this browser.
      documentEdited();
    },
    room(people, version, unconfirmed) {
      room = { id: new URLSearchParams(location.search).get('room') ?? '', people, version, unsent: unconfirmed };
      requestRender();
    },
    error(message) {
      loaded = true;
      setStatus(t('app.documentError', { name, message }));
    },
  }, requestedRoom);
  focusInput();
}

// --- Collaboration ---------------------------------------------------------------------
// ?room=<name> opens the document in a collaboration room. Until there's a networked server,
// rooms live in a SharedWorker (./collab/devServer.ts) shared by this browser's tabs.

const USER_COLORS = [0xe8590c, 0x2f9e44, 0x7048e8, 0xd6336c, 0x1098ad, 0xf08c00];
const userColor = USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
const guestNumber = Math.floor(Math.random() * 900 + 100);
const guestName = (): string => t('app.guestName', { number: guestNumber });

function roomOptions(): RoomOptions | undefined {
  const name = new URLSearchParams(location.search).get('room');
  if (!name || typeof SharedWorker === 'undefined') return undefined;
  const server = new SharedWorker(new URL('./collab/devServer.ts', import.meta.url), { type: 'module', name: 'word-collab' });
  return { kind: 'dev', name, port: server.port, user: guestName(), color: userColor };
}

/** The multiplayer server's room for a cloud document, when signed in (else the document is edited on its own). */
function networkRoom(cloudId: string | undefined): Extract<RoomOptions, { kind: 'network' }> | undefined {
  if (!cloudId || !account) return undefined;
  return { kind: 'network', docId: cloudId, user: account.name ?? account.email ?? guestName(), color: userColor };
}

let lastRoomText = '';

/**
 * The room stopped saving for us (we are alone again). What is in this browser is the document as
 * the server last saved it, so it continues from the cloud's current version: without this, its next
 * upload would look like it started from an older one and be kept as a "(conflicted copy)".
 */
async function resumeAfterRoom(doc: OpenDocument): Promise<void> {
  try {
    await saving;
    const info = savedDocs.find((d) => d.id === doc.localId);
    const cloud = info?.cloudId ? (await listDocuments()).find((d) => d.id === info.cloudId) : undefined;
    if (doc === current && info?.cloudId && cloud) {
      // Only the version it continues from changes; edits made since still count as unsent.
      await markSynced(info.id, { cloudId: info.cloudId, syncedAt: info.cloudSyncedAt ?? 0, cloudUpdatedAt: cloud.updatedAt });
      cloudDocs = [cloud, ...cloudDocs.filter((d) => d.id !== cloud.id)];
    }
  } catch {
    // Offline: the next upload sorts itself out as any other.
  }
  if (doc === current) documentEdited(); // saves the copy, and so uploads it
}

/** What the status line says about the room. */
function describeRoom(state: RoomState): string {
  if (state.mode === 'offline') return t('app.roomConnectionLost');
  const others = state.people.length - 1;
  const parts: string[] = [];
  if (state.role === 'viewer') parts.push(t('app.roomViewOnly'));
  if (others > 0) parts.push(t('app.roomPeople', { count: state.people.length }));
  return parts.join(' · ');
}

/** Puts the document, as it is now, in a new room, and opens a second window on it. */
async function collaborate(): Promise<void> {
  const params = new URLSearchParams(location.search);
  if (documentKind !== 'docx') {
    setStatus(t('app.collabNeedsWord'));
    return;
  }
  if (!params.get('room')) {
    let bytes: Uint8Array;
    try {
      bytes = await worker.convert('docx');
    } catch (e) {
      setStatus(t('app.collabFailed', { message: (e as Error).message }));
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
  history.replaceState(null, '', `?${params}`);
  if (source === 'war-and-peace') {
    open({ kind: 'text-url', name: t('app.warAndPeaceName'), url: warAndPeaceUrl }, { grid: true });
  } else if (source.startsWith('corpus:')) {
    const name = source.slice(7);
    open({ kind: 'docx-url', name, url: CORPUS_URL + encodeURIComponent(name) });
  } else if (source.startsWith('local:')) {
    void openLocal(source.slice(6));
  } else if (source.startsWith('cloud:')) {
    void openCloud(source.slice(6));
  } else if (source.startsWith('shared:')) {
    void openShared(source.slice(7));
  } else if (source === 'welcome') {
    open({ kind: 'welcome' });
  } else {
    open({ kind: 'fonts' });
  }
}

// --- Saving ----------------------------------------------------------------------------
// Documents save themselves a moment after each edit, so there's no Save command, and the user
// never picks where a document goes. Signed out, documents are saved in this browser (IndexedDB)
// and the app needs no account. Signed in, the account is where they live: each save still lands
// in this browser first (instant, and safe offline) and is uploaded soon after. Signing in brings
// this browser's documents into the account; signing out removes the account's from this browser.

const AUTOSAVE_DELAY_MS = 1000;
/** Typing without a pause still saves this often. */
const AUTOSAVE_MAX_WAIT_MS = 10_000;

interface OpenDocument {
  /** Its id among the documents saved in this browser (null until first saved). */
  localId: string | null;
  /** When its oldest unsaved edit was made (performance.now()), or 0 when everything is saved. */
  unsavedSince: number;
  /** The welcome or fonts document: only worth saving once the user has changed it. */
  builtIn: boolean;
  /** Where it stands in the multiplayer server's room (cloud documents), once joined. */
  room: RoomState | null;
  /** A multiplayer room has been asked for (at open, or once the document was first uploaded). */
  roomRequested: boolean;
  /**
   * A document someone else owns, opened straight from the cloud: it has no copy in this browser
   * and edits go to the cloud directly (or through the room), never to a copy of it here.
   */
  shared: { id: string; role: 'editor' | 'viewer'; dirty: boolean; uploading: boolean; error: string | null } | null;
}

/** A new one per open(), so a save finishing for the previous document can't touch this one. */
let current: OpenDocument = { localId: null, unsavedSince: 0, builtIn: false, room: null, roomRequested: false, shared: null };
let autosaveTimer = 0;
/** Saves write one at a time, in order, so a new document's first saves don't each create a copy. */
let saving: Promise<unknown> = Promise.resolve();

/** Schedules a save for once editing pauses. */
function documentEdited(): void {
  if (current.shared) return sharedEdited();
  const now = performance.now();
  if (!current.unsavedSince) current.unsavedSince = now;
  clearTimeout(autosaveTimer);
  const wait = Math.min(AUTOSAVE_DELAY_MS, current.unsavedSince + AUTOSAVE_MAX_WAIT_MS - now);
  autosaveTimer = window.setTimeout(() => void saveInBrowser(), Math.max(0, wait));
}

/** Saves now if there are unsaved edits (another document is opening, or the page is going away). */
function saveIfEdited(): void {
  if (current.shared) {
    if (current.shared.dirty) void uploadShared();
    return;
  }
  if (current.unsavedSince) void saveInBrowser();
}

// A shared document has no copy in this browser. When this user is the only one editing it, the
// document goes to the cloud a moment after each edit; while several people edit, the server saves.
let sharedTimer = 0;

function sharedEdited(): void {
  const shared = current.shared!;
  if (shared.role === 'viewer' || current.room?.mode === 'shared' || current.room?.mode === 'offline') return;
  shared.dirty = true;
  clearTimeout(sharedTimer);
  sharedTimer = window.setTimeout(() => void uploadShared(), UPLOAD_DELAY_MS);
  showSync();
}

async function uploadShared(): Promise<void> {
  const doc = current;
  const shared = doc.shared;
  if (!shared || !shared.dirty || shared.uploading) return;
  clearTimeout(sharedTimer);
  shared.dirty = false;
  shared.uploading = true;
  shared.error = null;
  showSync();
  try {
    await saveDocument(shared.id, await worker.convert('docx'));
  } catch (e) {
    // Refused because the room started saving: the edits are in the room's hands now.
    if (!(e instanceof CloudError && e.status === 423)) {
      shared.dirty = true;
      shared.error = (e as Error).message;
    }
  } finally {
    shared.uploading = false;
    if (doc === current) showSync();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return;
  saveIfEdited();
  void saving.then(() => flushUploads()); // the page may be closing: don't wait for the pause
});

/** The open document's id in this browser, saving it first if it has unsaved edits or was never saved. */
function saveNow(): Promise<string | null> {
  const doc = current;
  if (doc.shared) return Promise.resolve(null); // no copy in this browser
  return doc.unsavedSince || (!doc.localId && !doc.builtIn) ? saveInBrowser() : saving.then(() => doc.localId);
}

/** Shown when the current document finishes loading, which would otherwise replace it. */
let pendingNotice: string | null = null;

/** Who is signed in; null signed out. Offline, whoever was last time (see auth.ts). */
let account: User | null = null;
/** This browser's copies of the documents in view: the account's, or signed out, the browser's own. */
let savedDocs: SavedInfo[] = [];
/** The account's documents, as last listed (empty signed out or offline). */
let cloudDocs: CloudDocument[] = [];

/**
 * Finds out who is signed in and gets going: signed in, any documents made here while signed out
 * join the account, and whatever the account doesn't have yet is sent. Run on load and whenever
 * the connection comes back.
 */
/** The first `connect()`, on load: opening a document in the account waits for it, to know who is signed in. */
let firstConnect: Promise<void> = Promise.resolve();
/** Who is signed in is known: enough to decide whether a document joins its room. */
let accountKnown: Promise<void> = Promise.resolve();

async function connect(lookup: Promise<User | null> = currentUser()): Promise<void> {
  const before = account?.id ?? null;
  account = await lookup;
  if (account) {
    const adopted = await adoptGuestDocuments(account.id).catch(() => []);
    if (adopted.length) notify(t('app.adopted', { count: adopted.length }));
  }
  await refreshLibrary();
  sharedDeviceNotice.update({ signedIn: account !== null });
  if (account) {
    for (const info of savedDocs) if (hasUnsentChanges(info)) dirty.add(info.id);
    void flushUploads();
  }
  if ((account?.id ?? null) !== before) dashboard.refreshIfVisible();
  showSync();
}

/** Refreshes what File ▸ Open Recent lists. */
async function refreshLibrary(): Promise<void> {
  if (account) {
    try {
      cloudDocs = await listDocuments();
      signedOutRemotely = false;
    } catch (e) {
      if (e instanceof CloudError && e.status === 401) signedOutRemotely = true;
      else if (e instanceof TypeError) wentOffline();
    }
  } else {
    cloudDocs = [];
  }
  savedDocs = ownedBy(await listSaved().catch(() => []), account?.id ?? null);
  showSync();
}

/** Where to open a listed document from: the account only when this browser's copy is missing or older. */
function sourceOf(entry: LibraryEntry): string {
  return entry.local && !opensFromCloud(entry) ? `local:${entry.local.id}` : `cloud:${entry.cloud!.id}`;
}

// --- Uploading ------------------------------------------------------------------------------
// Signed in, each save schedules an upload of that document for a moment after editing pauses.
// Uploads go one at a time. Offline, or once the session has ended, they wait (the button at the
// top right says so) and go when the connection or the sign-in is back.

const UPLOAD_DELAY_MS = 2000;
/** How often to try again while offline (the browser's "online" event isn't always reliable). */
const OFFLINE_RETRY_MS = 30_000;
/** Browser copies with changes the account doesn't have, to upload. */
const dirty = new Set<string>();
let uploadTimer = 0;
let flushing: Promise<void> | null = null;
/** The browser copy being uploaded now, if any. */
let uploading: string | null = null;
/** Uploads failed because the account couldn't be reached. */
let offline = false;
let offlineRetryTimer = 0;
/** The session ended (signed out elsewhere, or it expired): uploads wait for the user to sign in again. */
let signedOutRemotely = false;
/** Why a browser copy's last upload failed, by id (cleared by the next that works). */
const failures = new Map<string, string>();

function syncStatus(): SyncStatus {
  if (!account) return { user: null, document: 'guest', error: null };
  const user = account.email ?? account.name ?? null;
  const id = current.localId;
  const info = savedDocs.find((d) => d.id === id);
  const unsent = current.unsavedSince > 0 || (id !== null && uploading === id) || (info !== undefined && hasUnsentChanges(info));
  let document: DocumentSync;
  const shared = current.shared;
  if (shared) {
    let state: DocumentSync;
    if (shared.role === 'viewer' || (current.room?.mode === 'shared' && !current.room.unconfirmed)) state = 'saved';
    else if (current.room?.mode === 'shared') state = 'saving';
    else if (shared.error) state = 'failed';
    else state = shared.uploading || shared.dirty ? 'saving' : 'saved';
    return { user, document: state, error: state === 'failed' ? shared.error : null };
  }
  if (id && failures.has(id)) document = 'failed';
  else if (current.room?.mode === 'shared') document = current.room.unconfirmed ? 'saving' : 'saved';
  else if (!unsent) document = 'saved';
  else if (signedOutRemotely) document = 'signedOut';
  else if (offline) document = 'offline';
  else document = 'saving';
  return { user, document, error: document === 'failed' ? failures.get(id!)! : null };
}

function showSync(): void {
  chrome.update({ sync: syncStatus() });
}

/** Uploads a browser copy once editing has paused. */
function scheduleUpload(id: string, delay = UPLOAD_DELAY_MS): void {
  dirty.add(id);
  clearTimeout(uploadTimer);
  uploadTimer = window.setTimeout(() => void flushUploads(), delay);
}

/** Uploads everything waiting, now. Resolves once they have all gone (or can't, for now). */
function flushUploads(): Promise<void> {
  clearTimeout(uploadTimer);
  // Cleared asynchronously, so an empty queue can't clear it before it's set.
  flushing ??= drainUploads().finally(() => (flushing = null));
  return flushing;
}

async function drainUploads(): Promise<void> {
  // Copies saved during an upload join the set, and are visited too.
  for (const id of dirty) {
    if (!account || offline || signedOutRemotely) break;
    dirty.delete(id);
    await upload(id);
  }
}

async function upload(id: string): Promise<void> {
  uploading = id;
  showSync();
  const before = savedDocs.find((d) => d.id === id)?.name;
  try {
    const { doc, conflictCopy } = await uploadToCloud(id);
    failures.delete(id);
    // A document made in this session gets its room once it is in the account.
    if (id === current.localId && !current.roomRequested && !conflictCopy) {
      const room = networkRoom(doc.id);
      if (room) {
        current.roomRequested = true;
        worker.joinRoom(room);
      }
    }
    cloudDocs = [doc, ...cloudDocs.filter((d) => d.id !== doc.id)];
    if (conflictCopy) {
      if (id === current.localId) {
        documentName = doc.name;
        chrome.update({ documentName });
      }
      notify(t('app.conflictNotice', { before: before ?? t('app.thisDocument'), name: doc.name }));
    }
  } catch (e) {
    if (e instanceof CloudError && e.status === 401) {
      signedOutRemotely = true;
      dirty.add(id);
    } else if (e instanceof TypeError) {
      // fetch couldn't reach the server.
      dirty.add(id);
      wentOffline();
    } else if (e instanceof CloudError && e.status === 423) {
      // Several people are editing it and the server is saving it: nothing to send from here.
    } else if (e instanceof CloudError) {
      failures.set(id, e.message);
    }
    // Anything else: the copy was deleted meanwhile, so there's nothing to send.
  } finally {
    uploading = null;
    savedDocs = ownedBy(await listSaved().catch(() => savedDocs), account?.id ?? null);
    showSync();
  }
}

/** The account can't be reached: uploads wait, and are tried again every so often. */
function wentOffline(): void {
  offline = true;
  clearTimeout(offlineRetryTimer);
  offlineRetryTimer = window.setTimeout(backOnline, OFFLINE_RETRY_MS);
}

function backOnline(): void {
  if (!account) return;
  offline = false;
  void connect();
}

window.addEventListener('online', backOnline);

/** Tries the uploads that failed again, now (the button's Try again). */
async function syncNow(): Promise<void> {
  saveIfEdited();
  await saving;
  failures.clear();
  offline = false;
  for (const info of savedDocs) if (hasUnsentChanges(info)) dirty.add(info.id);
  showSync();
  await flushUploads();
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
  if (doc.startsWith('local:')) {
    try {
      localStorage.setItem(LAST_DOC_KEY, doc);
    } catch {}
  }
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
      const owner = account?.id;
      const info = await saveSaved({ id: doc.localId ?? undefined, name, bytes: await bytes, owner });
      doc.localId = info.id;
      if (doc === current) {
        await makeThumbnail(info);
        rememberInUrl(`local:${info.id}`);
        // Signed in, the button at the top right says how saving is going.
        if (!owner) setStatus(t('app.savedInBrowser', { name: info.name }));
      }
      // A new document changes what's listed; later saves only its order.
      if (created) void refreshLibrary();
      else savedDocs = ownedBy(await listSaved().catch(() => savedDocs), owner ?? null);
      if (owner) {
        if (doc.room && doc.room.mode !== 'solo') {
          // The server keeps the cloud copy while several people edit. What is saved here is
          // that same document, so it counts as in step with the cloud (which will have moved
          // on, so opening it later fetches the cloud's) unless some edits didn't reach the server.
          if (doc.room.mode === 'shared' && doc.room.unconfirmed === 0 && info.cloudId) {
            await markSynced(info.id, { cloudId: info.cloudId, syncedAt: info.updatedAt });
            savedDocs = ownedBy(await listSaved().catch(() => savedDocs), owner);
          }
        } else scheduleUpload(info.id);
      }
      showSync();
      return info.id;
    } catch (e) {
      if (!doc.unsavedSince) doc.unsavedSince = performance.now(); // still unsaved: the next edit tries again
      if (doc === current) setStatus(t('app.saveFailed', { message: (e as Error).message }));
      return null;
    }
  });
  saving = done;
  return done;
}

async function signIn(options: { dashboard?: boolean } = {}): Promise<void> {
  // Signing in leaves the page, so keep the document first. Coming back, it joins the account.
  const id = await saveNow();
  const back: Record<string, string> = options.dashboard ? { dashboard: '1' } : {};
  showSignInDialog(id ? returnTo({ doc: `local:${id}`, ...back }) : returnTo(back));
}

/**
 * Signs out, and removes the account's documents from this browser (they're in the account). If
 * some changes haven't reached the account yet, it says so first, since signing out loses them.
 */
async function signOut(): Promise<void> {
  const user = account;
  if (!user) return;
  saveIfEdited();
  await saving;
  offline = false;
  await flushUploads();
  const unsent = ownedBy(await listSaved().catch(() => []), user.id).filter(hasUnsentChanges);
  if (unsent.length) {
    const key = offline ? 'app.signOutLossOffline' : signedOutRemotely ? 'app.signOutLossExpired' : 'app.signOutLoss';
    const body = document.createElement('p');
    body.textContent = t(key, { count: unsent.length, name: unsent[0]!.name });
    if (!(await showConfirm(t('app.signOutTitle'), body, t('app.signOutAnyway')))) {
      focusInput();
      return;
    }
  }
  try {
    await signOutOfCloud();
  } catch (e) {
    setStatus(e instanceof TypeError ? t('app.signOutOffline') : t('app.signOutFailed', { message: (e as Error).message }));
    return;
  }
  cleared = true; // nothing more is saved for this account here
  clearTimeout(autosaveTimer);
  clearTimeout(uploadTimer);
  dirty.clear();
  await saving.catch(() => {});
  await deleteOwnedBy(user.id).catch(() => {});
  location.replace(location.pathname);
}

/** Deletes a document (from the dashboard): from the account, and this browser's copy. */
async function deleteEverywhere(entry: LibraryEntry): Promise<void> {
  const cloudId = entry.cloud?.id ?? entry.local?.cloudId;
  if (cloudId && account) {
    try {
      await deleteDocument(cloudId);
    } catch (e) {
      // Already gone is fine; otherwise keep it, rather than have it come back from the account later.
      if (!(e instanceof CloudError && e.status === 404)) throw e;
    }
  }
  if (entry.local) {
    dirty.delete(entry.local.id);
    failures.delete(entry.local.id);
    await deleteSaved(entry.local.id);
  }
  await refreshLibrary();
}

/**
 * File ▸ Clear Local Data: deletes every document, thumbnail and setting kept in this browser,
 * then starts afresh (with the welcome document). The account's documents and the sign-in stay.
 */
async function clearLocalData(): Promise<void> {
  const count = savedDocs.length;
  const body = document.createElement('p');
  const which = count === 0 ? 'None' : count === 1 ? 'One' : 'Many';
  body.textContent = t(`app.clearBody${which}${account ? 'Account' : ''}` as MessageKey, { count });
  if (!(await showConfirm(t('app.clearTitle'), body, t('app.clearConfirm')))) {
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
    setStatus(t('app.clearFailed', { message: (e as Error).message }));
    return;
  }
  location.replace(location.pathname);
}

async function openLocal(id: string): Promise<void> {
  const early = earlySaved?.id === id ? earlySaved.saved : null;
  earlySaved = null;
  const saved = await (early ?? getSaved(id).catch(() => null));
  if (!saved) {
    open({ kind: 'blank', name: t('app.newDocumentName') });
    pendingNotice = t('app.localGone');
    return;
  }
  // Shown at once. Whether it joins its room depends on who is signed in, so if that isn't known
  // yet the room is joined once it is (the room's own copy replaces this one only if untouched).
  const cloudId = saved.info.cloudId;
  open(sourceFromFile(saved.info.name, saved.bytes) ?? { kind: 'docx', name: saved.info.name, bytes: saved.bytes }, { localId: id, cloudId });
  const doc = current;
  if (cloudId && !doc.roomRequested) {
    void accountKnown.then(() => {
      const room = current === doc && !doc.roomRequested ? networkRoom(cloudId) : undefined;
      if (!room) return;
      doc.roomRequested = true;
      worker.joinRoom(room);
    });
  }
}

/** Documents other people shared with this user, as last listed (the dashboard hands them over). */
const sharedDocs = new Map<string, CloudDocument>();

/** Opens a document someone shared with this user, straight from the cloud. */
async function openShared(id: string): Promise<void> {
  await firstConnect;
  try {
    let doc = sharedDocs.get(id);
    if (!doc) {
      for (const d of await listShared()) sharedDocs.set(d.id, d);
      doc = sharedDocs.get(id);
    }
    if (!doc) {
      open({ kind: 'blank', name: t('app.newDocumentName') });
      pendingNotice = t('app.sharedGone');
      return;
    }
    setStatus(t('app.openingShared'));
    open({ kind: 'docx-url', name: doc.name, url: documentUrl(doc.id) }, { shared: doc });
  } catch (e) {
    if (e instanceof CloudError && e.status === 401) showSignInDialog(returnTo({ doc: `shared:${id}` }));
    else setStatus(t('app.openSharedFailed', { message: (e as Error).message }));
  }
}

/** File ▸ Share: who else can open the open document. */
function share(): void {
  if (!account) return notify(t('app.signInToShare'));
  if (current.shared) return notify(t('app.ownerOnlyShare'));
  const info = savedDocs.find((d) => d.id === current.localId);
  if (!info?.cloudId) return notify(t('app.notInAccountYet'));
  showShareDialog({ id: info.cloudId, name: info.name });
}

async function openCloud(id: string): Promise<void> {
  try {
    if (!cloudDocs.some((d) => d.id === id)) await refreshLibrary();
    const cloud = cloudDocs.find((d) => d.id === id);
    const name = cloud?.name ?? t('app.cloudDocumentName');
    setStatus(t('app.opening', { name }));
    // A copy here with changes not uploaded yet opens as it is; uploading it sorts out the rest.
    const { info, bytes } = await openFromCloud({ id, name, updatedAt: cloud?.updatedAt }, account?.id);
    open(sourceFromFile(info.name, bytes) ?? { kind: 'docx', name: info.name, bytes }, { localId: info.id, cloudId: info.cloudId });
    rememberInUrl(`local:${info.id}`);
    void refreshLibrary();
  } catch (e) {
    if (e instanceof CloudError && e.status === 401) showSignInDialog(returnTo({ doc: `cloud:${id}` }));
    else setStatus(t('app.openFailed', { message: (e as Error).message }));
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
    setStatus(t('app.downloaded', { name }));
  } catch (e) {
    setStatus(t('app.downloadFailed', { message: (e as Error).message }));
  }
}

/**
 * File ▸ Print and Print Preview. The document is exported as a PDF (the same export as
 * Download), then printed from a hidden frame, or opened in a new tab to look at first.
 */
async function print(preview: boolean): Promise<void> {
  const bytes = await worker.convert('pdf');
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: FORMATS.pdf.mime }));
  if (preview) {
    if (!window.open(url, '_blank')) setStatus(t('app.allowPopups'));
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }
  const frame = Object.assign(document.createElement('iframe'), { src: url });
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
  frame.addEventListener('load', () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => {
      frame.remove();
      URL.revokeObjectURL(url);
    }, 60_000);
  });
  document.body.append(frame);
}

/** Said when a PDF's own pages are shown after its text was edited as something else. */
const outdatedPages = (): string => t('app.outdatedPages');

/** Said once the document has opened in its new format (what exporting to it leaves out, where that's something). */
function switchedNotice(to: Format): string {
  const { label, extensions } = FORMATS[to];
  if (to === 'pdf') return t('app.switchedPdf');
  const params = { label, extension: extensions[0] ?? '' };
  if (to === 'md') return t('app.switchedMd', params);
  if (to === 'txt') return t('app.switchedTxt', params);
  if (to === 'html') return t('app.switchedHtml', params);
  return t('app.switchedLossless', params);
}

/**
 * Switches the format the document is edited as (File ▸ Convert To, and the selector in the
 * chrome). It is the same document, saved in the app's own format (.wdoc), which keeps
 * everything it holds whatever it is edited as: switching Word → Markdown → Word gives back the
 * fonts and colors, and a Markdown document keeps its look as Word. Only a download (an export)
 * leaves out what its format can't express. Editing a PDF as anything else reflows its text;
 * the original pages are kept, and shown again as PDF (with a warning once the text is edited).
 */
async function convertTo(to: DocumentKind): Promise<void> {
  const from = documentKind;
  if (to === from) return;
  if (!isFormat(to) || !isFormat(from)) throw new Error(t('app.unsupportedFormat', { label: FORMATS[isFormat(to) ? from : to].label }));
  if (new URLSearchParams(location.search).get('room')) {
    setStatus(t('app.leaveRoomToSwitch'));
    return;
  }
  setStatus(t('app.switching', { label: FORMATS[to].label }));
  // Saved now, as the format to edit it as, in place of the document's last save.
  clearTimeout(autosaveTimer);
  const doc = current;
  doc.unsavedSince = 0;
  const name = stem(documentName) + FORMATS[to].extensions[0];
  const bytes = worker.save(to);
  bytes.catch(() => {});
  const done = saving.then(async () => saveSaved({ id: doc.localId ?? undefined, name, bytes: await bytes, owner: account?.id }));
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
  if (!source) throw new Error(t('app.cannotOpenFormat', { label: FORMATS[to].label }));
  history.replaceState(null, '', location.pathname);
  open(source, { grid, localId: info.id });
  rememberInUrl(`local:${info.id}`);
  chrome.update({ documentName, kind: documentKind });
  pendingNotice = switchedNotice(to);
  void refreshLibrary();
  if (account) scheduleUpload(info.id, 0);
}

// --- Selection and caret ---------------------------------------------------------------

let caretOn = true;
/** Formatting at the selection (from the worker), for the toolbar. */
let selectionFormat: FormatState = {};
/** The Format Painter is waiting for a selection to paint. */
let painting = false;
/** The link the selection is in. */
let link: SelectionUpdate['link'] = null;
/** Ctrl/Cmd was down for the last click: open the link it lands on, once the selection says which. */
let followLinkUntil = 0;
/** The document's comments, in order (for Go To). */
let comments: SelectionUpdate['comments'] = [];
let canUndo = false;
let canRedo = false;
let blinkTimer = 0;
/** When the last edit command was sent, for the latency readout. */
let editSent = 0;

function applySelection(update: SelectionUpdate): void {
  selection.update(update);
  commentsPanel.update(update.comments);
  selectionFormat = update.format;
  comments = update.comments;
  painting = update.painting ?? false;
  link = update.link ?? null;
  if (followLinkUntil > performance.now()) {
    followLinkUntil = 0;
    if (link && opensLink(link.url)) window.open(link.url, '_blank', 'noopener,noreferrer');
  }
  canvas.style.cursor = painting ? 'copy' : '';
  if (update.search) findDialog.report(update.search);
  if (update.spell) spellDialog.report(update.spell);
  formLayer.update(update.fields ?? null);
  canUndo = update.canUndo;
  canRedo = update.canRedo;
  if (editSent) {
    editTimes = { total: performance.now() - editSent, worker: update.workerMs };
    editSent = 0;
  }
  // Copy and cut read the selected text from `selection` (see the clipboard handlers).
  input.value = '';
  caretOn = true;
  clearInterval(blinkTimer);
  if (update.caret) {
    blinkTimer = window.setInterval(() => {
      // An unfocused editor draws no caret, so there's nothing to redraw (focus redraws).
      if (document.activeElement !== input || !document.hasFocus()) return;
      caretOn = !caretOn;
      requestCaretRender();
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
  if (command.kind !== 'move' && command.kind !== 'pointer' && command.kind !== 'selectAll' && command.kind !== 'find' && command.kind !== 'spellNext' && command.kind !== 'spellWords') {
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
/** Everything that asked for the queued frame was only the caret blinking. */
let frameCaretOnly = true;

function requestRender(): void {
  frameCaretOnly = false;
  queueFrame();
}

/** A redraw for the caret blinking alone (left out of the debug frame stats). */
function requestCaretRender(): void {
  queueFrame();
}

function queueFrame(): void {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(render);
}

const frames = new FrameMonitor();
let lastStats: FrameStats | null = null;
let lightTimer = 0;

/** Lights the render light for a moment: a frame itself is too brief to see. */
function flashRenderLight(): void {
  renderLight.classList.add('on');
  clearTimeout(lightTimer);
  lightTimer = window.setTimeout(() => renderLight.classList.remove('on'), 80);
}

type DebugRow = [label: string, value: string];

/** Fills a debug panel with label/value pairs (laid out in aligned columns by the CSS). */
function setDebugRows(el: HTMLElement, rows: DebugRow[]): void {
  el.replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const k = document.createElement('span');
      k.textContent = label;
      const v = document.createElement('span');
      v.textContent = value;
      return [k, v];
    }),
  );
}

/** A debug panel (a heading over label/value pairs). `list`: one pair per row, for long values. */
function debugPanel(title: string, rows: DebugRow[], list = false): HTMLElement {
  const panel = document.createElement('section');
  panel.className = list ? 'debug-panel debug-list' : 'debug-panel';
  const heading = document.createElement('h2');
  heading.textContent = title;
  const stats = document.createElement('div');
  stats.className = 'debug-stats';
  setDebugRows(stats, rows);
  panel.append(heading, stats);
  return panel;
}

const ms = (n: number, digits = 0) => `${n.toFixed(digits)} ms`;

/** The debug panels: render information, then the document's status in parts (View > Debug). */
function updateDebug(): void {
  const flags = debugFlags();
  const panels: HTMLElement[] = [];
  if (flags.status) {
    panels.push(debugPanel('Document', [['status', status], ...(loadTimes ? ([['pages', loadTimes.pages.toLocaleString()], ['glyphs', loadTimes.glyphs.toLocaleString()]] as DebugRow[]) : [])], true));
    if (room) {
      panels.push(
        debugPanel('Room', [
          ['id', room.id],
          ['people', String(room.people)],
          ['version', `v${room.version}`],
          ['unsent', String(room.unsent)],
        ]),
      );
    }
  }
  if (flags.load && loadTimes) {
    const t = loadTimes;
    panels.splice(
      flags.status ? 1 : 0,
      0,
      debugPanel('Load', [
        ['first page', ms(t.firstPage)],
        ['all', ms(t.total)],
        ['read', ms(t.read)],
        ['fonts', ms(t.fonts)],
        ['body', ms(t.body)],
        ['headers', ms(t.headers)],
      ]),
    );
  }
  if (flags.edit && editTimes) panels.push(debugPanel('Edit', [['to screen', ms(editTimes.total, 1)], ['worker', ms(editTimes.worker, 1)]]));
  statusPanelsEl.replaceChildren(...panels);
  const rows: DebugRow[] = [];
  if (flags.pages && lastStats) {
    rows.push(
      ['pages', `${lastStats.visiblePages}/${lastStats.pages.toLocaleString()}`],
      ['glyphs', lastStats.glyphs.toLocaleString()],
      ['draws', String(lastStats.drawCalls)],
    );
  }
  if (flags.zoom) rows.push(['zoom', `${Math.round(camera.zoom * 100)}%`]);
  if (flags.cpu) rows.push(['cpu', `${frames.cpuMs.toFixed(2)} ms`]);
  if (flags.fps) rows.push(['fps', String(Math.round(frames.rate))]);
  if (flags.frameTimes) {
    rows.push(['slowest', `${frames.maxCpuMs.toFixed(1)} ms`], ['gap', `${frames.maxGapMs.toFixed(0)} ms`], ['dropped', String(frames.dropped)]);
  }
  setDebugRows(renderStatsEl, rows);
  renderLight.hidden = !flags.fps;
  renderInfoEl.hidden = !rows.length && !flags.fps;
}

onDebugFlagsChange(updateDebug);
onThemeChange(requestRender);
renderInfoEl.addEventListener('click', () => {
  frames.clear();
  updateDebug();
});

function render(): void {
  frameQueued = false;
  const caretOnly = frameCaretOnly;
  frameCaretOnly = true;
  const start = performance.now();
  const caretVisible = caretOn && document.activeElement === input && document.hasFocus();
  camera.clamp(bounds, canvas.clientWidth, canvas.clientHeight);
  lastStats = renderer.render(camera, pages, selection, caretVisible);
  const end = performance.now();
  // The caret blinks on an idle document; counting that would make idle read as a steady frame rate.
  if (!caretOnly) {
    frames.record(end, end - start);
    if (debugFlags().fps) flashRenderLight();
  }
  chrome.update({
    documentName,
    kind: documentKind,
    hasSelection: selection.text.length > 0,
    zoom: camera.zoom,
    grid,
    format: selectionFormat,
    canUndo,
    canRedo,
    formMode: annotating ? formMode : null,
    painting,
  });
  formLayer.position();
  pointerLayer.position();
  updateDebug();
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
  // Resizing clears the canvas to (opaque) black: draw now, before this frame is painted, or
  // that black shows for a frame.
  frameCaretOnly = false;
  render();
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
  if (e.metaKey || e.ctrlKey) followLinkUntil = performance.now() + 1000;
  const clicks = clickCount(e);
  const unit = clicks === 2 ? 'word' : clicks >= 3 ? 'paragraph' : 'character';
  send({ kind: 'pointer', page: hit.page.id, x: hit.x, y: hit.y, extend: e.shiftKey && unit === 'character', unit });
  selecting = unit === 'character';
});

// Where this user's mouse is, for the other people in the document's room (about 20 times a second).
const POINTER_INTERVAL_MS = 50;
let pointerSentAt = 0;
let pointerTimer = 0;
let pointerAt: { x: number; y: number } | null = null;

function shareEnabled(): boolean {
  return (current.room?.people.length ?? 0) > 1;
}

function sendPointer(): void {
  pointerTimer = 0;
  pointerSentAt = performance.now();
  const at = pointerAt;
  const hit = at && pageAt(at.x, at.y);
  worker.pointer(hit ? { page: pages.indexOf(hit.page), x: hit.x, y: hit.y } : null);
}

function pointerMoved(x: number, y: number): void {
  if (!shareEnabled()) return;
  pointerAt = { x, y };
  if (pointerTimer) return;
  pointerTimer = window.setTimeout(sendPointer, Math.max(0, POINTER_INTERVAL_MS - (performance.now() - pointerSentAt)));
}

canvas.addEventListener('pointerleave', () => {
  if (!shareEnabled()) return;
  pointerAt = null;
  clearTimeout(pointerTimer);
  sendPointer();
});

canvas.addEventListener('pointermove', (e) => {
  pointerMoved(e.offsetX, e.offsetY);
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
canvas.addEventListener('pointerup', () => {
  endPointer();
  // With the Format Painter picked up, what was just selected is painted.
  if (painting) send({ kind: 'applyPainter' });
});
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
  if (painting && e.key === 'Escape') {
    e.preventDefault();
    send({ kind: 'format', action: { kind: 'formatPainter' } });
    return;
  }
  if (dashboard.visible) return; // the dashboard has the keyboard; the document is behind it
  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
  if (e.isComposing) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    // Documents save themselves; the habit just saves a little sooner.
    e.preventDefault();
    if (current.shared) void uploadShared();
    else if (current.unsavedSince || (!current.localId && !current.builtIn)) void saveInBrowser();
    else if (account) void flushUploads();
    else setStatus(t('app.allSaved'));
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
  syncNow,
  share,
  download,
  print,
  showFind: (tab) => findDialog.show(tab),
  showSpelling: () => spellDialog.open(),
  showLinkDialog: () => {
    const selected = selection.text;
    if (selected.includes('\n')) return setStatus(t('app.linkOneParagraph'));
    void showLinkDialog(link ?? null, selected).then((choice) => {
      if (choice === undefined) return;
      send(choice ? { kind: 'setLink', url: choice.url, text: choice.text } : { kind: 'removeLink' });
      focusInput();
    });
  },
  convert: convertTo,
  signIn,
  signOut,
  clearLocalData,
  saved: () => mergeLibrary(savedDocs, account ? cloudDocs : null).map((e) => ({ id: sourceOf(e), label: e.name.replace(/&/g, '&&') })),
  send,
  annotating: () => annotating,
  setFormMode: (mode) => {
    formMode = mode;
    formLayer.setMode(mode);
    requestRender();
    if (mode === 'fill') focusInput();
  },
  author: () => account?.name ?? account?.email ?? guestName(),
  selectedText: () => selection.text,
  focusEditor: focusInput,
  notify: setStatus,
  toggleGrid,
  viewChanged: () => {
    userMoved = true;
    requestRender();
  },
  fonts: () =>
    fetch(`${FONT_BASE}manifest.json`)
      .then((r) => r.json() as Promise<{ families: { wordName: string }[] }>)
      .then((m) => m.families.map((f) => f.wordName)),
  samples: () => [
    { id: 'welcome', label: t('app.sampleWelcome') },
    { id: 'fonts', label: t('app.sampleFonts') },
    { id: 'war-and-peace', label: t('app.sampleWarAndPeace') },
    ...corpusNames.map((name) => ({ id: `corpus:${name}`, label: name.replace(/&/g, '&&') })),
  ],
});
const chrome = mountChrome(document.getElementById('chrome')!, { host: chromeHost, isAdmin: () => account?.isAdmin === true, showUnimplemented: import.meta.env.DEV });

// Edit ▸ Find, Replace and Go To.
const findDialog = new FindDialog(document.body, {
  find: (text, matchCase, backward) => send({ kind: 'find', text, matchCase, backward }),
  replace: (text, replacement, matchCase) => {
    const selected = selection.text;
    if (matchCase ? selected === text : selected.toLowerCase() === text.toLowerCase()) {
      send(replacement ? { kind: 'insertText', text: replacement } : { kind: 'delete', direction: 'backward' });
    }
    send({ kind: 'find', text, matchCase });
  },
  replaceAll: (text, replacement, matchCase) => send({ kind: 'replaceAll', text, with: replacement, matchCase }),
  selectedText: () => selection.text,
  pageCount: () => pages.length,
  pageIndex: () => {
    const center = camera.toDocument(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const page = nearestPage(pages, center.x, center.y);
    return page ? pages.indexOf(page) : 0;
  },
  goToPage: (index) => {
    const page = pages[index];
    if (!page) return;
    // The page's top at the top of the view, and the page centered across it.
    const pointsPerCss = 1 / (camera.zoom * CSS_PX_PER_POINT);
    camera.x = page.x + page.width / 2 - (canvas.clientWidth / 2) * pointsPerCss;
    camera.y = page.y - 16 * pointsPerCss;
    userMoved = true;
    requestRender();
  },
  commentCount: () => comments.length,
  goToComment: (index) => {
    const comment = comments[index];
    if (comment) send({ kind: 'selectComment', id: comment.id });
  },
  focusEditor: focusInput,
});

// Tools ▸ Spelling and Grammar. The words the user adds to the dictionary are kept in this browser.
const USER_WORDS_KEY = 'word.userDictionary.v1';
const userWords = (): string[] => {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(USER_WORDS_KEY) ?? '[]');
    return Array.isArray(saved) ? saved.filter((w): w is string => typeof w === 'string') : [];
  } catch {
    return [];
  }
};
const spellDialog = new SpellDialog(document.body, {
  send,
  selectedText: () => selection.text,
  userWords,
  addUserWord: (word) => {
    try {
      localStorage.setItem(USER_WORDS_KEY, JSON.stringify([...new Set([...userWords(), word])]));
    } catch {
      // Storage unavailable: the word is accepted for this session only.
    }
  },
  focusEditor: focusInput,
});

// The dashboard of all documents (File ▸ Dashboard). Opening a document from it goes through the
// same paths as File ▸ Open Recent.
const dashboard = new Dashboard(document.getElementById('viewport')!, {
  newDocument: () => void Promise.resolve(chromeHost.perform({ kind: 'new' })).then(focusInput),
  open: (entry) => openSource(sourceOf(entry)),
  delete: deleteEverywhere,
  account: () => account,
  share: (id, name) => showShareDialog({ id, name }),
  openShared: (doc) => {
    sharedDocs.set(doc.id, doc);
    openSource(`shared:${doc.id}`);
  },
  signIn: () => signIn({ dashboard: true }),
  signOut,
  closed: focusInput,
});

// Signed out, documents live only in this browser: offer to clear them (for shared computers).
const sharedDeviceNotice = new SharedDeviceNotice(document.body, () => void clearLocalData());

// Other people's mouse pointers (see ui/pointerLayer.ts).
const pointerLayer = new PointerLayer(document.getElementById('viewport')!, { camera, page: (index) => pages[index] });

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

// Comments down the right of the editor; edits to them are ordinary (undoable) edits.
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
  accountKnown = accountLookup.then((user) => {
    account = user;
  });
  firstConnect = connect(accountLookup);
  // Joining a room without a document: the room has it.
  if (!doc && params.get('room')) open({ kind: 'blank', name: params.get('name') ?? t('app.blankDocumentName') });
  else if (doc) openSource(doc, true);
  // Nothing asked for: carry on with the document last open here (else the newest saved one);
  // someone with no documents yet is welcomed with what Golem Docs is.
  else {
    const early = earlySaved;
    void (async () => {
      if (early && (await early.saved)) return openSource(`local:${early.id}`, true);
      try {
        const saved = await listSaved();
        const last = lastDoc();
        const id = saved.some((d) => `local:${d.id}` === last) ? last : [...saved].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id;
        openSource(id ? (id.startsWith('local:') ? id : `local:${id}`) : 'welcome', true);
      } catch {
        openSource('welcome', true);
      }
    })();
  }
}
