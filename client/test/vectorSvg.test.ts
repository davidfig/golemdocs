// The vector scene: path data, transforms, styles, and reading and writing SVG (src/vector).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fmt, invert, multiply, parseTransform, rotation, serializeTransform } from '../src/vector/matrix.ts';
import { parsePath, pathBounds, serializePath, transformPath } from '../src/vector/pathData.ts';
import { readSvg, SvgError } from '../src/vector/svgRead.ts';
import { writeSvg } from '../src/vector/svgWrite.ts';
import { parseColor, parseLength, parseStylesheet, styleFor, urlReference } from '../src/vector/style.ts';
import type { PathNode, TextNode } from '../src/vector/model.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);

test('path data: relative commands, implicit repeats and shorthands become absolute lines and cubics', () => {
  assert.deepEqual(parsePath('M10 10 l5 0 0 5 z'), [['M', 10, 10], ['L', 15, 10], ['L', 15, 15], ['Z']]);
  assert.deepEqual(parsePath('M0,0 H10 V20 h-5'), [['M', 0, 0], ['L', 10, 0], ['L', 10, 20], ['L', 5, 20]]);
  // Extra pairs after a moveto are linetos.
  assert.deepEqual(parsePath('M1 1 2 2 3 3'), [['M', 1, 1], ['L', 2, 2], ['L', 3, 3]]);
  // Numbers run together: signs and second decimal points start a new number.
  assert.deepEqual(parsePath('M1-2L.5.5'), [['M', 1, -2], ['L', 0.5, 0.5]]);
  const smooth = parsePath('M0 0 C0 10 10 10 10 0 S20 -10 20 0');
  assert.deepEqual(smooth[2], ['C', 10, -10, 20, -10, 20, 0]);
  // A quadratic is raised to the cubic that draws the same curve.
  assert.deepEqual(parsePath('M0 0 Q30 0 30 30')[1], ['C', 20, 0, 30, 10, 30, 30]);
});

test('path data: arcs become curves that reach the end point and stay on the circle', () => {
  const commands = parsePath('M0 0 a10 10 0 0 1 20 0');
  assert.equal(commands.length, 3);
  const last = commands[commands.length - 1] as readonly ['C', number, number, number, number, number, number];
  near(last[5], 20);
  near(last[6], 0);
  const bounds = pathBounds(commands)!;
  // Sweeping clockwise on screen from the left end to the right end goes over the top.
  near(bounds.y, -10, 1e-2);
  near(bounds.height, 10, 1e-2);
  // Flags written without separators.
  assert.equal(parsePath('M0 0a1 1 0 00.5.5').length, 2);
  // Radii too small are scaled up to reach.
  const small = pathBounds(parsePath('M0 0 A1 1 0 0 1 20 0'))!;
  near(small.width, 20, 1e-6);
});

test('path data: an error keeps what came before it', () => {
  assert.deepEqual(parsePath('M0 0 L10 10 L oops'), [['M', 0, 0], ['L', 10, 10]]);
  assert.deepEqual(parsePath('L10 10'), []);
});

test('path data is written compactly and reads back the same', () => {
  const commands = parsePath('M0.5 0 C1 2 3 4 5 6 L7 8 Z');
  assert.equal(serializePath(commands), 'M0.5 0C1 2 3 4 5 6L7 8Z');
  assert.deepEqual(parsePath(serializePath(commands)), commands);
});

test('bounds include the bulge of a curve and follow a transform', () => {
  const curve = parsePath('M0 0 C0 20 10 20 10 0');
  const b = pathBounds(curve)!;
  near(b.height, 15, 1e-6);
  const turned = pathBounds(curve, rotation(90))!;
  near(turned.width, 15, 1e-6);
  near(turned.x, -15, 1e-6);
  assert.equal(pathBounds([]), null);
  assert.deepEqual(transformPath(parsePath('M1 2L3 4'), [2, 0, 0, 2, 10, 0]), [['M', 12, 4], ['L', 16, 8]]);
});

test('transforms: parsed in order, inverted, and written short', () => {
  const m = parseTransform('translate(10 20) scale(2)')!;
  assert.deepEqual([...m], [2, 0, 0, 2, 10, 20]);
  assert.deepEqual([...parseTransform('rotate(90 5 5)')!].map((v) => Math.round(v * 1e6) / 1e6 || 0), [0, 1, -1, 0, 10, 0].map((v) => v || 0));
  assert.equal(parseTransform('rotate(nope)'), null);
  assert.deepEqual([...multiply(m, invert(m)!)].map((v) => Math.round(v * 1e9) / 1e9 || 0), [1, 0, 0, 1, 0, 0]);
  assert.equal(invert([0, 0, 0, 0, 1, 1]), null);
  assert.equal(serializeTransform([1, 0, 0, 1, 5, 0]), 'translate(5)');
  assert.equal(serializeTransform([2, 0, 0, 3, 0, 0]), 'scale(2 3)');
  assert.equal(serializeTransform([1, 2, 3, 4, 5, 6]), 'matrix(1 2 3 4 5 6)');
  assert.equal(fmt(0.123456), '0.1235');
  assert.equal(fmt(-0.00001), '0');
});

test('colors and lengths', () => {
  assert.deepEqual(parseColor('#f80'), [255, 136, 0, 1]);
  assert.deepEqual(parseColor('#11223380'), [17, 34, 51, 128 / 255]);
  assert.deepEqual(parseColor('rgb(10, 20%, 300)'), [10, 51, 255, 1]);
  assert.deepEqual(parseColor('hsl(120 100% 50%)'), [0, 255, 0, 1]);
  assert.deepEqual(parseColor('RebeccaPurple'), [102, 51, 153, 1]);
  assert.equal(parseColor('none'), null);
  assert.equal(parseColor('url(#a)'), null);
  assert.equal(parseLength('1in'), 96);
  assert.equal(parseLength('50%', 200), 100);
  assert.equal(parseLength('abc'), null);
  assert.equal(urlReference('url("#grad") red'), 'grad');
});

test('a stylesheet applies by specificity and order, to classes, ids, tags and descendants', () => {
  const rules = parseStylesheet('rect{fill:red} .a{fill:green;stroke:blue} #x{fill:black} g > .b{opacity:.5} @media print{rect{fill:pink}}');
  const g = { tag: 'g', classes: [] as string[] };
  const style = (e: Parameters<typeof styleFor>[1]) => Object.fromEntries(styleFor(rules, e));
  assert.deepEqual(style({ tag: 'rect', classes: ['a'] }), { fill: 'green', stroke: 'blue' });
  assert.equal(style({ tag: 'rect', classes: ['a'], id: 'x' }).fill, 'black');
  assert.equal(style({ tag: 'rect', classes: ['b'], parent: g }).opacity, '.5');
  assert.equal(style({ tag: 'rect', classes: ['b'] }).opacity, undefined);
});

const SAMPLE = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="100" viewBox="0 0 400 200">
  <title>Sample</title>
  <defs><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs>
  <style>.big { stroke-width: 8 } rect { stroke: #000 }</style>
  <g id="layer" transform="translate(10 20)" opacity="0.5">
    <rect class="big" x="5" y="6" width="50%" height="20" rx="3" fill="url(#g)"/>
    <circle cx="50" cy="50" r="10" fill="#f00" style="stroke:green"/>
    <line x1="0" y1="0" x2="10" y2="10" stroke="black"/>
    <polygon points="0,0 10,0 10,10"/>
    <path d="M0 0L5 5" data-note="x"/>
  </g>
  <text x="10 20 30" y="40" font-size="12">Hello <tspan fill="red" dx="2">big</tspan>
    world</text>
  <use xlink:href="#layer" x="3"/>
  <foreignObject width="10" height="10"><p xmlns="http://www.w3.org/1999/xhtml">hi</p></foreignObject>
</svg>`;

test('reading an SVG: size, view box, nodes, styles and what is kept aside', () => {
  const scene = readSvg(SAMPLE);
  assert.deepEqual([scene.width, scene.height], [200, 100]);
  assert.deepEqual(scene.viewBox, { x: 0, y: 0, width: 400, height: 200 });
  assert.equal(scene.stylesheet, true);
  assert.deepEqual(scene.defs.map((d) => d.name), ['defs', 'style']);
  assert.deepEqual(scene.children.map((c) => c.kind), ['raw', 'group', 'text', 'use', 'raw']);
  const group = scene.children[1] as Extract<(typeof scene.children)[number], { kind: 'group' }>;
  assert.equal(group.id, 'layer');
  assert.deepEqual([...group.transform!], [1, 0, 0, 1, 10, 20]);
  assert.equal(group.style.opacity, '0.5');
  assert.deepEqual(group.children.map((c) => c.kind), ['rect', 'ellipse', 'path', 'path', 'path']);
  const rect = group.children[0] as Extract<(typeof group.children)[number], { kind: 'rect' }>;
  // 50% of the view box's width; the stylesheet's stroke and the class's width apply, the attribute's fill stays.
  assert.equal(rect.width, 200);
  assert.deepEqual([rect.rx, rect.ry], [3, 3]);
  assert.deepEqual(rect.style, { fill: 'url(#g)', stroke: '#000', 'stroke-width': '8' });
  assert.equal(rect.attrs.class, 'big');
  // Inline style beats the attribute and the stylesheet.
  const circle = group.children[1] as Extract<(typeof group.children)[number], { kind: 'ellipse' }>;
  assert.deepEqual([circle.rx, circle.ry, circle.style.fill, circle.style.stroke], [10, 10, '#f00', 'green']);
  assert.deepEqual((group.children[2] as PathNode).commands, [['M', 0, 0], ['L', 10, 10]]);
  assert.deepEqual((group.children[3] as PathNode).commands, [['M', 0, 0], ['L', 10, 0], ['L', 10, 10], ['Z']]);
  assert.equal((group.children[4] as PathNode).attrs['data-note'], 'x');
});

test('text: runs, collapsed white space, and lists of positions kept as written', () => {
  const text = readSvg(SAMPLE).children[2] as TextNode;
  assert.deepEqual(text.runs.map((r) => r.text), ['Hello ', 'big', ' world']);
  assert.deepEqual([text.x, text.y], [10, 40]);
  assert.equal(text.attrs.x, '10 20 30');
  assert.equal(text.runs[1].style.fill, 'red');
  assert.equal(text.runs[1].dx, 2);
  assert.equal(text.style['font-size'], '12');
});

test('a file without a size takes the view box; without either, SVG\'s default', () => {
  assert.deepEqual([readSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 12"/>').width, readSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 12"/>').height], [24, 12]);
  const bare = readSvg('<svg xmlns="http://www.w3.org/2000/svg"/>');
  assert.deepEqual([bare.width, bare.height], [300, 150]);
  // One side given: the other follows the view box's shape.
  const half = readSvg('<svg xmlns="http://www.w3.org/2000/svg" width="48" viewBox="0 0 24 12"/>');
  assert.deepEqual([half.width, half.height], [48, 24]);
});

test('text that is not an SVG is refused', () => {
  assert.throws(() => readSvg('<html/>'), SvgError);
  assert.throws(() => readSvg('not xml'), SvgError);
});

test('writing then reading gives the same scene', () => {
  const scene = readSvg(SAMPLE);
  const written = writeSvg(scene);
  // Shapes read from lines and polygons come back as paths, so the second reading differs from the first only in that; from then on it is stable.
  const again = readSvg(written);
  assert.equal(writeSvg(again), written);
  assert.deepEqual(again.children.map((c) => c.kind), scene.children.map((c) => c.kind));
  assert.deepEqual(again.defs, scene.defs);
  // The stylesheet is still there, so styles are written inline to win over it.
  assert.match(written, /style="[^"]*stroke-width:8/);
  assert.match(written, /xlink:href="#layer"/);
});

test('an edited path is written from its commands; an untouched one keeps its text', () => {
  const scene = readSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="m1 1 h2"/><path d="M0 0L1 1"/></svg>');
  const [a, b] = scene.children as PathNode[];
  delete b.source;
  b.commands = [['M', 0, 0], ['L', 5, 5]];
  const written = writeSvg(scene);
  assert.match(written, /d="m1 1 h2"/);
  assert.match(written, /d="M0 0L5 5"/);
  void a;
});

test('without a stylesheet styles are presentation attributes', () => {
  const scene = readSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="4" height="4" style="fill:red;stroke:blue"/></svg>');
  const written = writeSvg(scene);
  assert.match(written, /<rect width="4" height="4" fill="red" stroke="blue"\/>/);
});
