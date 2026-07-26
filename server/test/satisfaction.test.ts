// V2.8.2 — Customer Satisfaction (business-level, NPC-driven, smoothed) and its
// bounded effect on NPC-sale Business XP; plus the "stop production" behavior.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld } from './helpers.js';
import { closeDb } from '../src/db.js';
import { type World, type BizRec } from '../src/game/world.js';
import {
  xpForBizLevel, SATISFACTION_START, satisfactionXpBand, smoothSatisfaction,
  satisfactionStatus, type ProductId,
} from '@district/shared';

let world: World;
beforeEach(async () => {
  await resetDb();
  world = await loadedWorld();
});
afterAll(async () => {
  await closeDb();
});

async function shop(name: string): Promise<{ id: number; b: BizRec }> {
  const id = await newPlayer(world, name);
  const b = await world.chooseBusiness(id, 'coffee_shop');
  b.bizXp = xpForBizLevel(10); b.bizLevel = 10; b.level = 3;
  world.players.get(id)!.cash = 100000;
  return { id, b };
}
const give = (b: BizRec, p: ProductId, q: number) => b.inv.set(p, { qty: q, reserved: b.inv.get(p)?.reserved ?? 0 });

describe('satisfaction model (pure)', () => {
  it('XP bands are bounded 0.75–1.20 and monotonic', () => {
    expect(satisfactionXpBand(10)).toBe(0.75);
    expect(satisfactionXpBand(50)).toBe(0.90);
    expect(satisfactionXpBand(70)).toBe(1.00);
    expect(satisfactionXpBand(80)).toBe(1.10);
    expect(satisfactionXpBand(95)).toBe(1.20);
  });
  it('smoothing eases toward target, clamped, never overshoots in one step', () => {
    const up = smoothSatisfaction(70, 90, 10);
    expect(up).toBeGreaterThan(70); expect(up).toBeLessThan(90); // gradual
    expect(smoothSatisfaction(0, 100, 1000)).toBeLessThanOrEqual(100);
    expect(smoothSatisfaction(100, 0, 1000)).toBeGreaterThanOrEqual(0);
    // A single customer barely moves the score (evolves over many interactions).
    expect(Math.abs(smoothSatisfaction(70, 35, 1) - 70)).toBeLessThan(1);
  });
  it('status bands map correctly', () => {
    expect(satisfactionStatus(95)).toBe('excellent');
    expect(satisfactionStatus(80)).toBe('good');
    expect(satisfactionStatus(65)).toBe('normal');
    expect(satisfactionStatus(45)).toBe('poor');
    expect(satisfactionStatus(20)).toBe('critical');
  });
});

describe('satisfaction is driven only by NPC retail outcomes', () => {
  it('a new business starts at 70 and persists across restart', async () => {
    const { id, b } = await shop('cs1');
    expect(b.satisfaction).toBe(SATISFACTION_START);
    b.satisfaction = 83; b.dirty = true; await world.flush();
    const w2 = await loadedWorld();
    expect(w2.bizByOwner(id)!.satisfaction).toBe(83);
  });

  it('fair-price sales raise satisfaction toward ~90; persistent stockouts lower it', async () => {
    const { b } = await shop('cs2');
    b.satisfaction = 70;
    give(b, 'coffee', 100000); // never out of stock
    for (let i = 0; i < 40; i++) world.simulate(b, 30, true); // many fair sales
    const afterFair = b.satisfaction;
    expect(afterFair).toBeGreaterThan(75);

    // Now go permanently out of stock -> demand arrives, nothing served.
    give(b, 'coffee', 0);
    for (let i = 0; i < 60; i++) world.simulate(b, 30, true);
    expect(b.satisfaction).toBeLessThan(afterFair); // dropped
    expect(b.satisfaction).toBeGreaterThanOrEqual(0); // never below 0 (recoverable)
  });

  it('recovers after service is restored (no death spiral)', async () => {
    const { b } = await shop('cs3');
    b.satisfaction = 30; // start unhappy
    give(b, 'coffee', 100000);
    for (let i = 0; i < 60; i++) world.simulate(b, 30, true);
    expect(b.satisfaction).toBeGreaterThan(50); // climbed back up
  });

  it('non-retail actions do NOT change satisfaction (marketplace/production)', async () => {
    const { id, b } = await shop('cs4');
    const s0 = b.satisfaction;
    // A marketplace sell order does not touch satisfaction.
    give(b, 'coffee', 200);
    await world.createOrder(id, 'sell', 'coffee' as any, 50, 30, b.id).catch(() => {});
    // Production does not touch satisfaction.
    give(b, 'milk', 100); give(b, 'beans', 100);
    await world.startProduction(id, b.id, 'coffee', 20);
    expect(b.satisfaction).toBe(s0);
  });
});

describe('NPC-sale XP scales with satisfaction (bounded)', () => {
  it('same sales grant more XP at high satisfaction than at low', async () => {
    const hi = await shop('xh'); hi.b.satisfaction = 95; give(hi.b, 'coffee', 100000);
    const lo = await shop('xl'); lo.b.satisfaction = 20; give(lo.b, 'coffee', 100000);
    const hx0 = hi.b.bizXp, lx0 = lo.b.bizXp;
    // Drive identical retail time; high-satisfaction shop earns more Business XP.
    for (let i = 0; i < 20; i++) { world.simulate(hi.b, 30, true); world.simulate(lo.b, 30, true); }
    expect(hi.b.bizXp - hx0).toBeGreaterThan(lo.b.bizXp - lx0);
  });
});

describe('stop production (finish current, cancel the rest)', () => {
  it('lets the producing batch finish and cancels queued jobs with a refund', async () => {
    const { id, b } = await shop('st1');
    give(b, 'milk', 500); give(b, 'beans', 500);
    await world.startProduction(id, b.id, 'coffee', 20, 1); // producing (+repeat 1)
    await world.startProduction(id, b.id, 'coffee', 20);    // queued
    const milkBefore = b.inv.get('milk')!.qty;
    await world.stopProduction(id, b.id);
    // Queued job cancelled + refunded; the producing head remains, repeat cleared.
    expect(b.prodJobs).toHaveLength(1);
    expect(b.prodJobs[0].status).toBe('producing');
    expect(b.prodJobs[0].repeatRemaining).toBe(0);
    expect(b.inv.get('milk')!.qty).toBe(milkBefore + 20); // queued job's 20 refunded
    // Finish the current batch -> completes, and no repeat re-queues.
    await world.devCommand(id, 'finish_production', 0, b.id);
    expect(b.prodJobs).toHaveLength(0);
    expect(b.inv.get('coffee')!.qty).toBe(20); // only the current batch produced
  });
});
