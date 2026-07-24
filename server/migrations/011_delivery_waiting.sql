-- V2.6.2 — storage capacity invariant.
-- A delivery that cannot fit into its destination's storage on arrival enters
-- a WAITING state instead of overflowing inventory. Goods stay with the
-- delivery (money already settled) until enough room frees up.
ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_status_check;
ALTER TABLE deliveries ADD CONSTRAINT deliveries_status_check
  CHECK (status IN ('in_transit', 'waiting', 'delivered'));

-- Waiting deliveries are active (must be reloaded and retried), like in_transit.
CREATE INDEX IF NOT EXISTS idx_deliveries_active
  ON deliveries(status) WHERE status IN ('in_transit', 'waiting');
