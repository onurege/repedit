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

## V2.3 — Dynamic city demand & city events

- **Demand is derived, never accumulated.** Effective city demand for each final
  product is recomputed every tick as `clamp(1 + Σ active-event deltas, 0.5, 2.0)`.
  Nothing stores a running modifier, so a double tick, a restart, or a missed
  transition can never apply or remove an effect twice — the classic source of
  economy corruption is designed out.
- **Events are the dynamic source, base demand is stable.** Base demand stays
  1.0 (no random walk in V2.3). All movement comes from a small, legible event
  set with fixed, displayed percentage effects. Players never guess what an
  event does.
- **Demand changes volume, not price.** The multiplier scales the existing NPC
  customer arrival rate only. Player retail prices and all player-to-player
  marketplace/contract rules are untouched, preserving player-driven price
  discovery — high demand becomes a decision (raise price vs. maximise volume).
- **NPC fallback may get pricier, never unavailable.** Supply Disruption raises
  NPC wholesale prices via a bounded multiplier (clamped, min 1x), so players
  are never progression-blocked and Farm players get a real opportunity.
- **Preparation window is mandatory.** Events are announced (UPCOMING) with a
  lead time before they start, so a player can always make at least one
  strategic move (stock inputs, raise production, sign a contract) first.
- **Idempotent lifecycle.** `UPCOMING→ACTIVE→ENDED` transitions run in the tick
  and are guarded by a SQL `WHERE status=<from>` update, so a transition can't
  fire twice. Live events are reloaded on start and missed transitions resolved,
  so restarts resume correctly.
- **Scheduler keeps the economy readable.** At most one upcoming event and one
  active *major* event; per-type cooldowns prevent repetition; randomized gaps
  preserve stretches of normal economy. Timing constants are tuned short for
  accelerated/idle play and tested via dev controls (trigger/advance/clear),
  which are production-disabled.
- **Competition stays real.** Market share and rankings are deliberately NOT
  touched by events; a festival raises a player's share only through the extra
  `final_sale` units it causes — statistics remain derived from committed sales.
- **Inflation guardrails:** bounded demand multiplier, time-limited events,
  existing per-business customer/stock caps and price sensitivity. No taxes or
  sinks added (deferred).

## V2.4 — Player experience & live-service foundation

- **The brief is derived, not a new ledger.** The Morning Business Brief /
  Offline Report V2 aggregates across all a company's businesses from existing
  sources — `economic_ledger` (revenue, net cash flow, contract deliveries) and
  `company_activity` (per-product final sales) — plus live demand/market state.
  It is computed on connect / on request, never per tick. It shows **net cash
  flow**, explicitly labelled — never a fabricated "profit".
- **One opportunity, deterministic rules.** A single most-important
  recommendation is chosen by a fixed priority ladder (upcoming event on a sold
  product → high current demand → farm supplier opening → first upgrade → try
  the marketplace). No AI, no scoring model — legible and testable.
- **Alerts are prioritized and deduped**, capped at six, sorted
  critical→warning→info, derived from live business state and contract results.
- **New players are caught up, returning players see updates once.** Creating a
  player's tutorial row seeds `player_seen_updates` with all current release
  notes, so a brand-new player gets Mira instead of an update backlog; the
  connect flow resolves the tutorial *before* reading unseen updates to avoid a
  race. Existing players see each new update exactly once via `ack_update`.
- **Tutorial is non-blocking and resumable.** Mira is a corner avatar, not a
  modal wall; steps highlight the relevant UI. Progress (`tutorial_progress`)
  persists and resumes after restart; it can be skipped at any time and never
  un-skips. Completing "create your first business" auto-advances step 1.
- **Announcements are admin-only broadcasts, not chat.** Gated by a
  `players.is_admin` flag; server-side validation caps title/message length,
  strips angle brackets, and rate-limits to 5/min per admin. Priority drives the
  UI weight (critical banner → important banner → normal badge only); expiry is
  honoured for the active list while history is retained.
- **Camera matches RTS/tycoon conventions**: left-click selects (unchanged),
  right-drag orbits, middle-drag pans, wheel zooms, WASD still pans. Purely
  client-side; no gameplay impact.
- **No economic surface touched.** V2.4 reads existing state and adds
  communication/onboarding UI only — market share and rankings still derive
  from real committed activity; prices and trades are unchanged.

## V2.5 — Economic depth & market integrity

- **The Central Wholesale is finite, not infinite.** Wheat/Milk/Beans have a
  daily stock that depletes as players buy, creating real scarcity that steers
  players to the player marketplace. An **emergency reserve** (2.5× price, capped
  per purchase) guarantees new players are never blocked while making hoarding
  uneconomic. Daily stock is deliberately modest so a few aggressive buyers can
  actually deplete it.
- **Daily reset is idempotent and restart-safe.** Each product carries its own
  `reset_at`; on a tick past it, remaining refills to the daily stock and
  `reset_at` advances by whole days (so downtime can't double-refill or
  re-trigger). The first wholesale product anchors the once-per-day integrity
  evaluation, so a day boundary evaluates each company exactly once.
- **Integrity is a trust system, not anti-cheat.** A hidden per-company score
  (start 100) moves on *weak, combined, repeated* signals — cornering >50% of a
  product's daily stock, depleting it into emergency, repeated extreme-price
  resale. A single day never confirms anything; the ladder NORMAL → WATCHLIST →
  INVESTIGATING → CONFIRMED needs sustained abuse (≈3 flagged days). Buying,
  holding, reselling and event-prep, on their own, generate no suspicion — false
  positives are designed out.
- **Consequences are proportionate and recoverable.** Only CONFIRMED applies a
  company-reputation penalty (clamped, recoverable via normal play) and a vague
  public warning; money and inventory are never touched and nothing is banned.
  The reason is never revealed and the numeric score never leaves the server.
- **Everything is derived/recorded from committed events.** Signals accrue only
  from successful purchases/listings; wholesale purchases (incl. emergency) and
  integrity violations are written to the existing `economic_ledger`. Detection
  is event-driven with a once-per-day evaluation — no per-tick global scans.
- **Balancing left progression intact.** Opening/upgrade costs and cash
  generation are unchanged; the emergency premium is the only new sink and
  scarcity self-limits runaway buying. Adjust later only if telemetry demands.
