import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld } from './helpers.js';
import { closeDb, query } from '../src/db.js';
import {
  BUSINESS_CAPACITY, companyCapacity, businessOpenCost, COMPANY_LEVELS,
  defaultCompanyName,
} from '@district/shared';
import { World, GameError } from '../src/game/world.js';

let world: World;

beforeEach(async () => {
  await resetDb();
  world = await loadedWorld();
});

afterAll(async () => {
  await closeDb();
});

/** First vacant lot of a kind, so tests can open businesses deterministically. */
function vacantLot(w: World, kind: string): string {
  const taken = new Set([...w.businesses.values()].map((b) => b.lotId));
  // LOTS isn't imported here; rely on chooseBusiness/openBusiness picking, so
  // instead we query the shared map indirectly via known lot ids.
  const byKind: Record<string, string[]> = {
    farm: ['farm_1', 'farm_2', 'farm_3', 'farm_4', 'farm_5', 'farm_6'],
    coffee_shop: ['cafe_1', 'cafe_2', 'cafe_3', 'cafe_4', 'cafe_5', 'cafe_6'],
    bakery: ['bakery_1', 'bakery_2', 'bakery_3'],
    mini_market: ['market_1', 'market_2', 'market_3'],
  };
  const id = (byKind[kind] ?? []).find((l) => !taken.has(l));
  if (!id) throw new Error(`no vacant ${kind} lot`);
  return id;
}

describe('company creation & ownership', () => {
  it('creates exactly one company per player when they choose a business', async () => {
    const pid = await newPlayer(world, 'alice');
    const biz = await world.chooseBusiness(pid, 'farm');
    const company = world.companyByOwner(pid);
    expect(company).toBeDefined();
    expect(company!.ownerId).toBe(pid);
    expect(company!.level).toBe(1);
    expect(company!.name).toBe(defaultCompanyName('alice'));
    // The business is owned by that company.
    expect(biz.companyId).toBe(company!.id);
    // Exactly one company row.
    const rows = await query('SELECT count(*)::int AS n FROM companies WHERE player_id=$1', [pid]);
    expect(rows.rows[0].n).toBe(1);
  });

  it('lists all businesses a company owns', async () => {
    const pid = await newPlayer(world, 'bob');
    await world.chooseBusiness(pid, 'farm');
    world.players.get(pid)!.cash = 100000;
    await world.devCommand(pid, 'company_xp', 5000); // unlock capacity
    await world.openBusiness(pid, vacantLot(world, 'bakery'), 'bakery');
    expect(world.bizesByOwner(pid).length).toBe(2);
    const company = world.toCompanyPriv(world.companyByOwner(pid)!);
    expect(company.businessCount).toBe(2);
  });
});

describe('management capacity', () => {
  it('reports capacity used as the sum of business capacities', async () => {
    const pid = await newPlayer(world, 'cara');
    await world.chooseBusiness(pid, 'farm'); // 2
    world.players.get(pid)!.cash = 100000;
    await world.devCommand(pid, 'company_xp', 5000);
    await world.openBusiness(pid, vacantLot(world, 'coffee_shop'), 'coffee_shop'); // 3
    const priv = world.toCompanyPriv(world.companyByOwner(pid)!);
    expect(priv.capacityUsed).toBe(BUSINESS_CAPACITY.farm + BUSINESS_CAPACITY.coffee_shop);
  });

  it('rejects opening a business that exceeds capacity, charging nothing', async () => {
    const pid = await newPlayer(world, 'dan');
    await world.chooseBusiness(pid, 'farm'); // uses 2 of L1 cap (4)
    const cashBefore = world.players.get(pid)!.cash;
    // farm(2) + bakery(3) = 5 > 4, must be rejected at level 1.
    expect(companyCapacity(1)).toBe(4);
    await expect(
      world.openBusiness(pid, vacantLot(world, 'bakery'), 'bakery')
    ).rejects.toThrow(GameError);
    expect(world.players.get(pid)!.cash).toBe(cashBefore); // no cash lost
    expect(world.bizesByOwner(pid).length).toBe(1);
  });

  it('allows the business once company level raises capacity', async () => {
    const pid = await newPlayer(world, 'eve');
    await world.chooseBusiness(pid, 'farm');
    world.players.get(pid)!.cash = 100000;
    await world.devCommand(pid, 'company_xp', COMPANY_LEVELS[2].xp); // reach L2 -> cap 6
    expect(world.companyByOwner(pid)!.level).toBeGreaterThanOrEqual(2);
    await world.openBusiness(pid, vacantLot(world, 'bakery'), 'bakery');
    expect(world.bizesByOwner(pid).length).toBe(2);
  });
});

describe('opening additional businesses', () => {
  it('charges the escalating opening cost and writes a BUSINESS_OPENING ledger entry', async () => {
    const pid = await newPlayer(world, 'fred');
    await world.chooseBusiness(pid, 'farm');
    world.players.get(pid)!.cash = 100000;
    await world.devCommand(pid, 'company_xp', 5000);
    const cost = businessOpenCost(1); // 2nd business
    const before = world.players.get(pid)!.cash;
    await world.openBusiness(pid, vacantLot(world, 'coffee_shop'), 'coffee_shop');
    expect(world.players.get(pid)!.cash).toBe(before - cost);
    const led = await query(
      `SELECT amount FROM economic_ledger WHERE player_id=$1 AND transaction_type='BUSINESS_OPENING'`,
      [pid]
    );
    expect(led.rows.length).toBe(1);
    expect(Number(led.rows[0].amount)).toBe(-cost);
  });

  it('rejects opening when the player cannot afford the cost, charging nothing', async () => {
    const pid = await newPlayer(world, 'gwen');
    await world.chooseBusiness(pid, 'farm');
    await world.devCommand(pid, 'company_xp', 5000);
    world.players.get(pid)!.cash = 100; // far below opening cost
    await expect(
      world.openBusiness(pid, vacantLot(world, 'coffee_shop'), 'coffee_shop')
    ).rejects.toThrow(GameError);
    expect(world.players.get(pid)!.cash).toBe(100);
    expect(world.bizesByOwner(pid).length).toBe(1);
  });

  it('rejects a second business on an already-taken lot', async () => {
    const pid = await newPlayer(world, 'hana');
    const farm = await world.chooseBusiness(pid, 'farm');
    world.players.get(pid)!.cash = 100000;
    await world.devCommand(pid, 'company_xp', 5000);
    await expect(
      world.openBusiness(pid, farm.lotId, 'farm')
    ).rejects.toThrow(GameError);
  });

  it('protects against a concurrent double-open (one lock, one charge)', async () => {
    const pid = await newPlayer(world, 'iris');
    await world.chooseBusiness(pid, 'farm');
    world.players.get(pid)!.cash = 100000;
    await world.devCommand(pid, 'company_xp', 9000); // high capacity
    const before = world.players.get(pid)!.cash;
    const lot = vacantLot(world, 'coffee_shop');
    const results = await Promise.allSettled([
      world.openBusiness(pid, lot, 'coffee_shop'),
      world.openBusiness(pid, lot, 'coffee_shop'),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(1); // exactly one succeeded
    expect(world.bizesByOwner(pid).length).toBe(2); // farm + one coffee shop
    expect(world.players.get(pid)!.cash).toBe(before - businessOpenCost(1));
  });
});

describe('persistence across restart', () => {
  it('keeps the company, its level/xp and all businesses after reload', async () => {
    const pid = await newPlayer(world, 'jack');
    await world.chooseBusiness(pid, 'farm');
    world.players.get(pid)!.cash = 100000;
    await world.devCommand(pid, 'company_xp', COMPANY_LEVELS[2].xp);
    await world.openBusiness(pid, vacantLot(world, 'bakery'), 'bakery');
    const companyBefore = world.companyByOwner(pid)!;
    await world.flush();

    // Simulate a server restart: fresh World from the same DB.
    const world2 = await loadedWorld();
    const company2 = world2.companyByOwner(pid);
    expect(company2).toBeDefined();
    expect(company2!.id).toBe(companyBefore.id);
    expect(company2!.level).toBe(companyBefore.level);
    expect(company2!.xp).toBe(companyBefore.xp);
    const types = world2.bizesByOwner(pid).map((b) => b.type).sort();
    expect(types).toEqual(['bakery', 'farm']);
    // Every restored business is linked to the company.
    for (const b of world2.bizesByOwner(pid)) expect(b.companyId).toBe(company2!.id);
  });
});

describe('offline safety with multiple businesses', () => {
  it('catches up each business independently without cross-contamination', async () => {
    const pid = await newPlayer(world, 'kim');
    const farm = await world.chooseBusiness(pid, 'farm');
    world.players.get(pid)!.cash = 100000;
    await world.devCommand(pid, 'company_xp', COMPANY_LEVELS[2].xp);
    const bakeryLot = vacantLot(world, 'bakery');
    const bakery = await world.openBusiness(pid, bakeryLot, 'bakery');
    // Offline for a while: farm produces milk, bakery (no wheat) sells nothing.
    world.catchUp(farm, 200);
    world.catchUp(bakery, 200);
    expect(farm.milkProduced).toBeGreaterThan(0);
    expect(bakery.coffeeSold).toBe(0);
    // The two businesses keep separate inventories.
    expect(farm.inv.get('milk')!.qty).toBeGreaterThan(0);
    expect(bakery.inv.has('milk')).toBe(false);
  });
});
