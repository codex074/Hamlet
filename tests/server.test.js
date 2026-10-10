import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from '../server/db.js';
import { createApp, ipKey } from '../server/app.js';
import { createGoogleVerifier, cleanUsername, hashPassword, verifyPassword } from '../server/auth.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_ID = 'test-client.apps.googleusercontent.com';

// Fake Google signing key + JWKS
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
function googleToken(claims, { kid = 'k1', key = privateKey } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'RS256', kid, typ: 'JWT' });
  const body = enc({ iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 600, ...claims });
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

let server, base, db;
before(async () => {
  db = openDb(':memory:');
  const googleVerify = createGoogleVerifier({ clientId: CLIENT_ID, fetchJwks: async () => ({ keys: [jwk], maxAgeSec: 3600 }) });
  server = createServer(createApp({ db, rootDir: ROOT, googleClientId: CLIENT_ID, googleVerify, authLimit: { max: 1000, windowMs: 60_000 } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); });

// Minimal cookie-jar client.
function client() {
  let cookie = '';
  return async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* static file */ }
    return { status: res.status, json, text, headers: res.headers };
  };
}

test('password hashing round-trips and rejects wrong passwords', async () => {
  const h = await hashPassword('correct horse');
  assert.ok(h.startsWith('scrypt$'));
  assert.equal(await verifyPassword('correct horse', h), true);
  assert.equal(await verifyPassword('wrong horse', h), false);
});

test('username validation', () => {
  assert.equal(cleanUsername('ชาวนา_01').value, 'ชาวนา_01');
  assert.equal(cleanUsername('  Lord Hamlet ').value, 'Lord Hamlet');
  assert.ok(cleanUsername('ab').error);
  assert.ok(cleanUsername('a'.repeat(21)).error);
  assert.ok(cleanUsername('bad<script>').error);
  assert.ok(cleanUsername('two  spaces').error);
});

test('register, me, username, logout, login', async () => {
  const call = client();
  assert.equal((await call('GET', '/api/me')).status, 401);
  const reg = await call('POST', '/api/register', { email: 'A@Example.com ', password: 'secret123' });
  assert.equal(reg.status, 200);
  assert.equal(reg.json.user.email, 'a@example.com');
  assert.equal(reg.json.user.username, null);
  assert.match(reg.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await call('GET', '/api/me')).json.user.email, 'a@example.com');
  assert.equal((await call('POST', '/api/username', { username: 'Hamlet ผู้เล่น' })).json.user.username, 'Hamlet ผู้เล่น');
  assert.equal((await call('POST', '/api/logout', {})).status, 200);
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('POST', '/api/login', { email: 'a@example.com', password: 'nope-nope' })).status, 401);
  assert.equal((await call('POST', '/api/login', { email: 'a@example.com', password: 'secret123' })).status, 200);
  assert.equal((await call('GET', '/api/me')).json.user.username, 'Hamlet ผู้เล่น');
});

test('duplicate email and username are rejected', async () => {
  const a = client();
  const b = client();
  await a('POST', '/api/register', { email: 'dup@example.com', password: 'secret123' });
  assert.equal((await b('POST', '/api/register', { email: 'dup@example.com', password: 'secret123' })).status, 409);
  await a('POST', '/api/username', { username: 'Unique1' });
  await b('POST', '/api/register', { email: 'other@example.com', password: 'secret123' });
  assert.equal((await b('POST', '/api/username', { username: 'unique1' })).status, 409);
});

test('weak password and bad email are rejected', async () => {
  const call = client();
  assert.equal((await call('POST', '/api/register', { email: 'x@example.com', password: 'short' })).status, 400);
  assert.equal((await call('POST', '/api/register', { email: 'not-an-email', password: 'secret123' })).status, 400);
});

test('mutations require JSON and same origin', async () => {
  const call = client();
  const plain = await fetch(base + '/api/logout', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(plain.status, 415);
  const cross = await call('POST', '/api/login', { email: 'a@example.com', password: 'x' }, { Origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
});

test('villages: max 3, scoped per user, save round-trip', async () => {
  const alice = client();
  const bob = client();
  await alice('POST', '/api/register', { email: 'alice@example.com', password: 'secret123' });
  await bob('POST', '/api/register', { email: 'bob@example.com', password: 'secret123' });
  const ids = [];
  for (const name of ['หนึ่ง', 'สอง', 'สาม']) {
    const r = await alice('POST', '/api/villages', { name });
    assert.equal(r.status, 200);
    assert.ok(r.json.village.seed > 0);
    ids.push(r.json.village.id);
  }
  assert.equal((await alice('POST', '/api/villages', { name: 'สี่' })).status, 409);
  const list = await alice('GET', '/api/villages');
  assert.equal(list.json.villages.length, 3);
  assert.equal(list.json.max, 3);
  // bob can't see or touch alice's village
  assert.equal((await bob('GET', '/api/villages')).json.villages.length, 0);
  assert.equal((await bob('GET', `/api/villages/${ids[0]}/save`)).status, 404);
  assert.equal((await bob('PUT', `/api/villages/${ids[0]}/save`, { save: 'x', day: 1, pop: 1 })).status, 404);
  assert.equal((await bob('DELETE', `/api/villages/${ids[0]}`, {})).status, 404);
  // save round-trip
  const empty = await alice('GET', `/api/villages/${ids[0]}/save`);
  assert.equal(empty.json.save, null);
  const put = await alice('PUT', `/api/villages/${ids[0]}/save`, { save: '{"version":3}', day: 12, pop: 40 });
  assert.equal(put.status, 200);
  const got = await alice('GET', `/api/villages/${ids[0]}/save`);
  assert.equal(got.json.save, '{"version":3}');
  assert.equal(got.json.village.day, 12);
  assert.equal(got.json.village.pop, 40);
  assert.equal(got.json.village.hasSave, true);
  // rename + delete frees a slot
  assert.equal((await alice('PATCH', `/api/villages/${ids[1]}`, { name: 'เมืองใหม่' })).json.village.name, 'เมืองใหม่');
  assert.equal((await alice('DELETE', `/api/villages/${ids[2]}`, {})).status, 200);
  assert.equal((await alice('POST', '/api/villages', { name: 'สี่' })).status, 200);
});

test('villages require login', async () => {
  const anon = client();
  assert.equal((await anon('GET', '/api/villages')).status, 401);
  assert.equal((await anon('POST', '/api/villages', { name: 'x' })).status, 401);
});

test('google sign-in: valid token creates a user, links by email, rejects forged tokens', async () => {
  const call = client();
  const ok = await call('POST', '/api/google', { credential: googleToken({ sub: 'g-1', email: 'g@example.com', email_verified: true }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.hasGoogle, true);
  assert.equal(ok.json.user.email, 'g@example.com');
  // same Google account → same user
  const again = await client()('POST', '/api/google', { credential: googleToken({ sub: 'g-1', email: 'g@example.com', email_verified: true }) });
  assert.equal(again.json.user.id, ok.json.user.id);
  // existing password account gets linked
  const pw = client();
  const reg = await pw('POST', '/api/register', { email: 'link@example.com', password: 'secret123' });
  const linked = await client()('POST', '/api/google', { credential: googleToken({ sub: 'g-2', email: 'link@example.com', email_verified: true }) });
  assert.equal(linked.json.user.id, reg.json.user.id);
  // the pre-existing (unverified) password and its sessions are revoked
  assert.equal(linked.json.user.hasPassword, false);
  assert.equal((await pw('GET', '/api/me')).status, 401);
  assert.equal((await pw('POST', '/api/login', { email: 'link@example.com', password: 'secret123' })).status, 401);
  // forgeries
  const { privateKey: evilKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const forged = await client()('POST', '/api/google', { credential: googleToken({ sub: 'g-3' }, { key: evilKey }) });
  assert.equal(forged.status, 401);
  const wrongAud = await client()('POST', '/api/google', { credential: googleToken({ sub: 'g-4', aud: 'someone-else' }) });
  assert.equal(wrongAud.status, 401);
  const expired = await client()('POST', '/api/google', { credential: googleToken({ sub: 'g-5', exp: 1000 }) });
  assert.equal(expired.status, 401);
  const unverified = await client()('POST', '/api/google', { credential: googleToken({ sub: 'g-6', email: 'u@example.com', email_verified: false }) });
  assert.equal(unverified.status, 401);
});

test('static: serves the game, blocks everything outside src/ vendor/ index.html', async () => {
  const call = client();
  const index = await call('GET', '/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.equal((await call('GET', '/src/config.js')).status, 200);
  assert.equal((await call('GET', '/server/app.js')).status, 404);
  assert.equal((await call('GET', '/data/hamlet.db')).status, 404);
  assert.equal((await call('GET', '/.git/config')).status, 404);
  assert.equal((await call('GET', '/src/../server/app.js')).status, 404);
  assert.equal((await call('GET', '/%2e%2e/server/app.js')).status, 404);
  assert.equal((await call('GET', '/package.json')).status, 404);
});

test('rate limiting kicks in on repeated logins', async () => {
  const limited = createServer(createApp({ db, rootDir: ROOT, authLimit: { max: 3, windowMs: 60_000 } }));
  await new Promise((r) => limited.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${limited.address().port}/api/login`;
  const statuses = [];
  for (let i = 0; i < 5; i++) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'nobody@example.com', password: 'whatever1' }) });
    statuses.push(res.status);
  }
  limited.close();
  assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
});

test('failed-password limit per account applies across addresses but only counts failures', async () => {
  const limited = createServer(createApp({ db, rootDir: ROOT, trustProxy: true, authLimit: { max: 3, windowMs: 60_000 } }));
  await new Promise((r) => limited.listen(0, '127.0.0.1', r));
  const port = limited.address().port;
  const post = (path, body, ip) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip }, body: JSON.stringify(body),
  }).then((r) => r.status);
  assert.equal(await post('/api/register', { email: 'target@example.com', password: 'right-password' }, '10.1.0.1'), 200);
  // unknown emails never create per-account counters
  for (let i = 0; i < 10; i++) assert.equal(await post('/api/login', { email: `nobody${i}@example.com`, password: 'x'.repeat(8) }, `10.2.0.${i}`), 401);
  // a correct login does not count toward the limit
  assert.equal(await post('/api/login', { email: 'target@example.com', password: 'right-password' }, '10.3.0.1'), 200);
  const statuses = [];
  for (let i = 0; i < 8; i++) statuses.push(await post('/api/login', { email: 'target@example.com', password: 'wrong' + i }, `10.4.0.${i}`));
  limited.close();
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 401, 429, 429]);   // failure ceiling = 2 × max
});

test('ipKey groups IPv6 /64s regardless of notation', () => {
  assert.equal(ipKey('203.0.113.7'), 'ip:203.0.113.7');
  assert.equal(ipKey('::ffff:203.0.113.7'), 'ip:203.0.113.7');
  const a = ipKey('2001:db8:1:2:aaaa::1');
  assert.equal(a, 'ip6:2001:db8:1:2');
  assert.equal(ipKey('2001:0db8:0001:0002:ffff:0:0:9'), a);
  assert.equal(ipKey('2001:db8:0:0::5'), 'ip6:2001:db8:0:0');
  assert.equal(ipKey('2001:db8::5'), 'ip6:2001:db8:0:0');
  assert.notEqual(ipKey('2001:db8:1:3::1'), a);
});
