// World state, the fixed-step tick and player commands. Pure: no DOM, no globals.
import {
  DAY_LENGTH, SPAWN, START, BUILDINGS, CATHEDRAL_STAGES, HOUSE_LEVELS, NODE_AMOUNT,
  BERRY_REGROW_PER_SEC, REFUND_RATIO, ZONE_BRUSH, RESOURCES, BUILDER_RESERVE, DEER_RESPAWN_SEC,
} from './config.js';
import { mulberry32 } from './rng.js';
import { generateTerrain, generateNodes } from './terrain.js';
import { createWear, decayWear } from './wear.js';
import {
  emptyStock, distance, nearestStorage, addStock, totalStock, isStorage,
} from './economy.js';
import { canPlace as placementCanPlace, canPaintZone as placementCanPaintZone } from './placement.js';
import { stepVillager, failVillager, getBuilding, isSite } from './villagers.js';
import {
  clock, serviceCovered, pushEvent, newBuilding, clearNodesUnder, processMidnight, assignHomes, planHouses,
  evaluateHouse,
} from './needs.js';
import { pushFx } from './events.js';
import { createDeer, stepAnimals } from './animals.js';
import { upgradeStatus, requestUpgrade, setAutoUpgrade } from './upgrades.js';
import {
  createStartingVillagers, processDeaths, villagerAt, villagerInfo, household, populationCounts,
} from './families.js';
import { canBuild, canWork, canTakeJob } from './taskutil.js';

export {
  clock, serviceCovered, upgradeStatus, requestUpgrade, setAutoUpgrade, villagerAt, villagerInfo, household,
};

const MAX_STEP = 0.1;
const INITIAL_SPREAD = 6;
const ZONE_KINDS = ['residential', 'field'];

// ---------- world creation ----------

export function createWorld(seed) {
  const terrain = generateTerrain(seed);
  const state = {
    version: 3, seed, tick: 0, time: (DAY_LENGTH * 6) / 24, lastDay: 1, gold: START.gold, nextId: 1,
    terrain, nodes: generateNodes(seed, terrain), buildings: [], zones: [], villagers: [],
    wear: createWear(), events: [], animals: [], fx: [], deerTimer: DEER_RESPAWN_SEC,
    births: 0, deaths: 0, departed: {},
  };
  const hall = newBuilding(state, 'townhall', SPAWN.x, SPAWN.z, 0);
  hall.built = true;
  hall.progress = 1;
  hall.stock = { ...emptyStock(), ...START.stock };
  state.buildings.push(hall);
  const rand = mulberry32(seed + 1);
  createStartingVillagers(state, rand, () => {
    const rad = INITIAL_SPREAD * Math.sqrt(rand());
    const ang = rand() * Math.PI * 2;
    return { x: SPAWN.x + Math.cos(ang) * rad, z: SPAWN.z + Math.sin(ang) * rad };
  });
  state.animals = createDeer(state);
  pushEvent(state, 'ยินดีต้อนรับสู่หมู่บ้านใหม่ของคุณ เริ่มสร้างโรงตัดไม้และโกดังได้เลย');
  return state;
}

// ---------- queries ----------

export function isUnlocked(state, type) {
  const cfg = BUILDINGS[type];
  if (!cfg || type === 'townhall' || type === 'house') return false;
  return state.villagers.length >= cfg.unlockPop;
}

export function buildingAt(state, x, z) {
  let best = null;
  let bestD = Infinity;
  for (const b of state.buildings) {
    const d = distance(x, z, b.x, b.z);
    if (d <= BUILDINGS[b.type].radius && d < bestD) {
      best = b;
      bestD = d;
    }
  }
  return best;
}

export function canPlace(state, type, x, z, rot) {
  const cfg = BUILDINGS[type];
  if (!cfg || type === 'townhall' || type === 'house') return { ok: false, reason: 'วางอาคารนี้ไม่ได้' };
  if (!isUnlocked(state, type)) {
    return { ok: false, reason: `ยังไม่ปลดล็อก (ต้องมีประชากร ${cfg.unlockPop} คน)` };
  }
  if (type === 'cathedral' && state.buildings.some((b) => b.type === 'cathedral')) {
    return { ok: false, reason: 'มีมหาวิหารอยู่แล้ว' };
  }
  return placementCanPlace(state, type, x, z, rot);
}

export function canPaintZone(state, kind, x, z, r) {
  if (!ZONE_KINDS.includes(kind)) return { ok: false, reason: 'ชนิดโซนไม่ถูกต้อง' };
  if (r < ZONE_BRUSH.min || r > ZONE_BRUSH.max) return { ok: false, reason: 'ขนาดแปรงไม่ถูกต้อง' };
  return placementCanPaintZone(state, kind, x, z, r);
}

export function summary(state) {
  const c = clock(state);
  const hs = state.buildings.filter((b) => b.type === 'house' && b.built);
  let residents = 0;
  let weighted = 0;
  let housing = 0;
  for (const h of hs) {
    housing += HOUSE_LEVELS[h.level - 1].capacity;
    residents += h.residents.length;
    weighted += h.happiness * h.residents.length;
  }
  return {
    stock: totalStock(state), gold: state.gold, pop: state.villagers.length,
    homeless: state.villagers.filter((v) => v.homeId == null).length, housing,
    happiness: residents > 0 ? weighted / residents : 1,
    day: c.day, hour: c.hour, isNight: c.isNight,
    unemployed: state.villagers.filter((v) => v.jobId == null && canBuild(v)).length,
    sick: state.villagers.filter((v) => v.sick).length,
    ...populationCounts(state), births: state.births ?? 0, deaths: state.deaths ?? 0,
  };
}

// ---------- cathedral stages ----------

function beginStage(state, b) {
  const stage = CATHEDRAL_STAGES[b.stage];
  b.needed = { ...stage.cost };
  b.incoming = {};
  b.progress = 0;
  b.goldBlocked = 0;
  if (!stage.gold) return;
  if (state.gold >= stage.gold) state.gold = Math.round((state.gold - stage.gold) * 10) / 10;
  else b.goldBlocked = stage.gold;
}

function retryGold(state, b) {
  if (!(b.goldBlocked > 0) || state.gold < b.goldBlocked) return;
  state.gold = Math.round((state.gold - b.goldBlocked) * 10) / 10;
  b.goldBlocked = 0;
  pushEvent(state, `ใช้ทองสร้างมหาวิหารขั้น${CATHEDRAL_STAGES[b.stage].name}`);
}

// ---------- commands ----------

export function placeBuilding(state, type, x, z, rot) {
  if (!canPlace(state, type, x, z, rot).ok) return null;
  clearNodesUnder(state, x, z, BUILDINGS[type].radius);
  const b = newBuilding(state, type, x, z, rot);
  if (type === 'cathedral') {
    b.stage = 0;
    b.goldBlocked = 0;
    beginStage(state, b);
  }
  state.buildings.push(b);
  pushEvent(state, `เริ่มก่อสร้าง${BUILDINGS[type].name}`);
  return b.id;
}

export function paintZone(state, kind, x, z, r) {
  if (!canPaintZone(state, kind, x, z, r).ok) return null;
  const zone = { id: state.nextId++, kind, x, z, r };
  state.zones.push(zone);
  return zone.id;
}

export function setDesiredWorkers(state, bId, n) {
  const b = getBuilding(state, bId);
  if (!b) return;
  const max = BUILDINGS[b.type].workers ?? 0;
  b.desiredWorkers = Math.max(0, Math.min(max, Math.floor(n)));
}

function deliveredMaterials(b) {
  const out = {};
  const add = (cost, needed = {}) => {
    for (const [res, n] of Object.entries(cost)) out[res] = (out[res] ?? 0) + Math.max(0, n - (needed[res] ?? 0));
  };
  if (b.type === 'cathedral') {
    for (let i = 0; i < b.stage; i++) add(CATHEDRAL_STAGES[i].cost);
    if (b.stage < CATHEDRAL_STAGES.length) add(CATHEDRAL_STAGES[b.stage].cost, b.needed);
  } else if (b.built) add(BUILDINGS[b.type].cost);
  else add(BUILDINGS[b.type].cost, b.needed);
  return out;
}

function refund(state, b) {
  const dest = nearestStorage(state, b.x, b.z, (s) => s.id !== b.id);
  if (!dest) return;
  for (const [res, n] of Object.entries(deliveredMaterials(b))) {
    const back = Math.floor(n * REFUND_RATIO);
    if (back > 0) addStock(dest, res, back);
  }
  if (!isStorage(b)) return;
  for (const res of RESOURCES) addStock(dest, res, b.stock[res] ?? 0);
}

function referencesBuilding(v, id) {
  return v.res?.siteId === id || v.queue.some((t) => t.bId === id);
}

function removeBuilding(state, b) {
  refund(state, b);
  state.buildings.splice(state.buildings.indexOf(b), 1);
  for (const v of state.villagers) {
    if (v.jobId === b.id) v.jobId = null;
    if (v.homeId === b.id) v.homeId = null;
    if (referencesBuilding(v, b.id)) failVillager(state, v);
  }
  pushEvent(state, `รื้อ${BUILDINGS[b.type].name}แล้ว`);
}

export function removeAt(state, x, z) {
  const b = buildingAt(state, x, z);
  if (b && b.type !== 'townhall') {
    removeBuilding(state, b);
    return true;
  }
  if (b) return false;
  for (let i = state.zones.length - 1; i >= 0; i--) {
    const zone = state.zones[i];
    if (distance(x, z, zone.x, zone.z) <= zone.r) {
      state.zones.splice(i, 1);
      return true;
    }
  }
  return false;
}

// ---------- tick ----------

function finishHouse(state, b) {
  if (!b.upgrading) {
    b.built = true;
    b.progress = 1;
    return;
  }
  b.level += 1;
  b.upgrading = false;
  pushFx(state, b.x, b.z, 'upgrade');
  b.progress = 0;
  b.needed = {};
  b.incoming = {};
  pushEvent(state, `บ้านอัปเกรดเป็น${HOUSE_LEVELS[b.level - 1].name}แล้ว`);
}

function finishCathedral(state, b) {
  b.stage += 1;
  if (b.stage < CATHEDRAL_STAGES.length) {
    pushEvent(state, `มหาวิหารสร้างเสร็จขั้น${CATHEDRAL_STAGES[b.stage - 1].name}`);
    beginStage(state, b);
    return;
  }
  b.built = true;
  b.progress = 1;
  b.needed = {};
  b.incoming = {};
  pushEvent(state, 'มหาวิหารสร้างเสร็จสมบูรณ์แล้ว!');
}

function finishConstruction(state, b) {
  if (b.type === 'house') return finishHouse(state, b);
  if (b.type === 'cathedral') return finishCathedral(state, b);
  b.built = true;
  b.progress = 1;
  const cfg = BUILDINGS[b.type];
  if (cfg.storage) b.stock = emptyStock();
  else if (cfg.supply) b.stock = { [cfg.supply]: 0 };
  pushEvent(state, `${BUILDINGS[b.type].name}สร้างเสร็จแล้ว`);
}

function updateConstruction(state) {
  for (const b of state.buildings) {
    if (b.type === 'cathedral') retryGold(state, b);
    if (isSite(b) && b.progress >= 1) finishConstruction(state, b);
  }
}

function regrowBerries(state, dt) {
  const max = NODE_AMOUNT.berry;
  for (const n of state.nodes) {
    if (n.kind === 'berry' && n.amount < max) n.amount = Math.min(max, n.amount + BERRY_REGROW_PER_SEC * dt);
  }
}

function assignJobs(state) {
  const jobs = state.buildings.filter((b) => b.built && BUILDINGS[b.type].job);
  const jobById = new Map(jobs.map((b) => [b.id, b]));
  // Children, pregnant, sick villagers and elders in heavy jobs lose their post.
  for (const v of state.villagers) {
    if (v.jobId == null) continue;
    const b = jobById.get(v.jobId);
    if (!b || !canTakeJob(v, b)) v.jobId = null;
  }
  for (const b of jobs) {
    const mine = state.villagers.filter((v) => v.jobId === b.id);
    while (mine.length > b.desiredWorkers) mine.pop().jobId = null;
    b.workers = mine.map((v) => v.id);
  }
  // Keep a few able adults free as builders/haulers while there is construction work.
  const openSites = state.buildings.filter((b) => !b.built || b.upgrading).length;
  const reserve = Math.min(BUILDER_RESERVE, openSites);
  const free = state.villagers.filter((v) => v.jobId == null && canBuild(v));
  for (let i = jobs.length - 1; i >= 0 && free.length < reserve; i--) {
    const b = jobs[i];
    for (let j = b.workers.length - 1; j >= 0 && free.length < reserve; j--) {
      const v = state.villagers.find((w) => w.id === b.workers[j]);
      if (!v || !canBuild(v)) continue;   // elders cannot act as builders anyway
      v.jobId = null;
      b.workers.splice(j, 1);
      free.push(v);
    }
  }
  // Elders are never builders, so they fill light jobs first.
  const elders = state.villagers.filter((v) => v.jobId == null && canWork(v) && !canBuild(v));
  for (const b of jobs) {
    while (b.workers.length < b.desiredWorkers) {
      let v = null;
      if (BUILDINGS[b.type].light && elders.length > 0) v = elders.shift();
      else if (free.length > reserve) v = free.shift();
      if (!v) break;
      v.jobId = b.id;
      b.workers.push(v.id);
    }
  }
}

function stepWorld(state, dt) {
  state.tick += 1;
  const rand = mulberry32(state.seed * 7919 + state.tick);
  const before = Math.floor(state.time);
  state.time += dt;
  for (const v of state.villagers) stepVillager(state, v, dt, rand);
  stepAnimals(state, dt, rand);
  regrowBerries(state, dt);
  updateConstruction(state);
  if (Math.floor(state.time) !== before) {
    processDeaths(state);
    assignJobs(state);
    for (const b of state.buildings) if (b.type === 'house' && b.built) evaluateHouse(state, b);
    assignHomes(state);
    planHouses(state, rand);
  }
  decayWear(state.wear, dt);
  const day = clock(state).day;
  if (day > state.lastDay) {
    processMidnight(state, rand);
    state.lastDay = day;
  }
}

export function tick(state, dt) {
  let remaining = dt;
  while (remaining > 1e-9) {
    const step = Math.min(MAX_STEP, remaining);
    remaining -= step;
    stepWorld(state, step);
  }
}
