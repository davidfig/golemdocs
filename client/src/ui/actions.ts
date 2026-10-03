// What the menus and toolbars can ask the application to do.
//
// Actions are deliberately format-agnostic: "make the selection bold", "insert a page break",
// "save as Markdown". The host (the app) decides how each maps onto the open document, and the
// format profile (formats.ts) decides which ones make sense for that kind of document at all.
// Nothing here knows about .docx XML, the editor's model or the layout worker.

export type Mark = 'bold' | 'italic' | 'underline' | 'strikethrough' | 'superscript' | 'subscript' | 'code';
export type Alignment = 'left' | 'center' | 'right' | 'justify';
export type ListKind = 'bullet' | 'number' | 'task';
/** What Bullets and Numbering can start: also lists of check boxes (☐ not done, ☑ done), which Markdown task lists are. */
export type ListChoice = ListKind | 'taskDone';
export type CaseChange = 'sentence' | 'lower' | 'upper' | 'title' | 'toggle';
export type BreakKind = 'page' | 'column' | 'line' | 'sectionNextPage' | 'sectionContinuous';
/**
 * Print: pages as they print. Flow: the text reflowed to the window, without page edges (Word's Web Layout).
 * Grid: every page side by side, filling the window.
 */
export type ViewMode = 'print' | 'flow' | 'grid';
/** A PDF's form: filling in its fields, or arranging them (moving, adding, renaming, deleting). */
export type FormMode = 'fill' | 'edit';
/** A zoom factor (1 = 100%) or a fit mode. */
export type ZoomTarget = number | 'pageWidth' | 'wholePage' | 'allPages';

export type TableOp =
  | 'insertRowAbove'
  | 'insertRowBelow'
  | 'insertColumnLeft'
  | 'insertColumnRight'
  | 'deleteRows'
  | 'deleteColumns'
  | 'deleteTable'
  | 'mergeCells'
  | 'splitCells'
  | 'selectTable'
  | 'properties';

/** The tools of the Draw toolbar: each picks what the next stroke draws. */
export type DrawToolName = 'pen' | 'marker' | 'line' | 'arrow' | 'rectangle' | 'ellipse' | 'text' | 'bubble' | 'step' | 'pixelate' | 'eraser' | 'move';

/** The vector editor's tools and commands (the Drawing menu): the tools pick what a drag draws or does; the rest act on the selection. */
export type VectorOp = 'select' | 'rect' | 'ellipse' | 'line' | 'pen' | 'text' | 'delete' | 'duplicate' | 'group' | 'ungroup' | 'front' | 'forward' | 'backward' | 'back' | 'selectAll' | 'unite' | 'intersect' | 'subtract' | 'exclude' | 'makeClip' | 'releaseClip' | 'makeMask' | 'releaseMask' | 'canvasSize' | 'guideV' | 'guideH' | 'clearGuides' | 'layers' | 'snap';

/** What the picture tools do (the Picture menu): turns, flips, the three that ask for more, and the one-click effects. */
export type ImageOp = 'rotateLeft' | 'rotateRight' | 'rotate180' | 'flipHorizontal' | 'flipVertical' | 'crop' | 'resize' | 'adjust' | 'grayscale' | 'sepia' | 'invert' | 'blur' | 'sharpen' | 'autoLevels' | DrawToolName;

export type DialogName =
  | 'font'
  | 'paragraph'
  | 'bulletsAndNumbering'
  | 'bordersAndShading'
  | 'columns'
  | 'tabs'
  | 'styles'
  | 'pageSetup'
  | 'properties'
  | 'find'
  | 'replace'
  | 'goTo'
  | 'pasteSpecial'
  | 'spelling'
  | 'wordCount'
  | 'options'
  | 'pageNumbers'
  | 'dateTime';

export type Action =
  // File
  /** The screen of thumbnails of every document. */
  /** A blank document. `folderId` is where it is filed (null: the top level); left out, the folder of the open document. */
  | { kind: 'new'; folderId?: string | null }
  | { kind: 'open' }
  /** `folderId`: where the file goes (null: the top level); a ZIP's top level goes there. */
  | { kind: 'import'; folderId?: string | null }
  | { kind: 'openSample'; id: string }
  /** One of the user's documents (File ▸ Open Recent); `id` is its source, `local:…` or `cloud:…`. */
  | { kind: 'openSaved'; id: string }
  /** Send changes that haven't reached the account yet, now (after a failed upload). */
  | { kind: 'syncNow' }
  | { kind: 'share' }
  | { kind: 'signIn' }
  /** Show or hide Clip, the assistant. */
  | { kind: 'toggleClip' }
  | { kind: 'signOut' }
  /** Pay for sync: sign in first if needed, then go to Polar's checkout. */
  | { kind: 'subscribe' }
  /** Go to Polar's customer portal, to change the card, see invoices or cancel. */
  | { kind: 'manageSubscription' }
  /** Delete every document and setting kept in this browser (asks first). The account's documents stay. */
  | { kind: 'clearLocalData' }
  /** Download a copy of the document, in its own format. */
  | { kind: 'download' }
  /** Download every saved document as one ZIP. */
  | { kind: 'downloadAll' }
  /**
   * Make a copy of the document in another format (Word ⇄ PDF ⇄ Markdown ⇄ text), saved next to
   * the original, and open it. The original is kept as it is.
   */
  | { kind: 'convert'; to: DocumentKind }
  | { kind: 'print' }
  | { kind: 'printPreview' }
  // Edit
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'cut' }
  | { kind: 'copy' }
  | { kind: 'paste' }
  | { kind: 'selectAll' }
  | { kind: 'dialog'; name: DialogName }
  // View
  | { kind: 'viewMode'; mode: ViewMode }
  | { kind: 'zoom'; to: ZoomTarget }
  | { kind: 'zoomBy'; factor: number }
  | { kind: 'toggleGrid' }
  | { kind: 'togglePagesPanel' }
  | { kind: 'toggleFilesPanel' }
  | { kind: 'toggleRuler' }
  | { kind: 'toggleFooter' }
  | { kind: 'toggleFormattingMarks' }
  /** A PDF shown as its pages: fill in its form, or edit the form itself. */
  | { kind: 'setFormMode'; mode: FormMode }
  // Character formatting
  | { kind: 'toggleMark'; mark: Mark }
  | { kind: 'setFont'; family: string }
  | { kind: 'setFontSize'; points: number }
  | { kind: 'growFont' }
  | { kind: 'shrinkFont' }
  /** A CSS color (#rrggbb), or null for automatic. */
  | { kind: 'setColor'; color: string | null }
  /** A CSS color (#rrggbb), or null for none. */
  | { kind: 'setHighlight'; color: string | null }
  | { kind: 'changeCase'; to: CaseChange }
  | { kind: 'clearFormatting' }
  | { kind: 'formatPainter' }
  // Paragraph formatting
  | { kind: 'setStyle'; style: string }
  | { kind: 'setAlignment'; align: Alignment }
  | { kind: 'setLineSpacing'; lines: number }
  | ({ kind: 'setParagraph' } & ParagraphChoice)
  | { kind: 'toggleList'; list: ListChoice; force?: boolean }
  | { kind: 'indent'; direction: 'increase' | 'decrease' }
  // Insert
  | { kind: 'insertText'; text: string }
  | { kind: 'insertBreak'; break: BreakKind }
  /** Without a size, the host asks for one. */
  | { kind: 'insertTable'; rows?: number; columns?: number }
  | { kind: 'insertImage' }
  | { kind: 'insertLink' }
  /** Asks for an equation (in LaTeX) and inserts it at the caret. */
  | { kind: 'insertMath' }
  | { kind: 'insertComment' }
  | { kind: 'insertFootnote' }
  | { kind: 'insertBookmark' }
  | { kind: 'insertTextBox' }
  | { kind: 'insertCodeBlock' }
  | { kind: 'insertHorizontalRule' }
  // Table
  /** `columns` and `rows` say how to split cells; without them the host asks. */
  | { kind: 'table'; op: TableOp; columns?: number; rows?: number }
  // Picture
  | { kind: 'image'; op: ImageOp }
  /** The colour (CSS) and line thickness step (0 thin to 3 extra thick) the Draw tools use. */
  | { kind: 'drawStyle'; color?: string; size?: number; fill?: boolean }
  // Drawing (vector)
  | { kind: 'vector'; op: VectorOp }
  /** How the selected shapes (and the next ones) look; null is none. */
  | { kind: 'vectorStyle'; fill?: string | null; stroke?: string | null; strokeWidth?: number; strokeStyle?: string; fillType?: 'solid' | 'linear' | 'radial' }
  // Tools
  | { kind: 'toggleTrackChanges' };

export type ActionKind = Action['kind'];

/** Kinds of document the chrome knows how to present. */
export type DocumentKind = 'docx' | 'odt' | 'rtf' | 'pdf' | 'md' | 'html' | 'epub' | 'mhtml' | 'csv' | 'tsv' | 'tex' | 'adoc' | 'rst' | 'org' | 'mediawiki' | 'textile' | 'typst' | 'docbook' | 'jats' | 'fb2' | 'opml' | 'eml' | 'ipynb' | 'largetext' | 'png' | 'jpeg' | 'webp' | 'svg' | 'svgz' | 'txt';

/**
 * Formatting at the selection, for toolbar state. `undefined` means unknown or mixed (the
 * control shows blank / unpressed), which is also what a host that can't report it yet sends.
 */
/**
 * What the Paragraph dialog shows and sets (twips, except `line`, see below). In a state a field
 * is left out when the selected paragraphs differ; in a choice, when it is to stay as it is.
 */
export interface ParagraphChoice {
  align?: Alignment;
  left?: number;
  right?: number;
  special?: 'none' | 'firstLine' | 'hanging';
  /** Twips of the first-line or hanging indent. */
  by?: number;
  before?: number;
  after?: number;
  /** 240ths of a line for `auto`; twips for `exact` and `atLeast`. */
  line?: number;
  lineRule?: 'auto' | 'exact' | 'atLeast';
  keepNext?: boolean;
  keepLines?: boolean;
  pageBreakBefore?: boolean;
  widowControl?: boolean;
}

export interface FormatState {
  paragraph?: ParagraphChoice;
  marks?: Partial<Record<Mark, boolean>>;
  style?: string;
  font?: string;
  /** Points. */
  size?: number;
  align?: Alignment;
  list?: ListKind | null;
  color?: string | null;
  highlight?: string | null;
  /** Text colors (#RRGGBB) the document uses, most used first, for the color palette's "Document Colors" row. */
  documentColors?: string[];
}

/** Everything the chrome shows that comes from the application. */
export interface ChromeState {
  documentName: string;
  /** The other people editing this document together (not this user); empty when on one's own. Shown beside the name. */
  people: { name: string; picture: string | null; color: number }[];
  /** The name may be changed (not a built-in or shared document). */
  renamable: boolean;
  kind: DocumentKind;
  hasSelection: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** 1 = 100%. */
  zoom: number;
  viewMode: ViewMode;
  /** The pages panel is pulled out beside the document. */
  pagesPanel: boolean;
  /** The files sidebar is pulled out beside the document. */
  filesPanel: boolean;
  rulerVisible: boolean;
  /** The status bar is showing under the document. */
  footer: boolean;
  formattingMarks: boolean;
  trackChanges: boolean;
  format: FormatState;
  /** A PDF shown as its pages: whether its form is being filled in or edited; null otherwise. */
  formMode: FormMode | null;
  /** The selection is in a table: the Table menu's row, column and cell commands apply. */
  inTable: boolean;
  /** The Format Painter has picked up formatting and is waiting for a selection to paint. */
  painting: boolean;
  /** The Draw toolbar: the tool picked (if any), its colour and its thickness step. */
  draw: { tool: DrawToolName | null; color: string; size: number; fill: boolean };
  /** The vector editor: the tool picked, whether anything is selected, and the look of the selection (or of the next shape). */
  vector: { tool: 'select' | 'rect' | 'ellipse' | 'line' | 'pen' | 'text'; hasSelection: boolean; multiple: boolean; clipped: boolean; masked: boolean; layers: boolean; snap: boolean; fill: string | null; stroke: string | null; strokeWidth: number; fillType: 'solid' | 'linear' | 'radial'; strokeStyle: string };
  /** Whether the open document is saved, for the button at the top right. */
  sync: SyncStatus;
  /** The paid sync subscription: `active` (menus offer to manage it), `none` (they offer to subscribe), null while unknown. */
  subscription: SubscriptionState | null;
  /** Clip, the assistant, is showing. */
  clip: boolean;
}

export type SubscriptionState = 'none' | 'active';

/**
 * Whether the open document is saved. Signed out (`guest`), or signed in without a subscription
 * (`unsubscribed`), it is saved in this browser. Signed in with sync: `saved` to the account, `saving` (edits on their way), `offline` (kept here until the
 * account can be reached), `failed` (`error` says why), or `signedOut` (the session ended; the
 * edits wait here for the user to sign in again).
 */
export type DocumentSync = 'guest' | 'unsubscribed' | 'saved' | 'saving' | 'offline' | 'failed' | 'signedOut';

export interface SyncStatus {
  /** Who is signed in (an email or name); null when signed out. */
  user: string | null;
  /** The signed-in person's profile picture, if they have one. */
  picture?: string | null;
  document: DocumentSync;
  error: string | null;
  /** When the open document was last saved to the account (ms since the epoch), if known. */
  savedAt?: number | null;
  /** Signed out or without sync: whether the open document's latest changes are saved in this browser. */
  localSaved?: boolean;
}

export const DEFAULT_STATE: ChromeState = {
  documentName: '',
  people: [],
  renamable: false,
  kind: 'docx',
  hasSelection: false,
  canUndo: false,
  canRedo: false,
  zoom: 1,
  viewMode: 'print',
  pagesPanel: false,
  filesPanel: false,
  rulerVisible: false,
  footer: false,
  formattingMarks: false,
  trackChanges: false,
  format: {},
  formMode: null,
  painting: false,
  draw: { tool: null, color: '#e5322d', size: 1, fill: false },
  vector: { tool: 'select', hasSelection: false, multiple: false, clipped: false, masked: false, layers: false, snap: true, fill: null, stroke: null, strokeWidth: 1, fillType: 'solid', strokeStyle: 'dash:solid' },
  inTable: false,
  sync: { user: null, document: 'guest', error: null },
  subscription: null,
  clip: true,
};

/** A sample document the File menu can open. */
export interface Sample {
  id: string;
  label: string;
}

/** What the chrome needs from the application. */
export interface ChromeHost {
  /** Whether the app implements this action (for any document). Unimplemented actions are disabled. */
  supports(action: Action): boolean;
  perform(action: Action): void | Promise<void>;
  /** Puts keyboard focus back in the document. */
  focusEditor(): void;
  /** A short message for the user (errors, "not available yet"). */
  notify(message: string): void;
  /** Gives the document a new name (cleaned for a file name); returns the name kept, or null if it can't be renamed. */
  renameDocument(name: string): string | null;
  /** Samples for File ▸ Open Sample, read each time the menu opens. */
  samples?(): Sample[];
  /** The user's documents, for File ▸ Open Recent. */
  saved?(): Sample[];
  /** Font families for the font box. */
  fonts?(): string[] | Promise<string[]>;
}
