// Sheet protection (Excel's Protect Sheet): a protected sheet refuses changes to its locked cells (every cell is locked
// unless its style says otherwise), and to its layout, except what `<sheetProtection>` allows; the formulas of its hidden
// cells are not shown. A password is kept as Excel keeps it: a salted SHA-512 hash, spun 100,000 times (older files have
// a 16-bit `password` hash instead). Unprotecting checks the password against it.

import { el } from '@golemdocs/docx';
import type { XmlElement } from '@golemdocs/docx';
import { Kind, MAX_COLUMNS, MAX_ROWS } from './model/column.ts';
import type { Workbook } from './model/workbook.ts';
import type { Worksheet } from './model/worksheet.ts';
import type { EditOp } from './protocol.ts';
import type { CellRange } from './model/worksheet.ts';

/** A sheet's `<sheetProtection>` attributes, as read (and written back). */
export type SheetProtection = Record<string, string>;

const on = (v: string | undefined): boolean => v === '1' || v === 'true';

/** Whether the protection is on (a `<sheetProtection>` may be there with `sheet="0"`). */
export const isProtected = (p: SheetProtection | null): p is SheetProtection => !!p && on(p.sheet);

/** What a protected sheet may allow. Each is refused unless its attribute says "0"; objects (notes) are allowed unless it says "1". */
type Allowance = 'formatCells' | 'formatColumns' | 'formatRows' | 'insertColumns' | 'insertRows' | 'deleteColumns' | 'deleteRows' | 'sort' | 'autoFilter' | 'objects';

function allows(p: SheetProtection, what: Allowance): boolean {
  const v = p[what];
  if (what === 'objects') return !on(v);
  return v === '0' || v === 'false';
}

export function readProtection(root: XmlElement): SheetProtection | null {
  const e = root.children.find((c): c is XmlElement => typeof c !== 'string' && c.name === 'sheetProtection');
  return e ? { ...e.attrs } : null;
}

export const protectionElement = (p: SheetProtection | null): XmlElement | null => (p ? el('sheetProtection', p) : null);

/** A cell's style protects it: locked unless the style says it is not (and every style but one that says so is locked). */
function lockedStyle(book: Workbook, style: number): boolean {
  return book.styles.format(style)?.protection?.locked !== false;
}

/** Whether a cell's formula is hidden (on a protected sheet). */
export function hiddenFormula(book: Workbook, sheet: Worksheet, row: number, col: number): boolean {
  if (!isProtected(sheet.protection)) return false;
  const column = sheet.grid.columns[col];
  return book.styles.format(column?.style(row) ?? 0)?.protection?.hidden === true;
}

/** Whether a cell is locked: its style, or (empty) its row's or column's. */
export function lockedCell(book: Workbook, sheet: Worksheet, row: number, col: number): boolean {
  const column = sheet.grid.columns[col];
  const kind = column?.kind(row) ?? Kind.Empty;
  return lockedStyle(book, kind === Kind.Empty ? (sheet.rowStyles.get(row) ?? sheet.colStyles.get(col) ?? 0) : column!.style(row));
}

/** Whether any cell of a range is locked. The rows past the data are checked through their row and column styles. */
export function lockedRange(book: Workbook, sheet: Worksheet, r: CellRange): boolean {
  const grid = sheet.grid;
  const c1 = Math.min(r.c1, MAX_COLUMNS - 1);
  const r1 = Math.min(r.r1, MAX_ROWS - 1);
  const dataEnd = Math.min(r1, grid.rows - 1);
  for (let c = r.c0; c <= c1; c++) {
    if (c >= grid.cols) {
      // Columns past the data: empty, so their column's style or a styled row's.
      if (lockedStyle(book, sheet.colStyles.get(c) ?? 0)) return true;
      continue;
    }
    for (let row = r.r0; row <= dataEnd; row++) if (lockedCell(book, sheet, row, c)) return true;
    if (r1 > dataEnd && lockedStyle(book, sheet.colStyles.get(c) ?? 0)) return true;
  }
  for (const [row, style] of sheet.rowStyles) if (row > Math.max(dataEnd, r.r0 - 1) && row <= r1 && lockedStyle(book, style)) return true;
  return false;
}

/** Whether a protected sheet refuses an edit. Edits to the workbook (sheets added, renamed...) are not the sheet's to refuse. */
export function refuses(book: Workbook, sheet: Worksheet, op: EditOp): boolean {
  const p = sheet.protection;
  if (!isProtected(p)) return false;
  const locked = (r: CellRange) => lockedRange(book, sheet, r);
  switch (op.kind) {
    case 'input':
      return locked(op.range);
    case 'paste':
      return locked({ r0: op.at.row, c0: op.at.col, r1: op.at.row + Math.max(0, op.rows.length - 1), c1: op.at.col + Math.max(0, ...op.rows.map((r) => r.length - 1)) });
    case 'clear':
      return op.what === 'formats' ? !allows(p, 'formatCells') : op.ranges.some(locked);
    case 'replace':
      return !op.cells || op.cells.some((c) => lockedCell(book, sheet, c.row, c.col));
    case 'fill':
      return locked(op.target);
    case 'pasteCells': {
      const rows = op.source.r1 - op.source.r0;
      const cols = op.source.c1 - op.source.c0;
      const [h, w] = op.transpose ? [cols, rows] : [rows, cols];
      return (op.what === 'formats' && !allows(p, 'formatCells')) || locked({ r0: op.at.row, c0: op.at.col, r1: op.at.row + h, c1: op.at.col + w });
    }
    case 'sort':
      return !allows(p, 'sort') || locked(op.range);
    case 'filter':
      return !allows(p, 'autoFilter');
    case 'note':
    case 'insertChart':
    case 'chart':
    case 'insertSparklines':
    case 'clearSparklines':
      return !allows(p, 'objects');
    case 'format':
      return !allows(p, 'formatCells');
    case 'rowHeight':
    case 'hideRows':
      return !allows(p, 'formatRows');
    case 'columnWidth':
    case 'hideColumns':
      return !allows(p, 'formatColumns');
    case 'insertRows':
      return !allows(p, 'insertRows');
    case 'deleteRows':
      return !allows(p, 'deleteRows');
    case 'insertColumns':
      return !allows(p, 'insertColumns');
    case 'deleteColumns':
      return !allows(p, 'deleteColumns');
    case 'autoFilter':
    case 'createTable':
    case 'group':
    case 'collapse':
    case 'outlineLevel':
    case 'merge':
    case 'unmerge':
      return true;
    default:
      return false;
  }
}

// --- Passwords ------------------------------------------------------------------------------------------------------

const SPIN = 100_000;

/** The attributes of a protection turned on now, with a password's hash if there is one. */
export function protect(password: string, salt: Uint8Array = crypto.getRandomValues(new Uint8Array(16))): SheetProtection {
  const p: SheetProtection = { sheet: '1', objects: '1', scenarios: '1' };
  if (!password) return p;
  return { algorithmName: 'SHA-512', hashValue: base64(spunHash(password, salt, SPIN)), saltValue: base64(salt), spinCount: String(SPIN), ...p };
}

/** Whether a password opens a protection: no password is needed when it has none. */
export function passwordOpens(p: SheetProtection, password: string): boolean {
  if (p.hashValue && p.saltValue) {
    if ((p.algorithmName ?? 'SHA-512').toUpperCase() !== 'SHA-512') return false;
    return base64(spunHash(password, unbase64(p.saltValue), +(p.spinCount ?? 0))) === p.hashValue;
  }
  if (p.password) return legacyHash(password) === p.password.toUpperCase().padStart(4, '0');
  return true;
}

/** Whether a protection asks for a password. */
export const hasPassword = (p: SheetProtection): boolean => !!(p.hashValue || p.password);

/** Excel's hash: SHA-512 of the salt and the password (UTF-16LE), then again of the hash and the round number, `spin` times. */
export function spunHash(password: string, salt: Uint8Array, spin: number): Uint8Array {
  const text = new Uint8Array(password.length * 2);
  for (let i = 0; i < password.length; i++) {
    text[i * 2] = password.charCodeAt(i) & 0xff;
    text[i * 2 + 1] = password.charCodeAt(i) >> 8;
  }
  const first = new Uint8Array(salt.length + text.length);
  first.set(salt);
  first.set(text, salt.length);
  let hash = sha512(first);
  const round = new Uint8Array(68);
  for (let i = 0; i < spin; i++) {
    round.set(hash);
    round[64] = i & 0xff;
    round[65] = (i >>> 8) & 0xff;
    round[66] = (i >>> 16) & 0xff;
    round[67] = (i >>> 24) & 0xff;
    hash = sha512(round);
  }
  return hash;
}

/** The 16-bit hash older files keep in `password` (hex). */
export function legacyHash(password: string): string {
  let h = 0;
  for (let i = password.length - 1; i >= 0; i--) {
    h = ((h >> 14) & 1) | ((h << 1) & 0x7fff);
    h ^= password.charCodeAt(i);
  }
  h = ((h >> 14) & 1) | ((h << 1) & 0x7fff);
  h ^= password.length ^ 0xce4b;
  return h.toString(16).toUpperCase().padStart(4, '0');
}

const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unbase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

// SHA-512 (FIPS 180-4), on 64-bit words held as high and low 32-bit halves.
const K = [
  0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc, 0x3956c25b, 0xf348b538, 0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b,
  0xab1c5ed5, 0xda6d8118, 0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe, 0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2, 0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1,
  0x9bdc06a7, 0x25c71235, 0xc19bf174, 0xcf692694, 0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65, 0x2de92c6f, 0x592b0275,
  0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5, 0x983e5152, 0xee66dfab, 0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4,
  0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725, 0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70, 0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed,
  0x53380d13, 0x9d95b3df, 0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b, 0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001,
  0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30, 0xd192e819, 0xd6ef5218, 0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8, 0x19a4c116, 0xb8d2d0c8,
  0x1e376c08, 0x5141ab53, 0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8, 0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373, 0x682e6ff3, 0xd6b2b8a3,
  0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec, 0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915,
  0xc67178f2, 0xe372532b, 0xca273ece, 0xea26619c, 0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178, 0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6,
  0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b, 0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc, 0x431d67c4, 0x9c100d4c, 0x4cc5d4be, 0xcb3e42b6,
  0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817,
];
const INIT = [0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1, 0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179];
const W = new Int32Array(160);

export function sha512(data: Uint8Array): Uint8Array {
  const length = data.length;
  const padded = new Uint8Array(Math.ceil((length + 17) / 128) * 128);
  padded.set(data);
  padded[length] = 0x80;
  const bits = length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits >>> 0);
  const H = Int32Array.from(INIT);
  for (let block = 0; block < padded.length; block += 128) {
    for (let i = 0; i < 32; i++) W[i] = view.getInt32(block + i * 4);
    for (let i = 32; i < 160; i += 2) {
      // σ0 of W[i-30], σ1 of W[i-4], plus W[i-14] and W[i-32].
      let xh = W[i - 30], xl = W[i - 29];
      const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
      const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
      xh = W[i - 4];
      xl = W[i - 3];
      const s1h = ((xh >>> 19) | (xl << 13)) ^ ((xl >>> 29) | (xh << 3)) ^ (xh >>> 6);
      const s1l = ((xl >>> 19) | (xh << 13)) ^ ((xh >>> 29) | (xl << 3)) ^ ((xl >>> 6) | (xh << 26));
      let l = (s0l >>> 0) + (s1l >>> 0) + (W[i - 13] >>> 0) + (W[i - 31] >>> 0);
      W[i] = s0h + s1h + W[i - 14] + W[i - 32] + Math.floor(l / 0x100000000);
      W[i + 1] = l | 0;
    }
    let ah = H[0], al = H[1], bh = H[2], bl = H[3], ch = H[4], cl = H[5], dh = H[6], dl = H[7];
    let eh = H[8], elo = H[9], fh = H[10], fl = H[11], gh = H[12], gl = H[13], hh = H[14], hl = H[15];
    for (let i = 0; i < 160; i += 2) {
      const S1h = ((eh >>> 14) | (elo << 18)) ^ ((eh >>> 18) | (elo << 14)) ^ ((elo >>> 9) | (eh << 23));
      const S1l = ((elo >>> 14) | (eh << 18)) ^ ((elo >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (elo << 23));
      const chh = (eh & fh) ^ (~eh & gh);
      const chl = (elo & fl) ^ (~elo & gl);
      let l = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + (K[i + 1] >>> 0) + (W[i + 1] >>> 0);
      const t1h = (hh + S1h + chh + K[i] + W[i] + Math.floor(l / 0x100000000)) | 0;
      const t1l = l | 0;
      const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
      const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
      const mh = (ah & bh) ^ (ah & ch) ^ (bh & ch);
      const ml = (al & bl) ^ (al & cl) ^ (bl & cl);
      l = (S0l >>> 0) + (ml >>> 0);
      const t2h = (S0h + mh + Math.floor(l / 0x100000000)) | 0;
      const t2l = l | 0;
      hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = elo;
      l = (dl >>> 0) + (t1l >>> 0);
      eh = (dh + t1h + Math.floor(l / 0x100000000)) | 0;
      elo = l | 0;
      dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
      l = (t1l >>> 0) + (t2l >>> 0);
      ah = (t1h + t2h + Math.floor(l / 0x100000000)) | 0;
      al = l | 0;
    }
    const add = (i: number, h: number, lo: number) => {
      const l = (H[i + 1] >>> 0) + (lo >>> 0);
      H[i] = (H[i] + h + Math.floor(l / 0x100000000)) | 0;
      H[i + 1] = l | 0;
    };
    add(0, ah, al); add(2, bh, bl); add(4, ch, cl); add(6, dh, dl); add(8, eh, elo); add(10, fh, fl); add(12, gh, gl); add(14, hh, hl);
  }
  const out = new Uint8Array(64);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 16; i++) outView.setInt32(i * 4, H[i]);
  return out;
}
