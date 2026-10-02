// Typst import/export (src/formats/typst.ts), through the handler the app uses.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { typst } from '../src/formats/handlers/markup.ts';
import { documentToOutline, outlineToDocument } from '../src/formats/outline.ts';
import type { Node } from '../src/formats/outline.ts';

const fonts = undefined as never;
const bytes = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);
const read = async (text: string): Promise<Node[]> => documentToOutline((await typst.read(bytes(text))).document);

test('Typst: reads a typical document, leaving out rules, comments, labels and references', async () => {
  const nodes = await read(`#import "@preview/thing:0.1.0": *
#set page(paper: "a4")
#show heading: it => [
  #set text(blue)
  #it.body
]

= Introduction <intro>
Some *bold*, _emphasis_, \`raw\`, #link("https://typst.app")[a link] and https://example.com. // a comment
See @intro, snake_case, \\#hash, ~ -- --- ... and $x^2$.
/* a block
   comment */
- one
  continued
  - nested
- two

3. three
4. four

/ Term: its meaning

\`\`\`rust
fn main() {}
\`\`\`

#quote(block: true, attribution: [Someone])[
  Words *here*
]

#table(
  columns: (1fr, auto),
  table.header([*H1*], [H2]),
  [a], [b \\ c],
  table.hline(),
  [d], [e],
)

#line(length: 100%)
#figure(image("chart.png"), caption: [A chart])
#strong[Done] #underline[u] #super[2] #sub[i] #strike[s].
`);
  assert.deepEqual(
    nodes.map((n) => n.t),
    ['heading', 'para', 'list', 'list', 'list', 'code', 'quote', 'table', 'rule', 'para', 'para'],
  );
  assert.deepEqual(nodes[1], {
    t: 'para',
    spans: [
      { text: 'Some ' },
      { text: 'bold', bold: true },
      { text: ', ' },
      { text: 'emphasis', italic: true },
      { text: ', ' },
      { text: 'raw', code: true },
      { text: ', ' },
      { text: 'a link', link: 'https://typst.app' },
      { text: ' and ' },
      { text: 'https://example.com', link: 'https://example.com' },
      { text: '. See , snake_case, #hash,   – — … and x^2.' },
    ],
  });
  assert.deepEqual(nodes[2], {
    t: 'list',
    ordered: false,
    start: 1,
    items: [
      { spans: [{ text: 'one continued' }], children: [{ t: 'list', ordered: false, start: 1, items: [{ spans: [{ text: 'nested' }], children: [] }] }] },
      { spans: [{ text: 'two' }], children: [] },
    ],
  });
  assert.equal((nodes[3] as { start: number }).start, 3);
  assert.deepEqual((nodes[4] as { items: unknown[] }).items, [{ spans: [{ text: 'Term', bold: true }, { text: ': its meaning' }], children: [] }]);
  // (The document keeps a code block's text, not its language.)
  assert.deepEqual(nodes[5], { t: 'code', text: 'fn main() {}' });
  assert.deepEqual(nodes[6], { t: 'quote', paras: [[{ text: 'Words ' }, { text: 'here', bold: true }], [{ text: '— Someone' }]] });
  assert.deepEqual(nodes[7], {
    t: 'table',
    header: true,
    rows: [
      [[{ text: 'H1', bold: true }], [{ text: 'H2' }]],
      [[{ text: 'a' }], [{ text: 'b' }, { text: '', br: true }, { text: 'c' }]],
      [[{ text: 'd' }], [{ text: 'e' }]],
    ],
  });
  assert.deepEqual(nodes[9], { t: 'para', spans: [{ text: 'A chart' }] });
  assert.deepEqual(nodes[10], {
    t: 'para',
    spans: [{ text: 'Done', bold: true }, { text: ' ' }, { text: 'u', underline: true }, { text: ' ' }, { text: '2', sup: true }, { text: ' ' }, { text: 'i', sub: true }, { text: ' ' }, { text: 's', strike: true }, { text: '.' }],
  });
});

test('Typst: text that looks like markup is escaped and comes back as it was', async () => {
  const para = (text: string): Node => ({ t: 'para', spans: [{ text }] });
  const outline: Node[] = [
    para('= not a heading'),
    para('- not a list'),
    para('+ nor this'),
    para('12. nor this'),
    para('*a* _b_ `c` $d$ #e <f> @g [h] ~i // j /* k -- l --- m ... n \\ o https://p.q'),
    { t: 'para', spans: [{ text: 'a link: ' }, { text: 'https://x.org/a_b', link: 'https://x.org/a_b' }, { text: ' and ' }, { text: 'text', link: 'https://y.org' }] },
    { t: 'para', spans: [{ text: 'un' }, { text: 'believ', bold: true }, { text: 'able and ' }, { text: 'back`tick', code: true }] },
    { t: 'list', ordered: false, start: 1, items: [{ spans: [{ text: 'line' }, { text: '', br: true }, { text: '- break' }], children: [{ t: 'para', spans: [{ text: 'more' }] }] }, { spans: [{ text: 'next' }], children: [] }] },
    { t: 'code', text: 'has ``` in it\n  and indentation' },
  ];
  const source = await outlineToDocument(outline);
  const file = str(await typst.write(source, {}, fonts));
  assert.deepEqual(await read(file), documentToOutline(source), file);
  assert.match(file, /un#strong\[believ\]able/);
  assert.match(file, /a link: https:\/\/x\.org\/a_b and/);
});
