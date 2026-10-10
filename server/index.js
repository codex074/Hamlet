// Hamlet game server entry point. Config via environment:
//   PORT (8090), HOST (127.0.0.1), DATA_DIR (./data), GOOGLE_CLIENT_ID, TRUST_PROXY (1 behind nginx), ROOT_DIR (repo root)
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { createGoogleVerifier } from './auth.js';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = Number(env.PORT || 8090);
const HOST = env.HOST || '127.0.0.1';
const DATA_DIR = env.DATA_DIR || join(here, '..', 'data');
const ROOT_DIR = env.ROOT_DIR || join(here, '..');
const GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID || null;
const BACKUP_KEEP = 14;

const db = openDb(join(DATA_DIR, 'hamlet.db'));
const app = createApp({
  db,
  rootDir: ROOT_DIR,
  googleClientId: GOOGLE_CLIENT_ID,
  googleVerify: GOOGLE_CLIENT_ID ? createGoogleVerifier({ clientId: GOOGLE_CLIENT_ID }) : null,
  trustProxy: env.TRUST_PROXY === '1',
});

const server = createServer(app);
server.requestTimeout = 30_000;
server.listen(PORT, HOST, () => {
  console.log(`Hamlet server on http://${HOST}:${PORT} (google ${GOOGLE_CLIENT_ID ? 'on' : 'off'})`);
});

// Daily housekeeping: drop expired sessions, snapshot the database, keep the last BACKUP_KEEP snapshots.
function housekeeping() {
  try {
    db.purgeSessions();
    const dir = join(DATA_DIR, 'backups');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const file = join(dir, `hamlet-${stamp}.db`);
    try { unlinkSync(file); } catch { /* first backup of the day */ }
    db.backup(file);
    const old = readdirSync(dir).filter((f) => f.startsWith('hamlet-')).sort().slice(0, -BACKUP_KEEP);
    for (const f of old) unlinkSync(join(dir, f));
  } catch (err) {
    console.error('housekeeping failed', err);
  }
}
setTimeout(housekeeping, 60_000);
setInterval(housekeeping, 24 * 3600 * 1000);

function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
