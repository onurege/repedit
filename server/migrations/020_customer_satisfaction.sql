-- V2.8.2 — Customer Satisfaction (business-level NPC service quality, 0–100).
--
-- Additive, idempotent, state-preserving. A NEW column distinct from the B2B
-- `reputation` (which is untouched). Existing businesses initialize to the
-- neutral start of 70. Driven only by committed NPC retail outcomes; it modifies
-- only the Business XP earned from NPC sales.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS customer_satisfaction DOUBLE PRECISION NOT NULL DEFAULT 70;
