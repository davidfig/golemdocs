-- Feedback people send from Help > Send Feedback, read by admins.
CREATE TABLE feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  message    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX feedback_created ON feedback (created_at DESC);
