// Free (grid-less) placement checks for circular footprints and zones. Pure: no DOM, no globals.
import {
  WORLD_SIZE, EDGE_MARGIN, MAX_SLOPE, BUILDINGS, HOUSE_SITE_TRIES, NEAR_WATER_DIST, CELL,
} from './config.js';
import { heightAt, isWater } from './terrain.js';

const DEFAULT_GEO = { heightAt, isWater };
const WATERSIDE_SLOPE_MUL = 2.5;
const BUILDING_GAP = 0.5;
const NODE_PAD = 0.8;

// Centre plus 8 points evenly spaced on the circle of radius r.
export function samplePoints(x, z, r) {
  const pts = [[x, z]];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    pts.push([x + Math.cos(a) * r, z + Math.sin(a) * r]);
  }
  return pts;
}

function inBounds(x, z, r) {
  const lo = EDGE_MARGIN;
  const hi = WORLD_SIZE - EDGE_MARGIN;
  return x - r >= lo && x + r <= hi && z - r >= lo && z + r <= hi;
}

function dist(ax, az, bx, bz) {
  return Math.hypot(ax - bx, az - bz);
}

export function footprintOK(state, x, z, r, opts = {}, geo = DEFAULT_GEO) {
  if (!inBounds(x, z, r)) return { ok: false, reason: 'นอกแผนที่' };
  const pts = samplePoints(x, z, r);
  if (pts.some(([px, pz]) => geo.isWater(state.terrain, px, pz))) {
    return { ok: false, reason: 'อยู่บนน้ำ' };
  }
  const hs = pts.map(([px, pz]) => geo.heightAt(state.terrain, px, pz));
  if (Math.max(...hs) - Math.min(...hs) > MAX_SLOPE * (opts.slopeMul || 1)) {
    return { ok: false, reason: 'พื้นชันเกินไป' };
  }
  for (const b of state.buildings) {
    if (b.id === opts.ignoreId) continue;
    if (dist(x, z, b.x, b.z) < r + BUILDINGS[b.type].radius + BUILDING_GAP) {
      return { ok: false, reason: 'ทับอาคารอื่น' };
    }
  }
  if (!opts.ignoreZones) {
    for (const zone of state.zones) {
      if (dist(x, z, zone.x, zone.z) < r + zone.r) return { ok: false, reason: 'ทับโซน' };
    }
  }
  return { ok: true };
}

// True if any water lies within `reach` metres of (x, z).
function waterWithin(state, x, z, reach, geo) {
  for (let dz = -reach; dz <= reach; dz += CELL) {
    for (let dx = -reach; dx <= reach; dx += CELL) {
      if (Math.hypot(dx, dz) <= reach && geo.isWater(state.terrain, x + dx, z + dz)) return true;
    }
  }
  return false;
}

export function canPlace(state, type, x, z, rot, geo = DEFAULT_GEO) {
  const cfg = BUILDINGS[type];
  // waterside buildings stand on stilts, so river banks may be steeper than usual
  const fp = footprintOK(state, x, z, cfg.radius, { slopeMul: cfg.nearWater ? WATERSIDE_SLOPE_MUL : 1 }, geo);
  if (!fp.ok) return fp;
  if (cfg.nearWater && !waterWithin(state, x, z, cfg.radius + NEAR_WATER_DIST, geo)) {
    return { ok: false, reason: 'ต้องวางติดแหล่งน้ำ' };
  }
  return fp;
}

export function canPaintZone(state, kind, x, z, r, geo = DEFAULT_GEO) {
  if (!inBounds(x, z, r)) return { ok: false, reason: 'นอกแผนที่' };
  if (geo.isWater(state.terrain, x, z)) return { ok: false, reason: 'อยู่บนน้ำ' };
  for (const b of state.buildings) {
    if (b.type === 'house') continue;
    if (dist(x, z, b.x, b.z) < r + BUILDINGS[b.type].radius) {
      return { ok: false, reason: 'ทับอาคารอื่น' };
    }
  }
  for (const zone of state.zones) {
    if (zone.kind !== kind && dist(x, z, zone.x, zone.z) < r + zone.r) {
      return { ok: false, reason: 'ทับโซนอื่น' };
    }
  }
  return { ok: true };
}

export function nodesUnder(state, x, z, r) {
  return state.nodes
    .filter((n) => dist(x, z, n.x, n.z) < r + NODE_PAD)
    .map((n) => n.id);
}

export function findHouseSite(state, zone, rand, geo = DEFAULT_GEO) {
  const houseR = BUILDINGS.house.radius;
  const discR = Math.max(0, zone.r - houseR);
  for (let i = 0; i < HOUSE_SITE_TRIES; i++) {
    const rad = discR * Math.sqrt(rand());   // sqrt => uniform over the disc
    const ang = rand() * Math.PI * 2;
    const x = zone.x + Math.cos(ang) * rad;
    const z = zone.z + Math.sin(ang) * rad;
    const rot = rand() * Math.PI * 2;
    if (footprintOK(state, x, z, houseR, { ignoreZones: true }, geo).ok) return { x, z, rot };
  }
  return null;
}
