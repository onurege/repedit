-- V2.6.1 — custom business names.
-- Each business may have a player-chosen display name. NULL keeps the default
-- "<owner>'s <Type>" label, so existing businesses are unaffected.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS name TEXT;
