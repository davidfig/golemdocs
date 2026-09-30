// TeX's atom classes for characters in math: they decide the space around a character in
// layout (see layout's math/layout.ts) and whether MathML draws it as an operator.

/** TeX's atom classes. */
export type AtomClass = 'ord' | 'op' | 'bin' | 'rel' | 'open' | 'close' | 'punct';

const BINARY = new Set([...'+−±∓×÷⋅∗∘∙∧∨∩∪⊕⊖⊗⊘⊙∖⊓⊔⊎†‡⋆⋄◁▷△▽⨿≀·'].map((c) => c.codePointAt(0)!));
const OPENING = new Set([...'([{⟨⌊⌈⟦⟪⟮'].map((c) => c.codePointAt(0)!));
const CLOSING = new Set([...')]}⟩⌋⌉⟧⟫⟯'].map((c) => c.codePointAt(0)!));
const PUNCTUATION = new Set([...',;'].map((c) => c.codePointAt(0)!));
const RELATIONS = new Set([...'=<>≤≥≠≈≡∼≃≅∝∈∉∋⊂⊃⊆⊇⊥∥∣∤⊢⊣⊨≍≐⊑⊒⊊⊋⊈⊉⋈⌣⌢≇≁≰≱≲≳≊⊴⊵≪≫≺≻⪯⪰≮≯:∴∵'].map((c) => c.codePointAt(0)!));

export function classOf(cp: number): AtomClass {
  if (BINARY.has(cp)) return 'bin';
  if (RELATIONS.has(cp)) return 'rel';
  if (OPENING.has(cp)) return 'open';
  if (CLOSING.has(cp)) return 'close';
  if (PUNCTUATION.has(cp)) return 'punct';
  // Arrows (all blocks), and the relation-like operators of Supplemental Mathematical Operators.
  if ((cp >= 0x2190 && cp <= 0x21ff) || (cp >= 0x27f0 && cp <= 0x27ff) || (cp >= 0x2900 && cp <= 0x297f)) return 'rel';
  return 'ord';
}

