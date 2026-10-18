// Header menu: how the Shopee price check works, the ITEMDEX bookmark, and (local service only)
// the saved Shopee login for automatic checks.

import { useEffect, useRef } from 'react';
import { useMenu } from '../lib/menu';
import { useShopee } from '../lib/api';
import { say } from '../lib/dialog';
import { BookmarkletSetup } from './ShopeeCheck';

export function ShopeeMenu() {
  const [open, setOpen] = useMenu('shopee');
  const shopee = useShopee();
  const s = shopee.data;
  const prev = useRef(s?.state);

  // Tell the user when the login window finishes.
  useEffect(() => {
    if (prev.current === 'waiting' && s?.state === 'done') say('Shopee connected! Price checks are on.', { sound: 'select' });
    if (prev.current === 'waiting' && s?.state === 'error') say(s.message, { sound: 'error' });
    prev.current = s?.state;
  }, [s?.state, s?.message]);

  const run = (fn: () => Promise<unknown>) => fn().catch((err: Error) => say(err.message, { sound: 'error', hold: 6000 }));

  return (
    <span className="account">
      <button className="icon-btn" onClick={() => setOpen((o) => !o)} title="Shopee price check" aria-label="Shopee price check" aria-expanded={open}>🛒</button>
      {open && (
        <div className="panel account-panel shopee-panel">
          <h3 className="panel-title">SHOPEE PRICE CHECK</h3>
          <p className="small muted">Checks an item&apos;s value against real Shopee listings. Open an item priced in IDR and press <b>CHECK ON SHOPEE</b>.</p>

          {s?.available && (
            <section className="sp-sec">
              <h4>AUTOMATIC <em>· this computer</em></h4>
              <p className={`sp-status${s.connected ? ' on' : ''}`}>
                <i />{s.state === 'waiting' ? 'Waiting for you to log in in the new window...'
                  : s.connected ? 'Connected: checks run by themselves.' : 'Not connected'}
              </p>
              {!s.connected && s.state !== 'waiting' && <p className="small">Log in once and CHECK ON SHOPEE searches by itself, no bookmark needed.</p>}
              <div className="sp-actions">
                {s.state !== 'waiting' && (
                  <button className="btn btn-small btn-primary" onClick={() => run(shopee.connect)} title="Opens a browser window: log in to Shopee yourself. Only the session is saved, never your password">{s.connected ? '↻ RECONNECT' : '▶ LOG IN TO SHOPEE'}</button>
                )}
                {s.connected && <button className="btn btn-small btn-danger" onClick={() => run(shopee.disconnect)} title="Delete the saved Shopee session">DISCONNECT</button>}
              </div>
              <p className="muted small">Only the session is saved, never your password. Shopee may limit automated use.</p>
            </section>
          )}

          <section className="sp-sec">
            <h4>ON A PHONE</h4>
            <p className="small">Nothing to set up: OPEN SHOPEE, take screenshots of the results, upload them in the item. The AI reads the prices.</p>
          </section>

          <section className="sp-sec">
            <h4>ITEMDEX BOOKMARK <em>· computer browser</em></h4>
            <p className="small">A bookmark that reads the prices off the Shopee page you have open, with your own login.</p>
            <BookmarkletSetup />
          </section>
        </div>
      )}
    </span>
  );
}
