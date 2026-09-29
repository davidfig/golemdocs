#!/usr/bin/env bash
# Regenerates test/fixtures: the same short text from many PDF producers, plus qpdf
# variants (object streams, linearized, encrypted with each standard-handler revision).
# Needs: libreoffice, pdflatex, xelatex, chromium (Playwright's), wkhtmltopdf, python3 with
# reportlab + matplotlib, ImageMagick, qpdf. The fixtures are committed; this is only for
# regenerating them.
set -euo pipefail
cd "$(dirname "$0")/fixtures"
TMP=$(mktemp -d)
TEXT='The quick brown fox jumps over the lazy dog.'
LINE2='Café naïve résumé – “quoted” fi fl 1234'

# LibreOffice (TrueType subsets with ToUnicode)
printf '%s\n%s\n' "$TEXT" "$LINE2" > "$TMP/lo.txt"
soffice --headless --convert-to pdf --outdir "$TMP" "$TMP/lo.txt" >/dev/null 2>&1
cp "$TMP/lo.pdf" libreoffice.pdf

# pdflatex (Type 1 fonts with custom encodings), xelatex (OpenType CID fonts)
cat > "$TMP/tex.tex" <<TEX
\documentclass{article}\usepackage[T1]{fontenc}\usepackage[utf8]{inputenc}\pagestyle{empty}
\begin{document}$TEXT\par Caf\'e na\"ive r\'esum\'e -- ``quoted'' fi fl 1234\end{document}
TEX
(cd "$TMP" && pdflatex -interaction=batchmode tex.tex >/dev/null) && cp "$TMP/tex.pdf" pdflatex.pdf
cat > "$TMP/xe.tex" <<TEX
\documentclass{article}\usepackage{fontspec}\pagestyle{empty}
\begin{document}$TEXT\par $LINE2\end{document}
TEX
(cd "$TMP" && xelatex -interaction=batchmode xe.tex >/dev/null) && cp "$TMP/xe.pdf" xelatex.pdf

# Chromium (Skia) and wkhtmltopdf (Qt)
printf '<html><head><meta charset="utf-8"></head><body style="font-family:DejaVu Sans"><p>%s</p><p>%s</p></body></html>' "$TEXT" "$LINE2" > "$TMP/page.html"
CHROME=$(ls -d /opt/pw-browsers/chromium-*/chrome-linux/chrome 2>/dev/null | head -1)
"$CHROME" --headless --no-sandbox --disable-gpu --no-pdf-header-footer --print-to-pdf="$TMP/chrome.pdf" "file://$TMP/page.html" >/dev/null 2>&1
cp "$TMP/chrome.pdf" chromium.pdf
wkhtmltopdf -q "$TMP/page.html" wkhtmltopdf.pdf || true

# reportlab (standard 14 fonts), matplotlib (Type 3 and Type 42 fonts)
python3 - "$TEXT" "$LINE2" <<'PY'
import sys
from reportlab.pdfgen import canvas
c = canvas.Canvas('reportlab.pdf', pageCompression=0)
c.setFont('Helvetica', 12); c.drawString(72, 720, sys.argv[1])
c.setFont('Times-Roman', 12); c.drawString(72, 700, sys.argv[2])
c.showPage(); c.setFont('Courier', 12); c.drawString(72, 720, 'Second page'); c.save()
import matplotlib; matplotlib.use('pdf')
import matplotlib.pyplot as plt
for fonttype in (3, 42):
    matplotlib.rcParams['pdf.fonttype'] = fonttype
    fig = plt.figure(figsize=(6, 1.5)); fig.text(0.05, 0.6, sys.argv[1]); fig.text(0.05, 0.3, sys.argv[2])
    fig.savefig(f'matplotlib-type{fonttype}.pdf'); plt.close(fig)
PY

# An image-only PDF (ImageMagick)
convert -size 64x48 gradient:red-blue "$TMP/img.png" && convert "$TMP/img.png" image.pdf

# qpdf variants of the LibreOffice file
qpdf --object-streams=generate libreoffice.pdf objstm.pdf
qpdf --linearize libreoffice.pdf linearized.pdf
qpdf --qdf --object-streams=disable libreoffice.pdf qdf.pdf
qpdf --allow-weak-crypto --encrypt user owner 40 -- libreoffice.pdf rc4-40.pdf
qpdf --allow-weak-crypto --encrypt user owner 128 --use-aes=n -- libreoffice.pdf rc4-128.pdf
qpdf --encrypt user owner 128 --use-aes=y -- libreoffice.pdf aes-128.pdf
qpdf --encrypt user owner 256 --force-R5 -- libreoffice.pdf aes-256-r5.pdf
qpdf --encrypt user owner 256 -- libreoffice.pdf aes-256.pdf
qpdf --encrypt '' owner 256 -- libreoffice.pdf aes-256-owner-only.pdf
qpdf --encrypt 'pässwörd' owner 256 -- libreoffice.pdf aes-256-unicode.pdf
rm -rf "$TMP"
ls -la

# Images for the embedding tests: pixel (x, y) = (x*16, y*16, (x+y)*8), alpha x*16+y.
python3 <<'PY'
from PIL import Image
W, H = 16, 12
rgb = [(x * 16, y * 16, (x + y) * 8) for y in range(H) for x in range(W)]
alpha = [x * 16 + y for y in range(H) for x in range(W)]
im = Image.new('RGB', (W, H)); im.putdata(rgb); im.save('img-rgb.png')
ima = Image.new('RGBA', (W, H)); ima.putdata([c + (a,) for c, a in zip(rgb, alpha)]); ima.save('img-rgba.png')
g = Image.new('I;16', (W, H)); g.putdata([(x * 16 + y) * 257 for y in range(H) for x in range(W)]); g.save('img-gray16.png')
b = Image.new('1', (W, H)); b.putdata([255 if (x + y) % 2 else 0 for y in range(H) for x in range(W)]); b.save('img-gray1.png')
p = Image.new('P', (W, H)); p.putpalette([v for i in range(4) for v in (i * 80, 255 - i * 80, 40)]); p.putdata([(x // 4) for y in range(H) for x in range(W)])
p.info['transparency'] = bytes([0, 128, 255, 255]); p.save('img-palette-trns.png', transparency=bytes([0, 128, 255, 255]))
im.save('img-rgb.jpg', quality=95); im.convert('L').save('img-gray.jpg'); im.convert('CMYK').save('img-cmyk.jpg')
PY
# Pillow can't write interlaced PNGs.
convert img-rgb.png -interlace PNG PNG24:img-rgb-interlaced.png
convert img-rgba.png -interlace PNG PNG32:img-rgba-interlaced.png

# Fonts to embed (subsets keep the fixtures small; the licenses allow redistribution).
pyftsubset /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf --layout-features='' --output-file=DejaVuSans-subset.ttf \
  --unicodes="U+0020-007E,U+00A0-00FF,U+0391-03C9,U+0386,U+0388-038F,U+03AC-03AF,U+0400-044F,U+2013-2014,U+2018-201D,U+2192,U+2713,U+FB01-FB02"
pyftsubset /usr/share/texmf/fonts/opentype/public/lm/lmroman10-regular.otf --layout-features='' --unicodes="U+0020-007E,U+00E9" --output-file=LMRoman10-subset.otf
