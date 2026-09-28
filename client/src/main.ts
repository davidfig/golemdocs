import './style.css';
import { FontLibrary } from './text/fontLibrary.ts';
import { TextRenderer } from './text/textRenderer.ts';
import { buildDemo } from './demo.ts';
import { Camera } from './view/camera.ts';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const statsEl = document.getElementById('stats') as HTMLDivElement;
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: true });
if (!gl) throw new Error('WebGL2 not supported');

const camera = new Camera();
const renderer = new TextRenderer(gl);
const library = await FontLibrary.load(gl);
const repeat = Number(new URLSearchParams(location.search).get('repeat') ?? 1);
const buildStart = performance.now();
const batches = await buildDemo(library, Math.max(1, repeat));
const buildMs = performance.now() - buildStart;

let frameQueued = false;
let lastFrameMs = 0;

function requestRender(): void {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(render);
}

function render(): void {
  frameQueued = false;
  const start = performance.now();
  gl!.viewport(0, 0, camera.width, camera.height);
  gl!.clearColor(1, 1, 1, 1);
  gl!.clear(gl!.COLOR_BUFFER_BIT);
  const stats = renderer.render(camera, batches);
  lastFrameMs = performance.now() - start;
  statsEl.textContent =
    `${stats.glyphs.toLocaleString()} glyphs · ${stats.drawCalls} draw calls · ` +
    `zoom ${Math.round(camera.zoom * 100)}% · CPU ${lastFrameMs.toFixed(2)} ms/frame · ` +
    `layout ${buildMs.toFixed(0)} ms`;
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
  if (e.key === '=' || e.key === '+') camera.zoomAt(cx, cy, 1.25);
  else if (e.key === '-') camera.zoomAt(cx, cy, 0.8);
  else if (e.key === '0') camera.zoomAt(cx, cy, 1 / camera.zoom);
  else return;
  requestRender();
});

// Debug/automation hook.
Object.assign(window, { camera, requestRender, render });
