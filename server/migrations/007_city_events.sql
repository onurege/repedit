-- V2.3: dynamic city demand & city events.
--
-- A small, server-authoritative event log. Effective city demand is DERIVED
-- from the currently-active events each tick (never accumulated), so a restart
-- or a double tick can't corrupt demand. Effects are stored as additive deltas
-- per product, e.g. {"demand":{"bread":0.40,"coffee":0.50}} means +40% / +50%,
-- and {"wholesale":{"wheat":0.30}} means NPC wheat costs +30% while active.

CREATE TABLE IF NOT EXISTS city_events (
  id           SERIAL PRIMARY KEY,
  event_type   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'upcoming',  -- upcoming | active | ended
  effects      JSONB NOT NULL DEFAULT '{}'::jsonb,
  announced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  starts_at    TIMESTAMPTZ NOT NULL,
  ends_at      TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The tick only cares about events that are not yet ended.
CREATE INDEX IF NOT EXISTS idx_city_events_live ON city_events(status, starts_at, ends_at);
