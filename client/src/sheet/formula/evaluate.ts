// Evaluating formulas (docs/spreadsheets.md, "The formula engine"). A parsed formula is compiled once into closures; a
// formula run is compiled once and evaluated per cell, its relative references moved by the cell's distance from the run's
// first cell. Operators work element by element over arrays; a legacy formula (not a dynamic array) takes the cell of a
// range in its own row or column instead (implicit intersection). Functions say how they take each argument
// (functions/registry.ts).

import { MAX_COLUMNS, MAX_ROWS } from '../model/column.ts';
import { CATALOGUE } from './functions/catalogue.ts';
import { FUNCTIONS } from './functions/index.ts';
import type { ArgKind, FunctionSpec } from './functions/registry.ts';
import { parseFormula } from './parser.ts';
import type { Node, RefPart, SheetName } from './parser.ts';
import { intersect, lift1, lift2, operand, power, readArray } from './runtime.ts';
import type { Compiled, Context } from './runtime.ts';
import { ArrayValue, BLANK, CALC, DIV0, FormulaError, LambdaValue, MultiRef, NA, NAME, NULL, REF, RangeRef, VALUE, compare, isError, num, toNumber, toText } from './values.ts';
import type { Scalar, Value } from './values.ts';

/** A compiled formula, and whether it must be recalculated every time (it calls NOW, RAND, OFFSET...). */
export interface Program {
  run: Compiled;
  volatile: boolean;
  /** It calls a function that reaches outside the workbook (cubes, web services...): it keeps the value it was saved with. */
  external?: boolean;
  /** The formula did not read: it gives #NAME?. */
  invalid?: boolean;
}

/** Compiles a formula's text (as people write it, without `=`). */
export function compile(text: string): Program {
  let node: Node;
  try {
    node = parseFormula(text);
  } catch {
    return { run: () => NAME, volatile: false, invalid: true };
  }
  return { run: compileNode(node), volatile: isVolatile(node), external: calls(node, EXTERNAL) };
}

const cache = new Map<string, Program>();

/** compile(), shared between formulas with the same text. */
export function compiled(text: string): Program {
  let program = cache.get(text);
  if (!program) {
    if (cache.size > 50_000) cache.clear();
    cache.set(text, (program = compile(text)));
  }
  return program;
}

const EXTERNAL = new Set(CATALOGUE.external);

/** Whether a formula calls any of some functions. */
function calls(node: Node, names: Set<string>): boolean {
  switch (node.t) {
    case 'func':
      return names.has(node.name) || node.args.some((a) => calls(a, names));
    case 'call':
      return calls(node.fn, names) || node.args.some((a) => calls(a, names));
    case 'unary':
    case 'postfix':
      return calls(node.x, names);
    case 'binary':
      return calls(node.a, names) || calls(node.b, names);
    default:
      return false;
  }
}

/** Whether a formula calls a volatile function. */
function isVolatile(node: Node): boolean {
  switch (node.t) {
    case 'func':
      return !!FUNCTIONS.get(node.name)?.volatile || node.args.some(isVolatile);
    case 'call':
      return isVolatile(node.fn) || node.args.some(isVolatile);
    case 'unary':
    case 'postfix':
      return isVolatile(node.x);
    case 'binary':
      return isVolatile(node.a) || isVolatile(node.b);
    default:
      return false;
  }
}

export function compileNode(node: Node): Compiled {
  switch (node.t) {
    case 'num':
    case 'str':
    case 'bool':
    case 'err': {
      const v = node.v;
      return () => v;
    }
    case 'missing':
      return () => BLANK;
    case 'array': {
      const empty = {} as Context;
      const value = ArrayValue.of(node.rows.map((r) => r.map((cell) => compileNode(cell)(empty) as Scalar)));
      return () => value;
    }
    case 'cell':
    case 'area':
    case 'cols':
    case 'rows':
      return compileRef(node);
    case 'name':
      return compileName(node.name, node.sheet);
    case 'struct': {
      const { table, spec } = node;
      return (ctx) => ctx.host.structured(table, spec, ctx);
    }
    case 'unary':
      return compileUnary(node.op, compileNode(node.x));
    case 'postfix': {
      const x = compileNode(node.x);
      if (node.op === '#') return compileSpill(x);
      return (ctx) =>
        lift1(operand(x(ctx), ctx), (v) => {
          const n = toNumber(v);
          return isError(n) ? n : num(n / 100);
        });
    }
    case 'binary':
      return compileBinary(node.op, compileNode(node.a), compileNode(node.b));
    case 'func':
      return compileCall(node.name, node.args);
    case 'call': {
      const fn = compileNode(node.fn);
      const args = node.args.map(compileNode);
      return (ctx) => {
        const f = fn(ctx);
        if (!(f instanceof LambdaValue)) return isError(f) ? f : VALUE;
        return f.call(args.map((a) => a(ctx)));
      };
    }
  }
}

// --- References ---

function sheetsOf(sheet: SheetName | null, ctx: Context): number[] | FormulaError {
  if (!sheet) return [ctx.sheet];
  if (sheet.book !== undefined) return REF;
  const first = ctx.host.sheetIndex(sheet.first);
  if (first < 0) return REF;
  if (sheet.last === undefined) return [first];
  const last = ctx.host.sheetIndex(sheet.last);
  if (last < 0) return REF;
  const out: number[] = [];
  for (let s = Math.min(first, last); s <= Math.max(first, last); s++) out.push(s);
  return out;
}

const at = (part: RefPart, d: number): number => (part.abs ? part.i : part.i + d);

function compileRef(node: Extract<Node, { t: 'cell' | 'area' | 'cols' | 'rows' }>): Compiled {
  return (ctx) => {
    const sheets = sheetsOf(node.sheet, ctx);
    if (isError(sheets)) return sheets;
    let r0: number;
    let c0: number;
    let r1: number;
    let c1: number;
    switch (node.t) {
      case 'cell':
        r0 = r1 = at(node.row, ctx.dRow);
        c0 = c1 = at(node.col, ctx.dCol);
        break;
      case 'area':
        r0 = at(node.r0, ctx.dRow);
        r1 = at(node.r1, ctx.dRow);
        c0 = at(node.c0, ctx.dCol);
        c1 = at(node.c1, ctx.dCol);
        break;
      case 'cols':
        r0 = 0;
        r1 = MAX_ROWS - 1;
        c0 = at(node.c0, ctx.dCol);
        c1 = at(node.c1, ctx.dCol);
        break;
      case 'rows':
        c0 = 0;
        c1 = MAX_COLUMNS - 1;
        r0 = at(node.r0, ctx.dRow);
        r1 = at(node.r1, ctx.dRow);
        break;
    }
    if (Math.min(r0, r1, c0, c1) < 0 || Math.max(r0, r1) >= MAX_ROWS || Math.max(c0, c1) >= MAX_COLUMNS) return REF;
    const box = (s: number) => new RangeRef(s, Math.min(r0, r1), Math.min(c0, c1), Math.max(r0, r1), Math.max(c0, c1));
    return sheets.length === 1 ? box(sheets[0]) : new MultiRef(sheets.map(box));
  };
}

function compileName(name: string, sheet: SheetName | null): Compiled {
  const upper = name.toUpperCase();
  return (ctx) => {
    if (!sheet && ctx.scope) {
      const local = ctx.scope.get(upper);
      if (local !== undefined) return local;
    }
    const sheets = sheetsOf(sheet, ctx);
    if (isError(sheets)) return sheets;
    const value = ctx.host.name(name, sheets[0], ctx);
    if (value !== null) return value;
    // A function's name on its own is the function, to pass to GROUPBY, MAP and the like (SUM for LAMBDA(x,SUM(x))).
    const spec = !sheet && FUNCTIONS.get(upper);
    if (spec && spec.fn) return new LambdaValue([], (args) => call(spec, args.map((a) => () => a), ctx));
    return NAME;
  };
}

/** `A1#`: the range a dynamic array at A1 spilled into. */
function compileSpill(x: Compiled): Compiled {
  return (ctx) => {
    const v = x(ctx);
    if (!(v instanceof RangeRef)) return isError(v) ? v : REF;
    return ctx.host.spillOf(v.sheet, v.r0, v.c0) ?? REF;
  };
}

// --- Operators ---

function compileUnary(op: '-' | '+' | '@', x: Compiled): Compiled {
  if (op === '@') {
    return (ctx) => {
      const v = x(ctx);
      if (v instanceof RangeRef) return intersect(v, ctx);
      if (v instanceof ArrayValue) return v.get(0, 0);
      return v;
    };
  }
  if (op === '+') return x;
  return (ctx) =>
    lift1(operand(x(ctx), ctx), (v) => {
      const n = toNumber(v);
      return isError(n) ? n : num(-n);
    });
}

const ARITH: Record<string, (a: number, b: number) => number | FormulaError> = {
  '+': (a, b) => num(a + b),
  '-': (a, b) => num(a - b),
  '*': (a, b) => num(a * b),
  '/': (a, b) => (b === 0 ? DIV0 : num(a / b)),
  '^': power,
};

const TESTS: Record<string, (c: number) => boolean> = {
  '=': (c) => c === 0,
  '<>': (c) => c !== 0,
  '<': (c) => c < 0,
  '>': (c) => c > 0,
  '<=': (c) => c <= 0,
  '>=': (c) => c >= 0,
};

function compileBinary(op: Extract<Node, { t: 'binary' }>['op'], a: Compiled, b: Compiled): Compiled {
  if (op === ':' || op === ' ' || op === ',') return compileRefOp(op, a, b);
  if (op === '&') {
    return (ctx) =>
      lift2(operand(a(ctx), ctx), operand(b(ctx), ctx), (x, y) => {
        const s = toText(x);
        if (isError(s)) return s;
        const t = toText(y);
        return isError(t) ? t : s + t;
      });
  }
  const arith = ARITH[op];
  if (arith) {
    return (ctx) =>
      lift2(operand(a(ctx), ctx), operand(b(ctx), ctx), (x, y) => {
        const m = toNumber(x);
        if (isError(m)) return m;
        const n = toNumber(y);
        return isError(n) ? n : arith(m, n);
      });
  }
  const test = TESTS[op];
  return (ctx) =>
    lift2(operand(a(ctx), ctx), operand(b(ctx), ctx), (x, y) => {
      if (isError(x)) return x;
      if (isError(y)) return y;
      return test(compare(x, y));
    });
}

/** The reference operators: range (the box around both), intersection (the cells in both), union (both). */
function compileRefOp(op: ':' | ' ' | ',', a: Compiled, b: Compiled): Compiled {
  return (ctx) => {
    const x = a(ctx);
    if (isError(x)) return x;
    const y = b(ctx);
    if (isError(y)) return y;
    const xs = x instanceof RangeRef ? [x] : x instanceof MultiRef ? x.ranges : null;
    const ys = y instanceof RangeRef ? [y] : y instanceof MultiRef ? y.ranges : null;
    if (!xs || !ys) return VALUE;
    if (op === ',') return new MultiRef([...xs, ...ys]);
    if (xs.length !== 1 || ys.length !== 1) return VALUE;
    const [p] = xs;
    const [q] = ys;
    if (p.sheet !== q.sheet) return VALUE;
    if (op === ':') return new RangeRef(p.sheet, Math.min(p.r0, q.r0), Math.min(p.c0, q.c0), Math.max(p.r1, q.r1), Math.max(p.c1, q.c1));
    const r0 = Math.max(p.r0, q.r0);
    const r1 = Math.min(p.r1, q.r1);
    const c0 = Math.max(p.c0, q.c0);
    const c1 = Math.min(p.c1, q.c1);
    return r0 > r1 || c0 > c1 ? NULL : new RangeRef(p.sheet, r0, c0, r1, c1);
  };
}

// --- Functions ---

function compileCall(name: string, argNodes: Node[]): Compiled {
  if (name === 'LET') return compileLet(argNodes);
  if (name === 'LAMBDA') return compileLambda(argNodes);
  const args = argNodes.map(compileNode);
  const spec = FUNCTIONS.get(name);
  if (!spec) {
    // A name that holds a LAMBDA, called like a function.
    const holder = compileName(name, null);
    return (ctx) => {
      const f = holder(ctx);
      return f instanceof LambdaValue ? f.call(args.map((a) => a(ctx))) : NAME;
    };
  }
  if (args.length < spec.min || args.length > spec.max) return () => VALUE;
  if (spec.lazy) {
    const lazy = spec.lazy;
    return (ctx) => lazy(args, ctx);
  }
  return (ctx) => call(spec, args, ctx);
}

const kindAt = (spec: FunctionSpec, i: number): ArgKind => {
  const kinds = spec.args;
  if (typeof kinds === 'string') return kinds;
  return kinds[Math.min(i, kinds.length - 1)];
};

/** Calls a function: arguments taken as it asks, and arrays given for one-value arguments taken element by element. */
export function call(spec: FunctionSpec, args: Compiled[], ctx: Context): Value {
  const fn = spec.fn!;
  const values: Value[] = new Array(args.length);
  let lifted: number[] | null = null;
  for (let i = 0; i < args.length; i++) {
    const kind = kindAt(spec, i);
    const v = args[i](ctx);
    if (kind === 'any') values[i] = v;
    else if (kind === 'array') values[i] = v instanceof RangeRef ? readArray(v, ctx) : v instanceof MultiRef ? VALUE : v;
    else {
      let s: Value = v;
      if (v instanceof RangeRef) s = v.single ? ctx.host.value(v.sheet, v.r0, v.c0) : ctx.dynamic ? readArray(v, ctx) : intersect(v, ctx);
      else if (v instanceof MultiRef) s = VALUE;
      else if (v instanceof LambdaValue) s = CALC;
      if (s instanceof ArrayValue) {
        if ((s.rows === 1 && s.cols === 1) || !ctx.dynamic) s = s.get(0, 0);
        else (lifted ??= []).push(i);
      }
      values[i] = s;
    }
  }
  if (!lifted) return fn(values, ctx);
  const arrays = lifted.map((i) => values[i] as ArrayValue);
  const rows = Math.max(...arrays.map((a) => a.rows));
  const cols = Math.max(...arrays.map((a) => a.cols));
  const data: Scalar[] = new Array(rows * cols);
  const each = values.slice();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      for (let k = 0; k < lifted.length; k++) {
        const a = arrays[k];
        const rr = a.rows === 1 ? 0 : r;
        const cc = a.cols === 1 ? 0 : c;
        each[lifted[k]] = rr < a.rows && cc < a.cols ? a.get(rr, cc) : NA;
      }
      const out = fn(each, ctx);
      data[r * cols + c] = out instanceof ArrayValue ? out.get(0, 0) : out instanceof RangeRef ? intersect(out, ctx) : out instanceof MultiRef || out instanceof LambdaValue ? VALUE : out;
    }
  }
  return new ArrayValue(rows, cols, data);
}

/** LET(name1, value1, [name2, value2, ...], result). */
function compileLet(nodes: Node[]): Compiled {
  if (nodes.length < 3 || nodes.length % 2 === 0) return () => VALUE;
  const names: string[] = [];
  const values: Compiled[] = [];
  for (let i = 0; i < nodes.length - 1; i += 2) {
    const n = nodes[i];
    if (n.t !== 'name' || n.sheet) return () => NAME;
    names.push(n.name.toUpperCase());
    values.push(compileNode(nodes[i + 1]));
  }
  const body = compileNode(nodes[nodes.length - 1]);
  return (ctx) => {
    const scope = new Map(ctx.scope ?? []);
    const inner: Context = { ...ctx, scope };
    for (let i = 0; i < names.length; i++) scope.set(names[i], values[i](inner));
    return body(inner);
  };
}

/** LAMBDA(param1, ..., body): a function value. */
function compileLambda(nodes: Node[]): Compiled {
  if (!nodes.length) return () => VALUE;
  const params: string[] = [];
  for (const n of nodes.slice(0, -1)) {
    if (n.t !== 'name' || n.sheet) return () => VALUE;
    params.push(n.name.toUpperCase());
  }
  const body = compileNode(nodes[nodes.length - 1]);
  return (ctx) =>
    new LambdaValue(params, (args) => {
      if (args.length > params.length) return VALUE;
      const scope = new Map(ctx.scope ?? []);
      params.forEach((p, i) => scope.set(p, args[i] ?? BLANK));
      return body({ ...ctx, scope });
    });
}

/** A formula's final value in its cell: a reference read; in a legacy formula a range intersected and an array's first value. */
export function finish(v: Value, ctx: Context): Scalar | ArrayValue {
  if (v instanceof RangeRef) {
    if (v.single) return ctx.host.value(v.sheet, v.r0, v.c0);
    return ctx.dynamic ? readArray(v, ctx) : intersect(v, ctx);
  }
  if (v instanceof MultiRef) return VALUE;
  if (v instanceof LambdaValue) return CALC;
  if (v instanceof ArrayValue && (!ctx.dynamic || (v.rows === 1 && v.cols === 1))) return v.get(0, 0);
  return v;
}
