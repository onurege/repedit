// BUSINESS DISTRICT — V2.7 Phase 1 City Chat E2E.
//
// Prereqs: dev stack running with dev tools (npm run dev). Run: npm run e2e:chat
//
// Two players exchange real-time City Chat through the browser; an admin
// deletes a message and mutes a player; the muted player can no longer send.
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
  return page;
}
const send = (p, m) => p.evaluate((x) => window.__bd.client.send(x), m);
const chatBodies = (p) => p.evaluate(() => window.__bd.client.chat.map((m) => m.body));

const WHEAT = `Anyone selling Wheat? #${run}`;
const A = await player(`chA_${run}`, 'farm');
const B = await player(`chB_${run}`, 'bakery');

// A sends a message; B receives it in realtime.
await send(A, { t: 'chat_send', body: WHEAT });
await B.waitForFunction((w) => window.__bd.client.chat.some((m) => m.body === w), WHEAT, { timeout: 8000 });
check('B receives A\'s message in realtime', (await chatBodies(B)).includes(WHEAT));

// B replies; A receives it.
await send(B, { t: 'chat_send', body: 'I have 400 in Green Valley' });
await A.waitForFunction(() => window.__bd.client.chat.some((m) => m.body === 'I have 400 in Green Valley'), null, { timeout: 8000 });
check('A receives B\'s reply in realtime', (await chatBodies(A)).includes('I have 400 in Green Valley'));

// Markup is sanitised on the server. (space out same-player sends past the rate gap)
await A.waitForTimeout(1100);
await send(A, { t: 'chat_send', body: '<b>hax</b> deal now' });
await B.waitForFunction(() => window.__bd.client.chat.some((m) => m.body.includes('deal now')), null, { timeout: 8000 });
const sanitized = (await chatBodies(B)).find((b) => b.includes('deal now'));
check('markup is stripped server-side', sanitized && !sanitized.includes('<'), JSON.stringify(sanitized));

// A non-admin cannot moderate: canModerate is false and no delete affordance.
check('normal player cannot moderate', (await A.evaluate(() => window.__bd.client.canModerate)) === false);

// Promote B to admin (dev), then B deletes A's first message.
await send(B, { t: 'dev', cmd: 'make_admin' });
await B.waitForFunction(() => window.__bd.client.you?.isAdmin === true, null, { timeout: 8000 });
await send(B, { t: 'get_chat' }); // refresh canModerate
await B.waitForFunction(() => window.__bd.client.canModerate === true, null, { timeout: 8000 });
const delId = await B.evaluate((w) => window.__bd.client.chat.find((m) => m.body === w).id, WHEAT);
await send(B, { t: 'admin_delete_chat', messageId: delId });
await A.waitForFunction((id) => !window.__bd.client.chat.some((m) => m.id === id), delId, { timeout: 8000 });
check('admin delete removes the message for everyone', !(await chatBodies(A)).includes(WHEAT));

// Admin mutes A; A can no longer send.
const aId = await B.evaluate((n) => window.__bd.client.players.find((x) => x.name === n)?.id, `chA_${run}`);
await send(B, { t: 'admin_mute', playerId: aId, minutes: 60, reason: 'test' });
await A.waitForFunction(() => window.__bd.client.chatMuted === true, null, { timeout: 8000 });
check('muted player is notified', await A.evaluate(() => window.__bd.client.chatMuted));
const beforeCount = (await chatBodies(B)).length;
await A.waitForTimeout(1100);
await send(A, { t: 'chat_send', body: 'still here?' });
await A.waitForTimeout(1000);
check('muted player message is rejected (not broadcast)', (await chatBodies(B)).length === beforeCount);

// Unmute restores sending.
await send(B, { t: 'admin_unmute', playerId: aId });
await A.waitForFunction(() => window.__bd.client.chatMuted === false, null, { timeout: 8000 });
await A.waitForTimeout(1100);
await send(A, { t: 'chat_send', body: 'thanks, back now' });
await B.waitForFunction(() => window.__bd.client.chat.some((m) => m.body === 'thanks, back now'), null, { timeout: 8000 });
check('unmuted player can send again', (await chatBodies(B)).includes('thanks, back now'));

await browser.close();
console.log(failures ? `\nV2.7 CHAT: ${failures} CHECK(S) FAILED` : '\nV2.7 CHAT: ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
