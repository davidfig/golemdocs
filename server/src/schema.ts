// Schema of each user's own D1 database. Append a new entry to change it; never edit an old one.
// Databases are migrated when provisioned and, if behind, on the user's next request.

export const USER_MIGRATIONS: string[][] = [
  // 1: documents (the bytes live in R2 at r2_key; this is the catalogue).
  [
    `CREATE TABLE documents (
       id         TEXT PRIMARY KEY,
       name       TEXT NOT NULL,
       size       INTEGER NOT NULL,
       r2_key     TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE INDEX documents_updated ON documents (updated_at DESC)`,
  ],
  // 2: a thumbnail of the first page, rendered by the client that saved the document (the bytes
  // live in R2 at `<r2_key minus .docx>.thumb`). thumb_at is null until one has been uploaded.
  [`ALTER TABLE documents ADD COLUMN thumb_at INTEGER`],
  // 3: folders, nested through parent_id (null: the top level), and the folder a document is in
  // (folder_id, null: the top level). Only the owner's own arrangement; a shared document sits
  // outside it for the people it is shared with.
  [
    `CREATE TABLE folders (
       id         TEXT PRIMARY KEY,
       name       TEXT NOT NULL,
       parent_id  TEXT,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    `ALTER TABLE documents ADD COLUMN folder_id TEXT`,
  ],
  // 4: the person's interface settings, kept per profile ('desktop' or 'mobile': a phone wants its own),
  // one row per setting. A null value is a setting put back to its default. updated_at is the server's clock.
  [
    `CREATE TABLE preferences (
       profile    TEXT NOT NULL,
       key        TEXT NOT NULL,
       value      TEXT,
       updated_at INTEGER NOT NULL,
       PRIMARY KEY (profile, key)
     )`,
  ],
  // 5: history. A version is a document's file as it was before a save replaced it (`version` is that file's `updated_at`, which
  // is also its identity), kept in R2 at `<owner>/<doc>.history/<version>`; `name` is set when the person saved it on purpose.
  // `chunked` marks a version kept as a manifest of the document's chunks. The trash holds a deleted document's catalogue row
  // (its files stay in R2 until `deleted_at` is 30 days old or it is deleted for good).
  [
    `CREATE TABLE versions (
       doc_id     TEXT NOT NULL,
       version    INTEGER NOT NULL,
       size       INTEGER NOT NULL,
       name       TEXT,
       chunked    INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (doc_id, version)
     )`,
    `CREATE TABLE trash (
       id         TEXT PRIMARY KEY,
       name       TEXT NOT NULL,
       size       INTEGER NOT NULL,
       r2_key     TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL,
       thumb_at   INTEGER,
       folder_id  TEXT,
       deleted_at INTEGER NOT NULL
     )`,
  ],
  // 6: where the person is in each book they read (an EPUB), so every device opens it there. `book` is the hash of the book's
  // text (the same book on every device), `place` what the client keeps (see client/src/reading.ts), `read_at` when it was read
  // there (the server's clock; a device says how long ago it read): the latest reading wins.
  [
    `CREATE TABLE reading_places (
       book       TEXT PRIMARY KEY,
       place      TEXT NOT NULL,
       read_at    INTEGER NOT NULL
     )`,
  ],
  // 7: scheduled script runs (docs/live-blocks.md §8, *Triggers*). Each run has an id (the script's path and when it is due),
  // and the first device to claim it runs it; `done_at` once it has. A claim not done within a while is given to another
  // device. The server keeps claims only, never the script.
  [
    `CREATE TABLE script_claims (
       run_id     TEXT PRIMARY KEY,
       device     TEXT NOT NULL,
       claimed_at INTEGER NOT NULL,
       done_at    INTEGER
     )`,
  ],
  // 8: how far the person's devices have kept live blocks up to date (docs/live-blocks.md §6, *Updates in the background*).
  // One row: `worked_to` is the server time up to which every changed source's dependents were updated, by whichever device;
  // `deferred` (JSON, document ids) are dependents a device left because they were too large for it.
  [
    `CREATE TABLE live_marker (
       id         INTEGER PRIMARY KEY CHECK (id = 1),
       worked_to  INTEGER NOT NULL,
       deferred   TEXT NOT NULL DEFAULT '[]'
     )`,
  ],
];
