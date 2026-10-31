// SPDX-License-Identifier: MIT
// Math layout: turns a math tree into positioned glyphs and rules, following the TeX algorithm
// (The TeXbook, Appendix G) with the parameters of an OpenType MATH table (the constants,
// italic corrections, accent attachment points, size variants and glyph assemblies in MathData).
//
// Everything is in ems of the base font size, so the caller scales the result by the font size.
// Inside, y grows upward from the baseline (as in TeX's formulas); layoutMath() returns y-down,
// as the rest of layout expects. Scripts are drawn by glyph instances of a smaller `size`; the
// only things that aren't glyphs are rules (fraction bars, radical and over/under bars).

import type { MathList, MathNode, MathStyle } from '@golemdocs/docx';
import type { FaceMetrics } from '../fonts/faceMetrics.ts';
import type { MathConstruction, MathData } from '../fonts/fontTypes.ts';
import { classOf, mathChar, SPACE_WIDTH, type AtomClass } from './chars.ts';

export interface MathGlyphItem {
  /** Glyph position in the math face's layout. */
  glyph: number;
  /** Pen position, in ems of the base font size. */
  x: number;
  /** Baseline offset, downward positive. */
  y: number;
  /** Size relative to the base font size (1, or the script scales). */
  size: number;
}

export interface MathRuleItem {
  x: number;
  /** Top edge, downward from the baseline. */
  y: number;
  width: number;
  height: number;
}

/** A laid-out equation. Widths and heights are in ems of the base font size. */
export interface MathLayout {
  width: number;
  ascent: number;
  descent: number;
  glyphs: MathGlyphItem[];
  rules: MathRuleItem[];
}

export interface MathLayoutOptions {
  /** Display style (an equation on its own line) rather than text style (inline). */
  display: boolean;
}

// --- Boxes -------------------------------------------------------------------------------

interface Item {
  glyph: number;
  x: number;
  y: number;
  size: number;
}
interface Rule {
  x: number;
  /** Bottom edge, upward from the baseline. */
  y: number;
  w: number;
  h: number;
}

/** A laid-out piece: origin at its left end on the baseline; y up. */
interface Box {
  width: number;
  ascent: number;
  descent: number;
  /** Italic correction of the last glyph: how far its top leans past its advance. */
  italic: number;
  /** Where an accent centers over it, if it is known (a single glyph's attachment point). */
  attach?: number;
  /** One glyph, or a row of one: scripts on it use the simple rules. */
  simple: boolean;
  items: Item[];
  rules: Rule[];
}

const emptyBox = (): Box => ({ width: 0, ascent: 0, descent: 0, italic: 0, simple: false, items: [], rules: [] });

/** Adds `src` into `dst` at (dx, dy), widening `dst` to cover it. */
function put(dst: Box, src: Box, dx: number, dy: number): void {
  for (const i of src.items) dst.items.push({ glyph: i.glyph, x: i.x + dx, y: i.y + dy, size: i.size });
  for (const r of src.rules) dst.rules.push({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });
  dst.width = Math.max(dst.width, dx + src.width);
  dst.ascent = Math.max(dst.ascent, src.ascent + dy);
  dst.descent = Math.max(dst.descent, src.descent - dy);
}

// --- Styles ------------------------------------------------------------------------------

/** TeX's eight styles: display, text, script, scriptscript (level 0-3), each cramped or not. */
interface Style {
  level: 0 | 1 | 2 | 3;
  cramped: boolean;
}

const cramp = (s: Style): Style => (s.cramped ? s : { level: s.level, cramped: true });
const sup = (s: Style): Style => ({ level: s.level < 2 ? 2 : 3, cramped: s.cramped });
const sub = (s: Style): Style => cramp(sup(s));
const numerator = (s: Style): Style => ({ level: s.level === 0 ? 1 : s.level < 2 ? 2 : 3, cramped: s.cramped });
const denominator = (s: Style): Style => cramp(numerator(s));
const isScript = (s: Style): boolean => s.level >= 2;

// TeX's inter-atom spacing (The TeXbook p. 170): 1 thin always, -1 thin, -2 medium, -3 thick outside script styles.
const CLASSES: AtomClass[] = ['ord', 'op', 'bin', 'rel', 'open', 'close', 'punct'];
const SPACING: number[][] = [
  // ord op bin rel open close punct inner
  [0, 1, -2, -3, 0, 0, 0, -1], // ord
  [1, 1, 0, -3, 0, 0, 0, -1], // op
  [-2, -2, 0, 0, -2, 0, 0, -2], // bin
  [-3, -3, 0, 0, -3, 0, 0, -3], // rel
  [0, 0, 0, 0, 0, 0, 0, 0], // open
  [0, 1, -2, -3, 0, 0, 0, -1], // close
  [-1, -1, 0, -1, -1, -1, -1, -1], // punct
  [-1, 1, -2, -3, -1, 0, -1, -1], // inner
];

interface Atom {
  cls: AtomClass;
  box: Box;
}

// --- The layouter ------------------------------------------------------------------------

type Part = NonNullable<MathConstruction['assembly']>['parts'][number];

class Layouter {
  private readonly pad: number;

  constructor(
    private readonly face: FaceMetrics,
    private readonly data: MathData,
  ) {
    const { atlas } = face.layout;
    // planeBounds include the distance-field margin around the shape; ink is what is inside it.
    this.pad = (atlas.distanceRange / 2 + 0.5) / atlas.size;
  }

  // Constants --------------------------------------------------------------------------

  /** A MATH constant, in ems at the style's size. */
  private k(name: string, style: Style): number {
    return (this.data.constants[name] ?? 0) * this.scale(style);
  }

  private scale(style: Style): number {
    if (style.level < 2) return 1;
    return style.level === 2 ? this.data.constants.scriptPercentScaleDown : this.data.constants.scriptScriptPercentScaleDown;
  }

  private axis(style: Style): number {
    return this.k('axisHeight', style);
  }

  // Glyphs -----------------------------------------------------------------------------

  /** The extent of a glyph's ink, in ems: how far it reaches up, down, left and right of the pen. */
  private ink(glyph: number): { up: number; down: number; left: number; right: number } {
    const b = this.face.layout.glyphs[glyph]?.planeBounds;
    if (!b) return { up: 0, down: 0, left: 0, right: 0 };
    const p = this.pad;
    return { up: Math.max(-b.top - p, 0), down: Math.max(b.bottom - p, -1), left: b.left + p, right: Math.max(b.right - p, b.left + p) };
  }

  /** A box for one glyph at `scale` times the base size. */
  private glyphBox(glyph: number, scale: number): Box {
    if (glyph < 0) return { ...emptyBox(), width: this.face.advance(-1) * scale };
    const ink = this.ink(glyph);
    const attach = this.data.topAccent[glyph];
    return {
      width: this.face.advance(glyph) * scale,
      ascent: ink.up * scale,
      descent: Math.max(ink.down, 0) * scale,
      italic: (this.data.italics[glyph] ?? 0) * scale,
      ...(attach === undefined ? {} : { attach: attach * scale }),
      simple: true,
      items: [{ glyph, x: 0, y: 0, size: scale }],
      rules: [],
    };
  }

  /** The variant of a stretchy glyph closest to `target` (in ems, along the stretch direction), or an assembly of its pieces. */
  private stretch(glyph: number, target: number, vertical: boolean): Box {
    const construction: MathConstruction | undefined = (vertical ? this.data.vertical : this.data.horizontal)[glyph];
    let chosen = glyph;
    if (construction) {
      const fit = construction.variants.find(([, size]) => size >= target);
      if (fit) chosen = fit[0];
      else if (construction.assembly && construction.assembly.parts.length) return this.assemble(construction, target, vertical);
      else if (construction.variants.length) chosen = construction.variants[construction.variants.length - 1][0];
    }
    const box = this.glyphBox(chosen, 1);
    if (vertical) {
      // The baseline of a vertical stretch is the bottom of its ink, so callers can place it by its extent.
      const down = box.descent;
      box.items[0].y = down;
      box.ascent += down;
      box.descent = 0;
    }
    return box;
  }

  /** A glyph assembly: pieces stacked (or laid side by side) with overlapping connectors to reach `target`. */
  private assemble(construction: MathConstruction, target: number, vertical: boolean): Box {
    const parts = construction.assembly!.parts;
    const minOverlap = this.data.minConnectorOverlap;
    const fixedSum = parts.filter((p) => !p[4]).reduce((n, p) => n + p[3], 0);
    const extenders = parts.filter((p) => p[4]);
    const extenderSum = extenders.reduce((n, p) => n + p[3], 0);
    const count = (r: number) => parts.length - extenders.length + r * extenders.length;
    // The fewest repeats of the extenders that reach the target even with the least overlap.
    let repeats = 0;
    while (extenders.length && repeats < 200 && fixedSum + repeats * extenderSum - (count(repeats) - 1) * minOverlap < target) repeats++;
    if (extenders.length && repeats === 0) repeats = 1;

    const sequence: Part[] = [];
    for (const part of parts) for (let n = 0; n < (part[4] ? repeats : 1); n++) sequence.push(part);

    const joints = sequence.length - 1;
    const total = sequence.reduce((n, p) => n + p[3], 0);
    let overlap = minOverlap;
    if (joints > 0) {
      let maxOverlap = Infinity;
      for (let j = 0; j < joints; j++) maxOverlap = Math.min(maxOverlap, sequence[j][2], sequence[j + 1][1]);
      overlap = Math.min(Math.max((total - target) / joints, minOverlap), Math.max(maxOverlap, minOverlap));
    }

    const box = emptyBox();
    let offset = 0;
    for (const part of sequence) {
      const glyph = part[0];
      const ink = this.ink(glyph);
      if (vertical) {
        box.items.push({ glyph, x: 0, y: offset + Math.max(ink.down, 0), size: 1 });
        box.width = Math.max(box.width, this.face.advance(glyph));
      } else {
        box.items.push({ glyph, x: offset - ink.left, y: 0, size: 1 });
        box.ascent = Math.max(box.ascent, ink.up);
        box.descent = Math.max(box.descent, Math.max(ink.down, 0));
      }
      offset += part[3] - overlap;
    }
    const extent = offset + overlap;
    if (vertical) box.ascent = extent;
    else box.width = extent;
    box.italic = construction.assembly!.italics;
    return box;
  }

  // Rows -------------------------------------------------------------------------------

  private atoms(list: MathList, style: Style): Atom[] {
    const out: Atom[] = [];
    for (const node of list) this.node(node, style, out);
    return out;
  }

  /** A list laid out as a row of atoms with TeX's spacing. */
  row(list: MathList, style: Style): Box {
    return this.rowOf(this.atoms(list, style), style);
  }

  private rowOf(atoms: Atom[], style: Style): Box {
    // A binary operator with nothing to its left or right of the right kind is just a symbol (rules 5 and 6).
    for (let i = 0; i < atoms.length; i++) {
      const a = atoms[i];
      if (a.cls !== 'bin') continue;
      const prev = atoms[i - 1]?.cls;
      const next = atoms[i + 1]?.cls;
      if (prev === undefined || prev === 'bin' || prev === 'op' || prev === 'rel' || prev === 'open' || prev === 'punct') a.cls = 'ord';
      else if (next === undefined || next === 'rel' || next === 'close' || next === 'punct') a.cls = 'ord';
    }
    const box = emptyBox();
    const quad = this.scale(style);
    let x = 0;
    atoms.forEach((atom, i) => {
      if (i > 0) x += this.space(atoms[i - 1].cls, atom.cls, style) * quad;
      put(box, atom.box, x, 0);
      x += atom.box.width;
    });
    box.width = x;
    const last = atoms[atoms.length - 1];
    if (last) {
      box.italic = last.box.italic;
      if (atoms.length === 1) {
        box.simple = last.box.simple;
        if (last.box.attach !== undefined) box.attach = last.box.attach;
      }
    }
    return box;
  }

  /** Space between two atoms, in ems of the style's size. */
  private space(left: AtomClass, right: AtomClass, style: Style): number {
    const v = SPACING[CLASSES.indexOf(left)][CLASSES.indexOf(right)];
    if (v === 0) return 0;
    if (v === 1) return 3 / 18;
    if (isScript(style)) return 0;
    return v === -1 ? 3 / 18 : v === -2 ? 4 / 18 : 5 / 18;
  }

  // Nodes ------------------------------------------------------------------------------

  private node(node: MathNode, style: Style, out: Atom[]): void {
    switch (node.type) {
      case 'text':
        this.text(node.text, node.style, style, out);
        return;
      case 'frac':
        out.push({ cls: 'ord', box: this.fraction(node, style) });
        return;
      case 'script': {
        const base = this.atoms(node.base, style);
        const box = node.pre ? this.preScripts(base, node.sub, node.sup, style) : this.scripts(base, node.sub, node.sup, style);
        out.push({ cls: base.length === 1 ? base[0].cls : 'ord', box });
        return;
      }
      case 'rad':
        out.push({ cls: 'ord', box: this.radical(node, style) });
        return;
      case 'nary':
        this.nary(node, style, out);
        return;
      case 'delim':
        out.push({ cls: 'ord', box: this.delimited(node, style) });
        return;
      case 'func':
        out.push({ cls: 'op', box: this.row(node.name, style) }, ...this.atoms(node.arg, style));
        return;
      case 'accent':
        out.push({ cls: 'ord', box: this.accent(node.char, this.row(node.base, cramp(style)), style) });
        return;
      case 'bar':
        out.push({ cls: 'ord', box: this.bar(node.position, this.row(node.base, node.position === 'top' ? cramp(style) : style), style) });
        return;
      case 'limit':
        out.push({ cls: 'ord', box: this.limit(node.position, this.row(node.base, style), node.limit, style) });
        return;
      case 'matrix':
        out.push({ cls: 'ord', box: this.matrix(node.rows, style) });
        return;
      case 'eqArray':
        out.push({ cls: 'ord', box: this.eqArray(node.rows, style, 'align') });
        return;
    }
  }

  private text(text: string, mathStyle: MathStyle | undefined, style: Style, out: Atom[]): void {
    const scale = this.scale(style);
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      const space = SPACE_WIDTH[cp];
      if (space !== undefined) {
        // Plain spaces only count in ordinary text; math ignores them.
        if (cp === 0x20 && mathStyle !== 'normal') continue;
        out.push({ cls: 'ord', box: { ...emptyBox(), width: space * scale } });
        continue;
      }
      if (ch === '\n') continue;
      let glyph = this.face.glyph(mathChar(cp, mathStyle));
      if (glyph < 0) glyph = this.face.glyph(cp);
      out.push({ cls: classOf(cp), box: this.glyphBox(glyph, scale) });
    }
  }

  // Fractions (rule 15) ------------------------------------------------------------------

  private fraction(node: Extract<MathNode, { type: 'frac' }>, style: Style): Box {
    const num = this.row(node.num, numerator(style));
    const den = this.row(node.den, denominator(style));
    if (node.fraction === 'linear' || node.fraction === 'skew') {
      const box = emptyBox();
      const slash = this.glyphBox(this.face.glyph(0x2044) >= 0 ? this.face.glyph(0x2044) : this.face.glyph(0x2f), this.scale(style));
      let x = 0;
      for (const part of [num, slash, den]) {
        put(box, part, x, 0);
        x += part.width;
      }
      box.width = x;
      return box;
    }

    const display = style.level === 0;
    const axis = this.axis(style);
    const box = emptyBox();
    const pad = 0.04 * this.scale(style);
    const width = Math.max(num.width, den.width);
    let up: number;
    let down: number;
    let rule = 0;
    if (node.fraction === 'noBar') {
      up = this.k(display ? 'stackTopDisplayStyleShiftUp' : 'stackTopShiftUp', style);
      down = this.k(display ? 'stackBottomDisplayStyleShiftDown' : 'stackBottomShiftDown', style);
      const gap = up - num.descent - (den.ascent - down);
      const min = this.k(display ? 'stackDisplayStyleGapMin' : 'stackGapMin', style);
      if (gap < min) {
        up += (min - gap) / 2;
        down += (min - gap) / 2;
      }
    } else {
      rule = this.k('fractionRuleThickness', style);
      up = this.k(display ? 'fractionNumeratorDisplayStyleShiftUp' : 'fractionNumeratorShiftUp', style);
      down = this.k(display ? 'fractionDenominatorDisplayStyleShiftDown' : 'fractionDenominatorShiftDown', style);
      const numGap = this.k(display ? 'fractionNumDisplayStyleGapMin' : 'fractionNumeratorGapMin', style);
      const denGap = this.k(display ? 'fractionDenomDisplayStyleGapMin' : 'fractionDenominatorGapMin', style);
      up = Math.max(up, axis + rule / 2 + numGap + num.descent);
      down = Math.max(down, denGap + den.ascent - axis + rule / 2);
    }
    put(box, num, pad + (width - num.width) / 2, up);
    put(box, den, pad + (width - den.width) / 2, -down);
    if (rule > 0) box.rules.push({ x: pad, y: axis - rule / 2, w: width, h: rule });
    box.width = width + 2 * pad;
    return box;
  }

  // Scripts (rule 18) --------------------------------------------------------------------

  private scriptShifts(base: Box, subBox: Box | null, supBox: Box | null, style: Style): { up: number; down: number } {
    const supStyle = sup(style);
    const subStyle = sub(style);
    let u = base.simple ? 0 : base.ascent - this.k('superscriptBaselineDropMax', supStyle);
    let v = base.simple ? 0 : base.descent + this.k('subscriptBaselineDropMin', subStyle);
    if (supBox && !subBox) {
      const p = this.k(style.cramped ? 'superscriptShiftUpCramped' : 'superscriptShiftUp', style);
      u = Math.max(u, p, supBox.descent + this.k('superscriptBottomMin', style));
    } else if (subBox && !supBox) {
      v = Math.max(v, this.k('subscriptShiftDown', style), subBox.ascent - this.k('subscriptTopMax', style));
    } else if (supBox && subBox) {
      const p = this.k(style.cramped ? 'superscriptShiftUpCramped' : 'superscriptShiftUp', style);
      u = Math.max(u, p, supBox.descent + this.k('superscriptBottomMin', style));
      v = Math.max(v, this.k('subscriptShiftDown', style));
      const gap = u - supBox.descent - (subBox.ascent - v);
      const min = this.k('subSuperscriptGapMin', style);
      if (gap < min) {
        v += min - gap;
        const psi = this.k('superscriptBottomMaxWithSubscript', style) - (u - supBox.descent);
        if (psi > 0) {
          u += psi;
          v -= psi;
        }
      }
    }
    return { up: u, down: v };
  }

  private scripts(baseAtoms: Atom[], subList: MathList | undefined, supList: MathList | undefined, style: Style, opts: { op?: boolean; base?: Box } = {}): Box {
    const base = opts.base ?? this.rowOf(baseAtoms, style);
    const subBox = subList?.length ? this.row(subList, sub(style)) : null;
    const supBox = supList?.length ? this.row(supList, sup(style)) : null;
    if (!subBox && !supBox) return base;
    const { up, down } = this.scriptShifts(base, subBox, supBox, style);
    const after = this.k('spaceAfterScript', style);
    const box = emptyBox();
    put(box, base, 0, 0);
    let right = base.width;
    if (supBox) {
      put(box, supBox, base.width + base.italic, up);
      right = Math.max(right, base.width + base.italic + supBox.width);
    }
    if (subBox) {
      const x = base.width - (opts.op ? base.italic : 0);
      put(box, subBox, x, -down);
      right = Math.max(right, x + subBox.width);
    }
    box.width = right + after;
    return box;
  }

  private preScripts(baseAtoms: Atom[], subList: MathList | undefined, supList: MathList | undefined, style: Style): Box {
    const base = this.rowOf(baseAtoms, style);
    const subBox = subList?.length ? this.row(subList, sub(style)) : null;
    const supBox = supList?.length ? this.row(supList, sup(style)) : null;
    const { up, down } = this.scriptShifts(base, subBox, supBox, style);
    const box = emptyBox();
    const scriptWidth = Math.max(supBox?.width ?? 0, subBox?.width ?? 0) + this.k('spaceAfterScript', style);
    if (supBox) put(box, supBox, scriptWidth - this.k('spaceAfterScript', style) - supBox.width, up);
    if (subBox) put(box, subBox, scriptWidth - this.k('spaceAfterScript', style) - subBox.width, -down);
    put(box, base, scriptWidth, 0);
    box.width = scriptWidth + base.width;
    box.italic = base.italic;
    return box;
  }

  // Radicals (rule 11) -------------------------------------------------------------------

  private radical(node: Extract<MathNode, { type: 'rad' }>, style: Style): Box {
    const body = this.row(node.body, cramp(style));
    const display = style.level === 0;
    const thickness = this.k('radicalRuleThickness', style);
    let gap = this.k(display ? 'radicalDisplayStyleVerticalGap' : 'radicalVerticalGap', style);
    const target = body.ascent + body.descent + gap + thickness;
    // Sizes are chosen in base ems, then the sign is drawn at the style's scale.
    const size = this.scale(style);
    const sign = this.stretch(this.face.glyph(0x221a), target / size, true);
    const scaled = size === 1 ? sign : this.scaleBox(sign, size);
    const totalHeight = scaled.ascent;
    if (totalHeight > target) gap += (totalHeight - target) / 2;
    // The top of the sign (the bar's top edge) sits at the body's top plus the clearance.
    const top = body.ascent + gap + thickness;
    const bottom = top - totalHeight;

    const box = emptyBox();
    let x = 0;
    if (node.degree?.length) {
      const degree = this.row(node.degree, { level: 3, cramped: false });
      const raise = this.data.constants.radicalDegreeBottomRaisePercent * totalHeight;
      x = Math.max(this.k('radicalKernBeforeDegree', style), 0);
      put(box, degree, x, bottom + raise + degree.descent);
      x += degree.width + this.k('radicalKernAfterDegree', style);
      x = Math.max(x, 0);
    }
    put(box, scaled, x, bottom);
    x += scaled.width;
    box.rules.push({ x: x - 0.002, y: top - thickness, w: body.width + 0.002, h: thickness });
    put(box, body, x, 0);
    box.width = x + body.width;
    box.ascent = Math.max(box.ascent, top + this.k('radicalExtraAscender', style));
    box.descent = Math.max(box.descent, body.descent, -bottom);
    return box;
  }

  /** Scales a box's items (used for glyphs chosen at the base size that draw at a script size). */
  private scaleBox(box: Box, factor: number): Box {
    return {
      ...box,
      width: box.width * factor,
      ascent: box.ascent * factor,
      descent: box.descent * factor,
      italic: box.italic * factor,
      items: box.items.map((i) => ({ glyph: i.glyph, x: i.x * factor, y: i.y * factor, size: i.size * factor })),
      rules: box.rules.map((r) => ({ x: r.x * factor, y: r.y * factor, w: r.w * factor, h: r.h * factor })),
    };
  }

  // Large operators (rules 13 and 13a) -----------------------------------------------------

  private nary(node: Extract<MathNode, { type: 'nary' }>, style: Style, out: Atom[]): void {
    const cp = node.op.codePointAt(0)!;
    const display = style.level === 0;
    const scale = this.scale(style);
    const glyph = this.face.glyph(cp);
    const construction = this.data.vertical[glyph];
    let op: Box;
    if (glyph < 0) op = { ...emptyBox(), width: 0.5 * scale };
    else if (display && construction) {
      const min = this.k('displayOperatorMinHeight', style) / scale;
      const fit = construction.variants.find(([, size]) => size >= min) ?? construction.variants[construction.variants.length - 1];
      op = this.glyphBox(fit[0], scale);
    } else op = this.glyphBox(glyph, scale);
    // Center on the math axis.
    const centered = emptyBox();
    put(centered, op, 0, this.axis(style) - (op.ascent - op.descent) / 2);
    centered.width = op.width;
    centered.italic = op.italic;
    centered.simple = false;

    const integral = '∫∬∭∮∯∰'.includes(node.op);
    const limits = node.limits ?? (integral ? 'scripts' : display ? 'aboveBelow' : 'scripts');
    let box: Box;
    if (limits === 'aboveBelow') box = this.limits(centered, node.sup, node.sub, style, false);
    else box = this.scripts([], node.sub, node.sup, style, { op: true, base: centered });
    out.push({ cls: 'op', box });
    out.push(...this.atoms(node.body, style));
  }

  /** Limits above and below a base (rule 13a): the base and each limit centered on each other. */
  private limits(base: Box, upper: MathList | undefined, lower: MathList | undefined, style: Style, keepItalic: boolean): Box {
    const upBox = upper?.length ? this.row(upper, sup(style)) : null;
    const lowBox = lower?.length ? this.row(lower, sub(style)) : null;
    const width = Math.max(base.width, upBox?.width ?? 0, lowBox?.width ?? 0);
    const box = emptyBox();
    const italic = keepItalic ? 0 : base.italic;
    put(box, base, (width - base.width) / 2, 0);
    if (upBox) {
      const rise = Math.max(base.ascent + this.k('upperLimitGapMin', style) + upBox.descent, this.k('upperLimitBaselineRiseMin', style));
      put(box, upBox, (width - upBox.width) / 2 + italic / 2, rise);
    }
    if (lowBox) {
      const drop = Math.max(base.descent + this.k('lowerLimitGapMin', style) + lowBox.ascent, this.k('lowerLimitBaselineDropMin', style));
      put(box, lowBox, (width - lowBox.width) / 2 - italic / 2, -drop);
    }
    box.width = width;
    return box;
  }

  private limit(position: 'lower' | 'upper', base: Box, limit: MathList, style: Style): Box {
    return position === 'lower' ? this.limits(base, undefined, limit, style, true) : this.limits(base, limit, undefined, style, true);
  }

  // Delimiters (rule 19) -------------------------------------------------------------------

  private delimited(node: Extract<MathNode, { type: 'delim' }>, style: Style): Box {
    const scale = this.scale(style);
    const axis = this.axis(style);
    const cases = node.open === '{' && node.close === '' && node.items.length === 1 && node.items[0].length === 1 && node.items[0][0].type === 'eqArray';

    let inner: Box;
    if (cases) inner = this.eqArray((node.items[0][0] as Extract<MathNode, { type: 'eqArray' }>).rows, { level: 1, cramped: style.cramped }, 'cases');
    else {
      const atoms: Atom[] = [];
      node.items.forEach((item, i) => {
        if (i > 0 && node.separator) this.text(node.separator, undefined, style, atoms);
        atoms.push(...this.atoms(item, style));
      });
      inner = this.rowOf(atoms, style);
    }

    const half = Math.max(inner.ascent - axis, inner.descent + axis);
    const needed = Math.max((2 * half * 0.901) / scale, (2 * half - 0.5 * scale) / scale);
    const side = (ch: string): Box | null => {
      if (!ch) return null;
      const glyph = this.face.glyph(ch.codePointAt(0)!);
      if (glyph < 0) return null;
      const stretched = this.stretch(glyph, needed, true);
      const scaled = scale === 1 ? stretched : this.scaleBox(stretched, scale);
      const placed = emptyBox();
      // Center the delimiter's ink on the axis.
      put(placed, scaled, 0, axis - scaled.ascent / 2);
      placed.width = scaled.width;
      return placed;
    };

    const box = emptyBox();
    let x = 0;
    const open = side(node.open);
    if (open) {
      put(box, open, 0, 0);
      x += open.width;
    }
    put(box, inner, x, 0);
    x += inner.width;
    const close = side(node.close);
    if (close) {
      put(box, close, x, 0);
      x += close.width;
    }
    box.width = x;
    return box;
  }

  // Accents (rule 12) and bars -------------------------------------------------------------

  private accent(char: string, base: Box, style: Style): Box {
    const scale = this.scale(style);
    let glyph = this.face.glyph(char.codePointAt(0)!);
    if (glyph < 0) return base;
    // Wide accents come in sizes: pick one as wide as the base if the font has it.
    let accent: Box;
    if (this.data.horizontal[glyph] && base.width > 0.6 * scale) accent = this.scaleBox(this.stretch(glyph, base.width / scale, false), scale);
    else accent = this.glyphBox(glyph, scale);
    glyph = accent.items[0]?.glyph ?? glyph;

    const ink = this.ink(glyph);
    const accentAttach = this.data.topAccent[glyph] !== undefined ? this.data.topAccent[glyph] * scale : ((ink.left + ink.right) / 2) * scale;
    const baseAttach = base.attach ?? base.width / 2;
    const rise = Math.max(base.ascent - this.k('accentBaseHeight', style), 0);
    const box = emptyBox();
    put(box, base, 0, 0);
    put(box, accent, baseAttach - accentAttach, rise);
    box.width = base.width;
    box.italic = base.italic;
    return box;
  }

  private bar(position: 'top' | 'bottom', base: Box, style: Style): Box {
    const box = emptyBox();
    put(box, base, 0, 0);
    if (position === 'top') {
      const t = this.k('overbarRuleThickness', style);
      const y = base.ascent + this.k('overbarVerticalGap', style);
      box.rules.push({ x: 0, y, w: base.width, h: t });
      box.ascent = y + t + this.k('overbarExtraAscender', style);
    } else {
      const t = this.k('underbarRuleThickness', style);
      const y = -(base.descent + this.k('underbarVerticalGap', style)) - t;
      box.rules.push({ x: 0, y, w: base.width, h: t });
      box.descent = -y + this.k('underbarExtraDescender', style);
    }
    box.width = base.width;
    return box;
  }

  // Arrays ---------------------------------------------------------------------------------

  /** Rows of cells stacked with baselines TeX's `\baselineskip` apart, centered vertically on the axis. */
  private stack(rows: Box[], style: Style, skip = 1.2): Box {
    const scale = this.scale(style);
    const strutUp = 0.7 * skip * scale;
    const strutDown = 0.3 * skip * scale;
    const box = emptyBox();
    let y = 0; // baseline of the current row, downward from the first row's baseline
    let previousDescent = 0;
    rows.forEach((row, i) => {
      const up = Math.max(row.ascent, strutUp);
      if (i > 0) y += Math.max(skip * scale, previousDescent + up);
      put(box, row, 0, -y);
      previousDescent = Math.max(row.descent, strutDown);
    });
    box.width = Math.max(0, ...rows.map((r) => r.width));
    const top = Math.max(rows[0]?.ascent ?? 0, strutUp);
    const height = top + y + previousDescent;
    // Center on the axis: the middle of the rows is halfway between the first row's top and the last row's bottom.
    const shift = this.axis(style) - (top - y - previousDescent) / 2;
    const out = emptyBox();
    put(out, box, 0, shift);
    out.width = box.width;
    out.ascent = top + shift;
    out.descent = height - top - shift;
    return out;
  }

  private matrix(rows: MathList[][], style: Style): Box {
    const cellStyle: Style = { level: style.level === 0 ? 1 : style.level, cramped: style.cramped };
    const cells = rows.map((row) => row.map((cell) => this.row(cell, cellStyle)));
    const columns = Math.max(0, ...cells.map((r) => r.length));
    const widths = Array.from({ length: columns }, (_, c) => Math.max(0, ...cells.map((r) => r[c]?.width ?? 0)));
    const gap = 1 * this.scale(cellStyle);
    const laid = cells.map((row) => {
      const box = emptyBox();
      let x = 0;
      row.forEach((cell, c) => {
        put(box, cell, x + (widths[c] - cell.width) / 2, 0);
        x += widths[c] + gap;
      });
      box.width = Math.max(0, x - gap);
      return box;
    });
    return this.stack(laid, cellStyle);
  }

  /** Aligned lines: `&` in a line marks an alignment point; `cases` left-aligns the columns. */
  private eqArray(rows: MathList[], style: Style, mode: 'align' | 'cases'): Box {
    const lineStyle: Style = mode === 'cases' ? { level: 1, cramped: style.cramped } : style;
    // Each line splits at its `&` characters into cells.
    const cellLists: Box[][] = rows.map((row) => this.splitAtAmpersands(row).map((part) => this.row(part, lineStyle)));
    const columns = Math.max(1, ...cellLists.map((r) => r.length));
    const aligned = columns > 1;
    const widths = Array.from({ length: columns }, (_, c) => Math.max(0, ...cellLists.map((r) => r[c]?.width ?? 0)));
    const gap = mode === 'cases' ? this.scale(lineStyle) : 0;
    const pairGap = 2 * this.scale(lineStyle);
    const laid = cellLists.map((cells) => {
      const box = emptyBox();
      if (!aligned) {
        put(box, cells[0] ?? emptyBox(), 0, 0);
        box.width = cells[0]?.width ?? 0;
        return box;
      }
      let x = 0;
      cells.forEach((cell, c) => {
        // Even columns end at the alignment point (right-aligned), odd ones start there; `cases` are all left-aligned.
        const dx = mode === 'cases' ? 0 : c % 2 === 0 ? widths[c] - cell.width : 0;
        put(box, cell, x + dx, 0);
        x += widths[c] + (mode === 'cases' ? gap : c % 2 === 1 ? pairGap : 0);
      });
      box.width = x;
      return box;
    });
    if (aligned) return this.stack(laid, lineStyle);
    // Unaligned lines are centered on the widest.
    const width = Math.max(0, ...laid.map((b) => b.width));
    const centered = laid.map((box) => {
      const shifted = emptyBox();
      put(shifted, box, (width - box.width) / 2, 0);
      shifted.width = width;
      return shifted;
    });
    return this.stack(centered, lineStyle);
  }

  /** Splits a line's nodes at `&` characters in its text nodes (alignment points). */
  private splitAtAmpersands(row: MathList): MathList[] {
    const parts: MathList[] = [[]];
    for (const node of row) {
      if (node.type !== 'text' || !node.text.includes('&')) {
        parts[parts.length - 1].push(node);
        continue;
      }
      const pieces = node.text.split('&');
      pieces.forEach((piece, i) => {
        if (i > 0) parts.push([]);
        if (piece) parts[parts.length - 1].push({ ...node, text: piece });
      });
    }
    return parts;
  }
}

// --- Entry point -------------------------------------------------------------------------

/** Lays an equation out. Sizes are in ems of the base font size; multiply by the font size. */
export function layoutMath(content: MathList, face: FaceMetrics, data: MathData, options: MathLayoutOptions): MathLayout {
  const layouter = new Layouter(face, data);
  const box = layouter.row(content, { level: options.display ? 0 : 1, cramped: false });
  return {
    width: box.width,
    ascent: box.ascent,
    descent: box.descent,
    glyphs: box.items.map((i) => ({ glyph: i.glyph, x: i.x, y: -i.y || 0, size: i.size })),
    rules: box.rules.map((r) => ({ x: r.x, y: -(r.y + r.h) || 0, width: r.w, height: r.h })),
  };
}
