import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WordDocument, isMathInline, mathInline, parseLatex, parseXml, readOmml, readMathInline, serializeXml, toLatex, writeOmml, type MathEquation, type Paragraph } from '../src/index.ts';

const tree = (latex: string, display = false): MathEquation => {
  const { equation, errors } = parseLatex(latex, display);
  assert.deepEqual(errors, [], latex);
  return equation;
};

test('parses fractions, scripts and roots', () => {
  assert.deepEqual(tree('\\frac{a}{b}').content, [{ type: 'frac', num: [{ type: 'text', text: 'a' }], den: [{ type: 'text', text: 'b' }] }]);
  assert.deepEqual(tree('x^2_i').content, [{ type: 'script', base: [{ type: 'text', text: 'x' }], sup: [{ type: 'text', text: '2' }], sub: [{ type: 'text', text: 'i' }] }]);
  assert.deepEqual(tree('\\sqrt[3]{x}').content, [{ type: 'rad', degree: [{ type: 'text', text: '3' }], body: [{ type: 'text', text: 'x' }] }]);
});

test('a script binds to the last character only', () => {
  const [a, b] = tree('ab^2').content;
  assert.deepEqual(a, { type: 'text', text: 'a' });
  assert.equal(b.type, 'script');
});

test('large operators take the atoms up to the next relation as their operand', () => {
  const [sum, plus] = tree('\\sum_{i=1}^n a_i + b').content;
  assert.equal(sum.type, 'nary');
  assert.equal((sum as { op: string }).op, '∑');
  assert.equal((sum as { body: unknown[] }).body.length, 1);
  assert.deepEqual(plus, { type: 'text', text: '+b' });
  const [integral] = tree('\\int_0^1 f(x)\\,dx').content;
  assert.equal(integral.type, 'nary');
  assert.ok((integral as { body: unknown[] }).body.length > 2);
});

test('\\left \\right, matrices and cases', () => {
  const [d] = tree('\\left( a \\middle| b \\right]').content;
  assert.deepEqual([(d as { open: string }).open, (d as { close: string }).close, (d as { separator: string }).separator], ['(', ']', '|']);
  const [m] = tree('\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}').content;
  assert.equal(m.type, 'delim');
  const inner = (m as { items: { type: string; rows: unknown[][] }[][] }).items[0][0];
  assert.equal(inner.type, 'matrix');
  assert.equal(inner.rows.length, 2);
  assert.equal(inner.rows[0].length, 2);
  const [c] = tree('f(x)=\\begin{cases} 1 & x>0 \\\\ 0 & x\\le 0 \\end{cases}').content.slice(-1);
  assert.equal(c.type, 'delim');
});

test('rows separated by \\\\ make an equation array', () => {
  const [array] = tree('a &= b \\\\ c &= d').content;
  assert.equal(array.type, 'eqArray');
  assert.equal((array as { rows: unknown[] }).rows.length, 2);
});

test('font commands, functions and limits', () => {
  assert.deepEqual(tree('\\mathbb{R}').content, [{ type: 'text', text: 'R', style: 'doubleStruck' }]);
  const [lim] = tree('\\lim_{x\\to 0} f').content;
  assert.equal(lim.type, 'func');
  assert.equal((lim as { name: { type: string }[] }).name[0].type, 'limit');
  const [sin] = tree('\\sin(x)').content;
  assert.equal((sin as { arg: { type: string }[] }).arg[0].type, 'delim');
});

test('errors are reported and the source text is kept', () => {
  const { equation, errors } = parseLatex('a + \\bogus{x} \\frac{1}');
  assert.equal(errors.length >= 2, true);
  assert.match(errors[0], /bogus/);
  assert.ok(JSON.stringify(equation).includes('\\\\bogus'));
  // Garbage never throws or hangs.
  for (const junk of ['}{', '\\left(', '\\begin{x', '^^__', '\\end{a}', '\\frac', '{{{{', '\\sum_', '\\text{abc']) assert.doesNotThrow(() => parseLatex(junk));
});

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
];

test('LaTeX prints and parses back to the same tree', () => {
  for (const src of SAMPLES) {
    const first = tree(src);
    const printed = toLatex(first);
    assert.deepEqual(tree(printed), first, `${src}  ->  ${printed}`);
  }
});

test('OMML writes and reads back to the same tree', () => {
  for (const src of SAMPLES) {
    for (const display of [false, true]) {
      const first = tree(src, display);
      const xml = serializeXml(writeOmml(first), false);
      assert.deepEqual(readOmml(parseXml(xml)), first, src);
    }
  }
});

const WORD_OMML = `<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<m:f><m:fPr><m:ctrlPr><w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/><w:i/></w:rPr></m:ctrlPr></m:fPr><m:num><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>1</m:t></m:r></m:num><m:den><m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:den></m:f>
<m:nary><m:naryPr><m:chr m:val="∑"/><m:supHide m:val="1"/></m:naryPr><m:sub><m:r><m:t>i</m:t></m:r></m:sub><m:sup/><m:e><m:r><m:t>i</m:t></m:r></m:e></m:nary>
</m:oMath>`;

test('reads OMML as Word writes it, and recognizes any prefix for the namespace', () => {
  const eq = readOmml(parseXml(WORD_OMML));
  assert.deepEqual(eq.content.map((n) => n.type), ['frac', 'nary']);
  assert.equal(toLatex(eq), '\\frac{1}{x^2}\\sum_i i');
  const other = parseXml(WORD_OMML.replaceAll('m:', 'mm:').replaceAll('xmlns:m=', 'xmlns:mm='));
  assert.equal(other.name, 'm:oMath');
});

test('an equation in a paragraph survives a .docx round trip and counts as one position', async () => {
  const doc = await WordDocument.create();
  const run = (text: string) => ({ kind: 'run' as const, properties: {}, content: [{ kind: 'text' as const, text }], attrs: {} });
  const inline = mathInline(tree('\\frac{a}{b}'));
  const p: Paragraph = { kind: 'paragraph', properties: {}, children: [run('See '), inline, run(' here')], attrs: {} };
  doc.body = [p];
  const back = await WordDocument.read(await doc.write());
  const children = (back.body[0] as Paragraph).children;
  assert.equal(children.length, 3);
  assert.ok(isMathInline(children[1]));
  assert.equal(toLatex(readMathInline(children[1] as never)), '\\frac{a}{b}');
});
