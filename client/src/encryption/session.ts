// This page's encryption session (docs/encrypted-folders.md): which folders encrypt what goes into them, the item keys known, the personal
// keys pasted in so far, and locking.
//
// Nothing here is ever written anywhere: the personal keys pasted in and the item keys unwrapped with them live in this module's memory until
// the session ends (Lock, the idle timer, or the page going away). Every encrypted item (a document, or a folder whose name is sealed) has its
// own item key, stored wrapped next to it; whatever is sealed says which key opens it, and the key is unwrapped the first time it is needed.

import { isSealed, isSealedName, sealedKeyId, sealedNameKeyId, wrappedKeyId } from '@golemdocs/ops';
import { newItemKey, newPersonalKey, openFile, openName, openPersonalKey, sealFile, sealName, unwrapItemKey, type ItemKeys, type PersonalKey } from './crypto.ts';

/** What the session needs to know of a folder. */
export interface SealedFolderInfo {
  id: string;
  parentId: string | null;
  /** What goes into it is encrypted. */
  encrypted?: boolean;
  /** Its own name is sealed, with this key. */
  wrappedKey?: string;
}

/** Something encrypted was needed while it is locked. */
export class LockedError extends Error {
  constructor() {
    super('it is encrypted, and locked');
    this.name = 'LockedError';
  }
}

/** Every folder known, by id. */
let folders = new Map<string, SealedFolderInfo>();
/** Every wrapped item key known, by its id: the folders', the account's documents', this browser's copies'. */
const wrapped = new Map<string, string>();
/** The account's encrypted documents, by id: their wrapped keys. */
let documents = new Map<string, string>();
/** Keys pasted in this session. */
const personal: PersonalKey[] = [];
/** Item keys unwrapped so far, by key id. */
const unlocked = new Map<string, ItemKeys>();
/** Key ids that none of the pasted keys unwraps (made with another personal key). */
const foreign = new Set<string>();
/** Sealed names opened so far: the library is drawn often, and opening a name is a WebCrypto call. */
const names = new Map<string, string>();
const listeners = new Set<(open: boolean) => void>();

/** Remembers a wrapped item key (from a listing, or a copy in this browser). */
export function knowKey(key: string | undefined | null): void {
  const id = key ? wrappedKeyId(key) : null;
  if (id && key) wrapped.set(id, key);
}

/** Tells the session the folders there are (the account's, or a guest's): called whenever the library lists them. */
export function knowFolders(list: readonly SealedFolderInfo[]): void {
  folders = new Map(list.map((f) => [f.id, f]));
  for (const f of list) knowKey(f.wrappedKey);
}

/** Tells the session the account's documents (whenever the library lists them). */
export function knowDocuments(list: readonly { id: string; encrypted?: boolean; wrappedKey?: string }[]): void {
  documents = new Map(list.flatMap((d) => (d.encrypted && d.wrappedKey ? [[d.id, d.wrappedKey] as const] : [])));
  for (const key of documents.values()) knowKey(key);
}

/** A known wrapped item key, by its id (null if it is not known). */
export const wrappedFor = (keyId: string | null): string | null => (keyId ? (wrapped.get(keyId) ?? null) : null);

/** The wrapped key of an account document that is encrypted (null for an ordinary one, or one not known). */
export const encryptedDocumentKey = (id: string): string | null => documents.get(id) ?? null;

/** This browser's copies known to be sealed (storage marks them as it reads or writes them), so an opening knows at once. */
const sealedCopies = new Set<string>();
export const markSealedCopy = (id: string): void => void sealedCopies.add(id);
export const isSealedCopy = (id: string): boolean => sealedCopies.has(id);

/** A folder changed here (encrypted, or not any more) before the library lists it again. */
export function noteFolder(info: SealedFolderInfo): void {
  folders.set(info.id, info);
  knowKey(info.wrappedKey);
}

/** A folder as the session knows it (null if it does not). */
export const folderInfo = (id: string): SealedFolderInfo | null => folders.get(id) ?? null;

/** Whether what goes into a folder is encrypted: it is encrypted, or inside one that is. */
export function isEncryptedFolder(folderId: string | null | undefined): boolean {
  for (let at = folderId ?? null, depth = 0; at !== null && depth < 64; depth++) {
    const folder = folders.get(at);
    if (!folder) return false;
    if (folder.encrypted) return true;
    at = folder.parentId;
  }
  return false;
}

/** Whether anything is encrypted at all, and whether the session is unlocked. */
export const hasEncrypted = (): boolean => wrapped.size > 0 || [...folders.values()].some((f) => f.encrypted);
export const isUnlocked = (): boolean => personal.length > 0;

/** Whether something encrypted is still locked (all of it before unlocking; what another key made, after). */
export const anyLocked = (): boolean => hasEncrypted() && (!isUnlocked() || [...wrapped.keys()].some((id) => foreign.has(id)));

/** The keys of a wrapped item key, unwrapped with a pasted personal key; throws `LockedError` while none of them unwraps it. */
export async function keysOf(key: string): Promise<ItemKeys> {
  const id = wrappedKeyId(key);
  if (!id) throw new Error('not a wrapped item key');
  const known = unlocked.get(id);
  if (known) return known;
  knowKey(key);
  for (const p of personal) {
    const keys = await unwrapItemKey(p, key);
    if (keys) {
      unlocked.set(id, keys);
      foreign.delete(id);
      return keys;
    }
  }
  if (personal.length) foreign.add(id);
  throw new LockedError();
}

/** Whether a wrapped key opens now (unwrapping it if it can). */
export async function opens(key: string | undefined | null): Promise<boolean> {
  if (!key) return false;
  return keysOf(key).then(
    () => true,
    () => false,
  );
}

/**
 * Unlocks with a pasted personal key. Answers how many of the known keys it opened; 0 means it is not the key for any of them (and it is not
 * kept), unless nothing encrypted is known yet (setup, or a key typed in to encrypt a first document with). Throws `KeyError` (crypto.ts)
 * for text that is not a key at all.
 */
export async function unlock(text: string): Promise<number> {
  const key = await openPersonalKey(text);
  if (personal.some((p) => p.text === key.text)) return Math.max(unlocked.size, 1);
  let opened = 0;
  for (const [id, item] of wrapped) {
    if (unlocked.has(id)) continue;
    const keys = await unwrapItemKey(key, item);
    if (keys) {
      unlocked.set(id, keys);
      foreign.delete(id);
      opened++;
    }
  }
  if (opened === 0 && wrapped.size > 0) return 0;
  personal.push(key);
  for (const id of wrapped.keys()) if (!unlocked.has(id)) foreign.add(id);
  touch();
  emit();
  return Math.max(opened, 1);
}

/** A key made for the person (setup): unlocked at once, and returned so its text can be shown and saved. */
export async function createKey(): Promise<PersonalKey> {
  const key = await newPersonalKey();
  personal.push(key);
  touch();
  emit();
  return key;
}

/** The personal key new item keys are wrapped with: the first one unlocked this session. */
export const currentKey = (): PersonalKey | null => personal[0] ?? null;

/** A new item key, wrapped with the current personal key, and unlocked at once: what a newly encrypted item is sealed with. */
export async function newKey(): Promise<string> {
  const key = currentKey();
  if (!key) throw new LockedError();
  const { wrapped: item, keys } = await newItemKey(key);
  unlocked.set(keys.keyId, keys);
  wrapped.set(keys.keyId, item);
  return item;
}

const beforeLock = new Set<() => Promise<void>>();

/** Work to do while the keys are still here, before the session locks: saving the open encrypted document. */
export function onBeforeLock(work: () => Promise<void>): () => void {
  beforeLock.add(work);
  return () => beforeLock.delete(work);
}

/** Locks after the work before locking is done (a failure there does not keep the session open). */
export async function lockSession(): Promise<void> {
  if (!isUnlocked()) return;
  for (const work of [...beforeLock]) await work().catch((error) => console.error('before locking', error));
  lock();
}

/** Ends the session at once: every key and every opened name is forgotten. Listeners close what shows something encrypted. */
export function lock(): void {
  if (!personal.length && !unlocked.size) return;
  personal.length = 0;
  unlocked.clear();
  foreign.clear();
  names.clear();
  clearTimeout(idleTimer);
  emit();
}

/** Called with true when something unlocks, false when the session locks. */
export function onSessionChange(listener: (open: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  const open = isUnlocked();
  for (const listener of [...listeners]) listener(open);
}

// --- Sealing and opening ---------------------------------------------------------------------------------------------------------

/** Seals a file with an item key (as it is, if it already is sealed). */
export async function sealFileWith(key: string, bytes: Uint8Array): Promise<Uint8Array> {
  if (isSealed(bytes)) return bytes;
  return sealFile(await keysOf(key), bytes);
}

/** Seals a name with an item key (as it is, if it already is sealed). */
export async function sealNameWith(key: string, name: string): Promise<string> {
  if (isSealedName(name)) return name;
  const sealed = await sealName(await keysOf(key), name);
  names.set(sealed, name);
  return sealed;
}

/** The keys a sealed thing names, if they are known and open. */
async function keysFor(keyId: string | null): Promise<ItemKeys> {
  const known = keyId ? unlocked.get(keyId) : undefined;
  if (known) return known;
  const item = keyId ? wrapped.get(keyId) : undefined;
  if (!item) throw new LockedError();
  return keysOf(item);
}

/** Opens a sealed file with the key it names. Throws `LockedError` if that key is not open. */
export async function openSealedFile(bytes: Uint8Array): Promise<Uint8Array> {
  return openFile(await keysFor(sealedKeyId(bytes)), bytes);
}

/** Opens a name: as it is if it is not sealed. Throws `LockedError` while the key it names is not open. */
export async function openSealedName(sealed: string): Promise<string> {
  if (!isSealedName(sealed)) return sealed;
  const known = names.get(sealed);
  if (known !== undefined) return known;
  const name = await openName(await keysFor(sealedNameKeyId(sealed)), sealed);
  names.set(sealed, name);
  return name;
}

// --- The idle lock ---------------------------------------------------------------------------------------------------------------

let idleMinutes = 15;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

/** How long without activity locks the session; 0 turns the idle lock off. */
export function setIdleMinutes(minutes: number): void {
  idleMinutes = Math.max(0, minutes);
  touch();
}

/** Something was done in the app: the idle lock starts counting again. */
export function touch(): void {
  clearTimeout(idleTimer);
  if (!isUnlocked() || idleMinutes <= 0) return;
  idleTimer = setTimeout(() => void lockSession(), idleMinutes * 60_000);
}
