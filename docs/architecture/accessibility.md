# Accessibility

Status: **a plan, not built yet** (written 2026-11-01). The document is drawn on a WebGL canvas, so assistive technology cannot read it unless we describe it ourselves. This doc says where things stand, the approach, and the order to build it in. Update it as each phase lands.

## Where we stand

- **The document is invisible to screen readers.** All they see is the hidden `<textarea id="input" aria-label="Document">` (`client/index.html`). `ui/textInput.ts` empties it after every keystroke, so a screen reader hears "Document, edit text" and nothing more: typing is not echoed, moving the caret reads nothing, and there are no headings, lists or tables to move between.
- **The rest of the interface is in fair shape.** Menus, toolbars and dialogs are plain HTML with `aria-label`s (about 200), roles, `aria-expanded` / `pressed` / `selected`, and a few live regions (`searchPanel`, `spellDialog`, `progressToast`, `loadingScreen` and others). Nobody has checked it systematically.
- **Visual settings:** some `prefers-reduced-motion` handling (`ui.css`, `tooltip.css`, `loadingScreen.css`). There is no high-contrast theme and nothing for Windows High Contrast mode (`forced-colors`), which a canvas ignores entirely.
- **The layout worker already knows the document's structure:** paragraph styles, heading levels, lists, tables, links, image alt text. Nothing sends that structure to the page yet.

## Approach: draw it with WebGL, describe it with HTML

This is how VS Code, Google Docs and Flutter handle it. The canvas stays the only thing anyone sees. The layout worker also builds a small description of the document, and the page turns it into invisible HTML that assistive tech can read. There are two layers, because people use screen readers in two ways.

### 1. Editing: the hidden textarea mirrors the text

- Keep the current paragraph, or a window of about 1–2k characters around the caret, in `#input`, with `selectionStart` / `selectionEnd` matching our caret. Screen readers then read characters, words and lines as the caret moves, read a selection, and echo typing. This is VS Code's method.
- The worker sends the text near the caret with `SelectionUpdate` (`layout/protocol.ts`), so there is no extra round trip.
- Never rewrite the textarea while an input-method composition is under way, so typing in Chinese, Japanese and the like keeps working. Rewrite it only when the caret leaves the window.
- Edits from other people near the caret update the textarea quietly, without being read aloud.

### 2. Reading: an invisible copy of the document's structure

- The worker sends each page's structure in reading order: headings with levels, paragraphs, lists, tables with header cells, links, images with alt text, and comment anchors.
- The page builds that as real HTML (`h1`–`h6`, `ul`, `table`, `a`, `img alt`), only for pages near what is on screen, so a book-length document stays fast. An outline of all the headings is always present.
- Each piece sits invisibly over its line on the canvas. That gives VoiceOver on iOS touch exploration, lets screen magnifiers follow the focus, and lets the reader's cursor track what is on screen.
- Moving the reader's focus onto a piece places our caret there, so a user can switch smoothly between reading and editing.

## Phases

**Phase 0: decide and document.**
- Decide on a **Screen Reader Mode** setting. A browser cannot tell whether a screen reader is running, so this has to be a toggle with a shortcut, announced when the editor first gets focus.
- It is a preference, so it goes in `SYNCED_KEYS` (`settingsSync.ts`) and follows the account.

**Phase 1: editing mirror and one announcer.**
- Build the textarea mirror above.
- Add one shared `ui/announce.ts`, with one polite and one urgent live region, and move the existing `aria-live` spots onto it.
- Announce what only shows on the canvas: "Bold on", "Heading 2", "Page 4 of 12", "Spelling error: teh", find results, "Ana joined".
- All announcement text goes through `t()`.

**Phase 2: reading layer.**
- The worker builds the structure description (pure code, easy to test). Lay it out invisibly over the canvas, build only pages near the viewport, and connect focus back to the caret.
- Shortcuts to jump between headings, tables and comments.

**Phase 3: interface audit.**
- Toolbars get `role=toolbar`, and arrow keys move between their buttons.
- F6 cycles between the menu bar, toolbars, document, sidebar and status bar. Add a "skip to document" link.
- Check `dropdown`, `segmented`, `colorButton`, `LayerTree` and `LinkPopover` against the standard ARIA patterns for those controls.
- Every dialog returns focus to where it came from.
- These are all shared components, so each fix covers every editor.

**Phase 4: visual settings.**
- A high-contrast theme.
- `forced-colors`: read the system colors and pass them to the renderer for page, text, selection and caret.
- `prefers-reduced-motion` for caret blinking and smooth scrolling.
- A caret-width setting.
- Spelling and grammar squiggles that differ in pattern as well as color, for color-blind users.

**Phase 5: the other editors and exported files.**
- **Drawings and pictures:** select shapes and layers from the keyboard, give shapes accessible names, edit alt text.
- **PDFs:** expose the text layer `ui/pdfTextLayer.ts` already has, and the form fields.
- **Exports:** keep alt text when saving `.docx`, and produce a tagged PDF if we export PDFs.

## Testing

- **Unit tests** for building the structure description and for the textarea window and its selection mapping.
- **e2e:** Playwright's built-in `toMatchAriaSnapshot` (no new dependency) for the reading layer and the interface, and a check that arrowing through a paragraph moves the textarea's selection.
- **Optional:** `axe-core` as a dev dependency for automated checks. Adding it needs approval (AGENTS.md).
- **By hand, before each phase ships:**

| Screen reader | Where |
| --- | --- |
| NVDA | Chrome and Firefox |
| JAWS | Windows |
| VoiceOver | macOS desktop app and iOS |
| TalkBack | Android |
| Narrator | Windows |

## Risks

- **Input-method composition** breaks if the textarea is rewritten at the wrong moment.
- **Large documents** slow down if the reading layer is not limited to pages near the viewport.
- **Shared documents** can flood a screen reader with announcements while someone else types.
- **The desktop shell:** WKWebView handles ARIA slightly differently from Chrome.
- **Mobile:** touch exploration depends on the invisible layer lining up with the lines on the canvas.
