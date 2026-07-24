// V2.6.1 — custom business names.
import { describe, it, expect, beforeEach } from 'vitest';
import { BUSINESS_NAME_MAX } from '@district/shared';
import { GameError } from '../src/game/world.js';
import { resetDb, newPlayer, loadedWorld } from './helpers.js';

describe('business names', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('defaults to no custom name (public card falls back to the default label)', async () => {
    const world = await loadedWorld();
    const pid = await newPlayer(world, 'namer');
    const biz = await world.chooseBusiness(pid, 'farm');
    expect(biz.name).toBeNull();
    expect(world.toBizPub(biz).name).toBeNull();
  });

  it('sets and persists a custom name', async () => {
    const world = await loadedWorld();
    const pid = await newPlayer(world, 'namer');
    const biz = await world.chooseBusiness(pid, 'farm');
    await world.renameBusiness(pid, '  Sunny  Dairy  ', biz.id);
    // Whitespace is collapsed and trimmed.
    expect(biz.name).toBe('Sunny Dairy');
    expect(world.toBizPub(biz).name).toBe('Sunny Dairy');

    const reloaded = await loadedWorld();
    expect(reloaded.businesses.get(biz.id)!.name).toBe('Sunny Dairy');
  });

  it('clears the name when given an empty string', async () => {
    const world = await loadedWorld();
    const pid = await newPlayer(world, 'namer');
    const biz = await world.chooseBusiness(pid, 'farm');
    await world.renameBusiness(pid, 'Temp', biz.id);
    expect(biz.name).toBe('Temp');
    await world.renameBusiness(pid, '   ', biz.id);
    expect(biz.name).toBeNull();
    const reloaded = await loadedWorld();
    expect(reloaded.businesses.get(biz.id)!.name).toBeNull();
  });

  it('rejects a name that is too long and never mutates state on rejection', async () => {
    const world = await loadedWorld();
    const pid = await newPlayer(world, 'namer');
    const biz = await world.chooseBusiness(pid, 'farm');
    await world.renameBusiness(pid, 'Good Name', biz.id);
    await expect(
      world.renameBusiness(pid, 'x'.repeat(BUSINESS_NAME_MAX + 1), biz.id)
    ).rejects.toBeInstanceOf(GameError);
    expect(biz.name).toBe('Good Name');
  });

  it('strips angle brackets to prevent markup injection', async () => {
    const world = await loadedWorld();
    const pid = await newPlayer(world, 'namer');
    const biz = await world.chooseBusiness(pid, 'farm');
    await world.renameBusiness(pid, '<b>Cafe</b>', biz.id);
    expect(biz.name).not.toContain('<');
    expect(biz.name).not.toContain('>');
  });

  it('names the right business when a company owns several', async () => {
    const world = await loadedWorld();
    const pid = await newPlayer(world, 'multi');
    const first = await world.chooseBusiness(pid, 'farm');
    world.players.get(pid)!.cash = 500_000;
    world.companyByOwner(pid)!.level = 5;
    const gvLot = [...world.businesses.values()]; // ensure first exists
    void gvLot;
    // open a second business on a free coffee lot
    const freeCoffee = (await import('@district/shared')).lotsOfKind('coffee_shop')
      .find((l) => ![...world.businesses.values()].some((b) => b.lotId === l.id))!;
    const second = await world.openBusiness(pid, freeCoffee.id, 'coffee_shop');

    await world.renameBusiness(pid, 'Second Only', second.id);
    expect(second.name).toBe('Second Only');
    expect(first.name).toBeNull();
  });
});
