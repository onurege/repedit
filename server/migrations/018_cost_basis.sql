-- V2.8 Phase 3 — inventory cost basis (weighted-average acquisition cost).
--
-- Additive & idempotent. Enables gameplay profitability estimates: finished
-- goods inherit their ingredients' real acquisition cost, so a player who
-- sourced cheaply via a contract sees a better margin than one who paid the
-- Central Wholesale premium. Existing rows default to 0 ("cost unknown"), which
-- the UI renders as "cost unavailable" rather than a fake number.

-- Weighted-average $/unit for on-hand stock of a product at a business.
ALTER TABLE inventories   ADD COLUMN IF NOT EXISTS cost_basis DOUBLE PRECISION NOT NULL DEFAULT 0;

-- The committed ingredient cost captured at production start, applied to the
-- finished output's cost basis at completion (survives rebalancing).
ALTER TABLE production_jobs ADD COLUMN IF NOT EXISTS input_cost DOUBLE PRECISION NOT NULL DEFAULT 0;

-- The per-unit acquisition price a delivery carries, so unloading updates the
-- destination's weighted-average cost basis with the REAL price paid.
ALTER TABLE deliveries    ADD COLUMN IF NOT EXISTS unit_cost DOUBLE PRECISION NOT NULL DEFAULT 0;
