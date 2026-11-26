// The kinds of file the layout worker would only turn into a document, shown in the viewer the way the app shows them: a workbook
// (and a CSV or TSV) in the spreadsheet editor, a deck in the slides editor, audio and video in the media player, each read-only.
// The viewer drives them through `EditorView` as main.ts drives them in the app: it hands them its canvas, camera, fonts and the
// pointer, and draws them each frame. This glue (about 9 kB, under the size a chunk of its own pays for) comes with the viewer; each
// editor is fetched only when a file of its kind opens (the handles fetch theirs on `load`), so a shared Word file costs little more. See docs/architecture/viewer.md.

import type { DocumentSource } from '../layout/protocol.ts';
import type { Camera } from '../view/camera.ts';
import type { AtlasLibrary } from '../webgl/text/gpuFace.ts';
import type { ForcedColors } from '../webgl/program.ts';
import { SheetEditor } from '../sheet/handle.ts';
import { SlidesEditor } from '../slides/handle.ts';
import { mediaMime } from '../media/mediaFiles.ts';
import { editorFor, type EditorKind } from './editorKinds.ts';

/** A file read from bytes (every source the viewer opens is one). */
export type FileSource = Extract<DocumentSource, { bytes: ArrayBuffer }>;

/** What the viewer needs of an editor showing a file. */
export interface EditorView {
  readonly kind: EditorKind;
  /** Keeps the camera on what there is: a workbook from its top-left corner, a deck centred. */
  clamp(camera: Camera, width: number, height: number): void;
  /** Draws a frame (a sheet and a deck on the viewer's canvas; media is its own elements, over it). */
  draw(dark: boolean, forced: ForcedColors | null): void;
  press(x: number, y: number, shift: boolean, clicks: number, additive: boolean): void;
  drag(x: number, y: number, shift: boolean): void;
  release(): void;
  cursorAt(x: number, y: number): string;
  focus(): void;
  /** Its own Find, where it has one. */
  readonly find: (() => void) | null;
  /** It as a PDF for Print, where it can be printed. */
  pdf(): Promise<Uint8Array> | null;
  /** A newer save of the same file. */
  reload(bytes: ArrayBuffer): Promise<void>;
  destroy(): void;
}

export interface EditorHost {
  /** The element the editor puts its own elements in (the viewer's view, holding the canvas). */
  parent: HTMLElement;
  canvas: HTMLCanvasElement;
  camera: Camera;
  gl: WebGL2RenderingContext;
  atlases: AtlasLibrary;
  fontBase: string;
  locale: string;
  render(): void;
  /** The viewer's own keys (zoom, Find); true if it took the key. */
  viewKey(e: KeyboardEvent): boolean;
  fail(message: string): void;
}

/** Opens `source` in its editor, read-only; null when it turns out not to be one (a .wdoc CSV that holds no table). */
export async function openEditorView(source: DocumentSource, host: EditorHost): Promise<EditorView | null> {
  if (!('bytes' in source)) return null;
  const kind = editorFor(source);
  if (kind === 'sheet') return openSheet(source, host);
  if (kind === 'slides') return openSlides(source, host);
  if (kind === 'media') return openMedia(source, host);
  return null;
}

const nothing = (): void => {};

async function openSheet(source: FileSource, host: EditorHost): Promise<EditorView | null> {
  /** The file as the spreadsheet editor reads it: a CSV kept as a document gives back its table (formats/wdocDelimited.ts). */
  const fileOf = async (bytes: ArrayBuffer): Promise<{ bytes: Uint8Array; format?: 'csv' | 'tsv'; layout?: Parameters<SheetEditor['open']>[4] } | null> => {
    if (source.kind === 'csv' || source.kind === 'tsv') return { bytes: new Uint8Array(bytes), format: source.kind };
    if (source.kind === 'xlsx') return { bytes: new Uint8Array(bytes) };
    const { delimitedFromWdoc } = await import('../formats/wdocDelimited.ts');
    const file = await delimitedFromWdoc(new Uint8Array(bytes));
    return file && { bytes: file.bytes, format: file.kind, layout: file.layout };
  };
  const first = await fileOf(source.bytes);
  if (!first) return null;
  const sheet = new SheetEditor(host.parent, {
    camera: host.camera,
    gl: host.gl,
    atlases: host.atlases,
    fontBase: host.fontBase,
    locale: () => host.locale,
    render: host.render,
    viewKey: host.viewKey,
    notify: (message) => console.warn(message),
    openFailed: (message) => host.fail(message),
    appKey: () => false,
    author: () => '',
  });
  await sheet.load();
  const open = (file: NonNullable<typeof first>): void => {
    sheet.open(source.name, file.bytes, null, file.format, file.layout);
    // Nothing a reader does changes it: no typing, filling, moving or resizing (as a "Can view" share in the app).
    sheet.readOnly = true;
  };
  // A workbook opens at its first cell, at 100%, as in the app.
  host.camera.zoom = Math.min(Math.max(1, host.camera.minZoom), host.camera.maxZoom);
  host.camera.x = 0;
  host.camera.y = 0;
  open(first);
  return {
    kind: 'sheet',
    clamp: (camera, width, height) => camera.clampToStart(sheet.bounds(), width, height),
    draw: (dark, forced) => sheet.draw(dark, forced),
    press: (x, y, shift, clicks, additive) => sheet.press(x, y, shift, clicks, additive),
    drag: (x, y) => sheet.drag(x, y),
    release: () => sheet.release(),
    cursorAt: (x, y) => sheet.cursorAt(x, y),
    focus: () => sheet.focus(),
    find: () => sheet.find(false),
    pdf: () => sheet.printPdf(),
    async reload(bytes) {
      const file = await fileOf(bytes);
      if (file) open(file);
      host.render();
    },
    destroy: () => sheet.close(),
  };
}

async function openSlides(source: FileSource, host: EditorHost): Promise<EditorView> {
  const slides = new SlidesEditor(host.parent, {
    camera: host.camera,
    fontBase: host.fontBase,
    render: host.render,
    viewKey: host.viewKey,
    appKey: () => false,
    notify: (message) => console.warn(message),
    openFailed: (message) => host.fail(message),
    // Nothing is added to a deck only looked at.
    pickImage: () => Promise.resolve(null),
    pickDeck: () => Promise.resolve(null),
  });
  await slides.load();
  const open = async (bytes: ArrayBuffer): Promise<void> => {
    await slides.open(source.name, new Uint8Array(bytes));
    slides.readOnly = true;
  };
  await open(source.bytes);
  // A deck opens with its first slide fitted to the window, as in the app.
  slides.fitFirst(host.canvas.clientWidth, host.canvas.clientHeight);
  return {
    kind: 'slides',
    clamp: (camera, width, height) => camera.clamp(slides.bounds(), width, height, 48),
    draw: (dark) => slides.draw(dark),
    press: (x, y, shift, clicks, additive) => slides.press(x, y, shift, clicks, additive),
    drag: (x, y, shift) => slides.drag(x, y, shift),
    release: () => slides.release(),
    cursorAt: (x, y) => slides.cursorAt(x, y),
    focus: () => slides.focus(),
    find: null,
    pdf: () => slides.printPdf(),
    async reload(bytes) {
      await open(bytes);
      host.render();
    },
    destroy: () => slides.close(),
  };
}

const CAPTIONS_KEY = 'golem.mediaCaptions';

async function openMedia(source: FileSource, host: EditorHost): Promise<EditorView> {
  // The player is its own chunk: it is the app's (media/viewer.ts), with the app's icons.
  const { MediaViewer } = await import('../media/viewer.ts');
  const player = new MediaViewer(host.parent, {
    changed: nothing,
    captionsOn: () => {
      try {
        return localStorage.getItem(CAPTIONS_KEY) === 'on';
      } catch {
        return false;
      }
    },
    setCaptionsOn: (on) => {
      try {
        localStorage.setItem(CAPTIONS_KEY, on ? 'on' : 'off');
      } catch {
        // Not remembered: captions start off next time.
      }
    },
  });
  const kind = source.kind === 'audio' ? 'audio' : 'video';
  let url = '';
  const open = (bytes: ArrayBuffer): void => {
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(new Blob([bytes], { type: mediaMime(source.name) }));
    player.open({ name: source.name, kind, url, size: bytes.byteLength });
  };
  open(source.bytes);
  return {
    kind: 'media',
    clamp: nothing,
    draw: nothing,
    press: nothing,
    drag: nothing,
    release: nothing,
    cursorAt: () => '',
    focus: () => player.focus(),
    find: null,
    pdf: () => null,
    async reload(bytes) {
      open(bytes);
    },
    destroy() {
      player.close();
      if (url) URL.revokeObjectURL(url);
    },
  };
}
