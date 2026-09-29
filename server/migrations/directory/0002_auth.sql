-- Sign-in: which provider accounts belong to which user, and who is signed in where.
CREATE TABLE identities (
  provider       TEXT NOT NULL,      -- google | microsoft | github | apple
  subject        TEXT NOT NULL,      -- the provider's stable id for the person
  user_id        TEXT NOT NULL,      -- our user (one user can have several identities)
  email          TEXT,               -- lowercased
  email_verified INTEGER NOT NULL DEFAULT 0,
  name           TEXT,
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_user ON identities (user_id);
-- Only verified emails may link a new provider to an existing user.
CREATE INDEX identities_verified_email ON identities (email) WHERE email_verified = 1;

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,       -- SHA-256 of the cookie token; the token itself is never stored
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expires ON sessions (expires_at);
