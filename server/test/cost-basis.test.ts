// V2.8 Phase 3 — inventory cost basis (weighted-average acquisition cost) and
// production cost inheritance. Real prices only; never a fake Central price.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld, forceDeliveries } from './helpers.js';
import { closeDb } from '../src/db.js';
import { type World, type BizRec } from '../src/game/world.js';
import { xpForBizLevel, type ProductId } from '@district/shared';

let world: World;
beforeEach(async () => {
  await resetDb();
  world = await loadedWorld();
});
afterAll(async () => {
  await closeDb();
});

async function biz(name: string, type: 'farm' | 'bakery' | 'coffee_shop', level = 1): Promise<{ id: number; b: BizRec }> {
  const id = await newPlayer(world, name);
  const b = await world.chooseBusiness(id, type);
  b.bizXp = xpForBizLevel(level); b.bizLevel = level; b.level = 3;
  world.players.get(id)!.cash = 100_000_000;
  return { id, b };
}
const cb = (b: BizRec, p: ProductId): number => b.costBasis.get(p) ?? 0;

/** Farm lists a sell order at `price`; buyer fulfills `qty` and it gets delivered. */
async function buyFromFarm(buyerId: number, farmId: number, farmBiz: BizRec, product: ProductId, qty: number, price: number): Promise<void> {
  farmBiz.inv.set(product, { qty: qty + 10, reserved: 0 });
  const order = await world.createOrder(farmId, 'sell', product, qty, price, farmBiz.id);
  await world.fulfillOrder(buyerId, order.id, qty);
  await forceDeliveries(world);
}

describe('acquisition cost basis', () => {
  it('a marketplace purchase records the REAL price paid', async () => {
    const farm = await biz('cbf1', 'farm');
    const bak = await biz('cbb1', 'bakery');
    await buyFromFarm(bak.id, farm.id, farm.b, 'wheat', 100, 6);
    expect(bak.b.inv.get('wheat')!.qty).toBe(100);
    expect(cb(bak.b, 'wheat')).toBeCloseTo(6, 5);
  });

  it('a Central Wholesale purchase records the wholesale price (a real acquisition)', async () => {
    const bak = await biz('cbb2', 'bakery');
    await world.buyNpc(bak.id, 'wheat', 100);
    await forceDeliveries(world);
    expect(bak.b.inv.get('wheat')!.qty).toBe(100);
    expect(cb(bak.b, 'wheat')).toBeGreaterThan(0);
  });

  it('blends multiple acquisitions into a weighted average', async () => {
    const farm = await biz('cbf3', 'farm');
    const bak = await biz('cbb3', 'bakery');
    await buyFromFarm(bak.id, farm.id, farm.b, 'wheat', 100, 6);  // 100 @ 6
    await buyFromFarm(bak.id, farm.id, farm.b, 'wheat', 100, 10); // +100 @ 10
    expect(bak.b.inv.get('wheat')!.qty).toBe(200);
    expect(cb(bak.b, 'wheat')).toBeCloseTo(8, 5); // (100*6 + 100*10)/200
  });

  it('partial consumption leaves the weighted average unchanged', async () => {
    const farm = await biz('cbf4', 'farm');
    const bak = await biz('cbb4', 'bakery');
    await buyFromFarm(bak.id, farm.id, farm.b, 'wheat', 100, 8);
    // Sell half back on the market: WAC of the remaining stock is still 8.
    await world.createOrder(bak.id, 'sell', 'wheat', 50, 12, bak.b.id);
    expect(cb(bak.b, 'wheat')).toBeCloseTo(8, 5);
  });
});

describe('production cost inheritance', () => {
  it('finished bread inherits its wheat cost (2 wheat -> 1 bread @ WAC 8 => 16)', async () => {
    const farm = await biz('pcf1', 'farm');
    const bak = await biz('pcb1', 'bakery');
    await buyFromFarm(bak.id, farm.id, farm.b, 'wheat', 200, 8);
    await world.startProduction(bak.id, bak.b.id, 'bread', 50); // needs 100 wheat
    await world.devCommand(bak.id, 'finish_production', 0, bak.b.id);
    expect(bak.b.inv.get('bread')!.qty).toBe(50);
    expect(cb(bak.b, 'bread')).toBeCloseTo(16, 5); // 2 wheat * 8
  });

  it('unknown ingredient cost surfaces as unavailable (no fake Central price)', async () => {
    const bak = await biz('pcb2', 'bakery');
    // Wheat added WITHOUT a tracked purchase price (cost basis stays 0/unknown).
    bak.b.inv.set('wheat', { qty: 500, reserved: 0 });
    const line = (world as any).toProductionLine(bak.b);
    const bread = line.producible.find((p: any) => p.product === 'bread');
    expect(bread.unitInputCost).toBe(-1); // unavailable, never substituted
  });

  it('known ingredient cost yields a positive per-unit input cost in the planner', async () => {
    const farm = await biz('pcf3', 'farm');
    const bak = await biz('pcb3', 'bakery');
    await buyFromFarm(bak.id, farm.id, farm.b, 'wheat', 200, 7);
    const line = (world as any).toProductionLine(bak.b);
    const bread = line.producible.find((p: any) => p.product === 'bread');
    expect(bread.unitInputCost).toBeCloseTo(14, 5); // 2 wheat * 7
    expect(bread.retailPrice).toBeGreaterThan(0);
  });
});

describe('persistence & integrity', () => {
  it('cost basis survives a restart', async () => {
    const farm = await biz('cbr1', 'farm');
    const bak = await biz('cbr2', 'bakery');
    await buyFromFarm(bak.id, farm.id, farm.b, 'wheat', 100, 9);
    await world.startProduction(bak.id, bak.b.id, 'bread', 40); // 80 wheat -> 40 bread
    await world.devCommand(bak.id, 'finish_production', 0, bak.b.id);
    await world.flush();
    const w2 = await loadedWorld();
    const b2 = w2.bizByOwner(bak.id)!;
    expect(b2.costBasis.get('bread')).toBeCloseTo(18, 5); // 2 wheat * 9
    expect(b2.costBasis.get('wheat')).toBeCloseTo(9, 5);
  });

  it('cost basis is never negative or NaN', async () => {
    const farm = await biz('cbn1', 'farm');
    const bak = await biz('cbn2', 'bakery');
    await buyFromFarm(bak.id, farm.id, farm.b, 'wheat', 100, 5);
    for (const [, v] of bak.b.costBasis) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});
