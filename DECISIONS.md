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

## V2.6 — City expansion & districts

- **The city expands; the old map does not grow.** Old Town hit its lot ceiling.
  Adding lots around the edge would have diluted land scarcity and postponed the
  problem by one release. Making the city district-based solves it structurally:
  capacity is added by appending a district, and the same move works for
  District 3, 4, 5.
- **No database migration.** A lot's district is a property of its *definition*,
  not of a business row. Lots have never lived in the database — they are code
  constants — so a `districts`/`lots` table would only duplicate that data and
  add a migration that can fail on live data. Because every Old Town lot id and
  coordinate is unchanged, existing businesses resolve to Old Town for free.
  This was the single biggest risk-reducer in the release.
- **One road graph, not one per district.** Pathfinding was a hard-coded 3×3
  grid. It now builds from an arbitrary list of axis-aligned segments, so
  districts and their connectors form one connected component. Cross-district
  deliveries therefore *drive* — the visible route and the server's timing come
  from the same shared function, as they always have.
- **Districts are spatial, not economic.** No district bonuses, demand, taxes,
  land prices or NPC prices. Marketplace, wholesale, market share, rankings,
  events and integrity stay city-wide; management capacity stays company-wide.
  Economic specialisation is deliberately deferred until there is real player
  data showing where districts diverge.
- **A first business spills over; an expansion does not.** `chooseBusiness`
  prefers the earliest-unlocked district and falls through to later ones only
  when the centre is full, so newcomers still start in the established centre.
  Deliberate expansion (`openBusiness`) always takes an explicit lot — the
  player chooses where to grow, and is never silently relocated.
- **The lot race needed no new machinery.** `businesses.lot_id` is already
  `UNIQUE`, and `openBusiness` re-checks occupancy inside its transaction.
  Green Valley inherits both guarantees; the loser keeps cash and capacity.
- **The announcement is seeded once, keyed on content.** The expansion notice is
  written by the system (not an admin) and matched on a marker embedded in the
  message, so a restart or redeploy never re-posts it.

### Adding District 3

1. Append a `DistrictDef` to `DISTRICTS` in `shared/src/city.ts` — unique `id`,
   world `origin` (keep ground pads roughly adjacent), road lines, lots in
   district-local coordinates.
2. Add a `CONNECTORS` entry joining it to an existing district so the road graph
   stays one connected component.
3. Add `district.<id>.name` / `.sign` to both i18n dictionaries and a `THEMES`
   entry in `client/src/game/city.ts`.
4. Add a What's New entry and let `seedExpansionAnnouncement` post its notice.

Lots, pathfinding, occupancy, camera bounds, city status and the district
selector all derive from the definition and need no further changes.

## V2.5.1 — Import commodity availability (hotfix)

- **The deadlock was social, not mechanical.** V2.5's emergency reserve already
  kept every wholesale good buyable past depletion (2.5×, capped per purchase),
  so a Coffee Shop was never *mechanically* blocked. The real harm was in the
  hidden market-integrity system: every emergency purchase accrued a
  "depletion" suspicion signal, so an honest Coffee Shop — forced to import
  Coffee Beans because no player produces them — accumulated flags and could
  eventually be penalised for a shortage it did not cause.
- **Classification is derived, not hard-coded.** A product is import-dependent
  when no business type supplies it (`playerProducerOf` reads `SELLER_SUPPLIES`).
  Coffee Beans are the only such good today. Nothing in the app special-cases
  the string `'beans'`; add a producer to the config and it stops being an
  import automatically.
- **The exemption is surgical.** Emergency purchases of import-dependent goods
  no longer accrue the depletion signal — there is no player alternative, so it
  cannot be manipulation. The same behaviour on a player-producible good (wheat,
  milk) still accrues it, because there you *could* have traded with players
  instead of cornering the NPC. Reselling beans above 3× base still trips the
  separate extreme-resale signal, so deliberate abuse is still caught.
- **The UI names the lifeline.** An import-dependent good that is out of normal
  stock shows "Emergency Import available" rather than a bare "OUT OF STOCK", so
  the player understands they can still buy it. No implementation detail leaks.

### Supply-chain validation

Every business recipe input has at least one reachable supply path, so no
business can hard-lock. Verified by `unreachableInputs()` (asserted empty in
`server/test/import-supply.test.ts`).

| Input  | Player source        | NPC fallback                          |
|--------|----------------------|---------------------------------------|
| Milk   | Farm                 | Central Wholesale (finite daily)      |
| Wheat  | Farm                 | Central Wholesale (finite daily)      |
| Bread  | Bakery               | Central Wholesale (flat, unlimited)   |
| Beans  | **none — imported**  | Central Wholesale + **Emergency Import** |

Consumers: Coffee Shop needs Milk + Beans; Bakery needs Wheat; Mini Market
needs Bread + Milk. Beans is the only import commodity and is the reason the
Emergency Import path must always stay open and penalty-free.

## V2.6.2 — Storage capacity invariant (hotfix)

- **Root cause: one line.** `completeDelivery` unconditionally did
  `inv.qty += d.qty` ("Paid goods are never lost: deliveries may exceed nominal
  capacity"). Every inventory increase from the Marketplace, Contracts and the
  Central Wholesale flows through a delivery, so that single unload path let
  stock exceed capacity (observed: milk 4157 / 1500). Production and offline
  catch-up already capped correctly (`space = capacity − qty − reserved`).
- **The invariant is per-product, matching the existing model.** Capacity is
  per storage slot (`capacityFor(biz, product)`), not a shared pool — so the
  rule enforced is `qty + reserved ≤ capacityFor` for every product. Two
  reusable helpers (`usedStorage`, `freeSpaceFor`) centralise it so future
  admin ADD/SET inventory tools reuse the same guard.
- **Deliveries wait rather than overflow or vanish.** A delivery that cannot
  fit on arrival enters `WAITING_FOR_STORAGE` (new delivery status). Goods stay
  with the delivery; money and seller stock were already settled at
  creation/execution, so nothing duplicates or is lost. It is retried when
  space frees — in the tick loop (cheap: the deliveries map is small) and
  immediately after a capacity upgrade. Waiting deliveries are loaded on
  startup and survive restart.
- **All-or-nothing (no partial unload in this hotfix).** The full quantity must
  fit or the delivery keeps waiting, deferring partial-settlement complexity.
- **Concurrency is serial by construction.** Unload mutates in memory
  synchronously then persists, so two deliveries into the same slot cannot both
  see the same free space — exactly one takes it, the other waits.
- **Direct purchases pre-validate for UX.** Wholesale already rejected
  over-capacity buys; the Marketplace now rejects a fulfiller's over-capacity
  purchase before escrow (`err.insufficient_storage`). The unload check is still
  the authority — a concurrent change can only make a delivery wait, never
  overflow. Contract deliveries never reject the contract; they wait.
- **Legacy overflow is quarantined, not deleted.** Existing businesses already
  over capacity keep their goods. The same unload check blocks any further
  inbound (delivery waits; wholesale/marketplace pre-checks reject) until
  physical stock falls back below capacity through consumption or sales. The
  inventory UI shows "STORAGE OVER CAPACITY" and blocks are explained.

### Production over-capacity report

`npm run report:overflow -w server` lists every over-capacity slot
(business, owner, type, product, capacity, used, overflow) read-only — it never
touches player goods. Use it to inspect production before/after deploy.

## V2.7 — Player interaction & live ops (phased)

V2.7 is large (~10 subsystems). It is delivered in tested, independently
deployable phases following the prompt's own P0→P2 priority, so economic
correctness and admin authorization are never traded for feature count.

### Phase 1 — City Chat, moderation & the admin audit-log foundation

- **Extends the existing WebSocket architecture, no parallel stack.** Chat rides
  the same typed ClientMsg/ServerMsg + broadcast/sendToPlayer machinery as every
  other realtime feature. Recent history is an in-memory bounded buffer backed
  by `city_chat_messages`; only the last ~60 messages are kept/sent.
- **Server-authoritative safety.** Every message is length-capped (280), has
  markup (`<>`) and control chars stripped, a small profanity mask applied, is
  rate-limited (≤6 / 10s and ≥900ms apart, per player, in memory), and checked
  against active mutes — all before it is stored or broadcast. Author identity
  is denormalised so a message still renders after the author is deleted.
- **Moderation reuses the existing `isAdmin` guard.** `adminDeleteChat`,
  `adminMute`, `adminUnmute` all call `requireAdmin` server-side — hiding the UI
  is never the authorization. A non-admin crafting the WebSocket message is
  rejected with `err.not_admin` (regression-tested). Mutes persist in
  `player_mutes` and survive restart; expired mutes clear lazily. Players can
  report a message (`chat_reports`, unique per message+reporter = spam guard);
  reporter identity is never exposed.
- **`admin_audit_log` is the reusable foundation for ALL later admin features.**
  Append-only, never editable by admins, never stores secrets; `logAdminAction`
  records admin, action, target and a JSON detail (before/after/reason). Phase 1
  already logs DELETE_CHAT_MESSAGE / MUTE_PLAYER / UNMUTE_PLAYER.
- **Privacy preserved.** Chat payloads carry only public identity + body — never
  cash, inventory or other private economic data.

Later phases (Direct Messaging, Live Offers/counter-offers, Urgent City Orders,
the full Admin Console incl. wholesale/cash/inventory controls + hard delete,
Rival Alerts, City News, Feedback) build on this same audit + authorization
foundation.

### Phase 2 — Admin & Live Ops console

Goal: routine live-game administration no longer requires direct PostgreSQL
access. Built entirely on the Phase 1 `requireAdmin` + `admin_audit_log`
foundation and the existing WebSocket stack — no parallel admin backend.

- **Server-side authorization is the only authorization.** Every admin method
  calls `requireAdmin(adminId)`; a normal player crafting the WebSocket message
  is rejected with `err.not_admin` (a dedicated regression test drives every
  admin method as a non-admin). The client hides the Admin nav for non-admins,
  but that is convenience, never the gate.
- **Every consequential action is audited and pushes realtime state.** Cash,
  inventory and wholesale mutations write an `admin_audit_log` entry (admin,
  action, target, before/after, reason) and emit a targeted push/broadcast, so
  changes appear on connected clients with no restart. A reason is accepted on
  all consequential actions.
- **Admin inventory reuses the V2.6.2 storage guard.** Add/Set clamp to
  `capacity - reserved`; an admin can never recreate the storage-overflow bug,
  and freeing space retries waiting deliveries.
- **Cash is integer, non-negative, ledgered.** Add/Remove/Set clamp to >= 0 and
  record an `ADMIN_CASH` ledger row inside the same transaction.
- **Central Wholesale admin fixes the operational pain directly.** Add / remove
  / set stock, refill (product or all), set daily stock, set base price, force
  reset — all live-pushed. Coffee Beans can be refilled from the console; no
  SQL or restart is ever needed again.
- **Suspend / force-logout.** Suspending sets `players.suspended`, forces the
  player off, and blocks re-entry at connect. Force-logout deletes the player's
  sessions and closes their sockets. Both audited.
- **Hard delete is transactional and FK-complete.** The two real blockers — a
  `trades` row references the player AND the fulfilled `market_order`, neither
  with a cascade — are resolved by deleting the player's trades inside the
  transaction first; everything else cascades from `players` / `companies` /
  `businesses`. In-memory world state (business, company, integrity, orders,
  contracts, deliveries, mutes) is purged and a `biz_removed` broadcast drops
  the buildings for every client, so no ghost company / building / occupied lot
  survives. Sessions cascade-delete, so the token is dead — the player cannot
  reconnect. Requires an exact-username typed confirmation and refuses
  self-deletion.

Not in Phase 2 (later P0/P1 phases): direct messaging, live offers/counter
offers, urgent city orders, rival alerts, city news, player feedback.

### Phase 3 — Direct messaging & live negotiation

Turns another real company into a supplier/buyer/negotiation partner in-game.
Built on the Phase 1 WebSocket/moderation and Phase 2 audit foundations; reuses
the marketplace/contract economic discipline and the V2.6.2 storage guard — no
new logistics or realtime stack.

- **DM architecture.** One conversation per unordered player pair
  (`direct_conversations`), messages denormalise the author so history survives
  deletion, unread is a per-participant read cursor (`direct_reads`). Sending is
  length-capped, markup/control-char sanitised, rate-limited and mute-checked
  server-side; a report is one-per-message-per-reporter. Conversations are
  structurally private — a query only ever returns the caller's own pair.
- **Offer state model.** A `trade_offers` head carries the current actionable
  terms + `status` (pending / countered / accepted / rejected / expired /
  cancelled); every version is appended to `trade_offer_versions` as immutable
  negotiation history. Roles (buyer/seller player + business) are FIXED at
  creation from the proposer's side; counters change only qty/price and flip
  whose turn it is (`awaiting_player`). Only the latest version is executable.
- **Authorization & exactly-once.** Every action is server-authorized: only a
  participant can act, only the awaiting party can accept/counter/reject, and
  the client-passed `version` must match (stale guard). Accept mirrors
  fulfillOrder discipline — synchronous in-memory validate+mutate, a per-offer
  lock, and a DB `UPDATE … WHERE status IN (pending,countered) AND version=$
  RETURNING` guard — so a duplicate, concurrent, reconnect-replayed or spoofed
  accept can never move money or goods twice. A client cannot alter price/qty
  after creation; those live only server-side.
- **Storage & delivery.** Accept reuses the V2.6.2 guard: the full quantity must
  fit the buyer's storage (physical + incoming) or the accept is rejected — a
  direct trade can never overflow. Execution creates exactly one delivery via
  the existing engine; if it later can't fit on arrival, the existing
  WAITING_FOR_STORAGE behaviour remains authoritative. Money + stock settle once
  at accept and record `DIRECT_SELL`/`DIRECT_BUY` ledger rows.
- **Expiration.** Offers carry a persisted `expires_at`; a tick sweep retires
  past-deadline live offers (restart-safe), and an expired offer cannot execute.
  The client countdown is informational only — server time is authoritative.

Not in Phase 3 (later): urgent city orders, rival alerts, city news, feedback.

## V2.7 Phase 4 — Urgent City Orders, Rival Alerts & City News

- **Urgent orders — exactly one winner.** `urgent_orders` holds each order's
  lifecycle (`upcoming/active/fulfilled/expired/cancelled`). Fulfilment mirrors
  the fulfillOrder/acceptOffer discipline: a synchronous in-memory
  validate+mutate, a per-order lock, and a DB
  `UPDATE urgent_orders SET status='fulfilled', winner_* … WHERE id=$ AND status='active' RETURNING`
  guard. A concurrent, duplicate, reconnect-replayed or spoofed second claim
  finds zero rows and is rejected — so the goods leave exactly once and the
  reward is paid exactly once. FULL fulfilment only (no partial in Phase 4).
- **Settlement & audit.** The winner loses the required goods from ONE business
  holding enough *unreserved* stock (reserved = escrowed for the market, never
  counted), gains the fixed reward, and the move is recorded as a single
  `CITY_ORDER_REWARD` ledger row + a `company_activity` row of kind `city_order`
  — a new kind deliberately excluded from `recentUnits`, so city orders can
  never be used to game final-sale/supplier rankings. The city is the buyer:
  inventory is consumed atomically, no fake warehouse, delivery is not modelled.
- **Scheduler.** A conservative tick scheduler keeps at most `URGENT_MAX_ACTIVE`
  (default 1) live at once, gated by a spawn cooldown, an online-player minimum,
  and a per-tick probability. Product choice is loosely coupled to V2.3 city
  demand (highest effective demand + jitter). All limits are shared constants.
  Live orders are restart-safe (reloaded from the DB; anything past its deadline
  is retired on load).
- **Admin.** `createUrgentOrder`/`cancelUrgentOrder` require admin, are bounded
  to a safe envelope, audited (`CREATE_URGENT_ORDER`/`CANCEL_URGENT_ORDER`), and
  pushed in realtime. City-news auto-generation is deliberately NOT audited (it
  is not an admin action).
- **Rival alerts — committed data only.** Two derivations: (1) a coarse
  market-share sweep (`RIVAL_SWEEP_SECONDS`, never per-player, one query per
  product) compares this window's committed `final_sale` rank order against the
  last snapshot and alerts the overtaken company; (2) a fresh, materially
  cheaper (`>= RIVAL_MIN_UNDERCUT_FRACTION`) sell listing raises a price-undercut
  alert on order creation. Both use a stable dedupe key + a per-key cooldown
  (`RIVAL_ALERT_COOLDOWN_SECS`) and a minimum-volume floor, so a rival nudging a
  price by a cent, or trivial-volume products, never spam the feed. Alerts are a
  bounded per-player buffer, private to the affected player.
- **City news — bounded feed from real events.** `city_news` is append-only and
  pruned to `NEWS_MAX_ITEMS`. Types: city-order win (mandatory, awaited so it is
  never lost), major deal (single-deal money over threshold), market-leader
  change (only when leadership actually changes), business opened, wholesale low
  (once per depletion cycle via an in-memory flag re-armed on refill). Payloads
  are privacy-safe: a public actor name plus render params that are never cash,
  inventory, integrity, messages, or admin notes — the client renders via i18n.
  Leader-change / wholesale-low items carry a `dedupe_key` suppressed for 30 min.
- **Realtime & UI.** Urgent orders + city news broadcast; rival alerts push to
  the affected player only; all three are re-seeded on connect so a reconnect
  recovers state. A non-blocking HUD banner shows the soonest order with a live
  1s countdown and a Fulfil action gated on local unreserved stock (server stays
  authoritative on expiry and the single winner). A new CITY tab in the News
  panel is kept separate from What's New / announcements.

Not in Phase 4 (later): feedback, V2.8.

## V2.7 Mobile Web Compatibility Hotfix — touch controls + responsive UI

Frontend/input/CSS only — no backend, economy, schema, or WebSocket changes.

- **Touch as an adapter, not a second game.** `CameraRig` gains touch handlers
  that drive the SAME `target`/`yaw`/`dist` the desktop mouse path uses:
  one-finger drag pans (same math as middle-drag), pinch scales `dist`
  (fingers apart → zoom in), a two-finger midpoint slide rotates `yaw`. A
  12px travel threshold discriminates tap (→ existing `onSelect` raycast) from
  drag; a drag never selects; multitouch transitions re-baseline without a
  jump; `touchcancel` clears all gesture state. Desktop WASD/mouse/wheel are
  untouched (verified). Touch capability is detected via `ontouchstart` /
  `maxTouchPoints` (`src/touch.ts`), never viewport width, so hybrid devices
  keep both paths.
- **Gestures scoped to the canvas.** `touch-action: none` is set on the WebGL
  canvas only; `preventDefault` on canvas touch events stops page scroll/zoom
  and synthesized mouse events. UI panels keep native scrolling and never move
  the world (proven in the mobile E2E).
- **Responsive UI.** A `@media (max-width: 640px)` layer turns the docked side
  panel into a full-screen sheet that shrinks with the soft keyboard (a
  `--app-vh` CSS var fed by `visualViewport`), makes the bottom nav a
  horizontally-scrollable persistent tab bar above the panel, compacts the top
  HUD, moves the language switcher to a flag-only top-left chip, stacks the
  offer modal's controls, and enforces ~44px touch targets. A
  `641–1024px` layer hides the transient top banners/objectives while a panel
  is open (they would overlap a large docked panel). Safe-area insets
  (`env(safe-area-inset-*)`) are applied to the HUD, nav, panels and modals;
  `viewport-fit=cover` is set. The desktop WASD hint is hidden on touch and
  replaced by a one-time gesture card (EN/TR).
- **Mobile performance.** On touch devices the renderer caps DPR at 1.5 (vs 2),
  disables MSAA, and uses a 1024² (vs 2048²) shadow map + PCF (vs PCFSoft).
  Desktop visual quality is unchanged.

Not in this hotfix: any gameplay/economy change, V2.7 Phase 5, native apps.

## V2.8 Phase 1 — Product Economy Foundation

Additive on top of V2.7. The existing 1–3 facility "upgrade tier"
(capacity/production/upgrade), the production loop, the V2.6.2 storage invariant
and all V2.7 systems are untouched. Everything below is opt-in and migrated
safely; a business at Business Level 1 behaves exactly as before.

- **Canonical layer (`shared/src/economy.ts`).** One authoritative source for
  recipes, the product-license catalog, business levels 1–50, the XP curve and
  product slots. The server is authoritative; clients render these definitions
  (never redefine them).
- **Recipes.** `Recipe { output, outputQty, inputs[] }`. bread (wheat→bread) and
  coffee (milk+beans→coffee) mirror today's production; latte (beans×2+milk) is
  the multi-input, license-gated **foundation** product — recipe-previewable now,
  produced in Phase 2.
- **Product licenses.** Per BUSINESS (not company). Capability is PRODUCE
  (manufacture, has a recipe) or RETAIL (stock & resell) — this preserves the
  Mini Market retail role and each type's identity (`businesses` map per product).
  Requirements: business level, prerequisite license, fee. Starter licenses
  reproduce every current business's products, so migration loses nothing.
  Purchase is server-authoritative and **exactly-once** (the `business_licenses`
  primary key is the guard) with one `PRODUCT_LICENSE` ledger row. No
  refund/resale/transfer in Phase 1.
- **Business Level 1–50 (XP-driven).** Five tiers (Local/Established/Regional/
  Major/City Icon). **Every level grants something** (storage rises each level;
  milestones add slots/tier) — no empty levels. Storage bonus is modest
  (×1.0 at L1, ≈×2.0 at L50) and never a margin advantage. XP accrues only from
  committed, demand-limited activity (production, NPC retail sales, contract
  deliveries, urgent-order wins); player↔player XP is deliberately deferred to
  block circular-trade farming.
- **Product slots.** License ≠ active. Slots scale by level (L1:1 → L50:12) with
  grandfathering so a business never drops below its starter product count.
  Activation is server-authoritative with a modest reconfiguration cooldown
  (admins/dev bypass).
- **Central Wholesale player-first pricing.** A manipulation-resistant reference
  from COMPLETED player marketplace trades (self-trades excluded, min sample +
  volume, per-trade weight cap, volume-weighted median). A conservative repricer
  nudges the base price toward `reference × (1+premium)`, clamped to a safe band
  around the NPC base and bounded per refresh, so wholesale sits ABOVE healthy
  player prices and never undercuts them; Emergency Reserve stays ×2.5 above
  normal. No trustworthy history → safe fallback to the base NPC price.
- **Player-Sourced Input Ratio.** From committed deliveries
  (`from_lot = wholesale` → central, else player), city + per-product, with
  healthy/central-dependent/critical bands. Operator diagnostic only (Admin
  Console) — never public, never faked toward a target, never affects gameplay.
- **Migration 016 (additive).** biz_xp/biz_level/last_slot_change columns +
  business_licenses & business_active_products tables; starter licenses + active
  slots backfilled on load/creation.

### Balancing review (current values; flagged, not silently rebalanced)

- **XP curve** `xpToNextBizLevel(n) = round(45·n^1.6)`: L1→2 ≈ 45, L5→6 ≈ 590,
  cumulative to L5 ≈ 856, L10 ≈ 3.7k, L20 ≈ 22k, L50 cumulative ≈ 0.6M. **Early
  game (L1–10)** is quick from ordinary NPC sales/production; **mid (L11–30)** a
  meaningful investment; **late (L31–50)** a long tail. With NPC-sale XP = 2/unit
  a busy shop levels early tiers in a session and the top tiers over long play —
  reasonable for a persistent idle economy. FLAG: exact XP-per-activity constants
  (`BIZ_XP`) are conservative starting points; revisit after live data.
- **License fees**: latte = $4,000 (the only buyable license this phase) —
  roughly a mid-game purchase; starters are free. FLAG: expand with the catalog.
- **Slots**: L1:1 · L5:2 · every +5 → +1 · L50:12. Slots (not raw margins) are
  the main progression payoff, per the anti-power-creep rule.
- **Storage**: +2%/level, capped ≈×2 at L50 — additive over the facility tier.
- **Wholesale premium** = +20% over the player reference, clamped to [0.7×,2.5×]
  of the NPC base, ±8%/refresh, 5-min cadence. Emergency = ×2.5. Intent: player
  sourcing is normally cheaper; wholesale is the safety net; emergency is worst.
  FLAG: premium/clamp/cadence are conservative defaults for the current tiny
  catalog; tune as real completed-trade volume grows.

Not in Phase 1: manual production, production queue/timers/quantity selection,
ingredient-consumption UI, large product catalog, new business types.
