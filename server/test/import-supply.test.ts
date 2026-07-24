// V2.5.1 — import commodity availability hotfix.
//
// Coffee Beans have no player producer, so the Central Wholesale + Emergency
// Import is their only supply path and must never hard-lock a Coffee Shop.
// Crucially, being forced to use Emergency Import when normal stock is out must
// NOT accrue market-manipulation suspicion (there is no player alternative).
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld } from './helpers.js';
import { closeDb } from '../src/db.js';
import { type World } from '../src/game/world.js';
import {
  isImportDependent, playerProducerOf, unreachableInputs, BUSINESS_INPUTS,
  WHOLESALE_DAILY_STOCK, NPC_WHOLESALE_PRICES, EMERGENCY_PRICE_MULT,
  EMERGENCY_MAX_PER_BUY,
} from '@district/shared';

let world: World;

beforeEach(async () => {
  await resetDb();
  world = await loadedWorld();
});

afterAll(async () => {
  await closeDb();
});

const cid = (w: World, pid: number) => w.companyByOwner(pid)!.id;

describe('product supply classification', () => {
  it('classifies Coffee Beans as import-dependent and Wheat/Milk as player-producible', () => {
    expect(isImportDependent('beans')).toBe(true);
    expect(playerProducerOf('beans')).toBeNull();
    expect(isImportDependent('wheat')).toBe(false);
    expect(playerProducerOf('wheat')).toBe('farm');
    expect(isImportDependent('milk')).toBe(false);
    expect(playerProducerOf('milk')).toBe('farm');
  });

  it('leaves every recipe input with at least one reachable supply source', () => {
    // The core anti-deadlock invariant: no input is unreachable.
    expect(unreachableInputs()).toEqual([]);
    // And a coffee shop genuinely depends on beans, the import commodity.
    expect(BUSINESS_INPUTS.coffee_shop).toContain('beans');
  });
});

describe('Coffee Beans emergency import', () => {
  async function coffeeShop(name: string): Promise<number> {
    const pid = await newPlayer(world, name);
    const biz = await world.chooseBusiness(pid, 'coffee_shop');
    biz.level = 3; // roomy ingredient storage
    world.players.get(pid)!.cash = 100_000_000;
    return pid;
  }

  it('normal daily bean stock can reach zero', async () => {
    const pid = await coffeeShop('drainer');
    const daily = WHOLESALE_DAILY_STOCK.beans!;
    await world.buyNpc(pid, 'beans', daily); // buy exactly the day's stock
    expect(world.wholesale.get('beans')!.remaining).toBe(0);
    expect(world.toWholesaleState().products.find((p) => p.product === 'beans')!.emergency).toBe(true);
  });

  it('keeps Emergency Import available so the Coffee Shop is never blocked', async () => {
    const pid = await coffeeShop('starved');
    world.wholesale.get('beans')!.remaining = 0; // normal stock already gone
    world.deliveries.clear();
    // The shop can STILL obtain beans via emergency import.
    await world.buyNpc(pid, 'beans', 40);
    const incoming = [...world.deliveries.values()].filter((d) => d.product === 'beans');
    expect(incoming.length).toBe(1);
    expect(incoming[0].qty).toBe(40);
  });

  it('charges the 2.5x emergency multiplier on emergency units', async () => {
    const pid = await coffeeShop('payer');
    world.wholesale.get('beans')!.remaining = 0;
    const before = world.players.get(pid)!.cash;
    await world.buyNpc(pid, 'beans', 20);
    const spent = before - world.players.get(pid)!.cash;
    const base = NPC_WHOLESALE_PRICES.beans!;
    expect(spent).toBe(20 * Math.round(base * EMERGENCY_PRICE_MULT));
  });

  it('splits a partial buy: normal stock at base price, remainder at emergency price', async () => {
    const pid = await coffeeShop('mixed');
    const base = NPC_WHOLESALE_PRICES.beans!;
    world.wholesale.get('beans')!.remaining = 10; // only 10 left at base price
    const before = world.players.get(pid)!.cash;
    await world.buyNpc(pid, 'beans', 30); // 10 normal + 20 emergency
    const spent = before - world.players.get(pid)!.cash;
    expect(spent).toBe(10 * base + 20 * Math.round(base * EMERGENCY_PRICE_MULT));
    expect(world.wholesale.get('beans')!.remaining).toBe(0);
  });

  it('enforces the per-purchase emergency cap', async () => {
    const pid = await coffeeShop('greedy');
    world.wholesale.get('beans')!.remaining = 0;
    await expect(world.buyNpc(pid, 'beans', EMERGENCY_MAX_PER_BUY + 1)).rejects.toThrow();
    // At the cap it succeeds.
    world.deliveries.clear();
    await world.buyNpc(pid, 'beans', EMERGENCY_MAX_PER_BUY);
    expect([...world.deliveries.values()].some((d) => d.product === 'beans')).toBe(true);
  });

  it('preserves stock and reset behaviour across a restart', async () => {
    const pid = await coffeeShop('persist');
    await world.buyNpc(pid, 'beans', 100);
    const rem = world.wholesale.get('beans')!.remaining;
    expect(rem).toBe(WHOLESALE_DAILY_STOCK.beans! - 100);
    const world2 = await loadedWorld();
    expect(world2.wholesale.get('beans')!.remaining).toBe(rem);
    // Daily rollover still refills to full.
    await world2.devRolloverWholesale();
    expect(world2.wholesale.get('beans')!.remaining).toBe(WHOLESALE_DAILY_STOCK.beans);
  });
});

describe('emergency import and market integrity', () => {
  // Buy the whole day's stock of `product` plus an emergency slice, every day.
  async function drainOneDay(w: World, pid: number, product: 'beans' | 'wheat'): Promise<void> {
    const daily = WHOLESALE_DAILY_STOCK[product]!;
    w.wholesale.get(product)!.remaining = daily;
    const biz = w.bizByOwner(pid)!;
    biz.inv.get(product)!.qty = 0; // clear storage so the big buy fits
    w.deliveries.clear();
    // > full day's stock: crosses the high-share line AND dips into emergency.
    await w.buyNpc(pid, product, daily + 20);
    await w.devRolloverWholesale();
  }

  it('never penalizes a Coffee Shop for emergency-importing beans it cannot produce', async () => {
    const pid = await newPlayer(world, 'honest-barista');
    const biz = await world.chooseBusiness(world.players.get(pid)!.id === pid ? pid : pid, 'coffee_shop');
    biz.level = 3;
    world.players.get(pid)!.cash = 100_000_000;

    // Five days of maximal bean buying incl. emergency — the ONLY way to get
    // beans. Integrity must stay pristine: no player alternative exists.
    for (let day = 0; day < 5; day++) await drainOneDay(world, pid, 'beans');
    const rec = world.integrityOf(cid(world, pid))!;
    expect(rec.state).toBe('normal');
    expect(rec.flaggedDays).toBe(0);
    expect(rec.score).toBe(100);
  });

  it('still flags the same behaviour for a player-producible good (wheat)', async () => {
    // Proves the exemption is surgical, not a blanket disable: wheat CAN be
    // bought from player farms, so cornering + depleting it is real manipulation.
    const pid = await newPlayer(world, 'wheat-cornerer');
    const biz = await world.chooseBusiness(pid, 'bakery');
    biz.level = 3;
    world.players.get(pid)!.cash = 100_000_000;

    await drainOneDay(world, pid, 'wheat');
    expect(world.integrityOf(cid(world, pid))!.state).toBe('watchlist');
    await drainOneDay(world, pid, 'wheat');
    expect(world.integrityOf(cid(world, pid))!.state).toBe('investigating');
    await drainOneDay(world, pid, 'wheat');
    expect(world.integrityOf(cid(world, pid))!.state).toBe('confirmed');
  });
});
