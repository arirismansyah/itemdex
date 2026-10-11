// COLLECTION tab: server-side search/filter/sort with infinite scroll.

import { useEffect, useMemo, useRef, useState } from 'react';
import { TYPES, type Item, type ItemType, type Sort } from '@itemdex/shared';
import { useItems, useStats } from '../lib/api';
import { TYPE_META } from '../lib/format';
import { Sound } from '../lib/sound';
import { TradingCard } from './TradingCard';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function CollectionView({ active, onOpen, onGoScan }: {
  active: boolean;
  onOpen: (item: Item) => void;
  onGoScan: () => void;
}) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('new');
  const [type, setType] = useState<'ALL' | ItemType>('ALL');
  const q = useDebounced(search.trim(), 250);
  const stats = useStats();
  const filters = useMemo(() => ({ q, sort, type }), [q, sort, type]);
  const items = useItems(filters, active);
  const sentinel = useRef<HTMLDivElement>(null);

  const typeCounts = stats.data?.types ?? {};
  const total = stats.data?.total ?? 0;
  useEffect(() => {
    if (type !== 'ALL' && stats.data && !typeCounts[type]) setType('ALL');
  }, [stats.data, type, typeCounts]);

  // Load the next page when the sentinel scrolls into view.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = items;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !active) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) void fetchNextPage();
    }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [active, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const list = items.data?.pages.flatMap((p) => p.items) ?? [];
  const matched = items.data?.pages[0]?.total ?? 0;
  const presentTypes = TYPES.filter((t) => typeCounts[t]);

  return (
    <section className={`view view-collection${active ? ' active' : ''}`} aria-hidden={!active}>
      <div className="toolbar panel">
        <label className="search">
          <span aria-hidden="true">?</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="SEARCH NAME, TAG, OR WHERE IT IS..."
            aria-label="Search"
            type="search"
          />
        </label>
        <select value={sort} onChange={(e) => { Sound.play('click'); setSort(e.target.value as Sort); }} aria-label="Sort">
          <option value="new">NEWEST</option>
          <option value="value">VALUE ▼</option>
          <option value="rarity">RARITY ▼</option>
          <option value="name">NAME A-Z</option>
          <option value="number">NO. #</option>
        </select>
        <div className="type-filter">
          {(['ALL', ...presentTypes] as const).map((t) => (
            <button
              key={t}
              className={`chip${t === type ? ' active' : ''}${t !== 'ALL' ? ` type-${t}` : ''}`}
              onClick={() => { Sound.play('click'); setType(t); }}
            >
              {t === 'ALL' ? 'ALL' : `${TYPE_META[t].icon} ${TYPE_META[t].label}`}
              <small>{t === 'ALL' ? total : typeCounts[t]}</small>
            </button>
          ))}
        </div>
      </div>

      {stats.data && total === 0 ? (
        <div className="empty">
          <div className="empty-ball" aria-hidden="true" />
          <p>YOUR ITEMDEX IS EMPTY</p>
          <button className="btn btn-primary" onClick={onGoScan}>▶ GO CATCH SOME ITEMS</button>
        </div>
      ) : (
        <div className="grid">
          {items.isError && <p className="no-match">COULD NOT LOAD: {(items.error as Error).message}</p>}
          {items.isSuccess && !list.length && <p className="no-match">NO ITEMS MATCH YOUR SEARCH.</p>}
          {list.map((i) => (
            <div className="grid-cell" key={i.id}>
              <TradingCard item={i} image={i.thumb_url} mini onClick={() => onOpen(i)} />
            </div>
          ))}
          <div ref={sentinel} className="grid-sentinel" aria-hidden="true">
            {isFetchingNextPage ? 'LOADING...' : list.length && matched > list.length ? '▼' : ''}
          </div>
        </div>
      )}
    </section>
  );
}
