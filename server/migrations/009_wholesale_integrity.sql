-- V2.5: economic depth & market integrity.
--   * the Central Wholesale becomes a finite daily supplier
--   * each company has a hidden market-integrity score

-- One row per supply-limited product. Stock resets once per "wholesale day".
CREATE TABLE IF NOT EXISTS wholesale_supply (
  product     TEXT PRIMARY KEY,
  daily_stock INTEGER NOT NULL,
  remaining   INTEGER NOT NULL,
  base_price  INTEGER NOT NULL,
  reset_at    TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hidden per-company economic-trust record. NEVER exposed publicly except as a
-- vague warning flag while a confirmed violation is active.
CREATE TABLE IF NOT EXISTS company_integrity (
  company_id      INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  score           INTEGER NOT NULL DEFAULT 100,     -- 0..100, hidden
  state           TEXT NOT NULL DEFAULT 'normal',   -- normal|watchlist|investigating|confirmed
  suspicion_today INTEGER NOT NULL DEFAULT 0,
  flagged_days    INTEGER NOT NULL DEFAULT 0,
  violation_until TIMESTAMPTZ,                        -- public warning expiry
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
