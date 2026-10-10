// Save / load. Pure except for optional globalThis.localStorage access (always inside try/catch).
import { GRID, BUILDINGS, DEER_RESPAWN_SEC } from './config.js';
import { generateTerrain, generateNodes } from './terrain.js';
import { createDeer } from './animals.js';
import { emptyNeeds } from './needs.js';
import { migrateVillagersToV3 } from './families.js';

const SAVE_KEY = 'hamlet-save-v1';
const SAVE_VERSION = 3;
const SAVE_VERSIONS = [1, 2, 3];
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
  const fields = data?.version === 1 ? ARRAY_FIELDS : [...ARRAY_FIELDS, 'animals', 'fx'];
  const valid = data && typeof data === 'object' && SAVE_VERSIONS.includes(data.version)
    && Number.isFinite(data.seed)
    && fields.every((k) => Array.isArray(data[k]))
    && Array.isArray(data.wear) && data.wear.length === GRID * GRID;
  if (!valid) throw new Error('ไฟล์บันทึกไม่ถูกต้อง');
  return data;
}

// v1 -> v2: deer, fx, sickness fields, house upgrade/food fields, supply stocks and ore veins.
function migrateV1(state) {
  state.version = 2;
  state.fx = [];
  state.deerTimer = DEER_RESPAWN_SEC;
  for (const b of state.buildings) {
    const cfg = BUILDINGS[b.type];
    if (b.type === 'house') {
      b.autoUpgrade = true;
      b.foodsToday = [];
      delete b.breadToday;
      b.needsMet = emptyNeeds();
    } else {
      b.tooled = false;
      if (cfg.job === 'ranch') b.cycle = 0;
    }
    if (b.built && cfg.supply && !b.stock) b.stock = { [cfg.supply]: 0 };
  }
  for (const v of state.villagers) Object.assign(v, { sick: false, sickDays: 0, healer: null });
  state.animals = createDeer(state);
  addOreNodes(state);
}

// Appends the seed's ore veins (v1 worlds had none), skipping spots under existing buildings.
function addOreNodes(state) {
  let id = state.nodes.reduce((m, n) => Math.max(m, n.id), 0);
  const free = (n) => !state.buildings.some((b) => Math.hypot(b.x - n.x, b.z - n.z) < BUILDINGS[b.type].radius + 1);
  for (const n of generateNodes(state.seed, state.terrain)) {
    if (n.kind === 'ore' && free(n)) state.nodes.push({ ...n, id: ++id });
  }
}

// v2 -> v3: genders, ages, names, couples and parent/child links.
function migrateV2(state) {
  state.version = SAVE_VERSION;
  migrateVillagersToV3(state);
}

export function deserialize(str) {
  const data = parseSave(str);
  const state = { ...data, terrain: generateTerrain(data.seed), wear: Float32Array.from(data.wear) };
  if (data.version === 1) migrateV1(state);
  if (data.version <= 2) migrateV2(state);
  return state;
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
