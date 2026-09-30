import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromMathML, parseLatex, parseXml, toMathML } from '../src/index.ts';

const mathml = (latex: string, display = false): string => {
  const { equation, errors } = parseLatex(latex, display);
  assert.deepEqual(errors, [], latex);
  const xml = toMathML(equation);
  assert.doesNotThrow(() => parseXml(xml), latex);
  return xml;
};

test('MathML follows the structure of the equation', () => {
  assert.match(mathml('\\frac{a}{b}'), /<mfrac><mi>a<\/mi><mi>b<\/mi><\/mfrac>/);
  assert.match(mathml('x^2_i'), /<msubsup><mi>x<\/mi><mi>i<\/mi><mn>2<\/mn><\/msubsup>/);
  assert.match(mathml('\\sqrt[3]{x}'), /<mroot><mi>x<\/mi><mn>3<\/mn><\/mroot>/);
  assert.match(mathml('\\sqrt{x}'), /<msqrt>/);
  assert.match(mathml('a = b'), /<mo>=<\/mo>/);
  assert.match(mathml('\\sin x'), /<mi mathvariant="normal">sin<\/mi><mo>&#x2061;<\/mo>/);
  assert.match(mathml('\\sum_{i=1}^{n} i', true), /<munderover><mo largeop="true" movablelimits="true">∑<\/mo>/);
  assert.match(mathml('\\int_0^1 f'), /<msubsup><mo largeop="true" movablelimits="true">∫<\/mo>/);
  assert.match(mathml('\\mathbb{R}'), /<mi mathvariant="double-struck">R<\/mi>/);
  assert.match(mathml('\\left( x \\right)'), /<mo fence="true" form="prefix">\(<\/mo>.*<mo fence="true" form="postfix">\)<\/mo>/);
  assert.match(mathml('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}'), /<mtable><mtr><mtd><mi>a<\/mi><\/mtd><mtd><mi>b<\/mi><\/mtd><\/mtr>/);
  assert.match(mathml('\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}'), /columnalign="right left"/);
  assert.match(mathml('x', true), /display="block"/);
  assert.match(mathml('x'), /display="inline"/);
  assert.match(mathml('\\binom{n}{k}'), /linethickness="0"/);
  assert.match(mathml('\\hat{x}'), /<mover accent="true"><mi>x<\/mi><mo>\^<\/mo><\/mover>/);
});

test('MathML escapes markup characters and keeps every construct well-formed', () => {
  assert.match(mathml('a < b'), /<mo>&lt;<\/mo>/);
  for (const src of [
    '\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}',
    '\\sum_{i=1}^{n}{a_i x^i} = \\int_0^\\infty e^{-x^2}\\,dx',
    '\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1',
    '{}_a^b X',
    '\\underset{a}{b} + \\overset{c}{d}',
    'f(x) = \\begin{cases} 1 & x > 0 \\\\ 0 & x \\le 0 \\end{cases}',
    '\\overline{x} + \\underline{y} + \\vec{v}',
  ]) {
    mathml(src);
    mathml(src, true);
  }
});

test('MathML is read back into the same equation for the common structures', () => {
  for (const src of [
    '\\frac{a}{b}',
    'x^2_i + y_j',
    '\\sqrt{x} + \\sqrt[3]{y}',
    '\\left( \\frac{a}{b} \\right)',
    '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
    '\\hat{x} + \\overline{y} + \\underline{z}',
    '\\binom{n}{k}',
    '{}_a^b X',
    '\\mathbb{R}^n \\ne \\mathbf{v}',
    'a \\le b',
    '\\underset{a}{b}',
    '\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}',
  ]) {
    for (const display of [false, true]) {
      const first = parseLatex(src, display).equation;
      const back = fromMathML(parseXml(toMathML(first)));
      assert.deepEqual(back, first, src);
    }
  }
});

test('a large operator keeps its limits; upright names stay names; MathML from other producers reads', () => {
  const [sum] = fromMathML(parseXml(toMathML(parseLatex('\\sum_{i=1}^{n} i', true).equation))).content;
  assert.equal(sum.type, 'nary');
  assert.equal((sum as { limits?: string }).limits, 'aboveBelow');
  const [name] = fromMathML(parseXml(toMathML(parseLatex('\\sin x').equation))).content;
  assert.deepEqual(name, { type: 'text', text: 'sin', style: 'normal' });
  // What a browser or Word writes: an mfenced, invisible operators, whitespace and entities.
  const other = parseXml('<math display="block"><mfenced open="[" close="]"><mi>a</mi><mn>1</mn></mfenced> <mo>&#x2062;</mo><mi>x</mi></math>');
  const eq = fromMathML(other);
  assert.equal(eq.display, true);
  assert.equal(eq.content[0].type, 'delim');
});
