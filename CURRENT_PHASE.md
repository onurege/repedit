# V2.3 — DYNAMIC CITY DEMAND & CITY EVENTS (current)

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
