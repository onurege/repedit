-- V2.7 Phase 3 — Direct company-to-company messaging & negotiated trade offers.

-- One conversation per unordered pair of players (companies). player_lo < player_hi.
CREATE TABLE IF NOT EXISTS direct_conversations (
  id         BIGSERIAL PRIMARY KEY,
  player_lo  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  player_hi  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  last_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (player_lo, player_hi)
);
CREATE INDEX IF NOT EXISTS idx_dconv_lo ON direct_conversations(player_lo, last_at DESC);
CREATE INDEX IF NOT EXISTS idx_dconv_hi ON direct_conversations(player_hi, last_at DESC);

-- Messages. Author identity denormalised so history survives deletion. An
-- offer event carries offer_id and no body; a text message carries body.
CREATE TABLE IF NOT EXISTS direct_messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER REFERENCES players(id) ON DELETE SET NULL,
  sender_name     TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'offer')),
  body            TEXT,
  offer_id        BIGINT,
  deleted         BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dmsg_conv ON direct_messages(conversation_id, id);

-- Per-participant read cursor (unread = messages after last_read not sent by me).
CREATE TABLE IF NOT EXISTS direct_reads (
  conversation_id BIGINT NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
  player_id       INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  last_read_id    BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, player_id)
);

-- Reports on a private message (spam guard: one per message+reporter).
CREATE TABLE IF NOT EXISTS dm_reports (
  id          BIGSERIAL PRIMARY KEY,
  message_id  BIGINT REFERENCES direct_messages(id) ON DELETE CASCADE,
  reporter_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  reason      TEXT NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_id, reporter_id)
);

-- A negotiated trade offer. Roles (buyer/seller player + business) are FIXED at
-- creation from the proposer's chosen side; counters change only qty/price.
-- `proposed_by` made the current version; `awaiting_player` must respond to it.
CREATE TABLE IF NOT EXISTS trade_offers (
  id               BIGSERIAL PRIMARY KEY,
  conversation_id  BIGINT NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
  product          TEXT NOT NULL,
  buyer_player     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  seller_player    INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  buyer_business   INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  seller_business  INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  side             TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'countered', 'accepted', 'rejected', 'expired', 'cancelled')),
  cur_qty          INTEGER NOT NULL CHECK (cur_qty > 0),
  cur_price        INTEGER NOT NULL CHECK (cur_price > 0),
  proposed_by      INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  awaiting_player  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  version          INTEGER NOT NULL DEFAULT 1,
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_offers_live ON trade_offers(status) WHERE status IN ('pending', 'countered');
CREATE INDEX IF NOT EXISTS idx_offers_conv ON trade_offers(conversation_id, id);

-- Immutable negotiation history: every version (propose + counters).
CREATE TABLE IF NOT EXISTS trade_offer_versions (
  id         BIGSERIAL PRIMARY KEY,
  offer_id   BIGINT NOT NULL REFERENCES trade_offers(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  by_player  INTEGER REFERENCES players(id) ON DELETE SET NULL,
  qty        INTEGER NOT NULL,
  price      INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (offer_id, version)
);
