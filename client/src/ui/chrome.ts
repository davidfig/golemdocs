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
  type FormMode,
  type Mark,
  type TableOp,
  type ZoomTarget,
} from './actions.ts';
import { CommandRegistry, type CommandSpec } from './commands.ts';
import { h } from './dom.ts';
import { CONVERT_ORDER, FORMATS } from './formats.ts';
import { MenuBar, cmd, isFormField, sep, sub, type MenuItem, type TopMenu } from './menu.ts';
import { closePopup, setPopupLayer, showDialog } from './popup.ts';
import { matches } from './shortcuts.ts';
import { Toolbar, btn, colorButton, comboBox, control, tableGridButton, tsep, type Control, type ToolbarItem } from './toolbar.ts';
import { showCustomize, type CatalogItem } from './customize.ts';
import { iconElement } from './icons.ts';
import { SyncButton } from './syncButton.ts';
import { DEFAULT_LAYOUT, SEPARATOR, loadLayout, saveLayout, type ToolbarLayout } from './toolbarLayout.ts';
import './ui.css';

export interface ChromeOptions {
  host: ChromeHost;
  /**
   * Leave commands the document's format supports enabled even when the host hasn't
   * implemented them yet; they report "isn't available yet". Default false.
   */
  showUnimplemented?: boolean;
  /** For the window title and About box. Default "Golem Docs". */
  appName?: string;
}

const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];
const ZOOM_PRESETS: { label: string; to: ZoomTarget }[] = [
  { label: '500%', to: 5 },
  { label: '200%', to: 2 },
  { label: '150%', to: 1.5 },
  { label: '100%', to: 1 },
  { label: '75%', to: 0.75 },
  { label: '50%', to: 0.5 },
  { label: '25%', to: 0.25 },
  { label: '10%', to: 0.1 },
  { label: 'Page Width', to: 'pageWidth' },
  { label: 'Whole Page', to: 'wholePage' },
  { label: 'All Pages', to: 'allPages' },
];
const DEFAULT_FONTS = ['Arial', 'Calibri', 'Cambria', 'Comic Sans MS', 'Courier New', 'Georgia', 'Segoe UI', 'Times New Roman'];
const SYMBOLS: [string, string][] = [
  ['©', 'Copyright'],
  ['®', 'Registered'],
  ['™', 'Trademark'],
  ['§', 'Section'],
  ['¶', 'Paragraph'],
  ['…', 'Ellipsis'],
  ['—', 'Em Dash'],
  ['–', 'En Dash'],
  ['•', 'Bullet'],
  ['°', 'Degree'],
  ['±', 'Plus-Minus'],
  ['×', 'Multiply'],
  ['÷', 'Divide'],
  ['€', 'Euro'],
  ['£', 'Pound'],
  ['¥', 'Yen'],
];

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
  /** Fill in a PDF's form or edit it: beside the format selector, for a PDF's pages. */
  private formModeBox!: HTMLElement;
  /** Where the document is kept (this browser, or synced), at the far right. */
  private syncButton!: SyncButton;

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

    this.menuBar = new MenuBar(this.registry, this.menus(), this.layer);
    this.toolbarsEl = h('div', { class: 'wm-toolbars' });
    this.toolbarsEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.customize();
    });
    this.formatBox = this.buildFormatBox();
    this.el = h('div', { class: 'wm-chrome' }, this.menuBar.el, this.formatBox, this.toolbarsEl);
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
  }

  getState(): ChromeState {
    return this.state;
  }

  private refresh(): void {
    for (const toolbar of this.toolbars) toolbar.refresh(this.state);
    this.toolbarsEl.hidden = this.toolbars.every((t) => t.el.hidden);
    this.menuBar.refresh();
    this.syncFormatBox();
    this.syncButton.update(this.state.sync);
    const name = this.state.documentName;
    const title = name ? `${name} - ${this.appName}` : this.appName;
    if (document.title !== title) document.title = title;
  }

  private shortcut(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.isComposing || this.menuBar.active) return;
    if (isFormField(e.target) || document.querySelector('dialog[open]')) return;
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !/^F\d+$/.test(e.key)) return;
    for (const command of this.registry.all()) {
      if (!command.shortcutParsed || command.nativeShortcut || !matches(command.shortcutParsed, e)) continue;
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
      a('file.dashboard', '&Dashboard', { kind: 'dashboard' }, { tooltip: 'See all your documents' }),
      a('file.new', '&New', { kind: 'new' }, { icon: 'new', tooltip: 'New Blank Document' }),
      a('file.open', '&Open…', { kind: 'open' }, { icon: 'open', shortcut: 'Mod+O' }),
      a('file.download', 'Do&wnload', { kind: 'download' }, { tooltip: 'Download a copy of this document' }),
      a('file.saveToCloud', 'Save to &Cloud', { kind: 'saveToCloud' }, { tooltip: 'Keep a copy in your account (sign-in required)' }),
      dialog('file.pageSetup', 'Page Set&up…', 'pageSetup'),
      a('file.printPreview', 'Print Pre&view', { kind: 'printPreview' }, { icon: 'printPreview' }),
      a('file.collaborate', '&Collaborate…', { kind: 'collaborate' }, { tooltip: 'Edit this document together (opens a second window)' }),
      a('file.print', '&Print…', { kind: 'print' }, { icon: 'print', shortcut: 'Mod+P' }),
      dialog('file.properties', 'Propert&ies', 'properties', { icon: 'properties' }),
      a('file.clearLocalData', 'C&lear Local Data…', { kind: 'clearLocalData' }, { tooltip: 'Delete every document and setting kept in this browser' }),
    );
    for (const kind of CONVERT_ORDER) {
      const profile = FORMATS[kind];
      r.add(a(`file.convertTo.${kind}`, `${profile.label} (${profile.extensions[0]})`, { kind: 'convert', to: kind }, { enabled: (s) => s.kind !== kind }));
    }

    // Edit
    r.add(
      a('edit.undo', '&Undo', { kind: 'undo' }, { icon: 'undo', shortcut: 'Mod+Z', enabled: (s) => s.canUndo }),
      a('edit.redo', '&Redo', { kind: 'redo' }, { icon: 'redo', shortcut: { mac: 'Mod+Shift+Z', other: 'Mod+Y' }, enabled: (s) => s.canRedo }),
      a('edit.cut', 'Cu&t', { kind: 'cut' }, { icon: 'cut', shortcut: 'Mod+X', nativeShortcut: true, enabled: (s) => s.hasSelection }),
      a('edit.copy', '&Copy', { kind: 'copy' }, { icon: 'copy', shortcut: 'Mod+C', nativeShortcut: true, enabled: (s) => s.hasSelection }),
      a('edit.paste', '&Paste', { kind: 'paste' }, { icon: 'paste', shortcut: 'Mod+V', nativeShortcut: true }),
      dialog('edit.pasteSpecial', 'Paste &Special…', 'pasteSpecial'),
      a('edit.selectAll', 'Select A&ll', { kind: 'selectAll' }, { shortcut: 'Mod+A' }),
      dialog('edit.find', '&Find…', 'find', { icon: 'find', shortcut: 'Mod+F' }),
      dialog('edit.replace', 'R&eplace…', 'replace', { shortcut: { other: 'Mod+H', mac: 'Ctrl+H' } }),
      dialog('edit.goTo', '&Go To…', 'goTo', { shortcut: 'Mod+G' }),
    );

    // View
    const mode = (id: string, label: string, m: ChromeState['viewMode']) =>
      a(id, label, { kind: 'viewMode', mode: m }, { checked: (s) => s.viewMode === m, radio: true });
    r.add(
      mode('view.normal', '&Normal', 'normal'),
      mode('view.web', '&Web Layout', 'web'),
      mode('view.print', '&Print Layout', 'print'),
      mode('view.outline', '&Outline', 'outline'),
      a('view.fillForm', '&Fill In Form', { kind: 'setFormMode', mode: 'fill' }, { checked: (s) => s.formMode === 'fill', radio: true, tooltip: 'Type in the PDF’s fields' }),
      a('view.editForm', '&Edit Form', { kind: 'setFormMode', mode: 'edit' }, { checked: (s) => s.formMode === 'edit', radio: true, tooltip: 'Move, add, rename and delete the PDF’s fields' }),
      a('view.grid', 'Page &Grid', { kind: 'toggleGrid' }, { shortcut: 'Alt+G', checked: (s) => s.grid }),
      a('view.ruler', '&Ruler', { kind: 'toggleRuler' }, { checked: (s) => s.rulerVisible }),
      a('view.stats', 'Performance &Stats', { kind: 'toggleStats' }, { checked: (s) => s.statsVisible }),
      a('view.formattingMarks', 'Formatting &Marks', { kind: 'toggleFormattingMarks' }, {
        icon: 'paragraphMarks',
        tooltip: 'Show/Hide ¶',
        shortcut: 'Mod+Shift+8',
        checked: (s) => s.formattingMarks,
      }),
      {
        id: 'view.fullScreen',
        label: 'F&ull Screen',
        run: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}),
        checked: () => !!document.fullscreenElement,
        enabled: () => document.fullscreenEnabled,
      },
      a('view.zoomIn', 'Zoom &In', { kind: 'zoomBy', factor: 1.25 }, { shortcut: 'Mod+=' }),
      a('view.zoomOut', 'Zoom &Out', { kind: 'zoomBy', factor: 0.8 }, { shortcut: 'Mod+-' }),
      a('view.zoom100', '&Actual Size', { kind: 'zoom', to: 1 }, { shortcut: 'Mod+0' }),
      a('view.pageWidth', 'Page &Width', { kind: 'zoom', to: 'pageWidth' }),
      a('view.wholePage', 'W&hole Page', { kind: 'zoom', to: 'wholePage' }),
      a('view.allPages', 'All Pa&ges', { kind: 'zoom', to: 'allPages' }, { shortcut: { mac: 'Alt+F' } }),
    );
    for (const name of ['Standard', 'Formatting']) {
      r.add({
        id: `view.toolbar.${name.toLowerCase()}`,
        label: name === 'Standard' ? '&Standard' : '&Formatting',
        run: () => this.toggleToolbar(name),
        checked: () => this.layout.find((t) => t.name === name)?.visible ?? false,
      });
    }
    r.add({ id: 'view.customizeToolbars', label: 'Customi&ze…', run: () => this.customize() });

    // Insert
    r.add(
      a('insert.pageBreak', '&Page Break', { kind: 'insertBreak', break: 'page' }, { icon: 'pageBreak', shortcut: 'Mod+Enter' }),
      a('insert.columnBreak', '&Column Break', { kind: 'insertBreak', break: 'column' }, { shortcut: 'Mod+Shift+Enter' }),
      a('insert.lineBreak', '&Line Break', { kind: 'insertBreak', break: 'line' }, { shortcut: 'Shift+Enter', nativeShortcut: true }),
      a('insert.sectionNext', 'Section Break (&Next Page)', { kind: 'insertBreak', break: 'sectionNextPage' }),
      a('insert.sectionContinuous', 'Section Break (Co&ntinuous)', { kind: 'insertBreak', break: 'sectionContinuous' }),
      dialog('insert.pageNumbers', 'Page N&umbers…', 'pageNumbers'),
      a('insert.comment', 'Co&mment', { kind: 'insertComment' }, { icon: 'comment', shortcut: 'Mod+Alt+M' }),
      a('insert.footnote', 'Foot&note', { kind: 'insertFootnote' }, { shortcut: 'Mod+Alt+F' }),
      a('insert.image', '&Picture…', { kind: 'insertImage' }, { icon: 'image' }),
      a('insert.textBox', 'Te&xt Box', { kind: 'insertTextBox' }),
      a('insert.table', '&Table…', { kind: 'insertTable' }, { icon: 'table', tooltip: 'Insert Table' }),
      a('insert.horizontalRule', 'Hori&zontal Line', { kind: 'insertHorizontalRule' }),
      a('insert.codeBlock', 'Code Bloc&k', { kind: 'insertCodeBlock' }),
      a('insert.link', 'Hyperl&ink…', { kind: 'insertLink' }, { icon: 'link', shortcut: 'Mod+K', tooltip: 'Insert Hyperlink' }),
      a('insert.bookmark', 'Boo&kmark…', { kind: 'insertBookmark' }),
    );

    // Format: character
    const mark = (m: Mark, label: string, shortcut?: CommandSpec['shortcut']) =>
      a(`format.${m}`, label, { kind: 'toggleMark', mark: m }, { icon: m, shortcut, checked: (s) => !!s.format.marks?.[m] });
    r.add(
      mark('bold', '&Bold', 'Mod+B'),
      mark('italic', '&Italic', 'Mod+I'),
      mark('underline', '&Underline', 'Mod+U'),
      mark('strikethrough', 'Stri&kethrough', { other: 'Alt+Shift+5', mac: 'Mod+Shift+X' }),
      mark('superscript', 'Su&perscript', 'Mod+.'),
      mark('subscript', 'Su&bscript', 'Mod+,'),
      mark('code', '&Code'),
      a('format.growFont', '&Grow Font', { kind: 'growFont' }, { icon: 'growFont', shortcut: 'Mod+]' }),
      a('format.shrinkFont', 'S&hrink Font', { kind: 'shrinkFont' }, { icon: 'shrinkFont', shortcut: 'Mod+[' }),
      a('format.clear', 'Clear F&ormatting', { kind: 'clearFormatting' }, { icon: 'clearFormatting', shortcut: 'Mod+Space' }),
      a('format.painter', 'Format &Painter', { kind: 'formatPainter' }, { icon: 'formatPainter' }),
      dialog('format.font', '&Font…', 'font', { shortcut: 'Mod+D' }),
    );
    const cases: [CaseChange, string][] = [
      ['sentence', '&Sentence case.'],
      ['lower', '&lowercase'],
      ['upper', '&UPPERCASE'],
      ['title', '&Title Case'],
      ['toggle', 't&OGGLE cASE'],
    ];
    for (const [to, label] of cases) r.add(a(`format.case.${to}`, label, { kind: 'changeCase', to }));

    // Format: paragraph
    const align = (to: Alignment, label: string, icon: string, shortcut: string) =>
      a(`format.align.${to}`, label, { kind: 'setAlignment', align: to }, { icon, shortcut, checked: (s) => s.format.align === to, radio: true });
    r.add(
      align('left', 'Align &Left', 'alignLeft', 'Mod+L'),
      align('center', '&Center', 'alignCenter', 'Mod+E'),
      align('right', 'Align &Right', 'alignRight', 'Mod+R'),
      align('justify', '&Justify', 'justify', 'Mod+J'),
      a('format.bullets', '&Bullets', { kind: 'toggleList', list: 'bullet' }, { icon: 'bullets', checked: (s) => s.format.list === 'bullet' }),
      a('format.numbering', '&Numbering', { kind: 'toggleList', list: 'number' }, { icon: 'numbering', checked: (s) => s.format.list === 'number' }),
      a('format.indent', '&Increase Indent', { kind: 'indent', direction: 'increase' }, { icon: 'indentIncrease', shortcut: { other: 'Mod+M' } }),
      a('format.outdent', '&Decrease Indent', { kind: 'indent', direction: 'decrease' }, { icon: 'indentDecrease', shortcut: { other: 'Mod+Shift+M' } }),
      dialog('format.paragraph', '&Paragraph…', 'paragraph'),
      dialog('format.bulletsAndNumbering', 'Bullets and &Numbering…', 'bulletsAndNumbering'),
      dialog('format.borders', 'Bor&ders and Shading…', 'bordersAndShading', { icon: 'borders' }),
      dialog('format.columns', '&Columns…', 'columns', { icon: 'columns' }),
      dialog('format.tabs', '&Tabs…', 'tabs'),
      dialog('format.styles', 'St&yles…', 'styles'),
    );
    for (const lines of [1, 1.15, 1.5, 2, 2.5, 3]) {
      r.add(a(`format.spacing.${lines}`, lines.toFixed(lines % 1 ? 2 : 1).replace(/0$/, ''), { kind: 'setLineSpacing', lines }));
    }

    // Tools
    r.add(
      dialog('tools.spelling', '&Spelling and Grammar…', 'spelling', { icon: 'spelling', shortcut: 'F7' }),
      dialog('tools.wordCount', '&Word Count…', 'wordCount', { icon: 'wordCount' }),
      a('tools.trackChanges', '&Track Changes', { kind: 'toggleTrackChanges' }, { icon: 'trackChanges', shortcut: 'Mod+Shift+E', checked: (s) => s.trackChanges }),
      dialog('tools.options', '&Options…', 'options'),
    );

    // Table
    const table = (op: TableOp, label: string) => a(`table.${op}`, label, { kind: 'table', op });
    r.add(
      table('insertRowAbove', 'Rows &Above'),
      table('insertRowBelow', 'Rows &Below'),
      table('insertColumnLeft', 'Columns to the &Left'),
      table('insertColumnRight', 'Columns to the &Right'),
      table('deleteTable', '&Table'),
      table('deleteRows', '&Rows'),
      table('deleteColumns', '&Columns'),
      table('mergeCells', '&Merge Cells'),
      table('splitCells', 'S&plit Cells…'),
      table('selectTable', 'Select &Table'),
      table('properties', 'Table P&roperties…'),
    );

    // Help
    r.add(
      { id: 'help.shortcuts', label: '&Keyboard Shortcuts', icon: 'help', shortcut: 'F1', run: () => this.showShortcuts() },
      // The welcome document says what the app is and where its name comes from.
      a('help.about', `&About ${this.options.appName ?? 'Golem Docs'}`, { kind: 'openSample', id: 'welcome' }),
    );
  }

  // --- Menus -------------------------------------------------------------------------------

  private menus(): TopMenu[] {
    const host = this.options.host;
    const r = this.registry;
    const insertText = (text: string, label: string, hint?: string): MenuItem => ({
      type: 'item',
      label,
      hint,
      enabled: r.allows({ kind: 'insertText', text }),
      available: () => r.availableFor({ kind: 'insertText', text }),
      run: () => r.perform({ kind: 'insertText', text }, 'Insert'),
    });

    return [
      {
        label: '&File',
        items: [
          cmd('file.dashboard'),
          sep,
          cmd('file.new'),
          cmd('file.open'),
          sub('Open Sa&mple', () => {
            const samples = host.samples?.() ?? [];
            if (!samples.length) return [{ type: 'item', label: '(none)', enabled: false, run: () => {} }];
            return samples.map((s) => ({ type: 'item', label: s.label, run: () => r.perform({ kind: 'openSample', id: s.id }, s.label) }));
          }),
          sub('Open &Recent', () => {
            const saved = host.saved?.() ?? [];
            if (!saved.length) return [{ type: 'item', label: '(none)', enabled: false, run: () => {} }];
            return saved.map((s) => ({ type: 'item', label: s.label, run: () => r.perform({ kind: 'openSaved', id: s.id }, s.label) }));
          }),
          sub('Cloud &Documents', () => {
            const cloud = host.cloud?.();
            if (!cloud?.signedIn) {
              return [{ type: 'item', label: 'Sign in to see your cloud documents…', run: () => r.perform({ kind: 'signIn' }, 'Sign in') }];
            }
            const docs: MenuItem[] = cloud.documents.length
              ? cloud.documents.map((s) => ({ type: 'item', label: s.label, run: () => r.perform({ kind: 'openCloud', id: s.id }, s.label) }))
              : [{ type: 'item', label: '(none)', enabled: false, run: () => {} }];
            const who = cloud.user ? ` (${cloud.user.replace(/&/g, '&&')})` : '';
            return [...docs, sep, { type: 'item', label: `Sign &out${who}`, run: () => r.perform({ kind: 'signOut' }, 'Sign out') }];
          }),
          sep,
          cmd('file.saveToCloud'),
          sub('Con&vert To', CONVERT_ORDER.map((k) => cmd(`file.convertTo.${k}`))),
          cmd('file.download'),
          cmd('file.collaborate'),
          sep,
          cmd('file.pageSetup'),
          cmd('file.printPreview'),
          cmd('file.print'),
          sep,
          cmd('file.properties'),
          sep,
          cmd('file.clearLocalData'),
        ],
      },
      {
        label: '&Edit',
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
        ],
      },
      {
        label: '&View',
        items: [
          cmd('view.normal'),
          cmd('view.web'),
          cmd('view.print'),
          cmd('view.outline'),
          sep,
          sub('&Toolbars', [cmd('view.toolbar.standard'), cmd('view.toolbar.formatting'), sep, cmd('view.customizeToolbars')]),
          cmd('view.ruler'),
          cmd('view.formattingMarks'),
          cmd('view.stats'),
          sep,
          cmd('view.fillForm'),
          cmd('view.editForm'),
          sep,
          cmd('view.grid'),
          cmd('view.fullScreen'),
          sub(
            '&Zoom',
            () => [
              ...ZOOM_PRESETS.filter((p) => typeof p.to === 'number').map(
                (p): MenuItem => ({
                  type: 'item',
                  label: p.label,
                  checked: Math.abs(this.state.zoom - (p.to as number)) < 0.005,
                  run: () => r.perform({ kind: 'zoom', to: p.to }, 'Zoom'),
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
        label: '&Insert',
        items: [
          sub('&Break', [cmd('insert.pageBreak'), cmd('insert.columnBreak'), cmd('insert.lineBreak'), sep, cmd('insert.sectionNext'), cmd('insert.sectionContinuous')], 'pageBreak'),
          cmd('insert.pageNumbers'),
          sub('Date and &Time', () => {
            const now = new Date();
            return [
              insertText(now.toLocaleDateString(undefined, { dateStyle: 'long' }), now.toLocaleDateString(undefined, { dateStyle: 'long' })),
              insertText(now.toLocaleDateString(undefined, { dateStyle: 'full' }), now.toLocaleDateString(undefined, { dateStyle: 'full' })),
              insertText(now.toLocaleDateString(), now.toLocaleDateString()),
              insertText(now.toISOString().slice(0, 10), now.toISOString().slice(0, 10)),
              insertText(now.toLocaleTimeString(undefined, { timeStyle: 'short' }), now.toLocaleTimeString(undefined, { timeStyle: 'short' })),
            ];
          }),
          sub('&Symbol', () => SYMBOLS.map(([c, name]) => insertText(c, `${c}   ${name}`)), 'symbol'),
          sep,
          cmd('insert.comment'),
          cmd('insert.footnote'),
          sep,
          cmd('insert.image'),
          cmd('insert.textBox'),
          cmd('insert.table'),
          cmd('insert.horizontalRule'),
          cmd('insert.codeBlock'),
          sep,
          cmd('insert.link'),
          cmd('insert.bookmark'),
        ],
      },
      {
        label: 'F&ormat',
        items: [
          cmd('format.font'),
          cmd('format.paragraph'),
          cmd('format.bulletsAndNumbering'),
          cmd('format.borders'),
          cmd('format.columns'),
          cmd('format.tabs'),
          sep,
          sub('C&haracter', [
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
          sub('&Align', [cmd('format.align.left'), cmd('format.align.center'), cmd('format.align.right'), cmd('format.align.justify')], 'alignLeft'),
          sub('&Line Spacing', [1, 1.15, 1.5, 2, 2.5, 3].map((n) => cmd(`format.spacing.${n}`)), 'lineSpacing'),
          sub('Change Cas&e', ['sentence', 'lower', 'upper', 'title', 'toggle'].map((c) => cmd(`format.case.${c}`))),
          sep,
          cmd('format.styles'),
          cmd('format.painter'),
          cmd('format.clear'),
        ],
      },
      {
        label: '&Tools',
        items: [cmd('tools.spelling'), cmd('tools.wordCount'), sep, cmd('tools.trackChanges'), sep, cmd('view.customizeToolbars'), cmd('tools.options')],
      },
      {
        label: 'T&able',
        items: [
          cmd('insert.table'),
          sub('&Insert', [cmd('table.insertRowAbove'), cmd('table.insertRowBelow'), cmd('table.insertColumnLeft'), cmd('table.insertColumnRight')]),
          sub('&Delete', [cmd('table.deleteTable'), cmd('table.deleteRows'), cmd('table.deleteColumns')]),
          sep,
          cmd('table.mergeCells'),
          cmd('table.splitCells'),
          sep,
          cmd('table.selectTable'),
          cmd('table.properties'),
        ],
      },
      {
        label: '&Help',
        items: [cmd('help.shortcuts'), sep, cmd('help.about')],
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

    define('control.zoom', 'Zoom Box', 'View', 'zoom', () =>
      comboBox(
        {
          label: 'Zoom',
          width: 52,
          options: () => ZOOM_PRESETS.map((p) => p.label),
          value: (s) => `${Math.round(s.zoom * 100)}%`,
          enabled: () => true,
          commit: (text) => {
            const preset = ZOOM_PRESETS.find((p) => p.label.toLowerCase() === text.toLowerCase());
            const percent = parseFloat(text);
            const to = preset?.to ?? (percent > 0 ? percent / 100 : NaN);
            if (typeof to === 'number' && !(to > 0)) return false;
            r.perform({ kind: 'zoom', to }, 'Zoom');
            return true;
          },
        },
        state,
        focus,
      ),
    );

    define('control.style', 'Style Box', 'Format', 'combo', () =>
      gated(
        comboBox(
          {
            label: 'Style',
            width: 96,
            options: () => [...profile().styles],
            value: (s) => s.format.style ?? '',
            enabled: () => profile().editable && profile().styles.length > 0 && r.allows({ kind: 'setStyle', style: profile().styles[0] }),
            optionStyle: (style) => styleOptionCss(style),
            commit: (text) => {
              const style = profile().styles.find((s) => s.toLowerCase() === text.toLowerCase());
              if (!style) {
                this.options.host.notify(`There's no style named "${text}"`);
                return false;
              }
              r.perform({ kind: 'setStyle', style }, 'Style');
              return true;
            },
          },
          state,
          focus,
        ),
        () => profile().styles.length > 0,
      ),
    );

    define('control.font', 'Font Box', 'Format', 'combo', () =>
      gated(
        comboBox(
          {
            label: 'Font',
            width: 128,
            options: () => [...this.recentFonts, ...this.fonts],
            headerCount: () => this.recentFonts.length,
            value: (s) => s.format.font ?? '',
            enabled: () => r.allows({ kind: 'setFont', family: 'Calibri' }),
            optionStyle: (font) => `font-family:${JSON.stringify(font)},system-ui;font-size:13px`,
            commit: (text) => {
              const family = this.fonts.find((f) => f.toLowerCase() === text.toLowerCase()) ?? text;
              this.recentFonts = [family, ...this.recentFonts.filter((f) => f !== family)].slice(0, 3);
              r.perform({ kind: 'setFont', family }, 'Font');
              return true;
            },
          },
          state,
          focus,
        ),
        () => profile().fonts,
      ),
    );

    define('control.size', 'Font Size Box', 'Format', 'combo', () =>
      gated(
        comboBox(
          {
            label: 'Font Size',
            width: 30,
            options: () => FONT_SIZES.map(String),
            value: (s) => (s.format.size ? String(s.format.size) : ''),
            enabled: () => r.allows({ kind: 'setFontSize', points: 11 }),
            commit: (text) => {
              const points = Math.round(parseFloat(text) * 2) / 2;
              if (!(points >= 1 && points <= 1638)) {
                this.options.host.notify('The font size must be a number between 1 and 1638');
                return false;
              }
              r.perform({ kind: 'setFontSize', points }, 'Font Size');
              return true;
            },
          },
          state,
          focus,
        ),
        () => profile().fontSizes,
      ),
    );

    define('control.highlight', 'Highlight', 'Format', 'highlight', () =>
      gated(
        colorButton({ label: 'Highlight', icon: 'highlight', noneLabel: 'None', initial: '#FFFF00', palette: 'highlight', action: (color) => ({ kind: 'setHighlight', color }) }, r),
        () => profile().highlight,
      ),
    );
    define('control.fontColor', 'Font Color', 'Format', 'fontColor', () =>
      gated(
        colorButton({ label: 'Font Color', icon: 'fontColor', noneLabel: 'Automatic', initial: '#FF0000', palette: 'full', action: (color) => ({ kind: 'setColor', color }) }, r),
        () => profile().colors,
      ),
    );
  }

  // --- Format selector ---------------------------------------------------------------------

  /** "Format: [Word Document ▾]": switches the open document to another format (Action 'convert'). */
  private buildFormatBox(): HTMLElement {
    const { host } = this.options;
    const kindOf = (label: string) => (Object.keys(FORMATS) as (keyof typeof FORMATS)[]).find((k) => FORMATS[k].label === label);
    const combo = comboBox(
      {
        label: 'Document format',
        width: 104,
        readOnly: true,
        options: () => this.formatKinds().map((kind) => FORMATS[kind].label),
        value: (s) => FORMATS[s.kind].label,
        enabled: () => !this.converting,
        title: (s) =>
          FORMATS[s.kind].editable ? 'Document format: switching changes the tools available' : 'Read-only format: switch to Word Document to edit',
        commit: (text) => {
          const to = kindOf(text);
          if (!to) return false;
          const action: Action = { kind: 'convert', to };
          if (!host.supports(action)) {
            host.notify(`Converting to ${FORMATS[to].label} isn't available yet`);
            return false;
          }
          this.converting = true;
          this.formatCombo.refresh(this.state);
          Promise.resolve(host.perform(action))
            .catch((e: unknown) => host.notify(`Couldn't convert: ${(e as Error).message ?? e}`))
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
    const modeButton = (mode: FormMode, label: string, tooltip: string) => {
      const button = h('button', { class: 'wm-form-mode-button', text: label, title: tooltip, attrs: { type: 'button', 'data-mode': mode } });
      button.addEventListener('click', () => {
        void Promise.resolve(this.options.host.perform({ kind: 'setFormMode', mode }));
      });
      return button;
    };
    this.formModeBox = h(
      'div',
      { class: 'wm-form-mode', attrs: { role: 'group', 'aria-label': 'Form' } },
      modeButton('fill', 'Fill In', 'Type in the PDF’s fields'),
      modeButton('edit', 'Edit Form', 'Move, add, rename and delete the PDF’s fields'),
    );
    this.syncButton = new SyncButton(this.options.host);
    return h(
      'div',
      { class: 'wm-format' },
      this.formModeBox,
      h('div', { class: 'wm-format-field' }, h('span', { class: 'wm-format-label', text: 'Format' }), combo.el),
      this.syncButton.el,
    );
  }

  /** The switchable formats, plus the current one if it isn't switchable. */
  private formatKinds(): (keyof typeof FORMATS)[] {
    return CONVERT_ORDER.includes(this.state.kind) ? CONVERT_ORDER : [...CONVERT_ORDER, this.state.kind];
  }

  /** Lists the formats (plus the current one if it isn't switchable) and shows the current one. */
  private syncFormatBox(): void {
    this.formatCombo.refresh(this.state);
    this.formModeBox.hidden = this.state.formMode === null;
    for (const button of this.formModeBox.querySelectorAll<HTMLButtonElement>('button')) {
      const on = button.dataset.mode === this.state.formMode;
      button.classList.toggle('wm-form-mode-on', on);
      button.setAttribute('aria-pressed', String(on));
    }
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
    this.toolbars.length = 0;
    this.toolbarsEl.replaceChildren();
    for (const t of this.layout) {
      const toolbar = new Toolbar(t.name, r, t.items.map(item));
      toolbar.setShown(t.visible && t.items.length > 0);
      this.toolbars.push(toolbar);
      this.toolbarsEl.append(toolbar.el);
    }
    // The document area changes size; the canvas's ResizeObserver takes it from there.
    this.toolbarsEl.hidden = this.toolbars.every((t) => t.el.hidden);
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

  /** Everything that can go on a toolbar, grouped by menu. */
  private catalog(): CatalogItem[] {
    const categories: Record<string, string> = {
      file: 'File',
      edit: 'Edit',
      view: 'View',
      insert: 'Insert',
      format: 'Format',
      tools: 'Tools',
      table: 'Table',
      help: 'Help',
    };
    const prefixes: [string, string][] = [
      ['file.convertTo.', 'Convert To '],
      ['format.case.', 'Change Case: '],
      ['format.spacing.', 'Line Spacing '],
      ['table.', 'Table: '],
      ['view.toolbar.', 'Toolbar: '],
    ];
    const items: CatalogItem[] = [];
    const byCategory = new Map<string, CatalogItem[]>();
    for (const command of this.registry.all()) {
      if (command.id === 'view.customizeToolbars') continue;
      const category = categories[command.id.split('.')[0]] ?? 'Other';
      const prefix = prefixes.find(([p]) => command.id.startsWith(p))?.[1] ?? '';
      const label = prefix + (command.tooltip ?? command.plainLabel);
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

  // --- Help ----------------------------------------------------------------------------------

  private showShortcuts(): void {
    const table = h('table', { class: 'wm-shortcuts' });
    const seen = new Set<string>();
    for (const command of this.registry.all()) {
      if (!command.shortcutText || seen.has(command.shortcutText)) continue;
      seen.add(command.shortcutText);
      table.append(h('tr', {}, h('td', { text: command.plainLabel }), h('td', {}, h('kbd', { text: command.shortcutText }))));
    }
    showDialog('Keyboard Shortcuts', h('div', { class: 'wm-scroll' }, table), () => this.options.host.focusEditor());
  }
}

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
