// V2.7 Phase 4 — rival alerts (committed data, dedupe/cooldown) and city news
// (bounded, privacy-safe, generated from real events).
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld } from './helpers.js';
import { closeDb, query } from '../src/db.js';
import { type World } from '../src/game/world.js';
import { NEWS_MAX_ITEMS } from '@district/shared';

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

// A funded bakery holding bread (so it can list sell orders).
async function baker(w: World, name: string): Promise<number> {
  const id = await newPlayer(w, name);
  const biz = await w.chooseBusiness(id, 'bakery');
  biz.inv.set('bread', { qty: 2000, reserved: 0 });
  w.players.get(id)!.cash = 100000;
  return id;
}

describe('rival alerts — price undercut (committed sell orders)', () => {
  it('a materially cheaper sell listing alerts the undercut rival exactly once', async () => {
    const victim = await baker(world, 'victim');
    const rival = await baker(world, 'rival');
    // Victim lists bread at 20; rival then lists clearly cheaper at 15.
    await world.createOrder(victim, 'sell', 'bread', 100, 20);
    await world.createOrder(rival, 'sell', 'bread', 100, 15);
    const alerts = world.getRivalAlerts(victim);
    expect(alerts.length).toBe(1);
    expect(alerts[0].type).toBe('price_undercut');
    expect(alerts[0].product).toBe('bread');
    // A second, only-slightly-cheaper listing is deduped (same key + cooldown).
    await world.createOrder(rival, 'sell', 'bread', 100, 14);
    expect(world.getRivalAlerts(victim).length).toBe(1);
  });

  it('a trivial (non-material) undercut does not alert', async () => {
    const victim = await baker(world, 'victim');
    const rival = await baker(world, 'rival');
    await world.createOrder(victim, 'sell', 'bread', 100, 20);
    await world.createOrder(rival, 'sell', 'bread', 100, 20); // equal — no undercut
    expect(world.getRivalAlerts(victim).length).toBe(0);
  });

  it('does not alert on your own cheaper listing', async () => {
    const me = await baker(world, 'me');
    await world.createOrder(me, 'sell', 'bread', 100, 20);
    await world.createOrder(me, 'sell', 'bread', 100, 10);
    expect(world.getRivalAlerts(me).length).toBe(0);
  });
});

describe('city news — generated from committed events, privacy-safe & bounded', () => {
  it('a city-order win produces one news item (mandatory)', async () => {
    const a = await admin(world);
    const b1 = await baker(world, 'bk1');
    const order = await world.createUrgentOrder(a, { product: 'bread', qty: 100, reward: 1500, durationSecs: 600 });
    await world.fulfillUrgentOrder(b1, order.id);
    const news = await world.cityNews();
    const win = news.find((n) => n.type === 'city_order_win');
    expect(win).toBeTruthy();
    expect(win!.params.qty).toBe(100);
    // Privacy: the payload never carries cash or private inventory fields.
    const keys = Object.keys(win!.params);
    expect(keys.some((k) => /cash|balance|inventory|integrity|secret/i.test(k))).toBe(false);
  });

  it('opening a business is public city news', async () => {
    await baker(world, 'newco');
    const news = await world.cityNews();
    expect(news.some((n) => n.type === 'business_opened')).toBe(true);
  });

  it('the feed is bounded to NEWS_MAX_ITEMS (older items pruned)', async () => {
    // Emit more than the cap; the persistent history must stay bounded.
    const add = (world as unknown as {
      addCityNews(t: string, i: { actorName: string | null; product: string | null; params: Record<string, unknown> }): Promise<void>;
    }).addCityNews.bind(world);
    for (let i = 0; i < NEWS_MAX_ITEMS + 8; i++) {
      await add('major_deal', { actorName: `co${i}`, product: 'bread', params: { seller: `co${i}`, buyer: 'x', qty: 10, amount: 5000, product: 'bread' } });
    }
    const news = await world.cityNews(1000);
    expect(news.length).toBeLessThanOrEqual(NEWS_MAX_ITEMS);
    const rows = await query(`SELECT count(*)::int c FROM city_news`);
    expect(rows.rows[0].c).toBeLessThanOrEqual(NEWS_MAX_ITEMS);
  });

  it('city news persists across a restart', async () => {
    await baker(world, 'persistco');
    const world2 = await loadedWorld();
    const news = await world2.cityNews();
    expect(news.some((n) => n.type === 'business_opened')).toBe(true);
  });
});
