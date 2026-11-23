// Encrypted documents and folders, as the server sees them (docs/encrypted-folders.md). It cannot read them, so it keeps what it is sent and
// checks only that what must be sealed is (@golemdocs/ops sealed.ts), so a client bug cannot leave a readable file or name behind.
//
// An encrypted document (`documents.encrypted`) has its file, name and kept versions sealed, and its item key wrapped by the person's own key
// (`wrapped_key`). An encrypted folder (`folders.encrypted`, with its own `wrapped_key`) encrypts what goes into it: everything created in it
// or moved into it, at any depth, must be encrypted, and a folder's name inside one is sealed. Only the folder that was encrypted keeps a
// readable name. Documents and folders are converted in the browser, then saved as such.

import { isSealed, isSealedName, isSealedSize, isWrappedKey, sealedKeyId, wrappedKeyId } from '@golemdocs/ops';
import { listFolders } from './folderShares.ts';
import { HttpError } from './http.ts';
import type { UserDb } from './userDb.ts';

export interface FolderLike {
  id: string;
  parent_id: string | null;
  encrypted?: number | null;
  wrapped_key?: string | null;
}

/** For each folder, whether what goes into it is encrypted: it is encrypted, or inside one that is. */
export function encryptedInside(folders: Iterable<FolderLike>): Map<string, boolean> {
  const byId = new Map<string, FolderLike>();
  for (const folder of folders) byId.set(folder.id, folder);
  const out = new Map<string, boolean>();
  const of = (id: string, depth = 0): boolean => {
    const known = out.get(id);
    if (known !== undefined) return known;
    const folder = byId.get(id);
    const value = !!folder && (!!folder.encrypted || (folder.parent_id !== null && depth < 64 && of(folder.parent_id, depth + 1)));
    out.set(id, value);
    return value;
  };
  for (const id of byId.keys()) of(id);
  return out;
}

/** Whether what goes into a folder is encrypted (null: the top level, which never is). From the catalogue cache, as ordinary saves ask too. */
export async function folderEncrypts(db: UserDb, folderId: string | null): Promise<boolean> {
  if (folderId === null) return false;
  return encryptedInside(await listFolders<FolderLike & { name: string }>(db)).get(folderId) ?? false;
}

/** Refuses what an encrypted document or folder cannot do: anything that needs the server to read it, or to give it to someone else. */
export function refuseEncrypted(item: { encrypted?: number | null } | null | undefined, what: string): void {
  if (item?.encrypted) throw new HttpError(409, `${what} is not available for an encrypted document or folder`, 'encrypted');
}

/** The file saved into an encrypted document must be sealed. */
export function requireSealed(bytes: ArrayBuffer | Uint8Array): void {
  if (!isSealed(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))) throw new HttpError(400, 'an encrypted document’s file must be encrypted', 'not-sealed');
}

/**
 * A save of an encrypted document must be sealed with its own key (the one its header names): bytes sealed with another key would replace
 * it with a file its key can't open.
 */
export function requireSealedWith(bytes: ArrayBuffer | Uint8Array, wrapped: string | null | undefined): void {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  requireSealedStart(view, wrapped);
  if (!isSealedSize(view.byteLength)) throw new HttpError(400, 'an encrypted document’s file is not the size of an encrypted file', 'not-sealed');
}

/** The first bytes of an encrypted document's file (the whole of it, or its first chunk) are sealed with its own key. */
export function requireSealedStart(bytes: Uint8Array, wrapped: string | null | undefined): void {
  requireSealed(bytes);
  if (!wrapped || sealedKeyId(bytes) !== wrappedKeyId(wrapped)) throw new HttpError(400, 'an encrypted document’s file must be encrypted with its own key', 'not-sealed');
}

/** A decrypted document's file must not be sealed any more. */
export function requireOpen(bytes: ArrayBuffer | Uint8Array): void {
  if (isSealed(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))) throw new HttpError(400, 'a decrypted document’s file must not be encrypted', 'sealed');
}

/** A name given to something encrypted must be sealed; returns it. */
export function sealedName(raw: unknown): string {
  if (typeof raw !== 'string' || !isSealedName(raw)) throw new HttpError(400, 'an encrypted document’s or folder’s name must be encrypted', 'not-sealed');
  return raw;
}

/** A wrapped item key, as sent. */
export function wrappedKey(raw: unknown): string {
  if (!isWrappedKey(raw)) throw new HttpError(400, 'expected a wrapped item key', 'not-sealed');
  return raw;
}

/** What goes into an encrypted folder must be encrypted. */
export function requireEncryptedInto(into: boolean, item: { encrypted?: number | null }): void {
  if (into && !item.encrypted) throw new HttpError(409, 'everything in an encrypted folder is encrypted: encrypt it first', 'encrypted');
}
