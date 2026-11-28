-- WhatsApp-style alerts: a feed of app events, each user's read mark and muted kinds,
-- and the phones / PCs that asked for pop-up (push) notifications.
CREATE TABLE notifications (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  module TEXT NOT NULL,          -- who sees it: users whose role can view this module
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  actor_id INTEGER,              -- the user who did it (not told about their own action)
  user_id INTEGER                -- set: only this user sees it (e.g. a test)
);
CREATE INDEX notifications_module_idx ON notifications (module, id DESC);

CREATE TABLE push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT UNIQUE NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  device TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN notif_seen_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN notif_off TEXT NOT NULL DEFAULT '';
