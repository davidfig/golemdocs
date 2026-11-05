// The desktop shell's window settings that the page depends on, which no browser test can reach.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test("the desktop shell leaves drags to the page: Tauri's own drag handler keeps every drag from reaching WKWebView, so nothing could be dragged or dropped", () => {
  const config = JSON.parse(readFileSync(new URL('../../desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  assert.ok(config.app.windows.length > 0);
  for (const window of config.app.windows) assert.equal(window.dragDropEnabled, false);
});
