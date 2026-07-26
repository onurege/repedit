// V2.8.1 — consistency-release invariants: storage-projected production start,
// queued-job cancel with refund, internal company transfer, tradable source.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld, forceDeliveries } from './helpers.js';
import { closeDb, query } from '../src/db.js';
import { GameError, type World, type BizRec } from '../src/game/world.js';
import { xpForBizLevel, TRADABLE_PRODUCTS, WHOLESALE_PRODUCTS, isRawProduct, lotsOfKind, type ProductId } from '@district/shared';

let world: World;
beforeEach(async () => {
  await resetDb();
  world = await loadedWorld();
});
afterAll(async () => {
  await closeDb();
});

async function shop(name: string, type: 'coffee_shop' | 'bakery' = 'coffee_shop', level = 30): Promise<{ id: number; b: BizRec }> {
  const id = await newPlayer(world, name);
  const b = await world.chooseBusiness(id, type);
  b.bizXp = xpForBizLevel(level); b.bizLevel = level; b.level = 1; // tier-1 facility -> small coffee cap (30)
  world.players.get(id)!.cash = 1_000_000;
  return { id, b };
}
const give = (b: BizRec, p: ProductId, q: number) => b.inv.set(p, { qty: q, reserved: b.inv.get(p)?.reserved ?? 0 });
const onHand = (b: BizRec, p: ProductId) => b.inv.get(p)?.qty ?? 0;

describe('tradable source (single authority)', () => {
  it('the whole catalog is tradable; wholesale is raw-only', () => {
    expect(TRADABLE_PRODUCTS).toHaveLength(14);
    for (const p of WHOLESALE_PRODUCTS) expect(isRawProduct(p)).toBe(true);
    expect(WHOLESALE_PRODUCTS).not.toContain('bread' as ProductId); // no finished goods
  });
});

describe('production storage projection (Part 4/5)', () => {
  it('rejects a batch whose output cannot fit — not silently queued to waiting_storage', async () => {
    const { id, b } = await shop('sp1'); // coffee cap 30 at tier 1, bizLevel storage bonus applies
    give(b, 'milk', 500); give(b, 'beans', 500);
    const cap = (world as any).toBizPriv(b).inventory.coffee?.capacity ?? 30;
    // A batch larger than capacity must be rejected up-front (no waiting_storage abuse).
    await expect(world.startProduction(id, b.id, 'coffee', cap + 20)).rejects.toBeInstanceOf(GameError);
    expect(b.prodJobs).toHaveLength(0);
    expect(onHand(b, 'milk')).toBe(500); // nothing committed on rejection
  });

  it('projects queued output: a second batch that would overflow is rejected', async () => {
    const { id, b } = await shop('sp2');
    const cap = (world as any).toBizPriv(b).inventory.coffee?.capacity ?? 30;
    give(b, 'milk', 500); give(b, 'beans', 500);
    const half = Math.floor(cap / 2);
    await world.startProduction(id, b.id, 'coffee', half); // occupies `half` of projected room
    // A second `half+something` batch would exceed capacity across the two jobs.
    await expect(world.startProduction(id, b.id, 'coffee', cap)).rejects.toBeInstanceOf(GameError);
    expect(b.prodJobs).toHaveLength(1);
  });

  it('MAX never exceeds projected storage room', async () => {
    const { b } = await shop('sp3');
    give(b, 'milk', 5000); give(b, 'beans', 5000); // ingredients are not the limit
    const line = (world as any).toProductionLine(b);
    const coffee = line.producible.find((p: any) => p.product === 'coffee');
    const cap = (world as any).toBizPriv(b).inventory.coffee?.capacity ?? 30;
    expect(coffee.maxOutput).toBeLessThanOrEqual(cap); // storage-limited, not 5000
  });
});

describe('queue cancel (Part 6)', () => {
  it('cancels a QUEUED job and refunds its ingredients exactly', async () => {
    const { id, b } = await shop('qc1');
    give(b, 'milk', 40); give(b, 'beans', 40);
    await world.startProduction(id, b.id, 'coffee', 10); // producing (head)
    await world.startProduction(id, b.id, 'coffee', 10); // queued
    expect(onHand(b, 'milk')).toBe(20); // both committed
    const queued = b.prodJobs[1];
    await world.cancelProduction(id, b.id, queued.id);
    expect(b.prodJobs).toHaveLength(1);            // producing head remains
    expect(onHand(b, 'milk')).toBe(30);            // queued job's 10 refunded
    expect(onHand(b, 'beans')).toBe(30);
    const row = await query(`SELECT status FROM production_jobs WHERE id=$1`, [queued.id]);
    expect(row.rows[0].status).toBe('cancelled');
  });

  it('refuses to cancel a producing (started) job', async () => {
    const { id, b } = await shop('qc2');
    give(b, 'milk', 40); give(b, 'beans', 40);
    await world.startProduction(id, b.id, 'coffee', 10);
    const head = b.prodJobs[0];
    expect(head.status).toBe('producing');
    await expect(world.cancelProduction(id, b.id, head.id)).rejects.toBeInstanceOf(GameError);
  });
});

describe('internal company transfer (Part 9)', () => {
  it('moves goods via delivery PRICED at wholesale rate (not free), cost basis = ref, no revenue/XP', async () => {
    const id = await newPlayer(world, 'tf1');
    const bakery = await world.chooseBusiness(id, 'bakery');
    bakery.bizXp = xpForBizLevel(20); bakery.bizLevel = 20; bakery.level = 3;
    world.players.get(id)!.cash = 1_000_000;
    world.companyByOwner(id)!.level = 10; // capacity for a 2nd business
    give(bakery, 'bread', 100); bakery.costBasis.set('bread', 8); // source cost is low...
    const mm = await world.openBusiness(id, marketLot(world), 'mini_market');
    mm.bizXp = xpForBizLevel(20); mm.bizLevel = 20; mm.level = 3;

    const cashBefore = world.players.get(id)!.cash;
    const bakeryXp0 = bakery.bizXp, mmXp0 = mm.bizXp;
    const ref = 20; // bread has no wholesale price -> RETAIL_BASE.bread = 20 is the floor
    await world.transferInternal(id, bakery.id, mm.id, 'bread', 40);
    expect(onHand(bakery, 'bread')).toBe(60);      // removed from source (in transit)
    // NOT free: the company is charged the wholesale-reference cost.
    expect(world.players.get(id)!.cash).toBe(cashBefore - ref * 40);
    await forceDeliveries(world);
    expect(onHand(mm, 'bread')).toBe(40);          // arrived by delivery (not teleport)
    // Cost basis = the reference floor (not the source's artificially-low $8) — no laundering.
    expect(mm.costBasis.get('bread')).toBeCloseTo(ref, 5);
    // Not a trade: no XP, no trade count.
    expect(bakery.bizXp).toBe(bakeryXp0);
    expect(mm.bizXp).toBe(mmXp0);
    expect(mm.tradeCount).toBe(0);
  });

  it('rejects a transfer the destination cannot store, and to the same business', async () => {
    const id = await newPlayer(world, 'tf2');
    const bakery = await world.chooseBusiness(id, 'bakery');
    world.players.get(id)!.cash = 1_000_000;
    world.companyByOwner(id)!.level = 10;
    give(bakery, 'bread', 50);
    const farm = await world.openBusiness(id, farmLot(world), 'farm');
    // A farm cannot store bread -> reject (no lost goods).
    await expect(world.transferInternal(id, bakery.id, farm.id, 'bread', 10)).rejects.toBeInstanceOf(GameError);
    await expect(world.transferInternal(id, bakery.id, bakery.id, 'bread', 10)).rejects.toBeInstanceOf(GameError);
    expect(onHand(bakery, 'bread')).toBe(50);
  });
});

// Helpers to find a vacant lot of a kind (openBusiness needs an explicit lot).
function lotOfKind(w: World, kind: 'mini_market' | 'farm'): string {
  const taken = new Set([...w.businesses.values()].map((b) => b.lotId));
  const lot = lotsOfKind(kind).find((l) => !taken.has(l.id));
  if (!lot) throw new Error(`no vacant ${kind} lot`);
  return lot.id;
}
function marketLot(w: World): string { return lotOfKind(w, 'mini_market'); }
function farmLot(w: World): string { return lotOfKind(w, 'farm'); }
