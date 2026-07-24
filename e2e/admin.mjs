// BUSINESS DISTRICT — V2.7 Phase 2 Admin & Live Ops E2E.
//
// Prereqs: dev stack running with dev tools (npm run dev). Run: npm run e2e:admin
//
// An admin drives live operations entirely through the client (no DB access):
// search, cash, inventory, wholesale refill (visible to a player without a
// restart), announcement, mute, audit — then hard-deletes a disposable player
// and verifies no ghost business/lot remains and the deleted player is gone.
import { chromium } from 'playwright';

const CLIENT_URL = process.env.E2E_CLIENT_URL || 'http://localhost:5173';
const SERVER_URL = process.env.E2E_SERVER_URL || 'http://localhost:2567';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
};

try {
  const h = await fetch(`${SERVER_URL}/api/health`);
  if (!h.ok) throw new Error(String(h.status));
} catch {
  console.error(`Server not reachable at ${SERVER_URL}. Start it: npm run dev`);
  process.exit(2);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const run = Date.now() % 1000000;

async function player(name, bizType) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] PAGEERROR: ${e.message}`));
  await page.goto(CLIENT_URL);
  await page.waitForSelector('#auth-user', { timeout: 15000 });
  await page.fill('#auth-user', name);
  await page.fill('#auth-pass', 'e2e-pass-1234');
  await page.click('#auth-go');
  await page.waitForSelector('.choice', { timeout: 15000 });
  await page.click(`.choice[data-type="${bizType}"]`);
  await page.waitForFunction(() => window.__bd?.client?.myBiz != null, { timeout: 15000 });
  return { page, name };
}
const send = (p, m) => p.evaluate((x) => window.__bd.client.send(x), m);
const rpc = async (p, msg, until) => { await send(p, msg); await p.waitForFunction(until, null, { timeout: 8000 }); };

const ADMIN = await player(`adm_${run}`, 'coffee_shop');
const TARGET = await player(`tgt_${run}`, 'farm');
const DISPOSABLE = await player(`del_${run}`, 'bakery');

// Promote ADMIN via the dev hook (dev tools on in dev).
await ADMIN.page.evaluate(() => window.__bd.client.send({ t: 'dev', cmd: 'make_admin' }));
await ADMIN.page.waitForFunction(() => window.__bd.client.you?.isAdmin === true, null, { timeout: 8000 });
check('admin flag is set', await ADMIN.page.evaluate(() => window.__bd.client.you.isAdmin));

// 1) Search for the target player.
await rpc(ADMIN.page, { t: 'admin_search_players', q: `tgt_${run}` },
  () => window.__bd.client.adminPlayers.some((p) => p.username.startsWith('tgt_')));
const targetId = await ADMIN.page.evaluate((n) => window.__bd.client.adminPlayers.find((p) => p.username === n)?.id, `tgt_${run}`);
check('admin can find a player by name', targetId != null, `id=${targetId}`);

// 2) Add cash — the TARGET sees the new balance live (no restart).
const cash0 = await TARGET.page.evaluate(() => window.__bd.client.you.cash);
await send(ADMIN.page, { t: 'admin_cash', playerId: targetId, op: 'add', amount: 50000, reason: 'incident comp' });
await TARGET.page.waitForFunction((c0) => window.__bd.client.you.cash === c0 + 50000, cash0, { timeout: 8000 });
check('admin ADD CASH reaches the player live', (await TARGET.page.evaluate(() => window.__bd.client.you.cash)) === cash0 + 50000);

// 3) Add inventory — TARGET (farm) sees milk increase.
const tgtBizId = await TARGET.page.evaluate(() => window.__bd.client.myBiz.id);
const milk0 = await TARGET.page.evaluate(() => window.__bd.client.myBiz.inventory.milk?.qty ?? 0);
await send(ADMIN.page, { t: 'admin_inventory', bizId: tgtBizId, product: 'milk', op: 'add', amount: 50, reason: 'seed' });
await TARGET.page.waitForFunction((m0) => (window.__bd.client.myBiz.inventory.milk?.qty ?? 0) === m0 + 50, milk0, { timeout: 8000 });
check('admin ADD INVENTORY reaches the player live', (await TARGET.page.evaluate(() => window.__bd.client.myBiz.inventory.milk.qty)) === milk0 + 50);

// 4) Deplete then refill Coffee Beans wholesale — TARGET sees it WITHOUT restart.
await send(ADMIN.page, { t: 'admin_wholesale', product: 'beans', op: 'set', amount: 0 });
await TARGET.page.waitForFunction(() => (window.__bd.client.wholesale?.products?.find((w) => w.product === 'beans')?.remaining) === 0, null, { timeout: 8000 });
check('wholesale beans depleted (live)', (await TARGET.page.evaluate(() => window.__bd.client.wholesale.products.find((w) => w.product === 'beans').remaining)) === 0);
await send(ADMIN.page, { t: 'admin_wholesale', product: 'beans', op: 'refill', reason: 'restock' });
await TARGET.page.waitForFunction(() => (window.__bd.client.wholesale?.products?.find((w) => w.product === 'beans')?.remaining) > 0, null, { timeout: 8000 });
check('admin REFILL wholesale reaches players without restart', (await TARGET.page.evaluate(() => window.__bd.client.wholesale.products.find((w) => w.product === 'beans').remaining)) > 0);

// 5) Create an announcement — TARGET receives it live.
await send(ADMIN.page, { t: 'create_announcement', title: `Maint ${run}`, message: 'Live ops test', kind: 'general', priority: 'normal' });
await TARGET.page.waitForFunction((r) => window.__bd.client.announcementsActive.some((a) => a.title === `Maint ${r}`), run, { timeout: 8000 });
check('admin announcement reaches players live', await TARGET.page.evaluate((r) => window.__bd.client.announcementsActive.some((a) => a.title === `Maint ${r}`), run));

// 6) Mute the target; muted chat send is rejected; then unmute.
await send(ADMIN.page, { t: 'admin_mute', playerId: targetId, minutes: 60, reason: 'test' });
await TARGET.page.waitForFunction(() => window.__bd.client.chatMuted === true, null, { timeout: 8000 });
check('admin mute reaches the player', await TARGET.page.evaluate(() => window.__bd.client.chatMuted));
await send(TARGET.page, { t: 'chat_send', body: 'can I talk?' });
await TARGET.page.waitForTimeout(800);
check('muted player cannot post', !(await TARGET.page.evaluate(() => window.__bd.client.chat.some((m) => m.body === 'can I talk?'))));
await send(ADMIN.page, { t: 'admin_unmute', playerId: targetId });
await TARGET.page.waitForFunction(() => window.__bd.client.chatMuted === false, null, { timeout: 8000 });
check('admin unmute restores the player', !(await TARGET.page.evaluate(() => window.__bd.client.chatMuted)));

// 7) Hard delete the disposable player.
const delId = await ADMIN.page.evaluate((n) => window.__bd.client.players.find((p) => p.name === n)?.id, `del_${run}`);
const delBizId = await DISPOSABLE.page.evaluate(() => window.__bd.client.myBiz.id);
const delLotId = await DISPOSABLE.page.evaluate(() => window.__bd.client.myBiz.lotId);
// Confirm the business is visible to the admin before deletion.
check('disposable business is visible pre-delete', await ADMIN.page.evaluate((id) => window.__bd.client.businesses.has(id), delBizId));
await send(ADMIN.page, { t: 'admin_hard_delete', playerId: delId, confirmName: `del_${run}`, reason: 'cleanup' });

// The deleted player is forced off (socket closed, no reconnect).
await DISPOSABLE.page.waitForFunction(() => !window.__bd.client.connected, null, { timeout: 10000 }).catch(() => {});
check('deleted player is disconnected', !(await DISPOSABLE.page.evaluate(() => window.__bd.client.connected)));

// Other connected clients drop the ghost business + free the lot.
await ADMIN.page.waitForFunction((id) => !window.__bd.client.businesses.has(id), delBizId, { timeout: 8000 });
check('deleted business removed from other clients (no ghost)', !(await ADMIN.page.evaluate((id) => window.__bd.client.businesses.has(id), delBizId)));
const lotFree = await ADMIN.page.evaluate((lot) => ![...window.__bd.client.businesses.values()].some((b) => b.lotId === lot), delLotId);
check('deleted player\'s lot is free again', lotFree);

// Deleted player cannot reconnect (session invalidated): a manual reconnect stays disconnected.
await DISPOSABLE.page.evaluate(() => { try { window.__bd.client.connect(); } catch {} });
await DISPOSABLE.page.waitForTimeout(1500);
check('deleted player cannot reconnect', !(await DISPOSABLE.page.evaluate(() => window.__bd.client.connected)));

// 8) Audit log contains the actions we performed.
await rpc(ADMIN.page, { t: 'admin_audit', limit: 50 }, () => window.__bd.client.adminAudit.length > 0);
const actions = await ADMIN.page.evaluate(() => window.__bd.client.adminAudit.map((e) => e.action));
for (const act of ['SET_CASH', 'SET_INVENTORY', 'REFILL_WHOLESALE', 'MUTE_PLAYER', 'HARD_DELETE_PLAYER']) {
  check(`audit records ${act}`, actions.includes(act));
}

await browser.close();
console.log(failures ? `\nV2.7 ADMIN: ${failures} CHECK(S) FAILED` : '\nV2.7 ADMIN: ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
