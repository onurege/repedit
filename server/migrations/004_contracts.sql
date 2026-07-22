-- Phase 3: recurring player-to-player supply contracts.
CREATE TABLE IF NOT EXISTS contracts (
  id                  SERIAL PRIMARY KEY,
  buyer_player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  seller_player_id    INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  buyer_business_id   INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  seller_business_id  INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product             TEXT NOT NULL,
  quantity            INTEGER NOT NULL CHECK (quantity > 0),
  unit_price          INTEGER NOT NULL CHECK (unit_price > 0),
  frequency_secs      INTEGER NOT NULL,
  total_deliveries    INTEGER NOT NULL CHECK (total_deliveries > 0),
  remaining_deliveries INTEGER NOT NULL CHECK (remaining_deliveries >= 0),
  status              TEXT NOT NULL DEFAULT 'proposed'
                        CHECK (status IN ('proposed','active','completed','rejected','cancelled')),
  last_result         TEXT,
  next_execution_at   TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contracts_active ON contracts(status, next_execution_at)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_contracts_buyer ON contracts(buyer_player_id);
CREATE INDEX IF NOT EXISTS idx_contracts_seller ON contracts(seller_player_id);
