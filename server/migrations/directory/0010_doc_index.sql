-- (Safe to apply twice: it was first applied to the dev database as 0009_doc_index.sql, before 0009 was taken.)
-- Which documents the assistant's search index (Vectorize, see src/search.ts) holds, and as of which
-- version: a document is indexed again when its `updated_at` no longer matches. `chunks` is how many
-- vectors it has there (ids `<doc_id>:0` to `<doc_id>:<chunks - 1>`), so they can be removed.
CREATE TABLE IF NOT EXISTS doc_index (
  doc_id     TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  updated_at INTEGER NOT NULL,   -- the document's updated_at when it was indexed
  chunks     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS doc_index_owner ON doc_index (owner_id);
