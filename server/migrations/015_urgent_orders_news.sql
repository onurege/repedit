-- V2.7 Phase 4 — Urgent City Orders, Rival Alerts & City News.

-- A short-lived city procurement opportunity. EXACTLY ONE company can win it:
-- fulfilment flips status active->fulfilled under a `WHERE status='active'`
-- guard, so a concurrent second claim finds zero rows and is rejected.
CREATE TABLE IF NOT EXISTS urgent_orders (
  id                BIGSERIAL PRIMARY KEY,
  kind              TEXT NOT NULL,                 -- locale-independent flavour code
  product           TEXT NOT NULL,
  required_quantity INTEGER NOT NULL CHECK (required_quantity > 0),
  reward            BIGINT NOT NULL CHECK (reward >= 0),
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('upcoming','active','fulfilled','expired','cancelled')),
  starts_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  winner_player_id  INTEGER REFERENCES players(id) ON DELETE SET NULL,
  winner_company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  fulfilled_at      TIMESTAMPTZ,
  source            TEXT NOT NULL DEFAULT 'auto',  -- 'auto' | 'admin'
  created_by        INTEGER REFERENCES players(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Live orders are swept and listed constantly; index the hot path.
CREATE INDEX IF NOT EXISTS idx_urgent_status ON urgent_orders(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_urgent_created ON urgent_orders(created_at DESC);

-- Bounded, append-only city-news feed generated from real committed events.
-- Payload is privacy-safe: actor is a PUBLIC name, params never carry secrets.
CREATE TABLE IF NOT EXISTS city_news (
  id          BIGSERIAL PRIMARY KEY,
  type        TEXT NOT NULL,
  actor_name  TEXT,
  product     TEXT,
  params      JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key  TEXT,                                -- optional idempotency handle
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_city_news_time ON city_news(created_at DESC);
-- Leader-change / wholesale-low events are deduped by key within a short window.
CREATE INDEX IF NOT EXISTS idx_city_news_dedupe ON city_news(dedupe_key, created_at DESC);
