// Planners and task executors for the newer professions: fishing, ranching, hunting, doctor, market, quarry.
// Pure: no DOM, no globals. Wired into villagers.js via JOB_PLANNERS / JOB_EXEC.
import {
  CARRY_MAX, CELL, EDGE_MARGIN, FISH_RADIUS, HUNT_RADIUS, HUNT_SHOT_DIST, SUPPLY_MAX, HERBS_PER_HEAL,
  HEAL_TIME, BUILDINGS, FORESTER_RADIUS, SAPLING_GAP, SAPLING_PATH_WEAR, MAX_SAPLINGS_PER_FORESTER,
  QUARRY_ACCIDENT_CHANCE, QUARRY_FATAL_SHARE, QUARRY_TOOLED_MUL,
} from './config.js';
import { mulberry32 } from './rng.js';
import { pushEvent } from './events.js';
import { fullName } from './names.js';
import { distance, nearestStorage, nearestStorageWith } from './economy.js';
import { isWater } from './terrain.js';
import { sizeOf } from './world.js';
import { isOwned } from './territory.js';
import { addNode, anyNodeWithin, nodesOfKind } from './nodeindex.js';
import { wearAt } from './wear.js';
import { restockTargets, stockMaxOf } from './market.js';
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
  const size = sizeOf(state);
  const cands = [];
  for (let dz = -FISH_RADIUS; dz <= FISH_RADIUS; dz += CELL) {
    for (let dx = -FISH_RADIUS; dx <= FISH_RADIUS; dx += CELL) {
      const x = b.x + dx;
      const z = b.z + dz;
      const d = Math.hypot(dx, dz);
      if (d > FISH_RADIUS || d < near || x < 0 || z < 0 || x > size || z > size || !isOwned(state, x, z)) continue;
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
    if (a.reserved != null || !isOwned(state, a.x, a.z)) continue;
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

// Fetches `res` from a storage into the building's own stock (up to `max`); false if nothing to fetch.
function planFetch(state, v, b, res, max = SUPPLY_MAX) {
  b.stock ??= { [res]: 0 };
  const missing = Math.floor(max - (b.stock[res] ?? 0));
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

// Merchants refill the emptiest of the goods the player chose to sell, then mind the stalls.
function planMarket(state, v, b) {
  for (const res of restockTargets(b)) {
    if (planFetch(state, v, b, res, stockMaxOf(res))) return;
  }
  staff(v, b);
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

// ---------- forestry ----------

const PLANT_TRIES = 25;

// Is (x, z) a legal sapling spot? Owned land, dry, clear of nodes/buildings/zones and off the paths.
function saplingSpotOK(state, x, z) {
  const size = sizeOf(state);
  if (x < EDGE_MARGIN || z < EDGE_MARGIN || x > size - EDGE_MARGIN || z > size - EDGE_MARGIN) return false;
  if (!isOwned(state, x, z) || isWater(state.terrain, x, z)) return false;
  if (wearAt(state.wear, x, z) >= SAPLING_PATH_WEAR) return false;
  if (anyNodeWithin(state, x, z, SAPLING_GAP)) return false;
  for (const o of state.buildings) {
    if (distance(x, z, o.x, o.z) < BUILDINGS[o.type].radius + SAPLING_GAP) return false;
  }
  for (const zone of state.zones) {
    if (distance(x, z, zone.x, zone.z) < zone.r + SAPLING_GAP) return false;
  }
  return true;
}

function planForester(state, v, b, cfg, rand) {
  const alive = nodesOfKind(state, 'sapling').filter((n) => n.forester === b.id).length;
  if (alive >= MAX_SAPLINGS_PER_FORESTER) return planWait(v, null);
  for (let i = 0; i < PLANT_TRIES; i++) {
    const rad = FORESTER_RADIUS * Math.sqrt(rand());
    const ang = rand() * Math.PI * 2;
    const x = b.x + Math.cos(ang) * rad;
    const z = b.z + Math.sin(ang) * rad;
    if (!saplingSpotOK(state, x, z)) continue;
    v.queue.push(gotoPoint(x, z), { kind: 'plant', bId: b.id, x, z, t: workTime(b, cfg.time) });
    return;
  }
  planWait(v, null);
}

// ---------- livestock ----------

// The feed this pen takes now: the accepted crop with the most in any storage (enough for one round), or null.
export function feedFor(state, b) {
  const cfg = BUILDINGS[b.type];
  let best = null;
  let most = 0;
  for (const res of cfg.feed) {
    let have = 0;
    for (const s of state.buildings) if (BUILDINGS[s.type]?.storage && s.built) have += s.stock?.[res] ?? 0;
    if (have >= cfg.feedPer && have > most) { best = res; most = have; }
  }
  return best;
}

// Carry feed from storage to the pen, tend the animals, take the meat to storage.
function planLivestock(state, v, b, cfg) {
  const feed = feedFor(state, b);
  const src = feed && nearestStorageWith(state, b.x, b.z, feed, cfg.feedPer);
  const dst = nearestStorage(state, b.x, b.z);
  if (!src || !dst) return planWait(v, b);
  v.queue.push(
    gotoBuilding(src, v.x, v.z),
    { kind: 'take', bId: src.id, res: feed, n: cfg.feedPer },
    gotoBuilding(b, src.x, src.z),
    { kind: 'produce', bId: b.id, t: workTime(b, cfg.time), in: { [feed]: cfg.feedPer }, out: { ...cfg.output } },
    gotoBuilding(dst, b.x, b.z),
    { kind: 'put', bId: dst.id },
  );
}

// ---------- quarry ----------

// Diggers work in the pit and carry the stone to the nearest storage. The pit never runs out.
function planQuarry(state, v, b, cfg) {
  const store = nearestStorage(state, b.x, b.z);
  if (!store) return planWait(v, null);
  const ang = (v.id * 2.399) % (Math.PI * 2);   // spread the diggers around the pit
  const r = BUILDINGS[b.type].radius * 0.55;
  v.queue.push(
    gotoPoint(b.x + Math.cos(ang) * r, b.z + Math.sin(ang) * r),
    { kind: 'dig', bId: b.id, t: workTime(b, cfg.time), out: { ...cfg.output } },
    gotoBuilding(store, b.x, b.z),
    { kind: 'put', bId: store.id },
  );
}

// One dig's accident roll, from (seed, villager, time) so it is reproducible: null | 'injured' | 'killed'.
// Tools from the blacksmith halve the risk (and, via workTime, make each dig faster).
export function rollAccident(state, v, b) {
  const r = mulberry32(((state.seed * 2246822519) ^ Math.imul(v.id, 3266489917) ^ Math.floor(state.time * 10)) >>> 0);
  const chance = QUARRY_ACCIDENT_CHANCE * (b.tooled ? QUARRY_TOOLED_MUL : 1);
  if (r() >= chance) return null;
  return r() < QUARRY_FATAL_SHARE ? 'killed' : 'injured';
}

function execDig(state, v, t, dt) {
  const b = getBuilding(state, t.bId);
  if (!b || !b.built) return FAIL;
  if (countdown(t, dt) !== DONE) return undefined;
  const accident = rollAccident(state, v, b);
  b.accidents ??= { injured: 0, killed: 0 };
  const who = fullName(v);
  const at = { bId: b.id, x: b.x, z: b.z };
  if (accident === 'killed') {
    b.accidents.killed += 1;
    state.deaths = (state.deaths ?? 0) + 1;
    pushEvent(state, `⛏️ ${who} เสียชีวิตจากอุบัติเหตุในเหมืองหิน`, {
      kind: 'warn', ...at, detail: 'งานเหมืองหินเสี่ยงอันตราย — เครื่องมือจากโรงตีเหล็กลดความเสี่ยงลงครึ่งหนึ่งและขุดเร็วขึ้น หรือลดจำนวนคนงาน',
    });
    v.dead = true;   // removed by the sim once every villager has moved this tick
    return FAIL;
  }
  if (accident === 'injured') {
    b.accidents.injured += 1;
    v.sick = true;
    v.sickDays = 0;
    v.healer = null;
    pushEvent(state, `🤕 ${who} บาดเจ็บจากหินถล่มในเหมือง ต้องพักรักษาตัว`, { kind: 'warn', ...at, vId: v.id });
    return FAIL;   // drops the work; planNext sends them to rest
  }
  v.carry = firstEntry(t.out);
  return DONE;
}

export const JOB_PLANNERS = {
  fish: planFish, ranch: planRanch, hunt: planHunt, doctor: planDoctor, market: planMarket,
  forester: planForester, quarry: planQuarry, livestock: planLivestock,
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

// Plants a sapling where the forester stands (the spot is re-checked: someone may have built there).
function execPlant(state, v, t, dt) {
  const b = getBuilding(state, t.bId);
  if (!b || !b.built) return FAIL;
  if (countdown(t, dt) !== DONE) return undefined;
  if (!saplingSpotOK(state, t.x, t.z)) return FAIL;
  addNode(state, {
    kind: 'sapling', x: t.x, z: t.z, amount: 1, reserved: null, planted: state.time, forester: b.id,
  });
  return DONE;
}

export const JOB_EXEC = {
  follow: execFollow, hunt: execHunt, heal: execHeal, supply: execSupply, plant: execPlant, dig: execDig,
};
