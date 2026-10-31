# App shell and UI

The editor itself is a WebGL canvas; everything around it (menus, toolbars, dialogs, panels, the dashboard) is plain DOM with no framework. `client/src/main.ts` is the composition root that owns the open document, the layout worker and the canvas, and `client/src/ui/` is the chrome, which talks to the app only through the `ChromeHost` interface. This doc covers how those pieces fit, the shared-component rules, language and spelling plumbing, the view/camera, synced settings and the marketing site.

## How it works

```
   keys / mouse / menus / toolbars / palette
                    │ Action (ui/actions.ts)
                    ▼
 ui/chrome.ts ──► CommandRegistry (ui/commands.ts) ──► ChromeHost.perform(action)
 (menus, toolbars,        ▲ enabled/checked from                 │  chromeHost.ts: SUPPORTED + perform()
  catalog of commands)    │ ChromeState + FormatProfile          ▼
                          │ (ui/formats.ts)               main.ts: camera, layout worker,
        chrome.update(state) ◄─────────────────────────── editor, storage, rooms, dialogs
```

- **Actions** (`ui/actions.ts`) are format-agnostic requests ("bold", "insert page break", "save as Markdown"). Nothing in `ui/` knows about .docx, the editor model or the worker.
- **Commands** (`ui/commands.ts`) are named things menus, toolbars, shortcuts and the command palette invoke. A command either sends an `Action` to the host or runs something inside the chrome (a dialog, a toggle). Label, icon, shortcut and enabled rule are defined once; every surface refers to it by id.
- **`ui/chrome.ts`** is the catalog: which commands exist, which menus and toolbars show them, and default shortcuts. `Chrome.update(partial ChromeState)` pushes state (format state, view toggles, sync status) down; the chrome never reads the app directly.
- **Format profiles** (`ui/formats.ts`, `FormatProfile`) say what each `DocumentKind` can express, so one set of menus is disabled correctly for Markdown, PDF, pictures and so on.
- **`chromeHost.ts`** implements `ChromeHost`: `SUPPORTED` is the set of action kinds the app implements (others are disabled), and `perform()` maps each to the camera, worker or editor. Add a new action kind in both `actions.ts` and here. Status of each action: [actions-status.md](../actions-status.md).
- **`main.ts`** (about 4,700 lines, sectioned by `// --- Name ---` comments: current document, collaboration, saving, uploading, pictures, text too big to be a document, rendering, pointer, keyboard and text input, navigation, searching every document, status bar) wires it all. Collaboration and layout detail belongs to their own docs.

## Key files

| Path | Role |
| --- | --- |
| `client/src/main.ts` | Composition root: documents, canvas, worker, input, storage, rooms |
| `client/src/chromeHost.ts` | `ChromeHost` implementation; `SUPPORTED` and `perform()` |
| `client/src/ui/actions.ts` | `Action` union, `ChromeState`, `ChromeHost`, `DocumentKind`, op types |
| `client/src/ui/commands.ts` | `CommandSpec`, `CommandRegistry` |
| `client/src/ui/chrome.ts` | `Chrome` / `mountChrome`: command catalog, menu and toolbar contents |
| `client/src/ui/menu.ts`, `toolbar.ts`, `toolbarLayout.ts`, `customize.ts` | Menu bar mechanics, toolbar controls, toolbar contents as data, Customize Toolbars (layout kept per device) |
| `client/src/ui/commandPalette.ts`, `shortcuts.ts` | Searchable command list; `Mod+Shift+Z`-style shortcut parsing and user rebinding |
| `client/src/ui/popup.ts`, `dropdown.ts`, `dom.ts` | One-at-a-time popups and dialogs; the drop-down list; DOM helpers (`h`, `iconButton`, `segmented`) |
| `client/src/ui/layerTree.ts` + `layersPanel.ts`, `pictureLayersPanel.ts` | Shared layers panel and its two adapters |
| `client/src/ui/cursors.ts` | Cursor drawings for vector and picture tools |
| `client/src/ui/theme.ts`, `ui.css` | Color schemes via `--wm-*` variables and `data-theme`; the UI font (`--wm-font`, `uiFont()` for canvas labels) |
| `client/public/ui-fonts/` | The UI font, Atkinson Hyperlegible Next (OFL): Latin and Latin Extended woff2 files, upright and italic, declared by `@font-face` in `ui.css` and fetched only when used. Other scripts fall through `--wm-font` to the system font |
| `client/src/ui/dashboard.ts` | Documents screen (thumbnails, folders, selection) |
| `client/src/ui/pictureFrame.ts`, `pictureDetourBar.ts` | The frame and resize handles around the picture selected in the text; the Done / Cancel bar while a picture of the text is open in the image editor |
| `client/src/ui/*Layer.ts`, `vectorEditor.ts`, `vectorSession.ts` | DOM layers over the canvas (forms, PDF text, pointers, vector editing) |
| `client/src/view/camera.ts` | `Camera`: document points to canvas; zoom and scroll only change uniforms |
| `client/src/ui/scrollOptions.ts` | Tools › Options: scroll half a screen past the end (`Camera.scrollPastEnd`; synced, on by default) |
| `client/src/viewMemory.ts` | Per-document scroll, zoom, caret and selection (device-local) |
| `client/src/settingsSync.ts` | Account-synced preferences |
| `client/src/spelling/` | `dictionary.ts` (Hunspell reader), `check.ts`, `grammar.ts`, `languages.ts`, `appWords.ts` |
| `client/src/i18n/` | `t()`, `en/` catalog, `locales.ts`, `locales/` translations |
| `client/home/`, `client/public/home/`, `client/site/`, `client/seo.ts` | Marketing site generation |

## Shared-component rules (from AGENTS.md)

Reuse before you build, and centralize what you would copy. One implementation per job:

- A confirmation asked from inside a modal `<dialog>` (`confirmDelete(…, parent)`) must be put inside it: everything outside a modal dialog is inert. The Documents screen covers the menu bar, so what a menu command does that you need there (File › Trash) also has a button on the screen.
- Dialogs and titles: `dialogTitleBar`, `showDialog`, `showConfirm` (`ui/popup.ts`); buttons: `iconButton`, `CLOSE_ICON` (`ui/dom.ts`), class `wm-button` (flat, hairline border; a form's `type="submit"` button, or any button given `wm-primary`, is the main action and is filled with `--wm-accent`, each theme's title color); colors and fonts: `--wm-*` variables.
- Lists of choices: `dropdown` (`ui/dropdown.ts`, `lineSample` for widths), never a native `<select>`; stroke lists via `strokeStyleList` (`ui/chrome.ts`). Segmented choices: `segmented`. Colors: `colorButton` (`ui/toolbar.ts`) with the `fillHeader`/`drawFillHeader` methods on `Chrome`; drawings and pictures share fill, gradient and stroke UI.
- Layers: `LayerTree` (`ui/layerTree.ts`); an editor supplies only a `LayerAdapter`.
- Cursors: `ui/cursors.ts` via the editor's `setCursor`. Shapes and brushes: `vector/shapes.ts`, `vector/brushPresets.ts`, `shapePreview`, `brushPreview`, shared with picture tools.
- Draw icons as SVG; do not use text characters like `×` or `▸` (fonts place them differently; and no bundled font has `▸`, so write menu paths with `›`).
- When one editor needs a control another has, move it to a shared module and move both onto it in the same change.
- `client/test/consistency.test.ts` statically checks that literal `t('...')` keys exist, toolbar/menu ids are registered, and UI code does not draw string literals.

## Language, spelling, grammar

- Every user-visible string is `t('area.key')` called inside functions. English is the source (`client/src/i18n/en/*.ts`); other languages are lazily loaded catalogs (`locales.ts`) that may omit keys (they fall back to English), but the completeness test fails until each language has every English key. Conventions, plurals, mnemonics and adding a language: [localization.md](../localization.md), not repeated here.
- Spelling runs in the layout worker (`layoutWorker.ts` imports `spelling/`). `dictionary.ts` reads Hunspell `.aff`/`.dic` pairs from `client/public/dictionaries/` (fetched the first time a paragraph in that language is checked); `languages.ts` picks each paragraph's language (declared `w:lang`, else guessed) and lists which are checkable (Chinese, Japanese and Korean are not: no squiggles). `grammar.ts` is English-only, narrow rules. `appWords.ts` holds app-specific words that always pass; the welcome documents (`client/src/layout/welcome/*.md`) must have zero errors (a test enforces it).
- Adding a language also means a dictionary and license, `languages.ts` registration, a grammar-rule decision, and the marketing translation (below).

## View

`view/camera.ts` is small: a `Camera` maps document points (y down) to canvas pixels (`CSS_PX_PER_POINT`), so zoom and scroll never rebuild glyph buffers. View mode (`print | flow | grid`), zoom targets, toolbars (all at once; each toolbar's own visibility stays in the layout), ruler, status bar and formatting marks are `ChromeState` plus persisted keys. Rendering itself is in `client/src/webgl/` ([Rendering](rendering.md)).

## Settings that follow the account

`settingsSync.ts` keeps a person's preferences in browser storage and mirrors them to `/api/preferences` (`server/src/preferences.ts`). `SYNCED_KEYS` lists the synced keys (theme, appearance, dark pages, locale, shortcuts, auto-format, spelling, new-document kinds, full-screen menu bar, words ignored in each document, view mode, marks, toolbars, ruler, status bar, drawing options). `planSync(local, base, cloud)` is a three-way merge that returns what to apply here and what to push; applying reloads the page once because most settings are read at startup. Phones keep a separate `'mobile'` profile (`settingsProfile()`: coarse pointer, no hover). Rules: a preference (look, language, behavior, view) goes in `SYNCED_KEYS` with a default that works on both profiles; anything tied to this screen (sizes, positions, toolbar layout, per-document zoom/scroll, dismissed notices) stays out.

## Marketing site

- The marketing site is eight pages (Home, Your ai, Formats, Pricing, Journal, About, Developers, Download) in every app language, each drawn as a document on the app's grey workspace under an app-style menu bar (access keys underlined while Alt is held, Alt+letter opens the page). `client/home/build.ts` puts `layout.html` around `pages/<name>.html` and fills `{{key}}` slots from `locales/<tag>.json`; the stylesheet and script are `client/public/home/site.css` and `site.js`. Nothing generated is committed: the dev server renders a page per request (`serve`, called from `welcomeContent()`), and `vite build` writes them all to `dist/home/` (`renderAll`). English pages send visitors to their language; the footer's picker leads to the same page in each language.
- The Journal is `CHANGELOG.md` (`parseChangelog`, the latest eight releases), with optional headlines and notes in David's voice from `client/home/journal.md`; the home page lists the latest three.
- The home page's pictures are drawn in HTML and CSS: the editor (choose a file in its sidebar for a document, an SVG drawing, a PDF form or a CSV sheet, each with its own toolbar; it steps through them until someone chooses) and the "ask your ai" demo (a chat app or a terminal, played in turn, its height fixed to the taller of the two so the page never moves). Toolbar icons are `MOCK_ICONS` in `build.ts`: plain hints, not copies of the app's icons.
- Guide pages under `/home/<name>` are Markdown in `client/site/<name>.md` (with optional `.figure.html` illustrations and `figures.css`), rendered by `client/seo.ts` (`sitePages`, `sitePage`, `markdownToHtml`) inside the site's frame (`renderDocPage`), English only. Legal pages come from `src/layout/legal/<name>/en.md`. The Vite plugin `welcomeContent()` also inlines the English welcome text into `index.html` for crawlers, serves these pages in dev, and writes them into `dist/home/` on build (`closeBundle`).
- `client/public/home/war-and-peace.webm` is a recording of the real app; re-record with `pnpm record:home` when the look of toolbars, menus, status bar or Page Grid changes (needs the user's dev server on :5173).
- Marketing site changes, even copy about an existing feature, get a CHANGELOG line.
- **Section backgrounds must alternate.** No two neighbouring `<section>`s in `<main>` may share a background. This is automatic: CSS shades every odd `main > section` (`:nth-of-type(odd)`) with `--surface`, and the even ones stay `--bg`, so there is no per-section class to keep in step. When you add, remove or reorder a section, check the page still alternates (a section is a direct child of `<main>`; the hero is a `<div>`, so it is not counted and the first section is shaded). Don't give a section its own background or reintroduce an `alt` class.

## Invariants and gotchas

- The canvas has no DOM text; tests and tools read the document through `window` hooks and the worker (see [Build and testing](build-and-testing.md)).
- Pressing toolbar controls must not steal focus from the document (`keepFocus`); only combo boxes take it and hand it back. Menus take keys in the capture phase so the IME and caret survive.
- Only one popup is open at a time (`ui/popup.ts`), nested ones stack on their owner.
- Do not start dev servers yourself in the main checkout; a worktree may run its own on other ports.
- Unimplemented actions are disabled; dev builds still show them, saying "isn't available yet" (`ChromeOptions`/`CommandSpec` flags).
- `ui/` stays host-agnostic: if you need app state, add it to `ChromeState` or a `ChromeHost` method.

## Related docs

[Rendering](rendering.md), [Layout](layout.md), [Document model](document-model.md), [Collaboration](collaboration.md), [Server](server.md), [Build and testing](build-and-testing.md); [Localization](../localization.md); [Toolbar and file actions status](../actions-status.md).
