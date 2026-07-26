import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld } from './helpers.js';
import { closeDb, query } from '../src/db.js';
import type { World } from '../src/game/world.js';

let world: World;

beforeEach(async () => {
  await resetDb();
  world = await loadedWorld();
});

afterAll(async () => {
  await closeDb();
});

describe('economic ledger', () => {
  it('records NPC purchases, sales, trades, escrow and upgrades with consistent balances', async () => {
    const shopId = await newPlayer(world, 'ledger_shop');
    const farmId = await newPlayer(world, 'ledger_farm');
    await world.chooseBusiness(shopId, 'coffee_shop');
    const farm = await world.chooseBusiness(farmId, 'farm');
    const shop = world.bizByOwner(shopId)!;

    await world.buyNpc(shopId, 'beans', 20); // NPC_PURCHASE (goods arrive later by van)
    shop.inv.get('coffee')!.qty = 30;         // V2.8 P2: retail drains finished stock
    world.simulate(shop, 120, true); // CUSTOMER_SALE (queued)
    const order = await world.createOrder(shopId, 'buy', 'milk', 50, 12); // MARKET_ESCROW
    farm.inv.get('milk')!.qty = 100;
    await world.fulfillOrder(farmId, order.id, 50); // MARKET_SELL
    await world.upgrade(farmId); // BUSINESS_UPGRADE
    await world.flush(); // persists queued CUSTOMER_SALE rows

    const rows = (await query('SELECT * FROM economic_ledger ORDER BY id')).rows;
    const types = new Set(rows.map((r) => r.transaction_type));
    for (const t of ['NPC_PURCHASE', 'CUSTOMER_SALE', 'MARKET_ESCROW', 'MARKET_SELL', 'BUSINESS_UPGRADE']) {
      expect(types.has(t), `missing ledger type ${t}`).toBe(true);
    }
    // every entry balances: after - before == amount
    for (const r of rows) {
      expect(r.balance_after - r.balance_before).toBe(r.amount);
    }
    // the trade is traceable: MARKET_SELL references a trade row worth $600
    const sell = rows.find((r) => r.transaction_type === 'MARKET_SELL');
    expect(sell.amount).toBe(600);
    expect(sell.reference_type).toBe('trade');
    const trade = await query('SELECT * FROM trades WHERE id=$1', [sell.reference_id]);
    expect(trade.rowCount).toBe(1);
  });

  it('records a cancel refund matching the escrow', async () => {
    const shopId = await newPlayer(world, 'refunder');
    await world.chooseBusiness(shopId, 'coffee_shop');
    const order = await world.createOrder(shopId, 'buy', 'milk', 40, 10);
    await world.cancelOrder(shopId, order.id);
    const rows = (await query(
      "SELECT * FROM economic_ledger WHERE transaction_type IN ('MARKET_ESCROW','MARKET_REFUND') ORDER BY id"
    )).rows;
    expect(rows.length).toBe(2);
    expect(rows[0].amount).toBe(-400);
    expect(rows[1].amount).toBe(400);
    expect(rows[1].reference_id).toBe(order.id);
  });
});
