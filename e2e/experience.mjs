// BUSINESS DISTRICT — V2.4 player-experience E2E.
//
// New player: Mira tutorial appears, and completing the first business step
// advances it. Returning player: Morning Brief appears with a company summary,
// an event, an alert and an opportunity; "What's New" appears; an admin
// announcement is published and shown; and the new mouse camera controls work.
//
// All state comes from real game systems (dev tools only accelerate/inject
// test conditions — no ranking/brief tables are faked).
// Prereqs: dev stack with dev tools (npm run dev), Chromium. Run: npm run e2e:experience

import { chromium } from 'playwright';

const CLIENT_URL = process.env.E2E_CLIENT_URL || 'http://localhost:5173';
const SERVER_URL = process.env.E2E_SERVER_URL || 'http://localhost:2567';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const health = await fetch(`${SERVER_URL}/api/health`);
  if (!health.ok) throw new Error(String(health.status));
} catch {
  console.error(`Server not reachable at ${SERVER_URL}. Start the stack first: npm run dev`);
  process.exit(2);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const run = Date.now() % 1000000;
const ctx = await browser.newContext({ viewport: { width: 1380, height: 860 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log(`PAGEERROR: ${e.message}`));
const send = (msg) => page.evaluate((m) => window.__bd.client.send(m), msg);

// ---------- NEW PLAYER: tutorial ----------
await page.goto(CLIENT_URL);
await page.waitForSelector('#auth-user', { timeout: 15000 });
await page.fill('#auth-user', `xp_${run}`);
await page.fill('#auth-pass', 'e2e-pass-1234');
await page.click('#auth-go');
await page.waitForFunction(() => window.__bd?.client?.tutorial != null, { timeout: 10000 });
// Mira appears at step 1 for a brand-new player (before any business).
await page.waitForSelector('#mira .mira-name', { timeout: 8000 });
const miraStep0 = await page.evaluate(() => window.__bd.client.tutorial.currentStep);
check('Mira tutorial appears for a new player', miraStep0 === 0, `step=${miraStep0}`);

// Complete the first step by creating a business.
await page.waitForSelector('.choice', { timeout: 8000 });
await page.click('.choice[data-type="bakery"]');
await page.waitForFunction(() => window.__bd.client.company != null, { timeout: 10000 });
await page.waitForFunction(() => (window.__bd.client.tutorial?.completedSteps ?? []).includes(1), { timeout: 8000 });
check('completing the first business step advances the tutorial', true);

// Continue through one more step via Mira.
await page.waitForSelector('#mira #mira-next', { timeout: 8000 });
const before = await page.evaluate(() => window.__bd.client.tutorial.currentStep);
await page.click('#mira #mira-next');
await page.waitForFunction((b) => window.__bd.client.tutorial.currentStep > b, before, { timeout: 8000 });
check('Mira "Continue" advances the tutorial', true);

// ---------- create the conditions for a rich brief, then RETURN ----------
await send({ t: 'dev', cmd: 'make_admin' });         // to publish an announcement later
await send({ t: 'dev', cmd: 'reset_updates' });      // so "What's New" pops on return
await send({ t: 'dev', cmd: 'event_festival', value: 90 }); // an upcoming event for the brief
// Wait until the event is actually scheduled before reloading (avoids a race).
await page.waitForFunction(
  () => (window.__bd.client.cityMarket?.upcoming ?? []).some((e) => e.type === 'city_festival'),
  { timeout: 8000 }
);

// Reload = session return. A fresh bakery has no wheat -> low-stock/sold-out
// alerts, plus the upcoming festival and an opportunity.
await page.reload();
await page.waitForFunction(() => window.__bd?.client?.company != null, { timeout: 15000 });

// Morning Brief + What's New appear as sequential modals (order-independent).
let sawBrief = false, sawWhatsNew = false;
for (let i = 0; i < 2; i++) {
  await page.waitForSelector('.overlay.modal', { timeout: 10000 });
  if (await page.$('#brief-overlay')) {
    const briefText = await page.$eval('#brief-overlay', (el) => el.textContent || '');
    const brief = await page.evaluate(() => window.__bd.client.brief);
    check('Morning Brief appears on return', !!brief);
    check('brief shows the company summary', briefText.includes(`xp_${run}`) || briefText.includes('Co.'));
    check('brief includes an upcoming event', !!brief.upcomingEvent && brief.upcomingEvent.type === 'city_festival');
    check('brief includes at least one alert', brief.alerts.length > 0, `alerts=${brief.alerts.length}`);
    check('brief includes an opportunity', !!brief.opportunity, brief.opportunity?.kind);
    sawBrief = true;
    await page.click('#brief-close');
    await page.waitForFunction(() => !document.getElementById('brief-overlay'), { timeout: 5000 });
  } else if (await page.$('#whatsnew-overlay')) {
    const wn = await page.$eval('#whatsnew-overlay', (el) => el.textContent || '');
    // The newest release note should be what pops (whatever the latest version is).
    const latest = await page.evaluate(() => window.__bd.client.updatesAll[0]?.version);
    check("What's New appears with the latest version", wn.includes(latest), `${latest} · ${wn.slice(0, 40)}`);
    sawWhatsNew = true;
    await page.click('#wn-ok');
    await page.waitForFunction(() => !document.getElementById('whatsnew-overlay'), { timeout: 5000 });
  }
  await sleep(400);
}
check('both the brief and What\'s New were shown', sawBrief && sawWhatsNew, `brief=${sawBrief} wn=${sawWhatsNew}`);

// ---------- admin announcement ----------
await send({
  t: 'create_announcement',
  title: 'City Festival Tomorrow', message: 'Prepare your businesses for high demand.',
  kind: 'event', priority: 'important',
});
await page.waitForFunction(
  () => window.__bd.client.announcementsActive.some((a) => a.title === 'City Festival Tomorrow'),
  { timeout: 8000 }
);
check('admin announcement is published and received', true);
await page.waitForSelector('#announce-banner', { state: 'visible', timeout: 6000 });
const bannerText = await page.$eval('#announce-banner', (el) => el.textContent || '');
check('announcement banner shows the message', /City Festival Tomorrow/.test(bannerText));

// News panel lists it in history.
await page.click('#nav-news');
await page.waitForSelector('.ann-card', { timeout: 6000 });
const annCards = await page.$$eval('.ann-card .ann-title', (els) => els.map((e) => e.textContent).join('|'));
check('News panel shows the announcement history', /City Festival Tomorrow/.test(annCards));

// ---------- camera controls ----------
const yaw0 = await page.evaluate(() => window.__bd.rig.yaw);
await page.mouse.move(700, 430);
await page.mouse.down({ button: 'right' });
await page.mouse.move(900, 430, { steps: 8 });
await page.mouse.up({ button: 'right' });
const yaw1 = await page.evaluate(() => window.__bd.rig.yaw);
check('right-drag rotates the camera', Math.abs(yaw1 - yaw0) > 0.05, `Δyaw=${(yaw1 - yaw0).toFixed(3)}`);

const dist0 = await page.evaluate(() => window.__bd.rig.dist);
await page.mouse.move(700, 430);
await page.mouse.wheel(0, -300);
const dist1 = await page.evaluate(() => window.__bd.rig.dist);
check('mouse wheel zooms the camera', dist1 < dist0, `${dist0.toFixed(1)} -> ${dist1.toFixed(1)}`);

const tgt0 = await page.evaluate(() => ({ x: window.__bd.rig.target.x, z: window.__bd.rig.target.z }));
await page.mouse.move(700, 430);
await page.mouse.down({ button: 'middle' });
await page.mouse.move(560, 520, { steps: 8 });
await page.mouse.up({ button: 'middle' });
const tgt1 = await page.evaluate(() => ({ x: window.__bd.rig.target.x, z: window.__bd.rig.target.z }));
check('middle-drag pans the camera', Math.hypot(tgt1.x - tgt0.x, tgt1.z - tgt0.z) > 0.5,
  `Δ=${Math.hypot(tgt1.x - tgt0.x, tgt1.z - tgt0.z).toFixed(2)}`);

await browser.close();
console.log(failures === 0 ? '\nV2.4 EXPERIENCE: ALL CHECKS PASSED' : `\nV2.4 EXPERIENCE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
