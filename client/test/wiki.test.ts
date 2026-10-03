// MediaWiki and Textile (src/formats/mediawiki.ts, textile.ts), and the links between stored documents
// they are written with (src/formats/wikiLinks.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mediawiki, textile } from '../src/formats/handlers/markup.ts';
import { parseMediaWiki } from '../src/formats/mediawiki.ts';
import { documentToOutline, outlineToDocument } from '../src/formats/outline.ts';
import { parseTextile } from '../src/formats/textile.ts';
import type { Node, Span } from '../src/formats/outline.ts';
import { docAddress, findByTitle, splitLink, normalizeTitle, parseDocAddress, titleOfName } from '../src/formats/wikiLinks.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);
const fonts = undefined as never;
const links = (spans: Span[]) => spans.filter((s) => s.link !== undefined).map((s) => [s.text, s.link]);

test('links between documents are addressed by title', () => {
  assert.equal(docAddress('Project Plan'), 'doc:Project Plan');
  assert.equal(docAddress('Project Plan', 'Budget'), 'doc:Project Plan#Budget');
  assert.deepEqual(parseDocAddress('doc:Project Plan#Budget'), { title: 'Project Plan', section: 'Budget' });
  assert.equal(parseDocAddress('https://example.com'), null);
  assert.equal(parseDocAddress('doc:'), null);
  assert.deepEqual(parseDocAddress('doc:Project%20Plan#Q%203'), { title: 'Project Plan', section: 'Q 3' });
  assert.deepEqual(parseDocAddress('doc:100%'), { title: '100%', section: '' });
  assert.equal(titleOfName('Project Plan.docx'), 'Project Plan');
  assert.equal(titleOfName('notes'), 'notes');
  assert.equal(normalizeTitle('  Project_plan  '), 'project plan');
});

test('a title finds the stored document, ignoring case, underscores and the extension', () => {
  const docs = [{ name: 'Budget.xlsx' }, { name: 'Project Plan.docx' }, { name: 'project plan.md' }];
  assert.equal(findByTitle('Project_Plan', docs)?.name, 'Project Plan.docx');
  assert.equal(findByTitle('budget', docs)?.name, 'Budget.xlsx');
  assert.equal(findByTitle('Project Plan.md', docs)?.name, 'project plan.md');
  assert.equal(findByTitle('Missing', docs), undefined);
});

test('a link can name folders, as in Obsidian', () => {
  const docs = [
    { name: 'Plan.md', path: ['Work'] },
    { name: 'Plan.md', path: ['Home', 'Notes'] },
    { name: 'Plan.md', path: [] },
    { name: 'Idea.md', path: ['Home', 'Notes'] },
  ];
  const places = (from: string[]) => ({ folderNames: (d: (typeof docs)[number]) => d.path, from });
  const at = (title: string, from: string[] = []) => {
    const d = findByTitle(title, docs, places(from));
    return d && [...d.path, d.name].join('/');
  };
  assert.equal(at('Plan'), 'Plan.md', 'nearest the top when none is beside the link');
  assert.equal(at('Plan', ['Work']), 'Work/Plan.md', 'the one beside the link first');
  assert.equal(at('Notes/Plan'), 'Home/Notes/Plan.md', 'a path ending in the folders');
  assert.equal(at('home/notes/plan'), 'Home/Notes/Plan.md');
  assert.equal(at('Home/Plan'), undefined, 'folders must be directly above it');
  assert.equal(at('/Work/Plan'), 'Work/Plan.md', 'from the top level');
  assert.equal(at('/Plan'), 'Plan.md');
  assert.equal(at('/Notes/Plan'), undefined);
  assert.equal(at('./Idea', ['Home', 'Notes']), 'Home/Notes/Idea.md');
  assert.equal(at('../Work/Plan', ['Home']), 'Work/Plan.md');
  assert.equal(at('../Notes/Idea', ['Home', 'Notes']), 'Home/Notes/Idea.md');
  assert.equal(at('../Idea', ['Home', 'Notes']), undefined);
  assert.equal(at('./Notes/Idea', ['Home']), 'Home/Notes/Idea.md');
  assert.equal(at('../../Work/Plan', ['Home', 'Notes']), 'Work/Plan.md');
});

test('a link title splits into the folders and the name, for making what is missing', () => {
  assert.deepEqual(splitLink('Plan'), { name: 'Plan', folders: [], exact: false });
  assert.deepEqual(splitLink('Notes/Sub/Plan'), { name: 'Plan', folders: ['Notes', 'Sub'], exact: false });
  assert.deepEqual(splitLink('/Notes/Plan'), { name: 'Plan', folders: ['Notes'], exact: true });
  assert.deepEqual(splitLink('./Plan', ['A', 'B']), { name: 'Plan', folders: ['A', 'B'], exact: true });
  assert.deepEqual(splitLink('../New/Plan', ['A', 'B']), { name: 'Plan', folders: ['A', 'New'], exact: true });
  assert.deepEqual(splitLink('Notes//Plan').folders, ['Notes']);
  assert.equal(splitLink('Notes/').name, '');
});

test('MediaWiki: reads a typical page', () => {
  const outline = parseMediaWiki(
    `{{Infobox}}
== History ==
Some '''bold''', ''italic'', '''''both''''' and <code>code</code> with [[Project Plan|the plan]], [[Budget#Q3]] and [https://example.com a site].<ref>gone</ref>

=== Lists ===
* one
** nested
* two
# first
# second

<syntaxhighlight lang="js">
if (a < b) run();
</syntaxhighlight>

{| class="wikitable"
! Name !! Qty
|-
| Apple || 3
|-
| Pear || 10
|}
----
[[Category:Pages]]
`,
  );
  assert.deepEqual(outline.map((n) => n.t), ['heading', 'para', 'heading', 'list', 'list', 'code', 'table', 'rule']);
  const [h1, para, h2, bullets, numbers, code, table] = outline as [Extract<Node, { t: 'heading' }>, Extract<Node, { t: 'para' }>, Extract<Node, { t: 'heading' }>, Extract<Node, { t: 'list' }>, Extract<Node, { t: 'list' }>, Extract<Node, { t: 'code' }>, Extract<Node, { t: 'table' }>];
  assert.equal(h1.level, 1);
  assert.equal(h2.level, 2);
  assert.ok(para.spans.some((s) => s.text === 'bold' && s.bold && !s.italic));
  assert.ok(para.spans.some((s) => s.text === 'both' && s.bold && s.italic));
  assert.ok(para.spans.some((s) => s.text === 'code' && s.code));
  assert.deepEqual(links(para.spans), [['the plan', 'doc:Project Plan'], ['Budget#Q3', 'doc:Budget#Q3'], ['a site', 'https://example.com']]);
  assert.ok(!para.spans.some((s) => s.text.includes('gone')));
  assert.equal(bullets.items[0].children[0].t, 'list');
  assert.equal(numbers.ordered, true);
  assert.deepEqual([code.lang, code.text], ['js', 'if (a < b) run();']);
  assert.equal(table.header, true);
  assert.equal(table.rows.length, 3);
});

test('Textile: reads a typical page', () => {
  const outline = parseTextile(
    `h1. Title

A *bold* and _italic_ line with @code@, "a site":https://example.com and [[Project Plan|the plan]].
A second line.

* one
** nested
# first

bc(js). const x = 1;

bq. Quoted

|_. Name |_. Qty |
| Apple | 3 |
| Pear | 10 |
`,
  );
  assert.deepEqual(outline.map((n) => n.t), ['heading', 'para', 'list', 'list', 'code', 'quote', 'table']);
  const para = outline[1] as Extract<Node, { t: 'para' }>;
  assert.ok(para.spans.some((s) => s.text === 'bold' && s.bold));
  assert.ok(para.spans.some((s) => s.text === 'italic' && s.italic));
  assert.ok(para.spans.some((s) => s.text === 'code' && s.code));
  assert.ok(para.spans.some((s) => s.br), 'a line end is a line break in Textile');
  assert.deepEqual(links(para.spans), [['a site', 'https://example.com'], ['the plan', 'doc:Project Plan']]);
  assert.equal((outline[4] as Extract<Node, { t: 'code' }>).lang, 'js');
  assert.equal((outline[6] as Extract<Node, { t: 'table' }>).header, true);
});

const LINKED: Node[] = [
  { t: 'heading', level: 1, spans: [{ text: 'Home' }] },
  {
    t: 'para',
    spans: [
      { text: 'See ' },
      { text: 'Project Plan', link: docAddress('Project Plan') },
      { text: ', ' },
      { text: 'the budget', link: docAddress('Budget', 'Q3') },
      { text: ' and ' },
      { text: 'the site', link: 'https://example.com/a?b=1' },
      { text: '.' },
    ],
  },
];

for (const [name, handler] of [['MediaWiki', mediawiki], ['Textile', textile]] as const) {
  test(`${name}: links to other documents are written as wiki links and read back`, async () => {
    const document = await outlineToDocument(LINKED);
    const text = str(await handler.write(document, {}, fonts));
    assert.ok(text.includes('[[Project Plan]]'), text);
    assert.ok(text.includes('[[Budget#Q3|the budget]]'), text);
    const back = documentToOutline((await handler.read(bytes(text))).document);
    assert.deepEqual(back, documentToOutline(document));
  });
}

test('MediaWiki writes text that looks like markup so it reads back as it was', async () => {
  const tricky = "It's ''not'' [[a link]] & <b>not bold</b>, {{not}} a template\n* nor a list\n== nor a heading ==";
  const document = await outlineToDocument([{ t: 'para', spans: tricky.split('\n').flatMap((line, i) => [...(i ? [{ text: '', br: true }] : []), { text: line }]) }]);
  const back = documentToOutline((await mediawiki.read(await mediawiki.write(document, {}, fonts))).document);
  const text = (back[0] as Extract<Node, { t: 'para' }>).spans.map((s) => (s.br ? '\n' : s.text)).join('');
  assert.equal(text, tricky);
});

test('empty and odd input never throws', async () => {
  for (const handler of [mediawiki, textile]) {
    for (const input of ['', '\n\n', '[[', '{|', '{{', "'''", '<pre>', 'bc.. ', '|_. ', '"a":', '* ', '== ', '----']) {
      const { document } = await handler.read(bytes(input));
      await handler.write(document, {}, fonts);
    }
  }
});
