// End-to-end smoke test against a real PostgreSQL and a fake AI server:
//   DATABASE_URL=postgres://... npm run smoke -w @itemdex/server
// Use an empty scratch database: it creates items and accounts.

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp, loadConfig } from '../src/app.js';
import { fromAnthropicResponse, toAnthropicRequest } from '../src/anthropic.js';
import { migrate } from '../src/db.js';
import { LlmClient, cleanBaseUrl } from '../src/llm.js';

const CARD = {
  is_item: true, name: 'Drill', brand: 'Bosch', model: 'GSB', type: 'TOOL', subcategory: 'drill',
  description: 'x', color: 'blue', material: 'plastic', dimensions: { length_cm: 25, width_cm: 8, height_cm: 22 },
  size_class: 'SMALL', weight_g: 1500, condition: { score: 80, label: 'GOOD', notes: '' },
  value: { min: 400000, max: 600000, typical: 500000, new_price: 900000, confidence: 'MEDIUM', reasoning: 'r' },
  rarity: 'UNCOMMON', abilities: [{ name: 'Drill', power: 40, text: 't' }, { name: 'Spin', power: 20, text: 't' }],
  tags: ['power'], location_guess: 'garage', best_frame: 0,
};
const REPLIES: Record<string, unknown> = {
  itemdex_card: CARD,
  itemdex_room: { items: [{ ...CARD, box: [100, 100, 500, 500] }, { ...CARD, name: 'Speck', box: [0, 0, 5, 5] }] },
  itemdex_listing: { title: 'Bosch drill', description: 'Works great', price: 525000 },
  itemdex_ask: { q: 'garage', types: ['TOOL', 'NOPE'], rarities: [], min_value: 50000, max_value: 0, sort: 'value', flag: 'bogus' },
  itemdex_receipt: { is_receipt: true, store: 'Shop', date: '2026-01-31', total: 150000, warranty_months: 12 },
};

const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const name = JSON.parse(body || '{}').response_format?.json_schema?.name;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') return void res.end(JSON.stringify({ data: [{ id: 'fake' }, { id: 'other' }] }));
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(REPLIES[name] ?? {}) } }] }));
  });
});
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
const llmBase = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

const IMG = 'data:image/png;base64,iVBORw0KGgo=';
const config = (accounts: boolean) => loadConfig({
  logLevel: 'silent', reverseGeocode: false, webDist: null, openapiFile: null, accounts,
  llm: { baseUrl: llmBase, apiKey: '', model: 'fake', timeoutMs: 5000 },
});

// ---------------------------------------------------------------- providers (pure)
assert.equal(cleanBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com/v1', 'bare host gets /v1');
assert.equal(cleanBaseUrl('http://localhost:11434'), 'http://localhost:11434/v1');
assert.equal(cleanBaseUrl('https://x.io/v1/'), 'https://x.io/v1');
assert.equal(cleanBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai'), 'https://generativelanguage.googleapis.com/v1beta/openai', 'Gemini path kept');
const opts = { baseUrl: '', apiKey: 'k', model: 'm', timeoutMs: 1, language: 'English', currency: 'USD', market: 'US' };
assert.equal(new LlmClient({ ...opts, baseUrl: 'https://api.anthropic.com' }).kind, 'anthropic');
assert.equal(new LlmClient({ ...opts, baseUrl: 'https://api.deepseek.com' }).kind, 'openai');
const claudeReq = toAnthropicRequest('claude-x', {
  messages: [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
  ],
  max_tokens: 50, temperature: 0,
  response_format: { type: 'json_schema', json_schema: { name: 'card', schema: { type: 'object' } } },
});
assert.equal(claudeReq.system, 'be brief');
assert.deepEqual(claudeReq.messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
assert.deepEqual(claudeReq.tool_choice, { type: 'tool', name: 'card' });
assert.equal(fromAnthropicResponse({ content: [{ type: 'tool_use', input: { a: 1 } }] }), '{"a":1}');
assert.equal(fromAnthropicResponse({ content: [{ type: 'text', text: 'ok' }] }), 'ok');

// ---------------------------------------------------------------- single user (default household)
{
  const { app, db } = await buildApp(config(false));
  await migrate(db, () => {});
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object, headers = {}) => {
    const res = await app.inject({ method, url: `/api/v1${url}`, payload, headers });
    return { status: res.statusCode, body: res.body.startsWith('{') ? res.json() : res.body, res };
  };

  const scan = (await call('POST', '/scan', { images: [IMG], locale: { currency: 'USD', language: 'English', market: 'US' } })).body;
  assert.equal(scan.currency, 'USD');

  const created = await call('POST', '/items', { card: scan.card, image: IMG, thumb: IMG, source: 'photo', currency: 'USD', location: { place: 'garage' } });
  assert.equal(created.status, 201);
  const id = created.body.item.id as string;
  assert.equal(created.body.item.currency, 'USD');
  assert.equal((await call('GET', `/items/${id}`)).body.item.value_history.length, 1);

  // Lent out / overdue / returned
  assert.equal((await call('PUT', `/items/${id}/lend`, { to: '' })).status, 400);
  assert.equal((await call('PUT', `/items/${id}/lend`, { to: 'Budi', due: '2020-02-30' })).status, 400);
  assert.equal((await call('PUT', `/items/${id}/lend`, { to: 'Budi', due: '2020-01-01' })).status, 200);
  let stats = (await call('GET', '/stats')).body;
  assert.deepEqual([stats.flags.lent, stats.flags.overdue, stats.total_value], [1, 1, 0], 'USD item is not summed into the IDR total');
  assert.equal((await call('GET', '/items?flag=overdue')).body.total, 1);
  await call('DELETE', `/items/${id}/lend`);
  assert.equal((await call('GET', '/items?flag=lent')).body.total, 0);

  // Receipt -> warranty (Jan 31 + 12 months)
  const r = (await call('POST', `/items/${id}/receipt`, { image: IMG })).body.item.purchase;
  assert.deepEqual([r.store, r.date, r.warranty_until], ['Shop', '2026-01-31', '2027-01-31']);

  // Price history + sell-now: value rises 500k -> 600k, then drops
  const set = (typical: number) => call('PATCH', `/items/${id}`, { card: { value: { typical, max: Math.max(typical, 600000) } } });
  assert.equal((await call('GET', `/items/${id}`)).body.item.sell_now, false, 'one point is not a trend');
  await set(600000);
  const up = (await call('GET', `/items/${id}`)).body.item;
  assert.deepEqual([up.sell_now, up.value_history.length], [true, 2]);
  assert.equal((await call('GET', '/items?flag=sell_now')).body.total, 1);
  assert.equal((await call('GET', '/stats')).body.flags.sell_now, 1);
  await set(600000);
  assert.equal((await call('GET', `/items/${id}`)).body.item.value_history.length, 2, 'unchanged value adds no point');
  await set(520000);
  assert.equal((await call('GET', `/items/${id}`)).body.item.sell_now, false, 'below the peak');

  // AI server settings: saved in the DB, key never returned, URL cleaned, bad input rejected
  const ai0 = (await call('GET', '/settings/ai')).body;
  assert.deepEqual([ai0.source, ai0.model, ai0.has_key, ai0.editable], ['env', 'fake', false, true]);
  assert.equal((await call('PUT', '/settings/ai', { base_url: 'ftp://x', model: 'm' })).status, 400);
  assert.equal((await call('PUT', '/settings/ai', { base_url: llmBase, model: '' })).status, 400);
  const probe = (await call('POST', '/settings/ai/test', { base_url: `${llmBase}/v1/`, model: 'nope' })).body;
  assert.deepEqual([probe.ok, probe.models], [false, ['fake', 'other']], 'reachable but model missing');
  const good = (await call('POST', '/settings/ai/test', { base_url: llmBase, model: 'other' })).body;
  assert.deepEqual([good.ok, /accepts images/.test(good.message)], [true, true]);
  assert.equal((await call('POST', '/settings/ai/test', { base_url: 'http://127.0.0.1:1', model: 'm' })).body.ok, false);
  const ai1 = (await call('PUT', '/settings/ai', { base_url: `${llmBase}/v1/`, model: 'other', api_key: 'sekret' })).body;
  assert.deepEqual([ai1.source, ai1.base_url, ai1.model, ai1.has_key, ai1.provider], ['app', `${llmBase}/v1`, 'other', true, 'openai']);
  assert.ok(!JSON.stringify(ai1).includes('sekret'));
  assert.equal((await call('PUT', '/settings/ai', { base_url: llmBase, model: 'fake' })).body.has_key, true, 'empty key keeps the saved one');
  assert.equal((await call('PUT', '/settings/ai', { base_url: llmBase, model: 'fake', clear_key: true })).body.has_key, false);

  // Shopee not connected: status says so and the price check refuses (value stays the AI estimate)
  assert.equal((await call('GET', '/shopee')).body.connected, false);
  assert.equal((await call('POST', `/items/${id}/comps`)).status, 409);

  // Listing, ask, room, reports
  assert.equal((await call('POST', `/items/${id}/listing`, { platform: 'tokopedia' })).body.listing.price, 525000);
  const ask = (await call('POST', '/ask', { query: 'tools in the garage over 50k' })).body.filters;
  assert.deepEqual([ask.q, ask.types, ask.min_value, ask.flag], ['garage', ['TOOL'], 50000, '']);
  assert.equal((await call('GET', '/items?type=TOOL&min_value=50000&q=garage&sort=value')).body.total, 1);
  assert.equal((await call('GET', '/items?min_value=99999999')).body.total, 0);
  const room = (await call('POST', '/scan/room', { image: IMG })).body;
  assert.deepEqual([room.items.length, room.items[0].box, room.items[1].box], [2, [100, 100, 500, 500], null]);
  assert.match((await call('GET', '/report?format=csv')).body as string, /Drill/);
  const html = (await call('GET', '/report?format=html')).body as string;
  assert.match(html, /ITEMDEX inventory report/);

  // CSV injection guard
  await call('POST', '/items', { card: { ...CARD, name: '=HYPERLINK("x")' }, source: 'photo' });
  assert.match((await call('GET', '/report')).body as string, /"'=HYPERLINK/);

  await app.close();
}

// ---------------------------------------------------------------- accounts: households are isolated
{
  const { app } = await buildApp(config(true));
  const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, token = '') => {
    const res = await app.inject({ method, url: `/api/v1${url}`, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.statusCode, body: res.json() };
  };
  assert.equal((await call('GET', '/stats')).status, 401);
  assert.equal((await call('POST', '/auth/register', { email: 'bad', password: 'longenough' })).status, 400);
  const a = (await call('POST', '/auth/register', { email: 'a@x.io', password: 'password-a', name: 'A' })).body;
  const b = (await call('POST', '/auth/register', { email: 'b@x.io', password: 'password-b' })).body;
  assert.equal((await call('POST', '/auth/register', { email: 'A@x.io', password: 'password-a' })).status, 409);
  assert.equal((await call('POST', '/auth/login', { email: 'a@x.io', password: 'nope-nope' })).status, 401);

  const item = (await call('POST', '/items', { card: CARD, source: 'photo' }, a.token)).body.item;
  assert.equal((await call('GET', `/items/${item.id}`, undefined, b.token)).status, 404, 'other household cannot read it');
  assert.equal((await call('GET', '/items', undefined, b.token)).body.total, 0);

  const code = (await call('GET', '/auth/me', undefined, a.token)).body.household.invite_code;
  assert.equal((await call('POST', '/auth/register', { email: 'c@x.io', password: 'password-c', invite_code: 'default' })).status, 400, 'default household is not joinable');
  const c = (await call('POST', '/auth/register', { email: 'c@x.io', password: 'password-c', invite_code: code })).body;
  assert.equal((await call('GET', `/items/${item.id}`, undefined, c.token)).status, 200, 'invited member shares the collection');

  // only the first account may change the AI server
  assert.equal((await call('GET', '/settings/ai', undefined, a.token)).body.editable, true);
  assert.equal((await call('GET', '/settings/ai', undefined, b.token)).body.editable, false);
  assert.equal((await call('PUT', '/settings/ai', { base_url: llmBase, model: 'x' }, b.token)).status, 403);
  assert.equal((await call('POST', '/settings/ai/test', { base_url: llmBase }, b.token)).status, 403);

  await call('POST', '/auth/logout', undefined, c.token);
  assert.equal((await call('GET', '/stats', undefined, c.token)).status, 401);
  await app.close();
}

fake.close();
console.log('smoke ok');
