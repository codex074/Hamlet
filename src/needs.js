// Needs, happiness, taxes, house upgrades, immigration and housing. Pure: no DOM, no globals.
import {
  DAY_LENGTH, NIGHT_START, NIGHT_END, BUILDINGS, HOUSE_LEVELS, SERVICE_STAFFED_DIST, SPAWN,
  IMMIGRATION_MIN_HAPPINESS, IMMIGRATION_MAX_HOMELESS, LEAVE_HAPPINESS, LEAVE_AFTER_DAYS,
  WORLD_SIZE, EDGE_MARGIN, FOODS, CLOTH_PER_HOUSE_PER_DAY, TOOLS_PER_BUILDING_PER_DAY,
} from './config.js';
import { mulberry32 } from './rng.js';
import { distance, nearestStorage, addStock, takeStock, totalStock } from './economy.js';
import { isWater } from './terrain.js';
import { nodesUnder, findHouseSite } from './placement.js';
import { createVillager, removeVillager } from './villagers.js';
import { pushEvent } from './events.js';
import { startUpgrade, upgradeStatus } from './upgrades.js';
import { processSickness } from './sickness.js';

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

export function newBuilding(state, type, x, z, rot) {
  const cfg = BUILDINGS[type];
  const b = {
    id: state.nextId++, type, x, z, rot,
    built: false, progress: 0, needed: { ...cfg.cost }, incoming: {},
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
  for (let i = state.nodes.length - 1; i >= 0; i--) {
    const n = state.nodes[i];
    if (!ids.has(n.id)) continue;
    if (n.kind === 'tree') wood += n.amount;
    state.nodes.splice(i, 1);
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
  removeVillager(state, house.residents[house.residents.length - 1]);
  house.unhappyDays = 0;
  pushEvent(state, 'ชาวบ้านคนหนึ่งย้ายออกจากหมู่บ้านเพราะไม่พอใจ');
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
  const income = house.residents.length * tax * house.happiness;
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
  const hi = WORLD_SIZE - EDGE_MARGIN;
  let x = SPAWN.x;
  let z = SPAWN.z;
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
  const count = 2 + Math.floor(avg * 4);
  for (let i = 0; i < count; i++) {
    const p = edgeSpawn(state, rand);
    state.villagers.push(createVillager(state, p.x, p.z));
  }
  pushEvent(state, `ชาวบ้าน ${count} คนย้ายเข้ามาในหมู่บ้าน`);
}

export function processMidnight(state, rand) {
  const hs = houses(state);
  for (const h of hs) evaluateHouse(state, h);
  // own generator so sickness never disturbs the other random draws
  processSickness(state, mulberry32(((state.seed * 2654435761) ^ Math.floor(state.time)) >>> 0));
  consumeCloth(state, hs);
  equipTools(state);
  let income = 0;
  for (const h of houses(state)) income += processHouse(state, h);
  state.gold = Math.round((state.gold + income) * 10) / 10;
  immigrate(state, houses(state), rand);
}

// ---------- housing ----------

function townhallOf(state) {
  return state.buildings.find((b) => b.type === 'townhall') ?? { x: SPAWN.x, z: SPAWN.z };
}

export function assignHomes(state) {
  const alive = new Map(state.villagers.map((v) => [v.id, v]));
  const hs = houses(state);
  for (const h of hs) h.residents = h.residents.filter((id) => alive.get(id)?.homeId === h.id);
  const ids = new Set(hs.map((h) => h.id));
  for (const v of state.villagers) if (v.homeId != null && !ids.has(v.homeId)) v.homeId = null;
  const hall = townhallOf(state);
  for (const v of state.villagers) {
    if (v.homeId != null) continue;
    let best = null;
    let bestD = Infinity;
    for (const h of hs) {
      if (h.residents.length >= HOUSE_LEVELS[h.level - 1].capacity) continue;
      const d = distance(h.x, h.z, hall.x, hall.z);
      if (d < bestD) {
        best = h;
        bestD = d;
      }
    }
    if (!best) return;
    best.residents.push(v.id);
    v.homeId = best.id;
  }
}

function freeCapacity(state) {
  let free = 0;
  for (const b of state.buildings) {
    if (b.type !== 'house') continue;
    free += b.built
      ? HOUSE_LEVELS[b.level - 1].capacity - b.residents.length
      : UNBUILT_HOUSE_CAPACITY;
  }
  return free;
}

function warnNoZone(state) {
  const dayStart = Math.floor(state.time / DAY_LENGTH) * DAY_LENGTH;
  if (state.events.some((e) => e.text === NO_ZONE_MESSAGE && e.t >= dayStart)) return;
  pushEvent(state, NO_ZONE_MESSAGE);
}

export function planHouses(state, rand) {
  const homeless = state.villagers.filter((v) => v.homeId == null).length;
  if (homeless === 0) return;
  const zones = state.zones.filter((z) => z.kind === 'residential').sort((a, b) => a.id - b.id);
  if (zones.length === 0) {
    warnNoZone(state);
    return;
  }
  const unbuilt = state.buildings.filter((b) => b.type === 'house' && !b.built).length;
  if (homeless <= freeCapacity(state) || unbuilt >= MAX_UNBUILT_HOUSES) return;
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
