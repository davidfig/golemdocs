# Test fixtures

Small, committed inputs for the tests; `../make-fixtures.sh` regenerates all of them.

| Files | What they cover |
|---|---|
| `libreoffice.pdf`, `pdflatex.pdf`, `xelatex.pdf`, `chromium.pdf`, `wkhtmltopdf.pdf`, `reportlab.pdf`, `matplotlib-type3.pdf`, `matplotlib-type42.pdf`, `image.pdf` | The same two lines of text from different producers: TrueType subsets, Type 3 bitmap fonts (pdflatex without cm-super), OpenType CID fonts, the standard 14, Type 42 |
| `objstm.pdf`, `linearized.pdf`, `qdf.pdf` | qpdf rewrites of `libreoffice.pdf`: object and xref streams, linearization, an uncompressed QDF file |
| `rc4-40.pdf`, `rc4-128.pdf`, `aes-128.pdf`, `aes-256-r5.pdf`, `aes-256.pdf` | Encrypted with each standard security handler revision (2, 3, 4, 5, 6); user password `user`, owner password `owner` |
| `aes-256-owner-only.pdf`, `aes-256-unicode.pdf` | An empty user password; a non-ASCII user password (`pässwörd`) |
| `img-*.png`, `img-*.jpg` | Every PNG path (RGB, RGBA, interlaced, 16-bit gray, 1-bit, palette with tRNS) and JPEG gray/RGB/CMYK. Pixel (x, y) = (16x, 16y, 8(x+y)), alpha 16x+y |
| `DejaVuSans-subset.ttf`, `LMRoman10-subset.otf` | Fonts to embed: TrueType with composite glyphs, and CFF-flavoured OpenType. Licenses in `FONT-LICENSES.txt` |

A much larger real-world corpus (pdf.js's test PDFs, many deliberately broken) is fetched on demand: see the package README.
