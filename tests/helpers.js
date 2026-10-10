// Shared test utilities (not a test file: `npm test` only runs *.test.js).
import { SPAWN, BUILDINGS, HOUSE_LEVELS } from '../src/config.js';
import { emptyStock } from '../src/economy.js';
import { createVillager } from '../src/villagers.js';
import { newBuilding } from '../src/needs.js';
import { createWorld, canPlace, canPaintZone } from '../src/sim.js';

export function world(seed = 1) {
  return createWorld(seed);
}

export function townhall(state) {
  return state.buildings.find((b) => b.type === 'townhall');
}

// Adds an already-built building straight into the state (bypasses placement rules).
export function addBuilt(state, type, x, z) {
  const b = newBuilding(state, type, x, z, 0);
  b.built = true;
  b.progress = 1;
  b.needed = {};
  if (BUILDINGS[type].storage) b.stock = emptyStock();
  state.buildings.push(b);
  return b;
}

export function addSite(state, type, x, z) {
  const b = newBuilding(state, type, x, z, 0);
  state.buildings.push(b);
  return b;
}

export function addVillager(state, x, z) {
  const v = createVillager(state, x, z);
  state.villagers.push(v);
  return v;
}

// Built house with `count` residents (villagers created next to it).
export function addHouse(state, x, z, count = 3, level = 1) {
  const h = addBuilt(state, 'house', x, z);
  h.level = level;
  for (let i = 0; i < count; i++) {
    const v = addVillager(state, x, z);
    v.homeId = h.id;
    h.residents.push(v.id);
  }
  return h;
}

// Built service building with a worker standing at its door.
export function addStaffedService(state, type, x, z) {
  const b = addBuilt(state, type, x, z);
  const w = addVillager(state, x + BUILDINGS[type].radius + 0.8, z);
  w.jobId = b.id;
  b.workers.push(w.id);
  return b;
}

export function clearVillagers(state) {
  state.villagers = [];
  for (const b of state.buildings) {
    b.workers = [];
    if (b.residents) b.residents = [];
  }
}

export function nearestNode(state, kind, x, z) {
  let best = null;
  let bd = Infinity;
  for (const n of state.nodes) {
    const d = Math.hypot(n.x - x, n.z - z);
    if (n.kind === kind && d < bd) {
      best = n;
      bd = d;
    }
  }
  return best;
}

// Spiral outwards from (tx, tz) until accept(x, z) is true.
export function spiral(tx, tz, accept, maxR = 80, step = 2) {
  for (let r = 0; r <= maxR; r += step) {
    const n = Math.max(1, Math.round((2 * Math.PI * r) / step));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const x = tx + Math.cos(a) * r;
      const z = tz + Math.sin(a) * r;
      if (accept(x, z)) return { x, z };
    }
  }
  return null;
}

export function findPlaceSpot(state, type, tx, tz, maxR = 80) {
  return spiral(tx, tz, (x, z) => canPlace(state, type, x, z, 0).ok, maxR);
}

export function findZoneSpot(state, kind, r, tx, tz, maxR = 80) {
  return spiral(tx, tz, (x, z) => canPaintZone(state, kind, x, z, r).ok, maxR);
}

export { SPAWN, HOUSE_LEVELS };
