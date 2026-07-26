-- V2.8 Phase 2 — manual production jobs.
--
-- Additive & idempotent. No existing player state (inventory, cash, businesses,
-- licenses, active products, XP, levels) is touched. Production-capable
-- businesses gain a persistent, per-business production line; the automatic
-- tick production of recipe goods (coffee/bread) is retired in code so there is
-- exactly one authoritative production path. Raw farm output (milk/wheat) and
-- NPC retail sales remain automatic.
--
-- A job carries a RECIPE SNAPSHOT and its committed INPUTS so it can always be
-- completed exactly as planned, even after recipe/balance changes.

CREATE TABLE IF NOT EXISTS production_jobs (
  id           BIGSERIAL PRIMARY KEY,
  business_id  INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product      TEXT    NOT NULL,
  output_qty   INTEGER NOT NULL CHECK (output_qty > 0),
  batches      INTEGER NOT NULL CHECK (batches > 0),
  recipe       JSONB   NOT NULL,            -- { output, outputQty, inputs:[{product,qty}] }
  inputs       JSONB   NOT NULL,            -- committed ingredients: [{product,qty}]
  status       TEXT    NOT NULL DEFAULT 'queued', -- queued|producing|completed|waiting_storage
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  completes_at TIMESTAMPTZ
);

-- Live jobs are loaded per business on boot and resolved by wall-clock time.
CREATE INDEX IF NOT EXISTS idx_prod_jobs_live
  ON production_jobs (business_id, id)
  WHERE status IN ('queued', 'producing', 'waiting_storage');
