-- V2.7 Phase 1 — City Chat, moderation, and the admin audit-log foundation.

-- Real-time shared city chat. Author identity is denormalised so a message
-- still renders correctly after the player is deleted (FK SET NULL).
CREATE TABLE IF NOT EXISTS city_chat_messages (
  id           BIGSERIAL PRIMARY KEY,
  player_id    INTEGER REFERENCES players(id) ON DELETE SET NULL,
  author_name  TEXT NOT NULL,
  company_name TEXT,
  kind         TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'system')),
  body         TEXT NOT NULL,
  deleted      BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_recent ON city_chat_messages(created_at DESC) WHERE NOT deleted;

-- Chat mutes (moderation). NULL muted_until = indefinite.
CREATE TABLE IF NOT EXISTS player_mutes (
  player_id    INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  muted_until  TIMESTAMPTZ,
  reason       TEXT,
  muted_by     INTEGER REFERENCES players(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Player reports on chat messages. One report per (message, reporter) — a
-- spam guard enforced by the unique constraint.
CREATE TABLE IF NOT EXISTS chat_reports (
  id          BIGSERIAL PRIMARY KEY,
  message_id  BIGINT REFERENCES city_chat_messages(id) ON DELETE CASCADE,
  reporter_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  reason      TEXT NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_id, reporter_id)
);

-- Append-only audit log for EVERY consequential admin action (reused by all
-- later V2.7 admin features). Never stores secrets. Not editable by admins.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  admin_id    INTEGER REFERENCES players(id) ON DELETE SET NULL,
  admin_name  TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_recent ON admin_audit_log(created_at DESC);
