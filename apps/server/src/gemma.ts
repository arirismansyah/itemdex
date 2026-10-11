// Gemma client (vLLM, OpenAI-compatible /v1/chat/completions).
// Turns 1..N images of a single item into structured card data.

import { CONDITIONS, CONFIDENCES, RARITIES, SIZE_CLASSES, TYPES } from '@itemdex/shared';

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

export interface GemmaOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  language: string;
  currency: string;
  market: string;
}

export class GemmaClient {
  readonly configured: boolean;
  private baseUrl: string;

  constructor(private opts: GemmaOptions) {
    this.configured = !!(opts.baseUrl && opts.model);
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
  }

  get model() { return this.opts.model; }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
    };
  }

  private async chat(body: Json, timeoutMs = this.opts.timeoutMs): Promise<string> {
    if (!this.configured) throw new LlmError('LLM_API_BASE and LLM_MODEL are not configured', 503);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model: this.opts.model, ...body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') throw err;
      const cause = (err as { cause?: { code?: string } }).cause?.code || (err as Error).message;
      throw new LlmError(`Cannot reach Gemma at ${new URL(this.baseUrl).host} (${cause})`, 503);
    }
    const text = await res.text();
    if (!res.ok) throw new LlmError(`Gemma API ${res.status}: ${text.slice(0, 300)}`, res.status);
    const data = JSON.parse(text);
    return data.choices?.[0]?.message?.content ?? '';
  }

  async ping(): Promise<boolean> {
    if (!this.configured) return false;
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(8000),
      });
      return res.ok;
    } catch {
      return false;
    }
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

  // images: data URLs (image/jpeg, image/png or image/webp)
  async analyze(images: string[], { hint = '', isVideo = false } = {}): Promise<Json> {
    const intro = isVideo
      ? `These ${images.length} images are frames from a short video of one item.`
      : `These ${images.length} image(s) show one item.`;
    const userText = [intro, hint ? `Owner's note about the item: "${hint}"` : '', 'Create the ITEMDEX card data.']
      .filter(Boolean).join('\n');
    const messages = [
      { role: 'system', content: systemPrompt(this.opts) },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      },
    ];
    let raw: string;
    try {
      raw = await this.chat({
        messages,
        temperature: 0.3,
        max_tokens: 1500,
        response_format: { type: 'json_schema', json_schema: { name: 'itemdex_card', schema: CARD_SCHEMA } },
      });
    } catch (e) {
      // Some deployments reject guided decoding; retry with plain prompting.
      if (!(e instanceof LlmError) || e.status !== 400) throw e;
      raw = await this.chat({ messages, temperature: 0.3, max_tokens: 1500 });
    }
    return parseJson(raw);
  }
}

function parseJson(text: string): Json {
  const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new LlmError('Gemma returned a response that is not JSON');
  }
}
