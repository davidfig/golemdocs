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

## Decisions

- **Encrypt what you have.** A document's menu has Encrypt… (Decrypt… once it is); so has a folder's. There is no special kind of folder to
  make. The File menu has the same for the open document, and Unlock… and Lock for the session.
- **Encrypting a folder** encrypts everything in it, subfolders included: their files, their names and their history. Anything saved,
  imported or moved into it afterwards is encrypted on the way in. The folder's own name stays readable.
- **Encrypting a document** seals its file and name, and reseals every version its history keeps, here and in the account, so no readable
  copy is left in either. Copies made before (downloads, the desktop vault, other devices) are not reached: the person is told.
- **Decrypting** does the same the other way, after asking: the server can read the document again.
- **The key is random and the person keeps it.** A 256-bit **personal key**, generated in the browser, shown once to save in a password
  manager. The server never has it, so there is no passphrase to guess offline. It is never stored on a device either: it is pasted in to
  unlock, held in memory, and gone when the session ends. One key opens everything the person encrypted.
- **Each item carries its own key.** Every encrypted document, and every folder whose name is sealed, has a random **item key**, kept
  wrapped (AES-KW) by the personal key next to it: on the server for an account's, in IndexedDB for a guest's. Items move freely, between
  folders and into the account at sign-in, with nothing to convert. Changing the personal key rewraps item keys and re-encrypts nothing.
- **Lost key, lost documents.** No recovery and no reset. Setup does not finish until the key has been pasted back.
- **Locked until unlocked.** A locked encrypted document shows in its folder as "Encrypted document" with a padlock, a subfolder of an
  encrypted folder as "Encrypted folder"; opening either asks for the key. Unlocking opens everything that key encrypted.
- **Unlocked only for the session.** A session ends when the page reloads, the tab closes or the app quits; on Lock; after 15 minutes with
  nothing done (to be set in Options). Locking saves the open encrypted document, closes it, and forgets every decrypted thing.
- **Signed in or not**, the same.
- **Never shared, never in a room, never in the vault.** An encrypted document or folder cannot be shared or have a public link, and a share
  of an ordinary folder does not reach the encrypted ones in it. It never joins a room (two of the person's own devices editing it at once
  merge as offline edits do). It is left out of the desktop vault, whose guide for agents says so: a file the vault had for a document
  encrypted since is removed (an edit made to it there is saved into the document first, sealed), and a note, `<name> (encrypted).md`,
  stands in for each encrypted folder.
- **WebCrypto only.** No dependency.

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
- **What it checks:** an encrypted document's saves, names and versions must be sealed; anything created in or moved into an encrypted
  folder must be encrypted (a document with its key; a folder with a sealed name and key). It never reads either.
- **Converting** a document is a save with `?encrypt=<wrappedKey>` (sealed bytes and name) or `?decrypt=1` (readable ones), and no
  checkpoint of what it replaces (that would keep a readable copy). Each kept version is then replaced in place, sealed or opened
  (`PUT /api/documents/:id/versions/:version`), which keeps its number and name; `sealed` says which are done, so an interrupted conversion
  is finished the next time the document is opened unlocked.
- **Converting** a folder is `PUT /api/folders/:id { encrypted }`; the browser then converts what is in it.
- **It refuses** for encrypted documents and folders: shares, public links, folder shares, rooms, the search index, thumbnails.

## The browser

- **Storage** (`storage/local.ts`): an encrypted document's copy here is the sealed file and name, as in the account; `getSaved` opens it
  (or throws `LockedError`), `getSaved(id, { sealed: true })` reads it as stored, to upload. A save into an encrypted folder makes the
  document's key. Its local history is kept sealed. No thumbnail, undo steps, search index or edit journal is kept for it.
- **The cloud client** sends every name of an encrypted document or folder sealed, and a new one's `wrappedKey`.
- **The library** (`encryption/present.ts`) shows names opened while unlocked, placeholders with a padlock while locked.
- **Conversion** (`encryption/convert.ts`): a document's file, name and every version, here and in the account; a folder's subfolders and
  documents, one at a time, with progress.

## Status

**Step 1, built 2026-11-22** (branch `worktree-encrypted-folders`): everything above, signed in or not, except what follows.

- Code: `client/src/encryption/` (`crypto.ts`, `session.ts`, `present.ts`, `convert.ts`, `ui.ts`), `storage/local.ts`, `cloud.ts`,
  `library.ts`, `folderOps.ts`, the Files pane and File › Open; `server/src/sealed.ts`, `documents.ts`, `folders.ts`, `versions.ts`.
- Tests: `client/test/encryption.test.ts`, `client/test/encryptedFolders.test.ts`, `client/test/vaultEncrypted.test.ts`, `server/test/encryption.test.ts`,
  `e2e/collab/encrypted-folders.spec.ts`, `e2e/accessibility/encrypted-folders.spec.ts`.

**Next, agreed in outline:** working on an encrypted folder with ai on this computer: a per-folder, per-session choice to decrypt it into
the vault (desktop only, refused when the vault is in a synced folder such as iCloud Drive or Dropbox), edits sealed before they reach the
account, the decrypted files removed on Lock, idle, quit and after a crash.

**Not done yet:** large documents are sealed whole and then chunked, so every save sends every chunk (deterministic encrypted chunks
fix this); Version History and Trash show an encrypted document's sealed name and do not open its versions; the idle time is not in Options;
the faster autosave; search of unlocked documents in memory; changing the personal key; an interrupted decryption leaves sealed versions on
the account's copy until it is decrypted again (an interrupted encryption is finished when the document is next opened unlocked); links
between documents and live blocks are not rewritten inside encrypted documents. Whether a password manager offers to save the key from the
setup dialog's hidden field needs checking by hand.
