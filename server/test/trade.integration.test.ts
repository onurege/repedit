// The MVP acceptance trade, end to end at the world level:
// Player A (coffee shop) posts BUY 100 MILK @ $12,
// Player B (farm) produces milk and fulfills it,
// delivery completes, state survives a restart.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld, forceDeliveries } from './helpers.js';
import { closeDb, query } from '../src/db.js';
import type { World } from '../src/game/world.js';
import { STARTING_CASH, NPC_WHOLESALE_PRICES } from '@district/shared';

let world: World;

beforeEach(async () => {
  await resetDb();
  world = await loadedWorld();
});

afterAll(async () => {
  await closeDb();
});

it('full Player A / Player B milk trade scenario', async () => {
  // --- Player A: coffee shop start ---
  const aId = await newPlayer(world, 'playerA');
  await world.chooseBusiness(aId, 'coffee_shop');
  const a = world.players.get(aId)!;
  const shopBiz = world.bizByOwner(aId)!;
  expect(a.cash).toBe(STARTING_CASH);

  // Buys beans + milk from the NPC wholesaler.
  await world.buyNpc(aId, 'beans', 40);
  await world.buyNpc(aId, 'milk', 20);
  const npcSpend = 40 * NPC_WHOLESALE_PRICES.beans! + 20 * NPC_WHOLESALE_PRICES.milk!;
  expect(a.cash).toBe(STARTING_CASH - npcSpend);
  await forceDeliveries(world);
  expect(shopBiz.inv.get('beans')!.qty).toBe(40);
  expect(shopBiz.inv.get('milk')!.qty).toBe(20);

  // V2.8 Phase 2: brew a batch (manual production), then NPC customers buy it.
  await world.startProduction(aId, shopBiz.id, 'coffee', 20); // 20 milk + 20 beans -> 20 coffee
  await world.devCommand(aId, 'finish_production', 0, shopBiz.id);
  expect(shopBiz.inv.get('coffee')!.qty).toBe(20);
  world.simulate(shopBiz, 240, true);
  expect(shopBiz.coffeeSold).toBeGreaterThan(0);
  const cashAfterSales = a.cash;
  expect(cashAfterSales).toBeGreaterThan(STARTING_CASH - npcSpend);

  // A posts the acceptance order: BUY 100 MILK @ $12.
  const order = await world.createOrder(aId, 'buy', 'milk', 100, 12);
  expect(a.cash).toBe(cashAfterSales - 1200);

  // --- Player B: farm ---
  const bId = await newPlayer(world, 'playerB');
  await world.chooseBusiness(bId, 'farm');
  const b = world.players.get(bId)!;
  const farmBiz = world.bizByOwner(bId)!;
  world.simulate(farmBiz, 260, true); // produce at least 100 milk (0.5/s)
  expect(farmBiz.inv.get('milk')!.qty).toBeGreaterThanOrEqual(100);
  const bMilkBefore = farmBiz.inv.get('milk')!.qty;
  const bCashBefore = b.cash;
  const aCashBefore = a.cash;
  const aMilkBefore = shopBiz.inv.get('milk')!.qty;

  // B fulfills A's order.
  await world.fulfillOrder(bId, order.id, 100);

  // VERIFY: exactly-once money & goods movement.
  expect(a.cash).toBe(aCashBefore); // A already paid at escrow time
  expect(b.cash).toBe(bCashBefore + 1200);
  expect(farmBiz.inv.get('milk')!.qty).toBe(bMilkBefore - 100);
  expect(world.deliveries.size).toBe(1);
  const delivery = [...world.deliveries.values()][0];
  expect(delivery.product).toBe('milk');
  expect(delivery.qty).toBe(100);
  expect(delivery.fromLot).toBe(farmBiz.lotId);
  expect(delivery.toLot).toBe(shopBiz.lotId);

  // Retry attempts must fail and change nothing.
  await expect(world.fulfillOrder(bId, order.id, 100)).rejects.toThrow();
  expect(b.cash).toBe(bCashBefore + 1200);

  // Delivery arrives: A receives exactly 100 milk, exactly once.
  // (Empty the bean hopper so brewing doesn't consume milk during the check.)
  const beansHeld = shopBiz.inv.get('beans')!.qty;
  shopBiz.inv.get('beans')!.qty = 0;
  await forceDeliveries(world);
  expect(shopBiz.inv.get('milk')!.qty).toBe(aMilkBefore + 100);
  await world.tick(0); // extra tick: no double-credit
  expect(shopBiz.inv.get('milk')!.qty).toBe(aMilkBefore + 100);
  const trades = await query('SELECT * FROM trades');
  expect(trades.rowCount).toBe(1);
  shopBiz.inv.get('beans')!.qty = beansHeld;

  // --- B goes offline; A falls back to NPC milk; shop keeps operating ---
  world.disconnect(bId);
  shopBiz.inv.get('milk')!.qty = 0;
  await world.buyNpc(aId, 'milk', 30);
  await forceDeliveries(world);
  expect(shopBiz.inv.get('milk')!.qty).toBe(30);
  // Brew another batch so retail has finished coffee to sell (manual production).
  await world.startProduction(aId, shopBiz.id, 'coffee', 15);
  await world.devCommand(aId, 'finish_production', 0, shopBiz.id);
  const soldBefore = shopBiz.coffeeSold;
  world.simulate(shopBiz, 120, true);
  expect(shopBiz.coffeeSold).toBeGreaterThan(soldBefore);

  // --- Backend restart: everything persists ---
  await world.flush();
  const world2 = await loadedWorld();
  const a2 = world2.players.get(aId)!;
  const b2 = world2.players.get(bId)!;
  expect(a2.name).toBe('playerA');
  expect(b2.cash).toBe(b.cash);
  const shop2 = world2.bizByOwner(aId)!;
  const farm2 = world2.bizByOwner(bId)!;
  expect(shop2.type).toBe('coffee_shop');
  expect(farm2.type).toBe('farm');
  expect(shop2.level).toBe(shopBiz.level);
  // inventory persisted (allowing catch-up production/sales on top)
  expect(farm2.inv.get('milk')!.qty).toBeGreaterThanOrEqual(farmBiz.inv.get('milk')!.qty);
  expect(shop2.coffeeSold).toBeGreaterThanOrEqual(shopBiz.coffeeSold);
});
