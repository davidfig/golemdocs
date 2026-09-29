-- Admins mark feedback resolved; null until they do.
ALTER TABLE feedback ADD COLUMN resolved_at INTEGER;
