// App shell: header + HUD, the two tabs (kept mounted so state survives), detail modal.

import { useCallback, useEffect, useState } from 'react';
import type { Item } from '@itemdex/shared';
import { CollectionView } from './components/CollectionView';
import { DetailModal } from './components/DetailModal';
import { Dialog } from './components/Dialog';
import { ScanView } from './components/ScanView';
import { AccountMenu, AuthScreen } from './components/AuthScreen';
import { AiSettings } from './components/AiSettings';
import { ShopeeMenu } from './components/ShopeeMenu';
import { useHealth, useMeta, useStats, useToken } from './lib/api';
import { LOCALES, getLocaleId, setLocaleId } from './lib/locale';
import { say } from './lib/dialog';
import { closeMenus } from './lib/menu';
import { money, setCurrency } from './lib/format';
import { desktop } from './lib/platform';
import { Sound } from './lib/sound';

type View = 'scan' | 'collection';

const initialView = (): View => (window.location.hash === '#collection' ? 'collection' : 'scan');

export function App() {
  const [view, setView] = useState<View>(initialView);
  const [detail, setDetail] = useState<Item | null>(null);
  const [soundOn, setSoundOn] = useState(Sound.enabled);
  const health = useHealth();
  const meta = useMeta();
  const token = useToken();
  const stats = useStats(meta.isSuccess && (!meta.data.accounts || !!token));
  const [localeId, setLocale] = useState(getLocaleId);

  if (meta.data) setCurrency(meta.data.currency);

  const go = useCallback((v: View) => {
    Sound.play('select');
    closeMenus();
    setView(v);
    window.history.replaceState(null, '', v === 'scan' ? window.location.pathname : '#collection');
  }, []);

  const closeDetail = useCallback(() => setDetail(null), []);

  // Greeting once the collection size is known.
  const [greeted, setGreeted] = useState(false);
  useEffect(() => {
    if (greeted) return;
    if (stats.isSuccess) {
      setGreeted(true);
      const n = stats.data.total;
      say(n ? `Welcome back, trainer! You have ${n} items in your ITEMDEX.` : 'Welcome, trainer! Snap a photo of any item to start your ITEMDEX.');
    } else if (stats.isError) {
      setGreeted(true);
      say(`Could not load collection: ${(stats.error as Error).message}`, { sound: 'error', hold: 6000 });
    }
  }, [greeted, stats.isSuccess, stats.isError, stats.data, stats.error]);

  const h = health.data;
  const led = !h ? (health.isError ? ['off', 'SERVICE DOWN'] : ['', 'CONNECTING'])
    : !h.db ? ['off', 'DB OFFLINE']
      : h.llm ? ['on', 'AI ONLINE'] : ['off', 'AI OFFLINE'];

  if (meta.isPending) return <div className="app" />;
  if (meta.data?.accounts && !token) return <AuthScreen />;

  return (
    <div className={`app${desktop ? ` is-desktop platform-${desktop.platform}` : ''}`}>
      <div className="crt" aria-hidden="true" />

      <header className="topbar">
        <div className="logo" title="ITEMDEX: catalog your belongings as collectible cards">
          <span className="logo-mark" aria-hidden="true" />
          <div>
            <h1>ITEMDEX</h1>
            <small>EVERY ITEM, A CARD</small>
          </div>
        </div>

        <nav className="tabs" aria-label="Views">
          <button className={`tab${view === 'scan' ? ' active' : ''}`} onClick={() => go('scan')} aria-current={view === 'scan'} title="Scan new items with the camera or by uploading photos">SCAN</button>
          <button className={`tab${view === 'collection' ? ' active' : ''}`} onClick={() => go('collection')} aria-current={view === 'collection'} title="Browse, search and manage your saved cards">COLLECTION</button>
        </nav>

        <div className="hud">
          <div className="hud-stat" title="Number of items in your collection"><span>ITEMS</span><b>{stats.data?.total ?? 0}</b></div>
          <div className="hud-stat" title="Estimated resale value of everything in your collection (only items priced in the service currency are added)"><span>TOTAL VALUE</span><b>{money(stats.data?.total_value ?? 0)}</b></div>
          <div className={`hud-led ${led[0]}`} title={h ? `Model: ${h.model || 'not set'} · Price search: ${h.search == null ? 'off' : h.search ? 'online' : 'offline'}` : 'AI status'}><i /><span>{led[1]}</span></div>
          <select
            className="locale-select"
            value={localeId}
            onChange={(e) => { setLocaleId(e.target.value); setLocale(e.target.value); Sound.play('click'); }}
            title="Language, currency and market for new scans and listings"
            aria-label="Scan locale"
          >
            <option value="">{meta.data ? `DEFAULT · ${meta.data.currency}` : 'DEFAULT'}</option>
            {LOCALES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
          <AiSettings />
          <ShopeeMenu />
          {meta.data?.accounts && <AccountMenu />}
          <button
            className={`icon-btn${soundOn ? '' : ' off'}`}
            onClick={() => { setSoundOn(Sound.toggle()); Sound.play('click'); }}
            title="Toggle sound"
            aria-label="Toggle sound"
            aria-pressed={soundOn}
          >♪</button>
        </div>
      </header>

      <main>
        <ScanView active={view === 'scan'} keysEnabled={!detail} />
        <CollectionView active={view === 'collection'} onOpen={(i) => { Sound.play('select'); setDetail(i); }} onGoScan={() => go('scan')} />
      </main>

      {/* Phone navigation */}
      <nav className="bottom-nav" aria-label="Views">
        <button className={view === 'scan' ? 'active' : ''} onClick={() => go('scan')} title="Scan new items"><b>◉</b>SCAN</button>
        <button className={view === 'collection' ? 'active' : ''} onClick={() => go('collection')} title="Your collection"><b>▦</b>DEX</button>
      </nav>

      {detail && <DetailModal key={detail.id} initial={detail} onClose={closeDetail} />}
      <Dialog />
    </div>
  );
}
