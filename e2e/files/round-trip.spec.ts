// Download in every format, and open the downloaded file again: what comes back is what went out.

import { expect, test } from './fixtures';
import { blankWith, convertTo, formatLabel, importFile, readZip } from './helpers';

interface Target {
  menu: string;
  label: string;
  extension: string;
  /** Checks the downloaded bytes are of the right kind of file. */
  signature: (bytes: Buffer, text: string) => void;
  /** Whether the text comes back exactly (else just that both lines are in it). */
  exact: boolean;
}

const zipWith = (mime: string, entry: string) => (bytes: Buffer) => {
  expect(bytes.subarray(0, 2).toString()).toBe('PK');
  const files = readZip(bytes);
  expect(files.map((f) => f.name)).toContain(entry);
  if (mime) expect(files.find((f) => f.name === 'mimetype')?.bytes.toString()).toBe(mime);
};

const TARGETS: Target[] = [
  { menu: 'Word Document (.docx)', label: 'Word Document', extension: '.docx', signature: zipWith('', 'word/document.xml'), exact: true },
  { menu: 'OpenDocument Text (.odt)', label: 'OpenDocument Text', extension: '.odt', signature: zipWith('application/vnd.oasis.opendocument.text', 'content.xml'), exact: true },
  { menu: 'Rich Text Format (.rtf)', label: 'Rich Text Format', extension: '.rtf', signature: (_b, t) => expect(t.startsWith('{\\rtf')).toBe(true), exact: true },
  { menu: 'Web Page (.html)', label: 'Web Page', extension: '.html', signature: (_b, t) => expect(t.toLowerCase()).toContain('<html'), exact: true },
  { menu: 'EPUB Book (.epub)', label: 'EPUB Book', extension: '.epub', signature: zipWith('application/epub+zip', 'META-INF/container.xml'), exact: false },
  { menu: 'Web Archive (.mhtml)', label: 'Web Archive', extension: '.mhtml', signature: (_b, t) => expect(t).toMatch(/MIME-Version/i), exact: false },
  { menu: 'LaTeX (.tex)', label: 'LaTeX', extension: '.tex', signature: (_b, t) => expect(t).toContain('\\begin{document}'), exact: false },
  { menu: 'AsciiDoc (.adoc)', label: 'AsciiDoc', extension: '.adoc', signature: () => {}, exact: false },
  { menu: 'reStructuredText (.rst)', label: 'reStructuredText', extension: '.rst', signature: () => {}, exact: false },
  { menu: 'Org Mode (.org)', label: 'Org Mode', extension: '.org', signature: () => {}, exact: false },
  { menu: 'MediaWiki Markup (.wiki)', label: 'MediaWiki Markup', extension: '.wiki', signature: () => {}, exact: false },
  { menu: 'Textile (.textile)', label: 'Textile', extension: '.textile', signature: () => {}, exact: false },
  { menu: 'Email Message (.eml)', label: 'Email Message', extension: '.eml', signature: (_b, t) => expect(t).toMatch(/^[A-Za-z-]+: /m), exact: false },
  { menu: 'Jupyter Notebook (.ipynb)', label: 'Jupyter Notebook', extension: '.ipynb', signature: (_b, t) => expect(JSON.parse(t).nbformat).toBeGreaterThanOrEqual(4), exact: false },
  { menu: 'Markdown (.md)', label: 'Markdown', extension: '.md', signature: (_b, t) => expect(t).toContain('Round trip text'), exact: true },
  { menu: 'Plain Text (.txt)', label: 'Plain Text', extension: '.txt', signature: (_b, t) => expect(t).toContain('Round trip text'), exact: true },
];

for (const target of TARGETS) {
  test(`${target.label}: converting, downloading and importing the download gives the text back`, async ({ app }) => {
    await blankWith(app, 'Round trip text', 'Second line');
    // A new document is already a Word document (and its own entry is disabled in Convert To).
    if (target.extension !== '.docx') await convertTo(app, target.menu, target.label);
    const file = await app.download(() => app.menu('File', 'Download'));
    expect(file.name).toBe(`Document1${target.extension}`);
    target.signature(file.bytes, file.text);

    await importFile(app, { name: `again${target.extension}`, buffer: file.bytes });
    expect(await formatLabel(app.page)).toBe(target.label);
    const back = await app.text();
    if (target.exact) expect(back.replace(/\n+$/, '')).toBe('Round trip text\nSecond line');
    else {
      expect(back).toContain('Round trip text');
      expect(back).toContain('Second line');
    }
  });
}

test('PDF: a downloaded PDF is a PDF, opens as its own pages, and reflows as Word', async ({ app }) => {
  await blankWith(app, 'Round trip text', 'Second line');
  await convertTo(app, 'PDF (.pdf)', 'PDF');
  const file = await app.download(() => app.menu('File', 'Download'));
  expect(file.name).toBe('Document1.pdf');
  expect(file.bytes.subarray(0, 5).toString()).toBe('%PDF-');

  await importFile(app, { name: 'again.pdf', buffer: file.bytes });
  expect(await formatLabel(app.page)).toBe('PDF');
  await convertTo(app, 'Word Document (.docx)', 'Word Document');
  const back = await app.text();
  expect(back).toContain('Round trip text');
  expect(back).toContain('Second line');
});

test('a CSV document downloads as a CSV with the same rows', async ({ app }) => {
  await app.goto('?doc=welcome');
  const original = 'name,city\n"Smith, J",Paris\nBob,Rome\n';
  await importFile(app, { name: 'rows.csv', buffer: Buffer.from(original) });
  const file = await app.download(() => app.menu('File', 'Download'));
  expect(file.name).toBe('rows.csv');
  expect(file.text.replace(/\r\n/g, '\n').trim()).toBe(original.trim());
});

test('a TSV document downloads as a TSV with the same rows', async ({ app }) => {
  await app.goto('?doc=welcome');
  const original = 'x\ty\n1\t2\n';
  await importFile(app, { name: 'grid.tsv', buffer: Buffer.from(original) });
  const file = await app.download(() => app.menu('File', 'Download'));
  expect(file.name).toBe('grid.tsv');
  expect(file.text.replace(/\r\n/g, '\n').trim()).toBe(original.trim());
});

test('an imported PDF downloads as the very same bytes', async ({ app }) => {
  await blankWith(app, 'Untouched pages');
  await convertTo(app, 'PDF (.pdf)', 'PDF');
  const made = await app.download(() => app.menu('File', 'Download'));
  await importFile(app, { name: 'original.pdf', buffer: made.bytes });
  const again = await app.download(() => app.menu('File', 'Download'));
  expect(again.name).toBe('original.pdf');
  expect(again.bytes.equals(made.bytes)).toBe(true);
});
