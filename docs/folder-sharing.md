# Folder sharing

Plan, agreed 2026-11-17. Not built yet.

Sharing a whole folder, the way a single document is shared today (File › Share; see [Server](architecture/server.md#sharing) and [Embeddable viewer](architecture/viewer.md)), so that the folder's tree can be browsed and the links between its files work. It works for people with an account (shared by email, as viewer or editor) and without one (a public link, view only).

## Decisions

- **The folder, live.** A share covers whatever is in the folder and its subfolders at the time of the request. A file added later is shared; a file moved out or deleted is not. Nothing is copied or listed when the share is made.
- **Who may share:** the owner, while they have sync, from the web or the desktop app. Folders are already the account's (the vault mirrors them, `mirrorFolders` in `client/src/desktop/vaultSync.ts`), so no desktop app is needed. A folder share lasts only while the owner has sync, like a document share.
- **Roles:**
  - **Can view:** reads every file in the tree. Opens in the viewer.
  - **Can edit:** edits every file in the tree, and adds files and subfolders inside it. May rename or delete only what they added themselves. May not move anything, rename or delete the owner's files or folders, or share. Opens in the app.
  - **Owner:** everything, as today.
  This follows the document tools (Notion's *Can edit content*, Google shared drives' *Contributor*, Confluence's delete-own), which separate editing content from changing structure: renames break other people's links and bookmarks, and moves change what is shared. A *Can manage* role (move, delete anything) can be added later if asked for; taking rights away is harder than adding them.
- **Editors need an account but not sync.** The owner's subscription covers the folder. A free account is enough.
- **Public link: view only.** One per folder, like `public_links`. Editing always needs a signed-in person: rooms, history and the trash all need a known person, and anonymous editing invites vandalism with no names in the history.
- **Files the editor adds belong to the owner** and count against the owner's storage. What they delete goes to the owner's trash.
- **Links stop at the folder.** A `doc:` link (`[[wikilink]]`) or embed in a shared file resolves only against the files in the shared tree, for every role. A link to anything outside it is shown as not shared and does nothing, even if that file is shared some other way. A missing file and an unshared one look the same, so nothing about the rest of the owner's library leaks.
- **noindex.** Public folder pages send `X-Robots-Tag: noindex` and a `<meta name="robots" content="noindex">`. An opt-in to indexing (a folder published as a wiki) can come later.

## Server

**Tables** (directory database, new migration):

- `folder_shares (folder_id, owner_id, grantee_id, role, created_at, view_token)`: one row per person, as `shares`.
- `folder_links (folder_id, owner_id, token, created_at)`: the public link, as `public_links`.

The folder id is the owner's (folders live in the owner's database); `owner_id` is stored because, unlike documents, folders have no `document_owners` row.

**One access check.** `accessFor` in `sharing.ts` stays the single place that decides, for the API and rooms alike. After the direct share it looks for a folder share of the user's from this document's owner and, only if one exists, asks the owner's database for the document's folder ancestry (a recursive query on `folders.parent_id`) to see whether a shared folder is above it. The role is the best of the direct share and the folder shares. Because every route already goes through `accessFor`, saves, rooms, history, thumbnails and media work for folder editors without route changes.

**Structure rules for folder editors** (in `documents.ts` and `folders.ts`, each checked in `server/test/sharing.test.ts` route by route, as the viewer's are):

- Create a document or folder: allowed when its target folder is inside a folder they may edit. Stored in the owner's database, owned by the owner, with `created_by` recorded (a new column on documents and folders in the user database) so delete-own and rename-own can be checked.
- Rename, delete: only rows they created. Delete moves to the owner's trash.
- Move: refused. Changing `folder_id` or `parent_id` is owner only.
- Share, public links: owner only.

**Routes:**

- `/api/folders/:id/shares[/:userId]` and `/api/folders/:id/link` for the owner, as the document routes.
- `GET /api/shared` also lists folders shared with the user (`{ folderId, ownerId, ownerName, name, role, viewToken? }`).
- `GET /api/shared/folders/:id/tree` for a grantee: the tree under the shared folder (folders, and documents with their ids, names, dates, kinds). Editors need ids to open documents in the app.
- `GET /api/folder-view/:token` and `/api/folder-public/:token` for the viewer: the tree as paths relative to the shared folder, never document or folder ids; `…/file?path=<path>` for a file's bytes (304 for `If-None-Match`). The person's token needs that person's session, as `viewShare`; the public one needs none and sends `cache-control: public, max-age=60` and `noindex`. Unknown, dropped and other people's tokens all answer 404.

**Ending.** Unsharing, the folder being deleted (what was in it moves up, so it is no longer under the shared folder), the owner's sync ending and a file leaving the folder all end access the moment they happen, because access is checked on each request. Rooms of documents that lose a grantee kick them (`kickFromRoom`), as unsharing a document does. Deleting a folder calls a `forgetFolders` alongside `forgetDocuments`.

**Cost.** The folder check runs only for a user who has at least one folder share from that owner, so ordinary requests read the directory once, as now. Trees are capped (say 5,000 entries) and the tree answer is cached for a request.

## Viewer (Can view and public links)

The same page as today (`client/view/index.html`, `src/viewer/share.ts`) with a folder mode: `/view?f=<token>&path=Notes/Plan.md#Goals` for a person, `/view?F=<token>&path=…` for the public link. Paths are relative to the shared folder: readable, they match how wikilinks name files, and they show nothing above the shared folder. (A rename breaks a bookmark; the tree still finds the file.)

- **The tree:** a collapsible panel on the left, built from the tree answer. It is a listbox/tree with the ARIA tree pattern, reachable with F6 and the keyboard. See whether `ui/filesPanel.ts` can be shared without pulling much of the app into the viewer chunk; if not, a small tree in the viewer, and move both onto one later.
- **Links:** `onLink` resolves `doc:` addresses against the tree with the app's own resolver (`splitLink` / `findByTitle` in `formats/wikiLinks.ts`), the shared folder as the top level and the open file's folders as `from`. A hit opens in the same tab (history entry, path in the address); a miss is announced and shown as "This file isn't shared". Other links open in a new tab, as now.
- **Headings:** `#Section` scrolls to the heading. The viewer can't do this yet; it needs a `goTo(heading)` from the layout worker (the app already resolves headings for `golemdocs://` links).
- **Embeds:** an embed of a file in the tree is fetched through the folder routes; one outside it shows as not shared.
- **Refresh and ending:** the open file checks for a newer save as the document viewer does (30 s for a person, 2 min for the public link), and the tree is fetched again with it. A 404 or 403 on the tree destroys the viewer and says the folder is no longer shared.
- **Download** on the public link, per file, as today.

## App (Can edit)

- **Shared with me** lists shared folders with their owner's name. Opening one browses its tree like an own folder (`LibraryStore` gets the shared trees as a separate list; `Folder` entries carry the owner and role). Documents open through the existing path for shared documents (rooms, `uploadShared`).
- **Menus** for items in a shared folder show only what the role allows: New File and New Folder inside it; Rename and Delete only on what the person added; no Move. Hide the rest rather than disabling it, and tidy the dividers afterwards (the menu rules in the user's CLAUDE.md).
- **Links** in the app resolve the same way as in the viewer when the open document is in a folder shared with you: only the shared tree counts. Your own library is not searched from inside someone else's folder.
- **Share dialog** on a folder (folder's right-click menu and File › Share while in it): people with Can edit / Can view (`segmented`), and the public link with Copy Link. Owner only.
- **Leave** on a shared folder removes your share.

## Vault copies for the people it is shared with

A folder shared with someone is copied into their vault, under `Shared/<owner name>/<folder name>/`. Two owners with the same name get " (2)", as two documents with the same name already do.

- **The path is a label, chosen once.** The owner's name comes from their latest sign-in (`person()` in `sharing.ts`), so it can change with nothing done (Google one day, Apple the next). It is read only to choose the label the first time any of the recipient's computers copies the folder. From then on the label is fixed: it is kept in the account on the share row (`folder_shares.local_name`, the recipient's own), and each computer's sync memory maps the share (owner id, folder id) to it. Neither a new owner name nor the owner renaming the folder renames it on disk, which would rewrite every file under it (the shell has no rename) while agents work in them.
- **Finding it again.** In this order: the sync memory; else the label in the account (a new computer, or a lost memory); the current name only for a first copy. Inside the folder, files are followed by cloud id as everywhere in the vault.
- **Renamed on disk.** The recipient may rename `Shared/Alice/` or the folder under it: the sync matches the files by id, takes the new path as the share's label, and writes it to the account so their other computers follow.
- **No memory: the account wins.** Files are matched by path inside the labelled folder, as a first sync does, but a file that differs does not overwrite the owner's document: its contents are kept as a version in the document's history, and the account's copy is written to disk.
- **Unclaimed folders under `Shared/`.** Anything there that no share claims (left behind when a memory was lost and the folder renamed meanwhile) is never uploaded as new documents. The sync leaves it alone and says once that it is no longer linked to a shared folder.

- **Both ways, within the role.** Edits sync up. Files and folders created there sync up as new files owned by the owner. A delete, rename or move made on disk is applied only where the role allows it (their own additions); otherwise the sync puts the file back as it is in the account and says why in the sync's report. A delete on disk never deletes the owner's file.
- **Files added on disk.** An editor's new file or folder inside the shared folder is uploaded as if made with New File: the owner's document, in that folder, added by the editor (so they may later rename or delete it on disk). It is checked against the owner's sync and storage, not the editor's (the existing routes refuse a caller without sync, so the shared-folder path checks the owner); when the owner's storage is full the upload is refused, reported in the sync, and tried again later. A viewer's new file, and anything put in `Shared/` or `Shared/<owner>/` outside a shared folder, is never uploaded and never deleted: the sync leaves it and says once why it was not added.
- **Keep a copy in my vault** is a per-folder switch, on by default on the desktop. Turning it off removes the local copy only and keeps the share.
- **Leaving or losing the share removes the copy,** on every computer at its next sync, including local changes that were not yet synced: the documents are the owner's. Files that never reached the account (a viewer's additions, an editor's not yet uploaded, strays) are the person's own and are kept where they are; the sync says how many it kept.
- **Viewers** get a read-only copy (files marked read-only on disk where the platform allows); local changes are put back by the next sync.
- **Desktop shell:** this needs no new shell command if the existing vault commands can write under `Shared/`; check against the older-shell rule before adding any.

This is the largest piece and comes last.

## Order of work

1. Server: tables, `accessFor`, owner routes, the grantee tree, structure rules, tests.
2. Share dialog for folders; Shared with me lists folders; editing in the app.
3. Viewer folder mode: tree, link resolution, headings, embeds, public link with noindex.
4. Vault copies under `Shared/`.

Each step ships on its own, with e2e specs in `e2e/collab/` and `e2e/accessibility/`, a changelog line, and updates to [Server](architecture/server.md#sharing), [Embeddable viewer](architecture/viewer.md), [Collaboration](architecture/collaboration.md#sharing-permissions-and-rooms) and [Desktop app](architecture/desktop.md) as each lands.

## Open for later

- A *Can manage* role (move and delete anything in the folder).
- Indexable public folders.
- Activity in a shared folder (who added or changed what), which Dropbox and Drive show and which matters more once several people add files.
