// Villager AI: plans a task queue when idle, then executes it step by step. Pure: no DOM, no globals.
import {
  HUNGER_PER_SEC, HUNGRY_AT, STARVING_AT, CARRY_MAX, GATHER_RADIUS, FIELD_RADIUS, IDLE_WANDER_RADIUS,
  BUILDINGS, CATHEDRAL_STAGES, FOODS, UPGRADE_BUILD_TIME,
} from './config.js';
import {
  distance, nearestStorage, nearestStorageWithAll, nearestFoodStorage, isStorage, addStock, takeStock,
} from './economy.js';
import { fertilityAt } from './terrain.js';
import { clock } from './needs.js';
import {
  DONE, FAIL, WAIT_SECONDS, getBuilding, gotoPoint, gotoBuilding, firstEntry, planWait, countdown,
  moveToward, workTime,
} from './taskutil.js';
import { JOB_PLANNERS, JOB_EXEC } from './jobs.js';

const STAFF_GAP = 0.3;   // staff stand closer so arrival slack stays inside SERVICE_STAFFED_DIST
const BUILD_CHUNK = 10;
const SERVICE_SHIFT = 30;

// ---------- shared helpers (also used by sim.js / needs.js) ----------

export { getBuilding };

export function isSite(b) {
  return !b.built || b.upgrading === true;
}

export function isReady(b) {
  return !(b.goldBlocked > 0) && Object.values(b.needed ?? {}).every((n) => n <= 0);
}

export function buildTimeOf(b) {
  if (b.type === 'cathedral') return CATHEDRAL_STAGES[b.stage]?.buildTime ?? 40;
  if (b.type === 'house' && b.upgrading) return UPGRADE_BUILD_TIME;
  return BUILDINGS[b.type]?.buildTime || BUILD_CHUNK;
}

export function createVillager(state, x, z) {
  return {
    id: state.nextId++, x, z, homeId: null, jobId: null, hunger: 0,
    carry: null, queue: [], res: {}, role: 'idle', sick: false, sickDays: 0, healer: null,
  };
}

const SHARED_PICKS = 6;   // shared (keepNode) gatherers choose among the nearest few nodes

function pickNode(state, kind, cx, cz, shared = false, rand = null) {
  const near = [];
  for (const n of state.nodes) {
    if (n.kind !== kind || n.amount < 1 || (!shared && n.reserved != null)) continue;
    const d = distance(n.x, n.z, cx, cz);
    if (d <= GATHER_RADIUS) near.push({ n, d });
  }
  near.sort((a, b) => a.d - b.d);
  if (near.length === 0) return null;
  const pool = shared && rand ? Math.min(SHARED_PICKS, near.length) : 1;
  return near[Math.floor(rand ? rand() * pool : 0) % pool].n;
}

// Removes a villager and everything that points at them.
export function removeVillager(state, id) {
  const i = state.villagers.findIndex((v) => v.id === id);
  if (i < 0) return;
  const [v] = state.villagers.splice(i, 1);
  releaseReservations(state, v);
  for (const b of state.buildings) {
    b.workers = b.workers.filter((w) => w !== id);
    if (b.residents) b.residents = b.residents.filter((r) => r !== id);
  }
}

// ---------- reservations & failure ----------

export function releaseReservations(state, v) {
  const r = v.res ?? {};
  if (r.nodeId != null) {
    const node = state.nodes.find((n) => n.id === r.nodeId);
    if (node && node.reserved === v.id) node.reserved = null;
  }
  if (r.siteId != null && r.siteRes) {
    const site = getBuilding(state, r.siteId);
    if (site) site.incoming[r.siteRes] = Math.max(0, (site.incoming[r.siteRes] ?? 0) - (r.siteN ?? 0));
  }
  if (r.animalId != null) {
    const deer = (state.animals ?? []).find((a) => a.id === r.animalId);
    if (deer && deer.reserved === v.id) deer.reserved = null;
  }
  if (r.patientId != null) {
    const patient = state.villagers.find((p) => p.id === r.patientId);
    if (patient && patient.healer === v.id) patient.healer = null;
    const clinic = getBuilding(state, r.herbBId);
    if (r.herbPaid && clinic?.stock) addStock(clinic, 'herbs', 1);   // treatment never happened: give the herb back
  }
  v.res = {};
}

export function failVillager(state, v) {
  v.queue = [];
  releaseReservations(state, v);
  if (v.carry) {
    const s = nearestStorage(state, v.x, v.z);
    if (s) v.queue.push(gotoBuilding(s, v.x, v.z), { kind: 'put', bId: s.id });
    else v.carry = null;
  }
}

// ---------- planning ----------

function planEat(state, v) {
  if (v.hunger < HUNGRY_AT) return false;
  const s = nearestFoodStorage(state, v.x, v.z);
  if (!s) return false;
  v.queue.push(gotoBuilding(s, v.x, v.z), { kind: 'eat', bId: s.id });
  v.role = 'idle';
  return true;
}

function planSleep(state, v) {
  if (!clock(state).isNight) return false;
  const home = getBuilding(state, v.homeId);
  if (!home) return false;
  v.queue.push(gotoBuilding(home, v.x, v.z), { kind: 'sleep' });
  v.role = 'sleeping';
  return true;
}

// Sick villagers go home (or to the townhall) and lie down until healed.
function planSick(state, v) {
  const home = getBuilding(state, v.homeId) ?? state.buildings.find((b) => b.type === 'townhall');
  if (home) v.queue.push(gotoBuilding(home, v.x, v.z));
  v.queue.push({ kind: 'rest' });
  v.role = 'idle';
  return true;
}

function planGather(state, v, b, cfg, rand) {
  const node = pickNode(state, cfg.node, b.x, b.z, cfg.keepNode === true, rand);
  const store = node && nearestStorage(state, node.x, node.z);
  if (!node || !store) return planWait(v, null);
  if (!cfg.keepNode) {
    node.reserved = v.id;
    v.res.nodeId = node.id;
  }
  v.queue.push(
    gotoPoint(node.x, node.z),
    { kind: 'gather', nodeId: node.id, t: workTime(b, cfg.time), out: { ...cfg.output }, keep: cfg.keepNode === true },
    gotoBuilding(store, node.x, node.z),
    { kind: 'put', bId: store.id },
  );
}

function planFarm(state, v, b, cfg, rand) {
  const fields = state.zones.filter((z) => z.kind === 'field' && distance(z.x, z.z, b.x, b.z) <= FIELD_RADIUS);
  const store = nearestStorage(state, b.x, b.z);
  if (fields.length === 0 || !store) return planWait(v, null);
  const zone = fields[Math.floor(rand() * fields.length) % fields.length];
  const rad = zone.r * 0.9 * Math.sqrt(rand());
  const ang = rand() * Math.PI * 2;
  const px = zone.x + Math.cos(ang) * rad;
  const pz = zone.z + Math.sin(ang) * rad;
  const wheat = Math.min(CARRY_MAX, Math.round(cfg.output.wheat * (0.5 + fertilityAt(state.terrain, px, pz))));
  v.queue.push(
    gotoPoint(px, pz),
    { kind: 'produce', bId: b.id, t: workTime(b, cfg.time), out: { wheat } },
    gotoBuilding(store, px, pz),
    { kind: 'put', bId: store.id },
  );
}

// Only the first input resource is supported (carry holds a single resource); all configured recipes have one.
function planProcess(state, v, b, cfg) {
  const src = nearestStorageWithAll(state, b.x, b.z, cfg.input);
  const dst = nearestStorage(state, b.x, b.z);
  if (!src || !dst) return planWait(v, b);
  const input = firstEntry(cfg.input);
  v.queue.push(
    gotoBuilding(src, v.x, v.z),
    { kind: 'take', bId: src.id, res: input.res, n: input.n },
    gotoBuilding(b, src.x, src.z),
    { kind: 'produce', bId: b.id, t: workTime(b, cfg.time), in: { [input.res]: input.n }, out: { ...cfg.output } },
    gotoBuilding(dst, b.x, b.z),
    { kind: 'put', bId: dst.id },
  );
}

function planJob(state, v, rand) {
  const b = getBuilding(state, v.jobId);
  const cfg = b && b.built ? BUILDINGS[b.type] : null;
  if (!cfg || !cfg.job) {
    v.jobId = null;
    return false;
  }
  v.role = 'worker';
  if (cfg.job === 'gather') planGather(state, v, b, cfg, rand);
  else if (cfg.job === 'farm') planFarm(state, v, b, cfg, rand);
  else if (cfg.job === 'process') planProcess(state, v, b, cfg);
  else if (cfg.job === 'service') v.queue.push(gotoBuilding(b, v.x, v.z, STAFF_GAP), { kind: 'staff', bId: b.id, t: SERVICE_SHIFT });
  else if (JOB_PLANNERS[cfg.job]) JOB_PLANNERS[cfg.job](state, v, b, cfg, rand);
  else planWait(v, null);
  return true;
}

function planHaul(state, v) {
  for (const site of state.buildings) {
    if (!isSite(site)) continue;
    for (const [res, need] of Object.entries(site.needed)) {
      const free = need - (site.incoming[res] ?? 0);
      if (free <= 0) continue;
      const store = nearestStorage(state, v.x, v.z, (s) => (s.stock[res] ?? 0) >= 1);
      if (!store) continue;
      const n = Math.min(CARRY_MAX, free, Math.floor(store.stock[res]));
      site.incoming[res] = (site.incoming[res] ?? 0) + n;
      v.res.siteId = site.id;
      v.res.siteRes = res;
      v.res.siteN = n;
      v.queue.push(
        gotoBuilding(store, v.x, v.z),
        { kind: 'take', bId: store.id, res, n },
        gotoBuilding(site, store.x, store.z),
        { kind: 'deliver', bId: site.id },
      );
      return true;
    }
  }
  return false;
}

function planBuild(state, v) {
  const site = state.buildings.find((b) => isSite(b) && isReady(b));
  if (!site) return false;
  v.queue.push(gotoBuilding(site, v.x, v.z), { kind: 'build', bId: site.id, t: BUILD_CHUNK });
  return true;
}

function planWander(state, v, rand) {
  const centre = getBuilding(state, v.homeId) ?? state.buildings.find((b) => b.type === 'townhall');
  const cx = centre ? centre.x : v.x;
  const cz = centre ? centre.z : v.z;
  const rad = IDLE_WANDER_RADIUS * Math.sqrt(rand());
  const ang = rand() * Math.PI * 2;
  v.queue.push(gotoPoint(cx + Math.cos(ang) * rad, cz + Math.sin(ang) * rad), { kind: 'wait', t: WAIT_SECONDS });
  v.role = 'idle';
}

export function planNext(state, v, rand) {
  if (v.queue.length > 0) return;
  if (v.carry) {
    failVillager(state, v);   // a stray load goes back to a storage first
    return;
  }
  if (planEat(state, v)) return;
  if (v.sick) {
    planSick(state, v);
    return;
  }
  if (planSleep(state, v)) return;
  if (v.jobId != null && planJob(state, v, rand)) return;
  if (planHaul(state, v)) {
    v.role = 'builder';
    return;
  }
  if (planBuild(state, v)) {
    v.role = 'builder';
    return;
  }
  planWander(state, v, rand);
}

// ---------- execution ----------

function execGoto(state, v, t, dt) {
  if (!Number.isFinite(t.x) || !Number.isFinite(t.z)) return FAIL;
  return moveToward(state, v, t.x, t.z, dt) ? DONE : undefined;
}

function execTake(state, v, t) {
  const b = getBuilding(state, t.bId);
  if (!b || !isStorage(b) || v.carry) return FAIL;
  const taken = takeStock(b, t.res, t.n);
  if (taken <= 0) return FAIL;
  v.carry = { res: t.res, n: taken };
  return DONE;
}

function execPut(state, v, t) {
  if (!v.carry) return DONE;
  const b = getBuilding(state, t.bId);
  if (b && isStorage(b)) {
    addStock(b, v.carry.res, v.carry.n);
    v.carry = null;
    return DONE;
  }
  const s = nearestStorage(state, v.x, v.z);
  if (!s) {
    v.carry = null;
    return DONE;
  }
  t.bId = s.id;
  v.queue.unshift(gotoBuilding(s, v.x, v.z));
  return undefined;
}

function execDeliver(state, v, t) {
  const site = getBuilding(state, t.bId);
  if (!site || !isSite(site) || !v.carry) return FAIL;
  const { res, n } = v.carry;
  site.needed[res] = Math.max(0, (site.needed[res] ?? 0) - n);
  site.incoming[res] = Math.max(0, (site.incoming[res] ?? 0) - (v.res.siteN ?? n));
  v.carry = null;
  delete v.res.siteId;
  delete v.res.siteRes;
  delete v.res.siteN;
  return DONE;
}

function execGather(state, v, t, dt) {
  const node = state.nodes.find((n) => n.id === t.nodeId);
  if (!node || node.amount < 1) return FAIL;
  if (countdown(t, dt) !== DONE) return undefined;
  v.carry = firstEntry(t.out);
  if (t.keep) return DONE;   // shared node (herbs): nothing is used up
  node.amount -= 1;
  node.reserved = null;
  delete v.res.nodeId;
  if (node.amount <= 0 && node.kind !== 'berry') state.nodes.splice(state.nodes.indexOf(node), 1);
  return DONE;
}

function execProduce(state, v, t, dt) {
  const b = getBuilding(state, t.bId);
  if (!b || !b.built) return FAIL;
  if (t.in) {
    const need = firstEntry(t.in);
    if (!v.carry || v.carry.res !== need.res || v.carry.n < need.n) return FAIL;
  }
  if (countdown(t, dt) !== DONE) return undefined;
  v.carry = firstEntry(t.out);
  return DONE;
}

function execBuild(state, v, t, dt) {
  const b = getBuilding(state, t.bId);
  if (!b) return FAIL;
  if (!isSite(b)) return DONE;
  if (!isReady(b)) return FAIL;
  b.progress = Math.min(1, b.progress + dt / buildTimeOf(b));
  const timeUp = countdown(t, dt) === DONE;
  return timeUp || b.progress >= 1 ? DONE : undefined;
}

// First food the household has not had today (in FOODS order), else any food in stock.
function pickFood(state, v, store) {
  const home = getBuilding(state, v.homeId);
  const eaten = home?.foodsToday ?? [];
  const inStock = FOODS.filter((f) => (store.stock[f] ?? 0) >= 1);
  return inStock.find((f) => !eaten.includes(f)) ?? inStock[0] ?? null;
}

function execEat(state, v, t) {
  const b = getBuilding(state, t.bId);
  if (!b || !isStorage(b)) return FAIL;
  const food = pickFood(state, v, b);
  if (food) {
    takeStock(b, food, 1);
    v.hunger = 0;
    const home = getBuilding(state, v.homeId);
    if (home?.foodsToday && !home.foodsToday.includes(food)) home.foodsToday.push(food);
    return DONE;
  }
  return FAIL;
}

function execStaff(state, v, t, dt) {
  const b = getBuilding(state, t.bId);
  if (!b || !b.built) return FAIL;
  return countdown(t, dt);
}

function execSleep(state, v) {
  if (!clock(state).isNight) return DONE;
  const starving = v.hunger >= HUNGRY_AT && nearestFoodStorage(state, v.x, v.z);
  return starving ? DONE : undefined;   // wake up to eat when hungry and food exists
}

// A sick villager lies down until healed; gets up to eat when hungry and food exists.
function execRest(state, v) {
  if (!v.sick) return DONE;
  return v.hunger >= HUNGRY_AT && nearestFoodStorage(state, v.x, v.z) ? DONE : undefined;
}

const EXEC = {
  ...JOB_EXEC,
  rest: execRest,
  goto: execGoto,
  wait: (state, v, t, dt) => countdown(t, dt),
  take: execTake,
  put: execPut,
  deliver: execDeliver,
  gather: execGather,
  produce: execProduce,
  build: execBuild,
  eat: execEat,
  staff: execStaff,
  sleep: execSleep,
};

export function stepVillager(state, v, dt, rand) {
  v.hunger = Math.min(1, v.hunger + HUNGER_PER_SEC * dt);
  if (v.hunger >= STARVING_AT && v.homeId != null) {
    const home = getBuilding(state, v.homeId);
    if (home) home.starvedToday = true;
  }
  if (v.queue.length === 0) planNext(state, v, rand);
  const task = v.queue[0];
  if (!task) return;
  const exec = EXEC[task.kind];
  const result = exec ? exec(state, v, task, dt) : FAIL;
  if (result === DONE) v.queue.shift();
  else if (result === FAIL) failVillager(state, v);
}
