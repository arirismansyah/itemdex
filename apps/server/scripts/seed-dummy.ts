// Demo data for the game screens: items plus XP events from made-up players, all flagged dummy = true.
// Usage: npm run db:seed-dummy            (add; re-running replaces the old dummy rows)
//        npm run db:seed-dummy -- --remove (delete every dummy row)
//        npm run db:seed-dummy -- --if-missing (do nothing when dummy rows already exist; used by CI)

import '../src/env.js';
import { normalizeCard } from '@itemdex/shared';
import { loadConfig } from '../src/config.js';
import { createPool, migrate } from '../src/db.js';
import { DEFAULT_HOUSEHOLD, ItemsRepo } from '../src/repo.js';

const config = loadConfig();
const db = createPool(config.databaseUrl, 2);
const repo = new ItemsRepo(db, config.currency);

const remove = () => Promise.all([
  db.query('DELETE FROM game_events WHERE dummy'),
  db.query('DELETE FROM items WHERE dummy'), // images, locations and value history cascade
]);

// Pexels photo ids (free licence); '' = no good match, a generated placeholder is used instead.
const PHOTOS: Record<string, string> = {
  'Air Fryer': '29461935', 'Cast Iron Pan': '5639274', 'Blender': '6824660', 'Electric Kettle': '15206538',
  'Mechanical Keyboard': '2582938', 'Noise-Cancelling Headphones': '7054538', 'Smartphone': '3571094',
  'Desk Lamp': '1112598', 'Vintage Vinyl Player': '10676939', 'Acoustic Guitar': '1010519',
  'Board Game Set': '8111367', 'Road Bike': '5807754', 'Cordless Drill': '30413424', 'Toolbox': '9606740',
  'Running Shoes': '8858120', 'Leather Jacket': '18720773', 'Paperback Novel': '775998',
};
const photoUrl = (id: string) => `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=600`;

const ITEMS: [string, string, string, string, number, string][] = [
  // name, type, rarity, room, price, tags
  ['Air Fryer', 'KITCHEN', 'UNCOMMON', 'Kitchen', 850000, 'cooking,appliance'],
  ['Rice Cooker', 'KITCHEN', 'COMMON', 'Kitchen', 400000, 'cooking'],
  ['Cast Iron Pan', 'KITCHEN', 'RARE', 'Kitchen', 600000, 'cooking,heavy'],
  ['Blender', 'KITCHEN', 'COMMON', 'Kitchen', 350000, ''],
  ['Electric Kettle', 'KITCHEN', 'COMMON', 'Kitchen', 200000, 'appliance'],
  ['Gaming Laptop', 'ELECTRONIC', 'EPIC', 'Bedroom', 16500000, 'work,gaming'],
  ['Mechanical Keyboard', 'ELECTRONIC', 'RARE', 'Bedroom', 1800000, 'work'],
  ['Noise-Cancelling Headphones', 'ELECTRONIC', 'EPIC', 'Bedroom', 3900000, 'audio'],
  ['Smartphone', 'ELECTRONIC', 'UNCOMMON', 'Bedroom', 4200000, ''],
  ['Desk Lamp', 'HOME', 'COMMON', 'Bedroom', 150000, ''],
  ['Standing Fan', 'HOME', 'COMMON', 'Living room', 450000, 'appliance'],
  ['Vintage Vinyl Player', 'MUSIC', 'LEGENDARY', 'Living room', 9500000, 'audio,vintage'],
  ['Acoustic Guitar', 'MUSIC', 'RARE', 'Living room', 2800000, 'audio'],
  ['Board Game Set', 'TOY', 'UNCOMMON', 'Living room', 320000, 'family'],
  ['Road Bike', 'SPORT', 'EPIC', 'Garage', 7800000, 'outdoor'],
  ['Cordless Drill', 'TOOL', 'UNCOMMON', 'Garage', 900000, 'repair'],
  ['Toolbox', 'TOOL', 'COMMON', 'Garage', 500000, 'repair'],
  ['Running Shoes', 'FASHION', 'COMMON', 'Bedroom', 1100000, 'outdoor'],
  ['Leather Jacket', 'FASHION', 'RARE', 'Bedroom', 2400000, 'vintage'],
  ['Paperback Novel', 'BOOK', 'COMMON', 'Living room', 90000, ''],
];

// player, events spread over the last N days (more days = longer streak); 0 days = nothing today
const PLAYERS: [string, number, number][] = [
  ['Sakura', 14, 3], ['Budi', 9, 2], ['Rina', 6, 2], ['Dimas', 3, 1], ['Mochi', 1, 1],
];

try {
  await migrate(db);
  if (process.argv.includes('--if-missing')
    // photos were added later: dummy data from before that is replaced
    && (await db.query(`SELECT 1 FROM items WHERE dummy AND image_src <> '' LIMIT 1`)).rowCount) {
    console.log('dummy data already present, skipping');
    process.exit(0);
  }
  await remove();
  if (process.argv.includes('--remove')) {
    console.log('dummy rows removed');
  } else {
    const url = (p: string) => p;
    const ids: string[] = [];
    for (const [i, [name, type, rarity, room, price, tags]] of ITEMS.entries()) {
      const card = normalizeCard({
        name, type, rarity, subcategory: i % 4 ? name.split(' ').pop() : '', description: `Demo ${name}`,
        tags: tags ? tags.split(',') : [], value: { min: price * 0.8, max: price * 1.2, typical: price, new_price: price * 1.3 },
      });
      // Pexels photo by URL; items without a match get a generated SVG so Guess the Price still has a picture.
      const photo = PHOTOS[name];
      const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="360" height="360"><rect width="360" height="360" fill="hsl(${i * 37} 45% 30%)"/><text x="180" y="190" font-size="28" text-anchor="middle" fill="#fff" font-family="monospace">${name}</text></svg>`);
      const pic = { mime: 'image/svg+xml', data: svg };
      const item = await repo.create(DEFAULT_HOUSEHOLD, card,
        { source: 'photo', image: photo ? null : pic, thumb: photo ? null : pic, location: { place: room, lat: null, lng: null, accuracy_m: null, source: 'manual', address: '' } }, url);
      if (photo) await db.query('UPDATE items SET image_src = $2 WHERE id = $1', [item.id, photoUrl(photo)]);
      ids.push(item.id);
    }
    await db.query('UPDATE items SET dummy = true WHERE id = ANY($1)', [ids]);

    // Events: each player adds items on consecutive days ending today, plus some receipts / returns / guesses.
    let n = 0;
    const ev = (player: string, kind: string, pts: number, daysAgo: number, ref = '') =>
      db.query(
        `INSERT INTO game_events (household_id, player, kind, pts, ref, at, dummy)
         VALUES ($1,$2,$3,$4,$5, now() - $6 * interval '1 day' - $7 * interval '1 minute', true) ON CONFLICT DO NOTHING`,
        [DEFAULT_HOUSEHOLD, player, kind, pts, ref, daysAgo, n++]);
    for (const [pi, [player, days, perDay]] of PLAYERS.entries()) {
      for (let d = 0; d < days; d++) {
        for (let k = 0; k < perDay; k++) {
          const id = ids[(pi * 7 + d * 3 + k) % ids.length];
          await ev(player, 'add', 10, d, `dummy:${id}:${d}:${k}`);
        }
        if (d % 3 === 0) await ev(player, 'receipt', 5, d, `dummy:r:${d}`);
        if (d % 4 === 1) await ev(player, 'complete', 10, d, `dummy:c:${d}`);
        if (d % 5 === 2) await ev(player, 'return', pi % 2 ? 10 : -5, d, `dummy:l:${d}`);
        if (d % 2 === 0) await ev(player, 'guess', 5, d, `dummy:g:${d}`);
      }
    }
    console.log(`dummy data added: ${ids.length} items, ${n} events from ${PLAYERS.length} players`);
  }
} finally {
  await db.end();
}
