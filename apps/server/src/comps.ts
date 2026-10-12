// Price check on Shopee Indonesia: reads the public search page with a headless browser (Playwright),
// logged in with a session the user saves once through the app (Shopee blocks anonymous browsers).
// Needs `npx playwright-core install chromium`. Without a saved session the feature is off and
// values stay the AI estimates.

import fs from 'node:fs';
import path from 'node:path';
import type { Comp, Comps } from '@itemdex/shared';

export interface ShopeeConfig {
  state: string; // storageState file holding the login cookies
  discount: number; // listings are asking prices; sold items go for a bit less
  canLogin: boolean; // login opens a window on the machine running the service: local only
}

export type LoginStatus = { state: 'idle' | 'waiting' | 'done' | 'error'; message: string };

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MISSING = 'Price check needs Playwright: npm i playwright-core && npx playwright-core install chromium';

export const connected = (cfg: ShopeeConfig) => fs.existsSync(cfg.state);

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
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    throw new Error(MISSING);
  }
  const browser = await chromium.launch({ headless: false }).catch((e: Error) => {
    throw new Error(`Cannot open the browser: run "npx playwright-core install chromium" (${e.message.split('\n')[0]})`);
  });
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

// Runs in the page: every link whose text carries an "Rp" price is a product card.
// Passed as a string so the server's TypeScript needs no DOM types.
const EXTRACT = `(() => {
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

export async function fetchComps(query: string, cfg: ShopeeConfig): Promise<Comps | null> {
  if (!connected(cfg)) throw new Error('Shopee is not connected');
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    throw new Error(MISSING);
  }
  const browser = await chromium.launch({ headless: true }).catch((e: Error) => {
    throw new Error(`Cannot start the browser: run "npx playwright-core install chromium" (${e.message.split('\n')[0]})`);
  });
  // At least half the query words must appear in the title, otherwise it is a different product.
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
  const need = Math.ceil(words.length / 2);
  try {
    const ctx = await browser.newContext({
      storageState: cfg.state, userAgent: UA, locale: 'id-ID', viewport: { width: 1280, height: 1600 },
    });
    const page = await ctx.newPage();
    // "bekas" = second-hand, so new-price listings rank lower.
    await page.goto(`https://shopee.co.id/search?keyword=${encodeURIComponent(`${query} bekas`)}`, {
      waitUntil: 'domcontentloaded', timeout: 25_000,
    });
    await page.waitForTimeout(4000);
    if (/\/(buyer\/login|verify)/.test(page.url())) {
      throw new Error('Shopee asked to log in again: reconnect Shopee from the menu');
    }
    await page.mouse.wheel(0, 1500); // lazy-loaded cards
    await page.waitForTimeout(1500);
    const found = (await page.evaluate(EXTRACT)) as Omit<Comp, 'site'>[];
    const listings: Comp[] = found
      .filter((c) => words.filter((w) => c.title.toLowerCase().includes(w)).length >= need)
      .map((c) => ({ ...c, site: 'shopee', title: c.title.slice(0, 120), price: Math.round(c.price * cfg.discount) }));
    return listings.length ? summarize(query, listings) : null;
  } finally {
    await browser.close();
  }
}
