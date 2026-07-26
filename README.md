# BUSINESS DISTRICT

A browser-based, persistent, multiplayer business simulation set in a stylized
low-poly 3D city. Run a **Farm**, **Coffee Shop**, **Bakery** or **Mini Market**,
produce and trade real goods with other players on a live marketplace, form
recurring **supply contracts**, watch delivery vans carry goods across town, and
grow your business.

**Status: RELEASE CANDIDATE** — all gameplay (trading, supply chains, contracts)
plus a visual/game-feel polish pass. See [CURRENT_PHASE.md](CURRENT_PHASE.md).
For production deployment on a small VPS, see [DEPLOYMENT.md](DEPLOYMENT.md).

![stack](https://img.shields.io/badge/stack-TypeScript%20%C2%B7%20Three.js%20%C2%B7%20Node%20%C2%B7%20PostgreSQL-blue)

## The core loop

```
FARM ─produces─▶ MILK/WHEAT ─marketplace─▶ COFFEE SHOP / BAKERY ─manufacture─▶ COFFEE / BREAD ─▶ NPC CUSTOMERS ─▶ MONEY ─▶ LEVEL UP
```

- The server is **authoritative** for all money, inventory, production, trades
  and deliveries. The client only sends intent.
- Everything persists in PostgreSQL — restart the server and the city carries on.
- **Player-first economy:** finished goods (coffee, bread, cakes, lattes…) come
  only from players manufacturing them. The city genuinely needs other players.
- Farms auto-produce their chosen **raw** good; every **finished** good is made
  by the player through a manual **production queue** (start a batch, ingredients
  are committed up front, it completes on a timer).
- Businesses keep working while you're offline (capped at 8 h); you get a
  "While you were away" report on login.
- **Central Wholesale** is an NPC supplier of **raw materials only** (milk,
  beans, wheat, eggs, strawberries). It guarantees nobody is ever hard-blocked
  by another player being offline, but player-supplied raw goods are cheaper; it
  never sells finished goods and its **emergency** (out-of-stock) price is a
  deliberately expensive backstop, not the normal rate.

## The city

The world is split into districts that share one economy:

| District | Role | Lots |
|---|---|---|
| **Old Town** | the original commercial centre | 18 |
| **Green Valley** | first expansion, more open and greener | 24 |

A company may own businesses in any district on one company-wide management
capacity pool. The marketplace, contracts, Central Wholesale, rankings, market
share and city events are all city-wide. Deliveries drive between districts over
a connecting highway. See `DECISIONS.md` for how to add another district.

## Quick start (Docker)

```bash
cp .env.example .env
docker compose up
```

Then open **http://localhost:5173** in two browser windows (use a private
window for the second account), create two accounts, pick a Coffee Shop and a
Farm, and trade.

## Quick start (manual)

Requirements: Node 22+, PostgreSQL 16+.

```bash
# 1. database
createuser district --pwprompt        # password: district
createdb business_district -O district

# 2. install, migrate, seed
npm install
npm run migrate
npm run seed

# 3. run server + client (two terminals or one)
npm run dev
```

- Client: http://localhost:5173
- Server: http://localhost:2567 (REST auth + WebSocket at `/ws`)

Configuration via environment (see `.env.example`): `DATABASE_URL`, `PORT`,
`VITE_SERVER_URL`, `DEV_TOOLS` (set `DEV_TOOLS=0` or `NODE_ENV=production` to
disable in-game dev tools).

## How to play

| Action | How |
|---|---|
| Camera | **WASD** pan · **drag** rotate · **wheel** zoom · **R** reset |
| Select | **Left-click** a building |
| Manage your business | Click your building or the **Business** nav button |
| Buy from the NPC wholesaler | Click the blue **Central Wholesale** depot |
| Trade with players | **Market** nav button — create/fulfill buy & sell orders |
| Manufacture goods | Business panel → **Produce** tab (start/queue a batch) |
| Move stock inside your company | Inventory tab → **internal transfer** (10% fee) |
| Upgrade the facility | Business panel → Upgrade tab (**Facility Tier** 1–3, visible in the city) |

Coffee Shop: buy beans + milk → start a **coffee** batch on the Produce tab →
NPC customers walk up and buy it at your price. Farm: pick milk or wheat → it
produces automatically → sell it on the marketplace (undercut Central Wholesale
and coffee shops & bakeries will come to you).

## Progression & economy (V2.8)

- **Company** — you own one company; it holds cash and a management-capacity pool
  and levels up as your businesses do. It can own many businesses across districts.
- **Business Level (1–50)** — each business earns **Business XP** (from
  manufacturing and from NPC retail sales) and levels independently. Higher
  Business Level = more product **license slots**, faster production, a deeper
  production queue, and (from Lv 20) a permanent **specialization**.
- **Facility Tier (1–3)** — the physical upgrade you buy on the Upgrade tab
  (bigger storage / throughput). Distinct from Business Level, and visible in the
  city. *("Business Level" and "Facility Tier" are two different things.)*
- **Product licenses & active slots** — a business licenses the products it may
  handle; only a bounded number can be **active** at once (the slot count grows
  with Business Level), so you specialize your line-up.
- **Production queue** — finished goods are made in manual batches: ingredients
  are committed the moment you start, batches run on a wall-clock timer, and you
  can stop the line (the in-progress batch finishes; queued batches are cancelled
  and refunded).
- **Specialization** — a permanent Lv 20 choice (two disjoint paths per type)
  giving modest, family-scoped bonuses, with mastery tiers at Lv 30/40/50.
- **Customer Satisfaction (0–100)** — a per-business score driven **only** by NPC
  retail outcomes (fair sales raise it, gouging and stockouts lower it), smoothed
  and always recoverable. Its **only** effect is a bounded multiplier on the
  Business XP from NPC sales. It is **separate from Reputation** (the ★ score that
  reflects fair pricing) — the two never feed each other.
- **Internal company transfers** — move stock between your own businesses. This
  is a physical delivery plus a **10% logistics fee** paid to the city (reference
  price is the normal Central Wholesale base, never the emergency price). A
  transfer creates **no** revenue, XP, market activity or trade count; the
  receiving cost basis is the source's cost basis plus the per-unit fee.

## Tests

```bash
npm test
```

Covers inventory rules, production, cash transactions, marketplace
creation/fulfillment/cancellation, duplicate-transaction protection (including
concurrent double-fulfil), upgrades, offline progression, restart persistence,
the economic ledger, and a full Player A ↔ Player B trade integration scenario.
Tests use a separate `business_district_test` database (`createdb business_district_test -O district`).

Browser E2E (golden path — two players trading through the real UI). Requires
the dev stack running and Playwright's Chromium (`npx playwright install chromium`):

```bash
npm run dev            # in one terminal
npm run e2e            # golden path: Farm ↔ Coffee Shop milk trade
npm run e2e:chain      # Phase 2: Farm → Bakery → Mini Market chain
npm run e2e:contract   # Phase 3: recurring supply contract (Farm → Bakery)
npm run e2e:company    # V2.1: company, multi-business, management capacity
npm run e2e:rankings   # V2.2: market share & city rankings
npm run e2e:events     # V2.3: city events & dynamic demand
npm run e2e:experience # V2.4: Mira tutorial, brief, What's New
npm run e2e:wholesale  # V2.5: finite wholesale & market integrity
npm run e2e:districts  # V2.6: districts, expansion & cross-district delivery
npm run e2e:storage    # V2.6.2: storage capacity invariant & waiting deliveries
npm run e2e:chat       # V2.7: City Chat realtime + moderation
npm run e2e:admin      # V2.7: admin console live ops + hard delete
npm run e2e:negotiation # V2.7: direct messaging, offers & counter-offers
npm run e2e:urgent     # V2.7 Phase 4: urgent city order race (exactly one winner)
npm run e2e:citynews   # V2.7 Phase 4: rival alerts & city news from committed data
npm run e2e:mobile     # V2.7 mobile: touch camera (drag/pinch/rotate), tap-vs-drag, responsive UI
npm run e2e:economy    # V2.8 Phase 1: product licenses, business levels, recipes
npm run e2e:production  # V2.8 Phase 2: manual production queue, batches, exactly-once
npm run e2e:supply-economy # V2.8 Phase 3: supply chains, demand & player-sourced ratio
npm run e2e:specialization # V2.8 Phase 4: specialization, mastery & controlled automation
npm run e2e:customer-experience # V2.8.2: satisfaction, Business XP visibility, stockout/recovery
npm run e2e:internal-transfer   # V2.8.2: internal transfer, 10% fee, cost basis, no XP/market
```

`e2e:admin` also covers **live player presence** (online/offline, multi-device,
force-logout/suspend updating the admin console in realtime).

## Mobile / touch

The city is fully playable from a mobile browser — no keyboard or mouse needed.
Camera controls are gesture-based (touch capability is detected, not viewport
width, so hybrid touch laptops keep both input paths):

- **one-finger drag** — pan the city
- **pinch** — zoom
- **two-finger drag** — rotate the camera
- **tap** — select a business / lot

Desktop keeps WASD · right-drag rotate · middle-drag pan · wheel zoom · click
select. Panels become full-screen sheets on phones (docked on tablet/desktop),
the bottom navigation scrolls, safe-area insets and the soft keyboard are
handled via `visualViewport`, and the renderer caps its pixel ratio on touch
devices. There is no virtual joystick or D-pad — navigation is gesture-only.

Each E2E creates fresh persistent businesses; the shared city has a limited
number of lots, so reset the dev database and restart the server if you run
them many times:

```bash
docker compose exec db psql -U district -d business_district \
  -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
npm run migrate
```

Run them **one at a time from a fresh database**. `e2e:rankings` and
`e2e:experience` assert on city-wide aggregates (market share, city rank,
upcoming events), so businesses left behind by an earlier suite will make them
fail even though the code is correct.

All money movements (NPC purchases, coffee sales, market escrow/refunds/trades,
upgrades) are recorded in the append-only `economic_ledger` table for debugging:
`SELECT * FROM economic_ledger WHERE player_id = $1 ORDER BY id;`

## Admin & Live Ops

Admins (players with `is_admin`) get an in-game **Live Ops** console: dashboard,
player search/management, cash/inventory adjustments, full Central Wholesale
control, announcements, an audit viewer, and hard delete. Routine live
administration no longer requires direct database access. Every consequential
action is recorded in `admin_audit_log`.

**Live player presence** (admin-only): the console shows who is connected in
realtime — an online/offline indicator on every player, an online count on the
dashboard, All/Online/Offline/Suspended filters, and a detail view with the live
connection count, last-seen and session-start. Presence is server-authoritative
(derived from the actual WebSocket connections, player-based not socket-based, so
multi-device stays online until the last connection closes) and updates without a
refresh on connect/disconnect/force-logout/suspend/delete. Admins can also **set
Customer Satisfaction** on a business (0–100, reason required, audited). None of
this is exposed to normal players.

## Storage over-capacity report

List any businesses whose stored inventory exceeds capacity (read-only, never
deletes goods — legacy data from before the V2.6.2 invariant):

```bash
npm run report:overflow -w server
```

## Production build

```bash
npm run build        # typechecks everything + builds client to client/dist
NODE_ENV=production npm start
```

Serve `client/dist` from any static host and point `VITE_SERVER_URL` at the
server when building.

## Repository layout

```
client/   Vite + TypeScript + Three.js game client (procedural 3D city, UI, audio)
server/   Node + TypeScript authoritative game server (Express auth, ws realtime,
          world simulation, marketplace, deliveries) + migrations + tests
shared/   Data-driven definitions shared by both: products, business levels,
          city map, road-network pathfinding, wire protocol types
docs/     (reserved)
```

Design documents: [GAME_VISION.md](GAME_VISION.md) ·
[ROADMAP.md](ROADMAP.md) · [CURRENT_PHASE.md](CURRENT_PHASE.md) ·
[DECISIONS.md](DECISIONS.md) · [THIRD_PARTY_ASSETS.md](THIRD_PARTY_ASSETS.md)
