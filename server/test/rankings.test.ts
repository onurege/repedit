import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld } from './helpers.js';
import { closeDb, query } from '../src/db.js';
import { GameError, type World } from '../src/game/world.js';
import { COMPANY_LEVELS, RANKING_WINDOW_SECONDS } from '@district/shared';

let world: World;

beforeEach(async () => {
  await resetDb();
  world = await loadedWorld();
});

afterAll(async () => {
  await closeDb();
});

const BAKERY_LOTS = ['bakery_1', 'bakery_2', 'bakery_3'];
function vacantBakery(w: World): string {
  const taken = new Set([...w.businesses.values()].map((b) => b.lotId));
  const id = BAKERY_LOTS.find((l) => !taken.has(l));
  if (!id) throw new Error('no vacant bakery lot');
  return id;
}

/** Company id for a player. */
function cid(w: World, pid: number): number {
  return w.companyByOwner(pid)!.id;
}

/**
 * Stock a bakery with finished bread and let NPC customers buy it. V2.8 Phase 2:
 * bread is manufactured on the production line, so retail draws from finished
 * stock (the `stock` amount) rather than auto-baking wheat.
 */
function sellBread(w: World, biz: any, stock: number, seconds: number): number {
  biz.inv.get('bread')!.qty = stock;
  const before = biz.coffeeSold;
  w.simulate(biz, seconds, true);
  return biz.coffeeSold - before;
}

describe('final-sale market share', () => {
  it('computes per-company share, city total and rank from real NPC sales', async () => {
    const aId = await newPlayer(world, 'alpha');
    const bId = await newPlayer(world, 'bravo');
    const a = await world.chooseBusiness(aId, 'bakery');
    const b = await world.chooseBusiness(bId, 'bakery');
    const soldA = sellBread(world, a, 2000, 600);
    const soldB = sellBread(world, b, 2000, 250);
    await world.flush();
    expect(soldA).toBeGreaterThan(0);
    expect(soldB).toBeGreaterThan(0);

    const profA = (await world.computeCompanyProfile(cid(world, aId), aId))!;
    const share = profA.marketShares.find((m) => m.product === 'bread')!;
    expect(share.units).toBe(soldA);
    expect(share.cityUnits).toBe(soldA + soldB);
    expect(share.share).toBeCloseTo(soldA / (soldA + soldB), 5);

    // Ranking board is ordered by units desc and lists both companies.
    const rankings = await world.computeCityRankings(aId);
    const bread = rankings.boards.find((x) => x.category === 'bread')!;
    expect(bread.top.map((r) => r.value)).toEqual([...bread.top.map((r) => r.value)].sort((x, y) => y - x));
    const winner = soldA >= soldB ? cid(world, aId) : cid(world, bId);
    expect(bread.top[0].companyId).toBe(winner);
  });
});

describe('multi-business aggregation', () => {
  it("sums a company's bread sales across all its bakeries", async () => {
    const aId = await newPlayer(world, 'multi');
    const b1 = await world.chooseBusiness(aId, 'bakery');
    world.players.get(aId)!.cash = 100000;
    await world.devCommand(aId, 'company_xp', COMPANY_LEVELS[2].xp); // capacity for 2nd
    const b2 = await world.openBusiness(aId, vacantBakery(world), 'bakery');
    const s1 = sellBread(world, b1, 2000, 400);
    const s2 = sellBread(world, b2, 2000, 400);
    await world.flush();

    const prof = (await world.computeCompanyProfile(cid(world, aId), aId))!;
    const share = prof.marketShares.find((m) => m.product === 'bread')!;
    expect(share.units).toBe(s1 + s2);
    // Activity rows exist for both businesses.
    const rows = await query(
      `SELECT DISTINCT business_id FROM company_activity WHERE company_id=$1 AND kind='final_sale'`,
      [cid(world, aId)]
    );
    expect(rows.rows.length).toBe(2);
  });
});

describe('final vs supplier separation', () => {
  it('marketplace sales are supplier activity, never final market share', async () => {
    const farmId = await newPlayer(world, 'farmer');
    const bakeId = await newPlayer(world, 'baker');
    const farm = await world.chooseBusiness(farmId, 'farm');
    await world.chooseBusiness(bakeId, 'bakery');
    farm.inv.get('wheat')!.qty = 500;
    // Bakery buys wheat from the farm on the marketplace.
    const order = await world.createOrder(bakeId, 'buy', 'wheat', 200, 8);
    await world.fulfillOrder(farmId, order.id, 200);

    const finals = await query(`SELECT count(*)::int AS n FROM company_activity WHERE kind='final_sale'`);
    expect(finals.rows[0].n).toBe(0); // no NPC final sales happened
    const sup = await query(
      `SELECT SUM(units)::int AS u FROM company_activity WHERE kind='supplier_sale' AND product='wheat' AND company_id=$1`,
      [cid(world, farmId)]
    );
    expect(sup.rows[0].u).toBe(200);

    // Farm profile has a wheat supplier rank but no final market share.
    const prof = (await world.computeCompanyProfile(cid(world, farmId), farmId))!;
    expect(prof.supplierRanks.find((s) => s.product === 'wheat')!.units).toBe(200);
    expect(prof.marketShares.length).toBe(0);
  });
});

describe('supplier rankings', () => {
  it('ranks wheat suppliers by recent external volume', async () => {
    const bigId = await newPlayer(world, 'bigfarm');
    const smallId = await newPlayer(world, 'smallfarm');
    const buyId = await newPlayer(world, 'buyer');
    const big = await world.chooseBusiness(bigId, 'farm');
    const small = await world.chooseBusiness(smallId, 'farm');
    await world.chooseBusiness(buyId, 'bakery');
    big.inv.get('wheat')!.qty = 500;
    small.inv.get('wheat')!.qty = 500;
    const o1 = await world.createOrder(buyId, 'buy', 'wheat', 200, 8);
    await world.fulfillOrder(bigId, o1.id, 200);
    const o2 = await world.createOrder(buyId, 'buy', 'wheat', 50, 8);
    await world.fulfillOrder(smallId, o2.id, 50);

    const rankings = await world.computeCityRankings(bigId);
    const board = rankings.boards.find((b) => b.category === 'wheat_supplier')!;
    expect(board.top[0].companyId).toBe(cid(world, bigId));
    expect(board.top[0].value).toBe(200);
    expect(board.top[1].companyId).toBe(cid(world, smallId));
    expect(board.top[1].value).toBe(50);
  });
});

describe('rolling window', () => {
  it('excludes activity older than the window', async () => {
    const aId = await newPlayer(world, 'timed');
    const a = await world.chooseBusiness(aId, 'bakery');
    sellBread(world, a, 2000, 400);
    await world.flush();
    // Within window: bread share exists.
    let prof = (await world.computeCompanyProfile(cid(world, aId), aId))!;
    expect(prof.marketShares.find((m) => m.product === 'bread')).toBeTruthy();

    // Backdate every activity row to just beyond the window.
    await query(
      `UPDATE company_activity SET created_at = now() - ($1 || ' seconds')::interval`,
      [RANKING_WINDOW_SECONDS + 3600]
    );
    prof = (await world.computeCompanyProfile(cid(world, aId), aId))!;
    expect(prof.marketShares.find((m) => m.product === 'bread')).toBeUndefined();
    const rankings = await world.computeCityRankings(aId);
    expect(rankings.boards.find((b) => b.category === 'bread')!.top.length).toBe(0);
  });
});

describe('restart persistence', () => {
  it('recent metrics survive a server restart (loaded from the DB)', async () => {
    const aId = await newPlayer(world, 'persist');
    const a = await world.chooseBusiness(aId, 'bakery');
    const sold = sellBread(world, a, 2000, 500);
    await world.flush();

    const world2 = await loadedWorld();
    const prof = (await world2.computeCompanyProfile(cid(world2, aId), aId))!;
    expect(prof.marketShares.find((m) => m.product === 'bread')!.units).toBe(sold);
    expect(prof.recentRevenue).toBeGreaterThan(0);
  });
});

describe('duplicate-event protection', () => {
  it('a rejected double-fulfill does not double-count supplier volume', async () => {
    const farmId = await newPlayer(world, 'dupfarm');
    const buyId = await newPlayer(world, 'dupbuy');
    const farm = await world.chooseBusiness(farmId, 'farm');
    await world.chooseBusiness(buyId, 'bakery');
    farm.inv.get('wheat')!.qty = 500;
    const order = await world.createOrder(buyId, 'buy', 'wheat', 100, 8);
    await world.fulfillOrder(farmId, order.id, 100); // fully fills
    // Order is now gone; a second fulfill must fail, not record more activity.
    await expect(world.fulfillOrder(farmId, order.id, 100)).rejects.toThrow(GameError);
    const rows = await query(
      `SELECT SUM(units)::int AS u, count(*)::int AS n FROM company_activity
       WHERE kind='supplier_sale' AND company_id=$1`,
      [cid(world, farmId)]
    );
    expect(rows.rows[0].n).toBe(1);
    expect(rows.rows[0].u).toBe(100);
  });
});

describe('growth ranking safety', () => {
  it('does not rank a tiny new company as fastest growing', async () => {
    const aId = await newPlayer(world, 'tiny');
    const a = await world.chooseBusiness(aId, 'bakery');
    sellBread(world, a, 20, 20); // trivial activity, well under the floor
    await world.flush();
    const rankings = await world.computeCityRankings(aId);
    const growth = rankings.boards.find((b) => b.category === 'growth')!;
    expect(growth.top.find((r) => r.companyId === cid(world, aId))).toBeUndefined();
  });
});
