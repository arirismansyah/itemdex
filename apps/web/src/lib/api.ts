// HTTP client + React Query hooks for the ITEMDEX service.
//
// API base: same origin by default. A separately hosted web build can point elsewhere
// with VITE_API_URL at build time, or ?api=https://... once at runtime (remembered).
// API key: open the app once with ?key=YOUR_KEY (remembered in this browser).

import { useSyncExternalStore } from 'react';
import {
  keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient,
} from '@tanstack/react-query';
import type {
  AiConfig, AiTest, AskFilters, Card, DetectResult, Household, InvoiceResult, Item, ItemList, Listing, Meta, Platform, PriceCheck,
  PriceCheckResult, RoomResult, ScanResult, Session, ShopeeListing, ShopeeStatus, Sort, Source, Stats,
} from '@itemdex/shared';
import { localeBody } from './locale';
import { playerName } from './player';

function remembered(param: string, storageKey: string): string {
  try {
    const url = new URL(window.location.href);
    const v = url.searchParams.get(param);
    if (v) {
      localStorage.setItem(storageKey, v);
      url.searchParams.delete(param);
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
    return localStorage.getItem(storageKey) || '';
  } catch {
    return '';
  }
}

const API_KEY = remembered('key', 'itemdex.key');
const API_BASE = (remembered('api', 'itemdex.api') || import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');

// Account session (only when the service runs with ACCOUNTS=true).
let token = (() => { try { return localStorage.getItem('itemdex.token') || ''; } catch { return ''; } })();
const tokenListeners = new Set<() => void>();
export function setToken(t: string) {
  token = t;
  try { t ? localStorage.setItem('itemdex.token', t) : localStorage.removeItem('itemdex.token'); } catch { /* ignore */ }
  tokenListeners.forEach((l) => l());
}
export const useToken = () => useSyncExternalStore(
  (l) => { tokenListeners.add(l); return () => tokenListeners.delete(l); },
  () => token,
);

const authHeaders = (): Record<string, string> => ({
  ...(token ? { Authorization: `Bearer ${token}` } : API_KEY ? { 'X-API-Key': API_KEY } : {}),
  ...(playerName() ? { 'X-Player': playerName() } : {}),
});

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(`${API_BASE}/api/v1${path}`, {
    method: opts.method || 'GET',
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...authHeaders(),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) {
    setToken(''); // expired session -> back to the sign-in screen
    throw new ApiError('Session expired, sign in again', 401, 'unauthorized');
  }
  if (res.status === 401) throw new ApiError('API key required: open this page once with ?key=YOUR_KEY', 401, 'unauthorized');
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data.code);
  return data as T;
}

// ---------------------------------------------------------------- queries

export interface Health {
  ok: boolean; llm: boolean; db: boolean; model: string; items: number; version: string;
  search: boolean | null; // null = price check not configured
}

export const useHealth = () => useQuery({
  queryKey: ['health'],
  queryFn: () => api<Health>('/health'),
  refetchInterval: 30_000,
  retry: false,
});

export const useMeta = () => useQuery({
  queryKey: ['meta'],
  queryFn: () => api<Meta>('/meta'),
  staleTime: Infinity,
});

export const useStats = (enabled = true) => useQuery({
  queryKey: ['stats'],
  enabled,
  queryFn: () => api<Stats>('/stats'),
});

export interface ItemFilters {
  q: string;
  type: string; // 'ALL' or comma-separated types
  rarity: string;
  sort: Sort;
  min: number;
  max: number;
  flag: string;
}
const PAGE = 48;

export const useItems = (f: ItemFilters, enabled = true) => useInfiniteQuery({
  queryKey: ['items', f],
  enabled,
  initialPageParam: 0,
  placeholderData: keepPreviousData,
  queryFn: ({ pageParam, signal }) => {
    const qs = new URLSearchParams({ sort: f.sort, offset: String(pageParam), limit: String(PAGE) });
    if (f.q) qs.set('q', f.q);
    if (f.type !== 'ALL') qs.set('type', f.type);
    if (f.rarity) qs.set('rarity', f.rarity);
    if (f.min) qs.set('min_value', String(f.min));
    if (f.max) qs.set('max_value', String(f.max));
    if (f.flag) qs.set('flag', f.flag);
    return api<ItemList>(`/items?${qs}`, { signal });
  },
  getNextPageParam: (last) => (last.offset + last.items.length < last.total ? last.offset + last.items.length : undefined),
});

export const useItem = (id: string | null, placeholder?: Item) => useQuery({
  queryKey: ['item', id],
  enabled: !!id,
  queryFn: () => api<{ item: Item }>(`/items/${id}`).then((r) => r.item),
  placeholderData: placeholder,
});

// ---------------------------------------------------------------- mutations

function useItemMutation<V, R extends { item: Item }>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: ({ item }) => {
      qc.setQueryData(['item', item.id], item);
      qc.invalidateQueries({ queryKey: ['items'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      qc.invalidateQueries({ queryKey: ['game'] });
    },
  });
}

export interface NewItem {
  card: Card;
  image: string;
  thumb: string;
  source: Source;
  currency: string;
  location: Record<string, unknown>;
  purchase?: { store: string; date: string | null; price: number };
}

export const useCreateItem = () =>
  useItemMutation((body: NewItem) => api<{ item: Item }>('/items', { method: 'POST', body }));

export const useUpdateItem = () =>
  useItemMutation(({ id, card }: { id: string; card: Partial<Card> }) =>
    api<{ item: Item }>(`/items/${id}`, { method: 'PATCH', body: { card } }));

export const useMoveItem = () =>
  useItemMutation(({ id, location }: { id: string; location: Record<string, unknown> }) =>
    api<{ item: Item }>(`/items/${id}/location`, { method: 'PUT', body: location }));

// Re-checks a saved item's value against web listings (updates it when listings match).
export const useRecheckPrice = () =>
  useItemMutation((id: string) =>
    api<{ item: Item; price_check: PriceCheck }>(`/items/${id}/price-check`, { method: 'POST' }));

export function useDeleteItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/items/${id}`, { method: 'DELETE' }),
    onSuccess: (_r, id) => {
      qc.removeQueries({ queryKey: ['item', id] });
      qc.invalidateQueries({ queryKey: ['items'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      qc.invalidateQueries({ queryKey: ['game'] });
    },
  });
}

export const useLendItem = () =>
  useItemMutation(({ id, to, due }: { id: string; to: string; due: string }) =>
    api<{ item: Item }>(`/items/${id}/lend`, { method: 'PUT', body: { to, due: due || null } }));

export const useReturnItem = () =>
  useItemMutation((id: string) => api<{ item: Item }>(`/items/${id}/lend`, { method: 'DELETE' }));

export const useVerifyPrice = () =>
  useItemMutation((id: string) => api<{ item: Item }>(`/items/${id}/comps`, { method: 'POST' }));

// Screenshots of Shopee search results -> listings to confirm (nothing saved yet).
export type ReadListing = ShopeeListing & { match: boolean };
export const readShopeeShots = (id: string, images: string[]) =>
  api<{ query: string; listings: ReadListing[] }>(`/items/${id}/comps/read`, { method: 'POST', body: { images } });

// Shopee listings read in the user's own browser (bookmarklet or pasted page).
export const useSendShopee = () =>
  useItemMutation(({ id, listings }: { id: string; listings: ShopeeListing[] }) =>
    api<{ item: Item }>(`/items/${id}/comps`, { method: 'POST', body: { listings } }));

export const useReceipt = () =>
  useItemMutation(({ id, image }: { id: string; image: string }) =>
    api<{ item: Item }>(`/items/${id}/receipt`, { method: 'POST', body: { image } }));

export const makeListing = (id: string, platform: Platform) =>
  api<{ listing: Listing }>(`/items/${id}/listing`, { method: 'POST', body: { platform, locale: localeBody() } })
    .then((r) => r.listing);

export const scan = (body: { images: string[]; hint: string; source: Source }) =>
  api<ScanResult>('/scan', { method: 'POST', body: { ...body, locale: localeBody() } });

export const scanRoom = (image: string, hint: string) =>
  api<RoomResult>('/scan/room', { method: 'POST', body: { image, hint, locale: localeBody() } });

export const scanPdf = (pdf: string, hint: string) =>
  api<InvoiceResult>('/scan/pdf', { method: 'POST', body: { pdf, hint, locale: localeBody() } });

export const ask = (query: string) =>
  api<{ filters: AskFilters }>('/ask', { method: 'POST', body: { query, locale: localeBody() } }).then((r) => r.filters);

// Checks an unsaved card's value against web listings (~4s).
export const priceCheck = (card: Card) =>
  api<PriceCheckResult>('/price-check', { method: 'POST', body: { card, locale: localeBody() } });

export const detect = (image: string, signal?: AbortSignal) =>
  api<DetectResult>('/detect', { method: 'POST', body: { image }, signal });

// Shopee session for price checks. Polls while the login window is open.
export function useShopee() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['shopee'],
    queryFn: () => api<ShopeeStatus>('/shopee'),
    refetchInterval: (query) => (query.state.data?.state === 'waiting' ? 2000 : false),
    staleTime: 30_000,
  });
  const set = (r: ShopeeStatus) => qc.setQueryData(['shopee'], r);
  return {
    ...q,
    connect: () => api<ShopeeStatus>('/shopee/login', { method: 'POST' }).then(set),
    disconnect: () => api<ShopeeStatus>('/shopee', { method: 'DELETE' }).then(set),
  };
}

// AI server connection (URL, key, model).
type AiForm = { base_url: string; model: string; api_key?: string; clear_key?: boolean };

export const useAiConfig = () => useQuery({
  queryKey: ['ai-config'],
  queryFn: () => api<AiConfig>('/settings/ai'),
});

export function useSaveAi() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AiForm) => api<AiConfig>('/settings/ai', { method: 'PUT', body }),
    onSuccess: (cfg) => {
      qc.setQueryData(['ai-config'], cfg);
      void qc.invalidateQueries({ queryKey: ['health'] }); // refresh the AI ONLINE light
    },
  });
}

export const testAi = (body: AiForm) => api<AiTest>('/settings/ai/test', { method: 'POST', body });

// ---------------------------------------------------------------- accounts & reports

export const signIn = (mode: 'login' | 'register', body: Record<string, string>) =>
  api<Session>(`/auth/${mode}`, { method: 'POST', body });

export const signOut = () => api('/auth/logout', { method: 'POST' }).catch(() => undefined);

export const useHousehold = (enabled: boolean) => useQuery({
  queryKey: ['household'],
  enabled,
  queryFn: () => api<{ household: Household }>('/auth/me').then((r) => r.household),
});

// Inventory report: CSV downloads, HTML opens in a new tab and prints (Save as PDF).
export async function downloadReport(format: 'csv' | 'html') {
  const res = await fetch(`${API_BASE}/api/v1/report?format=${format}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Report failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  if (format === 'html') {
    const w = window.open(url, '_blank');
    w?.addEventListener('load', () => w.print());
  } else {
    const a = document.createElement('a');
    a.href = url;
    a.download = 'itemdex-inventory.csv';
    a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------------------------------------------------------------- game

export interface GameState {
  me: { name: string; xp: number; level: number; from: number; to: number; streak: number; karma: number };
  quest: { text: string; goal: number; progress: number; done: boolean; reward: number };
  dex: { types: { name: string; n: number; of: number }[]; rooms: { name: string; n: number; of: number }[]; all: number };
  quality: { average: number; todo: { id: string; name: string; score: number; missing: string[] }[] };
  badges: { id: string; name: string; how: string; got: boolean }[];
  board: { player: string; xp: number; week: number; added: number; karma: number }[];
}
export interface GuessItem { id: string; name: string; thumb_url: string | null; currency: string }
export interface GuessResult { actual: number; off_pct: number; points: number; repeat: boolean }

export const useGame = (enabled = true) => useQuery({
  queryKey: ['game', playerName()],
  enabled,
  queryFn: () => api<GameState>('/game'),
});

export const nextGuess = () => api<{ item: GuessItem | null }>('/game/guess').then((r) => r.item);
export const sendGuess = (id: string, guess: number) =>
  api<GuessResult>('/game/guess', { method: 'POST', body: { id, guess } });
