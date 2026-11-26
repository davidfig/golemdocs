# Plan: slides (.pptx, .odp)

**Status (2026-11-26).** Built on the `worktree-slides` branch: M0 to M3 and most of M4 and M6, M5 in part (the design part, background, theme and master editing, is done). See *Progress* at the
end for what exists, how it differs from the plan, and what is left.

**Goal.** A presentation editor, not a viewer: open, edit, present and save `.pptx` (and later `.odp`) without damaging
anything PowerPoint, Keynote or Google Slides wrote. Slides are drawn by the app's WebGL renderer on the same camera as
documents, so a deck can be zoomed out to a grid of every slide (as Page Grid does for pages) and in to a single shape.
No external libraries.

As with workbooks, **the file always wins**: the `.pptx` is what the account and the vault hold, so an agent pointed at the
vault, or PowerPoint, sees the real file.

## Principles

1. **Its own model, not a lens.** A slide is a canvas of positioned shapes that inherit from a layout and a master, not a
   flow of paragraphs. Squeezing it into `WordDocument` (each slide a page of floating text boxes) would open quickly but
   lose placeholders, inheritance, themes and animations on the first save. So, like the spreadsheet (`client/src/sheet/`),
   slides get their own model and engine in `client/src/slides/`, a `DocumentEngine` to the chrome, fetched as one lazy
   chunk when the first deck opens (`slides/handle.ts` stays tiny and static).
2. **Reuse every editor we already have.** A slide is made of things the app already edits:
   - shapes, lines, pictures, groups, selection handles, rotate, snap, nudge, fill/line popups, gradients, the layers panel
     and cursors: the **vector editor** (`vector/`, `ui/vectorEditor.ts`, `LayerTree`, `ui/cursors.ts`);
   - the text inside a shape: the **document layout and editor** (`@golemdocs/layout` `layoutBox`, already used for Word
     text boxes, and `@golemdocs/editor`) on a small `WordDocument` per text body;
   - tables: the document's table layout and editing;
   - charts: the spreadsheet's chart reader and scene (`sheet/charts/model.ts`, `scene.ts`), fed from the chart's embedded
     workbook;
   - the slide strip: the **pages panel** (`ui/pagesPanel.ts`, which already reorders and deletes PDF pages).
   Where one of these lives inside another editor's chunk, move it to a shared module (AGENTS.md, *Consistent UI*) rather
   than copying it.
3. **Lose nothing.** Every part, element and attribute we don't model is kept and written back as it came (the approach
   of `docx/` and `sheet/xlsx/`): open then save leaves untouched slides, masters, media and parts byte-identical.
4. **Small decks open instantly.** Unlike workbooks, a deck's model is small (a 100-slide deck is a few thousand shapes),
   so it lives on the page, not in a worker; only media decoding and thumbnails go off the main thread. Revisit if a
   measured 500-slide deck says otherwise.

## 1. The model

`@golemdocs/pptx` would be premature; start in `client/src/slides/model/`, pure and Node-tested.

- **Presentation**: slide size, slide order (ids), masters, layouts, theme(s), notes master, default text styles, sections,
  custom shows, and the OPC package for everything else (`docx/src/opc/package.ts`).
- **Slide / Layout / Master**: each a **shape tree** plus background, colour map override, transition, timing (animations,
  kept as XML at first), and for a slide its layout and its notes.
- **Shape tree**: `sp` (geometry + text body), `pic`, `grpSp`, `cxnSp` (connectors), `graphicFrame` (table, chart,
  SmartArt, OLE), each with transform (offset, extent, rotation, flips) in EMU, fill, line, effects (kept), and
  `extra` for what we don't read.
- **Inheritance resolved at read time, written back as overrides.** A placeholder on a slide takes position, size and text
  style from the matching placeholder on its layout, which takes them from its master; text takes level styles from the
  master's `titleStyle`/`bodyStyle`/`otherStyle` and colours and fonts from the theme (`+mj-lt`, `accent1`, `bg1`...). The
  resolver (like `StyleResolver` in `docx/src/model/resolve.ts`) answers "what does this shape look like", and edits write
  only the property that changed, on the slide, so changing the master still reaches every untouched slide.
- **Text bodies** read into the `WordDocument` paragraph model (paragraph = `a:p`, run = `a:r`, bullets and levels =
  numbering, `a:pPr` spacing/indents/alignment) plus a namespace for what Word lacks (autofit, vertical anchor, columns,
  insets, `normAutofit fontScale`). The writer turns them back into DrawingML, writing only what differs from the
  inherited style.
- **Preset geometry.** DrawingML has ~190 preset shapes defined by guide formulas (`presetShapeDefinitions.xml` in
  ECMA-376 Part 1). Write a small evaluator for the guide language (about 17 operators) and generate a compact table of the
  presets from the spec into a JSON file loaded with the chunk. `custGeom` uses the same evaluator. Output is
  `PathCommand[]` for the vector painter, and adjust handles (the yellow diamonds) fall out of it.

## 2. Reading and writing

- **.pptx** (`slides/pptx/read.ts`, `write.ts`) on the workspace's zip, XML and OPC code. Read is lazy per slide where it
  pays: the slide list, masters and theme first, so the first slide shows before the rest are parsed.
- **Round-trip tests** as for workbooks: every fixture opened, saved, reopened; untouched parts byte-identical.
- **Three-way checks against PowerPoint** on the development Mac (`scripts/slides/powerpoint.ts`, like
  `scripts/sheets/excel.ts`): PowerPoint opens what we write with no repair prompt, and its PDF export of a fixture is the
  reference image our renderer is diffed against.
- **.odp** (M6): `odt/` already reads ODF styles and frames; a presentation reader/writer on top maps `draw:page`,
  `draw:frame`, `presentation:class` and master pages onto the same model.
- **Keynote (.key)**: import only, much later if at all (its IWA format is snappy-compressed protobuf with no public
  spec). Keynote exports `.pptx`, which is the supported route.
- **Convert To / Export**: PDF (one page per slide, vector, tagged, via the existing PDF writer and the slide renderer
  as for drawings), PNG per slide, and to a document (each slide's title as a heading, its text as paragraphs, pictures
  kept, notes as quotes). A document to slides: each Heading 1 starts a slide, its body becomes the content placeholder.
- **Search indexing** of every slide's text and notes (`formats/docBytes.ts`), and thumbnails (the first slide).

## 3. Drawing

- Each slide is a scene: background, master shapes (unless `showMasterSp="0"`), layout shapes, slide shapes, painted
  by the vector painter for geometry and pictures and by the text renderer (`TextRenderer`, MSDF atlases, `FontSet.ensure`)
  for text, so text stays sharp at any zoom like a document's.
- **Views**: *Normal* (slide strip, one slide, notes below), *Slide Sorter* (all slides as a grid on the camera, drag to
  reorder; the same Page Grid code), *Outline* (titles and bullets as one editable text, from and back to the shapes), and
  *Presenter* (below).
- Fonts: themes name fonts by family (`Calibri`, `Aptos`); unknown ones map to the app's metric-compatible faces, as the
  document layout already does.

## 4. The editor

- Select, move, resize, rotate, flip, group, align and distribute, z-order, snap to guides and other shapes' edges and
  centres: from the vector editor.
- Double-click (or Enter) on a shape edits its text with the document editor laid into the shape's box: caret,
  selection, formatting, bullets, spelling, autocorrect all as in documents. **This is the largest new piece**: today
  Word text boxes are laid out but not editable in documents either, so building it here gives documents editable text
  boxes too.
- Autofit: shrink text on overflow (`normAutofit`) and resize shape to fit text (`spAutoFit`), recomputed as you type.
- Insert: slide (choosing a layout), text box, shape (the shared shape list), picture, table, chart (an embedded
  workbook opened in the sheet editor), video and audio (kept and played in Present).
- Slide commands: new, duplicate, delete, hide, change layout, reset to layout, move to section, reorder by drag or by
  keyboard (Alt+Up/Down) in the strip.
- Design: change theme (colours and fonts from a theme file or another deck), edit master and layouts (the same editor on
  the master's tree), background.
- Notes: a text pane under the slide, edited with the document editor.
- Transitions and animations: kept and played from M4; editing them (an animation pane) is M5.
- Undo: one list of model edits, as the sheet's.

## 5. Presenting

- **Present** (F5 from the start, Shift+F5 from this slide): full screen, the slide fitted to the screen, arrow keys,
  Space, clicks, swipes and number-then-Enter to move; Escape to leave; B/W to blank. Transitions (fade, push, wipe, cover
  first) and entrance/emphasis/exit animations for the common kinds; anything else appears without its effect.
- **Presenter view** on a second window when there is one (the desktop shell's windows; in the browser, a popup):
  current and next slide, notes, timer, slide count.
- Reduced motion: transitions and animations become cuts (*Accessibility*).

## 6. Storage, rooms and the rest of the app

- Stored as the `.pptx` itself, like workbooks; no `.wdoc` wrapper.
- **Rooms**: a new `slides` room kind, `watch` at first (one session edits, others watch and see each save), as `cells`
  started. Once slide edits are object operations (add, delete, move, set property on a shape id, text ops inside a text
  body using the document `ops`), it becomes `shared`: shapes are the `nodes` case with text inside them.
- **Live blocks**: a slide as a picture source (`Deck.pptx#slide:3`), and a shape group as a host (a chart or table kept
  up to date from a workbook), following the drawing host.
- **Automation**: `window.golem` reads the deck's outline (slides, shapes, text) and runs its commands, for e2e tests
  and agents.
- **Agents in the vault**: a `.pptx` is hard for an agent to edit by hand. See decision 3.

## 7. Accessibility

- Screen Reader Mode reads a slide in reading order (`a:ext` order or the shape tree order), each shape's text and its
  alt text; the strip announces slide n of m and its title; moving a shape announces its position.
- Every pointer action has a command: nudge with the arrows, resize with Shift+arrows, rotate with Alt+arrows, Tab
  between shapes.
- Present mode announces each slide's title and text as it changes.
- High contrast: chrome only; slide contents keep their own colours (they are the document), as pages do.
- A "check accessibility" pass (missing alt text, missing titles, reading order) is a cheap later win.

## Milestones

- **M0. Foundations.** A corpus of decks (PowerPoint, Keynote export, Google Slides export, LibreOffice), the
  PowerPoint script for reference PDFs, the preset geometry table and its evaluator, tested against reference shapes.
- **M1. Read and show.** Model, `.pptx` reader, inheritance resolver, renderer, Normal and Slide Sorter views, slide
  strip, Present with keyboard navigation and no effects, thumbnails, search indexing, export to PDF. Opens read-only:
  already useful (today a `.pptx` doesn't open at all).
- **M2. Edit shapes and slides.** Writer with byte-identical round trip, select/move/resize/rotate, insert shapes and
  pictures, new/duplicate/delete/reorder/hide slides, change layout, undo, clipboard (within and between decks, and a
  picture of a slide pasted into a document). Text still read-only.
- **M3. Edit text.** The document editor inside shapes, autofit, bullets, notes pane, spelling, find and replace across
  slides, Outline view. Editable text boxes in documents fall out of this.
- **M4. Present properly.** Transitions, common animations, Presenter view, video and audio.
- **M5. Design and the rest.** Tables, charts (with the sheet editor), themes, master and layout editing, sections,
  animation pane, Convert To between decks and documents.
- **M6. Together and around.** `slides` rooms (watch, then shared), live blocks, `.odp`, the accessibility checker.

M1 to M3 make it a usable editor; M4 makes it usable on stage.

## Tests

- Node: preset geometry against the spec's reference outlines; the inheritance resolver (a property set on master,
  layout, slide); round trip of every fixture, byte-identical for untouched parts; text body to `WordDocument` and back.
- Renderer: our PNG of each fixture slide against PowerPoint's PDF export, with a tolerance, in a generated status table
  as the formula oracle is.
- e2e under `e2e/slides/`: open, move between slides, present and leave, insert and move a shape, type in a
  placeholder, reorder in the strip, save and reopen, download; and `e2e/accessibility/` for the strip, shape focus and
  Present.

## Decisions

1. **Own model rather than a Word lens.** Recommended, for the reasons in Principle 1. The lens would get decks opening in
   days, but every save would flatten them, which breaks "lose nothing".
2. **Where text editing in shapes comes from.** Recommended: the document editor on a `WordDocument` per text body, not a
   third text editor. It is the biggest risk in the plan, so M3 starts with a spike on Word text boxes in documents, which
   needs the same thing and is smaller to test.
3. **An agent-friendly form in the vault.** A deck in the vault is a `.pptx`, which agents can only edit with a script.
   Options: (a) nothing extra; (b) a Markdown slide format (`---` between slides, Marp-style front matter) as a second,
   native deck type that the app edits as slides; (c) a read-only `.md` outline written beside each `.pptx`. Recommended:
   (b) after M3, since it fits *AI is done outside the app* and costs a reader/writer over the same model.
4. **Animations.** Recommended: keep all, play the common ones from M4, edit from M5. Building the full PowerPoint timing
   model is large and rarely used beyond appear/fade/fly-in.
5. **Branch.** Recommended: a long-lived `slides` branch in a worktree, as `xlsx` was, merged after M1 (read-only decks
   beat not opening at all), with the rest continuing on `main`.

## Progress

### What exists (2026-11-23)

All in `client/src/slides/`, one lazily loaded chunk (`view.ts` and what it imports, about 120 kB) behind `slides/handle.ts`.

- **Model** (`deck.ts`, `ooxml.ts`): the `.pptx` package (`OpcPackage`) with every slide, layout, master, theme, notes page, chart
  and SmartArt drawing parsed when the deck opens; the XML is the model, changed in place. Writing sets only changed parts, and
  leaves out parts nothing reaches any more (`unreachableUnder` in `OpcPackage.write`: deleted slides, their notes and media).
- **Inheritance** (`shapes.ts`, `textStyle.ts`): placeholders take frame, geometry, fill, line and body settings from their
  layout's and master's; text levels from the master's title, body or other style (the presentation's default style for other
  shapes), each placeholder's list style, then the paragraph and run; `p:style` references into the theme's style matrix.
- **Colours and themes** (`color.ts`, `theme.ts`): every colour kind and change (lumMod, tint, shade, alpha...), colour maps and
  their overrides.
- **Geometry** (`geometry.ts`): the guide language and custom geometry in full (arcs included), and all 187 preset shapes,
  which are the standard's own definitions in the same language (`presetData.ts`, packed from ECMA-376's
  `presetShapeDefinitions.xml` by `scripts/preset-shapes.ts`).
- **Text** (`textLayout.ts`, `fonts.ts`): line breaking, bullets and automatic numbers, spacing, alignment, anchors, vertical
  text, autofit scale; measured and drawn in the app's own font files (`fonts/manifest.json` substitutes, loaded as web fonts),
  or a font the computer has.
- **Drawing** (`scene.ts`, `tables.ts`): a slide becomes a drawing scene (`vector/model.ts`), painted by `vector/paint.ts`,
  written as a vector PDF by `vector/pdfOut.ts` (`scenesToPdf`). Pictures (cropped, clipped to their shape), gradients, lines
  with dashes and arrowheads, tables with table styles (PowerPoint's default style is built in), charts through the
  spreadsheet's chart layout (`sheet/charts/scene.ts`, `sheet/charts/svg.ts`), SmartArt from its drawing part.
- **Editor** (`view.ts`, `edit.ts`, `textEdit.ts`, `history.ts`): slides down the page or in Slide Sorter on the app's camera;
  select (click, Shift, marquee, Tab), move (with snapping to the slide's edges and middle), size, turn, nudge, order, delete,
  copy and paste shapes; edit text in place with a caret, selection, typing, Enter, line breaks, levels with Tab, and the
  toolbar's formatting; slides added, copied, moved, hidden, deleted and put on another layout; notes in a pane; undo and redo
  of everything through part snapshots. The slide strip is the pages panel.
- **Presenting** (`present.ts`): full screen, keys, clicks and swipes, click-by-click entrance and exit builds (fading in),
  fades between slides that have a transition, cuts under reduced motion, black and white screens, slide numbers typed and
  Enter, and a Presenter View (next slide, notes, clock).
- **Around the app**: a `pptx` format (`handlers/pptx.ts`), search indexing, the vault, thumbnails (the first slide), Convert
  To in both directions, New › PowerPoint Presentation (`blank.ts`, the app's own 16:9 deck), and a `slides` room kind,
  watched as workbooks are (`sheet/sheetSync.ts` with `kind: 'slides'`).

- **Design** (`design.ts`, `designDialogs.ts`): Slide › Background writes a solid, gradient or picture `p:bg` on the slide in
  hand, or (Apply to All) on the master while every slide and layout under it lets its own go; Reset Background removes the
  page's own. Slide › Theme writes a colour scheme and the Latin heading and body fonts into each master's theme part (from a
  built-in list, `COLOR_SCHEMES` and `FONT_PAIRS`, or read from another `.pptx` or `.thmx`), and dark or light slides as the
  master's colour map (`bg1`/`tx1` on `dk1`/`lt1`); `Deck.refreshThemes` re-reads them after a change or an undo. Slide ›
  Edit Master (also in View) is master view: the editor's pages (`pages` in `view.ts`) become each master followed by its
  layouts, drawn and edited as slides are (`slideShapes` and `slideScene` take a master or layout), with a bar to close it
  (or Escape with nothing selected), and the commands about slides themselves (`SLIDE_ONLY_OPS`) disabled. Text formatting
  on a master's placeholder is also written to the master's title, body or other style, and on a layout's placeholder to
  its list style, for each level the text has (`inheritedStyleOf`, `mirrorToStyle`), so it reaches every slide that does
  not set it itself; moving or sizing a master placeholder moves every slide's that has no place of its own. Each change
  touches only the parts it is about, so the rest of the package is written back byte for byte. Checked in PowerPoint
  16.115: a python-pptx deck restyled this way opens with no repair prompt and looks as set.

### How it differs from the plan

- **Text in shapes has its own editor** (`textEdit.ts` and the text half of `view.ts`), not the document editor (decision 2).
  The document editor lives in the layout worker on whole documents; giving each shape a document there and drawing it on
  the slide would have been far larger than editing DrawingML paragraphs directly, which also keeps every run's own XML.
  Documents still don't edit Word text boxes.
- **Slides are drawn on a canvas of their own** over the view (as drawings are), not by the WebGL renderer.

### Left to do

- Editing animations and transitions (they are kept and played, not edited); charts
  edited in the sheet editor; tables' rows and columns added or removed (cells' text is edited).
- The yellow handles that drag a shape's adjustments (the table's handles are left out until then).
- `.odp`; Keynote stays out.
- Design: adding, renaming and deleting layouts and masters; theme effects and the full font scheme (East Asian and complex
  script fonts are kept as they were); Georgia has no TTF in `client/public/fonts`, so slides can't draw it yet and it is
  left out of the built-in fonts.
- Rooms where several people edit a deck at once (it is watched: one edits, the others look).
- Live blocks: a slide as a source (`#slide:3`), shapes as hosts.
- A screen reader pass by hand (the shapes, the caret's paragraph and slide changes are announced).
