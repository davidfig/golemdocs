// SPDX-License-Identifier: MIT
// Presentation MathML to the math tree: what an HTML page's <math> holds, and what toMathML()
// writes. It reads the common elements (tokens, rows, fractions, roots, scripts, under/over
// scripts, fences, tables); anything else contributes its children.

import type { MathEquation, MathList, MathNode, MathStyle } from './tree.ts';

/** An element, as the HTML and XML parsers give it (attribute values may be missing). */
export interface MathMLElement {
  name: string;
  attrs: Record<string, string | undefined>;
  children: readonly (MathMLElement | string)[];
}

const VARIANT_STYLE: Record<string, MathStyle> = {
  normal: 'normal',
  bold: 'bold',
  italic: 'italic',
  'bold-italic': 'boldItalic',
  script: 'script',
  'bold-script': 'script',
  fraktur: 'fraktur',
  'bold-fraktur': 'fraktur',
  'double-struck': 'doubleStruck',
  'sans-serif': 'sansSerif',
  'bold-sans-serif': 'sansSerif',
  monospace: 'monospace',
};

const FENCE_PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '|': '|', '⟨': '⟩', '⌊': '⌋', '⌈': '⌉', '‖': '‖' };
const COMBINING: Record<string, string> = { '^': '̂', '~': '̃', '¯': '̄', '´': '́', '`': '̀', '˙': '̇', '¨': '̈', '˘': '̆', ˇ: '̌', '→': '⃗' };
const LARGE_OPERATORS = new Set([...'∑∏∐∫∬∭∮∯∰⋃⋂⋁⋀⨁⨂⨀⨄⨆']);

const local = (name: string): string => name.replace(/^.*:/, '').toLowerCase();
const isElement = (n: MathMLElement | string): n is MathMLElement => typeof n !== 'string';

/** The text of an element, whitespace trimmed (MathML ignores it around tokens). */
function textOf(el: MathMLElement): string {
  let out = '';
  for (const c of el.children) out += isElement(c) ? textOf(c) : c;
  return out.replace(/\s+/g, ' ').trim();
}

const kids = (el: MathMLElement): MathMLElement[] => el.children.filter(isElement);

function spaceFor(width: string | undefined): string {
  const m = /^(-?[\d.]+)(em|ex|px)?$/.exec(width ?? '');
  const em = m ? Number(m[1]) * (m[2] === 'ex' ? 0.5 : m[2] === 'px' ? 1 / 16 : 1) : 0.25;
  if (em <= 0) return '';
  return em < 0.2 ? ' ' : em < 0.25 ? ' ' : em < 0.5 ? ' ' : ' ';
}

class Reader {
  list(els: readonly (MathMLElement | string)[]): MathList {
    const out: MathList = [];
    for (const el of els) if (isElement(el)) this.node(el, out);
    return mergeTexts(out);
  }

  private one(el: MathMLElement | undefined): MathList {
    if (!el) return [];
    const out: MathList = [];
    this.node(el, out);
    return mergeTexts(out);
  }

  private token(el: MathMLElement, out: MathList): void {
    const name = local(el.name);
    const text = textOf(el).replace(/[⁡-⁤]/g, '');
    if (!text) return;
    const variant = el.attrs.mathvariant ? VARIANT_STYLE[el.attrs.mathvariant] : undefined;
    let style = variant;
    // An identifier of several letters is a name (sin, max), upright; a single letter is a variable, italic by default.
    if (name === 'mi' && !style && [...text].length > 1) style = 'normal';
    if (name === 'mtext' && !style) style = 'normal';
    out.push(style ? { type: 'text', text, style } : { type: 'text', text });
  }

  private node(el: MathMLElement, out: MathList): void {
    const name = local(el.name);
    const c = kids(el);
    switch (name) {
      case 'mi':
      case 'mn':
      case 'mo':
      case 'mtext':
      case 'ms':
        this.token(el, out);
        return;
      case 'mspace': {
        const space = spaceFor(el.attrs.width);
        if (space) out.push({ type: 'text', text: space, style: 'normal' });
        return;
      }
      case 'mrow':
        this.row(c, out);
        return;
      case 'mfrac': {
        const fraction = /^0(\.0*)?(px|em|pt)?$/.test(el.attrs.linethickness ?? '') ? ('noBar' as const) : undefined;
        out.push({ type: 'frac', num: this.one(c[0]), den: this.one(c[1]), ...(fraction && { fraction }) });
        return;
      }
      case 'msqrt':
        out.push({ type: 'rad', body: this.list(c) });
        return;
      case 'mroot':
        out.push({ type: 'rad', body: this.one(c[0]), degree: this.one(c[1]) });
        return;
      case 'msub':
      case 'msup':
      case 'msubsup': {
        const base = c[0];
        const sub = name === 'msup' ? undefined : this.one(c[1]);
        const sup = name === 'msub' ? undefined : this.one(c[name === 'msup' ? 1 : 2]);
        const op = this.largeOperator(base);
        if (op) out.push({ type: 'nary', op, ...(sub?.length && { sub }), ...(sup?.length && { sup }), body: [], limits: 'scripts' });
        else out.push({ type: 'script', base: this.one(base), ...(sub && { sub }), ...(sup && { sup }) });
        return;
      }
      case 'mmultiscripts': {
        const at = c.findIndex((x) => local(x.name) === 'mprescripts');
        const post = at < 0 ? c.slice(1) : c.slice(1, at);
        const pre = at < 0 ? [] : c.slice(at + 1);
        const script = (list: MathMLElement[]) => {
          const isNone = (e: MathMLElement | undefined) => !e || local(e.name) === 'none';
          return { sub: isNone(list[0]) ? undefined : this.one(list[0]), sup: isNone(list[1]) ? undefined : this.one(list[1]) };
        };
        const post_ = script(post);
        const pre_ = script(pre);
        let base = this.one(c[0]);
        if (post_.sub || post_.sup) base = [{ type: 'script', base, ...(post_.sub && { sub: post_.sub }), ...(post_.sup && { sup: post_.sup }) }];
        if (pre_.sub || pre_.sup) out.push({ type: 'script', base, ...(pre_.sub && { sub: pre_.sub }), ...(pre_.sup && { sup: pre_.sup }), pre: true });
        else out.push(...base);
        return;
      }
      case 'munder':
      case 'mover':
      case 'munderover': {
        const base = c[0];
        const under = name === 'mover' ? undefined : c[1];
        const over = name === 'munder' ? undefined : c[name === 'mover' ? 1 : 2];
        const op = this.largeOperator(base);
        if (op) {
          const sub = under ? this.one(under) : undefined;
          const sup = over ? this.one(over) : undefined;
          out.push({ type: 'nary', op, ...(sub?.length && { sub }), ...(sup?.length && { sup }), body: [], limits: 'aboveBelow' });
        } else if (name === 'mover' && over && local(over.name) === 'mo') {
          // An accent, or an overbar.
          const mark = textOf(over);
          if (mark === '‾' || mark === '¯' || mark === '—') out.push({ type: 'bar', position: 'top', base: this.one(base) });
          else out.push({ type: 'accent', char: COMBINING[mark] ?? mark, base: this.one(base) });
        } else if (name === 'munder' && under && local(under.name) === 'mo' && ['_', '‗', '▁'].includes(textOf(under))) {
          out.push({ type: 'bar', position: 'bottom', base: this.one(base) });
        } else if (name === 'munderover') {
          out.push({ type: 'limit', position: 'upper', base: [{ type: 'limit', position: 'lower', base: this.one(base), limit: this.one(under) }], limit: this.one(over) });
        } else if (under) out.push({ type: 'limit', position: 'lower', base: this.one(base), limit: this.one(under) });
        else if (over) out.push({ type: 'limit', position: 'upper', base: this.one(base), limit: this.one(over) });
        return;
      }
      case 'mfenced': {
        const open = el.attrs.open ?? '(';
        const close = el.attrs.close ?? ')';
        const separators = (el.attrs.separators ?? ',').trim();
        out.push({ type: 'delim', open, close, separator: separators[0] ?? ',', items: c.map((x) => this.one(x)) });
        return;
      }
      case 'mtable': {
        const rows = c.filter((r) => ['mtr', 'mlabeledtr'].includes(local(r.name))).map((r) => kids(r).filter((x) => local(x.name) === 'mtd').map((x) => this.list(x.children)));
        const columns = Math.max(0, ...rows.map((r) => r.length));
        // Alternating right and left columns (what an aligned environment writes) are aligned lines.
        if (/right\s+left/.test(el.attrs.columnalign ?? '') && columns >= 2) {
          out.push({ type: 'eqArray', rows: rows.map((r) => mergeTexts(r.flatMap((cell, i) => (i > 0 ? [{ type: 'text' as const, text: '&' }, ...cell] : cell)))) });
        } else if (columns <= 1 && rows.length && el.attrs.columnalign === 'center') out.push({ type: 'eqArray', rows: rows.map((r) => r[0] ?? []) });
        else out.push({ type: 'matrix', rows });
        return;
      }
      case 'mtr':
      case 'mtd':
      case 'mstyle':
      case 'mpadded':
      case 'mphantom':
      case 'menclose':
      case 'merror':
        this.row(c, out);
        return;
      case 'semantics':
        if (c[0]) this.node(c[0], out);
        return;
      case 'annotation':
      case 'annotation-xml':
      case 'none':
      case 'mprescripts':
        return;
      default:
        this.row(c, out);
    }
  }

  /** A row: `mo fence="true"` at both ends with a matching pair make delimiters; otherwise its children in order. */
  private row(c: MathMLElement[], out: MathList): void {
    const first = c[0];
    const last = c[c.length - 1];
    if (c.length >= 2 && first && last && local(first.name) === 'mo' && local(last.name) === 'mo' && first.attrs.fence === 'true' && last.attrs.fence === 'true') {
      const open = textOf(first);
      const close = textOf(last);
      if (FENCE_PAIRS[open] === close || open === '' || close === '') {
        const items: MathList[] = [[]];
        let separator = '|';
        for (const x of c.slice(1, -1)) {
          if (local(x.name) === 'mo' && x.attrs.separator === 'true') {
            separator = textOf(x) || separator;
            items.push([]);
          } else this.node(x, items[items.length - 1]);
        }
        out.push({ type: 'delim', open, close, separator, items: items.map(mergeTexts) });
        return;
      }
    }
    for (const x of c) this.node(x, out);
  }

  /** The operator character of an element that is a large operator, if it is. */
  private largeOperator(el: MathMLElement | undefined): string | null {
    if (!el || local(el.name) !== 'mo') return null;
    const text = textOf(el);
    return el.attrs.largeop === 'true' || LARGE_OPERATORS.has(text) ? (text.length === 1 || LARGE_OPERATORS.has(text) ? text : null) : null;
  }
}

function mergeTexts(list: MathList): MathList {
  const out: MathList = [];
  for (const n of list) {
    const last = out[out.length - 1];
    if (n.type === 'text' && last?.type === 'text' && last.style === n.style) out[out.length - 1] = { ...last, text: last.text + n.text };
    else out.push(n);
  }
  return out;
}

/** Reads a MathML `math` element. */
export function fromMathML(math: MathMLElement): MathEquation {
  const reader = new Reader();
  return { display: math.attrs.display === 'block', content: reader.list(math.children) };
}

export type { MathNode };
