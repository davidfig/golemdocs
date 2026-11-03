// The public link's embed code (ui/shareDialog.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { embedCode } from '../src/ui/shareDialog.ts';

test('the embed code is a frame of the address, with the address and the title escaped for an attribute', () => {
  const code = embedCode('https://golemdocs.com/view/?p=abc_-1&embed', 'Q&A "notes" on Golem Docs');
  assert.equal(code, '<iframe src="https://golemdocs.com/view/?p=abc_-1&amp;embed" title="Q&amp;A &quot;notes&quot; on Golem Docs" width="800" height="600" style="border:0" allowfullscreen></iframe>');
});
