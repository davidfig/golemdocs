// Embedded font programs read for their outlines (src/fonts/program.ts, type1.ts, cff.ts): the
// glyph each code or CID selects, in text space, for every kind of program a PDF embeds.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { N, PdfDict, PdfStream, type PdfObject } from '../src/core/objects.ts';
import { FontProgram, outlineBounds, type Outline } from '../src/fonts/program.ts';
import { PdfDocument, TrueTypeFont, interpretPage } from '../src/index.ts';
import { fixture, load } from './helpers.ts';

/** Every point of an outline, rounded to 1/1000 em (glyph space units for most fonts). */
const points = (o: Outline | null): number[][][] => (o ?? []).map((c) => c.map((s) => s.points.map((v) => Math.round(v * 1000))));

/** A simple font dictionary embedding `file` under `key`, with the given /Encoding. */
function simpleFont(doc: PdfDocument, subtype: string, key: string, file: PdfStream, encoding: PdfObject, flags = 32): PdfDict {
  const descriptor = new PdfDict({ Type: N('FontDescriptor'), FontName: N('Test'), Flags: flags, ItalicAngle: 0, [key]: doc.add(file) });
  return new PdfDict({ Type: N('Font'), Subtype: N(subtype), BaseFont: N('Test'), FirstChar: 0, LastChar: 255, Encoding: encoding, FontDescriptor: descriptor });
}

// --- Type 1 ---

const T1_OPS: Record<string, number[]> = {
  hsbw: [13], rmoveto: [21], hmoveto: [22], vmoveto: [4], rlineto: [5], hlineto: [6], vlineto: [7], rrcurveto: [8],
  closepath: [9], callsubr: [10], return: [11], endchar: [14], seac: [12, 6], callothersubr: [12, 16], pop: [12, 17], setcurrentpoint: [12, 33],
};

/** A Type 1 charstring from numbers and operator names, encrypted with lenIV 4. */
function charstring(...items: (number | string)[]): Uint8Array {
  const out: number[] = [0, 0, 0, 0];
  for (const item of items) {
    if (typeof item === 'string') out.push(...T1_OPS[item]);
    else if (item >= -107 && item <= 107) out.push(item + 139);
    else if (item >= 108 && item <= 1131) out.push(((item - 108) >> 8) + 247, (item - 108) & 255);
    else if (item <= -108 && item >= -1131) out.push(((-item - 108) >> 8) + 251, (-item - 108) & 255);
    else out.push(255, (item >> 24) & 255, (item >> 16) & 255, (item >> 8) & 255, item & 255);
  }
  return encrypt(Uint8Array.from(out), 4330);
}

function encrypt(plain: Uint8Array, key: number): Uint8Array {
  const out = new Uint8Array(plain.length);
  let r = key;
  plain.forEach((p, i) => {
    const c = p ^ (r >> 8);
    out[i] = c;
    r = ((c + r) * 52845 + 22719) & 0xffff;
  });
  return out;
}

const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/**
 * A Type 1 font: /A a square, /B a flex curve (through the standard flex subroutines), /acute a
 * small box, and /Aacute built from A and acute by seac. Its own encoding has A at 65 and B at 66.
 */
function type1Font(): { data: Uint8Array; length1: number } {
  const subrs = [
    charstring(3, 0, 'callothersubr', 'pop', 'pop', 'setcurrentpoint', 'return'),
    charstring(0, 1, 'callothersubr', 'return'),
    charstring(0, 2, 'callothersubr', 'return'),
    charstring('return'),
  ];
  const glyphs: [string, Uint8Array][] = [
    ['.notdef', charstring(0, 500, 'hsbw', 'endchar')],
    ['A', charstring(0, 500, 'hsbw', 100, 0, 'rmoveto', 300, 'hlineto', 700, 'vlineto', -300, 'hlineto', 'closepath', 'endchar')],
    [
      'B',
      charstring(
        0, 500, 'hsbw', 0, 0, 'rmoveto',
        1, 'callsubr',
        100, 0, 'rmoveto', 2, 'callsubr', // reference point
        -75, 40, 'rmoveto', 2, 'callsubr',
        50, 0, 'rmoveto', 2, 'callsubr',
        25, 0, 'rmoveto', 2, 'callsubr',
        25, 0, 'rmoveto', 2, 'callsubr',
        50, 0, 'rmoveto', 2, 'callsubr',
        25, -40, 'rmoveto', 2, 'callsubr',
        50, 200, 0, 0, 'callsubr',
        'closepath', 'endchar',
      ),
    ],
    ['acute', charstring(20, 300, 'hsbw', 0, 0, 'rmoveto', 100, 'hlineto', 50, 'vlineto', -100, 'hlineto', 'closepath', 'endchar')],
    ['Aacute', charstring(0, 500, 'hsbw', 20, 150, 200, 65, 194, 'seac')],
  ];
  const priv = concat([
    bytes('dup /Private 8 dict dup begin\n/lenIV 4 def\n/Subrs 4 array\n'),
    ...subrs.flatMap((s, i) => [bytes(`dup ${i} ${s.length} RD `), s, bytes(' NP\n')]),
    bytes('ND\n2 index /CharStrings 5 dict dup begin\n'),
    ...glyphs.flatMap(([name, cs]) => [bytes(`/${name} ${cs.length} RD `), cs, bytes(' ND\n')]),
    bytes('end\nend\nreadonly put\nnoaccess put\ndup /FontName get exch definefont pop\nmark currentfile closefile\n'),
  ]);
  const clear = bytes(
    '%!PS-AdobeFont-1.0: Test 001.000\n12 dict begin\n/FontName /Test def\n/FontMatrix [0.001 0 0 0.001 0 0] readonly def\n' +
      '/Encoding 256 array\n0 1 255 {1 index exch /.notdef put} for\ndup 65 /A put\ndup 66 /B put\nreadonly def\ncurrentfile eexec\n',
  );
  return { data: concat([clear, encrypt(concat([Uint8Array.of(1, 2, 3, 4), priv]), 55665), bytes('\n' + '0'.repeat(64) + '\ncleartomark\n')]), length1: clear.length };
}

function type1Doc(encoding: PdfObject): { doc: PdfDocument; font: FontProgram } {
  const doc = PdfDocument.create();
  const { data, length1 } = type1Font();
  const dict = simpleFont(doc, 'Type1', 'FontFile', new PdfStream(new PdfDict({ Length1: length1, Length2: data.length - length1, Length3: 0 }), data), encoding, 4);
  const font = FontProgram.load(doc, dict);
  assert.ok(font, 'the Type 1 program loads');
  return { doc, font };
}

test('Type 1: lines, closing, and the font matrix', () => {
  const { font } = type1Doc(N('StandardEncoding'));
  assert.deepEqual(points(font.outline(65)), [[[100, 0, 400, 0], [400, 0, 400, 700], [400, 700, 100, 700], [100, 700, 100, 0]]]);
});

test('Type 1: flex draws its two curves', () => {
  const { font } = type1Doc(N('StandardEncoding'));
  assert.deepEqual(points(font.outline(66)), [
    [
      [0, 0, 25, 40, 75, 40, 100, 40],
      [100, 40, 125, 40, 175, 40, 200, 0],
      [200, 0, 0, 0],
    ],
  ]);
});

test('Type 1: seac puts the accent at its offset over the base', () => {
  // /Differences names the composite, which isn't in the font's own encoding.
  const { font } = type1Doc(new PdfDict({ Type: N('Encoding'), Differences: [200, N('Aacute')] }));
  const o = points(font.outline(200));
  assert.equal(o.length, 2);
  assert.deepEqual(o[0][0], [100, 0, 400, 0]);
  // The accent's own side bearing (20) lands on adx (150), raised by ady (200).
  assert.deepEqual(o[1][0], [150, 200, 250, 200]);
});

test('Type 1: /Differences, else the font’s own encoding, picks the glyph', () => {
  const { font } = type1Doc(new PdfDict({ Type: N('Encoding'), Differences: [66, N('A')] }));
  const square = [[[100, 0, 400, 0], [400, 0, 400, 700], [400, 700, 100, 700], [100, 700, 100, 0]]];
  assert.deepEqual(points(font.outline(66)), square);
  // No difference for 65: the font's own encoding says A.
  assert.deepEqual(points(font.outline(65)), square);
  // Nothing at all for 67.
  assert.equal(font.outline(67), null);
  // .notdef is blank.
  assert.deepEqual(type1Doc(new PdfDict({ Differences: [1, N('.notdef')] })).font.outline(1), []);
});

// --- CFF and TrueType ---

test('CFF: an OpenType font and its bare CFF table, by glyph name', () => {
  const otf = fixture('LMRoman10-subset.otf');
  const doc = PdfDocument.create();
  const encoding = N('WinAnsiEncoding');
  const asOpenType = FontProgram.load(doc, simpleFont(doc, 'Type1', 'FontFile3', new PdfStream(new PdfDict({ Subtype: N('OpenType') }), otf), encoding));
  const table = TrueTypeFont.parse(otf).table('CFF ')!;
  const cff = otf.slice(table.offset, table.offset + table.length);
  const asType1C = FontProgram.load(doc, simpleFont(doc, 'Type1', 'FontFile3', new PdfStream(new PdfDict({ Subtype: N('Type1C') }), cff), encoding));
  for (const font of [asOpenType, asType1C]) {
    assert.ok(font);
    const a = outlineBounds(font.outline(0x41)!)!;
    // A capital: on the baseline, about 0.68 em tall, with a counter.
    assert.ok(Math.abs(a[1]) < 0.01 && a[3] > 0.6 && a[3] < 0.75, `A bounds ${a}`);
    assert.equal(font.outline(0x41)!.length, 2);
    // é (WinAnsi 0xE9) has a contour above x-height.
    assert.ok(outlineBounds(font.outline(0xe9)!)![3] > 0.6);
  }
});

test('TrueType: a simple font finds glyphs through its cmap by glyph name', () => {
  const ttf = fixture('DejaVuSans-subset.ttf');
  const doc = PdfDocument.create();
  const font = FontProgram.load(doc, simpleFont(doc, 'TrueType', 'FontFile2', new PdfStream(new PdfDict(), ttf), N('WinAnsiEncoding')));
  assert.ok(font);
  assert.ok(TrueTypeFont.parse(ttf).glyphForCodePoint(0x48) > 0, 'the fixture has H');
  // H: one contour, on the baseline, about 0.73 em tall (DejaVu's cap height).
  const b = outlineBounds(font.outline(0x48)!)!;
  assert.equal(font.outline(0x48)!.length, 1);
  assert.ok(Math.abs(b[1]) < 0.001 && b[3] > 0.7 && b[3] < 0.76, `H bounds ${b}`);
});

test('fonts without a program they embed (standard fonts, Type 3) have none', () => {
  const doc = PdfDocument.create();
  assert.equal(FontProgram.load(doc, new PdfDict({ Type: N('Font'), Subtype: N('Type1'), BaseFont: N('Helvetica') })), null);
  assert.equal(FontProgram.load(doc, new PdfDict({ Type: N('Font'), Subtype: N('Type3') })), null);
  // A damaged program is the same as none.
  assert.equal(FontProgram.load(doc, simpleFont(doc, 'Type1', 'FontFile3', new PdfStream(new PdfDict({ Subtype: N('Type1C') }), Uint8Array.of(1, 0, 4, 1, 0, 0)), N('WinAnsiEncoding')))?.outline(65) ?? null, null);
});

test('producer fixtures: every glyph shown in an embedded font has its outline', () => {
  // TrueType simple fonts (LibreOffice), TrueType CID fonts (Chromium, matplotlib), CID-keyed CFF (XeLaTeX).
  for (const name of ['libreoffice.pdf', 'chromium.pdf', 'matplotlib-type42.pdf', 'xelatex.pdf']) {
    const doc = load(name);
    let shown = 0;
    for (const page of doc.pages) {
      for (const run of interpretPage(page).glyphRuns) {
        const font = FontProgram.load(doc, run.fontDict);
        assert.ok(font, `${name}: ${run.name} has a program`);
        for (const g of run.glyphs) {
          if (!g.unicode.trim()) continue;
          shown++;
          assert.ok(font.outline(g.glyph)?.length, `${name}: ${run.name} draws ${g.unicode}`);
        }
      }
    }
    assert.ok(shown > 50, `${name}: ${shown} glyphs`);
  }
});

test('glyph runs carry their font and each glyph’s code or CID', () => {
  const doc = load('xelatex.pdf');
  const run = interpretPage(doc.pages[0]).glyphRuns[0];
  assert.equal(run.fontDict.name('Subtype'), 'Type0');
  // Identity-H: the CID is the two-byte code; distinct letters, distinct CIDs.
  const t = run.glyphs.find((g) => g.unicode === 'T')!;
  const h = run.glyphs.find((g) => g.unicode === 'h')!;
  assert.notEqual(t.glyph, h.glyph);
});
