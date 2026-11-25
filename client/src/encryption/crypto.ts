// The cryptography of encrypted documents and folders (docs/encrypted-folders.md), all WebCrypto.
//
// A person's **personal key** is 32 random bytes they keep in a password manager, written as `golem-key-1-` and Crockford base32 in groups
// of four, ending in a checksum. Only a key that cannot be read back is kept in memory, never its text: it wraps (AES-KW) the **item key** of each encrypted document, and of each folder
// whose name is sealed, and the wrapped key is what is stored, next to the item. An item key is unwrapped straight into an HKDF key that
// cannot be read back, and two keys are derived from it: one seals files, one seals names.
//
// What is sealed is laid out in @golemdocs/ops (sealed.ts): the item key's id travels in front, as the AES-GCM additional data, so a sealed
// file or name says which key opens it, and cannot be passed off as sealed by another.

import { fromBase64Url, isSealed, isSealedName, keyIdBytes, keyIdHex, paddedLength, SEALED_HEADER_BYTES, SEALED_MAGIC, SEALED_NAME_PREFIX, sealedKeyId, toBase64Url, wrappedKeyId } from '@golemdocs/ops';

export { fromBase64Url, toBase64Url };

const PREFIX = 'golem-key-1-';
/** Crockford's base32: no I, L, O or U, so a key read aloud or retyped is hard to get wrong. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 32 key bytes are 52 characters (the last one carrying 4 bits); the checksum is 5 bytes of SHA-256, 8 characters. */
const KEY_CHARS = 52;
const CHECK_BYTES = 5;
const CHECK_CHARS = 8;

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;
const encoder = new TextEncoder();

/**
 * A personal key, ready to use: a key that cannot be read back, and a fingerprint that tells two apart. Its text is not kept, so a script
 * running in the page could use the key while the session is unlocked but never take it away.
 */
export interface PersonalKey {
  /** The first 16 bytes of the key's SHA-256, in hex: the same key typed in twice has the same one. */
  id: string;
  key: CryptoKey;
}

/** An item's keys, derived from its item key. */
export interface ItemKeys {
  /** The item key's id (hex), which everything it seals carries. */
  keyId: string;
  files: CryptoKey;
  names: CryptoKey;
}

export type KeyProblem = 'format' | 'checksum';

export class KeyError extends Error {
  constructor(readonly problem: KeyProblem) {
    super(`not a personal key (${problem})`);
  }
}

function toBase32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

function fromBase32(text: string, byteLength: number): Uint8Array | null {
  const out = new Uint8Array(byteLength);
  let buffer = 0;
  let bits = 0;
  let at = 0;
  for (const char of text) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      if (at < byteLength) out[at++] = (buffer >>> (bits - 8)) & 255;
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  return at === byteLength ? out : null;
}

async function checksum(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await subtle().digest('SHA-256', own(bytes)));
  return toBase32(digest.subarray(0, CHECK_BYTES));
}

/** Writes a personal key's bytes as the text a person saves. */
export async function formatKey(bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength !== 32) throw new Error('a personal key is 32 bytes');
  const body = toBase32(bytes) + (await checksum(bytes));
  return PREFIX + (body.match(/.{1,4}/g) ?? []).join('-');
}

/**
 * Reads a personal key's text back into its bytes. Spaces, dashes and case do not matter, and Crockford's look-alikes (O for 0, I and L
 * for 1) are read as the digits they stand for. Throws `KeyError` if it is not a key, or a mistyped one.
 */
export async function parseKey(text: string): Promise<Uint8Array> {
  let body = text.trim().toUpperCase().replace(/[\s-]/g, '');
  const prefix = PREFIX.replace(/-/g, '').toUpperCase();
  if (!body.startsWith(prefix)) throw new KeyError('format');
  body = body.slice(prefix.length).replace(/O/g, '0').replace(/[IL]/g, '1');
  if (body.length !== KEY_CHARS + CHECK_CHARS) throw new KeyError('format');
  const bytes = fromBase32(body.slice(0, KEY_CHARS), 32);
  if (!bytes) throw new KeyError('format');
  if ((await checksum(bytes)) !== body.slice(KEY_CHARS)) throw new KeyError('checksum');
  return bytes;
}

/** A new personal key, random, with its text: to show once, at setup, for the person to save (the caller keeps only the key). */
export async function newPersonalKey(): Promise<PersonalKey & { text: string }> {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const text = await formatKey(bytes);
  return { text, ...(await importPersonalKey(bytes)) };
}

/** Turns a personal key's text into a key that can wrap and unwrap item keys (and cannot be read back). */
export async function openPersonalKey(text: string): Promise<PersonalKey> {
  return importPersonalKey(await parseKey(text));
}

async function importPersonalKey(bytes: Uint8Array): Promise<PersonalKey> {
  const digest = new Uint8Array(await subtle().digest('SHA-256', own(bytes)));
  const key = await subtle().importKey('raw', own(bytes), 'AES-KW', false, ['wrapKey', 'unwrapKey']);
  bytes.fill(0);
  return { id: keyIdHex(digest.subarray(0, 16)), key };
}

/** A new item key, wrapped by the personal key: what is stored with the item, and the keys to use now. */
export async function newItemKey(personal: PersonalKey): Promise<{ wrapped: string; keys: ItemKeys }> {
  const id = globalThis.crypto.getRandomValues(new Uint8Array(16));
  // Made extractable only so it can be wrapped once; what is kept is the derived keys, which cannot be read back.
  const raw = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const wrappedBytes = new Uint8Array(await subtle().wrapKey('raw', raw, personal.key, 'AES-KW'));
  const wrapped = toBase64Url(concat(id, wrappedBytes));
  const keys = await unwrapItemKey(personal, wrapped);
  if (!keys) throw new Error('an item key that does not unwrap');
  return { wrapped, keys };
}

/** An item's keys from its wrapped item key; null if this personal key did not wrap it (or it is not a wrapped key). */
export async function unwrapItemKey(personal: PersonalKey, wrapped: string): Promise<ItemKeys | null> {
  const keyId = wrappedKeyId(wrapped);
  const bytes = keyId ? fromBase64Url(wrapped) : null;
  if (!keyId || !bytes) return null;
  let base: CryptoKey;
  try {
    base = await subtle().unwrapKey('raw', own(bytes.subarray(16)), personal.key, 'AES-KW', 'HKDF', false, ['deriveKey']);
  } catch {
    return null; // AES-KW's integrity check: another key wrapped it
  }
  const derive = (info: string) =>
    subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: own(keyIdBytes(keyId)), info: own(encoder.encode(`golemdocs ${info}`)) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { keyId, files: await derive('files'), names: await derive('names') };
}

/** The same item key, wrapped by another personal key (changing the key, docs/encrypted-folders.md). Keeps its id. */
export async function rewrapItemKey(from: PersonalKey, to: PersonalKey, wrapped: string): Promise<string | null> {
  const bytes = wrappedKeyId(wrapped) ? fromBase64Url(wrapped) : null;
  if (!bytes) return null;
  try {
    const raw = await subtle().unwrapKey('raw', own(bytes.subarray(16)), from.key, 'AES-KW', { name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    return toBase64Url(concat(bytes.subarray(0, 16), new Uint8Array(await subtle().wrapKey('raw', raw, to.key, 'AES-KW'))));
  } catch {
    return null;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function header(keyId: string, nonce: Uint8Array): Uint8Array {
  const out = new Uint8Array(SEALED_HEADER_BYTES);
  out.set(SEALED_MAGIC, 0);
  out.set(keyIdBytes(keyId), 4);
  out.set(nonce, 20);
  return out;
}

async function seal(key: CryptoKey, keyId: string, plain: Uint8Array): Promise<Uint8Array> {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const head = header(keyId, nonce);
  const sealed = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: own(nonce), additionalData: own(head.subarray(0, 20)) }, key, own(plain)));
  return concat(head, sealed);
}

export class SealError extends Error {}

async function unseal(key: CryptoKey, keyId: string, bytes: Uint8Array): Promise<Uint8Array> {
  if (!isSealed(bytes) || sealedKeyId(bytes) !== keyId) throw new SealError('not sealed with this key');
  try {
    return new Uint8Array(
      await subtle().decrypt({ name: 'AES-GCM', iv: own(bytes.subarray(20, SEALED_HEADER_BYTES)), additionalData: own(bytes.subarray(0, 20)) }, key, own(bytes.subarray(SEALED_HEADER_BYTES))),
    );
  } catch {
    throw new SealError('the file does not open with this key (changed, or another key)');
  }
}

/** Seals a file: padded (ops `paddedLength`), with its real length in front, then encrypted. */
export async function sealFile(keys: ItemKeys, bytes: Uint8Array): Promise<Uint8Array> {
  const padded = new Uint8Array(paddedLength(bytes.byteLength));
  new DataView(padded.buffer).setUint32(0, bytes.byteLength);
  padded.set(bytes, 4);
  return seal(keys.files, keys.keyId, padded);
}

/** Opens a sealed file. Throws `SealError` if it is not sealed with these keys, or was changed. */
export async function openFile(keys: ItemKeys, bytes: Uint8Array): Promise<Uint8Array> {
  const padded = await unseal(keys.files, keys.keyId, bytes);
  const length = padded.byteLength >= 4 ? new DataView(padded.buffer, padded.byteOffset).getUint32(0) : -1;
  if (length < 0 || length > padded.byteLength - 4) throw new SealError('a sealed file with a bad length');
  return padded.slice(4, 4 + length);
}

/** Names are padded to a multiple of this many bytes, so a sealed name gives away only roughly how long it is. */
const NAME_STEP = 32;

/** Seals a name: `gde1.` and base64url. */
export async function sealName(keys: ItemKeys, name: string): Promise<string> {
  const text = encoder.encode(name);
  const padded = new Uint8Array(Math.ceil((text.byteLength + 2) / NAME_STEP) * NAME_STEP);
  new DataView(padded.buffer).setUint16(0, text.byteLength);
  padded.set(text, 2);
  return SEALED_NAME_PREFIX + toBase64Url(await seal(keys.names, keys.keyId, padded));
}

/** Opens a sealed name. Throws `SealError` if it is not sealed with these keys. */
export async function openName(keys: ItemKeys, sealed: string): Promise<string> {
  const bytes = isSealedName(sealed) ? fromBase64Url(sealed.slice(SEALED_NAME_PREFIX.length)) : null;
  if (!bytes) throw new SealError('not a sealed name');
  const padded = await unseal(keys.names, keys.keyId, bytes);
  const length = new DataView(padded.buffer, padded.byteOffset).getUint16(0);
  if (length > padded.byteLength - 2) throw new SealError('a sealed name with a bad length');
  return new TextDecoder().decode(padded.subarray(2, 2 + length));
}

export { keyIdHex };

/** A copy that owns a plain ArrayBuffer, which WebCrypto's types ask for. */
function own(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes);
}
