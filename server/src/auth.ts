import crypto from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { query } from './db.js';
import { STARTING_CASH } from '@district/shared';

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
}

async function createSession(playerId: number): Promise<string> {
  const token = crypto.randomBytes(24).toString('hex');
  await query('INSERT INTO sessions (token, player_id) VALUES ($1, $2)', [token, playerId]);
  return token;
}

export async function playerIdForToken(token: string): Promise<number | null> {
  const res = await query('SELECT player_id FROM sessions WHERE token = $1', [token]);
  return res.rowCount ? res.rows[0].player_id : null;
}

function validUsername(name: unknown): name is string {
  return typeof name === 'string' && /^[a-zA-Z0-9_-]{3,20}$/.test(name);
}

export function registerAuthRoutes(app: Express): void {
  app.post('/api/register', async (req: Request, res: Response) => {
    try {
      const { username, password } = req.body ?? {};
      if (!validUsername(username)) {
        return res.status(400).json({ error: 'Username must be 3-20 chars (letters, digits, _ or -).' });
      }
      if (typeof password !== 'string' || password.length < 4) {
        return res.status(400).json({ error: 'Password must be at least 4 characters.' });
      }
      const existing = await query('SELECT 1 FROM players WHERE lower(username) = lower($1)', [username]);
      if (existing.rowCount) {
        return res.status(409).json({ error: 'Username already taken.' });
      }
      const ins = await query(
        'INSERT INTO players (username, pass_hash, cash) VALUES ($1, $2, $3) RETURNING id, username',
        [username, hashPassword(password), STARTING_CASH]
      );
      const player = ins.rows[0];
      const token = await createSession(player.id);
      res.json({ token, playerId: player.id, username: player.username });
    } catch (err) {
      console.error('[auth] register failed', err);
      res.status(500).json({ error: 'Registration failed.' });
    }
  });

  app.post('/api/login', async (req: Request, res: Response) => {
    try {
      const { username, password } = req.body ?? {};
      if (typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'Missing credentials.' });
      }
      const found = await query(
        'SELECT id, username, pass_hash FROM players WHERE lower(username) = lower($1)',
        [username]
      );
      if (!found.rowCount || !verifyPassword(password, found.rows[0].pass_hash)) {
        return res.status(401).json({ error: 'Invalid username or password.' });
      }
      const player = found.rows[0];
      const token = await createSession(player.id);
      res.json({ token, playerId: player.id, username: player.username });
    } catch (err) {
      console.error('[auth] login failed', err);
      res.status(500).json({ error: 'Login failed.' });
    }
  });
}
