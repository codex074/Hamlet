// Needs, happiness, taxes, house upgrades, immigration and housing. Pure: no DOM, no globals.
import {
  DAY_LENGTH, NIGHT_START, NIGHT_END, BUILDINGS, HOUSE_LEVELS, SERVICE_STAFFED_DIST, SPAWN,
  IMMIGRATION_MIN_HAPPINESS, IMMIGRATION_MAX_HOMELESS, LEAVE_HAPPINESS, LEAVE_AFTER_DAYS,
  WORLD_SIZE, EDGE_MARGIN,
} from './config.js';
import { distance, nearestStorage, addStock, totalStock } from './economy.js';
import { isWater } from './terrain.js';
import { nodesUnder, findHouseSite } from './placement.js';
import { createVillager, releaseReservations } from './villagers.js';

const MAX_EVENTS = 20;
const NO_ZONE_MESSAGE = 'ระบายโซนที่อยู่อาศัยเพื่อให้ชาวบ้านสร้างบ้าน';
const UNBUILT_HOUSE_CAPACITY = 3;
const MAX_UNBUILT_HOUSES = 2;
const NO_HOUSE_HAPPINESS = 0.6;
const SPAWN_TRIES = 20;

export function pushEvent(state, text) {
  state.events.push({ t: state.time, text });
  while (state.events.length > MAX_EVENTS) state.events.shift();
}

export function clock(state) {
  const day = Math.floor(state.time / DAY_LENGTH) + 1;
  const tod = state.time % DAY_LENGTH;
  const hourF = (tod / DAY_LENGTH) * 24;
  const hour = Math.floor(hourF);
  const minute = Math.floor((hourF - hour) * 60);
  return { day, hour, minute, isNight: hour >= NIGHT_START || hour < NIGHT_END };
}

function isStaffed(state, b) {
  return b.workers.some((id) => {
    const w = state.villagers.find((v) => v.id === id);
    if (!w) return false;
    // workers asleep at home overnight still count as having staffed the building
    return w.role === 'sleeping' || distance(w.x, w.z, b.x, b.z) <= SERVICE_STAFFED_DIST;
  });
}

export function serviceCovered(state, house, service) {
  return state.buildings.some((b) => {
    const cfg = BUILDINGS[b.type];
    return b.built && cfg.service === service
      && distance(house.x, house.z, b.x, b.z) <= cfg.serviceRadius
      && isStaffed(state, b);
  });
}

export function cathedralDone(state) {
  return state.buildings.some((b) => b.type === 'cathedral' && b.built);
}

export function evaluateHouse(state, house) {
  const cfg = HOUSE_LEVELS[house.level - 1];
  house.needsMet = {
    food: house.residents.length > 0 && !house.starvedToday,
    bread: house.breadToday === true,
    religion: serviceCovered(state, house, 'religion'),
    entertainment: serviceCovered(state, house, 'entertainment'),
    cathedral: cathedralDone(state),
  };
  const met = cfg.needs.filter((k) => house.needsMet[k]).length;
  house.happiness = met / cfg.needs.length;
}

// ---------- site creation shared with sim.js ----------

export function newBuilding(state, type, x, z, rot) {
  const cfg = BUILDINGS[type];
  const b = {
    id: state.nextId++, type, x, z, rot,
    built: false, progress: 0, needed: { ...cfg.cost }, incoming: {},
    desiredWorkers: cfg.workers ?? 0, workers: [],
  };
  if (type === 'house') {
    Object.assign(b, {
      zoneId: null, level: 1, residents: [], upgrading: false, starvedToday: false, breadToday: false,
      happiness: 1, unhappyDays: 0,
      needsMet: { food: false, bread: false, religion: false, entertainment: false, cathedral: false },
    });
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

function startUpgrade(state, house) {
  const next = HOUSE_LEVELS[house.level];
  house.upgrading = true;
  house.needed = { ...next.upgradeCost };
  house.incoming = {};
  house.progress = 0;
  pushEvent(state, `บ้านกำลังอัปเกรดเป็น${next.name}`);
}

function removeVillager(state, id) {
  const i = state.villagers.findIndex((v) => v.id === id);
  if (i < 0) return;
  const [v] = state.villagers.splice(i, 1);
  releaseReservations(state, v);
  for (const b of state.buildings) {
    b.workers = b.workers.filter((w) => w !== id);
    if (b.residents) b.residents = b.residents.filter((r) => r !== id);
  }
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

function nextLevelMet(house) {
  return HOUSE_LEVELS[house.level].needs.every((k) => house.needsMet[k]);
}

function processHouse(state, house) {
  evaluateHouse(state, house);
  const tax = HOUSE_LEVELS[house.level - 1].tax;
  let income = house.residents.length * tax * house.happiness;
  if (house.level < 4 && !house.upgrading && nextLevelMet(house)) startUpgrade(state, house);
  updateUnhappiness(state, house);
  house.starvedToday = false;
  house.breadToday = false;
  income = Math.round(income * 10) / 10;
  return income;
}

function averageHappiness(state, hs) {
  let weight = 0;
  let sum = 0;
  for (const h of hs) {
    weight += h.residents.length;
    sum += h.happiness * h.residents.length;
  }
  if (weight > 0) return sum / weight;
  const stock = totalStock(state);
  return stock.berries + stock.bread > 0 ? NO_HOUSE_HAPPINESS : 0;
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
  const stock = totalStock(state);
  if (stock.berries + stock.bread <= 0) {
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
