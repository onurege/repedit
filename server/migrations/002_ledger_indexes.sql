-- Phase 1.5 hardening: append-only economic ledger + missing indexes.

-- business_id intentionally has NO foreign key: audit rows must survive
-- business resets/deletions.
CREATE TABLE IF NOT EXISTS economic_ledger (
  id             BIGSERIAL PRIMARY KEY,
  player_id      INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  business_id    INTEGER,
  transaction_type TEXT NOT NULL,
  amount         INTEGER NOT NULL,          -- positive = credit to player cash
  reference_type TEXT,
  reference_id   INTEGER,
  balance_before INTEGER NOT NULL,
  balance_after  INTEGER NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_player_time ON economic_ledger(player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_order ON trades(order_id);
CREATE INDEX IF NOT EXISTS idx_trades_buyer ON trades(buyer_id);
CREATE INDEX IF NOT EXISTS idx_trades_seller ON trades(seller_id);
