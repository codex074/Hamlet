// Terrain generation: heightmap, river, fertility and resource nodes. Pure: no DOM, no globals.
import {
  WORLD_SIZE, GRID, CELL, MAX_HEIGHT, RIVER_WIDTH,
  SPAWN, SPAWN_CLEAR_RADIUS, NODE_COUNTS, NODE_AMOUNT,
} from './config.js';
import { mulberry32, makeNoise2D, fbm } from './rng.js';

const VERTS = GRID + 1;
const FLAT_FULL = 20;   // full flattening within this distance of spawn
const FLAT_END = 35;    // no flattening beyond this distance
const RIVER_BED = -0.6;
const RIVER_SLOPE = 12;  // width of the sloping bank beyond the water's edge
const FOREST_TREE = 0.55;
const FOREST_BERRY_MIN = 0.42;

function smoothstep(t) {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Returns the river centre-line function z = riverZ(x) for a seed.
function makeRiver(seed) {
  const rand = mulberry32(seed + 7);
  const phase = rand() * Math.PI * 2;
  const phase2 = rand() * Math.PI * 2;
  return (x) => WORLD_SIZE * 0.28 + Math.sin(x * 0.03 + phase) * 14 + Math.sin(x * 0.011 + phase2) * 10;
}

function baseHeight(noise, x, z) {
  return fbm(noise, x * 0.012, z * 0.012, 4) * MAX_HEIGHT;
}

function buildHeights(seed, riverZ) {
  const noise = makeNoise2D(seed);
  const spawnBase = baseHeight(noise, SPAWN.x, SPAWN.z);
  const heights = new Float32Array(VERTS * VERTS);
  for (let iz = 0; iz < VERTS; iz++) {
    for (let ix = 0; ix < VERTS; ix++) {
      const x = ix * CELL;
      const z = iz * CELL;
      let h = baseHeight(noise, x, z);
      const dist = Math.hypot(x - SPAWN.x, z - SPAWN.z);
      // weight 1 inside FLAT_FULL, smoothly 0 at FLAT_END
      const flat = 1 - smoothstep((dist - FLAT_FULL) / (FLAT_END - FLAT_FULL));
      h = h * (1 - flat) + spawnBase * flat;
      // flat river bed across the full water width, then banks easing up over RIVER_SLOPE metres
      const bank = 1 - smoothstep((Math.abs(z - riverZ(x)) - RIVER_WIDTH / 2) / RIVER_SLOPE);
      h = h * (1 - bank) + RIVER_BED * bank;
      heights[iz * VERTS + ix] = h;
    }
  }
  return heights;
}

function buildWaterAndFertility(seed, riverZ) {
  const noise = makeNoise2D(seed + 13);
  const water = new Uint8Array(GRID * GRID);
  const fertility = new Float32Array(GRID * GRID);
  for (let iz = 0; iz < GRID; iz++) {
    for (let ix = 0; ix < GRID; ix++) {
      const x = (ix + 0.5) * CELL;
      const z = (iz + 0.5) * CELL;
      const i = iz * GRID + ix;
      if (Math.abs(z - riverZ(x)) <= RIVER_WIDTH / 2) {
        water[i] = 1;
        fertility[i] = 0;
      } else {
        fertility[i] = fbm(noise, x * 0.02, z * 0.02);
      }
    }
  }
  return { fertility, water };
}

export function generateTerrain(seed) {
  const riverZ = makeRiver(seed);
  const heights = buildHeights(seed, riverZ);
  const { fertility, water } = buildWaterAndFertility(seed, riverZ);
  return { heights, fertility, water };
}

function cellIndex(x, z) {
  const ix = clamp(Math.floor(x / CELL), 0, GRID - 1);
  const iz = clamp(Math.floor(z / CELL), 0, GRID - 1);
  return iz * GRID + ix;
}

// Bilinear interpolation of vertex heights; x,z clamped into the world.
export function heightAt(terrain, x, z) {
  const fx = clamp(x, 0, WORLD_SIZE) / CELL;
  const fz = clamp(z, 0, WORLD_SIZE) / CELL;
  const ix = Math.min(Math.floor(fx), GRID - 1);
  const iz = Math.min(Math.floor(fz), GRID - 1);
  const tx = fx - ix;
  const tz = fz - iz;
  const h = terrain.heights;
  const h00 = h[iz * VERTS + ix];
  const h10 = h[iz * VERTS + ix + 1];
  const h01 = h[(iz + 1) * VERTS + ix];
  const h11 = h[(iz + 1) * VERTS + ix + 1];
  const top = h00 + (h10 - h00) * tx;
  const bottom = h01 + (h11 - h01) * tx;
  return top + (bottom - top) * tz;
}

export function isWater(terrain, x, z) {
  return terrain.water[cellIndex(x, z)] === 1;
}

export function fertilityAt(terrain, x, z) {
  return terrain.fertility[cellIndex(x, z)];
}

// Spatial hash with 4 m buckets, used for neighbour-distance checks.
function makeHash() {
  const buckets = new Map();
  const key = (cx, cz) => cx + ',' + cz;
  return {
    add(node) {
      const k = key(Math.floor(node.x / 4), Math.floor(node.z / 4));
      const list = buckets.get(k);
      if (list) list.push(node);
      else buckets.set(k, [node]);
    },
    // True if any node lies within `dist` metres of (x, z).
    near(x, z, dist) {
      const cx = Math.floor(x / 4);
      const cz = Math.floor(z / 4);
      const span = Math.ceil(dist / 4);
      for (let dz = -span; dz <= span; dz++) {
        for (let dx = -span; dx <= span; dx++) {
          const list = buckets.get(key(cx + dx, cz + dz));
          if (!list) continue;
          for (const n of list) {
            if (Math.hypot(n.x - x, n.z - z) < dist) return true;
          }
        }
      }
      return false;
    },
  };
}

export function generateNodes(seed, terrain) {
  const rand = mulberry32(seed + 99);
  const forestNoise = makeNoise2D(seed + 31);
  const forestAt = (x, z) => forestNoise(x * 0.02, z * 0.02);
  const nodes = [];
  const hash = makeHash();
  const lo = 4;
  const hi = WORLD_SIZE - 4;

  // spec: { kind, count, attempts, minGap, clearRadius, forestOk(f) }
  function place(spec) {
    let placed = 0;
    for (let a = 0; a < spec.attempts && placed < spec.count; a++) {
      const x = lo + rand() * (hi - lo);
      const z = lo + rand() * (hi - lo);
      if (!spec.forestOk(forestAt(x, z))) continue;
      if (isWater(terrain, x, z)) continue;
      if (Math.hypot(x - SPAWN.x, z - SPAWN.z) <= spec.clearRadius) continue;
      if (hash.near(x, z, spec.minGap)) continue;
      const node = { id: nodes.length + 1, kind: spec.kind, x, z, amount: NODE_AMOUNT[spec.kind], reserved: null };
      nodes.push(node);
      hash.add(node);
      placed++;
    }
  }

  place({ kind: 'tree', count: NODE_COUNTS.tree, attempts: 40000, minGap: 1.6,
    clearRadius: SPAWN_CLEAR_RADIUS, forestOk: (f) => f >= FOREST_TREE });
  place({ kind: 'rock', count: NODE_COUNTS.rock, attempts: 20000, minGap: 4,
    clearRadius: SPAWN_CLEAR_RADIUS, forestOk: (f) => f < FOREST_TREE });
  place({ kind: 'berry', count: NODE_COUNTS.berry, attempts: 20000, minGap: 2,
    clearRadius: SPAWN_CLEAR_RADIUS - 8, forestOk: (f) => f >= FOREST_BERRY_MIN && f <= FOREST_TREE });
  return nodes;
}
