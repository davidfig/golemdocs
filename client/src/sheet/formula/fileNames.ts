// Functions newer than Excel 2007 are written in files with a prefix, so older versions show #NAME? rather than misread
// them: `_xlfn.XLOOKUP(...)`, and FILTER and SORT as `_xlfn._xlws.FILTER(...)`. Parameters of LET and LAMBDA get `_xlpm.`.
// People never see the prefixes: they are added on writing (toFileFormula) and removed on reading (fromFileFormula).
// The oracle (scripts/sheets/oracle.ts) checks the list against Excel: a wrong or missing entry comes back as #NAME?.

const FUTURE = new Set(
  (
    // Excel 2010
    'AGGREGATE BETA.DIST BETA.INV BINOM.DIST BINOM.INV CEILING.PRECISE CHISQ.DIST CHISQ.DIST.RT CHISQ.INV CHISQ.INV.RT ' +
    'CHISQ.TEST CONFIDENCE.NORM CONFIDENCE.T COVARIANCE.P COVARIANCE.S ERF.PRECISE ERFC.PRECISE EXPON.DIST F.DIST F.DIST.RT ' +
    'F.INV F.INV.RT F.TEST FLOOR.PRECISE GAMMA.DIST GAMMA.INV GAMMALN.PRECISE HYPGEOM.DIST LOGNORM.DIST LOGNORM.INV ' +
    'MODE.MULT MODE.SNGL NEGBINOM.DIST NETWORKDAYS.INTL NORM.DIST NORM.INV NORM.S.DIST NORM.S.INV PERCENTILE.EXC ' +
    'PERCENTILE.INC PERCENTRANK.EXC PERCENTRANK.INC POISSON.DIST QUARTILE.EXC QUARTILE.INC RANK.AVG RANK.EQ STDEV.P STDEV.S ' +
    'T.DIST T.DIST.2T T.DIST.RT T.INV T.INV.2T T.TEST VAR.P VAR.S WEIBULL.DIST WORKDAY.INTL Z.TEST ' +
    // Excel 2013
    'ACOT ACOTH ARABIC BASE BINOM.DIST.RANGE BITAND BITLSHIFT BITOR BITRSHIFT BITXOR CEILING.MATH COMBINA COT COTH CSC CSCH ' +
    'DAYS DECIMAL ENCODEURL FILTERXML FLOOR.MATH FORMULATEXT GAMMA GAUSS IFNA IMCOSH IMCOT IMCSC IMCSCH IMSEC IMSECH IMSINH ' +
    'IMTAN ISFORMULA ISOWEEKNUM MUNIT NUMBERVALUE PDURATION PERMUTATIONA PHI RRI SEC SECH SHEET SHEETS SKEW.P UNICHAR ' +
    'UNICODE WEBSERVICE XOR ' +
    // Excel 2016 and 2019
    'CONCAT FORECAST.ETS FORECAST.ETS.CONFINT FORECAST.ETS.SEASONALITY FORECAST.ETS.STAT FORECAST.LINEAR IFS MAXIFS MINIFS ' +
    'SWITCH TEXTJOIN ' +
    // Microsoft 365
    'ANCHORARRAY ARRAYTOTEXT BYCOL BYROW CHOOSECOLS CHOOSEROWS DROP EXPAND GROUPBY HSTACK IMAGE ISOMITTED LAMBDA LET MAKEARRAY ' +
    'MAP PERCENTOF PIVOTBY RANDARRAY REDUCE REGEXEXTRACT REGEXREPLACE REGEXTEST SCAN SEQUENCE SINGLE SORTBY STOCKHISTORY TAKE ' +
    'TEXTAFTER TEXTBEFORE TEXTSPLIT TOCOL TOROW TRIMRANGE UNIQUE VALUETOTEXT VSTACK WRAPCOLS WRAPROWS XLOOKUP XMATCH'
  ).split(' '),
);
/** Written as `_xlfn._xlws.NAME`. */
const WORKSHEET = new Set(['FILTER', 'SORT']);

/** Calls `piece(text, isString)` for the parts of a formula inside and outside string literals ("..."). */
function splitStrings(formula: string, piece: (text: string, isString: boolean) => string): string {
  let out = '';
  let at = 0;
  while (at < formula.length) {
    const quote = formula.indexOf('"', at);
    if (quote < 0) {
      out += piece(formula.slice(at), false);
      break;
    }
    out += piece(formula.slice(at, quote), false);
    let end = quote + 1;
    for (;;) {
      const next = formula.indexOf('"', end);
      if (next < 0) {
        end = formula.length;
        break;
      }
      if (formula[next + 1] === '"') end = next + 2;
      else {
        end = next + 1;
        break;
      }
    }
    out += piece(formula.slice(quote, end), true);
    at = end;
  }
  return out;
}

/** The names LET and LAMBDA give in a formula (upper case): what `_xlpm.` goes in front of. */
function parameters(formula: string): Set<string> {
  const out = new Set<string>();
  splitStrings(formula, (text, isString) => {
    if (isString) return text;
    // LAMBDA(a, b, body): every argument but the last; LET(a, x, b, y, body): every other one. Found by scanning for the
    // name after the opening bracket and after each top-level comma.
    for (const m of text.matchAll(/\b(LAMBDA|LET)\s*\(/gi)) {
      const lambda = m[1].toUpperCase() === 'LAMBDA';
      let depth = 0;
      let index = 0;
      let start = m.index! + m[0].length;
      for (let i = start; i <= text.length; i++) {
        const c = text[i];
        if (c === '(' || c === '{') depth++;
        else if ((c === ')' || c === '}') && depth > 0) depth--;
        else if ((c === ',' && depth === 0) || c === ')' || c === undefined) {
          const arg = text.slice(start, i).trim();
          if (/^[A-Za-z_][\w.]*$/.test(arg) && (lambda || index % 2 === 0)) out.add(arg.replace(/^_xlpm\./i, '').toUpperCase());
          index++;
          start = i + 1;
          if (c !== ',') break;
        }
      }
    }
    return text;
  });
  return out;
}

/** Functions passed by name (GROUPBY(..., SUM)) are written `_xleta.SUM`. */
const ETA = new Set(['SUM', 'AVERAGE', 'COUNT', 'COUNTA', 'MAX', 'MIN', 'PRODUCT', 'MEDIAN', 'STDEV.S', 'STDEV.P', 'VAR.S', 'VAR.P', 'ARRAYTOTEXT', 'PERCENTOF', 'MODE.SNGL', 'CONCAT', 'TEXTJOIN', 'AND', 'OR', 'XOR', 'ROWS', 'COLUMNS', 'TRANSPOSE', 'UNIQUE', 'SORT']);

/**
 * Structured references as Excel stores them: `[@Price]` and `T[@Price]` as `T[[#This Row],[Price]]`, a table-less one
 * taking the name of the table the formula is in (`table`).
 */
export function expandStructured(formula: string, table: string | null): string {
  return splitStrings(formula, (text, isString) =>
    isString
      ? text
      : text.replace(/((?:[A-Za-z_\\][\w.]*)?)\[@(\[[^\]]*(?:\]:\[[^\]]*)?\]|[^\[\],]*)\]/g, (whole, name: string, column: string) => {
          const owner = name || table;
          if (!owner) return whole;
          const col = column.startsWith('[') ? column : column ? `[${column}]` : '';
          return `${owner}[[#This Row]${col ? ',' + col : ''}]`;
        }),
  );
}

/** A formula as people write it to the form Excel stores (without the leading `=`). */
export function toFileFormula(formula: string): string {
  const params = /\b(LAMBDA|LET)\s*\(/i.test(formula) ? parameters(formula) : null;
  return splitStrings(formula, (text, isString) => {
    if (isString) return text;
    let out = text.replace(/(?<![\w.])([A-Za-z][\w.]*)(?=\()/g, (name: string) => {
      const upper = name.toUpperCase();
      if (params?.has(upper)) return `_xlpm.${name}`;
      if (WORKSHEET.has(upper)) return `_xlfn._xlws.${name}`;
      return FUTURE.has(upper) ? `_xlfn.${name}` : name;
    });
    // Names not called: LET and LAMBDA parameters, and functions passed as values.
    out = out.replace(/(?<![\w.!$'\]])([A-Za-z_][\w.]*)(?![\w.!(\[])/g, (name: string) => {
      const upper = name.toUpperCase();
      if (params?.has(upper)) return `_xlpm.${name}`;
      if (ETA.has(upper)) return `_xleta.${name}`;
      return name;
    });
    return out;
  });
}

/** A formula as stored in a file to the form people write. */
export function fromFileFormula(formula: string): string {
  return splitStrings(formula, (text, isString) => (isString ? text : text.replace(/_xlfn\.(?:_xlws\.)?|_xlpm\.|_xleta\./g, '')));
}
