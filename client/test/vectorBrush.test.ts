// Strokes: variable width, calligraphic, rough, pattern, scatter and arrowheads (src/vector/brush.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BRUSH_ATTR, CENTERLINE_ATTR, applyBrush, brushOf, brushOutline, editableCommands, profileAt, random, regenerate, setEditableCommands, strokeWidthOf } from '../src/vector/brush.ts';
import { BRUSH_PRESETS, presetById } from '../src/vector/brushPresets.ts';
import { flatten, insideFill } from '../src/vector/hit.ts';
import type { PathNode } from '../src/vector/model.ts';
import { parsePath, pathBounds, serializePath } from '../src/vector/pathData.ts';
import { readSvg } from '../src/vector/svgRead.ts';
import { writeSvg } from '../src/vector/svgWrite.ts';

const line = parsePath('M0 0 L100 0');

/** How tall the stroke is where it is crossed at x: the filled run along the vertical line there. */
function heightAt(commands: ReturnType<typeof brushOutline>, x: number): number {
  const lines = flatten(commands);
  let top = Infinity;
  let bottom = -Infinity;
  for (let y = -30; y <= 30; y += 0.25) {
    if (insideFill({ x, y }, lines, false)) {
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  return bottom < top ? 0 : bottom - top;
}

test('a plain brush is a line of one width with round ends', () => {
  const out = brushOutline(line, { kind: 'plain', width: 10 });
  const b = pathBounds(out)!;
  assert.ok(Math.abs(b.height - 10) < 0.2, `${b.height}`);
  // The round ends reach half a width past the line's ends.
  assert.ok(Math.abs(b.x + 5) < 0.3 && Math.abs(b.x + b.width - 105) < 0.3, `${b.x}, ${b.width}`);
  assert.ok(Math.abs(heightAt(out, 50) - 10) < 0.5);
  const flat = pathBounds(brushOutline(line, { kind: 'plain', width: 10, cap: 'butt' }))!;
  assert.ok(Math.abs(flat.x) < 0.3 && Math.abs(flat.width - 100) < 0.3);
});

test('a width profile makes the stroke follow it: tapered ends, widest in the middle', () => {
  const out = brushOutline(line, BRUSH_PRESETS.find((p) => p.id === 'taperBoth')!.make(10));
  assert.ok(heightAt(out, 50) > 9, `${heightAt(out, 50)}`);
  assert.ok(heightAt(out, 4) < 4, `${heightAt(out, 4)}`);
  assert.ok(heightAt(out, 96) < 4);
  assert.equal(Math.round(profileAt([[0, 0], [1, 1]], 0.5) * 100), 50);
  assert.equal(profileAt([[0, 0.2], [1, 1]], -1), 0.2);
  assert.equal(profileAt([], 0.3), 1);
});

test('a calligraphic nib is wide across the angle it is held at and thin along it', () => {
  const nib = { kind: 'calligraphic' as const, width: 10, angle: 0, roundness: 0 };
  // Held flat (0 degrees): travelling along it, the stroke is thin; travelling across, it is the full width.
  assert.ok(heightAt(brushOutline(line, nib), 50) < 1);
  const down = parsePath('M50 -40 L50 40');
  const across = pathBounds(brushOutline(down, nib))!;
  assert.ok(Math.abs(across.width - 10) < 0.5, `${across.width}`);
});

test('a rough stroke is ragged but the same every time for one seed', () => {
  const brush = { kind: 'rough' as const, width: 10, profile: [[0, 1], [1, 1]] as [number, number][], roughness: 0.8, seed: 4 };
  const a = serializePath(brushOutline(line, brush));
  assert.equal(serializePath(brushOutline(line, brush)), a);
  assert.notEqual(serializePath(brushOutline(line, { ...brush, seed: 5 })), a);
  const smooth = pathBounds(brushOutline(line, { ...brush, roughness: 0 }))!;
  assert.ok(smooth.height < 10.5);
});

test('a pattern puts copies of its shape along the path, each as long as the gaps allow', () => {
  const dots = presetById('dots')!.make(6);
  const out = brushOutline(line, dots);
  const subpaths = out.filter((c) => c[0] === 'M').length;
  // About 100 / (12 * 1.6) copies.
  assert.ok(subpaths >= 4 && subpaths <= 7, `${subpaths}`);
  const b = pathBounds(out)!;
  assert.ok(b.height <= 6.2 && b.x >= -0.1 && b.x + b.width <= 100.1);
});

test('a scatter strews copies along and around the path', () => {
  const stars = presetById('stars')!.make(8);
  const out = brushOutline(line, stars);
  assert.ok(out.filter((c) => c[0] === 'M').length >= 8);
  assert.equal(serializePath(brushOutline(line, stars)), serializePath(out));
  const b = pathBounds(out)!;
  assert.ok(b.height > 8, 'they stray from the line');
});

test('arrowheads end the line: it stops short, and the head reaches the end', () => {
  const out = brushOutline(line, { kind: 'plain', width: 4, cap: 'butt', endArrow: 'triangle' });
  const b = pathBounds(out)!;
  assert.ok(Math.abs(b.x + b.width - 100) < 0.3, `reaches the end: ${b.x + b.width}`);
  // The head is wider than the line: 3 widths long and about 2.7 across.
  assert.ok(b.height > 8, `${b.height}`);
  assert.ok(heightAt(out, 90) > 6 && heightAt(out, 50) < 4.5);
  const both = pathBounds(brushOutline(line, { kind: 'plain', width: 4, startArrow: 'diamond', endArrow: 'circle' }))!;
  assert.ok(both.x <= 0.01 && both.x + both.width >= 99.9);
  // A closed path has no ends to put heads on.
  const ring = brushOutline(parsePath('M0 0 L50 0 L50 50 L0 50 Z'), { kind: 'plain', width: 4, endArrow: 'triangle' });
  assert.ok(ring.filter((c) => c[0] === 'M').length === 2, 'outer and inner edge');
});

test('a closed path is a ring', () => {
  const ring = brushOutline(parsePath('M0 0 L60 0 L60 60 L0 60 Z'), { kind: 'plain', width: 6 });
  const lines = flatten(ring);
  assert.ok(insideFill({ x: 30, y: 1 }, lines, false), 'on the edge');
  assert.ok(!insideFill({ x: 30, y: 30 }, lines, false), 'the middle is empty');
});

test('every preset draws something', () => {
  const path = parsePath('M0 0 C30 40 70 -40 100 0');
  for (const preset of BRUSH_PRESETS) {
    const out = brushOutline(path, preset.make(6));
    assert.ok(out.length > 3 && pathBounds(out), preset.id);
    assert.equal(preset.make(6).preset, preset.id);
  }
});

test('the same seed gives the same numbers', () => {
  const a = random(9);
  const b = random(9);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

function pathNode(svg: string): PathNode {
  return readSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${svg}</svg>`).children[0] as PathNode;
}

test('a brush turns a stroked path into its filled outline and keeps the line it came from', () => {
  const node = pathNode('<path d="M10 50 L90 50" stroke="#c00" stroke-width="8" fill="none" stroke-dasharray="3 3"/>');
  applyBrush(node, presetById('taperBoth')!.make(8));
  assert.equal(node.style.fill, '#c00');
  assert.equal(node.style.stroke, 'none');
  assert.equal(node.style['stroke-dasharray'], undefined);
  assert.equal(node.attrs[CENTERLINE_ATTR], 'M10 50L90 50');
  assert.equal(brushOf(node)?.preset, 'taperBoth');
  assert.equal(strokeWidthOf(node), 8);
  assert.ok(node.commands.length > 5);
  // It is saved like any other SVG: the outline is the path, the rest are attributes.
  const text = writeSvg({ ...readSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"/>'), children: [node] });
  assert.match(text, new RegExp(`${BRUSH_ATTR}=`));
  const again = readSvg(text).children[0] as PathNode;
  assert.deepEqual(brushOf(again), brushOf(node));
  assert.equal(again.style.fill, '#c00');
});

test('reshaping a brush path draws the brush along the new line; taking the brush away gives the line back', () => {
  const node = pathNode('<path d="M10 50 L90 50" stroke="blue" stroke-width="6" fill="none"/>');
  applyBrush(node, presetById('swell')!.make(6));
  assert.deepEqual(editableCommands(node), parsePath('M10 50L90 50'));
  setEditableCommands(node, parsePath('M10 20 L90 80'));
  assert.equal(node.attrs[CENTERLINE_ATTR], 'M10 20L90 80');
  const b = pathBounds(node.commands)!;
  assert.ok(b.y < 21 && b.y + b.height > 79);
  // A new width is a change of the brush, then drawn again.
  node.attrs[BRUSH_ATTR] = JSON.stringify({ ...brushOf(node)!, width: 20 });
  regenerate(node);
  assert.ok(pathBounds(node.commands)!.width > b.width);
  applyBrush(node, null);
  assert.deepEqual(node.commands, parsePath('M10 20 L90 80'));
  assert.equal(node.style.stroke, 'blue');
  assert.equal(node.style.fill, 'none');
  assert.equal(node.style['stroke-width'], '20');
  assert.equal(node.attrs[BRUSH_ATTR], undefined);
  // Nothing to take away from an ordinary path.
  applyBrush(node, null);
  assert.equal(node.style.stroke, 'blue');
});

test('a bristle stroke is made of streaks, tapers at its ends and is the same every time for one seed', () => {
  for (const id of ['dryInk', 'frayedInk', 'charcoal']) {
    const brush = presetById(id)!.make(14);
    const long = parsePath('M0 0 L200 0');
    const a = brushOutline(long, brush);
    assert.deepEqual(a, brushOutline(long, brush));
    assert.notDeepEqual(a, brushOutline(long, { ...brush, seed: 99 }));
    // Many separate pieces (streaks and flecks), all inside a band about the brush's width.
    assert.ok(a.filter((c) => c[0] === 'M').length >= 5, id);
    const b = pathBounds(a)!;
    assert.ok(b.height > 5 && b.height < 14 * 1.6, `${id} ${b.height}`);
  }
  const ink = brushOutline(parsePath('M0 0 L200 0'), presetById('dryInk')!.make(14));
  assert.ok(heightAt(ink, 60) > heightAt(ink, 4) + 3);
  assert.ok(heightAt(ink, 60) > heightAt(ink, 196) + 3);
});
