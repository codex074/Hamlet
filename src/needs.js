// Needs, happiness, taxes, house upgrades, immigration and housing. Pure: no DOM, no globals.
import {
  DAY_LENGTH, NIGHT_START, NIGHT_END, BUILDINGS, HOUSE_LEVELS, SERVICE_STAFFED_DIST,
  IMMIGRATION_MIN_HAPPINESS, IMMIGRATION_MAX_HOMELESS, LEAVE_HAPPINESS, LEAVE_AFTER_DAYS, NEED_INFO,
  EDGE_MARGIN, FOODS, CLOTH_PER_HOUSE_PER_DAY, TOOLS_PER_BUILDING_PER_DAY,
} from './config.js';
import { mulberry32 } from './rng.js';
import { distance, nearestStorage, addStock, takeStock, totalStock } from './economy.js';
import { isWater } from './terrain.js';
import { nodesUnder, findHouseSite } from './placement.js';
import { createVillager, removeVillager } from './villagers.js';
import { pushEvent } from './events.js';
import { startUpgrade, upgradeStatus } from './upgrades.js';
import { processSickness } from './sickness.js';
import {
  processDeaths, processFamilies, spawnImmigrantGroup, homelessUnits, packUnits, attachToFamily,
} from './families.js';
import { stageOf } from './taskutil.js';
import { fullName } from './names.js';
import { foodSummary } from './status.js';
import { sizeOf, spawnOf } from './world.js';
import { removeNode, getNode } from './nodeindex.js';
import { difficultyOf } from './settings.js';

export { pushEvent };
const NO_ZONE_MESSAGE = 'ระบายโซนที่อยู่อาศัยเพื่อให้ชาวบ้านสร้างบ้าน';
const UNBUILT_HOUSE_CAPACITY = 3;
const MAX_UNBUILT_HOUSES = 2;
const NO_HOUSE_HAPPINESS = 0.6;
const SPAWN_TRIES = 20;

export function clock(state) {
  const day = Math.floor(state.time / DAY_LENGTH) + 1;
  const tod = state.time % DAY_LENGTH;
  const hourF = (tod / DAY_LENGTH) * 24;
  const hour = Math.floor(hourF);
  const minute = Math.floor((hourF - hour) * 60);
  return { day, hour, minute, isNight: hour >= NIGHT_START || hour < NIGHT_END };
}

// Workers stand at the door, so big buildings (market radius 6) need a wider staffing zone.
function staffedDist(b) {
  return Math.max(SERVICE_STAFFED_DIST, BUILDINGS[b.type].radius + 1);
}

function isStaffed(state, b) {
  return b.workers.some((id) => {
    const w = state.villagers.find((v) => v.id === id);
    if (!w || w.sick) return false;
    // workers asleep at home overnight still count as having staffed the building
    return w.role === 'sleeping' || distance(w.x, w.z, b.x, b.z) <= staffedDist(b);
  });
}

// Built, staffed service building in range (and stocked with its supply, if it needs one).
function coversHouse(state, house, b, service) {
  const cfg = BUILDINGS[b.type];
  return b.built && cfg.service === service
    && distance(house.x, house.z, b.x, b.z) <= cfg.serviceRadius
    && (!cfg.supply || (b.stock?.[cfg.supply] ?? 0) > 0)
    && isStaffed(state, b);
}

export function serviceCovered(state, house, service) {
  return state.buildings.some((b) => coversHouse(state, house, b, service));
}

export function cathedralDone(state) {
  return state.buildings.some((b) => b.type === 'cathedral' && b.built);
}

export function evaluateHouse(state, house) {
  const cfg = HOUSE_LEVELS[house.level - 1];
  const foods = house.foodsToday?.length ?? 0;
  house.needsMet = {
    food: house.residents.length > 0 && !house.starvedToday,
    variety2: foods >= 2,
    variety3: foods >= 3,
    religion: serviceCovered(state, house, 'religion'),
    entertainment: serviceCovered(state, house, 'entertainment'),
    health: serviceCovered(state, house, 'health'),
    clothing: serviceCovered(state, house, 'clothing'),
    cathedral: cathedralDone(state),
  };
  const met = cfg.needs.filter((k) => house.needsMet[k]).length;
  house.happiness = met / cfg.needs.length;
}

// ---------- site creation shared with sim.js ----------

export function emptyNeeds() {
  return {
    food: false, variety2: false, variety3: false, religion: false, entertainment: false,
    health: false, clothing: false, cathedral: false,
  };
}

// Construction cost of a NEW placement under the world's difficulty (rounded up, at least 1 per resource).
export function scaledCost(state, cost) {
  const mul = difficultyOf(state).cost;
  if (mul === 1) return { ...cost };
  const out = {};
  for (const [res, n] of Object.entries(cost)) out[res] = Math.max(1, Math.ceil(n * mul - 1e-9));
  return out;
}

export function newBuilding(state, type, x, z, rot) {
  const cfg = BUILDINGS[type];
  const cost = type === 'cathedral' ? { ...cfg.cost } : scaledCost(state, cfg.cost);
  const b = {
    id: state.nextId++, type, x, z, rot, cost,
    built: false, progress: 0, needed: { ...cost }, incoming: {},
    desiredWorkers: cfg.workers ?? 0, workers: [],
  };
  if (type === 'house') {
    Object.assign(b, {
      zoneId: null, level: 1, residents: [], upgrading: false, starvedToday: false, foodsToday: [],
      happiness: 1, unhappyDays: 0, autoUpgrade: true, needsMet: emptyNeeds(),
    });
  } else {
    b.tooled = false;
    if (cfg.job === 'ranch') b.cycle = 0;
  }
  return b;
}

// Removes nodes under a footprint (in place); felled tree wood goes to the nearest storage.
export function clearNodesUnder(state, x, z, r) {
  const ids = new Set(nodesUnder(state, x, z, r));
  if (ids.size === 0) return;
  let wood = 0;
  for (const id of ids) {
    const n = getNode(state, id);
    if (!n) continue;
    if (n.kind === 'tree') wood += n.amount;
    removeNode(state, n);
  }
  const store = nearestStorage(state, x, z);
  if (wood > 0 && store) addStock(store, 'wood', wood);
}

// ---------- midnight ----------

function houses(state) {
  return state.buildings.filter((b) => b.type === 'house' && b.built);
}

function updateUnhappiness(state, house) {
  if (house.residents.length === 0 || house.happiness >= LEAVE_HAPPINESS) {
    house.unhappyDays = 0;
    return;
  }
  house.unhappyDays += 1;
  if (house.unhappyDays < LEAVE_AFTER_DAYS) return;
  const byId = new Map(state.villagers.map((v) => [v.id, v]));
  const grown = house.residents.filter((id) => byId.has(id) && stageOf(byId.get(id)) !== 'child');
  const pool = grown.length > 0 ? grown : house.residents;
  const leaver = byId.get(pool[pool.length - 1]);
  const missing = unmetNeeds(state, house);
  const who = leaver ? fullName(leaver) : 'ชาวบ้านคนหนึ่ง';
  const level = HOUSE_LEVELS[house.level - 1];
  pushEvent(state, `😞 ${who} ย้ายออก — ขาด${missing.map((m) => m.name).join(', ') || 'ความสุข'}`, {
    kind: 'warn', bId: house.id, x: house.x, z: house.z,
    detail: `บ้านระดับ ${house.level} (${level.name}) มีความสุข ${Math.round(house.happiness * 100)}% `
      + `ต่ำกว่า ${Math.round(LEAVE_HAPPINESS * 100)}% ติดกัน ${house.unhappyDays} วัน`
      + (missing.length ? ` · ${missing.map((m) => `${m.name}: ${m.why}`).join(' · ')}` : ''),
  });
  removeVillager(state, pool[pool.length - 1]);
  house.unhappyDays = 0;
}

// Needs of the house's current level that were not met, each with a concrete reason.
export function unmetNeeds(state, house) {
  const level = HOUSE_LEVELS[house.level - 1];
  const met = house.needsMet || {};
  const out = [];
  for (const key of level.needs) {
    if (met[key]) continue;
    out.push({ key, name: NEED_INFO[key] ?? key, why: needReason(state, house, key) });
  }
  return out;
}

function needReason(state, house, key) {
  const service = (svc, building) => {
    const any = state.buildings.some((b) => b.built && BUILDINGS[b.type].service === svc);
    if (!any) return `ยังไม่มี${building}`;
    return `ไม่มี${building}ที่มีคนประจำ${svc === 'health' || svc === 'clothing' ? 'และของพร้อม' : ''}ในระยะ`;
  };
  switch (key) {
    case 'food': {
      const f = foodSummary(state, totalStock(state));
      if (f.net < 0) {
        return `ผลิตอาหารได้ ${f.inPerDay}/วัน แต่ชาวบ้าน ${state.villagers.length} คนต้องการราว ${f.demandPerDay}/วัน — สร้างคนเก็บของป่า ท่าประมง หรือนักล่าเพิ่ม`;
      }
      if (f.stock <= 0) return 'คลังอาหารหมด มีคนในบ้านหิวจนเกือบอด';
      return 'มีคนในบ้านหิวจนเกือบอด — โกดังที่มีอาหารอาจอยู่ไกลจากบ้านเกินไป ลองสร้างโกดังใกล้ย่านบ้าน';
    }
    case 'variety2':
    case 'variety3': {
      const n = (house.foodsToday ?? []).length;
      return `กินอาหารได้ ${n} ชนิด ต้องการ ${key === 'variety2' ? 2 : 3} ชนิด`;
    }
    case 'religion': return service('religion', 'โบสถ์');
    case 'entertainment': return service('entertainment', 'โรงเตี๊ยม');
    case 'health': return service('health', 'สถานพยาบาล');
    case 'clothing': return service('clothing', 'ตลาด');
    case 'cathedral': return 'มหาวิหารยังสร้างไม่เสร็จ';
    default: return 'ยังไม่ได้รับ';
  }
}

// Covering market with cloth in stock for this house, or null.
function clothMarket(state, house) {
  return state.buildings.find((b) => coversHouse(state, house, b, 'clothing')) ?? null;
}

// Houses at a clothing level use up cloth from the market that covers them.
function consumeCloth(state, hs) {
  for (const h of hs) {
    if (!HOUSE_LEVELS[h.level - 1].needs.includes('clothing') || !h.needsMet.clothing) continue;
    const market = clothMarket(state, h);
    if (market) takeStock(market, 'cloth', CLOTH_PER_HOUSE_PER_DAY);
  }
}

// Each working building takes tools from the nearest storage for the coming day.
function equipTools(state) {
  for (const b of state.buildings) {
    const cfg = BUILDINGS[b.type];
    const works = b.built && cfg.job && !cfg.storage && (cfg.category === 'resource' || cfg.category === 'production');
    b.tooled = false;
    if (!works || b.workers.length < 1) continue;
    const store = nearestStorage(state, b.x, b.z, (s) => (s.stock.tools ?? 0) >= TOOLS_PER_BUILDING_PER_DAY);
    if (!store) continue;
    takeStock(store, 'tools', TOOLS_PER_BUILDING_PER_DAY);
    b.tooled = true;
  }
}

function processHouse(state, house) {
  const tax = HOUSE_LEVELS[house.level - 1].tax;
  const income = house.residents.length * tax * house.happiness * difficultyOf(state).tax;
  if (house.autoUpgrade && upgradeStatus(state, house).canUpgrade) startUpgrade(state, house);
  updateUnhappiness(state, house);
  house.starvedToday = false;
  house.foodsToday = [];
  return Math.round(income * 10) / 10;
}

function foodStock(state) {
  const stock = totalStock(state);
  return FOODS.reduce((sum, f) => sum + (stock[f] ?? 0), 0);
}

function averageHappiness(state, hs) {
  let weight = 0;
  let sum = 0;
  for (const h of hs) {
    weight += h.residents.length;
    sum += h.happiness * h.residents.length;
  }
  if (weight > 0) return sum / weight;
  return foodStock(state) > 0 ? NO_HOUSE_HAPPINESS : 0;
}

function edgeSpawn(state, rand) {
  const lo = EDGE_MARGIN;
  const hi = sizeOf(state) - EDGE_MARGIN;
  let x = spawnOf(state).x;
  let z = spawnOf(state).z;
  for (let i = 0; i < SPAWN_TRIES; i++) {
    const t = lo + rand() * (hi - lo);
    const edge = Math.floor(rand() * 4);
    x = edge === 0 ? lo : edge === 1 ? hi : t;
    z = edge === 2 ? lo : edge === 3 ? hi : t;
    if (!isWater(state.terrain, x, z)) break;
  }
  return { x, z };
}

function immigrate(state, hs, rand) {
  const homeless = state.villagers.filter((v) => v.homeId == null).length;
  const avg = averageHappiness(state, hs);
  if (avg < IMMIGRATION_MIN_HAPPINESS || homeless > IMMIGRATION_MAX_HOMELESS) return;
  if (foodStock(state) <= 0) {
    pushEvent(state, 'ไม่มีใครอยากย้ายเข้ามา เพราะหมู่บ้านไม่มีอาหาร');
    return;
  }
  const count = Math.max(1, Math.round((2 + Math.floor(avg * 4)) * difficultyOf(state).immigration));
  const p = edgeSpawn(state, rand);
  let arrived = 0;
  while (arrived < count) {
    arrived += spawnImmigrantGroup(state, rand, () => p, count - arrived).length;
  }
  pushEvent(state, `ชาวบ้าน ${count} คนย้ายเข้ามาในหมู่บ้าน`);
}

export function processMidnight(state, rand) {
  processDeaths(state);
  const hs = houses(state);
  for (const h of hs) evaluateHouse(state, h);
  // own generator so sickness never disturbs the other random draws
  processSickness(state, mulberry32(((state.seed * 2654435761) ^ Math.floor(state.time)) >>> 0));
  // families draw from their own generator too
  processFamilies(state, mulberry32(((state.seed * 40503) ^ Math.floor(state.time)) >>> 0));
  consumeCloth(state, hs);
  equipTools(state);
  let income = 0;
  for (const h of houses(state)) income += processHouse(state, h);
  state.gold = Math.round((state.gold + income) * 10) / 10;
  immigrate(state, houses(state), rand);
}

// ---------- housing ----------

function townhallOf(state) {
  return state.buildings.find((b) => b.type === 'townhall') ?? spawnOf(state);
}

function houseSlots(state, hs) {
  const hall = townhallOf(state);
  return hs
    .map((h) => ({
      id: h.id, house: h, cap: HOUSE_LEVELS[h.level - 1].capacity, count: h.residents.length,
      free: HOUSE_LEVELS[h.level - 1].capacity - h.residents.length, d: distance(h.x, h.z, hall.x, hall.z),
    }))
    .sort((a, b) => a.d - b.d || a.id - b.id);
}

// Houses households as units: couples and their minor children move in together; singles fill the rest.
export function assignHomes(state) {
  const alive = new Map(state.villagers.map((v) => [v.id, v]));
  const hs = houses(state);
  for (const h of hs) h.residents = h.residents.filter((id) => alive.get(id)?.homeId === h.id);
  const ids = new Set(hs.map((h) => h.id));
  for (const v of state.villagers) if (v.homeId != null && !ids.has(v.homeId)) v.homeId = null;
  attachToFamily(state);
  const { placed } = packUnits(homelessUnits(state), houseSlots(state, hs));
  for (const { unit, slot } of placed) {
    for (const m of unit.members) {
      slot.house.residents.push(m.id);
      m.homeId = slot.house.id;
      delete m.avoidHomeId;
    }
  }
}

// Houses that do not exist yet count as empty slots of the base capacity.
function plannedSlots(state) {
  const slots = houseSlots(state, houses(state));
  for (const b of state.buildings) {
    if (b.type !== 'house' || b.built) continue;
    slots.push({ id: b.id, cap: UNBUILT_HOUSE_CAPACITY, count: 0, free: UNBUILT_HOUSE_CAPACITY });
  }
  return slots;
}

function warnNoZone(state) {
  const dayStart = Math.floor(state.time / DAY_LENGTH) * DAY_LENGTH;
  if (state.events.some((e) => e.text === NO_ZONE_MESSAGE && e.t >= dayStart)) return;
  pushEvent(state, NO_ZONE_MESSAGE);
}

export function planHouses(state, rand) {
  if (!state.villagers.some((v) => v.homeId == null)) return;
  const zones = state.zones.filter((z) => z.kind === 'residential').sort((a, b) => a.id - b.id);
  if (zones.length === 0) {
    warnNoZone(state);
    return;
  }
  const unbuilt = state.buildings.filter((b) => b.type === 'house' && !b.built).length;
  // families count as units: build only when some household still has no place to go
  const { unplaced } = packUnits(homelessUnits(state), plannedSlots(state));
  if (unplaced.length === 0 || unbuilt >= MAX_UNBUILT_HOUSES) return;
  for (const zone of zones) {
    const site = findHouseSite(state, zone, rand);
    if (!site) continue;
    clearNodesUnder(state, site.x, site.z, BUILDINGS.house.radius);
    const house = newBuilding(state, 'house', site.x, site.z, site.rot);
    house.zoneId = zone.id;
    state.buildings.push(house);
    return;
  }
}
