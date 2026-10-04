// Draws a big text file with the app's WebGL text renderer, on the same camera as documents, so zooming, panning and
// the fonts are the ones everything else has. The file is drawn in chunks of CHUNK lines, each one instanced glyph buffer
// per face plus one rectangle buffer (the line-number gutter), built when first in view and kept in a small cache. Zooming
// only changes uniforms.

import { GlyphList, RectList, packColor } from '@golemdocs/layout';
import { DARK_PAGE_RGB } from '../webgl/program.ts';
import { CARET, REMOTE_ALPHA, REMOTE_FLAG, REMOTE_WIDTH, SELECTION, SQUIGGLE_COLORS, squiggleRects } from '../webgl/overlayColors.ts';
import type { TextMark } from '../layout/protocol.ts';
import { RectBatch, RectBatchRenderer } from '../webgl/shapes/rectBatch.ts';
import { TextBatch } from '../webgl/text/textBatch.ts';
import type { GpuFace } from '../webgl/text/gpuFace.ts';
import { TextRenderer } from '../webgl/text/textRenderer.ts';
import { CSS_PX_PER_POINT } from '../view/camera.ts';
import type { Camera } from '../view/camera.ts';
import { cellWidth, forEachCell } from './lines.ts';
import { MonoFonts } from './fonts.ts';
import type { GlyphRef } from './fonts.ts';
import { LineIndex } from './lineIndex.ts';
import type { Pos, Selection } from './positions.ts';
import { BASELINE, CELL, CHUNK, LINE, SIZE, LineScene } from './scene.ts';
import type { Entries, Rect } from './scene.ts';

/** Chunks kept at least; more are kept when more are in view (zoomed far out), so a frame does not rebuild what the one before it drew. */
const MIN_KEPT = 24;
/** Milliseconds of a frame spent building chunks; the rest are built in the frames after. */
const BUDGET_MS = 10;
/** Rows built beyond the edge of the view, so a scroll finds them ready. */
const OVERSCAN_ROWS = 40;

const COLOR = {
  text: packColor(0x000000),
  muted: packColor(0x6a6a6a),
  error: packColor(0xb00020),
  warn: packColor(0x9a5b00),
  gutter: packColor(0xeeeeea),
  gutterEdge: packColor(0xb9b9b9),
  selection: SELECTION,
  match: packColor(0xffe066, 0.85),
  caret: CARET,
  current: packColor(0x316ac5),
};

/** The colour a line is drawn in: logs show their errors and warnings. */
export function levelColor(text: string): number {
  if (/\b(ERROR|FATAL|SEVERE|CRITICAL|Exception)\b/.test(text)) return COLOR.error;
  if (/\b(WARN|WARNING)\b/.test(text)) return COLOR.warn;
  if (/\b(DEBUG|TRACE)\b/.test(text)) return COLOR.muted;
  return COLOR.text;
}

/** What the view says about the text on screen. */
export interface DrawState {
  darkPages: boolean;
  caretVisible: boolean;
  selection: Selection;
  /** Search matches to mark (a global expression), or null. */
  highlight: { regex: RegExp; wholeWord: boolean } | null;
  /** Spelling and grammar marks of a line's text (undefined: none known). */
  marks?: (line: number, text: string) => readonly TextMark[] | undefined;
  /** Other people's selections (colour as 0xrrggbb). */
  remotes?: readonly { color: number; anchor: Pos; focus: Pos }[];
  /** The line the last search step landed on, or -1. */
  current: number;
  /** Text being composed by an input method, drawn at the caret. */
  composing: string | null;
}

export interface LineFrame {
  /** Chunks drawn. */
  chunks: number;
  glyphs: number;
  drawCalls: number;
  /** Chunks still to build: draw again. */
  pending: boolean;
}

interface Chunk {
  /** Entries first..last (inclusive). */
  first: number;
  last: number;
  text: TextBatch[];
  rects: RectBatch | null;
  version: number;
}

/** A glyph buffer being filled for one face. */
type Lists = Map<GpuFace, GlyphList>;

function put(lists: Lists, ref: GlyphRef, x: number, y: number, color: number): void {
  let list = lists.get(ref.face);
  if (!list) lists.set(ref.face, (list = new GlyphList(ref.font, ref.metrics)));
  list.push(x, y, SIZE, ref.glyph, color);
}

function batches(lists: Lists, originX: number, originY: number): TextBatch[] {
  return [...lists].filter(([, list]) => list.count > 0).map(([face, list]) => new TextBatch(face, { skew: 0, embolden: 0 }, list.buffer, list.count, originX, originY));
}

export class LineRenderer {
  private readonly text: TextRenderer;
  private readonly rects: RectBatchRenderer;
  private chunks = new Map<number, Chunk>();
  /** How many chunks the last frame had in view (the cache keeps at least that many, and a few more). */
  private inView = 0;
  /** Overlay batches of the last frame, and chunks that were only partly built (lines not indexed yet), freed at the next. */
  private overlays: { text: TextBatch[]; rects: RectBatch[] } = { text: [], rects: [] };
  private transient: Chunk[] = [];

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly fonts: MonoFonts,
    readonly scene: LineScene,
    private readonly lineIndex: () => LineIndex | null,
    private readonly entries: () => Entries,
  ) {
    this.text = new TextRenderer(gl);
    this.rects = new RectBatchRenderer(gl);
  }

  private free(chunk: Chunk): void {
    for (const batch of chunk.text) batch.dispose(this.gl);
    chunk.rects?.dispose(this.gl);
  }

  /** Forgets everything built (the lines shown, their wrap or the font changed). */
  reset(): void {
    for (const chunk of this.chunks.values()) this.free(chunk);
    this.chunks.clear();
  }

  /** Forgets the chunks holding entries from `entry` on (`to` bounds them when the lines after do not move). */
  forgetFrom(entry: number, to = Infinity): void {
    const from = Math.floor(entry / CHUNK);
    const until = to === Infinity ? Infinity : Math.floor(to / CHUNK);
    for (const [k, chunk] of this.chunks) {
      if (k >= from && k <= until) {
        this.free(chunk);
        this.chunks.delete(k);
      }
    }
  }

  dispose(): void {
    this.reset();
    this.freeOverlays();
    this.text.dispose();
  }

  // --- Building chunks ---

  private build(k: number): Chunk | null {
    const index = this.lineIndex();
    const entries = this.entries();
    const { scene, fonts } = this;
    if (!index) return null;
    const first = k * CHUNK;
    const last = Math.min(first + CHUNK, entries.count) - 1;
    const lists: Lists = new Map();
    const gutter = new RectList();
    const digits = scene.gutterCells - 2;
    let y = 0;
    let built = first - 1;
    for (let entry = first; entry <= last; entry++) {
      const line = entries.lineOf(entry);
      // Lines past what is indexed so far are drawn when the index reaches them.
      if (line >= index.available && !index.done) break;
      scene.settle(entry);
      const laid = scene.layout(line);
      const color = levelColor(laid.text);
      const number = String(line + 1);
      for (let d = 0; d < number.length; d++) {
        const ref = fonts.glyph(number.charCodeAt(d));
        if (ref?.visible) put(lists, ref, (digits - number.length + 1 + d) * CELL, y + BASELINE, COLOR.muted);
      }
      laid.rows.forEach((row, r) => {
        const baseline = y + r * LINE + BASELINE;
        forEachCell(laid.text, row, (_i, cp, cell) => {
          if (cp <= 32) return;
          const ref = fonts.glyph(cp);
          if (ref?.visible) put(lists, ref, scene.textLeft + cell * CELL, baseline, color);
        });
      });
      if (laid.more) {
        // What is not shown of a cut line: "… N B" after the last row's text.
        const note = `… ${laid.more.toLocaleString('en-US')} B`;
        const row = laid.rows[laid.rows.length - 1];
        let cell = row.cells;
        for (const ch of note) {
          const ref = ch === ' ' ? null : fonts.glyph(ch.codePointAt(0)!);
          if (ref?.visible) put(lists, ref, scene.textLeft + cell * CELL, y + (laid.rows.length - 1) * LINE + BASELINE, COLOR.muted);
          cell++;
        }
      }
      y += laid.rows.length * LINE;
      built = entry;
    }
    gutter.push(0, 0, scene.gutterWidth, y, COLOR.gutter);
    gutter.push(scene.gutterWidth - 0.25, 0, 0.25, y, COLOR.gutterEdge);
    return { first, last: built, text: batches(lists, 0, 0), rects: new RectBatch(gutter.buffer, gutter.count, 0, 0), version: fonts.version };
  }

  /** The chunk, built now if it is not in the cache (null when it cannot be built yet). Most recently used last. */
  private chunk(k: number): Chunk | null {
    const cache = this.chunks;
    let chunk = cache.get(k);
    if (chunk && chunk.version !== this.fonts.version) {
      this.free(chunk);
      cache.delete(k);
      chunk = undefined;
    }
    if (chunk) {
      cache.delete(k);
      cache.set(k, chunk);
      return chunk;
    }
    chunk = this.build(k) ?? undefined;
    if (!chunk || chunk.last < chunk.first) {
      if (chunk) this.free(chunk);
      return null;
    }
    // Partly built, as the index has not reached the end of it: drawn this once, built again when more of the file is indexed.
    if (chunk.last < Math.min(k * CHUNK + CHUNK, this.entries().count) - 1) {
      this.transient.push(chunk);
      return chunk;
    }
    cache.set(k, chunk);
    const limit = Math.max(MIN_KEPT, this.inView + 4);
    while (cache.size > limit) {
      const oldest = cache.keys().next().value as number;
      this.free(cache.get(oldest)!);
      cache.delete(oldest);
    }
    return chunk;
  }

  // --- Drawing ---

  private freeOverlays(): void {
    for (const chunk of this.transient) this.free(chunk);
    this.transient = [];
    for (const batch of this.overlays.text) batch.dispose(this.gl);
    for (const batch of this.overlays.rects) batch.dispose(this.gl);
    this.overlays = { text: [], rects: [] };
  }

  /** The rectangles as a batch whose coordinates are relative to `originY` (so float32 stays exact far down a long file). */
  private rectBatch(rects: readonly { rect: Rect; color: number }[], originY: number): RectBatch | null {
    if (!rects.length) return null;
    const list = new RectList();
    for (const { rect, color } of rects) list.push(rect.x, rect.y - originY, rect.width, rect.height, color);
    return new RectBatch(list.buffer, list.count, 0, originY);
  }

  /** Draws the file as the camera sees it. Chunks that could not be built within the frame's budget are left for the next (`pending`). */
  draw(camera: Camera, state: DrawState): LineFrame {
    const { gl, scene } = this;
    const frame: LineFrame = { chunks: 0, glyphs: 0, drawCalls: 0, pending: false };
    this.freeOverlays();
    const page = state.darkPages ? DARK_PAGE_RGB : 0xffffff;
    gl.viewport(0, 0, camera.width, camera.height);
    gl.clearColor(((page >> 16) & 255) / 255, ((page >> 8) & 255) / 255, (page & 255) / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const entries = this.entries();
    if (!this.lineIndex() || !entries.count) return frame;

    // Wrapping follows the window at 100% zoom, so zooming scales the text without moving its line breaks.
    if (scene.setViewportWidth(camera.width / camera.dpr / CSS_PX_PER_POINT)) {
      scene.rebuild();
      this.reset();
    }
    this.text.darkPages = state.darkPages;
    this.rects.darkPages = state.darkPages;

    const scale = camera.scale;
    const top = camera.y;
    const bottom = top + camera.height / scale;
    const firstEntry = scene.locate(top - OVERSCAN_ROWS * LINE).entry;
    const lastEntry = scene.locate(bottom + OVERSCAN_ROWS * LINE).entry;

    // Laying lines out corrects the heights that were estimated; what is at the top of the view stays where it is.
    const anchor = scene.locate(top).entry;
    const anchorTop = scene.top(anchor);
    const started = performance.now();
    const chunks: Chunk[] = [];
    this.inView = Math.floor(lastEntry / CHUNK) - Math.floor(firstEntry / CHUNK) + 1;
    for (let k = Math.floor(firstEntry / CHUNK); k <= Math.floor(lastEntry / CHUNK); k++) {
      if (performance.now() - started > BUDGET_MS && chunks.length) {
        frame.pending = true;
        break;
      }
      const chunk = this.chunk(k);
      if (chunk) chunks.push(chunk);
      else if (k * CHUNK < entries.count) frame.pending = true;
    }
    const moved = scene.top(anchor) - anchorTop;
    if (moved) camera.y += moved;
    const viewTop = camera.y;

    // Chunks hold their rows relative to their own top, which is where the (settled) heights now put them.
    const gutters: RectBatch[] = [];
    const texts: TextBatch[] = [];
    for (const chunk of chunks) {
      const y = scene.top(chunk.first);
      if (chunk.rects) {
        chunk.rects.originY = y;
        gutters.push(chunk.rects);
      }
      for (const batch of chunk.text) {
        batch.originY = y;
        texts.push(batch);
      }
    }

    const firstVisible = scene.locate(viewTop).entry;
    const lastVisible = scene.locate(viewTop + camera.height / scale).entry;
    const originY = scene.top(firstVisible);
    const under: { rect: Rect; color: number }[] = [];
    const over: { rect: Rect; color: number }[] = [];
    if (state.highlight) for (const rect of scene.matches(state.highlight.regex, state.highlight.wholeWord, firstVisible, lastVisible)) under.push({ rect, color: COLOR.match });
    if (state.current >= 0) {
      const entry = entries.entryOf(state.current);
      if (entry >= firstVisible && entry <= lastVisible && entries.lineOf(entry) === state.current) {
        const y = scene.top(entry);
        const height = scene.rowsOf(entry) * LINE;
        const x = scene.gutterWidth;
        const width = scene.bounds.width - x;
        for (const rect of [{ x, y, width, height: 0.5 }, { x, y: y + height - 0.5, width, height: 0.5 }, { x, y, width: 0.5, height }, { x: x + width - 0.5, y, width: 0.5, height }]) under.push({ rect, color: COLOR.current });
      }
    }
    for (const person of state.remotes ?? []) {
      for (const rect of scene.selection(person, firstVisible, lastVisible)) under.push({ rect, color: packColor(person.color, REMOTE_ALPHA) });
    }
    for (const rect of scene.selection(state.selection, firstVisible, lastVisible)) under.push({ rect, color: COLOR.selection });
    for (const person of state.remotes ?? []) {
      const box = scene.caretBox(person.focus);
      if (!box || box.y + box.height < viewTop || box.y > viewTop + camera.height / scale) continue;
      const color = packColor(person.color);
      over.push({ rect: { x: box.x - REMOTE_WIDTH / 2, y: box.y, width: REMOTE_WIDTH, height: box.height }, color });
      over.push({ rect: { x: box.x - REMOTE_WIDTH / 2, y: box.y - REMOTE_FLAG, width: REMOTE_FLAG * 1.6, height: REMOTE_FLAG }, color });
    }
    if (state.marks) {
      for (let entry = firstVisible; entry <= lastVisible && entry < entries.count; entry++) {
        const line = entries.lineOf(entry);
        const marks = state.marks(line, scene.layout(line).text);
        if (marks) for (const mark of marks) for (const rect of scene.spans(entry, mark.start, mark.end)) for (const [x, y, width, height] of squiggleRects(rect.x, rect.y, rect.width, rect.height)) over.push({ rect: { x, y, width, height }, color: SQUIGGLE_COLORS[mark.kind] });
      }
    }
    const caret = scene.caretBox(state.selection.focus);
    if (state.caretVisible && caret && caret.y + caret.height >= viewTop && caret.y <= viewTop + camera.height / scale) {
      let x = caret.x;
      if (state.composing) {
        const lists: Lists = new Map();
        let cell = 0;
        for (const ch of state.composing) {
          const cp = ch.codePointAt(0)!;
          const ref = cp > 32 ? this.fonts.glyph(cp) : null;
          if (ref?.visible) put(lists, ref, x + cell * CELL, caret.y - originY + BASELINE, COLOR.text);
          cell += Math.max(cellWidth(cp), 0);
        }
        this.overlays.text.push(...batches(lists, 0, originY));
        over.push({ rect: { x, y: caret.y + LINE - 1.5, width: cell * CELL, height: 0.6 }, color: COLOR.caret });
        x += cell * CELL;
      }
      over.push({ rect: { x, y: caret.y + 1, width: 0.01, height: LINE - 2 }, color: COLOR.caret });
    }
    const underBatch = this.rectBatch(under, originY);
    const overBatch = this.rectBatch(over, originY);
    if (underBatch) this.overlays.rects.push(underBatch);
    if (overBatch) this.overlays.rects.push(overBatch);

    // The gutters, the marks and selection, the text, then the caret.
    frame.drawCalls += this.rects.render(camera, gutters);
    if (underBatch) frame.drawCalls += this.rects.render(camera, [underBatch]);
    texts.sort((a, b) => a.face.id - b.face.id);
    const drawn = this.text.render(camera, texts);
    frame.drawCalls += drawn.drawCalls;
    frame.glyphs += drawn.glyphs;
    const extra = this.text.render(camera, this.overlays.text);
    frame.drawCalls += extra.drawCalls;
    frame.glyphs += extra.glyphs;
    if (overBatch) frame.drawCalls += this.rects.render(camera, [overBatch]);
    frame.chunks = chunks.length;
    return frame;
  }

  /** Where the caret is, in document points (for revealing it and for the input method's window). */
  caretAt(pos: Pos): Rect | null {
    return this.scene.caretBox(pos);
  }
}
