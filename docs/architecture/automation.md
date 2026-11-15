# Automation API

`window.golem` is the one documented way for an agent (Claude Code, Codex, a script) or an end-to-end test to drive the running app and read what it shows. The editor draws to a canvas, so there is no document text in the DOM to read; this API reads it from the layout worker instead, and runs commands through the same registry the menus use.

It lives in `client/src/automation.ts` and is installed by `main.ts` at start-up, in every build (it is a few kilobytes and only exposes what page script could already do). `golem.help()` prints the whole API.

## What it offers

| Call | What it does |
| --- | --- |
| `golem.state()` | The open document's name and kind, whether it is loaded, the status text, zoom, view mode, undo and redo, selection and the selection's format (`ChromeState`) |
| `golem.commands.list(filter?)` | Every command in the `CommandRegistry`: id, plain label, shortcut, `enabled` (would run now), `available` (the format has it at all), `checked`. The filter matches the id or the label |
| `golem.commands.run(id)` | Runs a command exactly as its menu item would (`CommandRegistry.execute`): false when it is disabled or the format lacks it. An unknown id throws, naming the ids it might have meant (`nearIds`) |
| `golem.doc.outline()` | Every body paragraph in order: its index (as the `select` command takes it), kind (`heading`, `item`, `paragraph`), level, whether a list is numbered, its text (a picture reads as U+FFFC, as for a screen reader) and its table cell. Null for a PDF, a text file or a workbook |
| `golem.doc.text()` / `golem.doc.markdown()` | The whole document as the `.txt` / `.md` exporters write it (`worker.convert`); a text file's own text |
| `golem.doc.select(paragraph, from?, to?)` | Selects in a paragraph (offsets are model offsets in it) and waits for the worker |
| `golem.doc.open(source)` | Opens a document by source (`welcome`, `local:<id>`, …) and waits until it is laid out |
| `golem.selection()` | The selected text and the caret |
| `golem.dialogs()` | The open dialogs and in-document cards (`dialog[open]`, `role="dialog"`): title, `modal`, fields (accessible name, type or role, value, checked) and buttons |
| `golem.waitIdle(timeoutMs?)` | Resolves once the document is loaded, the worker has handled every message sent so far, and two frames are drawn |

## How it works

- **Commands** go through `CommandRegistry` (`ui/commands.ts`), so a command an agent runs is checked, refused and focused exactly as a click on its menu item. A command that needs a value (a font size, a colour) is run through the real control instead.
- **The document** is read through two layout worker messages: `outline` (`outlineNodes` in `layout/a11y.ts`, which shares `HeadingReader`, `readableText` and the table lookup with Screen Reader Mode's reading layer, but covers the whole document and needs no Screen Reader Mode) and `ping`. The worker handles its messages strictly in order, so `pong` comes back only after every command sent before the ping; `waitIdle` adds two frames on top so what is drawn matches.
- **Dialogs** are read from the DOM by accessible name (`accessibleName`: `aria-label`, `aria-labelledby`, a `<label>`, then text). A control the API cannot name is one a screen reader cannot name either: fix the control.
- **Opening** waits for `beginOpen` to run (`opensBegun`) before waiting for `loaded`, since a source is read or fetched first.

## Rules

- **It reads and sets up; it does not replace the UI.** A test of a feature still clicks and types through the real controls (by role and name, see [Accessibility](accessibility.md)), and uses `golem` to set up and to read the result. A test that only calls `commands.run` never tests the button.
- **Everything goes through what the app already has.** Add to the API by exposing an existing path (a command, a worker request, the DOM), never by adding a second way to change the document.
- **The older hooks stay for now.** `window.camera`, `pages`, `selectionState`, `textEditor`, `sheetEditor` and the others are what many e2e specs read for positions on the canvas. New specs and agents should use `golem` where it covers what they need.
- **Not yet:** a way for an agent outside the page (the desktop app's local socket, a `golem` command line) to reach it. Inside a browser an agent calls it through its own JavaScript tool (Playwright's `page.evaluate`, a browser pane's JavaScript tool).

## Tests

`client/test/automation.test.ts` covers listing and running commands and the worker's `outline` and `ping`; `e2e/shell/automation.spec.ts` drives `window.golem` in the real app. The e2e `App` fixture has `idle()`, `outline()` and `run(id)` on top of it.
