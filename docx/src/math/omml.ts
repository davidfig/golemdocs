// SPDX-License-Identifier: MIT
// OMML (Office Math Markup Language, the m: namespace) to and from the math tree.
//
// Equations sit in a paragraph as `Raw` inlines holding an m:oMath (inline) or m:oMathPara
// (display) element, so they round-trip untouched and already count as one position for
// editing. This module reads that element into a MathEquation and writes one back when an
// equation is created or edited.

import type { Inline, Paragraph, Raw } from '../model/types.ts';
import { inlineLength } from '../edit/text.ts';
import { el, type XmlElement, type XmlNode } from '../xml/xml.ts';
import type { MathEquation, MathList, MathNode, MathStyle } from './tree.ts';

const MATH_ELEMENTS = new Set(['m:oMath', 'm:oMathPara']);

/** True for the Raw inline that holds an equation. */
export function isMathInline(inline: Inline): inline is Raw {
  return inline.kind === 'raw' && MATH_ELEMENTS.has(inline.xml.name);
}

/** A paragraph inline holding the equation, ready to insert. */
export function mathInline(equation: MathEquation): Raw {
  return { kind: 'raw', xml: writeOmml(equation) };
}

/** The equation held by a math inline. */
export function readMathInline(inline: Raw): MathEquation {
  return readOmml(inline.xml);
}

/** The equation at a model offset of a paragraph (the position it occupies), if there is one. */
export function mathAt(paragraph: Paragraph, offset: number): Raw | null {
  let pos = 0;
  const walk = (inlines: readonly Inline[]): Raw | null | undefined => {
    for (const inline of inlines) {
      const length = inlineLength(inline);
      if (offset < pos + length) {
        if (inline.kind === 'raw') return isMathInline(inline) ? inline : null;
        if (inline.kind === 'run') return null;
        return walk(inline.children);
      }
      pos += length;
    }
    return undefined;
  };
  return walk(paragraph.children) ?? null;
}

/** Merges neighbouring text nodes of the same style, so equal equations have equal trees. */
export function mergeText(list: MathList): MathList {
  const out: MathList = [];
  for (const node of list) {
    const last = out[out.length - 1];
    if (node.type === 'text' && last?.type === 'text' && last.style === node.style) out[out.length - 1] = { ...last, text: last.text + node.text };
    else out.push(node);
  }
  return out;
}

// --- Reading -----------------------------------------------------------------------------

const children = (e: XmlElement): XmlElement[] => e.children.filter((c): c is XmlElement => typeof c !== 'string');
const child = (e: XmlElement, name: string): XmlElement | undefined => children(e).find((c) => c.name === name);
const val = (e: XmlElement | undefined): string | undefined => e?.attrs['m:val'];

/** A property flag: present without a value or with a truthy one. */
function flag(e: XmlElement | undefined): boolean {
  if (!e) return false;
  const v = val(e);
  return v === undefined || v === '1' || v === 'on' || v === 'true';
}

function textOf(e: XmlElement): string {
  let out = '';
  for (const c of e.children) if (typeof c === 'string') out += c;
  return out;
}

const SCRIPT_STYLES: Record<string, MathStyle> = { script: 'script', fraktur: 'fraktur', 'double-struck': 'doubleStruck', 'sans-serif': 'sansSerif', monospace: 'monospace' };
const STY_STYLES: Record<string, MathStyle> = { p: 'normal', b: 'bold', i: 'italic', bi: 'boldItalic' };

function readRun(run: XmlElement): MathNode | null {
  let text = '';
  for (const c of children(run)) if (c.name === 'm:t') text += textOf(c);
  if (text === '') return null;
  const props = child(run, 'm:rPr');
  let style: MathStyle | undefined;
  if (props) {
    const scr = val(child(props, 'm:scr'));
    const sty = val(child(props, 'm:sty'));
    if (flag(child(props, 'm:nor'))) style = 'normal';
    else if (scr !== undefined && SCRIPT_STYLES[scr]) style = SCRIPT_STYLES[scr];
    else if (sty !== undefined) style = STY_STYLES[sty];
  }
  return style === undefined ? { type: 'text', text } : { type: 'text', text, style };
}

/** The contents of an argument element (m:e, m:num, m:sub...) or of m:oMath itself. */
function readList(container: XmlElement | undefined): MathList {
  if (!container) return [];
  const out: MathList = [];
  for (const c of children(container)) readNode(c, out);
  return mergeText(out);
}

function optional(list: MathList): MathList | undefined {
  return list.length ? list : undefined;
}

function readNode(e: XmlElement, out: MathList): void {
  const arg = (name: string) => readList(child(e, name));
  switch (e.name) {
    case 'm:r': {
      const node = readRun(e);
      if (node) out.push(node);
      return;
    }
    case 'm:f': {
      const type = val(child(child(e, 'm:fPr') ?? e, 'm:type'));
      const fraction = type === 'noBar' ? 'noBar' : type === 'skw' ? 'skew' : type === 'lin' ? 'linear' : undefined;
      out.push(fraction ? { type: 'frac', num: arg('m:num'), den: arg('m:den'), fraction } : { type: 'frac', num: arg('m:num'), den: arg('m:den') });
      return;
    }
    case 'm:sSup':
      out.push({ type: 'script', base: arg('m:e'), sup: arg('m:sup') });
      return;
    case 'm:sSub':
      out.push({ type: 'script', base: arg('m:e'), sub: arg('m:sub') });
      return;
    case 'm:sSubSup':
      out.push({ type: 'script', base: arg('m:e'), sub: arg('m:sub'), sup: arg('m:sup') });
      return;
    case 'm:sPre':
      out.push({ type: 'script', base: arg('m:e'), sub: optional(arg('m:sub')), sup: optional(arg('m:sup')), pre: true });
      return;
    case 'm:rad': {
      const hidden = flag(child(child(e, 'm:radPr') ?? e, 'm:degHide'));
      const degree = hidden ? [] : arg('m:deg');
      out.push(degree.length ? { type: 'rad', body: arg('m:e'), degree } : { type: 'rad', body: arg('m:e') });
      return;
    }
    case 'm:nary': {
      const props = child(e, 'm:naryPr') ?? e;
      const chr = val(child(props, 'm:chr'));
      const limLoc = val(child(props, 'm:limLoc'));
      const sub = flag(child(props, 'm:subHide')) ? [] : arg('m:sub');
      const sup = flag(child(props, 'm:supHide')) ? [] : arg('m:sup');
      const node: MathNode = { type: 'nary', op: chr ?? '∫', body: arg('m:e') };
      if (sub.length) node.sub = sub;
      if (sup.length) node.sup = sup;
      if (limLoc === 'undOvr') node.limits = 'aboveBelow';
      else if (limLoc === 'subSup') node.limits = 'scripts';
      out.push(node);
      return;
    }
    case 'm:d': {
      const props = child(e, 'm:dPr') ?? e;
      const get = (name: string, fallback: string) => val(child(props, name)) ?? fallback;
      out.push({
        type: 'delim',
        open: get('m:begChr', '('),
        close: get('m:endChr', ')'),
        separator: get('m:sepChr', '|'),
        items: children(e)
          .filter((c) => c.name === 'm:e')
          .map((c) => readList(c)),
      });
      return;
    }
    case 'm:func':
      out.push({ type: 'func', name: arg('m:fName'), arg: arg('m:e') });
      return;
    case 'm:acc':
      out.push({ type: 'accent', char: val(child(child(e, 'm:accPr') ?? e, 'm:chr')) ?? '̂', base: arg('m:e') });
      return;
    case 'm:bar':
      out.push({ type: 'bar', position: val(child(child(e, 'm:barPr') ?? e, 'm:pos')) === 'top' ? 'top' : 'bottom', base: arg('m:e') });
      return;
    case 'm:limLow':
      out.push({ type: 'limit', position: 'lower', base: arg('m:e'), limit: arg('m:lim') });
      return;
    case 'm:limUpp':
      out.push({ type: 'limit', position: 'upper', base: arg('m:e'), limit: arg('m:lim') });
      return;
    case 'm:m':
      out.push({
        type: 'matrix',
        rows: children(e)
          .filter((c) => c.name === 'm:mr')
          .map((row) => children(row).filter((c) => c.name === 'm:e').map((c) => readList(c))),
      });
      return;
    case 'm:eqArr':
      out.push({ type: 'eqArray', rows: children(e).filter((c) => c.name === 'm:e').map((c) => readList(c)) });
      return;
    case 'm:box':
    case 'm:borderBox':
    case 'm:phant':
    case 'm:groupChr':
      // Presentation-only wrappers: keep their content.
      out.push(...readList(child(e, 'm:e')));
      return;
    default:
    // Properties (m:...Pr), control properties and anything unknown carry no content.
  }
}

/** Reads an m:oMath or m:oMathPara element. */
export function readOmml(xml: XmlElement): MathEquation {
  if (xml.name === 'm:oMath') return { display: false, content: readList(xml) };
  const rows = children(xml)
    .filter((c) => c.name === 'm:oMath')
    .map((c) => readList(c));
  return { display: true, content: rows.length === 1 ? rows[0] : rows.length ? [{ type: 'eqArray', rows }] : [] };
}

// --- Writing -----------------------------------------------------------------------------

const M_FONT = el('w:rPr', {}, [el('w:rFonts', { 'w:ascii': 'Cambria Math', 'w:hAnsi': 'Cambria Math' })]);

function writeRun(node: Extract<MathNode, { type: 'text' }>): XmlElement {
  const props: XmlElement[] = [];
  switch (node.style) {
    case 'normal':
      props.push(el('m:sty', { 'm:val': 'p' }));
      break;
    case 'bold':
      props.push(el('m:sty', { 'm:val': 'b' }));
      break;
    case 'italic':
      props.push(el('m:sty', { 'm:val': 'i' }));
      break;
    case 'boldItalic':
      props.push(el('m:sty', { 'm:val': 'bi' }));
      break;
    case 'script':
    case 'fraktur':
    case 'doubleStruck':
    case 'sansSerif':
    case 'monospace': {
      const scr = { script: 'script', fraktur: 'fraktur', doubleStruck: 'double-struck', sansSerif: 'sans-serif', monospace: 'monospace' }[node.style];
      props.push(el('m:scr', { 'm:val': scr }), el('m:sty', { 'm:val': 'p' }));
      break;
    }
    default:
  }
  const t = el('m:t', /^\s|\s$/.test(node.text) ? { 'xml:space': 'preserve' } : {}, [node.text]);
  return el('m:r', {}, [...(props.length ? [el('m:rPr', {}, props)] : []), structuredClone(M_FONT), t]);
}

function arg(name: string, list: MathList | undefined): XmlElement {
  return el(name, {}, (list ?? []).map(writeNode));
}

function writeNode(node: MathNode): XmlElement {
  switch (node.type) {
    case 'text':
      return writeRun(node);
    case 'frac': {
      const type = node.fraction === 'noBar' ? 'noBar' : node.fraction === 'skew' ? 'skw' : node.fraction === 'linear' ? 'lin' : undefined;
      return el('m:f', {}, [...(type ? [el('m:fPr', {}, [el('m:type', { 'm:val': type })])] : []), arg('m:num', node.num), arg('m:den', node.den)]);
    }
    case 'script':
      if (node.pre) return el('m:sPre', {}, [arg('m:sub', node.sub), arg('m:sup', node.sup), arg('m:e', node.base)]);
      if (node.sub && node.sup) return el('m:sSubSup', {}, [arg('m:e', node.base), arg('m:sub', node.sub), arg('m:sup', node.sup)]);
      if (node.sub) return el('m:sSub', {}, [arg('m:e', node.base), arg('m:sub', node.sub)]);
      return el('m:sSup', {}, [arg('m:e', node.base), arg('m:sup', node.sup)]);
    case 'rad':
      return el('m:rad', {}, [...(node.degree?.length ? [] : [el('m:radPr', {}, [el('m:degHide', { 'm:val': 1 })])]), arg('m:deg', node.degree), arg('m:e', node.body)]);
    case 'nary': {
      const props = [el('m:chr', { 'm:val': node.op })];
      if (node.limits) props.push(el('m:limLoc', { 'm:val': node.limits === 'aboveBelow' ? 'undOvr' : 'subSup' }));
      if (!node.sub?.length) props.push(el('m:subHide', { 'm:val': 1 }));
      if (!node.sup?.length) props.push(el('m:supHide', { 'm:val': 1 }));
      return el('m:nary', {}, [el('m:naryPr', {}, props), arg('m:sub', node.sub), arg('m:sup', node.sup), arg('m:e', node.body)]);
    }
    case 'delim': {
      const props = [el('m:begChr', { 'm:val': node.open })];
      if (node.items.length > 1) props.push(el('m:sepChr', { 'm:val': node.separator }));
      props.push(el('m:endChr', { 'm:val': node.close }));
      return el('m:d', {}, [el('m:dPr', {}, props), ...node.items.map((item) => arg('m:e', item))]);
    }
    case 'func':
      return el('m:func', {}, [arg('m:fName', node.name), arg('m:e', node.arg)]);
    case 'accent':
      return el('m:acc', {}, [el('m:accPr', {}, [el('m:chr', { 'm:val': node.char })]), arg('m:e', node.base)]);
    case 'bar':
      return el('m:bar', {}, [el('m:barPr', {}, [el('m:pos', { 'm:val': node.position === 'top' ? 'top' : 'bot' })]), arg('m:e', node.base)]);
    case 'limit':
      return el(node.position === 'lower' ? 'm:limLow' : 'm:limUpp', {}, [arg('m:e', node.base), arg('m:lim', node.limit)]);
    case 'matrix':
      return el('m:m', {}, node.rows.map((row) => el('m:mr', {}, row.map((cell) => arg('m:e', cell)))));
    case 'eqArray':
      return el('m:eqArr', {}, node.rows.map((row) => arg('m:e', row)));
  }
}

/** The m:oMath (inline) or m:oMathPara (display) element for an equation. */
export function writeOmml(equation: MathEquation): XmlElement {
  const math = el('m:oMath', {}, equation.content.map(writeNode) as XmlNode[]);
  return equation.display ? el('m:oMathPara', {}, [math]) : math;
}
