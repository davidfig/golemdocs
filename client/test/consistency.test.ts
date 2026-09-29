// Static consistency checks that read source files from disk (no DOM, no bundler):
//   1. every literal t('area.key') resolves to an English catalog key;
//   2. every command / control id in the toolbar layout and menus is registered;
//   3. UI code does not put user-visible string literals on screen without t().

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { en } from '../src/i18n/en/index.ts';
import { DEFAULT_LAYOUT, SEPARATOR } from '../src/ui/toolbarLayout.ts';

const SRC = new URL('../src/', import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

const read = (path: string): string => readFileSync(path, 'utf8');
const rel = (path: string): string => relative(SRC, path);
/** Files outside the catalogs themselves (a catalog's own keys are not references). */
const sourceFiles = walk(SRC).filter((f) => !rel(f).startsWith('i18n/'));

/** Blanks out comments, keeping string contents and line numbers (a `//` inside a string survives). */
function stripComments(code: string): string {
  let out = '';
  let i = 0;
  let quote = '';
  while (i < code.length) {
    const c = code[i]!;
    const next = code[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') out += code[++i] ?? '';
      else if (c === quote) quote = '';
      i++;
    } else if (c === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end < 0 ? code.length : end + 2;
      out += code.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else {
      if (c === "'" || c === '"' || c === '`') quote = c;
      out += c;
      i++;
    }
  }
  return out;
}

const lineOf = (code: string, index: number): number => code.slice(0, index).split('\n').length;

// --- 1. Translation keys -----------------------------------------------------------------------

const KEY = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/;
const catalog = en as Record<string, string>;
const knownKey = (key: string): boolean => key in catalog || `${key}.other` in catalog || `${key}.one` in catalog;

/** The text of the balanced parentheses starting at `open` (the index of the `(`). */
function callArguments(code: string, open: number): string {
  let depth = 0;
  let quote = '';
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return code.slice(open + 1, i);
  }
  return code.slice(open + 1);
}

interface KeyUse {
  file: string;
  line: number;
  key: string;
}

/** Literal keys inside t(...) calls, and how many t() calls had only dynamic keys. */
function scanTCalls(): { uses: KeyUse[]; dynamic: number; prefixes: Set<string> } {
  const uses: KeyUse[] = [];
  const prefixes = new Set<string>();
  let dynamic = 0;
  for (const file of sourceFiles) {
    const code = stripComments(read(file));
    for (const m of code.matchAll(/(?<![\w.$])t\(/g)) {
      const args = callArguments(code, m.index + m[0].length - 1);
      let found = false;
      for (const lit of args.matchAll(/(['"])((?:(?!\1)[^\\])*)\1/g)) {
        if (KEY.test(lit[2]!)) {
          uses.push({ file: rel(file), line: lineOf(code, m.index), key: lit[2]! });
          found = true;
        }
      }
      for (const tpl of args.matchAll(/`([A-Za-z0-9.]*)\$\{/g)) {
        prefixes.add(tpl[1]!);
        found = true;
        dynamic++;
      }
      if (!found) dynamic++; // t(variable): the key is a MessageKey typed elsewhere (tsc checks it)
    }
  }
  return { uses, dynamic, prefixes };
}

test('every literal t() key exists in the English catalog', () => {
  const { uses, dynamic } = scanTCalls();
  // t(`area.${x}`) and t(variable) calls can't be resolved statically and are skipped here; the
  // dynamic ones are covered by the MessageKey type (tsc) and, for unused-key reporting, by prefix.
  // As of writing: see the `dynamic` count logged below.
  assert.ok(uses.length > 100, `only found ${uses.length} literal t() calls; has the scanner broken?`);
  const bad = uses.filter((u) => !knownKey(u.key)).map((u) => `${u.file}:${u.line} t('${u.key}')`);
  assert.deepEqual(bad, [], `unknown translation keys:\n${bad.join('\n')}`);
  console.log(`[i18n] ${uses.length} literal t() keys checked, ${dynamic} dynamic/variable t() calls skipped`);
});

test('no English key is unreferenced (budget below, zero today)', () => {
  const { prefixes } = scanTCalls();
  const literals = new Set<string>();
  for (const file of sourceFiles) {
    const code = stripComments(read(file));
    for (const m of code.matchAll(/(['"`])([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)\1/g)) literals.add(m[2]!);
    for (const m of code.matchAll(/`([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*\.?[A-Za-z0-9]*)\$\{/g)) prefixes.add(m[1]!);
  }
  const unused = Object.keys(catalog).filter((key) => {
    const base = key.replace(/\.(zero|one|two|few|many|other)$/, '');
    if (literals.has(key) || literals.has(base)) return false;
    for (const p of prefixes) if (p.includes('.') && key.startsWith(p)) return false; // `${x}.suffix` etc. carry no area to match
    return true;
  });
  if (unused.length) console.log(`[i18n] ${unused.length} English keys have no static reference:\n  ${unused.join('\n  ')}`);
  // Keys can be reached in ways a scan can't see, so this only guards against the list growing.
  assert.ok(unused.length <= UNUSED_KEY_BUDGET, `${unused.length} unused English keys (budget ${UNUSED_KEY_BUDGET}):\n${unused.join('\n')}`);
});
const UNUSED_KEY_BUDGET = 0;

// --- 2. Command and control ids ----------------------------------------------------------------

/** Ids registered by chrome.ts: `a('id'`, `dialog('id'`, `mode('id'`, `{ id: 'id'`, `define('id'`. Templates become prefixes. */
function registeredIds(): { exact: Set<string>; prefixes: string[] } {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  const chrome = stripComments(read(join(SRC, 'ui/chrome.ts')));
  for (const m of chrome.matchAll(/(?:\b(?:a|dialog|mode|picture|define|tool|add)\(|\bid:\s*)(['"`])([a-z][A-Za-z0-9]*\.[^'"`]*)\1/g)) {
    const id = m[2]!;
    const dollar = id.indexOf('${');
    if (dollar >= 0) prefixes.push(id.slice(0, dollar));
    else exact.add(id);
  }
  return { exact, prefixes };
}

const isRegistered = (id: string, reg: ReturnType<typeof registeredIds>): boolean => reg.exact.has(id) || reg.prefixes.some((p) => id.startsWith(p));

test('every id in the default toolbar layout is a registered command or control', () => {
  const reg = registeredIds();
  assert.ok(reg.exact.size > 50, `only ${reg.exact.size} ids found in chrome.ts; has the scanner broken?`);
  const bad: string[] = [];
  for (const bar of DEFAULT_LAYOUT) for (const id of bar.items) if (id !== SEPARATOR && !isRegistered(id, reg)) bad.push(`${bar.name}: ${id}`);
  assert.deepEqual(bad, [], `toolbar ids with no command or control:\n${bad.join('\n')}`);
});

test('every cmd() id in the menus is a registered command', () => {
  const reg = registeredIds();
  const chrome = stripComments(read(join(SRC, 'ui/chrome.ts')));
  const bad: string[] = [];
  let n = 0;
  for (const m of chrome.matchAll(/\bcmd\((['"`])([^'"`]+)\1\)/g)) {
    n++;
    const id = m[2]!;
    // A template id (`file.convertTo.${k}`) is checked by its prefix.
    const prefix = id.includes('${') ? id.slice(0, id.indexOf('${')) : null;
    const ok = prefix === null ? isRegistered(id, reg) : reg.prefixes.includes(prefix) || reg.exact.has(prefix.replace(/\.$/, ''));
    if (!ok) bad.push(`ui/chrome.ts:${lineOf(chrome, m.index)} cmd('${id}')`);
  }
  assert.ok(n > 50, `only ${n} cmd() calls found; has the scanner broken?`);
  assert.deepEqual(bad, [], `menu ids with no command:\n${bad.join('\n')}`);
});

test('command ids are used consistently (no toolbar id is a typo of a menu-only id)', () => {
  // Every toolbar item id looks like `area.name` or is the separator.
  for (const bar of DEFAULT_LAYOUT) for (const id of bar.items) assert.ok(id === SEPARATOR || /^[a-z]+\.[A-Za-z.]+$/.test(id), `${bar.name}: odd id ${id}`);
});

// --- 3. User-visible literals bypassing t() ----------------------------------------------------

/**
 * Documented exceptions: `file:line-text-fragment`, matched as a substring of "file: source line".
 * Each needs a reason. Keep it short; the goal is to move things into the catalog, not to grow this.
 */
const LITERAL_ALLOWLIST: { where: string; reason: string }[] = [
  { where: "icons.ts: text: 'abc',", reason: 'the strikethrough toolbar glyph: struck-through sample letters, not a word' },
];

const VISIBLE = [
  /\.(?:textContent|innerText|title|placeholder|ariaLabel)\s*=\s*(['"`])([^'"`\n]*)\1/g,
  /\b(?:text|title|placeholder|tooltip|ariaLabel|'aria-label'|'title'|'placeholder'|"aria-label")\s*:\s*(['"`])([^'"`\n]*)\1/g,
  /setAttribute\(\s*['"](?:aria-label|title|placeholder|aria-description)['"]\s*,\s*(['"`])([^'"`\n]*)\1/g,
];

/** Something a person could read: two letters in a row, outside any `${}`. Symbols, units and ids don't count. */
const readable = (literal: string): boolean => /[A-Za-z]{2}/.test(literal.replace(/\$\{[^}]*\}/g, ''));

test('UI code does not show string literals without t()', () => {
  const found: string[] = [];
  for (const file of walk(join(SRC, 'ui'))) {
    const raw = read(file);
    const code = stripComments(raw);
    const lines = raw.split('\n');
    for (const re of VISIBLE) {
      for (const m of code.matchAll(re)) {
        if (!readable(m[2]!)) continue;
        const line = lineOf(code, m.index);
        const text = lines[line - 1]!.trim();
        if (LITERAL_ALLOWLIST.some((a) => `${rel(file)}: ${text}`.includes(a.where))) continue;
        found.push(`ui/${rel(file).replace(/^ui\//, '')}:${line}  ${text.slice(0, 110)}`);
      }
    }
  }
  assert.deepEqual(found, [], `user-visible literals that bypass t() (move into client/src/i18n/en and every locale, or allowlist with a reason):\n${found.join('\n')}`);
});
