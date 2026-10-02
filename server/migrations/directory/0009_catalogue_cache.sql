-- A copy of each user's document and folder lists, so listing them reads this (native, fast) database
-- instead of making a round trip to the user's own database through Cloudflare's REST API.
-- `cached_at` is when the lists were read. The row with kind '' only records when the user's
-- database last changed; a list is current only if it was read after that.
CREATE TABLE IF NOT EXISTS catalogue_cache (
  db_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  json TEXT NOT NULL,
  cached_at INTEGER NOT NULL,
  PRIMARY KEY (db_key, kind)
);
