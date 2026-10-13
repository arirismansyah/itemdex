// Market price check: search the web (self-hosted SearXNG) for second-hand
// listings of the item, pull Rupiah prices out of the result snippets, let
// the AI pick the listings that really are the same product, then re-estimate
// the value from those prices.

import { normalizeCard, type Card, type Locale, type PriceCheck, type PriceSource, type Value } from '@itemdex/shared';
import type { Config } from './config.js';
import type { LlmClient } from './llm.js';

export interface Listing {
  title: string;
  url: string;
  site: string;
  snippet: string;
  prices: number[];
}

const MAX_LISTINGS = 10;
const MARKETPLACES = /(^|\.)(tokopedia|shopee|olx|bukalapak|blibli|lazada|carousell|jualo|facebook|tiktok)\./i;

// "Rp5.750.000", "Rp 6,000,000", "Rp.14.800.000", "Rp4,5 juta", "Rp 349 ribu", "IDR 250k"
const PRICE_RE = /(?:Rp\.?|IDR)\s?(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s?(jt|juta|rb|ribu|k)?\b/gi;

export function extractPrices(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(PRICE_RE)) {
    const [, digits, suffix] = m;
    let n: number;
    if (suffix) {
      const base = /^\d{1,3}(?:[.,]\d{3})+$/.test(digits) ? Number(digits.replace(/[.,]/g, '')) : Number(digits.replace(',', '.'));
      n = base * (/^j/i.test(suffix) ? 1e6 : 1e3);
    } else {
      n = Number(digits.replace(/[.,]/g, ''));
    }
    n = Math.round(n);
    if (n >= 1_000 && n <= 10_000_000_000 && !out.includes(n)) out.push(n);
  }
  return out;
}

// "Apple" + "MacBook (Retina, 12-inch)" -> "Apple MacBook Retina 12-inch bekas harga"
export function buildQuery(card: Pick<Card, 'brand' | 'model' | 'name'>, base = card.model || card.name): string {
  const seen = new Set<string>();
  const words = `${card.brand} ${base}`
    .replace(/[()[\],"]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !seen.has(w.toLowerCase()) && seen.add(w.toLowerCase()));
  return `${words.join(' ').slice(0, 80)} bekas harga`;
}

export class SearchClient {
  constructor(private cfg: Config['search']) {}

  get enabled() { return !!this.cfg.url; }

  async ping(): Promise<boolean | null> {
    if (!this.enabled) return null;
    try {
      const res = await fetch(`${this.cfg.url}/healthz`, { signal: AbortSignal.timeout(4000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listings(query: string): Promise<Listing[]> {
    const qs = new URLSearchParams({ q: query, format: 'json', language: this.cfg.language, categories: 'general' });
    let res: Response;
    try {
      res = await fetch(`${this.cfg.url}/search?${qs}`, { signal: AbortSignal.timeout(this.cfg.timeoutMs) });
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause?.code || (err as Error).message;
      throw new Error(`Cannot reach search at ${this.cfg.url} (${cause})`);
    }
    if (!res.ok) throw new Error(`Search returned HTTP ${res.status}${res.status === 403 ? ' (is the json format enabled?)' : ''}`);
    const data = (await res.json()) as { results?: { url?: string; title?: string; content?: string }[] };

    const seen = new Set<string>();
    const out: Listing[] = [];
    for (const r of data.results || []) {
      if (!r.url || !/^https?:\/\//.test(r.url) || seen.has(r.url)) continue;
      seen.add(r.url);
      const title = String(r.title || '').slice(0, 160);
      const snippet = String(r.content || '').replace(/\s+/g, ' ').slice(0, 260);
      const prices = extractPrices(`${title} ${snippet}`);
      if (!prices.length) continue;
      let site = '';
      try { site = new URL(r.url).hostname.replace(/^www\./, ''); } catch { continue; }
      out.push({ title, url: r.url, site, snippet, prices: prices.slice(0, 6) });
    }
    // Marketplaces first (stable: keeps the engine ranking inside each group).
    return out
      .map((l, i) => ({ l, k: (MARKETPLACES.test(l.site) ? 0 : 1) * 1000 + i }))
      .sort((a, b) => a.k - b.k)
      .map(({ l }) => l);
  }
}

// Runs the whole check. Never throws: failures come back as status "error"
// with the original value untouched, so callers can always use `value`.
export async function checkPrice(
  card: Card,
  search: SearchClient,
  llm: LlmClient,
  locale?: Locale,
): Promise<{ value: Value; price_check: PriceCheck }> {
  const started = Date.now();
  const query = buildQuery(card);
  const done = (status: PriceCheck['status'], extra: Partial<PriceCheck> = {}, value = card.value) => ({
    value,
    price_check: { status, query, listings: 0, used: 0, elapsed_ms: Date.now() - started, ...extra },
  });

  if (!search.enabled) return done('disabled');
  try {
    let listings = await search.listings(query);
    // Too specific? Retry once with the plain card name.
    if (listings.length < 3 && card.model && card.name) {
      const more = await search.listings(buildQuery(card, card.name)).catch(() => []);
      const urls = new Set(listings.map((l) => l.url));
      listings = [...listings, ...more.filter((l) => !urls.has(l.url))];
    }
    listings = listings.slice(0, MAX_LISTINGS);
    if (!listings.length) return done('no_results');

    const raw = await llm.appraise(card, listings, locale);

    // Keep only matches whose price really appears in that listing's text.
    const used: PriceSource[] = [];
    for (const m of Array.isArray(raw.matches) ? raw.matches : []) {
      const l = listings[Number(m?.index)];
      const price = Math.round(Number(m?.price));
      if (!l || !l.prices.some((p) => Math.abs(p - price) <= p * 0.01)) continue;
      if (used.some((u) => u.url === l.url)) continue;
      used.push({ title: l.title, url: l.url, site: l.site, price });
    }
    if (!used.length) return done('no_match', { listings: listings.length });

    const value = normalizeCard({
      ...card,
      value: {
        min: raw.min, max: raw.max, typical: raw.typical,
        new_price: raw.new_price || card.value.new_price,
        // Based on verified matches, not on what the model claims.
        confidence: used.length >= 3 ? 'HIGH' : 'MEDIUM',
        reasoning: raw.reasoning || card.value.reasoning,
        sources: used, checked_at: new Date().toISOString(),
      },
    }).value;
    return done('grounded', { listings: listings.length, used: used.length }, value);
  } catch (err) {
    if ((err as Error).name === 'TimeoutError') return done('error', { error: 'Price check timed out' });
    return done('error', { error: (err as Error).message.slice(0, 200) });
  }
}
