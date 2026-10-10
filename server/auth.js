// Passwords (scrypt), session tokens, input validation and Google ID-token verification.
import { scrypt, randomBytes, timingSafeEqual, createHash, createPublicKey, createVerify } from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scryptAsync(password, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const [kind, N, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scryptAsync(password, Buffer.from(salt, 'base64url'), { N: +N, r: +r, p: +p, keylen: expected.length });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// A hash to burn the same CPU time when the email is unknown (avoids user enumeration by timing).
let dummyHash = null;
export async function burnPasswordCheck(password) {
  if (!dummyHash) dummyHash = await hashPassword('dummy-password-for-timing');
  await verifyPassword(password, dummyHash);
}

export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

// ---------------------------------------------------------------- validation (Thai messages)

export function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const e = email.trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 8) return 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร';
  if (password.length > 128) return 'รหัสผ่านยาวเกินไป';
  return null;
}

// Thai letters/marks (U+0E00–U+0E7F), Latin letters, digits, _ and -, single inner spaces.
const USERNAME_RE = /^[฀-๿A-Za-z0-9_-]+( [฀-๿A-Za-z0-9_-]+)*$/;
export function cleanUsername(name) {
  if (typeof name !== 'string') return { error: 'กรุณาใส่ชื่อผู้เล่น' };
  const n = name.normalize('NFC').trim();
  const len = [...n].length;
  if (len < 3 || len > 20) return { error: 'ชื่อผู้เล่นต้องยาว 3–20 ตัวอักษร' };
  if (!USERNAME_RE.test(n)) return { error: 'ใช้ได้เฉพาะภาษาไทย อังกฤษ ตัวเลข _ และ - (เว้นวรรคได้ทีละช่อง)' };
  return { value: n };
}

export function cleanVillageName(name) {
  if (typeof name !== 'string') return { error: 'กรุณาตั้งชื่อหมู่บ้าน' };
  const n = name.normalize('NFC').trim().replace(/\s+/g, ' ');
  // strip control characters
  if (/[\u0000-\u001F\u007F]/.test(n)) return { error: 'ชื่อหมู่บ้านมีอักขระที่ใช้ไม่ได้' };
  const len = [...n].length;
  if (len < 1 || len > 30) return { error: 'ชื่อหมู่บ้านต้องยาว 1–30 ตัวอักษร' };
  return { value: n };
}

// ---------------------------------------------------------------- Google ID token (RS256 JWT)

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

// fetchJwks: async () => { keys: [JWK], maxAgeSec } — injectable for tests.
export function createGoogleVerifier({ clientId, fetchJwks = fetchGoogleJwks, now = () => Date.now() }) {
  let cache = { keys: null, until: 0 };

  async function keyFor(kid) {
    if (!cache.keys || now() > cache.until || !cache.keys.has(kid)) {
      const { keys, maxAgeSec } = await fetchJwks();
      cache = { keys: new Map(keys.map((k) => [k.kid, k])), until: now() + Math.max(60, maxAgeSec || 3600) * 1000 };
    }
    return cache.keys.get(kid) || null;
  }

  return async function verify(idToken) {
    if (!clientId) throw new Error('google-disabled');
    if (typeof idToken !== 'string' || idToken.length > 4096) throw new Error('bad-token');
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error('bad-token');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (header.alg !== 'RS256' || !header.kid) throw new Error('bad-alg');
    const jwk = await keyFor(header.kid);
    if (!jwk) throw new Error('unknown-key');
    const ok = createVerify('RSA-SHA256')
      .update(`${parts[0]}.${parts[1]}`)
      .verify(createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
    if (!ok) throw new Error('bad-signature');
    if (!GOOGLE_ISSUERS.has(payload.iss)) throw new Error('bad-issuer');
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(clientId)) throw new Error('bad-audience');
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < now() - 60_000) throw new Error('expired');
    if (!payload.sub) throw new Error('no-subject');
    if (payload.email && payload.email_verified !== true && payload.email_verified !== 'true') throw new Error('email-unverified');
    return { sub: String(payload.sub), email: payload.email ? normalizeEmail(payload.email) : null };
  };
}

async function fetchGoogleJwks() {
  const res = await fetch(GOOGLE_CERTS_URL);
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  const m = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  const body = await res.json();
  return { keys: body.keys || [], maxAgeSec: m ? Number(m[1]) : 3600 };
}
