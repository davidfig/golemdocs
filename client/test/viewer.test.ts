// The embeddable viewer's pure parts (src/viewer/protocol.ts, src/viewer/fonts.ts): the messages it takes from its host, the links it
// hands out, its zoom steps and page numbers, and the font set its build bundles.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { FontManifest } from '@golemdocs/layout';
import { fitWidthZoom, linkForHost, MAX_ZOOM, MIN_ZOOM, pageIndexAt, parsePageNumber, readToViewer, stepZoom, ZOOM_STEPS } from '../src/viewer/protocol.ts';
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
