// Connects the menu bar and toolbars (./ui) to this app: which actions exist today, and how each
// one reaches the camera, the layout worker or the editor. As the editor grows operations
// (formatting, undo, tables…), add them to SUPPORTED and to perform(); the UI enables them.

import type { WireCommand } from './layout/protocol.ts';
import type { DocumentSource } from './layout/protocol.ts';
import { sourceFromFile } from './formats/source.ts';
import type { Bounds } from './document/arrange.ts';
import type { GpuPage } from './view/gpuPage.ts';
import { CSS_PX_PER_POINT, type Camera } from './view/camera.ts';
import { acceptList, kindFromName, type Action, type DocumentKind, type ActionKind, type ChromeHost, type CloudState, type Sample, type ZoomTarget } from './ui/index.ts';

export interface AppHooks {
  /** Show (or hide) the dashboard of all documents. */
  dashboard(): void;
  canvas: HTMLCanvasElement;
  camera: Camera;
  pages(): readonly GpuPage[];
  bounds(): Bounds;
  open(source: DocumentSource): void;
  openSample(id: string): void;
  /** Put the document in a collaboration room and open a second window on it. */
  collaborate(): void;
  /** Save in this browser, then to the cloud; asks the user to sign in if they haven't. */
  saveToCloud(): Promise<void>;
  /** Download a copy of the document as a file, in its own format. */
  download(): Promise<void>;
  /** Make a copy of the document in another format next to the original, and open it. */
  convert(to: DocumentKind): Promise<void>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** Documents saved in this browser. */
  saved(): Sample[];
  cloud(): CloudState;
  send(command: WireCommand): void;
  /** The selected text (for copy and cut). */
  selectedText(): string;
  focusEditor(): void;
  notify(message: string): void;
  toggleGrid(): void;
  toggleStats(): void;
  /** The camera moved: stop auto-placing it, and redraw. */
  viewChanged(): void;
  fonts(): Promise<string[]>;
  samples(): Sample[];
}

/** Actions the app implements today, whatever the document. */
const SUPPORTED = new Set<ActionKind>([
  'dashboard',
  'new',
  'open',
  'openSample',
  'openSaved',
  'openCloud',
  'saveToCloud',
  'download',
  'signIn',
  'signOut',
  'cut',
  'copy',
  'paste',
  'selectAll',
  'collaborate',
  'undo',
  'redo',
  'zoom',
  'zoomBy',
  'toggleGrid',
  'toggleStats',
  'insertText',
  'convert',
]);


/** The formats a document can be converted to. */
const CONVERTIBLE = new Set<DocumentKind>(['docx', 'pdf', 'md', 'txt']);

export function createChromeHost(app: AppHooks): ChromeHost & { openFile(file: File): void } {
  let untitled = 0;

  const openFile = (file: File): void => {
    if (sourceFromFile(file.name, new ArrayBuffer(0))) {
      void file.arrayBuffer().then((bytes) => app.open(sourceFromFile(file.name, bytes)!));
    } else {
      app.notify(`Opening ${kindFromName(file.name, 'txt').toUpperCase()} files isn't supported yet (${file.name})`);
    }
  };

  const pickFile = (): void => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: acceptList() });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) openFile(file);
    });
    input.click();
  };

  /** The page at the middle of the view (or nearest to it). */
  const currentPage = (): GpuPage | null => {
    const { canvas, camera } = app;
    const center = camera.toDocument(canvas.clientWidth / 2, canvas.clientHeight / 2);
    let best: GpuPage | null = null;
    let bestDistance = Infinity;
    for (const page of app.pages()) {
      const dy = center.y < page.y ? page.y - center.y : center.y > page.y + page.height ? center.y - page.y - page.height : 0;
      const dx = center.x < page.x ? page.x - center.x : center.x > page.x + page.width ? center.x - page.x - page.width : 0;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        best = page;
        bestDistance = distance;
      }
    }
    return best;
  };

  const zoomTo = (to: ZoomTarget): void => {
    const { canvas, camera } = app;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (typeof to === 'number') {
      camera.zoomAt(width / 2, height / 2, to / camera.zoom);
    } else if (to === 'allPages') {
      camera.fit(app.bounds(), width, height);
    } else {
      const page = currentPage();
      if (!page) return;
      if (to === 'wholePage') {
        camera.fit(page, width, height, 16);
      } else {
        // Page width: fill the view with the page, keeping the top of the view where it was.
        const top = camera.toDocument(0, 0).y;
        camera.zoom = Math.min(Math.max((width - 32) / (page.width * CSS_PX_PER_POINT), camera.minZoom), camera.maxZoom);
        const pointsPerCss = 1 / (camera.zoom * CSS_PX_PER_POINT);
        camera.x = page.x + page.width / 2 - (width / 2) * pointsPerCss;
        camera.y = top;
      }
    }
    app.viewChanged();
  };

  return {
    openFile,

    supports(action: Action): boolean {
      if (action.kind === 'convert') return CONVERTIBLE.has(action.to);
      if (action.kind === 'insertBreak') return action.break === 'line';
      if (action.kind === 'viewMode') return action.mode === 'print';
      return SUPPORTED.has(action.kind);
    },

    async perform(action: Action): Promise<void> {
      switch (action.kind) {
        case 'dashboard':
          return app.dashboard();
        case 'new':
          untitled++;
          app.open({ kind: 'blank', name: `Document${untitled}` });
          return;
        case 'open':
          return pickFile();
        case 'openSample':
          return app.openSample(action.id);
        case 'openSaved':
          return app.openSample(`local:${action.id}`);
        case 'openCloud':
          return app.openSample(`cloud:${action.id}`);
        case 'download':
          return app.download();
        case 'convert':
          return app.convert(action.to);
        case 'saveToCloud':
          return app.saveToCloud();
        case 'signIn':
          return app.signIn();
        case 'signOut':
          return app.signOut();
        case 'viewMode':
          return;
        case 'collaborate':
          return app.collaborate();
        case 'copy':
          await navigator.clipboard.writeText(app.selectedText());
          return;
        case 'cut': {
          const text = app.selectedText();
          if (!text) return;
          await navigator.clipboard.writeText(text);
          app.send({ kind: 'delete', direction: 'backward' });
          return;
        }
        case 'paste': {
          const text = await navigator.clipboard.readText();
          if (text) app.send({ kind: 'insertText', text });
          return;
        }
        case 'undo':
        case 'redo':
          return app.send({ kind: action.kind });
        case 'selectAll':
          return app.send({ kind: 'selectAll' });
        case 'zoom':
          return zoomTo(action.to);
        case 'zoomBy': {
          const { canvas, camera } = app;
          camera.zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, action.factor);
          app.viewChanged();
          return;
        }
        case 'toggleGrid':
          return app.toggleGrid();
        case 'toggleStats':
          return app.toggleStats();
        case 'insertText':
          return app.send({ kind: 'insertText', text: action.text });
        case 'insertBreak':
          if (action.break === 'line') app.send({ kind: 'insertLineBreak' });
          return;
        default:
          app.notify(`${action.kind} isn't available yet`);
      }
    },

    focusEditor: app.focusEditor,
    notify: app.notify,
    samples: app.samples,
    saved: app.saved,
    cloud: app.cloud,
    fonts: app.fonts,
  };
}
