// V2.7 Phase 4 — urgent city orders: exactly-one-winner, settlement once,
// server-side validation, admin authorization, cancel, and restart safety.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld } from './helpers.js';
import { closeDb, query } from '../src/db.js';
import { GameError, type World } from '../src/game/world.js';

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

// A bakery holding `bread` stock, funded.
async function baker(w: World, name: string, bread = 500): Promise<number> {
  const id = await newPlayer(w, name);
  const biz = await w.chooseBusiness(id, 'bakery');
  biz.inv.set('bread', { qty: bread, reserved: 0 });
  w.players.get(id)!.cash = 10000;
  return id;
}

async function makeOrder(w: World, adminId: number, qty = 100, reward = 1200) {
  return w.createUrgentOrder(adminId, { product: 'bread', qty, reward, durationSecs: 600 });
}

describe('urgent city orders — exactly one winner', () => {
  it('two bakeries race for one order: exactly one wins; goods & reward move once', async () => {
    const a = await admin(world);
    const b1 = await baker(world, 'bk1');
    const b2 = await baker(world, 'bk2');
    const order = await makeOrder(world, a, 100, 1200);
    const cash1 = world.players.get(b1)!.cash;
    const cash2 = world.players.get(b2)!.cash;

    const [r1, r2] = await Promise.allSettled([
      world.fulfillUrgentOrder(b1, order.id),
      world.fulfillUrgentOrder(b2, order.id),
    ]);
    const wins = [r1, r2].filter((r) => r.status === 'fulfilled');
    expect(wins.length).toBe(1);

    // Exactly one paid the reward; exactly one lost 100 bread; the loser is untouched.
    const paid1 = world.players.get(b1)!.cash - cash1;
    const paid2 = world.players.get(b2)!.cash - cash2;
    expect([paid1, paid2].filter((d) => d === 1200).length).toBe(1);
    expect([paid1, paid2].filter((d) => d === 0).length).toBe(1);
    const bread1 = world.bizByOwner(b1)!.inv.get('bread')!.qty;
    const bread2 = world.bizByOwner(b2)!.inv.get('bread')!.qty;
    expect([bread1, bread2].filter((q) => q === 400).length).toBe(1); // winner lost 100
    expect([bread1, bread2].filter((q) => q === 500).length).toBe(1); // loser untouched

    // Ledger + activity recorded exactly once.
    const led = await query(`SELECT count(*)::int c FROM economic_ledger WHERE transaction_type='CITY_ORDER_REWARD' AND reference_id=$1`, [order.id]);
    expect(led.rows[0].c).toBe(1);
    const act = await query(`SELECT count(*)::int c FROM company_activity WHERE kind='city_order'`);
    expect(act.rows[0].c).toBe(1);
    // The order is fulfilled with a single winner recorded in the DB.
    const row = await query(`SELECT status, winner_company_id FROM urgent_orders WHERE id=$1`, [order.id]);
    expect(row.rows[0].status).toBe('fulfilled');
    expect(row.rows[0].winner_company_id).not.toBeNull();
  });

  it('a duplicate fulfil by the winner does not pay twice', async () => {
    const a = await admin(world);
    const b1 = await baker(world, 'bk1');
    const order = await makeOrder(world, a, 100, 1200);
    await world.fulfillUrgentOrder(b1, order.id);
    const cashAfter = world.players.get(b1)!.cash;
    await expect(world.fulfillUrgentOrder(b1, order.id)).rejects.toBeInstanceOf(GameError);
    expect(world.players.get(b1)!.cash).toBe(cashAfter);
  });

  it('rejects insufficient stock, expired, and already-won', async () => {
    const a = await admin(world);
    const poor = await baker(world, 'poor', 50); // only 50 bread
    const rich = await baker(world, 'rich', 500);
    const order = await makeOrder(world, a, 100, 1200);
    // Insufficient stock.
    await expect(world.fulfillUrgentOrder(poor, order.id)).rejects.toBeInstanceOf(GameError);
    // Expired.
    const expOrder = await makeOrder(world, a, 100, 1200);
    world.urgentOrders.get(expOrder.id)!.expiresAtMs = Date.now() - 1;
    await expect(world.fulfillUrgentOrder(rich, expOrder.id)).rejects.toBeInstanceOf(GameError);
    // Already won.
    await world.fulfillUrgentOrder(rich, order.id);
    const other = await baker(world, 'other', 500);
    await expect(world.fulfillUrgentOrder(other, order.id)).rejects.toBeInstanceOf(GameError);
  });

  it('reserved stock does not count toward fulfilment (unreserved only)', async () => {
    const a = await admin(world);
    const b1 = await baker(world, 'bk1', 60);
    world.bizByOwner(b1)!.inv.set('bread', { qty: 60, reserved: 60 }); // 60 on-hand, 60 escrowed
    const order = await makeOrder(world, a, 100, 1200); // needs 100 unreserved
    await expect(world.fulfillUrgentOrder(b1, order.id)).rejects.toBeInstanceOf(GameError);
  });
});

describe('urgent city orders — admin authorization (server-side)', () => {
  it('a normal player cannot create or cancel city orders', async () => {
    const a = await admin(world);
    const nobody = await baker(world, 'nobody');
    await expect(world.createUrgentOrder(nobody, { product: 'bread', qty: 100, reward: 100 })).rejects.toBeInstanceOf(GameError);
    const order = await makeOrder(world, a);
    await expect(world.cancelUrgentOrder(nobody, order.id)).rejects.toBeInstanceOf(GameError);
    // Still live after the failed cancel.
    expect(world.urgentOrders.has(order.id)).toBe(true);
  });

  it('admin create + cancel are audited; a cancelled order cannot be fulfilled', async () => {
    const a = await admin(world);
    const b1 = await baker(world, 'bk1');
    const order = await makeOrder(world, a);
    await world.cancelUrgentOrder(a, order.id, 'test');
    expect(world.urgentOrders.has(order.id)).toBe(false);
    await expect(world.fulfillUrgentOrder(b1, order.id)).rejects.toBeInstanceOf(GameError);
    const audit = await query(`SELECT action FROM admin_audit_log WHERE action IN ('CREATE_URGENT_ORDER','CANCEL_URGENT_ORDER') ORDER BY id`);
    expect(audit.rows.map((r: any) => r.action)).toEqual(['CREATE_URGENT_ORDER', 'CANCEL_URGENT_ORDER']);
  });

  it('admin create validates product / qty / reward bounds', async () => {
    const a = await admin(world);
    await expect(world.createUrgentOrder(a, { product: 'wheat' as any, qty: 100, reward: 100 })).rejects.toBeInstanceOf(GameError);
    await expect(world.createUrgentOrder(a, { product: 'bread', qty: 0, reward: 100 })).rejects.toBeInstanceOf(GameError);
    await expect(world.createUrgentOrder(a, { product: 'bread', qty: 100, reward: -5 })).rejects.toBeInstanceOf(GameError);
  });
});

describe('urgent city orders — restart safety', () => {
  it('a live order survives a restart and stays fulfillable', async () => {
    const a = await admin(world);
    const b1 = await baker(world, 'bk1');
    const order = await makeOrder(world, a, 100, 1200);
    const world2 = await loadedWorld();
    expect(world2.urgentOrders.has(order.id)).toBe(true);
    // Re-establish the baker's stock in the fresh world and fulfil there.
    world2.bizByOwner(b1)!.inv.set('bread', { qty: 500, reserved: 0 });
    await world2.fulfillUrgentOrder(b1, order.id);
    expect(world2.urgentOrders.has(order.id)).toBe(false);
  });

  it('an order already past its deadline is retired on load', async () => {
    const a = await admin(world);
    const order = await makeOrder(world, a, 100, 1200);
    await query(`UPDATE urgent_orders SET expires_at = now() - interval '1 minute' WHERE id=$1`, [order.id]);
    const world2 = await loadedWorld();
    expect(world2.urgentOrders.has(order.id)).toBe(false);
    const row = await query(`SELECT status FROM urgent_orders WHERE id=$1`, [order.id]);
    expect(row.rows[0].status).toBe('expired');
  });
});
