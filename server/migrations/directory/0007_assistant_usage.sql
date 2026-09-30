-- What each user has spent on the assistant (see src/assistant.ts), per calendar month (UTC).
-- Money is in micro-dollars (millionths of a dollar). `reserved` is held while a request is running.
CREATE TABLE assistant_usage (
  user_id         TEXT NOT NULL,
  period          TEXT NOT NULL,                 -- 'YYYY-MM'
  spent_micro     INTEGER NOT NULL DEFAULT 0,
  reserved_micro  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period)
);
