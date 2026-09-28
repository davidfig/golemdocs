import './style.css';
import warAndPeaceUrl from '../../scripts/war-and-peace.txt?url';
import type { MoveTarget } from '@word/editor';
import { arrangePages, columnsToFill, type Bounds } from './document/arrange.ts';
import { LayoutClient } from './layout/layoutClient.ts';
import { FONT_BASE, type DocumentSource, type LayoutUpdate, type SelectionUpdate, type WireCommand } from './layout/protocol.ts';
import { ImageRenderer } from './shapes/imageRenderer.ts';
import { AtlasLibrary } from './text/gpuFace.ts';
import { Camera, CSS_PX_PER_POINT } from './view/camera.ts';
import { GpuPage } from './view/gpuPage.ts';
import { PageRenderer } from './view/pageRenderer.ts';
import { SelectionLayer } from './view/selectionLayer.ts';

const PAGE_GAP = 18;
const CARET_BLINK_MS = 530;
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const input = document.getElementById('input') as HTMLTextAreaElement;
const statsEl = document.getElementById('stats') as HTMLDivElement;
const corpusSelect = document.getElementById('corpus') as HTMLSelectElement;
const fileInput = document.getElementById('file') as HTMLInputElement;
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
corpusSelect.hidden = true;
if (import.meta.env.DEV) {
  void fetch(CORPUS_URL)
    .then((r) => (r.ok ? (r.json() as Promise<string[]>) : []))
    .then((names) => {
      for (const name of names) corpusSelect.append(new Option(name, name));
      corpusSelect.hidden = names.length === 0;
      const doc = new URLSearchParams(location.search).get('doc');
      if (doc?.startsWith('corpus:')) corpusSelect.value = doc.slice(7);
    })
    .catch(() => {});
}

// --- Current document ------------------------------------------------------------------

/** Pages in display order, and every page the worker has sent that's still alive. */
let pages: GpuPage[] = [];
const pagesById = new Map<number, GpuPage>();
let bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
let grid = false;
let documentName = '';
let status = '';
/** Latest edit round trip (command sent to its selection update), ms. */
let editLatency = '';
/** Layout finished for the current document. */
let loaded = false;
/** The camera has been placed for the current document. */
let cameraPlaced = false;
/** The user has scrolled or zoomed since opening (streaming then stops moving the camera). */
let userMoved = false;

function setStatus(text: string): void {
  status = text;
  requestRender();
}

function open(source: DocumentSource, options: { grid?: boolean } = {}): void {
  const start = performance.now();
  let name = 'name' in source ? source.name : 'Fonts';
  let firstPage = 0;
  for (const page of pagesById.values()) page.dispose(gl!);
  pagesById.clear();
  pages = [];
  selection.clear();
  renderer.images?.clear();
  renderer.images = new ImageRenderer(gl!, { bytes: (part) => worker.media(part) }, requestRender);
  grid = options.grid ?? false;
  loaded = false;
  cameraPlaced = false;
  userMoved = false;
  editLatency = '';
  documentName = name;
  setStatus(`Loading ${name}…`);

  worker.open(source, {
    opened(docName) {
      name = documentName = docName;
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
    },
    selection(update) {
      applySelection(update);
    },
    error(message) {
      loaded = true;
      setStatus(`${name}: ${message}`);
    },
  });
  focusInput();
}

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
  corpusSelect.value = '';
  for (const link of document.querySelectorAll<HTMLAnchorElement>('#docs a')) link.classList.remove('active');
  history.replaceState(null, '', location.pathname);
  void file.arrayBuffer().then((bytes) => open({ kind: 'docx', name: file.name, bytes }));
}

function openSource(source: string): void {
  const params = new URLSearchParams(location.search);
  params.set('doc', source);
  history.replaceState(null, '', `?${params}`);
  for (const link of document.querySelectorAll<HTMLAnchorElement>('#docs a')) {
    link.classList.toggle('active', link.dataset.doc === source);
  }
  corpusSelect.value = source.startsWith('corpus:') ? source.slice(7) : '';
  if (source === 'war-and-peace') {
    open({ kind: 'text-url', name: 'War and Peace', url: warAndPeaceUrl }, { grid: true });
  } else if (source.startsWith('corpus:')) {
    const name = source.slice(7);
    open({ kind: 'docx-url', name, url: CORPUS_URL + encodeURIComponent(name) });
  } else {
    open({ kind: 'fonts' });
  }
}

async function save(): Promise<void> {
  try {
    const bytes = await worker.save();
    const name = documentName.replace(/\.(docx|docm|dotx|txt)$/i, '') + '.docx';
    const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: name });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    setStatus(`Save failed: ${(e as Error).message}`);
  }
}

// --- Selection and caret ---------------------------------------------------------------

let caretOn = true;
let blinkTimer = 0;
/** When the last edit command was sent, for the latency readout. */
let editSent = 0;

function applySelection(update: SelectionUpdate): void {
  selection.update(update);
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

function send(command: WireCommand): void {
  if (command.kind !== 'move' && command.kind !== 'pointer' && command.kind !== 'selectAll') editSent = performance.now();
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
  const stats = renderer.render(camera, pages, selection, caretVisible);
  const frameMs = performance.now() - start;
  statsEl.textContent =
    `${status}${editLatency ? ` · ${editLatency}` : ''}\n${stats.visiblePages}/${stats.pages.toLocaleString()} pages visible · ` +
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
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? canvas.clientHeight : 1;
    userMoved = true;
    if (e.ctrlKey || e.metaKey) camera.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * unit * 0.01));
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
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') return [{ kind: 'selectAll' }];
  return null;
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
    grid = !grid;
    cameraPlaced = false;
    userMoved = false;
    arrange();
    return true;
  } else return false;
  userMoved = true;
  requestRender();
  return true;
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
  if (e.isComposing) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    void save();
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

for (const link of document.querySelectorAll<HTMLAnchorElement>('#docs a')) {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    openSource(link.dataset.doc!);
  });
}
corpusSelect.addEventListener('change', () => {
  if (corpusSelect.value) openSource(`corpus:${corpusSelect.value}`);
});
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) openFile(file);
  fileInput.value = '';
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
  editLatency: { get: () => editLatency },
  selectionState: { get: () => ({ caret: selection.caret, text: selection.text }) },
});

openSource(new URLSearchParams(location.search).get('doc') ?? 'fonts');
