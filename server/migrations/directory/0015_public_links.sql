-- A document's public link: one random address (base64url, 192 bits) that opens the document read-only for anyone, signed in or
-- not, in the viewer (/view/?p=<token>) or embedded in another site (/embed/?p=<token>). At most one per document. Turning the link
-- off deletes the row; resetting it gives the row a new token, so copies of the old link stop working.
CREATE TABLE public_links (
  doc_id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
