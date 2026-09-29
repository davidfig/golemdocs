-- Sharing. Documents live in their owner's own database and bucket path, so anything that has to
-- find a document without knowing whose it is (a shared link, a collaboration room) starts here.
CREATE TABLE document_owners (
  doc_id     TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE shares (
  doc_id     TEXT NOT NULL,
  grantee_id TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (doc_id, grantee_id)
);
CREATE INDEX shares_grantee ON shares (grantee_id);
