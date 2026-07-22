import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { config, warnInsecureDefaults } from './config.js';
import { migrate, query } from './db.js';
import { registerAuthRoutes } from './auth.js';
import { World } from './game/world.js';
import { Net } from './net.js';

async function main() {
  warnInsecureDefaults();
  await migrate();

  const app = express();
  app.disable('x-powered-by');
  app.use(cors(config.corsOrigins.length ? { origin: config.corsOrigins } : undefined));
  app.use(express.json());
  registerAuthRoutes(app);

  // Lightweight health check for deployment monitoring: reports whether the
  // server is up and the database is reachable. Exposes no sensitive data.
  app.get('/api/health', async (_req, res) => {
    try {
      await query('SELECT 1');
      res.json({ ok: true, db: true });
    } catch {
      res.status(503).json({ ok: false, db: false });
    }
  });

  const world = new World();
  await world.load();
  world.start();

  const server = http.createServer(app);
  new Net(world, server);

  server.listen(config.port, () => {
    console.log(`[server] BUSINESS DISTRICT listening on :${config.port}`);
    console.log(`[server] dev tools ${config.devTools ? 'ENABLED' : 'disabled'}`);
  });

  const shutdown = async () => {
    console.log('[server] shutting down, flushing state...');
    world.stop();
    try {
      await world.flush();
    } catch (err) {
      console.error('[server] final flush failed', err);
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[server] fatal', err);
  process.exit(1);
});
