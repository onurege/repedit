import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld } from './helpers.js';
import { closeDb } from '../src/db.js';
import { FARM_LEVELS, SHOP_LEVELS, OFFLINE_CAP_SECONDS, storageMultForLevel } from '@district/shared';

// V2.8 Phase 3: farm production fills the REAL capacity (base facility store x
// the business-level storage bonus, which production XP raises over time).
const farmCap = (biz: any) => Math.round(FARM_LEVELS[biz.level].milkCapacity * storageMultForLevel(biz.bizLevel));
import type { World } from '../src/game/world.js';

let world: World;

beforeEach(async () => {
  await resetDb();
  world = await loadedWorld();
});

afterAll(async () => {
  await closeDb();
});

describe('farm production', () => {
  it('produces milk over time at the level rate', async () => {
    const pid = await newPlayer(world, 'farmer');
    const biz = await world.chooseBusiness(pid, 'farm');
    world.simulate(biz, 100, true); // 100s at 0.5/s = 50 milk
    expect(biz.inv.get('milk')!.qty).toBe(50);
    expect(biz.milkProduced).toBe(50);
    expect(biz.status).toBe('producing');
  });

  it('never exceeds storage capacity and pauses when full', async () => {
    const pid = await newPlayer(world, 'farmer2');
    const biz = await world.chooseBusiness(pid, 'farm');
    world.simulate(biz, 100000, true);
    // Filled to capacity (production XP raises the level/cap as it fills, so the
    // final fill lags the new cap by up to a step — never overflows it).
    expect(biz.inv.get('milk')!.qty).toBeGreaterThanOrEqual(FARM_LEVELS[1].milkCapacity);
    expect(biz.inv.get('milk')!.qty).toBeLessThanOrEqual(farmCap(biz));
    expect(biz.status).toBe('storage_full');
    // full storage must not bank production for later
    world.simulate(biz, 1, true);
    expect(biz.prodAccum).toBeLessThanOrEqual(1.5);
  });

  it('awards XP for production', async () => {
    const pid = await newPlayer(world, 'farmer3');
    const biz = await world.chooseBusiness(pid, 'farm');
    world.simulate(biz, 20, true);
    expect(world.players.get(pid)!.xp).toBeGreaterThan(0);
  });
});

describe('coffee shop', () => {
  // V2.8 Phase 2: coffee is manufactured via the manual production line, not
  // auto-brewed in the tick. Retail (NPC sales) now drains FINISHED coffee stock.
  it('sells only from finished coffee stock and stops without it', async () => {
    const pid = await newPlayer(world, 'barista');
    const biz = await world.chooseBusiness(pid, 'coffee_shop');
    const p = world.players.get(pid)!;
    const cashBefore = p.cash;

    // No finished coffee (even with ingredients): retail sells nothing.
    biz.inv.get('milk')!.qty = 50;
    biz.inv.get('beans')!.qty = 50;
    world.simulate(biz, 300, true);
    expect(biz.coffeeSold).toBe(0);
    expect(p.cash).toBe(cashBefore);
    expect(biz.status).toBe('out_of_stock');

    // Give finished coffee: sales happen and drain the stock (ingredients untouched).
    biz.inv.get('coffee')!.qty = 50;
    world.simulate(biz, 300, true);
    expect(biz.coffeeSold).toBeGreaterThan(0);
    expect(biz.inv.get('milk')!.qty).toBe(50);   // retail no longer consumes inputs
    expect(biz.inv.get('beans')!.qty).toBe(50);
    expect(biz.coffeeSold + biz.inv.get('coffee')!.qty).toBe(50);
    expect(p.cash).toBe(cashBefore + biz.coffeeSold * biz.price);
    expect(biz.revenue).toBe(biz.coffeeSold * biz.price);
  });

  it('sells faster at higher levels', async () => {
    const pid = await newPlayer(world, 'barista2');
    const biz = await world.chooseBusiness(pid, 'coffee_shop');
    biz.inv.get('coffee')!.qty = 1000;
    world.simulate(biz, 600, true);
    const soldL1 = biz.coffeeSold;
    biz.level = 3;
    biz.coffeeSold = 0;
    biz.inv.get('coffee')!.qty = 1000;
    world.simulate(biz, 600, true);
    expect(biz.coffeeSold).toBeGreaterThan(soldL1 * 2);
    expect(SHOP_LEVELS[3].customersPerSec).toBeGreaterThan(SHOP_LEVELS[1].customersPerSec);
  });

  it('loses reputation when customers find no coffee', async () => {
    const pid = await newPlayer(world, 'barista3');
    const biz = await world.chooseBusiness(pid, 'coffee_shop');
    const repBefore = biz.reputation;
    world.simulate(biz, 600, true); // no stock at all
    expect(biz.reputation).toBeLessThan(repBefore);
  });
});

describe('offline catch-up', () => {
  it('caps aggregated progression at OFFLINE_CAP_SECONDS', async () => {
    const pid = await newPlayer(world, 'idler');
    const biz = await world.chooseBusiness(pid, 'farm');
    world.catchUp(biz, OFFLINE_CAP_SECONDS * 10); // absurd downtime
    // capped: at most cap * rate (and clamped by storage anyway)
    expect(biz.milkProduced).toBeLessThanOrEqual(OFFLINE_CAP_SECONDS * FARM_LEVELS[1].milkPerSec + 1);
    expect(biz.inv.get("milk")!.qty).toBeLessThanOrEqual(farmCap(biz));
  });
});
