import { extractText } from 'unpdf';
import zlib from 'node:zlib';
import { normalizeCard, type Card, type InvoiceItem, type InvoiceResult, type Locale } from '@itemdex/shared';
import type { LlmClient } from './llm.js';

export class PdfInvoiceError extends Error {
  constructor(message: string, public code = 'invalid_pdf', public status = 422) {
    super(message);
    this.name = 'PdfInvoiceError';
  }
}

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
        required: ['name', 'price'],
      },
    },
  },
  required: ['items'],
};

// Pure Node.js stdlib PNG encoder (width, height, 8-bit RGB)
function makePng(width: number, height: number, rgbBytes: Buffer): Buffer {
  const crcTable = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[i] = c;
  }
  function crc32(buf: Buffer): number {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }
  function chunk(type: string, data: Buffer): Buffer {
    const len = data.length;
    const buf = Buffer.alloc(12 + len);
    buf.writeUInt32BE(len, 0);
    buf.write(type, 4, 4, 'ascii');
    data.copy(buf, 8);
    const crc = crc32(buf.subarray(4, 8 + len));
    buf.writeUInt32BE(crc, 8 + len);
    return buf;
  }

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const scanlines = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const src = y * width * 3;
    const dst = y * (1 + width * 3);
    scanlines[dst] = 0;
    rgbBytes.copy(scanlines, dst + 1, src, src + width * 3);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}

// Extracts embedded raster image from a PDF buffer (handles scans / screenshot PDFs)
export function extractPdfImage(data: Buffer): string | null {
  const str = data.toString('latin1');
  const imgIdx = str.indexOf('/Subtype /Image') !== -1 ? str.indexOf('/Subtype /Image') : str.indexOf('/Subtype/Image');
  if (imgIdx === -1) return null;

  const contextWindow = str.slice(Math.max(0, imgIdx - 200), imgIdx + 200);
  const isJpg = /Filter\s*(\[\s*)?\/DCTDecode/.test(contextWindow);
  const isFlate = /Filter\s*(\[\s*)?\/FlateDecode/.test(contextWindow);

  const wMatch = contextWindow.match(/\/Width\s+(\d+)/);
  const hMatch = contextWindow.match(/\/Height\s+(\d+)/);
  const width = wMatch ? parseInt(wMatch[1], 10) : 0;
  const height = hMatch ? parseInt(hMatch[1], 10) : 0;

  const streamStartStr = 'stream';
  const streamStart = str.indexOf(streamStartStr, imgIdx);
  if (streamStart === -1) return null;

  let dataStart = streamStart + 6;
  if (data[dataStart] === 0x0d) dataStart++;
  if (data[dataStart] === 0x0a) dataStart++;

  const endStream = str.indexOf('endstream', dataStart);
  if (endStream === -1) return null;

  const streamBuf = data.subarray(dataStart, endStream);
  if (isJpg) {
    return `data:image/jpeg;base64,${streamBuf.toString('base64')}`;
  }
  if (isFlate && width > 0 && height > 0) {
    try {
      const rawRgb = zlib.unzipSync(streamBuf);
      if (rawRgb.length >= width * height * 3) {
        const pngBuf = makePng(width, height, rawRgb);
        return `data:image/png;base64,${pngBuf.toString('base64')}`;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function buildInvoiceResult(raw: any, locale: Locale, started: number): InvoiceScanResult {
  const rawItems = Array.isArray(raw?.items) ? raw.items : [];
  if (!rawItems.length) {
    throw new PdfInvoiceError(
      'The AI could not identify any purchased physical items in the invoice or receipt.',
      'no_items_found',
      422,
    );
  }
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

export async function parseInvoiceImage(
  imageDataUrl: string,
  llm: LlmClient,
  locale: Locale,
  hint = '',
): Promise<InvoiceScanResult> {
  const started = Date.now();
  const prompt = `You parse e-commerce invoices, receipts, and order confirmation screenshots (Tokopedia, Shopee, Amazon, Flipkart, etc.).
Extract the store name, transaction date (YYYY-MM-DD), and all purchased physical items.
Do NOT include shipping fees, platform fees, insurance, or voucher discounts as items.
For each item, extract the name, brand, model, price (as an integer number), and provide realistic Pokédex-style card attributes (type, subcategory, playful description in ${locale.language}).
${hint ? `User note: "${hint}"` : ''}`;

  const raw = await llm.structuredVision(
    'You extract purchase item data from invoice and receipt images. Respond with JSON only.',
    prompt,
    [imageDataUrl],
    'itemdex_invoice',
    INVOICE_SCHEMA,
    { maxTokens: 3000, temperature: 0 },
  );

  return buildInvoiceResult(raw, locale, started);
}

export async function parsePdfInvoice(
  pdfBuffer: Buffer | Uint8Array,
  llm: LlmClient,
  locale: Locale,
  hint = '',
): Promise<InvoiceScanResult> {
  const started = Date.now();
  const rawBuf = Buffer.isBuffer(pdfBuffer)
    ? pdfBuffer
    : Buffer.from(pdfBuffer.buffer, pdfBuffer.byteOffset, pdfBuffer.byteLength);
  const uint8 = new Uint8Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength);

  let fullText = '';
  try {
    // Note: unpdf / pdfjs worker detaches the transferred ArrayBuffer, so pass a clone!
    const { text } = await extractText(uint8.slice());
    fullText = (Array.isArray(text) ? text.join('\n') : String(text || '')).trim();
    if (!fullText || fullText.length < 10) {
      // Fallback: extract uncompressed literal text tokens from raw PDF stream
      const rawAscii = rawBuf.toString('latin1');
      const textMatches = [...rawAscii.matchAll(/\(([^()]{3,})\)\s*Tj/g)].map((m) => m[1]);
      if (textMatches.length > 0) {
        fullText = textMatches.join(' ').trim();
      }
    }
  } catch (err) {
    throw new PdfInvoiceError(`Could not read PDF structure: ${(err as Error).message}`, 'unreadable_pdf', 400);
  }

  // If no readable text stream, fall back to embedded image (scanned PDF / screenshot in PDF)
  if (!fullText || fullText.length < 10) {
    const imgDataUrl = extractPdfImage(rawBuf);
    if (imgDataUrl) {
      return parseInvoiceImage(imgDataUrl, llm, locale, hint);
    }
    throw new PdfInvoiceError(
      'No readable text layer or embedded image found in PDF. Make sure it is an e-commerce invoice or receipt.',
      'no_text_in_pdf',
      422,
    );
  }

  const truncatedText = fullText.slice(0, 15000);
  const prompt = `You parse e-commerce invoices and receipts (Tokopedia, Shopee, Amazon, Flipkart, etc.).
Extract the store name, transaction date (YYYY-MM-DD), and all purchased physical items.
Do NOT include shipping fees, platform fees, insurance, or voucher discounts as items.
For each item, extract the name, brand, model, price (as an integer number), and provide realistic Pokédex-style card attributes (type, subcategory, playful description in ${locale.language}).
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

  return buildInvoiceResult(raw, locale, started);
}
