// The keys of the Insert Equation dialog: structures (a fraction, a root, a sum...) and symbol
// sets, each inserting LaTeX at the caret. A structure marks where the caret goes with `§`; if
// text is selected, it goes there instead.

import { SYMBOLS } from '@word/docx';

export interface PaletteKey {
  /** What the key shows. */
  label: string;
  /** LaTeX to insert. */
  insert: string;
  /** What it is, for the tooltip and screen readers: the command it inserts. */
  tip: string;
}

export type PaletteId = 'structures' | 'greek' | 'operators' | 'relations' | 'arrows';

const structure = (label: string, insert: string, tip = insert.replace('§', '').replace(/[{}]/g, '').trim()): PaletteKey => ({ label, insert, tip });

const STRUCTURES: PaletteKey[] = [
  structure('a⁄b', '\\frac{§}{}', '\\frac'),
  structure('xⁿ', '^{§}', '^'),
  structure('xₙ', '_{§}', '_'),
  structure('xₙⁿ', '_{§}^{}', '_ ^'),
  structure('√', '\\sqrt{§}', '\\sqrt'),
  structure('ⁿ√', '\\sqrt[§]{}', '\\sqrt[n]'),
  structure('∑', '\\sum_{§}^{}', '\\sum'),
  structure('∏', '\\prod_{§}^{}', '\\prod'),
  structure('∫', '\\int_{§}^{}', '\\int'),
  structure('∮', '\\oint_{§}', '\\oint'),
  structure('lim', '\\lim_{§}', '\\lim'),
  structure('(  )', '\\left(§\\right)', '\\left( \\right)'),
  structure('[  ]', '\\left[§\\right]', '\\left[ \\right]'),
  structure('{  }', '\\left\\{§\\right\\}', '\\left\\{ \\right\\}'),
  structure('|  |', '\\left|§\\right|', '\\left| \\right|'),
  structure('⟨  ⟩', '\\left\\langle §\\right\\rangle', '\\langle \\rangle'),
  structure('(ⁿₖ)', '\\binom{§}{}', '\\binom'),
  structure('x̂', '\\hat{§}', '\\hat'),
  structure('x̄', '\\overline{§}', '\\overline'),
  structure('x⃗', '\\vec{§}', '\\vec'),
  structure('▦', '\\begin{pmatrix} § & \\\\ & \\end{pmatrix}', 'pmatrix'),
  structure('{ ▤', '\\begin{cases} § & \\\\ & \\end{cases}', 'cases'),
  structure('a=b', '\\begin{aligned} § &= \\\\ &= \\end{aligned}', 'aligned'),
];

const symbols = (names: string): PaletteKey[] =>
  names
    .split(' ')
    .filter((name) => SYMBOLS[name] !== undefined)
    .map((name) => ({ label: SYMBOLS[name], insert: `\\${name} `, tip: `\\${name}` }));

export const PALETTE: Record<PaletteId, PaletteKey[]> = {
  structures: STRUCTURES,
  greek: symbols(
    'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega',
  ),
  operators: symbols('pm mp times div cdot ast star circ bullet oplus otimes cap cup wedge vee setminus infty partial nabla forall exists neg emptyset ldots cdots vdots ddots'),
  relations: symbols('leq geq neq approx equiv sim simeq cong propto ll gg subset supset subseteq supseteq in notin ni perp parallel mid'),
  arrows: symbols('leftarrow rightarrow leftrightarrow Leftarrow Rightarrow Leftrightarrow uparrow downarrow mapsto longrightarrow hookrightarrow implies iff'),
};

export const PALETTE_TABS: PaletteId[] = ['structures', 'greek', 'operators', 'relations', 'arrows'];

/** Text with a key's LaTeX put in over the selection [from, to), and where the caret goes. */
export function insertKey(value: string, from: number, to: number, key: PaletteKey): { value: string; caret: number } {
  const selected = value.slice(from, to);
  const at = key.insert.indexOf('§');
  const insert = key.insert.replace('§', selected);
  return {
    value: value.slice(0, from) + insert + value.slice(to),
    caret: from + (at < 0 ? insert.length : at + selected.length),
  };
}
