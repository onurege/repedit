// V2.8 Phase 1 — product economy: licenses, product slots, business XP/level.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld } from './helpers.js';
import { closeDb, query } from '../src/db.js';
import { GameError, type World, type BizRec } from '../src/game/world.js';
import { xpForBizLevel, bizLevelForXp } from '@district/shared';

let world: World;
beforeEach(async () => {
  await resetDb();
  world = await loadedWorld();
});
afterAll(async () => {
  await closeDb();
});

async function shop(w: World, name: string, cash = 100000): Promise<{ id: number; biz: BizRec }> {
  const id = await newPlayer(w, name);
  const biz = await w.chooseBusiness(id, 'coffee_shop');
  w.players.get(id)!.cash = cash;
  return { id, biz };
}
// Set a business's level directly (grants XP for the level) for license tests.
function setLevel(biz: BizRec, level: number): void {
  biz.bizXp = xpForBizLevel(level);
  biz.bizLevel = level;
}

describe('starter licenses (safe migration)', () => {
  it('a new business gets its type\'s starter licenses, all active', async () => {
    const { biz } = await shop(world, 'sm1');
    expect([...biz.licenses.keys()]).toEqual(['coffee']);
    expect(biz.licenses.get('coffee')).toBe('produce');
    expect(biz.activeProducts.has('coffee')).toBe(true);
  });

  it('a mini market keeps BOTH starter retail products active even at level 1 (grandfather)', async () => {
    const id = await newPlayer(world, 'mm1');
    const biz = await world.chooseBusiness(id, 'mini_market');
    expect([...biz.licenses.keys()].sort()).toEqual(['bread', 'milk']);
    expect(biz.activeProducts.size).toBe(2); // 2 starters even though L1 slot table = 1
    expect(biz.licenses.get('bread')).toBe('retail'); // retail, not produce
  });

  it('starter licenses persist across a restart', async () => {
    const { id } = await shop(world, 'sm2');
    const w2 = await loadedWorld();
    const biz = w2.bizByOwner(id)!;
    expect(biz.licenses.get('coffee')).toBe('produce');
    expect(biz.activeProducts.has('coffee')).toBe(true);
  });
});

describe('license purchase (server-authoritative, exactly-once)', () => {
  it('buys the latte license once: money out once, ledger once, license persists', async () => {
    const { id, biz } = await shop(world, 'lp1');
    setLevel(biz, 5); // latte requires level 5 + coffee prereq (coffee is starter)
    const cash0 = world.players.get(id)!.cash;
    await world.buyLicense(id, biz.id, 'latte');
    expect(biz.licenses.get('latte')).toBe('produce');
    expect(world.players.get(id)!.cash).toBe(cash0 - 4000);
    const led = await query(`SELECT count(*)::int c FROM economic_ledger WHERE transaction_type='PRODUCT_LICENSE'`);
    expect(led.rows[0].c).toBe(1);
    const w2 = await loadedWorld();
    expect(w2.bizByOwner(id)!.licenses.has('latte')).toBe(true);
  });

  it('rejects insufficient funds', async () => {
    const { id, biz } = await shop(world, 'lp2', 100);
    setLevel(biz, 5);
    await expect(world.buyLicense(id, biz.id, 'latte')).rejects.toBeInstanceOf(GameError);
    expect(biz.licenses.has('latte')).toBe(false);
  });

  it('rejects below the required business level', async () => {
    const { id, biz } = await shop(world, 'lp3');
    setLevel(biz, 4); // latte needs 5
    await expect(world.buyLicense(id, biz.id, 'latte')).rejects.toBeInstanceOf(GameError);
  });

  it('rejects a missing prerequisite license', async () => {
    const { id, biz } = await shop(world, 'lp4');
    setLevel(biz, 5);
    biz.licenses.delete('coffee'); // remove the prereq
    await expect(world.buyLicense(id, biz.id, 'latte')).rejects.toBeInstanceOf(GameError);
  });

  it('rejects a product incompatible with the business type', async () => {
    const { id, biz } = await shop(world, 'lp5');
    setLevel(biz, 10);
    await expect(world.buyLicense(id, biz.id, 'bread')).rejects.toBeInstanceOf(GameError); // coffee shop can't sell bread
  });

  it('rejects a duplicate purchase (already owned)', async () => {
    const { id, biz } = await shop(world, 'lp6');
    setLevel(biz, 5);
    await world.buyLicense(id, biz.id, 'latte');
    const cashAfter = world.players.get(id)!.cash;
    await expect(world.buyLicense(id, biz.id, 'latte')).rejects.toBeInstanceOf(GameError);
    expect(world.players.get(id)!.cash).toBe(cashAfter);
  });

  it('a concurrent double-buy charges once and grants one license', async () => {
    const { id, biz } = await shop(world, 'lp7');
    setLevel(biz, 5);
    const cash0 = world.players.get(id)!.cash;
    const [r1, r2] = await Promise.allSettled([
      world.buyLicense(id, biz.id, 'latte'),
      world.buyLicense(id, biz.id, 'latte'),
    ]);
    expect([r1, r2].filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(world.players.get(id)!.cash).toBe(cash0 - 4000);
    const led = await query(`SELECT count(*)::int c FROM economic_ledger WHERE transaction_type='PRODUCT_LICENSE'`);
    expect(led.rows[0].c).toBe(1);
  });

  it('licenses are business-specific: another business does NOT inherit them', async () => {
    const a = await shop(world, 'lp8a');
    const b = await shop(world, 'lp8b');
    setLevel(a.biz, 5);
    await world.buyLicense(a.id, a.biz.id, 'latte');
    expect(a.biz.licenses.has('latte')).toBe(true);
    // A different business (its own license set) never inherits the latte license.
    expect(b.biz.licenses.has('latte')).toBe(false);
    expect(b.biz.licenses.has('coffee')).toBe(true); // only its own starter
    // Buying on `b` requires ITS OWN level/prereq — proving per-business gating.
    setLevel(b.biz, 5);
    await world.buyLicense(b.id, b.biz.id, 'latte');
    expect(b.biz.licenses.has('latte')).toBe(true);
  });
});

describe('product slots (activate / deactivate)', () => {
  it('activating an unlicensed product is rejected', async () => {
    const { id, biz } = await shop(world, 'ps1');
    await expect(world.setProductActive(id, biz.id, 'latte', true)).rejects.toBeInstanceOf(GameError);
  });

  it('activation respects the level-scaled slot limit', async () => {
    const { id, biz } = await shop(world, 'ps2');
    setLevel(biz, 5); // 2 slots
    await world.buyLicense(id, biz.id, 'latte');
    // coffee already active (1/2). Activate latte -> 2/2.
    await world.setProductActive(id, biz.id, 'latte', true);
    expect(biz.activeProducts.size).toBe(2);
    // A level-1 shop (1 slot) with coffee active cannot add a second.
    const { id: id2, biz: b2 } = await shop(world, 'ps2b');
    setLevel(b2, 5);
    await world.buyLicense(id2, b2.id, 'latte');
    b2.bizLevel = 1; // force back to 1 slot
    b2.lastSlotChangeMs = null;
    await expect(world.setProductActive(id2, b2.id, 'latte', true)).rejects.toBeInstanceOf(GameError);
  });

  it('deactivate frees a slot; activation state persists across restart', async () => {
    const { id, biz } = await shop(world, 'ps3');
    setLevel(biz, 5);
    await world.buyLicense(id, biz.id, 'latte');
    await world.setProductActive(id, biz.id, 'latte', true);
    biz.lastSlotChangeMs = null; // bypass cooldown for the test
    await world.setProductActive(id, biz.id, 'coffee', false);
    expect(biz.activeProducts.has('coffee')).toBe(false);
    const w2 = await loadedWorld();
    const b = w2.bizByOwner(id)!;
    expect(b.activeProducts.has('latte')).toBe(true);
    expect(b.activeProducts.has('coffee')).toBe(false);
  });

  it('a reconfiguration cooldown blocks rapid switching', async () => {
    const { id, biz } = await shop(world, 'ps4');
    setLevel(biz, 5);
    await world.buyLicense(id, biz.id, 'latte');
    await world.setProductActive(id, biz.id, 'latte', true); // sets cooldown
    await expect(world.setProductActive(id, biz.id, 'coffee', false)).rejects.toBeInstanceOf(GameError);
  });
});

describe('business XP / level (nonlinear, capped, migrated)', () => {
  it('XP accrues into levels via the nonlinear curve and caps at 50', async () => {
    const { biz } = await shop(world, 'xp1');
    expect(biz.bizLevel).toBe(1);
    (world as unknown as { addBizXp(b: BizRec, n: number): void }).addBizXp(biz, xpForBizLevel(3));
    expect(biz.bizLevel).toBe(3);
    (world as unknown as { addBizXp(b: BizRec, n: number): void }).addBizXp(biz, xpForBizLevel(50) * 10);
    expect(biz.bizLevel).toBe(50);
    expect(bizLevelForXp(biz.bizXp)).toBe(50);
  });

  it('admin can set business XP (audited) and it persists', async () => {
    const rootId = await newPlayer(world, 'root');
    world.players.get(rootId)!.isAdmin = true;
    await query('UPDATE players SET is_admin=true WHERE id=$1', [rootId]);
    const { id, biz } = await shop(world, 'xp2');
    await world.adminSetBizXp(rootId, biz.id, xpForBizLevel(10), 'set');
    expect(biz.bizLevel).toBe(10);
    const audit = await query(`SELECT count(*)::int c FROM admin_audit_log WHERE action='SET_BUSINESS_XP'`);
    expect(audit.rows[0].c).toBe(1);
    const w2 = await loadedWorld();
    expect(w2.bizByOwner(id)!.bizLevel).toBe(10);
  });
});
