# DrawingML shapes

Pictures, shapes, lines and text boxes are written the same way in a `.pptx` and an `.xlsx`: DrawingML (`a:`), held by
PresentationML on a slide (`p:sp`, `p:pic`...) and by SpreadsheetML in a sheet's drawing part (`xdr:sp`, `xdr:pic`...). The
code that reads, draws, writes and edits a shape lives once, in `client/src/drawingml/`, and each host (the slides editor,
the sheet editor) builds on it. Nothing in `drawingml/` imports from `slides/` or `sheet/`: what only a deck has
(placeholders and their inheritance, master text styles, the colour map of a slide, tables, charts and SmartArt on a slide)
stays in `slides/`.

## Modules

| File | What it does |
| --- | --- |
| `ooxml.ts` | XML helpers (`kid`, `kids`, `at`, `ensure`, `replaceKid`...), EMU units, and the prefix-agnostic `localName`, `prefixOf`, `localKid` |
| `color.ts`, `theme.ts` | Every DrawingML colour and colour change, colour maps; a theme's colours, fonts and style matrix |
| `geometry.ts`, `presetData.ts` | The guide language, custom geometry, and all preset shapes (the standard's own definitions) |
| `shape.ts` | A shape as read (`DrawingShape`: element, kind, frame, `inherits`), its `cNvPr`, properties and transform by local name, fills and outlines along an inheritance chain (`shapeFill`, `shapeLine`) |
| `text.ts` | A text body's paragraphs and runs with their styles resolved (`readBody`), body settings, `TextContext` |
| `textLayout.ts` | Line breaking, bullets and numbers, spacing, alignment |
| `textEdit.ts` | Text positions and changes to `a:p` / `a:r` XML, `ensureBody`, a list style's levels |
| `build.ts` | Writing: `newShape`, `newPicture`, `setFrame`, `setFill`, `setLine`, `nextShapeId` |
| `scene.ts` | `ShapeBuilder`: shapes as a drawing scene (`vector/model.ts`), and where each shape and its text lines ended up (`ShapeView`) |
| `editor.ts` | `ShapeEditor`: picking, handles, moving, sizing, turning, nudging, and rich text editing on the canvas |
| `shapeChoices.ts` | The shapes Insert › Shape offers, as the shared catalogue's ids with their DrawingML presets |

## Prefixes

Every lookup of a shape's own children goes by local name (`spPr`, `txBody`, `style`, `blipFill`, `cNvPr`, a graphic
frame's `xfrm`), so `p:` and `xdr:` shapes read the same. Writers take the prefix from the element they change
(`setFrame` on an `xdr:sp` makes an `xdr:spPr`), or an `ns` argument when they make a new element (`newShape(..., 'xdr')`).
The `a:` children (`a:xfrm`, `a:prstGeom`, fills, `a:bodyPr`, paragraphs) are DrawingML's own and always `a:`.

## Inheritance

A `DrawingShape` carries `inherits`: the elements it takes what it does not set from, nearest first. A slide's placeholder
inherits from its layout's and master's placeholders (`slides/shapes.ts`, `ResolvedShape` extends `DrawingShape`); a shape
in a sheet inherits from nothing. Fills, outlines, geometry and body settings walk that chain; a theme style reference
(`a:fillRef`, `a:lnRef`, `a:fontRef`) is looked up in the theme the host's `ColorContext` names.

Text styles are passed in rather than found: `readBody` takes the list styles under a shape's own, lowest first. A slide
gives the master's title, body or other style and the placeholders' list styles (`slides/textStyle.ts`, `styleSources`); a
sheet gives none. `TextContext` has optional `link(rId)` (a hyperlink's target, from the host's relationships) and
`field(type, saved)` (a slide number or date; the saved text when not given).

## Drawing

`ShapeBuilder<S>` turns shapes into scene nodes: geometry with its fill (solid, gradient, pattern, picture) and outline
(dashes, arrowheads), pictures cropped and clipped to their outline, and text laid out in the shape's text rectangle (vertical
text turned). Its `shape(shape, parent, top)` places a shape by its frame inside its parent and records a `ShapeView` for each:
its matrix to the page's pixels, size, laid-out text, and the top-level shape a click selects. The host gives:

- `resolveEmbed(rId, shape)`: the href an image node gets for a picture's relationship id (a slide: `pptx:<part>`, decoded
  by the view);
- by subclassing: `textOf` (how text inherits), `promptOf` (an empty placeholder's prompt), `alwaysHasText`, `inherited`
  (shown from elsewhere, not pickable), `nodeAttrs`, and `other` for the kinds it alone draws (a slide's tables, charts,
  SmartArt; a grey box otherwise).

`slides/scene.ts` subclasses it as the slide's builder and adds the background.

## Editing

`ShapeEditor<P>` is the object editor for one page at a time, where `P` is the host's page (a slide part, a sheet). It owns
the selection, the text being edited (`TextEdit`: element, anchor and focus, the caret's goal and pending run properties),
the gesture under way and the caret's blink. The host drives it through `ShapeEditorHost`:

- where things are: `page()` (the page in hand), `views(page)` (its scene's views), `toScreen(page, x, y)` (page pixels to
  canvas CSS px), `scale()`, `snapLines(page)` (what a moved shape snaps to), `measure`, `theme(page)` for the colour menus;
- changes: `change(page, label)` starts one (its `touch()` is called before the XML changes) and `commit(change, options)`
  keeps it as an undoable step (`merge` joins typing into one step); `invalidate()` while a drag changes the XML;
- painting and state: `redraw()`, `render()`, `state()`, `leftText()` (seal the typing step);
- what is the host's: `deleteSelection()`, `undo()`, `redo()`, `mirrorStyle(page, element)` (a slide master's style that
  text formatting is also written to, in master view), and the textarea screen readers follow (`input`).

The host passes pointer and key events on: `pressHandle(x, y)` (screen) then `press(page, at, ...)` (page pixels), `drag`,
`release`, `cursorAt`, `shapeKey` (Tab, Enter/F2, Delete, arrows for the selection; false for keys it leaves to the host,
such as arrows with nothing selected), `textKey`, `typed`, `deleteKey`, `enter`, `formatAction` and `formatState` for the
toolbar, `colorMenus()` for the context menu, `copyText`, `cutText`, `pasteText`, `selectAll`, and `decorate(ctx, page,
ratio)` to draw the selection, handles, caret and marquee over the page. Page-level keys and commands (slides added, moved,
presented, master view) stay in the host.

The editor's strings (undo labels, the Fill and Outline menus and their colour names, the shape kinds read out) are the
`shapes.*` area (`i18n/en/shapes.ts`), shared by every host.

## Shapes to insert

The shapes Insert › Shape offers come from the vector editor's catalogue (`vector/shapes.ts`): one id, name
(`vector.shape.*`) and outline per shape, so the picker shows each with `ui/shapePreview.ts` as the Shapes tool does.
`drawingml/shapeChoices.ts` lists them in the picker's groups with each one's DrawingML preset (`star` is `star5`,
`arrowRight` is `rightArrow`, `rightTriangle` is `rtTriangle`...); the catalogue has a few the Shapes tool does not offer
(rectangle, oval, line, callouts, flowchart shapes), drawn for previews only. The picker itself is `ui/shapePicker.ts`.
