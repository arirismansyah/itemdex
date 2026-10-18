// AI client for any OpenAI-compatible vision model (Gemma/vLLM, Ollama, OpenAI, ...): /v1/chat/completions.
// Turns 1..N images of a single item into structured card data.

import { fromAnthropicResponse, toAnthropicRequest } from './anthropic.js';
import {
  CONDITIONS, CONFIDENCES, FLAGS, RARITIES, SIZE_CLASSES, SORTS, TYPES,
  type Card, type Item, type Locale, type Platform,
} from '@itemdex/shared';
import type { Listing as WebListing } from './pricing.js';

const CARD_SCHEMA = {
  type: 'object',
  properties: {
    is_item: { type: 'boolean' },
    name: { type: 'string' },
    brand: { type: 'string' },
    model: { type: 'string' },
    type: { type: 'string', enum: TYPES },
    subcategory: { type: 'string' },
    description: { type: 'string' },
    color: { type: 'string' },
    material: { type: 'string' },
    dimensions: {
      type: 'object',
      properties: {
        length_cm: { type: 'number' },
        width_cm: { type: 'number' },
        height_cm: { type: 'number' },
      },
      required: ['length_cm', 'width_cm', 'height_cm'],
    },
    size_class: { type: 'string', enum: SIZE_CLASSES },
    weight_g: { type: 'number' },
    condition: {
      type: 'object',
      properties: {
        score: { type: 'integer' },
        label: { type: 'string', enum: CONDITIONS },
        notes: { type: 'string' },
      },
      required: ['score', 'label', 'notes'],
    },
    value: {
      type: 'object',
      properties: {
        min: { type: 'integer' },
        max: { type: 'integer' },
        typical: { type: 'integer' },
        new_price: { type: 'integer' },
        confidence: { type: 'string', enum: CONFIDENCES },
        reasoning: { type: 'string' },
      },
      required: ['min', 'max', 'typical', 'new_price', 'confidence', 'reasoning'],
    },
    rarity: { type: 'string', enum: RARITIES },
    abilities: {
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          power: { type: 'integer' },
          text: { type: 'string' },
        },
        required: ['name', 'power', 'text'],
      },
    },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 6 },
    location_guess: { type: 'string' },
    best_frame: { type: 'integer' },
  },
  required: [
    'is_item', 'name', 'brand', 'model', 'type', 'subcategory', 'description',
    'color', 'material', 'dimensions', 'size_class', 'weight_g', 'condition',
    'value', 'rarity', 'abilities', 'tags', 'location_guess', 'best_frame',
  ],
};

// Whole-room scan: one card per visible item plus where it sits in the frame.
const { best_frame: _bf, ...ROOM_CARD_PROPS } = CARD_SCHEMA.properties;
const ROOM_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        properties: { ...ROOM_CARD_PROPS, box: { type: 'array', items: { type: 'integer' }, minItems: 4, maxItems: 4 } },
        required: [...CARD_SCHEMA.required.filter((k) => k !== 'best_frame'), 'box'],
      },
    },
  },
  required: ['items'],
};

const LISTING_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' }, description: { type: 'string' }, price: { type: 'integer' } },
  required: ['title', 'description', 'price'],
};

const ASK_SCHEMA = {
  type: 'object',
  properties: {
    q: { type: 'string' },
    types: { type: 'array', items: { type: 'string', enum: TYPES } },
    rarities: { type: 'array', items: { type: 'string', enum: RARITIES } },
    min_value: { type: 'integer' },
    max_value: { type: 'integer' },
    sort: { type: 'string', enum: SORTS },
    flag: { type: 'string', enum: ['', ...FLAGS] },
  },
  required: ['q', 'types', 'rarities', 'min_value', 'max_value', 'sort', 'flag'],
};

const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    is_receipt: { type: 'boolean' },
    store: { type: 'string' },
    date: { type: 'string' },
    total: { type: 'integer' },
    warranty_months: { type: 'integer' },
  },
  required: ['is_receipt', 'store', 'date', 'total', 'warranty_months'],
};

const SHOPEE_SHOTS_SCHEMA = {
  type: 'object',
  properties: {
    is_listing_page: { type: 'boolean' },
    listings: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, price: { type: 'integer' } },
        required: ['title', 'price'],
      },
    },
  },
  required: ['is_listing_page', 'listings'],
};

const PLATFORM_STYLE: Record<Platform, string> = {
  generic: 'a clear, honest classified ad for any marketplace',
  tokopedia: 'a Tokopedia/Shopee product listing: keyword-rich title (max 70 chars) with brand, model and condition, then short bullet lines (spec, condition, kelengkapan, alasan jual)',
  facebook: 'a Facebook Marketplace post: friendly and short, title max 60 chars, mention pickup/COD and that the price is slightly negotiable',
  ebay: 'an eBay listing: title max 80 chars packed with brand/model/keywords, then item-specifics style lines (Brand, Model, Color, Material, Condition) and any flaws',
};

const DETECT_SCHEMA = {
  type: 'object',
  properties: {
    has_item: { type: 'boolean' },
    name: { type: 'string' },
    box: { type: 'array', items: { type: 'integer' }, minItems: 4, maxItems: 4 },
  },
  required: ['has_item', 'name', 'box'],
};

const DETECT_PROMPT = `This is a live camera frame. Find the single main physical item the user is showing to the camera.
Ignore people, faces, hands holding the item, walls, and background furniture unless the item is clearly the subject.
If there is no clear item, set has_item=false.
name: short English name, max 3 words.
box: bounding box of the item as [ymin, xmin, ymax, xmax] normalized to 0-1000.`;

const APPRAISE_SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        properties: { index: { type: 'integer' }, price: { type: 'integer' } },
        required: ['index', 'price'],
      },
    },
    min: { type: 'integer' },
    max: { type: 'integer' },
    typical: { type: 'integer' },
    new_price: { type: 'integer' },
    confidence: { type: 'string', enum: CONFIDENCES },
    reasoning: { type: 'string' },
  },
  required: ['matches', 'min', 'max', 'typical', 'new_price', 'confidence', 'reasoning'],
};

function appraisePrompt(card: Card, listings: WebListing[], { language, currency, market }: Locale) {
  const v = card.value;
  const item = [
    `name: ${card.name}`, card.brand && `brand: ${card.brand}`, card.model && `model: ${card.model}`,
    card.subcategory && `category: ${card.subcategory}`,
    `condition: ${card.condition.label} (${card.condition.score}/100)${card.condition.notes ? ` - ${card.condition.notes}` : ''}`,
    `current estimate (${currency}): used ${v.min}-${v.max}, typical ${v.typical}, new ${v.new_price}`,
  ].filter(Boolean).join('\n');
  const rows = listings.map((l, i) =>
    `[${i}] ${l.site} | ${l.title} | ${l.snippet} | prices found: ${l.prices.join(', ')}`).join('\n');
  return `You are a second-hand price analyst for the ${market} market. Currency: ${currency}.

ITEM
${item}

WEB LISTINGS (search results, noisy)
${rows}

Task:
1. "matches": listings that sell or price THIS SAME product (same model/generation/variant, as close as the info allows) as USED / second-hand. For each give "index" and the "price" from its "prices found" that belongs to this item. Exclude accessories, cases, spare parts, broken or for-parts units (unless the item itself is broken), bundles, rentals, different models or generations, and articles that list many products without a clear price for this exact item.
2. "new_price": the current NEW retail price of this exact product if a listing shows it, else keep the current estimate.
3. "min", "max", "typical": realistic used price range for this item in its condition, based mainly on the matched prices (typical near their median, adjusted for condition). If nothing matches, return "matches": [] and the current estimate unchanged.
4. "confidence": HIGH with 3+ good matches, MEDIUM with 1-2, LOW with none.
5. "reasoning": one short sentence in ${language} explaining the price (do not state how many listings were used).
Whole numbers only. Respond with JSON only.`;
}

function systemPrompt({ language, currency, market }: { language: string; currency: string; market: string }) {
  return `You are ITEMDEX, an expert appraiser and cataloguer of personal belongings.
You look at photos (or video frames) of ONE physical item and produce data for a collectible trading card about it, in the style of a Pokedex entry.

Rules:
- Identify the main item as specifically as you can (brand, model, generation) using logos, shapes, text and design cues. If unsure about the brand/model, use "" for brand/model and give a clear generic name.
- "name": short card title, max 28 characters.
- "type" is the card element, pick the best fit:
  ELECTRONIC = phones, laptops, gadgets, chargers, cameras, appliances with a plug
  FASHION = clothes, shoes, bags, watches, jewelry | BOOK = books, comics, magazines
  TOY = toys, figures, board games, game cartridges | HOME = furniture, decor, bedding, cleaning
  KITCHEN = cookware, utensils, tableware, food containers | SPORT = sports and fitness gear
  TOOL = hand/power tools, hardware | COLLECTIBLE = trading cards, coins, stamps, memorabilia, antiques
  BEAUTY = cosmetics, skincare, perfume | VEHICLE = bikes, scooters, car/motor parts and accessories
  MUSIC = instruments, audio gear made for music | OFFICE = stationery, office supplies | OTHER = anything else
- "description": 1-2 sentence playful Pokedex-style flavor text about the item, in ${language}.
- "dimensions": your best physical size estimate in centimeters, using common real-world sizes of this product and visual references in the frame.
- "weight_g": estimated weight in grams.
- "condition": score 0-100 based on visible wear (scratches, dents, stains, fading). If you cannot see wear, assume GOOD (~75). "notes" in ${language}.
- "value": realistic SECOND-HAND resale price in ${currency} if sold today on the ${market} market (online marketplaces and local resale). min/max is the realistic range, typical is the most likely sale price, new_price is the approximate current retail price new. Use whole numbers, no decimals. "reasoning" is one short sentence in ${language}.
- "rarity": COMMON for everyday cheap items, UNCOMMON for decent branded items, RARE for valuable or hard-to-find items, EPIC for premium/collector items, LEGENDARY only for truly exceptional, vintage, limited or very expensive items.
- "abilities": exactly 2 card "moves" inspired by what the item really does (e.g. a kettle: "Boil Burst"). name max 18 characters, power 10-150, text is one short sentence in ${language}.
- "tags": up to 6 short lowercase keywords.
- "location_guess": where the item appears to be right now based on the background (e.g. "work desk", "kitchen counter", "bedroom shelf"), max 40 characters, in ${language}. Use "" if the background gives no clue.
- "best_frame": 0-based index of the input image that shows the item best.
- If the images contain no identifiable physical item, set is_item=false and fill the other fields with your best guess anyway.
Respond with JSON only.`;
}

export class LlmError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = 'LlmError';
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

export interface LlmOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  language: string;
  currency: string;
  market: string;
}

// The API root the user gave, minus slashes. A bare host gets /v1 (OpenAI, Ollama, vLLM, DeepSeek, Claude);
// a URL with a path is used as is (".../v1", Gemini's ".../v1beta/openai", ...). Endpoints are root + /chat/completions.
export function cleanBaseUrl(u: string): string {
  const t = u.trim();
  try {
    const url = new URL(t);
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${path || '/v1'}`;
  } catch {
    return t.replace(/\/+$/, '');
  }
}

// 1x1 PNG used to check that a model accepts images at all.
const PROBE_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export class LlmClient {
  private baseUrl: string;

  constructor(private opts: LlmOptions) {
    this.baseUrl = cleanBaseUrl(opts.baseUrl);
  }

  get configured() { return !!(this.baseUrl && this.opts.model); }
  // Claude has its own API; everything else is OpenAI-compatible.
  get kind(): 'openai' | 'anthropic' {
    try { return new URL(this.baseUrl).hostname.endsWith('anthropic.com') ? 'anthropic' : 'openai'; } catch { return 'openai'; }
  }
  get model() { return this.opts.model; }
  get url() { return this.baseUrl; }
  get hasKey() { return !!this.opts.apiKey; }
  get key() { return this.opts.apiKey; } // server-side only: never sent to clients

  // Changes the connection at runtime (Settings screen).
  configure(p: Partial<Pick<LlmOptions, 'baseUrl' | 'apiKey' | 'model'>>) {
    Object.assign(this.opts, p);
    this.baseUrl = cleanBaseUrl(this.opts.baseUrl);
  }

  // Model ids the server offers; throws LlmError when it cannot be reached.
  async models(): Promise<string[]> {
    if (!this.baseUrl) throw new LlmError('Enter the AI server URL first', 503);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/models`, { headers: this.headers(), signal: AbortSignal.timeout(8000) });
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause?.code || (err as Error).message;
      throw new LlmError(`Cannot reach ${this.baseUrl} (${cause})`, 503);
    }
    if (res.status === 401 || res.status === 403) throw new LlmError('The server rejected the API key', res.status);
    if (!res.ok) throw new LlmError(`The server answered ${res.status} at /v1/models (is this an OpenAI-compatible URL?)`, res.status);
    const data = (await res.json().catch(() => ({}))) as { data?: { id?: string }[] };
    // Gemini lists ids as "models/<name>"; the chat API wants "<name>".
    return (data.data ?? []).map((m) => String(m.id).replace(/^models\//, '')).filter(Boolean);
  }

  private headers(): Record<string, string> {
    const key = this.opts.apiKey;
    return {
      'Content-Type': 'application/json',
      ...(this.kind === 'anthropic'
        ? { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) }
        : key ? { Authorization: `Bearer ${key}` } : {}),
    };
  }

  private async chat(body: Json, timeoutMs = this.opts.timeoutMs): Promise<string> {
    if (!this.configured) throw new LlmError('The AI server is not set up: open the gear icon (or set LLM_API_BASE and LLM_MODEL)', 503);
    let res: Response;
    try {
      const claude = this.kind === 'anthropic';
      res = await fetch(`${this.baseUrl}${claude ? '/messages' : '/chat/completions'}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(claude ? toAnthropicRequest(this.opts.model, body) : { model: this.opts.model, stream: false, ...body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') throw err;
      const cause = (err as { cause?: { code?: string } }).cause?.code || (err as Error).message;
      throw new LlmError(`Cannot reach the AI server at ${new URL(this.baseUrl).host} (${cause})`, 503);
    }
    const text = await res.text();
    if (!res.ok) throw new LlmError(`AI server error ${res.status}: ${text.slice(0, 300)}`, res.status);
    let data: Json;
    try {
      data = JSON.parse(text);
    } catch {
      // Fallback if proxy returns SSE stream despite stream: false
      if (text.includes('data:')) {
        let content = '';
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:') || trimmed === 'data: [DONE]') continue;
          try {
            const chunk = JSON.parse(trimmed.slice(5).trim());
            content += chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? '';
          } catch {}
        }
        if (content) return content;
      }
      throw new LlmError(`AI returned invalid JSON: ${text.slice(0, 160)}`);
    }
    return this.kind === 'anthropic' ? fromAnthropicResponse(data) : data.choices?.[0]?.message?.content ?? '';
  }

  // Throws when the model refuses images (text-only models such as deepseek-chat).
  async probeVision(): Promise<void> {
    await this.chat({
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Reply with the single word OK.' },
        { type: 'image_url', image_url: { url: PROBE_IMAGE } },
      ] }],
      max_tokens: 10,
      temperature: 0,
    }, 20_000);
  }

  async ping(): Promise<boolean> {
    if (!this.configured) return false;
    return this.models().then(() => true, () => false);
  }

  // Fast single-frame detection for the live viewfinder (~0.6s).
  async detect(imageUrl: string): Promise<Json> {
    const raw = await this.chat({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: DETECT_PROMPT },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      }],
      temperature: 0,
      max_tokens: 80,
      response_format: { type: 'json_schema', json_schema: { name: 'itemdex_detect', schema: DETECT_SCHEMA } },
    }, 15_000);
    return parseJson(raw);
  }

  // Guided JSON output; some deployments reject guided decoding, so retry with plain prompting.
  private async structured(
    messages: Json[], name: string, schema: Json, { maxTokens = 1500, temperature = 0.3 } = {},
  ): Promise<Json> {
    let raw: string;
    try {
      raw = await this.chat({
        messages, temperature, max_tokens: maxTokens,
        response_format: { type: 'json_schema', json_schema: { name, schema } },
      });
    } catch (e) {
      if (!(e instanceof LlmError) || (e.status !== 400 && e.status !== 422) || this.kind === 'anthropic') throw e;
      raw = await this.chat({ messages, temperature, max_tokens: maxTokens });
    }
    return parseJson(raw);
  }

  private imageMessage(system: string, text: string, images: string[]) {
    return [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [{ type: 'text', text }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))],
      },
    ];
  }

  // Expose structured method for internal modules (like invoice.ts)
  async structuredText(messages: Json[], name: string, schema: Json, opts?: { maxTokens?: number; temperature?: number }): Promise<Json> {
    return this.structured(messages, name, schema, opts);
  }

  async structuredVision(system: string, text: string, images: string[], name: string, schema: Json, opts?: { maxTokens?: number; temperature?: number }): Promise<Json> {
    return this.structured(this.imageMessage(system, text, images), name, schema, opts);
  }

  // images: data URLs (image/jpeg, image/png or image/webp)
  async analyze(images: string[], { hint = '', isVideo = false, locale }: { hint?: string; isVideo?: boolean; locale?: Locale } = {}): Promise<Json> {
    const intro = isVideo
      ? `These ${images.length} images are frames from a short video of one item.`
      : `These ${images.length} image(s) show one item.`;
    const userText = [intro, hint ? `Owner's note about the item: "${hint}"` : '', 'Create the ITEMDEX card data.']
      .filter(Boolean).join('\n');
    return this.structured(
      this.imageMessage(systemPrompt({ ...this.opts, ...locale }), userText, images), 'itemdex_card', CARD_SCHEMA);
  }

  // One photo of a room/shelf/drawer -> a card for every distinct item in it.
  async room(images: string[], { hint = '', locale }: { hint?: string; locale?: Locale } = {}): Promise<Json[]> {
    const system = `${systemPrompt({ ...this.opts, ...locale })}

THIS REQUEST IS DIFFERENT: the image shows a room, shelf, drawer or table with MANY items instead of one.
Return {"items": [...]} with one card (same fields as above, without best_frame) for every distinct, clearly visible, separately sellable item, at most 12, most valuable first.
Skip walls, floors, built-in fixtures and tiny clutter. Each card also has "box": [ymin, xmin, ymax, xmax] around that item, normalized to 0-1000.`;
    const text = ['Catalogue the items in this image.', hint ? `Owner's note: "${hint}"` : ''].filter(Boolean).join('\n');
    const out = await this.structured(this.imageMessage(system, text, images), 'itemdex_room', ROOM_SCHEMA, { maxTokens: 6000 });
    return Array.isArray(out.items) ? out.items : [];
  }

  // Re-estimates the value from web listings (text only). See pricing.ts.
  async appraise(card: Card, listings: WebListing[], locale?: Locale): Promise<Json> {
    const messages = [{ role: 'user', content: appraisePrompt(card, listings, { ...this.opts, ...locale }) }];
    return this.structured(messages, 'itemdex_appraise', APPRAISE_SCHEMA, { maxTokens: 600, temperature: 0.1 });
  }

  async listing(item: Item, platform: Platform, locale?: Locale): Promise<Json> {
    const { language, currency } = { ...this.opts, ...locale };
    const facts = {
      name: item.name, brand: item.brand, model: item.model, subcategory: item.subcategory,
      color: item.color, material: item.material, size_cm: item.dimensions, weight_g: item.weight_g,
      condition: item.condition, price_range: item.value, purchased: item.purchase, location: item.location?.place,
    };
    const messages = [
      {
        role: 'system',
        content: `You write second-hand sale listings. Write ${PLATFORM_STYLE[platform]}, in ${language}.
Use only the facts given; never invent specs, accessories or defects. Mention visible condition honestly.
"description" is plain text (no markdown), 3-8 short lines.
"price" is the asking price as a whole number in ${currency}: about 5% above price_range.typical, rounded to a clean number, never below price_range.min.
Respond with JSON only.`,
      },
      { role: 'user', content: JSON.stringify(facts) },
    ];
    return this.structured(messages, 'itemdex_listing', LISTING_SCHEMA, { maxTokens: 800 });
  }

  // Natural-language collection search -> structured filters.
  async ask(query: string, locale?: Locale): Promise<Json> {
    const { currency } = { ...this.opts, ...locale };
    const messages = [
      {
        role: 'system',
        content: `You turn a question about someone's catalogued belongings into search filters. Respond with JSON only.
- q: ONE short keyword matched against item name, brand, tags and where the item is (e.g. "garage", "nike"); "" if the question has no such keyword. Use the language of the question.
- types: item types that fit (${TYPES.join(', ')}); [] if unspecified.
- rarities: [] unless the question names a rarity.
- min_value / max_value: price limits in ${currency} as whole numbers (expand "50k"/"50rb"=50000, "2jt"=2000000); 0 = no limit.
- sort: "value" for most/least valuable, "rarity" for rarest, "old" for oldest, otherwise "new".
- flag: "lent" for items lent out/borrowed, "overdue" for late returns, "sell_now" for items worth selling now / at peak price, "warranty" for warranty expiring soon; "" otherwise.`,
      },
      { role: 'user', content: query },
    ];
    return this.structured(messages, 'itemdex_ask', ASK_SCHEMA, { maxTokens: 300, temperature: 0 });
  }

  async receipt(image: string): Promise<Json> {
    const system = `You read purchase receipts and invoices. Respond with JSON only.
store: shop name. date: purchase date as YYYY-MM-DD, "" if unreadable. total: grand total as a whole number without currency symbols or separators, 0 if unreadable.
warranty_months: warranty length in months if the document states one (1 year = 12), else 0. is_receipt=false if the image is not a receipt or invoice.`;
    return this.structured(
      this.imageMessage(system, 'Read this receipt.', [image]), 'itemdex_receipt', RECEIPT_SCHEMA, { maxTokens: 300, temperature: 0 });
  }
}

// Screenshots of marketplace search results (Shopee app or web) -> the product cards on them.
export async function readListingShots(llm: LlmClient, images: string[]): Promise<Json> {
  const system = `You read screenshots of Shopee Indonesia search results (app or website). Respond with JSON only.
listings: every product card visible, top to bottom, left to right, each once even if it appears on two screenshots.
- title: the product title exactly as shown (it may be cut off with "...").
- price: the price in Rupiah as a whole number without symbols or separators ("Rp1.250.000" = 1250000, "Rp1,2jt" = 1200000, "Rp350rb" = 350000). For a range "Rp100.000 - Rp200.000" use the lower price. Use the current price, not a crossed-out one.
Skip cards whose price you cannot read. is_listing_page=false and listings=[] if these are not marketplace search results.`;
  return llm.structuredVision(system, `Read the product listings on these ${images.length} screenshot(s).`, images,
    'itemdex_shopee_shots', SHOPEE_SHOTS_SCHEMA, { maxTokens: 3000, temperature: 0 });
}

function parseJson(text: string): Json {
  const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new LlmError('The AI returned a response that is not JSON');
  }
}
