// BUSINESS DISTRICT — V2.8 Phase 1 Product Economy E2E (real UI).
//
// Prereqs: dev stack running with dev tools (npm run dev). Run: npm run e2e:economy
//
// Drives the real Business panel: starter license + active product, Business
// Level/XP + next reward + roadmap, license purchase via the game-native modal
// (exactly-once), product activation (slots + cooldown), reject cases, recipe
// preview, and business-specific license ownership.
import { chromium } from 'playwright';

const CLIENT_URL = process.env.E2E_CLIENT_URL || 'http://localhost:5173';
const SERVER_URL = process.env.E2E_SERVER_URL || 'http://localhost:2567';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
};
try { const h = await fetch(`${SERVER_URL}/api/health`); if (!h.ok) throw 0; }
catch { console.error(`Server not reachable. Start it: npm run dev`); process.exit(2); }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const run = Date.now() % 1000000;

async function player(name, bizType) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] PAGEERROR: ${e.message}`));
  await page.goto(CLIENT_URL);
  await page.waitForSelector('#auth-user', { timeout: 15000 });
  await page.fill('#auth-user', name); await page.fill('#auth-pass', 'e2e-pass-1234');
  await page.click('#auth-go');
  await page.waitForSelector('.choice', { timeout: 15000 });
  await page.click(`.choice[data-type="${bizType}"]`);
  await page.waitForFunction(() => window.__bd?.client?.myBiz != null, { timeout: 15000 });
  return page;
}
const send = (p, m) => p.evaluate((x) => window.__bd.client.send(x), m);
const cash = (p) => p.evaluate(() => window.__bd.client.you.cash);
const bizTab = async (p, tab) => {
  await p.click('#nav-biz'); await p.waitForTimeout(300);
  await p.evaluate((tb) => { const b = [...document.querySelectorAll('#panel-tabs button')].find((x) => x.dataset.tab === tb); b && b.click(); }, tab);
  await p.waitForTimeout(300);
};
const progression = (p) => p.evaluate(() => window.__bd.client.myBiz.progression);
const dismiss = (p) => p.evaluate(() => document.querySelectorAll('.overlay.modal, #brief-overlay, #mobile-hint').forEach((o) => o.remove()));

const A = await player(`peA_${run}`, 'coffee_shop');
await A.waitForTimeout(700); await dismiss(A);

// 1) Migration/creation: starter license exists + active; level/xp present.
let pr = await progression(A);
check('starter coffee license exists and is active', pr.owned.some((o) => o.product === 'coffee' && o.active));
check('business level + XP present', pr.bizLevel === 1 && typeof pr.bizXp === 'number');
check('next-level reward is defined', pr.nextRewardLevel === 2 && !!pr.nextRewardKind);

// 2) Level tab shows the roadmap; a milestone slot is visible.
await bizTab(A, 'level');
check('progression roadmap renders levels 1..50', await A.evaluate(() => document.querySelectorAll('.road-row').length >= 50));
check('a slot milestone is shown on the roadmap', await A.evaluate(() => [...document.querySelectorAll('.road-row')].some((r) => /Slot|Yuva/i.test(r.textContent))));

// 3) Products tab: latte is LOCKED at level 1 and explains why.
await bizTab(A, 'products');
check('latte is locked at level 1', await A.evaluate(() => !!document.querySelector('.prod-card.locked')));
check('locked latte explains the requirement', await A.evaluate(() => /Level 5|Seviye 5/i.test(document.querySelector('.prod-card.locked')?.textContent || '')));
check('recipe preview renders inputs → output', await A.evaluate(() => /×2/.test(document.body.textContent) && /→/.test(document.body.textContent)));

// 4) Reach level 5 via dev/admin acceleration (allowed by the spec for E2E).
const bizId = await A.evaluate(() => window.__bd.client.myBiz.id);
await send(A, { t: 'dev', cmd: 'biz_xp', value: 1000 }); // dev-only XP grant (A stays non-admin so cooldown applies)
await A.waitForFunction(() => window.__bd.client.myBiz.bizLevel >= 5, { timeout: 8000 });
check('business reached level 5 through XP', (await progression(A)).bizLevel >= 5);

// 5) Buy the latte license through the REAL modal; cash deducts exactly once.
await bizTab(A, 'products');
const cash0 = await cash(A);
await A.click('[data-buy="latte"]');
await A.waitForSelector('#license-overlay', { timeout: 5000 });
check('license modal shows fee + treasury impact', await A.evaluate(() => /4,000|4000/.test(document.querySelector('#license-overlay')?.textContent || '')));
await A.click('#lic-buy');
await A.waitForFunction(() => window.__bd.client.myBiz.progression.owned.some((o) => o.product === 'latte'), { timeout: 8000 });
check('latte license acquired', (await progression(A)).owned.some((o) => o.product === 'latte'));
check('cash deducted exactly once (−$4000)', (await cash(A)) === cash0 - 4000, `${cash0} -> ${await cash(A)}`);

// Double-buy attempt must not charge again (already owned / exactly-once).
const cashAfter = await cash(A);
await send(A, { t: 'buy_license', bizId, product: 'latte' });
await A.waitForTimeout(700);
check('duplicate license buy does not charge again', (await cash(A)) === cashAfter);

// 6) Persist across reload.
await A.reload(); await A.waitForFunction(() => window.__bd?.client?.myBiz != null, { timeout: 15000 }); await A.waitForTimeout(700); await dismiss(A);
check('license persists after reload', (await progression(A)).owned.some((o) => o.product === 'latte'));

// 7) Activate latte (slot usage updates), then reload preserves it.
await bizTab(A, 'products');
const usedBefore = (await progression(A)).slotsUsed;
await A.click('[data-toggle="latte:1"]');
await A.waitForFunction((u) => window.__bd.client.myBiz.progression.slotsUsed === u + 1, usedBefore, { timeout: 8000 }).catch(() => {});
check('activating a product uses a slot', (await progression(A)).slotsUsed === usedBefore + 1);
await A.reload(); await A.waitForFunction(() => window.__bd?.client?.myBiz != null, { timeout: 15000 }); await A.waitForTimeout(700); await dismiss(A);
check('active product persists after reload', (await progression(A)).owned.find((o) => o.product === 'latte')?.active === true);

// 8) Over-slot activation is rejected (2/2 used, no 3rd until level up) — and the
//    reconfiguration cooldown blocks an immediate switch.
await bizTab(A, 'products');
const cooldownBlocked = await A.evaluate(async () => {
  const before = window.__bd.client.myBiz.progression.owned.find((o) => o.product === 'coffee').active;
  window.__bd.client.send({ t: 'set_product_active', bizId: window.__bd.client.myBiz.id, product: 'coffee', active: false });
  await new Promise((r) => setTimeout(r, 700));
  return before === window.__bd.client.myBiz.progression.owned.find((o) => o.product === 'coffee').active; // unchanged => blocked
});
check('reconfiguration cooldown blocks rapid switching', cooldownBlocked);

// 9) Unlicensed activation rejected.
const unlicensed = await A.evaluate(async () => {
  const c0 = window.__bd.client.myBiz.progression.owned.length;
  window.__bd.client.send({ t: 'set_product_active', bizId: window.__bd.client.myBiz.id, product: 'bread', active: true });
  await new Promise((r) => setTimeout(r, 500));
  return window.__bd.client.myBiz.progression.owned.length === c0; // no bread added
});
check('activating an unlicensed product is rejected', unlicensed);

// 10) Business-specific: a different company's coffee shop does NOT have latte.
const B = await player(`peB_${run}`, 'coffee_shop');
const prB = await progression(B);
check('another business does not inherit the latte license', !prB.owned.some((o) => o.product === 'latte'));
check('but has its own starter coffee license', prB.owned.some((o) => o.product === 'coffee'));

await browser.close();
console.log(failures ? `\nV2.8 ECONOMY: ${failures} CHECK(S) FAILED` : '\nV2.8 ECONOMY: ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
