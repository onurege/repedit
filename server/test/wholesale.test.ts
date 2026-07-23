import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld } from './helpers.js';
import { closeDb, query } from '../src/db.js';
import { GameError, type World } from '../src/game/world.js';
import { WHOLESALE_DAILY_STOCK, NPC_WHOLESALE_PRICES, EMERGENCY_PRICE_MULT, REP_MIN } from '@district/shared';

let world: World;

beforeEach(async () => {
  await resetDb();
  world = await loadedWorld();
});

afterAll(async () => {
  await closeDb();
});

function cid(w: World, pid: number): number {
  return w.companyByOwner(pid)!.id;
}

describe('daily wholesale supply', () => {
  it('seeds finite daily stock at the base price', async () => {
    const state = world.toWholesaleState();
    const wheat = state.products.find((p) => p.product === 'wheat')!;
    expect(wheat.dailyStock).toBe(WHOLESALE_DAILY_STOCK.wheat);
    expect(wheat.remaining).toBe(WHOLESALE_DAILY_STOCK.wheat);
    expect(wheat.basePrice).toBe(NPC_WHOLESALE_PRICES.wheat);
  });

  it('consumes stock when a player buys, and persists remaining across restart', async () => {
    const pid = await newPlayer(world, 'baker');
    const biz = await world.chooseBusiness(pid, 'bakery');
    biz.level = 3; // roomy storage
    await world.buyNpc(pid, 'wheat', 200);
    const rem = world.wholesale.get('wheat')!.remaining;
    expect(rem).toBe(WHOLESALE_DAILY_STOCK.wheat! - 200);

    const world2 = await loadedWorld();
    expect(world2.wholesale.get('wheat')!.remaining).toBe(rem);
  });

  it('refills to full on a daily rollover (idempotent, restart-safe)', async () => {
    const pid = await newPlayer(world, 'baker2');
    const biz = await world.chooseBusiness(pid, 'bakery');
    biz.level = 3;
    await world.buyNpc(pid, 'wheat', 300);
    expect(world.wholesale.get('wheat')!.remaining).toBeLessThan(WHOLESALE_DAILY_STOCK.wheat!);
    await world.devRolloverWholesale();
    expect(world.wholesale.get('wheat')!.remaining).toBe(WHOLESALE_DAILY_STOCK.wheat);
    // The persisted reset time is in the future (no immediate re-trigger).
    const row = await query(`SELECT reset_at FROM wholesale_supply WHERE product='wheat'`);
    expect(new Date(row.rows[0].reset_at).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('emergency fallback', () => {
  it('sells beyond depletion at a premium, capped per purchase, never blocking', async () => {
    const pid = await newPlayer(world, 'emer');
    const biz = await world.chooseBusiness(pid, 'bakery');
    biz.level = 3;
    world.players.get(pid)!.cash = 1_000_000;
    // Drain stock down to a sliver.
    world.wholesale.get('wheat')!.remaining = 5;
    const base = NPC_WHOLESALE_PRICES.wheat!;
    const cashBefore = world.players.get(pid)!.cash;
    await world.buyNpc(pid, 'wheat', 25); // 5 normal + 20 emergency
    const spent = cashBefore - world.players.get(pid)!.cash;
    expect(spent).toBe(5 * base + 20 * Math.round(base * EMERGENCY_PRICE_MULT));
    expect(world.wholesale.get('wheat')!.remaining).toBe(0);
  });

  it('rejects a single purchase whose emergency portion exceeds the cap', async () => {
    const pid = await newPlayer(world, 'greedy');
    const biz = await world.chooseBusiness(pid, 'bakery');
    biz.level = 3;
    world.players.get(pid)!.cash = 1_000_000;
    world.wholesale.get('wheat')!.remaining = 0;
    await expect(world.buyNpc(pid, 'wheat', 500)).rejects.toThrow(GameError); // > EMERGENCY_MAX_PER_BUY
  });
});

describe('legitimate speculation is never punished', () => {
  it('normal buying, holding and reselling keeps integrity clean', async () => {
    const pid = await newPlayer(world, 'trader');
    const biz = await world.chooseBusiness(pid, 'bakery');
    biz.level = 3;
    world.players.get(pid)!.cash = 1_000_000;
    // Buy a sensible amount well within stock, several days running.
    for (let d = 0; d < 4; d++) {
      await world.buyNpc(pid, 'wheat', 100);
      await world.devRolloverWholesale();
    }
    const rec = world.integrityOf(cid(world, pid))!;
    expect(rec.state).toBe('normal');
    expect(rec.score).toBe(100);
    // No public warning.
    const prof = await world.computeCompanyProfile(cid(world, pid), pid);
    expect(prof!.warning).toBeNull();
  });
});

describe('market manipulation detection', () => {
  // Repeatedly corner + deplete the wheat supply over several days.
  async function manipulateOneDay(w: World, pid: number): Promise<void> {
    const daily = WHOLESALE_DAILY_STOCK.wheat!;
    w.wholesale.get('wheat')!.remaining = daily; // fresh day
    // Buy just over the whole day's stock: >50% share + dips into emergency.
    const biz = w.bizByOwner(pid)!;
    biz.inv.get('wheat')!.qty = 0;   // clear storage so the big buy fits
    w.deliveries.clear();            // (no ticks in tests -> vans never arrive)
    await w.buyNpc(pid, 'wheat', daily + 20);
    await w.devRolloverWholesale();
  }

  it('confirms manipulation only after sustained abuse, then penalizes reputation', async () => {
    const pid = await newPlayer(world, 'cornerer');
    const biz = await world.chooseBusiness(pid, 'bakery');
    biz.level = 3;
    world.players.get(pid)!.cash = 100_000_000;
    const startRep = biz.reputation;

    await manipulateOneDay(world, pid);
    expect(world.integrityOf(cid(world, pid))!.state).toBe('watchlist');
    await manipulateOneDay(world, pid);
    expect(world.integrityOf(cid(world, pid))!.state).toBe('investigating');
    await manipulateOneDay(world, pid);
    const rec = world.integrityOf(cid(world, pid))!;
    expect(rec.state).toBe('confirmed');
    // Consequence: reputation dropped (recoverable) and a public warning set.
    expect(world.bizByOwner(pid)!.reputation).toBeLessThan(startRep);
    expect(world.bizByOwner(pid)!.reputation).toBeGreaterThanOrEqual(REP_MIN);
    const prof = await world.computeCompanyProfile(cid(world, pid), pid);
    expect(prof!.warning).toBe('market_violation');

    // Hidden: the score/state never leak into the public profile payload.
    expect(JSON.stringify(prof)).not.toContain('score');
    expect(JSON.stringify(prof)).not.toContain('confirmed');
  });

  it('writes an integrity-violation ledger entry on confirmation', async () => {
    const pid = await newPlayer(world, 'cornerer2');
    const biz = await world.chooseBusiness(pid, 'bakery');
    biz.level = 3;
    world.players.get(pid)!.cash = 100_000_000;
    for (let d = 0; d < 3; d++) await manipulateOneDay(world, pid);
    await world.flush();
    const led = await query(
      `SELECT count(*)::int n FROM economic_ledger WHERE player_id=$1 AND transaction_type='INTEGRITY_VIOLATION'`,
      [pid]
    );
    expect(led.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('persists integrity state across a restart', async () => {
    const pid = await newPlayer(world, 'persist');
    const biz = await world.chooseBusiness(pid, 'bakery');
    biz.level = 3;
    world.players.get(pid)!.cash = 100_000_000;
    for (let d = 0; d < 3; d++) await manipulateOneDay(world, pid);
    await world.flush();
    const world2 = await loadedWorld();
    const rec2 = world2.integrityOf(cid(world2, pid));
    expect(rec2).toBeDefined();
    expect(rec2!.state).toBe('confirmed');
    const prof = await world2.computeCompanyProfile(cid(world2, pid), pid);
    expect(prof!.warning).toBe('market_violation');
  });
});

describe('false-positive prevention', () => {
  it('a single big buy does not confirm manipulation', async () => {
    const pid = await newPlayer(world, 'oneoff');
    const biz = await world.chooseBusiness(pid, 'bakery');
    biz.level = 3;
    world.players.get(pid)!.cash = 100_000_000;
    world.wholesale.get('wheat')!.remaining = WHOLESALE_DAILY_STOCK.wheat!;
    await world.buyNpc(pid, 'wheat', WHOLESALE_DAILY_STOCK.wheat! + 20); // one aggressive day
    await world.devRolloverWholesale();
    const rec = world.integrityOf(cid(world, pid))!;
    expect(rec.state).not.toBe('confirmed');
    expect(rec.state).not.toBe('investigating');
    expect((await world.computeCompanyProfile(cid(world, pid), pid))!.warning).toBeNull();
  });
});
