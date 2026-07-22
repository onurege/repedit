# PHASE 3 — PLAYER BUSINESS RELATIONSHIPS (current)

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
