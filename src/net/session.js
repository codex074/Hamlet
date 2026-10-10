// Boot flow for the game: decide local vs cloud mode, then run auth -> username -> village select.
// startSession() resolves { mode: 'local' } (no server) or { mode: 'cloud', user, village, initialSave, saver, ... }.
import * as api from './api.js';
import { serialize } from '../save.js';
import * as sim from '../sim.js';
import {
  authScreen, usernameScreen, villageSelectScreen, choiceModal, closeScreens, toMs,
} from '../ui/screens.js';

const BACKUP_PREFIX = 'hamlet-backup-';
const KEEPALIVE_LIMIT = 60000;   // fetch keepalive bodies are capped at 64 KB in browsers
const AUTOSAVE_RETRY_MS = 15000;

// ---------- local storage backup (per village) ----------
function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, val); return true; } catch { return false; }
}
function lsDel(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}
const saveKey = (id) => `${BACKUP_PREFIX}${id}`;
const metaKey = (id) => `${BACKUP_PREFIX}${id}-meta`;

function readBackup(id) {
  const save = lsGet(saveKey(id));
  if (!save) return null;
  try {
    const meta = JSON.parse(lsGet(metaKey(id)) || 'null');
    if (!meta || typeof meta !== 'object') return null;
    return { save, ...meta };
  } catch {
    return null;
  }
}
function clearBackup(id) {
  lsDel(saveKey(id));
  lsDel(metaKey(id));
}

// ---------- mode detection ----------
// Cloud mode = /api/me answers with JSON (200 with a user, or 401). Anything else (404 from a static
// server, HTML error pages, network failure) means there is no Hamlet server: local mode.
async function probe() {
  try {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 6000) : 0;
    let r;
    try {
      r = await api.rawRequest('GET', '/api/me', undefined, ctl ? { signal: ctl.signal } : {});
    } finally {
      clearTimeout(timer);
    }
    if (r.json && r.status === 200 && r.data && r.data.user) return { cloud: true, user: r.data.user };
    if (r.json && r.status === 401) return { cloud: true, user: null };
  } catch {
    // unreachable -> local
  }
  return { cloud: false, user: null };
}

async function getConfig() {
  try {
    const c = await api.get('/api/config');
    return c || {};
  } catch {
    return {};
  }
}

// ---------- cloud saver ----------
function createCloudSaver(village, knownSave) {
  const id = village.id;
  let status = { kind: 'idle', text: '' };
  let listener = null;
  let inflight = null;
  let queued = false;
  let latest = null;
  let lastSaved = knownSave == null ? null : knownSave;   // string the server is known to have
  let retryTimer = 0;

  const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  function setStatus(kind, text) {
    status = { kind, text };
    if (listener) listener(status);
  }

  function metaOf(state) {
    return { day: sim.clock(state).day, pop: sim.summary(state).pop };
  }

  // Writes the crash backup; returns the serialized string.
  function backup(state, str, m) {
    lsSet(saveKey(id), str);
    lsSet(metaKey(id), JSON.stringify({ t: Date.now(), day: m.day, pop: m.pop, synced: false }));
  }

  async function pushOnce(state) {
    const str = serialize(state);
    if (str === lastSaved) return true;
    const m = metaOf(state);
    backup(state, str, m);
    setStatus('saving', '☁️ กำลังบันทึก…');
    try {
      const res = await api.put(`/api/villages/${id}/save`, { save: str, day: m.day, pop: m.pop });
      lastSaved = str;
      lsSet(metaKey(id), JSON.stringify({ t: Date.now(), day: m.day, pop: m.pop, synced: true, serverUpdatedAt: res && res.updatedAt }));
      setStatus('ok', `☁️ บันทึกแล้ว ${hhmm(new Date())}`);
      clearTimeout(retryTimer);
      return true;
    } catch (e) {
      const text = e.status === 401 ? '⚠️ หมดเวลาเข้าสู่ระบบ — โหลดหน้าใหม่' : e.status === 413 ? '⚠️ เซฟใหญ่เกินไป' : '⚠️ บันทึกไม่สำเร็จ';
      setStatus('error', text);
      if (e.status !== 401 && e.status !== 413 && latest) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => { if (latest) saver.save(latest); }, AUTOSAVE_RETRY_MS);
      }
      return false;
    }
  }

  const saver = {
    get status() { return status; },
    setStatusListener(fn) { listener = fn; if (fn) fn(status); },
    // Debounced: while a PUT is in flight further calls collapse into one follow-up save.
    save(state) {
      latest = state;
      if (inflight) {
        queued = true;
        return inflight;
      }
      inflight = (async () => {
        let ok = await pushOnce(latest);
        while (queued) {
          queued = false;
          ok = await pushOnce(latest);
        }
        return ok;
      })().finally(() => { inflight = null; });
      return inflight;
    },
    // Page is going away: refresh the local backup synchronously and, when the body fits keepalive's
    // 64 KB budget, also fire a keepalive PUT. Larger saves rely on the localStorage backup alone
    // (the next load offers it if it is newer than the server copy).
    saveOnExit(state) {
      try {
        const str = serialize(state);
        if (str === lastSaved) return;
        const m = metaOf(state);
        backup(state, str, m);
        const body = JSON.stringify({ save: str, day: m.day, pop: m.pop });
        if (body.length > KEEPALIVE_LIMIT) return;
        api.put(`/api/villages/${id}/save`, { save: str, day: m.day, pop: m.pop }, { keepalive: true }).then(() => {
          lastSaved = str;
          lsSet(metaKey(id), JSON.stringify({ t: Date.now(), day: m.day, pop: m.pop, synced: true }));
        }).catch(() => {});
      } catch { /* ignore */ }
    },
  };
  return saver;
}

// ---------- backup vs server ----------
async function chooseSave(village, serverSave) {
  const bk = readBackup(village.id);
  if (!bk) return { save: serverSave, dirty: false };
  const serverT = toMs(village.updatedAt);
  const newer = !bk.synced && bk.save !== serverSave && bk.t > serverT;
  if (!newer) {
    if (bk.synced || bk.save === serverSave) clearBackup(village.id);
    return { save: serverSave, dirty: false };
  }
  const choice = await choiceModal({
    server: serverSave ? { day: village.day, pop: village.pop, t: serverT } : null,
    local: { day: bk.day, pop: bk.pop, t: bk.t },
  });
  if (choice === 'local') return { save: bk.save, dirty: true };
  clearBackup(village.id);
  return { save: serverSave, dirty: false };
}

// village.settings arrives as an object (or null for villages created before world settings existed);
// tolerate a JSON string too. null -> the save migration / sim defaults decide.
function parseSettings(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object') return o;
    } catch { /* ignore */ }
  }
  return null;
}

// ---------- entry point ----------
export async function startSession() {
  const p = await probe();
  if (!p.cloud) return { mode: 'local', village: null, initialSave: null, saver: null, user: null };

  let user = p.user;
  const cfg = await getConfig();
  let notice = '';
  for (;;) {
    try {
      if (!user) user = await authScreen({ googleClientId: cfg.googleClientId || null, notice });
      notice = '';
      if (!user.username) user = await usernameScreen({ user });
      const choice = await villageSelectScreen({ user });
      if (choice.action === 'logout') {
        user = null;
        continue;
      }
      const { village, save } = choice;
      village.settings = parseSettings(village.settings);
      const picked = await chooseSave(village, save);
      closeScreens();
      return {
        mode: 'cloud',
        user,
        village,
        initialSave: picked.save,
        dirty: picked.dirty,
        saver: createCloudSaver(village, picked.dirty ? null : picked.save),
        // Full navigations: the game restarts cleanly on the select / auth screens.
        backToSelect: () => { location.href = '/?select'; },
        logout: async () => {
          try { await api.post('/api/logout'); } catch { /* ignore */ }
          location.href = '/';
        },
      };
    } catch (e) {
      if (e && e.status === 401) {
        user = null;
        notice = 'หมดเวลาเข้าสู่ระบบ กรุณาเข้าสู่ระบบอีกครั้ง';
        continue;
      }
      throw e;
    }
  }
}
