// Syntax colors for code in the text editor (docs/text-files.md, *Syntax colors*): the file is parsed with its Lezer grammar, and each
// character of a line is given the color of what it is (a keyword, a string, a tag, a comment...). Only ever `import()`ed, the first
// time a code file opens: Lezer's core and the small grammars (HTML, CSS, JSON, YAML, XML) are this chunk; each larger grammar
// (JavaScript, Python, Markdown...) is a chunk of its own, fetched the first time a file in it opens.

import type { Parser } from '@lezer/common';
import { highlightTree, tagHighlighter, tags } from '@lezer/highlight';
import { parser as cssParser } from '@lezer/css';
import { configureNesting, parser as htmlParser } from '@lezer/html';
import { parser as jsonParser } from '@lezer/json';
import { parser as xmlParser } from '@lezer/xml';
import { parser as yamlParser } from '@lezer/yaml';
import { packColor } from '@golemdocs/layout';
import type { SyntaxId } from './languages.ts';

/** Colors for light pages (dark pages and contrast themes are made from them by the text shader, as for the rest of the text). */
const PALETTE = {
  keyword: packColor(0xcf222e),
  string: packColor(0x0a3069),
  number: packColor(0x0550ae),
  comment: packColor(0x6e7781),
  tag: packColor(0x116329),
  attribute: packColor(0x953800),
  property: packColor(0x0550ae),
  function: packColor(0x8250df),
  type: packColor(0x953800),
  meta: packColor(0x6e7781),
  heading: packColor(0x0550ae),
  link: packColor(0x0a3069),
  invalid: packColor(0x82071e),
};

type ColorName = keyof typeof PALETTE;

/** What each kind of thing a grammar names is colored as; anything else keeps the text's own color. */
const HIGHLIGHTER = tagHighlighter([
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.modifier, tags.self], class: 'keyword' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.escape, tags.character, tags.attributeValue], class: 'string' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.unit, tags.color, tags.constant(tags.variableName)], class: 'number' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], class: 'comment' },
  { tag: [tags.tagName, tags.angleBracket], class: 'tag' },
  { tag: [tags.attributeName], class: 'attribute' },
  { tag: [tags.propertyName, tags.definition(tags.propertyName), tags.labelName], class: 'property' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.function(tags.variableName)), tags.macroName], class: 'function' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.definition(tags.typeName)], class: 'type' },
  { tag: [tags.meta, tags.processingInstruction, tags.documentMeta, tags.annotation], class: 'meta' },
  { tag: [tags.heading, tags.heading1, tags.heading2, tags.heading3, tags.heading4, tags.heading5, tags.heading6], class: 'heading' },
  { tag: [tags.link, tags.url], class: 'link' },
  { tag: tags.invalid, class: 'invalid' },
]);

const parsers = new Map<SyntaxId, Promise<Parser>>();

/** The JavaScript grammar in a dialect: plain, with JSX, TypeScript, or both. */
const javascript = (dialect: string): Promise<Parser> => import('@lezer/javascript').then(({ parser }) => (dialect ? parser.configure({ dialect }) : parser));

/** HTML with the CSS in `<style>` and the JavaScript in `<script>` colored as those. */
async function html(): Promise<Parser> {
  const js = await javascript('');
  return htmlParser.configure({ wrap: configureNesting([{ tag: 'script', parser: js }, { tag: 'style', parser: cssParser }]) });
}

/** A grammar, loaded the first time it is asked for. */
export function grammar(id: SyntaxId): Promise<Parser> {
  let found = parsers.get(id);
  if (!found) {
    found = load(id);
    parsers.set(id, found);
    found.catch(() => parsers.delete(id));
  }
  return found;
}

function load(id: SyntaxId): Promise<Parser> {
  switch (id) {
    case 'html':
      return html();
    case 'css':
      return Promise.resolve(cssParser);
    case 'json':
      return Promise.resolve(jsonParser);
    case 'yaml':
      return Promise.resolve(yamlParser);
    case 'xml':
      return Promise.resolve(xmlParser);
    case 'scss':
      return import('@lezer/sass').then(({ parser }) => parser);
    case 'sass':
      return import('@lezer/sass').then(({ parser }) => parser.configure({ dialect: 'indented' }));
    case 'javascript':
      return javascript('');
    case 'jsx':
      return javascript('jsx');
    case 'typescript':
      return javascript('ts');
    case 'tsx':
      return javascript('ts jsx');
    case 'markdown':
      return import('@lezer/markdown').then(({ parser }) => parser);
    case 'python':
      return import('@lezer/python').then(({ parser }) => parser);
    case 'go':
      return import('@lezer/go').then(({ parser }) => parser);
    case 'java':
      return import('@lezer/java').then(({ parser }) => parser);
    case 'rust':
      return import('@lezer/rust').then(({ parser }) => parser);
    case 'cpp':
      return import('@lezer/cpp').then(({ parser }) => parser);
    case 'php':
      return import('@lezer/php').then(({ parser }) => parser);
  }
}

/** A file's colors, line by line: a color for each character of a line (0 where it keeps the text's own), or null for a plain line. */
export interface LineColors {
  colorsOf(line: number, text: string): Uint32Array | null;
}

/** Colors `text` with a grammar. Lines are found by `\n`, as the editor counts them; a line's characters are its UTF-16 code units. */
export function colorize(text: string, parser: Parser): LineColors {
  const starts: number[] = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  // Runs of one color, in order and not overlapping: from, to, color.
  const runs: number[] = [];
  highlightTree(parser.parse(text), HIGHLIGHTER, (from, to, classes) => {
    const color = PALETTE[classes.split(' ')[0] as ColorName];
    if (color !== undefined && to > from) runs.push(from, to, color);
  });
  const count = runs.length / 3;
  return {
    colorsOf(line, lineText) {
      const start = starts[line];
      if (start === undefined || !count) return null;
      const end = start + lineText.length;
      // The first run that ends after the line starts.
      let lo = 0;
      let hi = count;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (runs[mid * 3 + 1] <= start) lo = mid + 1;
        else hi = mid;
      }
      if (lo >= count || runs[lo * 3] >= end) return null;
      const colors = new Uint32Array(lineText.length);
      for (let r = lo; r < count && runs[r * 3] < end; r++) {
        const from = Math.max(runs[r * 3], start) - start;
        const to = Math.min(runs[r * 3 + 1], end) - start;
        colors.fill(runs[r * 3 + 2], from, to);
      }
      return colors;
    },
  };
}
