// Imports a v0.1 JSON data folder (items.json + media/) into PostgreSQL.
// Usage: npm run db:import-legacy -- "<dir>"
// Default dir: the old desktop app data (~/Library/Application Support/itemdex/itemdex-data on macOS).

import '../src/env.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeCard, SOURCES, type ItemLocation, type Source } from '@itemdex/shared';
import { loadConfig } from '../src/config.js';
import { createPool, migrate } from '../src/db.js';
import { DEFAULT_HOUSEHOLD, ItemsRepo, type ImageBlob } from '../src/repo.js';

function defaultDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library/Application Support/itemdex/itemdex-data');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || home, 'itemdex/itemdex-data');
  return path.join(home, '.config/itemdex/itemdex-data');
}

const dir = path.resolve(process.argv[2] || defaultDir());
const file = path.join(dir, 'items.json');
if (!fs.existsSync(file)) {
  console.error(`not found: ${file}`);
  process.exit(1);
}

const { items = [] } = JSON.parse(fs.readFileSync(file, 'utf8'));
const config = loadConfig();
const db = createPool(config.databaseUrl, 2);
const repo = new ItemsRepo(db, config.currency);

const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

try {
  await migrate(db);
  // Oldest first so numbers follow the original order.
  items.sort((a: { number: number }, b: { number: number }) => (a.number || 0) - (b.number || 0));
  let imported = 0;
  for (const it of items) {
    const exists = await db.query('SELECT 1 FROM items WHERE id = $1', [it.id]);
    if (exists.rowCount) {
      console.log(`skip  #${it.number} ${it.name} (already imported)`);
      continue;
    }
    let image: ImageBlob | null = null;
    if (it.image) {
      const p = path.join(dir, 'media', it.image);
      const ext = path.extname(p).slice(1).toLowerCase();
      if (fs.existsSync(p) && MIME[ext]) image = { mime: MIME[ext], data: fs.readFileSync(p) };
    }
    const history: ItemLocation[] = (it.location_history || []).map((h: ItemLocation) => ({ ...h }));
    const { at: _at, ...location } = it.location || {};
    await repo.create(DEFAULT_HOUSEHOLD, normalizeCard(it), {
      id: it.id,
      createdAt: it.created_at,
      source: (SOURCES as readonly string[]).includes(it.source) ? (it.source as Source) : 'photo',
      location: it.location ? (location as Omit<ItemLocation, 'at'>) : null,
      history,
      image,
      thumb: null,
    }, (p) => p);
    imported++;
    console.log(`ok    #${it.number} ${it.name}`);
  }
  // Keep new numbers after the imported ones.
  await db.query("SELECT setval('item_number_seq', GREATEST((SELECT coalesce(max(number), 0) FROM items), 1))");
  console.log(`imported ${imported} of ${items.length} item(s) from ${dir}`);
} catch (err) {
  console.error(`import failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
