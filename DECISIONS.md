# DECISIONS — architectural & gameplay record

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
