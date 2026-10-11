// Items persistence (PostgreSQL).

import crypto from 'node:crypto';
import {
  RARITY_RANK, type Card, type Item, type ItemList, type ItemLocation, type ItemType,
  type Rarity, type Sort, type Source, type Stats,
} from '@itemdex/shared';
import type { Db } from './db.js';

export interface ImageBlob { mime: string; data: Buffer }
export type NewLocation = Omit<ItemLocation, 'at'>;

export interface ListQuery {
  q?: string;
  types?: string[];
  rarities?: string[];
  sort?: Sort;
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

const ITEM_COLUMNS = `id, number, name, brand, model, type, rarity, subcategory, description, color,
  material, size_class, weight_g, dimensions, condition, value, abilities, tags, location_guess,
  is_item, source, location, has_image, created_at, updated_at`;

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
function toItem(row: any, url: UrlFor, history: ItemLocation[] = []): Item {
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
    location: row.location,
    location_history: history,
    image_url: row.has_image ? url(`/media/${row.id}`) : null,
    thumb_url: row.has_image ? url(`/media/${row.id}/thumb`) : null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export class ItemsRepo {
  constructor(private db: Db) {}

  async list(query: ListQuery, url: UrlFor): Promise<ItemList> {
    const where: string[] = [];
    const args: unknown[] = [];
    const arg = (v: unknown) => `$${args.push(v)}`;
    if (query.types?.length) where.push(`type = ANY(${arg(query.types)})`);
    if (query.rarities?.length) where.push(`rarity = ANY(${arg(query.rarities)})`);
    if (query.q) {
      const escaped = query.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
      where.push(`search_text LIKE ${arg(`%${escaped}%`)}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.min(200, Math.max(1, query.limit ?? 60));

    const [rows, agg] = await Promise.all([
      this.db.query(
        `SELECT ${ITEM_COLUMNS} FROM items ${whereSql}
         ORDER BY ${ORDER[query.sort ?? 'new'] ?? ORDER.new}, id
         OFFSET ${offset} LIMIT ${limit}`,
        args,
      ),
      this.db.query<{ total: number; total_value: number }>(
        `SELECT count(*)::int AS total, coalesce(sum(value_typical), 0)::bigint AS total_value
         FROM items ${whereSql}`,
        args,
      ),
    ]);
    return {
      items: rows.rows.map((r) => toItem(r, url)),
      total: agg.rows[0].total,
      total_value: agg.rows[0].total_value,
      offset,
      limit,
    };
  }

  async stats(): Promise<Stats> {
    const { rows } = await this.db.query<{ type: ItemType; n: number; v: number }>(
      'SELECT type, count(*)::int AS n, coalesce(sum(value_typical), 0)::bigint AS v FROM items GROUP BY type',
    );
    return {
      total: rows.reduce((s, r) => s + r.n, 0),
      total_value: rows.reduce((s, r) => s + r.v, 0),
      types: Object.fromEntries(rows.map((r) => [r.type, r.n])),
    };
  }

  async count(): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>('SELECT count(*)::int AS n FROM items');
    return rows[0].n;
  }

  async get(id: string, url: UrlFor): Promise<Item | null> {
    const [item, history] = await Promise.all([
      this.db.query(`SELECT ${ITEM_COLUMNS} FROM items WHERE id = $1`, [id]),
      this.db.query(
        `SELECT place, lat, lng, accuracy_m, source, address, at FROM item_locations
         WHERE item_id = $1 ORDER BY at DESC, id DESC LIMIT 20`,
        [id],
      ),
    ]);
    if (!item.rows[0]) return null;
    const hist = history.rows.map((h) => ({ ...h, at: iso(h.at) })) as ItemLocation[];
    return toItem(item.rows[0], url, hist);
  }

  async create(
    card: Card,
    opts: {
      source: Source; location: NewLocation | null; image: ImageBlob | null; thumb: ImageBlob | null;
      id?: string; createdAt?: string; history?: ItemLocation[];
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
           tags, location_guess, is_item, source, location, has_image, search_text, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$26)`,
        [
          id, card.name, card.brand, card.model, card.type, card.rarity, RARITY_RANK[card.rarity as Rarity],
          card.subcategory, card.description, card.color, card.material, card.size_class, card.weight_g,
          card.dimensions, card.condition, card.value, card.value.typical, JSON.stringify(card.abilities),
          card.tags, card.location_guess, card.is_item, opts.source, location, !!opts.image,
          searchText(card, location), now,
        ],
      );
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
    return (await this.get(id, url))!;
  }

  async update(id: string, card: Card, url: UrlFor): Promise<Item | null> {
    const { rowCount } = await this.db.query(
      `UPDATE items SET name=$2, brand=$3, model=$4, type=$5, rarity=$6, rarity_rank=$7, subcategory=$8,
         description=$9, color=$10, material=$11, size_class=$12, weight_g=$13, dimensions=$14,
         condition=$15, value=$16, value_typical=$17, abilities=$18, tags=$19, location_guess=$20,
         is_item=$21, search_text=$22 || ' ' || lower(coalesce(location->>'place','') || ' ' || coalesce(location->>'address','')),
         updated_at=now()
       WHERE id = $1`,
      [
        id, card.name, card.brand, card.model, card.type, card.rarity, RARITY_RANK[card.rarity as Rarity],
        card.subcategory, card.description, card.color, card.material, card.size_class, card.weight_g,
        card.dimensions, card.condition, card.value, card.value.typical, JSON.stringify(card.abilities),
        card.tags, card.location_guess, card.is_item, searchText(card, null),
      ],
    );
    return rowCount ? this.get(id, url) : null;
  }

  // Records where the item was last seen.
  async move(id: string, location: NewLocation, url: UrlFor): Promise<Item | null> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const now = new Date().toISOString();
      const loc = { ...location, at: now };
      const { rows } = await client.query(`SELECT ${ITEM_COLUMNS} FROM items WHERE id = $1 FOR UPDATE`, [id]);
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const card = toItem(rows[0], url);
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
    return this.get(id, url);
  }

  async remove(id: string): Promise<boolean> {
    const { rowCount } = await this.db.query('DELETE FROM items WHERE id = $1', [id]);
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
