# Hamlet — Accounts, Cloud Villages & Hosting (Design Spec v4)

Approved 2026-10-10. Target: https://hamlet.codex074.com on the existing Hostinger VPS.

## Architecture
- `server/` — Node 24, zero npm dependencies: `node:http`, `node:sqlite` (DatabaseSync), `node:crypto`.
  Serves the static game (repo root: index.html, src/, vendor/, dev/ excluded) and the JSON API under `/api/`.
- DB: SQLite file at `$DATA_DIR/hamlet.db` (Docker volume). Daily backup copy kept 14 days.
- Docker container `hamlet-server` listening on 127.0.0.1:8090; nginx site `hamlet.codex074.com` proxies to it with TLS by certbot.
- Game simulation stays in the browser; the server stores accounts and saves only.
- If `/api/me` is unreachable (e.g. `./serve.sh` local dev), the client runs in **local mode** (current behaviour, localStorage saves, no login).

## Data
```
users(id INTEGER PK, email TEXT UNIQUE NULL, password_hash TEXT NULL, google_sub TEXT UNIQUE NULL,
      username TEXT UNIQUE NULL COLLATE NOCASE, created_at INTEGER, last_login INTEGER)
sessions(token_hash TEXT PK, user_id INTEGER, created_at INTEGER, expires_at INTEGER)
villages(id INTEGER PK, user_id INTEGER, name TEXT, seed INTEGER, created_at INTEGER, updated_at INTEGER,
         day INTEGER, pop INTEGER, save TEXT NULL, save_size INTEGER)
```
Max 3 villages per user.

## Auth rules
- Password: 8–128 chars; scrypt (N=16384, r=8, p=1, 64-byte key, 16-byte salt) stored as `scrypt$N$r$p$salt$hash`.
- Email: trimmed, lowercased, simple shape check, ≤ 254 chars.
- Session: 32 random bytes, base64url, cookie `hamlet_sid` HttpOnly; Secure (when request is https / behind proxy); SameSite=Lax; Path=/; Max-Age 30 days. DB stores SHA-256 of the token.
- Google: client sends the GIS ID token (`credential`); server verifies RS256 signature against Google JWKS (cached by `Cache-Control` max-age), `iss` ∈ {accounts.google.com, https://accounts.google.com}, `aud` = GOOGLE_CLIENT_ID, `exp` in the future, `email_verified` true. Links to an existing user with the same email if that user has no google_sub yet.
- Rate limit: login/register/google 10 requests / 10 min per IP (in-memory), 429 + Thai message.
- CSRF: state-changing requests must send `Content-Type: application/json` and (when present) an `Origin` matching the host; cookies are SameSite=Lax.
- Username: 3–20 chars, Thai letters/marks, a–z A–Z 0–9 _ - and single spaces (not at ends), unique case-insensitive.

## API (all JSON; errors → `{ error: '<Thai message>' }` with 4xx)
| Method & path | Body | Response |
|---|---|---|
| GET `/api/config` | – | `{ googleClientId: string|null }` |
| GET `/api/me` | – | 200 `{ user: { id, email, username, hasPassword, hasGoogle } }` or 401 |
| POST `/api/register` | `{ email, password }` | 200 `{ user }` + cookie (409 if email exists) |
| POST `/api/login` | `{ email, password }` | 200 `{ user }` + cookie (401 'อีเมลหรือรหัสผ่านไม่ถูกต้อง') |
| POST `/api/google` | `{ credential }` | 200 `{ user }` + cookie |
| POST `/api/logout` | – | 200 `{ ok: true }` clears cookie |
| POST `/api/username` | `{ username }` | 200 `{ user }` (409 'ชื่อนี้มีคนใช้แล้ว') |
| GET `/api/villages` | – | `{ villages: [{ id, name, day, pop, createdAt, updatedAt, hasSave }], max: 3 }` |
| POST `/api/villages` | `{ name }` (1–30 chars) | `{ village }` (seed chosen by server; 409 'มีหมู่บ้านครบ 3 แห่งแล้ว') |
| PATCH `/api/villages/:id` | `{ name }` | `{ village }` |
| DELETE `/api/villages/:id` | – | `{ ok: true }` |
| GET `/api/villages/:id/save` | – | `{ village, save: string|null }` (save = the string from save.js serialize) |
| PUT `/api/villages/:id/save` | `{ save: string, day, pop }` | `{ ok: true, updatedAt }` (413 if > 8 MB) |
All `/api/villages*` and `/api/username` require a session (401 otherwise). Every village query is scoped by `user_id`.

## Client flow
`index.html` boots `src/main.js`, which first calls `src/net/session.js`:
1. GET /api/me → 401 → show **auth screen** (tabs เข้าสู่ระบบ / สมัครสมาชิก, email + password, Google button via GIS script `https://accounts.google.com/gsi/client` rendered only when googleClientId is set).
2. user without username → **username screen**.
3. **village select** (3 slots): create (name), play, rename, delete (confirm by typing the name), shows day/pop/updated time; header shows username + ออกจากระบบ.
4. play → load save (or `createWorld(village.seed)` when none) → game. Autosave every 30 s, on visibilitychange/beforeunload (use `fetch(..., {keepalive:true})`), and on "กลับไปเลือกหมู่บ้าน". A localStorage copy per village id is kept as crash backup; if it is newer than the server copy on load, ask which to use.
5. Menu ☰ adds "กลับไปเลือกหมู่บ้าน" and "ออกจากระบบ"; "เกมใหม่" is hidden in cloud mode (delete/recreate the village instead).
