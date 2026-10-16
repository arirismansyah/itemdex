// Gamification: XP events, levels, streaks, daily quest, dex progress, badges, leaderboard, price guessing.
// No login: a "player" is the name sent in the X-Player header. Everything derives from game_events + items.

import type { Item } from '@itemdex/shared';
import { TYPES } from '@itemdex/shared';
import type { Db } from './db.js';

export const POINTS = { add: 10, receipt: 5, complete: 10, return_ok: 10, return_late: -5, quest: 20 } as const;

const today = () => new Date().toISOString().slice(0, 10);
const MILESTONES = [5, 10, 25, 50, 100, 250, 500, 1000];
const target = (n: number) => MILESTONES.find((m) => m > n) ?? n + 1000;

// Level n needs 25 * (n-1)^2 XP.
export const levelOf = (xp: number) => {
  const level = Math.floor(Math.sqrt(Math.max(0, xp) / 25)) + 1;
  return { level, from: 25 * (level - 1) ** 2, to: 25 * level ** 2 };
};

// Five checks, 20% each.
const CHECKS: [string, (i: Item) => boolean][] = [
  ['photo', (i) => !!i.image_url],
  ['price', (i) => i.value.typical > 0],
  ['category', (i) => !!i.subcategory],
  ['tags', (i) => i.tags.length > 0],
  ['receipt', (i) => !!i.purchase],
];
export const missing = (i: Item) => CHECKS.filter(([, ok]) => !ok(i)).map(([k]) => k);
export const quality = (i: Item) => (CHECKS.length - missing(i).length) * (100 / CHECKS.length);

const QUESTS = [
  { kind: 'add', goal: 3, text: 'Catalogue 3 new items' },
  { kind: 'receipt', goal: 2, text: 'Attach 2 receipts' },
  { kind: 'complete', goal: 1, text: 'Bring 1 item to 100% complete' },
  { kind: 'guess', goal: 3, text: 'Play Guess the Price 3 times' },
];

export class Game {
  constructor(private db: Db, private base: string) {}

  // Idempotent when ref is set: the same (player, kind, ref) scores once.
  async award(hid: string, player: string, kind: string, pts: number, ref = ''): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `INSERT INTO game_events (household_id, player, kind, pts, ref) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [hid, player, kind, pts, ref],
    );
    return !!rowCount;
  }

  // ponytail: loads the whole household and builds the state in JS; push to SQL if collections pass ~10k items.
  async state(hid: string, player: string, items: Item[]) {
    const day = today();
    const [board, days, todayKinds] = await Promise.all([
      this.db.query(
        `SELECT player, sum(pts)::int AS xp,
           coalesce(sum(pts) FILTER (WHERE at >= date_trunc('week', now())), 0)::int AS week,
           count(*) FILTER (WHERE kind = 'add')::int AS added,
           coalesce(sum(pts) FILTER (WHERE kind = 'return'), 0)::int AS karma
         FROM game_events WHERE household_id = $1 GROUP BY player ORDER BY xp DESC, player LIMIT 20`, [hid]),
      this.db.query<{ d: string }>(
        `SELECT DISTINCT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d FROM game_events
         WHERE household_id = $1 AND player = $2 ORDER BY d DESC LIMIT 400`, [hid, player]),
      this.db.query<{ kind: string; n: number }>(
        `SELECT kind, count(*)::int AS n FROM game_events
         WHERE household_id = $1 AND player = $2 AND at >= $3::date GROUP BY kind`, [hid, player, day]),
    ]);

    // Streak: consecutive days with any award, ending today (or yesterday, so it survives until midnight).
    const seen = new Set(days.rows.map((r) => r.d));
    let streak = 0;
    const d = new Date(`${day}T00:00:00Z`);
    if (!seen.has(day)) d.setUTCDate(d.getUTCDate() - 1);
    while (seen.has(d.toISOString().slice(0, 10))) {
      streak++;
      d.setUTCDate(d.getUTCDate() - 1);
    }

    // Daily quest: one per day, same for everyone; the +20 is paid once when it is first seen done.
    const q = QUESTS[Math.floor(Date.parse(day) / 864e5) % QUESTS.length];
    const progress = Math.min(q.goal, todayKinds.rows.find((r) => r.kind === q.kind)?.n ?? 0);
    const done = progress >= q.goal;
    const paid = done && (await this.award(hid, player, 'quest', POINTS.quest, day));

    const mine = board.rows.find((r) => r.player === player);
    if (paid) { // the board was read before the bonus landed
      if (mine) { mine.xp += POINTS.quest; mine.week += POINTS.quest; } else board.rows.push({ player, xp: POINTS.quest, week: POINTS.quest, added: 0, karma: 0 });
    }
    const xp = mine?.xp ?? (paid ? POINTS.quest : 0);
    const lv = levelOf(xp);

    const count = (key: (i: Item) => string | undefined) => {
      const m = new Map<string, number>();
      for (const i of items) { const k = key(i); if (k) m.set(k, (m.get(k) ?? 0) + 1); }
      return m;
    };
    const dex = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n, of: target(n) }));
    const types = count((i) => i.type);
    const rooms = count((i) => i.location?.place.trim().toLowerCase() || undefined);

    const scored = items.map((i) => ({ i, score: quality(i) }));
    const roomItems = new Map<string, number[]>();
    for (const { i, score } of scored) {
      const k = i.location?.place.trim().toLowerCase();
      if (k) roomItems.set(k, [...(roomItems.get(k) ?? []), score]);
    }
    const karma = mine?.karma ?? 0;
    const badges = [
      ['first10', 'First 10', 'Catalogue 10 items', items.length >= 10],
      ['hoard50', 'Hoarder', 'Catalogue 50 items', items.length >= 50],
      ['receipts', 'Receipt Hoarder', 'Attach 20 receipts', items.filter((i) => i.purchase).length >= 20],
      ['tags', 'Tag Master', 'Tag 30 items', items.filter((i) => i.tags.length).length >= 30],
      ['room', 'Room Cleared', 'Have a room of 5+ items, all 100% complete', [...roomItems.values()].some((s) => s.length >= 5 && s.every((x) => x === 100))],
      ['legend', 'Legend Hunter', 'Own a LEGENDARY item', items.some((i) => i.rarity === 'LEGENDARY')],
      ['streak7', 'On Fire', '7-day streak', streak >= 7],
      ['karma', 'Good Neighbour', '50 lend karma', karma >= 50],
    ].map(([id, name, how, got]) => ({ id, name, how, got }));

    return {
      me: { name: player, xp, ...lv, streak, karma },
      quest: { text: q.text, goal: q.goal, progress, done, reward: POINTS.quest },
      dex: { types: dex(types), rooms: dex(rooms).slice(0, 12), all: TYPES.length },
      quality: {
        average: items.length ? Math.round(scored.reduce((s, x) => s + x.score, 0) / items.length) : 100,
        todo: scored.filter((x) => x.score < 100).sort((a, b) => a.score - b.score).slice(0, 6)
          .map(({ i, score }) => ({ id: i.id, name: i.name, score, missing: missing(i) })),
      },
      badges,
      board: board.rows,
    };
  }

  // One random photographed item (without its price) from this household.
  async guessItem(hid: string): Promise<string | null> {
    const { rows } = await this.db.query(
      `SELECT id FROM items WHERE household_id = $1 AND (has_image OR image_src <> '') AND value_typical > 0
         AND currency IN ('', $2) ORDER BY random() LIMIT 1`, [hid, this.base]);
    return rows[0]?.id ?? null;
  }

  // Closer guess = more points; once per item per day.
  async guess(hid: string, player: string, item: Item, guess: number) {
    const actual = item.value.typical;
    const off = Math.abs(guess - actual) / Math.max(1, actual);
    const pts = off <= 0.1 ? 10 : off <= 0.25 ? 5 : off <= 0.5 ? 2 : 0;
    const fresh = await this.award(hid, player, 'guess', pts, `${item.id}:${today()}`);
    return { actual, off_pct: Math.round(off * 100), points: fresh ? pts : 0, repeat: !fresh };
  }
}
