// Detail-view blocks beyond the card: price check + history, lent out, receipt/warranty, sale listing.

import { useRef, useState, type FormEvent } from 'react';
import { PLATFORMS, type Item, type Listing, type Platform, type ValuePoint } from '@itemdex/shared';
import {
  makeListing, useLendItem, useMeta, useReceipt, useRecheckPrice, useReturnItem, useShopee, useVerifyPrice,
} from '../lib/api';
import { say } from '../lib/dialog';
import { ago, date, money } from '../lib/format';
import { imageFileToDataUrl } from '../lib/media';

const today = () => new Date().toISOString().slice(0, 10);
const fail = (err: unknown) => say((err as Error).message, { sound: 'error' });

function Sparkline({ points }: { points: ValuePoint[] }) {
  if (points.length < 2) return null;
  const vals = points.map((p) => p.typical);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const t0 = new Date(points[0].at).getTime(), span = new Date(points[points.length - 1].at).getTime() - t0 || 1;
  const xy = points.map((p) => {
    const x = ((new Date(p.at).getTime() - t0) / span) * 200;
    const y = 36 - (hi === lo ? 0.5 : (p.typical - lo) / (hi - lo)) * 32;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg className="spark" viewBox="0 -2 200 42" role="img" aria-label={`Value history, ${points.length} points`}>
      <polyline points={xy.join(' ')} fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx={xy[xy.length - 1].split(',')[0]} cy={xy[xy.length - 1].split(',')[1]} r="3" fill="currentColor" />
    </svg>
  );
}

export function ValueBlock({ item }: { item: Item }) {
  const shopee = useShopee();
  const verify = useVerifyPrice();
  const recheck = useRecheckPrice();
  const priceOn = !!useMeta().data?.features?.price_check;
  const v = item.value;
  const cur = item.currency;
  const c = item.comps;
  const web = v.sources || [];
  const basis = web.length
    ? `WEB · ${web.length} LISTING${web.length === 1 ? '' : 'S'}`
    : c && v.reasoning.includes('Shopee') ? 'SHOPEE' : 'AI ESTIMATE';

  const check = async () => {
    try {
      const { item: next } = await verify.mutateAsync(item.id);
      const n = next.comps?.n ?? 0;
      say(n >= 3 ? `Price updated from ${n} Shopee listings.` : `Only ${n} listings found, value kept.`, { sound: 'select' });
    } catch (err) { fail(err); }
  };

  // Web search (SearXNG) check: the value changes only when listings of the same product were found.
  const checkWeb = async () => {
    try {
      const { item: next, price_check: r } = await recheck.mutateAsync(item.id);
      if (r.status === 'grounded') {
        say(`Market check: ${r.used} matching listing(s). Typical ${money(next.value.typical, { currency: cur })}.`, { sound: 'select' });
      } else if (r.status === 'error') {
        say(`Price search failed: ${r.error || 'unknown error'}`, { sound: 'error' });
      } else {
        say(`No matching listings found for "${r.query}". Value unchanged.`, { sound: 'error' });
      }
    } catch (err) { fail(err); }
  };

  return (
    <section className="info-sec value-sec" title="Estimated resale value and how it changed over time">
      <h4>
        MARKET VALUE <em>({basis} · {v.confidence} CONFIDENCE)</em>
        {item.sell_now && <b className="flag-sell inline">SELL NOW</b>}
      </h4>
      <p className="big-value">{money(v.typical, { compact: false, currency: cur })}</p>
      <p className="range">
        RANGE {money(v.min, { currency: cur })} – {money(v.max, { currency: cur })}
        {v.new_price ? ` · NEW ${money(v.new_price, { currency: cur })}` : ''}
      </p>
      {v.reasoning && <p className="muted">{v.reasoning}</p>}
      <Sparkline points={item.value_history} />
      {item.value_history.length > 1 && (
        <p className="muted small">
          {item.value_history.length} price points since {date(item.value_history[0].at)}
        </p>
      )}
      {c && (
        <ul className="history">
          {c.sources.slice(0, 4).map((s) => (
            <li key={s.url}>
              <span><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a></span>
              <em>{money(s.price, { currency: cur })}</em>
            </li>
          ))}
        </ul>
      )}
      {web.length > 0 && (
        <ul className="price-sources">
          {web.map((src) => (
            <li key={src.url}>
              <a href={src.url} target="_blank" rel="noopener noreferrer" title={src.title}>
                <span className="ps-site">{src.site}</span>
                <span className="ps-title">{src.title}</span>
                <b>{money(src.price, { currency: cur })}</b>
              </a>
            </li>
          ))}
        </ul>
      )}
      {(v.checked_at || priceOn) && (
        <div className="price-foot">
          {v.checked_at && <span className="muted">Checked {ago(v.checked_at)}</span>}
          {priceOn && (
            <button className="btn btn-small" onClick={checkWeb} disabled={recheck.isPending} title="Search the web for second-hand listings of this item and ground the value in them">
              {recheck.isPending ? '⟳ CHECKING...' : '↻ CHECK MARKET PRICE'}
            </button>
          )}
        </div>
      )}
      {cur === 'IDR' && shopee.data?.connected && (
        <button className="btn btn-small" onClick={check} disabled={verify.isPending} title="Search Shopee for this item and set the value from real listings (takes about 15 seconds)">
          {verify.isPending ? 'SEARCHING SHOPEE...' : c ? `↻ RE-CHECK ON SHOPEE (${ago(c.at)})` : '⌕ CHECK ON SHOPEE'}
        </button>
      )}
      {cur === 'IDR' && shopee.data && !shopee.data.connected && (
        <p className="muted small">Connect Shopee (🛒 menu) to check this price against real listings.</p>
      )}
    </section>
  );
}

export function LendBlock({ item }: { item: Item }) {
  const lend = useLendItem();
  const back = useReturnItem();
  const [to, setTo] = useState('');
  const [due, setDue] = useState('');
  const l = item.lent;
  const overdue = !!l?.due && l.due < today();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await lend.mutateAsync({ id: item.id, to: to.trim(), due });
      setTo('');
      setDue('');
      say(`${item.name.toUpperCase()} is now with ${to.trim()}.`, { sound: 'select' });
    } catch (err) { fail(err); }
  };
  const returned = async () => {
    try {
      await back.mutateAsync(item.id);
      say(`${item.name.toUpperCase()} is back home!`, { sound: 'select' });
    } catch (err) { fail(err); }
  };

  return (
    <section className="info-sec" title="Track who has borrowed this item">
      <h4>LENT OUT</h4>
      {l ? (
        <>
          <p className="place">
            With {l.to} <em>since {date(l.at)}</em>
          </p>
          {l.due && <p className={overdue ? 'overdue' : 'muted'}>{overdue ? 'OVERDUE · ' : ''}DUE {date(l.due)}</p>}
          <button className="btn btn-small btn-primary" onClick={returned} disabled={back.isPending} title="The item is back with you">✔ RETURNED</button>
        </>
      ) : (
        <form className="move-form" onSubmit={submit}>
          <input value={to} onChange={(e) => setTo(e.target.value)} maxLength={80} placeholder="Lent it to...?" aria-label="Lent to" title="Who has the item now" required />
          <input type="date" value={due} min={today()} onChange={(e) => setDue(e.target.value)} aria-label="Due date" title="Optional return date; after it the item shows as OVERDUE" />
          <button className="btn btn-small" disabled={lend.isPending || !to.trim()} title="Mark the item as lent out">LEND</button>
        </form>
      )}
    </section>
  );
}

export function PurchaseBlock({ item }: { item: Item }) {
  const receipt = useReceipt();
  const input = useRef<HTMLInputElement>(null);
  const p = item.purchase;
  const warrantyLeft = p?.warranty_until ? Math.ceil((new Date(p.warranty_until).getTime() - Date.now()) / 86_400_000) : null;

  const pick = async (file?: File) => {
    if (!file) return;
    try {
      const image = await imageFileToDataUrl(file);
      await receipt.mutateAsync({ id: item.id, image });
      say('Receipt saved.', { sound: 'select' });
    } catch (err) { fail(err); }
  };

  return (
    <section className="info-sec" title="Receipt details and when the warranty ends">
      <h4>PURCHASE &amp; WARRANTY</h4>
      {p ? (
        <>
          <p>{[p.store, p.date && date(p.date), p.price ? money(p.price, { compact: false, currency: item.currency }) : ''].filter(Boolean).join(' · ') || 'Receipt saved'}</p>
          {p.warranty_until && (
            <p className={warrantyLeft !== null && warrantyLeft < 0 ? 'overdue' : 'muted'}>
              {warrantyLeft !== null && warrantyLeft < 0
                ? `WARRANTY ENDED ${date(p.warranty_until)}`
                : `WARRANTY UNTIL ${date(p.warranty_until)} (${warrantyLeft} DAYS)`}
            </p>
          )}
        </>
      ) : <p className="muted">No receipt yet.</p>}
      <button className="btn btn-small" onClick={() => input.current?.click()} disabled={receipt.isPending} title="Photo of the receipt: the AI reads the store, date, price and warranty">
        {receipt.isPending ? 'READING...' : p ? '⇪ REPLACE RECEIPT' : '⇪ SCAN RECEIPT'}
      </button>
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
    </section>
  );
}

export function ListingBlock({ item }: { item: Item }) {
  const [platform, setPlatform] = useState<Platform>('generic');
  const [busy, setBusy] = useState(false);
  const [listing, setListing] = useState<Listing | null>(null);

  const generate = async () => {
    setBusy(true);
    try { setListing(await makeListing(item.id, platform)); } catch (err) { fail(err); } finally { setBusy(false); }
  };
  const copy = async () => {
    if (!listing) return;
    const text = `${listing.title}\n\n${money(listing.price, { compact: false, currency: listing.currency })}\n\n${listing.description}`;
    try {
      await navigator.clipboard.writeText(text);
      say('Listing copied!', { sound: 'select' });
    } catch { fail(new Error('Could not copy, select the text manually.')); }
  };

  return (
    <section className="info-sec" title="Make a ready-to-post sale listing">
      <h4>SELL IT</h4>
      <div className="move-form">
        <select value={platform} onChange={(e) => setPlatform(e.target.value as Platform)} aria-label="Marketplace" title="Where you will post the listing; the text is written in that style">
          {PLATFORMS.map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}
        </select>
        <button className="btn btn-small btn-primary" onClick={generate} disabled={busy} title="Let the AI write a title, description and price for selling this item">{busy ? 'WRITING...' : '✎ WRITE LISTING'}</button>
      </div>
      {listing && (
        <div className="listing">
          <b>{listing.title}</b>
          <p className="big-value">{money(listing.price, { compact: false, currency: listing.currency })}</p>
          <textarea readOnly rows={7} value={listing.description} aria-label="Listing text" />
          <button className="btn btn-small" onClick={copy} title="Copy title, price and description to the clipboard">⧉ COPY</button>
        </div>
      )}
    </section>
  );
}
