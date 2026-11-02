// SPDX-License-Identifier: MIT
// The LaTeX vocabulary the math parser and printer share: symbol names and the characters
// they stand for. The first name listed for a character is the one the printer writes.

import type { MathStyle } from './tree.ts';

/** Space-like characters, in em fractions the layout gives them. */
export const SPACES: Record<string, string> = {
  ',': ' ',
  ':': ' ',
  '>': ' ',
  ';': ' ',
  quad: ' ',
  qquad: '  ',
  ' ': ' ',
};

function table(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of source.trim().split(/\s+/)) {
    const eq = entry.indexOf('=');
    out[entry.slice(0, eq)] = String.fromCodePoint(parseInt(entry.slice(eq + 1), 16));
  }
  return out;
}

const GREEK = `alpha=3B1 beta=3B2 gamma=3B3 delta=3B4 varepsilon=3B5 zeta=3B6 eta=3B7 theta=3B8 iota=3B9 kappa=3BA lambda=3BB mu=3BC nu=3BD xi=3BE
pi=3C0 rho=3C1 varsigma=3C2 sigma=3C3 tau=3C4 upsilon=3C5 varphi=3C6 chi=3C7 psi=3C8 omega=3C9
epsilon=3F5 vartheta=3D1 varpi=3D6 varrho=3F1 varkappa=3F0 phi=3D5
Gamma=393 Delta=394 Theta=398 Lambda=39B Xi=39E Pi=3A0 Sigma=3A3 Upsilon=3A5 Phi=3A6 Psi=3A8 Omega=3A9`;

const OPERATORS = `pm=B1 mp=2213 times=D7 div=F7 cdot=22C5 ast=2217 star=22C6 circ=2218 bullet=2219 oplus=2295 ominus=2296 otimes=2297 oslash=2298 odot=2299
wedge=2227 land=2227 vee=2228 lor=2228 cap=2229 cup=222A setminus=2216 sqcap=2293 sqcup=2294 uplus=228E dagger=2020 ddagger=2021 diamond=22C4
amalg=2A3F wr=2240 triangleleft=25C1 triangleright=25B7 bigtriangleup=25B3 bigtriangledown=25BD`;

const RELATIONS = `leq=2264 le=2264 geq=2265 ge=2265 neq=2260 ne=2260 approx=2248 equiv=2261 sim=223C simeq=2243 cong=2245 propto=221D ll=226A gg=226B
prec=227A succ=227B preceq=2AAF succeq=2AB0 subset=2282 supset=2283 subseteq=2286 supseteq=2287 in=2208 ni=220B notin=2209 perp=22A5
parallel=2225 mid=2223 nmid=2224 vdash=22A2 dashv=22A3 models=22A8 asymp=224D doteq=2250 sqsubseteq=2291 sqsupseteq=2292
subsetneq=228A supsetneq=228B nsubseteq=2288 nsupseteq=2289 bowtie=22C8 smile=2323 frown=2322 ncong=2247 nsim=2241 nleq=2270 ngeq=2271
lesssim=2272 gtrsim=2273 approxeq=224A ll=226A trianglelefteq=22B4 trianglerighteq=22B5 sqsubset=228F sqsupset=2290 nless=226E ngtr=226F`;

const ARROWS = `leftarrow=2190 gets=2190 rightarrow=2192 to=2192 leftrightarrow=2194 Leftarrow=21D0 Rightarrow=21D2 Leftrightarrow=21D4
uparrow=2191 downarrow=2193 updownarrow=2195 Uparrow=21D1 Downarrow=21D3 Updownarrow=21D5 mapsto=21A6 longmapsto=27FC
longrightarrow=27F6 longleftarrow=27F5 longleftrightarrow=27F7 Longrightarrow=27F9 Longleftarrow=27F8 Longleftrightarrow=27FA
iff=27FA implies=27F9 impliedby=27F8 hookrightarrow=21AA hookleftarrow=21A9 rightharpoonup=21C0 leftharpoonup=21BC
rightharpoondown=21C1 leftharpoondown=21BD rightleftharpoons=21CC nearrow=2197 searrow=2198 swarrow=2199 nwarrow=2196 leadsto=21DD rightsquigarrow=21DD`;

const MISC = `infty=221E partial=2202 nabla=2207 forall=2200 exists=2203 nexists=2204 emptyset=2205 varnothing=2205 neg=AC lnot=AC top=22A4 bot=22A5
angle=2220 measuredangle=2221 triangle=25B3 prime=2032 backprime=2035 hbar=210F ell=2113 Re=211C Im=2111 aleph=2135 beth=2136 wp=2118
imath=131 jmath=237 degree=B0 sharp=266F flat=266D natural=266E clubsuit=2663 diamondsuit=2662 heartsuit=2661 spadesuit=2660
square=25A1 Box=25A1 blacksquare=25A0 checkmark=2713 ldots=2026 dots=2026 cdots=22EF vdots=22EE ddots=22F1 therefore=2234 because=2235
surd=221A backslash=5C lbrace=7B rbrace=7D dag=2020 ddag=2021 S=A7 P=B6 copyright=A9 pounds=A3 mho=2127 complement=2201 Finv=2132`;

/** Symbols usable anywhere in math. */
export const SYMBOLS: Record<string, string> = { ...table(GREEK), ...table(OPERATORS), ...table(RELATIONS), ...table(ARROWS), ...table(MISC) };

/** Large operators. */
export const NARY: Record<string, string> = table(`sum=2211 prod=220F coprod=2210 int=222B iint=222C iiint=222D oint=222E oiint=222F oiiint=2230
bigcup=22C3 bigcap=22C2 bigvee=22C1 bigwedge=22C0 bigoplus=2A01 bigotimes=2A02 bigodot=2A00 biguplus=2A04 bigsqcup=2A06`);

/** Operators whose default limits sit beside them, as scripts. */
export const INTEGRALS = new Set(['∫', '∬', '∭', '∮', '∯', '∰']);

/** Function names set upright: \sin, \log... */
export const FUNCTIONS = new Set(
  'sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh coth log ln lg exp det gcd lim limsup liminf max min sup inf arg deg dim hom ker Pr'.split(' '),
);
/** Functions that carry their subscript underneath. */
export const LIMIT_FUNCTIONS = new Set('lim limsup liminf max min sup inf det gcd Pr'.split(' '));

/** Accent commands to the combining character. */
export const ACCENTS: Record<string, string> = table(`hat=302 check=30C tilde=303 acute=301 grave=300 dot=307 ddot=308 breve=306 bar=304 vec=20D7
widehat=302 widetilde=303 mathring=30A dddot=20DB`);

/** Delimiter commands to the character. */
export const DELIMITERS: Record<string, string> = {
  ...table('langle=27E8 rangle=27E9 lfloor=230A rfloor=230B lceil=2308 rceil=2309 lVert=2016 rVert=2016 Vert=2016 vert=7C lvert=7C rvert=7C lbrace=7B rbrace=7D lgroup=27EE rgroup=27EF backslash=5C uparrow=2191 downarrow=2193 updownarrow=2195'),
  '{': '{',
  '}': '}',
  '|': '‖',
};

/** Font commands to the style they give their argument. */
export const STYLE_COMMANDS: Record<string, MathStyle> = {
  mathrm: 'normal',
  mathnormal: 'normal',
  textrm: 'normal',
  mathbf: 'bold',
  textbf: 'bold',
  boldsymbol: 'boldItalic',
  bm: 'boldItalic',
  mathit: 'italic',
  textit: 'italic',
  mathbb: 'doubleStruck',
  mathcal: 'script',
  mathscr: 'script',
  mathfrak: 'fraktur',
  mathsf: 'sansSerif',
  textsf: 'sansSerif',
  mathtt: 'monospace',
  texttt: 'monospace',
};

/** Printer names by style. */
export const STYLE_NAMES: Record<MathStyle, string> = {
  normal: 'mathrm',
  bold: 'mathbf',
  italic: 'mathit',
  boldItalic: 'boldsymbol',
  script: 'mathcal',
  fraktur: 'mathfrak',
  doubleStruck: 'mathbb',
  sansSerif: 'mathsf',
  monospace: 'mathtt',
};

/** Character to command name, for printing. The first name wins. */
function reverse(...tables: Record<string, string>[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of tables) for (const name in t) if (!out.has(t[name])) out.set(t[name], name);
  return out;
}

export const SYMBOL_NAMES = reverse(SYMBOLS);
export const NARY_NAMES = reverse(NARY);
export const ACCENT_NAMES = reverse(ACCENTS);
export const DELIMITER_NAMES = reverse({ langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉' });
export const SPACE_NAMES = new Map<string, string>(Object.entries(SPACES).map(([name, chars]) => [chars, name]));

/** Characters that end an operator's operand: relations, binary operators and separators. */
const STOPS = new Set('+-−=<>,;&±∓×÷⋅∗∘≤≥≠≈≡∼≃≅∝∈∉∋⊂⊃⊆⊇∪∩∧∨→←↔⇒⇐⇔↦⟶⟹⟺∖⊕⊗≪≫≺≻⊥∥∣'.split(''));
export const isOperatorChar = (c: string): boolean => STOPS.has(c);
