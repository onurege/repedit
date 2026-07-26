import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld } from './helpers.js';
import { closeDb, query } from '../src/db.js';
import { GameError, type World } from '../src/game/world.js';
import { UPDATES, TUTORIAL_LAST_STEP, COMPANY_LEVELS } from '@district/shared';

let world: World;

beforeEach(async () => {
  await resetDb();
  world = await loadedWorld();
});

afterAll(async () => {
  await closeDb();
});

// V2.8 Phase 2: retail draws from finished bread stock (production is manual).
function sellBread(w: World, biz: any, stock: number, seconds: number): number {
  biz.inv.get('bread')!.qty = stock;
  const before = biz.coffeeSold;
  w.simulate(biz, seconds, true);
  return biz.coffeeSold - before;
}

const BAKERY_LOTS = ['bakery_1', 'bakery_2', 'bakery_3'];
function vacantBakery(w: World): string {
  const taken = new Set([...w.businesses.values()].map((b) => b.lotId));
  return BAKERY_LOTS.find((l) => !taken.has(l))!;
}

describe('morning brief', () => {
  it('aggregates while-away economics and current market for a returning player', async () => {
    const pid = await newPlayer(world, 'onur');
    const biz = await world.chooseBusiness(pid, 'bakery');
    const sold = sellBread(world, biz, 3000, 500);
    await world.flush();

    // Synthetic away window covering the just-recorded activity.
    const brief = (await world.buildBrief(pid, {
      seconds: 3600, revenue: 0, expenses: 0, profit: 0, milkProduced: 0, coffeeSold: sold,
    }))!;
    expect(brief).toBeTruthy();
    expect(brief.companyName).toBe('onur Co.');
    expect(brief.revenue).toBeGreaterThan(0);
    expect(brief.sales.find((s) => s.product === 'bread')!.units).toBe(sold);
    expect(brief.market.find((m) => m.product === 'bread')).toBeTruthy();
  });

  it('sums sales across every business the company owns', async () => {
    const pid = await newPlayer(world, 'multi');
    const b1 = await world.chooseBusiness(pid, 'bakery');
    world.players.get(pid)!.cash = 100000;
    await world.devCommand(pid, 'company_xp', COMPANY_LEVELS[2].xp);
    const b2 = await world.openBusiness(pid, vacantBakery(world), 'bakery');
    const s1 = sellBread(world, b1, 3000, 400);
    const s2 = sellBread(world, b2, 3000, 400);
    await world.flush();

    const brief = (await world.buildBrief(pid, {
      seconds: 3600, revenue: 0, expenses: 0, profit: 0, milkProduced: 0, coffeeSold: s1 + s2,
    }))!;
    expect(brief.sales.find((s) => s.product === 'bread')!.units).toBe(s1 + s2);
  });

  it('returns null for a brand-new player with no business', async () => {
    const pid = await newPlayer(world, 'newbie');
    expect(await world.buildBrief(pid, null)).toBeNull();
  });
});

describe('business alerts', () => {
  it('flags sold-out and low input stock', async () => {
    const pid = await newPlayer(world, 'baker');
    const biz = await world.chooseBusiness(pid, 'bakery');
    biz.inv.get('wheat')!.qty = 0;
    biz.inv.get('bread')!.qty = 0;
    biz.status = 'out_of_stock';
    const alerts = world.computeAlerts(pid);
    expect(alerts.some((a) => a.kind === 'sold_out')).toBe(true);
    expect(alerts.some((a) => a.kind === 'low_stock' && a.product === 'wheat')).toBe(true);
  });

  it('flags a farm at full storage capacity', async () => {
    const pid = await newPlayer(world, 'farmer');
    const biz = await world.chooseBusiness(pid, 'farm');
    biz.status = 'storage_full';
    expect(world.computeAlerts(pid).some((a) => a.kind === 'capacity_full')).toBe(true);
  });

  it('surfaces a missed contract as a critical alert, sorted first', async () => {
    const pid = await newPlayer(world, 'supplier');
    const farm = await world.chooseBusiness(pid, 'farm');
    farm.status = 'storage_full'; // a lesser alert exists too
    // Inject a contract currently in a missed state for this player.
    (world.contracts as Map<number, any>).set(999, {
      id: 999, sellerId: pid, buyerId: -1, sellerBizId: farm.id, buyerBizId: -1,
      lastResult: 'missed_stock', status: 'active',
    });
    const alerts = world.computeAlerts(pid);
    expect(alerts[0].kind).toBe('missed_contract');
    expect(alerts[0].severity).toBe('critical');
  });
});

describe('opportunity (deterministic)', () => {
  it('recommends stocking up before an announced event that raises a sold product', async () => {
    const pid = await newPlayer(world, 'bakerA');
    await world.chooseBusiness(pid, 'bakery');
    // V2.8 Phase 3: City Festival raises cake demand; the bakery sells cake.
    await world.createEvent('city_festival', { announceSecs: 60, durationSecs: 120 });
    await world.processEvents();
    const opp = world.computeOpportunity(pid, new Set(['cake']), []);
    expect(opp!.kind).toBe('event_stock_up');
    expect(opp!.product).toBe('cake');
  });

  it('recommends supplier action to a farm during a supply disruption', async () => {
    const pid = await newPlayer(world, 'farmA');
    await world.chooseBusiness(pid, 'farm');
    const e = await world.createEvent('supply_disruption', { announceSecs: 1, durationSecs: 120 });
    await world.processEvents(e.startsAtMs + 1);
    const opp = world.computeOpportunity(pid, new Set(), []);
    expect(opp!.kind).toBe('supplier_demand');
  });

  it('nudges a new bakery toward its first upgrade when the city is calm', async () => {
    const pid = await newPlayer(world, 'calm');
    await world.chooseBusiness(pid, 'bakery');
    const opp = world.computeOpportunity(pid, new Set(['bread']), []);
    expect(opp!.kind).toBe('first_upgrade');
  });
});

describe("what's new / update tracking", () => {
  it('a new player is caught up (no update backlog)', async () => {
    const pid = await newPlayer(world, 'fresh');
    await world.getTutorial(pid); // creating tutorial marks updates seen
    expect((await world.unseenUpdates(pid)).length).toBe(0);
  });

  it('a returning player sees an update once', async () => {
    const pid = await newPlayer(world, 'returning');
    // Simulate a pre-existing player who has not been seeded.
    expect((await world.unseenUpdates(pid)).length).toBe(UPDATES.length);
    await world.markUpdateSeen(pid, UPDATES[0].id);
    const unseen = await world.unseenUpdates(pid);
    expect(unseen.find((u) => u.id === UPDATES[0].id)).toBeUndefined();
    expect(unseen.length).toBe(UPDATES.length - 1);
  });
});

describe('tutorial progress', () => {
  it('advances, persists across restart, and can be skipped', async () => {
    const pid = await newPlayer(world, 'student');
    let state = await world.getTutorial(pid);
    expect(state.currentStep).toBe(0);
    state = await world.advanceTutorial(pid, 1);
    expect(state.currentStep).toBe(2);
    expect(state.completedSteps).toContain(1);

    // Restart: progress restored from the DB.
    const world2 = await loadedWorld();
    const restored = await world2.getTutorial(pid);
    expect(restored.currentStep).toBe(2);
    expect(restored.completedSteps).toContain(1);

    const skipped = await world2.skipTutorial(pid);
    expect(skipped.skipped).toBe(true);
    expect(skipped.done).toBe(true);
  });

  it('does not advance once skipped', async () => {
    const pid = await newPlayer(world, 'skipper');
    await world.skipTutorial(pid);
    const state = await world.advanceTutorial(pid, 3);
    expect(state.skipped).toBe(true);
  });
});

describe('admin announcements', () => {
  it('rejects announcements from non-admins', async () => {
    const pid = await newPlayer(world, 'joe');
    await expect(world.createAnnouncement(pid, {
      title: 'Hello city', message: 'Test message', kind: 'general', priority: 'normal',
    })).rejects.toThrow(GameError);
  });

  it('lets an admin create an announcement that appears in the active list', async () => {
    const pid = await newPlayer(world, 'admin');
    world.players.get(pid)!.isAdmin = true;
    const a = await world.createAnnouncement(pid, {
      title: 'City Festival', message: 'Prepare your businesses.', kind: 'event', priority: 'important',
    });
    expect(a.id).toBeGreaterThan(0);
    const active = await world.activeAnnouncements();
    expect(active.find((x) => x.id === a.id)).toBeTruthy();
  });

  it('validates title/message length', async () => {
    const pid = await newPlayer(world, 'admin2');
    world.players.get(pid)!.isAdmin = true;
    await expect(world.createAnnouncement(pid, {
      title: 'x', message: 'ok message', kind: 'general', priority: 'normal',
    })).rejects.toThrow(GameError);
  });

  it('excludes expired announcements from the active list but keeps them in history', async () => {
    const pid = await newPlayer(world, 'admin3');
    world.players.get(pid)!.isAdmin = true;
    const a = await world.createAnnouncement(pid, {
      title: 'Old news', message: 'This will expire.', kind: 'general', priority: 'normal', durationSecs: 60,
    });
    await query(`UPDATE announcements SET expires_at = now() - interval '1 minute' WHERE id=$1`, [a.id]);
    expect((await world.activeAnnouncements()).find((x) => x.id === a.id)).toBeUndefined();
    expect((await world.announcementHistory()).find((x) => x.id === a.id)).toBeTruthy();
  });
});
