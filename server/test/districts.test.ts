// V2.6 — multi-district city.
//
// Covers the architecture guarantees rather than the specific map: that
// districts are data-driven, that pre-district businesses land in Old Town
// untouched, that capacity/economy stay company- and city-wide, and that the
// same-lot race is still decided by exactly one winner.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DISTRICTS,
  districtById,
  districtLots,
  lotById,
  lotsOfKind,
  roadPath,
  pathLength,
  CONNECTORS,
  ROAD_SEGMENTS,
  LOTS,
  type DistrictId,
} from '@district/shared';
import { GameError } from '../src/game/world.js';
import { query } from '../src/db.js';
import { resetDb, newPlayer, loadedWorld } from './helpers.js';

describe('district definitions', () => {
  it('exposes at least two districts with unique ids and unlock order', () => {
    expect(DISTRICTS.length).toBeGreaterThanOrEqual(2);
    const ids = DISTRICTS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    const orders = DISTRICTS.map((d) => d.unlockOrder).sort((a, b) => a - b);
    expect(orders[0]).toBe(1);
  });

  it('keeps every original lot id in Old Town at its original position', () => {
    // Any of these moving would relocate a live player's business.
    const originals: [string, number, number][] = [
      ['farm_1', -21, -58],
      ['cafe_1', -14, -14],
      ['bakery_1', -28, -28],
      ['market_1', -28, 28],
      ['wholesale', 16, -14],
    ];
    for (const [id, x, z] of originals) {
      const lot = lotById(id);
      expect(lot, `${id} must still exist`).toBeDefined();
      expect(lot!.district).toBe('old_town');
      expect(lot!.x).toBe(x);
      expect(lot!.z).toBe(z);
    }
  });

  it('every lot belongs to a declared district', () => {
    for (const lot of LOTS) {
      expect(districtById(lot.district), `${lot.id}`).toBeDefined();
    }
  });

  it('ships an expansion district with meaningful, balanced capacity', () => {
    const expansion = DISTRICTS.filter((d) => d.unlockOrder > 1);
    expect(expansion.length).toBeGreaterThan(0);
    for (const d of expansion) {
      const lots = districtLots(d.id);
      expect(lots.length).toBeGreaterThanOrEqual(20);
      expect(lots.length).toBeLessThanOrEqual(30);
      // No business type may become the new bottleneck.
      for (const kind of ['farm', 'coffee_shop', 'bakery', 'mini_market'] as const) {
        expect(lots.filter((l) => l.kind === kind).length, `${d.id}/${kind}`).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('places no two lots on top of each other within a district', () => {
    const half = (kind: string) => (kind === 'farm' ? { x: 7.5, z: 5.5 } : { x: 5.5, z: 4.5 });
    const expansion = DISTRICTS.filter((d) => d.unlockOrder > 1).map((d) => d.id);
    const lots = LOTS.filter((l) => expansion.includes(l.district));
    for (let i = 0; i < lots.length; i++) {
      for (let j = i + 1; j < lots.length; j++) {
        const a = lots[i];
        const b = lots[j];
        const ha = half(a.kind);
        const hb = half(b.kind);
        const overlaps =
          Math.abs(a.x - b.x) < ha.x + hb.x && Math.abs(a.z - b.z) < ha.z + hb.z;
        expect(overlaps, `${a.id} overlaps ${b.id}`).toBe(false);
      }
    }
  });
});

describe('cross-district road graph', () => {
  it('declares a connector joining the districts', () => {
    expect(CONNECTORS.length).toBeGreaterThan(0);
    expect(ROAD_SEGMENTS.length).toBeGreaterThan(CONNECTORS.length);
  });

  it('routes between districts over the connector, never through empty space', () => {
    const from = lotsOfKind('farm', 'green_valley')[0];
    const to = lotsOfKind('bakery', 'old_town')[0];
    const path = roadPath(from, to);
    const len = pathLength(path);
    // A road route can never be shorter than the straight line.
    expect(len).toBeGreaterThanOrEqual(Math.hypot(from.x - to.x, from.z - to.z));
    const conn = CONNECTORS[0];
    const usesConnector = path.some(
      (p, i) =>
        i > 0 &&
        Math.abs(p.z - conn.z1) < 0.05 &&
        (Math.abs(p.x - conn.x1) < 0.05 || Math.abs(p.x - conn.x2) < 0.05)
    );
    expect(usesConnector).toBe(true);
  });

  it('keeps intra-district routes off the connector', () => {
    const a = lotsOfKind('farm', 'old_town')[0];
    const b = lotsOfKind('coffee_shop', 'old_town')[0];
    const path = roadPath(a, b);
    const conn = CONNECTORS[0];
    const strays = path.some((p) => p.x > conn.x1 + 1 && p.x < conn.x2 - 1);
    expect(strays).toBe(false);
  });

  it('reaches every lot from Central Wholesale', () => {
    const depot = lotById('wholesale')!;
    for (const lot of LOTS) {
      if (lot.id === depot.id) continue;
      expect(pathLength(roadPath(depot, lot)), lot.id).toBeGreaterThan(0);
    }
  });
});

describe('districts in the running world', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('reports occupancy per district and totals across the city', async () => {
    const world = await loadedWorld();
    const before = world.districtOccupancy();
    expect(before.length).toBe(DISTRICTS.length);
    expect(before[0].unlockOrder).toBe(1);
    const totalLots = before.reduce((n, d) => n + d.total, 0);
    expect(totalLots).toBe(LOTS.filter((l) => l.kind !== 'wholesale').length);
    for (const d of before) expect(d.occupied).toBe(0);

    const pid = await newPlayer(world, 'occ');
    await world.chooseBusiness(pid, 'farm');
    const after = world.districtOccupancy();
    expect(after.reduce((n, d) => n + d.occupied, 0)).toBe(1);
    // A first business goes to the earliest-unlocked district.
    expect(after[0].occupied).toBe(1);
  });

  it('tags a business with the district of its lot', async () => {
    const world = await loadedWorld();
    const pid = await newPlayer(world, 'tag');
    const biz = await world.chooseBusiness(pid, 'farm');
    const pub = world.toBizPub(biz);
    expect(pub.district).toBe(lotById(biz.lotId)!.district);
    expect(pub.district).toBe('old_town');
  });

  it('lets one company own businesses in several districts on shared capacity', async () => {
    const world = await loadedWorld();
    const pid = await newPlayer(world, 'multi');
    await world.chooseBusiness(pid, 'farm');
    const player = world.players.get(pid)!;
    player.cash = 500_000;
    const company = world.companyByOwner(pid)!;
    company.level = 5; // plenty of management capacity for this test

    const gvLot = districtLots('green_valley').find((l) => l.kind === 'coffee_shop')!;
    const biz = await world.openBusiness(pid, gvLot.id, 'coffee_shop');
    expect(lotById(biz.lotId)!.district).toBe('green_valley');

    const owned = world.bizesByOwner(pid);
    expect(owned.length).toBe(2);
    // One company, one capacity pool — not one per district.
    const districts = new Set(owned.map((b) => lotById(b.lotId)!.district));
    expect(districts.size).toBe(2);
    expect(owned.every((b) => b.companyId === company.id)).toBe(true);
  });

  it('gives an expansion lot to exactly one of two racing players', async () => {
    const world = await loadedWorld();
    const a = await newPlayer(world, 'racerA');
    const b = await newPlayer(world, 'racerB');
    await world.chooseBusiness(a, 'farm');
    await world.chooseBusiness(b, 'farm');
    for (const pid of [a, b]) {
      world.players.get(pid)!.cash = 500_000;
      world.companyByOwner(pid)!.level = 5;
    }
    const lot = districtLots('green_valley').find((l) => l.kind === 'bakery')!;

    const results = await Promise.allSettled([
      world.openBusiness(a, lot.id, 'bakery'),
      world.openBusiness(b, lot.id, 'bakery'),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok.length).toBe(1);
    expect(failed.length).toBe(1);
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(GameError);
    // The lot is occupied exactly once.
    expect([...world.businesses.values()].filter((x) => x.lotId === lot.id).length).toBe(1);
  });

  it('does not charge the loser of a lot race', async () => {
    const world = await loadedWorld();
    const a = await newPlayer(world, 'payA');
    const b = await newPlayer(world, 'payB');
    await world.chooseBusiness(a, 'farm');
    await world.chooseBusiness(b, 'farm');
    for (const pid of [a, b]) {
      world.players.get(pid)!.cash = 500_000;
      world.companyByOwner(pid)!.level = 5;
    }
    const lot = districtLots('green_valley').find((l) => l.kind === 'mini_market')!;
    await world.openBusiness(a, lot.id, 'mini_market');

    const before = world.players.get(b)!.cash;
    await expect(world.openBusiness(b, lot.id, 'mini_market')).rejects.toBeInstanceOf(GameError);
    expect(world.players.get(b)!.cash).toBe(before);
    expect(world.bizesByOwner(b).length).toBe(1);
  });

  it('publishes only public information in city status', async () => {
    const world = await loadedWorld();
    const pid = await newPlayer(world, 'pub');
    await world.chooseBusiness(pid, 'bakery');
    const status = world.getCityStatus();
    expect(status.businesses).toBe(1);
    expect(status.totalLots).toBe(LOTS.filter((l) => l.kind !== 'wholesale').length);
    expect(status.districts.length).toBe(DISTRICTS.length);
    expect(status.recent[0].bizType).toBe('bakery');
    // No private fields may leak into the public payload.
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('cash');
    expect(serialized).not.toContain('inventory');
  });

  it('spills a first business into the next district once the centre is full', async () => {
    const world = await loadedWorld();
    // Fill every Old Town bakery lot.
    const oldBakeries = lotsOfKind('bakery', 'old_town');
    for (let i = 0; i < oldBakeries.length; i++) {
      const pid = await newPlayer(world, `fill${i}`);
      await world.chooseBusiness(pid, 'bakery');
    }
    const occ = world.districtOccupancy();
    expect(occ.find((d) => d.id === 'old_town')!.freeByType.bakery ?? 0).toBe(0);

    const late = await newPlayer(world, 'late');
    const biz = await world.chooseBusiness(late, 'bakery');
    expect(lotById(biz.lotId)!.district).not.toBe('old_town');
  });

  it('fails gracefully once every district is built out', async () => {
    const world = await loadedWorld();
    const all = lotsOfKind('mini_market');
    for (let i = 0; i < all.length; i++) {
      const pid = await newPlayer(world, `mk${i}`);
      await world.chooseBusiness(pid, 'mini_market');
    }
    const extra = await newPlayer(world, 'nolots');
    await expect(world.chooseBusiness(extra, 'mini_market')).rejects.toBeInstanceOf(GameError);
    // The player survives the refusal with their cash intact.
    expect(world.players.get(extra)!.cash).toBeGreaterThan(0);
    expect(world.bizByOwner(extra)).toBeUndefined();
  });

  it('shows V2.6 as unseen to a player who existed before the release', async () => {
    const world = await loadedWorld();
    const pid = await newPlayer(world, 'veteran');
    // Registering marks the current release notes as seen. A player who
    // existed *before* V2.6 shipped has no seen-row for it — reproduce that.
    await world.getTutorial(pid);
    await query('DELETE FROM player_seen_updates WHERE player_id=$1 AND update_id=$2', [pid, 'v2_6']);

    const unseen = await world.unseenUpdates(pid);
    expect(unseen.map((u) => u.id)).toContain('v2_6');
    expect(world.allUpdates().map((u) => u.id)).toContain('v2_6');

    // Acknowledging it clears it, and it stays cleared.
    await world.markUpdateSeen(pid, 'v2_6');
    expect((await world.unseenUpdates(pid)).map((u) => u.id)).not.toContain('v2_6');
  });

  it('keeps district assignment across a world reload', async () => {
    const world = await loadedWorld();
    const pid = await newPlayer(world, 'persist');
    await world.chooseBusiness(pid, 'farm');
    world.players.get(pid)!.cash = 500_000;
    world.companyByOwner(pid)!.level = 5;
    const gvLot = districtLots('green_valley').find((l) => l.kind === 'farm')!;
    await world.openBusiness(pid, gvLot.id, 'farm');
    await world.flush();

    const reloaded = await loadedWorld();
    const owned = reloaded.bizesByOwner(pid);
    expect(owned.length).toBe(2);
    const districts = new Set(owned.map((b) => lotById(b.lotId)!.district as DistrictId));
    expect(districts.has('old_town')).toBe(true);
    expect(districts.has('green_valley')).toBe(true);
  });
});
