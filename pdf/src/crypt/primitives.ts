// SPDX-License-Identifier: MIT
// The cryptographic primitives the PDF standard security handler needs (§7.6): MD5, RC4,
// SHA-256/384/512 and AES-128/256. Synchronous and hand-written: Web Crypto is async-only
// and has no MD5 or RC4. None of this protects anything; PDF encryption is for reading
// files others produced.

// --- MD5 (RFC 1321) ------------------------------------------------------------------------

const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const MD5_K = Int32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);

export function md5(data: Uint8Array): Uint8Array {
  const padded = new Uint8Array(((data.length + 72) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const bits = data.length * 8;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bits >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bits / 2 ** 32), true);
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
  const m = new Int32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = dv.getInt32(off + i * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      const t = d;
      d = c;
      c = b;
      const x = (a + f + MD5_K[i] + m[g]) | 0;
      b = (b + ((x << MD5_S[i]) | (x >>> (32 - MD5_S[i])))) | 0;
      a = t;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setInt32(0, a0, true); ov.setInt32(4, b0, true); ov.setInt32(8, c0, true); ov.setInt32(12, d0, true);
  return out;
}

// --- RC4 -------------------------------------------------------------------------------------

export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    const t = s[i]; s[i] = s[j]; s[j] = t;
  }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    const t = s[i]; s[i] = s[j]; s[j] = t;
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

// --- SHA-256 (FIPS 180-4) --------------------------------------------------------------------

const SHA256_K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function mdPad(data: Uint8Array, block: number): Uint8Array {
  const lenBytes = block === 64 ? 8 : 16;
  const total = Math.ceil((data.length + 1 + lenBytes) / block) * block;
  const out = new Uint8Array(total);
  out.set(data);
  out[data.length] = 0x80;
  const bits = data.length * 8;
  const dv = new DataView(out.buffer);
  dv.setUint32(total - 4, bits >>> 0);
  dv.setUint32(total - 8, Math.floor(bits / 2 ** 32));
  return out;
}

export function sha256(data: Uint8Array): Uint8Array {
  const p = mdPad(data, 64);
  const dv = new DataView(p.buffer);
  const h = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < p.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
  return out;
}

// --- SHA-384/512, with 64-bit words as (hi, lo) pairs -----------------------------------------

const SHA512_K = [
  '428a2f98d728ae22', '7137449123ef65cd', 'b5c0fbcfec4d3b2f', 'e9b5dba58189dbbc', '3956c25bf348b538', '59f111f1b605d019', '923f82a4af194f9b', 'ab1c5ed5da6d8118',
  'd807aa98a3030242', '12835b0145706fbe', '243185be4ee4b28c', '550c7dc3d5ffb4e2', '72be5d74f27b896f', '80deb1fe3b1696b1', '9bdc06a725c71235', 'c19bf174cf692694',
  'e49b69c19ef14ad2', 'efbe4786384f25e3', '0fc19dc68b8cd5b5', '240ca1cc77ac9c65', '2de92c6f592b0275', '4a7484aa6ea6e483', '5cb0a9dcbd41fbd4', '76f988da831153b5',
  '983e5152ee66dfab', 'a831c66d2db43210', 'b00327c898fb213f', 'bf597fc7beef0ee4', 'c6e00bf33da88fc2', 'd5a79147930aa725', '06ca6351e003826f', '142929670a0e6e70',
  '27b70a8546d22ffc', '2e1b21385c26c926', '4d2c6dfc5ac42aed', '53380d139d95b3df', '650a73548baf63de', '766a0abb3c77b2a8', '81c2c92e47edaee6', '92722c851482353b',
  'a2bfe8a14cf10364', 'a81a664bbc423001', 'c24b8b70d0f89791', 'c76c51a30654be30', 'd192e819d6ef5218', 'd69906245565a910', 'f40e35855771202a', '106aa07032bbd1b8',
  '19a4c116b8d2d0c8', '1e376c085141ab53', '2748774cdf8eeb99', '34b0bcb5e19b48a8', '391c0cb3c5c95a63', '4ed8aa4ae3418acb', '5b9cca4f7763e373', '682e6ff3d6b2b8a3',
  '748f82ee5defb2fc', '78a5636f43172f60', '84c87814a1f0ab72', '8cc702081a6439ec', '90befffa23631e28', 'a4506cebde82bde9', 'bef9a3f7b2c67915', 'c67178f2e372532b',
  'ca273eceea26619c', 'd186b8c721c0c207', 'eada7dd6cde0eb1e', 'f57d4f7fee6ed178', '06f067aa72176fba', '0a637dc5a2c898a6', '113f9804bef90dae', '1b710b35131c471b',
  '28db77f523047d84', '32caab7b40c72493', '3c9ebe0a15c9bebc', '431d67c49c100d4c', '4cc5d4becb3e42b6', '597f299cfc657e2a', '5fcb6fab3ad6faec', '6c44198c4a475817',
];
const K512 = (() => {
  const k = new Uint32Array(160);
  SHA512_K.forEach((h, i) => {
    k[i * 2] = parseInt(h.slice(0, 8), 16);
    k[i * 2 + 1] = parseInt(h.slice(8), 16);
  });
  return k;
})();

const IV512 = ['6a09e667f3bcc908', 'bb67ae8584caa73b', '3c6ef372fe94f82b', 'a54ff53a5f1d36f1', '510e527fade682d1', '9b05688c2b3e6c1f', '1f83d9abfb41bd6b', '5be0cd19137e2179'];
const IV384 = ['cbbb9d5dc1059ed8', '629a292a367cd507', '9159015a3070dd17', '152fecd8f70e5939', '67332667ffc00b31', '8eb44a8768581511', 'db0c2e0d64f98fa7', '47b5481dbefa4fa4'];

function sha512Core(data: Uint8Array, iv: string[], outBytes: number): Uint8Array {
  const p = mdPad(data, 128);
  const dv = new DataView(p.buffer);
  const h = new Uint32Array(16);
  iv.forEach((x, i) => {
    h[i * 2] = parseInt(x.slice(0, 8), 16);
    h[i * 2 + 1] = parseInt(x.slice(8), 16);
  });
  const w = new Uint32Array(160);
  // 64-bit helpers on (hi, lo) pairs; results written to r[0], r[1].
  const v = new Uint32Array(16);
  for (let off = 0; off < p.length; off += 128) {
    for (let i = 0; i < 32; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      const xh = w[(i - 15) * 2], xl = w[(i - 15) * 2 + 1];
      const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
      const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
      const yh = w[(i - 2) * 2], yl = w[(i - 2) * 2 + 1];
      const s1h = ((yh >>> 19) | (yl << 13)) ^ ((yl >>> 29) | (yh << 3)) ^ (yh >>> 6);
      const s1l = ((yl >>> 19) | (yh << 13)) ^ ((yh >>> 29) | (yl << 3)) ^ ((yl >>> 6) | (yh << 26));
      let lo = (w[(i - 16) * 2 + 1] + s0l) >>> 0;
      let hi = (w[(i - 16) * 2] + s0h + (lo < s0l >>> 0 ? 1 : 0)) >>> 0;
      const l2 = (lo + w[(i - 7) * 2 + 1]) >>> 0;
      hi = (hi + w[(i - 7) * 2] + (l2 < lo ? 1 : 0)) >>> 0;
      lo = l2;
      const l3 = (lo + s1l) >>> 0;
      hi = (hi + s1h + (l3 < lo ? 1 : 0)) >>> 0;
      w[i * 2] = hi;
      w[i * 2 + 1] = l3;
    }
    v.set(h);
    for (let i = 0; i < 80; i++) {
      const ah = v[0], al = v[1], bh = v[2], bl = v[3], ch = v[4], cl = v[5];
      const eh = v[8], el = v[9], fh = v[10], fl = v[11], gh = v[12], gl = v[13];
      // Σ1(e), Ch(e,f,g)
      const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
      const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
      const chh = (eh & fh) ^ (~eh & gh);
      const chl = (el & fl) ^ (~el & gl);
      // t1 = h + S1 + ch + K + W
      let t1l = (v[15] + S1l) >>> 0;
      let t1h = (v[14] + S1h + (t1l < S1l >>> 0 ? 1 : 0)) >>> 0;
      let x = (t1l + chl) >>> 0; t1h = (t1h + chh + (x < t1l ? 1 : 0)) >>> 0; t1l = x;
      x = (t1l + K512[i * 2 + 1]) >>> 0; t1h = (t1h + K512[i * 2] + (x < t1l ? 1 : 0)) >>> 0; t1l = x;
      x = (t1l + w[i * 2 + 1]) >>> 0; t1h = (t1h + w[i * 2] + (x < t1l ? 1 : 0)) >>> 0; t1l = x;
      // Σ0(a), Maj(a,b,c)
      const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
      const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
      const mjh = (ah & bh) ^ (ah & ch) ^ (bh & ch);
      const mjl = (al & bl) ^ (al & cl) ^ (bl & cl);
      const t2l = (S0l + mjl) >>> 0;
      const t2h = (S0h + mjh + (t2l < S0l >>> 0 ? 1 : 0)) >>> 0;
      // shift the working variables
      v[14] = gh; v[15] = gl; v[12] = fh; v[13] = fl; v[10] = eh; v[11] = el;
      x = (v[7] + t1l) >>> 0;
      v[8] = (v[6] + t1h + (x < t1l ? 1 : 0)) >>> 0; v[9] = x;
      v[6] = ch; v[7] = cl; v[4] = bh; v[5] = bl; v[2] = ah; v[3] = al;
      x = (t1l + t2l) >>> 0;
      v[0] = (t1h + t2h + (x < t1l ? 1 : 0)) >>> 0; v[1] = x;
    }
    for (let i = 0; i < 8; i++) {
      const lo = (h[i * 2 + 1] + v[i * 2 + 1]) >>> 0;
      h[i * 2] = (h[i * 2] + v[i * 2] + (lo < h[i * 2 + 1] ? 1 : 0)) >>> 0;
      h[i * 2 + 1] = lo;
    }
  }
  const out = new Uint8Array(64);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 16; i++) ov.setUint32(i * 4, h[i]);
  return out.slice(0, outBytes);
}

export const sha512 = (data: Uint8Array): Uint8Array => sha512Core(data, IV512, 64);
export const sha384 = (data: Uint8Array): Uint8Array => sha512Core(data, IV384, 48);

// --- AES (FIPS 197), CBC mode ----------------------------------------------------------------

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
const TE = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
const TD = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
(() => {
  // Build the S-box from GF(2^8) inverses, then the combined round tables.
  const exp = new Uint8Array(256);
  const log = new Uint8Array(256);
  for (let i = 0, x = 1; i < 256; i++) {
    exp[i] = x;
    log[x] = i;
    x ^= (x << 1) ^ (x & 0x80 ? 0x11b : 0);
    x &= 0xff;
  }
  const mul = (a: number, b: number) => (a && b ? exp[(log[a] + log[b]) % 255] : 0);
  for (let i = 0; i < 256; i++) {
    const inv = i ? exp[255 - log[i]] : 0;
    let s = inv;
    for (let k = 1; k < 5; k++) s ^= ((inv << k) | (inv >> (8 - k))) & 0xff;
    s ^= 0x63;
    SBOX[i] = s;
    INV_SBOX[s] = i;
  }
  for (let i = 0; i < 256; i++) {
    const s = SBOX[i];
    const e = (mul(s, 2) << 24) | (s << 16) | (s << 8) | mul(s, 3);
    const t = INV_SBOX[i];
    const d = (mul(t, 14) << 24) | (mul(t, 9) << 16) | (mul(t, 13) << 8) | mul(t, 11);
    for (let r = 0; r < 4; r++) {
      TE[r][i] = ((e >>> (8 * r)) | (e << (32 - 8 * r))) >>> 0;
      TD[r][i] = ((d >>> (8 * r)) | (d << (32 - 8 * r))) >>> 0;
    }
  }
})();

class Aes {
  readonly rounds: number;
  readonly ek: Uint32Array;
  readonly dk: Uint32Array;

  constructor(key: Uint8Array) {
    const nk = key.length / 4;
    if (nk !== 4 && nk !== 6 && nk !== 8) throw new Error('AES key must be 16, 24 or 32 bytes');
    this.rounds = nk + 6;
    const total = 4 * (this.rounds + 1);
    const w = new Uint32Array(total);
    for (let i = 0; i < nk; i++) w[i] = (key[i * 4] << 24) | (key[i * 4 + 1] << 16) | (key[i * 4 + 2] << 8) | key[i * 4 + 3];
    let rcon = 1;
    for (let i = nk; i < total; i++) {
      let t = w[i - 1];
      if (i % nk === 0) {
        t = ((SBOX[(t >>> 16) & 0xff] << 24) | (SBOX[(t >>> 8) & 0xff] << 16) | (SBOX[t & 0xff] << 8) | SBOX[t >>> 24]) ^ (rcon << 24);
        rcon = (rcon << 1) ^ (rcon & 0x80 ? 0x11b : 0);
      } else if (nk > 6 && i % nk === 4) {
        t = (SBOX[t >>> 24] << 24) | (SBOX[(t >>> 16) & 0xff] << 16) | (SBOX[(t >>> 8) & 0xff] << 8) | SBOX[t & 0xff];
      }
      w[i] = (w[i - nk] ^ t) >>> 0;
    }
    this.ek = w;
    // Equivalent inverse cipher key schedule: reversed round keys, InvMixColumns on the middle ones.
    const dk = new Uint32Array(total);
    for (let r = 0; r <= this.rounds; r++) {
      for (let c = 0; c < 4; c++) {
        const x = w[(this.rounds - r) * 4 + c];
        dk[r * 4 + c] =
          r === 0 || r === this.rounds
            ? x
            : (TD[0][SBOX[x >>> 24]] ^ TD[1][SBOX[(x >>> 16) & 0xff]] ^ TD[2][SBOX[(x >>> 8) & 0xff]] ^ TD[3][SBOX[x & 0xff]]) >>> 0;
      }
    }
    this.dk = dk;
  }

  encryptBlock(s: Uint32Array): void {
    const k = this.ek;
    let s0 = s[0] ^ k[0], s1 = s[1] ^ k[1], s2 = s[2] ^ k[2], s3 = s[3] ^ k[3];
    const [t0, t1, t2, t3] = TE;
    let ki = 4;
    for (let r = 1; r < this.rounds; r++, ki += 4) {
      const a = t0[s0 >>> 24] ^ t1[(s1 >>> 16) & 0xff] ^ t2[(s2 >>> 8) & 0xff] ^ t3[s3 & 0xff] ^ k[ki];
      const b = t0[s1 >>> 24] ^ t1[(s2 >>> 16) & 0xff] ^ t2[(s3 >>> 8) & 0xff] ^ t3[s0 & 0xff] ^ k[ki + 1];
      const c = t0[s2 >>> 24] ^ t1[(s3 >>> 16) & 0xff] ^ t2[(s0 >>> 8) & 0xff] ^ t3[s1 & 0xff] ^ k[ki + 2];
      const d = t0[s3 >>> 24] ^ t1[(s0 >>> 16) & 0xff] ^ t2[(s1 >>> 8) & 0xff] ^ t3[s2 & 0xff] ^ k[ki + 3];
      s0 = a; s1 = b; s2 = c; s3 = d;
    }
    const f = (a: number, b: number, c: number, d: number, key: number) =>
      ((SBOX[a >>> 24] << 24) | (SBOX[(b >>> 16) & 0xff] << 16) | (SBOX[(c >>> 8) & 0xff] << 8) | SBOX[d & 0xff]) ^ key;
    s[0] = f(s0, s1, s2, s3, k[ki]) >>> 0;
    s[1] = f(s1, s2, s3, s0, k[ki + 1]) >>> 0;
    s[2] = f(s2, s3, s0, s1, k[ki + 2]) >>> 0;
    s[3] = f(s3, s0, s1, s2, k[ki + 3]) >>> 0;
  }

  decryptBlock(s: Uint32Array): void {
    const k = this.dk;
    let s0 = s[0] ^ k[0], s1 = s[1] ^ k[1], s2 = s[2] ^ k[2], s3 = s[3] ^ k[3];
    const [t0, t1, t2, t3] = TD;
    let ki = 4;
    for (let r = 1; r < this.rounds; r++, ki += 4) {
      const a = t0[s0 >>> 24] ^ t1[(s3 >>> 16) & 0xff] ^ t2[(s2 >>> 8) & 0xff] ^ t3[s1 & 0xff] ^ k[ki];
      const b = t0[s1 >>> 24] ^ t1[(s0 >>> 16) & 0xff] ^ t2[(s3 >>> 8) & 0xff] ^ t3[s2 & 0xff] ^ k[ki + 1];
      const c = t0[s2 >>> 24] ^ t1[(s1 >>> 16) & 0xff] ^ t2[(s0 >>> 8) & 0xff] ^ t3[s3 & 0xff] ^ k[ki + 2];
      const d = t0[s3 >>> 24] ^ t1[(s2 >>> 16) & 0xff] ^ t2[(s1 >>> 8) & 0xff] ^ t3[s0 & 0xff] ^ k[ki + 3];
      s0 = a; s1 = b; s2 = c; s3 = d;
    }
    const f = (a: number, b: number, c: number, d: number, key: number) =>
      ((INV_SBOX[a >>> 24] << 24) | (INV_SBOX[(b >>> 16) & 0xff] << 16) | (INV_SBOX[(c >>> 8) & 0xff] << 8) | INV_SBOX[d & 0xff]) ^ key;
    s[0] = f(s0, s3, s2, s1, k[ki]) >>> 0;
    s[1] = f(s1, s0, s3, s2, k[ki + 1]) >>> 0;
    s[2] = f(s2, s1, s0, s3, k[ki + 2]) >>> 0;
    s[3] = f(s3, s2, s1, s0, k[ki + 3]) >>> 0;
  }
}

const readBlock = (b: Uint8Array, o: number, s: Uint32Array) => {
  for (let i = 0; i < 4; i++) s[i] = ((b[o + i * 4] << 24) | (b[o + i * 4 + 1] << 16) | (b[o + i * 4 + 2] << 8) | b[o + i * 4 + 3]) >>> 0;
};
const writeBlock = (b: Uint8Array, o: number, s: Uint32Array) => {
  for (let i = 0; i < 4; i++) {
    b[o + i * 4] = s[i] >>> 24;
    b[o + i * 4 + 1] = s[i] >>> 16;
    b[o + i * 4 + 2] = s[i] >>> 8;
    b[o + i * 4 + 3] = s[i];
  }
};

/** AES-CBC decryption. With `unpad`, strips PKCS#5 padding (leniently: bad padding is kept). */
export function aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array, unpad = true): Uint8Array {
  const aes = new Aes(key);
  const n = data.length - (data.length % 16);
  const out = new Uint8Array(n);
  const s = new Uint32Array(4);
  const prev = iv.slice(0, 16);
  for (let o = 0; o < n; o += 16) {
    readBlock(data, o, s);
    aes.decryptBlock(s);
    writeBlock(out, o, s);
    for (let i = 0; i < 16; i++) out[o + i] ^= prev[i];
    prev.set(data.subarray(o, o + 16));
  }
  if (unpad && n) {
    const pad = out[n - 1];
    if (pad >= 1 && pad <= 16 && out.subarray(n - pad).every((b) => b === pad)) return out.subarray(0, n - pad);
  }
  return out;
}

/** AES-CBC encryption without padding (data must be a multiple of 16 bytes). */
export function aesCbcEncrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const aes = new Aes(key);
  const out = new Uint8Array(data.length);
  const s = new Uint32Array(4);
  const prev = iv.slice(0, 16);
  for (let o = 0; o + 16 <= data.length; o += 16) {
    for (let i = 0; i < 16; i++) out[o + i] = data[o + i] ^ prev[i];
    readBlock(out, o, s);
    aes.encryptBlock(s);
    writeBlock(out, o, s);
    prev.set(out.subarray(o, o + 16));
  }
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
