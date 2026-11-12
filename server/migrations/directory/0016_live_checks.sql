-- How often a document's live blocks were out of date when it was opened (docs/live-blocks.md §6): whether updating them on
-- the server is worth building. Totals for each day (UTC) only: nothing says who opened what.
CREATE TABLE live_checks (
  day TEXT PRIMARY KEY,
  opened INTEGER NOT NULL DEFAULT 0,
  stale INTEGER NOT NULL DEFAULT 0
);
