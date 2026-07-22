-- Phase 2: Bakery + Mini Market business types, farm production choice,
-- second retail price (mini market milk).

ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_type_check;
ALTER TABLE businesses ADD CONSTRAINT businesses_type_check
  CHECK (type IN ('farm', 'coffee_shop', 'bakery', 'mini_market'));

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS production TEXT NOT NULL DEFAULT 'milk';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS price2 INTEGER NOT NULL DEFAULT 18;
