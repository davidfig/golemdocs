// The math tree as MathML (Presentation MathML, the subset browsers draw natively). It is what
// the Insert Equation dialog previews with, and what an HTML export writes for an equation.

import { classOf } from './classes.ts';
import { INTEGRALS } from './symbols.ts';
import type { MathEquation, MathList, MathNode, MathStyle } from './tree.ts';

const VARIANT: Partial<Record<MathStyle, string>> = {
  normal: 'normal',
  bold: 'bold',
  italic: 'italic',
  boldItalic: 'bold-italic',
  script: 'script',
  fraktur: 'fraktur',
  doubleStruck: 'double-struck',
  sansSerif: 'sans-serif',
  monospace: 'monospace',
};

/** Space characters and their widths in em (as `mspace` says them). */
const SPACES: Record<string, number> = { ' ': 3 / 18, ' ': 4 / 18, ' ': 5 / 18, ' ': 1, ' ': 0.5, ' ': 0.25, ' ': 0.25 };

const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const em = (n: number): string => `${Math.round(n * 1000) / 1000}em`;

/** An `mrow` unless the list is a single element already. */
function row(list: MathList): string {
  const parts = list.flatMap(node);
  return parts.length === 1 ? parts[0] : `<mrow>${parts.join('')}</mrow>`;
}

function operator(ch: string, attrs = ''): string {
  return `<mo${attrs}>${escape(ch)}</mo>`;
}

/** Text becomes numbers, identifiers, operators and spaces, one token each (letters of an upright word stay together). */
function text(t: string, style: MathStyle | undefined): string[] {
  const out: string[] = [];
  const variant = style ? VARIANT[style] : undefined;
  const chars = [...t];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '\n') continue;
    if (SPACES[ch] !== undefined) {
      if (ch === ' ' && style !== 'normal') continue;
      out.push(`<mspace width="${em(SPACES[ch])}"/>`);
    } else if (/[0-9]/.test(ch)) {
      let digits = ch;
      while (i + 1 < chars.length && /[0-9.]/.test(chars[i + 1]) && !(chars[i + 1] === '.' && !/[0-9]/.test(chars[i + 2] ?? ''))) digits += chars[++i];
      out.push(`<mn${variant ? ` mathvariant="${variant}"` : ''}>${digits}</mn>`);
    } else if (/\p{L}/u.test(ch) || style === 'normal') {
      let word = ch;
      // An upright run is one identifier (sin, max); other styles keep letters apart so a single one italicizes.
      while (style === 'normal' && i + 1 < chars.length && /\p{L}/u.test(chars[i + 1]) && /\p{L}/u.test(ch)) word += chars[++i];
      if (/^\p{L}+$/u.test(word)) out.push(`<mi${variant ? ` mathvariant="${variant}"` : ''}>${escape(word)}</mi>`);
      else out.push(style === 'normal' ? `<mtext>${escape(word)}</mtext>` : operator(word));
    } else {
      const cls = classOf(ch.codePointAt(0)!);
      const fence = cls === 'open' || cls === 'close' ? ' fence="false" stretchy="false"' : '';
      out.push(operator(ch, fence));
    }
  }
  return out;
}

function node(n: MathNode): string[] {
  switch (n.type) {
    case 'text':
      return text(n.text, n.style);
    case 'frac':
      if (n.fraction === 'linear' || n.fraction === 'skew') return [row(n.num), operator('/'), row(n.den)];
      return [`<mfrac${n.fraction === 'noBar' ? ' linethickness="0"' : ''}>${row(n.num)}${row(n.den)}</mfrac>`];
    case 'script': {
      const base = row(n.base);
      if (n.pre) return [`<mmultiscripts>${base}<mprescripts/>${n.sub ? row(n.sub) : '<none/>'}${n.sup ? row(n.sup) : '<none/>'}</mmultiscripts>`];
      if (n.sub && n.sup) return [`<msubsup>${base}${row(n.sub)}${row(n.sup)}</msubsup>`];
      if (n.sub) return [`<msub>${base}${row(n.sub)}</msub>`];
      if (n.sup) return [`<msup>${base}${row(n.sup)}</msup>`];
      return [base];
    }
    case 'rad':
      return [n.degree?.length ? `<mroot>${row(n.body)}${row(n.degree)}</mroot>` : `<msqrt>${row(n.body)}</msqrt>`];
    case 'nary': {
      const op = operator(n.op, ' largeop="true" movablelimits="true"');
      const integral = INTEGRALS.has(n.op);
      const above = (n.limits ?? (integral ? 'scripts' : 'aboveBelow')) === 'aboveBelow';
      let head = op;
      if (n.sub && n.sup) head = above ? `<munderover>${op}${row(n.sub)}${row(n.sup)}</munderover>` : `<msubsup>${op}${row(n.sub)}${row(n.sup)}</msubsup>`;
      else if (n.sub) head = above ? `<munder>${op}${row(n.sub)}</munder>` : `<msub>${op}${row(n.sub)}</msub>`;
      else if (n.sup) head = above ? `<mover>${op}${row(n.sup)}</mover>` : `<msup>${op}${row(n.sup)}</msup>`;
      return [head, ...n.body.flatMap(node)];
    }
    case 'delim': {
      const parts: string[] = [];
      if (n.open) parts.push(operator(n.open, ' fence="true" form="prefix"'));
      n.items.forEach((item, i) => {
        if (i > 0 && n.separator) parts.push(operator(n.separator, ' separator="true"'));
        parts.push(...item.flatMap(node));
      });
      if (n.close) parts.push(operator(n.close, ' fence="true" form="postfix"'));
      return [`<mrow>${parts.join('')}</mrow>`];
    }
    case 'func':
      return [`<mrow>${n.name.flatMap(node).join('')}<mo>&#x2061;</mo>${n.arg.flatMap(node).join('')}</mrow>`];
    case 'accent':
      return [`<mover accent="true">${row(n.base)}${operator(n.char.length === 1 && n.char.charCodeAt(0) >= 0x300 && n.char.charCodeAt(0) <= 0x36f ? spacingAccent(n.char) : n.char)}</mover>`];
    case 'bar':
      return [n.position === 'top' ? `<mover accent="true">${row(n.base)}${operator('‾')}</mover>` : `<munder accentunder="true">${row(n.base)}${operator('_')}</munder>`];
    case 'limit':
      return [n.position === 'lower' ? `<munder>${row(n.base)}${row(n.limit)}</munder>` : `<mover>${row(n.base)}${row(n.limit)}</mover>`];
    case 'matrix':
      return [`<mtable>${n.rows.map((r) => `<mtr>${r.map((c) => `<mtd>${row(c)}</mtd>`).join('')}</mtr>`).join('')}</mtable>`];
    case 'eqArray': {
      // `&` marks alignment: cells alternate right and left, as in an aligned environment.
      const rows = n.rows.map((r) => splitCells(r));
      const columns = Math.max(1, ...rows.map((r) => r.length));
      const align = Array.from({ length: columns }, (_, c) => (columns === 1 ? 'center' : c % 2 === 0 ? 'right' : 'left')).join(' ');
      return [`<mtable columnalign="${align}" columnspacing="0em">${rows.map((r) => `<mtr>${r.map((c) => `<mtd>${row(c)}</mtd>`).join('')}</mtr>`).join('')}</mtable>`];
    }
  }
}

/** The combining accents as the spacing characters MathML draws over a base. */
function spacingAccent(ch: string): string {
  return ({ '̂': '^', '̃': '~', '̄': '¯', '́': '´', '̀': '`', '̇': '˙', '̈': '¨', '̆': '˘', '̌': 'ˇ', '⃗': '→' } as Record<string, string>)[ch] ?? ch;
}

function splitCells(list: MathList): MathList[] {
  const cells: MathList[] = [[]];
  for (const n of list) {
    if (n.type !== 'text' || !n.text.includes('&')) {
      cells[cells.length - 1].push(n);
      continue;
    }
    n.text.split('&').forEach((piece, i) => {
      if (i > 0) cells.push([]);
      if (piece) cells[cells.length - 1].push({ ...n, text: piece });
    });
  }
  return cells;
}

/** An equation as a MathML `math` element (a string of markup). */
export function toMathML(equation: MathEquation): string {
  return `<math xmlns="http://www.w3.org/1998/Math/MathML" display="${equation.display ? 'block' : 'inline'}">${row(equation.content)}</math>`;
}
