// Syntax colors in the text editor (docs/text-files.md, *Syntax colors*): which files are colored, and what color each character of a
// line gets from its Lezer grammar, HTML's <script> and <style> included.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packColor } from '@golemdocs/layout';
import { colorize, grammar } from '../src/textEditor/syntax/colorize.ts';
import { MAX_SYNTAX_BYTES, syntaxOf } from '../src/textEditor/syntax/languages.ts';

const KEYWORD = packColor(0xcf222e);
const STRING = packColor(0x0a3069);
const COMMENT = packColor(0x6e7781);
const TAG = packColor(0x116329);
const ATTRIBUTE = packColor(0x953800);
const PROPERTY = packColor(0x0550ae);

/** The color of the characters of `line` at the first place `word` is. */
function colorAt(colors: ReturnType<typeof colorize>, lines: string[], line: number, word: string): number {
  const at = lines[line].indexOf(word);
  assert.ok(at >= 0, `${word} on line ${line}`);
  const row = colors.colorsOf(line, lines[line]);
  return row ? row[at] : 0;
}

test('code files are colored by their extension; logs and unknown files are plain', () => {
  assert.equal(syntaxOf('page.html'), 'html');
  assert.equal(syntaxOf('App.TSX'), 'tsx');
  assert.equal(syntaxOf('style.scss'), 'scss');
  assert.equal(syntaxOf('notes.md'), 'markdown');
  assert.equal(syntaxOf('main.rs'), 'rust');
  assert.equal(syntaxOf('server.log'), null);
  assert.equal(syntaxOf('Makefile'), null);
  assert.equal(syntaxOf('query.sql'), null);
  assert.ok(MAX_SYNTAX_BYTES >= 1024 * 1024);
});

test('HTML: tags, attributes and values, with the CSS in <style> and the JavaScript in <script> colored as those', async () => {
  const text = '<!-- note -->\n<div class="box">\n<style>p { color: red; }</style>\n<script>const x = "hi";</script>\n</div>';
  const lines = text.split('\n');
  const colors = colorize(text, await grammar('html'));
  assert.equal(colorAt(colors, lines, 0, 'note'), COMMENT);
  assert.equal(colorAt(colors, lines, 1, 'div'), TAG);
  assert.equal(colorAt(colors, lines, 1, 'class'), ATTRIBUTE);
  assert.equal(colorAt(colors, lines, 1, '"box"'), STRING);
  assert.equal(colorAt(colors, lines, 2, 'color'), PROPERTY);
  assert.equal(colorAt(colors, lines, 3, 'const'), KEYWORD);
  assert.equal(colorAt(colors, lines, 3, '"hi"'), STRING);
  // Plain text keeps the text's own color.
  assert.equal(colorAt(colors, lines, 3, ' x'), 0);
});

test('a string or comment that runs over several lines is colored on each of them', async () => {
  const text = 'let a = `one\ntwo`;\n/* three\nfour */\nreturn;';
  const lines = text.split('\n');
  const colors = colorize(text, await grammar('typescript'));
  assert.equal(colorAt(colors, lines, 1, 'two'), STRING);
  assert.equal(colorAt(colors, lines, 3, 'four'), COMMENT);
  assert.equal(colorAt(colors, lines, 4, 'return'), KEYWORD);
});

test('every grammar loads and colors something', async () => {
  const samples: Record<string, string> = {
    'a.css': 'a { color: red }',
    'a.scss': '$x: 1; a { b: $x }',
    'a.sass': 'a\n  color: red',
    'a.js': 'const a = 1',
    'a.jsx': 'const a = <b>hi</b>',
    'a.tsx': 'const a: number = <b/>',
    'a.json': '{"a": 1}',
    'a.yaml': 'a: "b"',
    'a.xml': '<a b="c"/>',
    'a.md': '# Title',
    'a.py': 'def f(): return 1',
    'a.go': 'package main',
    'a.java': 'class A {}',
    'a.rs': 'fn main() {}',
    'a.cpp': 'int main() { return 0; }',
    'a.php': '<?php echo "a"; ?>',
  };
  for (const [name, text] of Object.entries(samples)) {
    const colors = colorize(text, await grammar(syntaxOf(name)!));
    const lines = text.split('\n');
    assert.ok(lines.some((line, i) => colors.colorsOf(i, line)?.some((c) => c !== 0)), name);
  }
});
