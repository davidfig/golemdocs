// The math tree: a typed view of an equation, shared by the OMML reader and writer, the LaTeX
// parser and printer, and (later) math layout. It follows OMML's structures (fraction, script,
// radical, n-ary operator, delimiters, matrix...) because that is what documents store.
//
// The tree is a view, not the source of truth: an equation in a document is kept as its OMML
// element (see omml.ts) and only re-generated from a tree when the equation is edited.

/** Letter style. Undefined is "automatic": layout italicizes single Latin letters and Greek. */
export type MathStyle = 'normal' | 'bold' | 'italic' | 'boldItalic' | 'script' | 'fraktur' | 'doubleStruck' | 'sansSerif' | 'monospace';

export type MathList = MathNode[];

export interface MathText {
  type: 'text';
  text: string;
  style?: MathStyle;
}

export interface MathFraction {
  type: 'frac';
  num: MathList;
  den: MathList;
  /** "bar" is the default. */
  fraction?: 'bar' | 'noBar' | 'skew' | 'linear';
}

export interface MathScript {
  type: 'script';
  base: MathList;
  sub?: MathList;
  sup?: MathList;
  /** Scripts come before the base (m:sPre). */
  pre?: boolean;
}

export interface MathRadical {
  type: 'rad';
  body: MathList;
  degree?: MathList;
}

export interface MathNary {
  type: 'nary';
  /** The operator character: ∑ ∏ ∫ ⋃ ... */
  op: string;
  sub?: MathList;
  sup?: MathList;
  body: MathList;
  /** Limits above and below the operator, or as scripts beside it. Default: scripts for integrals, above/below otherwise. */
  limits?: 'aboveBelow' | 'scripts';
}

export interface MathDelimited {
  type: 'delim';
  /** Empty string for none. */
  open: string;
  close: string;
  /** Between items when there are several. */
  separator: string;
  items: MathList[];
}

export interface MathFunction {
  type: 'func';
  name: MathList;
  arg: MathList;
}

export interface MathAccent {
  type: 'accent';
  /** A combining character (U+0302 hat...) or arrow. */
  char: string;
  base: MathList;
}

export interface MathBar {
  type: 'bar';
  position: 'top' | 'bottom';
  base: MathList;
}

export interface MathLimit {
  type: 'limit';
  position: 'lower' | 'upper';
  base: MathList;
  limit: MathList;
}

export interface MathMatrix {
  type: 'matrix';
  /** Rows of cells. */
  rows: MathList[][];
}

/** Lines of an aligned or multi-line equation. `&` in a text node marks an alignment point. */
export interface MathEqArray {
  type: 'eqArray';
  rows: MathList[];
}

export type MathNode = MathText | MathFraction | MathScript | MathRadical | MathNary | MathDelimited | MathFunction | MathAccent | MathBar | MathLimit | MathMatrix | MathEqArray;

/** An equation: inline in running text, or on a line of its own (display). */
export interface MathEquation {
  display: boolean;
  content: MathList;
}
