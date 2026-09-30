-- Each user's paid sync subscription, kept current by Polar's webhooks (see src/subscriptions.ts).
CREATE TABLE subscriptions (
  user_id             TEXT PRIMARY KEY,   -- our user id, sent to Polar as the customer's external id at checkout
  polar_id            TEXT NOT NULL,      -- Polar's subscription id
  status              TEXT NOT NULL,      -- Polar's status: active, trialing, past_due, canceled, unpaid, incomplete, …
  current_period_end  INTEGER,            -- ms; when the paid period runs out
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  modified_at         INTEGER NOT NULL,   -- ms; Polar's own timestamp, so a late older event can't undo a newer one
  updated_at          INTEGER NOT NULL
);
CREATE INDEX subscriptions_polar ON subscriptions (polar_id);
