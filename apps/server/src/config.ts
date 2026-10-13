// Service configuration, read from the environment (.env is loaded by index.ts).

import fs from 'node:fs';
import path from 'node:path';
import type { ShopeeConfig } from './comps.js';

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
  search: {
    url: string; // SearXNG base URL; empty = price check disabled
    autostart: boolean; // start tools/searxng with the service when url is local
    timeoutMs: number;
    language: string;
  };
  apiKey: string; // ITEMDEX_API_KEY: protects /api when the service is exposed
  shopee: ShopeeConfig; // marketplace price check
  accounts: boolean; // ACCOUNTS=true: email/password sign-in + shared households (replaces apiKey)
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
    search: {
      url: (env.SEARCH_URL || '').replace(/\/+$/, ''),
      autostart: bool(env.SEARCH_AUTOSTART, true),
      timeoutMs: Number(env.SEARCH_TIMEOUT_MS) || 10_000,
      language: env.SEARCH_LANGUAGE || 'id-ID',
    },
    apiKey: env.ITEMDEX_API_KEY || '',
    shopee: {
      state: path.resolve(env.SHOPEE_STATE || '.itemdex/shopee-state.json'),
      discount: Number(env.COMPS_DISCOUNT) || 0.9,
      canLogin: ['127.0.0.1', 'localhost', '::1'].includes(env.HOST || '127.0.0.1'),
    },
    accounts: bool(env.ACCOUNTS, false),
    corsOrigins: (env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    bodyLimitMb: Number(env.BODY_LIMIT_MB) || 40,
    webDist: serveUi ? webDist : null,
    openapiFile: bool(env.API_DOCS, true) ? env.OPENAPI_FILE || findUp('docs/openapi.yaml') : null,
    logLevel: env.LOG_LEVEL || 'info',
    ...overrides,
  };
}
