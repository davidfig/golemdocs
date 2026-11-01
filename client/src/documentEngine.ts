// What the page asks of an editor that is not the layout worker's document: today the text editor (textEditor/), which has its own
// text, caret, undo and clipboard and is drawn by the same GPU renderer. `main.ts` hands the open one to the chrome as `engine()`
// (null for a document), so the menus and commands ask it, instead of each knowing about one editor.

import type { Rect } from './textEditor/scene.ts';
import type { Action } from './ui/actions.ts';

export interface DocumentEngine {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly hasSelection: boolean;
  /** The text as it would be saved (null when nothing is open). */
  snapshot(): Uint8Array | null;
  /** What the content fills, in points, for the camera. */
  bounds(): Rect;
  undo(): void;
  redo(): void;
  selectAll(): void;
  /** Types text at the caret, over the selection. */
  insert(text: string): void;
  copy(): Promise<void>;
  cut(): Promise<void>;
  paste(): Promise<void>;
  /** Edit › Find, Replace or Go To. */
  find(tab: 'find' | 'replace' | 'goTo'): void;
  /** The keyboard goes to the editor. */
  focus(): void;
  /** A formatting command (bold, font, colour, alignment) for an editor that formats in its own way; false if it has no such formatting. */
  format?(action: Action): boolean;
}
