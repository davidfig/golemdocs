import './style.css';
import warAndPeaceUrl from '../../scripts/war-and-peace.txt?url';
import type { MoveTarget } from '@golemdocs/editor';
import { deskColor, onThemeChange } from './ui/theme.ts';
import { FrameMonitor, debugFlags, onDebugFlagsChange } from './debug.ts';
import { currentUser, signOut as signOutOfCloud, type User } from './auth.ts';
import { createChromeHost } from './chromeHost.ts';
import { CloudError, deleteDocument, documentUrl, downloadDocument, listDocuments, listFolders, listShared, saveDocument, type CloudDocument } from './cloud.ts';
import { importFiles, readZipFiles } from './storage/zipImport.ts';
import { showProgress } from './ui/progressToast.ts';
import { adoptGuestFolders, createFolder } from './folderOps.ts';
import { openFromCloud, uploadToCloud } from './library.ts';
import {
  adoptGuestDocuments,
  releaseToGuest,
  clearAllSaved,
  deleteOwnedBy,
  deleteSaved,
  getSaved,
  getThumbnail,
  listLocalFolders,
  listSaved,
  markSynced,
  ownedBy,
  saveSaved,
  saveThumbnail,
  type SavedInfo,
} from './storage/local.ts';
import { folderOf, folderPath } from './folders.ts';
import { hasUnsentChanges, mergeLibrary, type LibraryEntry } from './sync.ts';
import { capturePageThumbnail, drawPages, pictureLayout, readPage } from './thumbnail.ts';
import { CommentsPanel } from './ui/commentsPanel.ts';
import { loadView, saveView, type SavedView } from './viewMemory.ts';
import { mnemonicLabel } from './ui/dom.ts';
import { FilesPanel } from './ui/filesPanel.ts';
import { PagesPanel } from './ui/pagesPanel.ts';
import { FormLayer } from './ui/formLayer.ts';
import { PdfEditTools } from './ui/pdfEditTools.ts';
import { PdfTextLayer } from './ui/pdfTextLayer.ts';
import { PointerLayer } from './ui/pointerLayer.ts';
import { showShareDialog } from './ui/shareDialog.ts';
import { showSignInDialog } from './ui/signIn.ts';
import { checkoutUrl, fetchSubscription, portalUrl, SubscriptionError, waitForSubscription, type Subscription } from './subscription.ts';
import { Dashboard } from './ui/dashboard.ts';
import { opensFromCloud } from './ui/dashboardFormat.ts';
import { showConfirm } from './ui/popup.ts';
import { SharedDeviceNotice } from './ui/sharedDeviceNotice.ts';
import { Assistant } from './assistant/index.ts';
import type { ToolResult } from './assistant/conversation.ts';
import { searchServer } from './assistant/api.ts';
import { OtherDocuments, type StoredDocument } from './assistant/libraryDocs.ts';
import { MAX_COPY } from './assistant/otherDocs.ts';
import { LoadingScreen } from './ui/loadingScreen.ts';
import { showToast } from './ui/toast.ts';
import { arrangePages, columnsToFill, nearestPage, type Bounds } from './document/arrange.ts';
import { LayoutClient } from './layout/layoutClient.ts';
import { FONT_BASE, type DocumentSource, type LayoutUpdate, type RoomOptions, type RoomState, type SelectionUpdate, type WireCommand, type WordStats } from './layout/protocol.ts';
import { ImageRenderer } from './webgl/shapes/imageRenderer.ts';
import { AtlasLibrary } from './webgl/text/gpuFace.ts';
import { Camera, CSS_PX_PER_POINT } from './view/camera.ts';
import { GpuPage } from './webgl/gpuPage.ts';
import { PageRenderer, type FrameStats } from './webgl/pageRenderer.ts';
import { getLocale, initLocale, t, type MessageKey } from './i18n/index.ts';
import { FindDialog } from './ui/findDialog.ts';
import { SpellDialog } from './ui/spellDialog.ts';
import { SpellMenu } from './ui/spellMenu.ts';
import { showColumnsDialog } from './ui/columnsDialog.ts';
import { showParagraphDialog } from './ui/paragraphDialog.ts';
import { showPageSetupDialog } from './ui/pageSetupDialog.ts';
import { readClipboard, showPasteSpecialDialog, type Clipboard } from './ui/pasteSpecialDialog.ts';
import { cleanDocumentName, displayDocumentName } from './documentName.ts';
import { PropertiesDialog } from './ui/propertiesDialog.ts';
import { WordCountDialog } from './ui/wordCountDialog.ts';
import { Footer } from './ui/footer.ts';
import { showSplitDialog, showTableDialog } from './ui/tableDialog.ts';
import { CropLayer } from './ui/cropLayer.ts';
import { DrawLayer, isDrawTool } from './ui/drawLayer.ts';
import { askDropChoice } from './ui/dropChoice.ts';
import { LargeTextView } from './largeText/view.ts';
import { showAdjustDialog, showResizeDialog } from './ui/pictureDialogs.ts';
import { applyImageEdit, type ImageEdit } from './formats/imageEdit.ts';
import type { ChromeState, ImageOp } from './ui/actions.ts';
import { opensLink, showLinkDialog } from './ui/linkDialog.ts';
import { SelectionLayer } from './webgl/selectionLayer.ts';
import { FORMAT_LIST, isFormat, type Format } from './formats/convert.ts';
import { isZipName, sourceFromFile, stem } from './formats/source.ts';
import { sniffImage } from './formats/images.ts';
import { hasExtension, toUtf8 } from './formats/textFiles.ts';
import { findByTitle, parseDocAddress } from './formats/wikiLinks.ts';
import { encodeCanvas, toPng } from './formats/imageCodec.ts';
import { MAX_PIXELS, MAX_SIDE } from './formats/imagePixels.ts';
import { FORMATS, PICTURE_KINDS, initTooltips, pointerTip, kindFromName, mountChrome, type DocumentKind, type DocumentSync, type FormatState, type FormMode, type SyncStatus, type ViewMode } from './ui/index.ts';

// Every string the UI builds goes through t(): the language has to be loaded first. Started here
// and awaited once the worker is running, so it doesn't hold up starting the worker.
// The static welcome text in index.html is for crawlers; the canvas is the page for everyone else.
document.getElementById('seo')?.setAttribute('aria-hidden', 'true');

initTooltips();
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
const atlases = new AtlasLibrary(gl, FONT_BASE, assetLoaded);
const selection = new SelectionLayer(gl);
// The document, layout and editing live in a worker; it streams pages here as GPU-ready
// buffers and answers input with page updates and selection geometry. This thread draws.
const worker = new LayoutClient((faces) => {
  for (const face of faces) atlases.define(face);
});
await localeReady;
worker.setLocale(getLocale());

// Formatting marks (¶): remembered in this browser, and told to the worker before any document opens.
const MARKS_KEY = 'word.formattingMarks';
let formattingMarks = false;
try {
  formattingMarks = localStorage.getItem(MARKS_KEY) === 'on';
} catch {
  // Storage unavailable: marks start off.
}
if (formattingMarks) worker.setMarks(true);

// The pages panel (View > Page Sidebar): remembered in this browser.
const PAGES_KEY = 'word.pagesPanel';
/** What the user chose (null: never chosen, so it is open when the window is wide enough for it and the page, closed on a phone). */
let pagesChoice: boolean | null = null;
try {
  const saved = localStorage.getItem(PAGES_KEY);
  pagesChoice = saved === 'on' ? true : saved === 'off' ? false : null;
} catch {
  // Storage unavailable: the panel follows the default.
}
const roomForPages = matchMedia('(min-width: 900px)');
const pagesOpen = (): boolean => pagesChoice ?? roomForPages.matches;

// The files sidebar (View > Files Sidebar): optional, so closed until chosen; remembered in this browser.
const FILES_KEY = 'word.filesPanel';
let filesOpen = false;
try {
  filesOpen = localStorage.getItem(FILES_KEY) === 'on';
} catch {
  // Storage unavailable: it starts closed.
}

// The status bar (View > Status Bar): off until chosen, then remembered in this browser.
const FOOTER_KEY = 'word.footer';
let footerOn = false;
try {
  footerOn = localStorage.getItem(FOOTER_KEY) === 'on';
} catch {
  // Storage unavailable: the bar starts off.
}

/** The counts of the whole document and of the selection, as the worker last gave them (null: none, or not asked for yet). */
let footerWords: WordStats | null = null;
let footerSelection: WordStats | null = null;
let footerTimer = 0;
/** The pixel size of the open picture, found once per opening (and which are being looked up). */
const pictureSizes = new WeakMap<object, { width: number; height: number }>();
const pictureSizing = new WeakSet<object>();

// View: Print layout (pages) or Normal (the text reflowed to the window). Remembered in this browser.
const VIEW_KEY = 'word.viewMode';
// With no saved choice, a phone-sized screen starts in Normal (a page shrunk to fit is unreadable there).
let viewMode: ViewMode = window.matchMedia('(max-width: 720px)').matches ? 'normal' : 'print';
try {
  const saved = localStorage.getItem(VIEW_KEY);
  if (saved === 'normal' || saved === 'print') viewMode = saved;
} catch {
  // Storage unavailable: use the default for this screen.
}

// The document to carry on with is read from this browser while the rest of the page is built.
const LAST_DOC_KEY = 'golemdocs.lastDoc';
function lastDoc(): string | null {
  try {
    return localStorage.getItem(LAST_DOC_KEY);
  } catch {
    return null;
  }
}
/** The built-in documents with an address of their own (the welcome text and changelog); the app is at `/` for everything else. (`/privacy` and `/terms` redirect to the plain pages under `/home`, see public/_redirects.) */
const PAGE_PATHS: Record<string, string> = { welcome: '/welcome', changelog: '/changelog' };
/** The document the address asks for: `?doc=…`, or a page's path. */
const wantedDoc = (params: URLSearchParams): string | null => params.get('doc') ?? Object.keys(PAGE_PATHS).find((id) => PAGE_PATHS[id] === location.pathname) ?? null;
/** Sets the address to `params` at the app's root, or at a page's path when it holds only that built-in document. */
function setUrl(params: URLSearchParams): void {
  const doc = params.get('doc');
  const path = doc ? PAGE_PATHS[doc] : undefined;
  if (path) params.delete('doc');
  history.replaceState(null, '', `${path ?? '/'}${params.size ? `?${params}` : ''}`);
}

let earlySaved: { id: string; saved: Promise<Awaited<ReturnType<typeof getSaved>>> } | null = null;
{
  const params = new URLSearchParams(location.search);
  const wanted = wantedDoc(params) ?? (params.get('room') ? null : lastDoc());
  if (wanted?.startsWith('local:')) earlySaved = { id: wanted.slice(6), saved: getSaved(wanted.slice(6)).catch(() => null) };
}

// Development convenience: the round-trip test corpus (pnpm --filter @golemdocs/docx corpus),
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
/** The source of the open document (`local:<id>`, ...), which its scroll position and zoom are remembered under. */
let viewDocKey: string | null = null;
/** The source the next open() is for, until that call takes it as `viewKey`. */
let wantedDocKey: string | null = null;
/** Where this browser last left the document being opened, applied as its pages arrive. */
let pendingView: SavedView | null = null;
/** `pendingView` was used to place the camera. */
let viewRestored = false;

/** The caret is in text that a click can put it back in (not a picture, a grid or a PDF's own pages). */
const textCaret = (): boolean => !grid && !annotating && !isPicture();

/** Remembers where the open document is scrolled to and its zoom, so opening it again returns there. */
function rememberView(): void {
  if (!viewDocKey || !loaded || !cameraPlaced) return;
  const view: SavedView = {};
  if (userMoved && !grid) view.camera = { x: camera.x, y: camera.y, zoom: camera.zoom, reflow: reflowing() };
  const caret = selection.caret;
  const page = caret ? pages.findIndex((p) => p.id === caret.page) : -1;
  if (caret && page >= 0 && textCaret()) view.caret = { page, x: caret.x, y: caret.y + caret.height / 2 };
  if (view.camera || view.caret) saveView(viewDocKey, view);
}

/**
 * The format a source is opened as (everything but PDF, Markdown and text is a Word document).
 * A .wdoc says for itself once the worker has read it; until then, its name's extension.
 */
function kindOfSource(source: DocumentSource): DocumentKind {
  if (source.kind === 'wdoc') {
    const kind = kindFromName(source.name);
    return isFormat(kind) ? kind : 'docx';
  }
  if (source.kind === 'image') return kindFromName(source.name, 'png');
  return source.kind === 'pdf' || source.kind === 'md' || source.kind === 'txt' || source.kind === 'odt' || source.kind === 'rtf' || source.kind === 'epub' || source.kind === 'csv' || source.kind === 'tex' || source.kind === 'adoc' || source.kind === 'rst' || source.kind === 'org' || source.kind === 'mediawiki' || source.kind === 'eml' || source.kind === 'ipynb' || source.kind === 'textile' || source.kind === 'typst' || source.kind === 'docbook' || source.kind === 'jats' || source.kind === 'fb2' || source.kind === 'opml' || source.kind === 'tsv' || source.kind === 'mhtml' || source.kind === 'html' ? source.kind : 'docx';
}

function setStatus(text: string): void {
  status = text;
  loadingScreen.update(text);
  requestRender();
}

/** A message the person needs to see (something failed or can't be done): the status, and a toast. */
function reportError(text: string): void {
  loadingScreen.hide();
  setStatus(text);
  showToast(text);
}

function open(source: DocumentSource, options: { grid?: boolean; localId?: string; cloudId?: string; shared?: CloudDocument; pictureEdit?: boolean; store?: boolean } = {}): void {
  const start = performance.now();
  let name = 'name' in source ? source.name : source.kind === 'welcome' ? t('app.welcomeName') : source.kind === 'legal' ? t(source.page === 'privacy' ? 'app.privacyName' : 'app.termsName') : source.kind === 'changelog' ? t('app.changelogName') : t('app.fontsName');
  let firstPage = 0;
  saveIfEdited(); // the worker is asked for the bytes now, before it switches documents
  rememberView();
  viewDocKey = wantedDocKey;
  wantedDocKey = null;
  pendingView = viewDocKey ? loadView(viewDocKey) : null;
  commandsAtOpen = commandsSent;
  viewRestored = false;
  cropLayer.cancel();
  largeView.close();
  drawLayer.cancel();
  // A picture that was changed comes back as the same document, so its undo history goes on; any other opening starts afresh.
  if (!options.pictureEdit) pictureHistory = { undo: [], redo: [] };
  current = {
    localId: options.localId ?? null,
    unsavedSince: 0,
    builtIn: source.kind === 'welcome' || source.kind === 'legal' || source.kind === 'changelog' || source.kind === 'fonts',
    room: null,
    roomRequested: false,
    shared: options.shared?.role === 'editor' || options.shared?.role === 'viewer' ? { id: options.shared.id, role: options.shared.role, dirty: false, uploading: false, error: null } : null,
  };
  const opening = current;
  showSync();
  for (const page of pagesById.values()) page.dispose(gl!);
  pagesById.clear();
  pages = [];
  pagesPanel.setPages(pages);
  selection.clear();
  commentsPanel.reset();
  comments = [];
  formLayer.update(null);
  pdfTextLayer.update(null);
  pdfTools.update(null, null);
  pointerLayer.update([]);
  formMode = 'fill';
  formLayer.setMode(formMode);
  pdfTools.setMode(formMode);
  selectionFormat = {};
  canUndo = canRedo = false;
  footerWords = footerSelection = null;
  window.clearTimeout(footerTimer);
  // One renderer for every document: clear() drops the old textures and any loads still under way.
  renderer.images?.clear();
  renderer.images ??= new ImageRenderer(gl!, { bytes: (part) => worker.media(part) }, assetLoaded);
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
  sharedDeviceNotice.update({ welcome: source.kind === 'welcome' || source.kind === 'legal' || source.kind === 'changelog' });
  setStatus(t('app.loading', { name }));

  const requestedRoom = roomOptions() ?? networkRoom(options.cloudId ?? options.shared?.id);
  current.roomRequested = requestedRoom !== undefined;
  worker.open(source, {
    opened(docName, format, fixedPages, outdated) {
      name = documentName = docName;
      documentKind = format;
      annotating = fixedPages;
      if (outdated) pendingNotice = outdatedPages();
      spellDialog.sendLive();
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
      loadingScreen.hide();
      arrange();
      if (pendingView) {
        // Streaming is over, so the restored position can be held to the real page bounds now.
        if (viewRestored) userMoved = true;
        const caret = pendingView.caret;
        const page = caret && textCaret() ? pages[caret.page] : undefined;
        // Not in a document with comments: a caret put back inside commented text would open that thread (even a resolved one).
        if (caret && page && commandsSent === commandsAtOpen && comments.length === 0) send({ kind: 'pointer', page: page.id, x: caret.x, y: caret.y });
        pendingView = null;
      }
      const glyphs = pages.reduce((n, p) => n + p.glyphCount, 0);
      loadTimes = { pages: count, glyphs, firstPage, total: performance.now() - start, read: times.read, fonts: times.fonts, body: times.body, headers: times.headers };
      setStatus(t('app.ready', { name }));
      if (pendingNotice) {
        setStatus(pendingNotice);
        pendingNotice = null;
      }
      if (current.localId) backfillThumbnail(current.localId);
      // A file the person added is kept in the document store as soon as it is open, edited or not.
      else if (options.store && opening === current) documentEdited();
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
      reportError(t('app.documentError', { name, message }));
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

/**
 * Puts the document, as it is now, in a room (unless it is in one), and gives the link that lets
 * others join it. Throws, with a message to show, when it can't.
 */
async function enterRoom(): Promise<string> {
  const params = new URLSearchParams(location.search);
  if (documentKind !== 'docx') throw new Error(t('app.collabNeedsWord'));
  if (!params.get('room')) {
    let bytes: Uint8Array;
    try {
      bytes = await worker.convert('docx');
    } catch (e) {
      throw new Error(t('app.collabFailed', { message: (e as Error).message }));
    }
    // Others join with just the room: its first member's copy is the document.
    const name = documentName.replace(/\.(docx|docm|dotx|txt)$/i, '') + '.docx';
    setUrl(new URLSearchParams({ room: Math.random().toString(36).slice(2, 8), name }));
    open({ kind: 'docx', name, bytes: bytes.slice().buffer });
  }
  return location.href;
}
window.addEventListener('pagehide', () => {
  rememberView();
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
  pagesPanel.setPages(pages);
  arrange();
}

/** Positions pages; places the camera the first time, and keeps a grid fitted while it grows. */
function arrange(): void {
  const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  const gap = reflowing() ? 0 : PAGE_GAP;
  bounds = arrangePages(pages, grid ? columnsToFill(pages, aspect, gap) : 1, gap);
  if (pages.length && (!cameraPlaced || (grid && !userMoved))) placeCamera();
  requestRender();
}

/** Normal view is on, and applies to this document (not a PDF's own pages, a picture or the page grid). */
function reflowing(): boolean {
  return viewMode === 'normal' && !annotating && !isPicture() && !grid;
}

/** Normal view: the width in points the text should fill at the current zoom. */
function reflowTarget(): number | null {
  return reflowing() ? Math.round(canvas.clientWidth / (camera.zoom * CSS_PX_PER_POINT)) : null;
}

let reflowSent: number | null = null;
let reflowTimer = 0;

/** Tells the worker the width to lay out at when it has changed (a resize or zoom), once things settle. */
function syncReflow(immediate = false): void {
  const target = reflowTarget();
  if (target === reflowSent) return;
  const send = (): void => {
    reflowSent = reflowTarget();
    worker.setReflow(reflowSent);
  };
  clearTimeout(reflowTimer);
  if (immediate || target === null) send();
  else reflowTimer = window.setTimeout(send, 150);
}

/** Word's page view (not reflowed text, a grid or a picture). */
const wordView = (): boolean => !reflowing() && !grid && !PICTURE_KINDS.includes(documentKind);

/** Gray kept beside a page that was zoomed to fit the screen's width. */
const PAGE_FIT_MARGIN_PX = 16;

function placeCamera(): void {
  cameraPlaced = true;
  const saved = pendingView?.camera;
  if (saved && saved.reflow === reflowing() && !grid) {
    camera.zoom = Math.min(Math.max(saved.zoom, camera.minZoom), camera.maxZoom);
    camera.x = saved.x;
    camera.y = saved.y;
    viewRestored = true;
    return;
  }
  if (reflowing()) {
    // Normal view: the text fills the window from the top, at the zoom the user has.
    camera.x = bounds.x;
    camera.y = bounds.y;
  } else if (grid) {
    camera.fit(bounds, canvas.clientWidth, canvas.clientHeight);
  } else if (PICTURE_KINDS.includes(documentKind)) {
    // A picture: the whole page in view.
    camera.fit(bounds, canvas.clientWidth, canvas.clientHeight, 32);
  } else {
    // Word's view: first page at 100%, centered, with a little gray above it. On a screen narrower
    // than the page, zoomed out until the page's width fits.
    camera.zoom = Math.min(1, Math.max(0.1, (canvas.clientWidth - PAGE_FIT_MARGIN_PX) / (bounds.width * CSS_PX_PER_POINT)));
    const pointsPerCss = 1 / (camera.zoom * CSS_PX_PER_POINT);
    camera.x = bounds.x + bounds.width / 2 - (canvas.clientWidth / 2) * pointsPerCss;
    camera.y = bounds.y - 24 * pointsPerCss;
  }
}

const loadingScreen = new LoadingScreen(document.getElementById('viewport')!);

/** Covers the editor (and the dashboard) with the loading screen until the document is open. */
function showLoading(name: string): void {
  loadingScreen.show(name);
  dashboard.hide();
}

function openFile(file: File): void {
  setUrl(new URLSearchParams());
  chromeHost.openFile(file);
}

/** Opens a document by name; `keepRoom` keeps the URL's collaboration room (else it's left). */
function openSource(source: string, keepRoom = false): void {
  wantedDocKey = source;
  const params = new URLSearchParams(location.search);
  params.set('doc', source);
  if (!keepRoom) params.delete('room');
  setUrl(params);
  if (source === 'war-and-peace') {
    open({ kind: 'text-url', name: t('app.warAndPeaceName'), url: warAndPeaceUrl });
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
  } else if (source === 'privacy' || source === 'terms') {
    open({ kind: 'legal', page: source });
  } else if (source === 'changelog') {
    open({ kind: 'changelog' });
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
  /** The welcome, legal or fonts document: only worth saving once the user has changed it. */
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
  chrome.accountChanged();
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
  rememberView();
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
let signedIn: User | null = null;
/**
 * The signed-in user whose documents live in the cloud: `signedIn`, when they have sync. Without it
 * (no subscription) they are saved in this browser, as for someone signed out.
 */
let account: User | null = null;
/** Whose cloud documents the screens last drew: when it changes, the dashboard draws again. */
let drawnFor: string | null = null;
/** This browser's copies of the documents in view: the account's, or signed out, the browser's own. */
let savedDocs: SavedInfo[] = [];
/** The account's documents, as last listed (empty signed out or offline). */
let cloudDocs: CloudDocument[] = [];

/** The first `connect()`, on load: opening a document in the account waits for it, to know who is signed in. */
let firstConnect: Promise<void> = Promise.resolve();
/** Who is signed in is known: enough to decide whether a document joins its room. */
let accountKnown: Promise<void> = Promise.resolve();

/**
 * Finds out who is signed in and gets going: signed in, any documents made here while signed out
 * join the account, and whatever the account doesn't have yet is sent. Run on load and whenever
 * the connection comes back.
 */
async function connect(lookup: Promise<User | null> = currentUser()): Promise<void> {
  signedIn = await lookup;
  const plan = signedIn ? await fetchSubscription() : null;
  applyPlan(plan);
  // An unknown plan (offline) or a server that doesn't say leaves sync on; the server refuses what isn't allowed.
  account = signedIn && plan?.sync !== false ? signedIn : null;
  // Signed in but no sync (never subscribed, or it ended): what they made here stays in view as this browser's own.
  if (signedIn && !account) await releaseToGuest(signedIn.id).catch(() => {});
  sharedDeviceNotice.update({ signedIn: signedIn !== null });
  assistant.update({ signedIn: signedIn !== null });
  if (account) {
    // Folders made before signing in go to the account first, so the documents in them can be filed there.
    await adoptGuestFolders().catch(() => {});
    const adopted = await adoptGuestDocuments(account.id).catch(() => []);
    if (adopted.length) notify(t('app.adopted', { count: adopted.length }));
  }
  await refreshLibrary();
  if (account) {
    for (const info of savedDocs) if (hasUnsentChanges(info)) dirty.add(info.id);
    void flushUploads();
  }
  if ((account?.id ?? null) !== drawnFor) dashboard.refreshIfVisible();
  drawnFor = account?.id ?? null;
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
  filesPanel.refreshSoon();
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
  if (!account) {
    const info = savedDocs.find((d) => d.id === current.localId);
    const local = { error: null, savedAt: info?.updatedAt ?? null, localSaved: current.unsavedSince === 0 && info !== undefined };
    return signedIn ? { user: signedIn.email ?? signedIn.name ?? null, picture: signedIn.picture, document: 'unsubscribed', ...local } : { user: null, document: 'guest', ...local };
  }
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
    return { user, picture: account.picture, document: state, error: state === 'failed' ? shared.error : null };
  }
  if (id && failures.has(id)) document = 'failed';
  else if (current.room?.mode === 'shared') document = current.room.unconfirmed ? 'saving' : 'saved';
  else if (!unsent) document = 'saved';
  else if (signedOutRemotely) document = 'signedOut';
  else if (offline) document = 'offline';
  else document = 'saving';
  const savedAt = document === 'saved' ? (info?.cloudSyncedAt ?? null) : null;
  return { user, document, error: document === 'failed' ? failures.get(id!)! : null, savedAt };
}

function showSync(): void {
  filesPanel.mark();
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
    } else if (e instanceof CloudError && e.status === 402) {
      // No subscription (it ended, or this page hadn't heard): carry on as someone without sync.
      void connect(Promise.resolve(signedIn));
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
  setUrl(params);
  viewDocKey ??= doc; // a new document, saved for the first time
  if (doc.startsWith('local:')) {
    try {
      localStorage.setItem(LAST_DOC_KEY, doc);
    } catch {}
  }
}

/** Whether the open document can be renamed: not one of the built-in pages, nor one shared by someone else. */
const NO_PEOPLE: ChromeState['people'] = [];
const renamable = () => !current.builtIn && !current.shared;

/** Gives the open document a new name (cleaned for a file name) and saves it under that name. Returns the name kept, or null. */
function renameDocument(input: string): string | null {
  const name = cleanDocumentName(input);
  if (!name || !renamable()) return null;
  if (name === documentName) return name;
  documentName = name;
  chrome.update({ documentName });
  documentEdited(); // saved under the new name, which goes on to the account too
  return documentName;
}

/** The name a download or save gets: the format's extension, except that a text file keeps the one it came with ("config.json", "main.py"). */
const fileName = () => (documentKind === 'txt' && hasExtension(documentName) ? documentName : stem(documentName) + FORMATS[documentKind].extensions[0]);
const returnTo = (params: Record<string, string>) => `${location.pathname}?${new URLSearchParams(params)}`;

/** File ▸ Download All: every document saved in this browser (or the account's copies), as one ZIP. */
async function downloadAll(): Promise<void> {
  try {
    const docs = (await Promise.all(savedDocs.map((d) => getSaved(d.id)))).filter((d) => d !== null);
    if (docs.length === 0) return setStatus(t('app.downloadAllNone'));
    // Folder ids are unique, so the account's folders and this browser's can be looked up together.
    const folders = [...(account ? await listFolders().catch(() => []) : []), ...(await listLocalFolders().catch(() => []))];
    const placed = new Map(mergeLibrary(savedDocs, account ? cloudDocs : null).filter((e) => e.local).map((e) => [e.local!.id, e.folderId]));
    const { zipDocuments } = await import('./storage/archive.ts');
    const bytes = await zipDocuments(
      docs.map((d) => ({
        name: d.info.name,
        bytes: d.bytes,
        folders: folderPath(folders, folderOf({ local: { folderId: placed.get(d.info.id) ?? null } }, folders)).map((f) => f.name),
      })),
    );
    const name = t('app.downloadAllName');
    const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' }));
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(t('app.downloadedAll', { count: docs.length }));
  } catch (e) {
    reportError(t('app.downloadFailed', { message: (e as Error).message }));
  }
}

/**
 * File ▸ Import of a ZIP: its documents go in the folders they were in (made as needed, or the ones
 * here with the same names), and keep to their own names, with " (2)" and so on where one is taken.
 * From the dashboard, the ZIP's top level goes in the folder being looked at.
 */
async function importZip(file: File): Promise<void> {
  const root = newDocumentFolder;
  newDocumentFolder = null;
  const progress = showProgress(t('app.importingZip', { name: file.name }));
  // Reading the ZIP is the first 30% of the bar, saving what is in it the rest.
  const READ_SHARE = 30;
  try {
    setStatus(t('app.importingZip', { name: file.name }));
    const { files, skipped } = await readZipFiles(new Uint8Array(await file.arrayBuffer()), {
      signal: progress.signal,
      onProgress: (done, total) => progress.update((done / total) * READ_SHARE, 100, t('app.importProgress', { done, total })),
    });
    if (!files.length) return setStatus(t('app.importZipNone', { name: file.name }));
    const cloud = account !== null;
    // Not guessed from nothing: a folder list that can't be read would make every folder a duplicate.
    const folders = cloud ? await listFolders() : await listLocalFolders();
    const owner = account?.id;
    const result = await importFiles(files, {
      folders,
      documents: mergeLibrary(savedDocs, cloud ? cloudDocs : null).map((e) => ({ name: e.name, folderId: folderOf({ local: { folderId: e.folderId } }, folders) })),
      root: root !== null && folders.some((f) => f.id === root) ? root : null,
      signal: progress.signal,
      onProgress: (done, total) => progress.update(READ_SHARE + (done / total) * (100 - READ_SHARE), 100, t('app.importProgress', { done, total })),
      makeFolder: (name, parentId) => createFolder(cloud, name, parentId),
      async save(name, bytes, folderId) {
        let doc = { name, bytes };
        if (sourceFromFile(name, new ArrayBuffer(0))?.kind === 'image') {
          // GIF, BMP and SVG are kept as the PNG they open as.
          try {
            const picture = await toPng(name, bytes);
            doc = { name: picture.name, bytes: picture.bytes };
          } catch {
            return false;
          }
        }
        const info = await saveSaved({ name: doc.name, bytes: doc.bytes, owner, ...(folderId !== null && { folderId }) });
        if (owner) scheduleUpload(info.id);
        return true;
      },
    });
    await refreshLibrary();
    dashboard.refreshIfVisible();
    const left = skipped + result.skipped;
    if (result.cancelled) return setStatus(t('app.importCancelled', { count: result.imported }));
    setStatus(left ? t('app.importedZipSkipped', { count: result.imported, skipped: left }) : t('app.importedZip', { count: result.imported }));
  } catch (e) {
    if (progress.signal.aborted) return setStatus(t('app.importCancelled', { count: 0 }));
    reportError(t('app.importZipFailed', { message: (e as Error).message }));
  } finally {
    progress.close();
  }
}

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
      const folderId = created ? (newDocumentFolder ?? undefined) : undefined;
      const info = await saveSaved({ id: doc.localId ?? undefined, name, bytes: await bytes, owner, folderId });
      if (created) newDocumentFolder = null;
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
      if (doc === current) reportError(t('app.saveFailed', { message: (e as Error).message }));
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

/** Whether the signed-in user pays for sync (null: signed out, or it couldn't be asked). */
let subscription: 'none' | 'active' | null = null;

function applyPlan(plan: Subscription | null): void {
  subscription = plan ? (plan.active ? 'active' : 'none') : null;
  chrome.update({ subscription });
}

async function refreshSubscription(): Promise<void> {
  applyPlan(signedIn ? await fetchSubscription() : null);
}

/** Takes the user to a Polar page (checkout or portal). Leaving the page, so the document is kept first. */
async function goToPolar(address: () => Promise<string>, failed: 'app.subscribeFailed' | 'app.portalFailed'): Promise<void> {
  let url: string;
  try {
    url = await address();
  } catch (e) {
    if (e instanceof SubscriptionError && e.status === 409) return void (await refreshSubscription()); // already subscribed: the menus now offer to manage it
    reportError(t(failed, { message: (e as Error).message }));
    return;
  }
  await saveNow();
  location.assign(url);
}

/** Subscribe…: to Polar's checkout. Signed out, they sign in first and come back to go on. */
async function subscribe(): Promise<void> {
  if (!signedIn) {
    const id = await saveNow();
    showSignInDialog(returnTo(id ? { doc: `local:${id}`, subscribe: '1' } : { subscribe: '1' }), { subscribe: true });
    return;
  }
  if (subscription === 'active') return manageSubscription();
  await goToPolar(checkoutUrl, 'app.subscribeFailed');
}

/** Manage Subscription…: Polar's customer portal. */
async function manageSubscription(): Promise<void> {
  if (!signedIn) return signIn();
  await goToPolar(portalUrl, 'app.portalFailed');
}

/** Back from paying: Polar tells the server a moment later, so wait for it to show. */
async function afterCheckout(): Promise<void> {
  const paid = await waitForSubscription();
  await connect(Promise.resolve(signedIn)); // sync starts: their browser's documents move into the account
  showToast(paid ? t('app.subscribed') : t('app.subscribePending'));
}

/**
 * Signs out, and removes the account's documents from this browser (they're in the account). If
 * some changes haven't reached the account yet, it says so first, since signing out loses them.
 */
async function signOut(): Promise<void> {
  const user = signedIn;
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
    reportError(e instanceof TypeError ? t('app.signOutOffline') : t('app.signOutFailed', { message: (e as Error).message }));
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

/** The folder (chosen on the dashboard) the document being started goes in once it is first saved. */
let newDocumentFolder: string | null = null;

/** Deletes a document (from the dashboard): from the account, and this browser's copy. */
async function deleteEverywhere(entry: LibraryEntry): Promise<void> {
  if (entry.local && entry.local.id === current.localId) {
    // The open document: its next autosave (or one under way) would write it back, and upload it
    // again as a new cloud document. It stays open, and is only saved again if it is changed.
    clearTimeout(autosaveTimer);
    await saving;
    current.localId = null;
    current.unsavedSince = 0;
    current.builtIn = true;
  }
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
    reportError(t('app.clearFailed', { message: (e as Error).message }));
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
    else reportError(t('app.openSharedFailed', { message: (e as Error).message }));
  }
}

/** File ▸ Share: a link that lets anyone edit the open document with you, and the people it is shared with. */
function share(): void {
  const inRoom = new URLSearchParams(location.search).has('room');
  const room = documentKind !== 'docx' ? { unavailable: t('app.collabNeedsWord') } : inRoom ? { link: location.href } : { create: enterRoom };
  const info = savedDocs.find((d) => d.id === current.localId);
  const people = !account
    ? { unavailable: signedIn ? t('app.subscribeToShare') : t('app.signInToShare') }
    : current.shared
      ? { unavailable: t('app.ownerOnlyShare') }
      : !info
        ? { unavailable: t('app.notSavedYet') } // e.g. the welcome document, until it is edited
        : !info.cloudId
          ? { unavailable: t('app.notInAccountYet') }
          : { id: info.cloudId };
  showShareDialog({ name: info?.name ?? documentName, room, people });
}

async function openCloud(id: string): Promise<void> {
  try {
    if (!cloudDocs.some((d) => d.id === id)) await refreshLibrary(); // only for an address opened before the list arrived
    const cloud = cloudDocs.find((d) => d.id === id);
    const name = cloud?.name ?? t('app.cloudDocumentName');
    setStatus(t('app.opening', { name }));
    // A copy here with changes not uploaded yet opens as it is; uploading it sorts out the rest.
    const { info, bytes } = await openFromCloud({ id, name, updatedAt: cloud?.updatedAt }, account?.id);
    open(sourceFromFile(info.name, bytes) ?? { kind: 'docx', name: info.name, bytes }, { localId: info.id, cloudId: info.cloudId });
    rememberInUrl(`local:${info.id}`);
    // Only the lists need the new browser copy, so they catch up after the document is on screen.
    window.setTimeout(() => void refreshLibrary(), 1000);
  } catch (e) {
    if (e instanceof CloudError && e.status === 401) showSignInDialog(returnTo({ doc: `cloud:${id}` }));
    else reportError(t('app.openFailed', { message: (e as Error).message }));
  }
}

/** Downloads a copy of the document as a file of the format it is edited as (an export: only what that format holds). */
async function download(): Promise<void> {
  try {
    // The large-text viewer holds the file as it was, and gives it back as it was.
    const large = largeView.active ? largeView.bytes : null;
    const bytes = large ?? (await worker.convert(documentKind as Format));
    const name = large ? largeView.fileName : fileName();
    const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: large ? 'text/plain' : FORMATS[documentKind].mime }));
    const link = Object.assign(document.createElement('a'), { href: url, download: name });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(t('app.downloaded', { name }));
  } catch (e) {
    reportError(t('app.downloadFailed', { message: (e as Error).message }));
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
    if (!window.open(url, '_blank')) reportError(t('app.allowPopups'));
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
  if (to === 'jpeg' || to === 'webp') return t('app.switchedPictureLossy', params);
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
  if (PICTURE_KINDS.includes(to) && !PICTURE_KINDS.includes(from)) return convertToPicture(to as 'png' | 'jpeg' | 'webp');
  if (!isFormat(to) || !isFormat(from)) throw new Error(t('app.unsupportedFormat', { label: FORMATS[isFormat(to) ? from : to].label }));
  if (new URLSearchParams(location.search).get('room')) {
    reportError(t('app.leaveRoomToSwitch'));
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
  setUrl(new URLSearchParams());
  open(source, { grid, localId: info.id });
  rememberInUrl(`local:${info.id}`);
  chrome.update({ documentName, kind: documentKind });
  pendingNotice = switchedNotice(to);
  void refreshLibrary();
  if (account) scheduleUpload(info.id, 0);
}

/**
 * Convert To a picture format from a document: the pages as they are laid out, one under another, become a picture,
 * saved and opened as a document of its own. The document stays as it is (a picture can't be switched back to text).
 */
async function convertToPicture(to: 'png' | 'jpeg' | 'webp'): Promise<void> {
  if (!gl || !loaded || !pages.length) return reportError(t('app.notReadyToConvert'));
  setStatus(t('app.switching', { label: FORMATS[to].label }));
  try {
    const layout = pictureLayout(pages.map((p) => ({ width: p.width, height: p.height })), { side: MAX_SIDE, pixels: MAX_PIXELS });
    const canvas = drawPages(gl, renderer, pages, layout);
    if (!canvas) throw new Error(t('app.imageTooBig'));
    const bytes = await encodeCanvas(canvas, to);
    const name = stem(documentName) + FORMATS[to].extensions[0];
    open({ kind: 'image', name, bytes: bytes.slice().buffer });
    documentEdited(); // saved, so it is there in the library next to the document it was made from
    pendingNotice = layout.count < pages.length ? t('app.pictureShortened', { name, count: layout.count }) : t('app.convertedToPicture', { name });
  } catch (e) {
    reportError(t('picture.editFailed', { message: (e as Error).message }));
  }
}

// --- Pictures ------------------------------------------------------------------------------
// A picture opens as a document that is one page showing it (see formats/imageDoc.ts). The picture
// tools change its pixels and open the result in place of it: the same saved document, the same
// name. Undo and redo keep the earlier pictures, since the editor's own history is of text.

const PICTURE_HISTORY = 12;
let pictureHistory: { undo: Uint8Array[]; redo: Uint8Array[] } = { undo: [], redo: [] };
const isPicture = (): boolean => PICTURE_KINDS.includes(documentKind);

/** The open picture as a file, of the type it is edited as. */
const pictureBytes = (): Promise<Uint8Array> => worker.convert(documentKind as Format);

/** Opens a picture in place of the open one, and saves it soon. */
function showPicture(bytes: Uint8Array): void {
  open({ kind: 'image', name: documentName, bytes: bytes.slice().buffer }, { grid, localId: current.localId ?? undefined, pictureEdit: true });
  documentEdited();
}

async function changePicture(edit: ImageEdit): Promise<void> {
  const doc = current;
  try {
    const before = await pictureBytes();
    const after = await applyImageEdit(before, edit);
    if (doc !== current) return; // another document was opened meanwhile
    pictureHistory.undo.push(before);
    if (pictureHistory.undo.length > PICTURE_HISTORY) pictureHistory.undo.shift();
    pictureHistory.redo = [];
    showPicture(after.bytes);
  } catch (e) {
    reportError(t('picture.editFailed', { message: (e as Error).message }));
  }
}

async function stepPicture(direction: 'undo' | 'redo'): Promise<void> {
  const from = direction === 'undo' ? pictureHistory.undo : pictureHistory.redo;
  const to = direction === 'undo' ? pictureHistory.redo : pictureHistory.undo;
  const target = from.pop();
  if (!target) return;
  const doc = current;
  try {
    const now = await pictureBytes();
    if (doc !== current) {
      from.push(target);
      return;
    }
    to.push(now);
    showPicture(target);
  } catch (e) {
    from.push(target);
    reportError(t('picture.editFailed', { message: (e as Error).message }));
  }
}

/** What the Draw tools draw with; the colour is CSS, the size a step from thin (0) to extra thick (3). */
const drawStyle = { color: '#e5322d', size: 1, fill: false };
/** The last drawing being put into the picture, for what comes next to wait on. */
let drawing: Promise<void> = Promise.resolve();

async function pictureAction(op: ImageOp): Promise<void> {
  if (!isPicture()) return;
  if (isDrawTool(op)) {
    cropLayer.cancel();
    if (drawLayer.active) return drawLayer.setTool(op);
    const doc = current;
    try {
      const size = sniffImage(await pictureBytes());
      if (!size || doc !== current) return;
      drawLayer.start(size.width, size.height, op, (shapes) => {
        if (shapes) drawing = changePicture({ op: 'draw', shapes });
        focusInput();
      });
    } catch (e) {
      reportError(t('picture.editFailed', { message: (e as Error).message }));
    }
    return;
  }
  // Any other tool takes the picture as drawn so far.
  drawLayer.apply();
  await drawing;
  const page = pages[0];
  if (op === 'rotateLeft') return changePicture({ op: 'rotate', turns: 3 });
  if (op === 'rotateRight') return changePicture({ op: 'rotate', turns: 1 });
  if (op === 'rotate180') return changePicture({ op: 'rotate', turns: 2 });
  if (op === 'grayscale' || op === 'sepia' || op === 'invert' || op === 'blur' || op === 'sharpen' || op === 'autoLevels') return changePicture({ op: 'effect', effect: op });
  if (op === 'flipHorizontal') return changePicture({ op: 'flip', axis: 'horizontal' });
  if (op === 'flipVertical') return changePicture({ op: 'flip', axis: 'vertical' });
  const doc = current;
  try {
    const bytes = await pictureBytes();
    const size = sniffImage(bytes);
    if (!size || doc !== current) return;
    if (op === 'crop') {
      if (!page) return;
      cropLayer.start(size.width, size.height, (box) => {
        if (box) void changePicture({ op: 'crop', ...box });
        focusInput();
      });
      return;
    }
    if (op === 'resize') {
      const to = await showResizeDialog(size.width, size.height);
      if (to && (to.width !== size.width || to.height !== size.height)) await changePicture({ op: 'resize', ...to });
    } else {
      const adjustments = await showAdjustDialog(bytes);
      if (adjustments) await changePicture({ op: 'adjust', ...adjustments });
    }
    focusInput();
  } catch (e) {
    reportError(t('picture.editFailed', { message: (e as Error).message }));
  }
}

// --- Text too big to be a document ---------------------------------------------------------------
// A file of many megabytes would need gigabytes as paragraphs (docs/large-text-files.md), so it opens in a
// viewer over the page instead: the file stays bytes, and only the lines in view are drawn. An empty document
// is opened under it (with the file's name) so that the rest of the app has something to stand on.

function openLarge(name: string, bytes: Uint8Array): void {
  open({ kind: 'blank', name });
  largeView.open(name, toUtf8(bytes));
  documentName = name;
  pendingNotice = t('largeText.notice', { name, size: `${(bytes.length / (1 << 20)).toFixed(bytes.length < 10 << 20 ? 1 : 0)} MB` });
  focusInput();
}

// --- Links to other documents ----------------------------------------------------------------
// A link to `doc:Title` (what [[Title]] is in wiki markup) opens the stored document of that title,
// this browser's copy or the account's. With none, it offers to make one, in the format of the
// document the link is in when that is text (so a wiki links to more wiki pages).

/** The formats a new, empty document can be made in from nothing: the text ones. */
const EMPTY_TEXT = new Set<DocumentKind>(['md', 'txt', 'mediawiki', 'textile', 'tex', 'typst', 'adoc', 'rst', 'org', 'html']);

async function openDocumentLink(title: string): Promise<void> {
  await saving;
  const found = findByTitle(title, mergeLibrary(savedDocs, account ? cloudDocs : null));
  if (found) return openSource(sourceOf(found));
  if (!window.confirm(t('app.createLinkedDocument', { title }))) return;
  const extension = FORMATS[documentKind].extensions[0] ?? '.docx';
  const text = EMPTY_TEXT.has(documentKind) ? sourceFromFile(`${title}${extension}`, new ArrayBuffer(0)) : null;
  open(text ?? { kind: 'blank', name: `${title}.docx` });
  // Saved at once, so that the link finds it next time.
  documentEdited();
}

// --- Putting a picture in a document ---------------------------------------------------------
// A picture file can be opened (as a picture, to change with the picture tools) or put in the open
// document. Insert ▸ Picture inserts; dropping one on a document asks which was meant.

const PICTURE_FILE = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;
const isPictureFile = (file: File): boolean => PICTURE_FILE.test(file.name) || (file.type.startsWith('image/') && file.type !== 'image/tiff');

/** Whether a picture can go into the open document now. */
const canInsertPicture = (): boolean => loaded && !isPicture() && !annotating && !dashboard.visible && FORMATS[documentKind].images;

async function dropped(file: File, x: number, y: number): Promise<void> {
  if (isPictureFile(file) && canInsertPicture()) {
    const choice = await askDropChoice(file.name, x, y);
    if (choice === undefined) return focusInput();
    if (choice === 'insert') return insertPicture(file, { x, y });
  }
  if (isZipName(file.name)) return void importZip(file);
  openFile(file);
}

/** Puts a picture file in the document, at `at` (a point on the screen) or else the caret. */
async function insertPicture(file: File, at?: { x: number; y: number }): Promise<void> {
  if (new URLSearchParams(location.search).get('room')) return reportError(t('picture.notInRoom'));
  try {
    let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
    let name = file.name;
    // SVG is drawn to a PNG (the document holds pictures, not drawings); the other types go in as they are.
    if (!sniffImage(bytes)) ({ bytes, name } = await toPng(name, bytes));
    const image = sniffImage(bytes);
    if (!image) throw new Error(t('app.notImage'));
    if (at) {
      const rect = canvas.getBoundingClientRect();
      const hit = pageAt(at.x - rect.left, at.y - rect.top);
      if (hit) send({ kind: 'pointer', page: hit.page.id, x: hit.x, y: hit.y });
    }
    // At 96 dpi, in EMUs; the document trims it to the page.
    worker.insertImage(bytes, image.type, Math.max(image.width, 1) * 9525, Math.max(image.height, 1) * 9525, name.replace(/\.[^.]*$/, ''));
    focusInput();
  } catch (e) {
    reportError(t('picture.insertFailed', { message: (e as Error).message }));
  }
}

/** Insert ▸ Picture: choose a file, then put it in the document. */
function pickPicture(): void {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/svg+xml' });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) void insertPicture(file);
  });
  input.click();
}

// --- Selection and caret ---------------------------------------------------------------

let caretOn = true;
/** Formatting at the selection (from the worker), for the toolbar. */
let selectionFormat: FormatState = {};
/** The Format Painter is waiting for a selection to paint. */
let painting = false;
/** The selection is in a table cell. */
let inTable = false;
/** The columns of the section the selection is in. */
let sectionColumns: SelectionUpdate['columns'];
/** The page setup of the section the selection is in. */
let sectionPage: SelectionUpdate['page'];
/** The link the selection is in. */
let link: SelectionUpdate['link'] = null;
/** The equation the selection is. */
let math: SelectionUpdate['math'] = null;
/** The last click was a double click: change the equation it lands on, once the selection says which. */
let editMathUntil = 0;
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
  commentsPanel.update(update.comments, update.activeComment);
  selectionFormat = update.format;
  comments = update.comments.filter((c) => !c.parentId);
  painting = update.painting ?? false;
  inTable = update.inTable ?? false;
  sectionColumns = update.columns;
  sectionPage = update.page;
  link = update.link ?? null;
  math = update.math ?? null;
  if (editMathUntil > performance.now()) {
    editMathUntil = 0;
    if (math) chromeHost.perform({ kind: 'insertMath' });
  }
  if (followLinkUntil > performance.now()) {
    followLinkUntil = 0;
    const page = link && Object.keys(PAGE_PATHS).find((id) => PAGE_PATHS[id] === link!.url);
    if (page) openSource(page);
    else if (link && opensLink(link.url)) window.open(link.url, '_blank', 'noopener,noreferrer');
    else if (link && parseDocAddress(link.url)) void openDocumentLink(parseDocAddress(link.url)!.title);
  }
  updateCursor();
  if (update.search) findDialog.report(update.search);
  if (update.spell?.menu) {
    if (update.spell.issue && spellMenuAt) spellMenu.show(update.spell.issue, spellMenuAt.x, spellMenuAt.y);
    spellMenuAt = null;
  } else if (update.spell) spellDialog.report(update.spell);
  if (update.stats !== undefined) {
    wordCountDialog.report(update.stats);
    propertiesDialog.reportStats(update.stats);
  }
  if (update.docProperties) propertiesDialog.reportProperties(update.docProperties);
  if (update.footerStats !== undefined) {
    if (update.footerStats?.selection) footerSelection = update.footerStats;
    else footerWords = update.footerStats;
    requestRender();
  } else if (footerOn) refreshFooterSoon();
  formLayer.update(update.fields ?? null);
  pdfTextLayer.update(update.pdfText ?? null);
  pdfTools.update(update.pdfText ?? null, update.pdfObject ?? null);
  if (update.pdfNotice) showToast(t('chrome.pdfEdit.partialRedaction'));
  if (update.pdfFontNotice) showToast(t('chrome.pdfEdit.fontSubstituted', { fonts: update.pdfFontNotice.join(', ') }));
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
const ANNOTATION_EDITS = new Set<WireCommand['kind']>(['annotate', 'delete', 'undo', 'redo', 'setFields', 'pdfText', 'pdfStyle', 'pdfMoveText', 'pdfMove', 'pdfShape', 'pdfAddShape', 'pdfAddImage', 'pdfAddText', 'pdfPageOp']);

/** Commands sent so far: the saved caret is only put back if the user has sent none since the document opened. */
let commandsSent = 0;
/** `commandsSent` when the document being opened was asked for. */
let commandsAtOpen = 0;

function send(command: WireCommand): void {
  commandsSent++;
  if (command.kind !== 'move' && command.kind !== 'pointer' && command.kind !== 'selectAll' && command.kind !== 'find' && command.kind !== 'spellNext' && command.kind !== 'spellWords' && command.kind !== 'spellCheck' && command.kind !== 'spellAt' && command.kind !== 'countWords' && command.kind !== 'getProperties') {
    editSent = performance.now();
    if (FORMATS[documentKind].editable || (annotating && ANNOTATION_EDITS.has(command.kind))) documentEdited();
  }
  worker.command(command);
}

function focusInput(): void {
  if (largeView.active) return largeView.focus();
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
    const times = loadTimes;
    panels.splice(
      flags.status ? 1 : 0,
      0,
      debugPanel('Load', [
        ['first page', ms(times.firstPage)],
        ['all', ms(times.total)],
        ['read', ms(times.read)],
        ['fonts', ms(times.fonts)],
        ['body', ms(times.body)],
        ['headers', ms(times.headers)],
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
  syncReflow();
  renderer.flat = reflowing();
  if (!pendingView) camera.clamp(bounds, canvas.clientWidth, canvas.clientHeight); // a restored position may lie past the pages that have arrived so far
  if (renderer.flat) camera.x = bounds.x;
  lastStats = renderer.render(camera, pages, selection, caretVisible);
  const end = performance.now();
  // The caret blinks on an idle document; counting that would make idle read as a steady frame rate.
  if (!caretOnly) {
    frames.record(end, end - start);
    if (debugFlags().fps) flashRenderLight();
  }
  chrome.update({
    documentName,
    people: current.room?.people.some((p) => !p.me) ? current.room.people.filter((p) => !p.me) : NO_PEOPLE,
    renamable: renamable(),
    kind: largeView.active ? 'largetext' : documentKind,
    hasSelection: selection.text.length > 0,
    zoom: camera.zoom,
    grid,
    pagesPanel: pagesOpen() && !largeView.active && !reflowing(),
    filesPanel: filesOpen,
    footer: footerOn,
    format: selectionFormat,
    canUndo: isPicture() ? pictureHistory.undo.length > 0 : canUndo,
    canRedo: isPicture() ? pictureHistory.redo.length > 0 : canRedo,
    formMode: annotating ? formMode : null,
    painting,
    draw: { tool: drawLayer.tool, color: drawStyle.color, size: drawStyle.size, fill: drawStyle.fill },
    inTable,
    formattingMarks,
    viewMode,
  });
  formLayer.position();
  pdfTextLayer.position();
  pdfTools.position();
  pointerLayer.position();
  commentsPanel.position();
  syncPagesPanel();
  updateFooter();
  cropLayer.position();
  drawLayer.position();
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

let lastCanvasHeight = 0;

// The on-screen keyboard. Chrome shrinks the page for it (see the viewport meta in index.html); iOS
// Safari doesn't: it covers the bottom of the page and scrolls the page to show the focused field.
// So the app is sized to the visible part of the window (the CSS variable), and kept from scrolling.
const visual = window.visualViewport;
if (visual) {
  const fitVisual = () => {
    const covered = window.innerHeight - visual.height > 1;
    document.documentElement.style.setProperty('--app-height', covered ? `${visual.height}px` : '100%');
    if (covered && (window.scrollY || visual.offsetTop)) window.scrollTo(0, 0);
  };
  visual.addEventListener('resize', fitVisual);
  visual.addEventListener('scroll', fitVisual);
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
  if ((grid || wordView()) && !userMoved && pages.length) placeCamera();
  // The on-screen keyboard came up over the caret: scroll it back into view.
  if (camera.height < lastCanvasHeight && document.activeElement === input && selection.caret) reveal(selection.caret);
  lastCanvasHeight = camera.height;
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

function clickCount(e: Press): number {
  const near = Math.abs(e.clientX - lastClick.x) <= MULTI_CLICK_PX && Math.abs(e.clientY - lastClick.y) <= MULTI_CLICK_PX;
  const count = near && e.timeStamp - lastClick.time < MULTI_CLICK_MS ? lastClick.count + 1 : 1;
  lastClick = { time: e.timeStamp, x: e.clientX, y: e.clientY, count };
  return count;
}

let pan: { x: number; y: number } | null = null;
let selecting = false;
/** Latest drag position, sent once per frame. */
let pendingDrag: { x: number; y: number } | null = null;

/** The parts of a pointer event a press needs, so a touch tap can replay the press it held back. */
type Press = Pick<PointerEvent, 'offsetX' | 'offsetY' | 'clientX' | 'clientY' | 'timeStamp' | 'shiftKey' | 'metaKey' | 'ctrlKey'>;

function press(e: Press): void {
  focusInput();
  const hit = pageAt(e.offsetX, e.offsetY);
  // Editing a PDF: a click picks the text under it to edit there (or, over nothing, puts the text down).
  if (annotating && formMode === 'edit') {
    if (hit) {
      pdfTextLayer.expectClick(e.clientX, e.clientY);
      send({ kind: 'pdfPick', page: hit.page.id, x: hit.x, y: hit.y });
    } else if (pdfTextLayer.active) send({ kind: 'pdfPutDown' });
    return;
  }
  if (!hit) return;
  if (e.metaKey || e.ctrlKey) followLinkUntil = performance.now() + 1000;
  const clicks = clickCount(e);
  const unit = clicks === 2 ? 'word' : clicks >= 3 ? 'paragraph' : 'character';
  if (clicks === 2) editMathUntil = performance.now() + 1000;
  send({ kind: 'pointer', page: hit.page.id, x: hit.x, y: hit.y, extend: e.shiftKey && unit === 'character', unit });
  selecting = unit === 'character';
}

// Touch: one finger drags the page, two pinch and pan it, and a tap (a press that never moved) puts the caret down.
const TOUCH_SLOP_PX = 8;
const touches = new Map<number, { x: number; y: number }>();
let touchTap: Press | null = null;
let lastMoveAt = 0;
let pinch: { distance: number; x: number; y: number } | null = null;

function pinchState(): { distance: number; x: number; y: number } {
  const [a, b] = [...touches.values()];
  return { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// A one-finger drag keeps gliding after release, slowing exponentially (velocity in CSS px per ms).
const FLING_MIN_SPEED = 0.05;
const FLING_DECAY_PER_MS = 0.004;
let flingVelocity = { x: 0, y: 0 };
let flingFrame = 0;

function stopFling(): void {
  cancelAnimationFrame(flingFrame);
  flingFrame = 0;
}

function startFling(): void {
  stopFling();
  let last = performance.now();
  const step = (now: number): void => {
    const dt = Math.min(now - last, 50);
    last = now;
    camera.panBy(-flingVelocity.x * dt, -flingVelocity.y * dt);
    const decay = Math.exp(-FLING_DECAY_PER_MS * dt);
    flingVelocity = { x: flingVelocity.x * decay, y: flingVelocity.y * decay };
    requestRender();
    flingFrame = Math.hypot(flingVelocity.x, flingVelocity.y) > FLING_MIN_SPEED / 5 ? requestAnimationFrame(step) : 0;
  };
  flingFrame = requestAnimationFrame(step);
}

function touchDown(e: PointerEvent): void {
  stopFling();
  flingVelocity = { x: 0, y: 0 };
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touches.size === 1) {
    touchTap = { offsetX: e.offsetX, offsetY: e.offsetY, clientX: e.clientX, clientY: e.clientY, timeStamp: e.timeStamp, shiftKey: false, metaKey: false, ctrlKey: false };
  } else {
    touchTap = null;
    pinch = touches.size === 2 ? pinchState() : null;
  }
}

function touchMove(e: PointerEvent): void {
  const last = touches.get(e.pointerId);
  if (!last) return;
  const dx = e.clientX - last.x;
  const dy = e.clientY - last.y;
  if (touchTap && Math.hypot(e.clientX - touchTap.clientX, e.clientY - touchTap.clientY) > TOUCH_SLOP_PX) touchTap = null;
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touchTap) return;
  userMoved = true;
  const rect = canvas.getBoundingClientRect();
  if (pinch && touches.size === 2) {
    const now = pinchState();
    camera.panBy(pinch.x - now.x, pinch.y - now.y);
    camera.zoomAt(now.x - rect.left, now.y - rect.top, now.distance / pinch.distance);
    pinch = now;
  } else if (touches.size === 1) {
    camera.panBy(-dx, -dy);
    // Smoothed, so one jittery sample at release doesn't decide the fling.
    const dt = Math.max(e.timeStamp - lastMoveAt, 1);
    flingVelocity = { x: flingVelocity.x * 0.6 + (dx / dt) * 0.4, y: flingVelocity.y * 0.6 + (dy / dt) * 0.4 };
  }
  lastMoveAt = e.timeStamp;
  requestRender();
}

function touchUp(e: PointerEvent): void {
  touches.delete(e.pointerId);
  pinch = touches.size === 2 ? pinchState() : null;
  if (touches.size === 0 && !touchTap && e.type === 'pointerup' && e.timeStamp - lastMoveAt < 80 && Math.hypot(flingVelocity.x, flingVelocity.y) > FLING_MIN_SPEED) startFling();
  if (touchTap && e.type === 'pointerup') press(touchTap);
  touchTap = null;
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  if (e.pointerType === 'touch') {
    e.preventDefault();
    touchDown(e);
    return;
  }
  if (e.button === 1 || (e.button === 0 && e.altKey)) {
    // Middle button (or Alt+drag) pans.
    pan = { x: e.clientX, y: e.clientY };
    e.preventDefault();
    return;
  }
  if (e.button !== 0) return;
  e.preventDefault();
  press(e);
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

// Over a link, a tooltip says how to follow it (a plain click only puts the caret there).
interface Hover {
  /** Canvas coordinates, to find the link; window coordinates, to place the tip. */
  x: number;
  y: number;
  clientX: number;
  clientY: number;
}
let hoverAt: Hover | null = null;
let hoverBusy = false;
let hoverInside = false;
/** The pointer is over a link, and the key that follows links (Cmd on a Mac, else Ctrl) is down: the cursor is a hand. */
let overLink = false;
let linkKeyDown = false;
function updateCursor(): void {
  const cursor = painting ? 'copy' : overLink && linkKeyDown && !selecting && !pan ? 'pointer' : '';
  if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
}
function linkKeyChanged(e: { metaKey: boolean; ctrlKey: boolean }): void {
  linkKeyDown = MAC ? e.metaKey : e.ctrlKey;
  updateCursor();
}
window.addEventListener('keydown', linkKeyChanged, true);
window.addEventListener('keyup', linkKeyChanged, true);
window.addEventListener('blur', () => linkKeyChanged({ metaKey: false, ctrlKey: false }));
function hoverLink(at: Hover): void {
  hoverAt = at;
  if (hoverBusy) return;
  hoverBusy = true;
  requestAnimationFrame(async () => {
    const asked = hoverAt;
    hoverAt = null;
    const hit = asked && loaded ? pageAt(asked.x, asked.y) : null;
    const url = hit ? await worker.linkAt(hit.page.id, hit.x, hit.y) : null;
    hoverBusy = false;
    overLink = url !== null && hoverInside;
    updateCursor();
    if (asked && hoverInside) pointerTip(url ? t(MAC ? 'app.linkTip.cmd' : 'app.linkTip.ctrl', { url }) : null, asked.clientX, asked.clientY);
    const moved = hoverAt as Hover | null; // the pointer may have moved while asking
    if (moved && hoverInside) hoverLink(moved);
  });
}

canvas.addEventListener('pointerleave', () => {
  hoverInside = false;
  hoverAt = null;
  overLink = false;
  updateCursor();
  pointerTip(null, 0, 0);
});

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return touchMove(e);
  pointerMoved(e.offsetX, e.offsetY);
  hoverInside = true;
  linkKeyChanged(e);
  if (!pan && !selecting) hoverLink({ x: e.offsetX, y: e.offsetY, clientX: e.clientX, clientY: e.clientY });
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
canvas.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'touch') return touchUp(e);
  endPointer();
  // With the Format Painter picked up, what was just selected is painted.
  if (painting) send({ kind: 'applyPainter' });
});
canvas.addEventListener('pointercancel', (e) => (e.pointerType === 'touch' ? touchUp(e) : endPointer()));

// Trackpad pinch arrives as ctrl+wheel; cmd/ctrl+wheel zooms with a mouse; plain wheel scrolls.
// Browsers don't flag macOS momentum events, so while a scroll is still coasting, cmd only takes
// over once the deltas jump up sharply (fresh wheel/trackpad input); a decaying tail keeps scrolling,
// including its jitter once the view is clamped at a bound.
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
    const coasting = e.timeStamp - lastWheelTime <= WHEEL_GESTURE_GAP_MS && magnitude <= lastWheelMagnitude * 2 + 8;
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
      // Between a table's cells, or a tab character.
      return [{ kind: 'tab', backward: e.shiftKey }];
  }
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'a') return [{ kind: 'selectAll' }];
  if (mod && e.key.toLowerCase() === 'z') return [{ kind: e.shiftKey ? 'redo' : 'undo' }];
  if (e.ctrlKey && !MAC && e.key.toLowerCase() === 'y') return [{ kind: 'redo' }];
  return null;
}

/** Scrolls to a page: its top at the top of the view, and the page centered across it. */
function goToPage(index: number): void {
  const page = pages[index];
  if (!page) return;
  const pointsPerCss = 1 / (camera.zoom * CSS_PX_PER_POINT);
  camera.x = page.x + page.width / 2 - (canvas.clientWidth / 2) * pointsPerCss;
  camera.y = page.y - 16 * pointsPerCss;
  userMoved = true;
  requestRender();
}

function togglePagesPanel(): void {
  pagesChoice = !pagesOpen();
  try {
    localStorage.setItem(PAGES_KEY, pagesChoice ? 'on' : 'off');
  } catch {
    // Storage unavailable: the choice lasts for this session only.
  }
  requestRender();
}

function toggleFooter(): void {
  footerOn = !footerOn;
  try {
    localStorage.setItem(FOOTER_KEY, footerOn ? 'on' : 'off');
  } catch {
    // Storage unavailable: the choice lasts for this session only.
  }
  if (footerOn) refreshFooter();
  // The bar takes room from the document: the canvas is resized by its observer, and the view is placed again.
  requestRender();
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
  } else if (e.altKey && e.code === 'KeyP') {
    togglePagesPanel();
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
  // Other text boxes (comments, Clip, dialogs) keep their keys; `#input` is the document's own.
  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
  if (e.target instanceof HTMLTextAreaElement && e.target.id !== 'input') return;
  if (e.isComposing) return;
  const inEditableBox = e.target instanceof HTMLElement && e.target.isContentEditable;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    // Documents save themselves; the habit just saves a little sooner.
    e.preventDefault();
    if (current.shared) void uploadShared();
    else if (current.unsavedSince || (!current.localId && !current.builtIn)) void saveInBrowser();
    else if (account) void flushUploads();
    else setStatus(t('app.allSaved'));
    return;
  }
  // Editing text in a box over a PDF page: the caret keys, selection and the rest are the browser's.
  if (inEditableBox) return;
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
/** HTML larger than this is pasted as plain text (reading it would take too long). */
const MAX_PASTED_HTML = 2_000_000;

/** Pastes what came from the clipboard: formatted if it has formatting and the document can hold it. */
function pasteClipboard(clip: Clipboard, form: 'auto' | 'html' | 'text' = 'auto'): void {
  const formatted = FORMATS[documentKind].marks.length > 0;
  if (clip.html && form !== 'text' && formatted && clip.html.length <= MAX_PASTED_HTML) send({ kind: 'pasteHtml', html: clip.html, text: clip.text ?? '' });
  else if (clip.text) send({ kind: 'insertText', text: clip.text });
}

input.addEventListener('paste', (e) => {
  e.preventDefault();
  pasteClipboard({ html: e.clipboardData?.getData('text/html') || undefined, text: e.clipboardData?.getData('text/plain') || undefined });
});

// --- Navigation ------------------------------------------------------------------------

/** The font families offered in font boxes (not the pages or the math one); `withFile`: only those with a font file to embed. */
function fontFamilies(withFile = false): Promise<string[]> {
  return fetch(`${FONT_BASE}manifest.json`)
    .then((r) => r.json() as Promise<{ families: { wordName: string; page?: unknown; math?: unknown; faces: { font?: string }[] }[] }>)
    .then((m) => m.families.filter((f) => !f.page && !f.math && (!withFile || f.faces.some((face) => face.font))).map((f) => f.wordName));
}

// Menu bar and toolbars (./ui); chromeHost.ts maps their actions onto this app.
const chromeHost = createChromeHost({
  dashboard: () => dashboard.toggle(),
  loading: (name) => (name === null ? loadingScreen.hide() : showLoading(name)),
  canvas,
  camera,
  pages: () => pages,
  bounds: () => bounds,
  open: (source) => {
    setUrl(new URLSearchParams());
    open(source, { store: true });
  },
  openSample: openSource,
  syncNow,
  share,
  download,
  downloadAll,
  importZip,
  toggleClip: () => assistant.setVisible(!assistant.visible),
  print,
  showFind: (tab) => (largeView.active ? (tab === 'goTo' ? largeView.goTo() : largeView.find()) : findDialog.show(tab)),
  showSpelling: () => spellDialog.open(),
  showWordCount: () => wordCountDialog.open(),
  paste: async () => {
    const clip = await readClipboard();
    if (clip) pasteClipboard(clip);
  },
  showPasteSpecial: () => {
    void readClipboard()
      .then((clip) => showPasteSpecialDialog(clip).then((form) => (form && clip ? pasteClipboard(clip, form) : undefined)))
      .then(focusInput);
  },
  renameDocument,
  showProperties: () => propertiesDialog.open(),
  showPageSetup: () => {
    void showPageSetupDialog(sectionPage ?? { width: 12240, height: 15840, landscape: false, top: 1440, bottom: 1440, left: 1440, right: 1440, gutter: 0, header: 720, footer: 720 }).then((choice) => {
      if (choice) send({ kind: 'setPage', ...choice });
      focusInput();
    });
  },
  showParagraphDialog: () => {
    void showParagraphDialog(selectionFormat.paragraph ?? {}).then((choice) => {
      if (choice && Object.keys(choice).length > 0) send({ kind: 'format', action: { kind: 'setParagraph', ...choice } });
      focusInput();
    });
  },
  showColumnsDialog: () => {
    void showColumnsDialog(sectionColumns ?? { count: 1, space: 720, sep: false, width: 9360 }).then((choice) => {
      if (choice) send({ kind: 'setColumns', ...choice });
      focusInput();
    });
  },
  showSplitDialog: () => {
    void showSplitDialog().then((size) => {
      if (size) send({ kind: 'format', action: { kind: 'table', op: 'splitCells', ...size } });
      focusInput();
    });
  },
  showTableDialog: () => {
    void showTableDialog().then((size) => {
      if (size) send({ kind: 'format', action: { kind: 'insertTable', ...size } });
      focusInput();
    });
  },
  showLinkDialog: () => {
    const selected = selection.text;
    if (selected.includes('\n')) return reportError(t('app.linkOneParagraph'));
    void showLinkDialog(link ?? null, selected).then((choice) => {
      if (choice === undefined) return;
      send(choice ? { kind: 'setLink', url: choice.url, text: choice.text } : { kind: 'removeLink' });
      focusInput();
    });
  },
  showMathDialog: () => {
    // The LaTeX parser is only fetched when an equation is asked for.
    void import('./ui/mathDialog.ts')
      .then((m) => m.showMathDialog(math))
      .then((equation) => {
        if (!equation) return;
        send({ kind: 'insertContent', content: [equation] });
        focusInput();
      });
  },
  convert: convertTo,
  imageAction: pictureAction,
  isLargeText: () => largeView.active,
  openLarge,
  largeZoom: (factor, reset) => largeView.zoomBy(factor, reset),
  largeCopy: async () => {
    const text = await largeView.copy();
    if (text !== null) setStatus(t('largeText.copied', { count: text.split('\n').length.toLocaleString() }));
  },
  drawStyle: (color, size, fill) => {
    if (color !== undefined) drawStyle.color = color;
    if (size !== undefined) drawStyle.size = size;
    if (fill !== undefined) drawStyle.fill = fill;
    requestRender();
  },
  pickPicture,
  isPicture,
  stepPicture,
  signIn,
  signOut,
  subscribe,
  manageSubscription,
  clearLocalData,
  saved: () => mergeLibrary(savedDocs, account ? cloudDocs : null).map((e) => ({ id: sourceOf(e), label: e.name.replace(/&/g, '&&') })),
  send,
  annotating: () => annotating,
  setFormMode,
  author: commentAuthor,
  startComment: () => commentsPanel.startDraft(),
  selectedText: () => selection.text,
  focusEditor: focusInput,
  notify: reportError,
  toggleGrid,
  togglePagesPanel,
  toggleFilesPanel,
  toggleFooter,
  setViewMode: (mode) => {
    viewMode = mode;
    try {
      localStorage.setItem(VIEW_KEY, mode);
    } catch {
      // Storage unavailable: the choice lasts for this session only.
    }
    cameraPlaced = false;
    userMoved = false;
    pendingView = null;
    syncReflow(true);
    arrange();
  },
  toggleFormattingMarks: () => {
    formattingMarks = !formattingMarks;
    try {
      localStorage.setItem(MARKS_KEY, formattingMarks ? 'on' : 'off');
    } catch {
      // Storage unavailable: the choice lasts for this session only.
    }
    worker.setMarks(formattingMarks);
  },
  viewChanged: () => {
    userMoved = true;
    requestRender();
  },
  fonts: () => fontFamilies(),
  samples: () => [
    { id: 'welcome', label: t('app.sampleWelcome') },
    { id: 'fonts', label: t('app.sampleFonts') },
    { id: 'war-and-peace', label: t('app.sampleWarAndPeace') },
    ...corpusNames.map((name) => ({ id: `corpus:${name}`, label: name.replace(/&/g, '&&') })),
  ],
});
const chrome = mountChrome(document.getElementById('chrome')!, { host: chromeHost, isAdmin: () => signedIn?.isAdmin === true, showUnimplemented: import.meta.env.DEV });

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
  goToPage,
  commentCount: () => comments.length,
  goToComment: (index) => {
    const comment = comments[index];
    if (comment) send({ kind: 'selectComment', id: comment.id });
  },
  focusEditor: focusInput,
});

// File ▸ Properties.
const propertiesDialog = new PropertiesDialog({ send, focusEditor: focusInput });

// Tools ▸ Word Count.
const wordCountDialog = new WordCountDialog({ send, focusEditor: focusInput });

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
const addUserWord = (word: string): void => {
  try {
    localStorage.setItem(USER_WORDS_KEY, JSON.stringify([...new Set([...userWords(), word])]));
  } catch {
    // Storage unavailable: the word is accepted for this session only.
  }
};
const spellDialog = new SpellDialog(document.body, {
  send,
  selectedText: () => selection.text,
  userWords,
  addUserWord,
  focusEditor: focusInput,
});

// Right click on an underlined word: change it, or ignore it.
const spellMenu = new SpellMenu({
  send,
  addUserWord,
  focusEditor: focusInput,
});
/** Where the last right click was, for the menu it may open. */
function toggleFilesPanel(): void {
  filesOpen = !filesOpen;
  try {
    localStorage.setItem(FILES_KEY, filesOpen ? 'on' : 'off');
  } catch {
    // Storage unavailable: the choice lasts for this session only.
  }
  filesPanel.setVisible(filesOpen);
  chrome.update({ filesPanel: filesOpen });
}

let spellMenuAt: { x: number; y: number } | null = null;
canvas.addEventListener('contextmenu', (e) => {
  if (annotating || !spellDialog.checkingLive) return;
  const hit = pageAt(e.offsetX, e.offsetY);
  if (!hit) return;
  e.preventDefault();
  focusInput();
  spellMenuAt = { x: e.clientX, y: e.clientY };
  send({ kind: 'spellAt', page: hit.page.id, x: hit.x, y: hit.y });
});

// The dashboard of all documents (File ▸ Dashboard). Opening a document from it goes through the
// same paths as File ▸ Open Recent.
const dashboard = new Dashboard(document.getElementById('workspace')!, {
  currentDocument: () => ({ localId: current.localId, cloudId: current.shared?.id ?? null }),
  newDocument: (folderId) => {
    newDocumentFolder = folderId;
    void Promise.resolve(chromeHost.perform({ kind: 'new' })).then(focusInput);
  },
  open: (entry) => {
    newDocumentFolder = null;
    showLoading(entry.name);
    openSource(sourceOf(entry));
  },
  importFile: (folderId) => {
    newDocumentFolder = folderId;
    void chromeHost.perform({ kind: 'import' });
  },
  delete: deleteEverywhere,
  account: () => account,
  signedIn: () => signedIn,
  share: (id, name) => showShareDialog({ name, people: { id } }),
  openShared: (doc) => {
    sharedDocs.set(doc.id, doc);
    openSource(`shared:${doc.id}`);
  },
  closed: focusInput,
});

// Signed out, documents live only in this browser: offer to clear them (for shared computers).
const sharedDeviceNotice = new SharedDeviceNotice(document.body, () => void clearLocalData());

/**
 * The assistant's tools that act on the app rather than the document's text: what the document is
 * and switching its format (the same switch as File ▸ Convert To). The rest run in the layout worker.
 */
async function assistantTool(name: string, argumentsJson: string): Promise<ToolResult> {
  const handler = Object.hasOwn(APP_TOOLS, name) ? APP_TOOLS[name] : undefined;
  if (!handler) return worker.agent(name, argumentsJson);
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = argumentsJson.trim() ? JSON.parse(argumentsJson) : {};
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'Error: the arguments must be an object.';
    args = parsed as Record<string, unknown>;
  } catch {
    return 'Error: the arguments were not valid JSON.';
  }
  try {
    return await handler(args);
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

const formatLabel = (kind: string): string => (isFormat(kind) ? `${FORMATS[kind].label} (${FORMATS[kind].extensions[0]})` : kind);
const optionalFlag = (args: Record<string, unknown>, key: string): boolean | undefined => {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new Error(`\`${key}\` must be true or false.`);
  return v;
};
const wholeNumber = (args: Record<string, unknown>, key: string, min: number, max: number): number => {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error(`\`${key}\` must be a whole number from ${min} to ${max}.`);
  return v;
};

/** Runs one of the layout worker's tools for another tool, and answers with its text (the pictures a tool fetches are only for the model). */
const workerText = async (name: string, args: string): Promise<string> => {
  const result = await worker.agent(name, args);
  return typeof result === 'string' ? result : result.text;
};

/**
 * The person's other documents, for the assistant: this browser's copies and the account's, and
 * what others shared with them. Everything but the open document.
 */
const otherDocuments = new OtherDocuments(async () => {
  const own: StoredDocument[] = mergeLibrary(savedDocs, account ? cloudDocs : null)
    .filter((e) => e.key !== current.localId && e.cloud?.id !== current.shared?.id)
    .map((e) => ({
      id: e.key,
      name: e.name,
      updatedAt: e.updatedAt,
      size: e.size,
      ...(e.cloud && { cloudId: e.cloud.id }),
      load: async () => (e.local && !opensFromCloud(e) ? (await getSaved(e.local.id))?.bytes : null) ?? downloadDocument(e.cloud!.id),
    }));
  const shared: StoredDocument[] = signedIn
    ? (await listShared().catch(() => [])).filter((d) => d.id !== current.shared?.id).map((d) => ({ id: d.id, name: d.name, updatedAt: d.updatedAt, size: d.size, place: `shared by ${d.owner?.name ?? d.owner?.email ?? 'someone'}`, load: () => downloadDocument(d.id) }))
    : [];
  return [...own, ...shared];
}, searchServer);

/** A whole number argument that may be left out. */
const optionalNumber = (args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number => {
  if (args[key] === undefined) return fallback;
  return wholeNumber(args, key, min, max);
};

const IMAGE_OPS: Record<string, ImageOp> = {
  rotate_left: 'rotateLeft',
  rotate_right: 'rotateRight',
  rotate_180: 'rotate180',
  flip_horizontal: 'flipHorizontal',
  flip_vertical: 'flipVertical',
  grayscale: 'grayscale',
  sepia: 'sepia',
  invert: 'invert',
  blur: 'blur',
  sharpen: 'sharpen',
  auto_levels: 'autoLevels',
};
const DRAWN = ['line', 'arrow', 'rectangle', 'ellipse', 'text'] as const;

/** The assistant's tools that act on the app rather than the document's text. The rest run in the layout worker. */
const APP_TOOLS: Record<string, (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult> = {
  async list_pictures() {
    // The open document's pictures are the layout worker's to find; the library's are listed here.
    return `${await workerText('list_pictures', '{}')}\n${await otherDocuments.describePictureFiles()}`;
  },
  view_picture(args) {
    // The person's other documents (this browser's, the account's and shared ones) are the library's, found and opened the way search_documents does.
    if (args.source === 'library') {
      if (typeof args.document !== 'string') return 'Error: `document` must be text: an id or a name.';
      return otherDocuments.picture(args.document, optionalNumber(args, 'number', 0, 0, 1000));
    }
    return worker.agent('view_picture', JSON.stringify(args));
  },
  list_documents: (args) => otherDocuments.describeAll(optionalNumber(args, 'start', 0, 0, 100_000), optionalNumber(args, 'count', 30, 1, 100)),
  search_documents(args) {
    if (typeof args.query !== 'string') return 'Error: `query` must be text.';
    return otherDocuments.search(args.query);
  },
  read_other_document(args) {
    if (typeof args.document !== 'string') return 'Error: `document` must be text: an id or a name.';
    return otherDocuments.read(args.document, optionalNumber(args, 'start', 0, 0, 1_000_000), optionalNumber(args, 'count', 40, 1, 100));
  },
  async insert_from_document(args) {
    if (typeof args.document !== 'string') return 'Error: `document` must be text: an id or a name.';
    const found = await otherDocuments.paragraphs(args.document);
    if (typeof found === 'string') return found;
    const { name, segments } = found;
    if (!segments.length) return `Error: "${name}" has no text to copy.`;
    const first = wholeNumber(args, 'start', 0, Math.max(0, segments.length - 1));
    const last = optionalNumber(args, 'end', first, first, Math.max(first, segments.length - 1));
    if (last - first + 1 > MAX_COPY) return `Error: copy at most ${MAX_COPY} paragraphs at a time.`;
    const after = wholeNumber(args, 'after', -1, 1_000_000);
    // Put in one paragraph at a time with the tools the model has itself, so each is an ordinary, undoable edit.
    for (let k = first; k <= last; k++) {
      const seg = segments[k]!;
      const at = after + (k - first);
      const added = await workerText('insert_paragraph', JSON.stringify({ after: at, text: seg.text, style: seg.style ?? 'Normal' }));
      if (added.startsWith('Error:')) return `${added} Copied ${k - first} of ${last - first + 1} paragraphs from "${name}" before stopping.`;
      if (seg.list) await workerText('format_paragraph', JSON.stringify({ paragraph: at + 1, list: seg.list }));
    }
    const count = last - first + 1;
    return `Copied ${count === 1 ? `paragraph ${first}` : `paragraphs ${first} to ${last}`} of "${name}" into this document as paragraphs ${after + 1} to ${after + count}. Pictures and tables in them are not carried over, only their text; undo steps back.`;
  },
  get_document_info: () => `The document is "${documentName}", edited as ${formatLabel(documentKind)}. It can be converted to: ${FORMAT_LIST.map(formatLabel).join(', ')}.`,
  rename_document(args) {
    if (typeof args.name !== 'string') return 'Error: `name` must be text.';
    if (!renamable()) return 'Error: this document cannot be renamed.';
    const kept = renameDocument(args.name);
    return kept === null ? 'Error: that is not a usable name.' : `The document is now named "${displayDocumentName(kept, documentKind)}".`;
  },
  async convert_document(args) {
    const to = args.to;
    const from = documentKind;
    if (typeof to !== 'string' || !isFormat(to)) return `Error: \`to\` must be one of ${FORMAT_LIST.join(', ')}.`;
    if (to === from) return `The document is already ${formatLabel(from)}.`;
    if (new URLSearchParams(location.search).get('room')) return 'Error: a document being edited together with other people cannot be converted.';
    await convertTo(to);
    return documentKind === to
      ? `Converted: the document is now edited as ${formatLabel(to)}. It is the same document, so switching back restores anything ${formatLabel(to)} could not hold. Paragraph numbers may differ now; read the document again before editing.`
      : 'Error: the document could not be converted.';
  },
  download_document() {
    void chromeHost.perform({ kind: 'download' });
    return `Started the download of a copy as ${formatLabel(documentKind)}.`;
  },
  print_document(args) {
    const preview = optionalFlag(args, 'preview') ?? false;
    void chromeHost.perform({ kind: preview ? 'printPreview' : 'print' });
    return preview ? 'Opened the print preview.' : 'Opened printing.';
  },
  set_view(args) {
    const done: string[] = [];
    const mode = args.view_mode;
    if (mode !== undefined) {
      if (mode !== 'print' && mode !== 'normal') throw new Error('`view_mode` must be print or normal.');
      void chromeHost.perform({ kind: 'viewMode', mode });
      done.push(`view ${mode}`);
    }
    const zoom = args.zoom;
    if (zoom !== undefined) {
      if (zoom === 'page_width' || zoom === 'whole_page' || zoom === 'all_pages') void chromeHost.perform({ kind: 'zoom', to: zoom === 'page_width' ? 'pageWidth' : zoom === 'whole_page' ? 'wholePage' : 'allPages' });
      else if (typeof zoom === 'number' && zoom >= 10 && zoom <= 500) void chromeHost.perform({ kind: 'zoom', to: zoom / 100 });
      else throw new Error('`zoom` must be a percentage from 10 to 500, or page_width, whole_page or all_pages.');
      done.push(`zoom ${String(zoom)}`);
    }
    const showGrid = optionalFlag(args, 'grid');
    if (showGrid !== undefined && showGrid !== grid) {
      void chromeHost.perform({ kind: 'toggleGrid' });
      done.push(`grid ${showGrid ? 'on' : 'off'}`);
    }
    const bar = optionalFlag(args, 'status_bar');
    if (bar !== undefined && bar !== footerOn) {
      void chromeHost.perform({ kind: 'toggleFooter' });
      done.push(`status bar ${bar ? 'on' : 'off'}`);
    }
    const marks = optionalFlag(args, 'formatting_marks');
    if (marks !== undefined && marks !== formattingMarks) {
      void chromeHost.perform({ kind: 'toggleFormattingMarks' });
      done.push(`formatting marks ${marks ? 'on' : 'off'}`);
    }
    if (!done.length) throw new Error('Say what to change: view_mode, zoom, grid, status_bar or formatting_marks.');
    return `Changed the view: ${done.join(', ')}.`;
  },
  async edit_picture(args) {
    if (!isPicture()) return 'Error: the open document is not a picture. Convert it to png, jpeg or webp to edit it as one.';
    const op = args.op;
    if (typeof op !== 'string') throw new Error('`op` must be text.');
    const size = sniffImage(await pictureBytes());
    if (!size) throw new Error('the picture could not be read');
    let edit: ImageEdit;
    if (Object.hasOwn(IMAGE_OPS, op)) {
      const name = IMAGE_OPS[op]!;
      edit = name === 'rotateLeft' ? { op: 'rotate', turns: 3 } : name === 'rotateRight' ? { op: 'rotate', turns: 1 } : name === 'rotate180' ? { op: 'rotate', turns: 2 } : name === 'flipHorizontal' ? { op: 'flip', axis: 'horizontal' } : name === 'flipVertical' ? { op: 'flip', axis: 'vertical' } : { op: 'effect', effect: name as 'grayscale' };
    } else if (op === 'crop') {
      const x = wholeNumber(args, 'x', 0, size.width - 1);
      const y = wholeNumber(args, 'y', 0, size.height - 1);
      edit = { op: 'crop', x, y, width: wholeNumber(args, 'width', 1, size.width - x), height: wholeNumber(args, 'height', 1, size.height - y) };
    } else if (op === 'resize') {
      edit = { op: 'resize', width: wholeNumber(args, 'width', 1, MAX_SIDE), height: wholeNumber(args, 'height', 1, MAX_SIDE) };
    } else if (op === 'adjust') {
      const part = (key: string) => (args[key] === undefined ? 0 : wholeNumber(args, key, -100, 100));
      edit = { op: 'adjust', brightness: part('brightness'), contrast: part('contrast'), saturation: part('saturation') };
    } else if (op === 'draw') {
      const tool = args.tool;
      if (typeof tool !== 'string' || !(DRAWN as readonly string[]).includes(tool)) throw new Error(`\`tool\` must be one of ${DRAWN.join(', ')}.`);
      const color = typeof args.color === 'string' && /^#[0-9a-f]{6}$/i.test(args.color) ? args.color : args.color === undefined ? '#e53935' : null;
      if (!color) throw new Error('`color` must be like #e53935.');
      const at = (px: string, py: string) => ({ x: wholeNumber(args, px, 0, size.width), y: wholeNumber(args, py, 0, size.height) });
      const points = tool === 'text' ? [at('x', 'y')] : [at('x', 'y'), at('to_x', 'to_y')];
      if (tool === 'text' && (typeof args.text !== 'string' || !args.text)) throw new Error('`text` is what to write.');
      const width = args.width === undefined ? Math.max(2, Math.round(Math.max(size.width, size.height) / 150)) : wholeNumber(args, 'width', 1, 200);
      edit = { op: 'draw', shapes: [{ tool: tool as 'line', color, width, points, ...(optionalFlag(args, 'fill') && { fill: true }), ...(tool === 'text' && { text: args.text as string }) }] };
    } else {
      throw new Error(`\`op\` must be one of ${[...Object.keys(IMAGE_OPS), 'crop', 'resize', 'adjust', 'draw'].join(', ')}.`);
    }
    await changePicture(edit);
    return `Done: ${op.replaceAll('_', ' ')} (the picture is ${size.width} x ${size.height} before the change; undo steps back).`;
  },
};

// Clip, the assistant: a paperclip in the bottom right that reads and edits the open document for subscribers (see assistant/).
const assistant = new Assistant(document.body, { tool: assistantTool, signIn: () => void signIn(), subscribe: () => void subscribe() });
assistant.onVisibility = (clip) => chrome.update({ clip });
chrome.update({ clip: assistant.visible });

// Other people's mouse pointers (see ui/pointerLayer.ts).
const pointerLayer = new PointerLayer(document.getElementById('viewport')!, { camera, page: (index) => pages[index] });
// Cropping a picture (see ui/cropLayer.ts).
const cropLayer = new CropLayer(document.getElementById('viewport')!, { camera, page: () => pages[0] });
// Text files too big to be documents (see largeText/view.ts).
const largeView = new LargeTextView(document.getElementById('viewport')!);
// Drawing on a picture (see ui/drawLayer.ts).
const drawLayer = new DrawLayer(document.getElementById('viewport')!, { camera, canvas, page: () => pages[0], style: () => drawStyle, changed: () => requestRender() });

// The thumbnails of the pages beside the document; for a PDF's pages, drag them into order or delete them (see ui/pagesPanel.ts).
const pagesPanel = new PagesPanel(document.getElementById('workspace')!, {
  go: goToPage,
  draw: (page, width, height) => (gl ? readPage(gl, renderer, page as GpuPage, width, height) : null),
  move: (index, to) => changePages(index, { op: 'move', to }),
  remove: (index) => changePages(index, { op: 'delete' }),
  close: togglePagesPanel,
  focusEditor: focusInput,
});
document.getElementById('workspace')!.prepend(pagesPanel.el);

// The account's folders and documents as a tree, left of everything else (see ui/filesPanel.ts).
const filesPanel = new FilesPanel(document.getElementById('workspace')!, {
  open: (entry) => {
    newDocumentFolder = null;
    showLoading(entry.name);
    openSource(sourceOf(entry));
  },
  newDocument: (folderId) => {
    newDocumentFolder = folderId;
    void Promise.resolve(chromeHost.perform({ kind: 'new' })).then(focusInput);
  },
  importFile: (folderId) => {
    newDocumentFolder = folderId;
    void chromeHost.perform({ kind: 'import' });
  },
  delete: deleteEverywhere,
  share: (id, name) => showShareDialog({ name, people: { id } }),
  account: () => account,
  signedIn: () => signedIn,
  current: () => ({ localId: current.localId, cloudId: savedDocs.find((d) => d.id === current.localId)?.cloudId ?? null }),
  close: toggleFilesPanel,
  focusEditor: focusInput,
});
document.getElementById('workspace')!.prepend(filesPanel.el);
filesPanel.setVisible(filesOpen);

/** A font or picture has loaded: the document redraws, and so do the thumbnails drawn without it. */
function assetLoaded(): void {
  requestRender();
  pagesPanel.refresh();
}

/** A PDF's page `index` is deleted or moved (the editing in progress is put down first). */
function changePages(index: number, op: { op: 'delete' } | { op: 'move'; to: number }): void {
  const page = pages[index];
  if (!page || !annotating || formMode !== 'edit') return;
  send({ kind: 'pdfPutDown' });
  send({ kind: 'pdfPageOp', page: page.id, ...op });
}

let panelCamera = '';

// --- Status bar ------------------------------------------------------------------------

const footer = new Footer(document.getElementById('footer')!);

/** Asks the worker for the counts, once the document has been still for a moment. */
function refreshFooterSoon(): void {
  window.clearTimeout(footerTimer);
  footerTimer = window.setTimeout(refreshFooter, 300);
}

function refreshFooter(): void {
  if (!footerOn || !loaded || isPicture() || largeView.active) return;
  send({ kind: 'countWords', whole: true, footer: true });
  if (selection.text.length > 0) send({ kind: 'countWords', footer: true });
  else footerSelection = null;
}

/** Shows or hides the bar and says what it says, for the kind of document open. */
function updateFooter(): void {
  const visible = footerOn && !largeView.active;
  footer.setVisible(visible);
  if (!visible) return;
  let picture = null;
  if (isPicture()) {
    picture = pictureSizes.get(current) ?? null;
    if (!picture && !pictureSizing.has(current)) {
      const doc = current;
      pictureSizing.add(doc);
      void pictureBytes().then((bytes) => {
        const size = sniffImage(bytes);
        if (!size) return;
        pictureSizes.set(doc, { width: size.width, height: size.height });
        requestRender();
      });
    }
  }
  const center = camera.toDocument(canvas.clientWidth / 2, canvas.clientHeight / 2);
  const here = reflowing() ? null : nearestPage(pages, center.x, center.y);
  footer.update({
    kind: documentKind,
    page: here ? { current: pages.indexOf(here) + 1, count: pages.length } : null,
    zoom: camera.zoom,
    words: footerWords,
    selection: selection.text.length > 0 ? footerSelection : null,
    picture,
  });
}

/** Keeps the pages panel in step with the document: shown or not, editable or not, and marking the page in view. */
function syncPagesPanel(): void {
  const shown = pagesOpen() && !largeView.active && !reflowing() && pages.length > 0;
  pagesPanel.setVisible(shown);
  if (!shown) return;
  const editing = annotating && formMode === 'edit';
  pagesPanel.setEditable(editing, annotating && !editing ? t('panels.pages.hint', { mode: mnemonicLabel(t('chrome.view.editForm')).text }) : null);
  const view = `${camera.x}/${camera.y}/${camera.zoom}/${pages.length}`;
  if (view === panelCamera) return;
  panelCamera = view;
  const center = camera.toDocument(canvas.clientWidth / 2, canvas.clientHeight / 2);
  const page = nearestPage(pages, center.x, center.y);
  pagesPanel.setCurrent(page ? pages.indexOf(page) : -1);
}

// A PDF's form fields, over its pages: filled in or arranged (see ui/formLayer.ts).
function setFormMode(mode: FormMode): void {
  if (mode !== 'edit') send({ kind: 'pdfPutDown' });
  formMode = mode;
  formLayer.setMode(mode);
  pdfTools.setMode(mode);
  requestRender();
  if (mode === 'fill') focusInput();
}

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
  setMode: setFormMode,
});

// A PDF page's own text, edited in place (see ui/pdfTextLayer.ts).
const pdfTextLayer = new PdfTextLayer(document.getElementById('viewport')!, {
  camera,
  canvas,
  page: (id) => pagesById.get(id),
  setText: (text) => send({ kind: 'pdfText', text }),
  putDown: () => send({ kind: 'pdfPutDown' }),
  move: (dx, dy) => send({ kind: 'pdfMoveText', dx, dy }),
});

// Tools for a PDF page's content: add text, pictures and shapes, and move, restyle or delete them (see ui/pdfEditTools.ts).
const pdfTools = new PdfEditTools(document.getElementById('viewport')!, {
  camera,
  canvas,
  page: (id) => pagesById.get(id),
  pageAt: (x, y) => {
    const hit = pageAt(x, y);
    return hit && { page: hit.page, x: hit.x, y: hit.y };
  },
  send,
  notify: setStatus,
  // Only families with a font file: the PDF's text is drawn with it.
  families: () => fontFamilies(true),
});
formLayer.toolsSlot.append(pdfTools.el);

/** Who new comments are from. */
function commentAuthor(): string {
  return signedIn?.name ?? signedIn?.email ?? guestName();
}

// Comments down the right of the editor, each beside its text; edits to them are ordinary (undoable) edits.
const commentsPanel = new CommentsPanel(document.getElementById('viewport')!, {
  select: (id) => {
    send({ kind: 'selectComment', id });
    focusInput();
  },
  edit: (id, text) => send({ kind: 'editComment', id, text }),
  remove: (id) => send({ kind: 'deleteComment', id }),
  reply: (id, text) => send({ kind: 'replyComment', id, text, author: commentAuthor() }),
  resolve: (id, resolved) => send({ kind: 'resolveComment', id, resolved }),
  add: (text) => send({ kind: 'addComment', text, author: commentAuthor() }),
  place: (pageId, y) => {
    const page = pagesById.get(pageId);
    return page ? (page.y + y - camera.y) * camera.zoom * CSS_PX_PER_POINT : null;
  },
  placeCaret: () => {
    const caret = selection.caret;
    const page = caret && pagesById.get(caret.page);
    return caret && page ? (page.y + caret.y - camera.y) * camera.zoom * CSS_PX_PER_POINT : null;
  },
  focusEditor: focusInput,
});

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  void dropped(file, e.clientX, e.clientY);
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
  const doc = wantedDoc(params);
  // Coming back from signing in on the dashboard: open it again.
  if (params.get('dashboard') === '1') {
    params.delete('dashboard');
    if (doc) params.set('doc', doc);
    setUrl(params);
    void dashboard.show();
  }
  accountKnown = accountLookup.then((user) => {
    signedIn = user;
    account = user;
    drawnFor = user?.id ?? null;
    chrome.accountChanged();
  });
  firstConnect = connect(accountLookup);
  // Back from signing in to subscribe, or from paying at Polar.
  const subscribing = params.get('subscribe') === '1';
  const subscribed = params.get('subscribed') === '1';
  if (subscribing || subscribed) {
    params.delete('subscribe');
    params.delete('subscribed');
    if (doc) params.set('doc', doc);
    setUrl(params);
    void firstConnect.then(() => (subscribed ? afterCheckout() : signedIn ? subscribe() : undefined));
  }
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
