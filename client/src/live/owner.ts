// Who made a live block (docs/live-blocks.md §1, *Who a block belongs to*). A block reads its source from the vault of the
// document it is in, so a block someone else made would fill itself from whatever file of yours has the same name: a form
// sent to you tagged `live:Taxes.xlsx#Summary`, filled with your numbers and ready to send back. So a tag says who made it,
// and only the person's own blocks are updated; others show what they came with until the person makes them theirs.
//
// `by` is a fresh random salt and a keyed hash of it: `<salt><mac>`, 8 + 16 hex digits. The key is a secret only the person's
// devices hold (one for the account, from the server, and one for this browser, used when signed out). Each block gets its
// own salt, so two of someone's documents can't be told apart as theirs, and without the secret no one can make a `by` that
// passes as theirs.
//
// A tag with no `by` was typed by hand (a person or an agent writing a Markdown note): in a text file (Markdown, HTML, SVG,
// plain text) it counts as the person's own, and is signed the first time it is written. In a Word, OpenDocument, workbook or
// PDF file only the app writes tags, and it always signs them, so an unsigned one there came from elsewhere.

import type { LiveTag } from './liveMarks.ts';

/** The secrets that make a block this person's: every one they hold, and the one new blocks are signed with. */
export interface LiveOwner {
  secrets: readonly string[];
  sign: string;
}

/** What an update is told about who it works for (absent: every block counts as the person's, as in tests and `golem run`). */
export interface OwnerOptions {
  owner?: LiveOwner;
  /** The document is a text file, where a tag with no `by` was typed by hand by the person (see above). */
  unsignedMine?: boolean;
  /** Make It Mine: the blocks showing this source (true: every block) count as the person's, and are signed as theirs. */
  adopt?: true | string;
}

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

const keys = new Map<string, Promise<CryptoKey>>();
function keyOf(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) keys.set(secret, (key = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])));
  return key;
}

async function macOf(secret: string, salt: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await keyOf(secret), new TextEncoder().encode(salt));
  return hex(new Uint8Array(signature).subarray(0, 8));
}

/** A new secret (a browser's own, or an account's on the server). */
export const newOwnerSecret = (): string => hex(crypto.getRandomValues(new Uint8Array(16)));

/** A `by` for a new block, signed with `secret`. */
export async function signedBy(secret: string): Promise<string> {
  const salt = hex(crypto.getRandomValues(new Uint8Array(4)));
  return salt + (await macOf(secret, salt));
}

/** Whether a `by` was made with one of the secrets. */
export async function isOwnedBy(by: string, secrets: readonly string[]): Promise<boolean> {
  if (!/^[0-9a-f]{24}$/.test(by)) return false;
  const salt = by.slice(0, 8);
  for (const secret of secrets) if ((await macOf(secret, salt)) === by.slice(8)) return true;
  return false;
}

/**
 * Whether a block is the person's to update, and the `by` to write with its next result: its own when it is theirs, a new
 * one when it had none (typed by hand) or is being made theirs.
 */
export async function ownership(tag: LiveTag, options: OwnerOptions): Promise<{ mine: boolean; by?: string }> {
  const { owner } = options;
  if (!owner) return { mine: true, ...(tag.by && { by: tag.by }) };
  if (tag.by && (await isOwnedBy(tag.by, owner.secrets))) return { mine: true, by: tag.by };
  if (options.adopt === true || options.adopt === tag.source || (!tag.by && options.unsignedMine)) return { mine: true, by: await signedBy(owner.sign) };
  return { mine: false };
}

/** Whether a document's name is a text file's, where tags may be typed by hand. */
export const isHandWritten = (name: string): boolean => /\.(md|markdown|txt|html?|svg)$/i.test(name);

/** How an update runs: `force` rewrites blocks whose stamp still matches (Update Now); the rest says whose blocks to update. */
export type LiveOptions = OwnerOptions & { force?: boolean };
