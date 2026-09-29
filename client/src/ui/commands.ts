// Commands: the named things menus, toolbars and shortcuts invoke. A command either sends an
// Action to the host or runs something inside the chrome (toggling a toolbar, a dialog). Menus
// and toolbars refer to commands by id, so a label, icon, shortcut or enabled rule is defined
// once and every place that shows the command agrees.

import type { Action, ChromeHost, ChromeState } from './actions.ts';
import { FORMATS, formatAllows } from './formats.ts';
import { formatShortcut, parseShortcut, type Shortcut, type ShortcutSpec } from './shortcuts.ts';
import { stripMnemonic } from './dom.ts';

export interface CommandSpec {
  id: string;
  /** Menu label, with an optional &mnemonic. */
  label: string;
  /** Toolbar tooltip, when it should differ from the label. */
  tooltip?: string;
  icon?: string;
  shortcut?: ShortcutSpec;
  /**
   * The shortcut is only shown: the browser's own handling does the work (clipboard keys, which
   * must reach the hidden textarea as real copy/cut/paste events).
   */
  nativeShortcut?: boolean;
  /** The action sent to the host. */
  action?: Action | ((state: ChromeState) => Action);
  /** Runs in the chrome instead of sending an action. */
  run?: () => void;
  /** Extra condition on top of format and host support. */
  enabled?: (state: ChromeState) => boolean;
  /** Shows a check (checkbox items) / pressed state (toolbar toggles). */
  checked?: (state: ChromeState) => boolean;
  /** Checked items in a group are drawn as radio bullets. */
  radio?: boolean;
}

export interface Command extends CommandSpec {
  shortcutParsed: Shortcut | null;
  shortcutText: string;
  plainLabel: string;
}

export interface CommandContext {
  host: ChromeHost;
  state: () => ChromeState;
  /**
   * Keep commands the format allows but the host hasn't implemented enabled; running one
   * reports that it isn't available yet. Useful while the editor catches up with the UI.
   */
  showUnimplemented: boolean;
}

export class CommandRegistry {
  private readonly commands = new Map<string, Command>();

  constructor(private readonly context: CommandContext) {}

  add(...specs: CommandSpec[]): void {
    for (const spec of specs) {
      if (this.commands.has(spec.id)) throw new Error(`duplicate command ${spec.id}`);
      const shortcutParsed = parseShortcut(spec.shortcut);
      this.commands.set(spec.id, {
        ...spec,
        shortcutParsed,
        shortcutText: shortcutParsed ? formatShortcut(shortcutParsed) : '',
        plainLabel: stripMnemonic(spec.label).replace(/…$/, ''),
      });
    }
  }

  focusEditor(): void {
    this.context.host.focusEditor();
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  get(id: string): Command {
    const command = this.commands.get(id);
    if (!command) throw new Error(`unknown command ${id}`);
    return command;
  }

  all(): Iterable<Command> {
    return this.commands.values();
  }

  actionOf(command: Command): Action | null {
    const { action } = command;
    if (!action) return null;
    return typeof action === 'function' ? action(this.context.state()) : action;
  }

  /** The format can express it and the host implements it (or unimplemented ones are shown). */
  isEnabled(command: Command): boolean {
    const state = this.context.state();
    if (command.enabled && !command.enabled(state)) return false;
    const action = this.actionOf(command);
    if (!action) return true;
    if (!formatAllows(FORMATS[state.kind], action)) return false;
    return this.context.showUnimplemented || this.context.host.supports(action);
  }

  /**
   * Whether the open document's format can express the command at all. Commands it can't are
   * hidden from toolbars and menus (a plain-text document has no fonts to pick); commands it can
   * but that don't apply right now (Undo with nothing to undo) are shown disabled.
   */
  isAvailable(command: Command): boolean {
    const action = this.actionOf(command);
    return !action || formatAllows(FORMATS[this.context.state().kind], action);
  }

  /** As `isAvailable`, for value-carrying actions of combo boxes and color buttons. */
  availableFor(action: Action): boolean {
    return formatAllows(FORMATS[this.context.state().kind], action);
  }

  isChecked(command: Command): boolean {
    return command.checked?.(this.context.state()) ?? false;
  }

  /** Runs a command if it's enabled. Returns whether it ran. */
  execute(id: string | Command, options: { refocus?: boolean } = {}): boolean {
    const command = typeof id === 'string' ? this.get(id) : id;
    if (!this.isEnabled(command)) return false;
    const { host } = this.context;
    if (command.run) {
      command.run();
    } else {
      const action = this.actionOf(command);
      if (action) this.perform(action, command.plainLabel);
    }
    if (options.refocus !== false) host.focusEditor();
    return true;
  }

  /** Sends an action (for controls like the font box whose action carries a value). */
  perform(action: Action, label: string): void {
    const { host } = this.context;
    if (!formatAllows(FORMATS[this.context.state().kind], action)) return;
    if (!host.supports(action)) {
      host.notify(`${label} isn't available yet`);
      return;
    }
    const result = host.perform(action);
    if (result instanceof Promise) result.catch((e: unknown) => host.notify(`${label} failed: ${(e as Error).message ?? e}`));
  }

  /** Whether a value-carrying action is available, for combo boxes and color buttons. */
  allows(action: Action): boolean {
    if (!formatAllows(FORMATS[this.context.state().kind], action)) return false;
    return this.context.showUnimplemented || this.context.host.supports(action);
  }
}
