// What the rest of the app holds of the slides editor (docs/slides.md). The editor itself (view.ts and what it uses) is only
// fetched when a deck is first opened; until then this is all there is, and it reports nothing open.

import type { Action, FormatState, SlidesOp } from '../ui/actions.ts';
import type { Region } from '../ui/focusRegions.ts';
import type { SlidesEditorDeps, SlidesEditorView } from './view.ts';

export class SlidesEditor {
  private view: SlidesEditorView | null = null;
  private loading: Promise<SlidesEditorView> | null = null;
  /** Called after every change to the deck, and when the selection or what can be undone changes. */
  onEdit: (() => void) | null = null;
  onState: (() => void) | null = null;

  constructor(
    private readonly parent: HTMLElement,
    private readonly deps: SlidesEditorDeps,
  ) {}

  /** Fetches the editor (once). */
  load(): Promise<SlidesEditorView> {
    this.loading ??= import('./view.ts').then(({ SlidesEditorView }) => {
      const view = new SlidesEditorView(this.parent, this.deps);
      view.onEdit = () => this.onEdit?.();
      view.onState = () => this.onState?.();
      return (this.view = view);
    });
    return this.loading;
  }

  get active(): boolean {
    return this.view?.isOpen ?? false;
  }

  get editor(): SlidesEditorView | null {
    return this.view?.isOpen ? this.view : null;
  }

  open(name: string, bytes: Uint8Array): Promise<void> {
    if (!this.view) throw new Error('the slides editor is not loaded');
    return this.view.open(name, bytes);
  }

  close(): void {
    this.view?.close();
  }

  set readOnly(on: boolean) {
    if (this.view) this.view.readOnly = on;
  }

  get readOnly(): boolean {
    return this.view?.readOnly ?? false;
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

  get presenting(): boolean {
    return this.view?.presenting ?? false;
  }

  get sorter(): boolean {
    return this.view?.isSorter ?? false;
  }

  get notesOpen(): boolean {
    return this.view?.notesOpen ?? false;
  }

  /** The deck as a `.pptx` (null when nothing is open). */
  save(): Promise<Uint8Array> | null {
    return this.view?.isOpen ? this.view.save() : null;
  }

  thumbnail(): Promise<Blob | null> {
    return this.view?.isOpen ? this.view.thumbnailBlob() : Promise.resolve(null);
  }

  printPdf(): Promise<Uint8Array> | null {
    return this.view?.isOpen ? this.view.printPdf() : null;
  }

  formatState(): FormatState {
    return this.view?.isOpen ? this.view.formatState() : {};
  }

  formatAction(action: Action): boolean {
    return this.view?.isOpen ? this.view.formatAction(action) : false;
  }

  slidesOp(op: SlidesOp): void {
    void this.view?.slidesOp(op);
  }

  draw(darkPages: boolean): void {
    this.view?.draw(darkPages);
  }

  bounds(): { x: number; y: number; width: number; height: number } {
    return this.view?.bounds() ?? { x: 0, y: 0, width: 0, height: 0 };
  }

  fitFirst(width: number, height: number): void {
    this.view?.fitFirst(width, height);
  }

  undo(): void {
    this.view?.undo();
  }

  redo(): void {
    this.view?.redo();
  }

  selectAll(): void {
    this.view?.selectAll();
  }

  insert(text: string): void {
    this.view?.insert(text);
  }

  copy(): Promise<void> {
    return this.view?.copy() ?? Promise.resolve();
  }

  cut(): Promise<void> {
    return this.view?.cut() ?? Promise.resolve();
  }

  paste(): Promise<void> {
    return this.view?.paste() ?? Promise.resolve();
  }

  focus(): void {
    this.view?.focus();
  }

  regions(): Region[] {
    return this.view?.isOpen ? this.view.regions() : [];
  }

  press(x: number, y: number, shift: boolean, clicks: number, additive: boolean): void {
    this.view?.press(x, y, shift, clicks, additive);
  }

  drag(x: number, y: number, shift: boolean): void {
    this.view?.drag(x, y, shift);
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

  footerInfo(): { slide: number; count: number } | null {
    return this.view?.isOpen ? this.view.footerInfo() : null;
  }

  /** The slides, for the slide strip. */
  stripPages(): readonly { width: number; height: number }[] {
    return this.view?.isOpen ? this.view.stripPages() : [];
  }

  thumbnailPixels(index: number, width: number, height: number): Uint8ClampedArray<ArrayBuffer> | null {
    return this.view?.thumbnailPixels(index, width, height) ?? null;
  }

  slideCount(): number {
    return this.view?.isOpen ? this.view.slideCount : 0;
  }

  /** The deck's text, a line per paragraph (for the automation API). */
  text(): string {
    return this.view?.isOpen ? this.view.deckText() : '';
  }

  get currentIndex(): number {
    return this.view?.currentIndex ?? -1;
  }

  go(index: number): void {
    this.view?.go(index);
  }

  moveSlide(from: number, to: number): void {
    void this.view?.moveSlide(from, to);
  }

  deleteSlide(index: number): void {
    void this.view?.deleteSlideAt(index);
  }

  insertPicture(bytes: Uint8Array, name: string): Promise<void> {
    return this.view?.insertPicture(bytes, name) ?? Promise.resolve();
  }

  debugState(): unknown {
    return this.view?.debugState() ?? null;
  }

  screenOf(name: string): { x: number; y: number } | null {
    return this.view?.screenOf(name) ?? null;
  }
}
