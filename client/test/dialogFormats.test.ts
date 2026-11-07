// What the Font, Borders and Shading, Tabs and Styles dialogs read and store (layout/dialogFormats.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StyleResolver, type Style, type StyleSheet } from '@golemdocs/docx';
import { bordersFormat, bordersOf, editedStyle, fontFormat, fontOf, listFormatOf, paragraphChoiceOf, styleIdFor, stylesOf, tabsFormat, tabsOf, withListFormat } from '../src/layout/dialogFormats.ts';
import type { BorderSide } from '../src/ui/actions.ts';

test('turning bold on stores it; turning it off stores nothing unless the style would still show it', () => {
  assert.deepEqual(fontFormat({ bold: true }, {}), { bold: true, boldCs: true });
  assert.deepEqual(fontFormat({ bold: false }, {}), { bold: null, boldCs: null });
  assert.deepEqual(fontFormat({ bold: false }, { bold: true }), { bold: false, boldCs: false });
  assert.deepEqual(fontFormat({ bold: true }, { bold: true }), { bold: null, boldCs: null });
});

test('what is left out of a choice is left alone', () => {
  assert.deepEqual(fontFormat({}, { bold: true, color: { val: 'FF0000' } }), {});
});

test('a size in points is stored in half points, within what Word allows', () => {
  assert.deepEqual(fontFormat({ size: 10.5 }, {}), { size: 21, sizeCs: 21 });
  assert.equal(fontFormat({ size: 99999 }, {}).size, 3276);
});

test('automatic color drops the direct color, or says so over a style that has one', () => {
  assert.equal(fontFormat({ color: null }, {}).color, null);
  assert.deepEqual(fontFormat({ color: null }, { color: { val: '112233' } }).color, { val: 'auto' });
  assert.deepEqual(fontFormat({ color: '#aabbcc' }, {}).color, { val: 'AABBCC' });
});

test('an underline keeps its color when only its style changes, and goes with None', () => {
  const current = { underline: { val: 'single', color: '00FF00' } };
  assert.deepEqual(fontFormat({ underline: 'double' }, {}, current).underline, { val: 'double', color: '00FF00' });
  assert.equal(fontFormat({ underline: 'none' }, {}, current).underline, null);
  assert.deepEqual(fontFormat({ underline: 'none' }, { underline: { val: 'single' } }).underline, { val: 'none' });
});

test('superscript and subscript come off to nothing, or to baseline over a style that has one', () => {
  assert.equal(fontFormat({ superscript: true, subscript: false }, {}).vertAlign, 'superscript');
  assert.equal(fontFormat({ superscript: false, subscript: false }, {}).vertAlign, null);
  assert.equal(fontFormat({ superscript: false, subscript: false }, { vertAlign: 'superscript' }).vertAlign, 'baseline');
});

test('character spacing and position equal to the style store nothing', () => {
  assert.equal(fontFormat({ spacing: 0, position: 0 }, {}).spacing, null);
  assert.equal(fontFormat({ spacing: 40, position: -6 }, {}).position, -6);
  assert.equal(fontFormat({ spacing: 40 }, { spacing: 40 }).spacing, null);
});

test('fontOf reads what the dialog shows', () => {
  const font = fontOf({ bold: true, size: 28, color: { val: 'ff0000' }, underline: { val: 'double' }, vertAlign: 'subscript', vanish: true, spacing: 20 }, 'Arial');
  assert.deepEqual([font.family, font.bold, font.italic, font.size, font.color, font.underline, font.subscript, font.hidden, font.spacing], ['Arial', true, false, 14, '#FF0000', 'double', true, true, 20]);
  assert.equal(fontOf({}, undefined).color, null);
  assert.equal(fontOf({ color: { val: 'auto' } }, undefined).color, null);
});

const line: BorderSide = { style: 'double', width: 12, color: '#ff0000', space: 1 };

test('a border is stored as Word writes it, and a side turned off goes, or says nil over a style', () => {
  const on = bordersFormat({}, {}, { top: line });
  assert.deepEqual(on.borders, { top: { val: 'double', sz: 12, space: 1, color: 'FF0000' } });
  assert.equal(bordersFormat({ borders: { top: { val: 'single' } } }, {}, { top: null }).borders, undefined);
  assert.deepEqual(bordersFormat({}, { borders: { top: { val: 'single' } } }, { top: null }).borders, { top: { val: 'nil' } });
});

test('sides left out of a choice stay, automatic color reads as null, and nil reads as no border', () => {
  const change = bordersFormat({ borders: { left: { val: 'single' } } }, {}, { top: line });
  assert.ok(change.borders?.left && change.borders.top);
  assert.equal(bordersFormat({}, {}, { top: { ...line, color: null } }).borders?.top?.color, 'auto');
  const read = bordersOf({ borders: { top: { val: 'single', sz: 8, color: 'auto' }, bottom: { val: 'nil' } } });
  assert.equal(read.top?.color, null);
  assert.equal(read.bottom, null);
});

test('shading goes on as a fill, comes off, and says so over a style', () => {
  assert.deepEqual(bordersFormat({}, {}, { shading: '#ffff99' }).shading, { val: 'clear', color: 'auto', fill: 'FFFF99' });
  assert.equal(bordersFormat({}, {}, { shading: null }).shading, undefined);
  assert.equal(bordersFormat({}, { shading: { fill: '112233' } }, { shading: null }).shading?.fill, 'auto');
  assert.equal(bordersOf({ shading: { fill: 'auto' } }).shading, null);
});

test('tab stops: sorted, with what can’t be set hidden', () => {
  const tabs = tabsOf({ tabs: [{ val: 'right', pos: 2880, leader: 'dot' }, { val: 'clear', pos: 100 }, { val: 'bar', pos: 200 }, { val: 'left', pos: 720 }] });
  assert.deepEqual(tabs, [{ pos: 720, align: 'left', leader: 'none' }, { pos: 2880, align: 'right', leader: 'dot' }]);
});

test('tab stops the style gives aren’t repeated, and one taken away says so', () => {
  const base = { tabs: [{ val: 'left' as const, pos: 720 }] };
  assert.equal(tabsFormat(base, [{ pos: 720, align: 'left', leader: 'none' }]), undefined);
  assert.deepEqual(tabsFormat(base, []), [{ val: 'clear', pos: 720 }]);
  assert.deepEqual(tabsFormat({}, [{ pos: 1440, align: 'center', leader: 'hyphen' }]), [{ val: 'center', pos: 1440, leader: 'hyphen' }]);
  // Moving its alignment replaces it rather than clearing it.
  assert.deepEqual(tabsFormat(base, [{ pos: 720, align: 'right', leader: 'none' }]), [{ val: 'right', pos: 720 }]);
});

test('a list level reads and takes a format, keeping what the format doesn’t say', () => {
  const level = { level: 1, start: 1, format: 'decimal', text: '%2.', attrs: {}, paragraphProperties: { indent: { left: 1440, hanging: 360 } } };
  assert.deepEqual(listFormatOf(level), { level: 1, start: 1, left: 1440, hanging: 360, kind: 'number', format: 'decimal', pattern: '%2.' });
  assert.equal(listFormatOf(undefined), null);
  assert.equal(listFormatOf({ ...level, format: 'none' }), null);
  const bullet = withListFormat(level, { kind: 'bullet', glyph: '■' });
  assert.deepEqual([bullet.format, bullet.text, bullet.start, bullet.paragraphProperties?.indent?.left], ['bullet', '■', 1, 1440]);
  const number = withListFormat(level, { kind: 'number', format: 'lowerRoman', pattern: '%2)', start: 4, left: 2000 });
  assert.deepEqual([number.format, number.text, number.start, number.paragraphProperties?.indent?.left, number.paragraphProperties?.indent?.hanging], ['lowerRoman', '%2)', 4, 2000, 360]);
});

test('Paragraph values read from what applies', () => {
  const choice = paragraphChoiceOf({ justification: 'both', indent: { left: 720, hanging: 360 }, spacing: { before: 120 }, widowControl: false });
  assert.deepEqual([choice.align, choice.left, choice.special, choice.by, choice.before, choice.line, choice.widowControl], ['justify', 720, 'hanging', 360, 120, 240, false]);
});

const sheet = (styles: Style[]): StyleSheet => ({ styles, rootAttrs: {} });
const normal: Style = { type: 'paragraph', id: 'Normal', name: 'Normal', isDefault: true, attrs: {} };
const resolverOf = (styles: Style[]) => new StyleResolver(sheet(styles), undefined, undefined);

test('a new style’s id comes from its name and doesn’t collide', () => {
  assert.equal(styleIdFor('Fine Print', new Set()), 'FinePrint');
  assert.equal(styleIdFor('Fine Print', new Set(['FinePrint', 'FinePrint1'])), 'FinePrint2');
  assert.equal(styleIdFor('!!!', new Set()), 'Style');
});

test('a new style stores only what was changed from what it is based on', () => {
  const heading: Style = { type: 'paragraph', id: 'Heading1', name: 'heading 1', basedOn: 'Normal', runProperties: { bold: true, size: 32 }, attrs: {} };
  const resolver = resolverOf([normal, heading]);
  const style = editedStyle(undefined, { name: 'Small', type: 'paragraph', basedOn: 'Heading1', font: { size: 8, bold: false }, paragraph: { align: 'center' } }, 'Small', resolver);
  assert.equal(style.customStyle, true);
  assert.equal(style.basedOn, 'Heading1');
  assert.deepEqual(style.runProperties, { size: 16, sizeCs: 16, bold: false, boldCs: false });
  assert.deepEqual(style.paragraphProperties, { justification: 'center' });
});

test('changing a style keeps what the edit didn’t mention, and basedOn null removes it', () => {
  const custom: Style = { type: 'paragraph', id: 'Mine', name: 'Mine', basedOn: 'Normal', customStyle: true, runProperties: { italic: true }, paragraphProperties: { keepNext: true }, attrs: {} };
  const style = editedStyle(custom, { id: 'Mine', name: 'Renamed', type: 'paragraph', basedOn: null, font: { size: 20 } }, 'Mine', resolverOf([normal, custom]));
  assert.equal(style.name, 'Renamed');
  assert.equal(style.basedOn, undefined);
  assert.equal(style.runProperties?.italic, true);
  assert.equal(style.runProperties?.size, 40);
  assert.equal(style.paragraphProperties?.keepNext, true);
  assert.equal(custom.name, 'Mine', 'the original is untouched');
});

test('a character style has no paragraph properties even if it is sent some', () => {
  const style = editedStyle(undefined, { name: 'Loud', type: 'character', font: { bold: true }, paragraph: { align: 'center' } }, 'Loud', resolverOf([normal]));
  assert.equal(style.type, 'character');
  assert.equal(style.paragraphProperties, undefined);
});

test('the list of styles leaves out hidden ones and adds the built-in ones not yet in the document', () => {
  const hidden: Style = { type: 'paragraph', id: 'Secret', name: 'Secret', attrs: {}, extra: [{ xml: { name: 'w:semiHidden', attrs: {}, children: [] }, after: null }] };
  const table: Style = { type: 'table', id: 'Grid', name: 'Grid', attrs: {} };
  const title: Style = { type: 'paragraph', id: 'Title', name: 'Title', basedOn: 'Normal', runProperties: { size: 56 }, attrs: {} };
  const styles = [normal, hidden, table];
  const list = stylesOf(sheet(styles), resolverOf(styles), [title, normal]);
  assert.deepEqual(list.map((s) => [s.id, s.defined]), [['Normal', true], ['Title', false]]);
  assert.equal(list[1].font.size, 28);
});
