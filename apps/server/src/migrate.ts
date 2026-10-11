// `npm run db:migrate`: apply pending migrations and exit (also done on every startup).

import './env.js';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';

const config = loadConfig();
const db = createPool(config.databaseUrl, 1);
try {
  await migrate(db);
  console.log('database is up to date');
} catch (err) {
  console.error(`migration failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
