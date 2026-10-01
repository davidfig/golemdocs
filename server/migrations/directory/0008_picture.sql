-- The profile picture a provider gave at sign-in (an https URL on the provider's own host), shown beside the person's name.
ALTER TABLE identities ADD COLUMN picture TEXT;
