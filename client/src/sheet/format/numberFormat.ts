// Excel number formats (docs/spreadsheets.md, "Formatting"): a format code ("#,##0.00;[Red](#,##0.00)", "m/d/yyyy h:mm",
// "# ?/?", "0.00E+00", "@") is compiled once into sections of tokens, then formats values, and estimates how wide a value
// shows without making its string (the overview and text overflow ask that of millions of cells).
//
// Excel's behaviour followed here, checked against values Excel computed (the oracle):
// - numbers round on their 15-significant-digit decimal form, half away from zero (1.005 to two places is 1.01);
// - serial dates count from 1900-01-00 with 29 February 1900 as day 60, or from 1904-01-01;
// - a format of one section shows a minus sign itself; the second section (negatives) is given the value without it;
// - `m` is minutes right after hours or right before seconds, months otherwise.

export interface Formatted {
  text: string;
  /** A colour the format names ([Red], [Color10]), as RGB. */
  color?: number;
  /** `*x`: the character repeated to fill the cell, and where it goes in `text`. */
  fill?: { char: string; at: number };
  /** The value cannot be shown this way (a negative date): a cell shows `####`, TEXT() gives #VALUE!. */
  error?: true;
}

const COLORS: Record<string, number> = { black: 0x000000, white: 0xffffff, red: 0xff0000, green: 0x00ff00, blue: 0x0000ff, yellow: 0xffff00, magenta: 0xff00ff, cyan: 0x00ffff };
/** [Color1] to [Color56]: the indexed palette from 8. */
const PALETTE = [
  0x000000, 0xffffff, 0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff, 0x800000, 0x008000, 0x000080, 0x808000, 0x800080, 0x008080, 0xc0c0c0, 0x808080,
  0x9999ff, 0x993366, 0xffffcc, 0xccffff, 0x660066, 0xff8080, 0x0066cc, 0xccccff, 0x000080, 0xff00ff, 0xffff00, 0x00ffff, 0x800080, 0x800000, 0x008080, 0x0000ff,
  0x00ccff, 0xccffff, 0xccffcc, 0xffff99, 0x99ccff, 0xff99cc, 0xcc99ff, 0xffcc99, 0x3366ff, 0x33cccc, 0x99cc00, 0xffcc00, 0xff9900, 0xff6600, 0x666699, 0x969696,
  0x003366, 0x339966, 0x003300, 0x333300, 0x993300, 0x993366, 0x333399, 0x333333,
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type Token =
  | { t: 'lit'; s: string }
  | { t: 'digit'; c: '0' | '#' | '?' }
  | { t: 'point' }
  | { t: 'comma' }
  | { t: 'percent' }
  | { t: 'exp'; sign: boolean; c: 'E' | 'e' }
  | { t: 'slash' }
  | { t: 'text' }
  | { t: 'fill'; s: string }
  | { t: 'general' }
  | { t: 'date'; s: string }
  | { t: 'elapsed'; s: 'h' | 'm' | 's'; n: number }
  | { t: 'ampm'; s: string }
  | { t: 'subsec'; n: number };

interface Section {
  tokens: Token[];
  color?: number;
  condition?: { op: string; value: number };
  kind: 'number' | 'date' | 'text' | 'general' | 'fraction';
  /** Number sections: placeholders and options, worked out once. */
  intDigits: Token[];
  decDigits: number;
  thousands: boolean;
  /** Divide by 1000 this many times (commas after the last digit). */
  scale: number;
  percent: number;
  exp: boolean;
  /** Fractions: denominator digits, or a fixed denominator. */
  denominator?: { digits: number; fixed?: number };
  /** Date sections: whether the time is shown to fractions of a second, and to how many places. */
  subsec: number;
  hasHour12: boolean;
  /** Literal characters shown, for width estimates. */
  literalChars: number;
}

export class NumberFormat {
  readonly sections: Section[];
  /** A date or time format: values are serial dates. */
  readonly isDate: boolean;
  readonly isText: boolean;
  readonly isGeneral: boolean;
  private conditional: boolean;

  constructor(readonly code: string) {
    this.sections = splitSections(code).map(parseSection);
    if (!this.sections.length) this.sections.push(parseSection('General'));
    this.conditional = this.sections.some((s) => s.condition);
    this.isDate = this.sections[0].kind === 'date';
    this.isText = this.sections.length === 1 && this.sections[0].kind === 'text';
    this.isGeneral = this.sections[0].kind === 'general' && this.sections.length === 1;
  }

  /** The text a number shows (`maxGeneral`: how many characters General may use; Excel's cells use 11). */
  format(value: number, date1904 = false, maxGeneral = 11): Formatted {
    if (!Number.isFinite(value)) return { text: '#NUM!' };
    const [section, shown] = this.pick(value);
    if (section.kind === 'text') {
      // A number in a text-only section shows as General with the section's literals around it.
      return render(section, (s) => (s.t === 'text' ? general(value, maxGeneral) : null), value);
    }
    if (section.kind === 'general') return render(section, (s) => (s.t === 'general' ? general(shown, maxGeneral) : null), value);
    if (section.kind === 'date') {
      if (shown < 0 || shown > 2958465.99999999) return { text: '#'.repeat(11), error: true };
      return formatDate(section, shown, date1904);
    }
    if (section.kind === 'fraction') return formatFraction(section, shown);
    return formatNumber(section, shown);
  }

  /** Text through the format's text section (the fourth, or the only one if it has `@`). */
  formatText(text: string): Formatted {
    const section = this.sections.length >= 4 ? this.sections[3] : this.sections.find((s) => s.kind === 'text');
    if (!section) return { text };
    return render(section, (s) => (s.t === 'text' ? text : s.t === 'general' ? text : null), 0);
  }

  /** About how many characters a number shows, without making its text. */
  estimateLength(value: number): number {
    const [section, shown] = this.pick(value);
    if (section.kind === 'number') {
      let v = Math.abs(shown) * 100 ** section.percent;
      if (section.scale) v /= 1000 ** section.scale;
      if (section.exp) return section.intDigits.length + (section.decDigits ? section.decDigits + 1 : 0) + 4 + section.literalChars;
      const digits = Math.max(section.intDigits.filter((d) => d.t === 'digit' && d.c !== '#').length, v >= 1 ? Math.floor(Math.log10(v)) + 1 : 1);
      const separators = section.thousands ? Math.floor((digits - 1) / 3) : 0;
      return digits + separators + (section.decDigits ? section.decDigits + 1 : 0) + section.literalChars + (value < 0 && this.sections.length === 1 ? 1 : 0);
    }
    if (section.kind === 'general') {
      if (Number.isInteger(value) && Math.abs(value) < 1e11) return (value < 0 ? 1 : 0) + (value === 0 ? 1 : Math.floor(Math.log10(Math.abs(value))) + 1);
      return 11;
    }
    return this.format(value).text.length;
  }

  /** The section for a number, and the value it shows (without its sign where the section shows none). */
  private pick(value: number): [Section, number] {
    const sections = this.sections;
    if (this.conditional) {
      const numeric = sections.filter((s) => s.kind !== 'text');
      for (let i = 0; i < numeric.length; i++) {
        const s = numeric[i];
        const condition = s.condition ?? (i === 0 ? { op: '>', value: 0 } : i === 1 ? { op: '<', value: 0 } : null);
        if (!condition || test(condition, value)) {
          // A second section given by default (negatives) shows no sign; one with its own condition shows the value as it is.
          return [s, i === 1 && !s.condition ? Math.abs(value) : s.condition && i > 0 && value < 0 ? Math.abs(value) : value];
        }
      }
      return [numeric[numeric.length - 1] ?? sections[0], value];
    }
    const numeric = sections.length >= 4 ? sections.slice(0, 3) : sections.filter((s, i) => i < 3 && !(s.kind === 'text' && i === sections.length - 1 && i > 0));
    if (value < 0 && numeric.length >= 2) return [numeric[1], -value];
    if (value === 0 && numeric.length >= 3) return [numeric[2], 0];
    return [numeric[0] ?? sections[0], value];
  }
}

const cache = new Map<string, NumberFormat>();

/** A compiled format, cached by code. */
export function numberFormat(code: string): NumberFormat {
  let format = cache.get(code);
  if (!format) {
    if (cache.size > 2000) cache.clear();
    cache.set(code, (format = new NumberFormat(code)));
  }
  return format;
}

function test(condition: { op: string; value: number }, v: number): boolean {
  switch (condition.op) {
    case '>':
      return v > condition.value;
    case '>=':
      return v >= condition.value;
    case '<':
      return v < condition.value;
    case '<=':
      return v <= condition.value;
    case '=':
      return v === condition.value;
    case '<>':
      return v !== condition.value;
  }
  return false;
}

/** Splits at `;` outside quotes, brackets and escapes. */
function splitSections(code: string): string[] {
  const out: string[] = [];
  let at = 0;
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '"') {
      const end = code.indexOf('"', i + 1);
      i = end < 0 ? code.length : end + 1;
    } else if (c === '\\') {
      i += 2;
    } else if (c === '[') {
      const end = code.indexOf(']', i);
      i = end < 0 ? code.length : end + 1;
    } else if (c === ';') {
      out.push(code.slice(at, i));
      at = ++i;
    } else {
      i++;
    }
  }
  out.push(code.slice(at));
  return out.slice(0, 4);
}

function parseSection(code: string): Section {
  const tokens: Token[] = [];
  let color: number | undefined;
  let condition: Section['condition'];
  let i = 0;
  const lower = code.toLowerCase();
  while (i < code.length) {
    const c = code[i];
    const l = lower[i];
    if (c === '"') {
      const end = code.indexOf('"', i + 1);
      tokens.push({ t: 'lit', s: code.slice(i + 1, end < 0 ? code.length : end) });
      i = end < 0 ? code.length : end + 1;
    } else if (c === '\\') {
      if (i + 1 < code.length) tokens.push({ t: 'lit', s: code[i + 1] });
      i += 2;
    } else if (c === '_') {
      tokens.push({ t: 'lit', s: ' ' });
      i += 2;
    } else if (c === '*') {
      tokens.push({ t: 'fill', s: code[i + 1] ?? ' ' });
      i += 2;
    } else if (c === '[') {
      const end = code.indexOf(']', i);
      const inner = code.slice(i + 1, end < 0 ? code.length : end);
      i = end < 0 ? code.length : end + 1;
      const name = inner.toLowerCase();
      const cond = /^(<=|>=|<>|<|>|=)\s*(-?[\d.]+(?:e[+-]?\d+)?)$/i.exec(inner);
      if (COLORS[name] !== undefined) color = COLORS[name];
      else if (/^color\s*\d+$/.test(name)) color = PALETTE[+name.replace(/\D/g, '') - 1];
      else if (cond) condition = { op: cond[1], value: +cond[2] };
      else if (/^(h+|m+|s+)$/.test(name)) tokens.push({ t: 'elapsed', s: name[0] as 'h' | 'm' | 's', n: name.length });
      else if (inner.startsWith('$')) {
        // [$€-407]: a currency symbol (and locale); [$-409]: a locale alone.
        const dash = inner.indexOf('-');
        const symbol = inner.slice(1, dash < 0 ? undefined : dash);
        if (symbol) tokens.push({ t: 'lit', s: symbol });
      }
    } else if (lower.startsWith('general', i)) {
      tokens.push({ t: 'general' });
      i += 7;
    } else if (c === '0' || c === '#' || c === '?') {
      tokens.push({ t: 'digit', c });
      i++;
    } else if (c === '.') {
      // After seconds, `.0`/`.00`/`.000` are fractions of a second.
      const prev = lastDate(tokens);
      if (prev?.t === 'date' && prev.s[0] === 's' && code[i + 1] === '0') {
        let n = 0;
        while (code[i + 1 + n] === '0') n++;
        tokens.push({ t: 'subsec', n });
        i += 1 + n;
      } else {
        tokens.push({ t: 'point' });
        i++;
      }
    } else if (c === ',') {
      tokens.push({ t: 'comma' });
      i++;
    } else if (c === '%') {
      tokens.push({ t: 'percent' });
      i++;
    } else if ((l === 'e') && (code[i + 1] === '+' || code[i + 1] === '-') && hasDigitBefore(tokens)) {
      tokens.push({ t: 'exp', sign: code[i + 1] === '+', c: c as 'E' | 'e' });
      i += 2;
    } else if (c === '/' && hasDigitBefore(tokens) && /[0-9#?]/.test(code[i + 1] ?? '')) {
      tokens.push({ t: 'slash' });
      i++;
    } else if (c === '@') {
      tokens.push({ t: 'text' });
      i++;
    } else if (lower.startsWith('am/pm', i) || lower.startsWith('a/p', i)) {
      const n = lower.startsWith('am/pm', i) ? 5 : 3;
      tokens.push({ t: 'ampm', s: code.slice(i, i + n) });
      i += n;
    } else if ('ymdhsbe'.includes(l)) {
      let n = 1;
      while (lower[i + n] === l) n++;
      tokens.push({ t: 'date', s: l.repeat(n) });
      i += n;
    } else {
      tokens.push({ t: 'lit', s: c });
      i++;
    }
  }
  return analyse(tokens, color, condition);
}

function lastDate(tokens: Token[]): Token | undefined {
  for (let i = tokens.length - 1; i >= 0; i--) if (tokens[i].t === 'date' || tokens[i].t === 'elapsed') return tokens[i];
  return undefined;
}

const hasDigitBefore = (tokens: Token[]) => tokens.some((t) => t.t === 'digit');

function analyse(tokens: Token[], color: number | undefined, condition: Section['condition']): Section {
  const section: Section = { tokens, color, condition, kind: 'number', intDigits: [], decDigits: 0, thousands: false, scale: 0, percent: 0, exp: false, subsec: 0, hasHour12: false, literalChars: 0 };
  for (const t of tokens) if (t.t === 'lit') section.literalChars += t.s.length;
  const has = (k: Token['t']) => tokens.some((t) => t.t === k);
  if (has('date') || has('elapsed')) {
    section.kind = 'date';
    // `m` is minutes after an hour or before a second.
    const dated = tokens.filter((t) => t.t === 'date' || t.t === 'elapsed') as (Token & { s: string })[];
    dated.forEach((t, k) => {
      if (t.t !== 'date' || t.s[0] !== 'm' || t.s.length > 2) return;
      const prev = dated[k - 1];
      const next = dated[k + 1];
      if ((prev && prev.s[0] === 'h') || (next && next.s[0] === 's')) t.s = t.s === 'm' ? 'n' : 'nn';
    });
    section.hasHour12 = has('ampm');
    const sub = tokens.find((t) => t.t === 'subsec') as { n: number } | undefined;
    section.subsec = sub?.n ?? 0;
    return section;
  }
  if (has('general')) {
    section.kind = 'general';
    return section;
  }
  if (has('text') && !has('digit')) {
    section.kind = 'text';
    return section;
  }
  if (!has('digit')) {
    // A section of literals only (`"zero"`, `-`) shows them for its numbers.
    return section;
  }
  if (has('slash')) {
    section.kind = 'fraction';
    const slash = tokens.findIndex((t) => t.t === 'slash');
    const after = tokens.slice(slash + 1);
    let digits = 0;
    let fixed = '';
    for (const t of after) {
      if (t.t === 'digit') digits++;
      else if (t.t === 'lit' && /^\d+$/.test(t.s)) fixed += t.s;
      else break;
    }
    // A denominator written as digits ("?/8") is fixed; the tokenizer reads 1-9 as literals and 0 as a placeholder.
    const fixedText = after
      .slice(0, after.findIndex((t) => !(t.t === 'lit' && /^\d$/.test(t.s)) && !(t.t === 'digit' && t.c === '0')) >>> 0)
      .map((t) => (t.t === 'lit' ? t.s : t.t === 'digit' ? '0' : ''))
      .join('');
    section.denominator = /^[1-9]\d*$/.test(fixedText) ? { digits: fixedText.length, fixed: +fixedText } : { digits: Math.max(1, digits) };
    void fixed;
    return section;
  }
  let seenPoint = false;
  let lastDigit = -1;
  tokens.forEach((t, k) => {
    if (t.t === 'digit') lastDigit = k;
  });
  tokens.forEach((t, k) => {
    if (t.t === 'point') seenPoint = true;
    else if (t.t === 'digit' && !section.exp) {
      if (seenPoint) section.decDigits++;
      else section.intDigits.push(t);
    } else if (t.t === 'comma') {
      // A comma between digits groups thousands; commas right after the last digit (or before the point) divide by 1000.
      const next = tokens.slice(k + 1).find((x) => x.t !== 'comma');
      if (k > lastDigit || next?.t === 'point' || (!seenPoint && next && next.t !== 'digit')) section.scale++;
      else if (!seenPoint) section.thousands = true;
    } else if (t.t === 'percent') section.percent++;
    else if (t.t === 'exp') section.exp = true;
  });
  return section;
}

/** Writes a section's tokens, asking `fill` for the text of the ones it handles. */
function render(section: Section, fill: (token: Token) => string | null, _value: number): Formatted {
  let text = '';
  let fillChar: Formatted['fill'];
  for (const t of section.tokens) {
    const s = fill(t);
    if (s !== null) text += s;
    else if (t.t === 'lit') text += t.s;
    else if (t.t === 'fill') fillChar = { char: t.s, at: text.length };
  }
  return { text, ...(section.color !== undefined && { color: section.color }), ...(fillChar && { fill: fillChar }) };
}

/**
 * A non-negative number rounded to `places` decimals as Excel rounds: on its 15-significant-digit decimal form, half away
 * from zero. Returns the digits before and after the point.
 */
export function roundDecimal(value: number, places: number): [string, string] {
  if (value === 0) return ['0', '0'.repeat(places)];
  const [mantissa, exponentText] = value.toExponential(14).split('e');
  const exponent = +exponentText;
  const digits = mantissa.replace('.', '');
  // The value is 0.digits * 10^(exponent + 1); keep exponent + 1 + places digits.
  const keep = exponent + 1 + places;
  if (keep < 0) return ['0', '0'.repeat(places)];
  let kept = digits.slice(0, keep).padEnd(Math.max(keep, 0), '0');
  if (keep < digits.length && digits.charCodeAt(keep) >= 53 /* 5 */) kept = increment(kept || '0', keep === 0);
  let whole = kept.length - places;
  if (kept.length < places) {
    kept = kept.padStart(places, '0');
    whole = 0;
  }
  const int = kept.slice(0, Math.max(0, whole)).replace(/^0+(?=\d)/, '') || '0';
  return [int, kept.slice(Math.max(0, whole))];
}

/** Adds one to a string of digits (`empty`: the digits were all rounded away, so the result is "1"). */
function increment(digits: string, empty: boolean): string {
  if (empty) return '1';
  const out = digits.split('');
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] === '9') out[i] = '0';
    else {
      out[i] = String(+out[i] + 1);
      return out.join('');
    }
  }
  return '1' + out.join('');
}

function formatNumber(section: Section, value: number): Formatted {
  const negative = value < 0;
  let v = Math.abs(value) * 100 ** section.percent;
  if (section.scale) v /= 1000 ** section.scale;
  let exponent = 0;
  let expText = '';
  if (section.exp) {
    // Engineering notation: with `#` among the integer placeholders, the exponent is a multiple of their count.
    const step = section.intDigits.some((d) => d.t === 'digit' && d.c === '#') ? section.intDigits.length : 1;
    if (v !== 0) {
      exponent = Math.floor(Math.log10(v));
      const fixed = Math.max(1, section.intDigits.filter((d) => d.t === 'digit' && d.c === '0').length);
      exponent = step > 1 ? Math.floor(exponent / step) * step : exponent - (fixed - 1);
      v /= 10 ** exponent;
      // Rounding can carry the mantissa to the next power (9.99 to 10.0).
      const [i] = roundDecimal(v, section.decDigits);
      if (i.length > Math.max(step, section.intDigits.length)) {
        exponent += step > 1 ? step : 1;
        v /= step > 1 ? 10 ** step : 10;
      }
    }
    const expToken = section.tokens.find((t) => t.t === 'exp') as { sign: boolean; c: string };
    const expIndex = section.tokens.indexOf(expToken as Token);
    const expDigits = section.tokens.slice(expIndex + 1).filter((t) => t.t === 'digit').length;
    expText = expToken.c + (exponent < 0 ? '-' : expToken.sign ? '+' : '') + String(Math.abs(exponent)).padStart(expDigits, '0');
  }
  const [intPart, decPart] = roundDecimal(v, section.decDigits);
  const isZero = /^0*$/.test(intPart + decPart);
  if (section.exp && v === 0) section = { ...section, intDigits: section.intDigits.map(() => ({ t: 'digit', c: '0' }) as Token), tokens: section.tokens.map((t, k) => (t.t === 'digit' && !afterPoint(section, k) && !afterExp(section, k) ? { t: 'digit', c: '0' } : t)) };
  // Integer digits: fill the placeholders from the right; extra digits go before the first placeholder.
  const placeholders = section.intDigits;
  let intDigits = intPart === '0' && placeholders.length && !placeholders.some((d) => d.t === 'digit' && d.c === '0') ? '' : intPart;
  if (section.thousands && intDigits) intDigits = intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let decDigits = decPart;
  // Trailing zeros of `#` places are dropped, of `?` places shown as spaces.
  const decTokens = decimalTokens(section);
  for (let k = decTokens.length - 1; k >= 0 && decDigits[k] === '0'; k--) {
    if (decTokens[k] === '#') decDigits = decDigits.slice(0, k) + '\u0000' + decDigits.slice(k + 1);
    else if (decTokens[k] === '?') decDigits = decDigits.slice(0, k) + ' ' + decDigits.slice(k + 1);
    else break;
  }
  decDigits = decDigits.replace(/\u0000/g, '');

  // Lay the tokens out: integer placeholders take digits from the right, literals stay where they are.
  const intSlots = section.tokens.reduce((n, t, k) => n + (t.t === 'digit' && !afterPoint(section, k) && !afterExp(section, k) ? 1 : 0), 0);
  const rawDigits = intDigits.replace(/,/g, '');
  const pads = placeholders.map((d) => (d.t === 'digit' ? d.c : '#'));
  const slotText: string[] = [];
  for (let k = 0; k < intSlots; k++) {
    const fromRight = intSlots - 1 - k;
    const digit = rawDigits.length > fromRight ? rawDigits[rawDigits.length - 1 - fromRight] : '';
    slotText.push(digit || (pads[k] === '0' ? '0' : pads[k] === '?' ? ' ' : ''));
  }
  if (rawDigits.length > intSlots && intSlots > 0) slotText[0] = rawDigits.slice(0, rawDigits.length - intSlots + 1);
  // Thousands separators go back into the slot digits.
  if (section.thousands) {
    const joined = slotText.join('');
    const digitsOnly = joined.replace(/ /g, '');
    const grouped = digitsOnly.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    // Spread the grouped text back over the slots: simplest is to put it all in the first non-empty slot.
    const lead = joined.length - joined.trimStart().length;
    for (let k = 0; k < slotText.length; k++) slotText[k] = '';
    if (slotText.length) slotText[0] = ' '.repeat(lead) + grouped;
  }
  let text = '';
  let slot = 0;
  let dec = 0;
  let pointSeen = false;
  let fillChar: Formatted['fill'];
  let expDone = false;
  for (let k = 0; k < section.tokens.length; k++) {
    const t = section.tokens[k];
    if (t.t === 'digit') {
      if (afterExp(section, k)) {
        if (!expDone) {
          text += expText.slice(1);
          expDone = true;
        }
      } else if (pointSeen) text += decDigits[dec++] ?? '';
      else text += slotText[slot++] ?? '';
    } else if (t.t === 'point') {
      pointSeen = true;
      text += '.';
    } else if (t.t === 'exp') text += expText[0];
    else if (t.t === 'percent') text += '%';
    else if (t.t === 'lit') text += t.s;
    else if (t.t === 'fill') fillChar = { char: t.s, at: text.length };
    else if (t.t === 'text') text += '';
  }
  if (negative && !isZero) text = '-' + text;
  return { text, ...(section.color !== undefined && { color: section.color }), ...(fillChar && { fill: fillChar }) };
}

function afterPoint(section: Section, index: number): boolean {
  for (let k = 0; k < index; k++) if (section.tokens[k].t === 'point') return true;
  return false;
}

function afterExp(section: Section, index: number): boolean {
  for (let k = 0; k < index; k++) if (section.tokens[k].t === 'exp') return true;
  return false;
}

function decimalTokens(section: Section): string[] {
  const out: string[] = [];
  section.tokens.forEach((t, k) => {
    if (t.t === 'digit' && afterPoint(section, k) && !afterExp(section, k)) out.push(t.c);
  });
  return out;
}

function formatFraction(section: Section, value: number): Formatted {
  const negative = value < 0;
  const v = Math.abs(value);
  const slash = section.tokens.findIndex((t) => t.t === 'slash');
  // Groups of placeholders before the slash: the last is the numerator, an earlier one the whole number.
  const groups: number[][] = [];
  let current: number[] | null = null;
  section.tokens.slice(0, slash).forEach((t, k) => {
    if (t.t === 'digit') {
      if (!current) groups.push((current = []));
      current.push(k);
    } else current = null;
  });
  const hasWhole = groups.length >= 2;
  const den = section.denominator!;
  let whole = hasWhole ? Math.floor(v) : 0;
  let num: number;
  let d: number;
  if (den.fixed) {
    d = den.fixed;
    num = Math.round((v - whole) * d);
  } else {
    [num, d] = bestFraction(v - whole, 10 ** den.digits - 1);
  }
  if (hasWhole && num === d) {
    whole++;
    num = 0;
  }
  // Excel gives up on numerators past these (found against Excel: a fixed denominator past 65535, any past 2^31 - 1).
  if ((den.fixed && num > 65535) || num > 2147483647) return { text: '#'.repeat(11), error: true };
  const showFraction = !hasWhole || num !== 0;
  const wholeGroup = hasWhole ? groups[0] : [];
  const numGroup = groups[groups.length - 1] ?? [];
  /** Digits laid into placeholders: `0` shows a zero, `?` a space, `#` nothing, where there is no digit. */
  const place = (digits: string, slots: number[], blank: boolean): string => {
    const pads = slots.map((k) => (section.tokens[k] as { c: string }).c);
    let out = '';
    for (let i = 0; i < pads.length; i++) {
      const fromRight = pads.length - 1 - i;
      const digit = !blank && digits.length > fromRight ? digits[digits.length - 1 - fromRight] : '';
      out += digit || (blank ? (pads[i] === '#' ? '' : ' ') : pads[i] === '0' ? '0' : pads[i] === '?' ? ' ' : '');
    }
    if (!blank && digits.length > pads.length) out = digits.slice(0, digits.length - pads.length) + out;
    return out;
  };
  const wholeDigits = whole || !showFraction ? String(whole) : '';
  let text = '';
  let wholeDone = false;
  let numDone = false;
  let denDone = false;
  section.tokens.forEach((t, k) => {
    if (t.t === 'digit' && wholeGroup.includes(k)) {
      if (!wholeDone) text += place(wholeDigits, wholeGroup, false);
      wholeDone = true;
    } else if (t.t === 'digit' && numGroup.includes(k)) {
      if (!numDone) text += place(String(num), numGroup, !showFraction);
      numDone = true;
    } else if (t.t === 'slash') {
      text += showFraction ? '/' : ' ';
    } else if (k > slash && (t.t === 'digit' || (t.t === 'lit' && /^\d$/.test(t.s) && den.fixed))) {
      if (!denDone) text += showFraction ? (den.fixed ? String(d) : String(d).padEnd(den.digits, ' ')) : ' '.repeat(den.digits);
      denDone = true;
    } else if (t.t === 'lit') {
      text += t.s;
    }
  });
  if (negative && (whole || num)) text = '-' + text;
  return { text, ...(section.color !== undefined && { color: section.color }) };
}

/** The closest fraction with a denominator up to `max` (Stern-Brocot, as Excel finds them). */
function bestFraction(x: number, max: number): [number, number] {
  if (x === 0) return [0, 1];
  if (x >= 1) {
    const whole = Math.floor(x);
    const [n, d] = bestFraction(x - whole, max);
    return [whole * d + n, d];
  }
  let [a, b, c, d] = [0, 1, 1, 1];
  let best: [number, number] = [Math.round(x), 1];
  let bestError = Math.abs(x - best[0]);
  while (b <= max && d <= max) {
    const mediant = (a + c) / (b + d);
    if (b + d > max) break;
    if (x === mediant) return [a + c, b + d];
    if (x > mediant) [a, b] = [a + c, b + d];
    else [c, d] = [a + c, b + d];
    for (const [n, m] of [[a, b], [c, d]] as [number, number][]) {
      const error = Math.abs(x - n / m);
      if (m <= max && error < bestError) {
        best = [n, m];
        bestError = error;
      }
    }
  }
  return best;
}

/** The parts of a serial date (1900 system with its phantom 29 February, or 1904). */
export function dateParts(serial: number, date1904 = false): { y: number; m: number; d: number; dow: number; H: number; M: number; S: number; ms: number } {
  let days = Math.floor(serial);
  let fraction = serial - days;
  // Times are kept to the millisecond: binary fractions of a day are not exact.
  let ms = Math.round(fraction * 86_400_000);
  if (ms >= 86_400_000) {
    days++;
    ms -= 86_400_000;
  }
  fraction = ms;
  let y: number;
  let m: number;
  let d: number;
  let dow: number;
  if (!date1904 && days === 60) {
    [y, m, d] = [1900, 2, 29];
    dow = 3;
  } else if (!date1904 && days === 0) {
    [y, m, d] = [1900, 1, 0];
    dow = 6;
  } else {
    const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, days < 60 ? 31 : 30);
    const date = new Date(epoch + days * 86_400_000);
    y = date.getUTCFullYear();
    m = date.getUTCMonth() + 1;
    d = date.getUTCDate();
    dow = date.getUTCDay();
    if (!date1904 && days < 60) dow = (dow + 6) % 7;
  }
  const H = Math.floor(fraction / 3_600_000);
  const M = Math.floor((fraction % 3_600_000) / 60_000);
  const S = Math.floor((fraction % 60_000) / 1000);
  return { y, m, d, dow, H, M, S, ms: fraction % 1000 };
}

function formatDate(section: Section, serial: number, date1904: boolean): Formatted {
  // Seconds round to what is shown: whole seconds, or tenths, hundredths, thousandths.
  const unit = 86400 * 10 ** section.subsec;
  const rounded = Math.round(serial * unit) / unit;
  const p = dateParts(rounded, date1904);
  const totalSeconds = Math.round(rounded * 86400 * 10 ** section.subsec) / 10 ** section.subsec;
  let text = '';
  let fillChar: Formatted['fill'];
  for (const t of section.tokens) {
    switch (t.t) {
      case 'date':
        text += datePart(t.s, p, section.hasHour12);
        break;
      case 'elapsed': {
        const value = t.s === 'h' ? Math.floor(totalSeconds / 3600) : t.s === 'm' ? Math.floor(totalSeconds / 60) : Math.floor(totalSeconds);
        text += String(value).padStart(t.n, '0');
        break;
      }
      case 'subsec':
        text += '.' + String(Math.round(p.ms / 10 ** (3 - t.n))).padStart(t.n, '0').slice(0, t.n);
        break;
      case 'ampm': {
        const pm = p.H >= 12;
        const s = t.s;
        if (s.length === 5) text += s[0] === s[0].toUpperCase() ? (pm ? 'PM' : 'AM') : pm ? 'pm' : 'am';
        else text += pm ? (s[2] === 'P' ? 'P' : 'p') : s[0] === 'A' ? 'A' : 'a';
        break;
      }
      case 'lit':
        text += t.s;
        break;
      case 'point':
        text += '.';
        break;
      case 'comma':
        text += ',';
        break;
      case 'percent':
        text += '%';
        break;
      case 'slash':
        text += '/';
        break;
      case 'fill':
        fillChar = { char: t.s, at: text.length };
        break;
      case 'digit':
        text += t.c === '0' ? '0' : '';
        break;
      default:
        break;
    }
  }
  return { text, ...(section.color !== undefined && { color: section.color }), ...(fillChar && { fill: fillChar }) };
}

function datePart(s: string, p: ReturnType<typeof dateParts>, hour12: boolean): string {
  const two = (n: number) => String(n).padStart(2, '0');
  switch (s[0]) {
    case 'y':
      return s.length <= 2 ? two(p.y % 100) : String(p.y).padStart(4, '0');
    case 'm':
      if (s.length === 1) return String(p.m);
      if (s.length === 2) return two(p.m);
      if (s.length === 3) return MONTHS[p.m - 1].slice(0, 3);
      if (s.length === 5) return MONTHS[p.m - 1][0];
      return MONTHS[p.m - 1];
    case 'n':
      return s.length === 1 ? String(p.M) : two(p.M);
    case 'd':
      if (s.length === 1) return String(p.d);
      if (s.length === 2) return two(p.d);
      if (s.length === 3) return DAYS[p.dow].slice(0, 3);
      return DAYS[p.dow];
    case 'h': {
      const h = hour12 ? p.H % 12 || 12 : p.H;
      return s.length === 1 ? String(h) : two(h);
    }
    case 's':
      return s.length === 1 ? String(p.S) : two(p.S);
    case 'e':
      return String(p.y);
    case 'b':
      return String(p.y + 543);
  }
  return '';
}

/**
 * General: as many significant digits as fit in `width` characters (11 in a cell of the default width), switching to
 * scientific notation for numbers too large or too small to show that way.
 */
export function general(value: number, width = 11): string {
  if (value === 0) return '0';
  const negative = value < 0;
  const v = Math.abs(value);
  const room = width - (negative ? 1 : 0);
  const sign = negative ? '-' : '';
  const exponent = Math.floor(Math.log10(v));
  if (exponent >= room || (exponent < -9 && v < 1e-9) || (exponent < 0 && room - 2 + exponent < 1)) return sign + scientific(v, room);
  if (Number.isInteger(v) && exponent < room) return sign + String(v);
  // Digits after the point that fit: the integer part, the point, and the rest.
  const intLength = exponent >= 0 ? exponent + 1 : 1;
  const places = Math.max(0, Math.min(room - intLength - 1, 30));
  const [int, dec] = roundDecimal(v, places);
  if (int.length > intLength && int.length > room) return sign + scientific(v, room);
  const trimmed = dec.replace(/0+$/, '');
  const text = trimmed ? `${int}.${trimmed}` : int;
  if (text === '0') return sign + scientific(v, room);
  return sign + (text.length > room ? text.slice(0, room).replace(/\.$/, '') : text);
}

function scientific(v: number, room: number): string {
  const exponent = Math.floor(Math.log10(v));
  const expText = 'E' + (exponent < 0 ? '-' : '+') + String(Math.abs(exponent)).padStart(2, '0');
  const places = Math.max(0, Math.min(14, room - expText.length - 2));
  let [int, dec] = roundDecimal(v / 10 ** exponent, places);
  let e = exponent;
  if (int.length > 1) {
    [int, dec] = roundDecimal(v / 10 ** (exponent + 1), places);
    e++;
  }
  const trimmed = dec.replace(/0+$/, '');
  return (trimmed ? `${int}.${trimmed}` : int) + 'E' + (e < 0 ? '-' : '+') + String(Math.abs(e)).padStart(2, '0');
}
