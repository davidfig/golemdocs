// The embeddable viewer: one document, shown read-only with the editor's own renderer, for another app to show a file in (a mail
// client's attachments). It scrolls, zooms, moves between pages, finds text, and selects and copies, and does nothing else: no
// storage, rooms, spelling, autocorrect, library, sync or menus. It fetches nothing but its own code and the fonts under `fontBase`,
// and a link that is clicked is handed to the host (`onLink`) rather than followed. See docs/architecture/viewer.md.
//
// `mount` styles the document it is in (the color scheme is on the root element), so it is meant to own that document: the viewer
// page (viewer.html, ./main.ts) or a frame of its own.

import '../ui/ui.css';
import './viewer.css';
import { arrangePages, nearestPage, type Bounds } from '../document/arrange.ts';
import { sourceFromFile } from '../formats/source.ts';
import { loadLocale, t } from '../i18n/index.ts';
import { LayoutClient, type DocumentListener } from '../layout/layoutClient.ts';
import type { LayoutUpdate, SelectionUpdate } from '../layout/protocol.ts';
import { CLOSE_ICON, h, iconButton } from '../ui/dom.ts';
import { Camera, CSS_PX_PER_POINT } from '../view/camera.ts';
import { GpuPage } from '../webgl/gpuPage.ts';
import { PageRenderer } from '../webgl/pageRenderer.ts';
import { SelectionLayer } from '../webgl/selectionLayer.ts';
import { ImageRenderer } from '../webgl/shapes/imageRenderer.ts';
import { AtlasLibrary } from '../webgl/text/gpuFace.ts';
import layoutWorkerUrl from '../layout/layoutWorkerEntry.ts?worker&url';
import { canScrollSideways, FIT_MARGIN, fitWidthZoom, hostKey, SIDE_PADDING, SIDE_PADDING_X, linkForHost, MAX_ZOOM, MIN_ZOOM, pageIndexAt, parsePageNumber, stepZoom, viewerKey, type HostKey } from './protocol.ts';

export interface ViewerOptions {
  /** The file's bytes (they are handed to the layout worker: an ArrayBuffer passed here is transferred, and so emptied). */
  bytes: ArrayBuffer | Uint8Array;
  /** The file's name: its extension says what it is. */
  name: string;
  /** Where the fonts are: the folder holding `manifest.json`, absolute or relative to the page. */
  fontBase: string;
  /** Dark colors around the pages, and dark pages with light letters. */
  dark?: boolean;
  /** The language of the viewer's own words (a BCP 47 tag; default English). */
  locale?: string;
  /** Shown in the bar beside the page number (a shared document's name, say). */
  title?: string;
  /** Shows a Download button in the bar, which calls this (a public link's page saves the file). */
  onDownload?(): void;
  /** A link in the document was clicked (only web, mail, phone and FTP addresses are passed on). */
  onLink?(url: string): void;
  /** A key the viewer has no use for was pressed while it had the focus (see `viewerKey` in protocol.ts): the host's to act on. */
  onKey?(key: HostKey): void;
  /** The document is open and laid out. */
  onOpened?(info: { name: string; format: string; pages: number }): void;
  /** It can't be shown. */
  onError?(message: string): void;
}

export interface Viewer {
  /** Takes the viewer down: stops its worker, frees the GPU and removes what it added to `el`. */
  destroy(): void;
  /** Shows a newer version of the same file in place of the one shown, at the same place and zoom (`onOpened` is told again). */
  reload(bytes: ArrayBuffer | Uint8Array): void;
}

/** Points of grey between pages. */
const PAGE_GAP = 18;
/** A press that moves less than this (CSS px) before it is let go is a click: on a link, the link is handed out. */
const CLICK_SLOP = 4;
const MULTI_CLICK_MS = 500;
/** CSS px an arrow key scrolls. */
const ARROW_STEP = 40;
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

const ICON_UP = 'M3 7.5L6 4.5L9 7.5';
const ICON_DOWN = 'M3 4.5L6 7.5L9 4.5';
const ICON_MINUS = 'M3 6H9';
const ICON_PLUS = 'M3 6H9M6 3V9';
const ICON_DOWNLOAD = 'M6 1.5V7.5M3.5 5L6 7.5L8.5 5M2 10H10';
const ICON_FIND = 'M7.3 7.3L10.5 10.5M8.2 5A3.2 3.2 0 1 1 1.8 5A3.2 3.2 0 1 1 8.2 5';

const LIGHT_DESK: readonly [number, number, number] = [0xe5 / 255, 0xe5 / 255, 0xe5 / 255];

/** Shows a document read-only in `el` (which it fills). */
export function mount(el: HTMLElement, options: ViewerOptions): Viewer {
  const doc = el.ownerDocument;
  const win = doc.defaultView ?? window;
  const dark = options.dark ?? false;
  doc.documentElement.dataset.theme = dark ? 'dark' : 'golem';
  doc.documentElement.dataset.scheme = 'golem';
  const fontBase = new URL(options.fontBase, doc.baseURI).href;

  // --- DOM ----------------------------------------------------------------------------------------
  const root = h('div', { class: 'wm-viewer' });
  const view = h('div', { class: 'wm-viewer-view' });
  const canvas = h('canvas', { attrs: { role: 'document' } });
  // Holds the focus, for copy and the keys; nothing typed in it goes anywhere (`inputmode="none"`: no on-screen keyboard).
  const input = h('textarea', { class: 'wm-viewer-input', attrs: { inputmode: 'none', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', tabindex: '0' } });
  const status = h('div', { class: 'wm-viewer-status', attrs: { role: 'status' } });
  view.append(canvas, input, status);

  const tool = (path: string, label: string, run: () => void): HTMLButtonElement => {
    const button = iconButton('wm-tbutton', path, label);
    button.addEventListener('click', () => {
      run();
      focusView();
    });
    return button;
  };
  const pageField = h('input', { class: 'wm-input', attrs: { type: 'text', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false' } });
  const pageCount = h('span', { class: 'wm-viewer-count' });
  const zoomLabel = h('button', { class: 'wm-tbutton wm-viewer-zoom', attrs: { type: 'button' } });
  const query = h('input', { class: 'wm-input wm-viewer-query', attrs: { type: 'search', autocomplete: 'off', spellcheck: 'false' } });
  const findMessage = h('span', { class: 'wm-find-message', attrs: { role: 'status' } });
  const findBar = h('div', { class: 'wm-viewer-bar wm-viewer-find', attrs: { role: 'search' } });
  findBar.hidden = true;
  const bar = h('div', { class: 'wm-viewer-bar', attrs: { role: 'toolbar' } });

  // --- Rendering state -----------------------------------------------------------------------------
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: true });
  const camera = new Camera();
  camera.minZoom = MIN_ZOOM;
  camera.maxZoom = MAX_ZOOM;
  let desk = LIGHT_DESK;
  let pages: GpuPage[] = [];
  const pagesById = new Map<number, GpuPage>();
  let bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
  let cameraPlaced = false;
  let userMoved = false;
  /** Opened as a fixed picture (a picture or drawing): fitted whole rather than to its width. */
  let fitWhole = false;
  /** A PDF shown as its own pages: they can't be searched yet. */
  let fixedPages = false;
  /** What the document was read as (docx, md, pdf...). */
  let format = '';
  let selectedText = '';
  let selectionHtml: { text: string; html: string } | null = null;
  let frame = 0;
  let destroyed = false;

  const renderer = gl ? new PageRenderer(gl, () => desk) : null;
  const atlases = gl ? new AtlasLibrary(gl, fontBase, requestRender) : null;
  const selection = gl ? new SelectionLayer(gl) : null;
  const worker = gl ? new LayoutClient((faces) => faces.forEach((face) => atlases!.define(face)), { fontBase, startWorker: (name) => startLayoutWorker(win, name) }) : null;
  if (renderer && worker && gl) renderer.images = new ImageRenderer(gl, { bytes: (part) => worker.media(part) }, requestRender, requestRender);

  function requestRender(): void {
    if (!frame && !destroyed) frame = win.requestAnimationFrame(render);
  }

  function render(): void {
    frame = 0;
    if (!renderer || !selection) return;
    camera.clamp(bounds, canvas.clientWidth, canvas.clientHeight, SIDE_PADDING, SIDE_PADDING_X);
    renderer.render(camera, pages, selection, false, dark);
    updateBar();
  }

  function showStatus(text: string | null): void {
    status.hidden = text === null;
    status.textContent = text ?? '';
  }

  function fail(message: string): void {
    showStatus(message);
    options.onError?.(message);
  }

  function focusView(): void {
    input.focus({ preventScroll: true });
  }

  // --- Pages and the camera -----------------------------------------------------------------------

  function placeCamera(): void {
    cameraPlaced = true;
    if (fitWhole) return camera.fit(bounds, canvas.clientWidth, canvas.clientHeight, 24);
    // As the editor opens a document: the first page at 100%, or zoomed out until its width fits, a little grey above it.
    camera.zoom = fitWidthZoom(bounds.width, canvas.clientWidth, FIT_MARGIN, CSS_PX_PER_POINT);
    const pointsPerCss = 1 / (camera.zoom * CSS_PX_PER_POINT);
    camera.x = bounds.x + bounds.width / 2 - (canvas.clientWidth / 2) * pointsPerCss;
    camera.y = bounds.y - 24 * pointsPerCss;
  }

  /** A newer version is being opened (`reload`): the old pages stay until its first pages arrive, then go. */
  let replacing = false;

  function applyLayout(update: LayoutUpdate): void {
    if (!gl || !atlases) return;
    if (replacing && update.pages.length) {
      replacing = false;
      for (const page of pagesById.values()) page.dispose(gl);
      pagesById.clear();
    }
    for (const encoded of update.pages) {
      pagesById.get(encoded.id)?.dispose(gl);
      pagesById.set(encoded.id, new GpuPage(encoded, atlases));
    }
    for (const { page, content } of update.overlays) pagesById.get(page)?.setOverlay(gl, content);
    for (const id of update.drop) {
      pagesById.get(id)?.dispose(gl);
      pagesById.delete(id);
    }
    pages = [];
    for (const id of update.order) {
      const page = pagesById.get(id);
      if (page) pages.push(page);
    }
    bounds = arrangePages(pages, 1, PAGE_GAP);
    if (pages.length && (!cameraPlaced || (fitWhole && !userMoved))) placeCamera();
    if (pages.length) showStatus(null);
    requestRender();
  }

  function applySelection(update: SelectionUpdate): void {
    selection?.update(update);
    selectedText = update.text;
    if (update.search) findMessage.textContent = update.search.found ? '' : t('dialogs.find.noMatches');
    if (update.reveal && update.focus) reveal(update.focus);
    requestRender();
  }

  /** Scrolls so a point of a page (the found text) is in view, with a margin. */
  function reveal(focus: NonNullable<SelectionUpdate['focus']>): void {
    const page = pagesById.get(focus.page);
    if (!page) return;
    const pointsPerCss = 1 / (camera.zoom * CSS_PX_PER_POINT);
    const viewWidth = canvas.clientWidth * pointsPerCss;
    const viewHeight = canvas.clientHeight * pointsPerCss;
    const margin = 48 * pointsPerCss;
    const x = page.x + focus.x;
    const top = page.y + focus.y;
    const bottom = top + focus.height;
    if (top < camera.y + margin || bottom > camera.y + viewHeight - margin) camera.y = top - viewHeight / 3;
    if (x < camera.x + margin || x > camera.x + viewWidth - margin) camera.x = x - viewWidth / 2;
    userMoved = true;
  }

  /** The page under (or nearest to) a CSS point of the canvas, and the point in its coordinates. */
  function pageAt(cssX: number, cssY: number): { page: GpuPage; x: number; y: number } | null {
    const point = camera.toDocument(cssX, cssY);
    const page = nearestPage(pages, point.x, point.y);
    return page && { page, x: point.x - page.x, y: point.y - page.y };
  }

  /** The page at the middle of the view, from 0 (-1 with none). */
  function currentPage(): number {
    const pointsPerCss = 1 / (camera.zoom * CSS_PX_PER_POINT);
    return pageIndexAt(pages, camera.y + (canvas.clientHeight / 2) * pointsPerCss);
  }

  function goToPage(index: number): void {
    const page = pages[Math.max(0, Math.min(index, pages.length - 1))];
    if (!page) return;
    userMoved = true;
    camera.y = page.y - 12 / (camera.zoom * CSS_PX_PER_POINT);
    requestRender();
  }

  /** Zooms by steps or to a level, keeping the point at the middle of the view (or `at`, CSS px) where it is. */
  function zoomTo(zoom: number, at?: { x: number; y: number }): void {
    userMoved = true;
    camera.zoomAt(at?.x ?? canvas.clientWidth / 2, at?.y ?? canvas.clientHeight / 2, zoom / camera.zoom);
    requestRender();
  }

  let shownPage = '';
  let shownCount = '';
  let shownZoom = '';
  function updateBar(): void {
    const page = pages.length ? String(currentPage() + 1) : '';
    if (page !== shownPage && doc.activeElement !== pageField) pageField.value = shownPage = page;
    const count = pages.length ? t('viewer.pageCount', { count: pages.length.toLocaleString(options.locale) }) : '';
    if (count !== shownCount) pageCount.textContent = shownCount = count;
    const zoom = `${Math.round(camera.zoom * 100).toLocaleString(options.locale)}%`;
    if (zoom !== shownZoom) zoomLabel.textContent = shownZoom = zoom;
  }

  // --- The document ---------------------------------------------------------------------------------

  const listener: DocumentListener = {
    opened(_name, opened, annotating) {
      format = opened;
      fixedPages = annotating;
      fitWhole = format === 'png' || format === 'jpeg' || format === 'webp' || format === 'svg' || format === 'svgz';
    },
    layout(update) {
      applyLayout(update);
      if (update.selection) applySelection(update.selection);
    },
    done(count) {
      options.onOpened?.({ name: options.name, format, pages: count });
    },
    selection: applySelection,
    selectionHtml(text, html) {
      selectionHtml = { text, html };
    },
    error: fail,
    notice() {},
    // Never in a room, and nothing is edited: these never come.
    roomState() {},
    roomReplace() {},
    roomGone() {},
    roomSaved() {},
    roomRelease() {},
    roomFlush() {},
    remoteEdit() {},
    pointers() {},
    shapes() {},
    vectorScene() {},
  };

  // --- Input ------------------------------------------------------------------------------------------

  let press: { x: number; y: number; id: number; moved: boolean; extend: boolean } | null = null;
  let pan: { x: number; y: number } | null = null;
  let pendingDrag: { x: number; y: number } | null = null;
  let lastClick = { time: 0, x: 0, y: 0, count: 0 };
  const touches = new Map<number, { x: number; y: number }>();
  let pinch: { distance: number } | null = null;

  function clickCount(e: PointerEvent): number {
    const near = Math.abs(e.clientX - lastClick.x) <= CLICK_SLOP && Math.abs(e.clientY - lastClick.y) <= CLICK_SLOP;
    const count = near && e.timeStamp - lastClick.time < MULTI_CLICK_MS ? lastClick.count + 1 : 1;
    lastClick = { time: e.timeStamp, x: e.clientX, y: e.clientY, count };
    return count;
  }

  const send = (command: Parameters<LayoutClient['command']>[0]): void => worker?.command(command);

  function onPointerDown(e: PointerEvent): void {
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    focusView();
    if (e.pointerType === 'touch') {
      // One finger scrolls, two pinch.
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      pinch = touches.size === 2 ? { distance: touchDistance() } : null;
      return;
    }
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      pan = { x: e.clientX, y: e.clientY };
      return;
    }
    if (e.button !== 0) return;
    const hit = pageAt(e.offsetX, e.offsetY);
    if (!hit) return;
    const clicks = clickCount(e);
    const unit = clicks === 2 ? 'word' : clicks >= 3 ? 'paragraph' : 'character';
    press = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false, extend: e.shiftKey };
    send({ kind: 'pointer', page: hit.page.id, x: hit.x, y: hit.y, extend: e.shiftKey, unit });
  }

  function onPointerMove(e: PointerEvent): void {
    if (e.pointerType === 'touch') return touchMove(e);
    if (pan) {
      userMoved = true;
      camera.panBy(pan.x - e.clientX, pan.y - e.clientY);
      pan = { x: e.clientX, y: e.clientY };
      return requestRender();
    }
    if (!press) return hover(e);
    if (Math.abs(e.clientX - press.x) > CLICK_SLOP || Math.abs(e.clientY - press.y) > CLICK_SLOP) press.moved = true;
    if (!press.moved) return;
    // One drag position a frame.
    if (!pendingDrag) {
      win.requestAnimationFrame(() => {
        const drag = pendingDrag;
        pendingDrag = null;
        const hit = drag && press && pageAt(drag.x, drag.y);
        if (hit) send({ kind: 'pointer', page: hit.page.id, x: hit.x, y: hit.y, extend: true });
      });
    }
    pendingDrag = { x: e.offsetX, y: e.offsetY };
  }

  function onPointerUp(e: PointerEvent): void {
    if (e.pointerType === 'touch') return touchUp(e);
    pan = null;
    const was = press;
    press = null;
    // A click (not a drag, not extending a selection) on a link hands the link to the host.
    if (was && !was.moved && !was.extend && e.type === 'pointerup' && lastClick.count === 1 && worker) {
      const hit = pageAt(e.offsetX, e.offsetY);
      if (hit)
        void worker.linkAt(hit.page.id, hit.x, hit.y).then((found) => {
          const url = linkForHost(found.url);
          if (url && !destroyed) options.onLink?.(url);
        });
    }
  }

  // The pointer shows a hand over a link, asked of the worker at most once a frame.
  let hoverAt: { x: number; y: number } | null = null;
  function hover(e: PointerEvent): void {
    const pending = hoverAt;
    hoverAt = { x: e.offsetX, y: e.offsetY };
    if (pending || !worker) return;
    win.requestAnimationFrame(() => {
      const at = hoverAt;
      hoverAt = null;
      const hit = at && pageAt(at.x, at.y);
      if (!hit) return;
      void worker.linkAt(hit.page.id, hit.x, hit.y).then((found) => {
        canvas.style.cursor = linkForHost(found.url) ? 'pointer' : '';
      });
    });
  }

  function touchDistance(): number {
    const [a, b] = [...touches.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function touchMove(e: PointerEvent): void {
    const before = touches.get(e.pointerId);
    if (!before) return;
    userMoved = true;
    if (touches.size === 1) camera.panBy(before.x - e.clientX, before.y - e.clientY);
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2 && pinch) {
      const distance = touchDistance();
      const [a, b] = [...touches.values()];
      const rect = canvas.getBoundingClientRect();
      camera.zoomAt((a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top, distance / pinch.distance);
      pinch.distance = distance;
    }
    requestRender();
  }

  function touchUp(e: PointerEvent): void {
    touches.delete(e.pointerId);
    pinch = null;
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? canvas.clientHeight : 1;
    userMoved = true;
    // A trackpad pinch comes as Ctrl+wheel; Ctrl or ⌘ with a mouse wheel zooms too.
    if (e.ctrlKey || e.metaKey) camera.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * unit * 0.01));
    else camera.panBy(e.deltaX * unit, e.deltaY * unit);
    requestRender();
  }

  // Safari and WebKit views send a trackpad pinch as gesture events with a running scale.
  let gestureScale = 1;
  const onGestureStart = (e: Event): void => {
    e.preventDefault();
    gestureScale = (e as Event & { scale: number }).scale || 1;
  };
  const onGestureChange = (e: Event): void => {
    e.preventDefault();
    const g = e as Event & { scale: number; clientX: number; clientY: number };
    const rect = canvas.getBoundingClientRect();
    userMoved = true;
    camera.zoomAt(g.clientX - rect.left, g.clientY - rect.top, g.scale / gestureScale);
    gestureScale = g.scale;
    requestRender();
  };

  function openFind(): void {
    findBar.hidden = false;
    findMessage.textContent = fixedPages ? t('viewer.findUnavailable') : '';
    if (!query.value && selectedText && !selectedText.includes('\n')) query.value = selectedText;
    query.focus();
    query.select();
  }

  function closeFind(): void {
    findBar.hidden = true;
    focusView();
  }

  function findNext(backward: boolean): void {
    if (fixedPages) {
      findMessage.textContent = t('viewer.findUnavailable');
      return;
    }
    if (!query.value) return;
    send({ kind: 'find', text: query.value, backward });
  }

  /** Keys anywhere in the viewer: zoom, find, select all, moving through the document. */
  /**
   * Keys anywhere in the viewer: zoom, find, select all, moving through the document. What it does with a key is `viewerKey`'s
   * decision (protocol.ts); a key it has no use for goes to the host (`onKey`), so the page around it can act on Escape, a letter, ← →.
   */
  function onKeyDown(e: KeyboardEvent): void {
    const action = viewerKey(e, {
      mac: MAC,
      inField: e.target === query || e.target === pageField,
      onButton: e.target instanceof HTMLButtonElement,
      findOpen: !findBar.hidden,
      canScrollSideways: canScrollSideways(camera, bounds, canvas.clientWidth),
    });
    if (action === 'browser') return;
    if (action === 'host') return void options.onKey?.(hostKey(e));
    e.preventDefault();
    const scroll = (dx: number, dy: number): void => {
      userMoved = true;
      camera.panBy(dx, dy);
      requestRender();
    };
    const screen = canvas.clientHeight * 0.9;
    switch (action) {
      case 'zoomIn':
        return zoomTo(stepZoom(camera.zoom, 1));
      case 'zoomOut':
        return zoomTo(stepZoom(camera.zoom, -1));
      case 'zoomReset':
        return zoomTo(1);
      case 'find':
        return openFind();
      case 'closeFind':
        return closeFind();
      case 'selectAll':
        return send({ kind: 'selectAll' });
      case 'findNext':
        return findNext(false);
      case 'findPrevious':
        return findNext(true);
      case 'lineDown':
        return scroll(0, ARROW_STEP);
      case 'lineUp':
        return scroll(0, -ARROW_STEP);
      case 'lineLeft':
        return scroll(-ARROW_STEP, 0);
      case 'lineRight':
        return scroll(ARROW_STEP, 0);
      case 'pageDown':
        return scroll(0, screen);
      case 'pageUp':
        return scroll(0, -screen);
      case 'first':
        return goToPage(0);
      case 'last':
        return goToPage(pages.length - 1);
    }
  }

  /** Copy (and cut, which copies: nothing can be cut from a document only looked at) gives the selected text and its formatting. */
  function onCopy(e: ClipboardEvent): void {
    if (e.target === query || e.target === pageField || !selectedText) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', selectedText);
    if (selectionHtml && selectionHtml.text === selectedText) e.clipboardData?.setData('text/html', selectionHtml.html);
  }

  // Whatever is typed into the focus holder is thrown away.
  const onInput = (): void => {
    input.value = '';
  };

  const resize = new ResizeObserver(([entry]) => {
    const box = entry.devicePixelContentBoxSize?.[0];
    const cssWidth = entry.contentRect.width || 1;
    camera.width = box ? box.inlineSize : Math.round(cssWidth * (win.devicePixelRatio || 1));
    camera.height = box ? box.blockSize : Math.round(entry.contentRect.height * (win.devicePixelRatio || 1));
    camera.dpr = camera.width / cssWidth;
    canvas.width = camera.width;
    canvas.height = camera.height;
    if (pages.length && !userMoved) placeCamera();
    // Resizing clears the canvas: draw before this frame is shown.
    if (frame) win.cancelAnimationFrame(frame);
    frame = 0;
    render();
  });

  // --- Start ---------------------------------------------------------------------------------------

  el.append(root);
  root.append(bar, findBar, view);
  resize.observe(canvas);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('gesturestart', onGestureStart);
  canvas.addEventListener('gesturechange', onGestureChange);
  input.addEventListener('input', onInput);
  root.addEventListener('keydown', onKeyDown);
  doc.addEventListener('copy', onCopy);
  doc.addEventListener('cut', onCopy);
  // Keys pressed with nothing focused (the frame was just clicked into, say) reach the viewer too.
  const onDocumentKey = (e: KeyboardEvent): void => {
    if (e.target === doc.body || e.target === doc.documentElement) onKeyDown(e);
  };
  doc.addEventListener('keydown', onDocumentKey);

  void (async () => {
    // The viewer's words are in the language asked for (English while it loads); the worker's errors follow it.
    const locale = await loadLocale(options.locale ?? 'en').catch(() => 'en');
    if (destroyed) return;
    canvas.setAttribute('aria-label', t('viewer.document'));
    pageField.setAttribute('aria-label', t('viewer.pageNumber'));
    zoomLabel.title = t('viewer.actualSize');
    zoomLabel.addEventListener('click', () => {
      zoomTo(1);
      focusView();
    });
    query.setAttribute('aria-label', t('dialogs.find.findWhatLabel'));
    query.placeholder = t('viewer.find');
    bar.append(
      tool(ICON_UP, t('viewer.previousPage'), () => goToPage(currentPage() - 1)),
      tool(ICON_DOWN, t('viewer.nextPage'), () => goToPage(currentPage() + 1)),
      pageField,
      pageCount,
      ...(options.title ? [h('span', { class: 'wm-viewer-title', text: options.title, title: options.title })] : []),
      h('span', { class: 'wm-viewer-spacer' }),
      tool(ICON_MINUS, t('viewer.zoomOut'), () => zoomTo(stepZoom(camera.zoom, -1))),
      zoomLabel,
      tool(ICON_PLUS, t('viewer.zoomIn'), () => zoomTo(stepZoom(camera.zoom, 1))),
      tool(ICON_FIND, t('viewer.find'), openFind),
      ...(options.onDownload ? [tool(ICON_DOWNLOAD, t('viewer.download'), options.onDownload)] : []),
    );
    findBar.append(query, tool(ICON_UP, t('dialogs.find.findPrevious'), () => findNext(true)), tool(ICON_DOWN, t('dialogs.find.findNext'), () => findNext(false)), findMessage, h('span', { class: 'wm-viewer-spacer' }), tool(CLOSE_ICON, t('viewer.closeFind'), closeFind));
    // `tool` hands the focus back to the document; the find bar's own buttons keep it in the search field.
    for (const button of findBar.querySelectorAll('button')) button.addEventListener('click', () => button !== findBar.lastElementChild && query.focus());
    query.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        findNext(e.shiftKey);
      }
    });
    pageField.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const index = parsePageNumber(pageField.value, pages.length);
      if (index !== null) goToPage(index);
      shownPage = '';
      focusView();
    });
    pageField.addEventListener('blur', () => {
      shownPage = '';
      requestRender();
    });

    if (!gl || !worker || !renderer) return fail(t('app.webglUnsupported'));
    desk = readDesk(doc) ?? LIGHT_DESK;
    const source = sourceFromFile(options.name, bufferOf(options.bytes));
    if (!source) return fail(t('viewer.cannotOpen', { name: options.name }));
    showStatus(t('viewer.opening', { name: options.name }));
    worker.setLocale(locale);
    // The default font nearly every document uses: its atlases are fetched now, not after the first layout.
    atlases!.warm(['calibri/regular.webp', 'calibri/bold.webp']);
    worker.openReadOnly(source, listener);
    focusView();
  })();

  return {
    reload(bytes) {
      const source = sourceFromFile(options.name, bufferOf(bytes));
      if (destroyed || !worker || !source) return;
      replacing = true;
      worker.openReadOnly(source, listener);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (frame) win.cancelAnimationFrame(frame);
      resize.disconnect();
      doc.removeEventListener('copy', onCopy);
      doc.removeEventListener('cut', onCopy);
      doc.removeEventListener('keydown', onDocumentKey);
      worker?.terminate();
      if (gl) {
        for (const page of pagesById.values()) page.dispose(gl);
        renderer?.images?.clear();
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
      pagesById.clear();
      pages = [];
      root.remove();
    },
  };
}

/**
 * Starts the layout worker. In a sandboxed frame (no `allow-same-origin`) the page's origin is opaque, and no worker can be started
 * from a URL there: Chromium refuses ("cannot be accessed from origin 'null'"), WebKit fails quietly. A module worker whose script is a
 * `data:` URL that imports the real worker by its address (a CORS request) starts in both. (A `blob:` one works in WebKit, not in
 * Chromium.) Such a worker has an opaque origin too, and the frame's Content-Security-Policy.
 */
export function startLayoutWorker(win: Window, name: string): Worker {
  const url = new URL(layoutWorkerUrl, win.location.href).href;
  // `origin`, not `location.origin`: the location is still the page's address, but the page's origin is "null".
  if (win.origin !== 'null') return new Worker(url, { type: 'module', name });
  return new Worker(`data:text/javascript,${encodeURIComponent(`import ${JSON.stringify(url)};`)}`, { type: 'module', name });
}

/** The bytes as an ArrayBuffer of their own (one passed as such is used as it is, and transferred to the worker). */
function bufferOf(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  return bytes instanceof ArrayBuffer ? bytes : bytes.slice().buffer;
}

/** The color behind the pages: the scheme's --wm-desk, 0-1 per channel. */
function readDesk(doc: Document): readonly [number, number, number] | null {
  const hex = getComputedStyle(doc.documentElement).getPropertyValue('--wm-desk').trim();
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
