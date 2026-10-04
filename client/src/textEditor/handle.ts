// What the rest of the app holds of the large-text editor. The editor itself (view.ts and what it uses, about 50 kB) is only
// fetched when a big text file is first opened; until then this is all there is, and it reports nothing open. See
// docs/text-files.md.

import type { TextEncoding } from '../formats/textFiles.ts';
import type { LineFrame } from './glRenderer.ts';
import type { Pos } from './positions.ts';
import type { Rect } from './scene.ts';
import type { SpellIssue } from '../layout/protocol.ts';
import type { TextEditorDeps, TextEditorView, TextRoom, TextRoomOptions } from './view.ts';

export type TextSource = { encoding: TextEncoding; bom: boolean; original: Uint8Array | null };

export class TextEditor {
  private view: TextEditorView | null = null;
  private loading: Promise<TextEditorView> | null = null;
  /** Called after every change to the text, when the keyboard asks to save, and when the selection or what can be undone changes. */
  onEdit: (() => void) | null = null;
  onSave: (() => void) | null = null;
  onState: (() => void) | null = null;

  constructor(
    private readonly parent: HTMLElement,
    private readonly deps: TextEditorDeps,
  ) {}

  /** Fetches the editor (once), ready to open a file. */
  load(): Promise<TextEditorView> {
    this.loading ??= import('./view.ts').then(async ({ TextEditorView, MonoFonts }) => {
      const fonts = await MonoFonts.create(this.deps.fontBase, this.deps.atlases, this.deps.render, this.deps.locale());
      const view = new TextEditorView(this.parent, this.deps, fonts);
      view.onEdit = () => this.onEdit?.();
      view.onSave = () => this.onSave?.();
      view.onState = () => this.onState?.();
      return (this.view = view);
    });
    return this.loading;
  }

  /** The room for the open file's cloud document (see textSync.ts). */
  async room(options: TextRoomOptions): Promise<TextRoom> {
    const { textRoom } = await import('./view.ts');
    return textRoom(options);
  }

  /** Bytes of the open file. */
  get size(): number {
    return this.view?.size ?? 0;
  }

  /** The editor, when it is open on a file (for the assistant's tools). */
  get editor(): TextEditorView | null {
    return this.view?.active ? this.view : null;
  }

  get active(): boolean {
    return this.view?.active ?? false;
  }

  open(name: string, bytes: Uint8Array, source: TextSource): void {
    if (!this.view) throw new Error('the large-text editor is not loaded');
    this.view.open(name, bytes, source);
  }

  close(): void {
    this.view?.close();
  }

  get fileName(): string {
    return this.view?.fileName ?? '';
  }

  get hasSelection(): boolean {
    return this.view?.hasSelection ?? false;
  }

  get canUndo(): boolean {
    return this.view?.canUndo ?? false;
  }

  get canRedo(): boolean {
    return this.view?.canRedo ?? false;
  }

  get selectedText(): string | null {
    return this.view?.selectedText ?? null;
  }

  snapshot(): Uint8Array | null {
    return this.view?.snapshot() ?? null;
  }

  focus(): void {
    this.view?.focus();
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

  cut(): Promise<void> {
    return this.view?.cut() ?? Promise.resolve();
  }

  paste(): Promise<void> {
    return this.view?.paste() ?? Promise.resolve();
  }

  copy(): Promise<string | null> {
    return this.view?.copy() ?? Promise.resolve(null);
  }

  find(replace = false): void {
    this.view?.find(replace);
  }

  goTo(): void {
    this.view?.goTo();
  }

  /** Draws the text on the canvas with the shared camera (null when nothing is open). */
  draw(darkPages: boolean, caretOn: boolean): LineFrame | null {
    return this.view?.draw(darkPages, caretOn) ?? null;
  }

  /** The area the text fills, in points, for the camera to be kept within. */
  bounds(): Rect {
    return this.view?.bounds() ?? { x: 0, y: 0, width: 0, height: 0 };
  }

  get hasFocus(): boolean {
    return this.view?.hasFocus ?? false;
  }

  get isDragging(): boolean {
    return this.view?.isDragging ?? false;
  }

  /** The pointer, in CSS pixels on the canvas. */
  press(x: number, y: number, shift: boolean, clicks: number): void {
    this.view?.press(x, y, shift, clicks);
  }

  drag(x: number, y: number): void {
    this.view?.drag(x, y);
  }

  release(): void {
    this.view?.release();
  }

  /** The first lines of the open file. */
  headLines(): string[] {
    return this.view?.headLines() ?? [];
  }

  /** What the status bar says about the open file. */
  footerInfo(): ReturnType<TextEditorView['footerInfo']> {
    return this.view?.footerInfo() ?? null;
  }

  /** Wrap long lines, or not. */
  toggleWrap(): void {
    if (this.view) this.view.setWrap(!this.view.wrapping);
  }

  debugState(): ReturnType<TextEditorView['debugState']> {
    return this.view?.debugState() ?? null;
  }

  /** Check the lines again (what counts as a mistake changed). */
  spellReset(): void {
    this.view?.spellReset();
  }

  async spellNext(from: 'documentStart' | 'selectionStart' | 'selectionEnd', grammar: boolean): Promise<SpellIssue | null> {
    return (await this.view?.spellNext(from, grammar)) ?? null;
  }

  async spellIssueAt(x: number, y: number): Promise<SpellIssue | null> {
    return (await this.view?.spellIssueAt(x, y)) ?? null;
  }

  pointOf(pos: Pos): { x: number; y: number } | null {
    return this.view?.pointOf(pos) ?? null;
  }

  numberPoint(line: number): { x: number; y: number } | null {
    return this.view?.numberPoint(line) ?? null;
  }
}
