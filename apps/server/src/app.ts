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
  CONDITIONS, RARITIES, SIZE_CLASSES, SORTS, SOURCES, TYPES,
  mergeCard, normalizeCard, type Sort, type Source,
} from '@itemdex/shared';
import type { Config } from './config.js';
import { createPool, migrate, type Db } from './db.js';
import { GemmaClient, LlmError } from './gemma.js';
import { cleanLocation, reverseGeocode } from './geo.js';
import { ItemsRepo, type ImageBlob } from './repo.js';

export { loadConfig, type Config } from './config.js';

export const VERSION = '2.0.0';
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cleanText = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const csv = (v: unknown) => cleanText(v, 200).toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);

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
  const gemma = new GemmaClient({ ...config.llm, language: config.language, currency: config.currency, market: config.market });
  const repo = new ItemsRepo(db);

  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: config.bodyLimitMb * 1024 * 1024,
    trustProxy: true, // correct protocol/host for image URLs behind proxies/tunnels
    logController: new LogController({ disableRequestLogging: true }), // /detect fires every ~0.6s
  });
  app.addHook('onClose', async () => { await db.end(); });

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
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return reply.status(504).send({ error: 'Gemma took too long to respond. Try again.', code: 'llm_timeout' });
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
      const [llm, items] = await Promise.all([
        gemma.ping(),
        repo.count().catch(() => null),
      ]);
      return { ok: items !== null, version: VERSION, llm, db: items !== null, model: gemma.model, items: items ?? 0 };
    });

    r.get('/meta', async () => ({
      version: VERSION,
      model: gemma.model,
      currency: config.currency,
      language: config.language,
      market: config.market,
      auth_required: !!config.apiKey,
      enums: { type: TYPES, rarity: RARITIES, condition: CONDITIONS, size_class: SIZE_CLASSES, source: SOURCES, sort: SORTS },
      limits: {
        max_images_per_scan: MAX_IMAGES,
        max_body_mb: config.bodyLimitMb,
        recommended_scan_image_side_px: 1024,
        recommended_detect_image_side_px: 512,
        thumb_side_px: 360,
      },
    }));

    await r.register(async (p) => {
      if (config.apiKey) {
        const expected = Buffer.from(config.apiKey);
        p.addHook('onRequest', async (req, reply) => {
          const header = String(req.headers['x-api-key'] || '')
            || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
          const given = Buffer.from(header);
          if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
            return reply.status(401).send({ error: 'Missing or invalid API key', code: 'unauthorized' });
          }
        });
      }

      // Live viewfinder: where is the item in this frame?
      p.post('/detect', async (req) => {
        const [image] = validImages([(req.body as { image?: unknown })?.image]);
        if (!image) throw bad('"image" must be a data:image/... URL');
        const started = Date.now();
        const raw = await gemma.detect(image);
        const b = Array.isArray(raw.box) && raw.box.length === 4
          ? raw.box.map((n: unknown) => Math.min(1000, Math.max(0, Math.round(Number(n) || 0))))
          : null;
        const box = b && b[2] - b[0] > 10 && b[3] - b[1] > 10 ? b : null;
        return { has_item: raw.has_item === true && !!box, name: cleanText(raw.name, 40), box, elapsed_ms: Date.now() - started };
      });

      // Analyze images -> card preview (NOT saved; POST /items to save).
      p.post('/scan', async (req) => {
        const body = (req.body || {}) as { images?: unknown; hint?: unknown; source?: unknown };
        const images = validImages(body.images);
        if (!images.length) throw bad(`"images" must contain 1-${MAX_IMAGES} data:image/... URLs`);
        const started = Date.now();
        const raw = await gemma.analyze(images, { hint: cleanText(body.hint, 300), isVideo: body.source === 'video' });
        const bestFrame = Math.min(images.length - 1, Math.max(0, Number(raw.best_frame) || 0));
        return { card: normalizeCard(raw), best_frame: bestFrame, elapsed_ms: Date.now() - started };
      });

      p.get('/stats', async () => repo.stats());

      p.get('/items', async (req) => {
        const q = req.query as Record<string, string | undefined>;
        const sort = (SORTS as readonly string[]).includes(q.sort ?? '') ? (q.sort as Sort) : 'new';
        return repo.list({
          q: cleanText(q.q, 100),
          types: csv(q.type),
          rarities: csv(q.rarity),
          sort,
          offset: Number(q.offset) || 0,
          limit: Number(q.limit) || 60,
        }, urlFor(req));
      });

      const idParam = (req: FastifyRequest) => {
        const { id } = req.params as { id: string };
        if (!UUID_RE.test(id)) throw notFound();
        return id;
      };

      p.get('/items/:id', async (req) => {
        const item = await repo.get(idParam(req), urlFor(req));
        if (!item) throw notFound();
        return { item };
      });

      p.post('/items', async (req, reply) => {
        const body = (req.body || {}) as Record<string, unknown>;
        if (!body.card || typeof body.card !== 'object') throw bad('Missing "card" object');
        const image = decodeImage(body.image);
        const item = await repo.create(normalizeCard(body.card as object), {
          image,
          thumb: image ? decodeImage(body.thumb) : null,
          source: (SOURCES as readonly string[]).includes(body.source as string) ? (body.source as Source) : 'photo',
          location: await reverseGeocode(cleanLocation(body.location), config.reverseGeocode),
        }, urlFor(req));
        return reply.status(201).send({ item });
      });

      const updateItem = async (req: FastifyRequest) => {
        const id = idParam(req);
        const patch = (req.body as { card?: unknown })?.card;
        if (!patch || typeof patch !== 'object') throw bad('Missing "card" object');
        const prev = await repo.get(id, urlFor(req));
        if (!prev) throw notFound();
        const item = await repo.update(id, normalizeCard(mergeCard(prev, patch)), urlFor(req));
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
        const item = await repo.move(id, (await reverseGeocode(location, config.reverseGeocode))!, urlFor(req));
        if (!item) throw notFound();
        return { item };
      });

      p.delete('/items/:id', async (req) => {
        if (!(await repo.remove(idParam(req)))) throw notFound();
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
