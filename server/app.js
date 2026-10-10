// HTTP layer: JSON API under /api/ and static game files. createApp() returns a node:http request handler.
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { randomInt } from 'node:crypto';
import {
  hashPassword, verifyPassword, burnPasswordCheck, newToken, hashToken,
  normalizeEmail, passwordProblem, cleanUsername, cleanVillageName,
} from './auth.js';

const SESSION_TTL = 30 * 24 * 3600 * 1000;
const COOKIE = 'hamlet_sid';
const MAX_VILLAGES = 3;
const MAX_SAVE = 8 * 1024 * 1024;
const MAX_BODY = MAX_SAVE + 64 * 1024;
const MAX_SMALL_BODY = 16 * 1024;
const AUTH_LIMIT = { max: 10, windowMs: 10 * 60 * 1000 };

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain',
};
// Only these parts of the repo are public.
const PUBLIC_DIRS = ['src', 'vendor'];
const PUBLIC_FILES = ['index.html'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createApp({ db, rootDir, googleClientId = null, googleVerify = null, trustProxy = false, authLimit = AUTH_LIMIT }) {
  const hits = new Map(); // ip -> [timestamps]

  function rateLimit(ip) {
    const now = Date.now();
    const list = (hits.get(ip) || []).filter((t) => now - t < authLimit.windowMs);
    list.push(now);
    hits.set(ip, list);
    if (hits.size > 10000) hits.clear();
    if (list.length > authLimit.max) throw new HttpError(429, 'ลองหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่');
  }

  const clientIp = (req) => (trustProxy && req.headers['x-real-ip']) || req.socket.remoteAddress || '?';
  const isSecure = (req) => (trustProxy ? req.headers['x-forwarded-proto'] === 'https' : !!req.socket.encrypted);

  function readCookie(req) {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)`).exec(req.headers.cookie || '');
    return m ? m[1] : null;
  }

  function sessionCookie(req, token, maxAgeSec) {
    const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
    if (isSecure(req)) parts.push('Secure');
    return parts.join('; ');
  }

  function startSession(req, res, user) {
    const token = newToken();
    db.createSession(hashToken(token), user.id, SESSION_TTL);
    db.touchLogin(user.id);
    res.setHeader('Set-Cookie', sessionCookie(req, token, SESSION_TTL / 1000));
  }

  function currentUser(req) {
    const token = readCookie(req);
    return token ? db.sessionUser(hashToken(token)) || null : null;
  }

  function requireUser(req) {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ');
    return user;
  }

  const publicUser = (u) => ({
    id: u.id, email: u.email, username: u.username, hasPassword: !!u.password_hash, hasGoogle: !!u.google_sub,
  });
  const publicVillage = (v) => ({
    id: v.id, name: v.name, seed: v.seed, day: v.day, pop: v.pop,
    createdAt: v.created_at, updatedAt: v.updated_at, hasSave: v.save_size > 0,
  });

  // State-changing requests: JSON only, and same-origin when the browser says where it came from.
  function checkMutation(req) {
    const type = (req.headers['content-type'] || '').split(';')[0].trim();
    if (type !== 'application/json') throw new HttpError(415, 'รูปแบบคำขอไม่ถูกต้อง');
    const origin = req.headers.origin;
    if (origin) {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      let ok = false;
      try { ok = new URL(origin).host === host; } catch { ok = false; }
      if (!ok) throw new HttpError(403, 'คำขอไม่ได้มาจากเว็บไซต์นี้');
    }
  }

  async function readJson(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, 'ข้อมูลมีขนาดใหญ่เกินไป');
      chunks.push(chunk);
    }
    if (!size) return {};
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
      return body;
    } catch {
      throw new HttpError(400, 'ข้อมูลไม่ถูกต้อง');
    }
  }

  const villageId = (s) => {
    const id = Number(s);
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(404, 'ไม่พบหมู่บ้าน');
    return id;
  };

  // ---------------------------------------------------------------- routes
  async function api(req, res, path) {
    const method = req.method;
    if (method !== 'GET' && method !== 'HEAD') checkMutation(req);

    if (path === '/api/config' && method === 'GET') return { googleClientId: googleClientId || null };

    if (path === '/api/me' && method === 'GET') return { user: publicUser(requireUser(req)) };

    if (path === '/api/register' && method === 'POST') {
      rateLimit(clientIp(req));
      const body = await readJson(req, MAX_SMALL_BODY);
      const email = normalizeEmail(body.email);
      if (!email) throw new HttpError(400, 'อีเมลไม่ถูกต้อง');
      const problem = passwordProblem(body.password);
      if (problem) throw new HttpError(400, problem);
      if (db.userByEmail(email)) throw new HttpError(409, 'อีเมลนี้สมัครไว้แล้ว ลองเข้าสู่ระบบแทน');
      const user = db.createUser({ email, passwordHash: await hashPassword(body.password) });
      startSession(req, res, user);
      return { user: publicUser(user) };
    }

    if (path === '/api/login' && method === 'POST') {
      rateLimit(clientIp(req));
      const body = await readJson(req, MAX_SMALL_BODY);
      const email = normalizeEmail(body.email);
      const password = typeof body.password === 'string' ? body.password.slice(0, 256) : '';
      const user = email ? db.userByEmail(email) : null;
      if (!user || !user.password_hash) {
        await burnPasswordCheck(password);
        throw new HttpError(401, user ? 'บัญชีนี้ใช้การเข้าสู่ระบบด้วย Google' : 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
      }
      if (!(await verifyPassword(password, user.password_hash))) throw new HttpError(401, 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
      startSession(req, res, user);
      return { user: publicUser(user) };
    }

    if (path === '/api/google' && method === 'POST') {
      rateLimit(clientIp(req));
      if (!googleVerify) throw new HttpError(404, 'ยังไม่เปิดใช้การเข้าสู่ระบบด้วย Google');
      const body = await readJson(req, MAX_SMALL_BODY);
      let info;
      try { info = await googleVerify(body.credential); } catch { throw new HttpError(401, 'ยืนยันตัวตนกับ Google ไม่สำเร็จ'); }
      let user = db.userByGoogle(info.sub);
      if (!user && info.email) {
        // Emails are not verified at registration, so linking also revokes the account's password and sessions
        // (see db.linkGoogle) — otherwise someone could pre-register a victim's email and keep access.
        const byEmail = db.userByEmail(info.email);
        if (byEmail && !byEmail.google_sub) { db.linkGoogle(byEmail.id, info.sub); user = db.userById(byEmail.id); }
      }
      if (!user) user = db.createUser({ email: info.email && !db.userByEmail(info.email) ? info.email : null, googleSub: info.sub });
      startSession(req, res, user);
      return { user: publicUser(user) };
    }

    if (path === '/api/logout' && method === 'POST') {
      const token = readCookie(req);
      if (token) db.deleteSession(hashToken(token));
      res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
      return { ok: true };
    }

    if (path === '/api/username' && method === 'POST') {
      const user = requireUser(req);
      const body = await readJson(req, MAX_SMALL_BODY);
      const { value, error } = cleanUsername(body.username);
      if (error) throw new HttpError(400, error);
      if (value.toLowerCase() !== (user.username || '').toLowerCase() && db.usernameTaken(value)) {
        throw new HttpError(409, 'ชื่อนี้มีคนใช้แล้ว');
      }
      try { db.setUsername(user.id, value); } catch { throw new HttpError(409, 'ชื่อนี้มีคนใช้แล้ว'); }
      return { user: publicUser(db.userById(user.id)) };
    }

    if (path === '/api/villages') {
      const user = requireUser(req);
      if (method === 'GET') return { villages: db.listVillages(user.id).map(publicVillage), max: MAX_VILLAGES };
      if (method === 'POST') {
        const body = await readJson(req, MAX_SMALL_BODY);
        const { value, error } = cleanVillageName(body.name);
        if (error) throw new HttpError(400, error);
        if (db.countVillages(user.id) >= MAX_VILLAGES) throw new HttpError(409, `มีหมู่บ้านครบ ${MAX_VILLAGES} แห่งแล้ว`);
        return { village: publicVillage(db.createVillage(user.id, value, randomInt(1, 2 ** 31 - 1))) };
      }
    }

    const m = /^\/api\/villages\/(\d+)(\/save)?$/.exec(path);
    if (m) {
      const user = requireUser(req);
      const id = villageId(m[1]);
      const v = db.village(id, user.id);
      if (!v) throw new HttpError(404, 'ไม่พบหมู่บ้าน');
      if (!m[2]) {
        if (method === 'PATCH') {
          const body = await readJson(req, MAX_SMALL_BODY);
          const { value, error } = cleanVillageName(body.name);
          if (error) throw new HttpError(400, error);
          db.renameVillage(id, user.id, value);
          return { village: publicVillage(db.village(id, user.id)) };
        }
        if (method === 'DELETE') { db.deleteVillage(id, user.id); return { ok: true }; }
      } else {
        if (method === 'GET') return { village: publicVillage(v), save: db.villageSave(id, user.id) };
        if (method === 'PUT') {
          const body = await readJson(req, MAX_BODY);
          if (typeof body.save !== 'string' || !body.save.length) throw new HttpError(400, 'ไม่มีข้อมูลเซฟ');
          if (body.save.length > MAX_SAVE) throw new HttpError(413, 'เซฟมีขนาดใหญ่เกินไป');
          const day = clampInt(body.day, 1, 1e6, v.day);
          const pop = clampInt(body.pop, 0, 1e6, v.pop);
          const updatedAt = db.writeSave(id, user.id, body.save, day, pop);
          return { ok: true, updatedAt };
        }
      }
    }
    throw new HttpError(404, 'ไม่พบ');
  }

  // ---------------------------------------------------------------- static files
  async function serveStatic(req, res, path) {
    let rel = decodeURIComponent(path).replace(/^\/+/, '');
    if (rel === '') rel = 'index.html';
    const clean = normalize(rel);
    const top = clean.split(sep)[0];
    if (clean.startsWith('..') || !(PUBLIC_FILES.includes(clean) || PUBLIC_DIRS.includes(top))) return notFound(res);
    const file = join(rootDir, clean);
    let info;
    try { info = await stat(file); } catch { return notFound(res); }
    if (!info.isFile()) return notFound(res);
    const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    res.setHeader('ETag', etag);
    // vendor libraries never change in place; game code must always revalidate
    res.setHeader('Cache-Control', top === 'vendor' ? 'public, max-age=604800' : 'no-cache');
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Content-Length': info.size });
    if (req.method === 'HEAD') return res.end();
    res.end(await readFile(file));
  }

  function notFound(res) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }

  function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
  }

  return async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    const path = (req.url || '/').split('?')[0];
    try {
      if (path.startsWith('/api/')) return sendJson(res, 200, await api(req, res, path));
      if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);
      return await serveStatic(req, res, path);
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      console.error(new Date().toISOString(), req.method, path, err);
      return sendJson(res, 500, { error: 'เซิร์ฟเวอร์ขัดข้อง กรุณาลองใหม่' });
    }
  };
}

function clampInt(v, lo, hi, fallback) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}
