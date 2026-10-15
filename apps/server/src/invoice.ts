import { extractText } from 'unpdf';
import { normalizeCard, type Card, type InvoiceItem, type InvoiceResult, type Locale } from '@itemdex/shared';
import type { LlmClient } from './llm.js';

export type InvoiceItemResult = InvoiceItem;
export type InvoiceScanResult = InvoiceResult;

const INVOICE_SCHEMA = {
  type: 'object',
  properties: {
    store: { type: 'string' },
    date: { type: 'string' },
    items: {
      type: 'array',
      maxItems: 15,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          brand: { type: 'string' },
          model: { type: 'string' },
          type: {
            type: 'string',
            enum: [
              'ELECTRONIC', 'FASHION', 'BOOK', 'TOY', 'HOME',
              'KITCHEN', 'SPORT', 'TOOL', 'COLLECTIBLE', 'BEAUTY',
              'VEHICLE', 'MUSIC', 'OFFICE', 'OTHER',
            ],
          },
          subcategory: { type: 'string' },
          description: { type: 'string' },
          color: { type: 'string' },
          material: { type: 'string' },
          price: { type: 'integer' },
          quantity: { type: 'integer' },
          rarity: { type: 'string', enum: ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY'] },
          tags: { type: 'array', items: { type: 'string' }, maxItems: 6 },
        },
        required: ['name', 'brand', 'model', 'type', 'subcategory', 'description', 'price', 'rarity', 'tags'],
      },
    },
  },
  required: ['store', 'date', 'items'],
};

export async function parsePdfInvoice(
  pdfBuffer: Uint8Array,
  llm: LlmClient,
  locale: Locale,
  hint = '',
): Promise<InvoiceScanResult> {
  const started = Date.now();
  const { text } = await extractText(pdfBuffer);
  const fullText = (Array.isArray(text) ? text.join('\n') : String(text || '')).trim();

  if (!fullText || fullText.length < 10) {
    throw new Error('No readable text found in PDF. Make sure it is a digital e-commerce invoice.');
  }

  const truncatedText = fullText.slice(0, 15000);
  const prompt = `You parse e-commerce invoices and receipts (Tokopedia, Shopee, Amazon, etc.).
Extract the store name, transaction date (YYYY-MM-DD), and all purchased physical items.
Do NOT include shipping fees, insurance, or voucher discounts as items.
For each item, provide realistic Pokédex-style card attributes (type, subcategory, playful description in ${locale.language}, and price in ${locale.currency}).
${hint ? `User note: "${hint}"` : ''}

Invoice text:
"""
${truncatedText}
"""`;

  const messages = [
    { role: 'system', content: `You extract purchase item data from invoice text. Respond with JSON only.` },
    { role: 'user', content: prompt },
  ];

  const raw = await llm.structuredText(messages, 'itemdex_invoice', INVOICE_SCHEMA, {
    maxTokens: 3000,
    temperature: 0,
  });

  const rawItems = Array.isArray(raw?.items) ? raw.items : [];
  const store = String(raw?.store || '').trim();
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(raw?.date || '')) ? String(raw.date) : null;

  const items: InvoiceItemResult[] = rawItems.map((it: any) => {
    const price = Math.max(0, Math.round(Number(it.price) || 0));
    const card = normalizeCard({
      ...it,
      condition: { score: 100, label: 'MINT', notes: 'Purchased new from invoice' },
      value: {
        min: Math.round(price * 0.8),
        typical: price,
        max: Math.round(price * 1.1),
        new_price: price,
        confidence: 'HIGH',
        reasoning: `Purchased from ${store || 'invoice'} for ${price}`,
      },
    });
    return {
      card,
      store,
      date: dateStr,
      price,
    };
  });

  return {
    items,
    store,
    date: dateStr,
    currency: locale.currency,
    elapsed_ms: Date.now() - started,
  };
}
