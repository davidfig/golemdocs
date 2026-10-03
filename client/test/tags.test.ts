// #tags as links (`tag:name`): Markdown import and export, the source view, the link dialog and other formats.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WordDocument, paragraphText } from '@golemdocs/docx';
import type { Hyperlink, Paragraph } from '@golemdocs/docx';
import { documentToMarkdown, markdownToDocument } from '../src/formats/markdown.ts';
import { linkInSource } from '../src/formats/wikiLinks.ts';
import { linkAddress } from '../src/ui/linkDialog.ts';
import { parseTextile } from '../src/formats/textile.ts';
import { parseMediaWiki } from '../src/formats/mediawiki.ts';

const paragraphs = (doc: WordDocument): Paragraph[] => doc.body.filter((b): b is Paragraph => b.kind === 'paragraph');
/** The [text, address] of every hyperlink in the document. */
function links(doc: WordDocument): [string, string][] {
  const out: [string, string][] = [];
  for (const p of paragraphs(doc)) {
    for (const i of p.children) {
      if (i.kind === 'hyperlink') {
        const h = i as Hyperlink;
        out.push([h.children.map((c) => (c.kind === 'run' ? c.content.map((x) => (x.kind === 'text' ? x.text : '')).join('') : '')).join(''), h.url ?? '']);
      }
    }
  }
  return out;
}
const imported = async (md: string) => links(await markdownToDocument(md));
const roundTrip = async (md: string) => documentToMarkdown(await markdownToDocument(md));

test('#name in text becomes a link to tag:name, keeping the case as written', async () => {
  assert.deepEqual(await imported('Meeting about #Project and #plan/q3.'), [
    ['#Project', 'tag:Project'],
    ['#plan/q3', 'tag:plan/q3'],
  ]);
  assert.deepEqual(await imported('#start of a paragraph'), [['#start', 'tag:start']]);
  assert.deepEqual(await imported('line one\n#second'), [['#second', 'tag:second']]);
  assert.deepEqual(await imported('**bold #tag**'), [['#tag', 'tag:tag']]);
  assert.deepEqual(await imported('# Heading #tag'), [['#tag', 'tag:tag']]);
  assert.deepEqual(await imported('- item #todo'), [['#todo', 'tag:todo']]);
});

test('headings stay headings and text that is not a tag stays text', async () => {
  const doc = await markdownToDocument('# Title\n\n## Sub\n\nC# and #1 and ##x and a/b#top and &#39; here');
  assert.deepEqual(links(doc), []);
  assert.equal(paragraphText(paragraphs(doc)[0]), 'Title');
  assert.equal(paragraphs(doc)[0].properties.style, 'Heading1');
  assert.equal(paragraphText(paragraphs(doc)[2]), "C# and #1 and ##x and a/b#top and ' here");
});

test('no tags in code, HTML, links, images or after an escape', async () => {
  assert.deepEqual(await imported('`#code` and <span title="#x">z</span> and <a href="#top">t</a>'), []);
  assert.deepEqual(await imported('```\n#fenced\n```\n\n    #indented'), []);
  assert.deepEqual(await imported('<http://example.com/#top> and http://example.com#frag'), [
    ['http://example.com/#top', 'http://example.com/#top'],
  ]);
  assert.deepEqual(await imported('[see #tag](https://example.com)'), [['see #tag', 'https://example.com']]);
  assert.ok(!JSON.stringify(await imported('![alt #tag](a.png)')).includes('tag:'));
  assert.deepEqual(await imported('[link](https://example.com/#anchor)'), [['link', 'https://example.com/#anchor']]);
  const escaped = await markdownToDocument('\\#tag stays');
  assert.deepEqual(links(escaped), []);
  assert.equal(paragraphText(paragraphs(escaped)[0]), '#tag stays');
});

test('a tag link is exported as the plain #tag', async () => {
  assert.equal(await roundTrip('Meeting about #Project, then #plan.'), 'Meeting about #Project, then #plan.\n');
  assert.equal(await roundTrip('#tag'), '#tag\n');
  assert.equal(await roundTrip('**#tag**'), '**#tag**\n');
  assert.equal(await roundTrip('# Heading'), '# Heading\n');
});

test('other tag: links keep the ordinary link form', async () => {
  assert.equal(await roundTrip('[a label](tag:project)'), '[a label](tag:project)\n');
  assert.equal(await roundTrip('[#other](tag:project)'), '[#other](tag:project)\n');
  assert.deepEqual(await imported('[#other](tag:project)'), [['#other', 'tag:project']]);
  // Tag text is compared without case.
  assert.equal(await roundTrip('[#Project](tag:project)'), '#Project\n');
});

test('a tag that would not read back as itself stays a link', async () => {
  assert.equal(await roundTrip('[#tag](tag:tag)x'), '[#tag](tag:tag)x\n');
  assert.equal(await roundTrip('C[#tag](tag:tag)'), 'C[#tag](tag:tag)\n');
});

test('text that looks like a heading or a tag is exported so that it reads back', async () => {
  const md = '\\# not a heading\n\n#word typed in Word\n';
  assert.equal(documentToMarkdown(await markdownToDocument(md)), '\\# not a heading\n\n#word typed in Word\n');
});

test('tags survive Markdown to .docx to Markdown', async () => {
  const doc = await markdownToDocument('Files under #Project and #plan/q3, not C# or [x](https://example.com).');
  const back = await WordDocument.read(await doc.write());
  assert.deepEqual(links(back), [
    ['#Project', 'tag:Project'],
    ['#plan/q3', 'tag:plan/q3'],
    ['x', 'https://example.com'],
  ]);
  assert.equal(documentToMarkdown(back), 'Files under #Project and #plan/q3, not C# or [x](https://example.com).\n');
});

test('linkInSource finds the tag under an offset', () => {
  const source = 'Plan the #project now, `#code`, [t #in](https://x.io) <a href="#top"> end';
  assert.equal(linkInSource(source, source.indexOf('#project') + 3), 'tag:project');
  assert.equal(linkInSource(source, source.indexOf('#project')), 'tag:project');
  assert.equal(linkInSource(source, source.indexOf('#project') + '#project'.length), null);
  assert.equal(linkInSource(source, 2), null);
  assert.equal(linkInSource(source, source.indexOf('#code') + 2), null);
  assert.equal(linkInSource(source, source.indexOf('#in') + 1), 'https://x.io');
  assert.equal(linkInSource(source, source.indexOf('#top') + 1), null);
  assert.equal(linkInSource('C# and #1', 1), null);
  assert.equal(linkInSource('[[Note]] #a', 3), 'doc:Note');
  assert.equal(linkInSource('[[Note]] #a', 10), 'tag:a');
});

test('the link dialog accepts tag: addresses', () => {
  assert.equal(linkAddress('tag:project'), 'tag:project');
  assert.equal(linkAddress('tag:'), null);
  assert.equal(linkAddress('javascript:alert(1)'), null);
});

test('Textile and MediaWiki keep tag: links', () => {
  const textile = parseTextile('See "#project":tag:project now');
  assert.ok(JSON.stringify(textile).includes('tag:project'));
  const wiki = parseMediaWiki('See [tag:project #project] now');
  assert.ok(JSON.stringify(wiki).includes('tag:project'));
});
