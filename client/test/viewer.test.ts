// The embeddable viewer's pure parts (src/viewer/protocol.ts, src/viewer/fonts.ts): the messages it takes from its host, the links it
// hands out, its zoom steps and page numbers, and the font set its build bundles.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { FontManifest } from '@golemdocs/layout';
import { Camera, CSS_PX_PER_POINT } from '../src/view/camera.ts';
import { canScrollSideways, checkOutcome, FIT_MARGIN, fitWidthZoom, hostKey, SIDE_PADDING, SIDE_PADDING_X, linkForHost, MAX_ZOOM, MIN_ZOOM, pageIndexAt, parsePageNumber, readToViewer, stepZoom, viewerKey, ZOOM_STEPS, type KeyContext } from '../src/viewer/protocol.ts';
import { VIEWER_FONTS, viewerFontSet } from '../src/viewer/fonts.ts';

test('an open message is read with its bytes, and anything else is ignored', () => {
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  assert.deepEqual(readToViewer({ type: 'golemdocs:open', name: 'a.docx', bytes }), { type: 'golemdocs:open', name: 'a.docx', bytes });
  const full = readToViewer({ type: 'golemdocs:open', name: 'a.md', bytes, fontBase: '/f/', dark: true, locale: 'fr', extra: 1 });
  assert.deepEqual(full, { type: 'golemdocs:open', name: 'a.md', bytes, fontBase: '/f/', dark: true, locale: 'fr' });
  // A view of the bytes is copied out to a buffer of its own.
  const view = readToViewer({ type: 'golemdocs:open', name: 'b.txt', bytes: new Uint8Array([9, 8, 7, 6]).subarray(1, 3) });
  assert.deepEqual([...new Uint8Array(view!.bytes)], [8, 7]);
  for (const junk of [null, 'golemdocs:open', { type: 'golemdocs:open', name: 'x' }, { type: 'golemdocs:open', bytes }, { type: 'other', name: 'x', bytes }, { type: 'golemdocs:open', name: 'x', bytes: [1, 2] }]) {
    assert.equal(readToViewer(junk), null, JSON.stringify(junk));
  }
  // Options of the wrong kind are left out rather than passed on.
  assert.deepEqual(readToViewer({ type: 'golemdocs:open', name: 'a', bytes, dark: 'yes', fontBase: 3, locale: '' }), { type: 'golemdocs:open', name: 'a', bytes });
});

test('only web, mail, phone and FTP links go to the host', () => {
  assert.equal(linkForHost('https://example.com/x'), 'https://example.com/x');
  assert.equal(linkForHost(' http://example.com '), 'http://example.com');
  assert.equal(linkForHost('mailto:ada@example.com'), 'mailto:ada@example.com');
  assert.equal(linkForHost('TEL:+15550100'), 'TEL:+15550100');
  assert.equal(linkForHost('ftp://files.example.com/a'), 'ftp://files.example.com/a');
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>x</b>', '#bookmark', 'doc:Note', 'tag:x', 'relative/page.html', '', null, undefined]) {
    assert.equal(linkForHost(url), null, String(url));
  }
});

test('zoom steps go to the next level each way, from between levels too, and stop at the limits', () => {
  assert.equal(stepZoom(1, 1), 1.1);
  assert.equal(stepZoom(1, -1), 0.9);
  assert.equal(stepZoom(1.05, 1), 1.1);
  assert.equal(stepZoom(1.05, -1), 1);
  assert.equal(stepZoom(MAX_ZOOM, 1), MAX_ZOOM);
  assert.equal(stepZoom(MIN_ZOOM, -1), MIN_ZOOM);
  assert.ok(ZOOM_STEPS.every((z, i) => i === 0 || z > ZOOM_STEPS[i - 1]));
  assert.equal(ZOOM_STEPS[0], MIN_ZOOM);
  assert.equal(ZOOM_STEPS.at(-1), MAX_ZOOM);
});

test('a page fits the view\'s width, never above 100%', () => {
  const css = 96 / 72;
  assert.equal(fitWidthZoom(612, 2000, 16, css), 1);
  assert.equal(fitWidthZoom(612, 612 * css + 16, 16, css), 1);
  assert.ok(Math.abs(fitWidthZoom(612, 400, 16, css) - 384 / (612 * css)) < 1e-9);
  assert.equal(fitWidthZoom(612, 1, 16, css), MIN_ZOOM);
  assert.equal(fitWidthZoom(0, 400, 16, css), 1);
});

test('the page at a height is the last one starting at or above it', () => {
  const pages = [0, 810, 1620].map((y) => ({ y, height: 792 }));
  assert.equal(pageIndexAt(pages, -50), 0);
  assert.equal(pageIndexAt(pages, 0), 0);
  assert.equal(pageIndexAt(pages, 805), 0, 'in the gap below the first');
  assert.equal(pageIndexAt(pages, 810), 1);
  assert.equal(pageIndexAt(pages, 5000), 2);
  assert.equal(pageIndexAt([], 10), -1);
});

test('a typed page number is read as an index when there is such a page', () => {
  assert.equal(parsePageNumber('1', 3), 0);
  assert.equal(parsePageNumber(' 3 ', 3), 2);
  for (const text of ['0', '4', '', 'two', '1.5', '-1']) assert.equal(parsePageNumber(text, 3), null, text);
});

const manifest = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../public/fonts/manifest.json'), 'utf8')) as FontManifest;

test('the viewer\'s font set is the common Office families\' core atlases, with nothing else', () => {
  const set = viewerFontSet(manifest);
  assert.deepEqual(set.manifest.families.map((f) => f.id).sort(), [...VIEWER_FONTS].sort());
  assert.equal(set.manifest.atlas.type, manifest.atlas.type);
  // Each face's atlas and layout, and each family's license; no font programs, which only writing a PDF needs.
  for (const family of set.manifest.families) {
    assert.ok(set.files.includes(family.licenseFile));
    for (const face of family.faces) {
      assert.ok(set.files.includes(face.atlas) && set.files.includes(face.layout));
      assert.equal(face.font, undefined);
    }
  }
  assert.ok(!set.files.some((f) => f.endsWith('.ttf')));
  for (const file of set.files) assert.ok(readFileSync(path.resolve(import.meta.dirname, '../public/fonts', file)).length > 0, file);
});

test('a font set can add families, their extra pages, CJK and the math font, and always has Calibri', () => {
  const ids = (families: string[], files = false) => viewerFontSet(manifest, families, files).manifest.families.map((f) => f.id);
  assert.deepEqual(ids([]), ['calibri']);
  assert.deepEqual(ids(['georgia']).sort(), ['calibri', 'georgia']);
  assert.deepEqual(ids(['calibri', 'extras']).sort(), ['calibri', 'calibri-extra'], 'an extra page only with its family');
  assert.deepEqual(ids(['georgia-extra']), ['calibri'], 'an extra page is no use without its family');
  const cjk = ids(['cjk']);
  assert.ok(cjk.includes('noto-sans-jp-1') && cjk.includes('noto-sans-tc-5'));
  assert.ok(ids(['libertinus-math']).includes('libertinus-math'));
  assert.equal(ids(['all']).length, manifest.families.length);
  const withFiles = viewerFontSet(manifest, ['arial'], true);
  assert.ok(withFiles.files.includes('arial/regular.ttf'));
  assert.ok(withFiles.manifest.families.every((f) => f.faces.every((face) => face.font === undefined || withFiles.files.includes(face.font))));
});

test('a check for a newer save shows it, keeps what is shown while unchanged or unreachable, and ends when access does', () => {
  assert.equal(checkOutcome(200), 'newer');
  assert.equal(checkOutcome(304), 'unchanged');
  assert.equal(checkOutcome(404), 'ended', 'unshared, left, made an editor');
  assert.equal(checkOutcome(403), 'ended', 'the owner’s plan ended');
  assert.equal(checkOutcome(401), 'signedOut');
  for (const status of [null, 500, 502, 503, 429, 408]) assert.equal(checkOutcome(status), 'retry', String(status));
});

// --- Keys -------------------------------------------------------------------------------------------

const VIEW: KeyContext = { mac: true, inField: false, onButton: false, findOpen: false, canScrollSideways: false };
type Press = { key: string; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; isComposing?: boolean };
const press = (p: Press, context: Partial<KeyContext> = {}) => viewerKey({ shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...p }, { ...VIEW, ...context });

test('the viewer keeps its own keys: zoom, find, select all, and moving through the document', () => {
  assert.equal(press({ key: '=', metaKey: true }), 'zoomIn');
  assert.equal(press({ key: '+', metaKey: true, shiftKey: true }), 'zoomIn');
  assert.equal(press({ key: '-', metaKey: true }), 'zoomOut');
  assert.equal(press({ key: '0', metaKey: true }), 'zoomReset');
  assert.equal(press({ key: 'f', metaKey: true }), 'find');
  assert.equal(press({ key: 'F', metaKey: true, shiftKey: true }), 'find');
  assert.equal(press({ key: 'a', metaKey: true }), 'selectAll');
  assert.equal(press({ key: 'F3' }), 'findNext');
  assert.equal(press({ key: 'g', metaKey: true, shiftKey: true }), 'findPrevious');
  assert.equal(press({ key: 'ArrowDown' }), 'lineDown');
  assert.equal(press({ key: 'ArrowUp', shiftKey: true }), 'lineUp');
  assert.equal(press({ key: ' ' }), 'pageDown');
  assert.equal(press({ key: ' ', shiftKey: true }), 'pageUp');
  assert.equal(press({ key: 'PageUp' }), 'pageUp');
  assert.equal(press({ key: 'Home' }), 'first');
  assert.equal(press({ key: 'End' }), 'last');
  // Ctrl is the command key on Windows and Linux; on a Mac, Ctrl+F is not find.
  assert.equal(press({ key: 'f', ctrlKey: true }, { mac: false }), 'find');
  assert.equal(press({ key: 'f', ctrlKey: true }), 'host');
  assert.equal(press({ key: 'f', metaKey: true }, { mac: false }), 'host');
});

test('Escape closes find when it is open, and is the host\'s otherwise; ← → scroll only pages wider than the view', () => {
  assert.equal(press({ key: 'Escape' }, { findOpen: true }), 'closeFind');
  assert.equal(press({ key: 'Escape' }, { findOpen: true, inField: true }), 'closeFind');
  assert.equal(press({ key: 'Escape' }), 'host');
  assert.equal(press({ key: 'ArrowLeft' }), 'host');
  assert.equal(press({ key: 'ArrowRight' }), 'host');
  assert.equal(press({ key: 'ArrowLeft' }, { canScrollSideways: true }), 'lineLeft');
  assert.equal(press({ key: 'ArrowRight' }, { canScrollSideways: true }), 'lineRight');
  assert.equal(press({ key: 'ArrowDown', altKey: true }), 'host', 'with a modifier the viewer does not use');
});

test('letters and keys the viewer has no use for are the host\'s; the browser keeps copying, Tab, fields, buttons and composing', () => {
  for (const key of ['f', 'j', 'k', 'N', 'Enter', 'Backspace', 'Delete', 'F5', '?']) assert.equal(press({ key }), 'host', key);
  assert.equal(press({ key: 'r', metaKey: true, shiftKey: true }), 'host');
  for (const key of ['c', 'x', 'v']) assert.equal(press({ key, metaKey: true }), 'browser', key);
  assert.equal(press({ key: 'Tab' }), 'browser');
  assert.equal(press({ key: 'Tab', shiftKey: true }), 'browser');
  for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']) assert.equal(press({ key }), 'browser', key);
  assert.equal(press({ key: 'a', isComposing: true }), 'browser');
  assert.equal(press({ key: 'Process' }), 'browser');
  // Typing in the find or page field is the field's, not the host's (but the zoom and find keys still work there).
  for (const key of ['f', 'Escape', 'ArrowLeft', 'Enter', 'Home']) assert.equal(press({ key }, { inField: true }), 'browser', key);
  assert.equal(press({ key: '=', metaKey: true }, { inField: true }), 'zoomIn');
  // Enter and Space press a button that has the focus.
  assert.equal(press({ key: 'Enter' }, { onButton: true }), 'browser');
  assert.equal(press({ key: ' ' }, { onButton: true }), 'browser');
});

test('in Screen Reader Mode the caret keys move a caret, with any modifier; Page Down, Space and the rest still scroll', () => {
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) assert.equal(press({ key }, { caret: true }), 'caret', key);
  assert.equal(press({ key: 'ArrowRight', shiftKey: true }, { caret: true }), 'caret', 'Shift selects');
  assert.equal(press({ key: 'ArrowLeft', altKey: true }, { caret: true }), 'caret', 'a word at a time (Option on a Mac)');
  assert.equal(press({ key: 'End', metaKey: true }, { caret: true }), 'caret', 'to the end of the document');
  assert.equal(press({ key: 'PageDown' }, { caret: true }), 'pageDown');
  assert.equal(press({ key: ' ' }, { caret: true }), 'pageDown');
  assert.equal(press({ key: 'a', metaKey: true }, { caret: true }), 'selectAll');
  // A field keeps its own arrows.
  assert.equal(press({ key: 'ArrowLeft' }, { caret: true, inField: true }), 'browser');
});

test('a host can ask for Screen Reader Mode and High Contrast; anything but a boolean is ignored', () => {
  const bytes = new ArrayBuffer(2);
  assert.deepEqual(readToViewer({ type: 'golemdocs:open', name: 'a.docx', bytes, screenReader: true, contrast: false }), { type: 'golemdocs:open', name: 'a.docx', bytes, screenReader: true, contrast: false });
  assert.deepEqual(readToViewer({ type: 'golemdocs:open', name: 'a.docx', bytes, screenReader: 'yes', contrast: 1 }), { type: 'golemdocs:open', name: 'a.docx', bytes });
});

test('a page zoomed to fit the width has no room to scroll sideways, so ← → go to the host; one zoomed past the width keeps them', () => {
  const letter = { x: 0, y: 0, width: 612, height: 792 };
  // Satchel's reading pane and wider views, at DPR 1 and 2 (CSS px are the same either way: the camera's room is in CSS px).
  for (const viewWidth of [480, 600, 640, 700, 733, 800, 1280]) {
    for (const dpr of [1, 2]) {
      const camera = new Camera();
      camera.dpr = dpr;
      camera.width = viewWidth * dpr;
      camera.zoom = fitWidthZoom(letter.width, viewWidth, FIT_MARGIN, CSS_PX_PER_POINT);
      camera.clamp(letter, viewWidth, 600, SIDE_PADDING, SIDE_PADDING_X);
      const scrolls = canScrollSideways(camera, letter, viewWidth);
      assert.equal(scrolls, false, `${viewWidth} px at DPR ${dpr}`);
      assert.equal(viewerKey({ key: 'ArrowLeft', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }, { ...VIEW, canScrollSideways: scrolls }), 'host');
      // Zoomed in until the page overflows the view: ← → scroll it.
      camera.zoom = (viewWidth + 100) / (letter.width * CSS_PX_PER_POINT);
      assert.equal(canScrollSideways(camera, letter, viewWidth), true, `${viewWidth} px at DPR ${dpr}, zoomed in`);
    }
  }
  // A page a pixel or two wider than the fit (rounding) still counts as fitting.
  const camera = new Camera();
  camera.zoom = (700 - FIT_MARGIN + 1.5) / (letter.width * CSS_PX_PER_POINT);
  assert.equal(canScrollSideways(camera, letter, 700), false);
});

test('a key passed to the host keeps only what describes it', () => {
  const event = { key: 'f', code: 'KeyF', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false, target: {}, timeStamp: 3 };
  assert.deepEqual(hostKey(event), { key: 'f', code: 'KeyF', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false });
});
