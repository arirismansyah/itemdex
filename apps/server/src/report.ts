// Inventory report for insurance / moving: CSV and a printable HTML page (browser "Save as PDF").

import type { Item } from '@itemdex/shared';

const CSV_HEAD = [
  'No', 'Name', 'Brand', 'Model', 'Type', 'Condition', 'Currency', 'Value min', 'Value typical', 'Value max',
  'New price', 'Length cm', 'Width cm', 'Height cm', 'Weight g', 'Location', 'Purchase date', 'Store',
  'Purchase price', 'Warranty until', 'Lent to', 'Added',
];

// Quotes every cell; a leading = + - @ is neutralized so spreadsheets don't run it as a formula.
const cell = (v: unknown) => `"${String(v ?? '').replace(/^([=+\-@\t\r])/, "'$1").replace(/"/g, '""')}"`;

export function toCsv(items: Item[]): string {
  const rows = items.map((i) => [
    i.number, i.name, i.brand, i.model, i.type, i.condition.label, i.currency, i.value.min, i.value.typical,
    i.value.max, i.value.new_price, i.dimensions.length_cm, i.dimensions.width_cm, i.dimensions.height_cm,
    i.weight_g, i.location?.place || i.location?.address || '', i.purchase?.date, i.purchase?.store,
    i.purchase?.price, i.purchase?.warranty_until, i.lent?.to, i.created_at.slice(0, 10),
  ]);
  return `﻿${[CSV_HEAD, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n: number, cur: string) => `${esc(cur)} ${n.toLocaleString('en-US')}`;

export function toHtml(items: Item[], title: string, imageUrl: (i: Item) => string | null): string {
  const totals = new Map<string, number>();
  for (const i of items) totals.set(i.currency, (totals.get(i.currency) ?? 0) + i.value.typical);
  const rows = items.map((i) => {
    const img = imageUrl(i);
    return `<tr>
<td>${img ? `<img src="${esc(img)}" alt="" width="64" height="64">` : ''}</td>
<td><b>${esc(i.name)}</b><br>${esc([i.brand, i.model].filter(Boolean).join(' '))}<br><small>#${i.number} · ${esc(i.type)} · ${esc(i.condition.label)}</small></td>
<td class="r">${fmt(i.value.typical, i.currency)}<br><small>${fmt(i.value.min, i.currency)} – ${fmt(i.value.max, i.currency)}</small></td>
<td>${esc(i.location?.place || i.location?.address || '')}</td>
<td>${i.purchase ? `${esc(i.purchase.store)} ${esc(i.purchase.date ?? '')}<br><small>warranty ${esc(i.purchase.warranty_until ?? '-')}</small>` : ''}</td>
</tr>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
body{font:13px/1.4 system-ui,sans-serif;margin:24px;color:#111}
h1{margin:0 0 4px}table{border-collapse:collapse;width:100%;margin-top:16px}
td,th{border-bottom:1px solid #ddd;padding:6px 8px;vertical-align:top;text-align:left}
th{background:#f3f3f3}.r{text-align:right;white-space:nowrap}img{object-fit:cover;border-radius:4px}
small{color:#666}tr{break-inside:avoid}
</style></head><body>
<h1>${esc(title)}</h1>
<p>${items.length} items · generated ${new Date().toISOString().slice(0, 10)}<br>
<b>Estimated total:</b> ${[...totals].map(([c, n]) => fmt(n, c)).join(' + ') || '-'}<br>
<small>Values are AI estimates of second-hand market value unless verified against sold listings.</small></p>
<table><thead><tr><th></th><th>Item</th><th class="r">Value</th><th>Location</th><th>Purchase</th></tr></thead>
<tbody>
${rows}
</tbody></table>
</body></html>`;
}
