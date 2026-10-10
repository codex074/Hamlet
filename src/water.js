// Drinking water: where villagers can drink and which houses have a well nearby. Pure: no DOM, no globals
// (the shore cache is a WeakMap keyed by the terrain object, so it never ends up in a save).
import { BUILDINGS, CELL, WATER_RADIUS } from './config.js';
import { distance } from './economy.js';
import { isWater } from './terrain.js';
import { sizeOf } from './world.js';
import { isOwned } from './territory.js';

const SHORE_STEP = 2 * CELL;   // coarse sampling is plenty for "walk to the riverbank"
const shoreCache = new WeakMap();

export const isWaterSource = (b) => b.built && BUILDINGS[b.type]?.water === true && !b.upgrading;

// Dry land cells right next to open water, sampled every SHORE_STEP metres (cached per terrain).
function shorePoints(state) {
  const t = state.terrain;
  let pts = shoreCache.get(t);
  if (pts) return pts;
  pts = [];
  const size = sizeOf(state);
  for (let z = SHORE_STEP / 2; z < size; z += SHORE_STEP) {
    for (let x = SHORE_STEP / 2; x < size; x += SHORE_STEP) {
      if (isWater(t, x, z)) continue;
      if (isWater(t, x + CELL, z) || isWater(t, x - CELL, z) || isWater(t, x, z + CELL) || isWater(t, x, z - CELL)) {
        pts.push({ x, z });
      }
    }
  }
  shoreCache.set(t, pts);
  return pts;
}

// Nearest place to drink from (x, z): { x, z, b } for a well-type building, { x, z, b: null } for a riverbank,
// or null when there is no water anywhere in the territory.
export function nearestWater(state, x, z) {
  let best = null;
  let bestD = Infinity;
  for (const b of state.buildings) {
    if (!isWaterSource(b)) continue;
    const d = distance(x, z, b.x, b.z);
    if (d < bestD) { best = { x: b.x, z: b.z, b }; bestD = d; }
  }
  for (const p of shorePoints(state)) {
    const d = distance(x, z, p.x, p.z);
    if (d < bestD && isOwned(state, p.x, p.z)) { best = { x: p.x, z: p.z, b: null }; bestD = d; }
  }
  return best;
}

// A house's water need: a well (or townhall / market) within WATER_RADIUS.
export function wellNear(state, house) {
  return state.buildings.some((b) => isWaterSource(b) && distance(b.x, b.z, house.x, house.z) <= WATER_RADIUS);
}
