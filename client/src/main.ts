import './style.css';
import warAndPeaceUrl from '../../scripts/war-and-peace.txt?url';
import { buildFontDemo } from './demo.ts';
import { arrangePages, columnsToFill, type Bounds } from './document/arrange.ts';
import { LETTER, type Page } from './document/page.ts';
import { layoutPlainText } from './document/plainTextLayout.ts';
import { FontLibrary } from './text/fontLibrary.ts';
import { Camera, CSS_PX_PER_POINT } from './view/camera.ts';
import { PageRenderer } from './view/pageRenderer.ts';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const statsEl = document.getElementById('stats') as HTMLDivElement;
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: true });
if (!gl) throw new Error('WebGL2 not supported');

const params = new URLSearchParams(location.search);
const docName = params.get('doc') ?? 'fonts';
for (const link of document.querySelectorAll<HTMLAnchorElement>('#docs a')) {
  if (new URL(link.href).searchParams.get('doc') === docName) link.classList.add('active');
}

const camera = new Camera();
const renderer = new PageRenderer(gl);
const library = await FontLibrary.load(gl);

let layoutMs = 0;
async function loadDocument(): Promise<Page[]> {
  if (docName === 'war-and-peace') {
    const text = await (await fetch(warAndPeaceUrl)).text();
    const start = performance.now();
    const pages = await layoutPlainText(library, text);
    layoutMs = performance.now() - start;
    return pages;
  }
  const start = performance.now();
  const pages = await buildFontDemo(library, Math.max(1, Number(params.get('repeat') ?? 1)));
  layoutMs = performance.now() - start;
  return pages;
}
const pages = await loadDocument();

let frameQueued = false;

function requestRender(): void {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(render);
}

function render(): void {
  frameQueued = false;
  const start = performance.now();
  const stats = renderer.render(camera, pages);
  const frameMs = performance.now() - start;
  statsEl.textContent =
    `${stats.visiblePages}/${stats.pages.toLocaleString()} pages · ${stats.glyphs.toLocaleString()} glyphs drawn · ` +
    `${stats.drawCalls} draw calls · zoom ${Math.round(camera.zoom * 100)}% · ` +
    `CPU ${frameMs.toFixed(2)} ms/frame · layout ${layoutMs.toFixed(0)} ms`;
}

// Multi-page documents open as a grid filling the window; `g` toggles a single column.
let grid = pages.length > 1;
let bounds: Bounds = arrangePages(pages, 1, LETTER.gap);

function arrange(): void {
  const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  bounds = arrangePages(pages, grid ? columnsToFill(pages, aspect, LETTER.gap) : 1, LETTER.gap);
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

let arranged = false;
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
  if (!arranged) {
    arrange();
    arranged = true;
  }
  requestRender();
}).observe(canvas);

// Trackpad pinch arrives as ctrl+wheel; cmd/ctrl+wheel zooms with a mouse; plain wheel scrolls.
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? canvas.clientHeight : 1;
    if (e.ctrlKey || e.metaKey) {
      camera.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * unit * 0.01));
    } else {
      camera.panBy(e.deltaX * unit, e.deltaY * unit);
    }
    requestRender();
  },
  { passive: false },
);

let drag: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  camera.panBy(drag.x - e.clientX, drag.y - e.clientY);
  drag = { x: e.clientX, y: e.clientY };
  requestRender();
});
canvas.addEventListener('pointerup', () => (drag = null));

window.addEventListener('keydown', (e) => {
  const cx = canvas.clientWidth / 2;
  const cy = canvas.clientHeight / 2;
  const pageHeight = canvas.clientHeight / (camera.zoom * CSS_PX_PER_POINT);
  if (e.key === '=' || e.key === '+') camera.zoomAt(cx, cy, 1.25);
  else if (e.key === '-') camera.zoomAt(cx, cy, 0.8);
  else if (e.key === '0') camera.zoomAt(cx, cy, 1 / camera.zoom);
  else if (e.key === 'PageDown' || e.key === ' ') camera.y += pageHeight * 0.9;
  else if (e.key === 'PageUp') camera.y -= pageHeight * 0.9;
  else if (e.key === 'Home') camera.y = bounds.y;
  else if (e.key === 'End') camera.y = bounds.y + bounds.height - pageHeight;
  else if (e.key === 'f') camera.fit(bounds, canvas.clientWidth, canvas.clientHeight);
  else if (e.key === 'g') {
    grid = !grid;
    arrange();
  }
  else return;
  e.preventDefault();
  requestRender();
});

// Debug/automation hook.
Object.assign(window, { camera, pages, requestRender, render });
