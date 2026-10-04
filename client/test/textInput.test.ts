import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachTextInput, editKey, type EditKey, type TextInputHandlers } from '../src/ui/textInput.ts';

const key = (k: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({ key: k, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods }) as KeyboardEvent;

test('the word key is Ctrl on Windows and Option on a Mac, and Cmd goes to the line or the document on a Mac', () => {
  assert.deepEqual(editKey(key('ArrowLeft', { ctrlKey: true }), false), { kind: 'move', to: 'wordLeft', extend: false });
  assert.deepEqual(editKey(key('ArrowLeft', { altKey: true }), false), { kind: 'move', to: 'left', extend: false });
  assert.deepEqual(editKey(key('ArrowRight', { altKey: true, shiftKey: true }), true), { kind: 'move', to: 'wordRight', extend: true });
  assert.deepEqual(editKey(key('ArrowLeft', { metaKey: true }), true), { kind: 'move', to: 'lineStart', extend: false });
  assert.deepEqual(editKey(key('ArrowDown', { metaKey: true }), true), { kind: 'move', to: 'documentEnd', extend: false });
  assert.deepEqual(editKey(key('Home', { ctrlKey: true }), false), { kind: 'move', to: 'documentStart', extend: false });
  assert.deepEqual(editKey(key('PageDown'), false), { kind: 'move', to: 'pageDown', extend: false });
});

test('deleting, line breaks, tabs, select all and undo', () => {
  assert.deepEqual(editKey(key('Backspace', { ctrlKey: true }), false), { kind: 'delete', direction: 'backward', unit: 'word' });
  assert.deepEqual(editKey(key('Backspace', { metaKey: true }), true), { kind: 'delete', direction: 'backward', unit: 'line' });
  assert.deepEqual(editKey(key('Delete'), false), { kind: 'delete', direction: 'forward', unit: 'character' });
  assert.deepEqual(editKey(key('Enter', { shiftKey: true }), false), { kind: 'enter', shift: true });
  assert.deepEqual(editKey(key('Tab', { shiftKey: true }), false), { kind: 'tab', backward: true });
  assert.deepEqual(editKey(key('a', { ctrlKey: true }), false), { kind: 'selectAll' });
  assert.deepEqual(editKey(key('Z', { ctrlKey: true, shiftKey: true }), false), { kind: 'redo' });
  assert.deepEqual(editKey(key('y', { ctrlKey: true }), false), { kind: 'redo' });
  assert.equal(editKey(key('y', { ctrlKey: true }), true), null);
  assert.equal(editKey(key('x'), false), null);
});

/** A textarea that records what is listened for, and lets a test fire events at it. */
function fake() {
  const target = new EventTarget() as EventTarget & { value: string };
  target.value = 'left over';
  const seen: string[] = [];
  const handlers: TextInputHandlers = {
    insert: (text) => seen.push(`insert ${text}`),
    key: (k: EditKey) => seen.push(`key ${k.kind}`),
    compose: (p) => seen.push(`compose ${p}`),
    copy: () => 'copied',
    cut: () => seen.push('cut'),
    paste: (clip) => seen.push(`paste ${clip.text}`),
  };
  attachTextInput(target as unknown as HTMLTextAreaElement, handlers);
  const fire = (type: string, props: Record<string, unknown>) => {
    const event = Object.assign(new Event(type, { cancelable: true }), props);
    target.dispatchEvent(event);
    return event;
  };
  return { target, seen, fire };
}

test('typed text, a phone keyboard\'s deletes and line breaks, and an input method all reach the editor', () => {
  const { target, seen, fire } = fake();
  assert.equal(fire('beforeinput', { inputType: 'insertText', data: 'é', isComposing: false }).defaultPrevented, true);
  fire('beforeinput', { inputType: 'deleteContentBackward', isComposing: false });
  fire('beforeinput', { inputType: 'insertParagraph', isComposing: false });
  fire('beforeinput', { inputType: 'insertCompositionText', data: 'に', isComposing: true });
  fire('compositionstart', {});
  fire('compositionupdate', { data: 'に' });
  fire('compositionend', { data: '日本' });
  assert.deepEqual(seen, ['insert é', 'key delete', 'key enter', 'compose ', 'compose に', 'compose null', 'insert 日本']);
  assert.equal(target.value, '', 'the textarea is emptied');
});

test('copy puts the editor\'s text on the clipboard, cut deletes after, and paste hands over the text', () => {
  const { seen, fire } = fake();
  const data = new Map<string, string>();
  const clipboardData = { setData: (type: string, text: string) => void data.set(type, text), getData: (type: string) => (type === 'text/plain' ? 'pasted' : '') };
  assert.equal(fire('copy', { clipboardData }).defaultPrevented, true);
  assert.equal(data.get('text/plain'), 'copied');
  fire('cut', { clipboardData });
  fire('paste', { clipboardData });
  assert.deepEqual(seen, ['cut', 'paste pasted']);
});
