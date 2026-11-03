// Data validation (Excel's Data › Validation): rules on what may be typed into cells, read from and written to the
// sheet's `<dataValidations>`. A list rule offers its choices from a drop-down arrow beside the cell; any rule with the
// Stop error style refuses a value it does not allow (warning and information styles let it in).

import { el, elements, textContent } from '@golemdocs/docx';
import type { XmlElement } from '@golemdocs/docx';
import type { Engine } from './formula/engine.ts';
import { ArrayValue, BLANK, FormulaError, RangeRef, compare } from './formula/values.ts';
import type { Scalar } from './formula/values.ts';
import type { CellRange } from './model/worksheet.ts';
import { parseRange, rangeName } from './refs.ts';

export interface Validation {
  ranges: CellRange[];
  /** any, whole, decimal, list, date, time, textLength, custom. */
  type: string;
  operator: string;
  formula1?: string;
  formula2?: string;
  allowBlank: boolean;
  /** A list's arrow is shown (the file says showDropDown="1" to hide it). */
  dropDown: boolean;
  /** stop (refuse), warning or information (let in). */
  errorStyle: string;
  /** Excel says no to a value the rule does not allow only when the rule shows its error message. */
  showError: boolean;
  error?: string;
  errorTitle?: string;
  /** The element as read, written back with its ranges as they now are. */
  element?: XmlElement;
}

export function readValidations(root: XmlElement): Validation[] {
  const list = [...elements(root)].find((e) => e.name === 'dataValidations');
  if (!list) return [];
  const out: Validation[] = [];
  for (const v of elements(list)) {
    if (v.name !== 'dataValidation') continue;
    const a = v.attrs;
    const ranges = (a.sqref ?? '').split(/\s+/).map((r) => parseRange(r)).filter((r): r is CellRange => !!r);
    if (!ranges.length) continue;
    const formula = (name: string) => {
      const f = [...elements(v)].find((c) => c.name === name);
      return f ? textContent(f) : undefined;
    };
    out.push({
      ranges,
      type: a.type ?? 'none',
      operator: a.operator ?? 'between',
      formula1: formula('formula1'),
      formula2: formula('formula2'),
      allowBlank: a.allowBlank === '1' || a.allowBlank === 'true',
      dropDown: !(a.showDropDown === '1' || a.showDropDown === 'true'),
      errorStyle: a.errorStyle ?? 'stop',
      showError: a.showErrorMessage === '1' || a.showErrorMessage === 'true',
      error: a.error,
      errorTitle: a.errorTitle,
      element: v,
    });
  }
  return out;
}

/** `<dataValidations>` as the model has it (each rule's element with its ranges as they now are). */
export function validationsElement(validations: Validation[]): XmlElement | null {
  if (!validations.length) return null;
  return el(
    'dataValidations',
    { count: validations.length },
    validations.map((v) => {
      const attrs = {
        type: v.type,
        errorStyle: v.errorStyle === 'stop' ? undefined : v.errorStyle,
        operator: v.operator === 'between' ? undefined : v.operator,
        allowBlank: v.allowBlank ? 1 : undefined,
        showDropDown: v.dropDown ? undefined : 1,
        showErrorMessage: v.showError ? 1 : undefined,
        errorTitle: v.errorTitle,
        error: v.error,
      };
      const e = v.element ?? el('dataValidation', attrs, [...(v.formula1 !== undefined ? [el('formula1', {}, [v.formula1])] : []), ...(v.formula2 !== undefined ? [el('formula2', {}, [v.formula2])] : [])]);
      e.attrs.sqref = v.ranges.map((r) => rangeName(r)).join(' ');
      for (const f of elements(e)) {
        if (f.name === 'formula1' && v.formula1 !== undefined) f.children = [v.formula1];
        if (f.name === 'formula2' && v.formula2 !== undefined) f.children = [v.formula2];
      }
      return e;
    }),
  );
}

export const validationAt = (validations: Validation[], row: number, col: number): Validation | null =>
  validations.find((v) => v.ranges.some((r) => row >= r.r0 && row <= r.r1 && col >= r.c0 && col <= r.c1)) ?? null;

/** A list rule's choices: written out ("a,b,c") or the values of the range (or name) it points to. */
export function listChoices(v: Validation, engine: Engine, sheet: number): string[] {
  const f = v.formula1;
  if (f === undefined) return [];
  if (f.startsWith('"')) return f.slice(1, -1).replace(/""/g, '"').split(',').map((s) => s.trim());
  const top = v.ranges[0];
  const value = engine.formulaReference(f, sheet, top.r0, top.c0);
  const out: string[] = [];
  const add = (s: Scalar) => {
    if (s === BLANK) return;
    out.push(s instanceof FormulaError ? s.name : typeof s === 'boolean' ? (s ? 'TRUE' : 'FALSE') : String(s));
  };
  if (value instanceof RangeRef) {
    for (let r = value.r0; r <= value.r1; r++) for (let c = value.c0; c <= value.c1; c++) add(engine.value(value.sheet, r, c));
  } else if (value instanceof ArrayValue) value.data.forEach(add);
  else add(value as Scalar);
  return out;
}

/** Whether a value may go in a cell under a rule (for the cell at row, col: formulas are relative to the rule's first cell). */
export function allows(v: Validation, value: Scalar, engine: Engine, sheet: number, row: number, col: number): boolean {
  if (value === BLANK || value === '') return v.allowBlank || v.type === 'none';
  const top = v.ranges[0];
  const operand = (f: string | undefined): Scalar => (f === undefined ? BLANK : engine.formulaValue(f, sheet, row, col, top.r0, top.c0));
  const within = (x: Scalar): boolean => {
    const a = operand(v.formula1);
    const b = operand(v.formula2);
    const c = (y: Scalar) => compare(x, y);
    switch (v.operator) {
      case 'notBetween':
        return c(a) < 0 || c(b) > 0;
      case 'equal':
        return c(a) === 0;
      case 'notEqual':
        return c(a) !== 0;
      case 'greaterThan':
        return c(a) > 0;
      case 'lessThan':
        return c(a) < 0;
      case 'greaterThanOrEqual':
        return c(a) >= 0;
      case 'lessThanOrEqual':
        return c(a) <= 0;
      default:
        return c(a) >= 0 && c(b) <= 0;
    }
  };
  switch (v.type) {
    case 'whole':
      return typeof value === 'number' && Number.isInteger(value) && within(value);
    case 'decimal':
    case 'date':
    case 'time':
      return typeof value === 'number' && within(value);
    case 'textLength':
      return within(String(value).length);
    case 'list': {
      const text = typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value);
      return listChoices(v, engine, sheet).some((c) => c.toLowerCase() === text.toLowerCase() || (typeof value === 'number' && Number(c) === value));
    }
    case 'custom': {
      const r = operand(v.formula1);
      return r === true || (typeof r === 'number' && r !== 0);
    }
    default:
      return true;
  }
}
