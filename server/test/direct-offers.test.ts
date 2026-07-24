// V2.7 Phase 3 — direct messaging & negotiated trade offers.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld } from './helpers.js';
import { closeDb, query } from '../src/db.js';
import { GameError, type World, type BizRec } from '../src/game/world.js';
import { SHOP_LEVELS } from '@district/shared';

let world: World;
beforeEach(async () => {
  await resetDb();
  world = await loadedWorld();
});
afterAll(async () => {
  await closeDb();
});

// A farm (milk seller) and a coffee shop (milk buyer), both funded.
async function pair(): Promise<{ sellerId: number; sellerBiz: BizRec; buyerId: number; buyerBiz: BizRec }> {
  const sellerId = await newPlayer(world, 'seller');
  const sellerBiz = await world.chooseBusiness(sellerId, 'farm');
  sellerBiz.inv.get('milk')!.qty = 1000;
  world.players.get(sellerId)!.cash = 100000;
  const buyerId = await newPlayer(world, 'buyer');
  const buyerBiz = await world.chooseBusiness(buyerId, 'coffee_shop');
  buyerBiz.level = 3;
  world.players.get(buyerId)!.cash = 100000;
  return { sellerId, sellerBiz, buyerId, buyerBiz };
}

describe('direct messaging', () => {
  it('sends a private message and both parties can read the conversation', async () => {
    const a = await newPlayer(world, 'alice');
    const b = await newPlayer(world, 'bob');
    await world.sendDirectMessage(a, b, 'Need 500 wheat?');
    const forA = await world.getConversation(a, b);
    const forB = await world.getConversation(b, a);
    expect(forA.messages.at(-1)!.body).toBe('Need 500 wheat?');
    expect(forB.messages.at(-1)!.body).toBe('Need 500 wheat?');
    expect(forA.messages.at(-1)!.self).toBe(true);
    expect(forB.messages.at(-1)!.self).toBe(false);
  });

  it('tracks unread per participant', async () => {
    const a = await newPlayer(world, 'a2');
    const b = await newPlayer(world, 'b2');
    await world.sendDirectMessage(a, b, 'hi');
    let convB = (await world.listConversations(b)).find((c) => c.otherId === a)!;
    expect(convB.unread).toBe(1);
    await world.getConversation(b, a); // b reads it
    convB = (await world.listConversations(b)).find((c) => c.otherId === a)!;
    expect(convB.unread).toBe(0);
    // The sender never has unread from their own message.
    const convA = (await world.listConversations(a)).find((c) => c.otherId === b)!;
    expect(convA.unread).toBe(0);
  });

  it('keeps conversations private (a third party cannot read them)', async () => {
    const a = await newPlayer(world, 'a3');
    const b = await newPlayer(world, 'b3');
    const c = await newPlayer(world, 'c3');
    await world.sendDirectMessage(a, b, 'secret deal');
    // c querying a conversation with a only ever gets the c<->a conversation.
    const forC = await world.getConversation(c, a);
    expect(forC.messages.some((m) => m.body === 'secret deal')).toBe(false);
    expect((await world.listConversations(c)).some((cv) => cv.otherId === b)).toBe(false);
  });

  it('rate-limits and sanitizes messages, rejects self-DM', async () => {
    const a = await newPlayer(world, 'a4');
    const b = await newPlayer(world, 'b4');
    const m = await world.sendDirectMessage(a, b, '<b>hi</b> there');
    expect(m.message.body).not.toContain('<');
    await expect(world.sendDirectMessage(a, b, 'again')).rejects.toBeInstanceOf(GameError); // min-gap
    await expect(world.sendDirectMessage(a, a, 'me')).rejects.toBeInstanceOf(GameError);
  });

  it('persists conversation history across restart', async () => {
    const a = await newPlayer(world, 'a5');
    const b = await newPlayer(world, 'b5');
    await world.sendDirectMessage(a, b, 'persist me');
    const world2 = await loadedWorld();
    const forA = await world2.getConversation(a, b);
    expect(forA.messages.some((x) => x.body === 'persist me')).toBe(true);
  });
});

describe('trade offers — negotiation', () => {
  it('creates a BUY offer; only the recipient may act', async () => {
    const { sellerId, buyerId, buyerBiz } = await pair();
    // buyer proposes BUY 200 milk @ 6 from the seller's business.
    const sellerBizId = world.bizByOwner(sellerId)!.id;
    const offer = await world.createOffer(buyerId, sellerBizId, 'buy', 'milk', 200, 6);
    expect(offer.status).toBe('pending');
    expect(offer.awaitingPlayer).toBe(sellerId);
    // The proposer cannot accept their own offer.
    await expect(world.acceptOffer(buyerId, offer.id, offer.version)).rejects.toBeInstanceOf(GameError);
    void buyerBiz;
  });

  it('counter chain: only the latest version is actionable', async () => {
    const { sellerId, buyerId } = await pair();
    const sellerBizId = world.bizByOwner(sellerId)!.id;
    const o = await world.createOffer(buyerId, sellerBizId, 'buy', 'milk', 200, 6); // v1, buyer proposes
    await world.counterOffer(sellerId, o.id, 200, 10, 1); // seller counters -> v2
    // Accepting the stale v1 is rejected.
    await expect(world.acceptOffer(buyerId, o.id, 1)).rejects.toBeInstanceOf(GameError);
    // Buyer counters again -> v3
    await world.counterOffer(buyerId, o.id, 200, 8, 2);
    expect(world.offers.get(o.id)!.version).toBe(3);
    expect(world.offers.get(o.id)!.awaitingPlayer).toBe(sellerId);
  });

  it('accept moves money and stock exactly once and creates one delivery', async () => {
    const { sellerId, sellerBiz, buyerId, buyerBiz } = await pair();
    const sellerBizId = sellerBiz.id;
    const o = await world.createOffer(buyerId, sellerBizId, 'buy', 'milk', 200, 6);
    const buyerCash0 = world.players.get(buyerId)!.cash;
    const sellerCash0 = world.players.get(sellerId)!.cash;
    const sellerMilk0 = sellerBiz.inv.get('milk')!.qty;
    world.deliveries.clear();

    await world.acceptOffer(sellerId, o.id, o.version); // seller (awaiting) accepts
    const amount = 200 * 6;
    expect(world.players.get(buyerId)!.cash).toBe(buyerCash0 - amount);
    expect(world.players.get(sellerId)!.cash).toBe(sellerCash0 + amount);
    expect(sellerBiz.inv.get('milk')!.qty).toBe(sellerMilk0 - 200);
    const del = [...world.deliveries.values()].filter((d) => d.product === 'milk' && d.toBusinessId === buyerBiz.id);
    expect(del.length).toBe(1);
    expect(del[0].qty).toBe(200);
    // Ledger: exactly one DIRECT_SELL and one DIRECT_BUY.
    const led = await query(`SELECT transaction_type t, count(*)::int c FROM economic_ledger WHERE reference_type='offer' GROUP BY t`);
    const m = Object.fromEntries(led.rows.map((r: any) => [r.t, r.c]));
    expect(m['DIRECT_SELL']).toBe(1);
    expect(m['DIRECT_BUY']).toBe(1);
  });

  it('rejects a duplicate / concurrent accept (money moves once)', async () => {
    const { sellerId, buyerId } = await pair();
    const sellerBizId = world.bizByOwner(sellerId)!.id;
    const o = await world.createOffer(buyerId, sellerBizId, 'buy', 'milk', 100, 5);
    const buyerCash0 = world.players.get(buyerId)!.cash;
    const [r1, r2] = await Promise.allSettled([
      world.acceptOffer(sellerId, o.id, o.version),
      world.acceptOffer(sellerId, o.id, o.version),
    ]);
    const ok = [r1, r2].filter((r) => r.status === 'fulfilled');
    expect(ok.length).toBe(1);
    // Charged exactly once.
    expect(world.players.get(buyerId)!.cash).toBe(buyerCash0 - 100 * 5);
  });

  it('rejects accept on insufficient funds / stock / storage', async () => {
    const { sellerId, sellerBiz, buyerId, buyerBiz } = await pair();
    const sellerBizId = sellerBiz.id;
    // Insufficient funds.
    world.players.get(buyerId)!.cash = 10;
    const o1 = await world.createOffer(buyerId, sellerBizId, 'buy', 'milk', 100, 5);
    await expect(world.acceptOffer(sellerId, o1.id, o1.version)).rejects.toBeInstanceOf(GameError);
    world.players.get(buyerId)!.cash = 100000;

    // Insufficient seller stock.
    sellerBiz.inv.get('milk')!.qty = 10;
    const o2 = await world.createOffer(buyerId, sellerBizId, 'buy', 'milk', 100, 5);
    await expect(world.acceptOffer(sellerId, o2.id, o2.version)).rejects.toBeInstanceOf(GameError);
    sellerBiz.inv.get('milk')!.qty = 1000;

    // Insufficient buyer storage (reuses the V2.6.2 guard) — never overflows.
    const cap = SHOP_LEVELS[3].ingredientCapacity;
    buyerBiz.inv.get('milk')!.qty = cap - 10; // only 10 free
    const o3 = await world.createOffer(buyerId, sellerBizId, 'buy', 'milk', 100, 5);
    await expect(world.acceptOffer(sellerId, o3.id, o3.version)).rejects.toBeInstanceOf(GameError);
    expect(buyerBiz.inv.get('milk')!.qty + buyerBiz.inv.get('milk')!.reserved).toBeLessThanOrEqual(cap);
  });

  it('reject / cancel end the negotiation; expired offers cannot execute', async () => {
    const { sellerId, buyerId } = await pair();
    const sellerBizId = world.bizByOwner(sellerId)!.id;
    const o1 = await world.createOffer(buyerId, sellerBizId, 'buy', 'milk', 50, 5);
    await world.rejectOffer(sellerId, o1.id);
    expect(world.offers.has(o1.id)).toBe(false);
    await expect(world.acceptOffer(sellerId, o1.id, o1.version)).rejects.toBeInstanceOf(GameError);

    const o2 = await world.createOffer(buyerId, sellerBizId, 'buy', 'milk', 50, 5);
    await world.cancelOffer(buyerId, o2.id);
    expect(world.offers.has(o2.id)).toBe(false);

    // Expiration sweep retires a past-deadline offer; it then cannot execute.
    const o3 = await world.createOffer(buyerId, sellerBizId, 'buy', 'milk', 50, 5);
    world.offers.get(o3.id)!.expiresAtMs = Date.now() - 1;
    await (world as unknown as { sweepExpiredOffers(n: number): Promise<void> }).sweepExpiredOffers(Date.now());
    expect(world.offers.has(o3.id)).toBe(false);
    await expect(world.acceptOffer(sellerId, o3.id, o3.version)).rejects.toBeInstanceOf(GameError);
  });

  it('a non-participant cannot act on an offer', async () => {
    const { sellerId, buyerId } = await pair();
    const outsider = await newPlayer(world, 'outsider');
    const sellerBizId = world.bizByOwner(sellerId)!.id;
    const o = await world.createOffer(buyerId, sellerBizId, 'buy', 'milk', 50, 5);
    await expect(world.acceptOffer(outsider, o.id, o.version)).rejects.toBeInstanceOf(GameError);
    await expect(world.counterOffer(outsider, o.id, 50, 4, o.version)).rejects.toBeInstanceOf(GameError);
  });

  it('a live offer survives restart and can still be accepted', async () => {
    const { sellerId, buyerId } = await pair();
    const sellerBizId = world.bizByOwner(sellerId)!.id;
    const o = await world.createOffer(buyerId, sellerBizId, 'buy', 'milk', 100, 5);
    const world2 = await loadedWorld();
    expect(world2.offers.has(o.id)).toBe(true);
    world2.players.get(buyerId)!.cash = 100000;
    world2.businesses.get(world2.bizByOwner(sellerId)!.id)!.inv.get('milk')!.qty = 1000;
    await world2.acceptOffer(sellerId, o.id, o.version);
    expect(world2.offers.has(o.id)).toBe(false);
  });
});
