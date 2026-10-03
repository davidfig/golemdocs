// Every tool the server tells the model about (server/src/assistantTools.ts) is one the page can
// run: in the layout worker (src/layout/agentTools.ts, agentPdfTools.ts), the file tools (src/assistant/fileTools.ts)
// or the app's own (src/assistant/appTools.ts). Their sources are read, as loading them needs a browser.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { TOOLS } from '../../server/src/assistantTools.ts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
/** The names a tool table defines: `name(`, `async name(` or `name:` at the start of a line. */
const defined = (text: string) => new Set([...text.matchAll(/^\s+(?:async\s+)?([a-z_]+)(?:\(|:\s)/gm)].map((m) => m[1]));

test('every tool the model is offered has a page that runs it', () => {
  const worker = source('../src/layout/agentTools.ts');
  const pdf = source('../src/layout/agentPdfTools.ts');
  const files = source('../src/assistant/fileTools.ts');
  const appSource = source('../src/assistant/appTools.ts');
  const app = appSource.slice(appSource.indexOf('const tools'), appSource.indexOf('\n  };', appSource.indexOf('const tools')));
  const known = new Set([...defined(worker.slice(worker.indexOf('const TOOLS'))), ...defined(pdf), ...defined(files), ...defined(app)]);
  const missing = TOOLS.map((tool) => tool.name).filter((name) => !known.has(name));
  assert.deepEqual(missing, []);
});
