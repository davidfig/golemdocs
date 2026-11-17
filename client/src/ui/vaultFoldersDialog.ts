// "In my vault…" on a shared folder's card (desktop app): whether the vault keeps a copy of the folder, and which of its folders
// (docs/folder-sharing.md, "Vault copies"). A folder left out stays in the account and the app; the vault gets an index of it.

import type { SharedFolder, SharedFolderTree } from '../cloud.ts';
import { defaultExcluded } from '../desktop/vaultShared.ts';
import { t } from '../i18n/index.ts';
import { h } from './dom.ts';
import { showChoice } from './popup.ts';

/** What the vault keeps of a shared folder: a copy at all, and the folders (ids) left out, or null while nothing was chosen. */
export interface VaultChoice {
  keep: boolean;
  excluded: string[] | null;
}

/** Asks what the vault keeps of `share`, given what is in it. Resolves with the new choice, or null for Cancel. */
export async function chooseVaultFolders(share: SharedFolder, tree: SharedFolderTree, current: VaultChoice): Promise<VaultChoice | null> {
  const top = tree.folders.find((f) => f.parentId === null)?.id ?? share.folderId;
  const startOut = new Set(current.excluded ?? defaultExcluded(tree));
  const children = new Map<string, SharedFolderTree['folders']>();
  for (const f of tree.folders) if (f.parentId) children.set(f.parentId, [...(children.get(f.parentId) ?? []), f]);
  for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name));

  const keep = h('input', { attrs: { type: 'checkbox' } });
  keep.checked = current.keep;
  const boxes: { id: string; box: HTMLInputElement; parent: HTMLInputElement | null }[] = [];

  /** The list of folders under `parentId`, each with a checkbox; a folder's own list follows its row. */
  const list = (parentId: string, parent: HTMLInputElement | null, depth: number): HTMLElement | null => {
    const kids = children.get(parentId) ?? [];
    if (!kids.length || depth > 64) return null;
    const ul = h('ul', { class: 'wm-vault-folders', attrs: depth ? {} : { 'aria-label': t('panels.dashboard.vaultFolders') } });
    for (const f of kids) {
      const box = h('input', { attrs: { type: 'checkbox' } });
      box.checked = !startOut.has(f.id);
      boxes.push({ id: f.id, box, parent });
      ul.append(h('li', {}, h('label', { class: 'wm-find-case' }, box, f.name), list(f.id, box, depth + 1)));
    }
    return ul;
  };
  const folders = list(top, null, 0);

  /** A folder is shown kept only if every folder above it is; nothing can be picked while the copy is off. */
  const update = () => {
    for (const { box, parent } of boxes) box.disabled = !keep.checked || (parent !== null && (parent.disabled || !parent.checked));
  };
  keep.addEventListener('change', update);
  for (const { box } of boxes) box.addEventListener('change', update);
  update();

  const large = current.excluded === null && startOut.size > 0;
  const body = h(
    'div',
    { class: 'wm-vault-choice' },
    h('label', { class: 'wm-find-case' }, keep, t('panels.dashboard.keepCopyOf', { name: share.name })),
    ...(folders
      ? [h('p', { class: 'wm-hint', text: t('panels.dashboard.vaultFoldersNote') }), ...(large ? [h('p', { class: 'wm-hint', text: t('panels.dashboard.vaultLarge') })] : []), folders]
      : [h('p', { class: 'wm-hint', text: t('panels.dashboard.vaultNoFolders') })]),
  );
  const saved = await showChoice(t('panels.dashboard.vaultTitle'), body, [{ label: t('panels.dashboard.vaultSave'), value: true }], { className: 'wm-vault-dialog' });
  if (!saved) return null;
  // Only the topmost folder of each part left out is kept: what is under it goes with it.
  const kept = (b: HTMLInputElement | null): boolean => b === null || (b.checked && kept(boxes.find((x) => x.box === b)!.parent));
  const out = boxes.filter(({ box, parent }) => !box.checked && kept(parent)).map((b) => b.id);
  return { keep: keep.checked, excluded: out };
}
