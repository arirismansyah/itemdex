// Who is playing: just a name typed in the top bar, kept in this browser (no login).
// Sent as X-Player so the server can credit XP, streaks and the leaderboard.

import { useSyncExternalStore } from 'react';

const KEY = 'itemdex.player';
let name = (() => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } })();
const listeners = new Set<() => void>();

export const playerName = () => name;

export function setPlayerName(v: string) {
  name = v.trim().slice(0, 24);
  try { name ? localStorage.setItem(KEY, name) : localStorage.removeItem(KEY); } catch { /* ignore */ }
  listeners.forEach((l) => l());
}

export const usePlayer = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => name);
