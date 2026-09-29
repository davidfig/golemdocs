// Keyboard shortcuts written as "Mod+Shift+Z": Mod is ⌘ on macOS and Ctrl elsewhere; "Ctrl"
// is the Control key on every platform. Keys are matched by physical key for letters, digits
// and punctuation, so Alt/Option combinations and non-US layouts behave predictably.

import { t } from '../i18n/index.ts';

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export interface Shortcut {
  /** ⌘ on macOS, Ctrl elsewhere. */
  mod: boolean;
  /** The Control key itself (only differs from `mod` on macOS). */
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** Normalized key: 'b', '8', '=', 'Enter', 'F7', … */
  key: string;
}

/** A shortcut for every platform, or per platform (either may be absent). */
export type ShortcutSpec = string | { mac?: string; other?: string };

const CODE_FOR: Record<string, string> = {
  '=': 'Equal',
  '-': 'Minus',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '.': 'Period',
  ',': 'Comma',
  '/': 'Slash',
  ';': 'Semicolon',
  "'": 'Quote',
  '`': 'Backquote',
  '\\': 'Backslash',
  Space: 'Space',
};

const MAC_KEY_NAMES: Record<string, string> = {
  Enter: '↩',
  Space: 'Space',
  Backspace: '⌫',
  Delete: '⌦',
  Escape: '⎋',
  Tab: '⇥',
};

const KEY_WORDS: Record<string, 'menus.key.enter' | 'menus.key.space' | 'menus.key.backspace' | 'menus.key.delete' | 'menus.key.escape' | 'menus.key.tab'> = {
  Enter: 'menus.key.enter',
  Space: 'menus.key.space',
  Backspace: 'menus.key.backspace',
  Delete: 'menus.key.delete',
  Escape: 'menus.key.escape',
  Tab: 'menus.key.tab',
};

export function parseShortcut(spec: ShortcutSpec | undefined): Shortcut | null {
  const text = typeof spec === 'string' ? spec : IS_MAC ? spec?.mac : spec?.other;
  if (!text) return null;
  const parts = text.split('+');
  // "Mod++" is Mod and the + key.
  let key = parts.pop()!;
  if (key === '' && parts.at(-1) === '') {
    parts.pop();
    key = '+';
  }
  const has = (name: string) => parts.includes(name);
  return {
    mod: has('Mod'),
    ctrl: has('Ctrl'),
    shift: has('Shift'),
    alt: has('Alt'),
    key: key.length === 1 ? key.toLowerCase() : key,
  };
}

/** The key an event is for, normalized like Shortcut.key. */
function eventKey(e: KeyboardEvent): string {
  const code = e.code;
  if (code.startsWith('Key')) return code.slice(3).toLowerCase();
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) {
    const rest = code.slice(6);
    if (/^\d$/.test(rest)) return rest;
    if (rest === 'Add') return '=';
    if (rest === 'Subtract') return '-';
    if (rest === 'Enter') return 'Enter';
  }
  for (const [key, c] of Object.entries(CODE_FOR)) if (c === code) return key;
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}

export function matches(shortcut: Shortcut, e: KeyboardEvent): boolean {
  const wantMeta = IS_MAC && shortcut.mod;
  const wantCtrl = shortcut.ctrl || (!IS_MAC && shortcut.mod);
  if (e.metaKey !== wantMeta || e.ctrlKey !== wantCtrl) return false;
  if (e.altKey !== shortcut.alt) return false;
  const key = eventKey(e);
  // Zoom in is commonly typed as Mod+Shift+= ("Mod++"); accept either.
  if (shortcut.key === '=' && key === '=' && !shortcut.shift) return true;
  if (e.shiftKey !== shortcut.shift) return false;
  return key === shortcut.key;
}

/** "Ctrl+Shift+Z" or "⇧⌘Z". */
export function formatShortcut(shortcut: Shortcut): string {
  const key = shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key;
  if (IS_MAC) {
    return (
      (shortcut.ctrl ? '⌃' : '') + (shortcut.alt ? '⌥' : '') + (shortcut.shift ? '⇧' : '') + (shortcut.mod ? '⌘' : '') + (MAC_KEY_NAMES[key] ?? key)
    );
  }
  const parts: string[] = [];
  if (shortcut.mod || shortcut.ctrl) parts.push(t('menus.key.ctrl'));
  if (shortcut.alt) parts.push(t('menus.key.alt'));
  if (shortcut.shift) parts.push(t('menus.key.shift'));
  parts.push(KEY_WORDS[key] ? t(KEY_WORDS[key]) : key);
  return parts.join('+');
}
