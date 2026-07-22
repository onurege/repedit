import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { migrate } from './db.js';
import { registerAuthRoutes } from './auth.js';
import { World } from './game/world.js';
import { Net } from './net.js';

async function main() {
  await migrate();

  const app = express();
  app.use(cors());
  app.use(express.json());
  registerAuthRoutes(app);
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

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
