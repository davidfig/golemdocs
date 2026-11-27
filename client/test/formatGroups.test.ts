// The groups the formats are listed under, in the format chip and File › Convert To (ui/formats.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONVERT_ORDER, FORMAT_GROUPS, PICTURE_CONVERT_ORDER, VECTOR_CONVERT_ORDER, convertTargets, formatGroup } from '../src/ui/formats.ts';

test('every format that can be converted to is in a group, so none falls under Popular by default', () => {
  const grouped = new Set(FORMAT_GROUPS.flatMap((g) => g.kinds));
  for (const kind of [...CONVERT_ORDER, ...PICTURE_CONVERT_ORDER, ...VECTOR_CONVERT_ORDER]) assert.ok(grouped.has(kind), `${kind} is in no group`);
});

test('each group heading appears once in the list of formats', () => {
  for (const from of ['docx', 'md', 'pdf', 'png', 'svg', 'eml', 'ipynb'] as const) {
    const headings = convertTargets(from).map(formatGroup).filter((g, i, all) => i === 0 || g !== all[i - 1]);
    assert.equal(new Set(headings).size, headings.length, `${from}: ${headings.join(', ')}`);
  }
});

test('an email message and a notebook are listed with the documents', () => {
  assert.equal(formatGroup('eml'), 'documents');
  assert.equal(formatGroup('ipynb'), 'documents');
});
