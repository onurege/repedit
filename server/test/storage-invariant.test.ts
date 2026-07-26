// V2.6.2 — storage capacity invariant.
//
// Physical stock (qty + reserved) must never exceed a product's capacity, on
// EVERY inventory-increasing path. Deliveries that cannot fit enter a WAITING
// state instead of overflowing; they unload exactly once when space frees, and
// survive restart. Money and goods always move exactly once.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld } from './helpers.js';
import { closeDb } from '../src/db.js';
import { GameError, type World, type BizRec } from '../src/game/world.js';
import { SHOP_LEVELS, FARM_LEVELS, storageMultForLevel } from '@district/shared';

// V2.8 Phase 3: real capacity = base facility store x business-level storage bonus.
const realFarmCap = (biz: any) => Math.round(FARM_LEVELS[biz.level].milkCapacity * storageMultForLevel(biz.bizLevel));

let world: World;

beforeEach(async () => {
  await resetDb();
  world = await loadedWorld();
});
afterAll(async () => {
  await closeDb();
});

/** The invariant, asserted for a business's every product slot. */
function assertInvariant(biz: BizRec, capOf: (b: BizRec, p: string) => number): void {
  for (const [product, rec] of biz.inv) {
    expect(rec.qty + rec.reserved, `${product} over capacity`).toBeLessThanOrEqual(capOf(biz, product));
  }
}

// Capacity for the coffee-shop ingredient slots (milk/beans) at a given level.
const ingredientCap = (level: number) => SHOP_LEVELS[level].ingredientCapacity;

async function coffeeShop(name: string, level = 3): Promise<{ pid: number; biz: BizRec }> {
  const pid = await newPlayer(world, name);
  const biz = await world.chooseBusiness(pid, 'coffee_shop');
  biz.level = level;
  world.players.get(pid)!.cash = 100_000_000;
  return { pid, biz };
}

async function farm(name: string, product: 'milk' | 'wheat' = 'milk'): Promise<{ pid: number; biz: BizRec }> {
  const pid = await newPlayer(world, name);
  const biz = await world.chooseBusiness(pid, 'farm');
  biz.level = 3;
  world.setProduction(pid, product);
  world.players.get(pid)!.cash = 100_000_000;
  return { pid, biz };
}

/** Force all in-transit deliveries to have arrived, then run one tick. */
async function deliverNow(): Promise<void> {
  for (const d of world.deliveries.values()) if (d.status === 'in_transit') d.arriveAtMs = Date.now() - 1;
  await world.tick(0);
}

describe('storage capacity invariant', () => {
  it('wholesale purchase that fits is accepted', async () => {
    const { pid, biz } = await coffeeShop('fits');
    await world.buyNpc(pid, 'beans', 100);
    await deliverNow();
    expect(biz.inv.get('beans')!.qty).toBe(100);
    assertInvariant(biz, (b, p) => (p === 'coffee' ? SHOP_LEVELS[b.level].coffeeCapacity : ingredientCap(b.level)));
  });

  it('wholesale rejects a purchase that would exceed capacity (before commitment)', async () => {
    const { pid, biz } = await coffeeShop('toobig');
    const cap = ingredientCap(biz.level);
    const before = world.players.get(pid)!.cash;
    await expect(world.buyNpc(pid, 'beans', cap + 1)).rejects.toBeInstanceOf(GameError);
    // No money taken, no delivery created.
    expect(world.players.get(pid)!.cash).toBe(before);
    expect([...world.deliveries.values()].length).toBe(0);
  });

  it('marketplace purchase exceeding capacity is rejected before escrow', async () => {
    const seller = await farm('seller-mp', 'milk');
    seller.biz.inv.get('milk')!.qty = 2000;
    await world.createOrder(seller.pid, 'sell', 'milk', 1000, 5);

    const buyer = await coffeeShop('buyer-mp');
    buyer.biz.inv.get('milk')!.qty = ingredientCap(buyer.biz.level) - 10; // only 10 free
    const order = [...world.orders.values()].find((o) => o.side === 'sell' && o.product === 'milk')!;
    const cashBefore = world.players.get(buyer.pid)!.cash;
    await expect(world.fulfillOrder(buyer.pid, order.id, 500)).rejects.toBeInstanceOf(GameError);
    expect(world.players.get(buyer.pid)!.cash).toBe(cashBefore);
  });

  it('a contract delivery that cannot fit enters WAITING_FOR_STORAGE (no overflow, money once)', async () => {
    const sellerF = await farm('c-seller', 'milk');
    sellerF.biz.inv.get('milk')!.qty = 5000;
    const buyer = await coffeeShop('c-buyer');
    // Buyer nearly full: only 30 milk of room.
    buyer.biz.inv.get('milk')!.qty = ingredientCap(buyer.biz.level) - 30;

    const contract = await world.proposeContract(buyer.pid, sellerF.biz.id, 'milk', 200, 4, 3);
    await world.acceptContract(sellerF.pid, contract.id);
    const buyerCashBefore = world.players.get(buyer.pid)!.cash;
    const sellerCashBefore = world.players.get(sellerF.pid)!.cash;
    const sellerStockBefore = sellerF.biz.inv.get('milk')!.qty;

    await world.executeContract(contract.id);
    await deliverNow();

    // Delivery is waiting, goods NOT in buyer inventory, invariant holds.
    const waiting = [...world.deliveries.values()].filter((d) => d.status === 'waiting' && d.product === 'milk');
    expect(waiting.length).toBe(1);
    expect(buyer.biz.inv.get('milk')!.qty).toBe(ingredientCap(buyer.biz.level) - 30);
    assertInvariant(buyer.biz, (b) => ingredientCap(b.level));
    // Money and seller stock moved exactly once (at execution, not at unload).
    expect(world.players.get(sellerF.pid)!.cash).toBe(sellerCashBefore + 200 * 4);
    expect(buyerCashBefore - world.players.get(buyer.pid)!.cash).toBe(200 * 4);
    expect(sellerStockBefore - sellerF.biz.inv.get('milk')!.qty).toBe(200);
  });

  it('a waiting delivery completes once storage frees, exactly once', async () => {
    const sellerF = await farm('w-seller', 'milk');
    sellerF.biz.inv.get('milk')!.qty = 5000;
    const buyer = await coffeeShop('w-buyer');
    const cap = ingredientCap(buyer.biz.level);
    buyer.biz.inv.get('milk')!.qty = cap - 30; // 30 free, a 200 delivery cannot fit

    const contract = await world.proposeContract(buyer.pid, sellerF.biz.id, 'milk', 200, 4, 3);
    await world.acceptContract(sellerF.pid, contract.id);
    await world.executeContract(contract.id);
    await deliverNow();
    expect([...world.deliveries.values()].some((d) => d.status === 'waiting')).toBe(true);

    // Free enough room (need qty <= cap - 200). Drop to 0.
    buyer.biz.inv.get('milk')!.qty = 0;
    await world.tick(0); // periodic retry unloads the waiting delivery

    expect([...world.deliveries.values()].length).toBe(0);
    expect(buyer.biz.inv.get('milk')!.qty).toBe(200); // unloaded fully, exactly once
    assertInvariant(buyer.biz, (b) => ingredientCap(b.level));
  });

  it('two concurrent deliveries cannot both unload past capacity', async () => {
    const sellerF = await farm('cc-seller', 'milk');
    sellerF.biz.inv.get('milk')!.qty = 5000;
    const buyer = await coffeeShop('cc-buyer');
    const cap = ingredientCap(buyer.biz.level);
    buyer.biz.inv.get('milk')!.qty = 0;
    // Two contracts of 0.4*cap each; together 0.8*cap fits, but if room were only
    // ~0.5*cap only one could unload. Set room so exactly one fits.
    const q = Math.floor(cap * 0.4);
    buyer.biz.inv.get('milk')!.qty = cap - Math.floor(q * 1.5); // room for one q, not two

    for (let i = 0; i < 2; i++) {
      const c = await world.proposeContract(buyer.pid, sellerF.biz.id, 'milk', q, 2, 3);
      await world.acceptContract(sellerF.pid, c.id);
      await world.executeContract(c.id);
    }
    await deliverNow();
    // Exactly one unloaded; the other waits. Invariant holds.
    const waiting = [...world.deliveries.values()].filter((d) => d.status === 'waiting');
    expect(waiting.length).toBe(1);
    assertInvariant(buyer.biz, (b) => ingredientCap(b.level));
  });

  it('a waiting delivery survives restart and unloads exactly once afterwards', async () => {
    const sellerF = await farm('r-seller', 'milk');
    sellerF.biz.inv.get('milk')!.qty = 5000;
    const buyer = await coffeeShop('r-buyer');
    const cap = ingredientCap(buyer.biz.level);
    buyer.biz.inv.get('milk')!.qty = cap - 20;
    const contract = await world.proposeContract(buyer.pid, sellerF.biz.id, 'milk', 200, 4, 3);
    await world.acceptContract(sellerF.pid, contract.id);
    await world.executeContract(contract.id);
    await deliverNow();
    await world.flush();
    expect([...world.deliveries.values()].some((d) => d.status === 'waiting')).toBe(true);

    // Restart.
    const world2 = await loadedWorld();
    const w2 = [...world2.deliveries.values()].filter((d) => d.status === 'waiting');
    expect(w2.length).toBe(1); // waiting delivery restored, goods not lost
    const buyer2 = world2.businesses.get(buyer.biz.id)!;
    buyer2.inv.get('milk')!.qty = 0; // free space
    await world2.tick(0);
    expect([...world2.deliveries.values()].length).toBe(0);
    expect(buyer2.inv.get('milk')!.qty).toBe(200);
  });

  it('a storage upgrade unblocks a waiting delivery', async () => {
    const sellerF = await farm('u-seller', 'milk');
    sellerF.biz.inv.get('milk')!.qty = 5000;
    const buyer = await coffeeShop('u-buyer', 1); // level-1 small storage
    const cap1 = ingredientCap(1);
    buyer.biz.inv.get('milk')!.qty = cap1 - 10;
    const contract = await world.proposeContract(buyer.pid, sellerF.biz.id, 'milk', 50, 4, 3);
    await world.acceptContract(sellerF.pid, contract.id);
    await world.executeContract(contract.id);
    await deliverNow();
    expect([...world.deliveries.values()].some((d) => d.status === 'waiting')).toBe(true);

    world.players.get(buyer.pid)!.cash = 100_000_000;
    await world.upgrade(buyer.pid, buyer.biz.id); // capacity grows -> retry
    // The larger store now fits the 50-unit delivery.
    expect([...world.deliveries.values()].length).toBe(0);
    expect(buyer.biz.inv.get('milk')!.qty).toBe(cap1 - 10 + 50);
    assertInvariant(buyer.biz, (b) => ingredientCap(b.level));
  });

  it('production cannot overflow storage', async () => {
    const { biz } = await farm('prod', 'milk');
    biz.inv.get('milk')!.qty = 0;
    // Many hours of production must never push stock past the current capacity
    // (which grows as production XP raises the business level — evaluate at the end).
    for (let i = 0; i < 50; i++) world.simulate(biz, 3600, true);
    expect(biz.inv.get('milk')!.qty).toBeLessThanOrEqual(realFarmCap(biz));
  });

  it('offline progression cannot overflow storage', async () => {
    const { biz } = await farm('offline', 'milk');
    biz.inv.get('milk')!.qty = 0;
    // A single 8-hour offline catch-up step must still cap at storage.
    world.simulate(biz, 8 * 3600, true);
    expect(biz.inv.get('milk')!.qty).toBeLessThanOrEqual(realFarmCap(biz));
  });

  it('legacy overflow: cannot receive more goods, but can decrease via sales/consumption', async () => {
    const buyer = await coffeeShop('legacy');
    const cap = ingredientCap(buyer.biz.level);
    // Simulate corrupt legacy data: milk far above capacity.
    buyer.biz.inv.get('milk')!.qty = cap + 2657;

    // Wholesale purchase blocked.
    await expect(world.buyNpc(buyer.pid, 'milk', 10)).rejects.toBeInstanceOf(GameError);

    // A contract delivery waits rather than overflowing further.
    const sellerF = await farm('legacy-seller', 'milk');
    sellerF.biz.inv.get('milk')!.qty = 5000;
    const c = await world.proposeContract(buyer.pid, sellerF.biz.id, 'milk', 50, 2, 3);
    await world.acceptContract(sellerF.pid, c.id);
    await world.executeContract(c.id);
    await deliverNow();
    expect([...world.deliveries.values()].some((d) => d.status === 'waiting')).toBe(true);
    // The over-capacity goods were never deleted.
    expect(buyer.biz.inv.get('milk')!.qty).toBe(cap + 2657);

    // While over capacity, it IS flagged by the report (goods intact).
    expect(world.overCapacityReport().find((r) => r.bizId === buyer.biz.id)).toBeDefined();

    // It CAN decrease through outgoing consumption/sale (physical stock leaves
    // the lot). Model that outflow, then the invariant is restored.
    buyer.biz.inv.get('milk')!.qty -= 3000; // consumed / sold to customers over time
    expect(buyer.biz.inv.get('milk')!.qty).toBe(cap + 2657 - 3000); // cap-343, now under
    expect(world.overCapacityReport().find((r) => r.bizId === buyer.biz.id)).toBeUndefined();

    // And the previously-waiting delivery can now unload (space freed).
    await world.tick(0);
    expect([...world.deliveries.values()].some((d) => d.status === 'waiting')).toBe(false);
  });

  it('over-capacity report lists a genuinely over-capacity business without deleting goods', async () => {
    const buyer = await coffeeShop('report');
    const cap = ingredientCap(buyer.biz.level);
    buyer.biz.inv.get('milk')!.qty = cap + 500;
    const report = world.overCapacityReport();
    const row = report.find((r) => r.bizId === buyer.biz.id && r.product === 'milk');
    expect(row).toBeDefined();
    expect(row!.overflow).toBe(500);
    expect(buyer.biz.inv.get('milk')!.qty).toBe(cap + 500); // untouched
  });
});
