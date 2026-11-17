-- Folder sharing (docs/folder-sharing.md). A folder lives in its owner's own database, so the directory keeps who it is shared with
-- and its public link, with the owner beside the folder's id (folders have no document_owners row). A share covers whatever is in
-- the folder and its subfolders when a request is made: nothing is listed or copied when it is made.
--
-- folder_shares: one row per person. A view-only share has its own random address for the viewer (view_token, as shares.view_token).
-- local_name is the label the person's vault copy was given the first time one of their computers copied it (Shared/<owner>/<folder>),
-- kept so every computer of theirs finds it there again, whatever the owner is called now.
CREATE TABLE folder_shares (
  folder_id  TEXT NOT NULL,
  owner_id   TEXT NOT NULL,
  grantee_id TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  created_at INTEGER NOT NULL,
  view_token TEXT UNIQUE,
  local_name TEXT,
  PRIMARY KEY (owner_id, folder_id, grantee_id)
);
CREATE INDEX folder_shares_grantee ON folder_shares (grantee_id, owner_id);

-- A folder's public link: one random address that opens the folder read-only for anyone, signed in or not. At most one per folder.
CREATE TABLE folder_links (
  owner_id   TEXT NOT NULL,
  folder_id  TEXT NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, folder_id)
);
