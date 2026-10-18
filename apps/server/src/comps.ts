// Price check on Shopee Indonesia. Two ways in:
// - in the user's browser (default, works for a hosted service): the app opens the Shopee search, a bookmarklet
//   reads the listings and the client posts them here; compsFromListings() filters and summarizes them.
// - on this machine (local/desktop only): a headless browser (Playwright) reads the search page, logged in with a
//   session the user saves once through the app. Needs Google Chrome (or `npx playwright-core install chromium`).

import fs from 'node:fs';
import path from 'node:path';
import { SHOPEE_EXTRACT, shopeeSearchUrl, type Comp, type Comps } from '@itemdex/shared';

export interface ShopeeConfig {
  state: string; // storageState file holding the login cookies
  discount: number; // listings are asking prices; sold items go for a bit less
  canLogin: boolean; // login opens a window on the machine running the service: local only
}

export type LoginStatus = { state: 'idle' | 'waiting' | 'done' | 'error'; message: string };

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MISSING = 'Price check needs Playwright: npm i playwright-core && npx playwright-core install chromium';

export const connected = (cfg: ShopeeConfig) => fs.existsSync(cfg.state);

// Playwright's own Chromium first, then an installed Chrome or Edge, so the price check works
// even where the Chromium download is blocked (office networks).
async function launch(headless: boolean) {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    throw new Error(MISSING);
  }
  let first: Error | undefined;
  for (const channel of [undefined, 'chrome', 'msedge']) {
    try {
      return await chromium.launch({ headless, channel });
    } catch (e) {
      first ??= e as Error;
    }
  }
  throw new Error(`Cannot start the browser: install Google Chrome or run "npx playwright-core install chromium" (${first!.message.split('\n')[0]})`);
}

export function disconnect(cfg: ShopeeConfig) {
  fs.rmSync(cfg.state, { force: true });
  login = { state: 'idle', message: '' };
}

// ---------------------------------------------------------------- login (one at a time)
let login: LoginStatus = { state: 'idle', message: '' };
export const loginStatus = () => login;

// Opens a visible browser; the user logs in; the session is saved when the login cookie appears.
export async function startLogin(cfg: ShopeeConfig): Promise<void> {
  if (login.state === 'waiting') return;
  const browser = await launch(false);
  login = { state: 'waiting', message: 'Log in to Shopee in the window that opened' };
  void (async () => {
    try {
      const ctx = await browser.newContext({ userAgent: UA, locale: 'id-ID', viewport: { width: 1100, height: 800 } });
      const page = await ctx.newPage();
      await page.goto('https://shopee.co.id/buyer/login');
      for (let i = 0; i < 150; i++) { // 5 minutes
        await page.waitForTimeout(2000);
        const uid = (await ctx.cookies()).find((c) => c.name === 'SPC_U')?.value;
        if (uid && uid !== '-' && !page.url().includes('/login')) {
          fs.mkdirSync(path.dirname(cfg.state), { recursive: true });
          await ctx.storageState({ path: cfg.state });
          fs.chmodSync(cfg.state, 0o600);
          login = { state: 'done', message: 'Shopee connected' };
          return;
        }
      }
      login = { state: 'error', message: 'Login timed out' };
    } catch {
      login = { state: 'error', message: 'Login window was closed before finishing' };
    } finally {
      await browser.close().catch(() => {});
    }
  })();
}

// ---------------------------------------------------------------- prices
const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

export function summarize(query: string, listings: Comp[], at = new Date().toISOString()): Comps {
  const mid = quantile(listings.map((l) => l.price).sort((a, b) => a - b), 0.5);
  // Drop accessories (far below) and bundles/parts lots (far above) before taking the range.
  const kept = listings.filter((l) => l.price >= mid * 0.3 && l.price <= mid * 3);
  const prices = kept.map((l) => l.price).sort((a, b) => a - b);
  return {
    query, engine: 'shopee', n: kept.length, median: Math.round(quantile(prices, 0.5)),
    low: Math.round(quantile(prices, 0.25)), high: Math.round(quantile(prices, 0.75)),
    sources: kept.slice(0, 8), at,
  };
}

// At least half the query words must appear in the title, otherwise it is a different product.
export function matcher(query: string) {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
  const need = Math.ceil(words.length / 2);
  return (title: string) => words.filter((w) => title.toLowerCase().includes(w)).length >= need;
}

// Raw listings (from the bookmarklet, pasted text or Playwright) -> Comps, or null when none match.
// Untrusted input: only titles, whole prices and shopee.co.id links survive.
export function compsFromListings(query: string, raw: unknown, discount: number): Comps | null {
  const search = shopeeSearchUrl(query);
  const matches = matcher(query);
  const listings: Comp[] = [];
  for (const r of (Array.isArray(raw) ? raw : []).slice(0, 200)) {
    const title = typeof r?.title === 'string' ? r.title.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    const price = Math.round(Number(r?.price));
    if (!title || !Number.isFinite(price) || price < 1000 || price > 1e11) continue;
    if (!matches(title)) continue;
    let url = search;
    try {
      const u = new URL(String(r?.url));
      if (u.protocol === 'https:' && /(^|\.)shopee\.co\.id$/.test(u.hostname)) url = u.href;
    } catch { /* no link: point at the search */ }
    listings.push({ title, price: Math.round(price * discount), url, site: 'shopee' });
  }
  return listings.length ? summarize(query, listings) : null;
}

export async function fetchComps(query: string, cfg: ShopeeConfig): Promise<Comps | null> {
  if (!connected(cfg)) throw new Error('Shopee is not connected');
  const browser = await launch(true);
  try {
    const ctx = await browser.newContext({
      storageState: cfg.state, userAgent: UA, locale: 'id-ID', viewport: { width: 1280, height: 1600 },
    });
    const page = await ctx.newPage();
    await page.goto(shopeeSearchUrl(query), {
      waitUntil: 'domcontentloaded', timeout: 25_000,
    });
    await page.waitForTimeout(4000);
    if (/\/(buyer\/login|verify)/.test(page.url())) {
      disconnect(cfg); // the saved session expired: show Shopee as not connected
      throw new Error('Shopee asked to log in again: reconnect Shopee from the menu');
    }
    await page.mouse.wheel(0, 1500); // lazy-loaded cards
    await page.waitForTimeout(1500);
    return compsFromListings(query, await page.evaluate(SHOPEE_EXTRACT), cfg.discount);
  } finally {
    await browser.close();
  }
}
