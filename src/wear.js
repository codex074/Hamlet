import { GRID, CELL, WEAR_DECAY, WEAR_PATH_MIN, WEAR_PATH_MAX, WEAR_SPEED_BONUS } from './config.js';

export function createWear() {
  return new Float32Array(GRID * GRID);
}

function clampCell(v) {
  return Math.min(GRID - 1, Math.max(0, Math.floor(v / CELL)));
}

export function cellIndex(x, z) {
  return clampCell(z) * GRID + clampCell(x);
}

export function addWear(wear, x, z, amount) {
  const i = cellIndex(x, z);
  wear[i] = Math.min(1, wear[i] + amount);
}

export function decayWear(wear, dt) {
  const drop = WEAR_DECAY * dt;
  for (let i = 0; i < wear.length; i++) {
    wear[i] = Math.max(0, wear[i] - drop);
  }
}

export function wearAt(wear, x, z) {
  return wear[cellIndex(x, z)];
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
