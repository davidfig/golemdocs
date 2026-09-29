// Connects the menu bar and toolbars (./ui) to this app: which actions exist today, and how each
// one reaches the camera, the layout worker or the editor. As the editor grows operations
// (formatting, undo, tables…), add them to SUPPORTED and to perform(); the UI enables them.

import type { WireCommand } from './layout/protocol.ts';
import { FORMAT_ACTIONS, type FormatAction } from './layout/formatting.ts';
import type { DocumentSource } from './layout/protocol.ts';
import { WDOC_EXTENSION } from './formats/wdoc.ts';
import { sourceFromFile } from './formats/source.ts';
import { nearestPage, type Bounds } from './document/arrange.ts';
import type { GpuPage } from './view/gpuPage.ts';
import { CSS_PX_PER_POINT, type Camera } from './view/camera.ts';
import type { FindTab } from './ui/findDialog.ts';
import { acceptList, kindFromName, type Action, type DocumentKind, type ActionKind, type ChromeHost, type FormMode, type Sample, type ZoomTarget } from './ui/index.ts';
import { t } from './i18n/index.ts';

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
  /** Send changes that haven't reached the account yet, now. */
  syncNow(): Promise<void>;
  /** Share the open cloud document with other people. */
  share(): void;
  /** Download a copy of the document as a file, in its own format. */
  download(): Promise<void>;
  /** Ask for a link to make of the selection (Insert ▸ Hyperlink). */
  showLinkDialog(): void;
  /** Show the Spelling and Grammar dialog and look for the first problem. */
  showSpelling(): void;
  /** Show the Find, Replace or Go To dialog on that tab. */
  showFind(tab: FindTab): void;
  /** Print the document (as a PDF), or open that PDF in a new tab to preview it. */
  print(preview: boolean): Promise<void>;
  /** Make a copy of the document in another format next to the original, and open it. */
  convert(to: DocumentKind): Promise<void>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** Delete every document and setting kept in this browser, once the user confirms. */
  clearLocalData(): Promise<void>;
  /** The user's documents (ids are sources: `local:…` or `cloud:…`). */
  saved(): Sample[];
  send(command: WireCommand): void;
  /** A PDF is shown as its own pages, which take markup annotations. */
  annotating(): boolean;
  /** Fill in a PDF's form, or edit the form itself. */
  setFormMode(mode: FormMode): void;
  /** Who new comments are from. */
  author(): string;
  /** The selected text (for copy and cut). */
  selectedText(): string;
  focusEditor(): void;
  notify(message: string): void;
  toggleGrid(): void;
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
  'syncNow',
  'share',
  'download',
  'print',
  'printPreview',
  'signIn',
  'signOut',
  'clearLocalData',
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
  'insertText',
  'convert',
  'insertComment',
  'insertLink',
]);


/** Actions that mark up a PDF shown as its own pages (see layout/pdfAnnotator.ts). */
const ANNOTATION_ACTIONS = new Set<ActionKind>(['setHighlight', 'toggleMark']);

/** The formats a document can be converted to. */
const CONVERTIBLE = new Set<DocumentKind>(['docx', 'odt', 'rtf', 'html', 'epub', 'mhtml', 'csv', 'tsv', 'tex', 'adoc', 'rst', 'org', 'pdf', 'md', 'txt']);

export function createChromeHost(app: AppHooks): ChromeHost & { openFile(file: File): void } {
  let untitled = 0;

  const openFile = (file: File): void => {
    if (sourceFromFile(file.name, new ArrayBuffer(0))) {
      void file.arrayBuffer().then((bytes) => app.open(sourceFromFile(file.name, bytes)!));
    } else {
      app.notify(t('app.unsupportedOpen', { kind: kindFromName(file.name, 'txt').toUpperCase(), name: file.name }));
    }
  };

  const pickFile = (): void => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: `${acceptList()},${WDOC_EXTENSION}` });
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
    return nearestPage(app.pages(), center.x, center.y);
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
      if (ANNOTATION_ACTIONS.has(action.kind) && app.annotating()) return true;
      if (FORMAT_ACTIONS.has(action.kind as FormatAction['kind'])) return !app.annotating();
      if (action.kind === 'setFormMode') return app.annotating();
      if (action.kind === 'dialog') return action.name === 'find' || action.name === 'replace' || action.name === 'goTo' || action.name === 'spelling';
      if (action.kind === 'convert') return CONVERTIBLE.has(action.to);
      if (action.kind === 'insertBreak') return action.break === 'line' || action.break === 'page' || action.break === 'column';
      if (action.kind === 'viewMode') return action.mode === 'print';
      return SUPPORTED.has(action.kind);
    },

    async perform(action: Action): Promise<void> {
      switch (action.kind) {
        case 'dashboard':
          return app.dashboard();
        case 'setFormMode':
          return app.setFormMode(action.mode);
        case 'new':
          untitled++;
          app.open({ kind: 'blank', name: `Document${untitled}` });
          return;
        case 'open':
          return pickFile();
        case 'openSample':
          return app.openSample(action.id);
        case 'openSaved':
          return app.openSample(action.id);
        case 'download':
          return app.download();
        case 'insertLink':
          return app.showLinkDialog();
        case 'dialog':
          if (action.name === 'spelling') return app.showSpelling();
          if (action.name === 'find' || action.name === 'replace' || action.name === 'goTo') return app.showFind(action.name);
          return app.notify(t('app.notAvailable', { name: action.name }));
        case 'print':
        case 'printPreview':
          return app.print(action.kind === 'printPreview');
        case 'convert':
          return app.convert(action.to);
        case 'syncNow':
          return app.syncNow();
        case 'share':
          return app.share();
        case 'signIn':
          return app.signIn();
        case 'signOut':
          return app.signOut();
        case 'clearLocalData':
          return app.clearLocalData();
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
        case 'insertText':
          return app.send({ kind: 'insertText', text: action.text });
        case 'insertBreak':
          if (action.break === 'line') app.send({ kind: 'insertLineBreak' });
          else if (action.break === 'page' || action.break === 'column') app.send({ kind: 'insertLineBreak', type: action.break });
          return;
        case 'setHighlight':
          if (!app.annotating()) return app.send({ kind: 'format', action });
          return app.send({ kind: 'annotate', annotation: 'highlight', color: action.color });
        case 'toggleMark':
          if (!app.annotating()) return app.send({ kind: 'format', action });
          if (action.mark === 'underline') return app.send({ kind: 'annotate', annotation: 'underline' });
          if (action.mark === 'strikethrough') return app.send({ kind: 'annotate', annotation: 'strikeout' });
          return app.notify(t('app.notAvailable', { name: action.mark }));
        case 'setFont':
        case 'setFontSize':
        case 'growFont':
        case 'shrinkFont':
        case 'setColor':
        case 'changeCase':
        case 'clearFormatting':
        case 'formatPainter':
        case 'setStyle':
        case 'setAlignment':
        case 'setLineSpacing':
        case 'toggleList':
        case 'indent':
          return app.send({ kind: 'format', action });
        case 'insertComment': {
          const text = window.prompt(app.annotating() ? t('app.notePrompt') : t('app.commentPrompt'));
          if (text === null) return;
          if (app.annotating()) app.send({ kind: 'annotate', annotation: 'note', text });
          else app.send({ kind: 'addComment', text, author: app.author() });
          return;
        }
        default:
          app.notify(t('app.notAvailable', { name: action.kind }));
      }
    },

    focusEditor: app.focusEditor,
    notify: app.notify,
    samples: app.samples,
    saved: app.saved,
    fonts: app.fonts,
  };
}
