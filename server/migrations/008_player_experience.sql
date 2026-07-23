-- V2.4: player experience & live-service foundation.
--   * per-player "What's New" tracking (see an update once)
--   * tutorial progress (resumable, skippable)
--   * admin-authored global announcements
--   * an admin flag on players

ALTER TABLE players ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

-- Which release-notes updates a player has already dismissed.
CREATE TABLE IF NOT EXISTS player_seen_updates (
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  update_id  TEXT NOT NULL,
  seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, update_id)
);

-- Guided onboarding progress. One row per player.
CREATE TABLE IF NOT EXISTS tutorial_progress (
  player_id       INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  current_step    INTEGER NOT NULL DEFAULT 0,
  completed_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  skipped         BOOLEAN NOT NULL DEFAULT false,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Admin-to-player broadcast messages (not chat).
CREATE TABLE IF NOT EXISTS announcements (
  id         SERIAL PRIMARY KEY,
  title      TEXT NOT NULL,
  message    TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'general',   -- general|update|event|maintenance|critical
  priority   TEXT NOT NULL DEFAULT 'normal',    -- normal|important|critical
  created_by INTEGER REFERENCES players(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  starts_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  is_active  BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_announcements_live ON announcements(is_active, starts_at, expires_at);
