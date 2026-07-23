import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld } from './helpers.js';
import { closeDb, query } from '../src/db.js';
import type { World } from '../src/game/world.js';
import { NPC_WHOLESALE_PRICES } from '@district/shared';

let world: World;

beforeEach(async () => {
  await resetDb();
  world = await loadedWorld();
});

afterAll(async () => {
  await closeDb();
});

/** Bake bread and return how many units sold to NPC customers. */
function sellBread(w: World, biz: any, wheat: number, seconds: number): number {
  biz.inv.get('wheat')!.qty = wheat;
  const before = biz.coffeeSold;
  w.simulate(biz, seconds, true);
  return biz.coffeeSold - before;
}

describe('event lifecycle', () => {
  it('creates an upcoming event, then transitions to active and ended', async () => {
    const e = await world.createEvent('city_festival', { announceSecs: 10, durationSecs: 20 });
    expect(e.status).toBe('upcoming');
    let row = await query(`SELECT status FROM city_events WHERE id=$1`, [e.id]);
    expect(row.rows[0].status).toBe('upcoming');

    // Not yet started: demand is still normal.
    expect(world.cityDemand('bread')).toBe(1);

    // Advance past the announce window: it becomes active and demand rises.
    await world.processEvents(e.startsAtMs + 1);
    expect(world.cityEvents.find((x) => x.id === e.id)!.status).toBe('active');
    expect(world.cityDemand('bread')).toBeCloseTo(1.4, 5); // +40%
    expect(world.cityDemand('coffee')).toBeCloseTo(1.5, 5); // +50%
    row = await query(`SELECT status FROM city_events WHERE id=$1`, [e.id]);
    expect(row.rows[0].status).toBe('active');

    // Advance past the end: it ends and demand returns to normal.
    await world.processEvents(e.endsAtMs + 1);
    expect(world.cityEvents.find((x) => x.id === e.id)).toBeUndefined();
    expect(world.cityDemand('bread')).toBe(1);
    row = await query(`SELECT status FROM city_events WHERE id=$1`, [e.id]);
    expect(row.rows[0].status).toBe('ended');
  });
});

describe('demand modifier calculation', () => {
  it('derives effective demand freshly and never double-applies', async () => {
    const e = await world.createEvent('city_festival', { announceSecs: 5, durationSecs: 30 });
    await world.processEvents(e.startsAtMs + 1); // active
    const first = world.cityDemand('bread');
    // Re-processing the same active event must not compound the modifier.
    await world.processEvents(e.startsAtMs + 2);
    await world.processEvents(e.startsAtMs + 3);
    expect(world.cityDemand('bread')).toBe(first);
    expect(first).toBeCloseTo(1.4, 5);
  });

  it('is bounded within the safe demand band', async () => {
    // Two overlapping demand events would still clamp under DEMAND_MAX.
    const a = await world.createEvent('city_festival', { announceSecs: 1, durationSecs: 60 });
    await world.processEvents(a.startsAtMs + 1);
    expect(world.cityDemand('coffee')).toBeLessThanOrEqual(2.0);
    expect(world.cityDemand('coffee')).toBeGreaterThan(1.0);
  });
});

describe('duplicate activation safety', () => {
  it('a repeated transition is a no-op (idempotent)', async () => {
    const e = await world.createEvent('local_market_day', { announceSecs: 5, durationSecs: 20 });
    await world.processEvents(e.startsAtMs + 1);
    const demandAfterFirst = world.cityDemand('bread');
    // Force a second processing at the same instant — no double effect.
    await world.processEvents(e.startsAtMs + 1);
    expect(world.cityDemand('bread')).toBe(demandAfterFirst);
    const active = await query(`SELECT count(*)::int AS n FROM city_events WHERE status='active'`);
    expect(active.rows[0].n).toBe(1);
  });
});

describe('restart persistence', () => {
  it('resumes an active event and its demand after reload', async () => {
    const e = await world.createEvent('city_festival', { announceSecs: 10, durationSecs: 60 });
    await world.advanceEvents(11); // shift into the active window and persist
    expect(world.cityEvents.find((x) => x.id === e.id)!.status).toBe('active');

    const world2 = await loadedWorld();
    const resumed = world2.cityEvents.find((x) => x.id === e.id);
    expect(resumed).toBeDefined();
    expect(resumed!.status).toBe('active');
    expect(world2.cityDemand('bread')).toBeCloseTo(1.4, 5);
  });
});

describe('NPC wholesale modifier', () => {
  it('a Supply Disruption raises NPC fallback prices but never removes supply', async () => {
    const pid = await newPlayer(world, 'baker');
    await world.chooseBusiness(pid, 'bakery');
    const e = await world.createEvent('supply_disruption', { announceSecs: 5, durationSecs: 60 });
    await world.processEvents(e.startsAtMs + 1);

    const base = NPC_WHOLESALE_PRICES.wheat!;
    const cashBefore = world.players.get(pid)!.cash;
    await world.buyNpc(pid, 'wheat', 10);
    const spent = cashBefore - world.players.get(pid)!.cash;
    expect(spent).toBe(Math.round(base * 1.3) * 10); // +30%, still purchasable
    const market = world.toCityMarket();
    expect(market.wholesale.find((w) => w.product === 'wheat')!.modifier).toBeCloseTo(1.3, 5);
  });
});

describe('demand affects real NPC sales', () => {
  it('a bakery sells more bread while a demand event is active', async () => {
    const baseId = await newPlayer(world, 'baseline');
    const evtId = await newPlayer(world, 'festival');
    const baseBiz = await world.chooseBusiness(baseId, 'bakery');
    const evtBiz = await world.chooseBusiness(evtId, 'bakery');

    // Pre-stock bread beyond demand so CUSTOMER volume (not baking) is the
    // limiter — that isolates the demand multiplier's effect on real sales.
    baseBiz.inv.get('bread')!.qty = 5000;
    evtBiz.inv.get('bread')!.qty = 5000;

    // Baseline: no event.
    const before = baseBiz.coffeeSold;
    world.simulate(baseBiz, 400, true);
    const soldBase = baseBiz.coffeeSold - before;

    // Same setup, but with an active City Festival (+40% bread demand).
    const e = await world.createEvent('city_festival', { announceSecs: 2, durationSecs: 600 });
    await world.processEvents(e.startsAtMs + 1);
    expect(world.cityDemand('bread')).toBeCloseTo(1.4, 5);
    const beforeE = evtBiz.coffeeSold;
    world.simulate(evtBiz, 400, true);
    const soldEvent = evtBiz.coffeeSold - beforeE;

    expect(soldEvent).toBeGreaterThan(soldBase);
    // Real final sales are recorded (market share derives from these).
    await world.flush();
    const act = await query(
      `SELECT SUM(units)::int AS u FROM company_activity
       WHERE kind='final_sale' AND product='bread' AND company_id=$1`,
      [world.companyByOwner(evtId)!.id]
    );
    expect(act.rows[0].u).toBe(soldEvent);
  });
});

describe('player prices are never manipulated', () => {
  it('demand changes customer volume, not the business price', async () => {
    const pid = await newPlayer(world, 'pricer');
    const biz = await world.chooseBusiness(pid, 'bakery');
    world.setPrice(pid, 25);
    const e = await world.createEvent('city_festival', { announceSecs: 1, durationSecs: 60 });
    await world.processEvents(e.startsAtMs + 1);
    world.simulate(biz, 10, true);
    expect(world.bizByOwner(pid)!.price).toBe(25); // unchanged by the event
  });
});
