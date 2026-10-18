// Types, enums and card normalization shared by the server and the web app.

export const TYPES = [
  'ELECTRONIC', 'FASHION', 'BOOK', 'TOY', 'HOME', 'KITCHEN', 'SPORT',
  'TOOL', 'COLLECTIBLE', 'BEAUTY', 'VEHICLE', 'MUSIC', 'OFFICE', 'OTHER',
] as const;
export const RARITIES = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY'] as const;
export const CONDITIONS = ['MINT', 'EXCELLENT', 'GOOD', 'FAIR', 'POOR'] as const;
export const SIZE_CLASSES = ['TINY', 'SMALL', 'MEDIUM', 'LARGE', 'HUGE'] as const;
export const CONFIDENCES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export const SOURCES = ['photo', 'video', 'camera'] as const;
export const SORTS = ['new', 'old', 'value', 'rarity', 'name', 'number'] as const;
export const PRICE_CHECK_STATUSES = ['grounded', 'no_match', 'no_results', 'disabled', 'error'] as const;
// Collection filters driven by the item's life after cataloguing.
export const FLAGS = ['lent', 'overdue', 'sell_now', 'warranty'] as const;
export const PLATFORMS = ['generic', 'tokopedia', 'facebook', 'ebay'] as const;

export type ItemType = (typeof TYPES)[number];
export type Rarity = (typeof RARITIES)[number];
export type ConditionLabel = (typeof CONDITIONS)[number];
export type SizeClass = (typeof SIZE_CLASSES)[number];
export type Confidence = (typeof CONFIDENCES)[number];
export type Source = (typeof SOURCES)[number];
export type Sort = (typeof SORTS)[number];
export type PriceCheckStatus = (typeof PRICE_CHECK_STATUSES)[number];
export type Flag = (typeof FLAGS)[number];
export type Platform = (typeof PLATFORMS)[number];

export const RARITY_RANK: Record<Rarity, number> = {
  COMMON: 1, UNCOMMON: 2, RARE: 3, EPIC: 4, LEGENDARY: 5,
};

export interface Dimensions { length_cm: number; width_cm: number; height_cm: number }
export interface Condition { score: number; label: ConditionLabel; notes: string }
// A web listing used as a price comparison (from the search-based price check).
export interface PriceSource { title: string; url: string; site: string; price: number }
export interface Value {
  min: number; max: number; typical: number; new_price: number;
  confidence: Confidence; reasoning: string;
  sources?: PriceSource[]; // present when the value was checked against web listings
  checked_at?: string; // ISO time of the last price check
}
export interface Ability { name: string; power: number; text: string }

export interface Card {
  is_item: boolean;
  name: string;
  brand: string;
  model: string;
  type: ItemType;
  subcategory: string;
  description: string;
  color: string;
  material: string;
  dimensions: Dimensions;
  size_class: SizeClass;
  weight_g: number;
  condition: Condition;
  value: Value;
  rarity: Rarity;
  abilities: Ability[];
  tags: string[];
  location_guess: string;
}

export type LocationSource = 'exif' | 'device' | 'manual';
export interface ItemLocation {
  place: string;
  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
  source: LocationSource;
  address: string;
  at: string;
}

export interface Lent { to: string; at: string; due: string | null }
export interface Purchase {
  store: string;
  date: string | null;
  price: number;
  warranty_months: number;
  warranty_until: string | null;
}
export interface Comp { title: string; price: number; url: string; site: string }
export interface Comps {
  query: string;
  engine: string;
  n: number;
  median: number;
  low: number;
  high: number;
  sources: Comp[];
  at: string;
}
export interface ValuePoint { typical: number; at: string }
export interface Locale { language: string; currency: string; market: string }

export interface Item extends Card {
  id: string;
  number: number;
  source: Source;
  currency: string;
  location: ItemLocation | null;
  location_history: ItemLocation[];
  lent: Lent | null;
  purchase: Purchase | null;
  comps: Comps | null; // last marketplace price check
  value_history: ValuePoint[]; // only on GET /items/:id
  sell_now: boolean; // value is at its all-time high and up 10%+ since first recorded
  image_url: string | null;
  thumb_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface PriceCheck {
  status: PriceCheckStatus; // grounded = value now based on matching listings
  query: string;
  listings: number; // listings with a price found by the search
  used: number; // listings Gemma judged to be the same product
  elapsed_ms: number;
  error?: string;
}
export interface PriceCheckResult { value: Value; price_check: PriceCheck }
export interface ScanResult { card: Card; best_frame: number; currency: string; elapsed_ms: number; price_check?: PriceCheck }
export interface RoomResult { items: { card: Card; box: [number, number, number, number] | null }[]; currency: string; elapsed_ms: number }
export interface InvoiceItem { card: Card; store: string; date: string | null; price: number }
export interface InvoiceResult { items: InvoiceItem[]; store: string; date: string | null; currency: string; elapsed_ms: number }
export interface Listing { title: string; description: string; price: number; currency: string; platform: Platform }
export interface AskFilters {
  q: string;
  types: string[];
  rarities: string[];
  min_value: number;
  max_value: number;
  sort: Sort;
  flag: Flag | '';
}
export interface ShopeeStatus {
  available: boolean; // login can be started (service runs on this machine)
  connected: boolean;
  state: 'idle' | 'waiting' | 'done' | 'error';
  message: string;
}
export interface AiConfig {
  base_url: string;
  model: string;
  provider: 'openai' | 'anthropic'; // detected from the URL: Claude uses its own API
  has_key: boolean;
  source: 'app' | 'env' | 'none'; // where the current values come from
  editable: boolean; // false for non-admin members in accounts mode
}
export interface AiTest { ok: boolean; message: string; models: string[] }
export interface AuthUser { id: string; email: string; name: string }
export interface Household { id: string; name: string; invite_code: string; members: AuthUser[] }
export interface Session { token: string; user: AuthUser; household: { id: string; name: string } }
export interface DetectResult {
  has_item: boolean;
  name: string;
  box: [number, number, number, number] | null; // [ymin, xmin, ymax, xmax], 0-1000
  elapsed_ms: number;
}
export interface ItemList { items: Item[]; total: number; total_value: number; offset: number; limit: number }
export interface Stats {
  total: number;
  total_value: number; // items in the service currency only
  types: Partial<Record<ItemType, number>>;
  flags: Record<Flag, number>;
}
export interface Meta {
  version: string;
  model: string;
  currency: string;
  language: string;
  market: string;
  auth_required: boolean;
  accounts: boolean;
  enums: Record<string, readonly string[]>;
  limits: Record<string, number>;
  features: { price_check: boolean };
}

// ---------------------------------------------------------------- normalize

const str = (v: unknown, max = 200, fallback = ''): string =>
  (typeof v === 'string' ? v.trim() : v == null ? fallback : String(v)).slice(0, max) || fallback;
const num = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(v);
  if (v === null || v === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};
const int = (v: unknown, min: number, max: number, fallback: number) => Math.round(num(v, min, max, fallback));
function oneOf<T extends string>(v: unknown, list: readonly T[], fallback: T): T {
  const up = String(v ?? '').toUpperCase().trim();
  return (list as readonly string[]).includes(up) ? (up as T) : fallback;
}

export function sizeClassFor({ length_cm, width_cm, height_cm }: Dimensions): SizeClass {
  const longest = Math.max(length_cm, width_cm, height_cm);
  if (longest < 8) return 'TINY';
  if (longest < 25) return 'SMALL';
  if (longest < 70) return 'MEDIUM';
  if (longest < 150) return 'LARGE';
  return 'HUGE';
}

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function normalizeSources(list: unknown): PriceSource[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out: PriceSource[] = [];
  for (const s of list as Loose[]) {
    const url = str(s?.url, 500);
    if (!/^https?:\/\//i.test(url)) continue;
    const price = int(s?.price, 0, 1e13, 0);
    if (!price) continue;
    let site = str(s?.site, 60);
    if (!site) {
      try { site = new URL(url).hostname.replace(/^www\./, ''); } catch { continue; }
    }
    out.push({ title: str(s?.title, 160), url, site, price });
    if (out.length === 8) break;
  }
  return out;
}

// Turns raw model output (or user edits) into a safe, complete card.
export function normalizeCard(raw: Loose = {}): Card {
  const dims: Loose = raw.dimensions || {};
  const dimensions: Dimensions = {
    length_cm: +num(dims.length_cm, 0, 10000, 0).toFixed(1),
    width_cm: +num(dims.width_cm, 0, 10000, 0).toFixed(1),
    height_cm: +num(dims.height_cm, 0, 10000, 0).toFixed(1),
  };

  const v: Loose = raw.value || {};
  let min = int(v.min, 0, 1e13, 0);
  let max = int(v.max, 0, 1e13, 0);
  if (max < min) [min, max] = [max, min];
  const typical = int(v.typical, min, Math.max(min, max), Math.round((min + max) / 2));

  const c: Loose = raw.condition || {};
  const abilities: Ability[] = (Array.isArray(raw.abilities) ? raw.abilities : [])
    .slice(0, 2)
    .map((a: Loose) => ({
      name: str(a?.name, 24, 'Mystery Move'),
      power: int(a?.power, 0, 999, 30),
      text: str(a?.text, 160),
    }));
  while (abilities.length < 2) abilities.push({ name: 'Mystery Move', power: 10, text: '' });

  const hasDims = dimensions.length_cm || dimensions.width_cm || dimensions.height_cm;
  return {
    is_item: raw.is_item !== false,
    name: str(raw.name, 40, 'Unknown Item'),
    brand: str(raw.brand, 60),
    model: str(raw.model, 80),
    type: oneOf(raw.type, TYPES, 'OTHER'),
    subcategory: str(raw.subcategory, 60),
    description: str(raw.description, 400),
    color: str(raw.color, 60),
    material: str(raw.material, 60),
    dimensions,
    // Derived from dimensions when known so the label always matches the numbers.
    size_class: hasDims ? sizeClassFor(dimensions) : oneOf(raw.size_class, SIZE_CLASSES, 'SMALL'),
    weight_g: Math.round(num(raw.weight_g, 0, 1e8, 0)),
    condition: {
      score: int(c.score, 0, 100, 75),
      label: oneOf(c.label, CONDITIONS, 'GOOD'),
      notes: str(c.notes, 300),
    },
    value: {
      min,
      max,
      typical,
      new_price: int(v.new_price, 0, 1e13, 0),
      confidence: oneOf(v.confidence, CONFIDENCES, 'LOW'),
      reasoning: str(v.reasoning, 300),
      ...(Array.isArray(v.sources) ? { sources: normalizeSources(v.sources) } : {}),
      ...(typeof v.checked_at === 'string' && !Number.isNaN(Date.parse(v.checked_at))
        ? { checked_at: new Date(v.checked_at).toISOString() } : {}),
    },
    rarity: oneOf(raw.rarity, RARITIES, 'COMMON'),
    abilities,
    tags: (Array.isArray(raw.tags) ? raw.tags : [])
      .map((t: unknown) => str(t, 24).toLowerCase())
      .filter(Boolean)
      .slice(0, 6),
    location_guess: str(raw.location_guess, 60),
  };
}

// Partial update: nested objects are merged, not replaced.
export function mergeCard(prev: Card, patch: Loose): Loose {
  const out: Loose = { ...prev, ...patch };
  for (const k of ['dimensions', 'condition', 'value'] as const) {
    if (patch[k] && typeof patch[k] === 'object') out[k] = { ...prev[k], ...patch[k] };
  }
  return out;
}

// ---------------------------------------------------------------- Shopee price check
// The check runs in the user's own browser: ITEMDEX opens the Shopee search, a bookmarklet reads the
// listings off that page and sends them back. The server only filters and summarizes them.

export const SHOPEE_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*shopee\.co\.id$/;
export const SHOPEE_MESSAGE = 'itemdex-shopee';
export interface ShopeeListing { title: string; price: number; url: string }

export const shopeeQuery = (i: Pick<Card, 'brand' | 'model' | 'name'>) => [i.brand, i.model || i.name].filter(Boolean).join(' ');
// "bekas" = second-hand, so new-price listings rank lower.
export const shopeeSearchUrl = (query: string) => `https://shopee.co.id/search?keyword=${encodeURIComponent(`${query} bekas`)}`;

// Runs in the Shopee page: every link whose text carries an "Rp" price is a product card.
// A string so it can go into a bookmarklet and Playwright's page.evaluate alike.
export const SHOPEE_EXTRACT = `(() => {
  const out = [], seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const text = a.innerText || '';
    const m = /Rp\\s?([\\d.]+)/.exec(text);
    if (!m || seen.has(a.href)) continue;
    const price = Number(m[1].replace(/\\./g, ''));
    const title = text.split('\\n').map((s) => s.trim())
      .filter((l) => l.length > 8 && !/^Rp/.test(l)).sort((x, y) => y.length - x.length)[0];
    if (price && title) { seen.add(a.href); out.push({ title, price, url: a.href }); }
  }
  return out;
})()`;

// Bookmarklet: posts the listings to the ITEMDEX tab that opened Shopee and closes the Shopee tab;
// when Shopee cut that link (or the page was opened by hand) it copies them for pasting instead.
export function shopeeBookmarklet(appOrigin: string): string {
  const code = `(async () => {
  if (!/shopee\\.co\\.id$/.test(location.hostname)) return alert('ITEMDEX: open a Shopee search page first');
  const listings = ${SHOPEE_EXTRACT};
  if (!listings.length) return alert('ITEMDEX: no listings with a price on this page yet. Scroll a bit and try again.');
  const msg = { type: '${SHOPEE_MESSAGE}', listings: listings.slice(0, 120) };
  if (window.opener) {
    try { window.opener.postMessage(msg, ${JSON.stringify(appOrigin)}); alert('ITEMDEX: sent ' + msg.listings.length + ' listings.'); window.close(); return; } catch (e) {}
  }
  const json = JSON.stringify(msg);
  try { await navigator.clipboard.writeText(json); alert('ITEMDEX: copied ' + msg.listings.length + ' listings. Go back to ITEMDEX and press PASTE.'); }
  catch (e) { prompt('ITEMDEX: copy this and paste it in ITEMDEX', json); }
})()`;
  return `javascript:${encodeURIComponent(code.replace(/\n\s*/g, ' '))}`;
}

// Pasted text -> listings. Takes the bookmarklet's JSON, or the plain text of a Shopee search page
// (select all + copy): each "Rp 123.000" is paired with the longest line just above it as the title.
export function parseShopeePaste(text: string): ShopeeListing[] {
  try {
    const j = JSON.parse(text);
    const arr = Array.isArray(j) ? j : j?.listings;
    if (Array.isArray(arr)) return arr;
  } catch { /* plain page text */ }
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const out: ShopeeListing[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const m = /^Rp\s?([\d.]+)/.exec(lines[i]) ?? (lines[i] === 'Rp' ? /^([\d.]+)/.exec(lines[i + 1] ?? '') : null);
    if (!m) continue;
    const price = Number(m[1].replace(/\./g, ''));
    const title = lines.slice(Math.max(0, i - 4), i)
      .filter((l) => l.length > 8 && !/^(Rp|\d)/.test(l) && !/terjual|sold/i.test(l))
      .sort((a, b) => b.length - a.length)[0];
    if (!price || !title || seen.has(`${title}|${price}`)) continue;
    seen.add(`${title}|${price}`);
    out.push({ title, price, url: '' });
  }
  return out;
}
