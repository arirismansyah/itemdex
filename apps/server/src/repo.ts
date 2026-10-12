// Items persistence (PostgreSQL).

import crypto from 'node:crypto';
import {
  FLAGS, RARITY_RANK, type Card, type Comps, type Flag, type Item, type ItemList, type ItemLocation,
  type ItemType, type Lent, type Purchase, type Rarity, type Sort, type Source, type Stats,
  type ValuePoint,
} from '@itemdex/shared';
import type { Db } from './db.js';

export const DEFAULT_HOUSEHOLD = '00000000-0000-0000-0000-000000000001';

export interface ImageBlob { mime: string; data: Buffer }
export type NewLocation = Omit<ItemLocation, 'at'>;

export interface ListQuery {
  q?: string;
  types?: string[];
  rarities?: string[];
  sort?: Sort;
  flag?: Flag | '';
  minValue?: number;
  maxValue?: number;
  offset?: number;
  limit?: number;
}

const ORDER: Record<Sort, string> = {
  new: 'created_at DESC',
  old: 'created_at ASC',
  value: 'value_typical DESC, created_at DESC',
  rarity: 'rarity_rank DESC, value_typical DESC',
  name: 'lower(name) ASC',
  number: 'number ASC',
};

// Value is at its all-time high and 10%+ above the first recorded value.
// ponytail: correlated subqueries per row; materialize a column if collections reach 100k items.
const SELL_NOW = `(
  (SELECT count(*) FROM item_value_history h WHERE h.item_id = items.id) >= 2
  AND items.value_typical >= (SELECT max(typical) FROM item_value_history h WHERE h.item_id = items.id)
  AND items.value_typical > (SELECT typical FROM item_value_history h WHERE h.item_id = items.id ORDER BY at, id LIMIT 1)
  AND items.value_typical * 10 >= 11 * (SELECT typical FROM item_value_history h WHERE h.item_id = items.id ORDER BY at, id LIMIT 1)
)`;

// due / warranty_until are validated as YYYY-MM-DD before they are stored, so the casts are safe.
const FLAG_SQL: Record<Flag, string> = {
  lent: 'lent IS NOT NULL',
  overdue: "(lent->>'due') IS NOT NULL AND (lent->>'due')::date < current_date",
  sell_now: SELL_NOW,
  warranty: "(purchase->>'warranty_until') IS NOT NULL AND (purchase->>'warranty_until')::date BETWEEN current_date AND current_date + 60",
};

const ITEM_COLUMNS = `id, number, name, brand, model, type, rarity, subcategory, description, color,
  material, size_class, weight_g, dimensions, condition, value, abilities, tags, location_guess,
  is_item, source, location, has_image, currency, lent, purchase, comps, ${SELL_NOW} AS sell_now,
  created_at, updated_at`;

// Builds an absolute URL for a server path (image links must work cross-origin).
type UrlFor = (path: string) => string;

function searchText(card: Card, location: NewLocation | ItemLocation | null): string {
  return [
    card.name, card.brand, card.model, card.subcategory, card.color, card.material, ...card.tags,
    location?.place, location?.address,
  ].filter(Boolean).join(' ').toLowerCase();
}

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : d);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toItem(row: any, url: UrlFor, base: string, history: ItemLocation[] = [], values: ValuePoint[] = []): Item {
  return {
    id: row.id,
    number: row.number,
    is_item: row.is_item,
    name: row.name,
    brand: row.brand,
    model: row.model,
    type: row.type,
    subcategory: row.subcategory,
    description: row.description,
    color: row.color,
    material: row.material,
    dimensions: row.dimensions,
    size_class: row.size_class,
    weight_g: row.weight_g,
    condition: row.condition,
    value: row.value,
    rarity: row.rarity,
    abilities: row.abilities,
    tags: row.tags,
    location_guess: row.location_guess,
    source: row.source,
    currency: row.currency || base,
    location: row.location,
    location_history: history,
    lent: row.lent ?? null,
    purchase: row.purchase ?? null,
    comps: row.comps ?? null,
    value_history: values,
    sell_now: !!row.sell_now,
    image_url: row.has_image ? url(`/media/${row.id}`) : null,
    thumb_url: row.has_image ? url(`/media/${row.id}/thumb`) : null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export class ItemsRepo {
  // `base` is the service currency: items stored with '' (or this value) count towards totals.
  constructor(private db: Db, private base: string) {}

  async list(hid: string, query: ListQuery, url: UrlFor): Promise<ItemList> {
    const args: unknown[] = [];
    const arg = (v: unknown) => `$${args.push(v)}`;
    const where: string[] = [`household_id = ${arg(hid)}`];
    if (query.types?.length) where.push(`type = ANY(${arg(query.types)})`);
    if (query.rarities?.length) where.push(`rarity = ANY(${arg(query.rarities)})`);
    if (query.q) {
      const escaped = query.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
      where.push(`search_text LIKE ${arg(`%${escaped}%`)}`);
    }
    if (query.flag && FLAGS.includes(query.flag)) where.push(`(${FLAG_SQL[query.flag]})`);
    if (query.minValue) where.push(`value_typical >= ${arg(query.minValue)}`);
    if (query.maxValue) where.push(`value_typical <= ${arg(query.maxValue)}`);
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const baseArg = arg(this.base);
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.min(200, Math.max(1, query.limit ?? 60));

    const [rows, agg] = await Promise.all([
      this.db.query(
        `SELECT ${ITEM_COLUMNS} FROM items ${whereSql}
         ORDER BY ${ORDER[query.sort ?? 'new'] ?? ORDER.new}, id
         OFFSET ${offset} LIMIT ${limit}`,
        args.slice(0, -1), // the last arg (service currency) is only used by the totals query
      ),
      this.db.query<{ total: number; total_value: number }>(
        `SELECT count(*)::int AS total,
           coalesce(sum(value_typical) FILTER (WHERE currency IN ('', ${baseArg})), 0)::bigint AS total_value
         FROM items ${whereSql}`,
        args,
      ),
    ]);
    return {
      items: rows.rows.map((r) => toItem(r, url, this.base)),
      total: agg.rows[0].total,
      total_value: agg.rows[0].total_value,
      offset,
      limit,
    };
  }

  // Everything, oldest first (reports).
  async all(hid: string, url: UrlFor): Promise<Item[]> {
    const { rows } = await this.db.query(
      `SELECT ${ITEM_COLUMNS} FROM items WHERE household_id = $1 ORDER BY number`, [hid]);
    return rows.map((r) => toItem(r, url, this.base));
  }

  async stats(hid: string): Promise<Stats> {
    const [byType, flags] = await Promise.all([
      this.db.query<{ type: ItemType; n: number; v: number }>(
        `SELECT type, count(*)::int AS n,
           coalesce(sum(value_typical) FILTER (WHERE currency IN ('', $2)), 0)::bigint AS v
         FROM items WHERE household_id = $1 GROUP BY type`,
        [hid, this.base],
      ),
      this.db.query<Record<Flag, number>>(
        `SELECT ${FLAGS.map((f) => `count(*) FILTER (WHERE ${FLAG_SQL[f]})::int AS ${f}`).join(', ')}
         FROM items WHERE household_id = $1`,
        [hid],
      ),
    ]);
    const rows = byType.rows;
    return {
      total: rows.reduce((s, r) => s + r.n, 0),
      total_value: rows.reduce((s, r) => s + r.v, 0),
      types: Object.fromEntries(rows.map((r) => [r.type, r.n])),
      flags: flags.rows[0],
    };
  }

  async count(): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>('SELECT count(*)::int AS n FROM items');
    return rows[0].n;
  }

  async get(hid: string, id: string, url: UrlFor): Promise<Item | null> {
    const [item, history, values] = await Promise.all([
      this.db.query(`SELECT ${ITEM_COLUMNS} FROM items WHERE id = $1 AND household_id = $2`, [id, hid]),
      this.db.query(
        `SELECT place, lat, lng, accuracy_m, source, address, at FROM item_locations
         WHERE item_id = $1 ORDER BY at DESC, id DESC LIMIT 20`,
        [id],
      ),
      this.db.query(
        `SELECT typical, at FROM (
           SELECT typical, at, id FROM item_value_history WHERE item_id = $1 ORDER BY at DESC, id DESC LIMIT 100
         ) t ORDER BY at, id`,
        [id],
      ),
    ]);
    if (!item.rows[0]) return null;
    const hist = history.rows.map((h) => ({ ...h, at: iso(h.at) })) as ItemLocation[];
    const vals = values.rows.map((v) => ({ typical: v.typical, at: iso(v.at) })) as ValuePoint[];
    return toItem(item.rows[0], url, this.base, hist, vals);
  }

  async create(
    hid: string,
    card: Card,
    opts: {
      source: Source; location: NewLocation | null; image: ImageBlob | null; thumb: ImageBlob | null;
      currency?: string; id?: string; createdAt?: string; history?: ItemLocation[];
    },
    url: UrlFor,
  ): Promise<Item> {
    const id = opts.id ?? crypto.randomUUID();
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const now = opts.createdAt ?? new Date().toISOString();
      const location = opts.location ? { ...opts.location, at: now } : null;
      await client.query(
        `INSERT INTO items (id, name, brand, model, type, rarity, rarity_rank, subcategory, description,
           color, material, size_class, weight_g, dimensions, condition, value, value_typical, abilities,
           tags, location_guess, is_item, source, location, has_image, search_text, created_at, updated_at,
           household_id, currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$26,$27,$28)`,
        [
          id, card.name, card.brand, card.model, card.type, card.rarity, RARITY_RANK[card.rarity as Rarity],
          card.subcategory, card.description, card.color, card.material, card.size_class, card.weight_g,
          card.dimensions, card.condition, card.value, card.value.typical, JSON.stringify(card.abilities),
          card.tags, card.location_guess, card.is_item, opts.source, location, !!opts.image,
          searchText(card, location), now, hid, opts.currency && opts.currency !== this.base ? opts.currency : '',
        ],
      );
      await client.query('INSERT INTO item_value_history (item_id, typical, at) VALUES ($1, $2, $3)', [id, card.value.typical, now]);
      if (opts.image) {
        const thumb = opts.thumb ?? opts.image;
        await client.query(
          'INSERT INTO item_images (item_id, mime, data, thumb_mime, thumb) VALUES ($1, $2, $3, $4, $5)',
          [id, opts.image.mime, opts.image.data, thumb.mime, thumb.data],
        );
      }
      // Oldest first so the newest ends up on top.
      const history = opts.history?.length ? [...opts.history].reverse() : location ? [location] : [];
      for (const h of history) await insertLocation(client, id, h);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return (await this.get(hid, id, url))!;
  }

  async update(hid: string, id: string, card: Card, url: UrlFor): Promise<Item | null> {
    const { rowCount } = await this.db.query(
      `UPDATE items SET name=$2, brand=$3, model=$4, type=$5, rarity=$6, rarity_rank=$7, subcategory=$8,
         description=$9, color=$10, material=$11, size_class=$12, weight_g=$13, dimensions=$14,
         condition=$15, value=$16, value_typical=$17, abilities=$18, tags=$19, location_guess=$20,
         is_item=$21, search_text=$22 || ' ' || lower(coalesce(location->>'place','') || ' ' || coalesce(location->>'address','')),
         updated_at=now()
       WHERE id = $1 AND household_id = $23`,
      [
        id, card.name, card.brand, card.model, card.type, card.rarity, RARITY_RANK[card.rarity as Rarity],
        card.subcategory, card.description, card.color, card.material, card.size_class, card.weight_g,
        card.dimensions, card.condition, card.value, card.value.typical, JSON.stringify(card.abilities),
        card.tags, card.location_guess, card.is_item, searchText(card, null), hid,
      ],
    );
    if (!rowCount) return null;
    // Only a changed value adds a point to the price history.
    await this.db.query(
      `INSERT INTO item_value_history (item_id, typical)
       SELECT $1::uuid, $2::bigint
       WHERE $2::bigint IS DISTINCT FROM
         (SELECT typical FROM item_value_history WHERE item_id = $1 ORDER BY at DESC, id DESC LIMIT 1)`,
      [id, card.value.typical],
    );
    return this.get(hid, id, url);
  }

  // Records where the item was last seen.
  async move(hid: string, id: string, location: NewLocation, url: UrlFor): Promise<Item | null> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const now = new Date().toISOString();
      const loc = { ...location, at: now };
      const { rows } = await client.query(
        `SELECT ${ITEM_COLUMNS} FROM items WHERE id = $1 AND household_id = $2 FOR UPDATE`, [id, hid]);
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const card = toItem(rows[0], url, this.base);
      await client.query(
        'UPDATE items SET location = $2, search_text = $3, updated_at = now() WHERE id = $1',
        [id, loc, searchText(card, loc)],
      );
      await insertLocation(client, id, loc);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return this.get(hid, id, url);
  }

  // One JSON column on the item: lent (null = back home), purchase, comps.
  async setJson(hid: string, id: string, column: 'lent' | 'purchase' | 'comps', value: Lent | Purchase | Comps | null, url: UrlFor) {
    const { rowCount } = await this.db.query(
      `UPDATE items SET ${column} = $3, updated_at = now() WHERE id = $1 AND household_id = $2`,
      [id, hid, value],
    );
    return rowCount ? this.get(hid, id, url) : null;
  }

  async remove(hid: string, id: string): Promise<boolean> {
    const { rowCount } = await this.db.query('DELETE FROM items WHERE id = $1 AND household_id = $2', [id, hid]);
    return !!rowCount;
  }

  async image(id: string, kind: 'full' | 'thumb'): Promise<ImageBlob | null> {
    const cols = kind === 'thumb' ? 'thumb_mime AS mime, thumb AS data' : 'mime, data';
    const { rows } = await this.db.query<ImageBlob>(`SELECT ${cols} FROM item_images WHERE item_id = $1`, [id]);
    return rows[0] ?? null;
  }
}

async function insertLocation(client: { query: Db['query'] }, id: string, h: ItemLocation) {
  await client.query(
    `INSERT INTO item_locations (item_id, place, lat, lng, accuracy_m, source, address, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, h.place || '', h.lat, h.lng, h.accuracy_m, h.source || 'manual', h.address || '', h.at],
  );
}
