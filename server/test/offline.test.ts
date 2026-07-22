import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld } from './helpers.js';
import { closeDb, query } from '../src/db.js';
import type { World } from '../src/game/world.js';
import { OFFLINE_CAP_SECONDS, FARM_LEVELS } from '@district/shared';

let world: World;

beforeEach(async () => {
  await resetDb();
  world = await loadedWorld();
});

afterAll(async () => {
  await closeDb();
});

describe('offline progression & away report', () => {
  it('reports profit and production accumulated while disconnected', async () => {
    const pid = await newPlayer(world, 'sleeper');
    const biz = await world.chooseBusiness(pid, 'farm');
    world.connect(pid);
    world.disconnect(pid); // snapshot taken here
    const p = world.players.get(pid)!;
    expect(p.awaySnapshot).not.toBeNull();
    // pretend the player was gone 10 minutes while the farm worked
    p.awaySnapshot!.ts = Date.now() - 10 * 60 * 1000;
    world.simulate(biz, 300, true);
    const report = world.connect(pid);
    expect(report).not.toBeNull();
    expect(report!.milkProduced).toBe(150); // 300s * 0.5/s (below storage cap)
    expect(report!.seconds).toBeGreaterThanOrEqual(599);
  });

  it('server-restart catch-up simulates capped downtime from sim_ts', async () => {
    const pid = await newPlayer(world, 'restarter');
    const biz = await world.chooseBusiness(pid, 'farm');
    await world.flush();
    // Backdate sim_ts and last_seen by 30 minutes, then load a fresh world (restart).
    await query(`UPDATE businesses SET sim_ts = now() - interval '30 minutes' WHERE id=$1`, [biz.id]);
    await query(`UPDATE players SET last_seen = now() - interval '30 minutes' WHERE id=$1`, [pid]);
    const world2 = await loadedWorld();
    const biz2 = world2.bizByOwner(pid)!;
    // ~1800s * 0.5/s = 900 wanted, clamped by L1 storage capacity (200)
    expect(biz2.milkProduced).toBe(FARM_LEVELS[1].milkCapacity);
    expect(biz2.inv.get('milk')!.qty).toBe(FARM_LEVELS[1].milkCapacity);
    expect(biz2.status).toBe('storage_full');
  });

  it('pauses businesses whose owner is away longer than the cap', async () => {
    const pid = await newPlayer(world, 'ghost');
    const biz = await world.chooseBusiness(pid, 'farm');
    const p = world.players.get(pid)!;
    p.lastSeenMs = Date.now() - (OFFLINE_CAP_SECONDS + 3600) * 1000;
    const before = biz.milkProduced;
    await world.tick(60);
    expect(biz.milkProduced).toBe(before);
    expect(biz.status).toBe('paused_away');
  });
});

describe('persistence across restart', () => {
  it('players, businesses, inventory, orders and upgrades survive reload', async () => {
    const shopId = await newPlayer(world, 'persist_shop');
    const farmId = await newPlayer(world, 'persist_farm');
    await world.chooseBusiness(shopId, 'coffee_shop');
    const farm = await world.chooseBusiness(farmId, 'farm');
    farm.inv.get('milk')!.qty = 120;
    world.players.get(farmId)!.cash = 55555;
    await world.upgrade(shopId);
    const order = await world.createOrder(farmId, 'sell', 'milk', 100, 13);
    await world.flush();

    const world2 = await loadedWorld();
    expect(world2.players.get(farmId)!.cash).toBe(55555);
    const farm2 = world2.bizByOwner(farmId)!;
    expect(farm2.inv.get('milk')!.qty).toBe(20);
    expect(farm2.inv.get('milk')!.reserved).toBe(100);
    expect(world2.bizByOwner(shopId)!.level).toBe(2);
    expect(world2.orders.get(order.id)!.remaining).toBe(100);
  });
});
