// Small helpers shared by the villager AI modules (movement, task builders). Pure: no DOM, no globals.
import {
  WALK_SPEED, WATER_SPEED_MUL, WEAR_PER_STEP, SICK_SPEED_MUL, BUILDINGS, TOOL_SPEED_BONUS,
  CHILD_AGE, ELDER_AGE, ELDER_SPEED_MUL, CHILD_SPEED_MUL, PREGNANT_SPEED_MUL,
} from './config.js';
import { addWear, speedMultiplier } from './wear.js';
import { isWater } from './terrain.js';

export const DONE = 'done';
export const FAIL = 'fail';
export const ARRIVE_DIST = 0.3;
export const WAIT_SECONDS = 3;
const DOOR_GAP = 0.8;

// ---------- life stages & work eligibility ----------

export function stageOf(v) {
  const age = v.age ?? CHILD_AGE + 1;   // a villager without an age counts as an adult
  return age < CHILD_AGE ? 'child' : age >= ELDER_AGE ? 'elder' : 'adult';
}

// Children, pregnant women and sick villagers cannot work at all.
export function canWork(v) {
  return stageOf(v) !== 'child' && !v.pregnant && !v.sick;
}

// Building sites and hauling are for healthy working-age adults only (never elders).
export function canBuild(v) {
  return canWork(v) && stageOf(v) === 'adult';
}

// Elders may only hold `light` jobs.
export function canTakeJob(v, b) {
  if (!canWork(v)) return false;
  return stageOf(v) === 'adult' || BUILDINGS[b?.type]?.light === true;
}

export function ageSpeedMul(v) {
  const st = stageOf(v);
  let m = st === 'elder' ? ELDER_SPEED_MUL : st === 'child' ? CHILD_SPEED_MUL : 1;
  if (v.pregnant) m *= PREGNANT_SPEED_MUL;
  return m;
}

export function getBuilding(state, id) {
  if (id == null) return null;
  return state.buildings.find((b) => b.id === id) ?? null;
}

export function getVillager(state, id) {
  if (id == null) return null;
  return state.villagers.find((v) => v.id === id) ?? null;
}

// Point on the building's rim, on the side facing (fromX, fromZ).
export function doorPoint(b, fromX, fromZ, gap = DOOR_GAP) {
  const dx = fromX - b.x;
  const dz = fromZ - b.z;
  const d = Math.hypot(dx, dz);
  const ux = d < 1e-6 ? 1 : dx / d;
  const uz = d < 1e-6 ? 0 : dz / d;
  const r = (BUILDINGS[b.type]?.radius ?? 0) + gap;
  return { x: b.x + ux * r, z: b.z + uz * r };
}

export function gotoPoint(x, z) {
  return { kind: 'goto', x, z };
}

export function gotoBuilding(b, fromX, fromZ, gap = DOOR_GAP) {
  const p = doorPoint(b, fromX, fromZ, gap);
  return gotoPoint(p.x, p.z);
}

export function firstEntry(obj) {
  const [res, n] = Object.entries(obj)[0];
  return { res, n };
}

export function planWait(v, b) {
  if (b) v.queue.push(gotoBuilding(b, v.x, v.z));
  v.queue.push({ kind: 'wait', t: WAIT_SECONDS });
}

export function countdown(t, dt) {
  t.t -= dt;
  return t.t <= 0 ? DONE : undefined;
}

// Work duration at a building; tooled buildings are faster.
export function workTime(b, t) {
  return b && b.tooled ? t * (1 - TOOL_SPEED_BONUS) : t;
}

// Walks one step toward (tx, tz); true once within `stop` metres.
export function moveToward(state, v, tx, tz, dt, stop = ARRIVE_DIST) {
  const dx = tx - v.x;
  const dz = tz - v.z;
  const d = Math.hypot(dx, dz);
  if (d <= stop) return true;
  const water = isWater(state.terrain, v.x, v.z) ? WATER_SPEED_MUL : 1;
  const sick = v.sick ? SICK_SPEED_MUL : 1;
  const speed = WALK_SPEED * speedMultiplier(state.wear, v.x, v.z) * water * sick * ageSpeedMul(v);
  const move = Math.min(speed * dt, d);
  v.x += (dx / d) * move;
  v.z += (dz / d) * move;
  addWear(state.wear, v.x, v.z, WEAR_PER_STEP * dt);
  return d - move <= stop;
}
