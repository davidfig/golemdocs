// The application chrome: menu bar plus the Standard and Formatting toolbars, in the classic
// (pre-ribbon) arrangement. This file is the catalog: which commands exist, where they appear
// and which shortcuts they take. Behavior lives in the host (see actions.ts), availability in
// the format profiles (formats.ts), mechanics in menu.ts and toolbar.ts.

import {
  DEFAULT_STATE,
  type Action,
  type Alignment,
  type CaseChange,
  type ChromeHost,
  type ChromeState,
  type ImageOp,
  type Mark,
  type TableOp,
  type ZoomTarget,
} from './actions.ts';
import { CommandRegistry, type Command, type CommandSpec } from './commands.ts';
import { h, isFormField, modalOpen, segmented } from './dom.ts';
import { format, getLocale, setLocale, t, type MessageKey } from '../i18n/index.ts';
import { LOCALES } from '../i18n/locales.ts';
import { BRUSH_GROUPS, BRUSH_PRESETS, DASHES } from '../vector/brushPresets.ts';
import { brushPreview } from './brushPreview.ts';
import { dropdown, lineSample } from './dropdown.ts';
import { shapePreview } from './shapePreview.ts';
import { SHAPE_IDS } from '../vector/shapes.ts';
import { CONVERT_ORDER, FORMATS, PICTURE_CONVERT_ORDER, VECTOR_CONVERT_ORDER, convertTargets, formatGroup } from './formats.ts';
import { billingPanel } from './billingPanel.ts';
import { analyticsPanel } from './analyticsPanel.ts';
import { feedbackPanel, showFeedbackDialog } from './feedback.ts';
import { MenuBar, cmd, sep, sub, type MenuItem, type TopMenu } from './menu.ts';
import type { DrawerEntry } from './menuDrawer.ts';
import { closePopup, openPopup, popupOpenFor, setPopupLayer, showConfirm, showDialog } from './popup.ts';
import { isUsableShortcut, matches, shortcutFromEvent, type Shortcut } from './shortcuts.ts';
import { Toolbar, btn, colorButton, comboBox, control, tableGridButton, tsep, type Control, type PaletteControl, type ToolbarItem } from './toolbar.ts';
import { debugSettings } from './debugSettings.ts';
import { autoFormatOn, setAutoFormat } from './autoFormat.ts';
import { lockGuidesOn, selectAfterPencilOn, setLockGuides, setSelectAfterPencil, setShowGuides, showGuidesOn } from './drawingOptions.ts';
import { livePreviewOn, setLivePreview } from './livePreview.ts';
import { SCHEMES, currentAppearance, currentScheme, isDark, pagesDark, setAppearance, setScheme, toggleDark, toggleDarkPages } from './theme.ts';
import { showCustomize, type CatalogItem } from './customize.ts';
import { ICONS, iconElement } from './icons.ts';
import { CommandPalette } from './commandPalette.ts';
import { AccountButton } from './accountButton.ts';
import { SyncButton } from './syncButton.ts';
import { DocumentTitle } from './documentTitle.ts';
import { displayDocumentName } from '../documentName.ts';
import { DEFAULT_LAYOUT, MOBILE_PRIMARY, SEPARATOR, loadLayout, saveLayout, type ToolbarLayout } from './toolbarLayout.ts';
import './ui.css';

export interface ChromeOptions {
  host: ChromeHost;
  /**
   * Leave commands the document's format supports enabled even when the host hasn't
   * implemented them yet; they report "isn't available yet". Default false.
   */
  showUnimplemented?: boolean;
  /** Whether the signed-in user is an admin; admin-only menu items are left out otherwise. */
  isAdmin?: () => boolean;
  /** For the window title and About box. Default "Golem Docs". */
  appName?: string;
}

const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];
const zoomPresets = (): { label: string; to: ZoomTarget }[] => [
  { label: '500%', to: 5 },
  { label: '200%', to: 2 },
  { label: '150%', to: 1.5 },
  { label: '100%', to: 1 },
  { label: '75%', to: 0.75 },
  { label: '50%', to: 0.5 },
  { label: '25%', to: 0.25 },
  { label: '10%', to: 0.1 },
  { label: t('chrome.zoom.pageWidth'), to: 'pageWidth' },
  { label: t('chrome.zoom.wholePage'), to: 'wholePage' },
  { label: t('chrome.zoom.allPages'), to: 'allPages' },
];
const DEFAULT_FONTS = ['Arial', 'Calibri', 'Cambria', 'Comic Sans MS', 'Courier New', 'Georgia', 'JetBrains Mono', 'Segoe UI', 'Times New Roman'];
const symbols = (): [string, string][] => [
  ['©', t('chrome.symbol.copyright')],
  ['®', t('chrome.symbol.registered')],
  ['™', t('chrome.symbol.trademark')],
  ['§', t('chrome.symbol.section')],
  ['¶', t('chrome.symbol.paragraph')],
  ['…', t('chrome.symbol.ellipsis')],
  ['—', t('chrome.symbol.emdash')],
  ['–', t('chrome.symbol.endash')],
  ['•', t('chrome.symbol.bullet')],
  ['°', t('chrome.symbol.degree')],
  ['±', t('chrome.symbol.plusminus')],
  ['×', t('chrome.symbol.multiply')],
  ['÷', t('chrome.symbol.divide')],
  ['€', t('chrome.symbol.euro')],
  ['£', t('chrome.symbol.pound')],
  ['¥', t('chrome.symbol.yen')],
];

/** The language picker's entries: each language by its own name. The UI is built once, so a change reloads it. */
const languageItems = (): MenuItem[] =>
  Object.entries(LOCALES).map(([id, info]) => ({
    type: 'item',
    label: info.name,
    checked: id === getLocale(),
    run: () => {
      if (id !== getLocale()) void setLocale(id).then(() => location.reload());
    },
  }));

export class Chrome {
  readonly el: HTMLDivElement;
  readonly registry: CommandRegistry;
  private state: ChromeState = DEFAULT_STATE;
  private readonly menuBar: MenuBar;
  private readonly toolbars: Toolbar[] = [];
  private readonly toolbarsEl: HTMLDivElement;
  private readonly layer: HTMLDivElement;
  private fonts: string[] = DEFAULT_FONTS;
  private recentFonts: string[] = [];
  private readonly appName: string;
  /** Controls that can be placed on toolbars besides command buttons (the font box…). */
  private readonly controls = new Map<string, { label: string; category: string; icon: string; create: () => Control }>();
  private layout: ToolbarLayout[];
  /** The "Format" selector at the right of the menu bar. */
  private readonly formatBox: HTMLElement;
  private formatCombo!: Control;
  /** A format conversion is in flight. */
  private converting = false;
  /** Whether the document is saved (or, signed out, an offer to sign in), at the far right. */
  private syncButton!: SyncButton;
  private accountButton!: AccountButton;
  /** The command palette button, left of the format selector. */
  private palette!: CommandPalette;
  /** The document's name in the middle of the menu bar. */
  private docTitle!: DocumentTitle;

  constructor(private readonly options: ChromeOptions) {
    const { host } = options;
    this.appName = options.appName ?? 'Golem Docs';
    this.registry = new CommandRegistry({ host, state: () => this.state, showUnimplemented: options.showUnimplemented ?? false });
    this.registerCommands();
    this.defineControls();
    this.layout = loadLayout((id) => this.controls.has(id) || this.registry.has(id));

    this.layer = h('div', { class: 'wm-layer' });
    document.body.append(this.layer);
    setPopupLayer(this.layer);

    this.menuBar = new MenuBar(this.registry, this.menus(), this.layer, () => this.mobileMenu());
    this.toolbarsEl = h('div', { class: 'wm-toolbars' });
    this.toolbarsEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.customize();
    });
    this.formatBox = this.buildFormatBox();
    this.docTitle = new DocumentTitle(this.menuBar.el, this.formatBox, (name) => host.renameDocument(name), () => host.focusEditor());
    this.el = h('div', { class: 'wm-chrome' }, this.menuBar.el, this.docTitle.el, this.formatBox, this.toolbarsEl);
    this.buildToolbars();

    window.addEventListener('keydown', (e) => this.shortcut(e), true);
    document.addEventListener('fullscreenchange', () => this.refresh());

    const fonts = host.fonts?.();
    if (fonts) {
      void Promise.resolve(fonts)
        .then((list) => {
          if (list.length) this.fonts = [...list].sort((a, b) => a.localeCompare(b));
        })
        .catch(() => {});
    }
    this.refresh();
  }

  /** Merges application state; controls are refreshed only when something changed. */
  update(partial: Partial<ChromeState>): void {
    let changed = false;
    for (const key of Object.keys(partial) as (keyof ChromeState)[]) {
      const next = partial[key];
      const prev = this.state[key];
      if (next === prev) continue;
      if ((key === 'format' || key === 'sync') && JSON.stringify(next) === JSON.stringify(prev)) continue;
      changed = true;
    }
    if (!changed) return;
    this.state = { ...this.state, ...partial };
    this.refresh();
    this.onFillChange?.();
  }

  /** Redraws the Fill popup's gradient editor while it is open. */
  private onFillChange: (() => void) | null = null;

  getState(): ChromeState {
    return this.state;
  }

  /** The zoom box's list of sizes, shown by `owner` (the status bar's zoom); a second click closes it. */
  showZoomList(owner: HTMLElement): void {
    if (popupOpenFor(owner)) return closePopup();
    const current = `${Math.round(this.state.zoom * 100)}%`;
    const list = h('div', { class: 'wm-list', attrs: { role: 'listbox', 'aria-label': t('chrome.control.zoom') } });
    for (const preset of zoomPresets()) {
      const chosen = preset.label === current;
      const row = h('div', { class: chosen ? 'wm-option active' : 'wm-option', text: preset.label, attrs: { role: 'option', 'aria-selected': String(chosen) } });
      row.addEventListener('pointerenter', () => {
        for (const other of list.children) other.classList.toggle('active', other === row);
      });
      row.addEventListener('click', () => {
        closePopup();
        this.registry.perform({ kind: 'zoom', to: preset.to }, t('chrome.perform.zoom'));
        this.options.host.focusEditor();
      });
      list.append(row);
    }
    openPopup(owner, list);
  }

  /** Who is signed in changed: the Admin menu appears or goes. */
  accountChanged(): void {
    this.menuBar.refresh();
  }

  /** The toolbars' row goes when the toolbars are turned off, or when none of them has anything to show. */
  private syncToolbarsHidden(): void {
    this.toolbarsEl.hidden = !this.state.toolbars || this.toolbars.every((t) => t.el.hidden || t.el.classList.contains('wm-mobile-only'));
  }

  private refresh(): void {
    for (const toolbar of this.toolbars) toolbar.refresh(this.state);
    this.syncToolbarsHidden();
    this.menuBar.refresh();
    this.syncFormatBox();
    this.syncButton.update(this.state.sync);
    this.accountButton.update(this.state.sync, this.state.subscription);
    const name = this.state.documentName;
    this.docTitle.show(displayDocumentName(name, this.state.kind), this.state.renamable);
    this.docTitle.setPeople(this.state.people);
    const title = name ? `${name} - ${this.appName}` : this.appName;
    if (document.title !== title) document.title = title;
  }

  private shortcut(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.isComposing || this.menuBar.active) return;
    if (isFormField(e.target) || modalOpen()) return;
    // The Documents screen covers the editor and has its own keys (Ctrl/Cmd+A selects its cards).
    if (document.querySelector('.wm-dashboard:not([hidden])')) return;
    // The vector editor's own keys come first and may be bare letters (V, P…); they only claim a
    // key they can act on, so typing elsewhere is never swallowed.
    const scope = FORMATS[this.state.kind].vectorTools ? 'vector' : FORMATS[this.state.kind].imageTools ? 'picture' : null;
    if (scope && !e.repeat) {
      for (const command of this.registry.all()) {
        if (command.scope !== scope || !command.shortcutParsed || !matches(command.shortcutParsed, e)) continue;
        if (!this.registry.isAvailable(command) || !this.registry.isEnabled(command)) continue;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.registry.execute(command);
        return;
      }
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !/^F\d+$/.test(e.key)) return;
    for (const command of this.registry.all()) {
      if (command.scope || !command.shortcutParsed || command.nativeShortcut || !matches(command.shortcutParsed, e)) continue;
      // The key belongs to the command even when it's disabled: the browser mustn't act on it
      // (Ctrl+B, Ctrl+P…) and neither must the document (Ctrl+Enter isn't a paragraph break).
      e.preventDefault();
      e.stopImmediatePropagation();
      this.registry.execute(command);
      return;
    }
  }

  // --- Commands ----------------------------------------------------------------------------

  private registerCommands(): void {
    const r = this.registry;
    const a = (id: string, label: string, action: Action, extra: Partial<CommandSpec> = {}): CommandSpec => ({ id, label, action, ...extra });
    const dialog = (id: string, label: string, name: Extract<Action, { kind: 'dialog' }>['name'], extra: Partial<CommandSpec> = {}) =>
      a(id, label, { kind: 'dialog', name }, extra);

    // File
    r.add(
      a('file.new', t('chrome.file.new'), { kind: 'new' }, { icon: 'new', tooltip: t('chrome.file.new.tip') }),
      a('file.open', t('chrome.file.open'), { kind: 'open' }, { icon: 'open', shortcut: 'Mod+O', tooltip: t('chrome.file.open.tip') }),
      a('file.import', t('chrome.file.import'), { kind: 'import' }, { tooltip: t('chrome.file.import.tip') }),
      a('file.importFolder', t('chrome.file.importFolder'), { kind: 'importFolder' }, { tooltip: t('chrome.file.importFolder.tip') }),
      a('file.download', t('chrome.file.download'), { kind: 'download' }, { tooltip: t('chrome.file.download.tip') }),
      a('file.downloadAll', t('chrome.file.downloadAll'), { kind: 'downloadAll' }, { tooltip: t('chrome.file.downloadAll.tip') }),
      a('file.openSelection', t('chrome.file.openSelection'), { kind: 'openSelection' }, { tooltip: t('chrome.file.openSelection.tip'), visible: (s) => s.kind === 'largetext', enabled: (s) => s.hasSelection }),
      a('file.share', t('chrome.file.share'), { kind: 'share' }, { tooltip: t('chrome.file.share.tip') }),
      dialog('file.pageSetup', t('chrome.file.pageSetup'), 'pageSetup'),
      a('file.printPreview', t('chrome.file.printPreview'), { kind: 'printPreview' }, { icon: 'printPreview' }),
      a('file.print', t('chrome.file.print'), { kind: 'print' }, { icon: 'print', shortcut: 'Mod+P' }),
      { id: 'file.rename', label: t('chrome.file.rename'), tooltip: t('chrome.file.rename.tip'), run: () => this.renameDocument(), enabled: (s) => s.renamable },
      dialog('file.properties', t('chrome.file.properties'), 'properties', { icon: 'properties' }),
      dialog('file.versionHistory', t('history.menu'), 'versionHistory', { tooltip: t('history.menu.tip') }),
      dialog('file.trash', t('history.trashMenu'), 'trash', { tooltip: t('history.trashMenu.tip') }),
      a('file.clearLocalData', t('chrome.file.clearLocalData'), { kind: 'clearLocalData' }, { tooltip: t('chrome.file.clearLocalData.tip') }),
      // Signed out, Subscribe signs in first. Once subscribed, the same place manages it.
      a('file.subscribe', t('chrome.file.subscribe'), { kind: 'subscribe' }, { tooltip: t('chrome.file.subscribe.tip'), visible: (s) => s.subscription !== 'active' }),
      a('file.manageSubscription', t('chrome.file.manageSubscription'), { kind: 'manageSubscription' }, { tooltip: t('chrome.file.manageSubscription.tip'), visible: (s) => s.subscription === 'active' }),
    );
    for (const kind of new Set([...CONVERT_ORDER, ...PICTURE_CONVERT_ORDER, ...VECTOR_CONVERT_ORDER])) {
      const profile = FORMATS[kind];
      r.add(a(`file.convertTo.${kind}`, `${profile.label} (${profile.extensions[0]})`, { kind: 'convert', to: kind }, { enabled: (s) => s.kind !== kind }));
    }

    // Edit
    r.add(
      a('edit.undo', t('chrome.edit.undo'), { kind: 'undo' }, { icon: 'undo', shortcut: 'Mod+Z', enabled: (s) => s.canUndo }),
      a('edit.redo', t('chrome.edit.redo'), { kind: 'redo' }, { icon: 'redo', shortcut: { mac: 'Mod+Shift+Z', other: 'Mod+Y' }, enabled: (s) => s.canRedo }),
      a('edit.cut', t('chrome.edit.cut'), { kind: 'cut' }, { icon: 'cut', shortcut: 'Mod+X', nativeShortcut: true, enabled: (s) => s.hasSelection }),
      a('edit.copy', t('chrome.edit.copy'), { kind: 'copy' }, { icon: 'copy', shortcut: 'Mod+C', nativeShortcut: true, enabled: (s) => s.hasSelection }),
      a('edit.paste', t('chrome.edit.paste'), { kind: 'paste' }, { icon: 'paste', shortcut: 'Mod+V', nativeShortcut: true }),
      dialog('edit.pasteSpecial', t('chrome.edit.pasteSpecial'), 'pasteSpecial'),
      a('edit.selectAll', t('chrome.edit.selectAll'), { kind: 'selectAll' }, { shortcut: 'Mod+A' }),
      dialog('edit.find', t('chrome.edit.find'), 'find', { icon: 'find', shortcut: 'Mod+F' }),
      dialog('edit.replace', t('chrome.edit.replace'), 'replace', { shortcut: { other: 'Mod+H', mac: 'Ctrl+H' } }),
      dialog('edit.goTo', t('chrome.edit.goTo'), 'goTo', { shortcut: 'Mod+G' }),
      dialog('edit.searchAll', t('chrome.edit.searchAll'), 'searchAll', { icon: 'find', shortcut: 'Mod+Shift+F' }),
    );

    // View
    const mode = (id: string, label: string, m: ChromeState['viewMode']) =>
      a(id, label, { kind: 'viewMode', mode: m }, { checked: (s) => s.viewMode === m, radio: true });
    r.add(
      mode('view.print', t('chrome.view.print'), 'print'),
      mode('view.flow', t('chrome.view.flow'), 'flow'),
      // A radio with the others, but a toggle: choosing it again (or Alt+G) goes back to the view before it.
      a('view.grid', t('chrome.view.grid'), { kind: 'toggleGrid' }, { shortcut: 'Alt+G', checked: (s) => s.viewMode === 'grid', radio: true }),
      a('view.fillForm', t('chrome.view.fillForm'), { kind: 'setFormMode', mode: 'fill' }, { checked: (s) => s.formMode === 'fill', radio: true, tooltip: t('chrome.view.fillForm.tip') }),
      a('view.editForm', t('chrome.view.editForm'), { kind: 'setFormMode', mode: 'edit' }, { checked: (s) => s.formMode === 'edit', radio: true, tooltip: t('chrome.view.editForm.tip') }),
      a('view.pagesPanel', t('chrome.view.pagesPanel'), { kind: 'togglePagesPanel' }, { shortcut: 'Alt+P', checked: (s) => s.pagesPanel }),
      a('view.filesPanel', t('chrome.view.filesPanel'), { kind: 'toggleFilesPanel' }, { checked: (s) => s.filesPanel }),
      a('view.toolbars', t('chrome.view.showToolbars'), { kind: 'toggleToolbars' }, { checked: (s) => s.toolbars }),
      a('view.footer', t('chrome.view.footer'), { kind: 'toggleFooter' }, { checked: (s) => s.footer }),
      a('view.ruler', t('chrome.view.ruler'), { kind: 'toggleRuler' }, { checked: (s) => s.rulerVisible }),
      a('view.formattingMarks', t('chrome.view.formattingMarks'), { kind: 'toggleFormattingMarks' }, {
        icon: 'paragraphMarks',
        tooltip: t('chrome.view.formattingMarks.tip'),
        shortcut: 'Mod+Shift+8',
        checked: (s) => s.formattingMarks,
      }),
      {
        id: 'view.fullScreen',
        label: t('chrome.view.fullScreen'),
        run: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}),
        checked: () => !!document.fullscreenElement,
        enabled: () => document.fullscreenEnabled,
      },
      a('view.zoomIn', t('chrome.view.zoomIn'), { kind: 'zoomBy', factor: 1.25 }, { shortcut: 'Mod+=' }),
      a('view.zoomOut', t('chrome.view.zoomOut'), { kind: 'zoomBy', factor: 0.8 }, { shortcut: 'Mod+-' }),
      a('view.zoom100', t('chrome.view.zoom100'), { kind: 'zoom', to: 1 }, { shortcut: 'Mod+0' }),
      a('view.pageWidth', t('chrome.view.pageWidth'), { kind: 'zoom', to: 'pageWidth' }),
      a('view.wholePage', t('chrome.view.wholePage'), { kind: 'zoom', to: 'wholePage' }),
      a('view.allPages', t('chrome.view.allPages'), { kind: 'zoom', to: 'allPages' }, { shortcut: { mac: 'Alt+F' } }),
    );
    for (const name of ['Standard', 'Formatting']) {
      r.add({
        id: `view.toolbar.${name.toLowerCase()}`,
        label: name === 'Standard' ? t('chrome.view.toolbar.standard') : t('chrome.view.toolbar.formatting'),
        run: () => this.toggleToolbar(name),
        checked: () => this.layout.find((t) => t.name === name)?.visible ?? false,
      });
    }
    for (const { id, label } of SCHEMES) {
      r.add({ id: `view.theme.${id}`, label, run: () => setScheme(id), checked: () => currentScheme() === id, radio: true });
    }
    r.add(
      { id: 'view.darkMode', label: t('chrome.view.darkMode'), run: toggleDark, checked: isDark },
      { id: 'view.darkPages', label: t('chrome.view.darkPages'), run: toggleDarkPages, checked: pagesDark },
      {
        id: 'view.matchSystem',
        label: t('chrome.view.matchSystem'),
        run: () => setAppearance(currentAppearance() === 'auto' ? (isDark() ? 'dark' : 'light') : 'auto'),
        checked: () => currentAppearance() === 'auto',
      },
    );
    r.add({ id: 'tools.commandPalette', label: t('chrome.palette.label'), icon: 'commandPalette', shortcut: 'Mod+Shift+P', run: () => this.palette.toggle() });
    r.add({ id: 'view.customizeToolbars', label: t('chrome.view.customizeToolbars'), run: () => this.customize() });

    // Insert
    r.add(
      a('insert.pageBreak', t('chrome.insert.pageBreak'), { kind: 'insertBreak', break: 'page' }, { icon: 'pageBreak', shortcut: 'Mod+Enter' }),
      a('insert.columnBreak', t('chrome.insert.columnBreak'), { kind: 'insertBreak', break: 'column' }, { shortcut: 'Mod+Shift+Enter' }),
      a('insert.lineBreak', t('chrome.insert.lineBreak'), { kind: 'insertBreak', break: 'line' }, { shortcut: 'Shift+Enter', nativeShortcut: true }),
      a('insert.sectionNext', t('chrome.insert.sectionNext'), { kind: 'insertBreak', break: 'sectionNextPage' }),
      a('insert.sectionContinuous', t('chrome.insert.sectionContinuous'), { kind: 'insertBreak', break: 'sectionContinuous' }),
      dialog('insert.pageNumbers', t('chrome.insert.pageNumbers'), 'pageNumbers'),
      a('insert.comment', t('chrome.insert.comment'), { kind: 'insertComment' }, { icon: 'comment', shortcut: 'Mod+Alt+M' }),
      a('insert.footnote', t('chrome.insert.footnote'), { kind: 'insertFootnote' }, { shortcut: 'Mod+Alt+F' }),
      a('insert.image', t('chrome.insert.image'), { kind: 'insertImage' }, { icon: 'image' }),
      a('insert.drawing', t('chrome.insert.drawing'), { kind: 'insertDrawing' }, { icon: 'shapes', tooltip: t('chrome.insert.drawing.tip') }),
      a('insert.textBox', t('chrome.insert.textBox'), { kind: 'insertTextBox' }),
      a('insert.table', t('chrome.insert.table'), { kind: 'insertTable' }, { icon: 'table', tooltip: t('chrome.insert.table.tip') }),
      a('insert.horizontalRule', t('chrome.insert.horizontalRule'), { kind: 'insertHorizontalRule' }),
      a('insert.codeBlock', t('chrome.insert.codeBlock'), { kind: 'insertCodeBlock' }),
      a('insert.link', t('chrome.insert.link'), { kind: 'insertLink' }, { icon: 'link', shortcut: 'Mod+K', tooltip: t('chrome.insert.link.tip') }),
      a('insert.bookmark', t('chrome.insert.bookmark'), { kind: 'insertBookmark' }),
      a('insert.math', t('math.insert'), { kind: 'insertMath' }, { icon: 'math', tooltip: t('math.insert.tip') }),
    );

    // Format: character
    const mark = (m: Mark, label: string, shortcut?: CommandSpec['shortcut']) =>
      a(`format.${m}`, label, { kind: 'toggleMark', mark: m }, { icon: m, shortcut, checked: (s) => !!s.format.marks?.[m] });
    r.add(
      mark('bold', t('chrome.format.bold'), 'Mod+B'),
      mark('italic', t('chrome.format.italic'), 'Mod+I'),
      mark('underline', t('chrome.format.underline'), 'Mod+U'),
      mark('strikethrough', t('chrome.format.strikethrough'), { other: 'Alt+Shift+5', mac: 'Mod+Shift+X' }),
      mark('superscript', t('chrome.format.superscript'), 'Mod+.'),
      mark('subscript', t('chrome.format.subscript'), 'Mod+,'),
      mark('code', t('chrome.format.code')),
      a('format.growFont', t('chrome.format.growFont'), { kind: 'growFont' }, { icon: 'growFont', shortcut: 'Mod+]' }),
      a('format.shrinkFont', t('chrome.format.shrinkFont'), { kind: 'shrinkFont' }, { icon: 'shrinkFont', shortcut: 'Mod+[' }),
      a('format.clear', t('chrome.format.clear'), { kind: 'clearFormatting' }, { icon: 'clearFormatting', shortcut: 'Mod+Space' }),
      a('format.painter', t('chrome.format.painter'), { kind: 'formatPainter' }, { icon: 'formatPainter', tooltip: t('chrome.format.painter.tip'), checked: (s) => s.painting }),
      dialog('format.font', t('chrome.format.font'), 'font', { shortcut: 'Mod+D' }),
    );
    const cases: [CaseChange, string][] = [
      ['sentence', t('chrome.format.case.sentence')],
      ['lower', t('chrome.format.case.lower')],
      ['upper', t('chrome.format.case.upper')],
      ['title', t('chrome.format.case.title')],
      ['toggle', t('chrome.format.case.toggle')],
    ];
    for (const [to, label] of cases) r.add(a(`format.case.${to}`, label, { kind: 'changeCase', to }));

    // Format: paragraph
    const align = (to: Alignment, label: string, icon: string, shortcut: string) =>
      a(`format.align.${to}`, label, { kind: 'setAlignment', align: to }, { icon, shortcut, checked: (s) => s.format.align === to, radio: true });
    r.add(
      align('left', t('chrome.format.align.left'), 'alignLeft', 'Mod+L'),
      align('center', t('chrome.format.align.center'), 'alignCenter', 'Mod+E'),
      align('right', t('chrome.format.align.right'), 'alignRight', 'Mod+R'),
      align('justify', t('chrome.format.align.justify'), 'justify', 'Mod+J'),
      a('format.bullets', t('chrome.format.bullets'), { kind: 'toggleList', list: 'bullet' }, { icon: 'bullets', checked: (s) => s.format.list === 'bullet' }),
      a('format.numbering', t('chrome.format.numbering'), { kind: 'toggleList', list: 'number' }, { icon: 'numbering', checked: (s) => s.format.list === 'number' }),
      a('format.checklist', t('chrome.format.checklist'), { kind: 'toggleList', list: 'task' }, { icon: 'checklist', checked: (s) => s.format.list === 'task' }),
      a('format.indent', t('chrome.format.indent'), { kind: 'indent', direction: 'increase' }, { icon: 'indentIncrease', shortcut: { other: 'Mod+M' } }),
      a('format.outdent', t('chrome.format.outdent'), { kind: 'indent', direction: 'decrease' }, { icon: 'indentDecrease', shortcut: { other: 'Mod+Shift+M' } }),
      dialog('format.paragraph', t('chrome.format.paragraph'), 'paragraph'),
      dialog('format.bulletsAndNumbering', t('chrome.format.bulletsAndNumbering'), 'bulletsAndNumbering'),
      dialog('format.borders', t('chrome.format.borders'), 'bordersAndShading', { icon: 'borders' }),
      dialog('format.columns', t('chrome.format.columns'), 'columns', { icon: 'columns' }),
      dialog('format.tabs', t('chrome.format.tabs'), 'tabs'),
      dialog('format.styles', t('chrome.format.styles'), 'styles'),
    );
    for (const lines of [1, 1.15, 1.5, 2, 2.5, 3]) {
      r.add(a(`format.spacing.${lines}`, lines.toFixed(lines % 1 ? 2 : 1).replace(/0$/, ''), { kind: 'setLineSpacing', lines }));
    }

    // Tools
    r.add(
      dialog('tools.spelling', t('chrome.tools.spelling'), 'spelling', { icon: 'spelling', shortcut: 'F7' }),
      dialog('tools.wordCount', t('chrome.tools.wordCount'), 'wordCount', { icon: 'wordCount' }),
      a('tools.trackChanges', t('chrome.tools.trackChanges'), { kind: 'toggleTrackChanges' }, { icon: 'trackChanges', shortcut: 'Mod+Shift+E', checked: (s) => s.trackChanges }),
      dialog('tools.options', t('chrome.tools.options'), 'options'),
      { id: 'tools.autoFormat', label: t('chrome.tools.autoFormat'), tooltip: t('chrome.tools.autoFormat.tip'), run: () => setAutoFormat(!autoFormatOn()), checked: autoFormatOn },
      { id: 'tools.livePreview', label: t('chrome.tools.livePreview'), tooltip: t('chrome.tools.livePreview.tip'), run: () => setLivePreview(!livePreviewOn()), checked: livePreviewOn },
    );

    // Table
    // Row, column and cell commands work on the table the selection is in.
    const table = (op: TableOp, label: string) => a(`table.${op}`, label, { kind: 'table', op }, { enabled: (s) => s.inTable });
    r.add(
      table('insertRowAbove', t('chrome.table.insertRowAbove')),
      table('insertRowBelow', t('chrome.table.insertRowBelow')),
      table('insertColumnLeft', t('chrome.table.insertColumnLeft')),
      table('insertColumnRight', t('chrome.table.insertColumnRight')),
      table('deleteTable', t('chrome.table.deleteTable')),
      table('deleteRows', t('chrome.table.deleteRows')),
      table('deleteColumns', t('chrome.table.deleteColumns')),
      table('mergeCells', t('chrome.table.mergeCells')),
      table('splitCells', t('chrome.table.splitCells')),
      table('selectTable', t('chrome.table.selectTable')),
      table('properties', t('chrome.table.properties')),
    );

    // Picture
    const picture = (op: ImageOp, label: string, icon: string, extra: Partial<CommandSpec> = {}) => a(`image.${op}`, label, { kind: 'image', op }, { icon, ...extra });
    r.add(
      picture('rotateLeft', t('picture.rotateLeft'), 'rotateLeft'),
      picture('rotateRight', t('picture.rotateRight'), 'rotateRight'),
      picture('rotate180', t('picture.rotate180'), 'rotate180'),
      picture('flipHorizontal', t('picture.flipHorizontal'), 'flipHorizontal'),
      picture('flipVertical', t('picture.flipVertical'), 'flipVertical'),
      picture('crop', t('picture.crop'), 'crop', { scope: 'picture', shortcut: PICTURE_KEYS.crop }),
      picture('resize', t('picture.resize'), 'resize', { scope: 'picture', shortcut: PICTURE_KEYS.resize }),
      picture('canvasSize', t('picture.canvas.menu'), 'resize', { scope: 'picture', shortcut: PICTURE_KEYS.canvasSize }),
      picture('background', t('picture.background.menu'), 'background', { scope: 'picture' }),
      picture('adjust', t('picture.adjust'), 'adjust'),
      picture('autoLevels', t('picture.autoLevels'), 'autoLevels'),
      picture('grayscale', t('picture.grayscale'), 'grayscale'),
      picture('sepia', t('picture.sepia'), 'sepia'),
      picture('invert', t('picture.invert'), 'invert', { scope: 'picture', shortcut: PICTURE_KEYS.invert }),
      picture('blur', t('picture.blur'), 'blur'),
      picture('sharpen', t('picture.sharpen'), 'sharpen'),
    );

    // Draw: the tools stay picked until Done, so they show as pressed. The keys are Photoshop's.
    for (const tool of ['move', 'pen', 'marker', 'smudge', 'mixer', 'blurBrush', 'sharpenBrush', 'dodge', 'burn', 'eraser', 'line', 'arrow', 'rectangle', 'ellipse', 'shape', 'text', 'bubble', 'step', 'pixelate', 'eyedropper', 'bucket'] as const) {
      r.add(a(`image.${tool}`, t(`picture.draw.${tool}`), { kind: 'image', op: tool }, { icon: tool === 'shape' ? 'shapes' : tool, scope: 'picture', shortcut: PICTURE_KEYS[tool], checked: (s) => s.draw.tool === tool }));
    }
    // What the picked shapes and layers can be given (the Layers panel's buttons and menu).
    const onShapes = (s: ChromeState): boolean => s.draw.hasSelection;
    for (const [op, label, icon, enabled] of [
      ['newLayer', t('vector.newLayer'), 'newLayer', undefined],
      ['duplicate', t('vector.duplicate'), 'copy', onShapes],
      ['group', t('vector.group'), 'group', onShapes],
      ['ungroup', t('vector.ungroup'), 'ungroup', onShapes],
      ['front', t('vector.front'), 'toFront', onShapes],
      ['forward', t('vector.forward'), 'forward', onShapes],
      ['backward', t('vector.backward'), 'backward', onShapes],
      ['back', t('vector.back'), 'toBack', onShapes],
      ['delete', t('vector.delete'), 'trash', onShapes],
      ['selectAll', t('vector.selectAll'), undefined, undefined],
      ['deselect', t('picture.deselect'), undefined, onShapes],
      ['sizeUp', t('picture.draw.sizeUp'), undefined, undefined],
      ['sizeDown', t('picture.draw.sizeDown'), undefined, undefined],
    ] as const) {
      r.add(a(`image.${op}`, label, { kind: 'image', op }, { ...(icon && { icon }), scope: 'picture', shortcut: PICTURE_KEYS[op], ...(enabled && { enabled }) }));
    }
    r.add(a('image.layers', t('vector.layers'), { kind: 'image', op: 'layers' }, { icon: 'layersStack', scope: 'picture', shortcut: PICTURE_KEYS.layers, checked: (s) => s.draw.layers }));

    // Drawing (vector): the tools stay picked, so they show as pressed; the rest act on the selection.
    for (const [tool, icon] of [['select', 'select'], ['rect', 'rectangle'], ['ellipse', 'ellipse'], ['shape', 'shapes'], ['line', 'line'], ['pen', 'penTool'], ['pencil', 'pencil'], ['nudge', 'nudge'], ['text', 'text'], ['canvas', 'canvasTool']] as const) {
      r.add(a(`vector.${tool}`, t(`vector.${tool}`), { kind: 'vector', op: tool }, { icon, scope: 'vector', shortcut: VECTOR_TOOL_KEYS[tool], checked: (s) => s.vector.tool === tool }));
    }
    const vectorOps = { delete: 'trash', duplicate: 'copy', group: 'group', ungroup: 'ungroup', front: 'toFront', forward: 'forward', backward: 'backward', back: 'toBack' } as const;
    for (const op of ['delete', 'duplicate', 'group', 'ungroup', 'front', 'forward', 'backward', 'back'] as const) {
      r.add(a(`vector.${op}`, t(`vector.${op}`), { kind: 'vector', op }, { icon: vectorOps[op], scope: 'vector', shortcut: VECTOR_KEYS[op], enabled: (s) => s.vector.hasSelection }));
    }
    const vectorBooleans = { unite: 'unite', intersect: 'intersect', subtract: 'subtract', exclude: 'exclude' } as const;
    for (const op of ['unite', 'intersect', 'subtract', 'exclude'] as const) {
      r.add(a(`vector.${op}`, t(`vector.${op}`), { kind: 'vector', op }, { icon: vectorBooleans[op], scope: 'vector', enabled: (s) => s.vector.multiple }));
    }
    r.add(a('vector.makeClip', t('vector.makeClip'), { kind: 'vector', op: 'makeClip' }, { icon: 'clipMask', scope: 'vector', shortcut: 'Mod+7', enabled: (s) => s.vector.multiple }));
    r.add(a('vector.releaseClip', t('vector.releaseClip'), { kind: 'vector', op: 'releaseClip' }, { scope: 'vector', shortcut: 'Alt+Mod+7', enabled: (s) => s.vector.clipped }));
    r.add(a('vector.makeMask', t('vector.makeMask'), { kind: 'vector', op: 'makeMask' }, { scope: 'vector', enabled: (s) => s.vector.multiple }));
    r.add(a('vector.releaseMask', t('vector.releaseMask'), { kind: 'vector', op: 'releaseMask' }, { scope: 'vector', enabled: (s) => s.vector.masked }));
    r.add(a('vector.newLayer', t('vector.newLayer'), { kind: 'vector', op: 'newLayer' }, { icon: 'newLayer', scope: 'vector' }));
    r.add(a('vector.newGroup', t('vector.newGroup'), { kind: 'vector', op: 'newGroup' }, { icon: 'newGroup', scope: 'vector' }));
    r.add(a('vector.canvasSize', t('vector.canvasSize'), { kind: 'vector', op: 'canvasSize' }, { scope: 'vector', shortcut: 'Alt+Mod+P' }));
    r.add(a('vector.guideV', t('vector.guideV'), { kind: 'vector', op: 'guideV' }, { scope: 'vector' }));
    r.add(a('vector.guideH', t('vector.guideH'), { kind: 'vector', op: 'guideH' }, { scope: 'vector' }));
    // Drawing settings run directly (they are not actions the format gates), so they are shown where there is a drawing to edit.
    const forVectors = (s: ChromeState): boolean => FORMATS[s.kind].vectorTools;
    r.add({ id: 'vector.showGuides', label: t('vector.showGuides'), run: () => setShowGuides(!showGuidesOn()), checked: showGuidesOn, scope: 'vector', visible: forVectors });
    r.add({ id: 'vector.lockGuides', label: t('vector.lockGuides'), run: () => setLockGuides(!lockGuidesOn()), checked: lockGuidesOn, scope: 'vector', visible: forVectors });
    r.add(a('vector.clearGuides', t('vector.clearGuides'), { kind: 'vector', op: 'clearGuides' }, { scope: 'vector' }));
    r.add(a('vector.layers', t('vector.layers'), { kind: 'vector', op: 'layers' }, { scope: 'vector', shortcut: 'F7', checked: (s) => s.vector.layers }));
    r.add({ id: 'vector.selectAfterPencil', label: t('vector.selectAfterPencil'), tooltip: t('dialogs.options.selectAfterPencil'), run: () => setSelectAfterPencil(!selectAfterPencilOn()), checked: selectAfterPencilOn, scope: 'vector', visible: forVectors });
    r.add(a('vector.snap', t('vector.snap'), { kind: 'vector', op: 'snap' }, { scope: 'vector', shortcut: 'Mod+U', checked: (s) => s.vector.snap }));
    r.add(a('vector.selectAll', t('vector.selectAll'), { kind: 'vector', op: 'selectAll' }, { scope: 'vector', shortcut: 'Mod+A' }));

    r.add({ id: 'image.fill', label: t('picture.draw.fill'), icon: 'fill', action: (s) => ({ kind: 'drawStyle', fill: !s.draw.fill }), checked: (s) => s.draw.fill });
    r.add({ id: 'image.noStroke', label: t('picture.draw.noStroke'), action: (s) => ({ kind: 'drawStyle', noStroke: !s.draw.noStroke }), checked: (s) => s.draw.noStroke });
    r.add({ id: 'image.contiguous', label: t('picture.draw.contiguous'), action: (s) => ({ kind: 'drawStyle', contiguous: !s.draw.contiguous }), checked: (s) => s.draw.contiguous });

    // Help
    r.add(
      { id: 'help.shortcuts', label: t('chrome.help.shortcuts'), icon: 'help', shortcut: 'F1', run: () => this.showShortcuts() },
      // The welcome document says what the app is and where its name comes from.
      { id: 'help.feedback', label: t('chrome.help.feedback'), run: () => this.sendFeedback() },
      a('help.about', t('chrome.help.about', { name: this.options.appName ?? 'Golem Docs' }), { kind: 'openSample', id: 'welcome' }),
      // The marketing site (public/home), a page of its own outside the app.
      { id: 'help.website', label: t('chrome.help.website', { name: this.options.appName ?? 'Golem Docs' }), run: () => void window.open('/home', '_blank', 'noopener') },
      a('help.privacy', t('chrome.help.privacy'), { kind: 'openSample', id: 'privacy' }),
      a('help.terms', t('chrome.help.terms'), { kind: 'openSample', id: 'terms' }),
      a('help.changelog', t('chrome.help.changelog'), { kind: 'openSample', id: 'changelog' }),
      a('help.clip', t('chrome.help.clip'), { kind: 'toggleClip' }, { checked: (s) => s.clip }),
    );
  }

  private openRecentItem(): MenuItem {
    const host = this.options.host;
    return sub(t('chrome.file.openRecent'), () => {
      const saved = host.saved?.() ?? [];
      if (!saved.length) return [{ type: 'item', label: t('chrome.none'), enabled: false, run: () => {} }];
      return saved.map((s) => ({ type: 'item', label: s.label, run: () => this.registry.perform({ kind: 'openSaved', id: s.id }, s.label) }));
    });
  }

  private convertToItem(): MenuItem {
    // The same kinds, order and group headings as the format box.
    return sub(t('chrome.file.convertTo'), () => {
      const items: MenuItem[] = [];
      let group: string | undefined;
      for (const kind of convertTargets(this.state.kind)) {
        const id = formatGroup(kind);
        if (id !== group) {
          group = id;
          items.push({ type: 'heading', label: t(`menus.format.group.${id}`) });
        }
        items.push(cmd(`file.convertTo.${kind}`));
      }
      return items;
    });
  }

  /**
   * The phone's menu: not the desktop menus behind a button but one list of what is used on a
   * phone, grouped under small headings, with the full menus last for everything else.
   */
  private mobileMenu(): DrawerEntry[] {
    const heading = (label: string): DrawerEntry => ({ type: 'heading', label });
    return [
      heading(t('chrome.menu.file')),
      cmd('file.new'),
      cmd('file.open'),
      this.openRecentItem(),
      cmd('file.share'),
      this.convertToItem(),
      cmd('file.download'),
      cmd('file.downloadAll'),
      cmd('file.openSelection'),
      cmd('file.subscribe'),
      cmd('file.manageSubscription'),
      cmd('file.print'),
      heading(t('chrome.menu.edit')),
      cmd('edit.find'),
      cmd('edit.replace'),
      cmd('edit.searchAll'),
      cmd('edit.selectAll'),
      cmd('edit.pasteSpecial'),
      heading(t('chrome.menu.insert')),
      cmd('insert.image'),
      cmd('insert.drawing'),
      cmd('insert.table'),
      cmd('format.bullets'),
      cmd('format.numbering'),
      cmd('format.checklist'),
      cmd('insert.link'),
      cmd('insert.comment'),
      cmd('insert.footnote'),
      cmd('insert.pageBreak'),
      cmd('insert.horizontalRule'),
      heading(t('chrome.menu.view')),
      cmd('view.print'),
      cmd('view.flow'),
      cmd('view.grid'),
      cmd('view.formattingMarks'),
      cmd('view.pageWidth'),
      cmd('view.darkMode'),
      cmd('view.darkPages'),
      heading(t('chrome.menu.tools')),
      cmd('tools.spelling'),
      cmd('tools.wordCount'),
      cmd('tools.trackChanges'),
      cmd('tools.autoFormat'),
      cmd('tools.livePreview'),
      cmd('file.pageSetup'),
      cmd('file.properties'),
      cmd('file.versionHistory'),
      cmd('file.trash'),
      cmd('tools.options'),
      heading(t('chrome.menu.help')),
      cmd('help.shortcuts'),
      cmd('help.feedback'),
      cmd('help.about'),
      { type: 'separator' },
      sub(t('menus.drawer.all'), () => this.menus().map((menu) => sub(menu.label, menu.items))),
    ];
  }

  // --- Menus -------------------------------------------------------------------------------

  private menus(): TopMenu[] {
    const isAdmin = () => this.options.isAdmin?.() ?? false;
    const host = this.options.host;
    const r = this.registry;
    const insertText = (text: string, label: string, hint?: string): MenuItem => ({
      type: 'item',
      label,
      hint,
      enabled: r.allows({ kind: 'insertText', text }),
      available: () => r.availableFor({ kind: 'insertText', text }),
      run: () => r.perform({ kind: 'insertText', text }, t('chrome.perform.insert')),
    });

    return [
      {
        label: t('chrome.menu.file'),
        items: [
          cmd('file.new'),
          cmd('file.open'),
          cmd('file.import'),
          cmd('file.importFolder'),
          this.openRecentItem(),
          sep,
          cmd('file.share'),
          this.convertToItem(),
          cmd('file.download'),
          cmd('file.downloadAll'),
          cmd('file.openSelection'),
          sep,
          cmd('file.rename'),
          sep,
          cmd('file.pageSetup'),
          cmd('file.printPreview'),
          cmd('file.print'),
          sep,
          cmd('file.properties'),
          cmd('file.versionHistory'),
          cmd('file.trash'),
          sep,
          cmd('file.subscribe'),
          cmd('file.manageSubscription'),
          sep,
          cmd('file.clearLocalData'),
        ],
      },
      {
        label: t('chrome.menu.edit'),
        items: [
          cmd('edit.undo'),
          cmd('edit.redo'),
          sep,
          cmd('edit.cut'),
          cmd('edit.copy'),
          cmd('edit.paste'),
          cmd('edit.pasteSpecial'),
          sep,
          cmd('edit.selectAll'),
          sep,
          cmd('edit.find'),
          cmd('edit.replace'),
          cmd('edit.goTo'),
          cmd('edit.searchAll'),
        ],
      },
      {
        label: t('chrome.menu.view'),
        items: [
          cmd('view.print'),
          cmd('view.flow'),
          cmd('view.grid'),
          sep,
          sub(t('chrome.view.toolbars'), [cmd('view.toolbars'), sep, cmd('view.toolbar.standard'), cmd('view.toolbar.formatting'), sep, cmd('view.customizeToolbars')]),
          sub(t('chrome.view.colorScheme'), [...SCHEMES.map(({ id }) => cmd(`view.theme.${id}`)), sep, cmd('view.darkMode'), cmd('view.darkPages'), cmd('view.matchSystem')]),
          sep,
          cmd('view.ruler'),
          cmd('view.formattingMarks'),
          cmd('help.clip'),
          sep,
          cmd('view.fillForm'),
          cmd('view.editForm'),
          sep,
          cmd('view.pagesPanel'),
          cmd('view.filesPanel'),
          cmd('view.footer'),
          sep,
          cmd('view.fullScreen'),
          sub(
            t('chrome.view.zoom'),
            () => [
              ...zoomPresets().filter((p) => typeof p.to === 'number').map(
                (p): MenuItem => ({
                  type: 'item',
                  label: p.label,
                  checked: Math.abs(this.state.zoom - (p.to as number)) < 0.005,
                  run: () => r.perform({ kind: 'zoom', to: p.to }, t('chrome.perform.zoom')),
                }),
              ),
              sep,
              cmd('view.pageWidth'),
              cmd('view.wholePage'),
              cmd('view.allPages'),
              sep,
              cmd('view.zoomIn'),
              cmd('view.zoomOut'),
              cmd('view.zoom100'),
            ],
            'zoom',
          ),
        ],
      },
      {
        label: t('chrome.menu.insert'),
        items: [
          sub(t('chrome.insert.break'), [cmd('insert.pageBreak'), cmd('insert.columnBreak'), cmd('insert.lineBreak'), sep, cmd('insert.sectionNext'), cmd('insert.sectionContinuous')], 'pageBreak'),
          cmd('insert.pageNumbers'),
          sub(t('chrome.insert.dateTime'), () => {
            const now = new Date();
            return [
              insertText(now.toLocaleDateString(undefined, { dateStyle: 'long' }), now.toLocaleDateString(undefined, { dateStyle: 'long' })),
              insertText(now.toLocaleDateString(undefined, { dateStyle: 'full' }), now.toLocaleDateString(undefined, { dateStyle: 'full' })),
              insertText(now.toLocaleDateString(), now.toLocaleDateString()),
              insertText(now.toISOString().slice(0, 10), now.toISOString().slice(0, 10)),
              insertText(now.toLocaleTimeString(undefined, { timeStyle: 'short' }), now.toLocaleTimeString(undefined, { timeStyle: 'short' })),
            ];
          }),
          sub(t('chrome.insert.symbol'), () => symbols().map(([c, name]) => insertText(c, `${c}   ${name}`)), 'symbol'),
          sep,
          cmd('insert.comment'),
          cmd('insert.footnote'),
          sep,
          cmd('insert.image'),
          cmd('insert.drawing'),
          cmd('insert.textBox'),
          cmd('insert.table'),
          cmd('insert.horizontalRule'),
          cmd('insert.codeBlock'),
          sep,
          cmd('format.bullets'),
          cmd('format.numbering'),
          cmd('format.checklist'),
          sep,
          cmd('insert.link'),
          cmd('insert.bookmark'),
          cmd('insert.math'),
        ],
      },
      {
        label: t('chrome.menu.format'),
        items: [
          cmd('format.font'),
          cmd('format.paragraph'),
          cmd('format.bulletsAndNumbering'),
          cmd('format.borders'),
          cmd('format.columns'),
          cmd('format.tabs'),
          sep,
          sub(t('chrome.format.character'), [
            cmd('format.bold'),
            cmd('format.italic'),
            cmd('format.underline'),
            cmd('format.strikethrough'),
            sep,
            cmd('format.superscript'),
            cmd('format.subscript'),
            cmd('format.code'),
            sep,
            cmd('format.growFont'),
            cmd('format.shrinkFont'),
          ]),
          sub(t('chrome.format.align'), [cmd('format.align.left'), cmd('format.align.center'), cmd('format.align.right'), cmd('format.align.justify')], 'alignLeft'),
          sub(t('chrome.format.lineSpacing'), [1, 1.15, 1.5, 2, 2.5, 3].map((n) => cmd(`format.spacing.${n}`)), 'lineSpacing'),
          sub(t('chrome.format.changeCase'), ['sentence', 'lower', 'upper', 'title', 'toggle'].map((c) => cmd(`format.case.${c}`))),
          sep,
          cmd('format.styles'),
          cmd('format.painter'),
          cmd('format.clear'),
        ],
      },
      {
        label: t('chrome.menu.tools'),
        items: [cmd('tools.spelling'), cmd('tools.wordCount'), sep, cmd('tools.trackChanges'), cmd('tools.autoFormat'), cmd('tools.livePreview'), sep, cmd('view.customizeToolbars'), cmd('tools.options'), cmd('tools.commandPalette'), sep, sub(t('chrome.tools.language'), languageItems)],
      },
      {
        label: t('chrome.menu.table'),
        items: [
          cmd('insert.table'),
          sub(t('chrome.table.insert'), [cmd('table.insertRowAbove'), cmd('table.insertRowBelow'), cmd('table.insertColumnLeft'), cmd('table.insertColumnRight')]),
          sub(t('chrome.table.delete'), [cmd('table.deleteTable'), cmd('table.deleteRows'), cmd('table.deleteColumns')]),
          sep,
          cmd('table.mergeCells'),
          cmd('table.splitCells'),
          sep,
          cmd('table.selectTable'),
          cmd('table.properties'),
        ],
      },
      {
        label: t('picture.menu'),
        items: [
          cmd('image.rotateLeft'),
          cmd('image.rotateRight'),
          cmd('image.rotate180'),
          cmd('image.flipHorizontal'),
          cmd('image.flipVertical'),
          sep,
          cmd('image.crop'),
          cmd('image.resize'),
          cmd('image.canvasSize'),
          cmd('image.background'),
          cmd('image.adjust'),
          sep,
          cmd('image.autoLevels'),
          cmd('image.grayscale'),
          cmd('image.sepia'),
          cmd('image.invert'),
          cmd('image.blur'),
          cmd('image.sharpen'),
          sep,
          cmd('image.move'),
          cmd('image.pen'),
          cmd('image.marker'),
          cmd('image.smudge'),
          cmd('image.mixer'),
          cmd('image.blurBrush'),
          cmd('image.sharpenBrush'),
          cmd('image.dodge'),
          cmd('image.burn'),
          cmd('image.eraser'),
          cmd('image.line'),
          cmd('image.arrow'),
          cmd('image.rectangle'),
          cmd('image.ellipse'),
          cmd('image.shape'),
          cmd('image.fill'),
          cmd('image.noStroke'),
          cmd('image.text'),
          cmd('image.bubble'),
          cmd('image.step'),
          cmd('image.pixelate'),
          cmd('image.eyedropper'),
          cmd('image.bucket'),
          cmd('image.contiguous'),
          sep,
          cmd('image.layers'),
          cmd('image.newLayer'),
          cmd('image.selectAll'),
          cmd('image.deselect'),
          cmd('image.duplicate'),
          cmd('image.group'),
          cmd('image.ungroup'),
          cmd('image.front'),
          cmd('image.forward'),
          cmd('image.backward'),
          cmd('image.back'),
          cmd('image.delete'),
        ],
      },
      {
        label: t('vector.menu'),
        items: [
          cmd('vector.select'),
          cmd('vector.rect'),
          cmd('vector.ellipse'),
          cmd('vector.shape'),
          cmd('vector.line'),
          cmd('vector.pen'),
          cmd('vector.pencil'),
          cmd('vector.nudge'),
          cmd('vector.text'),
          cmd('vector.canvas'),
          sep,
          cmd('vector.newLayer'),
          cmd('vector.newGroup'),
          sep,
          cmd('vector.group'),
          cmd('vector.ungroup'),
          cmd('vector.duplicate'),
          cmd('vector.delete'),
          sep,
          cmd('vector.front'),
          cmd('vector.forward'),
          cmd('vector.backward'),
          cmd('vector.back'),
          sep,
          cmd('vector.unite'),
          cmd('vector.intersect'),
          cmd('vector.subtract'),
          cmd('vector.exclude'),
          sep,
          cmd('vector.makeClip'),
          cmd('vector.releaseClip'),
          cmd('vector.makeMask'),
          cmd('vector.releaseMask'),
          sep,
          cmd('vector.canvasSize'),
          cmd('vector.guideV'),
          cmd('vector.guideH'),
          cmd('vector.clearGuides'),
          cmd('vector.showGuides'),
          cmd('vector.lockGuides'),
          cmd('vector.snap'),
          cmd('vector.selectAfterPencil'),
          cmd('vector.layers'),
          sep,
          cmd('vector.selectAll'),
        ],
      },
      {
        label: t('chrome.menu.help'),
        items: [cmd('help.shortcuts'), cmd('help.feedback'), sep, cmd('help.changelog'), cmd('help.about'), cmd('help.website'), cmd('help.privacy'), cmd('help.terms')],
      },
      {
        // For admins only: the whole menu is left out for everyone else (see MenuBar.refresh).
        label: t('chrome.menu.admin'),
        items: [
          { type: 'item', label: t('chrome.admin.debug'), run: () => this.showDebug(), available: isAdmin },
          { type: 'item', label: t('chrome.admin.billing'), run: () => this.showBilling(), available: isAdmin },
          { type: 'item', label: t('chrome.admin.analytics'), run: () => this.showAnalytics(), available: isAdmin },
          { type: 'item', label: t('chrome.admin.feedback'), run: () => this.showFeedback(), available: isAdmin },
          sub(t('chrome.file.openSample'), () => {
            const samples = host.samples?.() ?? [];
            if (!samples.length) return [{ type: 'item', label: t('chrome.none'), enabled: false, run: () => {} }];
            return samples.map((s) => ({ type: 'item', label: s.label, run: () => r.perform({ kind: 'openSample', id: s.id }, s.label) }));
          }),
        ],
      },
    ];
  }

  // --- Toolbars ----------------------------------------------------------------------------

  /** Toolbar controls other than command buttons, by id (see toolbarLayout.ts). */
  private defineControls(): void {
    const r = this.registry;
    const state = () => this.state;
    const focus = () => this.options.host.focusEditor();
    const profile = () => FORMATS[this.state.kind];
    const define = (id: string, label: string, category: string, icon: string, create: () => Control) => this.controls.set(id, { label, category, icon, create });
    /** A control the open format can't use is hidden, not just disabled. */
    const gated = (c: Control, available: () => boolean): Control => ({ ...c, available });

    define('control.zoom', t('chrome.control.zoomBox'), t('chrome.category.view'), 'zoom', () =>
      comboBox(
        {
          label: t('chrome.control.zoom'),
          width: 52,
          options: () => zoomPresets().map((p) => p.label),
          value: (s) => `${Math.round(s.zoom * 100)}%`,
          enabled: () => true,
          commit: (text) => {
            const preset = zoomPresets().find((p) => p.label.toLowerCase() === text.toLowerCase());
            const percent = parseFloat(text);
            const to = preset?.to ?? (percent > 0 ? percent / 100 : NaN);
            if (typeof to === 'number' && !(to > 0)) return false;
            r.perform({ kind: 'zoom', to }, t('chrome.perform.zoom'));
            return true;
          },
        },
        state,
        focus,
      ),
    );

    define('control.style', t('chrome.control.styleBox'), t('chrome.category.format'), 'combo', () =>
      gated(
        comboBox(
          {
            label: t('chrome.control.style'),
            width: 96,
            options: () => [...profile().styles],
            value: (s) => s.format.style ?? '',
            enabled: () => profile().editable && profile().styles.length > 0 && r.allows({ kind: 'setStyle', style: profile().styles[0] }),
            optionStyle: (style) => styleOptionCss(style),
            commit: (text) => {
              const style = profile().styles.find((s) => s.toLowerCase() === text.toLowerCase());
              if (!style) {
                this.options.host.notify(t('chrome.control.noStyle', { name: text }));
                return false;
              }
              r.perform({ kind: 'setStyle', style }, t('chrome.perform.style'));
              return true;
            },
          },
          state,
          focus,
        ),
        () => profile().styles.length > 0,
      ),
    );

    define('control.font', t('chrome.control.fontBox'), t('chrome.category.format'), 'combo', () =>
      gated(
        comboBox(
          {
            label: t('chrome.control.font'),
            width: 128,
            options: () => [...this.recentFonts, ...this.fonts],
            headerCount: () => this.recentFonts.length,
            value: (s) => s.format.font ?? '',
            enabled: () => r.allows({ kind: 'setFont', family: 'Calibri' }),
            optionStyle: (font) => `font-family:${JSON.stringify(font)},system-ui;font-size:13px`,
            commit: (text) => {
              const family = this.fonts.find((f) => f.toLowerCase() === text.toLowerCase()) ?? text;
              this.recentFonts = [family, ...this.recentFonts.filter((f) => f !== family)].slice(0, 3);
              r.perform({ kind: 'setFont', family }, t('chrome.perform.font'));
              return true;
            },
          },
          state,
          focus,
        ),
        () => profile().fonts,
      ),
    );

    define('control.size', t('chrome.control.sizeBox'), t('chrome.category.format'), 'combo', () =>
      gated(
        comboBox(
          {
            label: t('chrome.control.size'),
            width: 30,
            options: () => FONT_SIZES.map(String),
            value: (s) => (s.format.size ? String(s.format.size) : ''),
            enabled: () => r.allows({ kind: 'setFontSize', points: 11 }),
            commit: (text) => {
              const points = Math.round(parseFloat(text) * 2) / 2;
              if (!(points >= 1 && points <= 1638)) {
                this.options.host.notify(t('chrome.control.badSize'));
                return false;
              }
              r.perform({ kind: 'setFontSize', points }, t('chrome.perform.fontSize'));
              return true;
            },
          },
          state,
          focus,
        ),
        () => profile().fontSizes,
      ),
    );

    define('control.highlight', t('chrome.control.highlight'), t('chrome.category.format'), 'highlight', () =>
      gated(
        colorButton({ label: t('chrome.control.highlight'), icon: 'highlight', noneLabel: t('chrome.control.noHighlight'), initial: '#FFFF00', palette: 'highlight', action: (color) => ({ kind: 'setHighlight', color }) }, r),
        () => profile().highlight,
      ),
    );
    define('control.fontColor', t('chrome.control.fontColor'), t('chrome.category.format'), 'fontColor', () =>
      gated(
        colorButton({ label: t('chrome.control.fontColor'), icon: 'fontColor', noneLabel: t('chrome.control.automaticColor'), initial: '#FF0000', palette: 'full', documentColors: (state) => state.format.documentColors ?? [], action: (color) => ({ kind: 'setColor', color }) }, r),
        () => profile().colors,
      ),
    );
    define('control.drawColor', t('picture.draw.color'), t('picture.menu').replace('&', ''), 'drawColor', () =>
      gated(
        colorButton({ label: t('picture.draw.color'), icon: 'drawColor', noneLabel: t('picture.draw.black'), initial: '#E5322D', palette: 'full', action: (color) => ({ kind: 'drawStyle', color: color ?? '#000000' }) }, r),
        () => profile().imageTools,
      ),
    );
    define('control.vectorFill', t('vector.fill'), t('vector.toolbar'), 'fill', () =>
      gated(
        colorButton({ label: t('vector.fill'), icon: 'vectorFill', documentColors: (state) => state.vector.documentColors, shown: (state) => ({ color: state.vector.fill, gradient: state.vector.gradient ? [state.vector.gradient.stops[0].color, state.vector.gradient.stops[state.vector.gradient.stops.length - 1].color] : undefined }), noneLabel: t('vector.noFill'), initial: '#5B8DEF', palette: 'full', emptyNone: true, header: (_state, palette) => this.fillHeader(palette), keepOpen: (state) => state.vector.gradient !== null, action: (color) => ({ kind: 'vectorStyle', fill: color }) }, r),
        () => profile().vectorTools,
      ),
    );
    define('control.vectorStroke', t('vector.stroke'), t('vector.toolbar'), 'drawColor', () =>
      gated(
        colorButton({ label: t('vector.stroke'), icon: 'vectorStroke', documentColors: (state) => state.vector.documentColors, shown: (state) => ({ color: state.vector.stroke }), noneLabel: t('vector.noStroke'), initial: '#2E3148', palette: 'full', emptyNone: true, action: (color) => ({ kind: 'vectorStyle', stroke: color }) }, r),
        () => profile().vectorTools,
      ),
    );
    define('control.vectorFillType', t('vector.fillType'), t('vector.toolbar'), 'fill', () => gated(this.vectorFillTypeBox(), () => profile().vectorTools));
    define('control.vectorShape', t('vector.shapes'), t('vector.toolbar'), 'shapes', () => gated(this.vectorShapeBox(), () => profile().vectorTools));
    define('control.vectorStrokeStyle', t('vector.strokeStyle'), t('vector.toolbar'), 'line', () => gated(this.vectorStrokeStyleBox(), () => profile().vectorTools));
    define('control.vectorStrokeWidth', t('vector.strokeWidth'), t('vector.toolbar'), 'line', () => gated(this.vectorWidthBox(), () => profile().vectorTools));
    define('control.drawSize', t('picture.draw.size'), t('picture.menu').replace('&', ''), 'line', () => gated(this.drawSizeBox(), () => profile().imageTools));
    const draw = t('picture.draw.toolbar');
    define('control.drawFill', t('picture.draw.fillColor'), draw, 'fill', () =>
      gated(
        colorButton({
          label: t('picture.draw.fillColor'),
          icon: 'vectorFill',
          noneLabel: t('picture.draw.fillSame'),
          initial: '#5B8DEF',
          palette: 'full',
          shown: (state) => ({ color: state.draw.fillColor ?? state.draw.color, gradient: state.draw.fillType === 'solid' ? undefined : [state.draw.fillColor ?? state.draw.color, state.draw.gradientTo] }),
          header: (_state, palette) => this.drawFillHeader(palette),
          keepOpen: (state) => state.draw.fillType !== 'solid',
          // With a gradient, the palette colours whichever end is picked in the popup's header.
          action: (color) => (this.fillEnd === 'to' && this.state.draw.fillType !== 'solid' ? { kind: 'drawStyle', gradientTo: color ?? '#ffffff', fill: true } : { kind: 'drawStyle', fillColor: color, fill: true }),
        }, r),
        () => profile().imageTools,
      ),
    );
    define('control.drawOpacity', t('picture.draw.opacity'), draw, 'fill', () =>
      gated(
        this.drawSelect(t('picture.draw.opacity'), ['100', '75', '50', '25', '10'].map((v): [string, string] => [v, `${v}%`]), (s) => String(s.draw.opacity), (value) => ({ kind: 'drawStyle', opacity: Number(value) })),
        () => profile().imageTools,
      ),
    );
    define('control.drawDash', t('picture.draw.dash'), draw, 'line', () =>
      gated(this.strokeStyleList(t('picture.draw.dash'), (state) => state.draw.strokeStyle, (value) => ({ kind: 'drawStyle', strokeStyle: value })), () => profile().imageTools),
    );
    define('control.drawStrength', t('picture.draw.strength'), draw, 'smudge', () =>
      gated(
        this.drawSelect(t('picture.draw.strength'), ['10', '25', '50', '75', '100'].map((v): [string, string] => [v, `${v}%`]), (s) => String(s.draw.strength), (value) => ({ kind: 'drawStyle', strength: Number(value) })),
        () => profile().imageTools,
      ),
    );
    define('control.drawTolerance', t('picture.draw.tolerance'), draw, 'bucket', () =>
      gated(
        this.drawSelect(t('picture.draw.tolerance'), ['0', '10', '20', '35', '50', '75'].map((v): [string, string] => [v, `${t('picture.draw.toleranceShort')} ${v}%`]), (s) => String(s.draw.tolerance), (value) => ({ kind: 'drawStyle', tolerance: Number(value) })),
        () => profile().imageTools,
      ),
    );
    define('control.drawShape', t('vector.shapes'), draw, 'shapes', () => gated(this.drawShapeBox(), () => profile().imageTools));
  }

  /** Which end of a picture shape's gradient the Fill popup's palette colours. */
  private fillEnd: 'from' | 'to' = 'from';

  /**
   * The top of the picture's fill popup, like the vector editor's: Solid, Linear or Radial, and for a gradient a bar showing the two
   * colours with a marker at each end (click one to colour it from the palette under it), the angle of a linear one, and a button
   * that swaps the two colours.
   */
  private drawFillHeader(palette: PaletteControl): HTMLElement {
    const r = this.registry;
    const box = h('div', { class: 'wm-fill-gradient' });
    const change = (action: Extract<Action, { kind: 'drawStyle' }>) => r.perform(action, t('picture.draw.fillType'));
    const render = (): void => {
      const state = this.state.draw;
      box.replaceChildren();
      const types = segmented(
        t('picture.draw.fillType'),
        (['solid', 'linear', 'radial'] as const).map((type) => ({ value: type, text: t(`vector.fill.${type}`), title: t(`vector.fillType.${type}`), icon: h('span', { class: `wm-fill-sample wm-fill-sample-${type}`, attrs: { 'aria-hidden': 'true' } }) })),
        (type) => change({ kind: 'drawStyle', fillType: type, fill: true }),
      );
      types.set(state.fillType);
      types.el.classList.add('wm-fill-types');
      box.append(types.el);
      if (state.fillType === 'solid') {
        this.fillEnd = 'from';
        return;
      }
      const from = state.fillColor ?? state.color;
      palette.setColor(this.fillEnd === 'to' ? state.gradientTo : from);
      const bar = h('div', { class: 'wm-grad-bar' });
      bar.style.backgroundImage = state.fillType === 'linear' ? `linear-gradient(to right, ${from}, ${state.gradientTo})` : `radial-gradient(circle, ${from}, ${state.gradientTo})`;
      const track = h('div', { class: 'wm-grad-track', attrs: { 'aria-label': t('vector.gradientBar') } });
      (['from', 'to'] as const).forEach((end, index) => {
        const marker = h('button', { class: this.fillEnd === end ? 'wm-grad-stop current' : 'wm-grad-stop', attrs: { type: 'button', 'aria-label': t('vector.stopN', { n: index + 1 }), 'aria-pressed': String(this.fillEnd === end) } });
        marker.style.left = `${index * 100}%`;
        marker.style.setProperty('--stop', end === 'from' ? from : state.gradientTo);
        marker.addEventListener('click', () => {
          this.fillEnd = end;
          render();
        });
        track.append(marker);
      });
      const parts: (HTMLElement | string)[] = [];
      if (state.fillType === 'linear') {
        const angle = h('input', { class: 'wm-grad-position', attrs: { type: 'number', min: '0', max: '360', step: '15', 'aria-label': t('picture.paint.angle') } });
        angle.value = String(state.gradientAngle);
        angle.addEventListener('change', () => {
          const value = Number(angle.value);
          if (Number.isFinite(value)) change({ kind: 'drawStyle', gradientAngle: ((Math.round(value) % 360) + 360) % 360 });
        });
        parts.push(h('label', { class: 'wm-grad-label' }, t('picture.paint.angle'), angle, '°'));
      }
      const reverse = h('button', { class: 'wm-fill-action', text: t('vector.gradientReverse'), attrs: { type: 'button' } });
      reverse.addEventListener('click', () => change({ kind: 'drawStyle', fillColor: state.gradientTo, gradientTo: from }));
      parts.push(reverse);
      box.append(h('div', { class: 'wm-fill-stops' }, bar, track, h('div', { class: 'wm-grad-row' }, ...parts)), h('div', { class: 'wm-palette-label', text: t('vector.stopColor') }));
    };
    const shown = () => JSON.stringify([this.state.draw.fillType, this.state.draw.fillColor ?? this.state.draw.color, this.state.draw.gradientTo, this.state.draw.gradientAngle]);
    let drawn = shown();
    this.onFillChange = () => {
      if (!box.isConnected) return void (this.onFillChange = null);
      if (shown() === drawn) return;
      drawn = shown();
      render();
    };
    render();
    return box;
  }

  /**
   * The top of the fill popup: Solid, Linear or Radial, and for a gradient its editor: a bar showing
   * the colours with a marker for each stop (click a marker to pick it, drag it to move it, click the
   * bar to add one), the stop's position, and buttons to delete a stop or reverse the gradient. The
   * palette under it colours the picked stop.
   */
  private fillHeader(palette: PaletteControl): HTMLElement {
    const r = this.registry;
    const box = h('div', { class: 'wm-fill-gradient' });
    const gradient = (change: Extract<Action, { kind: 'vectorGradient' }>) => r.perform(change, t('vector.fillType'));
    // While a marker is dragged the header is not redrawn (that would take the marker from under the pointer).
    let dragging = false;
    const render = (): void => {
      const state = this.state.vector;
      box.replaceChildren();
      // Each kind of fill with a small sample of it: flat, fading across, fading out from the middle.
      const types = segmented(
        t('vector.fillType'),
        (['solid', 'linear', 'radial'] as const).map((type) => ({ value: type, text: t(`vector.fill.${type}`), title: t(`vector.fillType.${type}`), icon: h('span', { class: `wm-fill-sample wm-fill-sample-${type}`, attrs: { 'aria-hidden': 'true' } }) })),
        (type) => r.perform({ kind: 'vectorStyle', fillType: type }, t('vector.fillType')),
      );
      types.set(state.fillType);
      types.el.classList.add('wm-fill-types');
      box.append(types.el);
      const g = state.gradient;
      if (!g) return;
      palette.setColor(g.stops[g.stop].color);
      const css = (stops: readonly { offset: number; color: string }[]) => `linear-gradient(to right, ${stops.map((s) => `${s.color} ${s.offset * 100}%`).join(', ')})`;
      const bar = h('div', { class: 'wm-grad-bar' });
      bar.style.backgroundImage = css(g.stops);
      const track = h('div', { class: 'wm-grad-track', attrs: { 'aria-label': t('vector.gradientBar') } });
      const at = (e: PointerEvent): number => {
        const box = track.getBoundingClientRect();
        return Math.max(0, Math.min(1, (e.clientX - box.left) / (box.width || 1)));
      };
      g.stops.forEach((stop, index) => {
        const marker = h('button', { class: index === g.stop ? 'wm-grad-stop current' : 'wm-grad-stop', title: `${Math.round(stop.offset * 100)}%`, attrs: { type: 'button', 'aria-label': t('vector.stopN', { n: index + 1 }), 'aria-pressed': String(index === g.stop) } });
        marker.style.left = `${stop.offset * 100}%`;
        marker.style.setProperty('--stop', stop.color);
        const removable = g.stops.length > 2;
        marker.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          marker.setPointerCapture(e.pointerId);
          dragging = true;
          const start = e.clientX;
          let moved: number | null = null;
          const drag = (ev: PointerEvent) => {
            // A few pixels before it is a drag, so that a click is never a move.
            if (moved === null && Math.abs(ev.clientX - start) < 3) return;
            moved = at(ev);
            marker.style.left = `${moved * 100}%`;
            bar.style.backgroundImage = css(g.stops.map((s, i) => (i === index ? { ...s, offset: moved! } : s)).sort((a, b) => a.offset - b.offset));
          };
          const drop = () => {
            marker.removeEventListener('pointermove', drag);
            marker.removeEventListener('pointerup', drop);
            marker.removeEventListener('pointercancel', drop);
            dragging = false;
            // A drag is one change (one undo step); a click only picks the stop.
            if (moved !== null && Math.abs(moved - stop.offset) > 0.002) gradient({ kind: 'vectorGradient', op: 'move', index, offset: moved });
            else if (index !== g.stop) gradient({ kind: 'vectorGradient', op: 'select', index });
            else render();
          };
          marker.addEventListener('pointermove', drag);
          marker.addEventListener('pointerup', drop);
          marker.addEventListener('pointercancel', drop);
        });
        marker.addEventListener('keydown', (e) => {
          if ((e.key === 'Delete' || e.key === 'Backspace') && removable) {
            e.preventDefault();
            gradient({ kind: 'vectorGradient', op: 'remove', index });
          }
        });
        track.append(marker);
      });
      // A click on the bar or on the empty part of the track adds a stop there.
      const add = (e: PointerEvent) => {
        if (e.target !== track && e.target !== bar) return;
        gradient({ kind: 'vectorGradient', op: 'add', offset: at(e) });
      };
      track.addEventListener('pointerdown', add);
      bar.addEventListener('pointerdown', add);
      bar.title = t('vector.gradientHint');
      const stopsBox = h('div', { class: 'wm-fill-stops' }, bar, track);

      const position = h('input', { class: 'wm-grad-position', attrs: { type: 'number', min: '0', max: '100', step: '1', 'aria-label': t('vector.stopPosition') } });
      position.value = String(Math.round(g.stops[g.stop].offset * 100));
      position.addEventListener('change', () => {
        const value = Number(position.value);
        if (Number.isFinite(value)) gradient({ kind: 'vectorGradient', op: 'move', index: g.stop, offset: value / 100 });
      });
      const remove = h('button', { class: 'wm-fill-action', text: t('vector.stopRemove'), attrs: { type: 'button' } });
      remove.disabled = g.stops.length <= 2;
      remove.addEventListener('click', () => {
        gradient({ kind: 'vectorGradient', op: 'remove', index: g.stop });
      });
      const reverse = h('button', { class: 'wm-fill-action', text: t('vector.gradientReverse'), attrs: { type: 'button' } });
      reverse.addEventListener('click', () => {
        gradient({ kind: 'vectorGradient', op: 'reverse' });
      });
      stopsBox.append(h('div', { class: 'wm-grad-row' }, h('label', { class: 'wm-grad-label' }, t('vector.stopPosition'), position, '%'), remove, reverse));
      box.append(stopsBox, h('div', { class: 'wm-palette-label', text: t('vector.stopColor') }));
    };
    // The state follows the change a frame later: the popup shows it as soon as the chrome does.
    // Only a change to the fill redraws it: a redraw for anything else (the save status, say) could land
    // between a button's press and release, which loses the click.
    const shown = () => JSON.stringify([this.state.vector.fillType, this.state.vector.gradient]);
    let drawn = shown();
    this.onFillChange = () => {
      if (!box.isConnected) return void (this.onFillChange = null);
      if (dragging || shown() === drawn) return;
      drawn = shown();
      render();
    };
    render();
    return box;
  }

  /** Solid colour, or a linear or radial gradient. */
  private vectorFillTypeBox(): Control {
    return dropdown(
      {
        label: t('vector.fillType'),
        groups: () => [{ values: ['solid', 'linear', 'radial'] }],
        current: (state) => state.vector.fillType,
        name: (value) => t(`vector.fillType.${value}` as MessageKey),
        sample: (value) => h('span', { class: `wm-fill-sample wm-fill-sample-${value}`, attrs: { 'aria-hidden': 'true' } }),
        action: (value) => ({ kind: 'vectorStyle', fillType: value as 'solid' | 'linear' | 'radial' }),
        width: 110,
      },
      this.registry,
    );
  }

  /** The list of ways a line can be drawn: dashes, then the brushes in groups, each drawn as a sample. */
  /** The Shapes tool as a split button: the picture picks the tool, drawing the shape last used; the arrow opens the list of shapes. */
  private vectorShapeBox(): Control {
    const r = this.registry;
    const label = t('vector.shapes');
    const main = h('button', { class: 'wm-tbutton wm-split-main', attrs: { type: 'button', tabindex: '-1', 'aria-label': label } });
    const caret = h('button', { class: 'wm-tbutton wm-split-arrow', title: label, attrs: { type: 'button', tabindex: '-1', 'aria-label': label, 'aria-haspopup': 'listbox' } });
    caret.innerHTML = ICONS.dropdown;
    const el = h('span', { class: 'wm-split' }, main, caret);
    let current: string = SHAPE_IDS[0];
    main.addEventListener('click', () => {
      r.perform({ kind: 'vector', op: 'shape' }, label);
      r.focusEditor();
    });
    caret.addEventListener('click', () => {
      if (popupOpenFor(el)) return closePopup();
      const list = h('div', { class: 'wm-list wm-shape-list', attrs: { role: 'listbox', 'aria-label': label } });
      for (const id of SHAPE_IDS) {
        const chosen = id === current;
        const name = t(`vector.shape.${id}` as MessageKey);
        const row = h('div', { class: chosen ? 'wm-option wm-shape-row chosen' : 'wm-option wm-shape-row', title: name, attrs: { role: 'option', 'aria-selected': String(chosen), 'aria-label': name } }, shapePreview(id));
        row.addEventListener('click', () => {
          closePopup();
          r.perform({ kind: 'vector', op: `shape:${id}` }, label);
          r.focusEditor();
        });
        list.append(row);
      }
      openPopup(el, list);
    });
    return {
      el,
      refresh: (state) => {
        current = state.vector.shape;
        main.replaceChildren(shapePreview(current as (typeof SHAPE_IDS)[number]));
        main.title = `${label}: ${t(`vector.shape.${current}` as MessageKey)}`;
        main.setAttribute('aria-pressed', String(state.vector.tool === 'shape'));
        main.disabled = caret.disabled = !r.allows({ kind: 'vector', op: 'shape' });
      },
    };
  }

  private vectorStrokeStyleBox(): Control {
    return this.strokeStyleList(t('vector.strokeStyle'), (state) => state.vector.strokeStyle, (value) => ({ kind: 'vectorStyle', strokeStyle: value }));
  }

  /** The list of ways a line can be drawn, the same one for a drawing and for a picture: dashes, then the brushes in groups, each drawn as a sample. */
  private strokeStyleList(label: string, current: (state: ChromeState) => string, action: (value: string) => Action): Control {
    return dropdown(
      {
        label,
        groups: () => [
          { heading: t('vector.brushGroup.dashes'), values: DASHES.map((d) => `dash:${d.id}`) },
          ...BRUSH_GROUPS.map((g) => ({ heading: t(`vector.brushGroup.${g}`), values: BRUSH_PRESETS.filter((p) => p.group === g).map((p) => `brush:${p.id}`) })),
        ],
        current,
        name: (value) => (value.startsWith('dash:') ? t(`vector.dash.${value.slice(5)}` as MessageKey) : t(`vector.brush.${value.slice(6)}` as MessageKey)),
        sample: (value) => brushPreview(value),
        action,
      },
      this.registry,
    );
  }

  /** The outline width of the selected shapes: a list of widths, each drawn as a line (the same list as the stroke style's), and the shape's own when it is another. */
  private vectorWidthBox(): Control {
    const widths = [0.5, 1, 2, 4, 8, 16, 32];
    return dropdown(
      {
        label: t('vector.strokeWidth'),
        groups: (current) => [{ values: (widths.includes(Number(current)) ? widths : [...widths, Number(current)].sort((x, y) => x - y)).map(String) }],
        current: (state) => String(Math.round(state.vector.strokeWidth * 100) / 100),
        name: (value) => value,
        sample: (value) => lineSample(Number(value)),
        action: (value) => ({ kind: 'vectorStyle', strokeWidth: Number(value) }),
        width: 96,
      },
      this.registry,
    );
  }

  /** A drop-down list of choices for one of the Draw tools' settings: it shows the current one and sends the picked one. */
  private drawSelect(label: string, options: readonly (readonly [string, string])[], current: (state: ChromeState) => string, action: (value: string) => Action, sample?: (value: string) => Node | null): Control {
    const names = new Map(options);
    return dropdown({ label, groups: () => [{ values: options.map(([value]) => value) }], current, name: (value) => names.get(value) ?? value, action, width: 100, ...(sample && { sample }) }, this.registry);
  }

  /** The picture's Shapes tool as a split button, like the vector editor's: the picture picks the tool, the arrow opens the list of shapes. */
  private drawShapeBox(): Control {
    const r = this.registry;
    const label = t('vector.shapes');
    const main = h('button', { class: 'wm-tbutton wm-split-main', attrs: { type: 'button', tabindex: '-1', 'aria-label': label } });
    const caret = h('button', { class: 'wm-tbutton wm-split-arrow', title: label, attrs: { type: 'button', tabindex: '-1', 'aria-label': label, 'aria-haspopup': 'listbox' } });
    caret.innerHTML = ICONS.dropdown;
    const el = h('span', { class: 'wm-split' }, main, caret);
    let current: string = SHAPE_IDS[0];
    main.addEventListener('click', () => {
      r.perform({ kind: 'image', op: 'shape' }, label);
      r.focusEditor();
    });
    caret.addEventListener('click', () => {
      if (popupOpenFor(el)) return closePopup();
      const list = h('div', { class: 'wm-list wm-shape-list', attrs: { role: 'listbox', 'aria-label': label } });
      for (const id of SHAPE_IDS) {
        const chosen = id === current;
        const name = t(`vector.shape.${id}` as MessageKey);
        const row = h('div', { class: chosen ? 'wm-option wm-shape-row chosen' : 'wm-option wm-shape-row', title: name, attrs: { role: 'option', 'aria-selected': String(chosen), 'aria-label': name } }, shapePreview(id));
        row.addEventListener('click', () => {
          closePopup();
          r.perform({ kind: 'image', op: `shape:${id}` }, label);
          r.focusEditor();
        });
        list.append(row);
      }
      openPopup(el, list);
    });
    return {
      el,
      refresh: (state) => {
        current = state.draw.shape;
        main.replaceChildren(shapePreview(current as (typeof SHAPE_IDS)[number]));
        main.title = `${label}: ${t(`vector.shape.${current}` as MessageKey)}`;
        main.setAttribute('aria-pressed', String(state.draw.tool === 'shape'));
        main.disabled = caret.disabled = !r.allows({ kind: 'image', op: 'shape' });
      },
    };
  }

  /** The line thickness to draw with: a small list of steps. */
  private drawSizeBox(): Control {
    const names = ['thin', 'medium', 'thick', 'huge'] as const;
    return dropdown(
      {
        label: t('picture.draw.size'),
        groups: () => [{ values: names.map((_, step) => String(step)) }],
        current: (state) => String(state.draw.size),
        name: (value) => t(`picture.draw.size.${names[Number(value)]}`),
        sample: (value) => lineSample([1.5, 3, 6, 10][Number(value)]),
        action: (value) => ({ kind: 'drawStyle', size: Number(value) }),
        width: 130,
      },
      this.registry,
    );
  }

  // --- Format selector ---------------------------------------------------------------------

  /** "Format: [Word Document ▾]": switches the open document to another format (Action 'convert'). */
  private buildFormatBox(): HTMLElement {
    const { host } = this.options;
    const kindOf = (label: string) => (Object.keys(FORMATS) as (keyof typeof FORMATS)[]).find((k) => FORMATS[k].label === label);
    const combo = comboBox(
      {
        label: t('chrome.formatBox.label'),
        width: 104,
        readOnly: true,
        options: () => this.formatKinds().map((kind) => FORMATS[kind].label),
        groupLabel: (label) => {
          const kind = kindOf(label);
          return kind && t(`menus.format.group.${formatGroup(kind)}`);
        },
        value: (s) => FORMATS[s.kind].label,
        enabled: () => !this.converting,
        title: (s) =>
          FORMATS[s.kind].editable ? t('chrome.formatBox.editableTip') : t('chrome.formatBox.readOnlyTip'),
        commit: (text) => {
          const to = kindOf(text);
          if (!to) return false;
          const action: Action = { kind: 'convert', to };
          if (!host.supports(action)) {
            host.notify(t('chrome.formatBox.unavailable', { format: FORMATS[to].label }));
            return false;
          }
          this.converting = true;
          this.formatCombo.refresh(this.state);
          Promise.resolve(host.perform(action))
            .catch((e: unknown) => host.notify(t('chrome.formatBox.failed', { error: e instanceof Error ? e.message : String(e) })))
            .finally(() => {
              this.converting = false;
              this.formatCombo.refresh(this.state);
              host.focusEditor();
            });
          return true;
        },
      },
      () => this.state,
      () => host.focusEditor(),
    );
    this.formatCombo = combo;
    this.syncButton = new SyncButton(this.options.host);
    this.accountButton = new AccountButton(this.options.host);
    this.palette = new CommandPalette(this.registry, (command) => this.commandInfo(command, command.plainLabel));
    return h(
      'div',
      { class: 'wm-format' },
      this.palette.el,
      h('div', { class: 'wm-format-field' }, combo.el),
      this.syncButton.el,
      this.accountButton.el,
    );
  }

  /** File ▸ Rename: edits the name in the menu bar, or asks in a dialog when there is no room to show it there. */
  private renameDocument(): void {
    // After the menu has closed and handed the keyboard back to the document.
    if (this.docTitle.visible) return void setTimeout(() => this.docTitle.focus(), 0);
    const input = h('input', { attrs: { type: 'text', maxlength: '120', 'aria-label': t('chrome.title.label') }, class: 'wm-rename-input' });
    input.value = displayDocumentName(this.state.documentName, this.state.kind);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') input.closest('dialog')?.querySelector<HTMLElement>('.wm-dialog-buttons button:last-child')?.click();
    });
    void showConfirm(t('chrome.rename.title'), input, t('chrome.rename.action')).then((ok) => {
      if (ok && input.value.trim()) this.options.host.renameDocument(input.value);
      this.options.host.focusEditor();
    });
    input.focus();
    input.select();
  }

  /** The switchable formats, plus the current one if it isn't switchable. */
  private formatKinds(): (keyof typeof FORMATS)[] {
    return convertTargets(this.state.kind);
  }

  /** Lists the formats (plus the current one if it isn't switchable) and shows the current one. */
  private syncFormatBox(): void {
    this.formatCombo.refresh(this.state);
  }

  /** (Re)creates the toolbars from the layout. */
  private buildToolbars(): void {
    const r = this.registry;
    const item = (id: string): ToolbarItem => {
      if (id === SEPARATOR) return tsep;
      const c = this.controls.get(id);
      if (c) return control(c.create);
      // Insert Table gets the drag-out size grid.
      if (id === 'insert.table') return control(() => ({ ...tableGridButton(r, id), available: () => r.isAvailable(r.get(id)) }));
      return btn(id);
    };
    for (const toolbar of this.toolbars) toolbar.dispose();
    this.toolbars.length = 0;
    this.toolbarsEl.replaceChildren();
    for (const t of this.layout) {
      const toolbar = new Toolbar(t.name, r, t.items.map(item));
      toolbar.setShown(t.visible && t.items.length > 0);
      this.toolbars.push(toolbar);
      this.toolbarsEl.append(toolbar.el);
    }
    // On a phone there is one row instead: the main buttons, then every other button from the visible toolbars.
    const primary = new Set(MOBILE_PRIMARY);
    const rest = this.layout.filter((t) => t.visible).flatMap((t) => [SEPARATOR, ...t.items.filter((id) => !primary.has(id))]);
    const mobile = new Toolbar('Standard', r, [...MOBILE_PRIMARY, ...rest].map(item));
    mobile.el.classList.add('wm-mobile-only');
    mobile.setShown(this.layout.some((t) => t.visible && t.items.length > 0));
    this.toolbars.push(mobile);
    this.toolbarsEl.append(mobile.el);
    // The document area changes size; the canvas's ResizeObserver takes it from there.
    this.syncToolbarsHidden();
    this.refresh();
  }

  private setLayout(layout: ToolbarLayout[]): void {
    closePopup();
    this.layout = layout;
    saveLayout(layout);
    this.buildToolbars();
  }

  private toggleToolbar(name: string): void {
    this.setLayout(this.layout.map((t) => (t.name === name ? { ...t, visible: !t.visible } : t)));
  }

  /** A command's category (its menu) and its label, given its own name for it, as lists of every command show it. */
  private commandInfo(command: Command, own: string): { label: string; category: string } {
    const categories: Record<string, string> = {
      file: t('chrome.category.file'),
      edit: t('chrome.category.edit'),
      view: t('chrome.category.view'),
      insert: t('chrome.category.insert'),
      format: t('chrome.category.format'),
      tools: t('chrome.category.tools'),
      table: t('chrome.category.table'),
      help: t('chrome.category.help'),
    };
    // Each prefix is a whole message with the command's own label as {label}.
    const prefixes: [string, string][] = [
      ['file.convertTo.', t('chrome.catalog.convertTo')],
      ['format.case.', t('chrome.catalog.changeCase')],
      ['format.spacing.', t('chrome.catalog.lineSpacing')],
      ['table.', t('chrome.catalog.table')],
      ['view.toolbar.', t('chrome.catalog.toolbar')],
    ];
    const category = categories[command.id.split('.')[0]] ?? t('chrome.category.other');
    const prefix = prefixes.find(([p]) => command.id.startsWith(p))?.[1];
    return { label: prefix ? format(prefix, { label: own }) : own, category };
  }

  /** Everything that can go on a toolbar, grouped by menu. */
  private catalog(): CatalogItem[] {
    const items: CatalogItem[] = [];
    const byCategory = new Map<string, CatalogItem[]>();
    for (const command of this.registry.all()) {
      if (command.id === 'view.customizeToolbars' || command.id === 'view.toolbars') continue;
      const { label, category } = this.commandInfo(command, command.tooltip ?? command.plainLabel);
      if (!byCategory.has(category)) byCategory.set(category, []);
      byCategory.get(category)!.push({ id: command.id, label, category });
    }
    for (const [id, c] of this.controls) byCategory.get(c.category)?.unshift({ id, label: c.label, category: c.category });
    for (const list of byCategory.values()) items.push(...list);
    return items;
  }

  private customize(): void {
    this.menuBar.close(false);
    closePopup();
    showCustomize({
      layout: () => this.layout,
      defaults: DEFAULT_LAYOUT,
      catalog: this.catalog(),
      icon: (id) => {
        const c = this.controls.get(id);
        return iconElement(c ? c.icon : this.registry.get(id).icon);
      },
      apply: (layout) => this.setLayout(layout),
      onClose: () => this.options.host.focusEditor(),
    });
  }

  private showDebug(): void {
    this.menuBar.close(false);
    closePopup();
    showDialog(t('chrome.debug.title'), debugSettings(), () => this.options.host.focusEditor());
  }

  private showBilling(): void {
    this.menuBar.close(false);
    closePopup();
    showDialog(t('chrome.billing.title'), billingPanel(), () => this.options.host.focusEditor());
  }

  private showAnalytics(): void {
    this.menuBar.close(false);
    closePopup();
    showDialog(t('chrome.analytics.title'), analyticsPanel(), () => this.options.host.focusEditor());
  }

  private showFeedback(): void {
    this.menuBar.close(false);
    closePopup();
    showDialog(t('chrome.feedback.title'), feedbackPanel(), () => this.options.host.focusEditor());
  }

  // --- Help ----------------------------------------------------------------------------------

  private sendFeedback(): void {
    this.menuBar.close(false);
    closePopup();
    void showFeedbackDialog().then((sent) => {
      if (sent) this.options.host.notify(t('chrome.feedback.thanks'));
      this.options.host.focusEditor();
    });
  }

  private showShortcuts(): void {
    const table = h('table', { class: 'wm-shortcuts' });
    const status = h('div', { class: 'wm-shortcuts-status', attrs: { role: 'status' } });
    const reset = h('button', { class: 'wm-button', text: t('chrome.shortcuts.default'), attrs: { type: 'button' } });
    let recording: (() => void) | null = null;

    const render = () => {
      recording = null;
      table.replaceChildren();
      const commands = [...this.registry.all()];
      const rows = [...commands.filter((c) => !c.scope), ...commands.filter((c) => c.scope === 'vector'), ...commands.filter((c) => c.scope === 'picture')];
      const headers = new Set<string>();
      for (const command of rows) {
        const vector = command.scope !== undefined;
        // The vector editor's and the picture tools' sections list every command, so any of them can be given a key.
        if (!vector && !command.shortcutParsed && !command.defaultShortcut) continue;
        if (command.scope && !headers.has(command.scope)) {
          headers.add(command.scope);
          const picture = command.scope === 'picture';
          table.append(h('tr', { class: 'wm-shortcuts-section' }, h('th', { text: t(picture ? 'chrome.shortcuts.picture' : 'chrome.shortcuts.vector'), attrs: { colspan: '2', scope: 'colgroup' } })));
          table.append(h('tr', {}, h('td', { class: 'wm-shortcuts-note', text: t(picture ? 'chrome.shortcuts.pictureHint' : 'chrome.shortcuts.vectorHint'), attrs: { colspan: '2' } })));
        }
        const key = h('button', {
          class: 'wm-shortcut-key',
          attrs: { type: 'button', 'aria-label': t('chrome.shortcuts.change', { label: command.plainLabel }) },
        });
        const show = () => {
          key.classList.remove('recording');
          key.textContent = command.shortcutText || t('chrome.shortcuts.none');
          key.classList.toggle('none', !command.shortcutText);
        };
        show();
        if (command.nativeShortcut) {
          // The browser handles these keys itself (clipboard), so they are shown but fixed.
          key.disabled = true;
        } else {
          const stop = () => {
            key.removeEventListener('keydown', onKey);
            key.removeEventListener('blur', stop);
            recording = null;
            show();
          };
          const onKey = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Tab') return stop();
            const bare = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
            if (bare && e.key === 'Escape') return stop();
            let shortcut: Shortcut | null = null;
            if (bare && (e.key === 'Backspace' || e.key === 'Delete')) {
              status.textContent = '';
            } else {
              shortcut = shortcutFromEvent(e);
              if (!shortcut) return; // a modifier on its own: wait for the rest
              if (!isUsableShortcut(shortcut, vector)) {
                status.textContent = t(vector ? 'chrome.shortcuts.needKey' : 'chrome.shortcuts.needModifier');
                return;
              }
            }
            const taken = this.registry.setShortcut(command.id, shortcut);
            status.textContent = taken ? t('chrome.shortcuts.moved', { label: taken }) : '';
            this.refresh();
            const focused = command.id;
            render();
            table.querySelector<HTMLElement>(`[data-command="${focused}"]`)?.focus();
          };
          key.dataset.command = command.id;
          key.addEventListener('click', () => {
            recording?.();
            key.classList.add('recording');
            key.textContent = t('chrome.shortcuts.press');
            status.textContent = '';
            recording = stop;
            key.addEventListener('keydown', onKey);
            key.addEventListener('blur', stop);
          });
        }
        table.append(h('tr', {}, h('td', { text: command.plainLabel }), h('td', {}, key)));
      }
    };
    render();
    reset.addEventListener('click', () => {
      this.registry.resetShortcuts();
      this.refresh();
      status.textContent = '';
      render();
    });

    const footer = h('div', { class: 'wm-shortcuts-footer' }, h('span', { class: 'wm-shortcuts-hint', text: t('chrome.shortcuts.hint') }), reset);
    showDialog(t('chrome.shortcuts.title'), h('div', {}, footer, status, h('div', { class: 'wm-scroll' }, table)), () => this.options.host.focusEditor());
  }
}

/** The picture tools' built-in keys, as in Photoshop (a tool is a bare key; Mod is ⌘ or Ctrl). */
const PICTURE_KEYS: Partial<Record<string, string>> = {
  move: 'V',
  pen: 'B',
  marker: 'Shift+B',
  eraser: 'E',
  line: 'L',
  arrow: 'Shift+L',
  rectangle: 'U',
  ellipse: 'Shift+U',
  shape: 'Alt+U',
  text: 'T',
  bubble: 'Shift+T',
  step: 'Shift+I',
  pixelate: 'X',
  smudge: 'R',
  blurBrush: 'Shift+R',
  sharpenBrush: 'Alt+R',
  mixer: 'Alt+B',
  dodge: 'O',
  burn: 'Shift+O',
  eyedropper: 'I',
  bucket: 'G',
  crop: 'C',
  resize: 'Alt+Mod+I',
  canvasSize: 'Alt+Mod+C',
  invert: 'Mod+I',
  layers: 'F7',
  newLayer: 'Shift+Mod+N',
  duplicate: 'Mod+J',
  group: 'Mod+G',
  ungroup: 'Shift+Mod+G',
  front: 'Shift+Mod+]',
  forward: 'Mod+]',
  backward: 'Mod+[',
  back: 'Shift+Mod+[',
  selectAll: 'Mod+A',
  deselect: 'Mod+D',
  sizeDown: '[',
  sizeUp: ']',
};

/** The vector editor's built-in keys, as in Illustrator (a tool is a bare key; Mod is ⌘ or Ctrl). */
const VECTOR_TOOL_KEYS: Partial<Record<ChromeState['vector']['tool'], string>> = { select: 'V', rect: 'M', ellipse: 'L', shape: 'S', line: '\\', pen: 'P', pencil: 'N', nudge: 'B', text: 'T', canvas: 'C' };
const VECTOR_KEYS: Partial<Record<string, string>> = {
  duplicate: 'Mod+D',
  group: 'Mod+G',
  ungroup: 'Shift+Mod+G',
  front: 'Shift+Mod+]',
  forward: 'Mod+]',
  backward: 'Mod+[',
  back: 'Shift+Mod+[',
};

/** A hint of each style's look in the style list. */
function styleOptionCss(style: string): string {
  const heading = /^Heading (\d)$/.exec(style);
  if (heading) return `font-weight:700;font-size:${Math.max(11, 17 - Number(heading[1]) * 1.5)}px`;
  switch (style) {
    case 'Title':
      return 'font-size:17px';
    case 'Subtitle':
      return 'font-style:italic;color:#555';
    case 'Quote':
    case 'Intense Quote':
      return 'font-style:italic';
    case 'Code':
      return 'font-family:ui-monospace,monospace';
  }
  return '';
}

export function mountChrome(parent: HTMLElement, options: ChromeOptions): Chrome {
  const chrome = new Chrome(options);
  parent.append(chrome.el);
  return chrome;
}
