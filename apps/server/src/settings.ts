// App-level settings stored in PostgreSQL (override the environment).

import type { Db } from './db.js';

export interface AiSettings { base_url: string; api_key: string; model: string }

export class Settings {
  constructor(private db: Db) {}

  async ai(): Promise<AiSettings | null> {
    const { rows } = await this.db.query<{ value: AiSettings }>("SELECT value FROM settings WHERE key = 'ai'");
    return rows[0]?.value ?? null;
  }

  async setAi(value: AiSettings) {
    await this.db.query(
      "INSERT INTO settings (key, value) VALUES ('ai', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [value],
    );
  }
}
