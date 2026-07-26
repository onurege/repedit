// V2.8 Phase 2 — manual production: start/commit, queue, completion, storage,
// restart persistence, XP, and economic-race invariants.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld } from './helpers.js';
import { closeDb, query } from '../src/db.js';
import { GameError, type World, type BizRec } from '../src/game/world.js';
import { xpForBizLevel, type ProductId } from '@district/shared';

let world: World;
beforeEach(async () => {
  await resetDb();
  world = await loadedWorld();
});
afterAll(async () => {
  await closeDb();
});

async function shop(w: World, name: string, level = 1): Promise<{ id: number; biz: BizRec }> {
  const id = await newPlayer(w, name);
  const biz = await w.chooseBusiness(id, 'coffee_shop');
  biz.bizXp = xpForBizLevel(level);
  biz.bizLevel = level;
  biz.level = 3; // facility tier 3 -> ample finished-goods capacity (coffee cap 200)
  w.players.get(id)!.cash = 100000;
  return { id, biz };
}
function give(biz: BizRec, product: ProductId, qty: number): void {
  biz.inv.set(product, { qty, reserved: biz.inv.get(product)?.reserved ?? 0 });
}
const onHand = (biz: BizRec, p: ProductId): number => biz.inv.get(p)?.qty ?? 0;
const head = (biz: BizRec) => biz.prodJobs[0];

describe('start production — commitment & validation', () => {
  it('commits ingredients exactly once at start and creates one producing job', async () => {
    const { id, biz } = await shop(world, 'p1');
    give(biz, 'milk', 200); give(biz, 'beans', 200);
    await world.startProduction(id, biz.id, 'coffee', 50);
    expect(onHand(biz, 'milk')).toBe(150);  // consumed at START, not completion
    expect(onHand(biz, 'beans')).toBe(150);
    expect(onHand(biz, 'coffee')).toBe(0);   // output arrives only on completion
    expect(biz.prodJobs).toHaveLength(1);
    expect(head(biz).status).toBe('producing');
    const rows = await query('SELECT count(*)::int c FROM production_jobs');
    expect(rows.rows[0].c).toBe(1);
  });

  it('rejects an unlicensed product', async () => {
    const { id, biz } = await shop(world, 'p2');
    give(biz, 'wheat', 100);
    await expect(world.startProduction(id, biz.id, 'bread', 10)).rejects.toBeInstanceOf(GameError);
  });

  it('rejects an inactive (licensed but not slotted) product', async () => {
    const { id, biz } = await shop(world, 'p3', 5);
    await world.buyLicense(id, biz.id, 'latte'); // owned but not active
    give(biz, 'beans', 100); give(biz, 'milk', 100);
    await expect(world.startProduction(id, biz.id, 'latte', 10)).rejects.toBeInstanceOf(GameError);
  });

  it('rejects insufficient ingredients WITHOUT committing anything', async () => {
    const { id, biz } = await shop(world, 'p4');
    give(biz, 'milk', 5); give(biz, 'beans', 100);
    await expect(world.startProduction(id, biz.id, 'coffee', 50)).rejects.toBeInstanceOf(GameError);
    expect(onHand(biz, 'milk')).toBe(5);   // untouched
    expect(onHand(biz, 'beans')).toBe(100);
    expect(biz.prodJobs).toHaveLength(0);
  });

  it('rejects a zero / invalid quantity', async () => {
    const { id, biz } = await shop(world, 'p5');
    give(biz, 'milk', 100); give(biz, 'beans', 100);
    await expect(world.startProduction(id, biz.id, 'coffee', 0)).rejects.toBeInstanceOf(GameError);
  });

  it('a concurrent double-start consumes ingredients once and makes one job', async () => {
    const { id, biz } = await shop(world, 'p6');
    give(biz, 'milk', 200); give(biz, 'beans', 200);
    const [r1, r2] = await Promise.allSettled([
      world.startProduction(id, biz.id, 'coffee', 100),
      world.startProduction(id, biz.id, 'coffee', 100),
    ]);
    expect([r1, r2].filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(onHand(biz, 'milk')).toBe(100); // only one batch's worth consumed
    expect(biz.prodJobs).toHaveLength(1);
    const rows = await query(`SELECT count(*)::int c FROM production_jobs WHERE status<>'cancelled'`);
    expect(rows.rows[0].c).toBe(1);
  });
});

describe('queue — committed ingredients, ordering, capacity', () => {
  it('commits ingredients for every queued job; the queue is ordered', async () => {
    const { id, biz } = await shop(world, 'q1');
    give(biz, 'milk', 500); give(biz, 'beans', 500);
    await world.startProduction(id, biz.id, 'coffee', 100); // producing
    await world.startProduction(id, biz.id, 'coffee', 100); // queued
    expect(onHand(biz, 'milk')).toBe(300);  // 200 committed across both jobs
    expect(biz.prodJobs).toHaveLength(2);
    expect(biz.prodJobs[0].status).toBe('producing');
    expect(biz.prodJobs[1].status).toBe('queued');
  });

  it('committed ingredients cannot be double-spent by a later job', async () => {
    const { id, biz } = await shop(world, 'q2');
    give(biz, 'milk', 150); give(biz, 'beans', 150);
    await world.startProduction(id, biz.id, 'coffee', 100); // leaves 50 milk/50 beans
    await expect(world.startProduction(id, biz.id, 'coffee', 100)).rejects.toBeInstanceOf(GameError);
  });

  it('enforces the level-scaled queue limit', async () => {
    const { id, biz } = await shop(world, 'q3', 1); // limit 2
    give(biz, 'milk', 900); give(biz, 'beans', 900);
    await world.startProduction(id, biz.id, 'coffee', 100);
    await world.startProduction(id, biz.id, 'coffee', 100);
    await expect(world.startProduction(id, biz.id, 'coffee', 100)).rejects.toBeInstanceOf(GameError);
  });

  it('the next queued job auto-starts when the current one completes', async () => {
    const { id, biz } = await shop(world, 'q4');
    give(biz, 'milk', 500); give(biz, 'beans', 500);
    await world.startProduction(id, biz.id, 'coffee', 20);
    await world.startProduction(id, biz.id, 'coffee', 20);
    // finish the whole line via dev fast-forward
    await world.devCommand(id, 'finish_production', 0, biz.id);
    expect(biz.prodJobs).toHaveLength(0);
    expect(onHand(biz, 'coffee')).toBe(40);
  });
});

describe('completion — output, XP, exactly-once', () => {
  it('adds output once and awards production XP by volume', async () => {
    const { id, biz } = await shop(world, 'c1');
    const xp0 = biz.bizXp;
    give(biz, 'milk', 100); give(biz, 'beans', 100);
    await world.startProduction(id, biz.id, 'coffee', 100);
    await world.devCommand(id, 'finish_production', 0, biz.id);
    expect(onHand(biz, 'coffee')).toBe(100);
    expect(biz.bizXp).toBe(xp0 + 100); // 100 units * perUnitProduced(1)
  });

  it('splitting into many tiny jobs does not inflate XP vs one big job', async () => {
    const big = await shop(world, 'c2a');
    give(big.biz, 'milk', 100); give(big.biz, 'beans', 100);
    await world.startProduction(big.id, big.biz.id, 'coffee', 100);
    await world.devCommand(big.id, 'finish_production', 0, big.biz.id);

    const small = await shop(world, 'c2b');
    give(small.biz, 'milk', 100); give(small.biz, 'beans', 100);
    for (let i = 0; i < 5; i++) { // 5 jobs of 20 (queue limit 2 -> finish between)
      await world.startProduction(small.id, small.biz.id, 'coffee', 20);
      await world.devCommand(small.id, 'finish_production', 0, small.biz.id);
    }
    expect(small.biz.bizXp).toBe(big.biz.bizXp); // both produced 100 units total
  });

  it('a duplicate completion cannot add output twice', async () => {
    const { id, biz } = await shop(world, 'c3');
    give(biz, 'milk', 50); give(biz, 'beans', 50);
    await world.startProduction(id, biz.id, 'coffee', 50);
    const job = head(biz);
    job.completesAtMs = Date.now() - 1;
    await (world as any).completeJob(biz, job, true);
    await (world as any).completeJob(biz, job, true); // replay: guarded, no-op
    expect(onHand(biz, 'coffee')).toBe(50);
    const done = await query(`SELECT count(*)::int c FROM production_jobs WHERE status='completed'`);
    expect(done.rows[0].c).toBe(1);
  });

  it('resolves elapsed production via the tick (offline completion)', async () => {
    const { id, biz } = await shop(world, 'c4');
    give(biz, 'milk', 60); give(biz, 'beans', 60);
    await world.startProduction(id, biz.id, 'coffee', 60);
    head(biz).completesAtMs = Date.now() - 1; // as if time passed while offline
    await world.tick(0);
    expect(biz.prodJobs).toHaveLength(0);
    expect(onHand(biz, 'coffee')).toBeGreaterThan(0);
  });
});

describe('storage-blocked completion (V2.6.2 preserved)', () => {
  it('holds finished goods when full, then completes exactly once when space frees', async () => {
    const { id, biz } = await shop(world, 's1');
    // Coffee capacity is 200 at facility tier 3; fill it so output cannot fit.
    give(biz, 'coffee', 200);
    give(biz, 'milk', 100); give(biz, 'beans', 100);
    await world.startProduction(id, biz.id, 'coffee', 10);
    await world.devCommand(id, 'finish_production', 0, biz.id);
    expect(head(biz).status).toBe('waiting_storage'); // blocked, not lost
    expect(onHand(biz, 'coffee')).toBe(200);           // never overflowed

    give(biz, 'coffee', 0); // space frees (e.g. NPC sales)
    await world.tick(0);
    expect(biz.prodJobs).toHaveLength(0);
    expect(onHand(biz, 'coffee')).toBe(10);            // entered exactly once
  });
});

describe('persistence across restart', () => {
  it('a producing job survives a reload with its committed ingredients', async () => {
    const { id, biz } = await shop(world, 'r1');
    give(biz, 'milk', 200); give(biz, 'beans', 200);
    await world.startProduction(id, biz.id, 'coffee', 50);
    const w2 = await loadedWorld();
    const b2 = w2.bizByOwner(id)!;
    expect(b2.prodJobs).toHaveLength(1);
    expect(b2.prodJobs[0].product).toBe('coffee');
    expect(b2.inv.get('milk')!.qty).toBe(150); // committed stock persisted
  });

  it('finished output persists across a reload', async () => {
    const { id, biz } = await shop(world, 'r2');
    give(biz, 'milk', 40); give(biz, 'beans', 40);
    await world.startProduction(id, biz.id, 'coffee', 40);
    await world.devCommand(id, 'finish_production', 0, biz.id);
    const w2 = await loadedWorld();
    expect(w2.bizByOwner(id)!.inv.get('coffee')!.qty).toBe(40);
  });
});

describe('economic-race invariants', () => {
  it('ingredients consumed by production cannot be sold on the marketplace', async () => {
    const { id, biz } = await shop(world, 'e1');
    give(biz, 'milk', 100); give(biz, 'beans', 100);
    await world.startProduction(id, biz.id, 'coffee', 100); // consumes all milk
    expect(onHand(biz, 'milk')).toBe(0);
    await expect(world.createOrder(id, 'sell', 'milk', 10, 12, biz.id)).rejects.toBeInstanceOf(GameError);
  });
});
