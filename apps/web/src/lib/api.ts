// HTTP client + React Query hooks for the ITEMDEX service.
//
// API base: same origin by default. A separately hosted web build can point elsewhere
// with VITE_API_URL at build time, or ?api=https://... once at runtime (remembered).
// API key: open the app once with ?key=YOUR_KEY (remembered in this browser).

import {
  keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient,
} from '@tanstack/react-query';
import type {
  Card, DetectResult, Item, ItemList, Meta, ScanResult, Sort, Source, Stats,
} from '@itemdex/shared';

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
      ...(API_KEY ? { 'X-API-Key': API_KEY } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new ApiError('API key required: open this page once with ?key=YOUR_KEY', 401, 'unauthorized');
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data.code);
  return data as T;
}

// ---------------------------------------------------------------- queries

export interface Health { ok: boolean; llm: boolean; db: boolean; model: string; items: number; version: string }

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

export const useStats = () => useQuery({
  queryKey: ['stats'],
  queryFn: () => api<Stats>('/stats'),
});

export interface ItemFilters { q: string; type: string; sort: Sort }
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

function useItemMutation<V>(fn: (v: V) => Promise<{ item: Item }>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: ({ item }) => {
      qc.setQueryData(['item', item.id], item);
      qc.invalidateQueries({ queryKey: ['items'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export interface NewItem {
  card: Card;
  image: string;
  thumb: string;
  source: Source;
  location: Record<string, unknown>;
}

export const useCreateItem = () =>
  useItemMutation((body: NewItem) => api<{ item: Item }>('/items', { method: 'POST', body }));

export const useUpdateItem = () =>
  useItemMutation(({ id, card }: { id: string; card: Partial<Card> }) =>
    api<{ item: Item }>(`/items/${id}`, { method: 'PATCH', body: { card } }));

export const useMoveItem = () =>
  useItemMutation(({ id, location }: { id: string; location: Record<string, unknown> }) =>
    api<{ item: Item }>(`/items/${id}/location`, { method: 'PUT', body: location }));

export function useDeleteItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/items/${id}`, { method: 'DELETE' }),
    onSuccess: (_r, id) => {
      qc.removeQueries({ queryKey: ['item', id] });
      qc.invalidateQueries({ queryKey: ['items'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export const scan = (body: { images: string[]; hint: string; source: Source }) =>
  api<ScanResult>('/scan', { method: 'POST', body });

export const detect = (image: string, signal?: AbortSignal) =>
  api<DetectResult>('/detect', { method: 'POST', body: { image }, signal });
