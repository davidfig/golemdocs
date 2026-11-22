// SPDX-License-Identifier: MIT
// The format of what an encrypted folder stores (docs/encrypted-folders.md), shared by the browser, which seals and opens it, and the
// server, which only checks that what is saved into an encrypted folder is sealed, never reading it.
//
// A sealed file is `GDE1`, the 16-byte id of the item key that sealed it (docs/encrypted-folders.md: every encrypted document, and every
// folder whose name is sealed, has its own), a 12-byte nonce, then the AES-GCM ciphertext and its 16-byte tag. A sealed name is `gde1.` and
// the same envelope in base64url. A wrapped item key is base64url of its id and the AES-KW wrapping of the key (16 + 40 bytes).

/** The first bytes of a sealed file. */
export const SEALED_MAGIC = new Uint8Array([0x47, 0x44, 0x45, 0x31]); // "GDE1"
/** What a sealed name starts with. */
export const SEALED_NAME_PREFIX = 'gde1.';
/** Magic, folder id, nonce. */
export const SEALED_HEADER_BYTES = 4 + 16 + 12;
/** The AES-GCM tag. */
export const SEALED_TAG_BYTES = 16;
/** The longest sealed name the server keeps: a 255-character name, padded and sealed, fits with room to spare. */
export const MAX_SEALED_NAME = 2048;

/** Whether the bytes are a sealed file (only the shape: whether they open is for whoever has the key). */
export function isSealed(bytes: Uint8Array): boolean {
  if (bytes.byteLength < SEALED_HEADER_BYTES + SEALED_TAG_BYTES) return false;
  for (let i = 0; i < SEALED_MAGIC.length; i++) if (bytes[i] !== SEALED_MAGIC[i]) return false;
  return true;
}

/** Whether a name is a sealed one. */
export function isSealedName(name: string): boolean {
  return name.startsWith(SEALED_NAME_PREFIX) && name.length <= MAX_SEALED_NAME && /^[A-Za-z0-9_-]+$/.test(name.slice(SEALED_NAME_PREFIX.length));
}

/** A key id as text (hex) and back. */
export const keyIdHex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
export function keyIdBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`not a key id: ${hex}`);
  return Uint8Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

/** The id of the key that opens a sealed file (null if it is not one). */
export function sealedKeyId(bytes: Uint8Array): string | null {
  return isSealed(bytes) ? keyIdHex(bytes.subarray(4, 20)) : null;
}

/** base64url, both ways (null for text that is not). */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The id of the key that opens a sealed name (null if it is not one). */
export function sealedNameKeyId(name: string): string | null {
  const bytes = isSealedName(name) ? fromBase64Url(name.slice(SEALED_NAME_PREFIX.length)) : null;
  return bytes ? sealedKeyId(bytes) : null;
}

/** Whether text is a wrapped item key: 56 bytes in base64url. */
export const isWrappedKey = (text: unknown): text is string => typeof text === 'string' && /^[A-Za-z0-9_-]{75}$/.test(text);

/** The id of a wrapped item key (null if it is not one). */
export function wrappedKeyId(wrapped: string): string | null {
  const bytes = isWrappedKey(wrapped) ? fromBase64Url(wrapped) : null;
  return bytes && bytes.byteLength === 56 ? keyIdHex(bytes.subarray(0, 16)) : null;
}

/**
 * How long a file of `n` bytes is made before it is sealed, so its stored size says only roughly how big it is: 4 KiB at least, then the
 * next of 16 steps between one power of two and the next. The 4 bytes are the real length, kept in front of the padding.
 */
export function paddedLength(n: number): number {
  const need = n + 4;
  if (need <= 4096) return 4096;
  const step = 2 ** (Math.floor(Math.log2(need)) - 4);
  return Math.ceil(need / step) * step;
}
