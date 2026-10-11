// Service configuration, read from the environment (.env is loaded by index.ts).

import fs from 'node:fs';
import path from 'node:path';

export interface Config {
  host: string;
  port: number;
  databaseUrl: string;
  dbPoolMax: number;
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
  };
  language: string;
  currency: string;
  market: string;
  reverseGeocode: boolean;
  apiKey: string; // ITEMDEX_API_KEY: protects /api when the service is exposed
  corsOrigins: string[];
  publicUrl: string; // absolute base for image URLs; derived from the request when empty
  bodyLimitMb: number;
  webDist: string | null; // built web app to serve, null = API only
  openapiFile: string | null; // enables /api/docs when set
  logLevel: string;
}

// Walks up from `start` looking for `rel`; returns the first existing path.
export function findUp(rel: string, start = process.cwd(), levels = 3): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i <= levels; i++) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) return p;
    dir = path.dirname(dir);
  }
  return null;
}

const bool = (v: string | undefined, fallback: boolean) =>
  v == null || v === '' ? fallback : !['false', '0', 'no', 'off'].includes(v.toLowerCase());

export function loadConfig(overrides: Partial<Config> = {}, env = process.env): Config {
  const serveUi = bool(env.SERVE_UI, true);
  const webDist = env.WEB_DIST || findUp('apps/web/dist/index.html')?.replace(/index\.html$/, '') || null;
  return {
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT) || 7777,
    databaseUrl: env.DATABASE_URL || '',
    dbPoolMax: Number(env.DB_POOL_MAX) || 10,
    llm: {
      baseUrl: env.LLM_API_BASE || '',
      apiKey: env.LLM_API_KEY || '',
      model: env.LLM_MODEL || '',
      timeoutMs: Number(env.LLM_TIMEOUT_MS) || 120_000,
    },
    language: env.CARD_LANGUAGE || 'Indonesian',
    currency: env.CURRENCY || 'IDR',
    market: env.MARKET || 'Indonesian',
    reverseGeocode: bool(env.REVERSE_GEOCODE, true),
    apiKey: env.ITEMDEX_API_KEY || '',
    corsOrigins: (env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    bodyLimitMb: Number(env.BODY_LIMIT_MB) || 40,
    webDist: serveUi ? webDist : null,
    openapiFile: bool(env.API_DOCS, true) ? env.OPENAPI_FILE || findUp('docs/openapi.yaml') : null,
    logLevel: env.LOG_LEVEL || 'info',
    ...overrides,
  };
}
