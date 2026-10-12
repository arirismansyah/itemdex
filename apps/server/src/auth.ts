// Optional accounts (ACCOUNTS=true): email + password, bearer sessions, one household per user.
// Household members share one collection; an invite code lets others join.

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { AuthUser, Household, Session } from '@itemdex/shared';
import type { Db } from './db.js';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const SESSION_DAYS = 30;
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

async function hash(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${(await scrypt(password, salt, 32)).toString('hex')}`;
}

async function verify(password: string, stored: string): Promise<boolean> {
  const [salt, key] = stored.split(':');
  const given = await scrypt(password, Buffer.from(salt, 'hex'), 32);
  const want = Buffer.from(key, 'hex');
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

export class AuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class Accounts {
  constructor(private db: Db) {}

  private async open(user: AuthUser & { household_id: string }): Promise<Session> {
    const token = crypto.randomBytes(32).toString('hex');
    await this.db.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + $3 * interval '1 day')`,
      [sha(token), user.id, SESSION_DAYS],
    );
    const { rows } = await this.db.query('SELECT id, name FROM households WHERE id = $1', [user.household_id]);
    return { token, user: { id: user.id, email: user.email, name: user.name }, household: rows[0] };
  }

  async register(email: string, password: string, name: string, inviteCode: string): Promise<Session> {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AuthError(400, 'Enter a valid email');
    if (password.length < 8) throw new AuthError(400, 'Password must be at least 8 characters');
    let household: string;
    if (inviteCode) {
      const { rows } = await this.db.query('SELECT id FROM households WHERE invite_code = $1 AND invite_code <> $2', [inviteCode, 'default']);
      if (!rows[0]) throw new AuthError(400, 'Invalid invite code');
      household = rows[0].id;
    } else {
      household = crypto.randomUUID();
      await this.db.query('INSERT INTO households (id, name, invite_code) VALUES ($1, $2, $3)', [
        household, `${name || email.split('@')[0]}'s household`, crypto.randomBytes(4).toString('hex'),
      ]);
    }
    const id = crypto.randomUUID();
    try {
      await this.db.query(
        'INSERT INTO users (id, email, name, pass_hash, household_id) VALUES ($1, $2, $3, $4, $5)',
        [id, email.toLowerCase(), name, await hash(password), household],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new AuthError(409, 'Email already registered');
      throw err;
    }
    return this.open({ id, email: email.toLowerCase(), name, household_id: household });
  }

  async login(email: string, password: string): Promise<Session> {
    const { rows } = await this.db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    // Verify even for unknown emails so response time does not reveal which exist.
    const ok = await verify(password, rows[0]?.pass_hash ?? `${'0'.repeat(32)}:${'0'.repeat(64)}`);
    if (!rows[0] || !ok) throw new AuthError(401, 'Wrong email or password');
    return this.open(rows[0]);
  }

  async logout(token: string) {
    await this.db.query('DELETE FROM sessions WHERE token_hash = $1', [sha(token)]);
  }

  // Bearer token -> user + household, or null.
  async resolve(token: string): Promise<{ user: AuthUser; householdId: string } | null> {
    if (!token) return null;
    const { rows } = await this.db.query(
      `SELECT u.id, u.email, u.name, u.household_id FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha(token)],
    );
    return rows[0] ? { user: { id: rows[0].id, email: rows[0].email, name: rows[0].name }, householdId: rows[0].household_id } : null;
  }

  async household(id: string): Promise<Household> {
    const [h, m] = await Promise.all([
      this.db.query('SELECT id, name, invite_code FROM households WHERE id = $1', [id]),
      this.db.query('SELECT id, email, name FROM users WHERE household_id = $1 ORDER BY created_at', [id]),
    ]);
    return { ...h.rows[0], members: m.rows };
  }
}
