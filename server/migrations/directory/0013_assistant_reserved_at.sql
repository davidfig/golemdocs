-- When a hold on the assistant budget was last taken (ms). A request that never settled (its server
-- stopped part way) would otherwise keep its hold for the rest of the month; one older than any
-- request lasts is let go by the next.
ALTER TABLE assistant_usage ADD COLUMN reserved_at INTEGER NOT NULL DEFAULT 0;
