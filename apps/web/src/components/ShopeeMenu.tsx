// Header menu: save (or remove) the Shopee login used for price checks.

import { useEffect, useRef, useState } from 'react';
import { useShopee } from '../lib/api';
import { say } from '../lib/dialog';

export function ShopeeMenu() {
  const [open, setOpen] = useState(false);
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
      <button className={`icon-btn${s?.connected ? '' : ' off'}`} onClick={() => setOpen((o) => !o)} title="Shopee price check" aria-label="Shopee price check" aria-expanded={open}>🛒</button>
      {open && (
        <div className="panel account-panel">
          <b>SHOPEE PRICE CHECK</b>
          <p className="small">
            {s?.state === 'waiting' ? 'Waiting for you to log in in the new window...'
              : s?.connected ? 'Connected. Items priced in IDR can be checked against Shopee listings.'
                : 'Not connected. Values stay the AI estimates.'}
          </p>
          {s && !s.available && <p className="muted small">Connect from the computer that runs ITEMDEX (localhost).</p>}
          {s?.available && s.state !== 'waiting' && (
            <button className="btn btn-small btn-primary" onClick={() => run(shopee.connect)} title="Opens a browser window: log in to Shopee yourself. Only the session is saved, never your password">{s.connected ? '↻ RECONNECT' : '▶ LOG IN TO SHOPEE'}</button>
          )}
          {s?.connected && <button className="btn btn-small btn-danger" onClick={() => run(shopee.disconnect)} title="Delete the saved Shopee session">DISCONNECT</button>}
          <p className="muted small">Only the browser session is saved on this computer, never your password. Use a spare account if you can: Shopee may limit automated use.</p>
        </div>
      )}
    </span>
  );
}
