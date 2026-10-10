// Planners and task executors for the newer professions: fishing, ranching, hunting, doctor, market.
// Pure: no DOM, no globals. Wired into villagers.js via JOB_PLANNERS / JOB_EXEC.
import {
  CARRY_MAX, CELL, WORLD_SIZE, FISH_RADIUS, HUNT_RADIUS, HUNT_SHOT_DIST, SUPPLY_MAX, HERBS_PER_HEAL,
  HEAL_TIME, BUILDINGS,
} from './config.js';
import { distance, nearestStorage, nearestStorageWith } from './economy.js';
import { isWater } from './terrain.js';
import {
  DONE, FAIL, getBuilding, getVillager, gotoPoint, gotoBuilding, firstEntry, planWait, countdown,
  moveToward, workTime,
} from './taskutil.js';

const STAFF_GAP = 0.3;
const SERVICE_SHIFT = 8;      // short shifts so staff re-check for patients and restocking
const SHORE_POINTS = 12;
const SHORE_SPACING = 2;
const PEN_SHARE = 0.6;        // ranchers work within this share of the pen radius
const PATIENT_REACH = 1.2;    // doctor stops this close to the patient

// ---------- fishing ----------

function nextToWater(terrain, x, z) {
  return isWater(terrain, x + CELL, z) || isWater(terrain, x - CELL, z)
    || isWater(terrain, x, z + CELL) || isWater(terrain, x, z - CELL);
}

// Land points beside water near the building, nearest first, thinned out by SHORE_SPACING.
function findShore(state, b) {
  const near = BUILDINGS[b.type].radius + 1;
  const cands = [];
  for (let dz = -FISH_RADIUS; dz <= FISH_RADIUS; dz += CELL) {
    for (let dx = -FISH_RADIUS; dx <= FISH_RADIUS; dx += CELL) {
      const x = b.x + dx;
      const z = b.z + dz;
      const d = Math.hypot(dx, dz);
      if (d > FISH_RADIUS || d < near || x < 0 || z < 0 || x > WORLD_SIZE || z > WORLD_SIZE) continue;
      if (!isWater(state.terrain, x, z) && nextToWater(state.terrain, x, z)) cands.push({ x, z, d });
    }
  }
  cands.sort((p, q) => p.d - q.d || p.x - q.x || p.z - q.z);
  const out = [];
  for (const c of cands) {
    if (out.length >= SHORE_POINTS) break;
    if (out.every((o) => Math.hypot(o.x - c.x, o.z - c.z) >= SHORE_SPACING)) out.push({ x: c.x, z: c.z });
  }
  return out;
}

function planFish(state, v, b, cfg, rand) {
  if (!b.shore || b.shore.length === 0) b.shore = findShore(state, b);
  const store = nearestStorage(state, b.x, b.z);
  if (b.shore.length === 0 || !store) return planWait(v, null);
  const spot = b.shore[Math.floor(rand() * b.shore.length) % b.shore.length];
  v.queue.push(
    gotoPoint(spot.x, spot.z),
    { kind: 'produce', bId: b.id, t: workTime(b, cfg.time), out: { ...cfg.output } },
    gotoBuilding(store, spot.x, spot.z),
    { kind: 'put', bId: store.id },
  );
}

// ---------- ranching ----------

function planRanch(state, v, b, cfg, rand) {
  const store = nearestStorage(state, b.x, b.z);
  if (!store) return planWait(v, null);
  const out = cfg.outputs[(b.cycle ?? 0) % cfg.outputs.length];
  b.cycle = (b.cycle ?? 0) + 1;
  const rad = cfg.radius * PEN_SHARE * Math.sqrt(rand());
  const ang = rand() * Math.PI * 2;
  const px = b.x + Math.cos(ang) * rad;
  const pz = b.z + Math.sin(ang) * rad;
  v.queue.push(
    gotoPoint(px, pz),
    { kind: 'produce', bId: b.id, t: workTime(b, cfg.time), out: { ...out } },
    gotoBuilding(store, px, pz),
    { kind: 'put', bId: store.id },
  );
}

// ---------- hunting ----------

function pickDeer(state, b) {
  let best = null;
  let bestD = Infinity;
  for (const a of state.animals ?? []) {
    if (a.reserved != null) continue;
    const d = distance(a.x, a.z, b.x, b.z);
    if (d <= HUNT_RADIUS && d < bestD) {
      best = a;
      bestD = d;
    }
  }
  return best;
}

function planHunt(state, v, b, cfg) {
  const deer = pickDeer(state, b);
  const store = nearestStorage(state, b.x, b.z);
  if (!deer || !store) return planWait(v, null);
  deer.reserved = v.id;
  v.res.animalId = deer.id;
  v.queue.push(
    { kind: 'follow', target: 'animal', id: deer.id, dist: HUNT_SHOT_DIST },
    { kind: 'hunt', animalId: deer.id, t: workTime(b, cfg.time), out: { ...cfg.output } },
    gotoBuilding(store, b.x, b.z),
    { kind: 'put', bId: store.id },
  );
}

// ---------- supplies (infirmary herbs, market cloth) ----------

function staff(v, b) {
  v.queue.push(gotoBuilding(b, v.x, v.z, STAFF_GAP), { kind: 'staff', bId: b.id, t: SERVICE_SHIFT });
}

// Fetches `res` from a storage into the building's own stock; false if nothing to fetch.
function planFetch(state, v, b, res) {
  b.stock ??= { [res]: 0 };
  const missing = Math.floor(SUPPLY_MAX - (b.stock[res] ?? 0));
  const store = missing >= 1 && nearestStorageWith(state, b.x, b.z, res, 1);
  if (!store) return false;
  const n = Math.min(CARRY_MAX, missing, Math.floor(store.stock[res]));
  v.queue.push(
    gotoBuilding(store, v.x, v.z),
    { kind: 'take', bId: store.id, res, n },
    gotoBuilding(b, store.x, store.z),
    { kind: 'supply', bId: b.id },
  );
  return true;
}

function planMarket(state, v, b) {
  if (!planFetch(state, v, b, BUILDINGS[b.type].supply)) staff(v, b);
}

// ---------- doctor ----------

function hasLiveHealer(state, p) {
  return p.healer != null && getVillager(state, p.healer) != null;
}

function pickPatient(state, v, b, cfg) {
  let best = null;
  let bestD = Infinity;
  for (const p of state.villagers) {
    if (!p.sick || p.id === v.id || hasLiveHealer(state, p)) continue;
    if (distance(p.x, p.z, b.x, b.z) > cfg.serviceRadius) continue;
    const d = distance(p.x, p.z, v.x, v.z);
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

function planTreat(state, v, b, cfg) {
  if ((b.stock?.herbs ?? 0) < HERBS_PER_HEAL) return false;
  const patient = pickPatient(state, v, b, cfg);
  if (!patient) return false;
  patient.healer = v.id;
  b.stock.herbs -= HERBS_PER_HEAL;
  v.res.patientId = patient.id;
  v.res.herbBId = b.id;
  v.res.herbPaid = true;
  v.queue.push(
    { kind: 'follow', target: 'villager', id: patient.id, dist: PATIENT_REACH },
    { kind: 'heal', patientId: patient.id, t: HEAL_TIME },
  );
  return true;
}

function planDoctor(state, v, b, cfg) {
  const lowStock = (b.stock?.herbs ?? 0) < SUPPLY_MAX / 2;
  if (lowStock && planFetch(state, v, b, 'herbs')) return;
  if (planTreat(state, v, b, cfg)) return;
  staff(v, b);
}

export const JOB_PLANNERS = {
  fish: planFish, ranch: planRanch, hunt: planHunt, doctor: planDoctor, market: planMarket,
};

// ---------- executors ----------

// Walks toward a moving target (deer or patient) until within t.dist.
function execFollow(state, v, t, dt) {
  const target = t.target === 'animal'
    ? (state.animals ?? []).find((a) => a.id === t.id)
    : getVillager(state, t.id);
  if (!target || (t.target === 'villager' && !target.sick)) return FAIL;
  return moveToward(state, v, target.x, target.z, dt, t.dist) ? DONE : undefined;
}

function execHunt(state, v, t, dt) {
  const i = (state.animals ?? []).findIndex((a) => a.id === t.animalId);
  if (i < 0) return FAIL;
  if (countdown(t, dt) !== DONE) return undefined;
  state.animals.splice(i, 1);
  delete v.res.animalId;
  v.carry = firstEntry(t.out);
  return DONE;
}

function execHeal(state, v, t, dt) {
  const patient = getVillager(state, t.patientId);
  if (!patient || !patient.sick) return FAIL;
  if (countdown(t, dt) !== DONE) return undefined;
  patient.sick = false;
  patient.sickDays = 0;
  patient.healer = null;
  v.res = {};
  return DONE;
}

// Puts the carried goods into the workplace's own stock (not a storage).
function execSupply(state, v, t) {
  const b = getBuilding(state, t.bId);
  if (!b || !b.built || !b.stock || !v.carry) return FAIL;
  b.stock[v.carry.res] = (b.stock[v.carry.res] ?? 0) + v.carry.n;
  v.carry = null;
  return DONE;
}

export const JOB_EXEC = { follow: execFollow, hunt: execHunt, heal: execHeal, supply: execSupply };
