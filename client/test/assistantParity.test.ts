// Every tool the server tells the model about (server/src/assistantTools.ts) is one the page can
// run: in the layout worker (src/layout/agentTools.ts, agentPdfTools.ts), the file tools (src/assistant/fileTools.ts)
// or the app's own (src/assistant/appTools.ts). Their sources are read, as loading them needs a browser.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { TOOLS } from '../../server/src/assistantTools.ts';
import { TOOL_GROUPS, expandTool } from '../src/assistant/toolGroups.ts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
/** The names a tool table defines: `name(`, `async name(` or `name:` at the start of a line. */
const defined = (text: string) => new Set([...text.matchAll(/^\s+(?:async\s+)?([a-z_]+)(?:\(|:\s)/gm)].map((m) => m[1]));

function knownTools(): Set<string> {
  const worker = source('../src/layout/agentTools.ts');
  const pdf = source('../src/layout/agentPdfTools.ts');
  const files = source('../src/assistant/fileTools.ts');
  const appSource = source('../src/assistant/appTools.ts');
  const app = appSource.slice(appSource.indexOf('const tools'), appSource.indexOf('\n  };', appSource.indexOf('const tools')));
  return new Set([...defined(worker.slice(worker.indexOf('const TOOLS'))), ...defined(pdf), ...defined(files), ...defined(app)]);
}

const actionsOf = (tool: (typeof TOOLS)[number]): string[] => ((tool.parameters.properties as any)?.action?.enum as string[] | undefined) ?? [];

test('every tool the model is offered has a page that runs it', () => {
  const known = knownTools();
  // A group runs as the single tool each of its actions stands for.
  const missing = TOOLS.flatMap((tool) => (TOOL_GROUPS[tool.name] ? Object.values(TOOL_GROUPS[tool.name]) : [tool.name])).filter((name) => !known.has(name));
  assert.deepEqual(missing, []);
});

test('the actions the server offers for a group are the ones the page expands, and no others', () => {
  const offered = new Set(TOOLS.map((tool) => tool.name));
  for (const [group, actions] of Object.entries(TOOL_GROUPS)) {
    const tool = TOOLS.find((t) => t.name === group);
    assert.ok(tool, `the server offers ${group}`);
    assert.deepEqual([...actionsOf(tool)].sort(), Object.keys(actions).sort(), group);
    assert.deepEqual((tool.parameters.required as string[]).includes('action'), true, `${group} requires action`);
    assert.ok(!Object.values(actions).some((single) => offered.has(single)), `${group} hides its single tools from the model`);
  }
});

test('every action of every group expands to a tool', () => {
  for (const tool of TOOLS.filter((t) => TOOL_GROUPS[t.name])) {
    for (const action of actionsOf(tool)) assert.ok('name' in expandTool(tool.name, JSON.stringify({ action })), `${tool.name} ${action}`);
  }
});
