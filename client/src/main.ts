import './style.css';
import warAndPeaceUrl from '../../scripts/war-and-peace.txt?url';
import { replacementFor } from '@golemdocs/editor/pattern';
import { deskColor, onThemeChange, pagesDark } from './ui/theme.ts';
import { FrameMonitor, debugFlags, onDebugFlagsChange } from './debug.ts';
import { currentUser, remembered, signOut as signOutOfCloud, type User } from './auth.ts';
import { createChromeHost } from './chromeHost.ts';
import { CloudError, deleteDocuments, documentUrl, downloadDocument, downloadIndex, listDocuments, listFolders, listShared, listTrash, purgeTrash, renameCloudDocument, restoreFromTrash, saveChunked, saveDocument, type CloudDocument } from './cloud.ts';
import { CHUNK_MIN_FILE, chunkBytes } from './storage/chunker.ts';
import { zipDocuments } from './storage/archive.ts';
import { pickedFolder, takeDropped, type Dropped } from './storage/droppedFiles.ts';
import { importFiles, readZipFiles, sameBytes, type ZipContents } from './storage/zipImport.ts';
import { showProgress } from './ui/progressToast.ts';
import { rememberNewKind } from './ui/newKinds.ts';
import { appTools } from './assistant/appTools.ts';
import { addressDoc, builtInPageAt, lastDoc, noteAddressDoc, rememberLastDoc, setUrl, wantedDoc } from './address.ts';
import { adoptGuestFolders, createFolder, setLinkKeeper } from './folderOps.ts';
import { keepAsConflictCopy, openFromCloud, prefetchFromCloud, uploadNewToCloud, uploadToCloud } from './library.ts';
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
  saveFromCloud,
  saveSaved,
  saveThumbnail,
  deleteSearchIndexes,
  listSearchIndexes,
  listTrashedSaved,
  purgeTrashedSaved,
  restoreTrashedSaved,
  trashSaved,
  putSearchIndex,
  type SavedInfo,
} from './storage/local.ts';
import { folderOf, folderPath, type Folder } from './folders.ts';
import { UploadQueue } from './uploadQueue.ts';
import { LibraryStore } from './libraryStore.ts';
import { stopSettingsSync, syncSettings } from './settingsSync.ts';
import { forgetCatalogue, forgetInCatalogue, hasUnsentChanges, loadLocalLibrary, localCopies, putDocInCatalogue, type LibraryEntry } from './sync.ts';
import { capturePageThumbnail, drawPages, pictureLayout, readPage, textThumbnail } from './thumbnail.ts';
import { CommentsPanel } from './ui/commentsPanel.ts';
import { loadView, saveView, type SavedView } from './viewMemory.ts';
import { FilesPanel } from './ui/filesPanel.ts';
import { PagesPanel } from './ui/pagesPanel.ts';
import { FormLayer } from './ui/formLayer.ts';
import { PdfEditTools } from './ui/pdfEditTools.ts';
import { PdfTextLayer } from './ui/pdfTextLayer.ts';
import { PointerLayer } from './ui/pointerLayer.ts';
import { PictureFrame } from './ui/pictureFrame.ts';
import { showPopupMenu } from './ui/popupMenu.ts';
import { PictureDetourBar } from './ui/pictureDetourBar.ts';
import { showShareDialog } from './ui/shareDialog.ts';
import { showSignInDialog } from './ui/signIn.ts';
import { checkoutUrl, fetchSubscription, portalUrl, SubscriptionError, waitForSubscription, type Subscription } from './subscription.ts';
import { Dashboard } from './ui/dashboard.ts';
import { opensFromCloud } from './ui/dashboardFormat.ts';
import { showConfirm } from './ui/popup.ts';
import { NewVersionNotice } from './ui/newVersionNotice.ts';
import { SharedDeviceNotice } from './ui/sharedDeviceNotice.ts';
import { WatchBanner } from './ui/watchBanner.ts';
import { Assistant } from './assistant/index.ts';
import { searchServer } from './assistant/api.ts';
import { OtherDocuments, type StoredDocument } from './assistant/libraryDocs.ts';
import { IndexWorker } from './search/indexClient.ts';
import { SearchLibrary, type SearchHit } from './search/searchLibrary.ts';
import { searchableDocuments, type SourceDeps } from './search/sources.ts';
import { SearchPanel } from './ui/searchPanel.ts';
import { embedTitle, parseTagAddress } from '@golemdocs/docx';
import { LoadingScreen } from './ui/loadingScreen.ts';
import { showToast } from './ui/toast.ts';
import { arrangePages, columnsToFill, nearestPage, type Bounds } from './document/arrange.ts';
import { LayoutClient } from './layout/layoutClient.ts';
import { MAX_SHARED_TEXT_BYTES } from '@golemdocs/ops/textOps';
import type { TextRoom } from './textEditor/view.ts';
import { FONT_BASE, type DocumentSource, type LayoutUpdate, type RoomOptions, type RoomState, type SelectionUpdate, type SpellIssue, type WireCommand, type WordStats } from './layout/protocol.ts';
import { ImageRenderer } from './webgl/shapes/imageRenderer.ts';
import { AtlasLibrary } from './webgl/text/gpuFace.ts';
import { Camera, CSS_PX_PER_POINT } from './view/camera.ts';
import { GpuPage } from './webgl/gpuPage.ts';
import { PageRenderer, type FrameStats } from './webgl/pageRenderer.ts';
import { getLocale, initLocale, t, type MessageKey } from './i18n/index.ts';
import { FindDialog } from './ui/findDialog.ts';
import { SpellDialog } from './ui/spellDialog.ts';
import { autoCorrectOptions, autoCorrectReplacements, onAutoCorrect } from './ui/autoCorrect.ts';
import { autoFormatOn, onAutoFormat } from './ui/autoFormat.ts';
import { livePreviewOn, onLivePreview } from './ui/livePreview.ts';
import { SpellMenu } from './ui/spellMenu.ts';
import { loadIgnored, saveIgnored, withIgnored, type Ignored } from './spelling/ignored.ts';
import { showColumnsDialog } from './ui/columnsDialog.ts';
import { showParagraphDialog } from './ui/paragraphDialog.ts';
import { showPageSetupDialog } from './ui/pageSetupDialog.ts';
import { readClipboard, type Clipboard } from './ui/clipboard.ts';
import { showPasteSpecialDialog } from './ui/pasteSpecialDialog.ts';
import { attachTextInput, editKey, type EditKey } from './ui/textInput.ts';
import { cleanDocumentName } from './documentName.ts';
import { PropertiesDialog } from './ui/propertiesDialog.ts';
import { TrashDialog } from './ui/trashDialog.ts';
import { VersionHistoryDialog } from './ui/versionHistoryDialog.ts';
import { loadTrash, restoreById, type TrashDeps, type TrashItem } from './trash.ts';
import { TRASH_MS } from '@golemdocs/ops';
import { deviceVersionBytes, loadHistory, restoreFromAccount, restoredName, saveNamedVersion, type HistoryEntry, type HistoryTarget } from './history.ts';
import { WordCountDialog } from './ui/wordCountDialog.ts';
import { showOptions } from './ui/optionsDialog.ts';
import { Footer } from './ui/footer.ts';
import { Ruler } from './ui/ruler.ts';
import { showSplitDialog, showTableDialog } from './ui/tableDialog.ts';
import { CropLayer } from './ui/cropLayer.ts';
import { DrawLayer, isDrawTool } from './ui/drawLayer.ts';
import type { VectorSession } from './ui/vectorSession.ts';
import { askDropChoice } from './ui/dropChoice.ts';
import { askDuplicate } from './ui/duplicateDialog.ts';
import type { DocumentEngine } from './documentEngine.ts';
import { TextEditor } from './textEditor/handle.ts';
import { showAdjustDialog, showBackgroundDialog, showPictureCanvasDialog, showResizeDialog } from './ui/pictureDialogs.ts';
import { PictureLayersPanel } from './ui/pictureLayersPanel.ts';
import { samplePicture } from './formats/imageSample.ts';
import { DEFAULT_DRAW_STYLE, paintOf } from './formats/imageDraw.ts';
import type { DrawStyle, Shape } from './formats/imageDraw.ts';
import { applyImageEdit, type ImageEdit } from './formats/imageEdit.ts';
import type { ChromeState, ImageOp } from './ui/actions.ts';
import { opensLink, showLinkDialog } from './ui/linkDialog.ts';
import { droppedDocumentKey, isDocumentDrag } from './ui/documentDrag.ts';
import { SelectionLayer } from './webgl/selectionLayer.ts';
import { isFormat, type Format } from './formats/convert.ts';
import { isZipName, sourceFromFile, stem } from './formats/source.ts';
import { sniffImage } from './formats/images.ts';
import { LARGE_TEXT_BYTES, hasExtension, isProseName, textFileName, usesTextEngine, toUtf8WithEncoding } from './formats/textFiles.ts';
import { isVectorFormat } from './formats/roomDoc.ts';
import { ensureUids } from './vector/nodes.ts';
import type { Scene } from './vector/model.ts';
import type { Collaboration } from './assistant/appTools.ts';
import { docAddress, findByTitle, parseDocAddress, splitLink, normalizeTitle, type LinkPlaces } from './formats/wikiLinks.ts';
import { rewriteDocumentLinks } from './formats/docLinks.ts';
import { afterChange, anyMoved, placedDocs, retargets, shortestTitle, type LibraryChange, type LibrarySnapshot } from './linkRename.ts';
import { decodeImage, encodeCanvas, makeCanvas, toPng, transcode } from './formats/imageCodec.ts';
import { MAX_PIXELS, MAX_SIDE } from './formats/imagePixels.ts';
import { DEFAULT_STATE, FORMATS, PICTURE_KINDS, VECTOR_KINDS, initTooltips, pointerTip, kindFromName, mountChrome, type DocumentKind, type DocumentSync, type FormatState, type FormMode, type SyncStatus, type ViewMode } from './ui/index.ts';
import { modalOpen } from './ui/dom.ts';

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

// The status bar (View > Status Bar): on until turned off, then remembered in this browser.
const FOOTER_KEY = 'word.footer';
let footerOn = true;
try {
  footerOn = localStorage.getItem(FOOTER_KEY) !== 'off';
} catch {
  // Storage unavailable: the bar starts on.
}

// The toolbars (View > Toolbars > Show Toolbars): on until turned off, then remembered in this browser.
const TOOLBARS_KEY = 'word.toolbarsShown';
let toolbarsOn = true;
try {
  toolbarsOn = localStorage.getItem(TOOLBARS_KEY) !== 'off';
} catch {
  // Storage unavailable: the toolbars start on.
}

// The ruler (View > Ruler): off until turned on, then remembered in this browser.
const RULER_KEY = 'word.ruler';
let rulerOn = false;
try {
  rulerOn = localStorage.getItem(RULER_KEY) === 'on';
} catch {
  // Storage unavailable: the ruler starts off.
}

/** The counts of the whole document and of the selection, as the worker last gave them (null: none, or not asked for yet). */
let footerWords: WordStats | null = null;
let footerSelection: WordStats | null = null;
let footerTimer = 0;
/** The pixel size of the open picture, found once per opening (and which are being looked up). */
const pictureSizes = new WeakMap<object, { width: number; height: number }>();
const pictureSizing = new WeakSet<object>();

// View: Print layout (pages) or Flow (the text reflowed to the window). Remembered in this browser. The third
// view, the page grid, is `grid`: it is left when another document opens, back to this one.
const VIEW_KEY = 'word.viewMode';
// With no saved choice, a phone-sized screen starts in Flow (a page shrunk to fit is unreadable there).
let viewMode: Exclude<ViewMode, 'grid'> = window.matchMedia('(max-width: 720px)').matches ? 'flow' : 'print';
try {
  const saved = localStorage.getItem(VIEW_KEY);
  // 'normal' is Flow's earlier name.
  if (saved === 'flow' || saved === 'normal') viewMode = 'flow';
  else if (saved === 'print') viewMode = saved;
} catch {
  // Storage unavailable: use the default for this screen.
}

let earlySaved: { id: string; saved: Promise<Awaited<ReturnType<typeof getSaved>>> } | null = null;
{
  const params = new URLSearchParams(location.search);
  const wanted = wantedDoc(params) ?? lastDoc();
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
/** A PDF is shown as its own pages, which take markup annotations. */
let annotating = false;
/** A PDF's pages: filling in its form, or editing the form itself. */
let formMode: FormMode = 'fill';
let status = '';
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
const textCaret = (): boolean => !grid && !annotating && !isPicture() && !isDrawing();

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
  if (source.kind === 'svg') return kindFromName(source.name, 'svg');
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

/** Opens, and opens asked for: one that waits for something first (a download, say) doesn't replace a document opened since. */
let openRequests = 0;

/** For an open that waits for something first: says whether it is still the latest one asked for. */
function openTicket(): () => boolean {
  const ticket = ++openRequests;
  return () => ticket === openRequests;
}

/** `keepRoom`: the same document, opened again in place of itself (watching it, it was saved): it keeps its room; `version`: the save it is. */
type OpenOptions = { detour?: boolean; grid?: boolean; localId?: string; cloudId?: string; shared?: CloudDocument; pictureEdit?: boolean; keepRoom?: boolean; version?: number; store?: boolean; asDocument?: boolean };

/** Everything that starts a new document, before whatever shows it is asked for it: the old one is put away, the page's state is reset, and `current` is the new one. */
function beginOpen(source: DocumentSource, options: OpenOptions): { name: string; opening: OpenDocument } {
  keepCamera = !!options.pictureEdit && source.kind === 'svg';
  // Going anywhere but back to the document leaves the picture that was taken from it.
  if (!options.detour && pictureDetour) {
    pictureDetour = null;
    pictureDetourBar.update(null);
  }
  const name = 'name' in source ? source.name : source.kind === 'welcome' ? t('app.welcomeName') : source.kind === 'legal' ? t(source.page === 'privacy' ? 'app.privacyName' : 'app.termsName') : source.kind === 'changelog' ? t('app.changelogName') : t('app.fontsName');
  saveIfEdited(); // the worker is asked for the bytes now, before it switches documents
  rememberView();
  viewDocKey = wantedDocKey;
  wantedDocKey = null;
  pendingView = viewDocKey ? loadView(viewDocKey) : null;
  commandsAtOpen = commandsSent;
  viewRestored = false;
  cropLayer.cancel();
  leaveTextRoom();
  textView.close();
  drawLayer.cancel();
  // A drawing that was changed comes back as the same drawing, with the editor's own copy still in front of it.
  if (!options.pictureEdit) {
    embeddedDrawing = null;
    vector?.closeEmbedded();
    vector?.editor.close();
  }
  // A picture that was changed comes back as the same document, so its undo history goes on; any other opening starts afresh.
  if (!options.pictureEdit) pictureHistory = { undo: [], redo: [] };
  current = {
    localId: options.localId ?? null,
    unsavedSince: 0,
    builtIn: source.kind === 'welcome' || source.kind === 'legal' || source.kind === 'changelog' || source.kind === 'fonts',
    room: null,
    roomRequested: false,
    ignored: { words: [], rules: [] },
    shared: options.shared?.role === 'editor' || options.shared?.role === 'viewer' ? { id: options.shared.id, role: options.shared.role, dirty: false, uploading: false, error: null } : null,
    newFolder: options.localId ? null : newDocumentFolder,
    name,
    kind: kindOfSource(source),
    ...(options.detour && { detour: true }),
  };
  if (!current.builtIn) rememberNewKind(current.kind);
  // Meant for this document only: a later one isn't filed there by mistake.
  newDocumentFolder = null;
  const opening = current;
  showSync();
  // A changed drawing keeps showing its old page until the new one is laid out, so nothing flashes in between.
  keepPages = !!options.pictureEdit && source.kind === 'svg' && pages.length > 0;
  if (!keepPages) {
    for (const page of pagesById.values()) page.dispose(gl!);
    pagesById.clear();
    pages = [];
    pagesPanel.setPages(pages);
  }
  selection.clear();
  commentsPanel.reset();
  comments = [];
  formLayer.update(null);
  pdfTextLayer.update(null);
  pdfTools.update(null, null);
  pointerLayer.update([]);
  setSelectedPicture(null);
  formMode = 'fill';
  formLayer.setMode(formMode);
  pdfTools.setMode(formMode);
  selectionFormat = {};
  canUndo = canRedo = false;
  footerWords = footerSelection = null;
  window.clearTimeout(footerTimer);
  // One renderer for every document: clear() drops the old textures and any loads still under way.
  renderer.images?.clear();
  renderer.images ??= new ImageRenderer(gl!, { bytes: (part) => worker.media(part) }, assetLoaded, requestRender);
  grid = options.grid ?? false;
  loaded = false;
  cameraPlaced = false;
  userMoved = false;
  editTimes = null;
  loadTimes = null;
  pendingNotice = null;
  annotating = false;
  sharedDeviceNotice.update({ welcome: source.kind === 'welcome' || source.kind === 'legal' || source.kind === 'changelog' });
  setStatus(t('app.loading', { name }));

  layerSteps = { canUndo: false, canRedo: false };
  vectorSteps = { canUndo: false, canRedo: false };
  latestVectorScene = null;
  drawLayer.unbind();
  drawLayer.setBase(null);
  baseFor = null;
  return { name, opening };
}

function open(source: DocumentSource, options: OpenOptions = {}): void {
  // Plain text is edited in the text editor, not as a document (`asDocument`: for the things only a document does, such as printing).
  if (source.kind === 'txt' && !options.asDocument) {
    void openLarge(source.name, new Uint8Array(source.bytes), options);
    return;
  }
  openRequests++;
  // A changed drawing in the text is put back in its document first, so the change is saved with it; then this opens (unless another was asked for meanwhile).
  if (embeddedDrawing?.latest != null && !options.pictureEdit) {
    const still = openTicket();
    void leaveEmbeddedDrawing(false).then(() => still() && open(source, options));
    return;
  }
  const start = performance.now();
  // A changed picture or drawing (or one watched, saved by whoever holds it) opened in place of itself keeps its room rather than
  // leaving and joining again (when nothing is edited together in it).
  const keptRoom = (options.pictureEdit || options.keepRoom) && current.room?.mode === 'solo' ? current.room : null;
  let { name, opening } = beginOpen(source, options);
  let firstPage = 0;
  const requestedRoom = keptRoom ? undefined : networkRoom(options.cloudId ?? options.shared?.id);
  current.roomRequested = keptRoom !== null || requestedRoom !== undefined;
  current.room = keptRoom;
  showWatch();
  worker.open(source, {
    opened(docName, format, fixedPages, outdated) {
      name = opening.name = docName;
      opening.kind = format;
      annotating = fixedPages;
      // A document saved by an older version as plain text (a .wdoc of the text lens): the text editor takes it from here.
      if (format === 'txt' && !options.asDocument && !options.pictureEdit) void migrateText(current, docName, options);
      if (outdated) pendingNotice = outdatedPages();
      spellDialog.sendLive();
      startIgnored(current);
      worker.command({ kind: 'autoFormat', on: autoFormatOn() });
      worker.command({ kind: 'autoCorrect', options: autoCorrectOptions(), replacements: autoCorrectReplacements() });
      worker.command({ kind: 'livePreview', on: livePreviewOn() });
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
      if (isDrawing()) void showDrawing();
      documentReady();
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
      if (pendingJump) {
        const jump = pendingJump;
        pendingJump = null;
        if (jump.source === viewDocKey) goToHit(jump);
      }
      if (pendingPicture && pendingPicture.source === viewDocKey) putEditedPicture(pendingPicture);
      pendingPicture = null;
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
      else if (doc.shared && !doc.shared.dirty) void openShared(doc.shared.id);
    },
    roomState(state) {
      roomStateChanged(state);
    },
    roomGone() {
      roomGone(opening);
    },
    roomSaved(updatedAt) {
      void refreshWatched(opening, updatedAt);
    },
    roomRelease() {
      void releaseRoom(opening);
    },
    roomFlush() {
      if (opening === current) void saveAndSend();
    },
    pointers(list) {
      pointerLayer.update(list);
    },
    remoteEdit() {
      // Other people's edits are part of this document too, so they're kept in this browser.
      documentEdited();
    },
    error(message) {
      loaded = true;
      documentReady();
      reportError(t('app.documentError', { name, message }));
    },
    notice: (message) => reportError(message),
    vectorScene(state) {
      vectorSteps = { canUndo: state.canUndo, canRedo: state.canRedo };
      if (state.scene) {
        latestVectorScene = state.scene;
        if (vector?.editor.active) vector.syncScene(state.scene);
        pagesPanel.refresh();
      }
      requestRender();
    },
    shapes(state) {
      layerSteps = { canUndo: state.canUndo, canRedo: state.canRedo };
      drawLayer.bind(state.width, state.height, state.shapes);
      if (isPicture()) void loadPictureBase();
      requestRender();
      const echo = shapesEcho;
      shapesEcho = null;
      echo?.();
    },
  }, requestedRoom, keptRoom !== null, keptRoom ? options.version : undefined);
  focusInput();
}

// --- Documents edited one person at a time (PDFs, pictures: see ROOM_POLICY in @golemdocs/ops) ---------------------------------

/** Saves the open document and sends it to the account now, rather than after the usual pause. */
async function saveAndSend(): Promise<void> {
  const doc = current;
  saveIfEdited();
  await saving;
  if (doc.shared) await uploadShared();
  else await flushUploads();
}

/** Someone takes over the document this person holds: what they have is saved and sent first, then it is theirs. */
async function releaseRoom(doc: OpenDocument): Promise<void> {
  if (current !== doc) return;
  try {
    await saveAndSend();
  } finally {
    if (current === doc) worker.roomReleased();
  }
}

const WATCHED_RETRY_MS = 3000;

/** The newest version of a watched document asked to be shown, while one is being opened (it is opened next). */
let watchedNext: number | null = null;
let watchedOpening = false;

/**
 * Watching a document someone else holds, it was saved: it is opened again from the account, as it is now, keeping its room and
 * where it was scrolled to. Saves that arrive while it is being opened are taken together, once it is.
 */
async function refreshWatched(doc: OpenDocument, updatedAt?: number): Promise<void> {
  if (current !== doc || !(doc.room?.watching || doc.room?.catchingUp)) return;
  if (watchedOpening) {
    watchedNext = Math.max(watchedNext ?? 0, updatedAt ?? 0);
    return;
  }
  watchedOpening = true;
  try {
    const shared = doc.shared ? sharedDocs.get(doc.shared.id) : undefined;
    const cloudId = library.local.find((d) => d.id === doc.localId)?.cloudId;
    if (current !== doc) return;
    wantedDocKey = viewDocKey; // back where it was
    if (shared) open({ kind: 'docx-url', name: shared.name, url: documentUrl(shared.id) }, { shared, keepRoom: true, version: updatedAt });
    else if (cloudId) {
      const { info, bytes } = await openFromCloud({ id: cloudId, name: doc.name, updatedAt }, account?.id);
      if (current !== doc) return;
      const source = sourceFromFile(info.name, bytes) ?? { kind: 'docx', name: info.name, bytes };
      open(source, { localId: info.id, cloudId, keepRoom: true, version: updatedAt });
    }
  } catch (e) {
    // It stays as it is (and can't be changed) until it can be opened again.
    console.warn('could not open the saved document again', e);
    window.setTimeout(() => void refreshWatched(doc, updatedAt), WATCHED_RETRY_MS);
  } finally {
    watchedOpening = false;
    const next = watchedNext;
    watchedNext = null;
    if (next !== null) void refreshWatched(current, next || undefined);
  }
}

/** Someone else holds the open document (one edited by one person at a time): says so, and is true. Also true, saying nothing, for a moment while its newest save is being opened. */
function refuseWhileWatching(): boolean {
  const room = current.room;
  if (!room?.watching) return !!room?.catchingUp;
  reportError(room.holder?.mine ? t('room.watchingMineNoEdit') : t('room.watchingNoEdit', { name: room.holder?.name ?? '' }));
  return true;
}

/** For the assistant: why the open document can't be changed while someone else holds it. */
function whyWatching(): string {
  const holder = current.room?.holder;
  return holder?.mine
    ? 'the person is editing this document on another of their devices, so it can only be looked at here; take it over (collaboration take_over) to change it.'
    : `${holder?.name ?? 'someone else'} is editing this document now, so it can only be looked at; take it over (collaboration take_over) to change it.`;
}

/**
 * Watching a document someone else holds, this copy has changes the account doesn't (made here before it was opened, say): they are
 * kept as a "(conflicted copy)" in the account, never sent over the holder's, and the holder's version is opened in their place.
 */
let keeping: Promise<unknown> = Promise.resolve();

async function keepWatchedEdits(doc: OpenDocument): Promise<void> {
  const id = doc.localId;
  if (!id) return;
  // One at a time: the second finds nothing left to keep.
  const turn = keeping.then(() => saving).then(() => keepAsConflictCopy(id));
  keeping = turn.catch(() => {});
  const kept = await turn;
  if (!kept) return;
  library.putCloud(kept);
  putDocInCatalogue(kept);
  if (current === doc) notify(t('room.keptAsCopy', { name: kept.name }));
  void refreshWatched(doc);
}

/** Asks to hold the open document someone else is editing (it is theirs to save first). */
function takeOverEditing(): boolean {
  if (!current.room?.watching) return false;
  worker.takeOver();
  setStatus(t('room.takingOver'));
  return true;
}

/**
 * The document has no room after all: it could not be joined, or the connection was lost while this person was alone in it. It is
 * edited and saved as if it never had one, and the room is joined again once the document is next saved to the account.
 */
function roomGone(doc: OpenDocument): void {
  if (current !== doc) return;
  doc.room = null;
  doc.roomRequested = false;
  lastRoomText = '';
  pointerLayer.update([]);
  showWatch();
  showSync();
  requestRender();
}

/** A plain text document opened by the layout worker (one saved by an older version) is given to the text editor, as the text it says. */
async function migrateText(doc: OpenDocument, name: string, options: { localId?: string; shared?: CloudDocument }): Promise<void> {
  try {
    const notice = pendingNotice; // the switch that made it text says what it left out
    const bytes = await worker.convert('txt');
    if (current !== doc) return;
    await openLarge(name, bytes, { localId: options.localId, shared: options.shared });
    // The text editor is ready at once, so the notice is said now rather than held for a worker that has nothing to load.
    if (notice) setStatus(notice);
  } catch (e) {
    console.error(e);
  }
}

/** Where the document stands in its room changed (from the layout worker for a document, from the text editor's own room for a text file). */
function roomStateChanged(state: RoomState): void {
  const doc = current;
  const was = doc.room;
  doc.room = state;
  const text = describeRoom(state);
  if (text !== lastRoomText) notify(text || t('app.editingAlone'));
  lastRoomText = text;
  // The server saves while several people are editing: an upload from here would be refused.
  if (state.mode !== 'solo' && doc.localId) void uploads.forget([doc.localId]);
  // Back to saving from here: the server's last version is what this copy now continues from.
  if (was && was.mode !== 'solo' && state.mode === 'solo') void resumeAfterRoom(doc);
  if (state.mode === 'offline') {
    notify(t('app.roomLost'));
    if (was?.mode !== 'offline') rejoinWhenBack(doc);
  }
  // Watching, with changes made here that the account doesn't have: kept as a copy, and the holder's version opened instead.
  if (state.watching && !was?.watching && doc.localId) {
    saveIfEdited();
    void keepWatchedEdits(doc).catch((e) => console.warn('could not keep the changes made here', e));
  }
  // Holding the document now (someone left it, or it was taken over): it can be edited. Watching now: what was being drawn or cropped is let go.
  if (was?.watching && !state.watching && state.mode !== 'offline') notify(t('room.nowEditing'));
  if (state.watching && !was?.watching) {
    drawLayer.cancel();
    cropLayer.cancel();
  }
  showWatch();
  showSync();
  requestRender();
}

let textRoomHandle: TextRoom | null = null;

function leaveTextRoom(): void {
  textRoomHandle?.client.leave();
  textRoomHandle = null;
}

/** A big text file in the account is edited together with others in a room of its own (see textEditor/textSync.ts), joined here like a document's room is joined by the layout worker. */
async function joinTextRoom(doc: OpenDocument, cloudId: string): Promise<void> {
  const view = textView.editor;
  const room = networkRoom(cloudId);
  if (!view || !room || doc.roomRequested || current !== doc) return;
  if (textView.size > MAX_SHARED_TEXT_BYTES) return notify(t('textEditor.tooBigToShare', { max: '16 MB' }));
  doc.roomRequested = true;
  const handle = await textView.room({
    docId: cloudId,
    client: crypto.randomUUID(),
    name: room.user,
    color: room.color,
    view: () => (textView.editor === view ? view : null),
    changed: (state) => {
      if (current !== doc) return;
      view.readOnly = state.role === 'viewer';
      roomStateChanged(state);
    },
    remoteEdit: () => {
      if (current === doc) documentEdited();
    },
    upload: async (bytes) => {
      await saveDocument(cloudId, bytes);
    },
    lost: () => {
      if (textRoomHandle === handle) leaveTextRoom();
      roomGone(doc);
    },
  });
  textRoomHandle = handle;
  try {
    const start = await handle.client.join();
    if (current !== doc || textView.editor !== view) return handle.client.leave();
    // Others are editing: the room's file is the one to open (as UTF-8: a room keeps it so whatever the file was).
    if (start.kind === 'room') textView.open(textView.fileName, start.bytes, { encoding: 'utf-8', bom: false, original: null });
    handle.client.ready(start);
  } catch {
    // No room to be had: the file is edited alone, and saved as usual.
    handle.client.leave();
    if (textRoomHandle === handle) textRoomHandle = null;
    doc.roomRequested = false;
  }
}

// --- Collaboration ---------------------------------------------------------------------
// A cloud document is edited together with others in the multiplayer server's room (see collab/roomClient.ts).

const USER_COLORS = [0xe8590c, 0x2f9e44, 0x7048e8, 0xd6336c, 0x1098ad, 0xf08c00];
const userColor = USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
const guestNumber = Math.floor(Math.random() * 900 + 100);
const guestName = (): string => t('app.guestName', { number: guestNumber });

/** The multiplayer server's room for a cloud document, when signed in (else the document is edited on its own). */
function networkRoom(cloudId: string | undefined): RoomOptions | undefined {
  if (!cloudId || !account) return undefined;
  return { docId: cloudId, user: account.name ?? account.email ?? guestName(), color: userColor };
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
    const info = library.local.find((d) => d.id === doc.localId);
    const cloud = info?.cloudId ? (await listDocuments()).find((d) => d.id === info.cloudId) : undefined;
    if (doc === current && info?.cloudId && cloud) {
      // Only the version it continues from changes; edits made since still count as unsent.
      await markSynced(info.id, { cloudId: info.cloudId, syncedAt: info.cloudSyncedAt ?? 0, cloudUpdatedAt: cloud.updatedAt });
      library.putCloud(cloud);
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

/** Others may be editing the open document with this person now (a room). */
const sharedLive = (): boolean => current.room?.mode === 'shared';


window.addEventListener('pagehide', () => {
  rememberView();
  saveIfEdited();
  worker.leave();
});
// Back from the back/forward cache: the room was left on the way out (above), so edits here would
// reach no one. Reloading joins it again, at the view and with the edits saved on the way out.
window.addEventListener('pageshow', (event) => {
  if (event.persisted && current.roomRequested) location.reload();
});

/** The pages of the document before this one are still showing, until the first layout of the new one arrives (see `open`). */
let keepPages = false;

function applyLayout(update: LayoutUpdate): void {
  if (keepPages) {
    keepPages = false;
    for (const page of pagesById.values()) page.dispose(gl!);
    pagesById.clear();
  }
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
  if (newDrawingSince) {
    for (const page of pages) {
      const added = page.images.find((i) => i.svg && !newDrawingSince!.has(i.svg));
      if (added?.svg) {
        newDrawingSince = null;
        void editEmbeddedDrawing(page.id, added.svg);
        break;
      }
    }
  }
}

/** Positions pages; places the camera the first time, and keeps a grid fitted while it grows. */
function arrange(): void {
  // A big text file draws itself, on this camera: the empty document under it must not move it.
  if (textView.active) return;
  const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  const gap = reflowing() ? 0 : PAGE_GAP;
  bounds = arrangePages(pages, grid ? columnsToFill(pages, aspect, gap) : 1, gap);
  if (pages.length && (!cameraPlaced || (grid && !userMoved))) placeCamera();
  requestRender();
}

/** Flow view is on, and applies to this document (not a PDF's own pages, a picture or the page grid). */
function reflowing(): boolean {
  return viewMode === 'flow' && !annotating && !isPicture() && !isDrawing() && !grid;
}

/** Flow view: the width in points the text should fill at the current zoom. */
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
const wordView = (): boolean => !reflowing() && !grid && !isPicture() && !isDrawing();

/** Gray kept beside a page that was zoomed to fit the screen's width. */
const PAGE_FIT_MARGIN_PX = 16;

/** A drawing was just changed and opened again: the view stays where it was. */
let keepCamera = false;

function placeCamera(): void {
  cameraPlaced = true;
  if (keepCamera) {
    keepCamera = false;
    viewRestored = true;
    return;
  }
  const saved = pendingView?.camera;
  if (saved && saved.reflow === reflowing() && !grid) {
    camera.zoom = Math.min(Math.max(saved.zoom, camera.minZoom), camera.maxZoom);
    camera.x = saved.x;
    camera.y = saved.y;
    viewRestored = true;
    return;
  }
  if (reflowing()) {
    // Flow view: the text fills the window from the top, at the zoom the user has.
    camera.x = bounds.x;
    camera.y = bounds.y;
  } else if (grid) {
    camera.fit(bounds, canvas.clientWidth, canvas.clientHeight);
  } else if (isPicture() || isDrawing()) {
    // A picture or drawing: the whole page in view.
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
  document.dispatchEvent(new Event('wm-caret-off'));
  loadingScreen.show(name);
  dashboard.hide();
}

function openFile(file: File): void {
  setUrl(new URLSearchParams(), true);
  chromeHost.openFile(file);
}

/**
 * Opens a document by name.
 * `step` says how the address changes: a new step in history (Back returns to the document before),
 * or `'replace'` for the one at start-up or after a delete, or `'none'` when Back/Forward already moved it.
 */
function openSource(source: string, step: 'push' | 'replace' | 'none' = 'push'): void {
  wantedDocKey = source;
  const params = new URLSearchParams(location.search);
  params.set('doc', source);
  if (step === 'none') noteAddressDoc(source);
  else setUrl(params, step === 'push');
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
  /** What the person chose to ignore in it (Ignore All, Ignore Rule): kept with it, see `ignoredKeys`. */
  ignored: Ignored;
  /**
   * A document someone else owns, opened straight from the cloud: it has no copy in this browser
   * and edits go to the cloud directly (or through the room), never to a copy of it here.
   */
  shared: { id: string; role: 'editor' | 'viewer'; dirty: boolean; uploading: boolean; error: string | null; known?: Set<string> } | null;
  /** The folder a new document goes in when it is first saved (null: the top level). */
  newFolder: string | null;
  /** Its name, as the title shows it and it is saved under. */
  name: string;
  /** What it is edited as: Word, PDF, Markdown, text… It decides which tools are on offer. */
  kind: DocumentKind;
  /** A picture taken from a document to be edited, and put back when done: never saved on its own (see `editPicture`). */
  detour?: boolean;
}

/** A new one per open(), so a save finishing for the previous document can't touch this one. */
let current: OpenDocument = { localId: null, unsavedSince: 0, builtIn: false, room: null, roomRequested: false, ignored: { words: [], rules: [] }, shared: null, newFolder: null, name: '', kind: 'docx' };
/**
 * The folder the next document to open goes in once first saved (null: the top level): set just
 * before it opens (New, Import or a file dropped on a folder), and taken over by open().
 */
let newDocumentFolder: string | null = null;
let autosaveTimer = 0;
/** Saves write one at a time, in order, so a new document's first saves don't each create a copy. */
let saving: Promise<unknown> = Promise.resolve();

/** Schedules a save for once editing pauses. */
function documentEdited(): void {
  if (current.detour) {
    if (pictureDetour) pictureDetour.edited = true;
    return;
  }
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
  // Someone else holds it: never sent over theirs (it can't be changed here meanwhile).
  if (doc.room?.watching || doc.room?.catchingUp) return;
  clearTimeout(sharedTimer);
  shared.dirty = false;
  shared.uploading = true;
  shared.error = null;
  showSync();
  try {
    // No name: only the owner renames it (`fileName()` would also be the next document's, if one is
    // being opened). The whole document goes, so what it is edited as (Markdown...) is kept.
    const bytes = (textView.active ? textEngine.snapshot() : null) ?? (await worker.save());
    if (bytes.length >= CHUNK_MIN_FILE) {
      // A big document goes as chunks, and after the first save of this session only those that changed.
      const { manifest, fresh } = await chunkBytes(bytes);
      const byHash = new Map(fresh.map((c) => [c.hash, c.bytes]));
      putDocInCatalogue(await saveChunked(shared.id, manifest, async (hashes) => hashes.map((hash) => ({ hash, bytes: byHash.get(hash)! })), shared.known ?? new Set()));
      shared.known = new Set(manifest.chunks.map((c) => c.h));
    } else {
      putDocInCatalogue(await saveDocument(shared.id, bytes));
      shared.known = undefined;
    }
    library.refreshSoon();
    // Without a room (it could not be reached when the document opened): try it again now the account answers.
    joinRoomOf(doc, shared.id);
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
/** Where to go in the document being opened, once it is: the paragraph a search found it by (see openSearchHit). */
let pendingJump: { source: string; paragraph?: number; find: string } | null = null;

/** Who is signed in; null signed out. Offline, whoever was last time (see auth.ts). */
let signedIn: User | null = null;
/**
 * The signed-in user whose documents live in the cloud: `signedIn`, when they have sync. Without it
 * (no subscription) they are saved in this browser, as for someone signed out.
 */
let account: User | null = null;
/** `connect()` has finished once: until then `account` is only a guess (see `accountForFiles`). */
let accountResolved = false;
/**
 * The account the Files Sidebar lists for. On load, before the server has said who is signed in,
 * that is whoever was last, so the sidebar can show its saved catalogue at once instead of waiting
 * for the sign-in, plan and listing round trips.
 */
function accountForFiles(): User | null {
  return accountResolved ? account : (remembered() ?? account);
}
/** Whose documents the library last listed: when it changes, it starts again from theirs. */
let drawnFor: string | null = null;
/**
 * The library (see libraryStore.ts): this browser's copies of the documents in view (the account's,
 * or signed out, the browser's own), the account's documents as last listed, and their folders.
 * The Documents screen and the Files Sidebar show this same copy.
 */
const library = new LibraryStore({
  account: () => accountForFiles(),
  signedIn: () => signedIn,
  listed: ({ signedOut, offline }) => {
    if (!account) return;
    uploads.signedOut = signedOut;
    if (offline) wentOffline();
    // A listing of its own (not only refreshLibrary's) may be what finds out: the button says so.
    showSync();
  },
});

/** The first `connect()`, on load: opening a document in the account waits for it, to know who is signed in. */
let firstConnect: Promise<void> = Promise.resolve();
/** Whether the account syncs is known (`account` is settled): enough to decide whether a document joins its room. */
let markAccountKnown = (): void => {};
const accountKnown = new Promise<void>((resolve) => (markAccountKnown = resolve));

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
  accountResolved = true;
  markAccountKnown();
  // Signed in but no sync (never subscribed, or it ended): what they made here stays in view as this browser's own.
  if (signedIn && !account) await releaseToGuest(signedIn.id).catch(() => {});
  sharedDeviceNotice.update({ signedIn: signedIn !== null });
  assistant.update({ signedIn: signedIn !== null });
  // Interface settings follow the account (and a reload shows what came from it); see settingsSync.ts.
  if (account) void syncSettings(account.id, { reload: reloadForSettings });
  else stopSettingsSync();
  if (account) {
    // Folders made before signing in go to the account first, so the documents in them can be filed there.
    await adoptGuestFolders().catch(() => {});
    const adopted = await adoptGuestDocuments(account.id).catch(() => []);
    if (adopted.length) notify(t('app.adopted', { count: adopted.length }));
  }
  // Someone else's documents (or none, signed out): the library starts again from theirs.
  if ((account?.id ?? null) !== drawnFor) library.reset();
  drawnFor = account?.id ?? null;
  await refreshLibrary();
  if (account) {
    uploads.add(...library.local.filter(hasUnsentChanges).map((info) => info.id));
    void flushUploads();
  }
  showSync();
}

/** Reloads the page to show settings that came from the account, once what is open is saved. */
async function reloadForSettings(): Promise<void> {
  if (cleared) return;
  saveIfEdited();
  await saving.catch(() => {});
  location.reload();
}

/** Refreshes what File ▸ Open Recent lists. */
async function refreshLibrary(): Promise<void> {
  await library.refresh();
  showSync();
}

/** Where to open a listed document from: the account only when this browser's copy is missing or older. */
/** Waiting for a document other than `before` to finish opening (its first layout done, or failed). */
const readyWaiters: { before: OpenDocument; resolve: () => void }[] = [];

function documentReady(): void {
  for (const waiter of readyWaiters.filter((w) => w.before !== current)) {
    readyWaiters.splice(readyWaiters.indexOf(waiter), 1);
    waiter.resolve();
  }
}

/** Resolves once a document other than the one open now has opened (or `ms` have passed, for one that never does). */
function nextDocumentReady(ms = 30_000): Promise<void> {
  const before = current;
  return new Promise((resolve) => {
    const waiter = { before, resolve };
    readyWaiters.push(waiter);
    window.setTimeout(() => {
      const at = readyWaiters.indexOf(waiter);
      if (at >= 0) readyWaiters.splice(at, 1);
      resolve();
    }, ms);
  });
}

function sourceOf(entry: LibraryEntry): string {
  return entry.local && !opensFromCloud(entry) ? `local:${entry.local.id}` : `cloud:${entry.cloud!.id}`;
}

// --- Uploading ------------------------------------------------------------------------------
// Signed in, each save schedules an upload of that document (see uploadQueue.ts, which keeps track
// of what is waiting, offline or signed out); what an upload changes here is below.

/** How long after a save its upload starts (editing usually goes on). */
const UPLOAD_DELAY_MS = 2000;
/** How often to try again while offline (the browser's "online" event isn't always reliable). */
const OFFLINE_RETRY_MS = 30_000;

const uploads = new UploadQueue({
  enabled: () => account !== null,
  send: (id) => upload(id),
  settled: async () => {
    await library.reloadLocal();
    showSync();
    library.refreshSoon();
  },
  // No subscription (it ended, or this page hadn't heard): carry on as someone without sync.
  noSync: () => void connect(Promise.resolve(signedIn)),
  retry: backOnline,
  changed: () => showSync(),
}, { delayMs: UPLOAD_DELAY_MS, offlineRetryMs: OFFLINE_RETRY_MS });

function syncStatus(): SyncStatus {
  if (!account) {
    const info = library.local.find((d) => d.id === current.localId);
    const local = { error: null, savedAt: info?.updatedAt ?? null, localSaved: current.unsavedSince === 0 && info !== undefined };
    return signedIn ? { user: signedIn.email ?? signedIn.name ?? null, picture: signedIn.picture, document: 'unsubscribed', ...local } : { user: null, document: 'guest', ...local };
  }
  const user = account.email ?? account.name ?? null;
  const id = current.localId;
  const info = library.local.find((d) => d.id === id);
  const unsent = current.unsavedSince > 0 || (id !== null && uploads.uploading === id) || (info !== undefined && hasUnsentChanges(info));
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
  if (id && uploads.failures.has(id)) document = 'failed';
  else if (current.room?.mode === 'shared') document = current.room.unconfirmed ? 'saving' : 'saved';
  else if (!unsent) document = 'saved';
  else if (uploads.signedOut) document = 'signedOut';
  else if (uploads.offline) document = 'offline';
  else document = 'saving';
  const savedAt = document === 'saved' ? (info?.cloudSyncedAt ?? null) : null;
  return { user, document, error: document === 'failed' ? uploads.failures.get(id!)! : null, savedAt };
}

function showSync(): void {
  filesPanel.mark();
  chrome.update({ sync: syncStatus() });
}

/** Uploads a browser copy once editing has paused. */
function scheduleUpload(id: string, delay?: number): void {
  uploads.schedule(id, delay);
}

/** Uploads everything waiting, now. Resolves once they have all gone (or can't, for now). */
function flushUploads(): Promise<void> {
  return uploads.flush();
}

/** Joins the open document's room, unless it is in one or has asked: a text file's is its own (see joinTextRoom), a document's the layout worker's. */
function joinRoomOf(doc: OpenDocument, cloudId: string): void {
  if (current !== doc || doc.roomRequested) return;
  if (textView.active) return void joinTextRoom(doc, cloudId);
  const room = networkRoom(cloudId);
  if (!room) return;
  doc.roomRequested = true;
  worker.joinRoom(room);
}

/** One upload: the queue says when (and handles what failing means); here is what it changes on screen. */
async function upload(id: string): Promise<void> {
  // Someone else holds the open document: this copy is never sent over theirs (what it had is kept as a copy instead).
  if (id === current.localId && (current.room?.watching || current.room?.catchingUp)) return keepWatchedEdits(current);
  const before = library.local.find((d) => d.id === id)?.name;
  const { doc, conflictCopy } = await uploadToCloud(id);
  // A document made in this session gets its room once it is in the account (and one without a room, as it could not be reached, tries again).
  if (id === current.localId && !conflictCopy) joinRoomOf(current, doc.id);
  library.putCloud(doc);
  putDocInCatalogue(doc);
  if (conflictCopy) {
    if (id === current.localId) {
      current.name = doc.name;
      chrome.update({ documentName: doc.name });
    }
    notify(t('app.conflictNotice', { before: before ?? t('app.thisDocument'), name: doc.name }));
  }
}

/** The account can't be reached: uploads wait, and are tried again every so often. */
function wentOffline(): void {
  uploads.wentOffline();
}

function backOnline(): void {
  if (!account) return;
  uploads.backOnline();
  void connect();
}

window.addEventListener('online', backOnline);

/** Tries the uploads that failed again, now (the button's Try again). */
async function syncNow(): Promise<void> {
  saveIfEdited();
  await saving;
  uploads.failures.clear();
  uploads.backOnline();
  uploads.add(...library.local.filter(hasUnsentChanges).map((info) => info.id));
  showSync();
  await flushUploads();
}

/** Tells the user something now, or once the document being loaded has finished. */
function notify(message: string): void {
  if (loaded) setStatus(message);
  else pendingNotice = message;
}

/** How often a document whose room was lost tries to open again (as well as when the browser is back online). */
const ROOM_RETRY_MS = 30_000;

/**
 * A cloud document whose room connection is lost for good (a laptop asleep, say) can no longer be
 * edited. Once the connection seems back, it is opened again from its copy here, which joins the
 * room again (or, if the room still can't be reached, edits it on its own until it can).
 */
function rejoinWhenBack(doc: OpenDocument): void {
  const stop = (): void => {
    clearInterval(timer);
    window.removeEventListener('online', retry);
  };
  const retry = (): void => {
    if (current !== doc || doc.room?.mode !== 'offline' || !doc.localId) return stop();
    if (!navigator.onLine) return;
    stop();
    rememberView();
    openSource(`local:${doc.localId}`, 'none');
  };
  const timer = window.setInterval(retry, ROOM_RETRY_MS);
  window.addEventListener('online', retry);
}

/** Makes reloading the page reopen this document. */
function rememberInUrl(doc: string): void {
  const params = new URLSearchParams(location.search);
  params.set('doc', doc);
  setUrl(params);
  viewDocKey ??= doc; // a new document, saved for the first time
  if (doc.startsWith('local:')) rememberLastDoc(doc);
}

/** Whether the open document can be renamed: not one of the built-in pages, nor one shared by someone else. */
const NO_PEOPLE: ChromeState['people'] = [];
const renamable = () => !current.builtIn && !current.shared;

/** Gives the open document a new name (cleaned for a file name) and saves it under that name. Returns the name kept, or null. */
function renameDocument(input: string): string | null {
  const name = cleanDocumentName(input);
  if (!name || !renamable()) return null;
  if (name === current.name) return name;
  current.name = name;
  chrome.update({ documentName: name });
  documentEdited(); // saved under the new name, which goes on to the account too
  return current.name;
}

/** The name a download or save gets: the format's extension, except that a text file keeps the one it came with ("config.json", "main.py"). */
const fileName = () => (textView.active ? textFileNameOf(textView.fileName) : current.kind === 'txt' && hasExtension(current.name) ? current.name : stem(current.name) + FORMATS[current.kind].extensions[0]);
const returnTo = (params: Record<string, string>) => `${location.pathname}?${new URLSearchParams(params)}`;

/** File ▸ Download All: every document saved in this browser (or the account's copies), as one ZIP. */
async function downloadAll(): Promise<void> {
  try {
    const docs = (await Promise.all(library.local.map((d) => getSaved(d.id)))).filter((d) => d !== null);
    if (docs.length === 0) return setStatus(t('app.downloadAllNone'));
    // Folder ids are unique, so the account's folders and this browser's can be looked up together.
    const folders = [...(account ? await listFolders().catch(() => []) : []), ...(await listLocalFolders().catch(() => []))];
    const placed = new Map(library.entries.filter((e) => e.local).map((e) => [e.local!.id, e.folderId]));
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

/** How often a ZIP import shows what it has added so far in the dashboard and the Files panel. */
const IMPORT_REFRESH_MS = 1000;
/** Into the account the lists cost the server requests to Cloudflare's API, which limits them, so they are shown less often. */
const IMPORT_CLOUD_REFRESH_MS = 15_000;
/** A ZIP's documents are sent to the account this many at a time (or this many bytes, if that comes first). */
const IMPORT_UPLOAD_COUNT = 50;
const IMPORT_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * File ▸ Import of a ZIP: its documents go in the folders they were in (made as needed, or the ones
 * here with the same names), and keep to their own names, with " (2)" and so on where one is taken.
 * From the dashboard, the ZIP's top level goes in the folder being looked at.
 */
async function importZip(file: File): Promise<void> {
  await importDocuments(file.name, async (signal, onProgress) => readZipFiles(new Uint8Array(await file.arrayBuffer()), { signal, onProgress }));
}

/** Several files or a folder dropped from the computer: imported as a ZIP is (see storage/droppedFiles.ts). */
function importDropped(drop: Extract<Dropped, { kind: 'import' }>): Promise<void> {
  return importDocuments(drop.name, () => drop.read());
}

/**
 * Imports documents (a ZIP's, or files dropped together) into their folders, made as needed, or the
 * ones here with the same names; `name` is what they came in, for the progress card.
 */
async function importDocuments(name: string, read: (signal: AbortSignal, onProgress: (done: number, total: number) => void) => Promise<ZipContents>): Promise<void> {
  const root = newDocumentFolder;
  newDocumentFolder = null;
  const progress = showProgress(t('app.importingZip', { name }));
  // Saved here but not sent yet: if the import stops part way, these go the ordinary way.
  let waiting: string[] = [];
  let waitingBytes = 0;
  // The card was left to close itself after showing the end.
  let finished = false;
  // Reading the ZIP is the first 10% of the bar (it is quick), saving what is in it the rest.
  const READ_SHARE = 10;
  try {
    setStatus(t('app.importingZip', { name }));
    const { files, skipped } = await read(progress.signal, (done, total) => progress.update((done / total) * READ_SHARE, 100, t('app.importProgress', { done, total })));
    if (!files.length) return setStatus(t('app.importZipNone', { name }));
    const cloud = account !== null;
    // Not guessed from nothing: a folder list that can't be read would make every folder a duplicate.
    const folders = cloud ? await listFolders() : await listLocalFolders();
    const owner = account?.id;
    // What has been imported so far shows in the lists as it lands, not all at the end.
    let shownAt = 0;
    const showSoFar = (): void => {
      if (Date.now() - shownAt < (cloud ? IMPORT_CLOUD_REFRESH_MS : IMPORT_REFRESH_MS)) return;
      shownAt = Date.now();
      void refreshLibrary();
    };
    const sendWaiting = async (): Promise<void> => {
      const ids = waiting;
      waiting = [];
      waitingBytes = 0;
      await uploads.sendBatch(ids, async (still) => {
        const made = await uploadNewToCloud(still);
        library.putCloud(...made.values());
        return made.keys();
      });
      await library.reloadLocal();
      showSync();
    };
    // A picture is kept as the PNG it opens as (GIF, BMP and SVG); null if it can't be read.
    const kept = async (name: string, bytes: Uint8Array): Promise<{ name: string; bytes: Uint8Array } | null> => {
      if (sourceFromFile(name, new ArrayBuffer(0))?.kind !== 'image') return { name, bytes };
      try {
        return await toPng(name, bytes);
      } catch {
        return null;
      }
    };
    progress.startTimer();
    const result = await importFiles(files, {
      folders,
      documents: library.entries.map((e) => ({ id: e.key, name: e.name, folderId: folderOf({ local: { folderId: e.folderId } }, folders) })),
      root: root !== null && folders.some((f) => f.id === root) ? root : null,
      signal: progress.signal,
      onProgress: (done, total) => progress.update(READ_SHARE + (done / total) * (100 - READ_SHARE), 100, t('app.importProgress', { done, total })),
      async makeFolder(name, parentId) {
        return createFolder(cloud, name, parentId);
      },
      async same(id, name, bytes) {
        const entry = library.entries.find((e) => e.key === id);
        const doc = entry && (await kept(name, bytes));
        if (!entry || !doc) return false;
        try {
          // The copy that is current: this browser's, else the account's. Sizes first, as they are free (the listing has them).
          if (entry.local && !opensFromCloud(entry)) {
            if (entry.local.size !== doc.bytes.byteLength) return false;
            const saved = await getSaved(entry.local.id);
            return !!saved && sameBytes(saved.bytes, doc.bytes);
          }
          if (!entry.cloud || entry.cloud.size !== doc.bytes.byteLength) return false;
          // Same size: one download (a read, no egress charge) is cheaper than overwriting and re-syncing everywhere.
          return sameBytes(await downloadDocument(entry.cloud.id), doc.bytes);
        } catch {
          return false; // can't be read now (busy, offline): the user decides
        }
      },
      async replace(id, name, bytes) {
        const entry = library.entries.find((e) => e.key === id);
        const doc = entry && (await kept(name, bytes));
        if (!entry || !doc) return false;
        let saved: SavedInfo;
        if (entry.local) saved = await saveSaved({ id: entry.local.id, name: entry.name, bytes: doc.bytes });
        else if (entry.cloud) {
          // A cloud-only document gets its browser copy linked to the cloud one, then changed, so it uploads as an edit.
          const link = { id: entry.cloud.id, cloudId: entry.cloud.id, cloudUpdatedAt: entry.cloud.updatedAt, name: entry.name, owner, ...(entry.folderId !== null && { folderId: entry.folderId }) };
          await saveFromCloud({ ...link, bytes: doc.bytes });
          saved = await saveSaved({ id: entry.cloud.id, name: entry.name, bytes: doc.bytes });
        } else return false;
        if (owner) uploads.add(saved.id);
        showSoFar();
        return true;
      },
      ask: askDuplicate,
      async save(name, bytes, folderId) {
        const doc = await kept(name, bytes);
        if (!doc) return false;
        const info = await saveSaved({ name: doc.name, bytes: doc.bytes, owner, ...(folderId !== null && { folderId }) });
        if (owner) {
          // Sent in batches (and left in the queue meanwhile, so whatever a batch doesn't take goes the ordinary way, offline too).
          uploads.hold(info.id);
          waiting.push(info.id);
          waitingBytes += doc.bytes.byteLength;
          if (waiting.length >= IMPORT_UPLOAD_COUNT || waitingBytes >= IMPORT_UPLOAD_BYTES) await sendWaiting();
        }
        showSoFar();
        return true;
      },
    });
    await sendWaiting();
    await flushUploads();
    await refreshLibrary();
    const left = skipped + result.skipped;
    if (!result.cancelled) {
      progress.finish();
      finished = true;
    }
    if (result.cancelled) return setStatus(t('app.importCancelled', { count: result.imported }));
    if (left) setStatus(t('app.importedZipSkipped', { count: result.imported, skipped: left }));
    else if (result.unchanged) setStatus(t('app.importedZipUnchanged', { count: result.imported, unchanged: result.unchanged }));
    else setStatus(t('app.importedZip', { count: result.imported }));
  } catch (e) {
    if (progress.signal.aborted) return setStatus(t('app.importCancelled', { count: 0 }));
    reportError(t('app.importZipFailed', { message: (e as Error).message }));
  } finally {
    if (!finished) progress.close();
    if (waiting.length) {
      uploads.release(waiting);
      void flushUploads();
    }
  }
}

/**
 * Renders the first page as this saved copy's thumbnail (for the dashboard, and for the cloud
 * copy). Never fails the save: without a thumbnail the dashboard just shows a blank page.
 */
async function makeThumbnail(info: SavedInfo): Promise<void> {
  const page = pages[0];
  const text = textView.active;
  if (!text && (!page || !gl)) return;
  try {
    // A text file has no page: its first lines are drawn on one.
    const blob = text ? await textThumbnail(textView.headLines()) : await capturePageThumbnail(gl!, renderer, page!, paintEdits);
    if (blob) await saveThumbnail(info.id, blob, info.updatedAt);
  } catch {
    // no thumbnail this time
  } finally {
    requestRender(); // the capture drew into a scratch framebuffer; the canvas is unchanged, but be sure
  }
}

/** Documents saved before thumbnails existed get one when first opened again (once their images have arrived). */
function backfillThumbnail(id: string): void {
  const doc = current;
  window.setTimeout(async () => {
    if (current !== doc || doc.localId !== id) return; // another document was opened meanwhile
    const info = (await listSaved().catch(() => [])).find((d) => d.id === id);
    if (!info) return;
    const existing = await getThumbnail(id).catch(() => null);
    if (existing?.forUpdatedAt === info.updatedAt) return;
    // The thumbnail is drawn from what is on screen: still this document?
    if (current !== doc) return;
    await makeThumbnail(info);
  }, 1500);
}

/** Set once the user clears this browser's data: nothing more is saved before the page reloads. */
let cleared = false;

/** Saves the open document in this browser. Returns its id, or null if that failed. */
function saveInBrowser(): Promise<string | null> {
  clearTimeout(autosaveTimer);
  if (cleared || current.detour) return Promise.resolve(null);
  const doc = current;
  doc.unsavedSince = 0;
  const name = fileName();
  // Asked for now, while the worker (or the large-text editor) still has this document.
  const large = textView.active;
  const bytes = large ? Promise.resolve(textView.snapshot()!) : worker.save();
  bytes.catch(() => {}); // handled below, once earlier saves are written
  const done = saving.then(async () => {
    const created = !doc.localId;
    try {
      const owner = account?.id;
      const folderId = created ? (doc.newFolder ?? undefined) : undefined;
      // A renamed document breaks the links to it, unless they are written again once it is saved.
      const was = created ? undefined : library.entries.find((e) => e.local?.id === doc.localId);
      const linksAfter = was && was.name !== name ? keepLinks({ kind: 'rename', key: was.key, name }) : null;
      const info = await saveSaved({ id: doc.localId ?? undefined, name, bytes: await bytes, owner, folderId });
      linksAfter?.();
      doc.localId = info.id;
      rememberIgnored(doc);
      if (doc === current) {
        await makeThumbnail(info);
        rememberInUrl(`local:${info.id}`);
        // Signed in, the button at the top right says how saving is going.
        if (!owner) setStatus(t('app.savedInBrowser', { name: info.name }));
      }
      // Shown at once wherever the library is (a new document, or a later save's new order).
      library.putLocal(info);
      if (owner) {
        if (doc.room && doc.room.mode !== 'solo') {
          // The server keeps the cloud copy while several people edit. What is saved here is
          // that same document, so it counts as in step with the cloud (which will have moved
          // on, so opening it later fetches the cloud's) unless some edits didn't reach the server.
          if (doc.room.mode === 'shared' && doc.room.unconfirmed === 0 && info.cloudId) {
            await markSynced(info.id, { cloudId: info.cloudId, syncedAt: info.updatedAt });
            await library.reloadLocal();
          }
          // The room saves the contents, never the name: a rename goes to the account on its own.
          const cloudId = info.cloudId;
          const cloud = cloudId ? library.cloud.find((d) => d.id === cloudId) : undefined;
          if (cloudId && cloud && cloud.name !== info.name) {
            const renamed = await renameCloudDocument(cloudId, info.name).catch(() => null); // tried again at the next save
            if (renamed) {
              library.putCloud(renamed);
              putDocInCatalogue(renamed);
            }
          }
        } else scheduleUpload(info.id);
      }
      showSync();
      return info.id;
    } catch (e) {
      if (!doc.unsavedSince) doc.unsavedSince = performance.now(); // still unsaved: the next edit tries again
      if (doc === current) reportError((e as DOMException).name === 'QuotaExceededError' ? t('textEditor.quota') : t('app.saveFailed', { message: (e as Error).message }));
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
  if (await signOutQuietly()) location.replace(location.pathname);
}

/** `signOut` without the reload; false if the user cancelled or the sign-out failed. */
async function signOutQuietly(): Promise<boolean> {
  const user = signedIn;
  if (!user) return true;
  saveIfEdited();
  await saving;
  uploads.backOnline();
  await flushUploads();
  // The same copies the Documents page lists (not those of documents already deleted from the account).
  const unsent = ((await localCopies(user)) ?? []).filter(hasUnsentChanges);
  if (unsent.length) {
    const key = uploads.offline ? 'app.signOutLossOffline' : uploads.signedOut ? 'app.signOutLossExpired' : 'app.signOutLoss';
    const body = document.createElement('p');
    body.textContent = t(key, { count: unsent.length, name: unsent[0]!.name });
    if (!(await showConfirm(t('app.signOutTitle'), body, t('app.signOutAnyway')))) {
      focusInput();
      return false;
    }
  }
  try {
    await signOutOfCloud();
  } catch (e) {
    reportError(e instanceof TypeError ? t('app.signOutOffline') : t('app.signOutFailed', { message: (e as Error).message }));
    return false;
  }
  cleared = true; // nothing more is saved for this account here
  stopSettingsSync();
  clearTimeout(autosaveTimer);
  uploads.clear();
  await saving.catch(() => {});
  await deleteOwnedBy(user.id).catch(() => {});
  forgetCatalogue();
  try {
    localStorage.setItem(SIGNED_OUT_KEY, String(Date.now())); // tells this page's other tabs
  } catch {}
  return true;
}

/** Set when signing out, so the app's other tabs hear of it (a `storage` event). */
const SIGNED_OUT_KEY = 'wm.signedOut';

window.addEventListener('storage', (event) => {
  if (event.key !== SIGNED_OUT_KEY || !signedIn) return;
  // Signed out in another tab, which removed the account's copies here: a save or upload from this
  // one would bring them back (and send them with whoever signs in next), so it starts again signed out.
  cleared = true;
  clearTimeout(autosaveTimer);
  uploads.clear();
  location.replace(location.pathname);
});


/** A delete of more than this many documents and folders shows a progress card. */
const DELETE_PROGRESS_FROM = 200;

/** Deletes documents (from the dashboard, or the assistant): from the account in one request, and this browser's copies. */
async function deleteEverywhere(entries: readonly LibraryEntry[], folderIds: readonly string[] = []): Promise<void> {
  const deletingOpen = entries.some((entry) => entry.local && entry.local.id === current.localId);
  const open = current;
  const openId = open.localId;
  if (deletingOpen) {
    // The open document: its next autosave (or one under way) would write it back, and upload it
    // again as a new cloud document. It is replaced by the Welcome document once it is gone.
    clearTimeout(autosaveTimer);
    await saving;
    open.localId = null;
    open.unsavedSince = 0;
    open.builtIn = true;
  }
  // Not deleted after all (offline, or refused): it stays open as it was, rather than carrying on
  // unsaved and being saved again later as a second copy of itself.
  const keepOpen = (): void => {
    if (!deletingOpen || current !== open || open.localId !== null) return;
    open.localId = openId;
    open.builtIn = false;
    showSync();
  };
  let result: { removed: Set<string>; refused: Map<string, string> };
  try {
    result = await deleteEntries(entries, folderIds);
  } catch (e) {
    keepOpen();
    throw e;
  }
  if (deletingOpen) {
    if (openId !== null && result.removed.has(openId)) openSource('welcome', 'replace');
    else keepOpen();
  }
  if (result.refused.size) throw new Error([...result.refused.values()][0]);
}

/** The work of `deleteEverywhere`. Returns the browser copies removed, and why the account refused to delete the documents and folders it did not. */
async function deleteEntries(entries: readonly LibraryEntry[], folderIds: readonly string[]): Promise<{ removed: Set<string>; refused: Map<string, string> }> {
  // An upload under way would make a deleted document again (its cloud copy is gone, so it starts a
  // new one), or give a new one a cloud copy this delete doesn't know of: none of these start now,
  // and one that is running finishes first.
  const localIds = new Set(entries.flatMap((entry) => (entry.local ? [entry.local.id] : [])));
  await uploads.forget(localIds);
  const cloudIdOf = (entry: LibraryEntry) => entry.cloud?.id ?? library.local.find((d) => d.id === entry.local?.id)?.cloudId ?? entry.local?.cloudId ?? '';
  // The server deletes a folder's documents with it, so those are not named (a big folder is then one id, not thousands).
  const inDeleted = new Set(folderIds);
  const cloudIds = [
    ...new Set(
      entries.flatMap((entry) => (account && !(entry.cloud?.folderId && inDeleted.has(entry.cloud.folderId)) ? [cloudIdOf(entry)] : [])).filter(Boolean),
    ),
  ];
  // Already gone is fine; otherwise keep it, rather than have it come back from the account later.
  const refused = new Map<string, string>();
  const removed = new Set<string>();
  // A big delete takes several requests and as many removals here: say how far it is. Stopping half way would leave a folder part deleted, so there is no Cancel.
  const cloudWork = account ? cloudIds.length + folderIds.length : 0;
  const total = cloudWork + localIds.size;
  const progress = total > DELETE_PROGRESS_FROM ? showProgress(t('app.deleting'), false) : null;
  progress?.update(0, total);
  try {
    if (account && (cloudIds.length || folderIds.length)) {
      const result = await deleteDocuments(cloudIds, folderIds, (done) => progress?.update(done, total));
      for (const f of result.failed) if (f.error !== 'not found') refused.set(f.id, f.error);
    }
    if (account) forgetInCatalogue(account, cloudIds.filter((id) => !refused.has(id)), folderIds.filter((id) => !refused.has(id)));
    let done = cloudWork;
    for (const entry of entries) {
      if (refused.has(cloudIdOf(entry)) || (entry.cloud?.folderId && refused.has(entry.cloud.folderId))) continue;
      if (!entry.local) continue;
      // The account keeps what it deleted for 30 days (its trash); a document only this browser has goes to this browser's.
      if (account && cloudIdOf(entry)) await deleteSaved(entry.local.id);
      else await trashSaved(entry.local.id);
      removed.add(entry.local.id);
      progress?.update(++done, total);
    }
    progress?.finish();
  } catch (e) {
    progress?.close();
    throw e;
  }
  await refreshLibrary();
  return { removed, refused };
}

/**
 * File ▸ Clear Local Data: deletes every document, thumbnail and setting kept in this browser,
 * then starts afresh (with the welcome document). Signed in, it signs out first (with the usual
 * warning about changes not yet in the account), so the next person at this browser isn't you.
 */
async function clearLocalData(): Promise<void> {
  if (account) {
    // Let the open document's last edit reach the account first, so only real leftovers are counted.
    saveIfEdited();
    await saving;
    uploads.backOnline();
    await flushUploads();
  }
  // Everything in this browser's storage goes, whoever it belongs to and whichever folder it is in.
  const saved = await listSaved().catch(() => []);
  const count = saved.length;
  const unsent = account ? ((await localCopies(account)) ?? []).filter(hasUnsentChanges).length : 0;
  const body = document.createElement('p');
  if (account) {
    // Synced: this browser only holds copies, so the count would only alarm. Say more only if something hasn't reached the account.
    body.textContent = t('app.clearBodyAccount');
    if (unsent) body.textContent += ` ${t('app.clearUnsent', { count: unsent })}`;
  } else {
    const which = count === 0 ? 'None' : count === 1 ? 'One' : 'Many';
    body.textContent = t(`app.clearBody${which}` as MessageKey, { count });
    if (signedIn) body.textContent += ` ${t('app.clearSignOut')}`;
    body.textContent += ` ${t('app.clearLoss')}`;
  }
  if (!(await showConfirm(t('app.clearTitle'), body, t('app.clearConfirm')))) {
    focusInput();
    return;
  }
  if (signedIn && !(await signOutQuietly())) return;
  cleared = true;
  clearTimeout(autosaveTimer);
  try {
    await saving.catch(() => {}); // a save still writing would otherwise land after the wipe
    await clearAllSaved();
    searchLibrary.reset();
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
  const latest = openTicket();
  // Reopened straight after leaving it (Back, say), its last edits may still be on their way to this
  // browser's copy: reading the copy before they land would open, and then save, the older one.
  if (!early) await saving;
  const saved = await (early ?? getSaved(id).catch(() => null));
  if (!latest()) return;
  if (!saved) {
    open({ kind: 'blank', name: t('app.newDocumentName') });
    pendingNotice = t('app.localGone');
    return;
  }
  // Shown at once. Whether it joins its room depends on who is signed in, so if that isn't known
  // yet the room is joined once it is (the room's own copy replaces this one only if untouched).
  const cloudId = saved.info.cloudId;
  const source = sourceFromFile(saved.info.name, saved.bytes) ?? { kind: 'docx', name: saved.info.name, bytes: saved.bytes };
  // A huge text file (imported in a ZIP, say) opens in the viewer, as it does from the computer.
  if (usesTextEngine(source.kind, saved.bytes.byteLength)) return openLarge(saved.info.name, new Uint8Array(saved.bytes), { localId: id });
  open(source, { localId: id, cloudId });
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

/** Where documents are, so a link can name a folder (`[[Notes/Plan]]`), and the open document's folder, for plain titles and `../`. */
function linkPlaces(): LinkPlaces<LibraryEntry> {
  const names = (e: LibraryEntry) => folderPath(library.folders, folderOf(e, library.folders)).map((f) => f.name);
  const here = library.entries.find((e) => e.key === current.localId);
  return { folderNames: names, from: here ? names(here) : [] };
}

// --- Keeping links working -------------------------------------------------------------------
// Renaming or moving a document or folder can leave the links to it (`[[Plan]]`, `[[Notes/Plan]]`) naming nothing. So
// the documents that link to a moved one are found from their search indexes (which list their links) and the links are
// written again (see linkRename.ts, formats/docLinks.ts). Done after the change, in the background, one change at a time.

function librarySnapshot(): LibrarySnapshot {
  return { docs: library.entries.map((e) => ({ key: e.key, name: e.name, folderId: folderOf(e, library.folders) })), folders: library.folders };
}

let linkUpdates: Promise<void> = Promise.resolve();

/** Call before `change` is made; call what it returns once it is, to update the links it broke. */
function keepLinks(change: LibraryChange): () => void {
  const before = librarySnapshot();
  const after = afterChange(before, change);
  if (!anyMoved(placedDocs(before), placedDocs(after))) return () => {};
  return () => {
    linkUpdates = linkUpdates
      .then(() => updateLinks(placedDocs(before), placedDocs(after)))
      .catch((e: Error) => reportError(t('app.linksUpdateFailed', { message: e.message })));
  };
}

async function updateLinks(before: ReturnType<typeof placedDocs>, after: ReturnType<typeof placedDocs>): Promise<void> {
  await saving; // the open document's links are in its saved copy
  const own = searchableDocuments(library.entries, [], searchSources);
  await searchLibrary.sync(own);
  const plan = retargets(before, after, await searchLibrary.links(own));
  let updated = 0;
  let skipped = 0;
  for (const [key, renames] of plan) {
    const entry = library.entries.find((e) => e.key === key);
    const result = entry && entry.state !== 'conflict' ? await updateLinksIn(entry, renames) : 'skipped';
    if (result === 'updated') updated++;
    else if (result === 'skipped') skipped++;
  }
  if (updated) setStatus(t('app.linksUpdated', { count: updated }));
  if (skipped) reportError(t('app.linksSkipped', { count: skipped }));
}

/** Writes `renames` into one stored document; whether it was changed, left as it was, or could not be changed now. */
async function updateLinksIn(entry: LibraryEntry, renames: ReadonlyMap<string, string>): Promise<'updated' | 'unchanged' | 'skipped'> {
  const isOpen = entry.local !== null && entry.local.id === current.localId;
  if (isOpen) {
    await saveNow();
    // Others are editing it: the server keeps its copy.
    if (current.room && current.room.mode !== 'solo') return 'skipped';
  }
  const found = entry.cloud && opensFromCloud(entry) ? await openFromCloud(entry.cloud, account?.id) : await getSaved(entry.local!.id);
  if (!found) return 'skipped';
  const { bytes } = await rewriteDocumentLinks(found.bytes, renames);
  if (!bytes) return 'unchanged';
  // Edited while this was being worked out: the next save would put the old links back.
  if (isOpen && current.unsavedSince > 0) return 'skipped';
  const info = await saveSaved({ id: found.info.id, name: found.info.name, bytes, owner: account?.id });
  library.putLocal(info);
  if (account) scheduleUpload(info.id);
  if (isOpen) openSource(`local:${info.id}`, 'replace');
  return 'updated';
}

setLinkKeeper(keepLinks);

// A Markdown document that embeds a picture or a note (`![[map.png]]`) has the layout worker ask for it by title: this browser's copy or the account's.
worker.embeds = async (title) => {
    const found = findByTitle(title, library.entries.filter((e) => e.key !== current.localId && !(current.shared && e.cloud?.id === current.shared.id)), linkPlaces());
  if (!found) return null;
  try {
    const bytes = (found.local && !opensFromCloud(found) ? (await getSaved(found.local.id))?.bytes : null) ?? (found.cloud ? await downloadDocument(found.cloud.id) : null);
    return bytes ? { name: found.name, bytes: bytes.slice(0) } : null;
  } catch {
    return null;
  }
};

/** Documents other people shared with this user, as last listed (the dashboard hands them over). */
const sharedDocs = new Map<string, CloudDocument>();

/** Opens a document someone shared with this user, straight from the cloud. */
async function openShared(id: string): Promise<void> {
  const latest = openTicket();
  await firstConnect;
  try {
    let doc = sharedDocs.get(id);
    if (!doc) {
      for (const d of await listShared()) sharedDocs.set(d.id, d);
      doc = sharedDocs.get(id);
    }
    if (!latest()) return;
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
async function share(): Promise<void> {
  // Who may share depends on the account's plan: asked just after the page opened, wait for it
  // (otherwise the dialog would say to sign in, or to subscribe, to someone who has).
  await accountKnown;
  if (current.localId && !library.local.some((d) => d.id === current.localId)) await library.reloadLocal();
  const info = library.local.find((d) => d.id === current.localId);
  const people = !account
    ? { unavailable: signedIn ? t('app.subscribeToShare') : t('app.signInToShare') }
    : current.shared
      ? { unavailable: t('app.ownerOnlyShare') }
      : !info
        ? { unavailable: t('app.notSavedYet') } // e.g. the welcome document, until it is edited
        : !info.cloudId
          ? { unavailable: t('app.notInAccountYet') }
          : { id: info.cloudId };
  showShareDialog({ name: info?.name ?? current.name, people });
}

async function openCloud(id: string): Promise<void> {
  const latest = openTicket();
  // The copy made here is the account's: who that is (and whether they have sync) must be known first.
  await accountKnown;
  try {
    if (!library.cloud.some((d) => d.id === id)) await refreshLibrary(); // only for an address opened before the list arrived
    // A listing that another one overtook leaves the list empty: ask for it directly (the name says what kind of file it is).
    const cloud = library.cloud.find((d) => d.id === id) ?? (await listDocuments().catch(() => [])).find((d) => d.id === id);
    const name = cloud?.name ?? t('app.cloudDocumentName');
    setStatus(t('app.opening', { name }));
    // A copy here with changes not uploaded yet opens as it is; uploading it sorts out the rest. So
    // whatever is still being saved to it lands first.
    await saving;
    const { info, bytes } = await openFromCloud({ id, name, updatedAt: cloud?.updatedAt }, account?.id);
    // Listed at once: what asks about the open document's copy (File › Share, say) finds it.
    if ((info.owner ?? null) === (account?.id ?? null)) library.putLocal(info);
    if (!latest()) return; // something else was opened meanwhile: this one is saved here, for next time
    const source = sourceFromFile(info.name, bytes) ?? { kind: 'docx', name: info.name, bytes };
    if (usesTextEngine(source.kind, bytes.byteLength)) openLarge(info.name, new Uint8Array(bytes), { localId: info.id });
    else open(source, { localId: info.id, cloudId: info.cloudId });
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
    // The large-text editor holds the text, and gives it back in the encoding it came in.
    const large = textView.active ? textView.snapshot() : null;
    // Named now: another document may be open by the time the bytes come back.
    const name = large ? textView.fileName : fileName();
    const type = large ? 'text/plain' : FORMATS[current.kind].mime;
    const bytes = large ?? (await worker.convert(current.kind as Format));
    const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
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
  if (!(await openAsDocument())) return;
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
  if (!(await openAsDocument())) return;
  const from = current.kind;
  if (to === from) return;
  // A drawing's pictures are made from the drawing itself (at full resolution), as a document's pages are drawn into one.
  if (PICTURE_KINDS.includes(to) && !PICTURE_KINDS.includes(from) && !VECTOR_KINDS.includes(from)) return convertToPicture(to as 'png' | 'jpeg' | 'webp');
  if (VECTOR_KINDS.includes(to) && !VECTOR_KINDS.includes(from)) return convertToDrawing(to as 'svg' | 'svgz');
  if (!isFormat(to) || !isFormat(from)) throw new Error(t('app.unsupportedFormat', { label: FORMATS[isFormat(to) ? from : to].label }));
  // What a room's people edit the document as is the room's, so it stays while others are in it.
  if (current.room && current.room.mode !== 'solo') {
    reportError(t('app.leaveRoomToSwitch'));
    return;
  }
  setStatus(t('app.switching', { label: FORMATS[to].label }));
  const latest = openTicket();
  // Saved now, as the format to edit it as, in place of the document's last save.
  clearTimeout(autosaveTimer);
  const doc = current;
  doc.unsavedSince = 0;
  const name = stem(current.name) + FORMATS[to].extensions[0];
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
  void refreshLibrary();
  if (account) scheduleUpload(info.id, 0);
  // Another document opened meanwhile: the converted one is saved, in the library, but not opened over it.
  if (!latest()) return;
  const source = sourceFromFile(name, (await bytes).slice().buffer);
  if (!source) throw new Error(t('app.cannotOpenFormat', { label: FORMATS[to].label }));
  setUrl(new URLSearchParams());
  open(source, { grid, localId: info.id });
  rememberInUrl(`local:${info.id}`);
  chrome.update({ documentName: current.name, kind: current.kind });
  pendingNotice = switchedNotice(to);
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
    const name = stem(current.name) + FORMATS[to].extensions[0];
    const latest = openTicket();
    const bytes = await encodeCanvas(canvas, to);
    if (!latest()) return;
    open({ kind: 'image', name, bytes: bytes.slice().buffer });
    documentEdited(); // saved, so it is there in the library next to the document it was made from
    pendingNotice = layout.count < pages.length ? t('app.pictureShortened', { name, count: layout.count }) : t('app.convertedToPicture', { name });
  } catch (e) {
    reportError(t('picture.editFailed', { message: (e as Error).message }));
  }
}

/**
 * Convert To a vector format from another kind of document: its pages, laid out and drawn as vector graphics (text stays
 * text), saved and opened as a drawing of its own. The document stays as it is.
 */
async function convertToDrawing(to: 'svg' | 'svgz'): Promise<void> {
  if (!loaded) return reportError(t('app.notReadyToConvert'));
  setStatus(t('app.switching', { label: FORMATS[to].label }));
  try {
    const name = stem(current.name) + FORMATS[to].extensions[0];
    const latest = openTicket();
    const bytes = await worker.convert(to);
    if (!latest()) return;
    open({ kind: 'svg', name, bytes: bytes.slice().buffer });
    documentEdited();
    pendingNotice = t('app.convertedToDrawing', { name });
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
/** Whether the picture's layers (the shapes drawn over it) have changes to step back over or forward again. */
let layerSteps = { canUndo: false, canRedo: false };
/** A drawing edited together: whether the person's own changes to it can be stepped back over or forward again, and the drawing as the room last had it (with the ids its nodes have there). */
let vectorSteps = { canUndo: false, canRedo: false };
let latestVectorScene: Scene | null = null;
/** Called when the worker next sends the picture's shapes (the answer to a change of them). */
let shapesEcho: (() => void) | null = null;
const isPicture = (): boolean => PICTURE_KINDS.includes(current.kind);
/** A vector drawing is open: a page showing it, looked at as a whole like a picture. */
const isDrawing = (): boolean => VECTOR_KINDS.includes(current.kind);

// --- A picture of the text, edited in the image editor -------------------------------------------------------------
// The document is saved and put away, the picture opens as a picture of its own (which is never saved), and Done opens the
// document again with the picture it came to in place of the old one.

/** The document a picture was taken from: where to open it again, which picture it was (paragraph and offset), and whether the picture was changed. */
let pictureDetour: { source: string; name: string; at: { paragraph: number; offset: number }; edited: boolean } | null = null;
/** An edited picture waiting for its document to open again, to be put in place of the old one. */
let pendingPicture: { source: string; at: { paragraph: number; offset: number }; bytes: Uint8Array; ext: string; aspect: number } | null = null;
const pictureDetourBar = new PictureDetourBar(
  document.getElementById('viewport')!,
  () => void finishPictureDetour(true),
  () => void finishPictureDetour(false),
);

async function editPicture(picture: NonNullable<SelectionUpdate['picture']>): Promise<void> {
  if (!picture.at || pictureDetour || current.detour || refuseWhileWatching() || current.room?.role === 'viewer') return;
  // The document is opened again afterwards, which would take it out of a room.
  if (sharedLive() || current.shared) return reportError(t('picture.detour.unavailable'));
  const doc = current;
  try {
    const bytes = await worker.media(picture.part);
    const type = sniffImage(bytes)?.type;
    if (!type) return reportError(t('app.notImage'));
    const id = await saveNow();
    if (!id) return reportError(t('picture.detour.unavailable'));
    if (doc !== current) return;
    const source = `local:${id}`;
    pictureDetour = { source, name: doc.name, at: picture.at, edited: false };
    pictureDetourBar.update(doc.name);
    open({ kind: 'image', name: `${t('picture.detour.fileName')}.${type === 'jpeg' ? 'jpg' : type === 'webp' ? 'webp' : 'png'}`, bytes: bytes.slice().buffer }, { detour: true });
  } catch (e) {
    pictureDetour = null;
    pictureDetourBar.update(null);
    reportError(t('picture.editFailed', { message: (e as Error).message }));
  }
}

/** Back to the document: with the edited picture in place of the old one (`apply`), or as it was. */
async function finishPictureDetour(apply: boolean): Promise<void> {
  const back = pictureDetour;
  if (!back || !current.detour) return;
  try {
    if (apply && back.edited) {
      const bytes = await pictureBytes();
      const size = sniffImage(bytes);
      if (size) pendingPicture = { source: back.source, at: back.at, bytes, ext: size.type, aspect: size.width > 0 ? size.height / size.width : 0 };
    }
  } catch (e) {
    reportError(t('picture.editFailed', { message: (e as Error).message }));
    return;
  }
  pictureDetour = null;
  pictureDetourBar.update(null);
  openSource(back.source, 'none');
}

/** The document is open again: its picture is the one selected, and the edited one goes in its place. */
function putEditedPicture(back: NonNullable<typeof pendingPicture>): void {
  worker.command({ kind: 'select', paragraph: back.at.paragraph, from: back.at.offset, to: back.at.offset + 1 });
  worker.replacePicture(back.bytes, back.ext, back.aspect);
  documentEdited();
}

/** The assistant opens the picture it selected in the image editor, once the page has heard which is selected. */
async function editTextPicture(): Promise<string | null> {
  if (pictureDetour || current.detour) return 'a picture is already open in the image editor.';
  if (!FORMATS[current.kind].editable) return 'this document cannot be changed.';
  for (let waited = 0; waited < 3000 && !selectedPicture; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  if (!selectedPicture) return 'the picture is not selected.';
  if (selectedPicture.svg) return 'that is a vector drawing: open it with text_drawings.';
  await editPicture(selectedPicture);
  for (let waited = 0; waited < 5000 && !current.detour; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  return current.detour ? null : 'the picture could not be opened.';
}

async function finishTextPicture(apply: boolean): Promise<string | null> {
  if (!pictureDetour || !current.detour) return 'no picture from the document is open in the image editor.';
  await finishPictureDetour(apply);
  return pictureDetour ? 'the picture could not be put back.' : null;
}

/** The picture whose own pixels the Draw layer has been given (a fill finds its region in them), or null. */
let baseFor: object | null = null;

/** Gives the Draw layer the open picture's own pixels, without the shapes over it, once per picture. */
async function loadPictureBase(): Promise<void> {
  const doc = current;
  if (baseFor === doc) return;
  baseFor = doc;
  try {
    const bitmap = await decodeImage(await worker.pictureBase());
    const { context } = makeCanvas(bitmap.width, bitmap.height);
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();
    if (doc === current) drawLayer.setBase({ width: data.width, height: data.height, data: data.data });
  } catch {
    // Without them a fill is not shown, and the next change of the picture tries again.
    if (baseFor === doc) baseFor = null;
  }
}

/** The open picture as a file, of the type it is edited as. */
const pictureBytes = (): Promise<Uint8Array> => worker.convert(current.kind as Format);

/** Opens a picture in place of the open one, and saves it soon. */
function showPicture(bytes: Uint8Array): void {
  open({ kind: 'image', name: current.name, bytes: bytes.slice().buffer }, { grid, localId: current.localId ?? undefined, pictureEdit: true, detour: current.detour });
  documentEdited();
}

async function changePicture(edit: ImageEdit): Promise<void> {
  if (refuseWhileWatching()) return;
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
  if (isPicture() && refuseWhileWatching()) return;
  if (isDrawing() || embeddedDrawing) return direction === 'undo' ? vector?.editor.undo() : vector?.editor.redo();
  // What was drawn over the picture is stepped back over first; then the picture's own changes.
  if (isPicture() && (direction === 'undo' ? layerSteps.canUndo : layerSteps.canRedo)) return stepShapes(direction);
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
const drawStyle: DrawStyle = { ...DEFAULT_DRAW_STYLE };

/** Changes what the Draw tools draw with (the toolbar, the eyedropper, a key); the picked shapes are not restyled, only the next ones. */
function setDrawStyle(change: Partial<DrawStyle>): void {
  Object.assign(drawStyle, change);
  drawStyle.size = Math.min(3, Math.max(0, Math.round(drawStyle.size)));
  requestRender();
}

/** The Draw toolbar's tools, and the commands on the picked shapes and layers. `at` is where the paint bucket was clicked. */
async function pictureAction(op: ImageOp): Promise<void> {
  if (!isPicture()) return;
  if (op === 'sizeUp' || op === 'sizeDown') return setDrawStyle({ size: drawStyle.size + (op === 'sizeUp' ? 1 : -1) });
  if (op === 'layers') return toggleLayers();
  if (refuseWhileWatching()) return;
  if (op.startsWith('shape:') || op === 'shape') {
    if (op !== 'shape') setDrawStyle({ shape: op.slice(6) as DrawStyle['shape'] });
    cropLayer.cancel();
    if (drawLayer.active) return drawLayer.setTool('shape');
    return drawLayer.start('shape');
  }
  // Commands on the shapes drawn over the picture.
  switch (op) {
    case 'selectAll':
      if (!drawLayer.active) drawLayer.start('move');
      return drawLayer.selectAll();
    case 'deselect':
      return drawLayer.select([]);
    case 'duplicate':
      return drawLayer.duplicate();
    case 'group':
      return drawLayer.group();
    case 'ungroup':
      return drawLayer.ungroup();
    case 'newLayer':
      return drawLayer.newLayer();
    case 'delete':
      return drawLayer.deleteSelection();
    case 'front':
    case 'forward':
    case 'backward':
    case 'back':
      return drawLayer.order(op === 'front' || op === 'forward' ? 'forward' : 'backward', op === 'front' || op === 'back');
  }
  if (op === 'bucket') {
    // The bucket adds a fill layer (see ui/drawLayer.ts): the picture's own pixels are not changed.
    cropLayer.cancel();
    if (drawLayer.active) return drawLayer.setTool('bucket');
    return drawLayer.start('bucket');
  }
  if (op === 'background' || op === 'canvasSize') {
    drawLayer.apply();
    const doc = current;
    try {
      const size = sniffImage(await pictureBytes());
      if (!size || doc !== current) return;
      if (op === 'background') {
        const paint = await showBackgroundDialog(paintOf(drawStyle));
        if (paint) await changePicture({ op: 'background', paint });
      } else {
        const choice = await showPictureCanvasDialog(size.width, size.height, paintOf({ ...drawStyle, fillType: 'solid', fillColor: drawStyle.fillColor ?? '#ffffff' }));
        if (choice && (choice.width !== size.width || choice.height !== size.height)) await changePicture({ op: 'canvas', ...choice });
      }
      focusInput();
    } catch (e) {
      reportError(t('picture.editFailed', { message: (e as Error).message }));
    }
    return;
  }
  if (isDrawTool(op)) {
    cropLayer.cancel();
    if (drawLayer.active) return drawLayer.setTool(op);
    drawLayer.start(op);
    return;
  }
  // Any other tool takes the picture as drawn so far: the shapes are put into it (and are no longer layers).
  drawLayer.apply();
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
// A file of many megabytes would need gigabytes as paragraphs (docs/text-files.md), so it opens in a
// viewer over the page instead: the file stays bytes, and only the lines in view are drawn. An empty document
// is opened under it (with the file's name) so that the rest of the app has something to stand on.

async function openLarge(name: string, bytes: Uint8Array, options: { localId?: string; cloudId?: string; shared?: CloudDocument; store?: boolean } = {}): Promise<void> {
  // A changed drawing in the text is put back in its document first, so the change is saved with it; then this opens (unless another was asked for meanwhile).
  if (embeddedDrawing?.latest != null) {
    const still = openTicket();
    void leaveEmbeddedDrawing(false).then(() => void (still() && openLarge(name, bytes, options)));
    return;
  }
  // The editor is fetched the first time a text file is opened (it is about 60 kB that sessions of Word documents never need).
  const latest = openTicket();
  try {
    await textView.load();
  } catch (e) {
    return reportError(t('app.openFailed', { message: (e as Error).message }));
  }
  if (!latest()) return;
  openRequests++;
  // No account id is passed on: the layout worker has no document here, so it joins no room. The text editor joins its own (`joinTextRoom`).
  const { opening } = beginOpen({ kind: 'txt', name, bytes: new ArrayBuffer(0) }, { localId: options.localId, shared: options.shared });
  worker.close();
  spellDialog.sendLive(); // what is underlined, and the person's words: the worker holds them for text files too
  startIgnored(opening);
  const text = toUtf8WithEncoding(bytes);
  textView.open(name, text.bytes, { encoding: text.encoding, bom: text.bom, original: bytes });
  textView.editor!.readOnly = options.shared?.role === 'viewer';
  const big = bytes.length >= LARGE_TEXT_BYTES;
  const notice = (big ? t('textEditor.notice', { name, size: `${(bytes.length / (1 << 20)).toFixed(bytes.length < 10 << 20 ? 1 : 0)} MB` }) : '') + (text.encoding === 'windows-1252' ? `${big ? ' ' : ''}${t('textEditor.latin1Note')}` : '');
  // What opening a document ends with: it is ready, the loading screen goes, and a search hit is gone to.
  loaded = true;
  documentReady();
  loadingScreen.hide();
  setStatus(notice || t('app.ready', { name }));
  if (pendingJump) {
    const jump = pendingJump;
    pendingJump = null;
    if (jump.source === viewDocKey) goToHit(jump);
  }
  focusInput();
  // A file that came from somewhere is kept in this browser at once, as a document is (a big one only once it is edited, so looking costs nothing).
  if (options.localId) backfillThumbnail(options.localId);
  else if (!big && !options.shared) documentEdited();
  const cloudId = options.shared?.id ?? (options.localId ? library.local.find((d) => d.id === options.localId)?.cloudId : undefined);
  if (cloudId) void accountKnown.then(() => joinTextRoom(opening, cloudId));
}

/** The most of a big file that opens as an ordinary document: past this the document model costs too much (see docs/text-files.md). */
const MAX_SELECTION_BYTES = 5 * 1024 * 1024;

/**
 * What only a document does (printing, converting to another format): a text file in the text editor is opened as a document first, in place
 * of the file (it is the same file: the editor shows it again when it is opened next). True when there is a document to go on with.
 */
async function openAsDocument(): Promise<boolean> {
  if (!textView.active) return true;
  const bytes = textView.snapshot();
  if (!bytes || bytes.length > MAX_SELECTION_BYTES) {
    notify(t('textEditor.fileTooBig', { max: '5 MB' }));
    return false;
  }
  const before = current;
  await saveNow();
  const ready = nextDocumentReady();
  open({ kind: 'txt', name: textView.fileName, bytes: bytes.slice().buffer }, { asDocument: true, localId: before.localId ?? undefined });
  await ready;
  return true;
}

/** File › Open Selection as Document: the selected lines of a big text file, as a text document that can be formatted and converted. */
function openSelection(): void {
  if (!textView.hasSelection) return notify(t('textEditor.nothingSelected'));
  const text = textView.selectedText;
  const bytes = text === null ? null : new TextEncoder().encode(text);
  if (!bytes || bytes.length > MAX_SELECTION_BYTES) return notify(t('textEditor.selectionTooBig', { max: '5 MB' }));
  open({ kind: 'txt', name: `${t('textEditor.selectionName', { name: stem(textView.fileName) })}.txt`, bytes: bytes.buffer as ArrayBuffer }, { asDocument: true });
}

/** The name a big text file is saved under: one that opens as text again (a file with no extension gets `.txt`). */
const textFileNameOf = (name: string): string => textFileName(name, sourceFromFile(name, new ArrayBuffer(0)) !== null);

// --- Links to other documents ----------------------------------------------------------------
// A link to `doc:Title` (what [[Title]] is in wiki markup) opens the stored document of that title,
// this browser's copy or the account's. With none, it offers to make one, in the format of the
// document the link is in when that is text (so a wiki links to more wiki pages).

/** The formats a new, empty document can be made in from nothing: the text ones. */
const EMPTY_TEXT = new Set<DocumentKind>(['md', 'txt', 'mediawiki', 'textile', 'tex', 'typst', 'adoc', 'rst', 'org', 'html']);

/** Ctrl/Cmd+click on a link: opens a built-in page, a web address in a new tab, or the document a link names. */
function followLink(url: string): void {
  const page = builtInPageAt(url);
  if (page) openSource(page);
  else if (opensLink(url)) window.open(url, '_blank', 'noopener,noreferrer');
  else if (parseDocAddress(url)) void openDocumentLink(parseDocAddress(url)!.title);
  else if (parseTagAddress(url)) searchPanel.show(`#${parseTagAddress(url)}`);
}

async function openDocumentLink(title: string): Promise<void> {
  await saving;
  const found = findByTitle(title, library.entries, linkPlaces());
  if (found) return openSource(sourceOf(found));
  const ask = document.createElement('p');
  ask.textContent = t('app.createLinkedDocument', { title });
  if (!(await showConfirm(t('app.createLinkedTitle'), ask, t('app.createLinkedAction')))) {
    focusInput();
    return;
  }
  const target = splitLink(title, linkPlaces().from);
  if (!target.name) return;
  // `[[Notes/Plan]]` makes the folder Notes (and any inside it) as well as the document, unless they are there already.
  let parent: string | null = target.folders.length ? null : newDocumentFolder;
  const cloud = accountForFiles() !== null;
  for (const name of target.folders) {
    let folder = library.folders.find((f) => f.parentId === parent && normalizeTitle(f.name) === normalizeTitle(name));
    if (!folder) {
      folder = await createFolder(cloud, name, parent);
      library.update({ folders: [...library.folders, folder] });
    }
    parent = folder.id;
  }
  newDocumentFolder = parent;
  const extension = FORMATS[current.kind].extensions[0] ?? '.docx';
  const text = EMPTY_TEXT.has(current.kind) ? sourceFromFile(`${target.name}${extension}`, new ArrayBuffer(0)) : null;
  open(text ?? { kind: 'blank', name: `${target.name}.docx` });
  // Saved at once, so that the link finds it next time.
  documentEdited();
}

// --- Putting a picture in a document ---------------------------------------------------------
// A picture file can be opened (as a picture, to change with the picture tools) or put in the open
// document. Insert ▸ Picture inserts; dropping one on a document asks which was meant.

const PICTURE_FILE = /\.(png|jpe?g|webp|gif|bmp|heic|heif|svg)$/i;
const isPictureFile = (file: File): boolean => PICTURE_FILE.test(file.name) || (file.type.startsWith('image/') && file.type !== 'image/tiff');

/** Where a picture can go in the open document now: in its text, embedded in a Markdown note (as a stored file), or onto a PDF page. */
type PictureTarget = 'text' | 'embed' | 'pdf';
function pictureTarget(): PictureTarget | null {
  if (!loaded || isPicture() || isDrawing() || dashboard.visible) return null;
  if (annotating) return current.kind === 'pdf' ? 'pdf' : null;
  if (FORMATS[current.kind].images) return 'text';
  return current.kind === 'md' && !current.builtIn && !sharedLive() ? 'embed' : null;
}

/** Whether the point of the screen is on a page of the open document. */
function onPageAt(x: number, y: number): boolean {
  const rect = canvas.getBoundingClientRect();
  return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom && pageAt(x - rect.left, y - rect.top) !== null;
}

async function dropped(drop: Dropped, x: number, y: number): Promise<void> {
  if (drop?.kind === 'file' && isPictureFile(drop.file) && pictureTarget()) {
    const choice = await askDropChoice(drop.file.name, x, y);
    if (choice === undefined) return focusInput();
    if (choice === 'insert') return insertPicture(drop.file, { x, y });
  }
  // Dropped on the document, not a folder: it goes in the top level.
  dropFile(drop, null);
}

/**
 * Opens a dropped file (a ZIP is imported), filed in `folderId` (null: the top level) when it is
 * first saved; several files, or a folder, are imported there.
 */
function dropFile(drop: Dropped, folderId: string | null): void {
  if (!drop) return;
  newDocumentFolder = folderId;
  if (drop.kind === 'import') return void importDropped(drop);
  if (isZipName(drop.file.name)) return void importZip(drop.file);
  openFile(drop.file);
}

/** Whether a link can be dropped on the document at this point of the screen: it is on a page, of a document that holds links. */
function canLinkDropAt(x: number, y: number): boolean {
  if (!loaded || current.builtIn || isPicture() || annotating || dashboard.visible || !FORMATS[current.kind].links) return false;
  return onPageAt(x, y);
}

/** Whether a picture dropped at this point of the screen can go in the open document. */
const canPictureDropAt = (x: number, y: number): boolean => pictureTarget() !== null && onPageAt(x, y);

/**
 * A document dragged from the Files panel onto the open one. A picture is put in (or, where the document holds links, the choice
 * is asked: the picture or a link to it); any other document becomes a link.
 */
async function dropLibraryDocument(key: string, x: number, y: number): Promise<void> {
  const entry = library.entries.find((e) => e.key === key);
  if (!entry) return;
  const canLink = canLinkDropAt(x, y);
  if (PICTURE_FILE.test(entry.name) && canPictureDropAt(x, y)) {
    if (canLink) {
      const choice = await askDropChoice(entry.name, x, y, ['insert', 'link']);
      if (choice === undefined) return focusInput();
      if (choice === 'link') return linkDroppedDocument(key, x, y);
    }
    return insertLibraryPicture(entry, x, y);
  }
  if (canLink) linkDroppedDocument(key, x, y);
}

/** Puts a picture of the library in the document at the point of the screen: a Markdown note embeds the stored file, the others take a copy. */
async function insertLibraryPicture(entry: LibraryEntry, x: number, y: number): Promise<void> {
  try {
    if (pictureTarget() === 'embed') {
      await embedInNote(entry.name, { x, y });
      if (current.localId) openSource(`local:${current.localId}`, 'replace');
      return;
    }
    const bytes = (entry.local && !opensFromCloud(entry) ? (await getSaved(entry.local.id))?.bytes : null) ?? (entry.cloud ? await downloadDocument(entry.cloud.id) : null);
    if (!bytes) throw new Error(entry.name);
    const picture = new Uint8Array(await pictureFileOf(bytes));
    // Say what was found, so a stored file that holds no picture is not a mystery.
    if (!sniffImage(picture) && !/<svg[\s>]/i.test(new TextDecoder().decode(picture.subarray(0, 2048)))) {
      throw new Error(`${entry.name}: ${picture.length} bytes starting ${[...picture.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    }
    await insertPicture(new File([picture], entry.name), { x, y });
  } catch (e) {
    reportError(t('picture.insertFailed', { message: (e as Error).message }));
  }
}

/** The picture a stored picture file holds: it is kept as a saved document of its own page (with the shapes drawn over it), so the picture is taken out and the shapes are drawn on it. */
async function pictureFileOf(stored: ArrayBuffer): Promise<ArrayBuffer | Uint8Array<ArrayBuffer>> {
  const bytes = new Uint8Array(stored);
  if (sniffImage(bytes)) return stored;
  const { readWdoc, isWdoc } = await import('./formats/wdoc.ts');
  if (!isWdoc(bytes)) throw new Error(t('app.notImage'));
  const { document: docx, extensions } = await readWdoc(bytes);
  // A drawing is kept as its SVG text.
  if (extensions.svg?.source && !extensions.svg.gzip) return new TextEncoder().encode(extensions.svg.source) as Uint8Array<ArrayBuffer>;
  if (!docx) throw new Error(t('app.notImage'));
  const { readDocument } = await import('./formats/convert.ts');
  const { firstPicture } = await import('./formats/imageDoc.ts');
  const picture = await firstPicture(await readDocument('docx', docx));
  if (!picture) throw new Error(t('app.notImage'));
  const shapes = extensions.img?.shapes ?? [];
  return (shapes.length ? (await applyImageEdit(picture.image.bytes, { op: 'draw', shapes })).bytes : picture.image.bytes) as Uint8Array<ArrayBuffer>;
}

/** A document dragged from the Files panel onto the open one: a link to it where it was dropped, named as `[[Note]]` would. */
function linkDroppedDocument(key: string, x: number, y: number): void {
  const entry = library.entries.find((e) => e.key === key);
  if (!entry) return;
  const documents = placedDocs(librarySnapshot());
  const target = documents.find((d) => d.key === key);
  const rect = canvas.getBoundingClientRect();
  const hit = pageAt(x - rect.left, y - rect.top);
  if (!target || !hit) return;
  const title = shortestTitle(target, documents, linkPlaces().from ?? []);
  send({ kind: 'pointer', page: hit.page.id, x: hit.x, y: hit.y });
  // Where Markdown shows at the caret, the paragraph is its source text: the link goes in written out, and is a link once the caret leaves.
  if (current.kind === 'md' && livePreviewOn()) send({ kind: 'insertText', text: `[[${title}]]` });
  else send({ kind: 'setLink', url: docAddress(title), text: title });
  focusInput();
}

/** Puts a picture file in the document, at `at` (a point on the screen) or else the caret. */
async function insertPicture(file: File, at?: { x: number; y: number }): Promise<void> {
  const target = pictureTarget();
  if (!target) return;
  try {
    let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
    let name = file.name;
    // An SVG goes into a Word document as a drawing that can be edited there; in other documents it is drawn to a PNG (they hold pictures), and the other types go in as they are.
    if (target === 'text' && current.kind === 'docx' && !sniffImage(bytes) && /\.svg$/i.test(name)) {
      const svg = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
      try {
        return await putDrawing(svg, name.replace(/\.[^.]*$/, ''), at);
      } catch {
        // Not a drawing the editor reads: it goes in as a picture.
      }
    }
    // What the document can't hold as it is (SVG, a HEIC photo) is turned into a PNG or JPEG.
    const sniffed = sniffImage(bytes);
    if (!sniffed || sniffed.type === 'heic') ({ bytes, name } = await toPng(name, bytes));
    const image = sniffImage(bytes);
    if (!image) throw new Error(t('app.notImage'));
    if (target === 'pdf') return await pdfTools.addPicture(new File([bytes as Uint8Array<ArrayBuffer>], name), at);
    if (target === 'embed') return await embedPicture(bytes, name, at);
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

/** Puts a vector drawing (SVG text) in the text at the caret or `at`; with `edit`, starts editing it once it is there. */
async function putDrawing(svg: string, description: string, at?: { x: number; y: number }, edit = false): Promise<void> {
  const session = await loadVector();
  const picture = await session.picture(svg);
  if (at) {
    const rect = canvas.getBoundingClientRect();
    const hit = pageAt(at.x - rect.left, at.y - rect.top);
    if (hit) send({ kind: 'pointer', page: hit.page.id, x: hit.x, y: hit.y });
  }
  if (edit) {
    const known = new Set(pages.flatMap((p) => p.images.flatMap((i) => (i.svg ? [i.svg] : []))));
    newDrawingSince = known;
    // If it never arrives (not allowed here), another drawing appearing later is not this one.
    setTimeout(() => newDrawingSince === known && (newDrawingSince = null), 5000);
  }
  // At 96 dpi, in EMUs; the document trims it to the page.
  worker.putDrawing({ svg, png: picture.png, width: Math.max(picture.width, 1) * 9525, height: Math.max(picture.height, 1) * 9525, description });
  documentEdited();
  focusInput();
}

/** The drawings the text had before a new one was put in: the one that isn't among them, once the pages arrive, is edited. */
let newDrawingSince: Set<string> | null = null;

/** Insert ▸ Drawing: a blank drawing at the caret, open for drawing. */
function insertDrawing(size: { width?: number; height?: number } = {}): void {
  if (current.kind === 'md') return void insertStoredDrawing(size);
  void loadVector()
    .then((session) => putDrawing(session.blank(size.width ?? 480, size.height ?? 320), t('chrome.insert.drawing').replace('&', ''), undefined, true))
    .catch((e: Error) => reportError(t('picture.insertFailed', { message: e.message })));
}

/** Insert ▸ Drawing in a Markdown document: a new drawing of its own is stored and embedded (`![[Drawing.svg]]`), and opened for drawing once it shows. */
async function insertStoredDrawing(size: { width?: number; height?: number } = {}): Promise<void> {
  // The note is opened again to show the drawing, which would take it out of the room.
  if (sharedLive()) return reportError(t('picture.embedNotInRoom'));
  try {
    const session = await loadVector();
    const { newStoredDrawing } = await import('./formats/vectorDoc.ts');
    const taken = new Set(library.entries.map((e) => e.name.toLowerCase()));
    let name = 'Drawing.svg';
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `Drawing ${n}.svg`;
    const info = await saveSaved({ name, bytes: await newStoredDrawing(session.blank(size.width ?? 480, size.height ?? 320)), owner: account?.id });
    library.putLocal(info);
    if (account) scheduleUpload(info.id);
    await embedInNote(name);
    if (!current.localId) return;
    const known = new Set<string>();
    newDrawingSince = known;
    setTimeout(() => newDrawingSince === known && (newDrawingSince = null), 15000);
    openSource(`local:${current.localId}`, 'replace');
  } catch (e) {
    reportError(t('picture.insertFailed', { message: (e as Error).message }));
  }
}

/**
 * Embeds the stored file `name` (`![[name]]`) in the Markdown note in a paragraph of its own, at the point of the screen or else the end,
 * with the caret after it (a paragraph the caret is in shows its Markdown, not the picture), and saves. The note has to be opened
 * again to show the picture.
 */
async function embedInNote(name: string, at?: { x: number; y: number }): Promise<void> {
  const { embedPlaceholder } = await import('./formats/embedMarks.ts');
  const link = embedPlaceholder(name);
  if (!link) throw new Error(name);
  const rect = canvas.getBoundingClientRect();
  const hit = at && pageAt(at.x - rect.left, at.y - rect.top);
  if (hit) send({ kind: 'pointer', page: hit.page.id, x: hit.x, y: hit.y });
  else send({ kind: 'move', to: 'documentEnd' });
  send({ kind: 'insertParagraph' });
  send({ kind: 'insertContent', content: [link] });
  send({ kind: 'insertParagraph' });
  await saveNow();
}

/** A picture put in a Markdown note: kept as a file of its own beside it and embedded. */
async function embedPicture(bytes: Uint8Array, fileName: string, at?: { x: number; y: number }): Promise<void> {
  // The note is opened again to show the picture, which would take it out of the room.
  if (sharedLive()) return reportError(t('picture.embedNotInRoom'));
  const taken = new Set(library.entries.map((e) => e.name.toLowerCase()));
  const dot = fileName.lastIndexOf('.');
  const stemName = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : '';
  let name = fileName;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stemName} ${n}${extension}`;
  const info = await saveSaved({ name, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, owner: account?.id });
  library.putLocal(info);
  if (account) scheduleUpload(info.id);
  await embedInNote(name, at);
  if (current.localId) openSource(`local:${current.localId}`, 'replace');
}

/** Insert ▸ Picture: choose a file, then put it in the document. */
function pickPicture(): void {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/heic,image/heif,.heic,.heif,image/svg+xml' });
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
/** The picture the selection is, with the frame around it. */
let selectedPicture: SelectionUpdate['picture'] = null;

function setSelectedPicture(picture: SelectionUpdate['picture']): void {
  selectedPicture = picture ?? null;
  awaitingSelection = false;
  const waiting = selectionWaiters;
  selectionWaiters = [];
  for (const resolve of waiting) resolve();
  pictureFrame.update(selectedPicture);
  if (pressed && !pressed.settled) settlePress();
  // A double click came before the worker said the first click had picked a picture.
  const wanted = pendingPictureEdit;
  pendingPictureEdit = null;
  if (wanted && selectedPicture && !selectedPicture.svg && onSelectedPicture(wanted.page, wanted.x, wanted.y)) void editPicture(selectedPicture);
}

/** A click was sent and the worker has not yet said what is selected now. */
let awaitingSelection = false;
/** Runs once the worker next says what is selected. */
let selectionWaiters: (() => void)[] = [];
const nextSelection = (): Promise<void> => new Promise((resolve) => selectionWaiters.push(resolve));

/**
 * Puts the selected picture on the clipboard as a PNG (what other apps take), and for a cut takes it out of the document.
 * Whether a picture was selected. The clipboard is given a promise of the picture, so the write starts while the click still counts.
 */
function copySelectedPicture(cut: boolean): boolean {
  const picture = selectedPicture;
  if (!picture || textView.active) return false;
  const png = worker
    .media(picture.part)
    .then((bytes) => transcode(bytes, 'png'))
    .then((bytes) => new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }));
  navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]).catch((e: Error) => reportError(t('picture.frame.copyFailed', { message: e.message })));
  if (cut) send({ kind: 'delete', direction: 'backward' });
  return true;
}

/** The menu for a picture of the text (a right click on it): it is selected first. */
async function pictureMenu(hit: { page: GpuPage; x: number; y: number }, at: { x: number; y: number }): Promise<boolean> {
  if (!onSelectedPicture(hit.page.id, hit.x, hit.y)) {
    send({ kind: 'pointer', page: hit.page.id, x: hit.x, y: hit.y });
    // Other updates (spelling marks) can arrive first: wait for the one that picks the picture.
    const until = performance.now() + 1500;
    while (!onSelectedPicture(hit.page.id, hit.x, hit.y) && performance.now() < until) await Promise.race([nextSelection(), new Promise((resolve) => setTimeout(resolve, 100))]);
  }
  const picture = selectedPicture;
  if (!picture || !onSelectedPicture(hit.page.id, hit.x, hit.y)) return false;
  const label = (key: Parameters<typeof t>[0]) => t(key).replace('&', '');
  showPopupMenu(
    [
      { label: label('chrome.edit.cut'), run: () => copySelectedPicture(true) },
      { label: label('chrome.edit.copy'), run: () => copySelectedPicture(false) },
      { label: label('chrome.pdfEdit.delete'), run: () => send({ kind: 'delete', direction: 'backward' }) },
      'separator',
      { label: t('picture.frame.edit'), run: () => void editPicture(picture), disabled: !!picture.svg || sharedLive() || !!current.shared },
    ],
    at.x,
    at.y,
    t('picture.detour.fileName'),
    focusInput,
  );
  return true;
}

/** Where a double click was, when the picture it is on had not been picked yet: it is opened in the image editor once it is. */
let pendingPictureEdit: { page: number; x: number; y: number } | null = null;

/** Whether a point of a page is on the selected picture. */
const onSelectedPicture = (page: number, x: number, y: number): boolean => !!selectedPicture && selectedPicture.page === page && x >= selectedPicture.x && x <= selectedPicture.x + selectedPicture.width && y >= selectedPicture.y && y <= selectedPicture.y + selectedPicture.height;
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
  setSelectedPicture(update.picture ?? null);
  if (editMathUntil > performance.now()) {
    editMathUntil = 0;
    if (math) chromeHost.perform({ kind: 'insertMath' });
  }
  updateCursor();
  if (update.search) findDialog.report(update.search);
  if (update.spell?.menu) {
    showSpellMenu(update.spell.issue, spellMenuAt);
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
onAutoFormat((on) => worker.command({ kind: 'autoFormat', on }));
onAutoCorrect(() => worker.command({ kind: 'autoCorrect', options: autoCorrectOptions(), replacements: autoCorrectReplacements() }));
onLivePreview((on) => worker.command({ kind: 'livePreview', on }));
let commandsSent = 0;
/** `commandsSent` when the document being opened was asked for. */
let commandsAtOpen = 0;

function send(command: WireCommand): void {
  // A drawing in the document is being edited: the document waits.
  if (embeddedDrawing) return;
  commandsSent++;
  if (command.kind !== 'move' && command.kind !== 'pointer' && command.kind !== 'selectAll' && command.kind !== 'find' && command.kind !== 'spellNext' && command.kind !== 'spellWords' && command.kind !== 'spellIgnored' && command.kind !== 'spellCheck' && command.kind !== 'autoFormat' && command.kind !== 'autoCorrect' && command.kind !== 'livePreview' && command.kind !== 'spellAt' && command.kind !== 'countWords' && command.kind !== 'getProperties') {
    editSent = performance.now();
    if (FORMATS[current.kind].editable || (annotating && ANNOTATION_EDITS.has(command.kind))) documentEdited();
  }
  worker.command(command);
}

function focusInput(): void {
  if (textView.active) return textEngine.focus();
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
  if (textView.active) {
    // A big text file: its own bounds, from the top-left corner however short or narrow it is, and drawn by the large-text editor.
    const area = textView.bounds();
    camera.clampToStart(area, canvas.clientWidth, canvas.clientHeight);
    const frame = textView.draw(pagesDark(), caretOn && document.hasFocus());
    lastStats = { pages: frame?.chunks ?? 0, visiblePages: frame?.chunks ?? 0, glyphs: frame?.glyphs ?? 0, drawCalls: frame?.drawCalls ?? 0 };
  } else {
    if (!pendingView) camera.clamp(bounds, canvas.clientWidth, canvas.clientHeight); // a restored position may lie past the pages that have arrived so far
    if (renderer.flat) camera.x = bounds.x;
    lastStats = renderer.render(camera, pages, selection, caretVisible, pagesDark());
  }
  const end = performance.now();
  // The caret blinks on an idle document; counting that would make idle read as a steady frame rate.
  if (!caretOnly) {
    frames.record(end, end - start);
    if (debugFlags().fps) flashRenderLight();
  }
  chrome.update({
    documentName: current.name,
    people: current.room?.people.some((p) => !p.me) ? current.room.people.filter((p) => !p.me) : NO_PEOPLE,
    renamable: renamable(),
    kind: textView.active ? 'largetext' : embeddedDrawing ? 'svg' : current.kind,
    hasSelection: textView.active ? textEngine.hasSelection : selection.text.length > 0,
    zoom: camera.zoom,
    pagesPanel: pagesOpen() && !textView.active && !reflowing(),
    filesPanel: filesOpen,
    footer: footerOn,
    toolbars: toolbarsOn,
    rulerVisible: rulerOn,
    format: selectionFormat,
    canUndo: textView.active ? textEngine.canUndo : isDrawing() && sharedLive() && isVectorFormat(current.kind as Format) ? vectorSteps.canUndo : isDrawing() || embeddedDrawing ? (vector?.editor.canUndo ?? false) : isPicture() ? layerSteps.canUndo || pictureHistory.undo.length > 0 : canUndo,
    canRedo: textView.active ? textEngine.canRedo : isDrawing() && sharedLive() && isVectorFormat(current.kind as Format) ? vectorSteps.canRedo : isDrawing() || embeddedDrawing ? (vector?.editor.canRedo ?? false) : isPicture() ? layerSteps.canRedo || pictureHistory.redo.length > 0 : canRedo,
    formMode: annotating ? formMode : null,
    painting,
    draw: { ...drawStyle, tool: drawLayer.tool, hasSelection: drawLayer.selection.length > 0, layers: layersOpen },
    vector: vector ? vector.state(layersOpen) : { ...DEFAULT_STATE.vector, layers: layersOpen },
    inTable,
    formattingMarks,
    viewMode: grid ? 'grid' : viewMode,
  });
  formLayer.position();
  pdfTextLayer.position();
  pdfTools.position();
  pointerLayer.position();
  pictureFrame.position();
  commentsPanel.position();
  syncPagesPanel();
  updateFooter();
  updateRuler();
  cropLayer.position();
  drawLayer.position();
  pictureLayers.setVisible(layersOpen && isPicture() && loaded);
  vector?.position(layersOpen);
  // The layers panel takes room from the view: a drawing still fitted to the window is fitted again.
  const layersShown = (layersOpen && !!vector?.editor.active) || (layersOpen && isPicture() && loaded);
  if (layersShown !== layersWereShown) {
    layersWereShown = layersShown;
    if ((isDrawing() || isPicture()) && loaded && !userMoved) placeCamera();
  }
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
    // Where the keyboard starts, for the sheets and bars fixed to the bottom of the page (iOS leaves them under it).
    document.documentElement.style.setProperty('--keyboard-inset', covered ? `${Math.max(0, window.innerHeight - visual.height - visual.offsetTop)}px` : '0px');
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
  // Putting the caret down is what shows the phone's typing bar (see Chrome.trackTyping).
  document.dispatchEvent(new Event('wm-caret'));
  if (textView.active) {
    textView.press(e.offsetX, e.offsetY, e.shiftKey, clickCount(e));
    return;
  }
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
  // The link is read where the pointer is, before the click moves the caret: with Markdown at the caret on, the caret's paragraph turns into its source and the link is no longer there to find.
  if (e.metaKey || e.ctrlKey) void worker.linkAt(hit.page.id, hit.x, hit.y).then((found) => found.url && followLink(found.url));
  const clicks = clickCount(e);
  // A double click on a vector drawing in the text edits the drawing.
  if (clicks === 2 && !embeddedDrawing && FORMATS[current.kind].editable && !isDrawing()) {
    const image = hit.page.images.find((i) => i.svg && hit.x >= i.x && hit.x <= i.x + i.width && hit.y >= i.y && hit.y <= i.y + i.height);
    // A drawing embedded from another document is saved into that document, and this one reopened: that takes it out of a room.
    if (image?.svg && !(image.embed !== undefined && sharedLive())) return void editEmbeddedDrawing(hit.page.id, image.svg, image.embed);
  }
  // ...and on a picture, in the image editor: the click before it selected the picture.
  if (clicks === 2 && FORMATS[current.kind].editable) {
    if (selectedPicture && !selectedPicture.svg && onSelectedPicture(hit.page.id, hit.x, hit.y)) return void editPicture(selectedPicture);
    if (awaitingSelection) pendingPictureEdit = { page: hit.page.id, x: hit.x, y: hit.y };
  }
  const unit = clicks === 2 ? 'word' : clicks >= 3 ? 'paragraph' : 'character';
  if (clicks === 2) editMathUntil = performance.now() + 1000;
  send({ kind: 'pointer', page: hit.page.id, x: hit.x, y: hit.y, extend: e.shiftKey && unit === 'character', unit });
  awaitingSelection = true;
  selecting = unit === 'character';
  // Whether this press landed on a picture is known once the worker answers: until then a drag waits.
  pressed = selecting && !e.shiftKey ? { page: hit.page.id, x: hit.x, y: hit.y, clientX: e.clientX, clientY: e.clientY, settled: false, grab: false } : null;
  pictureDrag = null;
  waitingDrag = null;
}

/** The press that is still down: where it was, and, once the worker has answered it, whether it took hold of a picture (a drag then moves the picture instead of selecting text). */
let pressed: { page: number; x: number; y: number; clientX: number; clientY: number; settled: boolean; grab: boolean } | null = null;
/** A selecting drag that came before the worker said what the press hit. */
let waitingDrag: { x: number; y: number } | null = null;
/** A picture being dragged: how far the pointer has gone (CSS pixels). */
let pictureDrag: { dx: number; dy: number } | null = null;
const PICTURE_DRAG_SLOP_PX = 4;

function settlePress(): void {
  const down = pressed;
  if (!down) return;
  down.settled = true;
  down.grab = onSelectedPicture(down.page, down.x, down.y);
  if (down.grab) {
    selecting = false;
    pendingDrag = null;
    waitingDrag = null;
    return;
  }
  const drag = waitingDrag;
  waitingDrag = null;
  const hit = drag && selecting && pageAt(drag.x, drag.y);
  if (hit) send({ kind: 'pointer', page: hit.page.id, x: hit.x, y: hit.y, extend: true });
}

/** The pointer moved with the button down over a picture: the frame follows it. */
function dragPicture(e: PointerEvent): void {
  const down = pressed;
  if (!down) return;
  const dx = e.clientX - down.clientX;
  const dy = e.clientY - down.clientY;
  if (!pictureDrag && Math.hypot(dx, dy) < PICTURE_DRAG_SLOP_PX) return;
  pictureDrag = { dx, dy };
  pictureFrame.shift(dx, dy);
  canvas.style.cursor = 'move';
}

/** The button went up: a dragged picture is put where the pointer is. */
function dropPicture(e: PointerEvent): void {
  const dragged = pictureDrag;
  const picture = selectedPicture;
  const down = pressed;
  pictureDrag = null;
  pressed = null;
  waitingDrag = null;
  pictureFrame.shift(0, 0);
  if (!dragged || !picture || !down) return;
  const hit = pageAt(e.offsetX, e.offsetY);
  if (!hit) return;
  // A floating picture keeps the grip it was taken by; one in line with the text goes to the text at the pointer.
  const x = picture.floating ? hit.x - (down.x - picture.x) : hit.x;
  const y = picture.floating ? hit.y - (down.y - picture.y) : hit.y;
  send({ kind: 'moveDrawing', page: hit.page.id, x, y });
}

// Touch: one finger drags the page, two pinch and pan it, and a tap (a press that never moved) puts the caret down.
const TOUCH_SLOP_PX = 8;
const touches = new Map<number, { x: number; y: number }>();
let touchTap: Press | null = null;
/** Two or more fingers were down in this gesture: until every finger is up, nothing in it is a tap. */
let touchMulti = false;
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
  // A first finger starts a new gesture; a finger whose release was never seen must not count as a second one.
  if (e.isPrimary) {
    touches.clear();
    touchMulti = false;
  }
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touches.size > 1) touchMulti = true;
  if (touches.size === 1 && !touchMulti) {
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
  if (touchTap && !touchMulti && touches.size === 0 && e.type === 'pointerup') press(touchTap);
  touchTap = null;
  if (touches.size === 0) touchMulti = false;
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
  // Control-click on a Mac is a right click: the contextmenu event follows, and the button's release may never arrive, so it is not the start of a selection.
  if (MAC && e.ctrlKey) {
    canvas.releasePointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
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
/** The pointer is over the check box of a task list item: a click changes it. */
let overCheckbox = false;
/** The pointer is over the selected picture: a drag moves it. */
let overPicture = false;
let linkKeyDown = false;
function updateCursor(): void {
  // The vector editor sets the cursor itself, from what is under the pointer.
  if (isDrawing() && vector?.editor.active) return;
  // The picture tools do the same.
  if (isPicture() && drawLayer.active) return;
  const cursor = painting ? 'copy' : overPicture && !selecting && !pan ? 'move' : overCheckbox && !selecting && !pan ? 'pointer' : overLink && linkKeyDown && !selecting && !pan ? 'pointer' : '';
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
    const found = hit ? await worker.linkAt(hit.page.id, hit.x, hit.y) : null;
    const url = found?.url ?? null;
    hoverBusy = false;
    overLink = url !== null && hoverInside;
    overCheckbox = !!found?.checkbox && hoverInside;
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
  overCheckbox = false;
  overPicture = false;
  updateCursor();
  pointerTip(null, 0, 0);
});

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return touchMove(e);
  if (e.buttons === 0) spellHoverMoved(e);
  else spellHoverStop();
  pointerMoved(e.offsetX, e.offsetY);
  hoverInside = true;
  const over = selectedPicture ? pageAt(e.offsetX, e.offsetY) : null;
  const overBefore = overPicture;
  overPicture = !!over && onSelectedPicture(over.page.id, over.x, over.y) && !pressed?.grab;
  if (overPicture !== overBefore) updateCursor();
  linkKeyChanged(e);
  if (textView.active) {
    // A big text file: a drag selects (or pans, with the middle button), and there are no links to hover.
    if (pan) {
      userMoved = true;
      camera.panBy(pan.x - e.clientX, pan.y - e.clientY);
      pan = { x: e.clientX, y: e.clientY };
      requestRender();
    } else textView.drag(e.offsetX, e.offsetY);
    return;
  }
  if (!pan && !selecting) hoverLink({ x: e.offsetX, y: e.offsetY, clientX: e.clientX, clientY: e.clientY });
  if (pan) {
    userMoved = true;
    camera.panBy(pan.x - e.clientX, pan.y - e.clientY);
    pan = { x: e.clientX, y: e.clientY };
    requestRender();
    return;
  }
  if (pressed?.grab) return dragPicture(e);
  if (!selecting) return;
  // Still waiting to hear what the press landed on.
  if (pressed && !pressed.settled) {
    waitingDrag = { x: e.offsetX, y: e.offsetY };
    return;
  }
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
  textView.release();
};
canvas.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'touch') return touchUp(e);
  if (pressed?.grab) dropPicture(e);
  pressed = null;
  endPointer();
  // With the Format Painter picked up, what was just selected is painted.
  if (painting) send({ kind: 'applyPainter' });
});
canvas.addEventListener('pointercancel', (e) => {
  if (e.pointerType === 'touch') return touchUp(e);
  pictureDrag = null;
  pressed = null;
  pictureFrame.shift(0, 0);
  endPointer();
});

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

/** An editing key (see ui/textInput.ts) as commands for the document (page keys are the view's: see `viewKey`). */
function editingCommand(key: EditKey | null): WireCommand[] | null {
  if (!key) return null;
  switch (key.kind) {
    case 'move':
      return key.to === 'pageUp' || key.to === 'pageDown' ? null : [{ kind: 'move', to: key.to, extend: key.extend }];
    case 'delete':
      // A Mac's Cmd+Backspace deletes back to the start of the line.
      if (key.unit === 'line') return [{ kind: 'move', to: 'lineStart', extend: true }, { kind: 'delete', direction: 'backward' }];
      return [{ kind: 'delete', direction: key.direction, unit: key.unit }];
    case 'enter':
      return [{ kind: key.shift ? 'insertLineBreak' : 'insertParagraph' }];
    case 'tab':
      // Between a table's cells, or a tab character.
      return [{ kind: 'tab', backward: key.backward }];
    default:
      return [{ kind: key.kind }];
  }
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

function toggleToolbars(): void {
  toolbarsOn = !toolbarsOn;
  try {
    localStorage.setItem(TOOLBARS_KEY, toolbarsOn ? 'on' : 'off');
  } catch {
    // Storage unavailable: the choice lasts for this session only.
  }
  // The toolbars take room from the document: the canvas is resized by its observer, and the view is placed again.
  requestRender();
}

function toggleRuler(): void {
  rulerOn = !rulerOn;
  try {
    localStorage.setItem(RULER_KEY, rulerOn ? 'on' : 'off');
  } catch {
    // Storage unavailable: the choice lasts for this session only.
  }
  // The strip takes room from the document: the canvas is resized by its observer, and the view is placed again.
  requestRender();
}

/** Print, Flow or the page grid. Print and Flow are remembered; the grid lasts until another document opens. */
function setViewMode(mode: ViewMode): void {
  if (mode === 'grid') {
    if (grid) return;
    grid = true;
  } else {
    if (!grid && mode === viewMode) return;
    grid = false;
    viewMode = mode;
    try {
      localStorage.setItem(VIEW_KEY, mode);
    } catch {
      // Storage unavailable: the choice lasts for this session only.
    }
  }
  cameraPlaced = false;
  userMoved = false;
  pendingView = null;
  syncReflow(true);
  arrange();
}

/** The page grid, or back to the view before it. */
function toggleGrid(): void {
  setViewMode(grid ? viewMode : 'grid');
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

/** Ctrl/Cmd+S: documents save themselves; the habit just saves a little sooner. */
function saveKey(): void {
  if (current.shared) void uploadShared();
  else if (current.unsavedSince || (!current.localId && !current.builtIn)) void saveInBrowser();
  else if (account) void flushUploads();
  else setStatus(t('app.allSaved'));
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
    e.preventDefault();
    saveKey();
    return;
  }
  // Editing text in a box over a PDF page: the caret keys, selection and the rest are the browser's.
  if (inEditableBox) return;
  if (viewKey(e)) {
    e.preventDefault();
    return;
  }
  // A dialog keeps its keys, and Enter or Space on a button reached with the keyboard (in a dialog-like list, the Files sidebar) is its click, not a new paragraph.
  if (e.defaultPrevented || modalOpen()) return;
  if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof HTMLElement && e.target.tabIndex >= 0 && e.target.matches('button, a[href], [role="button"], [role="treeitem"]')) return;
  const commands = editingCommand(editKey(e, MAC));
  if (!commands) return;
  e.preventDefault();
  if (document.activeElement !== input) focusInput();
  for (const command of commands) send(command);
});

// Typed text, input methods, copy, cut and paste in the hidden textarea (ui/textInput.ts).
attachTextInput(input, {
  insert: (text) => send({ kind: 'insertText', text }),
  key: (key) => {
    for (const command of editingCommand(key) ?? []) send(command);
  },
  copy: () => selection.text,
  copyOther: (cut) => copySelectedPicture(cut),
  cut: () => {
    if (selection.text) send({ kind: 'delete', direction: 'backward' });
  },
  paste: (clip) => pasteClipboard(clip),
});

/** HTML larger than this is pasted as plain text (reading it would take too long). */
const MAX_PASTED_HTML = 2_000_000;

/** Pastes what came from the clipboard: formatted if it has formatting and the document can hold it. */
function pasteClipboard(clip: Clipboard, form: 'auto' | 'html' | 'text' = 'auto'): void {
  const formatted = FORMATS[current.kind].marks.length > 0;
  if (clip.html && form !== 'text' && formatted && clip.html.length <= MAX_PASTED_HTML) send({ kind: 'pasteHtml', html: clip.html, text: clip.text ?? '' });
  else if (clip.text) send({ kind: 'insertText', text: clip.text });
}

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
  prepareNew: async (folderId) => {
    if (folderId !== undefined) {
      newDocumentFolder = folderId;
      return;
    }
    // A document not saved yet: the new one goes where it was going to be filed.
    const localId = current.localId;
    if (!localId) {
      newDocumentFolder = current.newFolder;
      return;
    }
    const { entries, folders } = await loadLocalLibrary(accountForFiles());
    const here = entries.find((e) => e.local?.id === localId);
    newDocumentFolder = here ? folderOf(here, folders) : null;
  },
  loading: (name) => (name === null ? loadingScreen.hide() : showLoading(name)),
  canvas,
  camera,
  pages: () => pages,
  bounds: () => (textView.active ? textEngine.bounds() : bounds),
  open: (source) => {
    setUrl(new URLSearchParams(), true);
    open(source, { store: true });
  },
  openSample: openSource,
  syncNow,
  share,
  download,
  downloadAll,
  importZip,
  importPicked: (files) => importDropped(pickedFolder(files)),
  toggleClip: () => assistant.setVisible(!assistant.visible),
  print,
  showSearchAll: () => searchPanel.show(),
  showFind: (tab) => (textView.active ? textEngine.find(tab) : findDialog.show(tab)),
  showSpelling: () => spellDialog.open(),
  showWordCount: () => wordCountDialog.open(),
  showOptions: () => showOptions(focusInput),
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
  showVersionHistory: () => {
    // What was typed a moment ago is part of the history it is about to show.
    saveIfEdited();
    void saving.then(() => versionHistoryDialog.open());
  },
  showTrash: () => trashDialog.open(),
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
  documentReady: nextDocumentReady,
  imageAction: pictureAction,
  engine: () => (textView.active ? textEngine : null),
  openSelection,
  openLarge,
  drawStyle: (change) => setDrawStyle(change),
  vectorAction: (op) => (op === 'layers' ? toggleLayers() : vector?.action(op)),
  vectorStyle: (change) => vector?.style(change),
  vectorGradient: (change) => vector?.gradient(change),
  isDrawing: () => isDrawing() || !!embeddedDrawing,
  pickPicture,
  insertDrawing: () => insertDrawing(),
  isPicture: () => isPicture() || isDrawing() || !!embeddedDrawing,
  stepPicture,
  signIn,
  signOut,
  subscribe,
  manageSubscription,
  clearLocalData,
  saved: () => library.entries.map((e) => ({ id: sourceOf(e), label: e.name.replace(/&/g, '&&') })),
  send,
  annotating: () => annotating,
  setFormMode,
  author: commentAuthor,
  startComment: () => commentsPanel.startDraft(),
  selectedText: () => selection.text,
  copyPicture: (cut) => !textView.active && copySelectedPicture(cut),
  focusEditor: focusInput,
  notify: reportError,
  toggleGrid,
  togglePagesPanel,
  toggleFilesPanel,
  toggleFooter,
  toggleToolbars,
  toggleRuler,
  setViewMode,
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
  find: (query, backward) => send({ kind: 'find', ...query, backward }),
  replace: (query, replacement) => {
    const put = replacementFor(selection.text, { text: query.text, caseSensitive: query.matchCase, wholeWord: query.wholeWord, regex: query.regex }, replacement);
    if (put !== null) send(put ? { kind: 'insertText', text: put } : { kind: 'delete', direction: 'backward' });
    send({ kind: 'find', ...query });
  },
  replaceAll: (query, replacement) => send({ kind: 'replaceAll', ...query, with: replacement }),
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

// File ▸ Version History: the versions this browser and (for a document in the account) the account kept of the open document.
/** Tells the person something short, in the status bar and a toast. */
function say(text: string): void {
  setStatus(text);
  showToast(text);
}

/** The open document as history knows it, or null if it has never been saved (the welcome document, say). */
function historyTarget(): HistoryTarget | null {
  if (current.shared) return { localId: null, cloudId: current.shared.id };
  if (!current.localId) return null;
  const local = library.entries.find((e) => e.local?.id === current.localId)?.local;
  return { localId: current.localId, cloudId: account ? (local?.cloudId ?? null) : null };
}

/** Makes a new document from a kept version and opens it; the document the version is of stays as it is. */
async function openVersion(entry: HistoryEntry): Promise<string> {
  const target = historyTarget();
  if (!target) throw new Error(t('history.gone'));
  const name = restoredName(current.name || t('app.newDocumentName'), entry.version, getLocale());
  if (entry.source === 'account') {
    const made = await restoreFromAccount(target, entry, name);
    await refreshLibrary();
    void openCloud(made.id);
    return made.name;
  }
  const bytes = await deviceVersionBytes(target.localId!, entry.version);
  if (!bytes) throw new Error(t('history.gone'));
  const info = await saveSaved({ name, bytes, owner: account?.id });
  library.putLocal(info);
  if (account) scheduleUpload(info.id);
  openSource(`local:${info.id}`);
  return info.name;
}

const versionHistoryDialog = new VersionHistoryDialog({
  target: historyTarget,
  canEdit: () => current.shared?.role !== 'viewer',
  openVersion,
  tell: say,
  focusEditor: focusInput,
});

// File ▸ Trash: what was deleted from this browser and from the account.
const trashDeps: TrashDeps = {
  hasAccount: () => account !== null,
  // A document made while signed out can be brought back by whoever is signed in now (it is adopted, like the guest documents at sign-in).
  listDevice: async () =>
    (await listTrashedSaved())
      .filter(({ info }) => info.owner === undefined || info.owner === account?.id)
      .map(({ info, deletedAt }): TrashItem => ({ source: 'device', id: info.id, name: info.name, size: info.size, deletedAt, purgeAt: deletedAt + TRASH_MS })),
  listAccount: async () => (await listTrash()).map((d): TrashItem => ({ source: 'account', id: d.id, name: d.name, size: d.size, deletedAt: d.deletedAt, purgeAt: d.purgeAt })),
  async restore(item) {
    if (item.source === 'account') {
      await restoreFromTrash(item.id);
      return;
    }
    const info = await restoreTrashedSaved(item.id, account?.id);
    if (!info) throw new Error(t('trash.gone'));
    library.putLocal(info);
    if (account) scheduleUpload(info.id);
  },
  async purge(item) {
    if (!item || item.source === 'device') await purgeTrashedSaved(item?.id);
    if (account && (!item || item.source === 'account')) await purgeTrash(item?.id);
  },
};
const trashDialog = new TrashDialog({ deps: trashDeps, restored: () => void refreshLibrary(), tell: say, focusEditor: focusInput });

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
/**
 * The keys a document's ignored words are kept under, best first: its account's id for it when it has one (the same on every device),
 * then its id in this browser. None while it is unsaved (the welcome document, or a new one before its first save): it is ignored for as long as it is open.
 */
function ignoredKeys(doc: OpenDocument): string[] {
  if (doc.builtIn) return [];
  const cloudId = doc.shared?.id ?? library.local.find((d) => d.id === doc.localId)?.cloudId;
  return [...(cloudId ? [`cloud:${cloudId}`] : []), ...(doc.localId ? [`local:${doc.localId}`] : [])];
}

/** A document has opened: what was ignored in it before is ignored again (the layout worker forgot the last document's). */
function startIgnored(doc: OpenDocument): void {
  doc.ignored = ignoredKeys(doc).reduce((all, key) => {
    const saved = loadIgnored(key);
    return withIgnored(all, saved.words, saved.rules);
  }, doc.ignored);
  send({ kind: 'spellIgnored', ...doc.ignored });
}

/** Writes what is ignored in the document where it is kept (once it has an id to be kept under). */
function rememberIgnored(doc: OpenDocument): void {
  const [key] = ignoredKeys(doc);
  if (key) saveIgnored(key, doc.ignored);
}

/** Ignore All and Ignore Rule: in the open document from now on, and the next time it is opened. */
function ignoreInDocument(words: string[], rules: string[]): void {
  current.ignored = withIgnored(current.ignored, words, rules);
  rememberIgnored(current);
  send({ kind: 'spellIgnored', ...current.ignored });
  // What counts as a mistake changed: a plain text file in the text editor is checked again.
  textView.spellReset();
}

const spellDialog: SpellDialog = new SpellDialog(document.body, {
  ignore: ignoreInDocument,
  send: (command) => {
    // A plain text file is checked by the text editor (the layout worker still holds the dictionaries and the words that were added or ignored).
    if (textView.active) {
      if (command.kind === 'spellNext') {
        void textView.spellNext(command.from, command.grammar).then((issue) => spellDialog.report({ issue }));
        return;
      }
      if (command.kind === 'insertText') return textEngine.insert(command.text);
      if (command.kind === 'replaceAll') {
        void textView.editor?.replaceFile({ text: command.text, caseSensitive: command.matchCase ?? false, wholeWord: command.wholeWord ?? false, regex: false }, command.with);
        return;
      }
    }
    send(command);
    // What counts as a mistake changed: a plain text file in the text editor is checked again.
    if (command.kind === 'spellCheck' || command.kind === 'spellWords') textView.spellReset();
  },
  selectedText: () => (textView.active ? (textView.selectedText ?? '') : selection.text),
  userWords,
  addUserWord,
  focusEditor: focusInput,
});

// Right click on an underlined word: change it, or ignore it.
const spellMenu = new SpellMenu({
  ignore: ignoreInDocument,
  send: (command) => {
    // In a plain text file the problem is selected: the suggestion types over it.
    if (textView.active && command.kind === 'insertText') textEngine.insert(command.text);
    else send(command);
    if (command.kind === 'spellWords') textView.spellReset();
  },
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

/** Where the menu being asked for goes, and, when the pointer only rests on the mistake, the point to select it at if a suggestion is chosen. */
type SpellMenuAt = { x: number; y: number; hover?: { page: number; px: number; py: number } };
let spellMenuAt: SpellMenuAt | null = null;

/** The menu for a mistake the layout worker found at a point: after a right click, or because the pointer rested there. */
function showSpellMenu(issue: SpellIssue | null, at: SpellMenuAt | null): void {
  if (!at) return;
  if (!at.hover) {
    if (issue) spellMenu.show(issue, at.x, at.y);
    return;
  }
  // The pointer rested here: a right-click menu that is open is left alone; the mistake menu follows the pointer from one mistake to the next, and goes when it is on none.
  if (spellMenu.isOpen && !spellMenu.isHover) return;
  if (!issue) return spellMenu.close(false);
  if (spellMenu.isHover && spellMenu.issue?.text === issue.text && spellMenu.issue.message === issue.message) return;
  const { page, px, py } = at.hover;
  const select = () => void (textView.active ? textView.spellIssueAt(px, py) : send({ kind: 'spellAt', page, x: px, y: py }));
  spellMenu.show(issue, at.x, at.y + SPELL_HOVER_BELOW_PX, { select });
}

// The pointer resting on a squiggle opens the same menu after a pause (it does not move the caret or select the word, so typing is not in its way).
const SPELL_HOVER_DELAY_MS = 600;
/** The menu opens this far under the pointer, so it does not cover the word. */
const SPELL_HOVER_BELOW_PX = 18;
/** The pointer may cross this much space between the word and its menu without the menu going. */
const SPELL_HOVER_BRIDGE_PX = 32;
let spellHoverTimer = 0;

function spellHoverStop(): void {
  window.clearTimeout(spellHoverTimer);
  spellHoverTimer = 0;
}

/** The pointer moved over the document with no button down: look for a mistake under it once it is still. */
function spellHoverMoved(e: PointerEvent): void {
  spellHoverStop();
  if (spellMenu.isOpen && !spellMenu.isHover) return;
  // On the menu (or the way to it): it stays.
  if (spellMenu.isHover && spellMenu.near(e.clientX, e.clientY, SPELL_HOVER_BRIDGE_PX)) return;
  if (!spellMenu.isHover && !spellDialog.checkingLive) return;
  const at = { x: e.clientX, y: e.clientY, ox: e.offsetX, oy: e.offsetY };
  spellHoverTimer = window.setTimeout(() => {
    spellHoverTimer = 0;
    // Only while the editor has the keyboard (not while the person types in a dialog), and nothing else is in the way.
    const editing = textView.active ? textView.hasFocus : document.activeElement === input;
    if (!editing || annotating || !loaded) return;
    if (textView.active) {
      void textView.spellIssueAt(at.ox, at.oy, false).then((issue) => showSpellMenu(issue, { x: at.x, y: at.y, hover: { page: 0, px: at.ox, py: at.oy } }));
      return;
    }
    const hit = pageAt(at.ox, at.oy);
    if (!hit) return void (spellMenu.isHover && spellMenu.close(false));
    spellMenuAt = { x: at.x, y: at.y, hover: { page: hit.page.id, px: hit.x, py: hit.y } };
    send({ kind: 'spellAt', page: hit.page.id, x: hit.x, y: hit.y, select: false });
  }, SPELL_HOVER_DELAY_MS);
}
canvas.addEventListener('pointerleave', spellHoverStop);
canvas.addEventListener('pointerdown', spellHoverStop, true);
window.addEventListener('keydown', spellHoverStop, true);

canvas.addEventListener('contextmenu', (e) => {
  // The menu takes the pointer: a press that was under way is over, and the editor keeps the keyboard.
  endPointer();
  if (textView.active) {
    // A plain text file: the same menu, from the text editor's own marks.
    if (!spellDialog.checkingLive) return;
    e.preventDefault();
    const at = { x: e.clientX, y: e.clientY };
    void textView.spellIssueAt(e.offsetX, e.offsetY).then((issue) => {
      if (issue) spellMenu.show(issue, at.x, at.y);
    });
    return;
  }
  if (annotating) return;
  const hit = pageAt(e.offsetX, e.offsetY);
  if (!hit) return;
  // A picture of the text has its own menu (a mistake under a picture is not shown, so it is the picture's).
  if (FORMATS[current.kind].editable && !isPicture() && !isDrawing() && hit.page.images.some((i) => hit.x >= i.x && hit.x <= i.x + i.width && hit.y >= i.y && hit.y <= i.y + i.height)) {
    e.preventDefault();
    focusInput();
    const at = { x: e.clientX, y: e.clientY };
    void pictureMenu(hit, at).then((shown) => {
      if (!shown && spellDialog.checkingLive) {
        spellMenuAt = at;
        send({ kind: 'spellAt', page: hit.page.id, x: hit.x, y: hit.y });
      }
    });
    return;
  }
  if (!spellDialog.checkingLive) return;
  e.preventDefault();
  focusInput();
  spellMenuAt = { x: e.clientX, y: e.clientY };
  send({ kind: 'spellAt', page: hit.page.id, x: hit.x, y: hit.y });
});

// The dashboard of all documents (File ▸ Dashboard). Opening a document from it goes through the
// same paths as File ▸ Open Recent.
/** What the Documents screen and the Files Sidebar both ask of the app: one copy, so the two can't drift apart. */
const libraryHost = {
  open: (entry: LibraryEntry) => {
    newDocumentFolder = null;
    showLoading(entry.name);
    openSource(sourceOf(entry));
  },
  warm: (entry: LibraryEntry) => {
    if (entry.cloud && opensFromCloud(entry)) prefetchFromCloud({ id: entry.cloud.id, updatedAt: entry.cloud.updatedAt });
  },
  newDocument: (folderId: string | null, docKind?: DocumentKind) => {
    void Promise.resolve(chromeHost.perform({ kind: 'new', folderId, docKind })).then(focusInput);
  },
  importFile: (folderId: string | null) => void chromeHost.perform({ kind: 'import', folderId }),
  importFolder: (folderId: string | null) => void chromeHost.perform({ kind: 'importFolder', folderId }),
  dropFile,
  delete: deleteEverywhere,
  share: (id: string, name: string) => showShareDialog({ name, people: { id } }),
  // Whose documents to list: before the plan is known, the account last signed in here (a head start).
  account: accountForFiles,
  signedIn: () => signedIn,
};

/** The open document's ids: in this browser, and in the account (its own copy's, or one shared with this user). */
const openDocumentIds = (): { localId: string | null; cloudId: string | null } => ({
  localId: current.localId,
  cloudId: current.shared?.id ?? library.local.find((d) => d.id === current.localId)?.cloudId ?? null,
});

const dashboard = new Dashboard(document.body, {
  ...libraryHost,
  currentDocument: openDocumentIds,
  openShared: (doc) => {
    sharedDocs.set(doc.id, doc);
    openSource(`shared:${doc.id}`);
  },
  closed: focusInput,
  showTrash: () => trashDialog.open(),
  contentMatches: async (query) => {
    const docs = await searchableNow();
    // Copies kept here are indexed in the background a few seconds after a change; a search doesn't wait for that.
    await searchLibrary.sync(docs, { remote: false }).catch(() => {});
    return new Set((await searchLibrary.search(query, docs)).hits.map((h) => h.key));
  },
}, library);

// Signed out, documents live only in this browser: offer to clear them (for shared computers).
const sharedDeviceNotice = new SharedDeviceNotice(document.body, () => void clearLocalData());

// A new release: offer What's New (once per version, unless turned off).
new NewVersionNotice(document.body, () => openSource('changelog'));

/**
 * The person's other documents, for the assistant: this browser's copies and the account's, and
 * what others shared with them. Everything but the open document.
 */
const otherDocuments = new OtherDocuments(async () => {
  const own: StoredDocument[] = library.entries
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
}, searchServer, async (query) => {
  const docs = await searchableNow();
  await searchLibrary.sync(docs);
  return searchLibrary.search(query, docs);
});

// --- Searching every document ------------------------------------------------------------------
// Each document has an index kept in this browser (see search/searchLibrary.ts); the panel searches
// those. Copies kept here are indexed in the background; the rest (documents only the account has,
// and what others shared) when someone searches.

// Documents are opened and tokenized in a worker of their own, never on the page.
const indexWorker = new IndexWorker(() => new Worker(new URL('./search/indexWorker.ts', import.meta.url), { type: 'module', name: 'search-index' }));
const searchLibrary = new SearchLibrary({ list: listSearchIndexes, put: putSearchIndex, remove: deleteSearchIndexes }, (bytes) => indexWorker.build(bytes));
const searchSources: SourceDeps = { local: async (id) => (await getSaved(id))?.bytes, download: downloadDocument, index: downloadIndex };
const searchableNow = () => searchableDocuments(library.entries, signedIn ? library.shared : [], searchSources);

/** How long after the library changes the background indexing starts (editing usually goes on). */
const SEARCH_INDEX_DELAY_MS = 5000;
let searchIndexTimer: number | undefined;
library.subscribe(() => {
  window.clearTimeout(searchIndexTimer);
  searchIndexTimer = window.setTimeout(() => void searchLibrary.sync(searchableNow(), { remote: false }).catch((e) => console.error('indexing failed', e)), SEARCH_INDEX_DELAY_MS);
});

/** Selects the start of `jump.paragraph` in the open document and finds `jump.find` from there. */
function goToHit(jump: { paragraph?: number; find: string }): void {
  if (jump.paragraph === undefined) return;
  // A text file's paragraphs are its lines.
  if (textView.active) return textView.editor?.goToLine(jump.paragraph + 1);
  send({ kind: 'select', paragraph: jump.paragraph, from: 0, to: 0 });
  if (jump.find) send({ kind: 'find', text: jump.find, matchCase: false });
}

/** Opens the document a search result is for, at the paragraph that matched. */
function openSearchHit(hit: SearchHit, find: string): void {
  const entry = library.entries.find((e) => e.key === hit.key);
  const shared = entry ? undefined : library.shared.find((d) => d.id === hit.key);
  const source = entry ? sourceOf(entry) : shared ? `shared:${shared.id}` : null;
  if (!source) return;
  // A PDF's "paragraphs" in the index are its pages: there is no caret to put in one.
  const jump = { source, ...(hit.paragraph !== undefined && !/\.pdf$/i.test(hit.name) && { paragraph: hit.paragraph }), find };
  if (source === viewDocKey && loaded) {
    goToHit(jump);
    focusInput();
    return;
  }
  pendingJump = jump;
  if (entry) libraryHost.open(entry);
  else if (shared) {
    sharedDocs.set(shared.id, shared);
    showLoading(shared.name);
    openSource(source);
  }
}

const searchPanel = new SearchPanel({
  documents: async () => searchableNow(),
  search: (text, docs) => searchLibrary.search(text, docs),
  tags: (docs) => searchLibrary.tags(docs),
  sync: (docs) => searchLibrary.sync(docs),
  onProgress: (listener) => searchLibrary.subscribe(listener),
  open: openSearchHit,
  focusEditor: focusInput,
});

/** The folders documents are kept in: the account's, or this browser's. */
const listFoldersHere = async (): Promise<Folder[]> => (account ? await listFolders() : await listLocalFolders());

// The assistant's tools that act on the app rather than the document's text (see assistant/appTools.ts).
// --- What the assistant does with drawings in the text and with editing together --------------------------------------------

/** The drawings in the text, in reading order: where each is, and what is needed to open it. */
function textDrawingRefs(): { number: number; pageId: number; svg: string; embed?: string; width: number; height: number }[] {
  const out: { number: number; pageId: number; svg: string; embed?: string; width: number; height: number }[] = [];
  pages.forEach((page, index) => {
    for (const image of page.images) {
      if (!image.svg) continue;
      // Points to pixels at 96 dpi.
      out.push({ number: index + 1, pageId: page.id, svg: image.svg, ...(image.embed !== undefined && { embed: image.embed }), width: Math.round((image.width * 4) / 3), height: Math.round((image.height * 4) / 3) });
    }
  });
  return out;
}

async function openTextDrawing(index: number): Promise<string | null> {
  if (isDrawing()) return 'the open document is a drawing already.';
  if (embeddedDrawing) return 'a drawing in the text is being edited: close it first (text_drawings close).';
  const ref = textDrawingRefs()[index];
  if (!ref) return `there is no drawing ${index}: see text_drawings list.`;
  if (!FORMATS[current.kind].editable) return 'this document cannot be changed.';
  // A drawing embedded from another document is saved into that one, and this one is opened again: that takes it out of a room.
  if (ref.embed !== undefined && sharedLive()) return 'a drawing embedded from another document cannot be edited while others are editing this one.';
  await editEmbeddedDrawing(ref.pageId, ref.svg, ref.embed);
  return embeddedDrawing ? null : 'the drawing could not be opened.';
}

async function closeTextDrawing(): Promise<string | null> {
  if (!embeddedDrawing) return 'no drawing in the text is open.';
  await leaveEmbeddedDrawing();
  return embeddedDrawing ? 'the drawing could not be put back.' : null;
}

async function insertTextDrawing(size: { width?: number; height?: number }): Promise<string | null> {
  if (isDrawing() || isPicture()) return 'the open document is not text.';
  if (embeddedDrawing) return 'a drawing in the text is being edited: close it first (text_drawings close).';
  if (!FORMATS[current.kind].editable || !chromeHost.supports({ kind: 'insertDrawing' })) return 'a drawing cannot be put in this kind of document (Word and Markdown can hold them).';
  if (current.kind === 'md' && sharedLive()) return 'a drawing cannot be added to a Markdown note while others are editing it.';
  insertDrawing(size);
  // It opens for drawing once it is in the text (a Markdown note is stored, embedded and opened again first).
  for (let waited = 0; waited < 20_000; waited += 100) {
    if (embeddedDrawing) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return 'the drawing was not put in the text.';
}

/** Who is editing the open document with this person. */
function collaboration(): Collaboration {
  const net = current.room;
  const people = net ? net.people.map((p) => (p.me ? `${p.name} (you)` : p.name)) : [];
  const count = net ? net.people.length : 1;
  const holder = net?.holder ? { ...net.holder, here: !net.watching } : null;
  return { shared: count > 1, people, count, holder };
}

const assistantTools = appTools({
  textEditor: () => textView.editor,
  current: () => current,
  documentName: () => current.name,
  documentKind: () => current.kind,
  agent: (name, args) => worker.agent(name, args),
  files: {
    cloud: () => account !== null,
    entries: () => library.entries,
    folders: listFoldersHere,
    deleteEntries: (entries, folderIds) => deleteEverywhere(entries, folderIds),
    trash: async () => (await loadTrash(trashDeps)).items,
    restoreFromTrash: (ids) => restoreById(trashDeps, ids),
    changed: () => refreshLibrary(),
  },
  history: {
    async list() {
      // What was typed a moment ago is part of the history it is about to list.
      saveIfEdited();
      await saving;
      const target = historyTarget();
      if (!target) return 'Error: this document has not been saved yet, so it has no history.';
      const { entries, unreachable } = await loadHistory(target);
      const lines = entries.map((e) => `${e.source} version ${e.version}: saved ${new Date(e.version).toISOString()}, ${e.size} bytes${e.name !== null ? `, named "${e.name}"` : ''}`);
      const note = unreachable.length ? ` (The versions kept ${unreachable.map((s) => (s === 'account' ? 'in the account' : 'on this device')).join(' and ')} could not be loaded.)` : '';
      return lines.length ? `${lines.join('\n')}${note}` : `There are no earlier versions yet; they are kept as the document is edited.${note}`;
    },
    async save(name) {
      saveIfEdited();
      await saving;
      const target = historyTarget();
      if (!target) return 'Error: this document has not been saved yet, so it has no history.';
      if (current.shared?.role === 'viewer') return 'Error: the person can only view this document, not keep versions of it.';
      await saveNamedVersion(target, name);
      return `Kept the document as it is now as the version "${name}".`;
    },
    async restore(source, version) {
      const target = historyTarget();
      if (!target) return 'Error: this document has not been saved yet, so it has no history.';
      if (current.shared?.role === 'viewer') return 'Error: the person can only view this document, not open its versions.';
      const entry = (await loadHistory(target)).entries.find((e) => e.source === source && e.version === version);
      if (!entry) return `Error: there is no ${source} version ${version}; use list.`;
      const ready = nextDocumentReady();
      const name = await openVersion(entry);
      await ready;
      return `Opened the version as a new document named "${name}". It is the open document now; the one it came from is unchanged.`;
    },
  },
  otherDocuments,
  renamable,
  renameDocument,
  convertTo,
  inRoom: () => sharedLive(),
  openEntry: async (entry) => {
    const ready = nextDocumentReady();
    newDocumentFolder = null;
    showLoading(entry.name);
    openSource(sourceOf(entry));
    await ready;
  },
  newDocument: async (folderId, docKind) => {
    const ready = nextDocumentReady();
    await chromeHost.perform({ kind: 'new', folderId, docKind });
    await ready;
  },
  perform: (action) => chromeHost.perform(action),
  view: () => ({ toolbars: toolbarsOn, statusBar: footerOn, ruler: rulerOn, formattingMarks }),
  isPicture,
  pictureBytes,
  changePicture,
  textDrawings: () => textDrawingRefs().map((d) => ({ page: d.number, width: d.width, height: d.height, ...(d.embed !== undefined && { embed: d.embed }) })),
  openTextDrawing,
  closeTextDrawing,
  insertTextDrawing,
  editTextPicture,
  finishTextPicture,
  collaboration,
  pictureShapes: () => drawLayer.shapes,
  setPictureShapes: (shapes) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      shapesEcho = () => {
        clearTimeout(timer);
        resolve();
      };
      changeShapes(shapes);
    }),
  watching: () => (current.room?.watching ? whyWatching() : null),
  takeOver: takeOverEditing,
  drawing: async () => {
    if (!isDrawing() && !embeddedDrawing) return null;
    const session = await loadVector();
    return session.editor;
  },
});

// Clip, the assistant: a paperclip in the bottom right that reads and edits the open document for subscribers (see assistant/).
const assistant = new Assistant(document.body, { tool: assistantTools.run, begin: assistantTools.begin, signIn: () => void signIn(), subscribe: () => void subscribe() });
assistant.onVisibility = (clip) => chrome.update({ clip });
chrome.update({ clip: assistant.visible });

// Other people's mouse pointers (see ui/pointerLayer.ts).
const pointerLayer = new PointerLayer(document.getElementById('viewport')!, { camera, page: (index) => pages[index] });
// The frame around the picture selected in the text (see ui/pictureFrame.ts).
const pictureFrame = new PictureFrame(document.getElementById('viewport')!, {
  camera,
  page: (id) => pagesById.get(id),
  resized: (box, framed) => send({ kind: 'resizeDrawing', width: box.width, height: box.height, ...(framed.floating && { page: framed.page, x: box.x, y: box.y }) }),
});
const watchBanner = new WatchBanner(document.getElementById('viewport')!, () => void takeOverEditing());

/** Shows who holds the open document, if someone else does (see WatchBanner). */
function showWatch(): void {
  const room = current.room;
  watchBanner.update({ watching: room?.watching ?? false, holder: room?.holder ?? null, canTakeOver: room?.role !== 'viewer' && room?.mode !== 'offline' });
}
// Cropping a picture (see ui/cropLayer.ts).
const cropLayer = new CropLayer(document.getElementById('viewport')!, { camera, page: () => pages[0] });
// Text files too big to be documents (see textEditor/view.ts).
const textView: TextEditor = new TextEditor(document.getElementById('viewport')!, {
  camera,
  gl,
  atlases,
  fontBase: FONT_BASE,
  locale: getLocale,
  render: () => requestRender(),
  viewKey: (e) => viewKey(e),
  spell: {
    enabled: (name) => (isProseName(name) ? spellDialog.liveChecks : null),
    check: (texts, sample, what, at) => worker.spellText(texts, sample, what, at),
    redraw: () => requestRender(),
  },
});
/** The text editor as the chrome sees it (see documentEngine.ts). */
const textEngine: DocumentEngine = {
  get canUndo() {
    return textView.canUndo;
  },
  get canRedo() {
    return textView.canRedo;
  },
  get hasSelection() {
    return textView.hasSelection;
  },
  snapshot: () => textView.snapshot(),
  bounds: () => textView.bounds(),
  undo: () => textView.undo(),
  redo: () => textView.redo(),
  selectAll: () => textView.selectAll(),
  insert: (text) => textView.editor?.insert(text),
  copy: async () => {
    const text = await textView.copy();
    if (text !== null) setStatus(t('textEditor.copied', { count: text.split('\n').length.toLocaleString() }));
  },
  cut: () => textView.cut().catch((e) => reportError((e as Error).message)),
  paste: () => textView.paste().catch((e) => reportError((e as Error).message)),
  find: (tab) => (tab === 'goTo' ? textView.goTo() : textView.find(tab === 'replace')),
  focus: () => textView.focus(),
};
textView.onEdit = () => {
  textRoomHandle?.refresh();
  documentEdited();
  requestRender();
};
textView.onSave = () => saveKey();
// What the large-text editor shows, as text, for the end-to-end tests (it is drawn by the GPU, so the page has no text to read).
Object.assign(window, {
  textEditor: {
    state: () => textView.debugState(),
    text: () => new TextDecoder().decode(textView.editor?.flatten() ?? new Uint8Array(0)),
    pointOf: (line: number, col: number) => textView.pointOf({ line, col }),
    numberPoint: (line: number) => textView.numberPoint(line),
  },
});
textView.onState = () => requestRender();
// The vector editor (see ui/vectorSession.ts): a chunk of its own, fetched when the first drawing is opened.
let vector: VectorSession | null = null;
let vectorLoading: Promise<VectorSession> | null = null;

async function loadVector(): Promise<VectorSession> {
  vectorLoading ??= import('./ui/vectorSession.ts').then(({ createVectorSession }) => {
    vector = createVectorSession({
      camera,
      canvas,
      viewport: document.getElementById('viewport')!,
      workspace: document.getElementById('workspace')!,
      page: () => (embeddedDrawing ? embeddedRect() : pages[0]),
      changed: () => requestRender(),
      // The editor changed the drawing: its file is opened in place of the open one (the same saved document, the same name), then saved soon.
      // A drawing edited together sends each change to the room as changes to its nodes, and undoes through the room.
      sceneCommitted: (scene, base) => {
        pagesPanel.refresh(); // the thumbnail shows the drawing as it is now (see thumbnailPixels), whichever way it is saved
        if (!isDrawing() || !isVectorFormat(current.kind as Format) || !sharedLive()) return false;
        ensureUids(scene);
        worker.setVectorScene(scene, base);
        documentEdited();
        return true;
      },
      step: (direction) => {
        if (!isDrawing() || !isVectorFormat(current.kind as Format) || !sharedLive()) return false;
        worker.stepVector(direction);
        return true;
      },
      reopen(bytes) {
        const doc = current;
        open({ kind: 'svg', name: doc.name, bytes: bytes.slice().buffer }, { grid, localId: doc.localId ?? undefined, pictureEdit: true });
        documentEdited();
      },
      notice: (message) => setStatus(message),
      focusEditor: focusInput,
      toggleLayers,
    });
    return vector;
  });
  return vectorLoading;
}

/**
 * A vector drawing inside the document, being edited in place: the drawing is lit and everything
 * else dimmed, and the whole vector toolbar is there. Edits are kept in `latest`; leaving puts the
 * result in the document as one change (one undo).
 */
let embeddedDrawing: { svg: string; page: number; latest: string | null; width: number; embed?: string } | null = null;

/** Where the embedded drawing is, in points of the view. */
function embeddedRect(): { x: number; y: number; width: number; height: number } | undefined {
  const e = embeddedDrawing;
  if (!e) return undefined;
  let page = pagesById.get(e.page);
  let image = page?.images.find((i) => i.svg === e.svg);
  if (!image) {
    // The pages were laid out again: it is on another one.
    page = pages.find((p) => p.images.some((i) => i.svg === e.svg));
    image = page?.images.find((i) => i.svg === e.svg);
    if (page) e.page = page.id;
  }
  return page && image ? { x: page.x + image.x, y: page.y + image.y, width: image.width, height: image.height } : undefined;
}

async function editEmbeddedDrawing(pageId: number, svg: string, embed?: string): Promise<void> {
  const doc = current;
  try {
    const session = await loadVector();
    const bytes = await worker.media(svg);
    if (doc !== current || embeddedDrawing) return;
    const width = pagesById.get(pageId)?.images.find((i) => i.svg === svg)?.width ?? 0;
    embeddedDrawing = { svg, page: pageId, latest: null, width, ...(embed !== undefined && { embed }) };
    await session.openEmbedded(bytes, {
      changed: (text) => {
        if (embeddedDrawing) embeddedDrawing.latest = text;
        requestRender();
      },
      leave: () => void leaveEmbeddedDrawing(),
    });
    focusInput();
  } catch {
    embeddedDrawing = null;
    vector?.closeEmbedded();
  }
  requestRender();
}

/** Puts a new version of the stored drawing an embed (`![[body]]`) names in its document, in the library. Whether it did. */
async function saveEmbeddedDrawing(body: string, svg: string): Promise<boolean> {
  const entry = findByTitle(embedTitle(body), library.entries.filter((e) => e.key !== current.localId && !(current.shared && e.cloud?.id === current.shared.id)), linkPlaces());
  if (!entry || entry.state === 'conflict') return false;
  try {
    const found = entry.cloud && opensFromCloud(entry) ? await openFromCloud(entry.cloud, account?.id) : entry.local ? await getSaved(entry.local.id) : null;
    if (!found) return false;
    const bytes = await (await import('./formats/vectorDoc.ts')).rewriteStoredDrawing(new Uint8Array(found.bytes), svg);
    if (!bytes) return false;
    const info = await saveSaved({ id: found.info.id, name: found.info.name, bytes, owner: account?.id });
    library.putLocal(info);
    if (account) scheduleUpload(info.id);
    return true;
  } catch (e) {
    reportError((e as Error).message);
    return false;
  }
}

let leavingDrawing: Promise<void> | null = null;

/** Done with the embedded drawing: if it changed, the document gets the new version (and is opened again to show it, unless `reopen` is false: another document is opening). */
function leaveEmbeddedDrawing(reopen = true): Promise<void> {
  leavingDrawing ??= putBackDrawing(reopen).finally(() => (leavingDrawing = null));
  return leavingDrawing;
}

async function putBackDrawing(reopen: boolean): Promise<void> {
  const e = embeddedDrawing;
  const session = vector;
  if (!e || !session) return;
  try {
    if (e.latest !== null) {
      const picture = await session.picture(e.latest);
      // Sizes in EMUs: the drawing keeps its width in the text and its shape follows the drawing's.
      const width = Math.round((e.width || picture.width) * 12700);
      const height = Math.round((width * picture.height) / Math.max(picture.width, 1));
      // A drawing embedded from another document (`![[...]]`) is that document's: the change goes into it, and this one is opened again to show it.
      if (e.embed !== undefined && (await saveEmbeddedDrawing(e.embed, e.latest))) {
        if (!reopen) return;
        if (current.localId) {
          await saveNow();
          openSource(`local:${current.localId}`, 'replace');
          return;
        }
        worker.putDrawing({ svg: e.latest, png: picture.png, width, height }, e.svg);
        return;
      }
      worker.putDrawing({ svg: e.latest, png: picture.png, width, height }, e.svg);
      documentEdited();
    }
  } catch (error) {
    reportError((error as Error).message);
  } finally {
    embeddedDrawing = null;
    session.closeEmbedded();
    focusInput();
    requestRender();
  }
}

// --- A drawing edited together --------------------------------------------------------------------------------------------
// Everyone in a room edits a drawing at once: each change goes to the room as changes to its nodes (`sceneCommitted` in
// loadVector), and what others change comes back as the drawing as it now stands (`vectorScene`).

/** Starts editing the open drawing: reads its SVG from the document. A drawing that comes back after a change is the editor's already. */
async function showDrawing(): Promise<void> {
  const doc = current;
  try {
    const session = await loadVector();
    if (session.editor.active || doc !== current) return;
    await session.open(await worker.convert(doc.kind as Format));
    // A drawing edited together: the editor is given the drawing with the ids its nodes have in the room.
    if (latestVectorScene) session.syncScene(latestVectorScene);
  } catch {
    // The page's own picture of the drawing stays.
  }
  requestRender();
}

// The drawing's shapes as a list beside it (see ui/layersPanel.ts).
const LAYERS_KEY = 'word.layersPanel';
let layersWereShown = false;
let layersOpen = (() => {
  try {
    return localStorage.getItem(LAYERS_KEY) !== 'off';
  } catch {
    return true;
  }
})();
function toggleLayers(): void {
  layersOpen = !layersOpen;
  try {
    localStorage.setItem(LAYERS_KEY, layersOpen ? 'on' : 'off');
  } catch {
    // Not remembered.
  }
  requestRender();
}

// Drawing on a picture (see ui/drawLayer.ts).
const drawLayer: DrawLayer = new DrawLayer(document.getElementById('viewport')!, {
  camera,
  canvas,
  page: () => pages[0],
  style: () => drawStyle,
  setStyle: (change) => setDrawStyle(change),
  sample: async (at): Promise<string | null> => samplePicture(await worker.pictureBase(), drawLayer.shapes, at),
  changed: () => requestRender(),
  shapesChanged: changeShapes,
  undo: () => stepShapes('undo'),
});

/** The shapes drawn over the picture changed (from `base`, when drawn here): the worker keeps them, and the picture is saved with them. */
function changeShapes(shapes: Shape[], base?: Shape[]): void {
  worker.setShapes(shapes, base);
  documentEdited();
}

/** Undo or redo of the person's own changes to the shapes; saved like any change. */
function stepShapes(direction: 'undo' | 'redo'): void {
  worker.stepShapes(direction);
  documentEdited();
}

// The picture's shapes as layers in a list beside it (see ui/pictureLayersPanel.ts); it shares the vector panel's open or closed setting.
const pictureLayers = new PictureLayersPanel(document.getElementById('workspace')!, drawLayer, {
  close: toggleLayers,
  focusEditor: focusInput,
  background: () => void pictureAction('background'),
  canvasSize: () => void pictureAction('canvasSize'),
});

// The thumbnails of the pages beside the document; for a PDF's pages, drag them into order or delete them (see ui/pagesPanel.ts).
const pagesPanel = new PagesPanel(document.getElementById('workspace')!, {
  go: goToPage,
  draw: (page, width, height) => thumbnailPixels(page as GpuPage, width, height),
  move: (index, to) => changePages(index, { op: 'move', to }),
  remove: (index) => changePages(index, { op: 'delete' }),
  close: togglePagesPanel,
  focusEditor: focusInput,
});
document.getElementById('workspace')!.prepend(pagesPanel.el);
onThemeChange(() => pagesPanel.recolor()); // the thumbnails turn dark or light with Dark Pages
drawLayer.onUpdate(() => pagesPanel.refresh()); // a picture's shapes are in its thumbnail

/**
 * A page's thumbnail: the page as laid out, with what is painted over it while it is edited (a picture's shapes, the drawing being
 * edited, which the laid-out page only catches up with when the drawing is opened again).
 */
function thumbnailPixels(page: GpuPage, width: number, height: number): Uint8ClampedArray<ArrayBuffer> | null {
  const pixels = gl ? readPage(gl, renderer, page, width, height, pagesDark()) : null;
  if (page !== pages[0] || (!isPicture() && !isDrawing())) return pixels;
  const thumb = document.createElement('canvas');
  thumb.width = width;
  thumb.height = height;
  const ctx = thumb.getContext('2d');
  if (!ctx) return pixels;
  if (pixels) ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
  return paintEdits(ctx, width, height) ? ctx.getImageData(0, 0, width, height).data : pixels;
}

/** Paints what is drawn over the first page while it is edited (a picture's shapes, the drawing being edited) into a picture of that page; false when nothing is. */
function paintEdits(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  if (isDrawing()) return !!vector?.paintThumbnail(ctx, width, height);
  return isPicture() && drawLayer.paintOver(ctx, width, height);
}

// The account's folders and documents as a tree, left of everything else (see ui/filesPanel.ts).
const filesPanel = new FilesPanel(document.getElementById('workspace')!, {
  ...libraryHost,
  current: openDocumentIds,
  close: toggleFilesPanel,
  focusEditor: focusInput,
}, library);
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
  if (!page || !annotating) return;
  send({ kind: 'pdfPutDown' });
  send({ kind: 'pdfPageOp', page: page.id, ...op });
}

let panelCamera = '';

// --- Status bar ------------------------------------------------------------------------

const footer = new Footer(document.getElementById('footer')!, {
  view: setViewMode,
  goTo: () => chrome.registry.execute('edit.goTo'),
  wordCount: () => chrome.registry.execute('tools.wordCount'),
  zoom: (anchor) => chrome.showZoomList(anchor),
  canvasSize: () => chrome.registry.execute('vector.canvasSize'),
  wrap: () => textView.toggleWrap(),
  label: (action) => (action === 'zoom' ? t('chrome.control.zoom') : action === 'canvasSize' ? chrome.registry.get('vector.canvasSize').plainLabel : chrome.registry.get(action === 'goTo' ? 'edit.goTo' : 'tools.wordCount').plainLabel),
});

/** Asks the worker for the counts, once the document has been still for a moment. */
function refreshFooterSoon(): void {
  window.clearTimeout(footerTimer);
  footerTimer = window.setTimeout(refreshFooter, 300);
}

function refreshFooter(): void {
  if (!footerOn || !loaded || isPicture() || isDrawing() || textView.active) return;
  send({ kind: 'countWords', whole: true, footer: true });
  if (selection.text.length > 0) send({ kind: 'countWords', footer: true });
  else footerSelection = null;
}

/** Dragging a margin on a ruler: the selection's section gets the new margins (points in, twips out). */
function setMargins(margins: Partial<Record<'left' | 'right' | 'top' | 'bottom', number>>): void {
  if (!sectionPage) return;
  const twips = Object.fromEntries(Object.entries(margins).map(([side, points]) => [side, Math.round(points * 20)]));
  send({ kind: 'setPage', ...sectionPage, ...twips, scope: 'section' });
  focusInput();
}

const ruler = new Ruler(document.getElementById('ruler')!, false, {
  margins: (near, far) => setMargins({ left: near, right: far }),
  indents: ({ left, right, firstLine }) => {
    const by = Math.round(Math.abs(firstLine - left) * 20);
    const special = by === 0 ? 'none' : firstLine > left ? 'firstLine' : 'hanging';
    send({ kind: 'format', action: { kind: 'setParagraph', left: Math.round(left * 20), right: Math.round(right * 20), special, by } });
    focusInput();
  },
});
const verticalRuler = new Ruler(document.getElementById('vruler')!, true, {
  margins: (near, far) => setMargins({ top: near, bottom: far }),
});

/** The indents of the selected paragraphs, in points (what the ruler's markers show). */
function rulerIndents(): { left: number; right: number; firstLine: number } {
  const { left = 0, right = 0, special, by = 0 } = selectionFormat.paragraph ?? {};
  const first = special === 'firstLine' ? by : special === 'hanging' ? -by : 0;
  return { left: left / 20, right: right / 20, firstLine: (left + first) / 20 };
}

/** The rulers measure the page in view, so they are shown for pages that print: not in Flow, the page grid, a PDF or a picture. */
function updateRuler(): void {
  const center = camera.toDocument(canvas.clientWidth / 2, canvas.clientHeight / 2);
  const page = rulerOn && !textView.active && !reflowing() && !grid && !annotating && !isPicture() ? nearestPage(pages, center.x, center.y) : null;
  ruler.setVisible(page !== null);
  verticalRuler.setVisible(page !== null);
  if (!page) return;
  // The margins are the selection's section's: they apply to the page in view when it has the same size.
  const setup = sectionPage;
  const same = setup && [setup.width, setup.height].some((twips) => Math.abs(twips / 20 - page.width) < 1);
  const pxPerPoint = camera.zoom * CSS_PX_PER_POINT;
  const box = canvas.getBoundingClientRect();
  ruler.draw(
    {
      length: canvas.clientWidth,
      pxPerPoint,
      start: camera.x,
      page: { start: page.x, length: page.width },
      margins: same ? { near: setup.left / 20, far: setup.right / 20 } : null,
      indents: rulerIndents(),
    },
    box.left,
  );
  verticalRuler.draw(
    {
      length: canvas.clientHeight,
      pxPerPoint,
      start: camera.y,
      page: { start: page.y, length: page.height },
      margins: same ? { near: setup.top / 20, far: setup.bottom / 20 } : null,
    },
    0,
  );
}

/** Shows or hides the bar and says what it says, for the kind of document open. */
function updateFooter(): void {
  const visible = footerOn;
  footer.setVisible(visible);
  if (!visible) return;
  if (textView.active) {
    footer.update({ kind: current.kind, page: null, zoom: camera.zoom, words: null, selection: null, picture: null, view: 'print', canFlow: false, text: textView.footerInfo() });
    return;
  }
  let picture = null;
  if (isDrawing() && pages[0]) {
    // The page is the drawing's size at 96 dpi.
    picture = { width: Math.round((pages[0].width * 96) / 72), height: Math.round((pages[0].height * 96) / 72) };
  } else if (isPicture()) {
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
    kind: current.kind,
    page: here ? { current: pages.indexOf(here) + 1, count: pages.length } : null,
    zoom: camera.zoom,
    words: footerWords,
    selection: selection.text.length > 0 ? footerSelection : null,
    picture,
    view: grid ? 'grid' : reflowing() ? 'flow' : 'print',
    canFlow: !annotating && !isPicture() && !isDrawing(),
    text: null,
  });
}

/** Keeps the pages panel in step with the document: shown or not, editable or not, and marking the page in view. */
function syncPagesPanel(): void {
  // While a document opens it has no pages yet: a panel already showing stays, empty, rather than closing and opening again.
  const shown = pagesOpen() && !textView.active && !reflowing() && (pages.length > 0 || (loadingScreen.visible && !pagesPanel.el.hidden));
  pagesPanel.setVisible(shown);
  if (!shown) return;
  pagesPanel.setEditable(annotating);
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

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  // A document from the Files panel is dropped as a link, where the document can hold one.
  if (e.dataTransfer && isDocumentDrag(e.dataTransfer)) e.dataTransfer.dropEffect = canLinkDropAt(e.clientX, e.clientY) || canPictureDropAt(e.clientX, e.clientY) ? 'link' : 'none';
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (isDocumentDrag(e.dataTransfer)) {
    const key = droppedDocumentKey(e.dataTransfer);
    if (key) void dropLibraryDocument(key, e.clientX, e.clientY);
    return;
  }
  const drop = takeDropped(e.dataTransfer);
  if (drop) void dropped(drop, e.clientX, e.clientY);
});

// Debug/automation hooks.
Object.assign(window, { camera, requestRender, render, openSource, send, pageAt, assistantTools });
Object.defineProperties(window, {
  pages: { get: () => pages },
  loaded: { get: () => loaded },
  status: { get: () => status },
  room: { get: () => current.room },
  pictureShapes: { get: () => drawLayer.shapes },
  selectionState: { get: () => ({ caret: selection.caret, text: selection.text, others: selection.others, squiggles: selection.squiggleCount }) },
});

// Back and Forward: the document and the Documents screen the address names.
window.addEventListener('popstate', () => {
  const params = new URLSearchParams(location.search);
  const doc = wantedDoc(params);
  if (doc && doc !== addressDoc()) {
    const name = library.local.find((d) => `local:${d.id}` === doc)?.name;
    if (name) showLoading(name);
    openSource(doc, 'none');
  }
  if (history.state?.dashboard) void dashboard.show(false);
  else if (dashboard.visible) dashboard.dismiss(false);
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
  // Who is signed in shows at once; whether they have sync (and so the account's documents and
  // rooms) waits for their plan, in connect().
  void accountLookup.then((user) => {
    signedIn = user;
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
  if (doc) openSource(doc, 'replace');
  // Nothing asked for: carry on with the document last open here (else the newest saved one);
  // someone with no documents yet is welcomed with what Golem Docs is.
  else {
    const early = earlySaved;
    void (async () => {
      if (early && (await early.saved)) return openSource(`local:${early.id}`, 'replace');
      try {
        const saved = await listSaved();
        const last = lastDoc();
        const id = saved.some((d) => `local:${d.id}` === last) ? last : [...saved].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id;
        openSource(id ? (id.startsWith('local:') ? id : `local:${id}`) : 'welcome', 'replace');
      } catch {
        openSource('welcome', 'replace');
      }
    })();
  }
}
