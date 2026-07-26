// V2.8.2 RELEASE GATE — admin live player presence.
// Presence is PLAYER-based (not socket-based) and server-authoritative: it is
// derived only from the live WebSocket connection count the World tracks via
// connect()/disconnect(). These tests pin the multi-connection, last-seen,
// force-logout, suspend, hard-delete and restart semantics.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld } from './helpers.js';
import { closeDb, query } from '../src/db.js';
import { GameError, type World } from '../src/game/world.js';

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

const isOnline = (w: World, pid: number) => (w.players.get(pid)?.connections ?? 0) > 0;

describe('presence lifecycle (player-based, server-authoritative)', () => {
  it('connect → online; disconnect → offline with last_seen recorded', async () => {
    const pid = await newPlayer(world, 'alice');
    expect(isOnline(world, pid)).toBe(false);
    world.connect(pid);
    expect(isOnline(world, pid)).toBe(true);
    expect(world.onlineCount()).toBe(1);
    const before = world.players.get(pid)!.lastSeenMs;
    world.disconnect(pid);
    expect(isOnline(world, pid)).toBe(false);
    expect(world.onlineCount()).toBe(0);
    // last_seen advanced to the disconnect moment and the session ended.
    expect(world.players.get(pid)!.lastSeenMs).toBeGreaterThanOrEqual(before);
    expect(world.players.get(pid)!.sessionStartMs).toBeNull();
  });

  it('reconnect → online again', async () => {
    const pid = await newPlayer(world, 'bob');
    world.connect(pid);
    world.disconnect(pid);
    expect(isOnline(world, pid)).toBe(false);
    world.connect(pid);
    expect(isOnline(world, pid)).toBe(true);
  });

  it('two connections keep the player online until the FINAL one closes', async () => {
    const pid = await newPlayer(world, 'multi');
    world.connect(pid); // desktop
    world.connect(pid); // mobile
    expect(world.players.get(pid)!.connections).toBe(2);
    expect(isOnline(world, pid)).toBe(true);
    world.disconnect(pid); // desktop closes
    expect(world.players.get(pid)!.connections).toBe(1);
    expect(isOnline(world, pid)).toBe(true); // still online (mobile)
    world.disconnect(pid); // mobile closes
    expect(world.players.get(pid)!.connections).toBe(0);
    expect(isOnline(world, pid)).toBe(false); // ONLY now offline
  });

  it('the session starts on the first connection and survives added connections', async () => {
    const pid = await newPlayer(world, 'sess');
    world.connect(pid);
    const started = world.players.get(pid)!.sessionStartMs;
    expect(started).not.toBeNull();
    world.connect(pid); // second device — same session
    expect(world.players.get(pid)!.sessionStartMs).toBe(started);
    world.disconnect(pid);
    expect(world.players.get(pid)!.sessionStartMs).toBe(started); // still online
    world.disconnect(pid);
    expect(world.players.get(pid)!.sessionStartMs).toBeNull(); // ended
  });

  it('online count is correct across many players', async () => {
    const a = await newPlayer(world, 'p1');
    const b = await newPlayer(world, 'p2');
    const c = await newPlayer(world, 'p3');
    world.connect(a); world.connect(b);
    expect(world.onlineCount()).toBe(2);
    world.connect(c); world.disconnect(a);
    expect(world.onlineCount()).toBe(2);
    void b;
  });

  it('no ghost-online survives a world restart (connections reset to 0)', async () => {
    const pid = await newPlayer(world, 'ghost');
    world.connect(pid);
    expect(isOnline(world, pid)).toBe(true);
    // A fresh load models a server restart: nobody has a live socket.
    const world2 = await loadedWorld();
    expect(isOnline(world2, pid)).toBe(false);
    expect(world2.onlineCount()).toBe(0);
  });
});

describe('presence integrates with force-logout / suspend / hard-delete', () => {
  it('force logout drops presence once the socket closes', async () => {
    const a = await admin(world);
    const pid = await newPlayer(world, 'kicked');
    world.connect(pid);
    await query('INSERT INTO sessions (token, player_id) VALUES ($1,$2)', ['tok_fl', pid]);
    await world.adminForceLogout(a, pid, 'kick'); // invalidates sessions + signals net to close sockets
    // The net layer closes each socket; model that terminal close here.
    world.disconnect(pid);
    expect(isOnline(world, pid)).toBe(false);
    const s = await query('SELECT count(*)::int c FROM sessions WHERE player_id=$1', [pid]);
    expect(s.rows[0].c).toBe(0);
  });

  it('suspending an online player forces them offline (but suspended != offline state)', async () => {
    const a = await admin(world);
    const pid = await newPlayer(world, 'suspendme');
    world.connect(pid);
    await world.adminSuspend(a, pid, true, 'abuse'); // emits force_logout -> socket closes
    world.disconnect(pid);
    expect(isOnline(world, pid)).toBe(false);
    expect(world.isSuspended(pid)).toBe(true); // independent axis
    // Offline + suspended is a valid combined state.
  });

  it('hard delete removes the player from the presence set entirely', async () => {
    const a = await admin(world);
    const pid = await newPlayer(world, 'erased');
    world.connect(pid);
    expect(world.onlineCount()).toBe(1);
    await world.adminHardDeletePlayer(a, pid, 'erased');
    expect(world.players.has(pid)).toBe(false);
    expect(world.onlineCount()).toBe(0);
    expect(world.presenceSnapshot().some((r) => r.id === pid)).toBe(false);
  });
});

describe('presence snapshot + admin list filters', () => {
  it('presenceSnapshot reflects live connection counts', async () => {
    const a = await newPlayer(world, 's1');
    const b = await newPlayer(world, 's2');
    world.connect(a); world.connect(a); // two devices
    const snap = world.presenceSnapshot();
    const ra = snap.find((r) => r.id === a)!;
    const rb = snap.find((r) => r.id === b)!;
    expect(ra.online).toBe(true);
    expect(ra.connections).toBe(2);
    expect(rb.online).toBe(false);
    expect(rb.connections).toBe(0);
  });

  it('admin player list filters by All / Online / Offline / Suspended, online sorted first', async () => {
    const a = await admin(world);
    const on = await newPlayer(world, 'online_guy');
    const off = await newPlayer(world, 'offline_guy');
    const susp = await newPlayer(world, 'suspended_guy');
    world.connect(on);
    await world.adminSuspend(a, susp, true, 'x');

    const all = await world.adminSearchPlayers(a, '', 'all');
    expect(all.length).toBeGreaterThanOrEqual(4);
    // Online players come first in the default ordering.
    expect(all[0].online).toBe(true);

    const online = await world.adminSearchPlayers(a, '', 'online');
    expect(online.every((r) => r.online)).toBe(true);
    expect(online.some((r) => r.id === on)).toBe(true);
    expect(online.some((r) => r.id === off)).toBe(false);

    const offline = await world.adminSearchPlayers(a, '', 'offline');
    expect(offline.every((r) => !r.online)).toBe(true);
    expect(offline.some((r) => r.id === off)).toBe(true);

    const suspended = await world.adminSearchPlayers(a, '', 'suspended');
    expect(suspended.every((r) => r.suspended)).toBe(true);
    expect(suspended.some((r) => r.id === susp)).toBe(true);
  });

  it('admin player detail exposes connection count, last-seen and session start', async () => {
    const a = await admin(world);
    const pid = await newPlayer(world, 'detailed');
    world.connect(pid);
    const d = await world.adminPlayerDetail(a, pid);
    expect(d.online).toBe(true);
    expect(d.connections).toBe(1);
    expect(d.sessionStartedMs).not.toBeNull();
    expect(d.lastSeenMs).toBeGreaterThan(0);
  });

  it('normal players cannot request admin presence data', async () => {
    const nobody = await newPlayer(world, 'nobody');
    await expect(world.adminSearchPlayers(nobody, '', 'online')).rejects.toBeInstanceOf(GameError);
    await expect(world.adminPlayerDetail(nobody, nobody)).rejects.toBeInstanceOf(GameError);
    // presenceSnapshot() is not exposed to normal players — it is only fanned out
    // to admin sockets by the net layer (privacy: never sent to players).
  });
});

describe('admin can SET customer satisfaction with a required reason (audited)', () => {
  it('clamps 0–100, persists, and writes a SET_SATISFACTION audit entry', async () => {
    const a = await admin(world);
    const pid = await newPlayer(world, 'shopowner');
    const biz = await world.chooseBusiness(pid, 'coffee_shop');
    await world.adminSetSatisfaction(a, biz.id, 42, 'manual recovery');
    expect(world.businesses.get(biz.id)!.satisfaction).toBe(42);
    await world.adminSetSatisfaction(a, biz.id, 999, 'clamp test'); // clamps at 100
    expect(world.businesses.get(biz.id)!.satisfaction).toBe(100);
    const row = await query('SELECT customer_satisfaction FROM businesses WHERE id=$1', [biz.id]);
    expect(Number(row.rows[0].customer_satisfaction)).toBe(100);
    const audit = await world.adminRecentAudit(a, 20);
    const entry = audit.find((e) => e.action === 'SET_SATISFACTION');
    expect(entry).toBeDefined();
    expect(entry!.detail?.reason).toBe('clamp test');
    // Non-admin rejected.
    const nobody = await newPlayer(world, 'nobody2');
    await expect(world.adminSetSatisfaction(nobody, biz.id, 50, 'x')).rejects.toBeInstanceOf(GameError);
  });
});
