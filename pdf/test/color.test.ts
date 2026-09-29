// Color spaces and PDF functions (render/color.ts): components in, sRGB out.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PdfDict, PdfName, PdfStream, PdfString, type PdfObject } from '../src/core/objects.ts';
import { PdfDocument } from '../src/document.ts';
import { cmykToRgb, DEVICE_CMYK, DEVICE_GRAY, DEVICE_RGB, parseColorSpace, parseFunction } from '../src/render/color.ts';

const N = PdfName.of;
const doc = PdfDocument.create();
const bytes = (...b: number[]) => Uint8Array.from(b);
const text = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const near = (actual: ArrayLike<number>, expected: number[], eps = 1e-6) => {
  assert.equal(actual.length, expected.length);
  expected.forEach((e, i) => assert.ok(Math.abs(actual[i]! - e) <= eps, `component ${i}: ${actual[i]} vs ${e}`));
};
const fnStream = (entries: Record<string, PdfObject>, data: Uint8Array) => new PdfStream(new PdfDict(entries), data);
const ps = (code: string, entries: Record<string, PdfObject> = {}) => parseFunction(doc, fnStream({ FunctionType: 4, Domain: [0, 1], ...entries }, text(code)))!;

test('device spaces clamp components and default missing ones', () => {
  near(DEVICE_GRAY.toRgb([2]), [1, 1, 1]);
  near(DEVICE_GRAY.toRgb([]), [0, 0, 0]);
  near(DEVICE_RGB.toRgb([-1, 0.5, 9]), [0, 0.5, 1]);
  near(DEVICE_RGB.toRgb([]), [0, 0, 0]);
  near(DEVICE_CMYK.toRgb([0, 0, 0, 1]), [0, 0, 0]);
  near(DEVICE_CMYK.toRgb([]), [1, 1, 1]);
  near(cmykToRgb(1, 0, 0, 0), [0, 1, 1]);
  near(cmykToRgb(5, -5, 0, 0.5), [0, 0.5, 0.5], 1e-9);
  assert.deepEqual(DEVICE_CMYK.initial, [0, 0, 0, 1]);
  assert.deepEqual(DEVICE_RGB.decode(8), [0, 1, 0, 1, 0, 1]);
});

test('names resolve through the resources, with a depth limit, and unknown names are gray', () => {
  assert.equal(parseColorSpace(doc, N('DeviceRGB')), DEVICE_RGB);
  assert.equal(parseColorSpace(doc, N('CMYK')), DEVICE_CMYK);
  assert.equal(parseColorSpace(doc, N('CalRGB')), DEVICE_RGB);
  assert.equal(parseColorSpace(doc, undefined), DEVICE_GRAY);
  assert.equal(parseColorSpace(doc, N('Nope')), DEVICE_GRAY);
  assert.equal(parseColorSpace(doc, 42), DEVICE_GRAY);
  assert.equal(parseColorSpace(doc, []), DEVICE_GRAY);
  assert.equal(parseColorSpace(doc, [5]), DEVICE_GRAY, 'first element is not a name');

  const resources = new PdfDict({ ColorSpace: new PdfDict({ Cs1: N('DeviceCMYK'), Loop: N('Loop'), Ping: N('Pong'), Pong: N('Ping') }) });
  assert.equal(parseColorSpace(doc, N('Cs1'), resources), DEVICE_CMYK);
  assert.equal(parseColorSpace(doc, N('Cs1')), DEVICE_GRAY, 'without resources the name is unknown');
  assert.equal(parseColorSpace(doc, N('Loop'), resources), DEVICE_GRAY, 'self reference terminates');
  assert.equal(parseColorSpace(doc, N('Ping'), resources), DEVICE_GRAY, 'mutual reference terminates');
  assert.equal(parseColorSpace(doc, [N('CalGray'), new PdfDict()]), DEVICE_GRAY);
  assert.equal(parseColorSpace(doc, [N('CalRGB'), new PdfDict()]), DEVICE_RGB);
});

test('ICCBased spaces are chosen by component count', () => {
  const icc = (n?: number) => [N('ICCBased'), fnStream(n === undefined ? {} : { N: n }, bytes())];
  assert.equal(parseColorSpace(doc, icc(1)), DEVICE_GRAY);
  assert.equal(parseColorSpace(doc, icc(3)), DEVICE_RGB);
  assert.equal(parseColorSpace(doc, icc(4)), DEVICE_CMYK);
  assert.equal(parseColorSpace(doc, icc()), DEVICE_RGB, 'no /N: assume RGB');
  assert.equal(parseColorSpace(doc, [N('ICCBased'), 7]), DEVICE_RGB, 'no stream: assume RGB');
});

test('Pattern spaces have no color of their own', () => {
  const p = parseColorSpace(doc, [N('Pattern')]);
  assert.equal(p.pattern, true);
  assert.equal(p.n, 0);
  assert.equal(parseColorSpace(doc, N('Pattern')), p);
});

test('Indexed looks colors up in the palette, clamping the index', () => {
  const cs = parseColorSpace(doc, [N('Indexed'), N('DeviceRGB'), 1, new PdfString(bytes(255, 0, 0, 0, 255, 0))]);
  assert.equal(cs.name, 'Indexed');
  assert.equal(cs.n, 1);
  near(cs.toRgb([0]), [1, 0, 0]);
  near(cs.toRgb([1]), [0, 1, 0]);
  near(cs.toRgb([0.6]), [0, 1, 0], 0); // rounds to 1
  near(cs.toRgb([99]), [0, 1, 0]);
  near(cs.toRgb([-3]), [1, 0, 0]);
  near(cs.toRgb([]), [1, 0, 0]);
  assert.deepEqual(cs.decode(4), [0, 15]);
  assert.deepEqual(cs.decode(8), [0, 255]);
  assert.deepEqual(cs.decode(16), [0, 255], 'indexed samples never exceed 8 bits');
});

test('Indexed: a stream lookup, a short table (missing bytes are 0) and a hival past 255', () => {
  const stream = fnStream({}, bytes(0, 0, 255));
  const cs = parseColorSpace(doc, [N('I'), N('DeviceRGB'), 1, stream]);
  near(cs.toRgb([0]), [0, 0, 1]);
  near(cs.toRgb([1]), [0, 0, 0], 0);
  const wide = parseColorSpace(doc, [N('Indexed'), N('DeviceGray'), 1000, new PdfString(bytes(255))]);
  near(wide.toRgb([255]), [0, 0, 0]);
  near(wide.toRgb([1000]), [0, 0, 0], 0); // clamped to 255
  const none = parseColorSpace(doc, [N('Indexed'), N('DeviceGray'), 0]);
  near(none.toRgb([0]), [0, 0, 0]);
});

test('Indexed over CMYK converts each palette entry', () => {
  const cs = parseColorSpace(doc, [N('Indexed'), N('DeviceCMYK'), 0, new PdfString(bytes(255, 0, 0, 0))]);
  near(cs.toRgb([0]), [0, 1, 1]);
});

test('Separation and DeviceN run the tint transform into the alternate space', () => {
  const tintFn = { FunctionType: 2, Domain: [0, 1], C0: [1, 1, 1], C1: [1, 0, 0], N: 1 };
  const sep = parseColorSpace(doc, [N('Separation'), N('Spot'), N('DeviceRGB'), new PdfDict(tintFn)]);
  assert.equal(sep.n, 1);
  assert.deepEqual(sep.initial, [1]);
  near(sep.toRgb([1]), [1, 0, 0]);
  near(sep.toRgb([0.5]), [1, 0.5, 0.5]);
  near(sep.toRgb([]), [1, 1, 1]);
  assert.deepEqual(sep.decode(8), [0, 1]);

  const twoInputs = fnStream({ FunctionType: 4, Domain: [0, 1, 0, 1], Range: [0, 1, 0, 1, 0, 1] }, text('{ 0 }'));
  const dn = parseColorSpace(doc, [N('DeviceN'), [N('A'), N('B')], N('DeviceRGB'), twoInputs]);
  assert.equal(dn.n, 2);
  assert.deepEqual(dn.initial, [1, 1]);
  near(dn.toRgb([0.25, 0.75]), [0.25, 0.75, 0]);
});

test('a tint space with no usable function falls back to darkness proportional to the tint', () => {
  const sep = parseColorSpace(doc, [N('Separation'), N('Spot'), N('DeviceRGB'), 5]);
  near(sep.toRgb([0]), [1, 1, 1]);
  near(sep.toRgb([0.25]), [0.75, 0.75, 0.75]);
  near(sep.toRgb([7]), [0, 0, 0]);
  const dn = parseColorSpace(doc, [N('DeviceN'), [], N('DeviceRGB'), null]);
  assert.equal(dn.n, 1, 'an empty colorant list still has one component');
});

test('Lab: white, black, the initial color and the default decode', () => {
  const cs = parseColorSpace(doc, [N('Lab'), new PdfDict({ WhitePoint: [0.9642, 1, 0.8249], Range: [-50, 50, -60, 60] })]);
  near(cs.toRgb([100, 0, 0]), [1, 1, 1], 0.02);
  near(cs.toRgb([0, 0, 0]), [0, 0, 0], 0.01);
  const red = cs.toRgb([50, 80, 60]);
  assert.ok(red[0] > red[1] && red[0] > red[2], 'positive a* is reddish');
  const blue = cs.toRgb([30, 0, -80]);
  assert.ok(blue[2] > blue[0] && blue[2] > blue[1], 'negative b* is bluish');
  assert.deepEqual(cs.decode(8), [0, 100, -50, 50, -60, 60]);
  assert.deepEqual(cs.initial, [0, 0, 0]);
  const defaults = parseColorSpace(doc, [N('Lab'), new PdfDict()]);
  assert.deepEqual(defaults.decode(8), [0, 100, -100, 100, -100, 100]);
  const shifted = parseColorSpace(doc, [N('Lab'), new PdfDict({ Range: [10, 20, 30, 40] })]);
  assert.deepEqual(shifted.initial, [0, 10, 30], 'initial a*, b* are the range point nearest 0');
});

test('exponential functions (type 2)', () => {
  const linear = parseFunction(doc, new PdfDict({ FunctionType: 2, Domain: [0, 1], C0: [0, 1], C1: [1, 0], N: 1 }))!;
  near(linear([0.25]), [0.25, 0.75]);
  near(linear([-5]), [0, 1], 0); // input clamped to the domain
  near(linear([5]), [1, 0]);
  const squared = parseFunction(doc, new PdfDict({ FunctionType: 2, N: 2 }))!;
  near(squared([0.5]), [0.25], 1e-9);
  const ranged = parseFunction(doc, new PdfDict({ FunctionType: 2, C0: [0], C1: [10], Range: [0, 1] }))!;
  near(ranged([0.5]), [1], 0); // output clamped to the range
});

test('stitching functions (type 3) pick the piece and rescale the input', () => {
  const up = { FunctionType: 2, Domain: [0, 1], C0: [0], C1: [1], N: 1 };
  const down = { FunctionType: 2, Domain: [0, 1], C0: [1], C1: [0], N: 1 };
  const f = parseFunction(doc, new PdfDict({ FunctionType: 3, Domain: [0, 1], Functions: [new PdfDict(up), new PdfDict(down)], Bounds: [0.5], Encode: [0, 1, 0, 1] }))!;
  near(f([0.25]), [0.5]);
  near(f([0.5]), [1], 1e-9); // the boundary belongs to the next piece, at its start
  near(f([0.75]), [0.5]);
  near(f([1]), [0]);
  near(f([0]), [0]);
  // Reversed encoding on the first piece.
  const g = parseFunction(doc, new PdfDict({ FunctionType: 3, Domain: [0, 1], Functions: [new PdfDict(up), new PdfDict(down)], Bounds: [0.5], Encode: [1, 0, 0, 1] }))!;
  near(g([0]), [1]);
  near(g([0.25]), [0.5]);
  // One function and no bounds; a zero-width piece maps to the start of its encoding.
  const one = parseFunction(doc, new PdfDict({ FunctionType: 3, Domain: [0, 1], Functions: [new PdfDict(up)], Bounds: [] }))!;
  near(one([0.4]), [0.4]);
  const degenerate = parseFunction(doc, new PdfDict({ FunctionType: 3, Domain: [0, 0], Functions: [new PdfDict(up)], Bounds: [] }))!;
  near(degenerate([0]), [0]);
});

test('stitching with a missing or unsupported sub-function is unusable', () => {
  assert.equal(parseFunction(doc, new PdfDict({ FunctionType: 3, Functions: [] })), null);
  assert.equal(parseFunction(doc, new PdfDict({ FunctionType: 3, Functions: [new PdfDict({ FunctionType: 9 })] })), null);
  assert.equal(parseFunction(doc, new PdfDict({ FunctionType: 3, Functions: [7] })), null);
});

test('sampled functions (type 0) interpolate between samples', () => {
  const f = parseFunction(doc, fnStream({ FunctionType: 0, Domain: [0, 1], Range: [0, 1], Size: [2], BitsPerSample: 8 }, bytes(0, 255)))!;
  near(f([0]), [0]);
  near(f([1]), [1]);
  near(f([0.5]), [0.5]);
  near(f([2]), [1], 1e-9); // clamped to the domain
  // Two outputs per sample, with a Decode array remapping the range.
  const two = parseFunction(doc, fnStream({ FunctionType: 0, Domain: [0, 1], Range: [0, 1, 0, 1], Size: [2], BitsPerSample: 8, Decode: [1, 0, 0, 1] }, bytes(0, 255, 255, 0)))!;
  near(two([0]), [1, 1]); // sample 0 is (0, 255): decoded (1 - 0, 255/255)
  near(two([1]), [0, 0]); // sample 1 is (255, 0)
  near(two([0.5]), [0.5, 0.5]);
  // 16 bits per sample.
  const wide = parseFunction(doc, fnStream({ FunctionType: 0, Domain: [0, 1], Range: [0, 1], Size: [2], BitsPerSample: 16 }, bytes(0, 0, 0xff, 0xff)))!;
  near(wide([0.5]), [0.5]);
  // 4 bits per sample: two samples in one byte, high nibble first.
  const nibbles = parseFunction(doc, fnStream({ FunctionType: 0, Domain: [0, 1], Range: [0, 1], Size: [2], BitsPerSample: 4 }, bytes(0x0f)))!;
  near(nibbles([0]), [0]);
  near(nibbles([1]), [1]);
});

test('sampled functions with two inputs interpolate bilinearly', () => {
  // Size 2x2, one output; the first input varies fastest: samples (0,0)=0 (1,0)=255 (0,1)=0 (1,1)=255 -> depends on x only.
  const f = parseFunction(doc, fnStream({ FunctionType: 0, Domain: [0, 1, 0, 1], Range: [0, 1], Size: [2, 2], BitsPerSample: 8 }, bytes(0, 255, 0, 255)))!;
  near(f([0.5, 0.2]), [0.5]);
  near(f([1, 0.9]), [1]);
  const g = parseFunction(doc, fnStream({ FunctionType: 0, Domain: [0, 1, 0, 1], Range: [0, 1], Size: [2, 2], BitsPerSample: 8 }, bytes(0, 0, 255, 255)))!;
  near(g([0.9, 0.5]), [0.5], 1e-9);
  const h = parseFunction(doc, fnStream({ FunctionType: 0, Domain: [0, 1, 0, 1], Range: [0, 1], Size: [2, 2], BitsPerSample: 8 }, bytes(0, 255, 255, 0)))!;
  near(h([0.5, 0.5]), [0.5], 1e-9);
});

test('sampled functions with bad parameters are unusable', () => {
  assert.equal(parseFunction(doc, fnStream({ FunctionType: 0, Domain: [0, 1], Range: [0, 1], Size: [2, 2] }, bytes())), null, 'Size does not match Domain');
  assert.equal(parseFunction(doc, fnStream({ FunctionType: 0, Domain: [0, 1], Size: [2] }, bytes())), null, 'no Range');
  assert.equal(parseFunction(doc, new PdfDict({ FunctionType: 0, Domain: [0, 1], Range: [0, 1], Size: [2] })), null, 'a sampled function must be a stream');
  assert.equal(parseFunction(doc, new PdfDict({ FunctionType: 7 })), null);
  assert.equal(parseFunction(doc, 3), null);
  assert.equal(parseFunction(doc, undefined), null);
});

test('PostScript calculator functions: arithmetic and stack operators', () => {
  near(ps('{ dup mul }')([0.5]), [0.25]);
  near(ps('{ 1 exch sub }')([0.25]), [0.75]);
  near(ps('{ 2 mul 1 add 4 div }')([0.5]), [0.5]);
  near(ps('{ 3 2 exch pop }')([0]), [0, 2]); // 0 3 2 -> 0 2 3 -> 0 2
  near(ps('{ 1 2 3 3 1 roll }')([0]), [0, 3, 1, 2]);
  near(ps('{ 1 2 3 3 -1 roll }')([0]), [0, 2, 3, 1]);
  near(ps('{ 5 6 2 copy }')([0]), [0, 5, 6, 5, 6]);
  near(ps('{ 7 8 1 index }')([0]), [0, 7, 8, 7]);
  near(ps('{ 7 neg abs }')([0]), [0, 7]);
  near(ps('{ 7 2 idiv 7 2 mod }')([0]), [0, 3, 1]);
  near(ps('{ 1 0 div 1 0 idiv 1 0 mod }')([0]), [0, 0, 0, 0], 0); // division by zero yields 0, not Infinity
  near(ps('{ 2.5 round 2.5 floor 2.1 ceiling -2.7 truncate 3.9 cvi }')([0]), [0, 3, 2, 3, -2, 3]);
  near(ps('{ 2 3 exp 16 sqrt -4 sqrt 100 log }')([0]), [0, 8, 4, 0, 2]);
  near(ps('{ 90 sin 0 cos 1 1 atan }')([0]), [0, 1, 1, 45], 1e-9);
  near(ps('{ 5 3 bitshift 1 -1 bitshift }')([0]), [0, 40, 0]);
});

test('PostScript calculator functions: comparison, boolean and control operators', () => {
  near(ps('{ 0.5 gt { 1 } { 0 } ifelse }')([0.75]), [1]);
  near(ps('{ 0.5 gt { 1 } { 0 } ifelse }')([0.25]), [0]);
  near(ps('{ 0.5 lt { 9 } if }')([0.25]), [9]);
  near(ps('{ 0.5 lt { 9 } if }')([0.75]), []);
  near(ps('{ dup 0.5 ge exch 0.5 le and { 1 } { 0 } ifelse }')([0.5]), [1]);
  near(ps('{ 1 1 eq 1 2 ne }')([0]), [0, 1, 1]);
  near(ps('{ true false or true false xor true not }')([0]), [0, 1, 1, 0]);
  near(ps('{ 12 10 and 12 10 or 12 10 xor 0 not }')([0]), [0, 8, 14, 6, -1]);
  near(ps('{ 3 { 1 } { 2 } ifelse }')([0]), [0, 1]); // a nonzero number is a true condition
  near(ps('% a comment\n{ 1 add }')([0.5]), [1.5]);
  near(ps('{ nosuchoperator 1 add }')([0.5]), [1.5], 0); // unknown operators are ignored
});

test('PostScript functions clamp inputs, keep only the last outputs and clamp them to Range', () => {
  const f = ps('{ 2 mul dup }', { Range: [0, 1, 0, 1] });
  near(f([0.4]), [0.8, 0.8]);
  near(f([3]), [1, 1], 0); // input clamped to 1, doubled, output clamped
  const g = ps('{ pop 5 6 7 }', { Range: [0, 10, 0, 10] });
  near(g([0.5]), [6, 7], 0);
  const h = ps('{ pop }', { Range: [0, 1] });
  near(h([0.5]), [], 0); // stack empty: nothing to return
});

test('PostScript functions cannot run away or underflow', () => {
  // A loop-free language, but deep nesting must not overflow the budget guard or throw.
  const f = ps('{ pop pop pop add sub mul exch dup copy roll index }');
  assert.doesNotThrow(() => f([0.5]));
  const huge = ps(`{ ${'1 add '.repeat(20000)} }`);
  const out = huge([0]);
  assert.ok(out[0]! <= 10000, `execution budget stops a long program (got ${out[0]})`);
  // Truncated program (missing closing brace) still parses.
  near(ps('{ 1 add')([0.5]), [1.5]);
});

test('parseColorSpace never throws on damaged input', () => {
  const weird: PdfObject[] = [[N('Indexed')], [N('Indexed'), [N('Indexed')], 'x' as any], [N('Separation')], [N('Lab')], [N('DeviceN'), 5], [N('ICCBased')]];
  for (const w of weird) assert.doesNotThrow(() => parseColorSpace(doc, w).toRgb([0.5]));
});
