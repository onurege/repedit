-- V2.8 Phase 1 — Product Economy foundation (additive; nothing is dropped).
-- Adds an XP-driven Business Level (1–50) alongside the untouched 1–3 facility
-- tier, plus per-business product licenses and active product slots.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS biz_xp BIGINT NOT NULL DEFAULT 0;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS biz_level INTEGER NOT NULL DEFAULT 1;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS last_slot_change TIMESTAMPTZ;

-- A license is a business's permanent right to sell a product. Capability
-- distinguishes manufacture ('produce', has a recipe) from resale ('retail').
CREATE TABLE IF NOT EXISTS business_licenses (
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product     TEXT NOT NULL,
  capability  TEXT NOT NULL CHECK (capability IN ('produce', 'retail')),
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, product)
);
CREATE INDEX IF NOT EXISTS idx_biz_licenses ON business_licenses(business_id);

-- Which licensed products currently occupy the business's active slots.
CREATE TABLE IF NOT EXISTS business_active_products (
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product     TEXT NOT NULL,
  PRIMARY KEY (business_id, product)
);
CREATE INDEX IF NOT EXISTS idx_biz_active ON business_active_products(business_id);
