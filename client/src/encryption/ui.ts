// What the person sees of encryption (docs/encrypted-folders.md): the dialogs that set up a key and unlock with one, the questions before
// encrypting or decrypting, the progress while it is done, and the menu entries the Files pane and File › Open both offer, built here once
// so the two menus cannot differ.
//
// The key field is a password field with a username beside it, so a password manager fills it in (on a computer or a phone) and offers
// to save it at setup, without the key passing through the clipboard.

import { copyText } from '../desktop/bridge.ts';
import type { Folder } from '../folders.ts';
import { t } from '../i18n/index.ts';
import type { LibraryEntry } from '../sync.ts';
import { announce } from '../ui/announce.ts';
import { h } from '../ui/dom.ts';
import { dialogTitleBar, showChoice, showDialog } from '../ui/popup.ts';
import type { PopupItem } from '../ui/popupMenu.ts';
import { decryptDocument, decryptFolder, encryptDocument, encryptFolder, entriesIn, exclusive, learnEncrypted, type ConvertHost } from './convert.ts';
import { KeyError } from './crypto.ts';
import { confirmKeys, createKey, currentKey, decryptedInVault, hasEncrypted, isEncryptedFolder, isUnlocked, lock, lockSession, setDecryptedInVault, unlock } from './session.ts';
import { syncedService } from '../desktop/vaultLocation.ts';

/** A modal form with the shared dialog parts: resolves with what `submit` returns, or null for Cancel, Escape or the close button. */
function formDialog<T>(title: string, body: Node[], action: string, submit: (show: (message: string) => void) => Promise<T | null>): Promise<T | null> {
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: 'wm-dialog wm-encryption-dialog', attrs: { 'aria-label': title } });
    const message = h('div', { class: 'wm-find-message', attrs: { role: 'alert' } });
    const cancel = h('button', { class: 'wm-button', text: t('menus.dialog.cancel'), attrs: { type: 'button' } });
    const ok = h('button', { class: 'wm-button wm-primary', text: action, attrs: { type: 'submit' } });
    const form = h('form', { class: 'wm-dialog-body', attrs: { method: 'dialog', autocomplete: 'on' } }, ...body, message, h('div', { class: 'wm-dialog-buttons' }, cancel, ok));
    let result: T | null = null;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      message.textContent = '';
      ok.disabled = true;
      void submit((text) => (message.textContent = text))
        .then((value) => {
          if (value === null) return;
          result = value;
          dialog.close();
        })
        .finally(() => (ok.disabled = false));
    });
    dialog.append(dialogTitleBar(title, () => dialog.close()), form);
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    // The first field that shows (the username a password manager files the key under is hidden).
    [...dialog.querySelectorAll<HTMLInputElement>('input')].find((input) => input.offsetParent !== null)?.focus();
  });
}

/** The hidden username a password manager files the key under. */
const keyUser = () => h('input', { attrs: { type: 'text', name: 'username', autocomplete: 'username', value: t('encryption.keyUser'), hidden: '', 'aria-hidden': 'true', tabindex: '-1' } });

function keyField(label: string, autocomplete: 'current-password' | 'new-password'): { field: HTMLElement; input: HTMLInputElement } {
  const input = h('input', { class: 'wm-input', attrs: { type: 'password', name: 'password', autocomplete, spellcheck: 'false', autocapitalize: 'off' } }) as HTMLInputElement;
  return { input, field: h('label', { class: 'wm-encryption-field' }, h('span', { text: label }), input) };
}

const keyProblem = (error: unknown): string | null =>
  error instanceof KeyError ? (error.problem === 'checksum' ? t('encryption.badChecksum') : t('encryption.badFormat')) : null;

/** Asks for the key and unlocks everything it opens. Resolves whether it did. */
export async function showUnlock(): Promise<boolean> {
  const { field, input } = keyField(t('encryption.keyLabel'), 'current-password');
  const done = await formDialog(t('encryption.unlockTitle'), [h('p', { text: t('encryption.unlockIntro') }), keyUser(), field], t('encryption.unlockButton'), async (show) => {
    try {
      if ((await unlock(input.value)) === 0) {
        show(t('encryption.wrongKey'));
        return null;
      }
      return true;
    } catch (error) {
      show(keyProblem(error) ?? (error as Error).message);
      return null;
    }
  });
  if (done) {
    announce(t('encryption.unlocked'));
    await host?.refresh();
  }
  return done === true;
}

/**
 * The first time: makes a key, shows it to be saved, and asks for it back before going on (proof it was saved: nothing can bring a lost
 * key back). Resolves whether the person finished; if not, the key is forgotten.
 */
export async function showSetup(): Promise<boolean> {
  const key = await createKey();
  const shown = h('code', { class: 'wm-encryption-key', text: key.text, attrs: { tabindex: '0' } });
  const saved = keyField(t('encryption.keyLabel'), 'new-password');
  saved.input.value = key.text;
  saved.field.hidden = true; // there for the password manager to offer to save; the key is read from `shown`
  const copied = h('span', { class: 'wm-encryption-copied', attrs: { role: 'status' } });
  const copy = h('button', { class: 'wm-button', text: t('encryption.copyKey'), attrs: { type: 'button' } });
  copy.addEventListener('click', () => void copyText(key.text).then(() => (copied.textContent = t('encryption.copied'))));
  const confirm = keyField(t('encryption.confirmLabel'), 'current-password');
  confirm.input.name = 'confirm';
  confirm.input.autocomplete = 'off';
  const done = await formDialog(
    t('encryption.setupTitle'),
    [h('p', { text: t('encryption.setupIntro') }), keyUser(), saved.field, shown, h('div', { class: 'wm-encryption-row' }, copy, copied), confirm.field],
    t('encryption.setupButton'),
    async (show) => {
      const typed = confirm.input.value.trim().toUpperCase().replace(/[\s-]/g, '');
      if (typed !== key.text.toUpperCase().replace(/-/g, '')) {
        show(t('encryption.confirmMismatch'));
        return null;
      }
      return true;
    },
  );
  if (!done) lock();
  return done === true;
}

/**
 * Makes sure a key is unlocked to encrypt with: the person's, if they have encrypted anything, else a new one set up now. What they have
 * encrypted is checked with the account first, not taken from the library as last listed: offline, or before it is listed, it would look
 * like nothing, and a second key would be made (or a mistyped one used) beside the one their documents need.
 */
export async function ensureKey(): Promise<boolean> {
  if (!host) return false;
  // A key made here or seen to open what they encrypted needs no check.
  if (currentKey()) return true;
  try {
    await learnEncrypted(host.convert());
  } catch {
    showDialog(t('encryption.setupTitle'), h('p', { text: t('encryption.checkFailed') }));
    return false;
  }
  if (isUnlocked() && (await confirmKeys())) return true;
  if (!hasEncrypted()) return showSetup();
  return (await showUnlock()) && confirmKeys();
}

/** Locks everything now (after saving what is open, if it is encrypted). */
export async function lockNow(): Promise<void> {
  await lockSession();
  announce(t('encryption.locked'));
}

// --- Encrypting and decrypting -------------------------------------------------------------------------------------------------------

/** What converting needs from the app (main.ts sets it). */
export interface EncryptionHost {
  convert(): ConvertHost;
  /** The library as shown (names opened). */
  folders(): readonly Folder[];
  entries(): readonly LibraryEntry[];
  /** Before converting these: the open document among them is saved and closed (it is opened again after). */
  before(entries: readonly LibraryEntry[]): Promise<void>;
  /** Lists the library again, and opens again what `before` closed. */
  refresh(): Promise<void>;
  after(): void;
  /** The desktop vault folder's path, where an encrypted folder can be decrypted into for a session; null where there is none (a browser, a phone). */
  vaultRoot?(): string | null;
  /** Ends an encrypted folder's time in the vault: what changed there is saved, encrypted, then its files are removed. */
  stopInVault?(folderId: string): Promise<void>;
}

let host: EncryptionHost | null = null;
export const setEncryptionHost = (next: EncryptionHost): void => void (host = next);

/** A small dialog saying how far a conversion has gone; closed when it is done. */
function progressDialog(title: string): { update(text: string): void; close(): void } {
  const dialog = h('dialog', { class: 'wm-dialog wm-encryption-dialog', attrs: { 'aria-label': title } });
  const status = h('p', { attrs: { role: 'status' } });
  dialog.append(dialogTitleBar(title, () => undefined), h('div', { class: 'wm-dialog-body' }, status));
  dialog.querySelector('.wm-dialog-close')?.remove(); // it finishes, or fails, on its own
  dialog.addEventListener('cancel', (e) => e.preventDefault());
  document.body.append(dialog);
  dialog.showModal();
  return { update: (text) => (status.textContent = text), close: () => (dialog.close(), dialog.remove()) };
}

/** Runs a conversion with its progress shown, and says how it went. */
async function converting(title: string, word: 'encrypt' | 'decrypt', entries: readonly LibraryEntry[], work: (progress: (done: number, total: number) => void) => Promise<void>): Promise<boolean> {
  if (!host) return false;
  const shown = progressDialog(title);
  let failed: unknown = null;
  try {
    await host.before(entries);
    await exclusive(() => work((done, total) => shown.update(t(word === 'encrypt' ? 'encryption.progress' : 'encryption.progressDecrypt', { done, total }))));
  } catch (error) {
    failed = error;
  } finally {
    shown.close();
    await host.refresh();
    host.after();
  }
  if (failed) showDialog(title, h('p', { text: t('encryption.failed', { message: (failed as Error).message }) }));
  return !failed;
}

/** Encrypt…: asks, sets up or unlocks the key, and encrypts the documents. */
export async function encryptDocuments(entries: readonly LibraryEntry[], ask = true): Promise<boolean> {
  if (!host || !entries.length) return false;
  const title = entries.length === 1 ? t('encryption.encryptTitle', { name: entries[0]!.name }) : t('encryption.encryptManyTitle', { count: entries.length });
  if (ask && !(await showChoice(title, h('p', { text: t('encryption.encryptIntro') }), [{ label: t('encryption.encryptButton'), value: true, primary: true }]))) return false;
  if (!(await ensureKey())) return false;
  const convert = host.convert();
  const done = await converting(title, 'encrypt', entries, async (progress) => {
    for (let i = 0; i < entries.length; i++) {
      progress(i, entries.length);
      await encryptDocument(entries[i]!, convert);
    }
  });
  if (done) announce(t('encryption.encryptedDone'));
  return done;
}

/** Decrypt…: asks, unlocks if need be, and decrypts the documents. */
export async function decryptDocuments(entries: readonly LibraryEntry[], ask = true): Promise<boolean> {
  if (!host || !entries.length) return false;
  const title = entries.length === 1 ? t('encryption.decryptTitle', { name: entries[0]!.name }) : t('encryption.decryptManyTitle', { count: entries.length });
  if (ask && !(await showChoice(title, h('p', { text: t('encryption.decryptIntro') }), [{ label: t('encryption.decryptButton'), value: true, primary: true }]))) return false;
  if (!isUnlocked() && !(await showUnlock())) return false;
  const convert = host.convert();
  const done = await converting(title, 'decrypt', entries, async (progress) => {
    for (let i = 0; i < entries.length; i++) {
      progress(i, entries.length);
      await decryptDocument(entries[i]!, convert);
    }
  });
  if (done) announce(t('encryption.decryptedDone'));
  return done;
}

/** Encrypt folder…: asks, sets up or unlocks the key, and encrypts the folder and everything in it. */
export async function encryptFolderNow(folder: Folder, ask = true): Promise<boolean> {
  if (!host) return false;
  const title = t('encryption.encryptTitle', { name: folder.name });
  if (ask && !(await showChoice(title, h('p', { text: t('encryption.encryptFolderIntro') }), [{ label: t('encryption.encryptButton'), value: true, primary: true }]))) return false;
  if (!(await ensureKey())) return false;
  const { convert, folders, entries } = { convert: host.convert(), folders: host.folders(), entries: host.entries() };
  const done = await converting(title, 'encrypt', entriesIn(folder, folders, entries), (progress) => encryptFolder(folder, folders, entries, convert, progress));
  if (done) announce(t('encryption.encryptedDone'));
  return done;
}

/** Decrypt folder…: asks, unlocks if need be, and decrypts the folder and everything in it. */
export async function decryptFolderNow(folder: Folder, ask = true): Promise<boolean> {
  if (!host) return false;
  const title = t('encryption.decryptTitle', { name: folder.name });
  if (ask && !(await showChoice(title, h('p', { text: t('encryption.decryptFolderIntro') }), [{ label: t('encryption.decryptButton'), value: true, primary: true }]))) return false;
  if (!isUnlocked() && !(await showUnlock())) return false;
  const { convert, folders, entries } = { convert: host.convert(), folders: host.folders(), entries: host.entries() };
  const done = await converting(title, 'decrypt', entriesIn(folder, folders, entries), (progress) => decryptFolder(folder, folders, entries, convert, progress));
  if (done) announce(t('encryption.decryptedDone'));
  return done;
}

/**
 * Before a move into an encrypted folder: what is not encrypted is encrypted first, without asking again (going into that folder means
 * it). Resolves whether the move can go ahead.
 */
export async function encryptForMove(item: { kind: 'doc'; entry: LibraryEntry } | { kind: 'folder'; folder: Folder }, to: string | null): Promise<boolean> {
  if (!isEncryptedFolder(to)) return true;
  if (item.kind === 'doc') return item.entry.encrypted || item.entry.local?.encrypted || item.entry.cloud?.encrypted ? true : encryptDocuments([item.entry], false);
  return item.folder.encrypted ? true : encryptFolderNow(item.folder, false);
}

/** Whether moving `item` to `to` takes something encrypted out of an encrypted folder, into an ordinary place. */
function leavesEncryption(item: { kind: 'doc'; entry: LibraryEntry } | { kind: 'folder'; folder: Folder }, to: string | null): boolean {
  if (isEncryptedFolder(to)) return false;
  if (item.kind === 'doc') return isEncryptedFolder(item.entry.folderId) && !!(item.entry.encrypted || item.entry.local?.encrypted || item.entry.cloud?.encrypted);
  return isEncryptedFolder(item.folder.parentId) && !!item.folder.encrypted;
}

/**
 * A move in the app (dragged, or Move…) across the edge of an encrypted folder (docs/encrypted-folders.md). Into one, what isn't encrypted
 * is encrypted first. Out of one, into an ordinary place, it is decrypted, after asking: it is moved first (the server decrypts nothing
 * while it is inside an encrypted folder), then decrypted, file, name and versions. Cancel leaves it where it was. `move` makes the move.
 * (Moves made in the vault folder never decrypt: nobody is there to ask, so a document moved out there stays encrypted.)
 */
export async function moveAcrossEncryption(item: { kind: 'doc'; entry: LibraryEntry } | { kind: 'folder'; folder: Folder }, to: string | null, move: () => Promise<void>): Promise<void> {
  if (!(await encryptForMove(item, to))) return;
  if (!leavesEncryption(item, to)) return move();
  const name = item.kind === 'doc' ? item.entry.name : item.folder.name;
  const asked = await showChoice(t('encryption.moveOutTitle', { name }), h('p', { text: t(item.kind === 'doc' ? 'encryption.moveOutIntro' : 'encryption.moveOutFolderIntro') }), [{ label: t('encryption.moveOutButton'), value: true, primary: true }]);
  if (!asked) return;
  if (!isUnlocked() && !(await showUnlock())) return;
  await move();
  if (item.kind === 'doc') await decryptDocuments([item.entry], false);
  else await decryptFolderNow(item.folder, false);
}

/** Whether moving these to `to` crosses the edge of an encrypted folder, either way (each is then moved on its own, through `moveAcrossEncryption`). */
export function crossesEncryption(items: readonly ({ kind: 'doc'; entry: LibraryEntry } | { kind: 'folder'; folder: Folder })[], to: string | null): boolean {
  return items.some((item) => leavesEncryption(item, to) || (isEncryptedFolder(to) && (item.kind === 'doc' ? !(item.entry.encrypted || item.entry.local?.encrypted || item.entry.cloud?.encrypted) : !item.folder.encrypted)));
}

// --- Menu entries --------------------------------------------------------------------------------------------------------------------

/** A document's entries, the same in the Files pane and File › Open: Unlock… while locked, else Encrypt… or Decrypt…. */
export function documentItems(entry: LibraryEntry): PopupItem[] {
  if (entry.locked) return [{ label: t('encryption.unlock'), run: () => void showUnlock() }];
  if (entry.encrypted || entry.local?.encrypted || entry.cloud?.encrypted) {
    // Everything in an encrypted folder is encrypted: decrypting one there would leave it where it can't be.
    return isEncryptedFolder(entry.folderId) ? [] : [{ label: t('encryption.decrypt'), run: () => void decryptDocuments([entry]) }];
  }
  return [{ label: t('encryption.encrypt'), run: () => void encryptDocuments([entry]) }];
}

/**
 * A folder's entries, likewise: Unlock… while locked; on the folder that was encrypted, Decrypt folder…, Decrypt into vault folder… (or Stop
 * decrypting in vault folder) in the desktop app, and Lock; on an ordinary one, Encrypt folder….
 */
export function folderItems(folder: Folder): PopupItem[] {
  if (folder.locked) return [{ label: t('encryption.unlock'), run: () => void showUnlock() }];
  if (isEncryptedFolder(folder.parentId)) return [];
  if (!folder.encrypted) return [{ label: t('encryption.encryptFolder'), run: () => void encryptFolderNow(folder) }];
  const vault = host?.vaultRoot?.() ? [decryptedInVault(folder.id) ? { label: t('encryption.vaultStop'), run: () => void stopInVault(folder) } : { label: t('encryption.vaultDecrypt'), run: () => void decryptIntoVault(folder) }] : [];
  return [{ label: t('encryption.decryptFolder'), run: () => void decryptFolderNow(folder) }, ...vault, { label: t('encryption.lock'), run: () => void lockNow() }];
}

// --- Decrypted into the vault folder ------------------------------------------------------------------------------------------------

/**
 * Decrypt into vault folder…: an unlocked encrypted folder's documents written readable to the desktop vault for this session, for ai and
 * other programs to work on, after the risks are said. The server still gets only sealed files (vaultHost.ts seals what comes back). Not
 * where the vault is in a folder another service syncs: it would upload the readable files.
 */
export async function decryptIntoVault(folder: Folder): Promise<boolean> {
  const root = host?.vaultRoot?.();
  if (!root || !folder.encrypted || folder.locked) return false;
  const service = syncedService(root);
  if (service) {
    showDialog(t('encryption.vaultSyncedTitle'), h('p', { text: t('encryption.vaultSynced', { service }) }));
    return false;
  }
  const body = h(
    'div',
    {},
    h('p', { text: t('encryption.vaultIntro') }),
    h('ul', {}, ...[t('encryption.vaultRiskSync'), t('encryption.vaultRiskBackup'), t('encryption.vaultRiskAi')].map((risk) => h('li', { text: risk }))),
    h('p', { text: t('encryption.vaultEnd') }),
  );
  if (!(await showChoice(t('encryption.vaultTitle', { name: folder.name }), body, [{ label: t('encryption.vaultButton'), value: true, primary: true }]))) return false;
  if (!isUnlocked() && !(await showUnlock())) return false;
  setDecryptedInVault(folder.id, true);
  announce(t('encryption.vaultStarted', { name: folder.name }));
  return true;
}

/** Stop decrypting in vault folder: its files are taken out of the vault (any change made there is saved first, sealed). */
export async function stopInVault(folder: Folder): Promise<void> {
  announce(t('encryption.vaultStopped'));
  if (host?.stopInVault) await host.stopInVault(folder.id);
  else setDecryptedInVault(folder.id, false);
}
