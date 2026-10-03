-- Whether a user's documents from before sharing existed have been given owner rows (document_owners).
-- Listing documents did that on every cache miss, a directory write per document; now it is done once.
ALTER TABLE users ADD COLUMN owners_backfilled INTEGER NOT NULL DEFAULT 0;
