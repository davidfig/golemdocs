// SPDX-License-Identifier: MIT
// The standard security handler (§7.6.4): RC4 and AES, revisions 2 through 6, for reading
// encrypted files. Documents are decrypted as objects load and written back unencrypted.

import { PdfDict, PdfName, PdfStream, PdfString, type PdfObject } from '../core/objects.ts';
import { aesCbcDecrypt, aesCbcEncrypt, concat, md5, rc4, sha256, sha384, sha512 } from './primitives.ts';

export class EncryptionError extends Error {}

/** Thrown when neither the given password nor the empty password opens the document. */
export class PasswordError extends EncryptionError {}

const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

type Method = 'None' | 'RC4' | 'AESV2' | 'AESV3';

const bytesOf = (o: PdfObject | undefined): Uint8Array => (o instanceof PdfString ? o.bytes : new Uint8Array(0));

export class StandardSecurityHandler {
  readonly revision: number;
  /** User access permissions (/P), as a signed 32-bit integer. */
  readonly permissions: number;
  /** Opened with the owner password (full access), rather than the user password. */
  readonly isOwner: boolean;
  readonly encryptMetadata: boolean;
  /** False when the document opened without the password because only embedded files are encrypted. */
  readonly authenticated: boolean = true;
  private readonly key: Uint8Array;
  private readonly stringMethod: Method;
  private readonly streamMethod: Method;
  /** Embedded file streams (/EFF; defaults to the stream method). */
  private readonly fileMethod: Method;
  private readonly cryptFilters = new Map<string, Method>();

  /**
   * `resolve` follows references inside the /Encrypt dictionary; `id0` is the first element
   * of the trailer's /ID.
   */
  constructor(dict: PdfDict, id0: Uint8Array, password: string, resolve: (o: PdfObject | undefined) => PdfObject | undefined) {
    const filter = dict.name('Filter');
    if (filter !== 'Standard') throw new EncryptionError(`unsupported security handler: ${filter ?? 'none'}`);
    const num = (k: string, d: number) => {
      const v = resolve(dict.get(k));
      return typeof v === 'number' ? v : d;
    };
    const v = num('V', 0);
    const r = num('R', 2);
    this.revision = r;
    this.permissions = num('P', -1) | 0;
    const em = resolve(dict.get('EncryptMetadata'));
    this.encryptMetadata = em !== false;
    const o = bytesOf(resolve(dict.get('O')));
    const u = bytesOf(resolve(dict.get('U')));

    // Which algorithm strings and streams use.
    if (v >= 4) {
      const cf = resolve(dict.get('CF'));
      if (cf instanceof PdfDict) {
        for (const [name, entry] of cf) {
          const e = resolve(entry);
          const cfm = e instanceof PdfDict ? e.name('CFM') : undefined;
          this.cryptFilters.set(name, cfm === 'AESV2' ? 'AESV2' : cfm === 'AESV3' ? 'AESV3' : cfm === 'V2' ? 'RC4' : 'None');
        }
      }
      const pick = (key: string): Method => {
        const n = resolve(dict.get(key));
        if (!(n instanceof PdfName) || n.name === 'Identity') return 'None';
        return this.cryptFilters.get(n.name) ?? 'None';
      };
      this.stringMethod = pick('StrF');
      this.streamMethod = pick('StmF');
      this.fileMethod = dict.has('EFF') ? pick('EFF') : this.streamMethod;
    } else {
      this.stringMethod = this.streamMethod = this.fileMethod = 'RC4';
    }

    const pw = new TextEncoder().encode(saslprep(password));
    let key: Uint8Array | null;
    let owner = false;
    if (r >= 5) {
      const oe = bytesOf(resolve(dict.get('OE')));
      const ue = bytesOf(resolve(dict.get('UE')));
      const p = pw.subarray(0, 127);
      const attempt = (rev: number) => {
        let k = ownerKeyR6(p, o, u, oe, rev);
        owner = k !== null;
        k ??= userKeyR6(p, u, ue, rev);
        // The empty password as a fallback (a document with only an owner password).
        if (!k && p.length) k = userKeyR6(new Uint8Array(0), u, ue, rev);
        return k;
      };
      key = attempt(r);
    } else {
      const length = r === 2 ? 5 : Math.min(16, Math.max(5, num('Length', 40) / 8));
      const legacy = latin1Password(password);
      const tryUser = (pwd: Uint8Array) => {
        const k = computeKey(pwd, o, this.permissions, id0, r, length, this.encryptMetadata);
        return checkUserKey(k, u, id0, r) ? k : null;
      };
      // Owner password: recover the user password from /O, then authenticate with it.
      const ownerTry = tryUser(recoverUserPassword(legacy, o, r, length));
      key = ownerTry;
      owner = key !== null;
      key ??= tryUser(legacy);
      if (!key && legacy.length) key = tryUser(new Uint8Array(0));
    }
    if (!key) {
      // Only embedded files are encrypted (/EFF): the document itself opens without a password.
      if (this.stringMethod !== 'None' || this.streamMethod !== 'None') throw new PasswordError('incorrect password');
      key = new Uint8Array(0);
      this.authenticated = false;
    }
    this.key = key;
    this.isOwner = owner;
  }

  private objectKey(num: number, gen: number, method: Method): Uint8Array {
    if (method === 'AESV3') return this.key;
    const k = this.key;
    const parts = [k, Uint8Array.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff])];
    if (method === 'AESV2') parts.push(Uint8Array.from([0x73, 0x41, 0x6c, 0x54])); // "sAlT"
    return md5(concat(...parts)).subarray(0, Math.min(k.length + 5, 16));
  }

  private decrypt(data: Uint8Array, num: number, gen: number, method: Method): Uint8Array {
    // Unauthenticated (only embedded files are encrypted): those stay encrypted.
    if (method === 'None' || !this.authenticated) return data;
    const key = this.objectKey(num, gen, method);
    if (method === 'RC4') return rc4(key, data);
    if (data.length < 16) return new Uint8Array(0);
    return aesCbcDecrypt(key, data.subarray(0, 16), data.subarray(16));
  }

  decryptString(bytes: Uint8Array, num: number, gen: number): Uint8Array {
    return this.decrypt(bytes, num, gen, this.stringMethod);
  }

  decryptStream(stream: PdfStream, num: number, gen: number): Uint8Array {
    const d = stream.dict;
    if (d.name('Type') === 'XRef') return stream.data;
    if (!this.encryptMetadata && d.name('Type') === 'Metadata') return stream.data;
    // A /Crypt filter first in the chain overrides the default method.
    const f = d.get('Filter');
    const first = Array.isArray(f) ? f[0] : f;
    if (first instanceof PdfName && first.name === 'Crypt') {
      const p = d.get('DecodeParms');
      const parms = Array.isArray(p) ? p[0] : p;
      const name = parms instanceof PdfDict ? parms.name('Name') : undefined;
      const method = !name || name === 'Identity' ? 'None' : (this.cryptFilters.get(name) ?? 'None');
      return this.decrypt(stream.data, num, gen, method);
    }
    return this.decrypt(stream.data, num, gen, d.name('Type') === 'EmbeddedFile' ? this.fileMethod : this.streamMethod);
  }

  /** Decrypts every string (and the stream data) inside a freshly parsed indirect object. */
  decryptObject(o: PdfObject, num: number, gen: number): PdfObject {
    const walk = (x: PdfObject): PdfObject => {
      if (x instanceof PdfString) return new PdfString(this.decryptString(x.bytes, num, gen), x.hex);
      if (Array.isArray(x)) {
        for (let i = 0; i < x.length; i++) x[i] = walk(x[i]);
        return x;
      }
      if (x instanceof PdfDict) {
        for (const [k, v] of x) if (v instanceof PdfString || Array.isArray(v) || v instanceof PdfDict) x.entries.set(k, walk(v));
        return x;
      }
      if (x instanceof PdfStream) {
        walk(x.dict);
        x.data = this.decryptStream(x, num, gen);
        return x;
      }
      return x;
    };
    return walk(o);
  }
}

// SASLprep (RFC 4013) as revision 5/6 passwords need it: map non-ASCII spaces to space, drop
// the characters "commonly mapped to nothing", then NFKC. (Prohibited characters are left for
// the hash comparison to reject.)
const MAP_TO_NOTHING = /[\u00ad\u034f\u1806\u180b-\u180d\u200b-\u200d\u2060\ufe00-\ufe0f\ufeff]/g;
const NON_ASCII_SPACE = /[\u00a0\u1680\u2000-\u200b\u202f\u205f\u3000]/g;

export function saslprep(password: string): string {
  return password.replace(NON_ASCII_SPACE, ' ').replace(MAP_TO_NOTHING, '').normalize('NFKC');
}

function latin1Password(password: string): Uint8Array {
  return Uint8Array.from(password.slice(0, 32), (c) => c.charCodeAt(0) & 0xff);
}

function padPassword(pw: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  out.set(pw.subarray(0, 32));
  out.set(PAD.subarray(0, 32 - Math.min(32, pw.length)), Math.min(32, pw.length));
  return out;
}

/** Algorithm 2. */
function computeKey(pw: Uint8Array, o: Uint8Array, p: number, id0: Uint8Array, r: number, length: number, encryptMetadata: boolean): Uint8Array {
  const parts = [padPassword(pw), o.subarray(0, 32), Uint8Array.from([p & 0xff, (p >> 8) & 0xff, (p >> 16) & 0xff, (p >>> 24) & 0xff]), id0];
  if (r >= 4 && !encryptMetadata) parts.push(Uint8Array.from([0xff, 0xff, 0xff, 0xff]));
  let hash = md5(concat(...parts));
  if (r >= 3) for (let i = 0; i < 50; i++) hash = md5(hash.subarray(0, length));
  return hash.subarray(0, length);
}

/** Algorithms 4 and 5: does this key reproduce /U? */
function checkUserKey(key: Uint8Array, u: Uint8Array, id0: Uint8Array, r: number): boolean {
  if (r === 2) return equal(rc4(key, PAD), u.subarray(0, 32));
  let x = rc4(key, md5(concat(PAD, id0)));
  for (let i = 1; i <= 19; i++) x = rc4(key.map((b) => b ^ i), x);
  return equal(x.subarray(0, 16), u.subarray(0, 16));
}

/** Algorithm 7's first half: decrypts /O with the owner password to get the user password. */
function recoverUserPassword(ownerPw: Uint8Array, o: Uint8Array, r: number, length: number): Uint8Array {
  let hash = md5(padPassword(ownerPw));
  if (r >= 3) for (let i = 0; i < 50; i++) hash = md5(hash);
  const key = hash.subarray(0, length);
  if (r === 2) return rc4(key, o.subarray(0, 32));
  let x = o.subarray(0, 32);
  for (let i = 19; i >= 0; i--) x = rc4(key.map((b) => b ^ i), x);
  return x;
}

/** Algorithm 2.A/2.B (revision 5 and 6 hashes). */
function hashR6(pw: Uint8Array, salt: Uint8Array, udata: Uint8Array, r: number): Uint8Array {
  let k = sha256(concat(pw, salt, udata));
  if (r === 5) return k;
  for (let round = 0; ; round++) {
    const one = concat(pw, k, udata);
    const k1 = new Uint8Array(one.length * 64);
    for (let i = 0; i < 64; i++) k1.set(one, i * one.length);
    const e = aesCbcEncrypt(k.subarray(0, 16), k.subarray(16, 32), k1);
    let mod = 0;
    for (let i = 0; i < 16; i++) mod += e[i];
    mod %= 3;
    k = mod === 0 ? sha256(e) : mod === 1 ? sha384(e) : sha512(e);
    // At least 64 rounds, then until the last byte of E is at most (rounds done - 32).
    if (round >= 63 && e[e.length - 1] <= round + 1 - 32) break;
  }
  return k.subarray(0, 32);
}

function userKeyR6(pw: Uint8Array, u: Uint8Array, ue: Uint8Array, r: number): Uint8Array | null {
  if (!equal(hashR6(pw, u.subarray(32, 40), new Uint8Array(0), r), u.subarray(0, 32))) return null;
  const k = hashR6(pw, u.subarray(40, 48), new Uint8Array(0), r);
  return aesCbcDecrypt(k, new Uint8Array(16), ue.subarray(0, 32), false);
}

function ownerKeyR6(pw: Uint8Array, o: Uint8Array, u: Uint8Array, oe: Uint8Array, r: number): Uint8Array | null {
  const u48 = u.subarray(0, 48);
  if (!equal(hashR6(pw, o.subarray(32, 40), u48, r), o.subarray(0, 32))) return null;
  const k = hashR6(pw, o.subarray(40, 48), u48, r);
  return aesCbcDecrypt(k, new Uint8Array(16), oe.subarray(0, 32), false);
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
