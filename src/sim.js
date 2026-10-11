// World state, the fixed-step tick and player commands. Pure: no DOM, no globals.
import {
  DAY_LENGTH, START, BUILDINGS, CATHEDRAL_STAGES, HOUSE_LEVELS, DIFFICULTY, START_LAYOUT,
  START_STOCK_MUL, START_GOLD_BONUS, BERRY_REGROW_PER_SEC, REFUND_RATIO, ZONE_BRUSH, RESOURCES,
  DEER_RESPAWN_SEC,
} from './config.js';
import { mulberry32 } from './rng.js';
import { generateTerrain, generateNodes } from './terrain.js';
import { createWear, decayWear } from './wear.js';
import { normalizeSettings, worldDims, nodeAmountFor, DEFAULT_SETTINGS, SETTINGS_OPTIONS } from './settings.js';
import { spawnOf } from './world.js';
import {
  createTerritory, isOwned, plotInfo, plotPrice, buyPlot, ownedPlotCount,
} from './territory.js';
import { processRegrowth, growSaplings, countNodes } from './regrowth.js';
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
import { updateBuildingStatus, foodSummary } from './status.js';
import { seasonOf, weatherAt, seasonEffects, updateSnow, seasonChangeText } from './seasons.js';
import {
  ensureMarket, setMarketGoods, MARKET_GOODS, DEFAULT_MARKET_GOODS, priceOf, stockMaxOf,
} from './market.js';
import {
  syncJobs, assignJob, jobChoices, jobCandidates, workforceSummary, workplaceName, waitingReason, jobTitleOf,
  BUILDER, JOB_TITLE, BUILDER_TITLE,
} from './workforce.js';

export {
  clock, serviceCovered, upgradeStatus, requestUpgrade, setAutoUpgrade, villagerAt, villagerInfo, household,
  normalizeSettings, DEFAULT_SETTINGS, SETTINGS_OPTIONS, spawnOf, plotInfo, plotPrice, buyPlot, isOwned,
  assignJob, jobChoices, jobCandidates, workforceSummary, workplaceName, waitingReason, jobTitleOf,
  seasonOf, weatherAt, seasonEffects,
  BUILDER, JOB_TITLE, BUILDER_TITLE, ensureMarket, setMarketGoods, MARKET_GOODS, DEFAULT_MARKET_GOODS, priceOf,
  stockMaxOf,
};

const MAX_STEP = 0.1;
const SLOW_TICK = 1;   // game seconds between berry regrowth / sapling growth / wear decay
const INITIAL_SPREAD = 6;
const ZONE_KINDS = ['residential', 'field'];

// ---------- world creation ----------

export const SAVE_VERSION = 4;

function scaledStock(base, mul) {
  const out = {};
  for (const [res, n] of Object.entries(base)) out[res] = Math.round(n * mul);
  return out;
}

// settings: partial world settings (see normalizeSettings); fixed for the life of the world.
export function createWorld(seed, settings = DEFAULT_SETTINGS) {
  const cfg = normalizeSettings(settings);
  const world = worldDims(cfg);
  const terrain = generateTerrain(seed, cfg);
  const nodes = generateNodes(seed, terrain, cfg);
  const state = {
    version: SAVE_VERSION, seed, tick: 0, time: (DAY_LENGTH * 6) / 24, lastDay: 1,
    gold: START.gold + START_GOLD_BONUS[cfg.startResources], nextId: 1,
    settings: cfg, world, difficulty: 'normal', territory: createTerritory(world.plots),
    terrain, nodes, initialNodes: countNodes(nodes), buildings: [], zones: [], villagers: [],
    wear: createWear(world.grid), events: [], animals: [], fx: [], deerTimer: DEER_RESPAWN_SEC,
    births: 0, deaths: 0, departed: {},
  };
  const spawn = spawnOf(state);
  const hall = newBuilding(state, 'townhall', spawn.x, spawn.z, 0);
  hall.built = true;
  hall.progress = 1;
  hall.stock = { ...emptyStock(), ...scaledStock(START.stock, START_STOCK_MUL[cfg.startResources]) };
  state.buildings.push(hall);
  const rand = mulberry32(seed + 1);
  createStartingVillagers(state, rand, () => {
    const rad = INITIAL_SPREAD * Math.sqrt(rand());
    const ang = rand() * Math.PI * 2;
    return { x: spawn.x + Math.cos(ang) * rad, z: spawn.z + Math.sin(ang) * rad };
  }, START_LAYOUT[cfg.startVillagers]);
  state.animals = createDeer(state);
  state.manualJobs = true;
  state.waterIntro = true;
  pushEvent(state, 'ยินดีต้อนรับสู่หมู่บ้านใหม่ของคุณ เริ่มสร้างโรงตัดไม้และโกดังได้เลย');
  pushEvent(state, '👥 ชาวบ้านยังไม่มีงาน — เปิด "จัดการงาน" แล้วมอบหมายช่างก่อสร้างก่อน จากนั้นจึงส่งคนไปทำงานที่อาคารต่างๆ', {
    kind: 'info', detail: 'ระบบจะไม่ส่งใครไปทำงานเอง ช่างก่อสร้างขนวัสดุและสร้างอาคาร ส่วนอาคารผลิตต้องเลือกคนงานเองที่แผงของอาคาร',
  });
  return state;
}

// Changeable at any time. Returns true if the level was valid.
export function setDifficulty(state, level) {
  if (!Object.hasOwn(DIFFICULTY, level)) return false;
  if (state.difficulty === level) return true;
  state.difficulty = level;
  pushEvent(state, `⚙️ เปลี่ยนความยากเป็น${DIFFICULTY[level].name}`);
  return true;
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
  const stock = totalStock(state);
  return {
    stock, gold: state.gold, pop: state.villagers.length,
    food: foodSummary(state, stock),
    homeless: state.villagers.filter((v) => v.homeId == null).length, housing,
    happiness: residents > 0 ? weighted / residents : 1,
    day: c.day, hour: c.hour, isNight: c.isNight,
    unemployed: workforceSummary(state).free,
    workforce: workforceSummary(state),
    sick: state.villagers.filter((v) => v.sick).length,
    ...populationCounts(state), births: state.births ?? 0, deaths: state.deaths ?? 0,
    ownedPlots: ownedPlotCount(state), totalPlots: (state.world?.plots ?? 0) ** 2,
    difficulty: state.difficulty ?? 'normal',
    season: seasonOf(state), weather: weatherAt(state), snow: state.snow ?? 0,
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

function deliveredMaterials(b) {
  const out = {};
  const add = (cost, needed = {}) => {
    for (const [res, n] of Object.entries(cost)) out[res] = (out[res] ?? 0) + Math.max(0, n - (needed[res] ?? 0));
  };
  if (b.type === 'cathedral') {
    for (let i = 0; i < b.stage; i++) add(CATHEDRAL_STAGES[i].cost);
    if (b.stage < CATHEDRAL_STAGES.length) add(CATHEDRAL_STAGES[b.stage].cost, b.needed);
  } else if (b.built) add(b.cost ?? BUILDINGS[b.type].cost);
  else add(b.cost ?? BUILDINGS[b.type].cost, b.needed);
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
    if (v.jobId === b.id) v.jobId = null;   // the post is gone: the villager becomes free
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
  else if (cfg.job === 'market') ensureMarket(b);
  else if (cfg.supply) b.stock = { [cfg.supply]: 0 };
  pushEvent(state, `${BUILDINGS[b.type].name}สร้างเสร็จแล้ว`);
}

function updateConstruction(state) {
  for (const b of state.buildings) {
    if (b.type === 'cathedral') retryGold(state, b);
    if (isSite(b) && b.progress >= 1) finishConstruction(state, b);
  }
}

// Once per game second: berries regrow, saplings may become trees, paths fade.
function slowTick(state, dt) {
  const max = nodeAmountFor(state.settings, 'berry');
  const regrow = BERRY_REGROW_PER_SEC * seasonEffects(state).berry * dt;   // no regrowth in winter
  if (regrow > 0) {
    for (const n of state.nodes) {
      if (n.kind === 'berry' && n.amount < max) n.amount = Math.min(max, n.amount + regrow);
    }
  }
  updateSnow(state, dt);
  growSaplings(state);
  decayWear(state.wear, dt);
}

function stepWorld(state, dt) {
  state.tick += 1;
  const rand = mulberry32(state.seed * 7919 + state.tick);
  const before = Math.floor(state.time);
  state.time += dt;
  for (const v of state.villagers) stepVillager(state, v, dt, rand);
  stepAnimals(state, dt, rand);
  updateConstruction(state);
  if (Math.floor(state.time) !== before) {
    processDeaths(state);
    updateBuildingStatus(state);
    syncJobs(state);
    for (const b of state.buildings) if (b.type === 'house' && b.built) evaluateHouse(state, b);
    assignHomes(state);
    planHouses(state, rand);
  }
  state.slowTimer = (state.slowTimer ?? 0) + dt;
  if (state.slowTimer >= SLOW_TICK - 1e-9) {
    slowTick(state, state.slowTimer);
    state.slowTimer = 0;
  }
  const day = clock(state).day;
  if (day > state.lastDay) {
    processMidnight(state, rand);
    const news = seasonChangeText(state);
    if (news) pushEvent(state, news, { kind: 'info' });
    processRegrowth(state, mulberry32(((state.seed * 1597334677) ^ Math.floor(state.time)) >>> 0));
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
