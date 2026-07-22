# BUSINESS DISTRICT

A browser-based, persistent, multiplayer business simulation set in a stylized
low-poly 3D city. Own a **Farm** or a **Coffee Shop**, produce and trade real
goods with other players on a live marketplace, watch delivery vans carry your
milk across town, and grow your business.

**Current phase: PHASE 1 — PLAYABLE ECONOMY MVP** (see [CURRENT_PHASE.md](CURRENT_PHASE.md))

![stack](https://img.shields.io/badge/stack-TypeScript%20%C2%B7%20Three.js%20%C2%B7%20Node%20%C2%B7%20PostgreSQL-blue)

## The core loop

```
FARM ──produces──▶ MILK ──marketplace──▶ COFFEE SHOP ──sells──▶ COFFEE ──▶ NPC CUSTOMERS ──▶ MONEY ──▶ UPGRADES
```

- The server is **authoritative** for all money, inventory, production, trades
  and deliveries. The client only sends intent.
- Everything persists in PostgreSQL — restart the server and the city carries on.
- Businesses keep working while you're offline (capped at 8 h); you get a
  "While you were away" report on login.
- An NPC wholesaler ("Central Wholesale") guarantees supply so nobody is ever
  blocked by another player being offline — but player milk is cheaper.

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
| Upgrade | Business panel → Upgrade tab (3 levels, visible in the city) |

Coffee Shop: buy beans + milk → coffee brews automatically → NPC customers
walk up and buy it at your price. Farm: milk produces automatically → sell it
on the marketplace (undercut the NPC's $15 and coffee shops will come to you).

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
npm run dev     # in one terminal
npm run e2e     # in another
```

All money movements (NPC purchases, coffee sales, market escrow/refunds/trades,
upgrades) are recorded in the append-only `economic_ledger` table for debugging:
`SELECT * FROM economic_ledger WHERE player_id = $1 ORDER BY id;`

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
