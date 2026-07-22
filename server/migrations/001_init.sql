CREATE TABLE IF NOT EXISTS players (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  pass_hash     TEXT NOT NULL,
  cash          INTEGER NOT NULL DEFAULT 10000,
  xp            INTEGER NOT NULL DEFAULT 0,
  level         INTEGER NOT NULL DEFAULT 1,
  last_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
  away_snapshot JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS businesses (
  id             SERIAL PRIMARY KEY,
  player_id      INTEGER UNIQUE NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  type           TEXT NOT NULL CHECK (type IN ('farm', 'coffee_shop')),
  lot_id         TEXT UNIQUE NOT NULL,
  level          INTEGER NOT NULL DEFAULT 1,
  price          INTEGER NOT NULL DEFAULT 30,
  reputation     REAL NOT NULL DEFAULT 3.0,
  revenue        INTEGER NOT NULL DEFAULT 0,
  expenses       INTEGER NOT NULL DEFAULT 0,
  milk_produced  INTEGER NOT NULL DEFAULT 0,
  coffee_sold    INTEGER NOT NULL DEFAULT 0,
  customers      INTEGER NOT NULL DEFAULT 0,
  accums         JSONB NOT NULL DEFAULT '{}',
  sim_ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventories (
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product     TEXT NOT NULL,
  qty         INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  reserved    INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  PRIMARY KEY (business_id, product)
);

CREATE TABLE IF NOT EXISTS market_orders (
  id         SERIAL PRIMARY KEY,
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  side       TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  product    TEXT NOT NULL,
  qty        INTEGER NOT NULL CHECK (qty > 0),
  remaining  INTEGER NOT NULL CHECK (remaining >= 0),
  price      INTEGER NOT NULL CHECK (price > 0),
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filled', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trades (
  id         SERIAL PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES market_orders(id),
  buyer_id   INTEGER NOT NULL REFERENCES players(id),
  seller_id  INTEGER NOT NULL REFERENCES players(id),
  product    TEXT NOT NULL,
  qty        INTEGER NOT NULL CHECK (qty > 0),
  price      INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deliveries (
  id          SERIAL PRIMARY KEY,
  product     TEXT NOT NULL,
  qty         INTEGER NOT NULL CHECK (qty > 0),
  from_lot    TEXT NOT NULL,
  to_lot      TEXT NOT NULL,
  to_business INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'in_transit' CHECK (status IN ('in_transit', 'delivered')),
  depart_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  arrive_at   TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_open ON market_orders(status) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_deliveries_transit ON deliveries(status) WHERE status = 'in_transit';
CREATE INDEX IF NOT EXISTS idx_trades_created ON trades(created_at DESC);
