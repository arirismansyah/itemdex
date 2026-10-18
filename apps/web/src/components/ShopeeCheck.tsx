// Shopee price check in the user's own browser: open the Shopee search, then bring the prices back with
// screenshots (read by the AI, best on phones), the ITEMDEX bookmark (postMessage) or pasted page text.

import { useEffect, useRef, useState } from 'react';
import {
  SHOPEE_MESSAGE, SHOPEE_ORIGIN, parseShopeePaste, shopeeBookmarklet, shopeeQuery, shopeeSearchUrl,
  type Item, type ShopeeListing,
} from '@itemdex/shared';
import { readShopeeShots, useSendShopee, type ReadListing } from '../lib/api';
import { say } from '../lib/dialog';
import { money } from '../lib/format';
import { imageFileToDataUrl } from '../lib/media';

// Drag-to-bookmarks link. React refuses javascript: hrefs, so it is set on the element directly.
export function ShopeeBookmarklet() {
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => { ref.current?.setAttribute('href', shopeeBookmarklet(window.location.origin)); }, []);
  return (
    <a ref={ref} className="btn btn-small btn-accent bookmarklet" draggable
      onClick={(e) => { e.preventDefault(); say('Drag this button onto your bookmarks bar (don\'t click it here).'); }}
      title="Drag me to your bookmarks bar">★ ITEMDEX</a>
  );
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const isTouch = () => window.matchMedia('(hover: none)').matches;
const SHOT_SIDE = 2000; // screenshots keep small price text readable

// What "add the bookmark" means, step by step, plus copy-the-link for when dragging is not possible.
export function BookmarkletSetup() {
  const copy = () => navigator.clipboard.writeText(shopeeBookmarklet(window.location.origin))
    .then(() => say('Link copied. Add a new bookmark and paste it as the URL.', { sound: 'select' }))
    .catch(() => say('Clipboard is blocked: drag the button instead.', { sound: 'error' }));
  // Phones have no bookmarks bar to drag onto.
  if (isTouch()) {
    return <p className="small muted">On a phone there is no bookmarks bar: in the item, use <b>PASTE INSTEAD</b> (copy the Shopee search page and paste it).</p>;
  }
  return (
    <div className="bm-setup">
      <div className="bm-drag">
        <ShopeeBookmarklet />
        <span className="bm-hint">⇡ drag to the bookmarks bar</span>
      </div>
      <ol className="bm-steps">
        <li>Show the bookmarks bar: <kbd>{isMac ? '⌘ ⇧ B' : 'Ctrl Shift B'}</kbd></li>
        <li>Drag the red <b>★ ITEMDEX</b> button onto that bar. Done, only once.</li>
        <li>On a Shopee search page, click that bookmark: the prices go back to ITEMDEX.</li>
      </ol>
      <details className="bm-alt">
        <summary>Can&apos;t drag?</summary>
        <p className="small muted">Copy the link, add a new bookmark (right-click the bookmarks bar → Add page), name it ITEMDEX and paste the link as its URL.</p>
        <button className="btn btn-small" onClick={copy}>⎘ COPY BOOKMARK LINK</button>
      </details>
    </div>
  );
}

export function ShopeeCheck({ item, onDone }: { item: Item; onDone: () => void }) {
  const send = useSendShopee();
  const [paste, setPaste] = useState('');
  const query = shopeeQuery(item);

  const submit = async (listings: ShopeeListing[]) => {
    if (!listings.length) return say('No listings with a price found in that text.', { sound: 'error' });
    try {
      const { item: next } = await send.mutateAsync({ id: item.id, listings });
      const n = next.comps?.n ?? 0;
      say(n >= 3 ? `Price updated from ${n} Shopee listings.` : `Only ${n} matching listing(s), value kept.`, { sound: 'select' });
      setPaste('');
      onDone();
    } catch (err) {
      say((err as Error).message, { sound: 'error', hold: 6000 });
    }
  };
  const latest = useRef(submit);
  latest.current = submit;

  // Listings posted by the bookmarklet from the Shopee tab this view opened.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!SHOPEE_ORIGIN.test(e.origin) || e.data?.type !== SHOPEE_MESSAGE || !Array.isArray(e.data.listings)) return;
      window.focus();
      void latest.current(e.data.listings);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Screenshots -> AI reads the cards -> the user confirms which ones to use.
  const [reading, setReading] = useState(false);
  const [review, setReview] = useState<(ReadListing & { on: boolean })[] | null>(null);
  const readShots = async (files: File[]) => {
    if (!files.length) return;
    setReading(true);
    setReview(null);
    try {
      const images = await Promise.all(files.slice(0, 4).map((f) => imageFileToDataUrl(f, SHOT_SIDE)));
      const r = await readShopeeShots(item.id, images);
      setReview(r.listings.map((l) => ({ ...l, on: l.match })));
    } catch (err) {
      say((err as Error).message, { sound: 'error', hold: 6000 });
    } finally {
      setReading(false);
    }
  };
  const chosen = review?.filter((l) => l.on) ?? [];

  const fromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setPaste(text);
      await submit(parseShopeePaste(text));
    } catch {
      say('Clipboard is blocked here: paste into the box instead.', { sound: 'error' });
    }
  };

  return (
    <div className="shopee-check">
      <div className="sc-step">
        <b>1</b>
        <div>
          <button className="btn btn-small btn-primary" onClick={() => window.open(shopeeSearchUrl(query), 'itemdex-shopee')}
            title="Opens the Shopee search (on a phone: the Shopee app)">▶ OPEN SHOPEE</button>
          <p className="muted small">Searches “{query} bekas”. Log in if asked.</p>
        </div>
      </div>
      <div className="sc-step">
        <b>2</b>
        <div className="sc-ways">
          <div className="sc-way">
            <h5>📷 SCREENSHOTS</h5>
            <p className="small">Screenshot the results (1–4 screens), come back and upload them. The AI reads the prices.</p>
            <label className={`btn btn-small btn-primary${reading ? ' busy' : ''}`}>
              {reading ? '⟳ AI IS READING...' : '⇪ UPLOAD SCREENSHOTS'}
              <input type="file" accept="image/*" multiple hidden disabled={reading}
                onChange={(e) => { void readShots([...(e.target.files ?? [])]); e.target.value = ''; }} />
            </label>
          </div>
          {!isTouch() && (
            <div className="sc-way">
              <h5>★ BOOKMARK <em>· no AI needed</em></h5>
              <p className="small">On the Shopee tab, click the <b>ITEMDEX</b> bookmark. The prices come back here by themselves.</p>
              <details className="bm-alt"><summary>No bookmark yet?</summary><BookmarkletSetup /></details>
            </div>
          )}
        </div>
      </div>

      {review && (
        <div className="sc-review">
          <h5>FOUND {review.length} LISTING{review.length === 1 ? '' : 'S'} · {chosen.length} WILL BE USED</h5>
          <ul>
            {review.map((l, i) => (
              <li key={i} className={l.match ? '' : 'off'}>
                <label title={l.match ? 'Untick to leave it out' : `Doesn't look like "${query}"`}>
                  <input type="checkbox" checked={l.on} disabled={!l.match}
                    onChange={() => setReview(review.map((x, j) => (j === i ? { ...x, on: !x.on } : x)))} />
                  <span className="sc-title">{l.title}</span>
                  <b>{money(l.price, { currency: 'IDR', compact: false })}</b>
                </label>
                {!l.match && <small>other product</small>}
              </li>
            ))}
          </ul>
          {!review.some((l) => l.match)
            ? <p className="small muted">None of these look like “{query}”. Do the screenshots show the search from step 1?</p>
            : chosen.length < 3 && <p className="small muted">The value changes with 3+ listings. Add another screenshot to get more.</p>}
          <div className="price-actions">
            <button className="btn btn-small" onClick={() => setReview(null)}>✕ CANCEL</button>
            <button className="btn btn-small btn-primary" disabled={!chosen.length || send.isPending}
              onClick={() => submit(chosen.map(({ title, price, url }) => ({ title, price, url })))}>
              {send.isPending ? '⟳ SAVING...' : `✔ USE ${chosen.length} PRICE${chosen.length === 1 ? '' : 'S'}`}
            </button>
          </div>
        </div>
      )}

      <details className="bm-alt">
        <summary>Or paste the page text</summary>
        <p className="muted small">On the Shopee website select all and copy (or use the bookmark&apos;s copied text), then paste here.</p>
        <textarea rows={3} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Paste the Shopee page here" />
        <div className="price-actions">
          <button className="btn btn-small" onClick={fromClipboard} disabled={send.isPending}>⎘ PASTE FROM CLIPBOARD</button>
          <button className="btn btn-small btn-primary" onClick={() => submit(parseShopeePaste(paste))} disabled={send.isPending || !paste.trim()}>
            {send.isPending ? '⟳ CHECKING...' : '✔ USE PASTED TEXT'}
          </button>
        </div>
      </details>
    </div>
  );
}
