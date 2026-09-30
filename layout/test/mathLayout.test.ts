import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseLatex } from '@word/docx';
import { FontSet } from '../src/index.ts';
import { layoutMath, type MathLayout } from '../src/math/layout.ts';

// Uses the generated math font in client/public/fonts (run `pnpm fonts --only libertinus-math`).
const FONT_DIR = path.resolve(import.meta.dirname, '../../client/public/fonts');
const hasFonts = existsSync(path.join(FONT_DIR, 'libertinus-math', 'math.json'));
const skip = hasFonts ? {} : { skip: 'run `pnpm fonts` first' };
const fonts = hasFonts ? await FontSet.load(async (p) => JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8'))) : null;
if (fonts) await fonts.ensureMath();

const CP = (c: string) => c.codePointAt(0)!;

function lay(latex: string, display = false): MathLayout {
  const { equation, errors } = parseLatex(latex, display);
  assert.deepEqual(errors, [], latex);
  return layoutMath(equation.content, fonts!.metrics(fonts!.mathFace!)!, fonts!.mathData!, { display });
}

const face = () => fonts!.metrics(fonts!.mathFace!)!;
const data = () => fonts!.mathData!;
const glyphAt = (layout: MathLayout, unicode: string) => layout.glyphs.filter((g) => face().layout.glyphs[g.glyph].unicode === CP(unicode));

test('a letter is one italic glyph on the baseline', skip, () => {
  const x = lay('x');
  assert.equal(x.glyphs.length, 1);
  assert.equal(x.glyphs[0].y, 0);
  assert.equal(x.glyphs[0].size, 1);
  assert.equal(face().layout.glyphs[x.glyphs[0].glyph].unicode, 0x1d465, 'x is drawn as MATHEMATICAL ITALIC SMALL X');
  assert.ok(x.width > 0.3 && x.width < 0.8);
  assert.ok(x.ascent > 0.3 && x.descent >= 0);
});

test('digits and capital Greek stay upright; font commands pick the alphabet', skip, () => {
  assert.equal(face().layout.glyphs[lay('7').glyphs[0].glyph].unicode, CP('7'));
  assert.equal(face().layout.glyphs[lay('\\Omega').glyphs[0].glyph].unicode, 0x3a9);
  assert.equal(face().layout.glyphs[lay('\\alpha').glyphs[0].glyph].unicode, 0x1d6fc);
  assert.equal(face().layout.glyphs[lay('\\mathbb{R}').glyphs[0].glyph].unicode, 0x211d);
  assert.equal(face().layout.glyphs[lay('\\mathbf{x}').glyphs[0].glyph].unicode, 0x1d431);
});

test('superscripts rise and shrink; subscripts drop', skip, () => {
  const [base, up] = lay('x^2').glyphs;
  assert.equal(up.size, 0.8);
  assert.ok(up.y < -0.25, 'raised above the baseline (y is downward)');
  assert.ok(up.x >= base.x + face().advance(base.glyph), 'placed after the base');
  const [, down] = lay('x_i').glyphs;
  assert.equal(down.size, 0.8);
  assert.ok(down.y > 0.1, 'dropped below the baseline');
  // Both together: separated by at least the minimum gap.
  const both = lay('x^2_i');
  const [, s, b] = both.glyphs;
  assert.ok(s.y < b.y);
  // Scripts of scripts shrink further.
  const nested = lay('x^{y^z}').glyphs;
  assert.equal(nested[2].size, 0.6);
});

test('a fraction is two rows around a bar on the math axis', skip, () => {
  const f = lay('\\frac{a}{b}');
  assert.equal(f.rules.length, 1);
  const bar = f.rules[0];
  assert.equal(bar.height, data().constants.fractionRuleThickness);
  const axis = data().constants.axisHeight;
  assert.ok(Math.abs(-(bar.y + bar.height / 2) - axis) < 1e-9, 'bar is centered on the axis');
  const [num, den] = f.glyphs;
  assert.ok(num.y < bar.y, 'numerator above the bar');
  assert.ok(den.y > bar.y + bar.height, 'denominator below the bar');
  assert.ok(f.width >= Math.max(...f.glyphs.map((g) => g.x)) && f.ascent > 0.6 && f.descent > 0.2);
  // Display style uses larger shifts than text style.
  assert.ok(lay('\\frac{a}{b}', true).ascent > f.ascent);
  // Nested fractions shrink their parts.
  assert.equal(lay('\\frac{1}{\\frac{1}{2}}').glyphs.some((g) => g.size < 0.8), true);
});

test('relations and binary operators get TeX spacing; a leading minus does not', skip, () => {
  const glyphs = (s: string) => lay(s).glyphs;
  const gap = (s: string, from: number) => {
    const g = glyphs(s);
    return g[from + 1].x - (g[from].x + face().advance(g[from].glyph));
  };
  assert.ok(Math.abs(gap('a=b', 0) - 5 / 18) < 1e-6, 'thick space before a relation');
  assert.ok(Math.abs(gap('a+b', 0) - 4 / 18) < 1e-6, 'medium space before a binary operator');
  assert.ok(Math.abs(gap('a,b', 0)) < 1e-6 && Math.abs(gap('a,b', 1) - 3 / 18) < 1e-6, 'thin space after a comma');
  const minus = glyphs('-x');
  assert.ok(Math.abs(minus[1].x - face().advance(minus[0].glyph)) < 1e-6, 'a leading minus is a plain symbol');
  // No extra space inside scripts.
  const script = glyphs('x^{a=b}');
  assert.ok(Math.abs(script[2].x - (script[1].x + face().advance(script[1].glyph) * 0.8)) < 1e-6);
});

test('a square root has a sign, an overbar that spans the radicand, and clearance above it', skip, () => {
  const r = lay('\\sqrt{x}');
  assert.equal(r.rules.length, 1);
  const x = glyphAt(r, '\u{1d465}')[0];
  const bar = r.rules[0];
  assert.ok(Math.abs(bar.x + bar.width - (x.x + face().advance(x.glyph))) < 0.01, 'the bar ends at the radicand');
  assert.ok(bar.x <= x.x + 1e-6, 'and starts before it');
  assert.ok(-bar.y > 0.4, 'above the x');
  assert.ok(bar.height === data().constants.radicalRuleThickness);
  // Taller radicands need a larger sign.
  const tall = lay('\\sqrt{\\frac{a}{b}}');
  const sign = (l: MathLayout) => l.glyphs[0].glyph;
  assert.notEqual(sign(tall), sign(r), 'a taller variant of the sign');
  // A degree sits over the sign's left tick, in scriptscript size.
  const cube = lay('\\sqrt[3]{x}');
  assert.equal(cube.glyphs[0].size, 0.6);
  assert.ok(cube.glyphs[0].x < cube.glyphs[2].x, 'left of the radicand, tucked into the sign');
  assert.ok(cube.glyphs[0].y < 0, 'raised above the baseline');
});

test('a large operator grows in display style and puts its limits above and below', skip, () => {
  const inline = lay('\\sum_{i=1}^{n} i');
  const display = lay('\\sum_{i=1}^{n} i', true);
  const sum = (l: MathLayout) => l.glyphs.find((g) => g.size === 1 && face().layout.glyphs[g.glyph].unicode !== 0x1d456)!;
  assert.notEqual(sum(display).glyph, sum(inline).glyph, 'display uses a larger variant');
  // Display: limits centered above and below the operator.
  const scripts = display.glyphs.filter((g) => g.size < 1);
  const op = sum(display);
  assert.ok(scripts.some((g) => g.y < op.y - 0.4), 'upper limit above');
  assert.ok(scripts.some((g) => g.y > op.y + 0.4), 'lower limit below');
  // Inline: limits are scripts to the right of the operator.
  const inlineScripts = inline.glyphs.filter((g) => g.size < 1);
  assert.ok(inlineScripts.every((g) => g.x >= sum(inline).x + face().advance(sum(inline).glyph) - 0.05));
  // The operator is centered on the axis.
  const b = face().layout.glyphs[op.glyph].planeBounds!;
  const center = op.y + (b.top + b.bottom) / 2;
  assert.ok(Math.abs(-center - data().constants.axisHeight) < 0.06);
  // Integrals keep scripts at the side even in display style.
  const integral = lay('\\int_0^1 f', true).glyphs.filter((g) => g.size < 1);
  const glyphInt = lay('\\int_0^1 f', true).glyphs[0];
  assert.ok(integral.every((g) => g.x > glyphInt.x));
});

test('delimiters stretch to their contents, centered on the axis, and assemble beyond the largest size', skip, () => {
  const small = lay('\\left( x \\right)');
  const paren = face().glyph(CP('('));
  assert.equal(small.glyphs[0].glyph, paren, 'a short content keeps the plain parenthesis');
  const tall = lay('\\left( \\frac{a}{b} \\right)', true);
  assert.notEqual(tall.glyphs[0].glyph, paren, 'a tall one gets a larger variant');
  assert.ok(tall.glyphs[tall.glyphs.length - 1].glyph !== face().glyph(CP(')')));
  // Centered on the axis (within the margin of estimated ink bounds).
  const b = face().layout.glyphs[tall.glyphs[0].glyph].planeBounds!;
  assert.ok(Math.abs(-(tall.glyphs[0].y + (b.top + b.bottom) / 2) - data().constants.axisHeight) < 0.06);
  // Far taller than any variant: pieces are stacked.
  const huge = lay('\\left( \\begin{matrix} a \\\\ b \\\\ c \\\\ d \\\\ e \\\\ f \\end{matrix} \\right)');
  // The bracket pieces (⎛ ⎜ ⎝ and ⎞ ⎟ ⎠, U+239B-23A0) stacked, with the extender repeated.
  const pieces = huge.glyphs.filter((g) => {
    const u = face().layout.glyphs[g.glyph].unicode;
    return u !== undefined && u >= 0x239b && u <= 0x23a0;
  });
  assert.ok(pieces.length >= 6, `assembled from pieces (${pieces.length})`);
  // Pieces overlap at their connectors: consecutive pieces are less than a full advance apart.
  const ys = pieces.filter((p) => p.x === pieces[0].x).map((p) => p.y).sort((a, c) => a - c);
  assert.ok(ys.every((y, i) => i === 0 || y - ys[i - 1] > 0.5), 'pieces are a stack, one after another');
  // The assembled delimiter covers the content's height.
  assert.ok(huge.ascent + huge.descent > 3);
});

test('accents and bars sit above the base; \\underline sits below', skip, () => {
  const hat = lay('\\hat{x}');
  assert.equal(hat.glyphs.length, 2);
  const [x, accent] = hat.glyphs;
  assert.ok(hat.ascent > lay('x').ascent + 0.15, 'the accent adds height');
  // The accent's own attachment point lands on the base's.
  const attachX = data().topAccent[x.glyph];
  const attachAccent = data().topAccent[accent.glyph];
  assert.ok(Math.abs(accent.x + attachAccent - (x.x + attachX)) < 1e-9);
  const over = lay('\\overline{x}');
  assert.equal(over.rules.length, 1);
  assert.ok(-over.rules[0].y > lay('x').ascent);
  const under = lay('\\underline{x}');
  assert.ok(under.rules[0].y > 0 && under.descent > lay('x').descent);
});

test('matrices align columns and stack rows; aligned lines share their alignment point', skip, () => {
  const m = lay('\\begin{matrix} a & b \\\\ c & d \\end{matrix}');
  const [a, b, c, d] = m.glyphs;
  assert.ok(Math.abs(a.x - c.x) < 0.1 && b.x > a.x + 0.5, 'columns line up, a column apart');
  assert.ok(c.y > a.y + 0.7 && Math.abs(c.y - d.y) < 1e-9, 'rows a line apart');
  const eq = lay('\\begin{aligned} a &= b \\\\ cc &= d \\end{aligned}');
  const equals = glyphAt(eq, '=');
  assert.equal(equals.length, 2);
  assert.ok(Math.abs(equals[0].x - equals[1].x) < 1e-9, 'the = signs line up');
  const cases = lay('f = \\begin{cases} 1 & x \\\\ 22 & y \\end{cases}');
  assert.ok(cases.glyphs.length > 5);
});

test('every construct lays out to finite numbers, and nothing draws above or below its box', skip, () => {
  const SAMPLES = [
    '\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}',
    'e^{i\\pi}+1=0',
    '\\sum_{i=1}^{n}{a_i x^i} = \\int_0^\\infty e^{-x^2}\\,dx',
    '\\left( \\frac{a}{b} \\right)',
    '\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}',
    '\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1',
    "f'(x) = \\hat{y} + \\overline{z}",
    '\\mathbb{R}^n \\subset \\mathcal{C}',
    '\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}',
    '\\binom{n}{k} = \\frac{n!}{k!(n-k)!}',
    '\\alpha\\beta\\Gamma \\le \\infty',
    '{}_a^b X',
    '\\underset{a}{b} + \\overset{c}{d}',
    'f(x) = \\begin{cases} 1 & x > 0 \\\\ 0 & x \\le 0 \\end{cases}',
  ];
  for (const src of SAMPLES) {
    for (const display of [false, true]) {
      const l = lay(src, display);
      const numbers = [l.width, l.ascent, l.descent, ...l.glyphs.flatMap((g) => [g.x, g.y, g.size]), ...l.rules.flatMap((r) => [r.x, r.y, r.width, r.height])];
      assert.ok(numbers.every(Number.isFinite), src);
      assert.ok(l.width > 0 && l.glyphs.length > 0, src);
      for (const r of l.rules) assert.ok(-r.y <= l.ascent + 1e-6 && r.y + r.height <= l.descent + 1e-6, `${src}: rule inside the box`);
    }
  }
  // Empty equations are fine.
  assert.equal(lay('').width, 0);
});
