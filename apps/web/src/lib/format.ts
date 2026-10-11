// Display helpers shared by cards, the collection and the detail view.

import type { Dimensions, ItemLocation, ItemType } from '@itemdex/shared';

export const TYPE_META: Record<ItemType, { icon: string; label: string }> = {
  ELECTRONIC: { icon: '⚡', label: 'ELECTRIC' },
  FASHION: { icon: '✿', label: 'FASHION' },
  BOOK: { icon: '✎', label: 'BOOK' },
  TOY: { icon: '♣', label: 'TOY' },
  HOME: { icon: '⌂', label: 'HOME' },
  KITCHEN: { icon: '♨', label: 'KITCHEN' },
  SPORT: { icon: '✊', label: 'SPORT' },
  TOOL: { icon: '⚒', label: 'TOOL' },
  COLLECTIBLE: { icon: '♛', label: 'COLLECT' },
  BEAUTY: { icon: '❀', label: 'BEAUTY' },
  VEHICLE: { icon: '➤', label: 'VEHICLE' },
  MUSIC: { icon: '♫', label: 'MUSIC' },
  OFFICE: { icon: '✉', label: 'OFFICE' },
  OTHER: { icon: '✦', label: 'NORMAL' },
};

let currency = 'IDR';
const formatters = new Map<string, Intl.NumberFormat>();
export const setCurrency = (c?: string) => { currency = c || 'IDR'; };

export function money(n: number, { compact = true } = {}): string {
  if (!n) return '-';
  const key = `${currency}|${compact}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(currency === 'IDR' ? 'id-ID' : 'en-US', {
      style: 'currency',
      currency,
      notation: compact ? 'compact' : 'standard',
      maximumFractionDigits: compact ? 1 : 0,
    });
    formatters.set(key, f);
  }
  return f.format(n);
}

export const date = (iso: string) => new Date(iso).toLocaleDateString('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric',
}).toUpperCase();

export function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return date(iso);
}

export function dims(d?: Dimensions): string {
  if (!d || !(d.length_cm || d.width_cm || d.height_cm)) return '?';
  const f = (n: number) => (n >= 100 ? Math.round(n) : +n.toFixed(1));
  return `${f(d.length_cm)}×${f(d.width_cm)}×${f(d.height_cm)}cm`;
}

export function weight(g: number): string {
  if (!g) return '?';
  return g >= 1000 ? `${+(g / 1000).toFixed(1)}kg` : `${g}g`;
}

export function placeLabel(loc?: Partial<ItemLocation> | null): string {
  if (!loc) return '';
  return loc.place || loc.address || (loc.lat != null && loc.lng != null ? `${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}` : '');
}

export const mapUrl = (loc: { lat: number | null; lng: number | null }) =>
  `https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lng}#map=18/${loc.lat}/${loc.lng}`;

export const pad = (n?: number) => (n ? String(n).padStart(3, '0') : '???');
