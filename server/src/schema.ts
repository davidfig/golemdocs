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
];
