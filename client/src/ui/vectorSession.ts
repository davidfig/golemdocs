// Everything the vector editor needs, behind one entry so it is a single chunk fetched when the first
// drawing is opened (never imported statically): the layer that paints the drawing, the editor that
// changes it, the layers panel, and reading and writing the drawing's file.

import type { Camera } from '../view/camera.ts';
import type { ChromeState, VectorOp } from './actions.ts';
import { colorText, parseColor } from '../vector/style.ts';
import { sceneToPng, svgBytes, svgText } from '../formats/vectorDoc.ts';
import { writeSvg } from '../vector/svgWrite.ts';
import { emptyScene, type Scene } from '../vector/model.ts';
import { LayersPanel } from './layersPanel.ts';
import { ToolOptions } from './toolOptions.ts';
import { VectorEditor } from './vectorEditor.ts';
import type { ShapeStyle } from './vectorEditor.ts';
import { VectorLayer } from './vectorLayer.ts';
import { isShapeId, type ShapeId } from '../vector/shapes.ts';

export interface VectorSessionHost {
  camera: Camera;
  canvas: HTMLCanvasElement;
  /** The element the drawing is painted in, and the one the layers panel goes in. */
  viewport: HTMLElement;
  workspace: HTMLElement;
  /** The drawing's page: where it is, in points. */
  page(): { x: number; y: number; width: number; height: number } | undefined;
  /** Something changed that needs the view drawn again. */
  changed(): void;
  /** The drawing was changed: its file is to be opened in place of the open one and saved. */
  reopen(bytes: Uint8Array): void;
  /** Offered the drawing itself after each change: true if it was taken (a drawing edited together sends the change to the room). */
  sceneCommitted?(scene: Scene, base?: Scene): boolean;
  /** Undo and redo of a drawing edited together are the room's: true if the step was taken. */
  step?(direction: 'undo' | 'redo'): boolean;
  notice(message: string): void;
  focusEditor(): void;
  toggleLayers(): void;
}

export interface VectorSession {
  readonly editor: VectorEditor;
  /** Starts editing the drawing in these file bytes (SVG, or compressed SVG). */
  open(bytes: Uint8Array): Promise<void>;
  /** Starts editing a drawing embedded in another document: dimmed all around, cut off at its edge. `changed` gets the SVG text after each edit; `leave` is asked for by a press outside it or Escape. */
  openEmbedded(bytes: Uint8Array, hooks: { changed(svg: string): void; leave(): void }): Promise<void>;
  /** The picture a document shows for the drawing in this SVG text, and the drawing's size. */
  picture(svg: string): Promise<{ png: Uint8Array; width: number; height: number }>;
  /** The drawing as it now stands after changes from others (or an undo) in a drawing edited together; the selection stays. */
  syncScene(scene: Scene): void;
  /** The SVG text of a new blank drawing. */
  blank(width: number, height: number): string;
  /** Stops editing the embedded drawing. */
  closeEmbedded(): void;
  readonly embedded: boolean;
  /** Paints the drawing being edited (not one in the text) into its page's thumbnail; false when there is none. */
  paintThumbnail(ctx: CanvasRenderingContext2D, width: number, height: number): boolean;
  /** Paints the drawing and the layers panel, where the view has them. */
  position(layersOpen: boolean): void;
  /** What the chrome shows of the editor. */
  state(layersOpen: boolean): ChromeState['vector'];
  action(op: VectorOp): void;
  style(change: Partial<ShapeStyle>): void;
  gradient(change: { op: 'select' | 'add' | 'remove' | 'move' | 'reverse'; index?: number; offset?: number }): void;
}

/** A colour as #rrggbb when it is a plain one (so the palette can mark it), else as it is. */
const hex = (color: string | null): string | null => {
  const rgba = color ? parseColor(color) : null;
  return rgba && rgba[3] === 1 ? colorText(rgba) : color;
};

export function createVectorSession(host: VectorSessionHost): VectorSession {
  const layer = new VectorLayer(host.viewport, { camera: host.camera, page: host.page, changed: host.changed });
  const compressed = { value: false };
  let embedded: { changed(svg: string): void; leave(): void } | null = null;
  const editor: VectorEditor = new VectorEditor({
    canvas: host.canvas,
    layer,
    changed: (scene, base) => {
      if (!embedded && host.sceneCommitted?.(scene, base)) return;
      const text = writeSvg(scene);
      if (embedded) embedded.changed(text);
      else void svgBytes(text, compressed.value).then(host.reopen);
    },
    stateChanged: host.changed,
    notice: host.notice,
    outside: (e) => !!embedded && layer.outside(e.clientX, e.clientY),
    step: (direction) => host.step?.(direction) ?? false,
    get leave() {
      return embedded ? embedded.leave : undefined;
    },
  });
  const openCanvas = (): void =>
    void import('./canvasDialog.ts').then(({ showCanvasDialog }) =>
      showCanvasDialog({
        state: () => editor.page,
        apply: (w, h, mode, background) => editor.setPage(w, h, mode, background),
        fit: (margin, background) => editor.fitPage(margin, background),
        focusEditor: host.focusEditor,
      }),
    );
  const panel = new LayersPanel(host.workspace, editor, { close: host.toggleLayers, focusEditor: host.focusEditor, canvasSize: openCanvas, fitCanvas: () => editor.fitPage(0) });
  const options = new ToolOptions(host.viewport, host.focusEditor);

  return {
    editor,
    async open(bytes) {
      const { scene, gzip } = await svgText(bytes);
      compressed.value = gzip;
      if (!editor.active) editor.open(scene);
    },
    async openEmbedded(bytes, hooks) {
      const { scene } = await svgText(bytes);
      if (editor.active) editor.close();
      embedded = hooks;
      layer.focus = true;
      editor.open(scene);
    },
    async picture(svg) {
      const { scene } = await svgText(new TextEncoder().encode(svg));
      return { png: await sceneToPng(scene), width: scene.width, height: scene.height };
    },
    syncScene: (scene) => editor.sync(scene),
    blank: (width, height) => writeSvg(emptyScene(width, height)),
    closeEmbedded() {
      if (!embedded) return;
      embedded = null;
      editor.close();
      layer.focus = false;
    },
    get embedded() {
      return !!embedded;
    },
    paintThumbnail(ctx, width, height) {
      return !embedded && editor.active && layer.paintInto(ctx, width, height);
    },
    position(layersOpen) {
      layer.position();
      options.setTool(editor.active ? editor.tool : '');
      panel.setVisible(layersOpen && editor.active);
      panel.update();
    },
    state(layersOpen) {
      const style = editor.currentStyle;
      return {
        tool: editor.tool,
        shape: editor.shapeId,
        hasSelection: editor.selection.length > 0,
        multiple: editor.selection.length > 1,
        clipped: editor.clipped,
        masked: editor.masked,
        layers: layersOpen,
        snap: editor.snapping,
        ...style,
        fill: hex(style.fill),
        stroke: hex(style.stroke),
        gradient: editor.gradientStops,
        documentColors: editor.documentColors,
      };
    },
    action(op) {
      if (op.startsWith('shape:')) return isShapeId(op.slice(6)) ? editor.setShape(op.slice(6) as ShapeId) : undefined;
      switch (op) {
        case 'select':
        case 'rect':
        case 'ellipse':
        case 'shape':
        case 'line':
        case 'pen':
        case 'pencil':
        case 'nudge':
        case 'text':
        case 'canvas':
          return editor.setTool(op);
        case 'delete':
          return editor.delete();
        case 'duplicate':
          return editor.duplicate();
        case 'group':
          return editor.group();
        case 'ungroup':
          return editor.ungroup();
        case 'front':
        case 'forward':
        case 'backward':
        case 'back':
          return editor.order(op);
        case 'selectAll':
          return editor.selectAll();
        case 'unite':
        case 'intersect':
        case 'subtract':
        case 'exclude':
          return void editor.boolean(op);
        case 'makeClip':
          return editor.makeClip();
        case 'releaseClip':
          return editor.releaseClip();
        case 'newLayer':
          return editor.newLayer();
        case 'newGroup':
          return editor.newGroup();
        case 'canvasSize':
          return openCanvas();
        case 'guideV':
          return editor.addGuide('v');
        case 'guideH':
          return editor.addGuide('h');
        case 'clearGuides':
          return editor.clearGuides();
        case 'makeMask':
          return editor.makeMask();
        case 'releaseMask':
          return editor.releaseMask();
        case 'snap':
          return editor.toggleSnap();
        case 'layers':
          return host.toggleLayers();
      }
    },
    style: (change) => editor.applyStyle(change),
    gradient({ op, index = 0, offset = 0 }) {
      if (op === 'select') editor.selectStop(index);
      else if (op === 'add') editor.addStopAt(offset);
      else if (op === 'remove') editor.removeStopAt(index);
      else if (op === 'move') editor.moveStop(index, offset);
      else editor.reverseGradient();
    },
  };
}
