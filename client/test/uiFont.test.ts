import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// The UI font is declared by @font-face in ui.css and served from public/ui-fonts/ (see docs/architecture/ui.md).
const css = readFileSync(new URL('../src/ui/ui.css', import.meta.url), 'utf8');
const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map(([, body]) => body!);

test('every UI font face points at a woff2 file that is in public/', () => {
  assert.ok(faces.length > 0);
  for (const face of faces) {
    const url = /src:\s*url\('([^']+)'\)/.exec(face)?.[1];
    assert.ok(url?.startsWith('/ui-fonts/'), `unexpected source in ${face}`);
    const file = new URL(`../public${url}`, import.meta.url);
    assert.ok(existsSync(file), `${url} is missing`);
    assert.equal(readFileSync(file).subarray(0, 4).toString('latin1'), 'wOF2', `${url} is not woff2`);
  }
  assert.ok(existsSync(new URL('../public/ui-fonts/LICENSE.txt', import.meta.url)));
});

test('--wm-font puts the bundled face first and falls back to the system font', () => {
  const family = /font-family:\s*'([^']+)'/.exec(faces[0]!)?.[1];
  const stack = /--wm-font:\s*([^;]+);/.exec(css)?.[1];
  assert.ok(stack?.startsWith(`'${family}',`));
  assert.match(stack!, /system-ui/);
});
