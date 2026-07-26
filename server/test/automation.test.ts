// V2.8 Phase 4 — controlled automation: bounded production auto-repeat.
// Never auto-buys; commits ingredients exactly once, only when a repeat becomes
// a real job; fails gracefully; bounded; restart-safe.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld } from './helpers.js';
import { closeDb, query } from '../src/db.js';
import { type World, type BizRec } from '../src/game/world.js';
import { xpForBizLevel, type ProductId } from '@district/shared';

let world: World;
beforeEach(async () => {
  await resetDb();
  world = await loadedWorld();
});
afterAll(async () => {
  await closeDb();
});

// A coffee shop at a level that unlocks the given repeat cap (25:1, 35:2, 45:3).
async function shop(name: string, level = 25): Promise<{ id: number; b: BizRec }> {
  const id = await newPlayer(world, name);
  const b = await world.chooseBusiness(id, 'coffee_shop');
  b.bizXp = xpForBizLevel(level); b.bizLevel = level; b.level = 3;
  world.players.get(id)!.cash = 100000;
  return { id, b };
}
function give(b: BizRec, p: ProductId, qty: number): void { b.inv.set(p, { qty, reserved: b.inv.get(p)?.reserved ?? 0 }); }
const onHand = (b: BizRec, p: ProductId): number => b.inv.get(p)?.qty ?? 0;

describe('bounded auto-repeat', () => {
  it('clamps the repeat request to the level cap and stores it on the job', async () => {
    const { id, b } = await shop('ar1', 25); // cap 1
    give(b, 'milk', 200); give(b, 'beans', 200);
    await world.startProduction(id, b.id, 'coffee', 20, 5); // ask 5, allowed 1
    expect(b.prodJobs[0].repeatRemaining).toBe(1);
  });

  it('a completed job with repeats re-queues ONE real job, committing ingredients once', async () => {
    const { id, b } = await shop('ar2', 25);
    give(b, 'milk', 40); give(b, 'beans', 40); // exactly two 20-coffee batches
    await world.startProduction(id, b.id, 'coffee', 20, 1);
    expect(onHand(b, 'milk')).toBe(20); // first batch committed
    // Finish the first job: its repeat re-queues a second, committing again.
    await world.devCommand(id, 'finish_production', 0, b.id);
    // The repeat job exists and the second batch's ingredients are committed once.
    const jobs = await query(`SELECT count(*)::int c FROM production_jobs WHERE business_id=$1`, [b.id]);
    expect(jobs.rows[0].c).toBe(2);
    expect(onHand(b, 'milk')).toBe(0); // both batches committed, never negative
    expect(onHand(b, 'beans')).toBe(0);
    // Finish the whole line: 40 coffee produced total, no third repeat (count exhausted).
    await world.devCommand(id, 'finish_production', 0, b.id);
    expect(onHand(b, 'coffee')).toBe(40);
    expect(b.prodJobs).toHaveLength(0);
  });

  it('does not repeat when ingredients are insufficient (never auto-buys, no negative)', async () => {
    const { id, b } = await shop('ar3', 25);
    give(b, 'milk', 20); give(b, 'beans', 20); // enough for ONE batch only
    await world.startProduction(id, b.id, 'coffee', 20, 1);
    await world.devCommand(id, 'finish_production', 0, b.id); // repeat should fail (no ingredients)
    expect(onHand(b, 'milk')).toBe(0);
    expect(onHand(b, 'beans')).toBe(0);
    expect(onHand(b, 'coffee')).toBe(20); // only the first batch
    expect(b.prodJobs).toHaveLength(0);   // no fabricated repeat
  });

  it('does not repeat an inactive product', async () => {
    const { id, b } = await shop('ar4', 25);
    give(b, 'milk', 60); give(b, 'beans', 60);
    await world.startProduction(id, b.id, 'coffee', 20, 1);
    // Deactivate coffee before the job completes (admin bypasses cooldown).
    world.players.get(id)!.isAdmin = true;
    await world.setProductActive(id, b.id, 'coffee', false);
    await world.devCommand(id, 'finish_production', 0, b.id);
    expect(b.prodJobs).toHaveLength(0); // no repeat since coffee is inactive
    expect(onHand(b, 'coffee')).toBe(20);
  });

  it('repeats decrement and stop (no infinite loop)', async () => {
    const { id, b } = await shop('ar5', 45); // cap 3
    give(b, 'milk', 400); give(b, 'beans', 400);
    await world.startProduction(id, b.id, 'coffee', 20, 3);
    // Fast-forward the whole chain; it produces the initial + 3 repeats = 4 batches, then stops.
    for (let i = 0; i < 8; i++) await world.devCommand(id, 'finish_production', 0, b.id);
    expect(onHand(b, 'coffee')).toBe(80); // 4 * 20
    expect(b.prodJobs).toHaveLength(0);
    const completed = await query(`SELECT count(*)::int c FROM production_jobs WHERE status='completed'`);
    expect(completed.rows[0].c).toBe(4);
  });

  it('repeat_remaining survives a restart', async () => {
    const { id, b } = await shop('ar6', 35);
    give(b, 'milk', 200); give(b, 'beans', 200);
    await world.startProduction(id, b.id, 'coffee', 20, 2);
    const w2 = await loadedWorld();
    const b2 = w2.bizByOwner(id)!;
    expect(b2.prodJobs[0].repeatRemaining).toBe(2);
  });
});
