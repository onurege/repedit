// Phase 2: Wheat/Bread, Bakery, Mini Market, and the trade chain.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld, forceDeliveries } from './helpers.js';
import { closeDb, query } from '../src/db.js';
import { GameError, type World } from '../src/game/world.js';
import { STARTING_CASH, FARM_LEVELS } from '@district/shared';

let world: World;

beforeEach(async () => {
  await resetDb();
  world = await loadedWorld();
});

afterAll(async () => {
  await closeDb();
});

describe('farm production choice', () => {
  it('produces wheat after switching, and switches back', async () => {
    const pid = await newPlayer(world, 'wheat_farmer');
    const biz = await world.chooseBusiness(pid, 'farm');
    world.setProduction(pid, 'wheat');
    world.simulate(biz, 100, true);
    expect(biz.inv.get('wheat')!.qty).toBe(50);
    expect(biz.inv.get('milk')!.qty).toBe(0);
    world.setProduction(pid, 'milk');
    world.simulate(biz, 100, true);
    expect(biz.inv.get('milk')!.qty).toBe(50);
    expect(biz.inv.get('wheat')!.qty).toBe(50); // wheat stock kept
  });

  it('rejects invalid production and non-farm switching', async () => {
    const pid = await newPlayer(world, 'baker0');
    await world.chooseBusiness(pid, 'bakery');
    expect(() => world.setProduction(pid, 'bread' as any)).toThrow(GameError);
  });
});

describe('bakery', () => {
  it('bakes bread from wheat and sells it; stops without wheat', async () => {
    const pid = await newPlayer(world, 'baker');
    const biz = await world.chooseBusiness(pid, 'bakery');
    const p = world.players.get(pid)!;
    const cash0 = p.cash;
    world.simulate(biz, 300, true);
    expect(biz.coffeeSold).toBe(0); // no wheat -> nothing sold
    expect(biz.status).toBe('out_of_stock');
    biz.inv.get('wheat')!.qty = 60;
    world.simulate(biz, 300, true);
    expect(biz.coffeeSold).toBeGreaterThan(0);
    const consumed = 60 - biz.inv.get('wheat')!.qty;
    expect(biz.coffeeSold + biz.inv.get('bread')!.qty).toBe(consumed);
    expect(p.cash).toBe(cash0 + biz.coffeeSold * biz.price);
  });
});

describe('mini market', () => {
  it('retails bread and milk at separate prices; stops without stock', async () => {
    const pid = await newPlayer(world, 'grocer');
    const biz = await world.chooseBusiness(pid, 'mini_market');
    const p = world.players.get(pid)!;
    const cash0 = p.cash;
    world.simulate(biz, 400, true);
    expect(p.cash).toBe(cash0); // empty shelves sell nothing
    expect(biz.status).toBe('out_of_stock');
    biz.inv.get('bread')!.qty = 50;
    biz.inv.get('milk')!.qty = 50;
    world.setPrice(pid, 22);           // bread
    world.setPrice(pid, 16, 'milk');   // milk
    world.simulate(biz, 600, true);
    const breadSold = 50 - biz.inv.get('bread')!.qty;
    const milkSold = 50 - biz.inv.get('milk')!.qty;
    expect(breadSold).toBeGreaterThan(0);
    expect(milkSold).toBeGreaterThan(0);
    expect(p.cash).toBe(cash0 + breadSold * 22 + milkSold * 16);
    expect(biz.revenue).toBe(breadSold * 22 + milkSold * 16);
  });
});

describe('wheat & bread marketplace', () => {
  it('runs the full chain: farm -> bakery (wheat), bakery -> market (bread)', async () => {
    const aId = await newPlayer(world, 'chainA');
    const bId = await newPlayer(world, 'chainB');
    const cId = await newPlayer(world, 'chainC');
    const farm = await world.chooseBusiness(aId, 'farm');
    const bakery = await world.chooseBusiness(bId, 'bakery');
    const market = await world.chooseBusiness(cId, 'mini_market');

    // A produces wheat and lists it
    world.setProduction(aId, 'wheat');
    world.simulate(farm, 260, true);
    expect(farm.inv.get('wheat')!.qty).toBeGreaterThanOrEqual(100);
    await world.createOrder(aId, 'sell', 'wheat', 100, 7);

    // B buys A's wheat
    const wheatOrder = [...world.orders.values()][0];
    await world.fulfillOrder(bId, wheatOrder.id, 100);
    expect(world.players.get(aId)!.cash).toBe(STARTING_CASH + 700);
    expect(world.players.get(bId)!.cash).toBe(STARTING_CASH - 700);
    await forceDeliveries(world);
    expect(bakery.inv.get('wheat')!.qty).toBeGreaterThan(0); // delivered (some may already be baked)

    // B bakes and earns from customers
    world.simulate(bakery, 400, true);
    expect(bakery.coffeeSold).toBeGreaterThan(0);
    const bCash = world.players.get(bId)!.cash;
    expect(bCash).toBeGreaterThan(STARTING_CASH - 700);

    // B lists bread; C buys it
    bakery.inv.get('bread')!.qty += 40;
    await world.createOrder(bId, 'sell', 'bread', 40, 14);
    const breadOrder = [...world.orders.values()].find((o) => o.product === 'bread')!;
    await world.fulfillOrder(cId, breadOrder.id, 40);
    expect(world.players.get(cId)!.cash).toBe(STARTING_CASH - 560);
    await forceDeliveries(world);
    expect(market.inv.get('bread')!.qty).toBe(40);

    // duplicate fulfillment of the filled order is impossible
    await expect(world.fulfillOrder(cId, breadOrder.id, 40)).rejects.toThrow();

    // C retails bread to NPC customers
    world.simulate(market, 500, true);
    expect(market.coffeeSold).toBeGreaterThan(0);
    expect(world.players.get(cId)!.cash).toBeGreaterThan(STARTING_CASH - 560);

    // ledger recorded the chain
    const rows = (await query('SELECT transaction_type, count(*)::int AS n FROM economic_ledger GROUP BY 1')).rows;
    const types = Object.fromEntries(rows.map((r) => [r.transaction_type, r.n]));
    expect(types.MARKET_SELL).toBe(2);
    await world.flush();
    const sales = await query("SELECT count(*)::int AS n FROM economic_ledger WHERE transaction_type='CUSTOMER_SALE'");
    expect(sales.rows[0].n).toBeGreaterThan(0);
  });

  it('NPC wholesaler sells wheat and bread with delivery', async () => {
    const pid = await newPlayer(world, 'npc_buyer');
    const biz = await world.chooseBusiness(pid, 'bakery');
    await world.buyNpc(pid, 'wheat', 50); // $500
    expect(world.players.get(pid)!.cash).toBe(STARTING_CASH - 500);
    await forceDeliveries(world);
    expect(biz.inv.get('wheat')!.qty).toBeGreaterThanOrEqual(49); // baking may consume during tick
    await expect(world.buyNpc(pid, 'coffee' as any, 5)).rejects.toThrow(GameError);
  });

  it('persists production choice and price2 across restart', async () => {
    const pid = await newPlayer(world, 'persist2');
    await world.chooseBusiness(pid, 'mini_market');
    world.setPrice(pid, 25);
    world.setPrice(pid, 14, 'milk');
    const fId = await newPlayer(world, 'persist2f');
    await world.chooseBusiness(fId, 'farm');
    world.setProduction(fId, 'wheat');
    await world.flush();
    const world2 = await loadedWorld();
    expect(world2.bizByOwner(pid)!.price).toBe(25);
    expect(world2.bizByOwner(pid)!.price2).toBe(14);
    expect(world2.bizByOwner(fId)!.production).toBe('wheat');
  });
});
