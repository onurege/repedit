// Phase 3: recurring supply contracts.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld, forceDeliveries } from './helpers.js';
import { closeDb, query } from '../src/db.js';
import { GameError, type World } from '../src/game/world.js';
import { STARTING_CASH } from '@district/shared';

let world: World;
let farmerId: number;
let bakerId: number;
let farmBizId: number;
let bakeryBizId: number;

beforeEach(async () => {
  await resetDb();
  world = await loadedWorld();
  farmerId = await newPlayer(world, 'farmer');
  bakerId = await newPlayer(world, 'baker');
  const farm = await world.chooseBusiness(farmerId, 'farm');
  world.setProduction(farmerId, 'wheat');
  const bakery = await world.chooseBusiness(bakerId, 'bakery');
  farmBizId = farm.id;
  bakeryBizId = bakery.id;
});

afterAll(async () => {
  await closeDb();
});

/** Baker proposes: 50 wheat @ $8 x N deliveries from the farm. */
async function propose(deliveries = 3) {
  return world.proposeContract(bakerId, farmBizId, 'wheat', 50, 8, deliveries);
}

describe('proposal & lifecycle', () => {
  it('proposes, and the seller accepts to make it active', async () => {
    const c = await propose();
    expect(c.status).toBe('proposed');
    expect(c.buyerId).toBe(bakerId);
    expect(c.sellerId).toBe(farmerId);
    const accepted = await world.acceptContract(farmerId, c.id);
    expect(accepted.status).toBe('active');
    expect(accepted.nextExecutionAtMs).not.toBeNull();
  });

  it('lets the seller reject a proposal', async () => {
    const c = await propose();
    const rej = await world.rejectContract(farmerId, c.id);
    expect(rej.status).toBe('rejected');
    expect(world.contracts.has(c.id)).toBe(false);
  });

  it('rejects nonsensical or self contracts and bad params', async () => {
    // farm cannot buy bread from a bakery it doesn't consume; buyer must consume product
    await expect(world.proposeContract(farmerId, bakeryBizId, 'bread', 10, 5, 3)).rejects.toThrow(GameError);
    // coffee is not contractable
    await expect(world.proposeContract(bakerId, farmBizId, 'coffee' as any, 10, 5, 3)).rejects.toThrow(GameError);
    // wheat from bakery: bakery doesn't supply wheat
    await expect(world.proposeContract(bakerId, bakeryBizId, 'wheat', 10, 5, 3)).rejects.toThrow(GameError);
    // bad quantity / deliveries
    await expect(world.proposeContract(bakerId, farmBizId, 'wheat', 0, 8, 3)).rejects.toThrow(GameError);
    await expect(world.proposeContract(bakerId, farmBizId, 'wheat', 50, 8, 0)).rejects.toThrow(GameError);
  });

  it('only the seller can accept/reject', async () => {
    const c = await propose();
    await expect(world.acceptContract(bakerId, c.id)).rejects.toThrow(GameError);
    await expect(world.rejectContract(bakerId, c.id)).rejects.toThrow(GameError);
  });
});

describe('execution', () => {
  it('executes exactly once: seller inventory & cash move, delivery created, buyer paid on arrival', async () => {
    const c = await propose(3);
    await world.acceptContract(farmerId, c.id);
    const farm = world.bizByOwner(farmerId)!;
    farm.inv.get('wheat')!.qty = 200;
    const farmerCash0 = world.players.get(farmerId)!.cash;
    const bakerCash0 = world.players.get(bakerId)!.cash;

    const result = await world.executeContract(c.id);
    expect(result).toBe('delivered');
    // seller loses exactly 50 wheat, gains $400; buyer pays $400 now, goods later
    expect(farm.inv.get('wheat')!.qty).toBe(150);
    expect(world.players.get(farmerId)!.cash).toBe(farmerCash0 + 400);
    expect(world.players.get(bakerId)!.cash).toBe(bakerCash0 - 400);
    expect(world.bizByOwner(bakerId)!.inv.get('wheat')!.qty ?? 0).toBe(0);
    expect(world.deliveries.size).toBe(1);
    expect(c.remaining).toBe(2);

    // delivery arrives -> baker receives exactly 50 wheat
    await forceDeliveries(world);
    expect(world.bizByOwner(bakerId)!.inv.get('wheat')!.qty).toBe(50);

    // ledger recorded both sides exactly once
    await world.flush();
    const rows = (await query(
      "SELECT transaction_type, count(*)::int n, sum(amount) s FROM economic_ledger WHERE reference_type='contract' GROUP BY 1 ORDER BY 1"
    )).rows;
    const byType = Object.fromEntries(rows.map((r) => [r.transaction_type, { n: r.n, s: Number(r.s) }]));
    expect(byType.CONTRACT_SELL).toEqual({ n: 1, s: 400 });
    expect(byType.CONTRACT_BUY).toEqual({ n: 1, s: -400 });
  });

  it('completes after the final delivery', async () => {
    const c = await propose(2);
    await world.acceptContract(farmerId, c.id);
    const farm = world.bizByOwner(farmerId)!;
    farm.inv.get('wheat')!.qty = 500;
    expect(await world.executeContract(c.id)).toBe('delivered');
    expect(c.status).toBe('active');
    expect(await world.executeContract(c.id)).toBe('delivered');
    expect(c.status).toBe('completed');
    expect(c.remaining).toBe(0);
    expect(world.contracts.has(c.id)).toBe(false);
    // no further execution possible
    const row = await query('SELECT status FROM contracts WHERE id=$1', [c.id]);
    expect(row.rows[0].status).toBe('completed');
  });

  it('skips safely on insufficient seller stock — no money, goods, or delivery move', async () => {
    const c = await propose(3);
    await world.acceptContract(farmerId, c.id);
    const farm = world.bizByOwner(farmerId)!;
    farm.inv.get('wheat')!.qty = 10; // < 50
    const farmerCash0 = world.players.get(farmerId)!.cash;
    const bakerCash0 = world.players.get(bakerId)!.cash;
    const result = await world.executeContract(c.id);
    expect(result).toBe('missed_stock');
    expect(farm.inv.get('wheat')!.qty).toBe(10);
    expect(world.players.get(farmerId)!.cash).toBe(farmerCash0);
    expect(world.players.get(bakerId)!.cash).toBe(bakerCash0);
    expect(world.deliveries.size).toBe(0);
    expect(c.status).toBe('active');
    expect(c.remaining).toBe(3);
    expect(c.lastResult).toBe('missed_stock');
    expect(c.nextExecutionAtMs).not.toBeNull();
  });

  it('skips safely on insufficient buyer funds', async () => {
    const c = await propose(3);
    await world.acceptContract(farmerId, c.id);
    world.bizByOwner(farmerId)!.inv.get('wheat')!.qty = 200;
    world.players.get(bakerId)!.cash = 100; // < $400
    const result = await world.executeContract(c.id);
    expect(result).toBe('missed_funds');
    expect(world.bizByOwner(farmerId)!.inv.get('wheat')!.qty).toBe(200);
    expect(world.players.get(bakerId)!.cash).toBe(100);
    expect(world.deliveries.size).toBe(0);
    expect(c.status).toBe('active');
    expect(c.lastResult).toBe('missed_funds');
  });

  it('duplicate concurrent execution is impossible', async () => {
    const c = await propose(3);
    await world.acceptContract(farmerId, c.id);
    world.bizByOwner(farmerId)!.inv.get('wheat')!.qty = 200;
    const [r1, r2] = await Promise.all([world.executeContract(c.id), world.executeContract(c.id)]);
    const delivered = [r1, r2].filter((r) => r === 'delivered').length;
    expect(delivered).toBe(1);
    expect(c.remaining).toBe(2);
    expect(world.bizByOwner(farmerId)!.inv.get('wheat')!.qty).toBe(150);
    const trades = await query("SELECT count(*)::int n FROM economic_ledger WHERE reference_type='contract' AND transaction_type='CONTRACT_SELL'");
    expect(trades.rows[0].n).toBe(1);
  });
});

describe('persistence', () => {
  it('active contracts survive a server restart and keep executing', async () => {
    const c = await propose(3);
    await world.acceptContract(farmerId, c.id);
    world.bizByOwner(farmerId)!.inv.get('wheat')!.qty = 300;
    await world.executeContract(c.id); // remaining -> 2
    await world.flush();

    const world2 = await loadedWorld();
    const c2 = world2.contracts.get(c.id)!;
    expect(c2).toBeTruthy();
    expect(c2.status).toBe('active');
    expect(c2.remaining).toBe(2);
    // still executes on the reloaded world
    world2.bizByOwner(farmerId)!.inv.get('wheat')!.qty = 300;
    expect(await world2.executeContract(c.id)).toBe('delivered');
    expect(c2.remaining).toBe(1);
  });

  it('offline execution does not require sessions (players have no connections)', async () => {
    const c = await propose(2);
    await world.acceptContract(farmerId, c.id);
    world.bizByOwner(farmerId)!.inv.get('wheat')!.qty = 200;
    // neither player is "connected"; execution is server-driven
    expect(world.players.get(farmerId)!.connections).toBe(0);
    const result = await world.executeContract(c.id);
    expect(result).toBe('delivered');
  });
});
