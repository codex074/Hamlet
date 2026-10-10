// Per-world dimensions. Pure: no DOM, no globals.
import { WORLD_SIZE, CELL } from './config.js';

// World size in metres of a state or a terrain (falls back to the small-map default for bare fixtures).
export function sizeOf(o) {
  return o?.world?.size ?? o?.terrain?.size ?? o?.size ?? WORLD_SIZE;
}

export function gridOf(o) {
  return o?.world?.grid ?? o?.terrain?.grid ?? o?.grid ?? Math.round(sizeOf(o) / CELL);
}

// Map centre: where the town hall stands and villagers start.
export function spawnOf(o) {
  const half = sizeOf(o) / 2;
  return { x: half, z: half };
}
