// ITEMDEX service: REST API (/api/v1) + optional static web app.
// Runs standalone (src/index.ts) or embedded in the desktop app (apps/desktop).
// API reference: docs/API.md, docs/openapi.yaml, live Swagger at /api/docs.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import {
  CONDITIONS, FLAGS, PLATFORMS, RARITIES, SIZE_CLASSES, SORTS, SOURCES, TYPES,
  mergeCard, normalizeCard, type AiConfig, type AiTest, type AskFilters, type AuthUser, type Flag, type Locale, type Platform,
  type Purchase, type Sort, type Source,
} from '@itemdex/shared';
import { Accounts, AuthError } from './auth.js';
import { connected, disconnect, fetchComps, loginStatus, startLogin } from './comps.js';
import type { Config } from './config.js';
import { createPool, migrate, type Db } from './db.js';
import { LlmClient, LlmError, cleanBaseUrl } from './llm.js';
import { cleanLocation, reverseGeocode } from './geo.js';
import { toCsv, toHtml } from './report.js';
import { Settings } from './settings.js';
import { DEFAULT_HOUSEHOLD, ItemsRepo, type ImageBlob } from './repo.js';

export { loadConfig, type Config } from './config.js';

export const VERSION = '2.0.0';
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cleanText = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const csv = (v: unknown) => cleanText(v, 200).toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);

declare module 'fastify' {
  interface FastifyRequest {
    hid: string; // household whose collection this request works on
    user: AuthUser | null;
  }
}

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
const bad = (message: string) => new HttpError(400, 'bad_request', message);
const notFound = () => new HttpError(404, 'not_found', 'Item not found');

function validImages(list: unknown): string[] {
  return (Array.isArray(list) ? list : [])
    .filter((u): u is string => typeof u === 'string' && /^data:image\/(png|jpe?g|webp);base64,/.test(u))
    .slice(0, MAX_IMAGES);
}

const iso = (v: unknown): string | null => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
};
const wholeNumber = (v: unknown, max: number) => Math.min(max, Math.max(0, Math.round(Number(v) || 0)));
const currencyOf = (v: unknown) => (typeof v === 'string' && /^[A-Z]{3}$/.test(v) ? v : '');

function decodeImage(dataUrl: unknown): ImageBlob | null {
  if (typeof dataUrl !== 'string') return null;
  const m = /^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/s.exec(dataUrl);
  if (!m) return null;
  const data = Buffer.from(m[2], 'base64');
  if (!data.length || data.length > MAX_IMAGE_BYTES) return null;
  return { mime: m[1] === 'image/jpg' ? 'image/jpeg' : m[1], data };
}

export interface ServerHandle {
  app: FastifyInstance;
  db: Db;
  url: string;
  close: () => Promise<void>;
}

export async function buildApp(config: Config, db = createPool(config.databaseUrl, config.dbPoolMax)) {
  const llm = new LlmClient({ ...config.llm, language: config.language, currency: config.currency, market: config.market });
  const repo = new ItemsRepo(db, config.currency);
  const accounts = config.accounts ? new Accounts(db) : null;
  const settings = new Settings(db);
  let aiSource: AiConfig['source'] = llm.configured ? 'env' : 'none';

  // Per-request language / currency / market, falling back to the service defaults.
  const localeOf = (v: unknown): Locale => {
    const l = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    return {
      language: cleanText(l.language, 30) || config.language,
      currency: currencyOf(l.currency) || config.currency,
      market: cleanText(l.market, 30) || config.market,
    };
  };

  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: config.bodyLimitMb * 1024 * 1024,
    trustProxy: true, // correct protocol/host for image URLs behind proxies/tunnels
    logController: new LogController({ disableRequestLogging: true }), // /detect fires every ~0.6s
  });
  app.addHook('onClose', async () => { await db.end(); });
  app.addHook('onReady', async () => {
    const saved = await settings.ai().catch(() => null);
    if (saved) {
      llm.configure({ baseUrl: saved.base_url, apiKey: saved.api_key, model: saved.model });
      aiSource = 'app';
    }
  });
  app.decorateRequest('hid', DEFAULT_HOUSEHOLD);
  app.decorateRequest('user', null);

  const urlFor = (req: FastifyRequest) => {
    const base = config.publicUrl || `${req.protocol}://${req.host}`;
    return (p: string) => `${base}${p}`;
  };

  if (config.corsOrigins.length) {
    await app.register(cors, {
      origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
      maxAge: 600,
    });
  }

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, code: err.code });
    if (err instanceof AuthError) return reply.status(err.status).send({ error: err.message, code: 'auth_error' });
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return reply.status(504).send({ error: 'The AI took too long to respond. Try again.', code: 'llm_timeout' });
    }
    if (err instanceof LlmError) {
      req.log.warn(`llm: ${err.message}`);
      const down = (err as LlmError).status === 503;
      return reply.status(down ? 503 : 502).send({ error: err.message, code: down ? 'llm_unavailable' : 'llm_error' });
    }
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.status(413).send({ error: `Body exceeds ${config.bodyLimitMb}MB`, code: 'payload_too_large' });
    }
    if (err.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || err.statusCode === 400) {
      return reply.status(400).send({ error: 'Body is not valid JSON', code: 'bad_request' });
    }
    if (['ECONNREFUSED', 'ENOTFOUND', '57P01', '3D000', '28P01'].includes(err.code ?? '')) {
      req.log.error(`database: ${err.code} ${err.message}`);
      return reply.status(503).send({ error: 'Database unavailable', code: 'db_unavailable' });
    }
    req.log.error(err);
    return reply.status(500).send({ error: 'Internal server error', code: 'internal' });
  });

  // ------------------------------------------------------------- API
  const api = async (r: FastifyInstance) => {
    r.get('/health', async () => {
      const [ai, items] = await Promise.all([
        llm.ping(),
        repo.count().catch(() => null),
      ]);
      return { ok: items !== null, version: VERSION, llm: ai, db: items !== null, model: llm.model, items: items ?? 0 };
    });

    r.get('/meta', async () => ({
      version: VERSION,
      model: llm.model,
      currency: config.currency,
      language: config.language,
      market: config.market,
      auth_required: !!config.apiKey || config.accounts,
      accounts: config.accounts,
      enums: { type: TYPES, rarity: RARITIES, condition: CONDITIONS, size_class: SIZE_CLASSES, source: SOURCES, sort: SORTS },
      limits: {
        max_images_per_scan: MAX_IMAGES,
        max_body_mb: config.bodyLimitMb,
        recommended_scan_image_side_px: 1024,
        recommended_detect_image_side_px: 512,
        thumb_side_px: 360,
      },
    }));

    const bearer = (req: FastifyRequest) =>
      String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.headers['x-api-key'] || '');

    if (accounts) {
      const creds = (req: FastifyRequest) => {
        const b = (req.body || {}) as Record<string, unknown>;
        return { email: cleanText(b.email, 120), password: typeof b.password === 'string' ? b.password.slice(0, 200) : '', b };
      };
      // ponytail: no login rate limit; add @fastify/rate-limit before exposing this publicly.
      r.post('/auth/register', async (req, reply) => {
        const { email, password, b } = creds(req);
        return reply.status(201).send(await accounts.register(email, password, cleanText(b.name, 60), cleanText(b.invite_code, 40)));
      });
      r.post('/auth/login', async (req) => {
        const { email, password } = creds(req);
        return accounts.login(email, password);
      });
    }

    await r.register(async (p) => {
      p.addHook('onRequest', async (req, reply) => {
        if (accounts) {
          const who = await accounts.resolve(bearer(req));
          if (!who) return reply.status(401).send({ error: 'Sign in required', code: 'unauthorized' });
          req.hid = who.householdId;
          req.user = who.user;
        } else if (config.apiKey) {
          const expected = Buffer.from(config.apiKey);
          const given = Buffer.from(bearer(req));
          if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
            return reply.status(401).send({ error: 'Missing or invalid API key', code: 'unauthorized' });
          }
        }
      });

      if (accounts) {
        p.get('/auth/me', async (req) => ({ user: req.user, household: await accounts.household(req.hid) }));
        p.post('/auth/logout', async (req) => {
          await accounts.logout(bearer(req));
          return { ok: true };
        });
      }

      // Live viewfinder: where is the item in this frame?
      p.post('/detect', async (req) => {
        const [image] = validImages([(req.body as { image?: unknown })?.image]);
        if (!image) throw bad('"image" must be a data:image/... URL');
        const started = Date.now();
        const raw = await llm.detect(image);
        const b = Array.isArray(raw.box) && raw.box.length === 4
          ? raw.box.map((n: unknown) => Math.min(1000, Math.max(0, Math.round(Number(n) || 0))))
          : null;
        const box = b && b[2] - b[0] > 10 && b[3] - b[1] > 10 ? b : null;
        return { has_item: raw.has_item === true && !!box, name: cleanText(raw.name, 40), box, elapsed_ms: Date.now() - started };
      });

      // Analyze images -> card preview (NOT saved; POST /items to save).
      p.post('/scan', async (req) => {
        const body = (req.body || {}) as { images?: unknown; hint?: unknown; source?: unknown; locale?: unknown };
        const images = validImages(body.images);
        if (!images.length) throw bad(`"images" must contain 1-${MAX_IMAGES} data:image/... URLs`);
        const locale = localeOf(body.locale);
        const started = Date.now();
        const raw = await llm.analyze(images, { hint: cleanText(body.hint, 300), isVideo: body.source === 'video', locale });
        const bestFrame = Math.min(images.length - 1, Math.max(0, Number(raw.best_frame) || 0));
        return { card: normalizeCard(raw), best_frame: bestFrame, currency: locale.currency, elapsed_ms: Date.now() - started };
      });

      // One photo of a room/shelf -> a card per item (NOT saved; POST /items for each).
      p.post('/scan/room', async (req) => {
        const body = (req.body || {}) as { image?: unknown; hint?: unknown; locale?: unknown };
        const [image] = validImages([body.image]);
        if (!image) throw bad('"image" must be a data:image/... URL');
        const locale = localeOf(body.locale);
        const started = Date.now();
        const raw = await llm.room([image], { hint: cleanText(body.hint, 300), locale });
        const items = raw.map((r) => {
          const b = Array.isArray(r.box) && r.box.length === 4
            ? r.box.map((n: unknown) => Math.min(1000, Math.max(0, Math.round(Number(n) || 0))))
            : null;
          return { card: normalizeCard(r), box: b && b[2] - b[0] > 10 && b[3] - b[1] > 10 ? b : null };
        });
        return { items, currency: locale.currency, elapsed_ms: Date.now() - started };
      });

      // Natural-language search -> filters the client applies to GET /items.
      p.post('/ask', async (req) => {
        const body = (req.body || {}) as { query?: unknown; locale?: unknown };
        const query = cleanText(body.query, 200);
        if (!query) throw bad('"query" is required');
        const raw = await llm.ask(query, localeOf(body.locale));
        const list = (v: unknown, allowed: readonly string[]) =>
          (Array.isArray(v) ? v : []).map((x) => String(x).toUpperCase()).filter((x) => allowed.includes(x));
        const filters: AskFilters = {
          q: cleanText(raw.q, 60),
          types: list(raw.types, TYPES),
          rarities: list(raw.rarities, RARITIES),
          min_value: wholeNumber(raw.min_value, 1e13),
          max_value: wholeNumber(raw.max_value, 1e13),
          sort: (SORTS as readonly string[]).includes(raw.sort) ? raw.sort : 'new',
          flag: (FLAGS as readonly string[]).includes(raw.flag) ? raw.flag : '',
        };
        return { filters };
      });

      // AI server connection (URL, key, model). With accounts, only the first account may change it.
      const canEditAi = async (req: FastifyRequest) => {
        if (!accounts) return true;
        const { rows } = await db.query('SELECT id FROM users ORDER BY created_at, id LIMIT 1');
        return rows[0]?.id === req.user?.id;
      };
      const aiConfig = async (req: FastifyRequest): Promise<AiConfig> => ({
        base_url: llm.url, model: llm.model, provider: llm.kind, has_key: llm.hasKey, source: aiSource, editable: await canEditAi(req),
      });
      // Candidate values from the form; an empty key keeps the current one.
      const aiBody = (req: FastifyRequest) => {
        const b = (req.body || {}) as Record<string, unknown>;
        return {
          baseUrl: cleanBaseUrl(cleanText(b.base_url, 300)),
          model: cleanText(b.model, 120),
          apiKey: typeof b.api_key === 'string' && b.api_key.trim() ? b.api_key.trim().slice(0, 500) : null,
          clearKey: b.clear_key === true,
        };
      };
      p.get('/settings/ai', async (req) => aiConfig(req));
      p.put('/settings/ai', async (req) => {
        if (!(await canEditAi(req))) throw new HttpError(403, 'forbidden', 'Only the first account can change the AI server');
        const { baseUrl, model, apiKey, clearKey } = aiBody(req);
        if (!/^https?:\/\/[^\s/]+/i.test(baseUrl)) throw bad('"base_url" must start with http:// or https://');
        if (!model) throw bad('"model" is required');
        const key = clearKey ? '' : apiKey ?? llm.key;
        await settings.setAi({ base_url: baseUrl, api_key: key, model });
        llm.configure({ baseUrl, apiKey: key, model });
        aiSource = 'app';
        return aiConfig(req);
      });
      // Tries the form values (or the saved ones) against /v1/models. Never throws: the answer is the message.
      p.post('/settings/ai/test', async (req): Promise<AiTest> => {
        if (!(await canEditAi(req))) throw new HttpError(403, 'forbidden', 'Only the first account can change the AI server');
        const { baseUrl, model, apiKey } = aiBody(req);
        const probe = new LlmClient({
          ...config.llm, language: config.language, currency: config.currency, market: config.market,
          baseUrl: baseUrl || llm.url, model: model || llm.model, apiKey: apiKey ?? llm.key,
        });
        try {
          const models = await probe.models();
          if (probe.model && models.length && !models.includes(probe.model)) {
            return { ok: false, models, message: `Connected, but the server has no model called "${probe.model}"` };
          }
          if (!probe.model) return { ok: true, models, message: `Connected. ${models.length} model(s) available: pick a vision model.` };
          try {
            await probe.probeVision();
          } catch (err) {
            return { ok: false, models, message: `Connected, but "${probe.model}" did not accept an image (${(err as Error).message.slice(0, 160)}). Scanning needs a vision model.` };
          }
          return { ok: true, models, message: `Connected. "${probe.model}" accepts images.` };
        } catch (err) {
          return { ok: false, models: [], message: (err as Error).message };
        }
      });

      // Shopee session for the price check. One session per service; login opens a window on this machine.
      const shopee = () => ({ available: config.shopee.canLogin, connected: connected(config.shopee), ...loginStatus() });
      p.get('/shopee', async () => shopee());
      p.post('/shopee/login', async () => {
        if (!config.shopee.canLogin) throw new HttpError(403, 'remote', 'Connect Shopee from the computer that runs ITEMDEX (localhost)');
        try {
          await startLogin(config.shopee);
        } catch (err) {
          throw new HttpError(500, 'browser_error', (err as Error).message);
        }
        return shopee();
      });
      p.delete('/shopee', async () => {
        disconnect(config.shopee);
        return shopee();
      });

      p.get('/stats', async (req) => repo.stats(req.hid));

      p.get('/items', async (req) => {
        const q = req.query as Record<string, string | undefined>;
        const sort = (SORTS as readonly string[]).includes(q.sort ?? '') ? (q.sort as Sort) : 'new';
        const flag = (FLAGS as readonly string[]).includes(q.flag ?? '') ? (q.flag as Flag) : '';
        return repo.list(req.hid, {
          q: cleanText(q.q, 100),
          types: csv(q.type),
          rarities: csv(q.rarity),
          sort,
          flag,
          minValue: wholeNumber(q.min_value, 1e13),
          maxValue: wholeNumber(q.max_value, 1e13),
          offset: Number(q.offset) || 0,
          limit: Number(q.limit) || 60,
        }, urlFor(req));
      });

      // Insurance / moving inventory. ?format=csv (default) or html (open it and print to PDF).
      p.get('/report', async (req, reply) => {
        const { format } = req.query as { format?: string };
        const url = urlFor(req);
        const items = await repo.all(req.hid, url);
        if (format === 'html') {
          return reply.type('text/html; charset=utf-8').send(
            toHtml(items, 'ITEMDEX inventory report', (i) => i.thumb_url));
        }
        return reply
          .type('text/csv; charset=utf-8')
          .header('Content-Disposition', 'attachment; filename="itemdex-inventory.csv"')
          .send(toCsv(items));
      });

      const idParam = (req: FastifyRequest) => {
        const { id } = req.params as { id: string };
        if (!UUID_RE.test(id)) throw notFound();
        return id;
      };

      // Loads the item or 404s (also the household check for the actions below).
      const owned = async (req: FastifyRequest) => {
        const item = await repo.get(req.hid, idParam(req), urlFor(req));
        if (!item) throw notFound();
        return item;
      };

      p.get('/items/:id', async (req) => ({ item: await owned(req) }));

      p.post('/items', async (req, reply) => {
        const body = (req.body || {}) as Record<string, unknown>;
        if (!body.card || typeof body.card !== 'object') throw bad('Missing "card" object');
        const image = decodeImage(body.image);
        const item = await repo.create(req.hid, normalizeCard(body.card as object), {
          image,
          thumb: image ? decodeImage(body.thumb) : null,
          source: (SOURCES as readonly string[]).includes(body.source as string) ? (body.source as Source) : 'photo',
          currency: currencyOf(body.currency),
          location: await reverseGeocode(cleanLocation(body.location), config.reverseGeocode),
        }, urlFor(req));
        return reply.status(201).send({ item });
      });

      const updateItem = async (req: FastifyRequest) => {
        const patch = (req.body as { card?: unknown })?.card;
        if (!patch || typeof patch !== 'object') throw bad('Missing "card" object');
        const prev = await owned(req);
        const item = await repo.update(req.hid, prev.id, normalizeCard(mergeCard(prev, patch)), urlFor(req));
        if (!item) throw notFound();
        return { item };
      };
      p.patch('/items/:id', updateItem);
      p.put('/items/:id', updateItem);

      // "Last seen" location update.
      p.put('/items/:id/location', async (req) => {
        const id = idParam(req);
        const location = cleanLocation(req.body);
        if (!location) throw bad('Provide "place" and/or "lat"+"lng"');
        const item = await repo.move(req.hid, id, (await reverseGeocode(location, config.reverseGeocode))!, urlFor(req));
        if (!item) throw notFound();
        return { item };
      });

      // Lent out to someone (optional due date YYYY-MM-DD); DELETE = it is back.
      p.put('/items/:id/lend', async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        const to = cleanText(b.to, 80);
        if (!to) throw bad('"to" (who has it) is required');
        if (b.due && !iso(b.due)) throw bad('"due" must be a valid YYYY-MM-DD date');
        const item = await repo.setJson(req.hid, idParam(req), 'lent',
          { to, at: new Date().toISOString(), due: iso(b.due) }, urlFor(req));
        if (!item) throw notFound();
        return { item };
      });
      p.delete('/items/:id/lend', async (req) => {
        const item = await repo.setJson(req.hid, idParam(req), 'lent', null, urlFor(req));
        if (!item) throw notFound();
        return { item };
      });

      const savePurchase = (req: FastifyRequest, id: string, b: Record<string, unknown>) => {
        const date = iso(b.date);
        const months = wholeNumber(b.warranty_months, 240);
        const until = date && months ? new Date(`${date}T00:00:00Z`) : null;
        until?.setUTCMonth(until.getUTCMonth() + months);
        const purchase: Purchase = {
          store: cleanText(b.store, 80), date, price: wholeNumber(b.price, 1e13), warranty_months: months,
          warranty_until: until ? until.toISOString().slice(0, 10) : null,
        };
        return repo.setJson(req.hid, id, 'purchase', purchase, urlFor(req));
      };
      p.put('/items/:id/purchase', async (req) => {
        const item = await savePurchase(req, idParam(req), (req.body || {}) as Record<string, unknown>);
        if (!item) throw notFound();
        return { item };
      });

      // Read a receipt photo: purchase date, store, price and warranty expiry.
      p.post('/items/:id/receipt', async (req) => {
        const item = await owned(req);
        const [image] = validImages([(req.body as { image?: unknown })?.image]);
        if (!image) throw bad('"image" must be a data:image/... URL');
        const r = await llm.receipt(image);
        if (r.is_receipt === false) throw new HttpError(422, 'not_a_receipt', 'The AI could not find a receipt in that image');
        const saved = await savePurchase(req, item.id, { store: r.store, date: r.date, price: r.total, warranty_months: r.warranty_months });
        return { item: saved };
      });

      // Ready-to-post sale listing text.
      p.post('/items/:id/listing', async (req) => {
        const item = await owned(req);
        const b = (req.body || {}) as { platform?: unknown; locale?: unknown };
        const platform = (PLATFORMS as readonly string[]).includes(b.platform as string) ? (b.platform as Platform) : 'generic';
        const locale = localeOf(b.locale);
        const raw = await llm.listing(item, platform, locale);
        return {
          listing: {
            title: cleanText(raw.title, 120) || item.name,
            description: cleanText(raw.description, 2000),
            price: wholeNumber(raw.price, 1e13) || item.value.typical,
            currency: item.currency,
            platform,
          },
        };
      });

      // Check the value against current Shopee listings (needs a connected session); updates it when 3+ match.
      p.post('/items/:id/comps', async (req) => {
        if (!connected(config.shopee)) throw new HttpError(409, 'not_connected', 'Connect Shopee from the menu to check prices; until then the value stays the AI estimate');
        const prev = await owned(req);
        if (prev.currency !== 'IDR') throw bad('Shopee prices are in IDR; this item is priced in another currency');
        const query = [prev.brand, prev.model || prev.name].filter(Boolean).join(' ');
        let comps;
        try {
          comps = await fetchComps(query, config.shopee);
        } catch (err) {
          throw new HttpError(502, 'comps_error', (err as Error).message);
        }
        if (!comps) throw new HttpError(404, 'no_comps', `No Shopee listings found for "${query}"`);
        let item = prev;
        if (comps.n >= 3) {
          const value = {
            min: comps.low, typical: comps.median, max: comps.high,
            confidence: comps.n >= 8 ? 'HIGH' : 'MEDIUM',
            reasoning: `Median of ${comps.n} Shopee listings, ${Math.round((1 - config.shopee.discount) * 100)}% below asking prices.`,
          };
          item = (await repo.update(req.hid, prev.id, normalizeCard(mergeCard(prev, { value })), urlFor(req))) ?? prev;
        }
        const saved = await repo.setJson(req.hid, prev.id, 'comps', comps, urlFor(req));
        return { item: saved ?? item };
      });

      p.delete('/items/:id', async (req) => {
        if (!(await repo.remove(req.hid, idParam(req)))) throw notFound();
        return { ok: true };
      });
    });

    r.all('/*', async (req) => {
      throw new HttpError(404, 'not_found', `No route ${req.method} ${req.url.split('?')[0]}`);
    });
  };

  await app.register(api, { prefix: '/api/v1' });
  await app.register(api, { prefix: '/api' }); // unversioned alias

  // ------------------------------------------------------------- media (public: ids are unguessable)
  const sendImage = (kind: 'full' | 'thumb') => async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) throw notFound();
    const img = await repo.image(id, kind);
    if (!img) throw notFound();
    return reply
      .header('Content-Type', img.mime)
      .header('Cache-Control', 'public, max-age=31536000, immutable') // bytes never change
      .send(img.data);
  };
  app.get('/media/:id', sendImage('full'));
  app.get('/media/:id/thumb', sendImage('thumb'));

  // ------------------------------------------------------------- API docs
  if (config.openapiFile && fs.existsSync(config.openapiFile)) {
    const [{ default: swagger }, { default: swaggerUi }, YAML] = await Promise.all([
      import('@fastify/swagger'), import('@fastify/swagger-ui'), import('yaml'),
    ]);
    const spec = YAML.parse(fs.readFileSync(config.openapiFile, 'utf8'));
    await app.register(swagger, { mode: 'static', specification: { document: spec } });
    await app.register(swaggerUi, { routePrefix: '/api/docs' });
    app.get('/api/v1/openapi.json', async () => spec);
  }

  // ------------------------------------------------------------- web app
  if (config.webDist && fs.existsSync(path.join(config.webDist, 'index.html'))) {
    const csp = [
      "default-src 'self'", "img-src 'self' data: blob:", "media-src 'self' blob:",
      "style-src 'self' 'unsafe-inline'", "font-src 'self' data:", "connect-src 'self'", "script-src 'self'",
      "object-src 'none'", "base-uri 'self'",
    ].join('; ');
    await app.register(fastifyStatic, {
      root: config.webDist,
      wildcard: true, // resolve files per request, so a rebuilt web app is picked up
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) {
          res.header('Cache-Control', 'no-cache');
          res.header('Content-Security-Policy', csp);
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.header('Cache-Control', 'public, max-age=31536000, immutable'); // hashed by Vite
        }
      },
    });
    // SPA fallback for page routes only (a missing /assets/x.js must stay a 404).
    app.setNotFoundHandler((req, reply) => {
      const p = req.url.split('?')[0];
      if (req.method === 'GET' && !/^\/(api|media|assets)(\/|$)/.test(p) && !/\.\w+$/.test(p)) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: 'Not found', code: 'not_found' });
    });
  }

  return { app, db };
}

// Migrates the database and starts listening. Used by the CLI and the desktop app.
export async function startServer(config: Config): Promise<ServerHandle> {
  const { app, db } = await buildApp(config);
  try {
    await migrate(db, (m) => app.log.info(m));
  } catch (err) {
    await app.close();
    throw err;
  }
  await app.listen({ host: config.host, port: config.port });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  const shown = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  return { app, db, url: `http://${shown}:${port}`, close: () => app.close() };
}
