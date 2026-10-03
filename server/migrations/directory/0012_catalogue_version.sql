-- The cached lists are told apart from stale ones by a count of changes, not by the time: the time
-- comes from whichever server handled the request, and their clocks needn't agree. The row with
-- kind '' holds the user's database's change count; a list holds the count it was read at.
ALTER TABLE catalogue_cache ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
