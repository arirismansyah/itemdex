// Card language / currency / market the user scans in. Sent with scan, listing and search requests.
// The service default (from /meta) is used until the user picks something else.

export interface LocalePreset { id: string; label: string; language: string; currency: string; market: string }

export const LOCALES: LocalePreset[] = [
  { id: 'id', label: 'ID · Bahasa · IDR', language: 'Indonesian', currency: 'IDR', market: 'Indonesian' },
  { id: 'us', label: 'US · English · USD', language: 'English', currency: 'USD', market: 'US' },
  { id: 'sg', label: 'SG · English · SGD', language: 'English', currency: 'SGD', market: 'Singapore' },
  { id: 'my', label: 'MY · Malay · MYR', language: 'Malay', currency: 'MYR', market: 'Malaysian' },
  { id: 'jp', label: 'JP · Japanese · JPY', language: 'Japanese', currency: 'JPY', market: 'Japanese' },
  { id: 'in', label: 'IN · English · INR', language: 'English', currency: 'INR', market: 'Indian' },
  { id: 'au', label: 'AU · English · AUD', language: 'English', currency: 'AUD', market: 'Australian' },
];

const KEY = 'itemdex.locale';
export const getLocaleId = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
export const setLocaleId = (id: string) => { try { id ? localStorage.setItem(KEY, id) : localStorage.removeItem(KEY); } catch { /* ignore */ } };

// undefined = let the service use its defaults.
export function localeBody() {
  const p = LOCALES.find((l) => l.id === getLocaleId());
  return p && { language: p.language, currency: p.currency, market: p.market };
}
