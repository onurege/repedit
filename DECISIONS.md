# DECISIONS — architectural & gameplay record

## Phase 3 — supply contracts

- **Contracts reuse the delivery + ledger + exactly-once discipline** from
  marketplace fulfillment: execution mutates memory synchronously, persists in
  one DB transaction guarded by `WHERE status='active' AND remaining_deliveries=$prev`,
  plus an in-memory `contractLocks` set — so concurrent/duplicate execution
  cannot double-pay, double-remove stock, double-deliver, or double-log.
- **Buyer pays at execution time (no escrow).** Simpler than the marketplace's
  buy-order escrow and adequate because execution validates funds first and
  skips safely (MISSED — BUYER FUNDS) rather than going negative.
- **Server-driven execution in the tick loop** (and a catch-up sweep on load)
  means contracts run while both players are offline; no browser session needed.
- **Contracts are private to their two parties** (not broadcast): live updates
  go only to buyer+seller; the welcome snapshot queries the DB for that player's
  contracts including terminal history. Only proposed/active are held in memory.
- **`~45s "game day"` interval in wall-clock**, independent of dev time-scale,
  so time-warp accelerates production but not contract cadence.
- **Public inspection fields** (reputation, supplies, trade count) were added to
  the already-broadcast `BizPub` rather than a new request; `tradeCount` is
  seeded from the `trades` table at load and incremented in memory (contract
  deliveries since restart are counted live).
- New ledger types `CONTRACT_SELL` / `CONTRACT_BUY` reuse the existing schema.

## Architecture

- **Realtime layer: hand-rolled WebSocket (`ws`) instead of Colyseus.**
  The spec allows "Colyseus or equivalent authoritative realtime framework".
  Our state is small (a handful of businesses/orders/deliveries), so JSON
  snapshot-on-join + incremental events is simpler, dependency-light, and makes
  reconnect trivially correct (every welcome message is a full authoritative
  snapshot — stale client state is impossible by construction).

- **Memory-authoritative simulation, PostgreSQL as durable record.**
  The world lives in server memory and ticks once per second. Node's
  single-threaded execution makes in-memory validations race-free. Critical
  multi-party operations (trades, purchases, upgrades) mutate memory
  synchronously, then persist immediately inside a DB transaction, with
  in-memory rollback on persistence failure plus a per-order lock across the
  async window. Ambient simulation state flushes every 5 s and on shutdown.
  Duplicate fulfillment is additionally guarded at the DB level
  (`UPDATE ... WHERE status='open'` inside the transaction).

- **Escrow marketplace.** BUY orders escrow the buyer's cash at creation;
  SELL orders move goods into a `reserved` bucket. Fulfillment therefore never
  fails on the order owner's side, and cancellation is an exact refund. This
  is what makes "the transaction must happen exactly once" easy to guarantee.

- **Deliveries decouple trade from goods arrival.** A trade pays instantly but
  goods travel as a delivery row with `arrive_at`. The economy completes the
  delivery server-side on schedule regardless of what the visual van does —
  visuals can never corrupt the economy. Overdue deliveries are completed on
  server boot (restart-safe).

- **Shared `shared/` package.** Product/business/upgrade definitions, the city
  map and the road-graph pathfinding are one source of truth imported by both
  client and server; delivery travel time is computed from the same path the
  client animates.

- **Offline progression = restart catch-up.** One mechanism: each business has
  `sim_ts`; on load the server runs aggregated 60 s-chunk simulation for the
  elapsed time, capped at 8 h. While the server runs, businesses of players
  offline longer than 8 h pause ("PAUSED (owner away)"), preventing unbounded
  idle income.

- **Money is integer dollars.** No floating-point cash anywhere.

- **Accounts: username+password (scrypt) + DB session tokens.** Lightweight,
  supports many accounts per browser machine for local testing; OAuth
  deliberately omitted for the MVP.

## Gameplay / economy

- **Coffee recipe 1 milk + 1 beans → 1 coffee**, base price $30.
  NPC wholesale: milk $15, beans $8 → NPC-supplied coffee margin ≈ $7;
  player milk around $10–14 beats the NPC, giving both sides a reason to trade.
- **Farm L1 produces 0.5 milk/s (30/min)** so the acceptance scenario's
  "produce 100 milk" takes ~3½ minutes of real time (or seconds with dev
  time-warp). Upgrades: 2500 → 7000 (farm), 3000 → 9000 (shop) — first upgrade
  reachable in ~10 min of normal play.
- **Demand model:** customer arrival rate = level rate × price multiplier
  (cheaper than $30 attracts, above ~$36 repels) × reputation multiplier.
  Lost customers (no coffee in stock) cost reputation.
- **Reputation:** shops gain by selling at fair prices, lose on stock-outs and
  gouging; farms gain by fulfilling marketplace trades.
- **Deliveries may exceed nominal storage capacity.** Paid goods are never
  destroyed; capacity gates production and *new* purchases instead.
- **Visual customers represent sales** (spawned on server sale events); the
  +$ popup fires when the visual customer reaches the door, but the money is
  already booked. Navigation can never affect correctness.

## Art & audio

- **All 3D art is original and procedural** (Three.js primitives with a shared
  palette) — zero external assets, zero licensing risk, tiny download.
  Quaternius/Kenney packs were considered and kept as an option for later
  phases; visual consistency of the procedural set won for the MVP.
- **All audio is synthesized WebAudio** (clicks, sale/purchase chimes, upgrade
  fanfare, delivery ding, ambient bed) — respects autoplay rules by starting
  on first user gesture.

## V2.2 — Market share, company profile & city rankings

- **Rolling 7-day window (real time), not lifetime.** Competitive rankings use
  recent activity so early players can't permanently hold the top. We read the
  spec's "7 game days" as 7 real days — the natural "recent" horizon for a
  persistent, mostly-offline idle economy. The contract cadence's 45s "game
  day" is a separate concept and deliberately not reused for rankings.
- **One small append-only table, plus the existing ledger.** `company_activity`
  (migration 006) records only the per-product *unit* flows the ledger lacks:
  `final_sale` (NPC retail → market share) and `supplier_sale` (external
  player-to-player marketplace/contract volume → supplier ranks). Recent
  revenue, net cash flow and growth are derived from the existing
  `economic_ledger`. No analytics database, no per-tick global scans.
- **Stats are recorded inside the same transaction as the money.** Final sales
  queue alongside the CUSTOMER_SALE ledger row and flush together; marketplace
  and contract supplier rows are written in those operations' own commit
  transactions. So a failed sale or a rejected double-fulfill can never inflate
  a statistic, and every metric survives logout/reconnect/restart.
- **Market share is final-consumer only.** Internal transfers don't exist
  (inventory is per-business, no company-internal transfer), and marketplace /
  contract flows are counted as *supplier* volume, never as final market share.
  NPC wholesale supply is never counted as player market activity.
- **Net cash flow, not "profit".** True per-window profit is hard to attribute
  cleanly from the ledger, so the profile/rankings show net cash flow over the
  window and label it as such — no misleading metric.
- **Company reputation** is an activity-weighted average of its businesses'
  reputations (weight = 1 + lifetime units the business has moved), falling back
  to a plain average when there's no activity — reusing existing per-business
  reputation rather than a new model.
- **Fastest-growing guards against new-company nonsense:** a company is eligible
  only if both the current and previous window clear a recent-revenue floor
  ($5,000), so going $0 → $100 can't vault to #1.
- **On-demand with a 5s cache.** Rankings are computed from a handful of indexed
  queries when requested and cached briefly; per-viewer "your rank" markers are
  layered on cheaply in memory. Profiles expose only public data (company,
  public businesses, reputation, rankings, market share, trade counts) — never
  cash, inventory, contract pricing, or ledger entries.
