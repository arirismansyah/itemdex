// PostgreSQL pool + forward-only migrations (run automatically on startup).

import pg from 'pg';

// int8 / numeric -> JS number (values here stay far below 2^53).
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export type Db = pg.Pool;

export function createPool(databaseUrl: string, max = 10): Db {
  // Empty url: node-postgres falls back to PGHOST/PGUSER/PGPASSWORD/PGDATABASE.
  const pool = new pg.Pool({
    connectionString: databaseUrl || undefined,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
  });
  // An idle client losing its connection must not crash the process.
  pool.on('error', (err) => console.error('[itemdex] postgres pool error:', err.message));
  return pool;
}

const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001_init',
    sql: `
      CREATE SEQUENCE IF NOT EXISTS item_number_seq;

      CREATE TABLE IF NOT EXISTS items (
        id             uuid PRIMARY KEY,
        number         integer NOT NULL UNIQUE DEFAULT nextval('item_number_seq'),
        name           text NOT NULL,
        brand          text NOT NULL DEFAULT '',
        model          text NOT NULL DEFAULT '',
        type           text NOT NULL,
        rarity         text NOT NULL,
        rarity_rank    smallint NOT NULL DEFAULT 1,
        subcategory    text NOT NULL DEFAULT '',
        description    text NOT NULL DEFAULT '',
        color          text NOT NULL DEFAULT '',
        material       text NOT NULL DEFAULT '',
        size_class     text NOT NULL,
        weight_g       bigint NOT NULL DEFAULT 0,
        dimensions     jsonb NOT NULL,
        condition      jsonb NOT NULL,
        value          jsonb NOT NULL,
        value_typical  bigint NOT NULL DEFAULT 0,
        abilities      jsonb NOT NULL,
        tags           text[] NOT NULL DEFAULT '{}',
        location_guess text NOT NULL DEFAULT '',
        is_item        boolean NOT NULL DEFAULT true,
        source         text NOT NULL DEFAULT 'photo',
        location       jsonb,
        has_image      boolean NOT NULL DEFAULT false,
        search_text    text NOT NULL DEFAULT '',
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now()
      );
      ALTER SEQUENCE item_number_seq OWNED BY items.number;
      CREATE INDEX IF NOT EXISTS items_created_idx ON items (created_at DESC);
      CREATE INDEX IF NOT EXISTS items_type_idx ON items (type);
      CREATE INDEX IF NOT EXISTS items_value_idx ON items (value_typical DESC);

      -- Images live in their own table so item listings stay small.
      CREATE TABLE IF NOT EXISTS item_images (
        item_id    uuid PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
        mime       text NOT NULL,
        data       bytea NOT NULL,
        thumb_mime text NOT NULL,
        thumb      bytea NOT NULL
      );

      -- "Last seen" history; items.location mirrors the newest row.
      CREATE TABLE IF NOT EXISTS item_locations (
        id         bigserial PRIMARY KEY,
        item_id    uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        place      text NOT NULL DEFAULT '',
        lat        double precision,
        lng        double precision,
        accuracy_m integer,
        source     text NOT NULL DEFAULT 'manual',
        address    text NOT NULL DEFAULT '',
        at         timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS item_locations_item_idx ON item_locations (item_id, at DESC);

      -- Fast substring search when pg_trgm is available (optional).
      DO $$ BEGIN
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
        CREATE INDEX IF NOT EXISTS items_search_trgm_idx ON items USING gin (search_text gin_trgm_ops);
      EXCEPTION WHEN others THEN
        RAISE NOTICE 'pg_trgm not available, search uses a sequential scan';
      END $$;
    `,
  },
  {
    id: '002_households_lifecycle',
    sql: `
      -- Accounts are optional (ACCOUNTS=true); without them everything lives in the default household.
      CREATE TABLE IF NOT EXISTS households (
        id          uuid PRIMARY KEY,
        name        text NOT NULL,
        invite_code text NOT NULL UNIQUE,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO households (id, name, invite_code)
        VALUES ('00000000-0000-0000-0000-000000000001', 'My household', 'default')
        ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS users (
        id           uuid PRIMARY KEY,
        email        text NOT NULL UNIQUE,
        name         text NOT NULL DEFAULT '',
        pass_hash    text NOT NULL,
        household_id uuid NOT NULL REFERENCES households(id),
        created_at   timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash text PRIMARY KEY,
        user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at timestamptz NOT NULL
      );

      ALTER TABLE items
        ADD COLUMN IF NOT EXISTS household_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES households(id),
        ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT '', -- '' = the service currency
        ADD COLUMN IF NOT EXISTS lent jsonb,
        ADD COLUMN IF NOT EXISTS purchase jsonb,
        ADD COLUMN IF NOT EXISTS comps jsonb;
      CREATE INDEX IF NOT EXISTS items_household_idx ON items (household_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS item_value_history (
        id      bigserial PRIMARY KEY,
        item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        typical bigint NOT NULL,
        at      timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS item_value_history_idx ON item_value_history (item_id, at, id);
      INSERT INTO item_value_history (item_id, typical, at) SELECT id, value_typical, created_at FROM items;
    `,
  },
  {
    id: '003_settings',
    sql: `
      -- Settings changed from the app (AI server URL / key / model); they override the environment.
      CREATE TABLE IF NOT EXISTS settings (
        key   text PRIMARY KEY,
        value jsonb NOT NULL
      );
    `,
  },
];

const LOCK_ID = 7_210_001; // advisory lock so parallel instances don't migrate twice

export async function migrate(db: Db, log: (msg: string) => void = console.log): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query<{ id: string }>('SELECT id FROM schema_migrations');
    const done = new Set(rows.map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
        await client.query('COMMIT');
        log(`migration applied: ${m.id}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}
