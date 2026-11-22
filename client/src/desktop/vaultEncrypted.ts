// Encrypted documents and folders in the vault (docs/encrypted-folders.md): they are never written to it, decrypted or not. The vault's
// listing leaves them out; says which documents are encrypted, so a file the vault still has for one (it was encrypted since) is taken out
// rather than read as a new document; and writes a note in place of each encrypted folder, so the folder doesn't simply vanish.

import { t } from '../i18n/index.ts';
import { safeName } from './vaultPlan.ts';

interface DocLike {
  id: string;
  folderId?: string | null;
  encrypted?: boolean | true;
}
interface FolderLike {
  id: string;
  name: string;
  parentId: string | null;
  encrypted?: boolean;
}

/** A note the vault keeps in place of an encrypted folder: where (a vault path) and what it says. */
export interface VaultNote {
  path: string;
  text: string;
}

export interface WithoutEncrypted<D, F> {
  docs: D[];
  folders: F[];
  /** The encrypted documents' ids. */
  encrypted: string[];
  /** A note beside each encrypted folder whose parent is not encrypted. */
  notes: VaultNote[];
  /** The vault paths the encrypted folders would have: a folder of that name on disk is not made in the account from it. */
  encryptedPaths: string[];
}

/** The listing with everything encrypted left out, and what the vault needs to know about what was. */
export function withoutEncrypted<D extends DocLike, F extends FolderLike>(docs: readonly D[], folders: readonly F[]): WithoutEncrypted<D, F> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const pathOf = (folder: F): string => {
    const parts: string[] = [];
    for (let at: F | undefined = folder, depth = 0; at && depth < 64; at = at.parentId ? byId.get(at.parentId) : undefined, depth++) parts.unshift(safeName(at.name));
    return parts.join('/');
  };
  const sealed = new Set(folders.filter((f) => f.encrypted).map((f) => f.id));
  const tops = folders.filter((f) => f.encrypted && !(f.parentId && sealed.has(f.parentId)));
  const notes = tops.map((top) => {
    const parent = top.parentId ? byId.get(top.parentId) : undefined;
    const name = safeName(top.name);
    return {
      path: `${parent ? `${pathOf(parent)}/` : ''}${safeName(t('vault.encrypted.file', { name }))}.md`,
      text: `# ${t('vault.encrypted.title', { name: top.name })}\n\n${t('vault.encrypted.intro', { name: top.name })}\n`,
    };
  });
  return {
    docs: docs.filter((d) => !d.encrypted && !(d.folderId && sealed.has(d.folderId))),
    folders: folders.filter((f) => !sealed.has(f.id)),
    encrypted: docs.filter((d) => d.encrypted || (d.folderId && sealed.has(d.folderId))).map((d) => d.id),
    notes,
    encryptedPaths: tops.map(pathOf),
  };
}
