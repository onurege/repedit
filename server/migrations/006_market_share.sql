-- V2.2: city-wide competition — append-only competitive activity log.
--
-- Records ONLY competitively-relevant, already-committed economic events so
-- market share and supplier rankings can be computed from recent activity
-- without scanning the whole ledger. Revenue / net cash flow / growth are
-- derived from the existing economic_ledger; this table adds the per-product
-- UNIT flows the ledger does not carry.
--
-- kinds:
--   final_sale    -- units sold to NPC END customers (retail): market share
--   supplier_sale -- units sold to ANOTHER company via marketplace/contract:
--                    supplier rankings (external, player-to-player only)
--
-- No foreign key on business_id (audit rows must survive business resets).
-- company_id cascades: if a company is deleted its competitive history goes too.

CREATE TABLE IF NOT EXISTS company_activity (
  id           BIGSERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  business_id  INTEGER,
  kind         TEXT NOT NULL,          -- 'final_sale' | 'supplier_sale'
  product      TEXT NOT NULL,
  units        INTEGER NOT NULL,
  amount       INTEGER NOT NULL,       -- gross money for the event (info)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rolling-window rankings filter by time first, then group by company/product.
CREATE INDEX IF NOT EXISTS idx_activity_time ON company_activity(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_kind_product_time ON company_activity(kind, product, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_company_time ON company_activity(company_id, created_at);
