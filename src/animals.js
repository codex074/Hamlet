// Wild deer: spawn in forests, wander, flee from villagers, respawn. Pure: no DOM, no globals.
import {
  EDGE_MARGIN, SPAWN_CLEAR_RADIUS, DEER_COUNT, DEER_RESPAWN_SEC, DEER_SPEED,
  BUILDINGS,
} from './config.js';
import { mulberry32 } from './rng.js';
import { isWater } from './terrain.js';
import { sizeOf, spawnOf } from './world.js';
import { nodesOfKind } from './nodeindex.js';

const FOREST_RADIUS = 6;       // deer spawn within this distance of a tree
const FLEE_DIST = 8;
const FLEE_MUL = 2;            // fleeing deer run faster
const WANDER_MAX = 15;
const EDGE_BAND = 40;          // "near the map edge" for respawns
const SPAWN_TRIES = 40;

function inBounds(state, x, z) {
  const size = sizeOf(state);
  return x >= EDGE_MARGIN && x <= size - EDGE_MARGIN && z >= EDGE_MARGIN && z <= size - EDGE_MARGIN;
}

function edgeDist(state, x, z) {
  const size = sizeOf(state);
  return Math.min(x, z, size - x, size - z);
}

function isLand(state, x, z) {
  return inBounds(state, x, z) && !isWater(state.terrain, x, z);
}

// Herd size grows with the map (linearly with its side, so large maps are not swamped).
export function deerTarget(state) {
  return Math.round(DEER_COUNT * sizeOf(state) / 240);
}

// Random land point within FOREST_RADIUS of a tree, away from spawn; null if none found.
function forestPoint(state, trees, rand, edgeOnly) {
  if (trees.length === 0) return null;
  const spawn = spawnOf(state);
  for (let i = 0; i < SPAWN_TRIES; i++) {
    const tree = trees[Math.floor(rand() * trees.length) % trees.length];
    const ang = rand() * Math.PI * 2;
    const rad = FOREST_RADIUS * Math.sqrt(rand());
    const x = tree.x + Math.cos(ang) * rad;
    const z = tree.z + Math.sin(ang) * rad;
    if (!isLand(state, x, z)) continue;
    if (Math.hypot(x - spawn.x, z - spawn.z) <= SPAWN_CLEAR_RADIUS) continue;
    if (edgeOnly && edgeDist(state, x, z) > EDGE_BAND) continue;
    return { x, z };
  }
  return null;
}

function newDeer(state, p) {
  return { id: state.nextId++, kind: 'deer', x: p.x, z: p.z, tx: p.x, tz: p.z, wait: 2, reserved: null };
}

// Initial herd (deterministic per seed). Uses state.nodes, state.terrain and state.nextId.
export function createDeer(state) {
  const rand = mulberry32(state.seed + 5);
  const trees = nodesOfKind(state, 'tree');
  const deer = [];
  for (let i = 0; i < deerTarget(state); i++) {
    const p = forestPoint(state, trees, rand, false);
    if (p) deer.push(newDeer(state, p));
  }
  return deer;
}

function chooseTarget(state, d, rand, from) {
  for (let i = 0; i < 8; i++) {
    let ang = rand() * Math.PI * 2;
    if (from) ang = Math.atan2(d.z - from.z, d.x - from.x) + (rand() - 0.5) * 1.2;
    const len = from ? WANDER_MAX * (0.5 + rand() * 0.5) : 4 + rand() * (WANDER_MAX - 4);
    const x = d.x + Math.cos(ang) * len;
    const z = d.z + Math.sin(ang) * len;
    if (!isLand(state, x, z)) continue;
    d.tx = x;
    d.tz = z;
    return true;
  }
  return false;
}

function nearestThreat(d, walkers) {
  let best = null;
  let bestD = FLEE_DIST;
  for (const w of walkers) {
    const dist = Math.hypot(w.x - d.x, w.z - d.z);
    if (dist < bestD) {
      best = w;
      bestD = dist;
    }
  }
  return best;
}

function stepDeer(state, d, dt, rand, walkers) {
  const threat = d.reserved == null ? nearestThreat(d, walkers) : null;
  if (threat) {
    const towards = (d.tx - d.x) * (threat.x - d.x) + (d.tz - d.z) * (threat.z - d.z) > 0;
    if (d.wait > 0 || towards) {
      chooseTarget(state, d, rand, threat);
      d.wait = 0;
    }
  }
  if (d.wait > 0) {
    d.wait -= dt;
    return;
  }
  const dx = d.tx - d.x;
  const dz = d.tz - d.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.3) {
    d.wait = 2 + rand() * 4;
    if (!chooseTarget(state, d, rand, null)) { d.tx = d.x; d.tz = d.z; }
    return;
  }
  const step = Math.min(DEER_SPEED * (threat ? FLEE_MUL : 1) * dt, dist);
  const nx = d.x + (dx / dist) * step;
  const nz = d.z + (dz / dist) * step;
  if (!isLand(state, nx, nz)) {   // river or map edge: stop and pick another way
    d.wait = 1;
    d.tx = d.x;
    d.tz = d.z;
    return;
  }
  d.x = nx;
  d.z = nz;
}

function respawn(state, dt, rand) {
  if (state.animals.length >= deerTarget(state)) {
    state.deerTimer = DEER_RESPAWN_SEC;
    return;
  }
  state.deerTimer = (state.deerTimer ?? DEER_RESPAWN_SEC) - dt;
  if (state.deerTimer > 0) return;
  state.deerTimer = DEER_RESPAWN_SEC;
  const trees = nodesOfKind(state, 'tree');
  const p = forestPoint(state, trees, rand, true) ?? forestPoint(state, trees, rand, false);
  if (p) state.animals.push(newDeer(state, p));
}

export function stepAnimals(state, dt, rand) {
  if (!state.animals) return;
  const hunters = new Set();
  for (const b of state.buildings) {
    if (BUILDINGS[b.type]?.job === 'hunt') for (const id of b.workers) hunters.add(id);
  }
  const walkers = state.villagers.filter((v) => !hunters.has(v.id));
  for (const d of state.animals) stepDeer(state, d, dt, rand, walkers);
  respawn(state, dt, rand);
}
