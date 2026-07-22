import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld } from './helpers.js';
import { closeDb } from '../src/db.js';
import { GameError, type World } from '../src/game/world.js';
import { FARM_LEVELS, STARTING_CASH } from '@district/shared';

let world: World;

beforeEach(async () => {
  await resetDb();
  world = await loadedWorld();
});

afterAll(async () => {
  await closeDb();
});

describe('business upgrades', () => {
  it('deducts cost, raises level, awards XP', async () => {
    const pid = await newPlayer(world, 'upgrader');
    await world.chooseBusiness(pid, 'farm');
    await world.upgrade(pid);
    const p = world.players.get(pid)!;
    const biz = world.bizByOwner(pid)!;
    expect(biz.level).toBe(2);
    expect(p.cash).toBe(STARTING_CASH - FARM_LEVELS[1].upgradeCost!);
    expect(p.xp).toBeGreaterThan(0);
    expect(biz.expenses).toBe(FARM_LEVELS[1].upgradeCost);
  });

  it('rejects upgrades without funds and beyond max level', async () => {
    const pid = await newPlayer(world, 'poor');
    await world.chooseBusiness(pid, 'farm');
    const p = world.players.get(pid)!;
    p.cash = 10;
    await expect(world.upgrade(pid)).rejects.toThrow(GameError);
    expect(world.bizByOwner(pid)!.level).toBe(1);
    p.cash = 1000000;
    await world.upgrade(pid);
    await world.upgrade(pid);
    await expect(world.upgrade(pid)).rejects.toThrow(GameError);
    expect(world.bizByOwner(pid)!.level).toBe(3);
  });

  it('upgrade raises production capability', async () => {
    const pid = await newPlayer(world, 'grower');
    const biz = await world.chooseBusiness(pid, 'farm');
    world.players.get(pid)!.cash = 100000;
    world.simulate(biz, 60, true);
    const l1 = biz.milkProduced;
    await world.upgrade(pid);
    biz.milkProduced = 0;
    biz.inv.get('milk')!.qty = 0;
    world.simulate(biz, 60, true);
    expect(biz.milkProduced).toBeGreaterThan(l1);
  });
});
