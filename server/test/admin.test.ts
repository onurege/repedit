// V2.7 Phase 2 — Admin & Live Ops console.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld } from './helpers.js';
import { closeDb, query } from '../src/db.js';
import { GameError, type World } from '../src/game/world.js';
import { SHOP_LEVELS } from '@district/shared';

let world: World;
beforeEach(async () => {
  await resetDb();
  world = await loadedWorld();
});
afterAll(async () => {
  await closeDb();
});

async function admin(w: World, name = 'root'): Promise<number> {
  const id = await newPlayer(w, name);
  w.players.get(id)!.isAdmin = true;
  await query('UPDATE players SET is_admin=true WHERE id=$1', [id]);
  return id;
}

describe('admin authorization (server-side, mandatory)', () => {
  it('rejects every consequential admin action from a non-admin', async () => {
    const a = await admin(world);
    const nobody = await newPlayer(world, 'nobody');
    const victim = await newPlayer(world, 'victim');
    await world.chooseBusiness(victim, 'coffee_shop');
    const bizId = world.bizByOwner(victim)!.id;

    // A crafted WebSocket message from a normal player must be refused.
    await expect(world.adminDashboard(nobody)).rejects.toBeInstanceOf(GameError);
    await expect(world.adminSearchPlayers(nobody, 'a')).rejects.toBeInstanceOf(GameError);
    await expect(world.adminPlayerDetail(nobody, victim)).rejects.toBeInstanceOf(GameError);
    await expect(world.adminSetCash(nobody, victim, 'add', 100)).rejects.toBeInstanceOf(GameError);
    await expect(world.adminSetInventory(nobody, bizId, 'milk', 'add', 10)).rejects.toBeInstanceOf(GameError);
    await expect(world.adminWholesale(nobody, 'beans', 'refill')).rejects.toBeInstanceOf(GameError);
    await expect(world.adminWholesaleRefillAll(nobody)).rejects.toBeInstanceOf(GameError);
    await expect(world.adminSuspend(nobody, victim, true)).rejects.toBeInstanceOf(GameError);
    await expect(world.adminForceLogout(nobody, victim)).rejects.toBeInstanceOf(GameError);
    await expect(world.adminHardDeletePlayer(nobody, victim, 'victim')).rejects.toBeInstanceOf(GameError);
    await expect(world.adminRecentAudit(nobody)).rejects.toBeInstanceOf(GameError);
    // And nothing was mutated.
    expect(world.players.get(victim)!.cash).toBe(10000);
    void a;
  });
});

describe('admin cash', () => {
  it('adds, removes and sets cash, clamped to >= 0, with a ledger entry', async () => {
    const a = await admin(world);
    const pid = await newPlayer(world, 'wallet');
    await world.adminSetCash(a, pid, 'add', 5000, 'compensation');
    expect(world.players.get(pid)!.cash).toBe(15000);
    await world.adminSetCash(a, pid, 'set', 250);
    expect(world.players.get(pid)!.cash).toBe(250);
    await world.adminSetCash(a, pid, 'remove', 9999); // clamps at 0
    expect(world.players.get(pid)!.cash).toBe(0);
    const led = await query(`SELECT count(*)::int c FROM economic_ledger WHERE player_id=$1 AND transaction_type='ADMIN_CASH'`, [pid]);
    expect(led.rows[0].c).toBe(3);
  });
});

describe('admin inventory reuses the V2.6.2 capacity guard', () => {
  it('cannot overflow storage even via admin add/set', async () => {
    const a = await admin(world);
    const pid = await newPlayer(world, 'shopkeep');
    const biz = await world.chooseBusiness(pid, 'coffee_shop');
    biz.level = 3;
    const cap = SHOP_LEVELS[3].ingredientCapacity;
    await world.adminSetInventory(a, biz.id, 'milk', 'add', cap + 5000);
    expect(biz.inv.get('milk')!.qty).toBe(cap); // clamped to capacity
    expect(biz.inv.get('milk')!.qty + biz.inv.get('milk')!.reserved).toBeLessThanOrEqual(cap);
    await world.adminSetInventory(a, biz.id, 'milk', 'set', 5);
    expect(biz.inv.get('milk')!.qty).toBe(5);
    await world.adminSetInventory(a, biz.id, 'milk', 'remove', 100); // clamps at 0
    expect(biz.inv.get('milk')!.qty).toBe(0);
  });
});

describe('admin wholesale (live, no restart)', () => {
  it('refills, sets stock and price, all audited', async () => {
    const a = await admin(world);
    const beans = world.wholesale.get('beans')!;
    beans.remaining = 0;
    await world.adminWholesale(a, 'beans', 'refill');
    expect(world.wholesale.get('beans')!.remaining).toBe(beans.dailyStock);
    await world.adminWholesale(a, 'beans', 'set', 123);
    expect(world.wholesale.get('beans')!.remaining).toBe(123);
    await world.adminWholesale(a, 'beans', 'set_price', 20);
    expect(world.wholesale.get('beans')!.basePrice).toBe(20);
    await world.adminWholesaleRefillAll(a);
    for (const w of world.wholesale.values()) expect(w.remaining).toBe(w.dailyStock);
    const audit = await world.adminRecentAudit(a, 50);
    expect(audit.some((e) => e.action === 'REFILL_WHOLESALE')).toBe(true);
    expect(audit.some((e) => e.action === 'CHANGE_WHOLESALE_PRICE')).toBe(true);
    // Wholesale change persisted for a live reload (no restart needed to see it).
    const row = await query('SELECT remaining, base_price FROM wholesale_supply WHERE product=$1', ['beans']);
    expect(row.rows[0].base_price).toBe(20);
  });
});

describe('admin suspend / force logout', () => {
  it('suspends and unsuspends a player', async () => {
    const a = await admin(world);
    const pid = await newPlayer(world, 'rulebreaker');
    await world.adminSuspend(a, pid, true, 'cheating');
    expect(world.isSuspended(pid)).toBe(true);
    const row = await query('SELECT suspended, suspended_reason FROM players WHERE id=$1', [pid]);
    expect(row.rows[0].suspended).toBe(true);
    await world.adminSuspend(a, pid, false);
    expect(world.isSuspended(pid)).toBe(false);
  });

  it('force logout invalidates all sessions', async () => {
    const a = await admin(world);
    const pid = await newPlayer(world, 'ghost');
    await query('INSERT INTO sessions (token, player_id) VALUES ($1,$2)', ['tok_test', pid]);
    await world.adminForceLogout(a, pid, 'kick');
    const s = await query('SELECT count(*)::int c FROM sessions WHERE player_id=$1', [pid]);
    expect(s.rows[0].c).toBe(0);
  });
});

describe('admin audit log', () => {
  it('records consequential actions with admin identity and no secrets', async () => {
    const a = await admin(world);
    const pid = await newPlayer(world, 'tracked');
    await world.adminSetCash(a, pid, 'add', 1000, 'because');
    const entries = await world.adminRecentAudit(a, 20);
    const cashEntry = entries.find((e) => e.action === 'SET_CASH');
    expect(cashEntry).toBeDefined();
    expect(cashEntry!.adminName).toBe('root');
    expect(JSON.stringify(entries)).not.toContain('pass');
    expect(JSON.stringify(entries)).not.toContain('token');
  });
});

describe('hard delete player', () => {
  it('removes the player and ALL dependent state, releases the lot, cleans memory', async () => {
    const a = await admin(world);
    // Victim with a company, business, inventory, an order, and a completed trade.
    const victim = await newPlayer(world, 'doomed');
    const vbiz = await world.chooseBusiness(victim, 'farm');
    world.players.get(victim)!.cash = 100000;
    vbiz.inv.get('milk')!.qty = 100;
    await world.flush();
    const lotId = vbiz.lotId;
    const vbizId = vbiz.id;

    // A trade between victim (seller) and a buyer, exercising the trades FK.
    const buyer = await newPlayer(world, 'buyer');
    const bbiz = await world.chooseBusiness(buyer, 'coffee_shop');
    bbiz.level = 3;
    world.players.get(buyer)!.cash = 100000;
    await world.createOrder(victim, 'sell', 'milk', 50, 5); // victim lists milk
    const order = [...world.orders.values()].find((o) => o.playerId === victim)!;
    await world.fulfillOrder(buyer, order.id, 50); // creates a trades row referencing victim
    const tradesBefore = await query('SELECT count(*)::int c FROM trades WHERE seller_id=$1 OR buyer_id=$1', [victim]);
    expect(tradesBefore.rows[0].c).toBeGreaterThan(0);

    // Give the victim a still-open order too.
    await world.createOrder(victim, 'sell', 'milk', 10, 5);

    const res = await world.adminHardDeletePlayer(a, victim, 'doomed');
    expect(res.bizIds).toContain(vbizId);
    expect(res.lotIds).toContain(lotId);

    // Player + all dependent rows are gone (no FK error, trades resolved).
    for (const [t, col] of [
      ['players', 'id'], ['companies', 'player_id'], ['businesses', 'player_id'],
      ['market_orders', 'player_id'], ['sessions', 'player_id'],
      ['tutorial_progress', 'player_id'], ['player_seen_updates', 'player_id'],
    ] as const) {
      const r = await query(`SELECT count(*)::int c FROM ${t} WHERE ${col}=$1`, [victim]);
      expect(r.rows[0].c, `${t}`).toBe(0);
    }
    const trades = await query('SELECT count(*)::int c FROM trades WHERE seller_id=$1 OR buyer_id=$1', [victim]);
    expect(trades.rows[0].c).toBe(0);
    const inv = await query('SELECT count(*)::int c FROM inventories WHERE business_id=$1', [vbizId]);
    expect(inv.rows[0].c).toBe(0);

    // In-memory world state purged: no ghost company / business / order.
    expect(world.players.has(victim)).toBe(false);
    expect(world.companyByOwner(victim)).toBeUndefined();
    expect(world.businesses.has(vbizId)).toBe(false);
    expect([...world.orders.values()].some((o) => o.playerId === victim)).toBe(false);

    // The lot is free again — occupancy no longer counts the deleted business.
    const occupied = new Set([...world.businesses.values()].map((b) => b.lotId));
    expect(occupied.has(lotId)).toBe(false);

    // Audit recorded the deletion.
    const audit = await world.adminRecentAudit(a, 20);
    expect(audit.some((e) => e.action === 'HARD_DELETE_PLAYER' && e.targetId === String(victim))).toBe(true);
  });

  it('a deleted player cannot reconnect (session-less) and survives a reload with no ghost', async () => {
    const a = await admin(world);
    const victim = await newPlayer(world, 'vanish');
    await world.chooseBusiness(victim, 'bakery');
    await world.flush();
    await query('INSERT INTO sessions (token, player_id) VALUES ($1,$2)', ['gone_token', victim]);

    await world.adminHardDeletePlayer(a, victim, 'vanish');
    // Session is gone -> token resolves to nobody -> cannot reconnect.
    const s = await query('SELECT count(*)::int c FROM sessions WHERE token=$1', ['gone_token']);
    expect(s.rows[0].c).toBe(0);

    // A fresh world load shows no ghost business/company/player.
    const world2 = await loadedWorld();
    expect(world2.players.has(victim)).toBe(false);
    expect([...world2.businesses.values()].some((b) => b.ownerId === victim)).toBe(false);
  });

  it('requires an exact username confirmation and refuses self-deletion', async () => {
    const a = await admin(world, 'selfadmin');
    const victim = await newPlayer(world, 'careful');
    await expect(world.adminHardDeletePlayer(a, victim, 'WRONG')).rejects.toBeInstanceOf(GameError);
    expect(world.players.has(victim)).toBe(true);
    await expect(world.adminHardDeletePlayer(a, a, 'selfadmin')).rejects.toBeInstanceOf(GameError);
    expect(world.players.has(a)).toBe(true);
  });
});

describe('admin rename company / business', () => {
  it('renames any player\'s company and business, audited, with validation', async () => {
    const a = await admin(world);
    const pid = await newPlayer(world, 'branded');
    const biz = await world.chooseBusiness(pid, 'coffee_shop');

    await world.adminRenameCompany(a, pid, 'Onur Foods');
    expect(world.companyByOwner(pid)!.name).toBe('Onur Foods');
    await world.adminRenameBusiness(a, biz.id, 'Downtown Brews');
    expect(world.businesses.get(biz.id)!.name).toBe('Downtown Brews');
    // Empty business name clears back to the default label.
    await world.adminRenameBusiness(a, biz.id, '   ');
    expect(world.businesses.get(biz.id)!.name).toBeNull();
    // Markup stripped; over-long rejected.
    await world.adminRenameBusiness(a, biz.id, '<b>Cafe</b>');
    expect(world.businesses.get(biz.id)!.name).not.toContain('<');
    await expect(world.adminRenameCompany(a, pid, 'x')).rejects.toBeInstanceOf(GameError); // too short
    // Persisted + audited.
    const co = await query('SELECT name FROM companies WHERE player_id=$1', [pid]);
    expect(co.rows[0].name).toBe('Onur Foods');
    const audit = await world.adminRecentAudit(a, 20);
    expect(audit.some((e) => e.action === 'RENAME_COMPANY')).toBe(true);
    expect(audit.some((e) => e.action === 'RENAME_BUSINESS')).toBe(true);
  });

  it('rejects rename from a non-admin', async () => {
    const nobody = await newPlayer(world, 'plebe');
    const pid = await newPlayer(world, 'target2');
    const biz = await world.chooseBusiness(pid, 'farm');
    await expect(world.adminRenameCompany(nobody, pid, 'Hax Corp')).rejects.toBeInstanceOf(GameError);
    await expect(world.adminRenameBusiness(nobody, biz.id, 'Hax Farm')).rejects.toBeInstanceOf(GameError);
  });
});
