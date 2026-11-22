// Encrypted documents and folders in the vault (docs/encrypted-folders.md): they are not written to it, decrypted or not, unless the person
// chose to have an encrypted folder decrypted into it for this session (for ai and other programs to work on). The vault's listing leaves
// the rest out; says which documents are encrypted, so a file the vault still has for one (encrypted since, or a folder no longer shown) is
// taken out rather than read as a new document; and writes a note in place of each encrypted folder that isn't shown.

import { isSealedName } from '@golemdocs/ops';
import { knowKey, openSealedName } from '../encryption/session.ts';
import { t } from '../i18n/index.ts';
import { safeName } from './vaultPlan.ts';

interface DocLike {
  id: string;
  name: string;
  folderId?: string | null;
  encrypted?: boolean | true;
  wrappedKey?: string;
}
interface FolderLike {
  id: string;
  name: string;
  parentId: string | null;
  encrypted?: boolean;
  wrappedKey?: string;
}

/** A note the vault keeps in place of an encrypted folder: where (a vault path) and what it says. */
export interface VaultNote {
  path: string;
  text: string;
}

export interface WithoutEncrypted<D, F> {
  docs: D[];
  folders: F[];
  /** The encrypted documents' ids that are left out. */
  encrypted: string[];
  /** A note beside each encrypted folder left out whose parent is not encrypted. */
  notes: VaultNote[];
  /** The vault paths the encrypted folders left out would have: a folder of that name on disk is not made in the account from it. */
  encryptedPaths: string[];
  /** The vault paths of the encrypted folders decrypted into it now: when one stops, whatever is left there is removed. */
  decryptedPaths: string[];
  /** The encrypted documents kept in because their folder is decrypted into the vault, with that folder (the one that was encrypted). */
  decryptedDocs: { id: string; top: string }[];
}

/**
 * The listing with what is encrypted left out, and what the vault needs to know about what was. `shown` says whether an encrypted folder
 * (by the id of the one at the top of its tree, the one that was encrypted) is decrypted into the vault now: its folders and documents stay
 * in, with their names still sealed (see `openNames`).
 */
export function withoutEncrypted<D extends DocLike, F extends FolderLike>(
  docs: readonly D[],
  folders: readonly F[],
  shown: (top: string) => boolean = () => false,
  /** An encrypted document decrypted into the vault with its folder this session, then moved out of it: it stays in, until that ends. */
  shownDoc: (id: string) => boolean = () => false,
): WithoutEncrypted<D, F> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const pathOf = (folder: F): string => {
    const parts: string[] = [];
    for (let at: F | undefined = folder, depth = 0; at && depth < 64; at = at.parentId ? byId.get(at.parentId) : undefined, depth++) parts.unshift(safeName(at.name));
    return parts.join('/');
  };
  const topOf = (folder: F): string => {
    let top = folder;
    for (let at: F | undefined = folder, depth = 0; at?.encrypted && depth < 64; at = at.parentId ? byId.get(at.parentId) : undefined, depth++) top = at;
    return top.id;
  };
  const hidden = new Set(folders.filter((f) => f.encrypted && !shown(topOf(f))).map((f) => f.id));
  const inShown = (folderId: string | null | undefined) => !!folderId && !!byId.get(folderId)?.encrypted && !hidden.has(folderId);
  const tops = folders.filter((f) => hidden.has(f.id) && !(f.parentId && byId.get(f.parentId)?.encrypted));
  const notes = tops.map((top) => {
    const parent = top.parentId ? byId.get(top.parentId) : undefined;
    const name = safeName(top.name);
    return {
      path: `${parent ? `${pathOf(parent)}/` : ''}${safeName(t('vault.encrypted.file', { name }))}.md`,
      text: `# ${t('vault.encrypted.title', { name: top.name })}\n\n${t('vault.encrypted.intro', { name: top.name })}\n`,
    };
  });
  const left = (d: D) => (d.encrypted && !inShown(d.folderId) && !shownDoc(d.id)) || (!!d.folderId && hidden.has(d.folderId));
  const shownTops = folders.filter((f) => f.encrypted && !hidden.has(f.id) && !(f.parentId && byId.get(f.parentId)?.encrypted));
  return {
    docs: docs.filter((d) => !left(d)),
    folders: folders.filter((f) => !hidden.has(f.id)),
    encrypted: docs.filter(left).map((d) => d.id),
    notes,
    encryptedPaths: tops.map(pathOf),
    decryptedPaths: shownTops.map(pathOf),
    decryptedDocs: docs.filter((d) => d.encrypted && inShown(d.folderId)).map((d) => ({ id: d.id, top: topOf(byId.get(d.folderId!)!) })),
  };
}

/**
 * The names of what is decrypted into the vault, opened (the vault writes files by name). Throws `LockedError` if one can't be: the sync
 * stops before it changes anything, rather than write a file under a sealed name.
 */
export async function openNames<T extends { name: string; wrappedKey?: string }>(items: readonly T[]): Promise<T[]> {
  return Promise.all(
    items.map(async (item) => {
      if (!isSealedName(item.name)) return item;
      knowKey(item.wrappedKey);
      return { ...item, name: await openSealedName(item.name) };
    }),
  );
}
