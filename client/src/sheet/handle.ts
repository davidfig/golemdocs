// What the rest of the app holds of the spreadsheet editor. The editor itself (view.ts and what it uses; the workbook lives
// in its own worker) is only fetched when a workbook is first opened; until then this is all there is, and it reports
// nothing open. See docs/spreadsheets.md.

import type { SheetLayout } from '../formats/wdoc.ts';
import type { Action, FormatState, SheetOp } from '../ui/actions.ts';
import type { SheetEditorDeps, SheetEditorView } from './view.ts';
import type { Region } from '../ui/focusRegions.ts';
import type { ForcedColors } from '../webgl/program.ts';

export class SheetEditor {
  private view: SheetEditorView | null = null;
  private loading: Promise<SheetEditorView> | null = null;
  /** Called after every change to the workbook, and when the selection or what can be undone changes. */
  onEdit: (() => void) | null = null;
  onState: (() => void) | null = null;
  /** The memory image of a workbook just read from its file, to keep next to it. */
  onImage: ((bytes: Uint8Array, sha256: string) => void) | null = null;

  constructor(
    private readonly parent: HTMLElement,
    private readonly deps: SheetEditorDeps,
  ) {}

  /** Fetches the editor (once). */
  load(): Promise<SheetEditorView> {
    this.loading ??= import('./view.ts').then(async ({ SheetEditorView, CellFonts }) => {
      const fonts = await CellFonts.create(this.deps.fontBase, this.deps.atlases, this.deps.render, this.deps.locale());
      const view = new SheetEditorView(this.parent, this.deps, fonts);
      view.onEdit = () => this.onEdit?.();
      view.onState = () => this.onState?.();
      view.onImage = (bytes, sha256) => this.onImage?.(bytes, sha256);
      return (this.view = view);
    });
    return this.loading;
  }

  get active(): boolean {
    return this.view?.isOpen ?? false;
  }

  get editor(): SheetEditorView | null {
    return this.view?.isOpen ? this.view : null;
  }

  open(name: string, bytes: Uint8Array, image: Uint8Array | null, format?: 'csv' | 'tsv', layout?: SheetLayout): void {
    if (!this.view) throw new Error('the spreadsheet editor is not loaded');
    this.view.open(name, bytes, image, format, layout);
  }

  close(): void {
    this.view?.close();
  }

  /** How the active cell looks, for the toolbar. */
  formatState(): FormatState {
    return this.view?.isOpen ? this.view.formatState() : {};
  }

  /** A formatting command for the selected cells; false if cells have no such formatting. */
  formatAction(action: Action): boolean {
    return this.view?.isOpen ? this.view.formatAction(action) : false;
  }

  get fileName(): string {
    return this.view?.fileName ?? '';
  }

  get canUndo(): boolean {
    return this.view?.canUndo ?? false;
  }

  get canRedo(): boolean {
    return this.view?.canRedo ?? false;
  }

  get hasSelection(): boolean {
    return this.view?.hasSelection ?? false;
  }

  get hasFocus(): boolean {
    return this.view?.hasFocus ?? false;
  }

  get isDragging(): boolean {
    return this.view?.isDragging ?? false;
  }

  /** The file (.xlsx, or the CSV or TSV it was), what to store of it (see `SheetEditorView.save`) and its memory image (null when nothing is open). */
  save(): Promise<{ file: Uint8Array; stored: Uint8Array; image: Uint8Array; sha256: string }> | null {
    return this.view?.isOpen ? this.view.save() : null;
  }

  /** The workbook written as another of the grid's formats (null when nothing is open). */
  saveAs(format: 'xlsx' | 'csv' | 'tsv'): Promise<Uint8Array> | null {
    return this.view?.isOpen ? this.view.saveAs(format) : null;
  }

  /** The active sheet's top left as a thumbnail (null when nothing is open). */
  thumbnail(): Promise<Blob | null> {
    return this.view?.isOpen ? this.view.thumbnail() : Promise.resolve(null);
  }

  /** File › Page Setup for the active sheet. */
  pageSetup(): void {
    void this.view?.pageSetup();
  }

  /** The active sheet as a PDF, as it prints (null when nothing is open). */
  printPdf(): Promise<Uint8Array> | null {
    return this.view?.isOpen ? this.view.printPdf() : null;
  }

  draw(darkPages: boolean, forced: ForcedColors | null = null): void {
    this.view?.draw(darkPages, forced);
  }

  bounds(): { x: number; y: number; width: number; height: number } {
    return this.view?.bounds() ?? { x: 0, y: 0, width: 0, height: 0 };
  }

  undo(): void {
    void this.view?.undo();
  }

  redo(): void {
    void this.view?.redo();
  }

  selectAll(): void {
    this.view?.selectAll();
  }

  insert(text: string): void {
    this.view?.insert(text);
  }

  copy(): Promise<void> {
    return this.view?.copy(false) ?? Promise.resolve();
  }

  copyLiveLink(name: string): Promise<void> {
    return this.view?.copyLiveLink(name) ?? Promise.resolve();
  }

  cut(): Promise<void> {
    return this.view?.copy(true) ?? Promise.resolve();
  }

  paste(): Promise<void> {
    return this.view?.paste() ?? Promise.resolve();
  }

  find(replace = false): void {
    this.view?.find(replace);
  }

  focus(): void {
    this.view?.focus();
  }

  /** The workbook's parts of the window for F6 (none while nothing is open). */
  regions(): Region[] {
    return this.view?.isOpen ? this.view.regions() : [];
  }

  sheetOp(op: SheetOp): void {
    this.view?.sheetOp(op);
  }

  press(x: number, y: number, shift: boolean, clicks: number, additive: boolean): void {
    this.view?.press(x, y, shift, clicks, additive);
  }

  drag(x: number, y: number): void {
    this.view?.drag(x, y);
  }

  release(): void {
    this.view?.release();
  }

  cursorAt(x: number, y: number): string {
    return this.view?.cursorAt(x, y) ?? 'default';
  }

  contextMenu(clientX: number, clientY: number, x: number, y: number): void {
    this.view?.contextMenu(clientX, clientY, x, y);
  }

  footerInfo(): ReturnType<SheetEditorView['footerInfo']> {
    return this.view?.footerInfo() ?? null;
  }

  /** The active sheet's size, for the status bar (null when nothing is open or it is still opening). */
  get size(): { rows: number; columns: number } | null {
    return this.view?.isOpen ? this.view.size : null;
  }

  debugState(): unknown {
    return this.view?.debugState() ?? null;
  }

  columnEdge(col: number): { x: number; y: number; width: number } | null {
    return this.view?.columnEdge(col) ?? null;
  }

  pointOf(row: number, col: number): { x: number; y: number } | null {
    return this.view?.pointOf(row, col) ?? null;
  }

  /** A cell of the active sheet, as typed and as shown (for the end-to-end tests). */
  cell(row: number, col: number): Promise<{ input: string; display: string } | null> {
    return this.view?.cellContent(row, col) ?? Promise.resolve(null);
  }

  screenOf(x: number, y: number): { x: number; y: number } | null {
    return this.view?.screenOf(x, y) ?? null;
  }

  set readOnly(value: boolean) {
    if (this.view) this.view.readOnly = value;
  }
}
