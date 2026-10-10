// Save / load. Pure except for optional globalThis.localStorage access (always inside try/catch).
import { GRID } from './config.js';
import { generateTerrain } from './terrain.js';

const SAVE_KEY = 'hamlet-save-v1';
const ARRAY_FIELDS = ['nodes', 'buildings', 'zones', 'villagers', 'events'];

export function serialize(state) {
  const { terrain, wear, ...rest } = state;
  return JSON.stringify({ ...rest, wear: Array.from(wear) });
}

function parseSave(str) {
  let data;
  try {
    data = JSON.parse(str);
  } catch {
    throw new Error('ไฟล์บันทึกเสียหาย');
  }
  const valid = data && typeof data === 'object' && data.version === 1
    && Number.isFinite(data.seed)
    && ARRAY_FIELDS.every((k) => Array.isArray(data[k]))
    && Array.isArray(data.wear) && data.wear.length === GRID * GRID;
  if (!valid) throw new Error('ไฟล์บันทึกไม่ถูกต้อง');
  return data;
}

export function deserialize(str) {
  const data = parseSave(str);
  return { ...data, terrain: generateTerrain(data.seed), wear: Float32Array.from(data.wear) };
}

function storage() {
  return globalThis.localStorage ?? null;
}

export function saveGame(state) {
  try {
    const ls = storage();
    if (!ls) return false;
    ls.setItem(SAVE_KEY, serialize(state));
    return true;
  } catch {
    return false;
  }
}

export function loadGame() {
  try {
    const ls = storage();
    const raw = ls ? ls.getItem(SAVE_KEY) : null;
    return raw ? deserialize(raw) : null;
  } catch {
    return null;
  }
}

export function clearSave() {
  try {
    storage()?.removeItem(SAVE_KEY);
  } catch {
    // ignore: storage unavailable
  }
}
