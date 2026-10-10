// Villager AI: plans a task queue when idle, then executes it step by step. Pure: no DOM, no globals.
import {
  WALK_SPEED, WATER_SPEED_MUL, WEAR_PER_STEP, HUNGER_PER_SEC, HUNGRY_AT, STARVING_AT,
  CARRY_MAX, GATHER_RADIUS, FIELD_RADIUS, IDLE_WANDER_RADIUS, BUILDINGS, CATHEDRAL_STAGES, FOODS,
} from './config.js';
import {
  distance, nearestStorage, nearestStorageWithAll, nearestFoodStorage, isStorage, addStock, takeStock,
} from './economy.js';
import { addWear, speedMultiplier } from './wear.js';
import { isWater, fertilityAt } from './terrain.js';
import { clock } from './needs.js';

const DONE = 'done';
const FAIL = 'fail';
const ARRIVE_DIST = 0.3;
const DOOR_GAP = 0.8;
const STAFF_GAP = 0.3;   // staff stand closer so arrival slack stays inside SERVICE_STAFFED_DIST
const BUILD_CHUNK = 10;
const UPGRADE_BUILD_TIME = 8;
const SERVICE_SHIFT = 30;
const WAIT_SECONDS = 3;

// ---------- shared helpers (also used by sim.js / needs.js) ----------

export function getBuilding(state, id) {
  if (id == null) return null;
  return state.buildings.find((b) => b.id === id) ?? null;
}

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
    carry: null, queue: [], res: {}, role: 'idle',
  };
}

// Point on the building's rim, on the side facing (fromX, fromZ).
function doorPoint(b, fromX, fromZ, gap = DOOR_GAP) {
  const dx = fromX - b.x;
  const dz = fromZ - b.z;
  const d = Math.hypot(dx, dz);
  const ux = d < 1e-6 ? 1 : dx / d;
  const uz = d < 1e-6 ? 0 : dz / d;
  const r = (BUILDINGS[b.type]?.radius ?? 0) + gap;
  return { x: b.x + ux * r, z: b.z + uz * r };
}

function gotoPoint(x, z) {
  return { kind: 'goto', x, z };
}

function gotoBuilding(b, fromX, fromZ, gap = DOOR_GAP) {
  const p = doorPoint(b, fromX, fromZ, gap);
  return gotoPoint(p.x, p.z);
}

function firstEntry(obj) {
  const [res, n] = Object.entries(obj)[0];
  return { res, n };
}

function pickNode(state, kind, cx, cz) {
  let best = null;
  let bestD = Infinity;
  for (const n of state.nodes) {
    if (n.kind !== kind || n.amount < 1 || n.reserved != null) continue;
    const d = distance(n.x, n.z, cx, cz);
    if (d <= GATHER_RADIUS && d < bestD) {
      best = n;
      bestD = d;
    }
  }
  return best;
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

function planWait(v, b) {
  if (b) v.queue.push(gotoBuilding(b, v.x, v.z));
  v.queue.push({ kind: 'wait', t: WAIT_SECONDS });
}

function planGather(state, v, b, cfg) {
  const node = pickNode(state, cfg.node, b.x, b.z);
  const store = node && nearestStorage(state, node.x, node.z);
  if (!node || !store) return planWait(v, null);
  node.reserved = v.id;
  v.res.nodeId = node.id;
  v.queue.push(
    gotoPoint(node.x, node.z),
    { kind: 'gather', nodeId: node.id, t: cfg.time, out: { ...cfg.output } },
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
    { kind: 'produce', bId: b.id, t: cfg.time, out: { wheat } },
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
    { kind: 'produce', bId: b.id, t: cfg.time, in: { [input.res]: input.n }, out: { ...cfg.output } },
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
  if (cfg.job === 'gather') planGather(state, v, b, cfg);
  else if (cfg.job === 'farm') planFarm(state, v, b, cfg, rand);
  else if (cfg.job === 'process') planProcess(state, v, b, cfg);
  else if (cfg.job === 'service') v.queue.push(gotoBuilding(b, v.x, v.z, STAFF_GAP), { kind: 'staff', bId: b.id, t: SERVICE_SHIFT });
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
  const dx = t.x - v.x;
  const dz = t.z - v.z;
  const d = Math.hypot(dx, dz);
  if (d <= ARRIVE_DIST) return DONE;
  const water = isWater(state.terrain, v.x, v.z) ? WATER_SPEED_MUL : 1;
  const speed = WALK_SPEED * speedMultiplier(state.wear, v.x, v.z) * water;
  const move = Math.min(speed * dt, d);
  v.x += (dx / d) * move;
  v.z += (dz / d) * move;
  addWear(state.wear, v.x, v.z, WEAR_PER_STEP * dt);
  return d - move <= ARRIVE_DIST ? DONE : undefined;
}

function countdown(t, dt) {
  t.t -= dt;
  return t.t <= 0 ? DONE : undefined;
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
  node.amount -= 1;
  node.reserved = null;
  delete v.res.nodeId;
  v.carry = firstEntry(t.out);
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

function execEat(state, v, t) {
  const b = getBuilding(state, t.bId);
  if (!b || !isStorage(b)) return FAIL;
  for (const food of FOODS) {
    if ((b.stock[food] ?? 0) < 1) continue;
    takeStock(b, food, 1);
    v.hunger = 0;
    const home = getBuilding(state, v.homeId);
    if (food === 'bread' && home) home.breadToday = true;
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

const EXEC = {
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
