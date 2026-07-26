// V2.8 Phase 1 — Central Wholesale player-first reference pricing, manipulation
// protection, safe fallback, and the Player-Sourced Input Ratio.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld } from './helpers.js';
import { closeDb, query } from '../src/db.js';
import { type World } from '../src/game/world.js';
import { NPC_WHOLESALE_PRICES, WHOLESALE_LOT_ID } from '@district/shared';

let world: World;
let buyer = 0, seller = 0;
beforeEach(async () => {
  await resetDb();
  world = await loadedWorld();
  buyer = await newPlayer(world, 'buy');
  seller = await newPlayer(world, 'sell');
});
afterAll(async () => {
  await closeDb();
});

// Insert N completed marketplace trades for `product` (real trades table rows).
async function trades(product: string, rows: { price: number; qty: number }[], b = buyer, s = seller): Promise<void> {
  const o = await query(
    `INSERT INTO market_orders (player_id, side, product, qty, remaining, price) VALUES ($1,'sell',$2,1000,0,10) RETURNING id`,
    [s, product]
  );
  const orderId = o.rows[0].id;
  for (const r of rows) {
    await query(`INSERT INTO trades (order_id, buyer_id, seller_id, product, qty, price) VALUES ($1,$2,$3,$4,$5,$6)`,
      [orderId, b, s, product, r.qty, r.price]);
  }
}

describe('wholesale reference price (manipulation-resistant)', () => {
  it('derives a volume-weighted median from completed player trades', async () => {
    await trades('wheat', [
      { price: 7, qty: 100 }, { price: 8, qty: 100 }, { price: 8, qty: 100 },
      { price: 9, qty: 100 }, { price: 9, qty: 100 },
    ]);
    const ref = await world.wholesaleReference('wheat');
    expect(ref).toBe(8); // weighted median
  });

  it('a single extreme outlier does not dominate the reference', async () => {
    await trades('wheat', [
      { price: 7, qty: 100 }, { price: 7, qty: 100 }, { price: 8, qty: 100 },
      { price: 8, qty: 100 }, { price: 8, qty: 100 }, { price: 999, qty: 5 }, // spike, tiny volume
    ]);
    const ref = await world.wholesaleReference('wheat');
    expect(ref).toBeLessThanOrEqual(9); // spike ignored by weight + median
  });

  it('tiny-volume wash trades do not establish a price (min volume)', async () => {
    await trades('wheat', [
      { price: 3, qty: 1 }, { price: 3, qty: 1 }, { price: 3, qty: 1 },
      { price: 3, qty: 1 }, { price: 3, qty: 1 }, // 5 trades but only 5 total units
    ]);
    expect(await world.wholesaleReference('wheat')).toBeNull(); // below min volume -> fallback
  });

  it('insufficient history returns null (safe fallback to base)', async () => {
    await trades('wheat', [{ price: 7, qty: 100 }, { price: 8, qty: 100 }]); // < min sample
    expect(await world.wholesaleReference('wheat')).toBeNull();
  });

  it('excludes self-trades (buyer == seller)', async () => {
    await trades('wheat', [
      { price: 50, qty: 100 }, { price: 50, qty: 100 }, { price: 50, qty: 100 },
      { price: 50, qty: 100 }, { price: 50, qty: 100 }, { price: 50, qty: 100 },
    ], seller, seller); // all self-trades
    expect(await world.wholesaleReference('wheat')).toBeNull();
  });

  it('re-priced wholesale stays a premium ABOVE the healthy player price; emergency is worse', async () => {
    // Healthy player price for wheat ~7 (well under the $10 NPC base).
    await trades('wheat', [
      { price: 7, qty: 200 }, { price: 7, qty: 200 }, { price: 7, qty: 200 },
      { price: 7, qty: 200 }, { price: 7, qty: 200 },
    ]);
    const ref = (await world.wholesaleReference('wheat'))!;
    // Drive the conservative repricer to convergence.
    for (let i = 0; i < 30; i++) {
      (world as unknown as { lastWholesaleRepriceMs: number }).lastWholesaleRepriceMs = 0;
      await (world as unknown as { repriceWholesale(n: number): Promise<void> }).repriceWholesale(Date.now());
    }
    const state = world.toWholesaleState().products.find((p) => p.product === 'wheat')!;
    expect(state.basePrice).toBeGreaterThan(ref);            // wholesale > player price
    expect(state.basePrice).toBeGreaterThanOrEqual(Math.round(NPC_WHOLESALE_PRICES['wheat']! * 0.7));
    // Emergency reserve is materially more expensive than normal wholesale.
    expect(state.basePrice * 2.5).toBeGreaterThan(state.basePrice);
  });

  it('wholesale moves conservatively (bounded step), not in one jump', async () => {
    await trades('milk', [
      { price: 40, qty: 300 }, { price: 40, qty: 300 }, { price: 40, qty: 300 },
      { price: 40, qty: 300 }, { price: 40, qty: 300 },
    ]);
    const ws = world.wholesale.get('milk')!;
    const start = ws.basePrice;
    (world as unknown as { lastWholesaleRepriceMs: number }).lastWholesaleRepriceMs = 0;
    await (world as unknown as { repriceWholesale(n: number): Promise<void> }).repriceWholesale(Date.now());
    // One refresh cannot leap all the way to the clamped target.
    const npcBase = NPC_WHOLESALE_PRICES['milk']!;
    expect(Math.abs(ws.basePrice - start)).toBeLessThanOrEqual(Math.max(1, Math.round(npcBase * 0.08)));
  });
});

describe('player-sourced input ratio (deliveries)', () => {
  it('splits committed deliveries into player vs central and reports health', async () => {
    const biz = await world.chooseBusiness(buyer, 'coffee_shop'); // real to_business FK
    // Insert delivered rows: player-sourced (from a business lot) + central (wholesale).
    const mk = async (fromLot: string, product: string, qty: number) =>
      query(`INSERT INTO deliveries (product, qty, from_lot, to_lot, to_business, status, depart_at, arrive_at)
              VALUES ($1,$2,$3,'x',$4,'delivered', now(), now())`, [product, qty, fromLot, biz.id]);
    await mk('coffee_shop_1', 'milk', 80);   // player-sourced
    await mk('coffee_shop_1', 'milk', 20);   // player-sourced
    await mk(WHOLESALE_LOT_ID, 'milk', 25);  // central
    const eco = await world.playerSourcedRatio();
    expect(eco.overall.player).toBe(100);
    expect(eco.overall.central).toBe(25);
    expect(eco.overall.ratio).toBeCloseTo(100 / 125, 3);
    expect(eco.overall.health).toBe('healthy'); // 80% >= 70%
    const milk = eco.byProduct.find((p) => p.product === 'milk')!;
    expect(milk.player).toBe(100);
    expect(milk.central).toBe(25);
  });

  it('is empty (ratio 0) with no deliveries — never invented', async () => {
    const eco = await world.playerSourcedRatio();
    expect(eco.overall.player).toBe(0);
    expect(eco.overall.central).toBe(0);
    expect(eco.overall.ratio).toBe(0);
  });
});
