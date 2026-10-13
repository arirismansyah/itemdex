// Header popovers (AI server, Shopee, household): at most one open at a time.
// Closes on Escape, on a click outside any header menu, and when the view changes.

import { useCallback, useSyncExternalStore } from 'react';

let current: string | null = null;
const listeners = new Set<() => void>();

function set(id: string | null) {
  if (id === current) return;
  current = id;
  listeners.forEach((l) => l());
}

export const closeMenus = () => set(null);

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
  document.addEventListener('pointerdown', (e) => {
    if (current && !(e.target as Element).closest?.('.account')) closeMenus();
  });
}

export function useMenu(id: string) {
  const open = useSyncExternalStore(subscribe, () => current === id);
  const setOpen = useCallback((v: boolean | ((o: boolean) => boolean)) => {
    const next = typeof v === 'function' ? v(current === id) : v;
    if (next) set(id);
    else if (current === id) set(null);
  }, [id]);
  return [open, setOpen] as const;
}
