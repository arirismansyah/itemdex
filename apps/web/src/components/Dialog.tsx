// RPG-style typewriter dialog box at the bottom of the screen.

import { useEffect, useState } from 'react';
import { closeDialog, useDialog } from '../lib/dialog';
import { Sound } from '../lib/sound';

export function Dialog() {
  const msg = useDialog();
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (!msg) return;
    setShown(0);
    let i = 0;
    let hideTimer = 0;
    const typer = window.setInterval(() => {
      i++;
      setShown(i);
      if (i % 2) Sound.play('type');
      if (i >= msg.text.length) {
        clearInterval(typer);
        hideTimer = window.setTimeout(closeDialog, msg.hold);
      }
    }, 22);
    return () => { clearInterval(typer); clearTimeout(hideTimer); };
  }, [msg]);

  if (!msg) return null;
  return (
    <div className="dialog" onClick={closeDialog} role="status" aria-live="polite">
      <p aria-hidden="true">{msg.text.slice(0, shown)}</p>
      <span className="sr-only">{msg.text}</span>
      <span className="dialog-next" aria-hidden="true">▼</span>
    </div>
  );
}
