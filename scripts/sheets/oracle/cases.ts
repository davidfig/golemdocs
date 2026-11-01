// The oracle's formulas (docs/spreadsheets.md, "The oracle"): each becomes a cell in a workbook that Excel calculates, and
// Excel's results are what our engine must give. One workbook per group. A case is a formula as people type it (without
// `=`), and how many rows and columns it may spill into (default one cell). Every workbook has the same Data sheet.
//
// Add cases freely; run `pnpm tsx scripts/sheets/oracle.ts` to have Excel calculate them (it rewrites the fixtures).

export interface Case {
  f: string;
  rows?: number;
  cols?: number;
}

export type Cell = number | string | boolean | null | { formula: string };

/** The Data sheet, column by column from A1 down: what the cases refer to. */
export const DATA: Record<string, Cell[]> = {
  // A: 1..10
  A: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  // B: one of each kind of value, and the awkward ones: blank, a number stored as text, an empty string, an error.
  B: [5, 'abc', true, null, { formula: 'NA()' }, 45000, '12', 0, -3.5, { formula: '""' }],
  // C, D: names and numbers for lookups (unsorted, with a repeated name).
  C: ['apple', 'Banana', 'cherry', 'apple', 'date'],
  D: [10, 20, 30, 40, 50],
  // E, F: sorted keys and their names, for approximate matches.
  E: [1, 3, 5, 7, 9],
  F: ['one', 'three', 'five', 'seven', 'nine'],
  // G: dates (serial numbers): 1900-02-28, 1900-03-01 (after Excel's phantom 29 February), 2024-02-29, 2024-12-31.
  G: [59, 61, 45351, 45657],
  // H: numbers for statistics.
  H: [2.5, 3.1, 4.7, 1.2, 9.9, 3.3, 7.4, 5.5],
  // I:K: a small database (names, regions, sales) with its field names on top; L:O: criteria ranges for it.
  I: ['Name', 'apple', 'pear', 'fig', 'kiwi', 'plum'],
  J: ['Region', 'East', 'West', 'East', 'North', 'West'],
  K: ['Sales', 100, 250, 75, 300, 125],
  L: ['Region', 'East'],
  M: ['Sales', '>90'],
  N: ['Region', 'West'],
  O: ['Sales', '>200'],
  // P, Q: two more variables for regression on H.
  P: [5, 3, 8, 1, 9, 2, 7, 4],
  Q: [2, 7, 1, 8, 2, 8, 1, 8],
};

/** Number formats: every value below through every code, as TEXT(value,"code"); client/test/sheetFormat.test.ts checks our formatter against Excel's text. */
export const FORMAT_VALUES = [0, 1, -1, 0.5, -0.5, 1234.5678, -1234.5678, 0.001234, 1234567.891, 1e15, 1.5e-10, 45351.75, 0.99999, 2.5];
export const FORMAT_CODES = [
  'General', '0', '0.00', '#,##0', '#,##0.00', '#,##0.000', '0%', '0.00%', '0.00E+00', '##0.0E+0', '0.0E+0', '# ?/?', '# ??/??', '?/?', '# ?/8', '?/100',
  '"$"#,##0.00', '#,##0.00;[Red](#,##0.00)', '0.0;-0.0;"zero"', '0;(0);-', '[>=100]0;[<0]"neg";"small"', '#,##0,', '0.0,,"M"', '000-00-0000', '00000',
  '#.##', '0.#', '?.??', '0.00?', '#,##0_);(#,##0)', '$#,##0', '"Total: "0', '0 "units"', '\\#0', '@', '0;@', 'm/d/yyyy', 'd-mmm-yy', 'mmmm d, yyyy',
  'dddd', 'ddd, mmm d', 'mmmmm', 'yy', 'h:mm', 'h:mm:ss', 'h:mm AM/PM', 'hh:mm:ss a/p', '[h]:mm:ss', '[mm]:ss', 'mm:ss.0', 'h:mm:ss.000', 'yyyy-mm-dd hh:mm',
  'm/d/yyyy h:mm', '[$-409]mmmm d, yyyy', '[$€-407] #,##0.00', 'General" kg"', '0.00_);[Red]-0.00 ',
];

/** A number as a plain decimal (Excel saves 1.5e-10 as 0.00000000015, so writing it that way keeps the formula as typed). */
const plain = (v: number): string => v.toLocaleString('en-US', { useGrouping: false, maximumSignificantDigits: 15 });

export const CASES: Record<string, Case[]> = {
  formats: FORMAT_VALUES.flatMap((v) => FORMAT_CODES.map((code) => ({ f: `TEXT(${plain(v)},"${code.replace(/"/g, '""')}")` }))),
  math: [
    'SUM(Data!A1:A10)', 'SUM(Data!B1:B10)', 'SUM(1,"2",TRUE)', 'SUMPRODUCT(Data!A1:A5,Data!A6:A10)', 'PRODUCT(Data!A1:A5)',
    '0.1+0.2', '0.1+0.2=0.3', '1/0', '-7/2', 'MOD(-7,3)', 'MOD(7,-3)', 'INT(-2.5)', 'TRUNC(-2.5)', 'ROUND(2.5,0)', 'ROUND(-2.5,0)',
    'ROUND(1.005,2)', 'ROUNDUP(1.21,1)', 'ROUNDDOWN(-1.29,1)', 'MROUND(10,3)', 'CEILING(2.1,1)', 'FLOOR.MATH(-2.5)', 'CEILING.MATH(-2.5)',
    'POWER(2,0.5)', 'SQRT(-1)', '2^10', '-2^2', 'EXP(1)', 'LN(0)', 'LOG(1000)', 'LOG10(0.001)', 'FACT(20)', 'FACT(170)', 'FACT(171)',
    'COMBIN(10,3)', 'GCD(12,18)', 'LCM(4,6)', 'ABS(-0)', 'SIGN(-0.001)', 'PI()', 'SIN(PI())', 'ATAN2(1,1)', 'DEGREES(PI())',
    'SUMIF(Data!C1:C5,"apple",Data!D1:D5)', 'SUMIFS(Data!D1:D5,Data!C1:C5,"<>apple",Data!D1:D5,">15")', 'COUNTIF(Data!C1:C5,"a*")',
    'SUBTOTAL(9,Data!A1:A10)', 'AGGREGATE(9,6,Data!B1:B10)', '12345678901234567890', '9.99999999999999E+307*10', '2^-1074',
  ].map((f) => ({ f })),
  logical: [
    'IF(TRUE,1,2)', 'IF(0,"yes","no")', 'IF("TRUE",1,2)', 'IF(Data!B4,1,2)', 'AND(TRUE,1,"x")', 'AND(Data!B1:B3)', 'OR(FALSE,0)', 'XOR(TRUE,TRUE,TRUE)',
    'NOT(0)', 'IFERROR(1/0,"div")', 'IFERROR(Data!B5,"na")', 'IFNA(Data!B5,"na")', 'IFS(FALSE,1,TRUE,2)', 'IFS(FALSE,1)',
    'SWITCH(2,1,"a",2,"b","other")', 'SWITCH(9,1,"a")', 'TRUE+TRUE', 'TRUE=1', '"a"="A"', '"a"<"B"', '1<"1"', 'Data!B4=0', 'Data!B4=""',
  ].map((f) => ({ f })),
  text: [
    'LEFT("hello",2)', 'RIGHT("hello",10)', 'MID("hello",2,3)', 'MID("hello",0,1)', 'LEN("héllo😀")', 'UPPER("straße")', 'PROPER("hello WORLD o\'neil")',
    'TRIM("  a   b  ")', 'SUBSTITUTE("aaa","a","b",2)', 'REPLACE("abcdef",2,3,"X")', 'FIND("b","abcb",3)', 'FIND("z","abc")', 'SEARCH("B?","abcb")',
    'CONCAT(Data!C1:C3)', 'TEXTJOIN("-",TRUE,Data!B1:B4)', '"a"&1&TRUE', 'REPT("ab",3)', 'EXACT("a","A")', 'CODE("A")', 'CHAR(65)', 'UNICHAR(128512)',
    'VALUE("1,234.5")', 'VALUE("12%")', 'VALUE("abc")', 'NUMBERVALUE("1.234,5",",",".")', 'TEXT(1234.567,"#,##0.00")', 'TEXT(0.5,"0%")',
    'TEXT(45351,"dddd, mmmm d, yyyy")', 'TEXT(-1.5,"0.0;(0.0)")', 'TEXT(0.75,"h:mm AM/PM")', 'TEXT(1234567,"0.00E+00")', 'TEXT(3.14159,"# ?/?")',
    'FIXED(1234.567,1)', 'DOLLAR(-1234.5)', 'T(5)', 'N("5")', 'CLEAN("a"&CHAR(7)&"b")', 'TEXTBEFORE("a-b-c","-",-1)', 'TEXTAFTER("a-b-c","-")',
  ].map((f) => ({ f })),
  lookup: [
    'VLOOKUP("apple",Data!C1:D5,2,FALSE)', 'VLOOKUP("APPLE",Data!C1:D5,2,FALSE)', 'VLOOKUP("zzz",Data!C1:D5,2,FALSE)', 'VLOOKUP(6,Data!E1:F5,2,TRUE)',
    'VLOOKUP(0,Data!E1:F5,2)', 'HLOOKUP(3,Data!A1:A10,1,FALSE)', 'INDEX(Data!C1:D5,3,2)', 'MATCH("cherry",Data!C1:C5,0)',
    'MATCH(6,Data!E1:E5)', 'MATCH("b*",Data!C1:C5,0)', 'XLOOKUP("apple",Data!C1:C5,Data!D1:D5)', 'XLOOKUP("apple",Data!C1:C5,Data!D1:D5,,0,-1)',
    'XLOOKUP(6,Data!E1:E5,Data!F1:F5,"none",1)', 'XLOOKUP("zzz",Data!C1:C5,Data!D1:D5,"none")', 'XMATCH(7,Data!E1:E5)', 'CHOOSE(2,"a","b","c")',
    'ROWS(Data!A1:C7)', 'COLUMNS(Data!A1:C7)', 'ROW(Data!C3)', 'COLUMN(Data!C3)', 'ADDRESS(3,28)', 'ADDRESS(3,28,4)', 'INDIRECT("Data!A3")', 'OFFSET(Data!A1,2,0)',
    'SUM(OFFSET(Data!A1,0,0,3,1))', 'LOOKUP(6,Data!E1:E5,Data!F1:F5)',
  ].map((f) => ({ f })),
  date: [
    'DATE(2024,2,29)', 'DATE(2023,2,29)', 'DATE(2024,13,1)', 'DATE(1900,2,29)', 'DATE(99,1,1)', 'YEAR(Data!G1)', 'MONTH(Data!G2)', 'DAY(60)',
    'WEEKDAY(Data!G3)', 'WEEKDAY(Data!G3,2)', 'WEEKNUM(Data!G4)', 'ISOWEEKNUM(Data!G4)', 'EOMONTH(Data!G3,1)', 'EDATE(DATE(2024,1,31),1)',
    'DATEDIF(DATE(2020,2,29),DATE(2024,2,28),"Y")', 'DATEDIF(DATE(2020,1,31),DATE(2020,3,1),"MD")', 'DAYS(Data!G4,Data!G3)', 'DAYS360(DATE(2024,1,31),DATE(2024,3,31))',
    'NETWORKDAYS(DATE(2024,1,1),DATE(2024,1,31))', 'WORKDAY(DATE(2024,1,5),1)', 'YEARFRAC(DATE(2024,1,1),DATE(2024,7,1),1)', 'DATEVALUE("2024-02-29")',
    'TIMEVALUE("6:30 PM")', 'TIME(25,0,0)', 'HOUR(0.75)', 'MINUTE(0.7604166)', 'SECOND(TIME(0,0,59.5))',
  ].map((f) => ({ f })),
  statistical: [
    'AVERAGE(Data!B1:B10)', 'AVERAGEA(Data!B1:B3)', 'AVERAGE(Data!B4)', 'COUNT(Data!B1:B10)', 'COUNTA(Data!B1:B10)', 'COUNTBLANK(Data!B1:B10)',
    'MAX(Data!H1:H8)', 'MIN(Data!B1:B10)', 'MEDIAN(Data!H1:H8)', 'MODE.SNGL(1,2,2,3)', 'STDEV.S(Data!H1:H8)', 'STDEV.P(Data!H1:H8)', 'VAR.S(Data!H1:H8)',
    'LARGE(Data!H1:H8,2)', 'SMALL(Data!H1:H8,9)', 'RANK.EQ(4.7,Data!H1:H8)', 'RANK.AVG(4.7,Data!H1:H8,1)', 'PERCENTILE.INC(Data!H1:H8,0.3)', 'PERCENTILE.EXC(Data!H1:H8,0.3)',
    'QUARTILE.INC(Data!H1:H8,1)', 'CORREL(Data!A1:A8,Data!H1:H8)', 'SLOPE(Data!H1:H8,Data!A1:A8)', 'FORECAST.LINEAR(9,Data!H1:H8,Data!A1:A8)',
    'NORM.DIST(1,0,1,TRUE)', 'NORM.S.INV(0.975)', 'T.INV.2T(0.05,10)', 'T.DIST(1.5,10,TRUE)', 'CHISQ.DIST.RT(3.84,1)', 'F.DIST(2,3,4,TRUE)',
    'BINOM.DIST(3,10,0.5,FALSE)', 'POISSON.DIST(2,3,TRUE)', 'GAMMA.DIST(2,3,1,TRUE)', 'BETA.INV(0.5,2,3)', 'GAMMALN(10)', 'GEOMEAN(Data!H1:H8)',
  ].map((f) => ({ f })),
  financial: [
    'PMT(0.05/12,360,200000)', 'FV(0.04,10,-1000)', 'PV(0.06,5,0,-1000)', 'NPER(0.01,-100,1000)', 'RATE(36,-300,9000)', 'NPV(0.1,-1000,300,400,500)',
    'IRR({-1000,300,400,500})', 'XNPV(0.1,{-1000,500,700},{45000,45200,45400})', 'XIRR({-1000,500,700},{45000,45200,45400})', 'IPMT(0.05/12,1,360,200000)',
    'CUMIPMT(0.05/12,360,200000,1,12,0)', 'SLN(10000,1000,5)', 'DDB(10000,1000,5,2)', 'EFFECT(0.05,12)',
  ].map((f) => ({ f })),
  info: [
    'ISBLANK(Data!B4)', 'ISBLANK(Data!B10)', 'ISNUMBER(Data!B7)', 'ISTEXT(Data!B10)', 'ISERROR(Data!B5)', 'ISNA(Data!B5)', 'ERROR.TYPE(1/0)',
    'TYPE(Data!B3)', 'TYPE({1,2})', 'N(Data!B3)', 'ISEVEN(-2.5)', 'ISLOGICAL(Data!B3)', 'ISREF(Data!A1)', 'ISFORMULA(Data!B5)', 'NA()',
  ].map((f) => ({ f })),
  engineering: [
    'BIN2DEC(1100100)', 'BIN2DEC("1111111111")', 'DEC2BIN(9,8)', 'DEC2BIN(-100)', 'DEC2HEX(255)', 'DEC2HEX(-1)', 'HEX2DEC("FFFFFFFFFF")', 'HEX2OCT("1F")',
    'OCT2BIN("777")', 'DEC2OCT(58,3)', 'BIN2HEX("1110")', 'DEC2BIN(512)', 'BITAND(13,25)', 'BITOR(23,10)', 'BITXOR(5,3)', 'BITLSHIFT(4,2)', 'BITRSHIFT(13,2)',
    'COMPLEX(3,4)', 'COMPLEX(0,-1)', 'COMPLEX(3,4,"j")', 'IMABS("3+4i")', 'IMREAL("6-9i")', 'IMAGINARY("i")', 'IMARGUMENT("3+4i")', 'IMCONJUGATE("3+4i")',
    'IMSUM("3+4i","5-3i")', 'IMSUB("13+4i","5+3i")', 'IMPRODUCT("3+4i","5-3i")', 'IMDIV("-238+240i","10+24i")', 'IMPOWER("2+3i",3)', 'IMSQRT("1+i")',
    'IMEXP("1+i")', 'IMLN("3+4i")', 'IMLOG10("3+4i")', 'IMLOG2("3+4i")', 'IMSIN("4+3i")', 'IMCOS("1+i")', 'IMTAN("4+3i")', 'IMSINH("4+3i")', 'IMCOSH("4+3i")',
    'IMSEC("4+3i")', 'IMCSC("4+3i")', 'IMCOT("4+3i")', 'IMSECH("4+3i")', 'IMCSCH("4+3i")', 'BESSELJ(1.9,2)', 'BESSELI(1.5,1)', 'BESSELK(1.5,1)', 'BESSELY(2.5,1)',
    'BESSELJ(10,0)', 'BESSELY(0.5,3)', 'ERF(0.745)', 'ERF(1,2)', 'ERFC(1)', 'ERF.PRECISE(0.5)', 'DELTA(5,4)', 'GESTEP(5,4)', 'CONVERT(1,"lbm","kg")',
    'CONVERT(68,"F","C")', 'CONVERT(2.5,"ft","sec")', 'CONVERT(1,"mi","km")', 'CONVERT(100,"kg","ozm")', 'CONVERT(1,"gal","l")', 'CONVERT(1,"kibyte","bit")',
    'CONVERT(1,"hr","mn")', 'CONVERT(100,"C","K")', 'CONVERT(1,"atm","mmHg")', 'CONVERT(1,"BTU","J")', 'CONVERT(1,"HP","W")', 'CONVERT(1,"m2","ft2")',
    'CONVERT(1,"Nmi","m")', 'CONVERT(1,"cm3","in3")', 'CONVERT(1,"mph","m/s")',
  ].map((f) => ({ f })),
  database: [
    'DSUM(Data!I1:K6,"Sales",Data!L1:L2)', 'DAVERAGE(Data!I1:K6,3,Data!L1:L2)', 'DCOUNT(Data!I1:K6,"Sales",Data!N1:O2)', 'DCOUNTA(Data!I1:K6,"Name",Data!L1:M2)',
    'DGET(Data!I1:K6,"Name",Data!N1:O2)', 'DGET(Data!I1:K6,"Name",Data!L1:L2)', 'DMAX(Data!I1:K6,"Sales",Data!N1:N2)', 'DMIN(Data!I1:K6,"Sales",Data!L1:L2)',
    'DPRODUCT(Data!I1:K6,"Sales",Data!L1:L2)', 'DSTDEV(Data!I1:K6,"Sales",Data!N1:N2)', 'DSTDEVP(Data!I1:K6,"Sales",Data!N1:N2)', 'DVAR(Data!I1:K6,"Sales",Data!N1:N2)',
    'DVARP(Data!I1:K6,"Sales",Data!N1:N2)', 'DSUM(Data!I1:K6,"Sales",Data!M1:M2)',
  ].map((f) => ({ f })),
  bonds: [
    'PRICE(DATE(2008,2,15),DATE(2017,11,15),0.0575,0.065,100,2,0)', 'PRICE(DATE(2008,2,15),DATE(2017,11,15),0.0575,0.065,100,2,1)',
    'PRICE(DATE(2008,2,15),DATE(2017,11,15),0.0575,0.065,100,4,4)', 'PRICE(DATE(2008,2,15),DATE(2008,11,15),0.0575,0.065,100,2,1)',
    'YIELD(DATE(2008,2,15),DATE(2016,11,15),0.0575,95.04287,100,2,0)', 'YIELD(DATE(2008,2,15),DATE(2008,11,15),0.0575,99.5,100,2,1)',
    'COUPDAYBS(DATE(2011,1,25),DATE(2011,11,15),2,1)', 'COUPDAYS(DATE(2011,1,25),DATE(2011,11,15),2,1)', 'COUPDAYSNC(DATE(2011,1,25),DATE(2011,11,15),2,1)',
    'COUPNCD(DATE(2011,1,25),DATE(2011,11,15),2,1)', 'COUPNUM(DATE(2007,1,25),DATE(2008,11,15),2,1)', 'COUPPCD(DATE(2011,1,25),DATE(2011,11,15),2,1)',
    'COUPDAYBS(DATE(2011,1,25),DATE(2011,11,15),2,0)', 'COUPDAYSNC(DATE(2011,1,25),DATE(2011,11,15),2,0)', 'COUPDAYS(DATE(2011,1,25),DATE(2011,11,15),4,3)',
    'COUPDAYSNC(DATE(2011,1,25),DATE(2011,11,30),2,4)', 'COUPPCD(DATE(2011,3,31),DATE(2012,2,29),4,0)', 'DURATION(DATE(2018,7,1),DATE(2048,1,1),0.08,0.09,2,1)',
    'MDURATION(DATE(2008,1,1),DATE(2016,1,1),0.08,0.09,2,1)', 'ACCRINT(DATE(2008,3,1),DATE(2008,8,31),DATE(2008,5,1),0.1,1000,2,0)',
    'ACCRINT(DATE(2008,3,5),DATE(2008,8,31),DATE(2008,5,1),0.1,1000,2,0,FALSE)', 'ACCRINT(DATE(2007,1,1),DATE(2007,7,1),DATE(2008,3,15),0.05,1000,2,1)',
    'ACCRINTM(DATE(2008,4,1),DATE(2008,6,15),0.1,1000,3)', 'DISC(DATE(2018,7,1),DATE(2048,1,1),97.975,100,1)', 'INTRATE(DATE(2008,2,15),DATE(2008,5,15),1000000,1014420,2)',
    'RECEIVED(DATE(2008,2,15),DATE(2008,5,15),1000000,0.0575,2)', 'PRICEDISC(DATE(2008,2,16),DATE(2008,3,1),0.0525,100,2)',
    'YIELDDISC(DATE(2008,2,16),DATE(2008,3,1),99.795,100,2)', 'PRICEMAT(DATE(2008,2,15),DATE(2008,4,13),DATE(2007,11,11),0.061,0.061,0)',
    'PRICEMAT(DATE(2008,2,15),DATE(2008,4,13),DATE(2007,11,11),0.061,0.061,1)', 'YIELDMAT(DATE(2008,3,15),DATE(2008,11,3),DATE(2007,11,8),0.0625,100.0123,0)',
    'TBILLPRICE(DATE(2008,3,31),DATE(2008,6,1),0.09)', 'TBILLYIELD(DATE(2008,3,31),DATE(2008,6,1),98.45)', 'TBILLEQ(DATE(2008,3,31),DATE(2008,6,1),0.0914)',
    'TBILLEQ(DATE(2008,3,31),DATE(2009,2,1),0.0914)', 'DOLLARDE(1.02,16)', 'DOLLARFR(1.125,16)', 'DOLLARDE(1.1,32)',
    'AMORLINC(2400,DATE(2008,8,19),DATE(2008,12,31),300,1,0.15,1)', 'AMORDEGRC(2400,DATE(2008,8,19),DATE(2008,12,31),300,1,0.15,1)',
    'ODDFPRICE(DATE(2008,11,11),DATE(2021,3,1),DATE(2008,10,15),DATE(2009,3,1),0.0785,0.0625,100,2,1)',
    'ODDFYIELD(DATE(2008,11,11),DATE(2021,3,1),DATE(2008,10,15),DATE(2009,3,1),0.0575,84.5,100,2,0)',
    'ODDLPRICE(DATE(2008,2,7),DATE(2008,6,15),DATE(2007,10,15),0.0375,0.0405,100,2,0)', 'ODDLYIELD(DATE(2008,4,20),DATE(2008,6,15),DATE(2007,12,24),0.0375,99.875,100,2,0)',
  ].map((f) => ({ f })),
  regression: [
    { f: 'LINEST(Data!H1:H8,Data!A1:A8)', cols: 2 },
    { f: 'LINEST(Data!H1:H8,Data!A1:A8,TRUE,TRUE)', rows: 5, cols: 2 },
    { f: 'LINEST(Data!H1:H8,Data!P1:Q8)', cols: 3 },
    { f: 'LINEST(Data!H1:H8,Data!P1:Q8,TRUE,TRUE)', rows: 5, cols: 3 },
    { f: 'LINEST(Data!H1:H8,Data!A1:A8,FALSE)', cols: 2 },
    { f: 'LOGEST(Data!H1:H8,Data!A1:A8)', cols: 2 },
    { f: 'LOGEST(Data!H1:H8,Data!A1:A8,TRUE,TRUE)', rows: 5, cols: 2 },
    { f: 'TREND(Data!H1:H8,Data!A1:A8,{9;10})', rows: 2 },
    { f: 'GROWTH(Data!H1:H8,Data!A1:A8,{9;10})', rows: 2 },
    { f: 'TREND(Data!H1:H8)', rows: 8 },
    { f: 'T.TEST(Data!H1:H8,Data!A1:A8,2,1)' },
    { f: 'T.TEST(Data!H1:H8,Data!A1:A8,2,2)' },
    { f: 'T.TEST(Data!H1:H8,Data!A1:A8,1,3)' },
    { f: 'Z.TEST(Data!H1:H8,4)' },
    { f: 'Z.TEST(Data!H1:H8,4,2)' },
    { f: 'CHISQ.TEST({58,35;11,25;10,23},{45.35,47.65;17.56,18.44;16.09,16.91})' },
    { f: 'F.TEST(Data!H1:H8,Data!A1:A8)' },
    { f: 'HYPGEOMDIST(1,4,8,20)' },
    { f: 'NEGBINOMDIST(10,5,0.25)' },
  ],
  misc: [
    { f: 'VALUETOTEXT("abc",1)' },
    { f: 'VALUETOTEXT(12.5)' },
    { f: 'ARRAYTOTEXT({1,"a";TRUE,2})' },
    { f: 'ARRAYTOTEXT({1,"a";TRUE,2},1)' },
    { f: 'BAHTTEXT(1234.56)' },
    { f: 'BAHTTEXT(21)' },
    { f: 'BAHTTEXT(0)' },
    { f: 'BAHTTEXT(1000000)' },
    { f: 'BAHTTEXT(101)' },
    { f: 'BAHTTEXT(11.01)' },
    { f: 'REGEXTEST("abc123","[0-9]+")' },
    { f: 'REGEXTEST("ABC","abc",1)' },
    { f: 'REGEXEXTRACT("abc123def456","[0-9]+")' },
    { f: 'REGEXEXTRACT("abc123def456","[0-9]+",1)', cols: 2 },
    { f: 'REGEXEXTRACT("John Smith","(\\w+) (\\w+)",2)', cols: 2 },
    { f: 'REGEXREPLACE("abc123","[0-9]","#")' },
    { f: 'REGEXREPLACE("a1b2c3","[0-9]","#",2)' },
    { f: 'CELL("address",Data!C3)' },
    { f: 'CELL("col",Data!C3)' },
    { f: 'CELL("contents",Data!A2)' },
    { f: 'CELL("type",Data!C1)' },
    { f: 'INFO("recalc")' },
    { f: 'PERCENTOF(Data!A1:A3,Data!A1:A10)' },
    { f: 'GROUPBY(Data!J2:J6,Data!K2:K6,SUM)', rows: 4, cols: 2 },
    { f: 'GROUPBY(Data!J2:J6,Data!K2:K6,AVERAGE,0,0)', rows: 3, cols: 2 },
    { f: 'PIVOTBY(Data!J2:J6,Data!I2:I6,Data!K2:K6,SUM)', rows: 5, cols: 7 },
    { f: 'TRIMRANGE(Data!A1:A20)', rows: 10 },
    { f: 'SUM(TRIMRANGE(Data!H1:H30))' },
    { f: 'MAP({1,2,3},LAMBDA(x,x*2))', cols: 3 },
    { f: 'BYROW({1,2;3,4},SUM)', rows: 2 },
  ],
  tables: [
    'SUM(Sales[Sales])', 'AVERAGE(Sales[Sales])', 'Sales[[#Headers],[Region]]', 'COUNTA(Sales[#All])', 'ROWS(Sales[#Data])', 'INDEX(Sales[Name],2)',
    'SUMIFS(Sales[Sales],Sales[Region],"West")', 'XLOOKUP("fig",Sales[Name],Sales[Sales])', 'COLUMNS(Sales[[Name]:[Region]])', 'COUNTIF(Sales[Region],"East")',
    'MAX(Sales[[#Data],[Sales]])', 'ROWS(Sales[#Headers])',
  ].map((f) => ({ f })),
  dynamic: [
    { f: 'SEQUENCE(3,2)', rows: 3, cols: 2 },
    { f: 'SEQUENCE(1,4,10,-2)', cols: 4 },
    { f: 'SORT(Data!C1:C5)', rows: 5 },
    { f: 'SORT(Data!C1:D5,2,-1)', rows: 5, cols: 2 },
    { f: 'SORTBY(Data!C1:C5,Data!D1:D5,-1)', rows: 5 },
    { f: 'UNIQUE(Data!C1:C5)', rows: 5 },
    { f: 'FILTER(Data!C1:C5,Data!D1:D5>25)', rows: 5 },
    { f: 'FILTER(Data!C1:C5,Data!D1:D5>99,"none")', rows: 1 },
    { f: 'TRANSPOSE(Data!E1:E5)', cols: 5 },
    { f: 'INDEX(Data!C1:D5,0,1)', rows: 5 },
    { f: 'Data!A1:A3*10', rows: 3 },
    { f: 'TEXTSPLIT("a,b;c,d",",",";")', rows: 2, cols: 2 },
    { f: 'VSTACK({1,2},{3,4})', rows: 2, cols: 2 },
    { f: 'TAKE(Data!A1:A10,-3)', rows: 3 },
    { f: 'TOCOL({1,2;3,4})', rows: 4 },
    { f: 'MMULT({1,2;3,4},{5;6})', rows: 2 },
    { f: 'SUM(Data!A1:A10*(Data!A1:A10>5))' },
    { f: 'SEQUENCE(2)+SEQUENCE(1,3)', rows: 2, cols: 3 },
  ],
};
