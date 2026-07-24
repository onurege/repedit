-- V2.7 Phase 2 — Admin & Live Ops. Account suspension for moderation.
ALTER TABLE players ADD COLUMN IF NOT EXISTS suspended BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE players ADD COLUMN IF NOT EXISTS suspended_reason TEXT;
