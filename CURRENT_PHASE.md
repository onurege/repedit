# PHASE 2 — BUSINESS NETWORK (current)

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
