// ITEMDEX service: REST API (+ the bundled demo UI). Runs standalone
// (`npm run service`) or embedded inside the Electron app (desktop/main.js).
// API reference: docs/API.md, docs/openapi.yaml, live Swagger at /api/docs.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { GemmaClient, TYPES, RARITIES, CONDITIONS, SIZE_CLASSES } = require('./gemma');
const { normalizeCard } = require('./card');
const { Store } = require('./store');

const VERSION = '1.0.0';
const MAX_IMAGES = 6;
const BODY_LIMIT_MB = 60;
const SOURCES = ['photo', 'video', 'camera'];
const RARITY_RANK = Object.fromEntries(RARITIES.map((r, i) => [r, i]));

const cleanText = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function fail(res, status, code, message) {
  return res.status(status).json({ error: message, code });
}

// Accepts { place, lat, lng, accuracy_m, source }; returns null when empty.
function cleanLocation(v) {
  if (!v || typeof v !== 'object') return null;
  const lat = Number(v.lat);
  const lng = Number(v.lng);
  const hasGeo = v.lat != null && v.lng != null && Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
  const place = cleanText(v.place, 80);
  if (!place && !hasGeo) return null;
  return {
    place,
    lat: hasGeo ? +lat.toFixed(6) : null,
    lng: hasGeo ? +lng.toFixed(6) : null,
    accuracy_m: hasGeo && Number.isFinite(Number(v.accuracy_m)) ? Math.round(Number(v.accuracy_m)) : null,
    source: hasGeo && ['exif', 'device'].includes(v.source) ? v.source : (hasGeo ? 'device' : 'manual'),
    address: '',
  };
}

// Coordinates -> short human-readable address via OpenStreetMap Nominatim.
async function reverseGeocode(loc) {
  if (!loc || loc.lat == null || process.env.REVERSE_GEOCODE === 'false') return loc;
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat=${loc.lat}&lon=${loc.lng}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ITEMDEX-hackathon-demo/0.1', 'Accept-Language': 'id,en' },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = await res.json();
      const a = data.address || {};
      const parts = [a.road, a.suburb || a.village || a.neighbourhood, a.city || a.town || a.county]
        .filter(Boolean);
      loc.address = (parts.length ? parts.join(', ') : data.display_name || '').slice(0, 160);
    }
  } catch { /* offline: keep raw coordinates */ }
  return loc;
}

// Partial update: nested objects are merged, not replaced.
function mergeCard(prev, patch) {
  const out = { ...prev, ...patch };
  for (const k of ['dimensions', 'condition', 'value']) {
    if (patch[k] && typeof patch[k] === 'object') out[k] = { ...prev[k], ...patch[k] };
  }
  return out;
}

function validImages(list) {
  return (Array.isArray(list) ? list : [])
    .filter((u) => typeof u === 'string' && u.startsWith('data:image/'))
    .slice(0, MAX_IMAGES);
}

// ------------------------------------------------------------------ middleware
function cors(allowed) {
  const origins = allowed.split(',').map((s) => s.trim()).filter(Boolean);
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin && (origins.includes('*') || origins.includes(origin))) {
      res.set('Access-Control-Allow-Origin', origins.includes('*') ? '*' : origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
      res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.set('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
}

// Accepts "Authorization: Bearer <key>" or "X-API-Key: <key>".
function requireKey(apiKey) {
  const expected = Buffer.from(apiKey);
  return (req, res, next) => {
    const header = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const given = Buffer.from(header);
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
    fail(res, 401, 'unauthorized', 'Missing or invalid API key');
  };
}

// ------------------------------------------------------------------ app
function createApp({ dataDir, apiKey = '', corsOrigins = '', serveUi = true }) {
  const gemma = new GemmaClient({
    baseUrl: process.env.LLM_API_BASE,
    apiKey: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL,
    language: process.env.CARD_LANGUAGE || 'Indonesian',
    currency: process.env.CURRENCY || 'IDR',
    market: process.env.MARKET || 'Indonesian',
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 120000,
  });
  const store = new Store(dataDir);

  const app = express();
  app.set('trust proxy', true); // correct https image_url behind tunnels/proxies
  if (corsOrigins) app.use(['/api', '/media'], cors(corsOrigins));
  app.use(express.json({ limit: `${BODY_LIMIT_MB}mb` }));
  if (serveUi) app.use(express.static(path.join(__dirname, '..', 'ui')));
  app.use('/media', express.static(store.mediaDir, { maxAge: '1h' }));

  // Interactive API docs.
  const specPath = path.join(__dirname, '..', 'docs', 'openapi.yaml');
  if (fs.existsSync(specPath)) {
    const spec = require('yaml').parse(fs.readFileSync(specPath, 'utf8'));
    const swaggerUi = require('swagger-ui-express');
    app.get('/api/v1/openapi.json', (req, res) => res.json(spec));
    app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec, { customSiteTitle: 'ITEMDEX API' }));
  }

  const wrap = (fn) => (req, res) =>
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error(`[itemdex] ${req.method} ${req.path}: ${err.cause?.code || err.name}: ${err.message}`);
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        return fail(res, 504, 'llm_timeout', 'Gemma took too long to respond. Try again.');
      }
      fail(res, 502, 'llm_error', err.message);
    });

  const withUrls = (req, item) => ({
    ...item,
    image_url: item.image ? `${req.protocol}://${req.get('host')}/media/${encodeURIComponent(item.image)}` : null,
  });

  const api = express.Router();

  // ---- public
  api.get('/health', wrap(async (req, res) => {
    let llm = false;
    try { llm = await gemma.ping(); } catch { /* offline */ }
    res.json({ ok: true, version: VERSION, llm, model: gemma.model, items: store.items.length });
  }));

  api.get('/meta', (req, res) => {
    res.json({
      version: VERSION,
      model: gemma.model,
      currency: gemma.currency,
      language: gemma.language,
      market: gemma.market,
      auth_required: !!apiKey,
      enums: {
        type: TYPES, rarity: RARITIES, condition: CONDITIONS, size_class: SIZE_CLASSES, source: SOURCES,
      },
      limits: {
        max_images_per_scan: MAX_IMAGES,
        max_body_mb: BODY_LIMIT_MB,
        recommended_scan_image_side_px: 1024,
        recommended_detect_image_side_px: 512,
      },
    });
  });

  // ---- protected
  if (apiKey) api.use(requireKey(apiKey));

  // Live viewfinder: where is the item in this frame?
  api.post('/detect', wrap(async (req, res) => {
    const [image] = validImages([req.body?.image]);
    if (!image) return fail(res, 400, 'bad_request', '"image" must be a data:image/... URL');
    const started = Date.now();
    const raw = await gemma.detect(image);
    const b = Array.isArray(raw.box) && raw.box.length === 4
      ? raw.box.map((n) => Math.min(1000, Math.max(0, Math.round(Number(n) || 0))))
      : null;
    const box = b && b[2] - b[0] > 10 && b[3] - b[1] > 10 ? b : null;
    res.json({
      has_item: raw.has_item === true && !!box,
      name: cleanText(raw.name, 40),
      box,
      elapsed_ms: Date.now() - started,
    });
  }));

  // Analyze images -> card preview (NOT saved; POST /items to save).
  api.post('/scan', wrap(async (req, res) => {
    const { hint, source } = req.body || {};
    const images = validImages(req.body?.images);
    if (!images.length) return fail(res, 400, 'bad_request', '"images" must contain 1-6 data:image/... URLs');
    const started = Date.now();
    const raw = await gemma.analyze(images, {
      hint: typeof hint === 'string' ? hint.slice(0, 300) : '',
      isVideo: source === 'video',
    });
    const card = normalizeCard(raw);
    const bestFrame = Math.min(images.length - 1, Math.max(0, Number(raw.best_frame) || 0));
    res.json({ card, best_frame: bestFrame, elapsed_ms: Date.now() - started });
  }));

  api.get('/items', (req, res) => {
    const q = cleanText(req.query.q, 100).toLowerCase();
    const types = cleanText(req.query.type, 200).toUpperCase().split(',').filter(Boolean);
    const rarities = cleanText(req.query.rarity, 200).toUpperCase().split(',').filter(Boolean);
    let list = store.list();
    if (types.length) list = list.filter((i) => types.includes(i.type));
    if (rarities.length) list = list.filter((i) => rarities.includes(i.rarity));
    if (q) {
      list = list.filter((i) => [
        i.name, i.brand, i.model, i.subcategory, i.color, i.material, ...(i.tags || []),
        i.location?.place, i.location?.address,
      ].filter(Boolean).join(' ').toLowerCase().includes(q));
    }
    const sorters = {
      new: (a, b) => b.created_at.localeCompare(a.created_at),
      old: (a, b) => a.created_at.localeCompare(b.created_at),
      value: (a, b) => (b.value?.typical || 0) - (a.value?.typical || 0),
      rarity: (a, b) => RARITY_RANK[b.rarity] - RARITY_RANK[a.rarity] || (b.value?.typical || 0) - (a.value?.typical || 0),
      name: (a, b) => a.name.localeCompare(b.name),
      number: (a, b) => a.number - b.number,
    };
    list.sort(sorters[req.query.sort] || sorters.new);
    const total = list.length;
    const totalValue = list.reduce((s, i) => s + (i.value?.typical || 0), 0);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 500));
    res.json({
      items: list.slice(offset, offset + limit).map((i) => withUrls(req, i)),
      total,
      total_value: totalValue,
    });
  });

  api.get('/items/:id', (req, res) => {
    const item = store.get(req.params.id);
    if (!item) return fail(res, 404, 'not_found', 'Item not found');
    res.json({ item: withUrls(req, item) });
  });

  api.post('/items', wrap(async (req, res) => {
    const { card, image, source, location } = req.body || {};
    if (!card || typeof card !== 'object') return fail(res, 400, 'bad_request', 'Missing "card" object');
    const item = store.create(normalizeCard(card), {
      imageDataUrl: image,
      location: await reverseGeocode(cleanLocation(location)),
      source: SOURCES.includes(source) ? source : 'photo',
    });
    res.status(201).json({ item: withUrls(req, item) });
  }));

  const updateItem = (req, res) => {
    const prev = store.get(req.params.id);
    if (!prev) return fail(res, 404, 'not_found', 'Item not found');
    const patch = req.body?.card;
    if (!patch || typeof patch !== 'object') return fail(res, 400, 'bad_request', 'Missing "card" object');
    const item = store.update(req.params.id, normalizeCard(mergeCard(prev, patch)));
    res.json({ item: withUrls(req, item) });
  };
  api.patch('/items/:id', updateItem);
  api.put('/items/:id', updateItem);

  // "Last seen" location update.
  api.put('/items/:id/location', wrap(async (req, res) => {
    if (!store.get(req.params.id)) return fail(res, 404, 'not_found', 'Item not found');
    const location = cleanLocation(req.body);
    if (!location) return fail(res, 400, 'bad_request', 'Provide "place" and/or "lat"+"lng"');
    res.json({ item: withUrls(req, store.move(req.params.id, await reverseGeocode(location))) });
  }));

  api.delete('/items/:id', (req, res) => {
    if (!store.remove(req.params.id)) return fail(res, 404, 'not_found', 'Item not found');
    res.json({ ok: true });
  });

  api.use((req, res) => fail(res, 404, 'not_found', `No route ${req.method} ${req.baseUrl}${req.path}`));

  app.use('/api/v1', api);
  app.use('/api', api); // unversioned alias used by the bundled demo UI

  // Malformed / oversized JSON bodies -> JSON errors instead of HTML.
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err.type === 'entity.parse.failed') return fail(res, 400, 'bad_request', 'Body is not valid JSON');
    if (err.type === 'entity.too.large') return fail(res, 413, 'payload_too_large', `Body exceeds ${BODY_LIMIT_MB}MB`);
    console.error('[itemdex]', err);
    fail(res, 500, 'internal', 'Internal server error');
  });

  return app;
}

function startServer({
  port = 0,
  host = process.env.HOST || '127.0.0.1',
  dataDir,
  apiKey = process.env.ITEMDEX_API_KEY || '',
  corsOrigins = process.env.CORS_ORIGINS || '',
  serveUi = process.env.SERVE_UI !== 'false',
} = {}) {
  const app = createApp({
    dataDir: dataDir || process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
    apiKey,
    corsOrigins,
    serveUi,
  });
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const { port: actual } = server.address();
      const shown = host === '0.0.0.0' ? 'localhost' : host;
      resolve({ server, url: `http://${shown}:${actual}` });
    });
    server.on('error', reject);
  });
}

module.exports = { createApp, startServer };

if (require.main === module) {
  startServer({ port: Number(process.env.PORT) || 7777 })
    .then(({ url }) => {
      console.log(`ITEMDEX service running at ${url}  (API docs: ${url}/api/docs)`);
      if (process.env.HOST && process.env.HOST !== '127.0.0.1' && !process.env.ITEMDEX_API_KEY) {
        console.warn('WARNING: service is reachable from the network without ITEMDEX_API_KEY.');
      }
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
