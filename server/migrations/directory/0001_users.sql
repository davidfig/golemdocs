-- Which per-user D1 database belongs to which user.
CREATE TABLE users (
  user_id        TEXT PRIMARY KEY,   -- stable hash of the authenticated identity (see src/auth.ts)
  database_id    TEXT NOT NULL,      -- the user's D1 database uuid
  schema_version INTEGER NOT NULL,   -- how many USER_MIGRATIONS have been applied to that database
  created_at     INTEGER NOT NULL
);
