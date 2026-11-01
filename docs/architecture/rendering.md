# Rendering

Golem Docs draws the whole editor surface (pages, text, selection, caret, squiggles) on one WebGL2 canvas. Text is drawn from MSDF glyph atlases, so it stays sharp at any zoom, and the layout worker hands the main thread GPU-ready buffers, so a frame is only a few instanced draw calls. This doc covers the renderer, the font pipeline behind the atlases, the camera and page arrangement, hit-testing, thumbnails, and what a canvas-based editor means for the DOM, accessibility and tests.

## How it works

```
 layout worker (see layout.md)                       main thread (client/src/main.ts)
 ------------------------------                      -------------------------------------------
 PageLayout --encodePage--> EncodedPage  ---post--->  applyLayout(): new GpuPage(encoded, atlases)
 describeFace(metrics) -> FaceDescriptor ---post--->  atlases.define(): GpuFace (glyph table texture
   (once per face, glyph quads/UVs)                     now, atlas .webp fetched async, redraw on load)
 SelectionUpdate (caret, rects, marks)   ---post--->  SelectionLayer.update()
                                                      arrange(): arrangePages() -> page.moveTo(x, y)
                                                      requestRender() -> render() (rAF)
                                                        camera.clamp -> PageRenderer.render(camera, pages, selection)
```

1. **Data crosses as bytes.** Layout writes 20-byte glyph and rect instances directly (`GLYPH_INSTANCE_BYTES`, `RECT_INSTANCE_BYTES` in `layout/src/display.ts`); `encodePage` (`layout/src/wire.ts`) moves those buffers into an `EncodedPage` and they are transferred, not copied. No conversion happens before they become GPU buffers.
2. **`GpuPage`** (`client/src/webgl/gpuPage.ts`) wraps one page: `TextBatch`es (one per face and synthetic style), background and foreground `RectBatch`es, and image items. It keeps page-relative positions and only a per-page origin changes when pages are rearranged. GPU buffers upload on first draw (`batch.prepare`), so pages never scrolled into view cost nothing on the GPU. Headers and footers arrive later as an overlay (`setOverlay`) because they need the final page count.
3. **A frame** (`PageRenderer.render`, `client/src/webgl/pageRenderer.ts`): binary-search the visible pages (pages are kept sorted by y), clear to the desk colour, draw sheets (shadow, border, white or dark fill, snapped to whole device pixels), images behind text, background rects, selection highlight, inline images, text batched per face across pages (sorted by `face.id`, so each atlas binds once), foreground rects (underlines, borders), squiggles, remote carets, then the caret.
3a. **Pictures** (`webgl/shapes/imageRenderer.ts`): one textured quad per image, its bitmap decoded once (`createImageBitmap`) with mipmaps. A picture that carries an SVG (a drawing: `Drawing.svg`, `images[].svg` on the page) is drawn from the SVG by the drawing editor's own painter (`vector/svgRead.ts` reads it into a `Scene`, `vector/paint.ts` paints it, both lazy chunks) into a texture at the size it is shown at, so it is sharp; until that texture is ready the bitmap shows. Zooming only scales the texture on screen (smooth, no work); once the zoom rests for ~120 ms (or has gone on ~450 ms) the drawing is painted again at the new size and swapped in. Sizes are quantised in steps of root two (`svgRasterScale`), capped at 4096 pixels a side and 12 million in all, so a small zoom does not paint again and an extreme one stays as sharp as the cap allows; far more than needed is shrunk again, and at most 24 drawing textures are kept (those not on screen go first). Pattern fills, gradients, clips, dashes and joins are the painter's (`paintFor`, `patternFor`), so a drawing looks the same in a document as in the editor.
4. **Text shader** (`webgl/text/textShaders.ts`, `textRenderer.ts`): one instanced draw call per batch, a triangle strip whose 4 corners come from `gl_VertexID`. The glyph's quad and atlas UVs are fetched from the face's glyph table texture (`glyphTable.ts`: two RGBA32F texels per glyph, rows of 128 glyphs). The fragment shader takes the median of the MSDF channels, and supersamples with a 2x2 rotated grid when one screen pixel spans more than about 1.5 atlas texels (zoomed-out text). There are no mipmaps, because tightly packed glyphs would bleed. Synthetic italic (skew) and bold (embolden) are uniforms, used when a family lacks the face.
5. **Float precision.** `TextRenderer` computes `(batch.origin - camera) * scale` in float64 on the CPU and passes it as a uniform, so far-away pages in a big document stay precise in float32 vertex math.
6. **Zoom and scroll** only change `Camera` state (`client/src/view/camera.ts`) and uniforms; no buffers are rebuilt. `Camera.scale` is device pixels per document point (`zoom * CSS_PX_PER_POINT * dpr`, `CSS_PX_PER_POINT = 96/72`). Zoom range is 0.01 to 64. The canvas is sized in exact device pixels via `ResizeObserver` (`devicePixelContentBoxSize`), and `dpr` is derived from the real backing store.
7. **Rendering is on demand** (`requestRender` then `render()` in `main.ts`), also driving caret blink (`CARET_BLINK_MS`). After drawing, `render()` positions the DOM overlays (form fields, PDF text layer, comments, rulers, pointer layer) and the hidden `#input` textarea at the caret.

## Fonts and atlases

Documents name Word fonts; we ship open substitutes. `scripts/fonts/` generates the atlases offline (`pnpm fonts`, `scripts/fonts/generate.ts`) and the output is committed under `client/public/fonts/`.

```
sources.ts (FAMILIES, ATLAS)  -->  generate.ts + msdf-atlas-gen  -->  public/fonts/manifest.json
  charset.txt = core charset                                          public/fonts/<id>/<face>.{webp,json,ttf}
  withExtras() = "<id>-extra" page for everything else                public/fonts/<id>-extra/coverage.json ...
  CJK = noto-sans-{jp,kr,sc,tc}-N pages                               public/fonts/noto-sans-jp-1/ ...
```

- **Atlas format:** MTSDF, 48 px/em, 8 px range (`ATLAS` in `sources.ts`); CJK pages use a coarser MSDF (32 px, range 4, 2048x2048). `.ttf` files are copied next to the atlases only so PDF export can embed them; they are fetched only when a PDF uses the face (`FontSet.fontFile`).
- **Manifest** (`FontManifest`, `layout/src/fonts/fontTypes.ts`): families with `wordName`, `aliases`, `faces` (weight, italic, atlas, layout JSON, metrics) and optional `page: { group, order, coverage }`.
- **`FontSet`** (`layout/src/fonts/fontSet.ts`) runs in the layout worker. `resolve({font, bold, italic})` maps a Word name to a family (via `FALLBACK_BY_NAME`, default `Calibri`) and picks the nearest face, flagging `syntheticItalic` / `syntheticBold`. `ensure(faces)` loads face metrics JSON once each. Loading is injected (`FontJsonLoader`), so layout also runs in Node tests and on servers. Nothing about a face is loaded until a document uses it.
- **Atlas images** load on the page thread (`AtlasLibrary`, `webgl/text/gpuFace.ts`) when a layout update first names a face; the face draws nothing until then. `AtlasLibrary.warm` fetches and decodes the default font's regular and bold atlases at startup (`main.ts`), so they are ready by the first layout.
- **Pages (extras and CJK) are one mechanism.** A family with `page` is never chosen by name. It only draws characters a run's own font lacks, through `RunStyle.fallbacks`. `ensurePages(group, codePoints, styles)` loads the coverage ranges of each page in the group, then the metrics of the first page covering each code point, and returns code points no page has. `ensureCjk(lang, ...)` runs it for a language and its `CJK_SIBLINGS` (zh-Hans and zh-Hant fill in for each other). `pageVersion` bumps when page metrics load, which is part of the paragraph cache key, so affected paragraphs re-lay out.
- **When pages load:** `LayoutSession.create` scans the document (`pagedTextOf`) and loads what it needs before the first layout; `LayoutSession.ensurePages(text)` loads before an edit that types or pastes uncovered characters (`runCommand` in `layoutWorker.ts`). `ensureMath` loads the math font and the math layout chunk only for documents with equations.
- **Main-thread side:** the worker sends a `FaceDescriptor` (`describeFace`) the first time a face is used (`sentFaces` in `layoutWorker.ts`). `AtlasLibrary.define` (`webgl/text/gpuFace.ts`) creates the `GpuFace`, uploads the glyph table, and fetches the `.webp` with `createImageBitmap(premultiplyAlpha: 'none', colorSpaceConversion: 'none')`. A face draws nothing until its atlas arrives, then `onLoad` triggers a redraw. A face larger than `MAX_TEXTURE_SIZE` is skipped with a console warning.
- **Faces made at runtime: a PDF's embedded fonts.** PDF pages (`client/src/formats/pdfPages.ts`) draw each glyph from the font program its PDF embeds where it can. `PdfFaces` (`formats/pdfFaces.ts`) reads the glyph's outline (`FontProgram`, `@golemdocs/pdf/fontProgram`: Type 1, CFF and TrueType, simple and composite fonts), turns it into a multi-channel distance field (`formats/msdf.ts`, msdfgen's method at the shipped atlases' 48 px/em and 8 px range, so the same shader draws it), and packs the glyphs a page brings into a new atlas, keyed `pdf-font:<n>`. Its `FaceMetrics` carries the atlas pixels, which `describeFace` puts in the `FaceDescriptor` (`pixels`) and `AtlasLibrary.define` uploads instead of fetching. Glyphs are found by `DisplayGlyph.glyph` (the code, or the CID of a composite font) and `GlyphRun.fontDict`. A glyph the program lacks, a Type 3 font, or a font with no program (the standard 14) is drawn with a substitute face as before.
- **Rules from AGENTS.md:** never widen a core charset or add a second path for rare glyphs; add pages. No font data goes into JS bundles.

## Pages, Page Grid, Flow view

- `arrangePages(pages, columns, gap)` (`client/src/document/arrange.ts`) places pages row-major; with one column it is the usual vertical scroll. Page Grid uses `columnsToFill` to match the viewport's aspect ratio. `PageRenderer` culling depends on pages staying sorted by y.
- **Flow view** (`reflowing()` in `main.ts`): the app tells the worker a width (`reflow` message, debounced 150 ms in `syncReflow`); layout then produces one wide column with slim margins and no headers. `renderer.flat = true` draws sheets edge to edge. Flow is off for PDFs, pictures, drawings and the grid.
- A **plain text file** that is large is not a document at all: `client/src/textEditor/` (`glRenderer.ts`, `view.ts`) draws it in chunks on the same camera, reusing `TextRenderer`, `TextBatch` and `AtlasLibrary`. See [text-files](../text-files.md).
- A **workbook** is not a document either: `client/src/sheet/renderer.ts` draws it on the same camera in panes (headers and frozen panes, `geometry.ts`), from tiles its worker builds: cells of 64 rows by 16 columns (text laid out on the page with `CellFonts`, `fonts.ts`) and, below about 9 pixels a row, an overview of 256 by 256 texels a tile at as many levels as the zoom needs (down to 0.1%). See [spreadsheets](../spreadsheets.md).

## Thumbnails

`client/src/thumbnail.ts` renders a page with the same `PageRenderer` into an offscreen framebuffer (`readPage`), flips rows, forces opaque alpha, and encodes WebP (`capturePageThumbnail`, up to 320x420). They are made on save (stored in IndexedDB, uploaded for cloud documents), backfilled for older documents, and used by the dashboard and the pages panel (`ui/pagesPanel.ts`, drawn lazily for pages in view). It saves and restores GL state the frame loop relies on.

## Hit-testing and input

Hit-testing splits across the thread boundary. The main thread owns only geometry:
- `pageAt(cssX, cssY)` in `main.ts` converts through `camera.toDocument`, picks the nearest page (so clicks in the gutter still land) and returns page-relative points.
- It sends `{kind: 'pointer', page: id, x, y, extend?, unit?}` to the worker. The worker's `Editor.hitTest(page, x, y)` (`editor/src/navigation.ts`) scores every `LineRecord` on the page by distance (columns restrict candidates), then picks the nearest caret stop (`LineLayout.stops`) and maps the visible offset to a model offset with `toModel` (`layout/src/offsets.ts`).
- Links and task-list check boxes are asked asynchronously (`linkAt`, which also returns a link's shown text). Resting the pointer on a link opens `ui/linkPopover.ts`: a form over the document with the link's text and address, whose OK / Remove Link put the caret in the link and run `setLink` / `removeLink`. It goes when the pointer leaves unless it has been used. The same form is Insert Hyperlink (`LinkPopover.edit`); there is no modal link dialog. The caret and selection come back as `SelectionUpdate` (page-relative points) and are drawn by `SelectionLayer` (`webgl/selectionLayer.ts`) as rects over the same pages, so text and caret update in the same frame.

## Canvas consequences

- **There is no text in the DOM.** Typing goes into a hidden `<textarea id="input" aria-label="Document">` that is moved to the caret each frame, so IME candidate windows and the on-screen keyboard appear in the right place. Keys, composition and clipboard go through it.
- **Accessibility is limited.** Screen readers see one labelled textarea and the DOM menus, toolbars and dialogs (which carry roles), not the document text. Treat any "read the document aloud" feature as unsolved here.
- **DOM overlays** sit above the canvas for things that need real inputs or are easier in HTML: PDF form fields (`ui/formLayer.ts`), PDF text editing (`ui/pdfTextLayer.ts`), comments (`ui/commentsPanel.ts`), other people's pointers (`ui/pointerLayer.ts`), crop and draw layers. Each has a `position()` called from `render()`.
- **No browser find or spellcheck on the page.** Find, spelling and grammar squiggles are drawn by the worker's geometry (`spellMarks`, `squiggleRects`).
- **How e2e reads text** (`e2e/fixtures.ts`): `main.ts` exposes `window.selectionState` (`caret`, `text`, `others`), `window.loaded`, `window.pages`, `window.status`, `camera`, `pageAt`, `send`. `app.text()` presses Ctrl+A and reads `selectionState.text`. Plain text files expose `window.textEditor.text()`. Other checks use DOM of menus and dialogs, or downloaded files. Pixel assertions are rare.
- **WebGL2 is required**: `main.ts` throws `app.webglUnsupported` if no context. The context is created with `antialias: false, alpha: false, premultipliedAlpha: true`; blending is premultiplied (`ONE, ONE_MINUS_SRC_ALPHA`).

## Key files

| Path | Role |
| --- | --- |
| `client/src/webgl/pageRenderer.ts` | Frame orchestration, culling, draw order |
| `client/src/webgl/gpuPage.ts` | One page on the GPU, body plus header/footer overlay |
| `client/src/webgl/text/` | `gpuFace.ts` (atlas library), `textRenderer.ts`, `textBatch.ts`, `textShaders.ts`, `glyphTable.ts` |
| `client/src/webgl/shapes/` | Rect and image renderers and batches |
| `client/src/webgl/selectionLayer.ts` | Caret, highlights, squiggles, remote carets |
| `client/src/webgl/program.ts` | Shader helpers, dark-pages colour mapping |
| `client/src/view/camera.ts` | Zoom, pan, fit, clamp, coordinate conversion |
| `client/src/document/arrange.ts` | Page placement, Page Grid columns, `nearestPage` |
| `client/src/thumbnail.ts` | Offscreen page capture |
| `client/src/main.ts` | Frame loop (`render`), `applyLayout`, `arrange`, input, window hooks |
| `layout/src/fonts/` | `FontSet`, face metrics, CJK helpers, manifest types |
| `client/src/formats/pdfFaces.ts`, `msdf.ts` | Atlases for a PDF's embedded fonts, made at runtime |
| `layout/src/display.ts`, `wire.ts` | Instance formats, `EncodedPage`, `FaceDescriptor` |
| `scripts/fonts/` | Atlas generation: `sources.ts`, `charset.txt`, `generate.ts` |
| `client/public/fonts/` | Generated manifest and atlases (committed) |

## Key data types

- `EncodedPage`, `EncodedText`, `FaceDescriptor` (`layout/src/wire.ts`): the worker-to-GPU contract. Glyph instance: x, y (float32 points, page-relative), size, glyph index (uint16), packed RGBA8 colour.
- `GpuPage`, `GpuFace`, `TextBatch`, `RectBatch`: GPU-side holders. `TriangleBatch` (`webgl/shapes/triangleBatch.ts`) is the same for triangles (x, y and a colour per vertex), drawn by a spreadsheet's charts (slanted lines, slices, areas). `Camera`: `x, y, zoom, width, height, dpr`.
- `ResolvedFont` / `ManifestFamily` / `ManifestFace` and `page` groups: font resolution.

## Invariants and gotchas

- Pages must stay sorted by y (row-major) or culling breaks. Change page order only through `arrange()`.
- Face ids (`GpuFace.id`) drive draw order; batches of one face should be adjacent.
- A page's `EncodedPage` buffers are transferred: the worker must not touch the `PageLayout` buffers afterwards.
- Atlas textures must reach the GPU unmodified (no premultiply, no colour management).
- New faces are registered for every document, even stale ones (`LayoutClient.receive`), because the worker will not resend them.
- Adding a font or charset changes committed binaries under `client/public/fonts/`; run `pnpm fonts` and check the manifest. The `.ttf` copies exist for PDF export.
- Dark Pages is a shader-side colour mapping (`DARK_PAGES_GLSL`), not a different layout; thumbnails pass `darkPages` explicitly.
- After changing the look the marketing clip shows, re-record it (see AGENTS.md, `pnpm record:home`).

## Related docs

- [Layout](layout.md)
- [Plain text files](../text-files.md)
- [Localization](../localization.md) (CJK language pages and the app language)
