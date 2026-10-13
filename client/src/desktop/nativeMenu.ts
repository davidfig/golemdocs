// The macOS menu bar in the desktop app. The in-page menus and this one come from the same list (`TopMenu`, built in
// ui/chrome.ts) and the same commands, so a label, shortcut, enabled rule or checked state is defined once. This
// turns that list into a snapshot for the native side (desktop/src-tauri/src/menu.rs), sends it when it changes, and runs
// the command whose id comes back from a click.
//
// A shortcut shown in the native menu is also bound by it: the system takes the key before the page sees it and sends
// the item's id instead, so every command with a shortcut in a menu is run from here. Three kinds are left to the page or
// the system: Cut, Copy and Paste (the editor needs them as real clipboard events, so they are system items), shortcuts
// that are not a modifier plus a key (Shift+Enter must stay a key press in the editor), and the drawing tools' own keys.

import { stripMnemonic } from '../ui/dom.ts';
import type { CommandRegistry } from '../ui/commands.ts';
import { describeItem, hasAvailable, visibleItems, type MenuItem, type RowItem, type TopMenu } from '../ui/menu.ts';
import type { Shortcut } from '../ui/shortcuts.ts';
import type { DesktopMenu } from './bridge.ts';

export type NativeEntry =
  | { kind: 'separator' }
  | { kind: 'item'; id: string; label: string; accelerator?: string; enabled: boolean; checked?: boolean; role?: 'cut' | 'copy' | 'paste' | 'selectAll'; appMenu?: boolean }
  | { kind: 'submenu'; label: string; enabled: boolean; items: NativeEntry[] };

export interface NativeTop {
  label: string;
  items: NativeEntry[];
}

/** Commands that belong in the app menu (macOS puts Settings there, with ⌘,) rather than where the page lists them. */
const APP_MENU = new Set(['tools.options']);

/** Commands the system runs itself, so the editor gets a real clipboard event. */
const ROLES: Record<string, 'cut' | 'copy' | 'paste'> = { 'edit.cut': 'cut', 'edit.copy': 'copy', 'edit.paste': 'paste' };

const KEY_NAMES: Record<string, string> = {
  Enter: 'Enter',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Tab: 'Tab',
  Escape: 'Escape',
  Space: 'Space',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};

/** A shortcut as the system writes it ("Cmd+Shift+B"), or null when it should stay with the page. */
export function acceleratorFor(shortcut: Shortcut | null): string | null {
  if (!shortcut) return null;
  const isFunctionKey = /^F\d{1,2}$/.test(shortcut.key);
  // Without ⌘ or ⌃ it is a key the editor types or moves with, and a menu must not take it.
  if (!shortcut.mod && !shortcut.ctrl && !isFunctionKey) return null;
  // A letter, a digit or punctuation on a US keyboard; anything else the system could not name (it would drop the item's shortcut).
  const key = shortcut.key.length === 1 ? (/^[a-z0-9=\-[\];',./`\\]$/i.test(shortcut.key) ? shortcut.key.toUpperCase() : null) : KEY_NAMES[shortcut.key] ?? (isFunctionKey ? shortcut.key : null);
  if (!key) return null;
  const parts = [shortcut.mod ? 'Cmd' : '', shortcut.ctrl ? 'Ctrl' : '', shortcut.alt ? 'Alt' : '', shortcut.shift ? 'Shift' : '', key].filter(Boolean);
  return parts.join('+');
}

export interface Snapshot {
  menus: NativeTop[];
  /** What each id in the snapshot does, and whether it came with a shortcut (see `NativeMenuSync.run`). */
  actions: Map<string, { run: () => void; shortcut: boolean; command?: string }>;
}

/** The menus as the native side needs them. A menu or item the open format cannot express is left out, as in the page. */
export function snapshotMenus(registry: CommandRegistry, menus: readonly TopMenu[]): Snapshot {
  const actions = new Map<string, { run: () => void; shortcut: boolean; command?: string }>();
  let next = 0;

  const entries = (items: MenuItem[], depth: number): NativeEntry[] => {
    const out: NativeEntry[] = [];
    for (const item of visibleItems(registry, items)) {
      if (item === 'separator') {
        out.push({ kind: 'separator' });
        continue;
      }
      if (item.type === 'heading') {
        // A small label over the rows after it: a row that cannot be chosen.
        out.push({ kind: 'item', id: `h${next++}`, label: stripMnemonic(item.label), enabled: false });
        continue;
      }
      const info = describeItem(registry, item as RowItem);
      const label = stripMnemonic(info.label);
      if (info.submenu) {
        // Menus built when opened (recent documents, samples) are read now; deeper than this is cut off.
        const inner = depth < 3 ? entries(typeof info.submenu === 'function' ? info.submenu() : info.submenu, depth + 1) : [];
        out.push({ kind: 'submenu', label, enabled: info.enabled && inner.length > 0, items: inner });
        continue;
      }
      const command = item.type === 'command' ? registry.get(item.id) : null;
      const role = command ? ROLES[command.id] : undefined;
      const accelerator = !role && command ? acceleratorFor(command.shortcutParsed) : null;
      const id = `n${next++}`;
      const checked = info.role === 'menuitem' ? undefined : info.checked;
      out.push({ kind: 'item', id, label, enabled: info.enabled, ...(checked !== undefined && { checked }), ...(accelerator && { accelerator }), ...(role && { role }), ...(command && APP_MENU.has(command.id) && { appMenu: true }) });
      actions.set(id, { run: info.run, shortcut: accelerator !== null, command: command?.id });
    }
    return out;
  };

  const tops: NativeTop[] = [];
  for (const menu of menus) {
    if (!hasAvailable(registry, menu.items)) continue;
    const items = entries(menu.items, 0);
    if (items.length) tops.push({ label: stripMnemonic(menu.label), items });
  }
  return { menus: tops, actions };
}

const DELAY_MS = 150;

/** What a text field does with the editing shortcuts the menu took from it. */
export type FieldEdit = 'selectAll' | 'undo' | 'redo';
const FIELD_EDITS: Record<string, FieldEdit> = { 'edit.selectAll': 'selectAll', 'edit.undo': 'undo', 'edit.redo': 'redo' };

/** What `NativeMenuSync` asks of the page when a command comes in. */
export interface MenuGuard {
  /** A text field (the title, a dialog's box) has the keyboard. */
  fieldFocused(): boolean;
  /** A dialog is open. */
  dialogOpen(): boolean;
  /** Does in the focused field what the menu took the key for. */
  editField(edit: FieldEdit): void;
}

/** Keeps the native menu bar in step with the page's menus. */
export class NativeMenuSync {
  private snapshot: Snapshot | null = null;
  private last = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private off: (() => void) | null = null;

  constructor(
    private readonly registry: CommandRegistry,
    private readonly menus: () => TopMenu[],
    private readonly native: DesktopMenu,
    private readonly guard: MenuGuard,
  ) {}

  async start(): Promise<void> {
    this.off = await this.native.onClick((id) => this.run(id));
    this.schedule();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.off?.();
    this.off = null;
  }

  /** Something the menus show may have changed: send them again shortly, if they differ. */
  schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.send(), DELAY_MS);
  }

  private async send(): Promise<void> {
    let snapshot: Snapshot;
    try {
      snapshot = snapshotMenus(this.registry, this.menus());
    } catch {
      return; // a menu that cannot be read now is read at the next change
    }
    const text = JSON.stringify(snapshot.menus);
    this.snapshot = snapshot; // ids are only valid with the snapshot they came in
    if (text === this.last) return;
    this.last = text;
    await this.native.set(snapshot.menus).catch(() => {
      this.last = '';
    });
  }

  /**
   * A click, or a shortcut the menu took. Nothing runs while a dialog is open (the page behind it is not what the person
   * is working in). A shortcut does not run the document's command while a text field has the keyboard, as the page's own
   * shortcuts do; Select All, Undo and Redo are done in the field instead.
   * (A click cannot be told from a shortcut, so every item that has one is treated as a possible shortcut.)
   */
  run(id: string): void {
    const action = this.snapshot?.actions.get(id);
    if (!action) return;
    // The menu took the key from the field, so the field's own editing is done here instead of the document's.
    if (action.shortcut && this.guard.fieldFocused()) {
      const edit = action.command ? FIELD_EDITS[action.command] : undefined;
      if (edit) this.guard.editField(edit);
      return;
    }
    if (this.guard.dialogOpen()) return;
    action.run();
  }
}
