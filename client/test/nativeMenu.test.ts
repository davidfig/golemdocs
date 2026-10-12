// The macOS menu bar of the desktop app (src/desktop/nativeMenu.ts): the snapshot of the page's menus, and how a click is run.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceleratorFor, NativeMenuSync, snapshotMenus, type NativeEntry } from '../src/desktop/nativeMenu.ts';
import type { DesktopMenu } from '../src/desktop/bridge.ts';
import { DEFAULT_STATE, type Action, type ChromeHost, type ChromeState } from '../src/ui/actions.ts';
import { CommandRegistry } from '../src/ui/commands.ts';
import { cmd, sep, sub, type TopMenu } from '../src/ui/menu.ts';
import type { Shortcut } from '../src/ui/shortcuts.ts';

const shortcut = (key: string, extra: Partial<Shortcut> = {}): Shortcut => ({ mod: false, ctrl: false, shift: false, alt: false, key, ...extra });

function setup(state: Partial<ChromeState> = {}) {
  const performed: Action[] = [];
  const host = { supports: () => true, perform: (a: Action) => void performed.push(a), notify: () => {}, focusEditor: () => {} } as unknown as ChromeHost;
  const current: ChromeState = { ...DEFAULT_STATE, ...state };
  const registry = new CommandRegistry({ host, state: () => current, showUnimplemented: true });
  registry.add(
    { id: 'file.new', label: '&New', action: { kind: 'new' }, shortcut: 'Mod+N' },
    { id: 'file.vault', label: 'Vault Folder…', action: { kind: 'dialog', name: 'vault' }, visible: () => false },
    { id: 'edit.copy', label: '&Copy', action: { kind: 'copy' }, shortcut: 'Mod+C', nativeShortcut: true },
    { id: 'edit.bold', label: '&Bold', action: { kind: 'new' }, shortcut: 'Mod+B', checked: (s) => s.hasSelection },
    { id: 'edit.lineBreak', label: 'Line Break', action: { kind: 'new' }, shortcut: 'Shift+Enter', nativeShortcut: true },
    { id: 'tools.disabled', label: 'Disabled', action: { kind: 'new' }, enabled: () => false },
  );
  return { registry, performed };
}

const find = (entries: NativeEntry[], label: string): NativeEntry | undefined => entries.find((e) => e.kind !== 'separator' && e.label === label);

test('shortcuts become system accelerators only when they cannot be a typed key', () => {
  assert.equal(acceleratorFor(shortcut('b', { mod: true })), 'Cmd+B');
  assert.equal(acceleratorFor(shortcut('z', { mod: true, shift: true })), 'Cmd+Shift+Z');
  assert.equal(acceleratorFor(shortcut('=', { mod: true })), 'Cmd+=');
  assert.equal(acceleratorFor(shortcut('Enter', { mod: true })), 'Cmd+Enter');
  assert.equal(acceleratorFor(shortcut('k', { ctrl: true, alt: true })), 'Ctrl+Alt+K');
  assert.equal(acceleratorFor(shortcut('F7')), 'F7');
  assert.equal(acceleratorFor(shortcut('Enter', { shift: true })), null, 'Shift+Enter stays a key press in the editor');
  assert.equal(acceleratorFor(shortcut('v')), null, 'a bare letter is a drawing tool');
  assert.equal(acceleratorFor(shortcut('ß', { mod: true })), null, 'not a key the system names');
  assert.equal(acceleratorFor(shortcut('Insert', { mod: true })), null, 'a key the system has no name for');
  assert.equal(acceleratorFor(null), null);
});

test('the snapshot has the labels without mnemonics, shortcuts, and checked states', () => {
  const { registry } = setup({ hasSelection: true });
  const menus: TopMenu[] = [{ label: '&File', items: [cmd('file.new'), sep, cmd('edit.bold'), cmd('tools.disabled')] }];
  const { menus: out } = snapshotMenus(registry, menus);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.label, 'File');
  assert.deepEqual(find(out[0]!.items, 'New'), { kind: 'item', id: 'n0', label: 'New', enabled: true, accelerator: 'Cmd+N' });
  const bold = find(out[0]!.items, 'Bold') as Extract<NativeEntry, { kind: 'item' }>;
  assert.equal(bold.checked, true);
  assert.equal(bold.accelerator, 'Cmd+B');
  assert.equal((find(out[0]!.items, 'Disabled') as Extract<NativeEntry, { kind: 'item' }>).enabled, false);
  assert.equal(out[0]!.items[1]!.kind, 'separator');
});

test('Copy is a system item, and a shortcut that is a plain key is left to the page', () => {
  const { registry } = setup();
  const { menus } = snapshotMenus(registry, [{ label: 'Edit', items: [cmd('edit.copy'), cmd('edit.lineBreak')] }]);
  const copy = find(menus[0]!.items, 'Copy') as Extract<NativeEntry, { kind: 'item' }>;
  assert.equal(copy.role, 'copy');
  assert.equal(copy.accelerator, undefined, 'the system item brings its own');
  const lineBreak = find(menus[0]!.items, 'Line Break') as Extract<NativeEntry, { kind: 'item' }>;
  assert.equal(lineBreak.accelerator, undefined);
});

test('what the open format cannot use is left out, and so is a menu with nothing left', () => {
  const { registry } = setup();
  const { menus } = snapshotMenus(registry, [
    { label: 'File', items: [cmd('file.new'), cmd('file.vault')] },
    { label: 'Empty', items: [cmd('file.vault')] },
  ]);
  assert.deepEqual(menus.map((m) => m.label), ['File']);
  assert.equal(find(menus[0]!.items, 'Vault Folder…'), undefined);
});

test('submenus are read when the snapshot is made, headings cannot be chosen, and one-off items work', () => {
  const { registry } = setup();
  let ran = 0;
  const { menus, actions } = snapshotMenus(registry, [
    {
      label: 'File',
      items: [
        { type: 'heading', label: 'Recent' },
        sub('Open &Recent', () => [{ type: 'item', label: 'a.md', run: () => void ran++ }]),
        sub('Nothing', () => []),
      ],
    },
  ]);
  const [heading, recent, nothing] = menus[0]!.items as [NativeEntry, Extract<NativeEntry, { kind: 'submenu' }>, Extract<NativeEntry, { kind: 'submenu' }>];
  assert.equal((heading as Extract<NativeEntry, { kind: 'item' }>).enabled, false);
  assert.equal(recent.label, 'Open Recent');
  assert.equal(recent.items.length, 1);
  assert.equal(nothing.enabled, false, 'an empty submenu is greyed out');
  const id = (recent.items[0] as Extract<NativeEntry, { kind: 'item' }>).id;
  actions.get(id)!.run();
  assert.equal(ran, 1);
});

/** A native side in memory. */
function fakeNative() {
  const sent: unknown[] = [];
  let click: ((id: string) => void) | null = null;
  const native: DesktopMenu = {
    async set(menus) {
      sent.push(menus);
    },
    async onClick(callback) {
      click = callback;
      return () => {
        click = null;
      };
    },
  };
  return { native, sent, clickItem: (id: string) => click?.(id), listening: () => click !== null };
}

test('a click runs its command, but not while a dialog is open or, for a shortcut, a text field has the keys', async () => {
  const { registry, performed } = setup();
  const fake = fakeNative();
  const state = { dialog: false, field: false };
  const edits: string[] = [];
  const guard = { fieldFocused: () => state.field, dialogOpen: () => state.dialog, editField: (e: string) => void edits.push(e) };
  const sync = new NativeMenuSync(registry, () => [{ label: 'File', items: [cmd('file.new'), cmd('tools.disabled')] }], fake.native, guard);
  await sync.start();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(fake.sent.length, 1);
  const items = (fake.sent[0] as { items: { id: string; label: string }[] }[])[0]!.items;
  const idOf = (label: string) => items.find((i) => i.label === label)!.id;

  fake.clickItem(idOf('New'));
  assert.equal(performed.length, 1);
  state.field = true;
  fake.clickItem(idOf('New'));
  assert.equal(performed.length, 1, 'New has a shortcut, so a text field keeps the key');
  assert.deepEqual(edits, []);
  state.dialog = true;
  fake.clickItem(idOf('Disabled'));
  assert.equal(performed.length, 1, 'nothing runs behind a dialog');
  fake.clickItem('unknown');
  sync.stop();
  assert.equal(fake.listening(), false);
});

test('Select All with a text field focused selects the field’s text, even in a dialog', async () => {
  const { registry, performed } = setup();
  registry.add({ id: 'edit.selectAll', label: 'Select All', action: { kind: 'selectAll' }, shortcut: 'Mod+A' });
  const fake = fakeNative();
  const edits: string[] = [];
  const state = { dialog: true, field: true };
  const sync = new NativeMenuSync(registry, () => [{ label: 'Edit', items: [cmd('edit.selectAll')] }], fake.native, { fieldFocused: () => state.field, dialogOpen: () => state.dialog, editField: (e) => void edits.push(e) });
  await sync.start();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const id = (fake.sent[0] as { items: { id: string }[] }[])[0]!.items[0]!.id;
  fake.clickItem(id);
  assert.deepEqual(edits, ['selectAll']);
  assert.equal(performed.length, 0, 'the document is not touched');
  state.field = false;
  state.dialog = false;
  fake.clickItem(id);
  assert.equal(performed.length, 1, 'in the document it is the document’s command');
  sync.stop();
});

test('the menus are sent again only when they changed', async () => {
  const { registry } = setup();
  const fake = fakeNative();
  const state = { label: 'File' };
  const sync = new NativeMenuSync(registry, () => [{ label: state.label, items: [cmd('file.new')] }], fake.native, { fieldFocused: () => false, dialogOpen: () => false, editField: () => {} });
  await sync.start();
  await new Promise((resolve) => setTimeout(resolve, 250));
  sync.schedule();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(fake.sent.length, 1, 'same menus, nothing sent');
  state.label = 'Fichier';
  sync.schedule();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(fake.sent.length, 2);
  sync.stop();
});
