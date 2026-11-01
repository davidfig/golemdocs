// The spreadsheet editor on the page (docs/spreadsheets.md, "The editor"): the workbook is in the sheet worker (worker.ts);
// this keeps the camera's sheet geometry, the selection, the cell being edited, the formula bar, the sheet tabs and the
// find bar, takes the keyboard and the mouse, and draws through SheetRenderer on the app's canvas and camera.

import { t } from '../i18n/index.ts';
import type { MessageKey } from '../i18n/index.ts';
import { h, iconButton, CLOSE_ICON } from '../ui/dom.ts';
import { attachTextInput } from '../ui/textInput.ts';
import { showPopupMenu } from '../ui/popupMenu.ts';
import type { PopupItem } from '../ui/popupMenu.ts';
import { onContextMenu } from '../ui/contextMenu.ts';
import { IS_MAC } from '../ui/shortcuts.ts';
import type { Action, FormatState, SheetOp } from '../ui/actions.ts';
import { CSS_PX_PER_POINT } from '../view/camera.ts';
import type { Camera } from '../view/camera.ts';
import type { AtlasLibrary } from '../webgl/text/gpuFace.ts';
import { MAX_COLUMNS, MAX_ROWS, columnName } from './model/column.ts';
import type { CellRange } from './model/worksheet.ts';
import { PAD as CELL_PAD } from './cellText.ts';
import { CellFonts } from './fonts.ts';
import type { BorderChange, StyleChange } from './format/styleChange.ts';
import type { PasteWhat } from './pasteCells.ts';
import { HEADER_HEIGHT, SheetGeometry } from './geometry.ts';
import type { Hit } from './geometry.ts';
import { FILL_HANDLE, SheetRenderer, choicesButton, filterButton } from './renderer.ts';
import { FilterCard } from './filterCard.ts';
import { NoteCard, NoteEditor } from './noteCard.ts';
import { askSheetPassword } from './protectDialog.ts';
import { parseRange, rangeName } from './refs.ts';
import { parseTabbed } from './clipboard.ts';
import type { BookInfo, CellContent, Changed, EditOp, FromWorker, SheetInfo, TileKey, ToWorker } from './protocol.ts';
import './view.css';

export interface SheetEditorDeps {
  camera: Camera;
  gl: WebGL2RenderingContext;
  atlases: AtlasLibrary;
  fontBase: string;
  locale(): string;
  render(): void;
  /** The app's own view keys (zoom, fit); true if it took the key. */
  viewKey(e: KeyboardEvent): boolean;
  /** A message for the status line and a toast. */
  notify(message: string): void;
  /** The app's commands for a key it would run (Ctrl+S, Ctrl+F...); true if it ran one. */
  appKey(e: KeyboardEvent): boolean;
  /** The name a new note is signed with (the person signed in, or the guest's name). */
  author(): string;
}

/** Bars over the canvas, in CSS pixels: the formula bar at the top, the sheet tabs at the bottom. */
const FORMULA_BAR = 30;
const TABS_BAR = 30;

const single = (row: number, col: number): CellRange => ({ r0: row, c0: col, r1: row, c1: col });
const norm = (a: { row: number; col: number }, b: { row: number; col: number }): CellRange => ({ r0: Math.min(a.row, b.row), c0: Math.min(a.col, b.col), r1: Math.max(a.row, b.row), c1: Math.max(a.col, b.col) });

/** The Sheet menu's number formats, as Excel's en-US codes. */
const NUMBER_FORMATS = {
  numberGeneral: 'General',
  numberNumber: '0.00',
  numberCurrency: '"$"#,##0.00',
  numberAccounting: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)',
  numberPercent: '0.00%',
  numberScientific: '0.00E+00',
  numberFraction: '# ?/?',
  numberDate: 'm/d/yyyy',
  numberLongDate: 'dddd, mmmm d, yyyy',
  numberTime: 'h:mm:ss AM/PM',
  numberText: '@',
} as const;

/** The Sheet menu's borders. */
const BORDER_OPS = {
  borderAll: 'all',
  borderOutside: 'outside',
  borderThickOutside: 'thickOutside',
  borderTop: 'top',
  borderBottom: 'bottom',
  borderLeft: 'left',
  borderRight: 'right',
  borderDoubleBottom: 'doubleBottom',
  borderNone: 'none',
} as const satisfies Record<string, BorderChange>;

export class SheetEditorView {
  readonly el = h('div', { class: 'wm-sheet', attrs: { hidden: '' } });
  private readonly formulaBar = h('div', { class: 'wm-sheet-formula' });
  private readonly nameBox = h('input', { class: 'wm-input wm-sheet-name', attrs: { type: 'text', 'aria-label': t('sheet.nameBox'), spellcheck: 'false', autocomplete: 'off' } });
  private readonly formulaInput = h('textarea', { class: 'wm-input wm-sheet-fx', attrs: { 'aria-label': t('sheet.formulaBar'), spellcheck: 'false', rows: '1', wrap: 'off' } });
  private readonly findBar = h('div', { class: 'wm-sheet-find', attrs: { hidden: '' } });
  private readonly replaceRow = h('div', { class: 'wm-sheet-replace', attrs: { hidden: '' } });
  private readonly replaceInput = h('input', { class: 'wm-input', attrs: { type: 'text', placeholder: t('textEditor.replacePlaceholder'), 'aria-label': t('textEditor.replacePlaceholder'), 'data-sheet-input': '' } });
  private readonly findInput = h('input', { class: 'wm-input', attrs: { type: 'text', placeholder: t('sheet.findPlaceholder'), 'aria-label': t('sheet.findPlaceholder'), spellcheck: 'false' } });
  private readonly findMessage = h('span', { class: 'wm-find-message', attrs: { 'aria-live': 'polite' } });
  private readonly findOptions: Record<'matchCase' | 'wholeCell' | 'formulas' | 'allSheets', HTMLInputElement>;
  private readonly tabs = h('div', { class: 'wm-sheet-tabs', attrs: { role: 'tablist', 'aria-label': t('sheet.tabs') } });
  private readonly tabList = h('div', { class: 'wm-sheet-tablist' });
  private readonly status = h('span', { class: 'wm-sheet-status', attrs: { 'aria-live': 'polite' } });
  private readonly cellEditor = h('textarea', { class: 'wm-sheet-editor', attrs: { 'aria-label': t('sheet.cellEditor'), spellcheck: 'false', autocomplete: 'off', hidden: '' } });
  /** Takes the keyboard while no cell is being edited (typing starts editing the active cell). */
  private readonly input = h('textarea', { class: 'wm-sheet-input', attrs: { 'aria-label': t('sheet.editor'), autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', rows: '1', 'data-sheet-input': '' } });

  private readonly renderer: SheetRenderer;
  private worker: Worker | null = null;
  private nextId = 1;
  private replies = new Map<number, (m: FromWorker) => void>();
  private book: BookInfo | null = null;
  private geometry: SheetGeometry | null = null;
  private sheetIndex = 0;
  private name = '';
  /** The active cell, the cell the selection is anchored at, and the selected ranges (the last is being extended). */
  private active = { row: 0, col: 0 };
  private anchor = { row: 0, col: 0 };
  private ranges: CellRange[] = [single(0, 0)];
  /** The cell's contents, for the formula bar (and editing). */
  private content: CellContent = { input: '', display: '', isFormula: false };
  /** The cell `content` is of (sheet:row:col): it comes a moment after the active cell changes. */
  private contentOf = '';
  /** The cell being edited, how editing began (typing over it, or F2 / a double click to change it), and its text. */
  private editing: { row: number; col: number; mode: 'enter' | 'edit' } | null = null;
  private copied: CellRange | null = null;
  /** The sheet the copied range is on, and the text it put on the clipboard (to know a paste is of it). */
  private copiedFrom: { sheet: number; text: string } | null = null;
  private dragState: { kind: 'select' | 'columns' | 'rows' | 'resizeColumn' | 'resizeRow' | 'fill'; index?: number; start?: number; size?: number } | null = null;
  /** While the fill handle is dragged: the range it would fill. */
  private filling: CellRange | null = null;
  private filterCard: FilterCard | null = null;
  private noteCard: NoteCard | null = null;
  private noteEditor: NoteEditor | null = null;
  private noteHover = '';
  private noteTimer = 0;
  private resizeTo: number | null = null;
  private progress: string | null = null;
  /** The open workbook was mapped from its memory image rather than read from its file. */
  private fromImage = false;
  readOnly = false;
  onEdit: (() => void) | null = null;
  onState: (() => void) | null = null;
  /** The memory image of the file just read, to keep next to it. */
  onImage: ((bytes: Uint8Array, sha256: string) => void) | null = null;
  onSave: (() => void) | null = null;

  constructor(
    parent: HTMLElement,
    private readonly deps: SheetEditorDeps,
    fonts: CellFonts,
  ) {
    this.renderer = new SheetRenderer(deps.gl, fonts);
    this.renderer.want = (sheet, keys) => this.requestTiles(sheet, keys);
    const fx = h('span', { class: 'wm-sheet-fxlabel', text: 'fx', attrs: { 'aria-hidden': 'true' } });
    this.formulaBar.append(this.nameBox, fx, this.formulaInput);
    const add = iconButton('wm-sheet-icon', 'M6 2V10M2 6H10', t('sheet.op.addSheet'));
    add.addEventListener('click', () => this.sheetOp('addSheet'));
    this.tabs.append(add, this.tabList, this.status);
    this.findOptions = {
      matchCase: this.findCheck(t('dialogs.find.matchCase')),
      wholeCell: this.findCheck(t('sheet.wholeCell')),
      formulas: this.findCheck(t('sheet.lookInFormulas')),
      allSheets: this.findCheck(t('sheet.allSheets')),
    };
    const previous = h('button', { class: 'wm-button', text: t('textEditor.previous'), attrs: { type: 'button' } });
    const next = h('button', { class: 'wm-button', text: t('textEditor.next'), attrs: { type: 'button' } });
    const close = iconButton('wm-sheet-icon', CLOSE_ICON, t('textEditor.close'));
    const replace = h('button', { class: 'wm-button', text: t('textEditor.replace'), attrs: { type: 'button' } });
    const replaceAll = h('button', { class: 'wm-button', text: t('textEditor.replaceAll'), attrs: { type: 'button' } });
    this.replaceRow.append(this.replaceInput, replace, replaceAll);
    this.findBar.append(this.findInput, ...Object.values(this.findOptions).map((c) => c.parentElement!), previous, next, this.findMessage, close, this.replaceRow);
    replace.addEventListener('click', () => void this.replaceOne());
    replaceAll.addEventListener('click', () => void this.replaceAll());
    this.replaceInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') void this.replaceOne();
      else if (e.key === 'Escape') this.closeFind();
      else return;
      e.preventDefault();
    });
    previous.addEventListener('click', () => void this.findStep(true));
    next.addEventListener('click', () => void this.findStep(false));
    close.addEventListener('click', () => this.closeFind());
    this.findInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') void this.findStep(e.shiftKey);
      else if (e.key === 'Escape') this.closeFind();
      else return;
      e.preventDefault();
    });
    this.el.append(this.formulaBar, this.findBar, h('div', { class: 'wm-sheet-fill' }), this.tabs, this.cellEditor, this.input);
    parent.append(this.el);
    this.listen();
  }

  private findCheck(label: string): HTMLInputElement {
    const box = h('input', { attrs: { type: 'checkbox' } });
    h('label', { class: 'wm-sheet-check' }, box, h('span', { text: label }));
    return box;
  }

  // --- The worker ---

  private send(message: ToWorker, transfer: Transferable[] = []): void {
    this.worker?.postMessage(message, transfer);
  }

  private ask<T extends FromWorker>(message: ToWorker & { id: number }): Promise<T> {
    return new Promise((resolve, reject) => {
      this.replies.set(message.id, (m) => (m.t === 'error' ? reject(new Error(m.message)) : resolve(m as T)));
      this.send(message);
    });
  }

  private id(): number {
    return this.nextId++;
  }

  private receive(m: FromWorker): void {
    switch (m.t) {
      case 'opened':
        this.book = m.info;
        this.fromImage = m.fromImage;
        this.sheetIndex = m.info.activeSheet;
        this.useSheet(true);
        this.progress = m.fromImage ? null : t('sheet.opening');
        this.showStatus();
        this.showTabs();
        this.onState?.();
        break;
      case 'progress':
        this.progress = t('sheet.reading', { rows: m.rows.toLocaleString() });
        this.showStatus();
        if (m.sheet === this.sheetIndex && this.book) {
          this.book.sheets[m.sheet].rows = m.rows;
          this.renderer.invalidate(m.sheet);
          this.deps.render();
        }
        break;
      case 'loaded':
        this.book = m.info;
        this.progress = null;
        this.showStatus();
        this.useSheet(false);
        this.renderer.invalidate(this.sheetIndex);
        this.showTabs();
        this.deps.render();
        break;
      case 'image':
        this.onImage?.(new Uint8Array(m.bytes), m.sha256);
        break;
      case 'failed':
        this.deps.notify(t('app.openFailed', { message: m.message }));
        break;
      case 'tiles':
        for (const tile of m.cells) this.renderer.putCells(tile);
        for (const tile of m.overview) this.renderer.putOverview(tile);
        this.deps.render();
        break;
      default:
        if ('id' in m) {
          const reply = this.replies.get(m.id);
          this.replies.delete(m.id);
          reply?.(m);
        }
    }
  }

  private requestTiles(sheet: number, keys: TileKey[]): void {
    this.send({ t: 'tiles', id: this.id(), sheet, keys });
  }

  // --- Opening and closing ---

  /** Opens a workbook: the file's bytes, and its memory image if one was kept. */
  open(name: string, bytes: Uint8Array, image: Uint8Array | null): void {
    this.close();
    this.name = name;
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.receive(e.data);
    this.worker.onerror = (e) => this.deps.notify(t('app.openFailed', { message: e.message }));
    const buffer = bytes.slice().buffer;
    const imageBuffer = image ? image.slice().buffer : null;
    this.send({ t: 'open', name, bytes: buffer, image: imageBuffer }, imageBuffer ? [buffer, imageBuffer] : [buffer]);
    this.el.hidden = false;
    this.progress = t('sheet.opening');
    this.showStatus();
    this.focus();
  }

  close(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const reply of this.replies.values()) reply({ t: 'error', id: 0, message: 'closed' });
    this.replies.clear();
    this.renderer.reset();
    this.book = null;
    this.geometry = null;
    this.editing = null;
    this.copied = null;
    this.cellEditor.hidden = true;
    this.el.hidden = true;
    this.closeFind();
  }

  get fileName(): string {
    return this.name;
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  private get info(): SheetInfo | null {
    return this.book?.sheets[this.sheetIndex] ?? null;
  }

  /** Takes the active sheet's geometry (after opening, an edit that moved rows or columns, a switch of sheet). */
  private useSheet(first: boolean): void {
    const info = this.info;
    if (!info) return;
    this.geometry = new SheetGeometry(info);
    if (first) {
      this.active = { ...info.active };
      this.anchor = { ...info.active };
      this.ranges = [single(info.active.row, info.active.col)];
      const { camera } = this.deps;
      camera.x = 0;
      camera.y = 0;
      camera.zoom = Math.max(0.1, Math.min(4, (info.zoom || 100) / 100));
      this.reveal();
    }
    void this.loadContent();
    this.deps.render();
  }

  // --- Saving ---

  /** The workbook as .xlsx, and its new memory image. */
  async save(): Promise<{ xlsx: Uint8Array; image: Uint8Array; sha256: string }> {
    // A cell being typed into is left alone: what is saved is what was entered (an autosave must never end someone's typing).
    const reply = await this.ask<Extract<FromWorker, { t: 'saved' }>>({ t: 'save', id: this.id() });
    return { xlsx: new Uint8Array(reply.xlsx), image: new Uint8Array(reply.image), sha256: reply.sha256 };
  }

  // --- Drawing ---

  /** What the cells fill, in points, for the camera to be kept within (the data and some room past it, and wherever the selection is). */
  bounds(): { x: number; y: number; width: number; height: number } {
    const g = this.geometry;
    const info = this.info;
    if (!g || !info) return { x: 0, y: 0, width: 0, height: 0 };
    const rows = Math.min(MAX_ROWS, Math.max(info.rows, this.active.row + 1) + 100);
    const cols = Math.min(MAX_COLUMNS, Math.max(info.cols, this.active.col + 1) + 26);
    // Less the frozen part (the camera scrolls the rest) and the header and bars, which cover the canvas's edges.
    const scale = this.deps.camera.zoom * CSS_PX_PER_POINT;
    const extraX = (this.renderer.headerWidth || 40) / scale;
    const extraY = ((this.geometry?.headerHeight ?? HEADER_HEIGHT) + FORMULA_BAR + TABS_BAR) / scale;
    return { x: 0, y: 0, width: g.x(cols) - g.frozenWidth + extraX, height: g.y(rows) - g.frozenHeight + extraY };
  }

  draw(darkPages: boolean): void {
    const g = this.geometry;
    const info = this.info;
    if (!g || !info) return;
    const { camera } = this.deps;
    // The canvas less the bars over its top and bottom: the renderer draws between them.
    const top = FORMULA_BAR + (this.findBar.hidden ? 0 : this.findBar.offsetHeight);
    this.offsetTop = top;
    const pending = this.renderer.draw({
      camera,
      top,
      bottom: TABS_BAR,
      sheet: this.sheetIndex,
      geometry: g,
      gridlines: info.gridlines,
      extent: { rows: info.rows, cols: info.cols },
      selection: this.ranges,
      filling: this.filling,
      filter: this.info?.filter ?? null,
      choices: this.content.list && !this.editing ? { ...this.active } : null,
      active: this.active,
      editing: this.editing,
      copied: this.copied,
      darkPages,
    });
    if (pending) requestAnimationFrame(() => this.deps.render());
    this.placeEditor();
  }

  /** Where the cells' area starts below the canvas's top (the formula bar, and the find bar when it shows). */
  private offsetTop = FORMULA_BAR;

  // --- The selection ---

  private select(row: number, col: number, extend = false, keepRanges = false): void {
    row = Math.max(0, Math.min(MAX_ROWS - 1, row));
    col = Math.max(0, Math.min(MAX_COLUMNS - 1, col));
    if (extend) {
      const range = this.geometry ? this.geometry.expand(norm(this.anchor, { row, col })) : norm(this.anchor, { row, col });
      this.ranges = keepRanges ? [...this.ranges.slice(0, -1), range] : [range];
      this.focusCell = { row, col };
    } else {
      this.active = { row, col };
      this.anchor = { row, col };
      this.focusCell = { row, col };
      const merged = this.geometry?.mergeAt(row, col);
      const range = merged ? { ...merged } : single(row, col);
      this.ranges = keepRanges ? [...this.ranges, range] : [range];
    }
    this.reveal(extend ? this.focusCell : this.active);
    void this.loadContent();
    this.onState?.();
    this.deps.render();
  }

  /** The cell a Shift+arrow moves (the far corner of the range being extended). */
  private focusCell = { row: 0, col: 0 };

  private get selection(): CellRange {
    return this.ranges[this.ranges.length - 1];
  }

  get hasSelection(): boolean {
    return !!this.book;
  }

  /** Scrolls so a cell is in view (with the frozen panes accounted for). */
  private reveal(cell = this.active): void {
    const g = this.geometry;
    if (!g) return;
    const { camera } = this.deps;
    const scale = camera.zoom * CSS_PX_PER_POINT;
    const viewWidth = camera.width / camera.dpr - (this.renderer.headerWidth || 40) - g.frozenWidth * scale;
    const viewHeight = camera.height / camera.dpr - g.headerHeight - this.offsetTop - TABS_BAR - g.frozenHeight * scale;
    if (cell.col >= g.frozenCols) {
      const x0 = g.x(cell.col) - g.frozenWidth;
      const x1 = g.x(cell.col + 1) - g.frozenWidth;
      if (x0 < camera.x) camera.x = x0;
      else if (x1 > camera.x + viewWidth / scale) camera.x = Math.max(0, x1 - viewWidth / scale);
    }
    if (cell.row >= g.frozenRows) {
      const y0 = g.y(cell.row) - g.frozenHeight;
      const y1 = g.y(cell.row + 1) - g.frozenHeight;
      if (y0 < camera.y) camera.y = y0;
      else if (y1 > camera.y + viewHeight / scale) camera.y = Math.max(0, y1 - viewHeight / scale);
    }
  }

  private async loadContent(): Promise<void> {
    if (!this.worker || !this.book) return;
    const at = { ...this.active };
    const reply = await this.ask<Extract<FromWorker, { t: 'cell' }>>({ t: 'cell', id: this.id(), sheet: this.sheetIndex, row: at.row, col: at.col }).catch(() => null);
    if (!reply || at.row !== this.active.row || at.col !== this.active.col) return;
    this.content = reply.content;
    this.contentOf = `${this.sheetIndex}:${at.row}:${at.col}`;
    if (!this.editing) this.formulaInput.value = reply.content.input;
    // A locked cell of a protected sheet can't be typed into from the formula bar either.
    this.formulaInput.readOnly = !!reply.content.locked;
    const sel = this.selection;
    this.nameBox.value = sel.r0 === sel.r1 && sel.c0 === sel.c1 ? `${columnName(at.col)}${at.row + 1}` : rangeName(sel);
  }

  // --- Editing ---

  private startEdit(mode: 'enter' | 'edit', text: string | null): void {
    if (this.readOnly || !this.book) return;
    // A locked cell of a protected sheet is not typed into (the worker refuses the edit too, if the content was late).
    if (this.content.locked && this.contentOf === `${this.sheetIndex}:${this.active.row}:${this.active.col}`) return this.deps.notify(t('sheet.sheetProtected'));
    this.editing = { ...this.active, mode };
    const value = text ?? this.content.input;
    this.cellEditor.value = value;
    this.formulaInput.value = value;
    this.cellEditor.hidden = false;
    this.placeEditor();
    this.cellEditor.focus({ preventScroll: true });
    this.cellEditor.setSelectionRange(value.length, value.length);
    this.renderer.rebuild(this.sheetIndex, single(this.active.row, this.active.col));
    this.deps.render();
  }

  /** Puts the cell editor over the cell being edited (growing right as the text grows, as Excel's does). */
  private placeEditor(): void {
    const e = this.editing;
    const g = this.geometry;
    if (!e || !g) return;
    const { camera } = this.deps;
    const scale = camera.zoom * CSS_PX_PER_POINT;
    const region = this.renderer.regions.find((r) => (e.col < g.frozenCols) === !r.scrollX && (e.row < g.frozenRows) === !r.scrollY) ?? this.renderer.regions[this.renderer.regions.length - 1];
    if (!region) return;
    const box = g.mergeAt(e.row, e.col) ?? single(e.row, e.col);
    const x = region.x + (g.x(box.c0) - region.originX) * scale;
    const y = this.offsetTop + region.y + (g.y(box.r0) - region.originY) * scale;
    const width = (g.x(box.c1 + 1) - g.x(box.c0)) * scale;
    const height = (g.y(box.r1 + 1) - g.y(box.r0)) * scale;
    const style = this.cellEditor.style;
    style.left = `${x}px`;
    style.top = `${y}px`;
    style.minWidth = `${width}px`;
    style.minHeight = `${height}px`;
    style.fontSize = `${11 * scale}px`;
    style.width = `${Math.max(width, Math.min(600, (this.cellEditor.value.length + 1) * 7 * scale * 0.8))}px`;
  }

  /** Ends editing, keeping what was typed (`commit`) or not; then moves as Enter or Tab would. */
  private commitEdit(commit = true, move?: { dRow: number; dCol: number }, fillSelection = false): void {
    const e = this.editing;
    if (!e) return;
    this.editing = null;
    const text = this.cellEditor.value;
    this.cellEditor.hidden = true;
    this.renderer.rebuild(this.sheetIndex, single(e.row, e.col));
    if (commit && text !== this.content.input) {
      const range = fillSelection ? this.selection : single(e.row, e.col);
      void this.edit({ kind: 'input', range, text });
    } else if (!commit) {
      this.formulaInput.value = this.content.input;
    }
    if (move) this.move(move.dRow, move.dCol, false);
    this.focus();
    this.deps.render();
  }

  /** Edits sent and not answered yet: they can be undone already (the worker answers in order). */
  private inFlight = 0;

  /** Asks the worker for an edit, then draws what it changed. */
  private async edit(op: EditOp): Promise<Changed | null> {
    if (this.readOnly || !this.worker) return null;
    this.inFlight++;
    if (op.kind !== 'activeSheet') this.onState?.();
    try {
      const reply = await this.ask<Extract<FromWorker, { t: 'changed' }>>({ t: 'edit', id: this.id(), sheet: this.sheetIndex, op });
      this.applyChanged(reply.changed);
      // An edit that changed no cells (frozen panes, protection) still changed the workbook: it is saved.
      if (!reply.changed.ranges.length && !reply.changed.message && op.kind !== 'activeSheet') this.onEdit?.();
      return reply.changed;
    } catch (err) {
      this.deps.notify((err as Error).message);
      return null;
    } finally {
      this.inFlight--;
    }
  }

  private applyChanged(changed: Changed): void {
    if (changed.message) this.deps.notify(messageFor(changed.message));
    if (changed.info) {
      this.book = changed.info;
      this.sheetIndex = Math.min(this.sheetIndex, changed.info.sheets.length - 1);
      this.geometry = this.info ? new SheetGeometry(this.info) : null;
      this.showTabs();
    }
    if (changed.ranges.length) {
      this.renderer.invalidate(this.sheetIndex, changed.ranges);
      this.onEdit?.();
    }
    for (const sheet of changed.elsewhere ?? []) this.renderer.invalidate(sheet);
    if (changed.select) {
      const s = changed.select;
      this.ranges = [s];
      // The active cell stays where it is when the new selection holds it (a sorted block), else goes to its corner.
      const inside = this.active.row >= s.r0 && this.active.row <= s.r1 && this.active.col >= s.c0 && this.active.col <= s.c1;
      if (!inside) this.active = { row: s.r0, col: s.c0 };
      this.anchor = { row: s.r0, col: s.c0 };
    }
    void this.loadContent();
    this.onState?.();
    this.deps.render();
  }

  get canUndo(): boolean {
    return (this.book?.canUndo ?? false) || this.inFlight > 0;
  }

  get canRedo(): boolean {
    return this.book?.canRedo ?? false;
  }

  async undo(): Promise<void> {
    if (this.editing) return this.commitEdit(false);
    const reply = await this.ask<Extract<FromWorker, { t: 'changed' }>>({ t: 'undo', id: this.id() }).catch(() => null);
    if (reply) this.afterHistory(reply.changed);
  }

  async redo(): Promise<void> {
    const reply = await this.ask<Extract<FromWorker, { t: 'changed' }>>({ t: 'redo', id: this.id() }).catch(() => null);
    if (reply) this.afterHistory(reply.changed);
  }

  private afterHistory(changed: Changed): void {
    if (changed.info) {
      this.book = changed.info;
      this.sheetIndex = Math.min(this.sheetIndex, this.book.sheets.length - 1);
      this.geometry = this.info ? new SheetGeometry(this.info) : null;
      this.showTabs();
    }
    this.renderer.invalidate(this.sheetIndex);
    for (const sheet of changed.elsewhere ?? []) this.renderer.invalidate(sheet);
    if (changed.select) {
      this.ranges = [changed.select];
      this.active = { row: changed.select.r0, col: changed.select.c0 };
      this.anchor = { ...this.active };
      this.reveal();
    }
    this.onEdit?.();
    void this.loadContent();
    this.onState?.();
    this.deps.render();
  }

  // --- Keys ---

  private listen(): void {
    const input = this.input;
    input.addEventListener('keydown', (e) => this.key(e));
    attachTextInput(input, {
      insert: (text) => this.typed(text),
      key: () => {},
      copy: () => null,
      cut: () => {},
      paste: (clip) => void this.pasteClip(clip.text ?? '', clip.html ?? ''),
    });
    for (const name of ['copy', 'cut'] as const) {
      input.addEventListener(name, (e) => {
        e.preventDefault();
        void this.copy(name === 'cut');
      });
    }
    this.cellEditor.addEventListener('keydown', (e) => this.editorKey(e));
    this.cellEditor.addEventListener('input', () => {
      this.formulaInput.value = this.cellEditor.value;
      this.placeEditor();
    });
    this.formulaInput.addEventListener('focus', () => {
      if (!this.editing) {
        this.editing = { ...this.active, mode: 'edit' };
        this.cellEditor.value = this.formulaInput.value;
      }
    });
    this.formulaInput.addEventListener('input', () => {
      this.cellEditor.value = this.formulaInput.value;
    });
    this.formulaInput.addEventListener('keydown', (e) => this.editorKey(e));
    this.nameBox.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        this.goTo(this.nameBox.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.focus();
      }
    });
    onContextMenu(this.tabList, (e) => {
      const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-sheet]');
      if (!tab) return false;
      this.switchSheet(Number(tab.dataset.sheet));
      this.menu(e.clientX, e.clientY, this.tabItems());
    });
  }

  /** Text typed while a cell is selected: it replaces the cell's contents, and editing begins. */
  private typed(text: string): void {
    if (this.editing || this.readOnly) return;
    this.startEdit('enter', text);
  }

  private key(e: KeyboardEvent): void {
    if (this.deps.viewKey(e)) return;
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    const g = this.geometry;
    if (!g) return;
    const handled = (() => {
      const extend = e.shiftKey;
      const target = extend ? this.focusCell : this.active;
      switch (e.key) {
        case 'ArrowUp':
        case 'ArrowDown':
        case 'ArrowLeft':
        case 'ArrowRight': {
          // Alt+Down opens a list validation's choices, as in Excel.
          if (e.key === 'ArrowDown' && e.altKey && this.content.list) {
            void this.showChoices();
            return true;
          }
          const dRow = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
          const dCol = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
          if (mod) void this.jump(target, dRow, dCol, extend);
          else this.select(dRow ? g.step(g.rows, target.row, dRow) : target.row, dCol ? g.step(g.cols, target.col, dCol) : target.col, extend);
          return true;
        }
        case 'PageUp':
        case 'PageDown': {
          const page = Math.max(1, Math.floor((this.deps.camera.height / this.deps.camera.dpr - 80) / (g.rows.default * this.deps.camera.zoom * CSS_PX_PER_POINT)));
          const sign = e.key === 'PageUp' ? -1 : 1;
          if (e.altKey) this.select(target.row, Math.max(0, target.col + sign * 10), extend);
          else {
            this.deps.camera.y = Math.max(0, this.deps.camera.y + sign * page * g.rows.default);
            this.select(Math.max(0, target.row + sign * page), target.col, extend);
          }
          return true;
        }
        case 'Home':
          if (mod) this.select(g.frozenRows, g.frozenCols, extend);
          else this.select(target.row, 0, extend);
          return true;
        case 'End':
          if (mod && this.info) this.select(Math.max(0, this.info.rows - 1), Math.max(0, this.info.cols - 1), extend);
          else return false;
          return true;
        case 'Tab':
          this.move(0, e.shiftKey ? -1 : 1, true);
          return true;
        case 'Enter':
          if (mod || e.altKey) return false;
          this.move(e.shiftKey ? -1 : 1, 0, true);
          return true;
        case 'F2':
          this.startEdit('edit', null);
          return true;
        case 'Delete':
          void this.edit({ kind: 'clear', ranges: this.ranges, what: 'contents' });
          return true;
        case 'Backspace':
          this.startEdit('enter', '');
          return true;
        case 'Escape':
          if (this.copied) {
            this.copied = null;
            this.deps.render();
            return true;
          }
          return false;
        case ' ':
          if (mod) {
            this.ranges = [{ r0: 0, c0: this.selection.c0, r1: MAX_ROWS - 1, c1: this.selection.c1 }];
            this.deps.render();
            return true;
          }
          if (e.shiftKey) {
            this.ranges = [{ r0: this.selection.r0, c0: 0, r1: this.selection.r1, c1: MAX_COLUMNS - 1 }];
            this.deps.render();
            return true;
          }
          return false;
      }
      if (mod) {
        switch (e.key.toLowerCase()) {
          case 'a':
            this.selectAll();
            return true;
          case 'z':
            void (e.shiftKey ? this.redo() : this.undo());
            return true;
          case 'y':
            if (IS_MAC) return false;
            void this.redo();
            return true;
          case 'f':
            this.find();
            return true;
        }
      }
      return false;
    })();
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (this.deps.appKey(e)) e.preventDefault();
  }

  private editorKey(e: KeyboardEvent): void {
    e.stopPropagation();
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    switch (e.key) {
      case 'Enter':
        if (e.altKey || (IS_MAC && e.ctrlKey && !e.metaKey)) return; // a line break in the cell
        e.preventDefault();
        this.commitEdit(true, mod ? undefined : { dRow: e.shiftKey ? -1 : 1, dCol: 0 }, mod);
        return;
      case 'Tab':
        e.preventDefault();
        this.commitEdit(true, { dRow: 0, dCol: e.shiftKey ? -1 : 1 });
        return;
      case 'Escape':
        e.preventDefault();
        this.commitEdit(false);
        return;
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight':
        // Typing over a cell, arrows move to the next one (as in Excel); changing a cell's text, they move the caret.
        if (this.editing?.mode === 'enter' && e.target === this.cellEditor) {
          e.preventDefault();
          const dRow = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
          const dCol = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
          this.commitEdit(true, { dRow, dCol });
        }
        return;
      case 'F2':
        e.preventDefault();
        if (this.editing) this.editing.mode = this.editing.mode === 'enter' ? 'edit' : 'enter';
        return;
    }
  }

  /** Enter and Tab move within the selection when it is more than one cell, else to the next cell. */
  private move(dRow: number, dCol: number, withinSelection: boolean): void {
    const g = this.geometry;
    if (!g) return;
    const sel = this.selection;
    const many = withinSelection && (sel.r0 !== sel.r1 || sel.c0 !== sel.c1);
    if (!many) {
      this.select(dRow ? g.step(g.rows, this.active.row, dRow) : this.active.row, dCol ? g.step(g.cols, this.active.col, dCol) : this.active.col);
      return;
    }
    let { row, col } = this.active;
    if (dRow) {
      row += dRow;
      if (row > sel.r1) [row, col] = [sel.r0, col + 1 > sel.c1 ? sel.c0 : col + 1];
      else if (row < sel.r0) [row, col] = [sel.r1, col - 1 < sel.c0 ? sel.c1 : col - 1];
    } else {
      col += dCol;
      if (col > sel.c1) [row, col] = [row + 1 > sel.r1 ? sel.r0 : row + 1, sel.c0];
      else if (col < sel.c0) [row, col] = [row - 1 < sel.r0 ? sel.r1 : row - 1, sel.c1];
    }
    this.active = { row, col };
    this.reveal();
    void this.loadContent();
    this.deps.render();
  }

  /** Ctrl+arrow: to the edge of the data (the worker knows where the cells are). */
  private async jump(from: { row: number; col: number }, dRow: number, dCol: number, extend: boolean): Promise<void> {
    const reply = await this.ask<Extract<FromWorker, { t: 'end' }>>({ t: 'end', id: this.id(), sheet: this.sheetIndex, from, dRow, dCol }).catch(() => null);
    if (reply) this.select(reply.at.row, reply.at.col, extend);
  }

  selectAll(): void {
    this.ranges = [{ r0: 0, c0: 0, r1: MAX_ROWS - 1, c1: MAX_COLUMNS - 1 }];
    this.deps.render();
    this.onState?.();
  }

  /** Types text into the active cell (Insert › Symbol and the like): it is edited with the text added. */
  insert(text: string): void {
    if (this.editing) {
      const editor = this.cellEditor;
      editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, 'end');
      this.formulaInput.value = editor.value;
    } else this.startEdit('enter', text);
  }

  /** The name box: a cell or range ("B5", "A1:C10"), or a sheet's cell ("Data!B2"). */
  private goTo(text: string): void {
    const trimmed = text.trim();
    const bang = trimmed.lastIndexOf('!');
    const sheetName = bang > 0 ? trimmed.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'") : null;
    const range = parseRange(bang > 0 ? trimmed.slice(bang + 1) : trimmed);
    if (!range) {
      this.deps.notify(t('sheet.badReference', { text: trimmed }));
      return;
    }
    if (sheetName !== null) {
      const index = this.book?.sheets.findIndex((s) => s.name.toLowerCase() === sheetName.toLowerCase()) ?? -1;
      if (index < 0) return this.deps.notify(t('sheet.badReference', { text: trimmed }));
      this.switchSheet(index);
    }
    this.active = { row: range.r0, col: range.c0 };
    this.anchor = { ...this.active };
    this.ranges = [range];
    this.reveal();
    void this.loadContent();
    this.focus();
    this.deps.render();
  }

  // --- The mouse (canvas CSS pixels) ---

  private hit(x: number, y: number): Hit | null {
    const g = this.geometry;
    if (!g) return null;
    const scale = this.deps.camera.zoom * CSS_PX_PER_POINT;
    return g.hit(x, y - this.offsetTop, this.renderer.regions, scale, this.renderer.headerWidth);
  }

  press(x: number, y: number, shift: boolean, clicks: number, additive = false): void {
    const hit = this.hit(x, y);
    if (!hit || !this.geometry) return;
    if (this.onChoicesButton(x, y)) {
      void this.showChoices();
      return;
    }
    if (this.editing) this.commitEdit(true);
    this.focus();
    const g = this.geometry;
    switch (hit.kind) {
      case 'outline':
        this.outlinePress(hit);
        return;
      case 'corner':
        this.selectAll();
        return;
      case 'columnHeader':
        if (hit.edge?.col !== undefined) {
          if (clicks >= 2) return void this.autofitColumns(hit.edge.col);
          this.dragState = { kind: 'resizeColumn', index: hit.edge.col, start: x, size: g.cols.size(hit.edge.col) };
          return;
        }
        this.anchor = shift ? this.anchor : { row: 0, col: hit.col };
        if (!shift) this.active = { row: g.frozenRows ? 0 : Math.round(this.deps.camera.y / g.rows.default), col: hit.col };
        this.ranges = [{ r0: 0, c0: Math.min(this.anchor.col, hit.col), r1: MAX_ROWS - 1, c1: Math.max(this.anchor.col, hit.col) }];
        this.dragState = { kind: 'columns' };
        break;
      case 'rowHeader':
        if (hit.edge?.row !== undefined) {
          if (clicks >= 2) return;
          this.dragState = { kind: 'resizeRow', index: hit.edge.row, start: y, size: g.rows.size(hit.edge.row) };
          return;
        }
        this.anchor = shift ? this.anchor : { row: hit.row, col: 0 };
        if (!shift) this.active = { row: hit.row, col: 0 };
        this.ranges = [{ r0: Math.min(this.anchor.row, hit.row), c0: 0, r1: Math.max(this.anchor.row, hit.row), c1: MAX_COLUMNS - 1 }];
        this.dragState = { kind: 'rows' };
        break;
      case 'cell':
        if (!shift && this.filterButtonAt(hit.row, hit.col, x, y)) {
          this.select(hit.row, hit.col);
          void this.openFilter(hit.col, x, y);
          return;
        }
        if (!shift && !this.readOnly && this.onFillHandle(x, y)) {
          this.dragState = { kind: 'fill' };
          this.filling = { ...this.selection };
          return;
        }
        if (clicks >= 2 && !shift) {
          this.select(hit.row, hit.col);
          this.startEdit('edit', null);
          return;
        }
        this.select(hit.row, hit.col, shift, additive);
        this.dragState = { kind: 'select' };
        break;
      default:
        return;
    }
    void this.loadContent();
    this.onState?.();
    this.deps.render();
  }

  drag(x: number, y: number): void {
    const d = this.dragState;
    const g = this.geometry;
    if (!d || !g) return;
    const scale = this.deps.camera.zoom * CSS_PX_PER_POINT;
    if (d.kind === 'resizeColumn' || d.kind === 'resizeRow') {
      const delta = ((d.kind === 'resizeColumn' ? x : y) - d.start!) / scale;
      this.resizeTo = Math.max(0, d.size! + delta);
      (d.kind === 'resizeColumn' ? g.cols : g.rows).set(d.index!, this.resizeTo);
      this.renderer.invalidate(this.sheetIndex);
      this.deps.render();
      return;
    }
    const hit = this.hit(Math.max(this.renderer.headerWidth + 1, x), Math.max(g.headerHeight + this.offsetTop + 1, y));
    if (!hit) return;
    if (d.kind === 'fill' && hit.kind === 'cell') {
      // Down, up, right or left of the selection, whichever the pointer is further out along.
      const s = this.selection;
      const below = hit.row - s.r1;
      const above = s.r0 - hit.row;
      const right = hit.col - s.c1;
      const left = s.c0 - hit.col;
      const most = Math.max(below, above, right, left, 0);
      this.filling = most === 0 ? { ...s } : most === below ? { ...s, r1: hit.row } : most === above ? { ...s, r0: hit.row } : most === right ? { ...s, c1: hit.col } : { ...s, c0: hit.col };
      this.deps.render();
      return;
    }
    if (d.kind === 'select' && hit.kind === 'cell') this.select(hit.row, hit.col, true, true);
    else if (d.kind === 'columns') {
      this.ranges = [{ r0: 0, c0: Math.min(this.anchor.col, hit.col), r1: MAX_ROWS - 1, c1: Math.max(this.anchor.col, hit.col) }];
      this.deps.render();
    } else if (d.kind === 'rows') {
      this.ranges = [{ r0: Math.min(this.anchor.row, hit.row), c0: 0, r1: Math.max(this.anchor.row, hit.row), c1: MAX_COLUMNS - 1 }];
      this.deps.render();
    }
  }

  release(): void {
    const d = this.dragState;
    this.dragState = null;
    if (d?.kind === 'fill') {
      const target = this.filling;
      const source = this.selection;
      this.filling = null;
      if (target && (target.r0 !== source.r0 || target.r1 !== source.r1 || target.c0 !== source.c0 || target.c1 !== source.c1)) void this.edit({ kind: 'fill', source, target });
      this.deps.render();
      return;
    }
    if (!d || this.resizeTo === null) return;
    const size = this.resizeTo;
    this.resizeTo = null;
    // Resizing one of several selected rows or columns resizes them all, as in Excel.
    if (d.kind === 'resizeColumn') {
      const sel = this.selection;
      const whole = sel.r0 === 0 && sel.r1 === MAX_ROWS - 1 && d.index! >= sel.c0 && d.index! <= sel.c1;
      const cols = whole ? range(sel.c0, sel.c1) : [d.index!];
      void this.edit(size > 0 ? { kind: 'columnWidth', cols, size } : { kind: 'hideColumns', cols, hidden: true });
    } else if (d.kind === 'resizeRow') {
      const sel = this.selection;
      const whole = sel.c0 === 0 && sel.c1 === MAX_COLUMNS - 1 && d.index! >= sel.r0 && d.index! <= sel.r1;
      const rows = whole ? range(sel.r0, sel.r1) : [d.index!];
      void this.edit(size > 0 ? { kind: 'rowHeight', rows, size } : { kind: 'hideRows', rows, hidden: true });
    }
  }

  get isDragging(): boolean {
    return this.dragState !== null;
  }

  /** Double-click on a column header's edge: the column (and the other selected whole columns with it) fits its widest text. */
  private async autofitColumns(col: number): Promise<void> {
    if (this.readOnly) return;
    const whole = this.ranges.find((r) => r.r0 === 0 && r.r1 >= MAX_ROWS - 1 && r.c0 <= col && r.c1 >= col);
    const cols = whole ? range(whole.c0, Math.min(whole.c1, whole.c0 + 256)) : [col];
    const widths: number[] = [];
    for (const c of cols) {
      const reply = await this.ask<Extract<FromWorker, { t: 'columnTexts' }>>({ t: 'columnTexts', id: this.id(), sheet: this.sheetIndex, col: c }).catch(() => null);
      if (!reply) return;
      const missing = [...new Set(reply.texts.map(([, s]) => s))].filter((s) => !this.renderer.styleOf(s));
      if (missing.length) {
        const styles = await this.ask<Extract<FromWorker, { t: 'styles' }>>({ t: 'styles', id: this.id(), ids: missing }).catch(() => null);
        for (const [i, style] of styles?.styles ?? []) this.renderer.rememberStyle(i, style);
      }
      let widest = 0;
      for (const [text, s] of reply.texts) {
        const style = this.renderer.styleOf(s);
        const w = style ? this.renderer.textWidth(text, style) : null;
        if (w !== null) widest = Math.max(widest, w);
      }
      widths.push(widest);
    }
    // Text, its padding on both sides, and a little room, as Excel leaves; an empty column goes back to the default width.
    const sizes = widths.map((w) => (w ? Math.ceil(w + 2 * CELL_PAD + 3) : null));
    for (let i = 0; i < cols.length; i++) void this.edit({ kind: 'columnWidth', cols: [cols[i]], size: sizes[i] });
  }

  /** Whether a point (CSS pixels on the canvas) is on the AutoFilter's button in a cell. */
  private filterButtonAt(row: number, col: number, x: number, y: number): boolean {
    const filter = this.info?.filter;
    const g = this.geometry;
    if (!filter || !g || row !== filter.range.r0 || col < filter.range.c0 || col > filter.range.c1) return false;
    const scale = this.deps.camera.zoom * CSS_PX_PER_POINT;
    const box = filterButton(g, row, col, 1 / scale);
    const center = this.pointOf(row, col);
    if (!box || !center) return false;
    // The cell's middle on screen, and the button's offset from it.
    const mx = (g.x(col) + g.x(col + 1)) / 2;
    const my = (g.y(row) + g.y(row + 1)) / 2;
    const x0 = center.x + (box.x0 - mx) * scale;
    const x1 = center.x + (box.x1 - mx) * scale;
    const y0 = center.y + (box.y0 - my) * scale;
    const y1 = center.y + (box.y1 - my) * scale;
    return x >= x0 && x <= x1 && y >= y0 && y <= y1;
  }

  /** Opens the AutoFilter's card for a column, under its button. */
  private async openFilter(col: number, x: number, y: number): Promise<void> {
    const filter = this.info?.filter;
    if (!filter) return;
    const reply = await this.ask<Extract<FromWorker, { t: 'filterValues' }>>({ t: 'filterValues', id: this.id(), sheet: this.sheetIndex, col }).catch(() => null);
    if (!reply) return;
    const canvas = this.el.getBoundingClientRect();
    this.filterCard ??= new FilterCard();
    this.filterCard.show({
      values: reply.values,
      blanks: reply.blanks,
      shown: reply.shown,
      shownBlanks: reply.shownBlanks,
      clientX: canvas.left + x,
      clientY: canvas.top + y + 8,
      sort: (descending) => void this.edit({ kind: 'sort', range: filter.range, keys: [{ col, descending }], header: true }),
      apply: (choice) => void this.edit({ kind: 'filter', col, values: choice.values, blanks: choice.blanks }),
    });
  }

  /** A press in an outline gutter: a level button shows that level; a group's box collapses or expands it. */
  private outlinePress(hit: Hit): void {
    const g = this.geometry;
    const o = hit.outline;
    if (!g || !o || this.readOnly) return;
    const groups = o.axis === 'row' ? g.rowOutline : g.colOutline;
    if (o.button) {
      if (o.level <= groups.depth + 1) void this.edit({ kind: 'outlineLevel', axis: o.axis, level: o.level });
      return;
    }
    // The box is at a group's summary: the index right after a run at this level.
    const i = o.axis === 'row' ? hit.row : hit.col;
    if ((groups.levels.get(i - 1) ?? 0) >= o.level && (groups.levels.get(i) ?? 0) < o.level) {
      void this.edit({ kind: 'collapse', axis: o.axis, summary: i, level: o.level, collapse: !groups.collapsed.has(i) });
    }
  }

  /**
   * Back to the sheet after a card or dialog over it. Closing a modal dialog hands the focus back to what had it before,
   * which can be the formula bar, whose focus starts an edit: an edit nothing was typed into is dropped. And Chrome can
   * give the focus back without the caret (keys then type nothing), so the focus is taken away and given again.
   */
  private afterCard(): void {
    if (this.editing && this.formulaInput.value === this.content.input) this.commitEdit(false);
    (document.activeElement as HTMLElement | null)?.blur();
    this.focus();
  }

  /** Sheet › Protect Sheet or Unprotect Sheet: the password asked for (protecting, or a sheet that has one). */
  private async protectSheet(on: boolean): Promise<void> {
    if (this.readOnly || !this.info) return;
    const sheet = this.sheetIndex;
    const isOn = !!this.info.protection;
    if (on === isOn) return this.deps.notify(t(on ? 'sheet.alreadyProtected' : 'sheet.notProtected'));
    const password = on || this.info.protection?.password ? await askSheetPassword(on ? 'protect' : 'unprotect') : '';
    this.afterCard();
    if (password === null || sheet !== this.sheetIndex) return;
    void this.edit({ kind: 'protect', on, password });
  }

  /** Sheet › New Note: a card beside the active cell to type its note in (the note it has, to change). */
  private async editNote(): Promise<void> {
    if (this.readOnly || !this.info) return;
    const { row, col } = this.active;
    const sheet = this.sheetIndex;
    this.hoverNote(null);
    const reply = this.info.notes?.some(([r, c]) => r === row && c === col)
      ? await this.ask<Extract<FromWorker, { t: 'note' }>>({ t: 'note', id: this.id(), sheet, row, col }).catch(() => null)
      : null;
    const at = this.noteCorner(row, col);
    if (!at) return;
    this.noteEditor ??= new NoteEditor();
    const author = reply?.note?.author ?? this.deps.author();
    const text = await this.noteEditor.edit(author, reply?.note?.text ?? '', at.x, at.y);
    this.afterCard();
    if (text === undefined || sheet !== this.sheetIndex || (!reply?.note && !text.trim()) || text === reply?.note?.text) return;
    void this.edit({ kind: 'note', row, col, text, author });
  }

  /** A cell's top right corner, in window pixels (where a note's card goes). */
  private noteCorner(row: number, col: number): { x: number; y: number } | null {
    const g = this.geometry;
    const center = this.pointOf(row, col);
    if (!g || !center) return null;
    const scale = this.deps.camera.zoom * CSS_PX_PER_POINT;
    const canvas = this.el.getBoundingClientRect();
    return { x: canvas.left + center.x + ((g.x(col + 1) - g.x(col)) / 2) * scale, y: canvas.top + center.y - ((g.y(row + 1) - g.y(row)) / 2) * scale };
  }

  /** The pointer rests on a cell: its note, if it has one, shows after a moment; leaving the cell hides it. */
  private hoverNote(cell: { row: number; col: number } | null): void {
    const key = cell ? `${this.sheetIndex}:${cell.row}:${cell.col}` : '';
    if (key === this.noteHover) return;
    this.noteHover = key;
    window.clearTimeout(this.noteTimer);
    this.noteCard?.hide();
    if (!cell || !this.info?.notes?.some(([r, c]) => r === cell.row && c === cell.col)) return;
    this.noteTimer = window.setTimeout(async () => {
      const reply = await this.ask<Extract<FromWorker, { t: 'note' }>>({ t: 'note', id: this.id(), sheet: this.sheetIndex, row: cell.row, col: cell.col }).catch(() => null);
      const at = this.noteCorner(cell.row, cell.col);
      if (!reply?.note || this.noteHover !== key || !at || this.noteEditor?.shown) return;
      this.noteCard ??= new NoteCard();
      this.noteCard.show(reply.note.author, reply.note.text, at.x, at.y);
    }, 300);
  }

  /** Whether a point (CSS pixels on the canvas) is on the active cell's list arrow. */
  private onChoicesButton(x: number, y: number): boolean {
    const g = this.geometry;
    if (!g || !this.content.list || this.editing) return false;
    const { row, col } = this.active;
    const scale = this.deps.camera.zoom * CSS_PX_PER_POINT;
    const box = choicesButton(g, row, col, 1 / scale);
    const center = this.pointOf(row, col);
    if (!box || !center) return false;
    const mx = (g.x(col) + g.x(col + 1)) / 2;
    const my = (g.y(row) + g.y(row + 1)) / 2;
    return x >= center.x + (box.x0 - mx) * scale && x <= center.x + (box.x1 - mx) * scale && y >= center.y + (box.y0 - my) * scale && y <= center.y + (box.y1 - my) * scale;
  }

  /** The active cell's list validation: its choices in a menu under the cell; picking one types it. */
  private async showChoices(): Promise<void> {
    if (this.readOnly) return;
    const at = { ...this.active };
    const reply = await this.ask<Extract<FromWorker, { t: 'choices' }>>({ t: 'choices', id: this.id(), sheet: this.sheetIndex, row: at.row, col: at.col }).catch(() => null);
    if (!reply?.items.length) return;
    const point = this.pointOf(at.row, at.col);
    const g = this.geometry;
    if (!point || !g) return;
    const scale = this.deps.camera.zoom * CSS_PX_PER_POINT;
    const canvas = this.el.getBoundingClientRect();
    const x = canvas.left + point.x - ((g.x(at.col + 1) - g.x(at.col)) / 2) * scale;
    const y = canvas.top + point.y + ((g.y(at.row + 1) - g.y(at.row)) / 2) * scale;
    showPopupMenu(
      reply.items.map((item) => ({ label: item, run: () => void this.edit({ kind: 'input', range: { r0: at.row, c0: at.col, r1: at.row, c1: at.col }, text: item }) })),
      x,
      y,
      t('sheet.choices'),
      () => this.focus(),
    );
  }

  /** Whether a point (CSS pixels) is on the fill handle at the selection's corner. */
  private onFillHandle(x: number, y: number): boolean {
    const g = this.geometry;
    if (!g || this.ranges.length !== 1) return false;
    const s = this.selection;
    const corner = this.pointOf(s.r1, s.c1);
    if (!corner) return false;
    const scale = this.deps.camera.zoom * CSS_PX_PER_POINT;
    const cx = corner.x + ((g.x(s.c1 + 1) - g.x(s.c1)) / 2) * scale;
    const cy = corner.y + ((g.y(s.r1 + 1) - g.y(s.r1)) / 2) * scale;
    return Math.abs(x - cx) <= FILL_HANDLE && Math.abs(y - cy) <= FILL_HANDLE;
  }

  /** The pointer's shape over a point: a resize arrow over a header's edge. */
  cursorAt(x: number, y: number): string {
    const hit = this.hit(x, y);
    this.hoverNote(hit?.kind === 'cell' ? hit : null);
    if (hit?.edge?.col !== undefined) return 'col-resize';
    if (hit?.edge?.row !== undefined) return 'row-resize';
    if (hit?.kind === 'cell' && this.onFillHandle(x, y)) return 'crosshair';
    if (hit?.kind === 'cell') return 'cell';
    return 'default';
  }

  /** A right click: the cells' menu. */
  contextMenu(clientX: number, clientY: number, x: number, y: number): void {
    const hit = this.hit(x, y);
    if (!hit) return;
    const sel = this.selection;
    const inside = hit.row >= sel.r0 && hit.row <= sel.r1 && hit.col >= sel.c0 && hit.col <= sel.c1;
    if (!inside && hit.kind === 'cell') this.select(hit.row, hit.col);
    this.menu(clientX, clientY, this.cellItems(hit.kind));
  }

  private menu(x: number, y: number, items: PopupItem[]): void {
    showPopupMenu(items, x, y, t('sheet.tabs'), () => this.focus());
  }

  private cellItems(kind: Hit['kind']): PopupItem[] {
    const op = (o: SheetOp): PopupItem => ({ label: t(`sheet.op.${o}` as MessageKey), run: () => this.sheetOp(o) });
    const clipboard: PopupItem[] = [
      { label: t('sheet.cut'), run: () => void this.copy(true) },
      { label: t('sheet.copy'), run: () => void this.copy(false) },
      { label: t('sheet.paste'), run: () => void this.paste() },
    ];
    if (kind === 'columnHeader') return [...clipboard, 'separator', op('insertColumnsLeft'), op('deleteColumns'), op('clearContents'), 'separator', op('hideColumns'), op('unhideColumns')];
    if (kind === 'rowHeader') return [...clipboard, 'separator', op('insertRowsAbove'), op('deleteRows'), op('clearContents'), 'separator', op('hideRows'), op('unhideRows')];
    return [...clipboard, 'separator', op('insertRowsAbove'), op('insertColumnsLeft'), op('deleteRows'), op('deleteColumns'), 'separator', op('clearContents'), op('clearFormats'), 'separator', op('merge'), op('unmerge')];
  }

  private tabItems(): PopupItem[] {
    const op = (o: SheetOp): PopupItem => ({ label: t(`sheet.op.${o}` as MessageKey), run: () => this.sheetOp(o) });
    return [op('addSheet'), op('renameSheet'), op('deleteSheet')];
  }

  // --- Clipboard ---

  async copy(cut = false): Promise<void> {
    if (!this.worker) return;
    const range = this.selection;
    try {
      const reply = await this.ask<Extract<FromWorker, { t: 'copy' }>>({ t: 'copy', id: this.id(), sheet: this.sheetIndex, range });
      await writeClipboard(reply.text, reply.html);
      this.copied = range;
      this.copiedFrom = { sheet: this.sheetIndex, text: reply.text };
      this.deps.render();
      if (cut) await this.edit({ kind: 'clear', ranges: [range], what: 'all' });
    } catch (e) {
      this.deps.notify(messageFor((e as Error).message));
    }
  }

  async paste(): Promise<void> {
    try {
      const items = await navigator.clipboard.read();
      let text = '';
      let html = '';
      for (const item of items) {
        if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
        if (item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
      }
      await this.pasteClip(text, html);
    } catch {
      try {
        await this.pasteClip(await navigator.clipboard.readText(), '');
      } catch (e) {
        this.deps.notify((e as Error).message);
      }
    }
  }

  private async pasteClip(text: string, html: string): Promise<void> {
    if (this.readOnly) return;
    // Cells copied here (the clipboard still holds their text): pasted with their formulas and looks.
    if (this.copied && this.copiedFrom && text === this.copiedFrom.text) return this.pasteSpecial('all', false);
    let rows: string[][] = [];
    if (html.includes('<table')) {
      const table = new DOMParser().parseFromString(html, 'text/html').querySelector('table');
      if (table) rows = [...table.rows].map((r) => [...r.cells].flatMap((c) => [(c.textContent ?? '').trim(), ...Array<string>(Math.max(0, c.colSpan - 1)).fill('')]));
    }
    if (!rows.length) rows = parseTabbed(text);
    if (!rows.length) return;
    await this.edit({ kind: 'paste', at: { ...this.active }, rows });
    this.copied = null;
  }

  /** Pastes the cells copied in this workbook, or only some of what they hold. */
  private async pasteSpecial(what: PasteWhat, transpose: boolean): Promise<void> {
    if (this.readOnly) return;
    if (!this.copied || !this.copiedFrom) {
      // Nothing copied here: values from the clipboard, as typed.
      if (what === 'values' || what === 'all') await this.paste();
      return;
    }
    await this.edit({ kind: 'pasteCells', from: this.copiedFrom.sheet, source: this.copied, at: { ...this.active }, what, transpose });
  }

  // --- Sheets ---

  private showTabs(): void {
    const book = this.book;
    if (!book) return;
    this.tabList.replaceChildren(
      ...book.sheets.map((sheet, i) => {
        if (sheet.state !== 'visible') return '';
        const tab = h('button', { class: 'wm-sheet-tab', text: sheet.name, attrs: { type: 'button', role: 'tab', 'aria-selected': String(i === this.sheetIndex), 'data-sheet': String(i) } });
        tab.addEventListener('click', () => this.switchSheet(i));
        tab.addEventListener('dblclick', () => this.renameInPlace(i, tab));
        return tab;
      }),
    );
  }

  private showStatus(): void {
    this.status.textContent = this.progress ?? '';
  }

  switchSheet(index: number): void {
    if (!this.book || index === this.sheetIndex || !this.book.sheets[index]) return;
    this.commitEdit(true);
    this.sheetIndex = index;
    void this.edit({ kind: 'activeSheet', sheet: index });
    this.useSheet(true);
    this.showTabs();
  }

  private renameInPlace(index: number, tab: HTMLElement): void {
    if (this.readOnly) return;
    const field = h('input', { class: 'wm-input wm-sheet-rename', attrs: { type: 'text', value: this.book!.sheets[index].name, 'aria-label': t('sheet.op.renameSheet') } });
    tab.replaceWith(field);
    field.select();
    const done = (keep: boolean) => {
      field.remove();
      if (keep && field.value !== this.book?.sheets[index]?.name) void this.edit({ kind: 'renameSheet', sheet: index, name: field.value });
      this.showTabs();
      this.focus();
    };
    field.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(true);
      else if (e.key === 'Escape') done(false);
    });
    field.addEventListener('blur', () => done(true), { once: true });
  }

  /** Changes how the selected cells look. */
  private format(change: StyleChange): void {
    if (this.readOnly) return;
    void this.edit({ kind: 'format', ranges: this.ranges, change });
  }

  /** How the active cell looks, as the toolbar shows a selection's formatting. */
  formatState(): FormatState {
    const look = this.content.look;
    if (!look) return {};
    const hex = (n: number | null) => (n === null ? null : '#' + n.toString(16).padStart(6, '0').toUpperCase());
    const align = look.horizontal === 'left' || look.horizontal === 'center' || look.horizontal === 'right' || look.horizontal === 'justify' ? look.horizontal : undefined;
    return { marks: { bold: look.bold, italic: look.italic, underline: look.underline, strikethrough: look.strike }, font: look.font, size: look.size, align, color: hex(look.color), highlight: hex(look.fill) };
  }

  /** The app's formatting commands (Format menu, Formatting toolbar), applied to the selected cells. False for one cells don't have. */
  formatAction(action: Action): boolean {
    const look = this.content.look;
    const color = (c: string | null) => (c === null ? null : parseInt(c.replace('#', ''), 16));
    switch (action.kind) {
      case 'toggleMark': {
        const key = action.mark === 'strikethrough' ? 'strike' : action.mark;
        if (key !== 'bold' && key !== 'italic' && key !== 'underline' && key !== 'strike') return false;
        this.format({ [key]: !look?.[key] });
        return true;
      }
      case 'setFont':
        this.format({ font: action.family });
        return true;
      case 'setFontSize':
        this.format({ size: action.points });
        return true;
      case 'growFont':
      case 'shrinkFont':
        this.format({ grow: action.kind === 'growFont' ? 1 : -1 });
        return true;
      case 'setColor':
        this.format({ color: color(action.color) });
        return true;
      case 'setHighlight':
        this.format({ fill: color(action.color) });
        return true;
      case 'setAlignment':
        this.format({ horizontal: look?.horizontal === action.align ? 'general' : action.align });
        return true;
      case 'clearFormatting':
        this.format({ clear: true });
        return true;
      default:
        return false;
    }
  }

  /** The Sheet menu's commands, and the context menus'. */
  sheetOp(op: SheetOp): void {
    const sel = this.selection;
    const rows = sel.r1 - sel.r0 + 1;
    const cols = sel.c1 - sel.c0 + 1;
    const book = this.book;
    if (!book) return;
    if (op in NUMBER_FORMATS) return this.format({ numFmt: NUMBER_FORMATS[op as keyof typeof NUMBER_FORMATS] });
    if (op in BORDER_OPS) return this.format({ border: BORDER_OPS[op as keyof typeof BORDER_OPS] });
    switch (op) {
      case 'pasteValues':
      case 'pasteFormulas':
      case 'pasteFormats':
      case 'pasteTranspose':
        void this.pasteSpecial(op === 'pasteValues' ? 'values' : op === 'pasteFormulas' ? 'formulas' : op === 'pasteFormats' ? 'formats' : 'all', op === 'pasteTranspose');
        return;
      case 'sortAscending':
      case 'sortDescending': {
        // One cell: the block around it; a selection: just it.
        const range = this.ranges.length === 1 ? sel : { r0: this.active.row, c0: this.active.col, r1: this.active.row, c1: this.active.col };
        void this.edit({ kind: 'sort', range, keys: [{ col: this.active.col, descending: op === 'sortDescending' }], header: null });
        return;
      }
      case 'groupRows':
      case 'ungroupRows':
        void this.edit({ kind: 'group', axis: 'row', from: sel.r0, to: Math.min(sel.r1, sel.r0 + 200000), by: op === 'groupRows' ? 1 : -1 });
        return;
      case 'groupColumns':
      case 'ungroupColumns':
        void this.edit({ kind: 'group', axis: 'col', from: sel.c0, to: sel.c1, by: op === 'groupColumns' ? 1 : -1 });
        return;
      case 'protectSheet':
      case 'unprotectSheet':
        void this.protectSheet(op === 'protectSheet');
        return;
      case 'lockCells':
      case 'unlockCells':
        void this.edit({ kind: 'format', ranges: this.ranges, change: { locked: op === 'lockCells' } });
        return;
      case 'newNote':
        void this.editNote();
        return;
      case 'deleteNote':
        void this.edit({ kind: 'note', row: this.active.row, col: this.active.col, text: null, author: '' });
        return;
      case 'insertTable':
        void this.edit({ kind: 'createTable', range: this.ranges.length === 1 ? sel : { r0: this.active.row, c0: this.active.col, r1: this.active.row, c1: this.active.col } });
        return;
      case 'filter':
        void this.edit({ kind: 'autoFilter', range: this.info?.filter ? null : this.ranges.length === 1 ? sel : { r0: this.active.row, c0: this.active.col, r1: this.active.row, c1: this.active.col } });
        return;
      case 'increaseDecimals':
      case 'decreaseDecimals':
        this.format({ decimals: op === 'increaseDecimals' ? 1 : -1 });
        return;
      case 'wrapText':
        this.format({ wrap: !this.content.look?.wrap });
        return;
      case 'alignTop':
      case 'alignMiddle':
      case 'alignBottom':
        this.format({ vertical: op === 'alignTop' ? 'top' : op === 'alignMiddle' ? 'center' : 'bottom' });
        return;
      case 'mergeCenter':
        void this.edit({ kind: 'merge', range: sel }).then(() => this.format({ horizontal: 'center' }));
        return;
      case 'insertRowsAbove':
        void this.edit({ kind: 'insertRows', at: sel.r0, count: Math.min(rows, 10000) });
        return;
      case 'insertRowsBelow':
        void this.edit({ kind: 'insertRows', at: sel.r1 + 1, count: Math.min(rows, 10000) });
        return;
      case 'insertColumnsLeft':
        void this.edit({ kind: 'insertColumns', at: sel.c0, count: Math.min(cols, 1000) });
        return;
      case 'insertColumnsRight':
        void this.edit({ kind: 'insertColumns', at: sel.c1 + 1, count: Math.min(cols, 1000) });
        return;
      case 'deleteRows':
        void this.edit({ kind: 'deleteRows', at: sel.r0, count: rows });
        return;
      case 'deleteColumns':
        void this.edit({ kind: 'deleteColumns', at: sel.c0, count: cols });
        return;
      case 'clearContents':
      case 'clearFormats':
      case 'clearAll':
        void this.edit({ kind: 'clear', ranges: this.ranges, what: op === 'clearContents' ? 'contents' : op === 'clearFormats' ? 'formats' : 'all' });
        return;
      case 'hideRows':
      case 'unhideRows':
        void this.edit({ kind: 'hideRows', rows: range(sel.r0, Math.min(sel.r1, sel.r0 + 100000)), hidden: op === 'hideRows' });
        return;
      case 'hideColumns':
      case 'unhideColumns':
        void this.edit({ kind: 'hideColumns', cols: range(sel.c0, sel.c1), hidden: op === 'hideColumns' });
        return;
      case 'freezePanes':
        void this.edit({ kind: 'freeze', pane: { rows: this.active.row, cols: this.active.col } });
        return;
      case 'freezeTopRow':
        void this.edit({ kind: 'freeze', pane: { rows: 1, cols: 0 } });
        return;
      case 'freezeFirstColumn':
        void this.edit({ kind: 'freeze', pane: { rows: 0, cols: 1 } });
        return;
      case 'unfreezePanes':
        void this.edit({ kind: 'freeze', pane: null });
        return;
      case 'merge':
        void this.edit({ kind: 'merge', range: sel });
        return;
      case 'unmerge':
        void this.edit({ kind: 'unmerge', range: sel });
        return;
      case 'addSheet': {
        let n = book.sheets.length + 1;
        while (book.sheets.some((s) => s.name.toLowerCase() === `sheet${n}`)) n++;
        void this.edit({ kind: 'addSheet', at: this.sheetIndex + 1, name: `Sheet${n}` }).then((changed) => {
          if (changed?.info) {
            this.sheetIndex = changed.info.activeSheet;
            this.useSheet(true);
            this.showTabs();
          }
        });
        return;
      }
      case 'deleteSheet':
        void this.edit({ kind: 'deleteSheet', sheet: this.sheetIndex }).then((changed) => {
          if (changed?.info) {
            this.sheetIndex = changed.info.activeSheet;
            this.useSheet(true);
            this.showTabs();
          }
        });
        return;
      case 'renameSheet': {
        const tab = this.tabList.querySelector<HTMLElement>(`[data-sheet="${this.sheetIndex}"]`);
        if (tab) this.renameInPlace(this.sheetIndex, tab);
        return;
      }
      case 'nextSheet':
      case 'previousSheet': {
        const visible = book.sheets.map((s, i) => (s.state === 'visible' ? i : -1)).filter((i) => i >= 0);
        const at = visible.indexOf(this.sheetIndex);
        const next = visible[(at + (op === 'nextSheet' ? 1 : -1) + visible.length) % visible.length];
        this.switchSheet(next);
        return;
      }
    }
  }

  // --- Find ---

  find(replace = false): void {
    this.replaceRow.hidden = !replace;
    this.findBar.hidden = false;
    this.findInput.focus();
    this.findInput.select();
    this.deps.render();
  }

  private closeFind(): void {
    if (this.findBar.hidden) return;
    this.findBar.hidden = true;
    this.findMessage.textContent = '';
    this.focus();
    this.deps.render();
  }

  private async findStep(backwards: boolean): Promise<void> {
    const o = this.findOptions;
    const reply = await this.ask<Extract<FromWorker, { t: 'found' }>>({
      t: 'find',
      id: this.id(),
      sheet: this.sheetIndex,
      text: this.findInput.value,
      from: this.active,
      backwards,
      matchCase: o.matchCase.checked,
      wholeCell: o.wholeCell.checked,
      formulas: o.formulas.checked,
      allSheets: o.allSheets.checked,
    }).catch(() => null);
    if (!reply?.at) {
      this.findMessage.textContent = t('sheet.notFound');
      return;
    }
    this.findMessage.textContent = '';
    if (reply.at.sheet !== this.sheetIndex) this.switchSheet(reply.at.sheet);
    this.select(reply.at.row, reply.at.col);
    this.findInput.focus();
  }

  /** Replaces the match in the active cell, if it is one, then finds the next. */
  private async replaceOne(): Promise<void> {
    const o = this.findOptions;
    const changed = await this.edit({ kind: 'replace', text: this.findInput.value, with: this.replaceInput.value, matchCase: o.matchCase.checked, wholeCell: o.wholeCell.checked, cells: [{ ...this.active }] });
    if (changed !== null) await this.findStep(false);
    this.replaceInput.focus();
  }

  private async replaceAll(): Promise<void> {
    const o = this.findOptions;
    const changed = await this.edit({ kind: 'replace', text: this.findInput.value, with: this.replaceInput.value, matchCase: o.matchCase.checked, wholeCell: o.wholeCell.checked });
    const count = changed?.count ?? 0;
    this.findMessage.textContent = count ? t('textEditor.replaced', { count }) : t('textEditor.replaceNone');
    this.replaceInput.focus();
  }

  // --- Focus and state ---

  focus(): void {
    if (this.editing) this.cellEditor.focus({ preventScroll: true });
    else this.input.focus({ preventScroll: true });
  }

  get hasFocus(): boolean {
    return this.el.contains(document.activeElement);
  }

  /** What the status bar shows: the active cell, and the selection's count. */
  footerInfo(): { cell: string; sheets: number } | null {
    if (!this.book) return null;
    return { cell: rangeName(this.selection), sheets: this.book.sheets.length };
  }

  debugState(): unknown {
    return { fromImage: this.fromImage, loaded: !this.progress, sheet: this.sheetIndex, active: this.active, ranges: this.ranges, editing: this.editing, content: this.content, info: this.info && { name: this.info.name, rows: this.info.rows, cols: this.info.cols }, sheets: this.book?.sheets.map((s) => s.name) ?? [], canUndo: this.canUndo, canRedo: this.canRedo, filter: this.info?.filter ?? null, outline: this.info?.outline ?? null, protection: this.info?.protection ?? null, locked: !!this.content.locked, hiddenRows: this.info?.rowSizes.hidden?.reduce((n, h) => n + (h ? 1 : 0), 0) ?? 0 };
  }

  /** The point (CSS pixels on the canvas) at the middle of a cell, for tests. */
  pointOf(row: number, col: number): { x: number; y: number } | null {
    const g = this.geometry;
    if (!g) return null;
    const scale = this.deps.camera.zoom * CSS_PX_PER_POINT;
    const region = this.renderer.regions.find((r) => (col < g.frozenCols) === !r.scrollX && (row < g.frozenRows) === !r.scrollY);
    if (!region) return null;
    return { x: region.x + ((g.x(col) + g.x(col + 1)) / 2 - region.originX) * scale, y: this.offsetTop + region.y + ((g.y(row) + g.y(row + 1)) / 2 - region.originY) * scale };
  }

  /** The point on the column header at a column's right edge, and the column's width in points, for tests. */
  columnEdge(col: number): { x: number; y: number; width: number } | null {
    const g = this.geometry;
    const cell = this.pointOf(0, col);
    if (!g || !cell) return null;
    const scale = this.deps.camera.zoom * CSS_PX_PER_POINT;
    const top = this.pointOf(0, col)!.y - ((g.y(1) - g.y(0)) / 2) * scale;
    return { x: cell.x + ((g.x(col + 1) - g.x(col)) / 2) * scale, y: top - HEADER_HEIGHT / 2, width: g.cols.size(col) };
  }
}

const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** Puts text and HTML on the clipboard (the HTML makes a table when pasted into a document). */
async function writeClipboard(text: string, html: string): Promise<void> {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]);
  } catch {
    await navigator.clipboard.writeText(text);
  }
}

/** A worker's message code as words. */
function messageFor(code: string): string {
  switch (code) {
    case 'empty':
    case 'tooLong':
    case 'characters':
    case 'taken':
    case 'lastSheet':
      return t(`sheet.problem.${code}` as MessageKey);
    case 'too many cells':
      return t('sheet.tooManyCells');
    case 'tooManyToCopy':
      return t('sheet.tooManyToCopy');
    case 'invalidValue':
      return t('sheet.invalidValue');
    case 'tableOverlap':
      return t('sheet.tableOverlap');
    case 'sheetProtected':
      return t('sheet.sheetProtected');
    case 'wrongPassword':
      return t('sheet.wrongPassword');
  }
  return code;
}

export { CellFonts };
