# V2.7 — PLAYER INTERACTION & LIVE OPS (in progress, phased)

Shipping in tested, deployable phases per the prompt's P0->P2 priority.

## Phase 3 (shipped) — Direct messaging & live negotiation
Company-to-company private messaging (realtime, persistent, unread, sanitised,
rate-limited, reportable) plus negotiated one-off trade offers with counter
chains. Accepting an offer is server-authoritative and exactly-once (per-offer
lock + DB status/version guard), reuses the V2.6.2 storage guard (no overflow),
creates one delivery, and records DIRECT_SELL/DIRECT_BUY ledger rows. Offers
carry a persisted expiry swept each tick. See DECISIONS.md.

## Phase 2 (shipped) — Admin & Live Ops console
Routine live administration no longer needs direct PostgreSQL access. On the
Phase 1 `requireAdmin` + `admin_audit_log` foundation: dashboard, player
search/detail, suspend/unsuspend, force-logout, cash add/remove/set (ledgered),
inventory add/remove/set (reuses the V2.6.2 capacity guard), full Central
Wholesale control (stock/refill/daily/price/reset, live-pushed), announcement
edit/deactivate, an audit viewer, and a transactional FK-complete hard delete
that leaves no ghost business/lot and blocks reconnect. All server-authorized
and audited. See DECISIONS.md.

## Phase 1 (shipped) — City Chat + moderation + admin audit foundation
Real-time City Chat over the existing WebSocket stack: bounded persistent
history, server-side validation (length, markup/control-char stripping,
profanity mask, rate limiting), mute/report moderation, and admin delete —
all gated by the existing `isAdmin` guard. Introduces `admin_audit_log`, the
append-only, secret-free audit trail every later V2.7 admin action reuses.
See DECISIONS.md. Remaining V2.7 areas (DMs, live offers, urgent city orders,
full admin console + hard delete, rival alerts, city news, feedback) follow.

# V2.6.2 — STORAGE CAPACITY INVARIANT (hotfix)

Deliveries (Marketplace, Contracts, Wholesale) could unload into a full store,
letting inventory exceed capacity (observed: milk 4157 / 1500). Root cause: a
single unbounded `inv.qty += d.qty` in `completeDelivery`. Fixed by enforcing
`qty + reserved <= capacityFor(product)` at unload; a delivery that cannot fit
enters WAITING_FOR_STORAGE (goods held, money already settled once) and unloads
exactly once when space frees (consumption, sale, or upgrade), surviving
restart. Legacy over-capacity data is preserved but blocked from receiving more
until it drains. See DECISIONS.md for the full design and the
`report:overflow` admin query.

# V2.5.1 — IMPORT COMMODITY AVAILABILITY (hotfix)

Coffee Beans have no player producer, so the Central Wholesale + Emergency
Import is their only supply path. This hotfix ensures that path never hard-locks
a Coffee Shop and — the actual bug — that being forced to use Emergency Import
for an import commodity no longer accrues market-manipulation suspicion. The
exemption is data-driven (a good is "import-dependent" when no business supplies
it) and surgical (player-producible goods still accrue the signal). See
DECISIONS.md for the supply-chain validation table.

# V2.6 — CITY EXPANSION, DISTRICTS & LIVING CITY (current)

Old Town had reached its practical lot capacity. Rather than enlarging the old
map, the city became **district-based** so capacity can be added again and
again. One economy, several places.

- **Districts are data.** `shared/src/city.ts` declares `DISTRICTS`: each has an
  `id`, world `origin`, ground size, road lines, a visual `theme` and its lots
  in district-local coordinates. World-space `LOTS`, `ROAD_SEGMENTS` and
  `CITY_BOUNDS` are all derived. Adding District 3 is a definition plus a
  connector — no schema, company, marketplace, contract or delivery rewrite.
- **Old Town is District 1.** Every original lot id and coordinate is unchanged,
  so existing businesses, companies, contracts, orders, inventories and
  reputation survive untouched and resolve to Old Town automatically. **No
  migration was needed**: a lot's district is derived from its definition, not
  stored per business.
- **Green Valley is District 2.** 24 lots — 6 each of farm / coffee shop /
  bakery / mini market, deliberately balanced so no type becomes the next
  bottleneck (Old Town has only 3 bakery and 3 market lots). Visually distinct:
  wider road spacing, open blocks, denser greenery, a village green instead of
  the plaza, and an entrance monument.
- **One connected road graph.** Pathfinding moved off the hard-coded 3×3 grid
  onto an arbitrary set of axis-aligned segments, cut at endpoints, crossings
  and projections. Districts plus `CONNECTORS` form a single component, so a
  delivery van physically drives the inter-district highway instead of
  teleporting — and route length still matches the server's delivery timing.
- **One city economy.** Marketplace, contracts, Central Wholesale, market share,
  rankings, city events, dynamic demand and market integrity remain city-wide;
  management capacity remains company-wide. A company can own businesses in
  several districts on one capacity pool.
- **Navigation & visibility.** A district selector shows live occupancy and
  travels the camera (no reload, no reconnect); pan bounds now cover the whole
  city. Business chips and the open-business dialog group by district. A city
  status panel reports real aggregates and recent public openings.
- **Communication.** V2.6 What's New (EN/TR); the city expansion announcement is
  seeded exactly once; one contextual Mira hint when the centre gets crowded.
- **Graceful ceiling.** When every district is built out, business creation is
  refused cleanly (`err.city_full`) with cash and capacity intact.

## Previous — V2.5 — ECONOMIC DEPTH & MARKET INTEGRITY

Turns the economy from "produce → sell → grow" into "analyze → predict → trade
→ manage risk → protect reputation", by making the Central Wholesale a finite
institution and adding a fair, hidden market-integrity system. No banks, loans,
taxes, or social systems.

- **Finite Central Wholesale.** Wheat, Milk and Coffee Beans now have a finite
  **daily stock** (`wholesale_supply`, migration 009) at a base price, resetting
  once per wholesale day. Stock decreases as players buy and can hit **OUT OF
  STOCK** — which naturally pushes players to the marketplace. Reset is
  idempotent and restart-safe (advances by whole days on catch-up).
- **Never blocked.** Past depletion an **emergency reserve** stays available —
  expensive (2.5×) and capped per purchase — so new players are never
  progression-blocked while hoarding is discouraged.
- **Speculation is encouraged, never punished.** Buying low, holding, preparing
  for an announced event and reselling high are all legitimate and carry no
  penalty on their own.
- **Hidden market-integrity system** (`company_integrity`). Each company has a
  private score (starts 100) and a gradual state ladder NORMAL → WATCHLIST →
  INVESTIGATING → CONFIRMED. It combines *weak* signals over multiple days
  (cornering >50% of a product's daily stock, depleting into the emergency
  reserve, repeated extreme-price resale). No single action ever flags a day;
  only **sustained** abuse escalates. The score is never exposed.
- **Reputation consequences.** Only a CONFIRMED, sustained manipulator takes a
  **recoverable** company-reputation penalty and a vague public profile warning
  ("⚠ Recent Market Violation") — never money removed, inventory deleted, or a
  ban, and never revealing why.
- **Scarcity UI.** The wholesale panel shows remaining/daily stock, a stock bar,
  IN STOCK / LIMITED / LOW STOCK / OUT OF STOCK, the (event-adjusted) unit
  price, and a reset countdown — encouraging strategic planning.
- **Ledger + performance.** Wholesale purchases (incl. emergency) and integrity
  violations are recorded in the existing ledger. Detection is event-driven
  (counters on committed purchases/listings) with periodic per-day evaluation —
  no expensive continuous scans.
- **Balancing** was reviewed; progression (opening/upgrade costs) is unchanged.
  The new money sink is the emergency premium, and scarcity self-limits
  cash generation — deliberately minimal adjustments.

All 103 unit tests (incl. 10 new wholesale/integrity tests) and eight browser
E2Es (golden-path, supply-chain, contract, company, rankings, events,
experience, wholesale) pass; production build succeeds.

---

# V2.4 — PLAYER EXPERIENCE & LIVE-SERVICE FOUNDATION

Makes the game welcoming to new players and worth returning to, without any
economic changes. When a player enters they immediately understand what
happened while away, what changed in the city, what needs attention, and what
to do next.

- **Morning Business Brief** on session return: aggregates while-away revenue,
  net cash flow, production and per-product sales *across all the company's
  businesses* (from the ledger + `company_activity`), plus current demand /
  market share, the active/upcoming event, prioritized alerts and one
  opportunity — with a "Go to Business" shortcut. Doubles as **Offline Report
  V2**. Honest numbers only (net cash flow, never a fake "profit").
- **Business alerts** (deduped, prioritized): low input stock, sold out, missed
  contract, business not operating, storage full — actionable, not spammy.
- **Opportunity**: exactly one deterministic, rule-based recommendation
  (stock up before an announced event → produce more in high demand → farm
  supplier opening → first upgrade → try the marketplace). No AI.
- **What's New**: a persistent, per-player release-notes system (`UPDATES` +
  `player_seen_updates`) — a player sees each update once; brand-new players are
  auto-caught-up so they get the tutorial, not a backlog. Full **update
  history** browsable in the News panel.
- **Mira**, a friendly business-advisor avatar (bottom-right), gives a gentle,
  skippable, 9-step tutorial. Progress persists (`tutorial_progress`) and
  resumes after restart; completing "create your first business" auto-advances.
- **Global announcements**: admins (a `players.is_admin` flag) publish
  broadcast messages (`announcements`) with type + priority; players see a
  banner by priority, a nav badge, and full history — validated, length-capped,
  HTML-stripped, rate-limited, admin-only. Not chat.
- **Improved camera**: WASD + **left-click select**, **right-drag rotate**,
  **middle-drag pan**, **wheel zoom** — an RTS/tycoon feel.

All reports are computed on connect/on request (never per tick). Other players'
data stays public-only. Full EN/TR localization. All 93 unit tests (incl. 17
new experience tests) and seven browser E2Es (golden-path, supply-chain,
contract, company, rankings, events, experience) pass; production build
succeeds.

---

# V2.3 — DYNAMIC CITY DEMAND & CITY EVENTS

The first **dynamic economy** layer. The city now runs scheduled events that
shift consumer demand, so players can read an upcoming situation, prepare
(stock inputs, raise production, sign contracts), and profit if they
anticipated correctly. No new economy mechanics, prices, or businesses — just
a demand multiplier and an event schedule on top of the existing simulation.

- **City demand state** for the three final products (**Bread, Coffee, Milk
  retail**): a server-authoritative multiplier, **derived fresh each tick from
  the currently-active events** (never accumulated), clamped to a safe band
  (0.5–2.0; events normally stay 0.7–1.5). It multiplies the existing customer
  arrival rate, so demand changes *how many NPCs buy* — player prices and
  player-to-player trades are never touched.
- **Five city events**, announced ahead of time so there's a preparation
  window: **City Festival** (bread +40%, coffee +50%, milk +15%), **University
  Week** (coffee +35%…), **Heat Wave** (milk +25%, coffee −10%), **Supply
  Disruption** (raises NPC wholesale wheat +30% / milk +20% — inputs get
  pricier, never unavailable), **Local Market Day** (small, frequent; bread &
  milk +20%). Effects and exact percentages are always shown.
- **Lifecycle** `UPCOMING → ACTIVE → ENDED`, persisted in `city_events`
  (migration 007). Transitions are guarded by a status check so a double tick
  or a restart can never apply or remove a modifier twice; demand is
  re-derived, not toggled. A lightweight scheduler keeps at most one upcoming
  event and one active *major* event, with per-type cooldowns and normal-economy
  gaps between events.
- **UI**: a **City Market** panel (active/upcoming events with live countdowns
  and exact effects, a demand overview with VERY LOW…VERY HIGH categories and
  trend arrows, and NPC wholesale price status), a compact HUD banner while a
  major event is active, a nav badge, and an optional "Current Opportunities"
  line on the player's own profile.
- **Market share & rankings are untouched** — they keep deriving from real
  `final_sale` activity, so a festival that boosts a player's bread sales raises
  their bread market share *through actual sales*, never by awarding points.
- **Dev-only controls** (trigger each event, advance event time, clear events)
  drive tests and are disabled in production like all dev tools.

All 76 unit tests (incl. 8 new event tests) and six browser E2Es (golden-path,
supply-chain, contract, company, rankings, events) pass; production build
succeeds.

---

# V2.2 — MARKET SHARE, COMPANY PROFILE & CITY RANKINGS

The first city-wide **competition** layer. Players can now answer "how big is
my company, what am I best at, and who is beating me?" — without any new
economy mechanics, dynamic demand, or city events (those are V2.3).

- **Competitive metrics** are computed from *recent* activity over a rolling
  **7-day window**, so early players can't lock in the top spots. (We interpret
  the spec's "7 game days" as 7 real days — the natural recent horizon for a
  persistent, mostly-offline idle economy.)
- **Market share** (final consumers): a company's share of the city's NPC
  retail sales for **Bread, Coffee and Milk (retail)**, by units. Internal and
  B2B flows never count as final share — only real NPC sales do.
- **Supplier rankings** (raw materials): **Wheat** and **Milk** suppliers ranked
  by recent *external* player-to-player volume (marketplace + contract
  deliveries). A company supplying itself is impossible here (no internal
  transfer exists; marketplace/contracts require two different companies).
- **Company Profile** (public): name, owner, level, management capacity,
  aggregated reputation, businesses owned (listed, clickable), founded date,
  recent revenue and **net cash flow** (labelled honestly — not "profit"),
  successful trades, active contracts, plus market-share cards and supplier
  ranks with `#1` badges. Only categories with real activity are shown. Private
  data (cash, inventory, contract pricing, ledger) is never exposed to others.
- **City Rankings** (Top 10 + your own rank): recent revenue, net cash flow,
  reputation, fastest-growing (revenue % change vs the previous window, guarded
  by a minimum-activity floor so a new company can't jump to #1 from ~$0),
  and the per-product boards (bread / coffee / milk-retail / wheat-supplier /
  milk-supplier). Rows link to the company's profile.
- **Metrics aggregate across all of a company's businesses** and are recorded
  only from *committed* economic events — inside the same transaction as the
  money movement — so a failed sale or a rejected double-fulfill never inflates
  a statistic, and everything survives logout/reconnect/restart. Rankings are
  computed on demand with a short (5s) cache; no per-tick global scans.

Data model: a single append-only `company_activity` table (migration 006)
carries the per-product *unit* flows the ledger doesn't; recent revenue / net /
growth are derived from the existing `economic_ledger`. Company reputation is an
activity-weighted average of its businesses' reputations.

All 68 unit tests (incl. 8 new ranking tests) and five browser E2Es
(golden-path, supply-chain, contract, company, and the new rankings flow) pass;
production build succeeds.

---

# V2.1 — COMPANY FOUNDATION & MULTI-BUSINESS EXPANSION

Introduces a persistent **Company** that every player owns exactly one of; a
company owns one or more businesses (still only the existing four types —
Farm, Coffee Shop, Bakery, Mini Market). Existing players are migrated safely:
each gets a company (named `<username> Co.`), their existing business attaches
to it, and all cash, inventory, levels, contracts, orders, ledger and
reputation are preserved. The player's cash is reused as the company treasury.

- **Multiple businesses per company**: a player starts with one business and
  can later OPEN a NEW BUSINESS by picking a vacant lot (the lot's kind sets
  the type) and paying an escalating opening cost ($15k / $40k / $90k / …),
  recorded as a `BUSINESS_OPENING` ledger entry. Opening is atomic and guarded
  against double-open (per-player lock + in-transaction lot re-check).
- **Management Capacity** — the one specialization constraint that protects the
  player-driven economy. Each business consumes capacity (Farm 2, Coffee Shop /
  Bakery / Mini Market 3); company capacity grows with company level
  (L1 4, L2 6, L3 8, L4 10, L5 12). Opening a business that would exceed
  capacity is rejected with no cash lost.
- **Company progression** is separate from business XP: earned from meaningful
  activity (upgrades, trades, contract deliveries, revenue) and mainly unlocks
  capacity — deliberately hard to farm.
- **Inventory stays per-business** (no shared company pool; no internal
  transfer). Orders and contracts are business-scoped; actions target the
  currently-selected business, defaulting to the only one for single-business
  play.
- **UI**: company identity in the HUD (name · level · capacity used/total), a
  compact MY BUSINESSES switcher (click a chip to focus the building and open
  its management panel), an open-new-business flow (also reachable by clicking a
  vacant lot), rename-company with validation, and the owning company shown in
  public inspection and on contracts.

Everything else — production, NPC sales, wholesaler, marketplace, trades,
deliveries, contracts, ledger, offline progression, reconnect, upgrades,
public inspection — is preserved. All 60 unit tests (incl. 11 new company
tests) and four browser E2Es (golden-path, supply-chain, contract, and the new
V2.1 company flow) pass; production build succeeds.

---

# RELEASE CANDIDATE

All gameplay phases (1, 1.5, 2, 3) are complete and the game has had a
visual-polish & game-feel pass to make it read as a finished browser tycoon
rather than a prototype:

- **Visuals**: distance-based building labels (raised above roofs, fade when
  zoomed out); sale popups repositioned so they no longer collide with labels;
  enlarged ground + tuned fog so there is no visible "map edge"; NPC houses
  moved off business lots; countryside tree belt ringing the district; subtle
  vacant-lot signs; a pulsing ground ring highlights the selected/focused lot.
- **Entry / feel**: instant loading screen (title + progress) before the city
  renders; business-selection cards tagged Producer / Processor + Retailer /
  Retailer; delivery-arrival and level-up popups; throttled, tidy sale feedback.
- **Production readiness**: `NODE_ENV=production` disables all dev tools
  (verified inaccessible); health endpoint checks DB reachability; configurable
  CORS; same-origin client URL resolution; `docker-compose.prod.yml` + Caddy
  reverse-proxy config; `DEPLOYMENT.md` with backup procedure.

No new gameplay systems were added in this phase. All 49 unit tests and the
three browser E2Es (golden-path, supply-chain, contract) pass; production build
succeeds. Ready for deployment to a small VPS.

---

# PHASE 3 — PLAYER BUSINESS RELATIONSHIPS

Phases 1, 1.5 and 2 are complete. Phase 3 adds **recurring supply contracts**
plus a small **public business inspection** panel — reusing the existing
marketplace economy, delivery system, ledger, persistence and reputation.

A buyer inspects a compatible seller's business and proposes a fixed contract
(product, quantity, unit price, number of deliveries). The seller ACCEPTs or
REJECTs. An ACTIVE contract executes server-side once per "game day" (~45s):
it validates seller stock and buyer funds, moves money and goods exactly once
(guarded like marketplace fulfillment), creates a normal delivery van, and
decrements remaining deliveries until COMPLETED. Insufficient stock/funds are
skipped safely (MISSED — SUPPLIER STOCK / BUYER FUNDS) and rescheduled, never
moving money or goods. Contracts persist across restarts and execute while
players are offline. Only fixed contracts — no negotiation, penalties, or
dynamic pricing.

Compatibility: Bakery↔Farm (wheat), Coffee Shop↔Farm (milk),
Mini Market↔Farm (milk), Mini Market↔Bakery (bread).

---

# PHASE 2 — BUSINESS NETWORK (complete)

Phase 1 (Playable Economy MVP) and Phase 1.5 (hardening) are complete.
Phase 2 adds exactly two business types (**Bakery**, **Mini Market**) and two
products (**Wheat**, **Bread**), creating the interconnected chain:

```
FARM ─ milk ──→ COFFEE SHOP ─→ customers
  └── wheat ──→ BAKERY ─ bread ──→ MINI MARKET ─→ customers
```

Farms choose Milk or Wheat production; bakeries bake wheat into bread;
mini markets are pure retail (bread + milk, two prices). Central Wholesale
provides fallback supply for all inputs; player suppliers can profitably
undercut it. Everything reuses the existing marketplace, deliveries,
inventory, ledger, upgrades, offline progression and persistence.

---

# PHASE 1 — PLAYABLE ECONOMY MVP (complete)

## Goal

Prove the core gameplay hypothesis:

> "Is it fun to own a visible business inside a shared city, produce goods,
> trade those goods with another player, and use the resulting profit to grow
> the business?"

## In scope

- Two player business types: **Farm** and **Coffee Shop** (3 upgrade levels each, visibly different)
- Three products: **Milk**, **Coffee Beans**, **Coffee**
- One shared persistent city with roads, scenery, NPC buildings and city life
- Server-authoritative economy: money, inventory, production, trades, deliveries
- Player marketplace: buy/sell orders for milk & beans, partial fulfillment, history
- NPC wholesaler (Central Wholesale) as guaranteed supply fallback
- Visible NPC customers and delivery vans on the road network
- Lightweight accounts, XP/levels 1–10, reputation 1.0–5.0
- Offline progression (capped 8 h) with "While you were away" report
- Reconnect handling + full persistence across server restarts
- Dev tools (disabled in production)

## Explicitly out of scope

Everything in ROADMAP.md phases 2–5: more business types, employees, player
logistics, banking, contracts, chat, leaderboards, weather, day/night, multiple
businesses per player, and so on.
