// Connects the menu bar and toolbars (./ui) to this app: which actions exist today, and how each
// one reaches the camera, the layout worker or the editor. As the editor grows operations
// (formatting, undo, tables…), add them to SUPPORTED and to perform(); the UI enables them.

import type { WireCommand } from './layout/protocol.ts';
import { FORMAT_ACTIONS, TABLE_EDITS, type FormatAction } from './layout/formatting.ts';
import type { DocumentSource } from './layout/protocol.ts';
import { WDOC_EXTENSION } from './formats/wdoc.ts';
import { sourceFromFile } from './formats/source.ts';
import { toPng } from './formats/imageCodec.ts';
import { LARGE_TEXT_BYTES, looksLikeText } from './formats/textFiles.ts';
import { nearestPage, type Bounds } from './document/arrange.ts';
import type { GpuPage } from './view/gpuPage.ts';
import { CSS_PX_PER_POINT, type Camera } from './view/camera.ts';
import type { FindTab } from './ui/findDialog.ts';
import { acceptList, type ImageOp, type Action, type DocumentKind, type ActionKind, type ChromeHost, type FormMode, type Sample, type ViewMode, type ZoomTarget } from './ui/index.ts';
import { t } from './i18n/index.ts';

export interface AppHooks {
  /** Show (or hide) the dashboard of all documents. */
  dashboard(): void;
  canvas: HTMLCanvasElement;
  camera: Camera;
  pages(): readonly GpuPage[];
  bounds(): Bounds;
  open(source: DocumentSource): void;
  /** Cover the editor with the loading screen for `name` (else take it away). */
  loading(name: string | null): void;
  openSample(id: string): void;
  /** Send changes that haven't reached the account yet, now. */
  syncNow(): Promise<void>;
  /** Share the open cloud document with other people. */
  share(): void;
  /** Download a copy of the document as a file, in its own format. */
  download(): Promise<void>;
  /** Ask for a link to make of the selection (Insert ▸ Hyperlink). */
  showLinkDialog(): void;
  /** Ask for an equation, then insert it. */
  showMathDialog(): void;
  /** Ask for a table's size, then insert it. */
  showTableDialog(): void;
  /** Ask how many columns and rows to split the cell into, then do it. */
  showSplitDialog(): void;
  /** Paste what is on the clipboard (formatted, if the document can hold it). */
  paste(): Promise<void>;
  /** Show what is on the clipboard and paste it in the form the user picks. */
  showPasteSpecial(): void;
  /** Show the document's properties (title, author…) to look at or change. */
  showProperties(): void;
  /** Ask for the page size, margins and orientation, then set them. */
  showPageSetup(): void;
  /** Show the document's word, character, paragraph, line and page counts. */
  showWordCount(): void;
  /** Ask for columns of text, then set them. */
  showColumnsDialog(): void;
  showParagraphDialog(): void;
  /** Show the Spelling and Grammar dialog and look for the first problem. */
  showSpelling(): void;
  /** Show the Find, Replace or Go To dialog on that tab. */
  showFind(tab: FindTab): void;
  /** Print the document (as a PDF), or open that PDF in a new tab to preview it. */
  print(preview: boolean): Promise<void>;
  /** Make a copy of the document in another format next to the original, and open it. */
  convert(to: DocumentKind): Promise<void>;
  /** A picture tool (rotate, flip, crop, resize, adjust) on the open picture. */
  imageAction(op: ImageOp): Promise<void>;
  /** The Draw tools' colour and thickness step. */
  drawStyle(color?: string, size?: number, fill?: boolean): void;
  /** Insert ▸ Picture: choose a picture file and put it in the document. */
  pickPicture(): void;
  /** The open file is in the large-text viewer. */
  isLargeText(): boolean;
  /** Copy the lines selected in the large-text viewer. */
  largeCopy(): Promise<void>;
  /** Change the viewer's text size by a factor, or back to normal. */
  largeZoom(factor: number, reset?: boolean): void;
  /** Open a text file too big to be a document: in the viewer. */
  openLarge(name: string, bytes: Uint8Array): void;
  /** The open document is a picture (its own undo history, and no text editing). */
  isPicture(): boolean;
  stepPicture(direction: 'undo' | 'redo'): Promise<void>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** Pay for sync (signing in first if needed), or manage the subscription. */
  subscribe(): Promise<void>;
  manageSubscription(): Promise<void>;
  /** Show or hide Clip, the assistant. */
  toggleClip(): void;
  /** Delete every document and setting kept in this browser, once the user confirms. */
  clearLocalData(): Promise<void>;
  /** Download every saved document as one ZIP. */
  downloadAll(): Promise<void>;
  /** The user's documents (ids are sources: `local:…` or `cloud:…`). */
  saved(): Sample[];
  send(command: WireCommand): void;
  /** A PDF is shown as its own pages, which take markup annotations. */
  annotating(): boolean;
  /** Fill in a PDF's form, or edit the form itself. */
  setFormMode(mode: FormMode): void;
  /** Who new comments are from. */
  author(): string;
  /** Opens a new comment beside the selection, to be written in the comments panel. */
  startComment(): void;
  /** The selected text (for copy and cut). */
  selectedText(): string;
  focusEditor(): void;
  notify(message: string): void;
  toggleGrid(): void;
  /** Show or hide formatting marks (¶, spaces, tabs). */
  toggleFormattingMarks(): void;
  /** Print layout (pages) or Normal (the text reflowed to the window). */
  setViewMode(mode: ViewMode): void;
  /** The camera moved: stop auto-placing it, and redraw. */
  viewChanged(): void;
  fonts(): Promise<string[]>;
  samples(): Sample[];
}

/** Actions the app implements today, whatever the document. */
const SUPPORTED = new Set<ActionKind>([
  'new',
  'open',
  'import',
  'openSample',
  'openSaved',
  'syncNow',
  'share',
  'download',
  'downloadAll',
  'print',
  'printPreview',
  'signIn',
  'signOut',
  'subscribe',
  'manageSubscription',
  'toggleClip',
  'clearLocalData',
  'cut',
  'copy',
  'paste',
  'selectAll',
  'undo',
  'redo',
  'image',
  'drawStyle',
  'insertImage',
  'zoom',
  'zoomBy',
  'toggleGrid',
  'toggleFormattingMarks',
  'insertText',
  'convert',
  'insertComment',
  'insertLink',
  'insertMath',
]);


/** Actions that mark up a PDF shown as its own pages (see layout/pdfAnnotator.ts). */
const ANNOTATION_ACTIONS = new Set<ActionKind>(['setHighlight', 'toggleMark']);

/** The formats a document can be converted to. */
const CONVERTIBLE = new Set<DocumentKind>(['docx', 'odt', 'rtf', 'html', 'epub', 'mhtml', 'csv', 'tsv', 'tex', 'adoc', 'rst', 'org', 'mediawiki', 'textile', 'eml', 'ipynb', 'png', 'jpeg', 'webp', 'pdf', 'md', 'txt']);

export function createChromeHost(app: AppHooks): ChromeHost & { openFile(file: File): void } {
  let untitled = 0;

  const openFile = (file: File): void => {
    app.loading(file.name);
    if (!sourceFromFile(file.name, new ArrayBuffer(0))) {
      // An extension we don't know: text is text whatever it is called, binary files are not opened.
      void file.arrayBuffer().then((bytes) => {
        if (looksLikeText(new Uint8Array(bytes))) return bytes.byteLength >= LARGE_TEXT_BYTES ? app.openLarge(file.name, new Uint8Array(bytes)) : app.open({ kind: 'txt', name: file.name, bytes });
        const dot = file.name.lastIndexOf('.');
        app.loading(null);
        app.notify(t('app.unsupportedOpen', { kind: dot >= 0 ? file.name.slice(dot + 1).toUpperCase() : '?', name: file.name }));
      });
      return;
    }
    if (sourceFromFile(file.name, new ArrayBuffer(0))) {
      void file.arrayBuffer().then(async (bytes) => {
        const source = sourceFromFile(file.name, bytes)!;
        // Text too big to be a document opens in the viewer instead (a table of 500,000 rows is no better than 500,000 paragraphs).
        if ((source.kind === 'txt' || source.kind === 'csv' || source.kind === 'tsv') && bytes.byteLength >= LARGE_TEXT_BYTES) return app.openLarge(file.name, new Uint8Array(bytes));
        if (source.kind !== 'image') return app.open(source);
        // GIF, BMP and SVG open as PNG (a GIF as its first frame); PNG, JPEG and WebP as they are.
        try {
          const picture = await toPng(source.name, new Uint8Array(bytes));
          app.open({ kind: 'image', name: picture.name, bytes: picture.bytes.slice().buffer });
        } catch (e) {
          app.loading(null);
          app.notify(t('app.unsupportedOpen', { kind: file.name.slice(file.name.lastIndexOf('.') + 1).toUpperCase(), name: file.name }));
          console.error(e);
        }
      });
    } else {
      const dot = file.name.lastIndexOf('.');
      app.loading(null);
      app.notify(t('app.unsupportedOpen', { kind: dot >= 0 ? file.name.slice(dot + 1).toUpperCase() : '?', name: file.name }));
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
      // Table commands: only the ones the editor can do yet.
      if (action.kind === 'table') return TABLE_EDITS.has(action.op) && !app.annotating();
      if (FORMAT_ACTIONS.has(action.kind as FormatAction['kind'])) return !app.annotating();
      if (action.kind === 'setFormMode') return app.annotating();
      if (action.kind === 'dialog') return action.name === 'find' || action.name === 'replace' || action.name === 'goTo' || action.name === 'spelling' || action.name === 'columns' || action.name === 'paragraph' || action.name === 'wordCount' || action.name === 'pageSetup' || action.name === 'properties' || action.name === 'pasteSpecial';
      if (action.kind === 'convert') return CONVERTIBLE.has(action.to);
      if (action.kind === 'insertBreak') return action.break === 'line' || action.break === 'page' || action.break === 'column';
      if (action.kind === 'viewMode') return action.mode === 'print' || !(app.annotating() || app.isPicture());
      return SUPPORTED.has(action.kind);
    },

    async perform(action: Action): Promise<void> {
      switch (action.kind) {
        case 'setFormMode':
          return app.setFormMode(action.mode);
        case 'new':
          untitled++;
          app.open({ kind: 'blank', name: `Document${untitled}` });
          return;
        case 'open':
          return app.dashboard();
        case 'import':
          return pickFile();
        case 'openSample':
          return app.openSample(action.id);
        case 'openSaved':
          return app.openSample(action.id);
        case 'download':
          return app.download();
        case 'insertLink':
          return app.showLinkDialog();
        case 'insertMath':
          return app.showMathDialog();
        case 'dialog':
          if (action.name === 'spelling') return app.showSpelling();
          if (action.name === 'columns') return app.showColumnsDialog();
          if (action.name === 'paragraph') return app.showParagraphDialog();
          if (action.name === 'wordCount') return app.showWordCount();
          if (action.name === 'pageSetup') return app.showPageSetup();
          if (action.name === 'properties') return app.showProperties();
          if (action.name === 'pasteSpecial') return app.showPasteSpecial();
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
        case 'subscribe':
          return app.subscribe();
        case 'manageSubscription':
          return app.manageSubscription();
        case 'toggleClip':
          return app.toggleClip();
        case 'downloadAll':
          return app.downloadAll();
        case 'clearLocalData':
          return app.clearLocalData();
        case 'viewMode':
          return app.setViewMode(action.mode);
        case 'copy':
          if (app.isLargeText()) return app.largeCopy();
          await navigator.clipboard.writeText(app.selectedText());
          return;
        case 'cut': {
          const text = app.selectedText();
          if (!text) return;
          await navigator.clipboard.writeText(text);
          app.send({ kind: 'delete', direction: 'backward' });
          return;
        }
        case 'paste':
          return app.paste();
        case 'undo':
        case 'redo':
          return app.isPicture() ? app.stepPicture(action.kind) : app.send({ kind: action.kind });
        case 'image':
          return app.imageAction(action.op);
        case 'drawStyle':
          return app.drawStyle(action.color, action.size, action.fill);
        case 'insertImage':
          return app.pickPicture();
        case 'selectAll':
          return app.send({ kind: 'selectAll' });
        case 'zoom':
          if (app.isLargeText()) return app.largeZoom(1, true);
          return zoomTo(action.to);
        case 'zoomBy': {
          if (app.isLargeText()) return app.largeZoom(action.factor);
          const { canvas, camera } = app;
          camera.zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, action.factor);
          app.viewChanged();
          return;
        }
        case 'toggleFormattingMarks':
          return app.toggleFormattingMarks();
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
        case 'setParagraph':
        case 'toggleList':
        case 'indent':
          return app.send({ kind: 'format', action });
        case 'table':
          // Splitting cells needs to know into how many.
          return action.op === 'splitCells' && !(action.columns && action.rows) ? app.showSplitDialog() : app.send({ kind: 'format', action });
        case 'insertTable':
          // Without a size, ask for one.
          return action.rows && action.columns ? app.send({ kind: 'format', action }) : app.showTableDialog();
        case 'insertComment': {
          if (!app.annotating()) return app.startComment();
          const text = window.prompt(t('app.notePrompt'));
          if (text !== null) app.send({ kind: 'annotate', annotation: 'note', text });
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
