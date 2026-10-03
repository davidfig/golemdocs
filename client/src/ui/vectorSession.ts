// Everything the vector editor needs, behind one entry so it is a single chunk fetched when the first
// drawing is opened (never imported statically): the layer that paints the drawing, the editor that
// changes it, the layers panel, and reading and writing the drawing's file.

import type { Camera } from '../view/camera.ts';
import type { ChromeState, VectorOp } from './actions.ts';
import { svgBytes, svgText } from '../formats/vectorDoc.ts';
import { writeSvg } from '../vector/svgWrite.ts';
import { LayersPanel } from './layersPanel.ts';
import { VectorEditor } from './vectorEditor.ts';
import type { ShapeStyle } from './vectorEditor.ts';
import { VectorLayer } from './vectorLayer.ts';

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
  notice(message: string): void;
  focusEditor(): void;
  toggleLayers(): void;
}

export interface VectorSession {
  readonly editor: VectorEditor;
  /** Starts editing the drawing in these file bytes (SVG, or compressed SVG). */
  open(bytes: Uint8Array): Promise<void>;
  /** Paints the drawing and the layers panel, where the view has them. */
  position(layersOpen: boolean): void;
  /** What the chrome shows of the editor. */
  state(layersOpen: boolean): ChromeState['vector'];
  action(op: VectorOp): void;
  style(change: Partial<ShapeStyle>): void;
}

export function createVectorSession(host: VectorSessionHost): VectorSession {
  const layer = new VectorLayer(host.viewport, { camera: host.camera, page: host.page, changed: host.changed });
  const compressed = { value: false };
  const editor: VectorEditor = new VectorEditor({
    canvas: host.canvas,
    layer,
    changed: (scene) => void svgBytes(writeSvg(scene), compressed.value).then(host.reopen),
    stateChanged: host.changed,
    notice: host.notice,
  });
  const panel = new LayersPanel(host.workspace, editor, { close: host.toggleLayers, focusEditor: host.focusEditor });

  return {
    editor,
    async open(bytes) {
      const { scene, gzip } = await svgText(bytes);
      compressed.value = gzip;
      if (!editor.active) editor.open(scene);
    },
    position(layersOpen) {
      layer.position();
      panel.setVisible(layersOpen && editor.active);
      panel.update();
    },
    state(layersOpen) {
      return {
        tool: editor.tool,
        hasSelection: editor.selection.length > 0,
        multiple: editor.selection.length > 1,
        clipped: editor.clipped,
        masked: editor.masked,
        layers: layersOpen,
        snap: editor.snapping,
        ...editor.currentStyle,
      };
    },
    action(op) {
      switch (op) {
        case 'select':
        case 'rect':
        case 'ellipse':
        case 'line':
        case 'pen':
        case 'text':
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
  };
}
