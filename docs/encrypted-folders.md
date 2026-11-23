# Encrypted documents and folders

Plan agreed 2026-11-22, revised the same day: encryption is turned on for a document or folder you already have, not made as a special
folder. Step 1 is built (see *Status*).

Any document or folder can be encrypted, and decrypted again. An encrypted document syncs like any other, but its file and name are encrypted
in the browser before they are saved or uploaded, with a key the person keeps in their password manager and the server never sees. Everything
in an encrypted folder is encrypted, and so is anything added to it later. Encrypted documents stay locked until the key is entered, and
unlock only for that session.

## What it protects against

**A breach of stored data:** a dump of D1 and R2, a leaked storage token, someone with read access to the buckets. They get blobs, no names
and nothing to guess against.

**Not against someone who can change the code the server sends.** The desktop and iOS apps load the live website, so whoever can deploy it
can ship a page that captures the key when it is pasted. The Cloudflare account and deploy access are the perimeter. Nor does it protect an
unlocked session on a device someone else is using.

What a breach still shows: the name of a folder that was encrypted (the person chose that; the names of what is inside it, subfolders
included, are sealed), which documents are encrypted and roughly how big they are (*Padding*), when each was created, saved and deleted, how
many versions history keeps, and the shape of the folder tree.

**Read, not write.** Someone who can also write to the storage can't read or forge an encrypted document, but can put back an older file
of the same document (a version, or the file as it was), or swap its versions: AES-GCM shows a file was made with the document's key, not
that it is the newest. Telling would need a record of the newest that the server can't change, which the browser doesn't have across
devices. Each document has its own key, so a file can't be passed off as another document's.

**Copies outside the app.** A vault folder in "Desktop & Documents" in iCloud (macOS) is uploaded under an unchanged path, so the check
before decrypting into it can't refuse it (`syncedService`); its question names that setting instead.

## Decisions

- **Encrypt what you have.** A document's menu has Encrypt… (Decrypt… once it is); so has a folder's. There is no special kind of folder to
  make. The File menu has the same for the open document, and Unlock… and Lock for the session.
- **Encrypting a folder** encrypts everything in it, subfolders included: their files, their names and their history. Anything saved,
  imported or moved into it afterwards is encrypted on the way in. The folder's own name stays readable.
- **Encrypting a document** seals its file and name, and reseals every version its history keeps, here and in the account, so no readable
  copy is left in either. Copies made before (downloads, the desktop vault, other devices) are not reached: the person is told.
- **Decrypting** does the same the other way, after asking: the server can read the document again.
- **Moving across the edge, in the app** (dragged, or Move…; `moveAcrossEncryption`, `encryption/ui.ts`): into an encrypted folder, what
  isn't encrypted is encrypted on the way; out of one into an ordinary place, it is decrypted, after asking ("Decrypt and move"), moved
  first and then decrypted (the server decrypts nothing inside an encrypted folder). A subfolder moved out is decrypted with everything in
  it. Cancel leaves it where it was. Moves made in the vault folder never decrypt (nobody is there to ask; see *Decrypted into the vault
  folder*).
- **The key's text is not kept.** Unlocking keeps only a key WebCrypto won't give back and a fingerprint (`PersonalKey.id`); setup
  returns the text once, to show. A script in the page can use an unlocked key, but not carry it off.
- **The key is random and the person keeps it.** A 256-bit **personal key**, generated in the browser, shown once to save in a password
  manager. The server never has it, so there is no passphrase to guess offline. It is never stored on a device either: it is pasted in to
  unlock, held in memory, and gone when the session ends. One key opens everything the person encrypted.
- **Each item carries its own key.** Every encrypted document, and every folder whose name is sealed, has a random **item key**, kept
  wrapped (AES-KW) by the personal key next to it: on the server for an account's, in IndexedDB for a guest's. Items move freely, between
  folders and into the account at sign-in, with nothing to convert. Changing the personal key rewraps item keys and re-encrypts nothing.
- **Lost key, lost documents.** No recovery and no reset. Setup does not finish until the key has been pasted back.
- **One key, never a second by accident.** New item keys are made only with a personal key known to be the person's (`verified`,
  `session.ts`): one made here, or one seen to open something they encrypted. Before a key is set up or first used to encrypt, what they
  have encrypted is asked of the account (`learnEncrypted`, `convert.ts`), not taken from the library as last listed; offline, setup is
  refused rather than risk a second key. A key typed in while nothing encrypted is known unlocks, but encrypts nothing until confirmed.
- **Locked until unlocked.** A locked encrypted document shows in its folder as "Encrypted document" with a padlock, a subfolder of an
  encrypted folder as "Encrypted folder"; opening either asks for the key. Unlocking opens everything that key encrypted.
- **Unlocked only for the session.** A session ends when the page reloads, the tab closes or the app quits; on Lock; after 15 minutes with
  nothing done (to be set in Options). Locking saves the open encrypted document, closes it, and forgets every decrypted thing.
- **Signed in or not**, the same.
- **Encrypting ends sharing.** Encrypting a document removes its shares and public link (and a folder's, its folder shares and link), ends
  its room (which forgets the edits it kept), and deletes its thumbnail and search index, in the account and in this browser (with its
  memory image and merge base). Decrypting it later gives nobody access back.
- **Never shared, never in a room, never in the vault.** An encrypted document or folder cannot be shared or have a public link, and a share
  of an ordinary folder does not reach the encrypted ones in it. It never joins a room (two of the person's own devices editing it at once
  merge as offline edits do). It is left out of the desktop vault, whose guide for agents says so: a file the vault had for a document
  encrypted since is removed (an edit made to it there is saved into the document first, sealed), and a note, `<name> (encrypted).md`,
  stands in for each encrypted folder.
- **WebCrypto only.** No dependency.

## Decrypted into the vault folder, for a session

For working on an encrypted folder with ai on this computer. An unlocked encrypted folder (the one that was encrypted) has Decrypt into
vault folder… in its menu, in the desktop app only, while it has a vault folder (not a phone, whose vault is in iCloud Drive).

- **Refused where the vault folder syncs.** A vault inside iCloud Drive, Dropbox, OneDrive, Google Drive or Box (`syncedService`,
  `desktop/vaultLocation.ts`, from the path) would upload the readable files; the app says so and does nothing. macOS's Desktop & Documents
  in iCloud syncs `~/Documents` without changing its path, so the warning names that case too.
- **Asked first,** naming the risks: a vault in a synced folder, backups and search indexing (Time Machine, Spotlight) keeping copies while
  the files are there, and the ai app sending what it reads to its own servers.
- **For this session only** (`setDecryptedInVault`, `encryption/session.ts`, in memory). While it lasts, the vault's listing keeps that
  folder's tree with names opened (`withoutEncrypted`'s `shown`, `openNames`), its documents are written opened (`vaultHost.ts`), and what
  comes back is sealed with each document's key: a changed file, a new one (a new key, in the encrypted folder), a new folder (its own key
  and a sealed name), a rename (the name sealed). The server keeps refusing anything readable for these documents, so a bug can't change
  that. No copy is kept in this browser from the vault's side.
- **Moving in and out, in the vault.** An ordinary document moved into the folder is encrypted first, file, name and versions
  (`encryptAccountDocument`, or `encryptDocument` signed out), then moved. One moved out stays encrypted in the account (moving a file never
  decrypts anything on the server); its file stays in the vault where it was put while the folder's session lasts
  (`rememberInVault`/`documentInVault`, session.ts), and goes with the rest when it ends.
- **Taken out when it ends:** Stop decrypting in vault folder, Lock, or the idle timer (`endInVault` in `main.ts`, before the keys go) sync
  the vault while the folder is still decrypted into it, so a file changed or made just now reaches its document, encrypted; then the folder
  stops and the vault syncs again, which saves any change into its document, sealed, and removes every document's file (the same path as for
  a document encrypted since, `syncVault`). Files the vault doesn't sync that are left under the folder go too (`State.decrypted`).
  Starting and any conversion sync the vault at once (`VaultService.syncAfterCurrent`).
- **Never a readable document from an encrypted folder's path:** a file under an encrypted folder that isn't decrypted into the vault is
  left out of the plan, so it is never uploaded as an ordinary document; one made there after the last sync is taken in, encrypted, the
  next time the folder is decrypted into the vault.
- **After a quit or a crash** the files are still there (the shell doesn't let the page finish first). The next start's sync, locked,
  removes the documents' files that were not changed and the files the vault doesn't sync; a changed document is kept (not lost, not
  uploaded readable) until the key is entered, then saved and removed, and a document made just before is kept until the folder is
  decrypted into the vault again.
- **Limits:** a document encrypted on its own (not in an encrypted folder) is never decrypted into the vault; the folder scan doesn't see
  names starting with a dot, so a file named so in the folder is left on disk (the agent guide says never to put one there).

## Keys and formats (`@golemdocs/ops` `sealed.ts`, `client/src/encryption/crypto.ts`)

- **Personal key:** 32 random bytes, shown as `golem-key-1-` and Crockford base32 in groups of four, with a two-group checksum.
- **Item key:** 32 random bytes and a random 16-byte **key id**. Stored as `wrappedKey`: base64url of the key id followed by the AES-KW
  wrapping of the key (16 + 40 bytes, 75 characters). The wrong personal key fails AES-KW's integrity check: that is how a wrong key is told.
- **Subkeys** by HKDF (the key id as salt): one seals files, one seals names.
- **Envelope:** `GDE1`, the key id, a 12-byte nonce, then the AES-GCM ciphertext and tag; the magic and key id are the additional data. A
  sealed file or name says which key opens it, so the browser opens what it has without knowing where it came from.
- **Names:** `gde1.` and the envelope in base64url, padded to 32-byte steps.
- **Padding:** a file is padded to 4 KiB, then to the next of 16 steps per doubling.

## The server (`server/src/sealed.ts`)

- **Schema** (user database): `documents.encrypted` and `documents.wrapped_key`; `folders.encrypted` (its contents are encrypted) and
  `folders.wrapped_key` (its own name is sealed); the trash row keeps both of a document's; `versions.sealed` marks a version kept sealed.
- **What it checks:** an encrypted document's saves, names and versions must be sealed, a whole file with the document's own key (the key id
  in its header), and only its owner saves it; an ordinary document left in an encrypted folder (its folder's encryption cut short) takes
  no readable save, only `?encrypt=`; anything created in or moved into an encrypted
  folder must be encrypted (a document with its key; a folder with a sealed name and key). It never reads either.
- **Converting** a document is a save with `?encrypt=<wrappedKey>` (sealed bytes and name) or `?decrypt=1` (readable ones), and no
  checkpoint of what it replaces (that would keep a readable copy). Each kept version is then replaced in place, sealed or opened
  (`PUT /api/documents/:id/versions/:version`), which keeps its number and name; `sealed` says which are done, so an interrupted conversion
  is finished the next time the document is opened unlocked.
- **Converting** a folder is `PUT /api/folders/:id { encrypted }`; the browser then converts what is in it.
- **It refuses** for encrypted documents and folders: shares, public links, folder shares, rooms, the search index, thumbnails.
- **Sizes:** a whole file, or a file sent in chunks (where only the first chunk shows the envelope), must be the size of a sealed file
  (`isSealedSize`, ops): the header and tag around a padded file, so readable bytes added after a sealed start are refused.
- **Restoring a version** makes a document of its document's kind only: a version not converted yet (a conversion cut short) is refused,
  sealed one for an ordinary document, readable one for an encrypted one.

## The browser

- **Storage** (`storage/local.ts`): an encrypted document's copy here is the sealed file and name, as in the account; `getSaved` opens it
  (or throws `LockedError`), `getSaved(id, { sealed: true })` reads it as stored, to upload. A save into an encrypted folder makes the
  document's key. Its local history is kept sealed. No thumbnail, undo steps, search index or edit journal is kept for it.
- **The cloud client** sends every name of an encrypted document or folder sealed, and a new one's `wrappedKey`.
- **The library** (`encryption/present.ts`) shows names opened while unlocked, placeholders with a padlock while locked.
- **Trash:** documents deleted from a folder before it was encrypted stay readable in the trash until they are deleted for good. After
  encrypting a folder, the app lists them (`readableTrashIn`, from each trashed document's `folderId`) and offers to delete them for good
  (`offerToPurgeTrash`, `ui.ts`).
- **Conversion** (`encryption/convert.ts`): a document's file, name and every version, here and in the account; a folder's subfolders and
  documents, one at a time, with progress. Conversions run one at a time (`exclusive`). A folder's encryption cut short is finished while
  unlocked, a moment after the library lists it (`finishEncrypting`, from `main.ts`); until then, uploads of what is left readable in it wait
  in this browser (`sendToCloud`, `library.ts`).
- **Sealing checks, not shapes:** `sealFileWith` and `sealNameWith` keep something as it is only if it is sealed with that item's key and
  opens with it (while locked, if it names the key); a readable file starting `GDE1`, or a name starting `gde1.`, is sealed like any other.
- **A readable copy of a document encrypted elsewhere** that has changes of its own (another device, offline) is encrypted here with a key
  of its own and sent as an encrypted conflicted copy (`keepEncrypted`, `library.ts`); while locked it stays here, unsent.

## Status

**Step 1, built 2026-11-22** (branch `worktree-encrypted-folders`): everything above, signed in or not, except what follows.

- Code: `client/src/encryption/` (`crypto.ts`, `session.ts`, `present.ts`, `convert.ts`, `ui.ts`), `storage/local.ts`, `cloud.ts`,
  `library.ts`, `folderOps.ts`, the Files pane and File › Open; `server/src/sealed.ts`, `documents.ts`, `folders.ts`, `versions.ts`.
- Tests: `client/test/encryption.test.ts`, `client/test/encryptedFolders.test.ts`, `client/test/encryptionKeys.test.ts`, `client/test/vaultEncrypted.test.ts`, `client/test/vaultLocation.test.ts`, `server/test/encryption.test.ts`, `e2e/shell/vault-decrypt.spec.ts`,
  `e2e/collab/encrypted-folders.spec.ts`, `e2e/accessibility/encrypted-folders.spec.ts`.

**Not done yet:** large documents are sealed whole and then chunked, so every save sends every chunk (deterministic encrypted chunks
fix this); Version History and Trash show an encrypted document's sealed name and do not open its versions; the idle time is not in Options;
the faster autosave; search of unlocked documents in memory; changing the personal key; an interrupted decryption leaves sealed versions on
the account's copy until it is decrypted again (an interrupted encryption is finished when the document is next opened unlocked); links
between documents and live blocks are not rewritten inside encrypted documents. Whether a password manager offers to save the key from the
setup dialog's hidden field needs checking by hand.
