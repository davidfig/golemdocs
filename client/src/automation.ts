// The automation API: `window.golem`, one documented way for an agent (or an end-to-end test) to drive the running app and read
// what it shows. Everything goes through what the app already has: commands run through the CommandRegistry exactly as a menu
// item would (so they are refused when disabled), the document is read through the layout worker, and dialogs are read from the
// DOM by their accessible names. See docs/architecture/automation.md.
//
// It is for checking work and for reading context, not a second UI: a test of a feature still clicks and types through the real
// controls, and uses this to set up and to read the result.

import type { OutlineNode } from './layout/a11y.ts';
import type { ChromeState } from './ui/actions.ts';
import type { Command, CommandRegistry } from './ui/commands.ts';

export const AUTOMATION_VERSION = 1;

/** What main.ts gives the API. */
export interface AutomationContext {
  registry: CommandRegistry;
  loaded: () => boolean;
  status: () => string;
  selection: () => { text: string; caret: unknown };
  /** The open document's paragraphs, or null when it has none (a PDF, a plain text file, a workbook). */
  outline: () => Promise<OutlineNode[] | null>;
  /** The open document as plain text, or as Markdown; rejects when its kind can't be written that way. */
  text: () => Promise<string>;
  markdown: () => Promise<string>;
  /** Selects in paragraph `paragraph` (an index from `outline`) from `from` to `to` (model offsets). */
  select: (paragraph: number, from: number, to: number) => void;
  /** Opens a document by its source (`local:<id>`, a sample's name such as `welcome`). */
  open: (source: string) => void;
  /** How many documents have begun opening so far. */
  opensBegun: () => number;
  /** Resolves once the layout worker has handled every message sent so far. */
  ping: () => Promise<void>;
}

export interface CommandInfo {
  id: string;
  label: string;
  shortcut: string;
  /** It would run now. */
  enabled: boolean;
  /** The open document's format can express it at all (menus hide it when not). */
  available: boolean;
  checked: boolean;
}

export interface DialogField {
  label: string;
  /** The input's type, or the ARIA role of a custom control. */
  type: string;
  value: string;
  checked?: boolean;
  disabled?: boolean;
}

export interface DialogInfo {
  title: string;
  /** A modal `<dialog>`, or a card over the document (role="dialog"). */
  modal: boolean;
  fields: DialogField[];
  buttons: { label: string; disabled: boolean }[];
}

export interface AutomationState {
  document: string;
  kind: ChromeState['kind'];
  nothingOpen: boolean;
  loaded: boolean;
  status: string;
  zoom: number;
  viewMode: ChromeState['viewMode'];
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  inTable: boolean;
  format: ChromeState['format'];
}

export interface GolemAutomation {
  version: number;
  help(): string;
  state(): AutomationState;
  commands: {
    list(filter?: string): CommandInfo[];
    run(id: string): boolean;
  };
  doc: {
    outline(): Promise<OutlineNode[] | null>;
    text(): Promise<string>;
    markdown(): Promise<string>;
    select(paragraph: number, from?: number, to?: number): Promise<void>;
    open(source: string, timeoutMs?: number): Promise<void>;
  };
  selection(): { text: string; caret: unknown };
  dialogs(): DialogInfo[];
  waitIdle(timeoutMs?: number): Promise<void>;
}

const HELP = `window.golem — the golemdocs automation API (version ${AUTOMATION_VERSION})

golem.state()                     the open document, its kind, zoom, view, undo state and the selection's format
golem.commands.list(filter?)      every command: id, label, shortcut, enabled, available, checked (filter matches id or label)
golem.commands.run(id)            runs a command as its menu item would; false when it is disabled now
golem.doc.outline()               the document's paragraphs: index, kind (heading/item/paragraph), level, text, table cell
golem.doc.text()                  the whole document as plain text
golem.doc.markdown()              the whole document as Markdown (word processing documents)
golem.doc.select(p, from?, to?)   selects in paragraph p (an outline index), from/to as offsets in it; waits for it
golem.doc.open(source)            opens a document ("welcome", "local:<id>", ...) and waits until it is laid out
golem.selection()                 the selected text and the caret
golem.dialogs()                   open dialogs and cards: title, fields (label, value), buttons
golem.waitIdle(timeoutMs?)        resolves once the document is loaded, the layout worker has caught up and a frame is drawn

Commands run through the same checks as the menus. Read results back with outline(), text() or dialogs(); for
anything a person does with the pointer or keys, drive the real controls (they have accessible names and roles).`;

/** The registry's commands as plain data, those whose id or label contain `filter` (any case). */
export function listCommands(registry: CommandRegistry, filter?: string): CommandInfo[] {
  const wanted = filter?.trim().toLowerCase();
  const out: CommandInfo[] = [];
  for (const command of registry.all()) {
    if (wanted && !command.id.toLowerCase().includes(wanted) && !command.plainLabel.toLowerCase().includes(wanted)) continue;
    out.push(commandInfo(registry, command));
  }
  return out;
}

function commandInfo(registry: CommandRegistry, command: Command): CommandInfo {
  return {
    id: command.id,
    label: command.plainLabel,
    shortcut: command.shortcutText,
    enabled: registry.isAvailable(command) && registry.isEnabled(command),
    available: registry.isAvailable(command),
    checked: registry.isChecked(command),
  };
}

/** Runs a command by id; an unknown id throws, naming the commands it might have meant. */
export function runCommand(registry: CommandRegistry, id: string): boolean {
  if (!registry.has(id)) {
    const near = nearIds(id, [...registry.all()].map((c) => c.id));
    throw new Error(`unknown command "${id}"${near.length ? `; did you mean ${near.join(', ')}?` : ''} (golem.commands.list() lists them all)`);
  }
  const command = registry.get(id);
  if (!registry.isAvailable(command)) return false;
  return registry.execute(command);
}

/** Ids close to a mistyped one: those sharing its last part, or a few edits away, closest first. */
export function nearIds(id: string, ids: string[]): string[] {
  const wanted = id.toLowerCase();
  const word = wanted.split('.').pop()!;
  return ids
    .map((other) => ({ other, d: other.toLowerCase().endsWith(`.${word}`) ? 0 : editDistance(wanted, other.toLowerCase()) }))
    .filter(({ d }) => d <= Math.max(2, Math.floor(wanted.length / 4)))
    .sort((a, b) => a.d - b.d)
    .slice(0, 8)
    .map(({ other }) => other);
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

const clean = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();

/** An element's accessible name, as far as a page can work it out: aria-label, aria-labelledby, a <label>, then its text. */
export function accessibleName(el: Element): string {
  const label = el.getAttribute('aria-label');
  if (label) return clean(label);
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const text = by
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent)
      .filter(Boolean)
      .join(' ');
    if (clean(text)) return clean(text);
  }
  const labels = (el as HTMLInputElement).labels;
  if (labels?.length) return clean([...labels].map((l) => l.textContent).join(' '));
  if (el instanceof HTMLInputElement && (el.type === 'button' || el.type === 'submit')) return clean(el.value);
  const text = clean(el.textContent);
  if (text) return text;
  return clean(el.getAttribute('title') ?? el.getAttribute('placeholder'));
}

const FIELD_ROLES = ['checkbox', 'radio', 'switch', 'combobox', 'listbox', 'slider', 'spinbutton', 'textbox', 'tab', 'menuitemcheckbox'];
const FIELDS = `input:not([type=hidden]):not([type=button]):not([type=submit]), textarea, select, ${FIELD_ROLES.map((r) => `[role=${r}]`).join(', ')}`;

function visible(el: Element): boolean {
  const html = el as HTMLElement;
  if (html.hidden || el.closest('[hidden], [aria-hidden=true]')) return false;
  return !('getClientRects' in el) || el.getClientRects().length > 0;
}

function fieldOf(el: Element): DialogField {
  const role = el.getAttribute('role');
  const type = role ?? (el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase());
  const field: DialogField = { label: '', type, value: '' };
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    field.label = accessibleName(el);
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) field.checked = el.checked;
    else field.value = el.value;
    if (el.disabled) field.disabled = true;
  } else {
    // A custom control: its name is its label, unless it shows its value as its text (a drop-down button), when the label is elsewhere.
    const label = el.getAttribute('aria-label') ?? '';
    field.label = clean(label) || accessibleName(el);
    field.value = role === 'listbox' ? clean(el.querySelector('[aria-selected=true]')?.textContent) : clean(el.getAttribute('aria-valuetext') ?? el.getAttribute('aria-valuenow') ?? (label ? el.textContent : ''));
    const checked = el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed') ?? el.getAttribute('aria-selected');
    if (checked !== null) field.checked = checked === 'true';
    if (el.getAttribute('aria-disabled') === 'true') field.disabled = true;
  }
  return field;
}

/** The dialogs and in-document cards open in `root`, with their fields and buttons. */
export function listDialogs(root: ParentNode = document): DialogInfo[] {
  const out: DialogInfo[] = [];
  for (const el of root.querySelectorAll('dialog[open], [role=dialog]:not(dialog), [role=alertdialog]:not(dialog)')) {
    if (!visible(el)) continue;
    // A card inside a dialog is listed on its own.
    const nested = (x: Element): boolean => x.closest('dialog[open], [role=dialog], [role=alertdialog]') === el;
    const title = clean(el.getAttribute('aria-label')) || accessibleName(el.querySelector('.wm-dialog-title, h1, h2, h3') ?? el).slice(0, 120);
    const fields = [...el.querySelectorAll(FIELDS)].filter((f) => nested(f) && visible(f)).map(fieldOf);
    const buttons = [...el.querySelectorAll('button, [role=button], input[type=button], input[type=submit]')]
      .filter((b) => nested(b) && visible(b) && b.getAttribute('role') !== 'tab' && !b.matches(FIELDS))
      .map((b) => ({ label: accessibleName(b), disabled: (b as HTMLButtonElement).disabled === true || b.getAttribute('aria-disabled') === 'true' }));
    out.push({ title, modal: el instanceof HTMLDialogElement && el.matches(':modal'), fields, buttons });
  }
  return out;
}

/** A frame, or a short wait when no frame comes (a hidden tab draws none). */
const frame = (): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, 100);
  requestAnimationFrame(() => {
    clearTimeout(timer);
    resolve();
  });
});

export function createAutomation(context: AutomationContext): GolemAutomation {
  const { registry } = context;

  async function waitIdle(timeoutMs = 30_000): Promise<void> {
    const until = performance.now() + timeoutMs;
    while (!context.loaded()) {
      if (performance.now() > until) throw new Error(`golem.waitIdle: the document did not finish loading in ${timeoutMs} ms (status: ${context.status() || 'none'})`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await context.ping();
    await frame();
    await frame();
  }

  return {
    version: AUTOMATION_VERSION,
    help: () => HELP,
    state() {
      const s = registry.state();
      return {
        document: s.documentName,
        kind: s.kind,
        nothingOpen: s.nothingOpen,
        loaded: context.loaded(),
        status: context.status(),
        zoom: s.zoom,
        viewMode: s.viewMode,
        canUndo: s.canUndo,
        canRedo: s.canRedo,
        hasSelection: s.hasSelection,
        inTable: s.inTable,
        format: s.format,
      };
    },
    commands: {
      list: (filter) => listCommands(registry, filter),
      run: (id) => runCommand(registry, id),
    },
    doc: {
      outline: () => context.outline(),
      text: () => context.text(),
      markdown: () => context.markdown(),
      async select(paragraph, from = 0, to = from) {
        context.select(paragraph, from, to);
        await waitIdle();
      },
      async open(source, timeoutMs = 30_000) {
        // The source is read (perhaps fetched) before the document begins to open and `loaded` is cleared: wait for that first.
        const before = context.opensBegun();
        const until = performance.now() + timeoutMs;
        context.open(source);
        while (context.opensBegun() === before) {
          if (performance.now() > until) throw new Error(`golem.doc.open: "${source}" did not begin to open in ${timeoutMs} ms (status: ${context.status() || 'none'})`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await waitIdle(Math.max(until - performance.now(), 1000));
      },
    },
    selection: () => context.selection(),
    dialogs: () => listDialogs(),
    waitIdle,
  };
}

/** Puts the API on `window.golem`. */
export function installAutomation(context: AutomationContext): GolemAutomation {
  const golem = createAutomation(context);
  Object.defineProperty(window, 'golem', { value: golem, configurable: true });
  return golem;
}
