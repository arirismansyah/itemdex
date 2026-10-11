// "Last seen" location parsing + reverse geocoding.

import type { NewLocation } from './repo.js';

const cleanText = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Accepts { place, lat, lng, accuracy_m, source }; returns null when empty.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function cleanLocation(v: any): NewLocation | null {
  if (!v || typeof v !== 'object') return null;
  const lat = Number(v.lat);
  const lng = Number(v.lng);
  const hasGeo = v.lat != null && v.lng != null && Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
  const place = cleanText(v.place, 80);
  if (!place && !hasGeo) return null;
  const acc = Number(v.accuracy_m);
  return {
    place,
    lat: hasGeo ? +lat.toFixed(6) : null,
    lng: hasGeo ? +lng.toFixed(6) : null,
    accuracy_m: hasGeo && v.accuracy_m != null && Number.isFinite(acc) ? Math.round(acc) : null,
    source: hasGeo ? (v.source === 'exif' ? 'exif' : 'device') : 'manual',
    address: '',
  };
}

// Coordinates -> short human-readable address via OpenStreetMap Nominatim.
export async function reverseGeocode(loc: NewLocation | null, enabled: boolean): Promise<NewLocation | null> {
  if (!loc || loc.lat == null || !enabled) return loc;
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat=${loc.lat}&lon=${loc.lng}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ITEMDEX/0.2 (personal catalog app)', 'Accept-Language': 'id,en' },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = (await res.json()) as { address?: Record<string, string>; display_name?: string };
      const a = data.address || {};
      const parts = [a.road, a.suburb || a.village || a.neighbourhood, a.city || a.town || a.county].filter(Boolean);
      loc.address = String(parts.length ? parts.join(', ') : data.display_name || '').slice(0, 160);
    }
  } catch { /* offline: keep raw coordinates */ }
  return loc;
}
