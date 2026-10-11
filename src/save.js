// Save / load. Pure except for optional globalThis.localStorage access (always inside try/catch).
import { GRID, BUILDINGS, DEER_RESPAWN_SEC, MAP_SIZES, PLOT_SIZE, DIFFICULTY, CHILD_AGE, ELDER_AGE } from './config.js';
import { generateTerrain, generateNodes } from './terrain.js';
import { createDeer } from './animals.js';
import { emptyNeeds } from './needs.js';
import { migrateVillagersToV3 } from './families.js';
import { normalizeSettings, worldDims, LEGACY_SETTINGS } from './settings.js';
import { allOwnedTerritory } from './territory.js';
import { countNodes } from './regrowth.js';
import { pushEvent } from './events.js';
import { ensureTutorial } from './tutorial.js';

const SAVE_KEY = 'hamlet-save-v1';
const SAVE_VERSION = 4;
const SAVE_VERSIONS = [1, 2, 3, 4];
const ARRAY_FIELDS = ['nodes', 'buildings', 'zones', 'villagers', 'events'];

export function serialize(state) {
  const { terrain, wear, ...rest } = state;
  return JSON.stringify({ ...rest, wear: Array.from(wear) });
}

// Cells in the wear grid: the small map before v4, otherwise from the saved settings.
function expectedWearLength(data) {
  if (data.version < 4) return GRID * GRID;
  const settings = data.settings;
  if (!settings || typeof settings !== 'object' || !(settings.mapSize in MAP_SIZES)) return -1;
  const territory = data.territory;
  const plots = MAP_SIZES[settings.mapSize] / PLOT_SIZE;
  if (!territory || !Array.isArray(territory.owned) || territory.owned.length !== plots * plots) return -1;
  return (MAP_SIZES[settings.mapSize] / 2) ** 2;
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
    && Array.isArray(data.wear) && data.wear.length === expectedWearLength(data);
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
  for (const n of generateNodes(state.seed, state.terrain, state.settings)) {
    if (n.kind === 'ore' && free(n)) state.nodes.push({ ...n, id: ++id });
  }
}

// v2 -> v3: genders, ages, names, couples and parent/child links.
function migrateV2(state) {
  state.version = 3;
  migrateVillagersToV3(state);
}

// v3 -> v4: world settings, per-world dims, territory (all owned), difficulty, initial node counts.
// The terrain keeps its original single river (legacyRiver) so the village stays on the same map.
function migrateV3(state) {
  state.version = SAVE_VERSION;
  state.settings = { ...LEGACY_SETTINGS };
  state.world = worldDims(state.settings);
  state.territory = allOwnedTerritory(state.world.plots);
  state.difficulty = 'normal';
  state.legacyRiver = true;
  state.initialNodes = countNodes(state.nodes);
}

// Defaults for fields a hand-edited or partial v4 save may lack.
function repairV4(state) {
  state.settings = normalizeSettings(state.settings);
  state.world = worldDims(state.settings);
  state.difficulty = Object.hasOwn(DIFFICULTY, state.difficulty) ? state.difficulty : 'normal';
  state.initialNodes ??= countNodes(state.nodes);
  if (!Array.isArray(state.territory.owned)) state.territory = allOwnedTerritory(state.world.plots);
  state.territory.bought = Number.isFinite(state.territory.bought) ? state.territory.bought : 0;
}

// Saves from before manual job assignment: the jobless adults used to build and haul by themselves,
// so they join the builder crew and the village keeps running exactly as before.
function migrateManualJobs(state) {
  if (state.manualJobs) return;
  state.manualJobs = true;
  for (const v of state.villagers) {
    const adult = (v.age ?? 30) >= CHILD_AGE && (v.age ?? 30) < ELDER_AGE;
    v.builder = v.jobId == null && adult;
    if ((v.age ?? 30) < CHILD_AGE) v.minor = true;
  }
  for (const b of state.buildings) delete b.desiredWorkers;
}

// Saves from before thirst: tell the player once that houses now need a well nearby.
function introduceWater(state) {
  if (state.waterIntro) return;
  state.waterIntro = true;
  pushEvent(state, '💧 ชาวบ้านต้องดื่มน้ำแล้ว — สร้างบ่อน้ำใกล้บ้านและที่ทำงาน (แท็บบริการ)', {
    kind: 'info', detail: 'บ้านทุกระดับต้องการน้ำดื่ม: มีบ่อน้ำ ศาลากลาง หรือตลาดในระยะใกล้ ยิ่งเดินไกลยิ่งหิวและกระหายเร็ว',
  });
}

// Rocks and ore veins used to hold 60 / 80 trips; they now hold 20 / 25 (each trip carries more), so a
// half-mined rock in an old save keeps the same share left.
function rescaleNodes(state) {
  if (state.nodeAmountsV2) return;
  state.nodeAmountsV2 = true;
  for (const n of state.nodes) {
    if (n.kind === 'rock') n.amount = Math.max(1, Math.ceil(n.amount / 3));
    else if (n.kind === 'ore') n.amount = Math.max(1, Math.ceil(n.amount * 25 / 80));
  }
}

export function deserialize(str) {
  const data = parseSave(str);
  const settings = data.version >= 4 ? normalizeSettings(data.settings) : LEGACY_SETTINGS;
  const terrain = generateTerrain(data.seed, settings, { legacy: data.version < 4 || data.legacyRiver === true });
  const state = { ...data, terrain, wear: Float32Array.from(data.wear) };
  if (data.version < 4) state.settings = { ...LEGACY_SETTINGS };
  rescaleNodes(state);   // before migrateV1 adds ore veins that already use the new amounts
  if (data.version === 1) migrateV1(state);
  if (data.version <= 2) migrateV2(state);
  if (data.version <= 3) migrateV3(state);
  else repairV4(state);
  migrateManualJobs(state);
  introduceWater(state);
  ensureTutorial(state);   // villages from before the checklist skip it
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
