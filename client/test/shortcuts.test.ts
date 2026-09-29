import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatShortcut, IS_MAC, matches, parseShortcut } from '../src/ui/shortcuts.ts';

const parsed = (spec: string) => parseShortcut(spec)!;
/** A key event as the browser reports it (only what matches() reads). */
const key = (code: string, k: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) =>
  ({ code, key: k, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt }) as KeyboardEvent;
/** The modifier that "Mod" means on this machine. */
const mod = IS_MAC ? { meta: true } : { ctrl: true };

test('shortcut text splits into modifiers and a lowercase key', () => {
  assert.deepEqual(parsed('Mod+Shift+Z'), { mod: true, ctrl: false, shift: true, alt: false, key: 'z' });
  assert.deepEqual(parsed('Ctrl+Alt+Delete'), { mod: false, ctrl: true, shift: false, alt: true, key: 'Delete' });
  assert.equal(parsed('F7').key, 'F7');
});

test('"Mod++" is Mod and the plus key', () => {
  assert.deepEqual(parsed('Mod++'), { mod: true, ctrl: false, shift: false, alt: false, key: '+' });
});

test('an empty or missing shortcut is none; a per-platform one picks this platform’s', () => {
  assert.equal(parseShortcut(undefined), null);
  assert.equal(parseShortcut(''), null);
  assert.equal(parseShortcut({ mac: 'Mod+M' })?.key ?? null, IS_MAC ? 'm' : null);
  assert.equal(parseShortcut({ other: 'Mod+O' })?.key ?? null, IS_MAC ? null : 'o');
  assert.equal(parseShortcut({ mac: 'Mod+M', other: 'Mod+O' })?.key, IS_MAC ? 'm' : 'o');
});

test('letters and digits match by physical key, whatever the layout or Option makes of them', () => {
  assert.ok(matches(parsed('Mod+B'), key('KeyB', 'b', mod)));
  assert.ok(matches(parsed('Mod+Alt+B'), key('KeyB', '∫', { ...mod, alt: true })), 'Option+B types a different character');
  assert.ok(matches(parsed('Mod+1'), key('Digit1', '1', mod)));
  assert.ok(matches(parsed('Mod+1'), key('Numpad1', '1', mod)));
});

test('modifiers must match exactly', () => {
  assert.ok(!matches(parsed('Mod+B'), key('KeyB', 'b')), 'no modifier');
  assert.ok(!matches(parsed('Mod+B'), key('KeyB', 'B', { ...mod, shift: true })), 'extra Shift');
  assert.ok(!matches(parsed('Mod+B'), key('KeyB', 'b', { ...mod, alt: true })), 'extra Alt');
  assert.ok(!matches(parsed('Mod+Shift+B'), key('KeyB', 'b', mod)), 'missing Shift');
  assert.ok(!matches(parsed('Mod+B'), key('KeyN', 'n', mod)), 'another key');
});

test('Ctrl is the Control key on every platform', () => {
  assert.ok(matches(parsed('Ctrl+Tab'), key('Tab', 'Tab', { ctrl: true })));
  assert.ok(!matches(parsed('Ctrl+Tab'), key('Tab', 'Tab', { meta: true })));
});

test('zoom in accepts = with or without Shift, and the numpad plus and minus', () => {
  assert.ok(matches(parsed('Mod+='), key('Equal', '=', mod)));
  assert.ok(matches(parsed('Mod+='), key('Equal', '+', { ...mod, shift: true })));
  assert.ok(matches(parsed('Mod+-'), key('NumpadSubtract', '-', mod)));
  assert.ok(matches(parsed('Mod+='), key('NumpadAdd', '+', mod)));
});

test('named keys match by their names', () => {
  assert.ok(matches(parsed('Enter'), key('Enter', 'Enter')));
  assert.ok(matches(parsed('Mod+Enter'), key('NumpadEnter', 'Enter', mod)));
  assert.ok(matches(parsed('F7'), key('F7', 'F7')));
});

test('shortcuts read back in the platform’s style', () => {
  if (IS_MAC) {
    assert.equal(formatShortcut(parsed('Mod+Shift+Z')), '⇧⌘Z');
    assert.equal(formatShortcut(parsed('Ctrl+Alt+Enter')), '⌃⌥↩');
  } else {
    assert.equal(formatShortcut(parsed('Mod+Shift+Z')), 'Ctrl+Shift+Z');
    assert.equal(formatShortcut(parsed('Alt+Enter')), 'Alt+Enter');
    assert.equal(formatShortcut(parsed('Ctrl+Escape')), 'Ctrl+Esc');
  }
});
