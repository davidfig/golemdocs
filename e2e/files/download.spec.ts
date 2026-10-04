// File ▸ Download and Download All: names, what each format keeps and drops, and saving rules.

import { MOD, expect, test } from './fixtures';
import { blankWith, buildDocx, convertTo, importFile, readZip, status, text, waitForOpen, waitForSaved } from './helpers';

test('Download gives a new document the .docx name and says so', async ({ app }) => {
  await blankWith(app, 'Hello');
  const file = await app.download(() => app.menu('File', 'Download'));
  expect(file.name).toBe('Document1.docx');
  expect(file.bytes.subarray(0, 2).toString()).toBe('PK');
  await expect.poll(() => status(app.page)).toBe('Downloaded “Document1.docx”');
  expect(readZip(file.bytes).find((f) => f.name === 'word/document.xml')?.bytes.toString()).toContain('Hello');
});

test('a downloaded Word document keeps what was typed after the import', async ({ app }) => {
  await app.goto('?doc=welcome');
  await importFile(app, { name: 'memo.docx', buffer: buildDocx(['One', 'Two']) });
  await app.press(`${MOD}+End`);
  await app.type(' and more');
  const file = await app.download(() => app.menu('File', 'Download'));
  expect(file.name).toBe('memo.docx');
  const xml = readZip(file.bytes).find((f) => f.name === 'word/document.xml')!.bytes.toString();
  expect(xml).toContain('Two and more');
});

test('Markdown keeps its front matter and the edits made to the body', async ({ app }) => {
  await app.goto('?doc=welcome');
  await importFile(app, text('post.md', '---\ntitle: My Post\ntags: [a, b]\n---\n# Heading\n\nBody text\n'));
  await app.press(`${MOD}+End`);
  await app.type(' plus edit');
  const file = await app.download(() => app.menu('File', 'Download'));
  expect(file.name).toBe('post.md');
  expect(file.text.startsWith('---\ntitle: My Post\ntags: [a, b]\n---\n')).toBe(true);
  expect(file.text).toContain('# Heading');
  expect(file.text).toContain('Body text plus edit');
});

test('Markdown keeps its front matter through a trip via Word and back', async ({ app }) => {
  await app.goto('?doc=welcome');
  await importFile(app, text('trip.md', '---\nlayout: post\n---\nBody\n'));
  await convertTo(app, 'Word Document (.docx)', 'Word Document');
  await convertTo(app, 'Markdown (.md)', 'Markdown');
  const file = await app.download(() => app.menu('File', 'Download'));
  expect(file.name).toBe('trip.md');
  expect(file.text).toContain('layout: post');
  expect(file.text).toContain('Body');
});

test('bold text downloads as ** in Markdown, and is dropped in plain text for good (a text file is just text)', async ({ app }) => {
  await app.blank();
  await app.press(`${MOD}+b`);
  await app.type('strong');
  await app.press(`${MOD}+b`);
  await app.type(' plain');
  await convertTo(app, 'Markdown (.md)', 'Markdown');
  const md = await app.download(() => app.menu('File', 'Download'));
  expect(md.text).toContain('**strong** plain');

  await convertTo(app, 'Plain Text (.txt)', 'Plain Text');
  const txt = await app.download(() => app.menu('File', 'Download'));
  expect(txt.text.trim()).toBe('strong plain');

  await convertTo(app, 'Word Document (.docx)', 'Word Document');
  const docx = await app.download(() => app.menu('File', 'Download'));
  const xml = readZip(docx.bytes).find((f) => f.name === 'word/document.xml')!.bytes.toString();
  expect(xml).toContain('strong plain');
  expect(xml).not.toMatch(/<w:b\b/);
});

test('a text file keeps its own name and extension on download', async ({ app }) => {
  await app.goto('?doc=welcome');
  await importFile(app, text('server.log', 'started\nlistening'));
  const file = await app.download(() => app.menu('File', 'Download'));
  expect(file.name).toBe('server.log');
  expect(file.text).toBe('started\nlistening');
});

test('a text file comes back byte for byte: CRLF line endings and Windows-1252 letters', async ({ app }) => {
  await app.goto('?doc=welcome');
  const original = Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from('\r\nsecond\r\n')]);
  await importFile(app, { name: 'legacy.txt', buffer: original });
  const file = await app.download(() => app.menu('File', 'Download'));
  expect(file.name).toBe('legacy.txt');
  expect(file.bytes.equals(original)).toBe(true);
});

test('UTF-8 text with a byte order mark keeps it', async ({ app }) => {
  await app.goto('?doc=welcome');
  const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('héllo wörld\n', 'utf8')]);
  await importFile(app, { name: 'bom.txt', buffer: original });
  expect(await app.text()).toContain('héllo wörld');
  const file = await app.download(() => app.menu('File', 'Download'));
  expect(file.bytes.equals(original)).toBe(true);
});

test('editing a CSV cell saves it as the same CSV file', async ({ app }) => {
  await app.goto('?doc=welcome');
  await importFile(app, text('data.csv', 'name,age\nAnn,30\nBob,25\n'));
  await app.focus();
  await app.press(`${MOD}+Home`);
  await app.type('Dr ');
  const file = await app.download(() => app.menu('File', 'Download'));
  expect(file.name).toBe('data.csv');
  expect(file.text.replace(/\r\n/g, '\n')).toBe('Dr name,age\nAnn,30\nBob,25\n');
});

test('Download All is refused while nothing is saved', async ({ app }) => {
  await app.goto('?doc=welcome');
  await app.menu('File', 'Download All (ZIP)');
  await expect.poll(() => status(app.page)).toBe('There are no saved documents to download');
});

test('Download All zips every saved document', async ({ app }) => {
  await blankWith(app, 'first body');
  await waitForSaved(app.page, 'Document1.docx');
  await app.menu('File', 'New');
  await app.ready();
  await app.type('second body');
  await waitForSaved(app.page, 'Document2.docx');

  const zip = await app.download(() => app.menu('File', 'Download All (ZIP)'));
  expect(zip.name).toBe('documents.zip');
  const files = readZip(zip.bytes);
  expect(files.map((f) => f.name).sort()).toEqual(['Document1.docx', 'Document2.docx']);
  for (const f of files) expect(f.bytes.subarray(0, 2).toString()).toBe('PK');
  // Each file opens again in the app (they are saved copies, in the app's own package).
  const first = files.find((f) => f.name === 'Document1.docx')!;
  await importFile(app, { name: 'restored-one.docx', buffer: first.bytes });
  expect(await app.text()).toBe('first body');
  const second = files.find((f) => f.name === 'Document2.docx')!;
  await importFile(app, { name: 'restored-two.docx', buffer: second.bytes });
  expect(await app.text()).toBe('second body');
});

// Download All stores each document as it is saved in the browser: the app's own package (a ZIP
// with a `mimetype` of application/x-golem-document), under the document's .docx name. Word
// can't open that, so a user who unzips the archive gets .docx files that aren't Word documents.
test.fixme('Download All: a file named .docx in the archive is a real Word document', async ({ app }) => {
  await blankWith(app, 'first body');
  await waitForSaved(app.page, 'Document1.docx');
  const zip = await app.download(() => app.menu('File', 'Download All (ZIP)'));
  const file = readZip(zip.bytes).find((f) => f.name === 'Document1.docx')!;
  expect(readZip(file.bytes).map((e) => e.name)).toContain('word/document.xml');
});

test('Download All numbers documents that share a name, and keeps each in its own format', async ({ app }) => {
  await app.goto('?doc=welcome');
  await importFile(app, text('same.txt', 'one'));
  await waitForSaved(app.page, 'same.txt');
  await app.menu('File', 'New');
  await waitForOpen(app, 'Document1');
  await importFile(app, text('same.txt', 'three'));
  await waitForSaved(app.page, 'same.txt');
  await importFile(app, text('notes.md', '# two'));
  await waitForSaved(app.page, 'notes.md');
  const zip = await app.download(() => app.menu('File', 'Download All (ZIP)'));
  const files = readZip(zip.bytes);
  expect(files.map((f) => f.name)).toEqual(expect.arrayContaining(['notes.md', 'same (2).txt', 'same.txt']));
  const bodies = files.filter((f) => f.name.endsWith('.txt')).map((f) => f.bytes.toString());
  expect(bodies.length).toBe(2);
});
