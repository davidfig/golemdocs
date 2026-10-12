// Typing into a canvas editor: the hidden textarea every editor keeps focus in, and the keys that move, delete and break lines in it.
// One set of keys and one set of input handlers for the document editor and the plain text editor, each giving only what to do with
// the result, so a key or an input method works the same in both.

import type { MoveTarget } from '@golemdocs/editor';
import { IS_MAC } from './shortcuts.ts';
import { clipboardOf, type Clipboard } from './clipboard.ts';

/** What an editing key asks for. */
export type EditKey =
  | { kind: 'move'; to: MoveTarget | 'pageUp' | 'pageDown'; extend: boolean }
  | { kind: 'delete'; direction: 'backward' | 'forward'; unit: 'character' | 'word' | 'line' }
  | { kind: 'enter'; shift: boolean }
  | { kind: 'tab'; backward: boolean }
  | { kind: 'selectAll' }
  | { kind: 'undo' }
  | { kind: 'redo' };

/** Editing keys, as Word (Windows) and macOS text fields map them (the word key is Ctrl on Windows and Option on a Mac; Cmd goes to the line or the document on a Mac). */
export function editKey(e: KeyboardEvent, mac = IS_MAC): EditKey | null {
  const extend = e.shiftKey;
  const word = mac ? e.altKey : e.ctrlKey;
  const line = mac && e.metaKey;
  const move = (to: MoveTarget | 'pageUp' | 'pageDown'): EditKey => ({ kind: 'move', to, extend });
  switch (e.key) {
    case 'ArrowLeft':
      return move(line ? 'lineStart' : word ? 'wordLeft' : 'left');
    case 'ArrowRight':
      return move(line ? 'lineEnd' : word ? 'wordRight' : 'right');
    case 'ArrowUp':
      return move(line ? 'documentStart' : 'up');
    case 'ArrowDown':
      return move(line ? 'documentEnd' : 'down');
    case 'PageUp':
      return move('pageUp');
    case 'PageDown':
      return move('pageDown');
    case 'Home':
      return move(e.ctrlKey || e.metaKey ? 'documentStart' : 'lineStart');
    case 'End':
      return move(e.ctrlKey || e.metaKey ? 'documentEnd' : 'lineEnd');
    case 'Backspace':
      return { kind: 'delete', direction: 'backward', unit: line ? 'line' : word ? 'word' : 'character' };
    case 'Delete':
      return { kind: 'delete', direction: 'forward', unit: word ? 'word' : 'character' };
    case 'Enter':
      return { kind: 'enter', shift: e.shiftKey };
    case 'Tab':
      return { kind: 'tab', backward: e.shiftKey };
  }
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'a') return { kind: 'selectAll' };
  if (mod && e.key.toLowerCase() === 'z') return { kind: e.shiftKey ? 'redo' : 'undo' };
  if (e.ctrlKey && !mac && e.key.toLowerCase() === 'y') return { kind: 'redo' };
  return null;
}

/** The key an input event of the browser stands for (the keyboards of phones send these instead of key presses). */
function keyOfInput(type: string): EditKey | null {
  switch (type) {
    case 'deleteContentBackward':
      return { kind: 'delete', direction: 'backward', unit: 'character' };
    case 'deleteContentForward':
      return { kind: 'delete', direction: 'forward', unit: 'character' };
    case 'deleteWordBackward':
      return { kind: 'delete', direction: 'backward', unit: 'word' };
    case 'deleteWordForward':
      return { kind: 'delete', direction: 'forward', unit: 'word' };
    case 'deleteSoftLineBackward':
    case 'deleteHardLineBackward':
      return { kind: 'delete', direction: 'backward', unit: 'line' };
    case 'insertParagraph':
      return { kind: 'enter', shift: false };
    case 'insertLineBreak':
      return { kind: 'enter', shift: true };
    case 'historyUndo':
      return { kind: 'undo' };
    case 'historyRedo':
      return { kind: 'redo' };
  }
  return null;
}

export interface TextInputHandlers {
  /** Text typed, dictated, dropped, or committed by an input method. */
  insert(text: string): void;
  /** An editing key that reached the browser as an input event (a phone's keyboard). */
  key(key: EditKey): void;
  /** An input method is composing: its text so far (null: it finished, and its text arrives through `insert`). */
  compose?(preview: string | null): void;
  /** The text a copy puts on the clipboard (null: nothing is selected, or it cannot be copied). */
  copy(): string | null;
  /** The formatted form of what `copy()` returns, if it has one (put on the clipboard beside the text). */
  copyHtml?(): string | undefined;
  /** After a cut put `copy()`'s text on the clipboard: the selection is deleted. */
  cut(): void;
  /** Something other than text is selected (a picture): it is put on the clipboard (and, for a cut, taken out) by the editor itself; whether it was. */
  copyOther?(cut: boolean): boolean;
  paste(clip: Clipboard): void;
}

/** Wires the textarea an editor keeps focus in: typed text, input methods, copy, cut and paste. Key presses are the editor's (see `editKey`). */
export function attachTextInput(input: HTMLTextAreaElement, h: TextInputHandlers): void {
  // Typed text arrives as input events (after keyboard layouts, dead keys and input methods have done their work), never as raw key presses.
  input.addEventListener('beforeinput', (e) => {
    if (e.isComposing || e.inputType === 'insertCompositionText') return;
    const key = keyOfInput(e.inputType);
    if (key) {
      e.preventDefault();
      h.key(key);
    } else if (e.inputType.startsWith('insert')) {
      e.preventDefault();
      const text = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
      if (text) h.insert(text);
    }
  });
  input.addEventListener('compositionstart', () => h.compose?.(''));
  input.addEventListener('compositionupdate', (e) => h.compose?.(e.data));
  input.addEventListener('compositionend', (e) => {
    h.compose?.(null);
    if (e.data) h.insert(e.data);
    input.value = '';
  });
  input.addEventListener('copy', (e) => {
    if (h.copyOther?.(false)) return e.preventDefault();
    const text = h.copy();
    if (text === null) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', text);
    const html = h.copyHtml?.();
    if (html) e.clipboardData?.setData('text/html', html);
  });
  input.addEventListener('cut', (e) => {
    if (h.copyOther?.(true)) return e.preventDefault();
    const text = h.copy();
    if (text === null) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', text);
    const html = h.copyHtml?.();
    if (html) e.clipboardData?.setData('text/html', html);
    h.cut();
  });
  input.addEventListener('paste', (e) => {
    e.preventDefault();
    h.paste(clipboardOf(e));
  });
}
