// What the rest of the app holds of the spreadsheet editor. The editor itself (view.ts and what it uses; the workbook lives
// in its own worker) is only fetched when a workbook is first opened; until then this is all there is, and it reports
// nothing open. See docs/spreadsheets.md.

import type { Action, FormatState, SheetOp } from '../ui/actions.ts';
import type { SheetEditorDeps, SheetEditorView } from './view.ts';

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

  open(name: string, bytes: Uint8Array, image: Uint8Array | null): void {
    if (!this.view) throw new Error('the spreadsheet editor is not loaded');
    this.view.open(name, bytes, image);
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

  /** The workbook as .xlsx and its memory image (null when nothing is open). */
  save(): Promise<{ xlsx: Uint8Array; image: Uint8Array; sha256: string }> | null {
    return this.view?.isOpen ? this.view.save() : null;
  }

  draw(darkPages: boolean): void {
    this.view?.draw(darkPages);
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

  debugState(): unknown {
    return this.view?.debugState() ?? null;
  }

  columnEdge(col: number): { x: number; y: number; width: number } | null {
    return this.view?.columnEdge(col) ?? null;
  }

  pointOf(row: number, col: number): { x: number; y: number } | null {
    return this.view?.pointOf(row, col) ?? null;
  }

  screenOf(x: number, y: number): { x: number; y: number } | null {
    return this.view?.screenOf(x, y) ?? null;
  }

  set readOnly(value: boolean) {
    if (this.view) this.view.readOnly = value;
  }
}
