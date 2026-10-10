import { GRID, CELL, WEAR_DECAY, WEAR_PATH_MIN, WEAR_PATH_MAX, WEAR_SPEED_BONUS } from './config.js';

// Wear grids are square: the side length is derived from the array, so any map size works.
export function wearGrid(wear) {
  return Math.round(Math.sqrt(wear.length));
}

// grid: cells per side (a number, or anything with a .grid such as a terrain or world); default 120.
export function createWear(grid = GRID) {
  const g = typeof grid === 'object' ? grid.grid : grid;
  return new Float32Array(g * g);
}

function clampCell(v, g) {
  return Math.min(g - 1, Math.max(0, Math.floor(v / CELL)));
}

export function cellIndex(wear, x, z) {
  const g = wearGrid(wear);
  return clampCell(z, g) * g + clampCell(x, g);
}

export function addWear(wear, x, z, amount) {
  const i = cellIndex(wear, x, z);
  wear[i] = Math.min(1, wear[i] + amount);
}

export function decayWear(wear, dt) {
  const drop = WEAR_DECAY * dt;
  for (let i = 0; i < wear.length; i++) {
    const w = wear[i];
    if (w > 0) wear[i] = w > drop ? w - drop : 0;
  }
}

export function wearAt(wear, x, z) {
  return wear[cellIndex(wear, x, z)];
}

export function smoothstep(edge0, edge1, v) {
  if (v <= edge0) return 0;
  if (v >= edge1) return 1;
  const t = (v - edge0) / (edge1 - edge0);
  return t * t * (3 - 2 * t);
}

export function speedMultiplier(wear, x, z) {
  return 1 + WEAR_SPEED_BONUS * smoothstep(WEAR_PATH_MIN, WEAR_PATH_MAX, wearAt(wear, x, z));
}
