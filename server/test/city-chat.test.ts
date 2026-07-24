// V2.7 Phase 1 — City Chat, moderation, and admin audit log.
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

async function makeAdmin(w: World, pid: number): Promise<void> {
  w.players.get(pid)!.isAdmin = true;
  await query('UPDATE players SET is_admin=true WHERE id=$1', [pid]);
}

describe('city chat', () => {
  it('sends a message and returns it publicly (no private data)', async () => {
    const pid = await newPlayer(world, 'chatter');
    await world.chooseBusiness(pid, 'farm');
    const msg = await world.sendChat(pid, 'Anyone selling Wheat?');
    expect(msg.body).toBe('Anyone selling Wheat?');
    expect(msg.authorName).toBe('chatter');
    expect(msg.kind).toBe('user');
    const serialized = JSON.stringify(msg);
    expect(serialized).not.toContain('cash');
    expect(world.recentChat().at(-1)!.id).toBe(msg.id);
  });

  it('escapes markup and masks profanity, rejects empty', async () => {
    // Rate limiting is per-player, so use a fresh player per successful send.
    const a = await newPlayer(world, 'xss');
    const msg = await world.sendChat(a, '  <script>alert(1)</script>  hello  ');
    expect(msg.body).not.toContain('<');
    expect(msg.body).not.toContain('>');
    expect(msg.body).toContain('hello');
    const b = await newPlayer(world, 'potty');
    const masked = await world.sendChat(b, 'this is shit');
    expect(masked.body).toContain('****');
    const c = await newPlayer(world, 'empty');
    await expect(world.sendChat(c, '   ')).rejects.toBeInstanceOf(GameError);
    await expect(world.sendChat(c, '<>')).rejects.toBeInstanceOf(GameError);
  });

  it('rate-limits rapid messages', async () => {
    const pid = await newPlayer(world, 'spammer');
    // The min-gap guard blocks a burst; second immediate message is rejected.
    await world.sendChat(pid, 'one');
    await expect(world.sendChat(pid, 'two')).rejects.toBeInstanceOf(GameError);
  });

  it('caps message length', async () => {
    const pid = await newPlayer(world, 'verbose');
    const long = 'a'.repeat(1000);
    const msg = await world.sendChat(pid, long);
    expect(msg.body.length).toBeLessThanOrEqual(280);
  });

  it('a muted player cannot send', async () => {
    const admin = await newPlayer(world, 'admin1');
    await makeAdmin(world, admin);
    const target = await newPlayer(world, 'loudmouth');
    await world.adminMute(admin, target, 60, 'spamming');
    expect(world.isMuted(target)).toBe(true);
    await expect(world.sendChat(target, 'hi')).rejects.toBeInstanceOf(GameError);
    // Unmute restores sending.
    await world.adminUnmute(admin, target);
    expect(world.isMuted(target)).toBe(false);
    const ok = await world.sendChat(target, 'sorry');
    expect(ok.body).toBe('sorry');
  });

  it('expired mutes clear automatically', async () => {
    const admin = await newPlayer(world, 'admin2');
    await makeAdmin(world, admin);
    const target = await newPlayer(world, 'temp');
    await world.adminMute(admin, target, 60, null as unknown as string);
    // Force the mute into the past.
    (world as unknown as { chatMutes: Map<number, { until: number | null }> }).chatMutes.get(target)!.until = Date.now() - 1;
    expect(world.isMuted(target)).toBe(false);
  });

  it('admin can delete a message; non-admin cannot', async () => {
    const admin = await newPlayer(world, 'mod');
    await makeAdmin(world, admin);
    const pid = await newPlayer(world, 'poster');
    const msg = await world.sendChat(pid, 'delete me');
    // Non-admin delete is rejected.
    await expect(world.adminDeleteChat(pid, msg.id)).rejects.toBeInstanceOf(GameError);
    expect(world.recentChat().some((m) => m.id === msg.id)).toBe(true);
    // Admin delete removes it from the live buffer and marks it deleted.
    await world.adminDeleteChat(admin, msg.id);
    expect(world.recentChat().some((m) => m.id === msg.id)).toBe(false);
    const row = await query('SELECT deleted FROM city_chat_messages WHERE id=$1', [msg.id]);
    expect(row.rows[0].deleted).toBe(true);
  });

  it('reports dedupe per (message, reporter)', async () => {
    const pid = await newPlayer(world, 'reporter');
    const other = await newPlayer(world, 'offender');
    const msg = await world.sendChat(other, 'buy my stuff');
    await world.reportChat(pid, msg.id, 'spam', 'obvious spam');
    await world.reportChat(pid, msg.id, 'spam'); // duplicate ignored
    const n = await query('SELECT count(*)::int AS c FROM chat_reports WHERE message_id=$1', [msg.id]);
    expect(n.rows[0].c).toBe(1);
    await expect(world.reportChat(pid, msg.id, 'bogus' as never)).rejects.toBeInstanceOf(GameError);
  });

  it('records admin actions in the append-only audit log', async () => {
    const admin = await newPlayer(world, 'auditor');
    await makeAdmin(world, admin);
    const target = await newPlayer(world, 'subject');
    const msg = await world.sendChat(target, 'hello world');
    await world.adminDeleteChat(admin, msg.id);
    await world.adminMute(admin, target, 30, 'test');
    const rows = await query(
      `SELECT action, admin_id, target_type, target_id FROM admin_audit_log WHERE admin_id=$1 ORDER BY id`,
      [admin]
    );
    const actions = rows.rows.map((r) => r.action);
    expect(actions).toContain('DELETE_CHAT_MESSAGE');
    expect(actions).toContain('MUTE_PLAYER');
    // No secrets ever recorded.
    const dump = JSON.stringify(rows.rows);
    expect(dump).not.toContain('pass');
    expect(dump).not.toContain('token');
  });

  it('recent history survives a restart', async () => {
    const pid = await newPlayer(world, 'historian');
    await world.sendChat(pid, 'persist me');
    const world2 = await loadedWorld();
    expect(world2.recentChat().some((m) => m.body === 'persist me')).toBe(true);
  });

  it('an active mute survives a restart', async () => {
    const admin = await newPlayer(world, 'admin3');
    await makeAdmin(world, admin);
    const target = await newPlayer(world, 'muted');
    await world.adminMute(admin, target, 120, 'restart test');
    const world2 = await loadedWorld();
    expect(world2.isMuted(target)).toBe(true);
  });
});
