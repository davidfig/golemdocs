import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../src/sheet/formula/functions/index.ts';
import { FUNCTIONS } from '../src/sheet/formula/functions/registry.ts';
import { CATALOGUE } from '../src/sheet/formula/functions/catalogue.ts';
import { HELP_LANGUAGES, argumentIndex, functionHelp, splitArgs, type FunctionHelp } from '../src/sheet/formula/help/index.ts';

const names = Object.values(CATALOGUE).flat();

/** The shape of an argument list, whatever its language: R required, O optional (bracketed), M more (…). */
const shape = (args: string) => splitArgs(args).map((a) => (a === '…' ? 'M' : a.startsWith('[') ? `O${splitArgs(a.slice(1, -1)).length}` : 'R'));

test('every function Excel has has English help, and nothing else does', async () => {
  const help = await functionHelp('en');
  assert.deepEqual(names.filter((n) => !help[n]), []);
  assert.deepEqual(Object.keys(help).filter((n) => !names.includes(n)), []);
  for (const [name, [, description]] of Object.entries(help)) assert.ok(description.trim().length > 10, name);
});

test('each function’s listed arguments take as many arguments as the function does', async () => {
  const help = await functionHelp('en');
  const wrong: string[] = [];
  for (const name of names) {
    const spec = FUNCTIONS.get(name);
    if (!spec) continue;
    const parts = shape(help[name][0]);
    const required = parts.filter((p) => p === 'R').length;
    const more = parts.includes('M');
    const listed = parts.reduce((n, p) => n + (p === 'R' ? 1 : p.startsWith('O') ? +p.slice(1) : 0), 0);
    if (required !== spec.min || (more ? spec.max < listed : listed !== spec.max)) wrong.push(`${name} ${help[name][0]} (${spec.min}-${spec.max})`);
  }
  assert.deepEqual(wrong, []);
});

test('every language has help for every function, with the same arguments', async () => {
  const en = await functionHelp('en');
  for (const tag of HELP_LANGUAGES) {
    const help: FunctionHelp = await functionHelp(tag);
    assert.deepEqual(names.filter((n) => !help[n]), [], tag);
    for (const name of names) assert.deepEqual(shape(help[name][0]), shape(en[name][0]), `${tag} ${name}: ${help[name][0]}`);
  }
});

test('an unknown language gets English help, and a regional one its language’s', async () => {
  assert.equal(await functionHelp('xx'), await functionHelp('en'));
  assert.equal(await functionHelp('de-AT'), await functionHelp('de'));
});

test('the argument being typed is found among the listed ones, past the end on the one that repeats', () => {
  const sumifs = splitArgs('sum_range, criteria_range1, criteria1, [criteria_range2, criteria2], …');
  assert.deepEqual(sumifs, ['sum_range', 'criteria_range1', 'criteria1', '[criteria_range2, criteria2]', '…']);
  assert.equal(argumentIndex(sumifs, 1), 1);
  assert.equal(argumentIndex(sumifs, 3), 3);
  assert.equal(argumentIndex(sumifs, 7), 3);
  const round = splitArgs('number, num_digits');
  assert.equal(argumentIndex(round, 5), 1);
  assert.deepEqual(splitArgs(''), []);
});

test('the call the caret is in: the innermost named one, counting commas outside strings, sheet names and array constants', async () => {
  const { callAt } = await import('../src/sheet/formulaHint.ts');
  const at = (text: string) => callAt(text.replace('|', ''), text.indexOf('|'));
  assert.deepEqual(at('=SUM(A1|'), { name: 'SUM', arg: 0 });
  assert.deepEqual(at('=SUM(A1, B2|'), { name: 'SUM', arg: 1 });
  assert.deepEqual(at('=IF(A1>0, ROUND(B1, |'), { name: 'ROUND', arg: 1 });
  assert.deepEqual(at('=IF(A1>0, ROUND(B1, 2), |'), { name: 'IF', arg: 2 });
  assert.deepEqual(at('=CONCAT("a, b", |'), { name: 'CONCAT', arg: 1 });
  assert.deepEqual(at("=SUM('a, b'!A1, |"), { name: 'SUM', arg: 1 });
  assert.deepEqual(at('=INDEX({1,2,3}, |'), { name: 'INDEX', arg: 1 });
  assert.deepEqual(at('=forecast.linear(|'), { name: 'FORECAST.LINEAR', arg: 0 });
  // Inside plain parentheses the call around them is the one.
  assert.deepEqual(at('=SUM((A1+|'), { name: 'SUM', arg: 0 });
  assert.equal(at('=A1+|'), null);
  assert.equal(at('text (not a formula|'), null);
});
