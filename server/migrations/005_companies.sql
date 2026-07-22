-- V2.1: Company foundation + multiple businesses per company.

CREATE TABLE IF NOT EXISTS companies (
  id          SERIAL PRIMARY KEY,
  player_id   INTEGER UNIQUE NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  level       INTEGER NOT NULL DEFAULT 1,
  xp          INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A player may now own more than one business: drop the one-per-player rule
-- and attach businesses to a company.
ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_player_id_key;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE;

-- Market orders reserve goods in a SPECIFIC business (was implicitly "the"
-- player's single business).
ALTER TABLE market_orders ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE;

-- Safe migration of existing players: one company each, keep everything.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id, username FROM players LOOP
    INSERT INTO companies (player_id, name)
    VALUES (r.id, r.username || ' Co.')
    ON CONFLICT (player_id) DO NOTHING;
  END LOOP;
  UPDATE businesses b SET company_id = c.id
    FROM companies c WHERE c.player_id = b.player_id AND b.company_id IS NULL;
  UPDATE market_orders o SET business_id = b.id
    FROM businesses b WHERE b.player_id = o.player_id AND o.business_id IS NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_businesses_company ON businesses(company_id);
CREATE INDEX IF NOT EXISTS idx_orders_business ON market_orders(business_id);
