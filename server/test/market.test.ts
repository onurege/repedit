import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld } from './helpers.js';
import { closeDb, query } from '../src/db.js';
import { GameError, type World } from '../src/game/world.js';
import { STARTING_CASH } from '@district/shared';

let world: World;
let shopId: number;
let farmId: number;

beforeEach(async () => {
  await resetDb();
  world = await loadedWorld();
  shopId = await newPlayer(world, 'shopper');
  farmId = await newPlayer(world, 'grower');
  await world.chooseBusiness(shopId, 'coffee_shop');
  const farm = await world.chooseBusiness(farmId, 'farm');
  farm.inv.get('milk')!.qty = 150;
});

afterAll(async () => {
  await closeDb();
});

describe('order creation', () => {
  it('escrows cash for buy orders', async () => {
    await world.createOrder(shopId, 'buy', 'milk', 100, 12);
    expect(world.players.get(shopId)!.cash).toBe(STARTING_CASH - 1200);
  });

  it('rejects buy orders beyond available cash', async () => {
    await expect(world.createOrder(shopId, 'buy', 'milk', 10000, 500)).rejects.toThrow(GameError);
    expect(world.players.get(shopId)!.cash).toBe(STARTING_CASH);
  });

  it('reserves goods for sell orders and rejects overselling', async () => {
    await world.createOrder(farmId, 'sell', 'milk', 100, 12);
    const farm = world.bizByOwner(farmId)!;
    expect(farm.inv.get('milk')!.qty).toBe(50);
    expect(farm.inv.get('milk')!.reserved).toBe(100);
    await expect(world.createOrder(farmId, 'sell', 'milk', 60, 12)).rejects.toThrow(GameError);
  });

  it('rejects invalid quantities and prices', async () => {
    await expect(world.createOrder(shopId, 'buy', 'milk', 0, 12)).rejects.toThrow(GameError);
    await expect(world.createOrder(shopId, 'buy', 'milk', -5, 12)).rejects.toThrow(GameError);
    await expect(world.createOrder(shopId, 'buy', 'milk', 10, 0)).rejects.toThrow(GameError);
    await expect(world.createOrder(shopId, 'buy', 'coffee' as any, 10, 10)).rejects.toThrow(GameError);
  });

  it('cancelling refunds escrow exactly once', async () => {
    const order = await world.createOrder(shopId, 'buy', 'milk', 100, 12);
    await world.cancelOrder(shopId, order.id);
    expect(world.players.get(shopId)!.cash).toBe(STARTING_CASH);
    await expect(world.cancelOrder(shopId, order.id)).rejects.toThrow(GameError);
    expect(world.players.get(shopId)!.cash).toBe(STARTING_CASH);
  });
});

describe('fulfillment', () => {
  it('farm fulfills a shop buy order: money and goods move exactly once', async () => {
    const order = await world.createOrder(shopId, 'buy', 'milk', 100, 12);
    await world.fulfillOrder(farmId, order.id, 100);
    expect(world.players.get(shopId)!.cash).toBe(STARTING_CASH - 1200);
    expect(world.players.get(farmId)!.cash).toBe(STARTING_CASH + 1200);
    const farm = world.bizByOwner(farmId)!;
    expect(farm.inv.get('milk')!.qty).toBe(50);
    // buyer gets goods only after delivery
    const shop = world.bizByOwner(shopId)!;
    expect(shop.inv.get('milk')!.qty).toBe(0);
    expect(world.deliveries.size).toBe(1);
    const trades = await query('SELECT * FROM trades');
    expect(trades.rowCount).toBe(1);
  });

  it('shop fulfills a farm sell order', async () => {
    const order = await world.createOrder(farmId, 'sell', 'milk', 100, 14);
    await world.fulfillOrder(shopId, order.id, 100);
    expect(world.players.get(shopId)!.cash).toBe(STARTING_CASH - 1400);
    expect(world.players.get(farmId)!.cash).toBe(STARTING_CASH + 1400);
    expect(world.bizByOwner(farmId)!.inv.get('milk')!.reserved).toBe(0);
  });

  it('supports partial fulfillment', async () => {
    const order = await world.createOrder(shopId, 'buy', 'milk', 100, 12);
    await world.fulfillOrder(farmId, order.id, 40);
    expect(order.remaining).toBe(60);
    expect(order.status).toBe('open');
    expect(world.players.get(farmId)!.cash).toBe(STARTING_CASH + 480);
    await world.fulfillOrder(farmId, order.id, 60);
    expect(order.status).toBe('filled');
  });

  it('cannot fulfill your own order', async () => {
    const order = await world.createOrder(shopId, 'buy', 'milk', 10, 12);
    await expect(world.fulfillOrder(shopId, order.id, 10)).rejects.toThrow(GameError);
  });

  it('cannot sell goods you do not have', async () => {
    const order = await world.createOrder(shopId, 'buy', 'milk', 100, 12);
    world.bizByOwner(farmId)!.inv.get('milk')!.qty = 5;
    await expect(world.fulfillOrder(farmId, order.id, 100)).rejects.toThrow(GameError);
    // nothing moved
    expect(world.players.get(farmId)!.cash).toBe(STARTING_CASH);
    expect(world.deliveries.size).toBe(0);
  });

  it('duplicate fulfillment is impossible (sequential)', async () => {
    const order = await world.createOrder(shopId, 'buy', 'milk', 100, 12);
    await world.fulfillOrder(farmId, order.id, 100);
    await expect(world.fulfillOrder(farmId, order.id, 100)).rejects.toThrow(GameError);
    expect(world.players.get(farmId)!.cash).toBe(STARTING_CASH + 1200);
  });

  it('duplicate fulfillment is impossible (concurrent double-click)', async () => {
    const order = await world.createOrder(shopId, 'buy', 'milk', 100, 12);
    const results = await Promise.allSettled([
      world.fulfillOrder(farmId, order.id, 100),
      world.fulfillOrder(farmId, order.id, 100),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok.length).toBe(1);
    expect(world.players.get(shopId)!.cash).toBe(STARTING_CASH - 1200);
    expect(world.players.get(farmId)!.cash).toBe(STARTING_CASH + 1200);
    const trades = await query('SELECT * FROM trades');
    expect(trades.rowCount).toBe(1);
  });
});

describe('npc wholesaler', () => {
  it('sells with delivery and never allows negative cash', async () => {
    await world.buyNpc(shopId, 'beans', 50); // $400
    expect(world.players.get(shopId)!.cash).toBe(STARTING_CASH - 400);
    expect(world.deliveries.size).toBe(1);
    await expect(world.buyNpc(shopId, 'beans', 100000)).rejects.toThrow(GameError);
  });

  it('enforces storage capacity', async () => {
    await expect(world.buyNpc(shopId, 'beans', 251)).rejects.toThrow(GameError);
  });
});
