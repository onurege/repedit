import { migrate, closeDb } from './db.js';

migrate()
  .then(() => {
    console.log('[db] migrations up to date');
    return closeDb();
  })
  .catch((err) => {
    console.error('[db] migration failed', err);
    process.exit(1);
  });
