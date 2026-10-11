// Standalone service: `npm run dev` / `npm start` (from the repo root or apps/server).

import './env.js';
import { loadConfig, startServer } from './app.js';

const config = loadConfig();

try {
  const { url, app } = await startServer(config);
  app.log.info(`ITEMDEX service at ${url}  (API docs: ${url}/api/docs)`);
  if (config.webDist) app.log.info(`serving web app from ${config.webDist}`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host) && !config.apiKey) {
    app.log.warn('service is reachable from the network without ITEMDEX_API_KEY');
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => { app.close().finally(() => process.exit(0)); });
  }
} catch (err) {
  const e = err as Error & { code?: string };
  console.error(`ITEMDEX failed to start: ${e.code ? `${e.code} ` : ''}${e.message}`);
  if (!config.databaseUrl) console.error('Hint: set DATABASE_URL in .env (see .env.example).');
  process.exit(1);
}
