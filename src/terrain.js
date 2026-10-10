// Terrain generation: heightmap, rivers/ponds, fertility and resource nodes. Pure: no DOM, no globals.
// Every terrain carries its own { size, grid }; all helpers read those, never global constants.
import {
  CELL, MAX_HEIGHT, RIVER_WIDTH, SPAWN_CLEAR_RADIUS, NODE_COUNTS, ORE_MIN_HEIGHT, DEFAULT_SETTINGS,
  DENSITY_MUL, TERRAIN_AMP, HILLY_ORE_MUL, RIVER_MIN_SPAWN_DIST,
} from './config.js';
import { mulberry32, makeNoise2D, fbm } from './rng.js';
import { normalizeSettings, mapSizeOf, nodeAmountFor } from './settings.js';

const FLAT_FULL = 20;   // full flattening within this distance of spawn
const FLAT_END = 35;    // no flattening beyond this distance
const RIVER_BED = -0.6;
const RIVER_SLOPE = 12;  // width of the sloping bank beyond the water's edge
const FOREST_TREE = 0.55;
const FOREST_BERRY_MIN = 0.42;
const ORE_GAP = 6;
const ORE_RELAX_SHARE = 0.15;   // fallback: ore on the highest 15% of land
const SMALL_AREA = 240 * 240;
// River lanes (fraction of the map across the flow): never nearer than 0.3 of the map to the centre.
const LANES = [[false, 0.2], [true, 0.8], [false, 0.8], [true, 0.2]];   // [vertical, fraction]

function smoothstep(t) {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Water features: each is a function (x, z) -> metres beyond the water's edge (<= 0 means water).
function riverFeature(vertical, pos, phase, phase2) {
  const centre = (t) => pos + Math.sin(t * 0.03 + phase) * 14 + Math.sin(t * 0.011 + phase2) * 10;
  return vertical
    ? (x, z) => Math.abs(x - centre(z)) - RIVER_WIDTH / 2
    : (x, z) => Math.abs(z - centre(x)) - RIVER_WIDTH / 2;
}

function pondFeature(cx, cz, r, wobblePhase) {
  return (x, z) => {
    const a = Math.atan2(z - cz, x - cx);
    return Math.hypot(x - cx, z - cz) - r * (1 + 0.15 * Math.sin(3 * a + wobblePhase));
  };
}

// opts.legacy reproduces the single river of pre-v4 worlds exactly (migrated saves keep their map).
function makeWater(seed, size, riverCount, legacy) {
  const rand = mulberry32(seed + 7);
  if (legacy) {
    const phase = rand() * Math.PI * 2;
    const phase2 = rand() * Math.PI * 2;
    return [riverFeature(false, size * 0.28, phase, phase2)];
  }
  const features = [];
  const lane0 = Math.floor(mulberry32(seed + 8)() * LANES.length);
  for (let i = 0; i < riverCount; i++) {
    const phase = rand() * Math.PI * 2;
    const phase2 = rand() * Math.PI * 2;
    const [vertical, frac] = LANES[(lane0 + i) % LANES.length];
    features.push(riverFeature(vertical, size * frac, phase, phase2));
  }
  if (riverCount === 0) {   // no rivers: one or two ponds so fishing stays possible
    const ponds = 1 + Math.floor(rand() * 2);
    const half = size / 2;
    const base = rand() * Math.PI * 2;
    for (let i = 0; i < ponds; i++) {
      const r = 10 + rand() * 4;
      const ang = base + i * Math.PI * (0.7 + rand() * 0.6);
      const lo = RIVER_MIN_SPAWN_DIST + r * 1.3 + 4;
      const hi = Math.max(lo + 1, Math.min(half - r * 1.3 - 8, size * 0.36));
      const dist = lo + rand() * (hi - lo);
      features.push(pondFeature(half + Math.cos(ang) * dist, half + Math.sin(ang) * dist, r, rand() * 6.28));
    }
  }
  return features;
}

function waterDist(features, x, z) {
  let d = Infinity;
  for (const f of features) d = Math.min(d, f(x, z));
  return d;
}

function baseHeight(noise, x, z) {
  return fbm(noise, x * 0.012, z * 0.012, 4) * MAX_HEIGHT;
}

function buildHeights(seed, size, grid, amp, features) {
  const verts = grid + 1;
  const half = size / 2;
  const noise = makeNoise2D(seed);
  const spawnBase = baseHeight(noise, half, half) * amp;
  const heights = new Float32Array(verts * verts);
  for (let iz = 0; iz < verts; iz++) {
    for (let ix = 0; ix < verts; ix++) {
      const x = ix * CELL;
      const z = iz * CELL;
      let h = baseHeight(noise, x, z) * amp;
      const dist = Math.hypot(x - half, z - half);
      // weight 1 inside FLAT_FULL, smoothly 0 at FLAT_END
      const flat = 1 - smoothstep((dist - FLAT_FULL) / (FLAT_END - FLAT_FULL));
      h = h * (1 - flat) + spawnBase * flat;
      // flat bed across the full water width, then banks easing up over RIVER_SLOPE metres
      const bank = 1 - smoothstep(waterDist(features, x, z) / RIVER_SLOPE);
      h = h * (1 - bank) + RIVER_BED * bank;
      heights[iz * verts + ix] = h;
    }
  }
  return heights;
}

function buildWaterAndFertility(seed, grid, features) {
  const noise = makeNoise2D(seed + 13);
  const water = new Uint8Array(grid * grid);
  const fertility = new Float32Array(grid * grid);
  for (let iz = 0; iz < grid; iz++) {
    for (let ix = 0; ix < grid; ix++) {
      const x = (ix + 0.5) * CELL;
      const z = (iz + 0.5) * CELL;
      const i = iz * grid + ix;
      if (waterDist(features, x, z) <= 0) {
        water[i] = 1;
        fertility[i] = 0;
      } else {
        fertility[i] = fbm(noise, x * 0.02, z * 0.02);
      }
    }
  }
  return { fertility, water };
}

// settings: partial world settings (normalised here). opts.legacy: pre-v4 single-river layout.
export function generateTerrain(seed, settings = DEFAULT_SETTINGS, opts = {}) {
  const cfg = normalizeSettings(settings);
  const size = mapSizeOf(cfg);
  const grid = size / CELL;
  const features = makeWater(seed, size, cfg.rivers, opts.legacy === true);
  const heights = buildHeights(seed, size, grid, TERRAIN_AMP[cfg.terrain], features);
  const { fertility, water } = buildWaterAndFertility(seed, grid, features);
  return { heights, fertility, water, size, grid };
}

function cellIndex(terrain, x, z) {
  const g = terrain.grid;
  const ix = clamp(Math.floor(x / CELL), 0, g - 1);
  const iz = clamp(Math.floor(z / CELL), 0, g - 1);
  return iz * g + ix;
}

// Bilinear interpolation of vertex heights; x,z clamped into the world.
export function heightAt(terrain, x, z) {
  const g = terrain.grid;
  const verts = g + 1;
  const fx = clamp(x, 0, terrain.size) / CELL;
  const fz = clamp(z, 0, terrain.size) / CELL;
  const ix = Math.min(Math.floor(fx), g - 1);
  const iz = Math.min(Math.floor(fz), g - 1);
  const tx = fx - ix;
  const tz = fz - iz;
  const h = terrain.heights;
  const h00 = h[iz * verts + ix];
  const h10 = h[iz * verts + ix + 1];
  const h01 = h[(iz + 1) * verts + ix];
  const h11 = h[(iz + 1) * verts + ix + 1];
  const top = h00 + (h10 - h00) * tx;
  const bottom = h01 + (h11 - h01) * tx;
  return top + (bottom - top) * tz;
}

export function isWater(terrain, x, z) {
  return terrain.water[cellIndex(terrain, x, z)] === 1;
}

export function fertilityAt(terrain, x, z) {
  return terrain.fertility[cellIndex(terrain, x, z)];
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

// Node target counts scale with land area relative to the small map and the density setting.
function targetCount(kind, cfgKey, cfg, size) {
  const area = (size * size) / SMALL_AREA;
  let n = NODE_COUNTS[kind] * area * DENSITY_MUL[cfg[cfgKey]];
  if (kind === 'ore' && cfg.terrain === 'hilly') n *= HILLY_ORE_MUL;
  return Math.round(n);
}

// Attempt budget: unchanged on the small map at normal density, grows with area and density.
function attemptBudget(base, cfgKey, cfg, size) {
  return Math.round(base * ((size * size) / SMALL_AREA) * Math.max(1, DENSITY_MUL[cfg[cfgKey]]));
}

export function generateNodes(seed, terrain, settings = DEFAULT_SETTINGS) {
  const cfg = normalizeSettings(settings);
  const size = terrain.size;
  const half = size / 2;
  const rand = mulberry32(seed + 99);
  const forestNoise = makeNoise2D(seed + 31);
  const forestAt = (x, z) => forestNoise(x * 0.02, z * 0.02);
  const nodes = [];
  const hash = makeHash();
  const lo = 4;
  const hi = size - 4;

  // spec: { kind, count, attempts, minGap, clearRadius, forestOk(f), spotOk?(x, z) }; returns number placed
  function place(spec) {
    const amount = nodeAmountFor(cfg, spec.kind);
    let placed = 0;
    for (let a = 0; a < spec.attempts && placed < spec.count; a++) {
      const x = lo + rand() * (hi - lo);
      const z = lo + rand() * (hi - lo);
      if (!spec.forestOk(forestAt(x, z))) continue;
      if (spec.spotOk && !spec.spotOk(x, z)) continue;
      if (isWater(terrain, x, z)) continue;
      if (Math.hypot(x - half, z - half) <= spec.clearRadius) continue;
      if (hash.near(x, z, spec.minGap)) continue;
      const node = { id: nodes.length + 1, kind: spec.kind, x, z, amount, reserved: null };
      nodes.push(node);
      hash.add(node);
      placed++;
    }
    return placed;
  }

  place({ kind: 'tree', count: targetCount('tree', 'forest', cfg, size),
    attempts: attemptBudget(40000, 'forest', cfg, size), minGap: 1.6,
    clearRadius: SPAWN_CLEAR_RADIUS, forestOk: (f) => f >= FOREST_TREE });
  place({ kind: 'rock', count: targetCount('rock', 'stone', cfg, size),
    attempts: attemptBudget(20000, 'stone', cfg, size), minGap: 4,
    clearRadius: SPAWN_CLEAR_RADIUS, forestOk: (f) => f < FOREST_TREE });
  place({ kind: 'berry', count: targetCount('berry', 'berries', cfg, size),
    attempts: attemptBudget(20000, 'berries', cfg, size), minGap: 2,
    clearRadius: SPAWN_CLEAR_RADIUS - 8, forestOk: (f) => f >= FOREST_BERRY_MIN && f <= FOREST_TREE });
  placeOre(place, terrain, targetCount('ore', 'ore', cfg, size), attemptBudget(20000, 'ore', cfg, size));
  return nodes;
}

// Height reached by the top `share` of land vertices.
function landHeightQuantile(terrain, share) {
  const verts = terrain.grid + 1;
  const hs = [];
  for (let iz = 0; iz < verts; iz++) {
    for (let ix = 0; ix < verts; ix++) {
      if (!isWater(terrain, ix * CELL, iz * CELL)) hs.push(terrain.heights[iz * verts + ix]);
    }
  }
  hs.sort((a, b) => a - b);
  return hs[Math.min(hs.length - 1, Math.floor(hs.length * (1 - share)))];
}

// Minimum height for ore veins: high ground, relaxed to the top of the land on flat maps (cached).
export function oreHeightThreshold(terrain) {
  if (terrain.oreMinHeight === undefined) {
    Object.defineProperty(terrain, 'oreMinHeight', {
      value: Math.min(ORE_MIN_HEIGHT * MAX_HEIGHT, landHeightQuantile(terrain, ORE_RELAX_SHARE)),
      enumerable: false, writable: true, configurable: true,
    });
  }
  return terrain.oreMinHeight;
}

// Ore veins on high ground; if there is too little, relax to the highest part of the land.
function placeOre(place, terrain, count, attempts) {
  const spec = (minH, n) => ({
    kind: 'ore', count: n, attempts, minGap: ORE_GAP, clearRadius: SPAWN_CLEAR_RADIUS,
    forestOk: () => true, spotOk: (x, z) => heightAt(terrain, x, z) >= minH,
  });
  const high = ORE_MIN_HEIGHT * MAX_HEIGHT;
  const got = place(spec(high, count));
  if (got >= count) return;
  place(spec(oreHeightThreshold(terrain), count - got));
}
