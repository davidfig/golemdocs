-- A view-only share's own address for the read-only viewer (/view/?s=<token>), so the document's id never shows there: random
-- (base64url, 192 bits), not derived from the document, the person or the time. It is null for an editor's share; changing the role
-- to editor or removing the share drops it, and sharing view-only again makes a new one. Shares from before this get theirs the
-- first time it is needed (`viewTokenFor` in src/sharing.ts): SQLite can't write base64url.
ALTER TABLE shares ADD COLUMN view_token TEXT;
CREATE UNIQUE INDEX shares_view_token ON shares (view_token) WHERE view_token IS NOT NULL;
