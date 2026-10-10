import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWear, cellIndex, addWear, decayWear, wearAt, smoothstep, speedMultiplier,
} from '../src/wear.js';
import { GRID, CELL, WEAR_SPEED_BONUS, WORLD_SIZE } from '../src/config.js';

// Centre of cell (ix, iz) in world metres.
const centre = (ix, iz) => ({ x: (ix + 0.5) * CELL, z: (iz + 0.5) * CELL });

test('new grid is all zero with correct length', () => {
  const wear = createWear();
  assert.ok(wear instanceof Float32Array);
  assert.equal(wear.length, GRID * GRID);
  assert.ok(wear.every((v) => v === 0));
});

test('addWear accumulates and clamps at 1', () => {
  const wear = createWear();
  const { x, z } = centre(10, 20);
  addWear(wear, x, z, 0.25);
  addWear(wear, x, z, 0.25);
  assert.equal(wearAt(wear, x, z), 0.5);
  addWear(wear, x, z, 5);
  assert.equal(wearAt(wear, x, z), 1);
});

test('addWear leaves neighbouring cells untouched', () => {
  const wear = createWear();
  const { x, z } = centre(10, 20);
  addWear(wear, x, z, 0.5);
  const i = cellIndex(wear, x, z);
  let nonZero = 0;
  for (let k = 0; k < wear.length; k++) if (wear[k] !== 0) nonZero++;
  assert.equal(nonZero, 1);
  assert.equal(wear[i], 0.5);
  assert.equal(wearAt(wear, centre(9, 20).x, centre(9, 20).z), 0);
  assert.equal(wearAt(wear, centre(11, 20).x, centre(11, 20).z), 0);
  assert.equal(wearAt(wear, centre(10, 19).x, centre(10, 19).z), 0);
  assert.equal(wearAt(wear, centre(10, 21).x, centre(10, 21).z), 0);
});

test('cellIndex is row-major and maps world coords to cells', () => {
  const wear = createWear();
  assert.equal(cellIndex(wear, 0, 0), 0);
  assert.equal(cellIndex(wear, 3 * CELL + 0.1, 2 * CELL + 0.1), 2 * GRID + 3);
  assert.equal(cellIndex(wear, CELL - 0.01, 0), 0);
  assert.equal(cellIndex(wear, CELL, 0), 1);
});

test('out-of-range coordinates clamp to edge cells', () => {
  const last = GRID * GRID - 1;
  const wear = createWear();
  assert.equal(cellIndex(wear, -5, -5), 0);
  assert.equal(cellIndex(wear, -1e6, 1e6), (GRID - 1) * GRID);
  assert.equal(cellIndex(wear, 1e6, -1e6), GRID - 1);
  assert.equal(cellIndex(wear, 1e6, 1e6), last);
  assert.equal(cellIndex(wear, WORLD_SIZE, WORLD_SIZE), last);

  addWear(wear, -100, -100, 0.5);
  assert.equal(wear[0], 0.5);
  addWear(wear, 1e6, 1e6, 0.25);
  assert.equal(wear[last], 0.25);
  assert.equal(wearAt(wear, 1e6, 1e6), 0.25);
});

test('decayWear reduces every cell and clamps at 0', () => {
  const wear = createWear();
  const { x, z } = centre(5, 5);
  addWear(wear, x, z, 0.5);
  addWear(wear, 0, 0, 0.001);
  decayWear(wear, 10);
  assert.ok(Math.abs(wearAt(wear, x, z) - 0.485) < 1e-6);
  assert.equal(wearAt(wear, 0, 0), 0);
  decayWear(wear, 1e6);
  assert.ok(wear.every((v) => v === 0));
});

test('smoothstep has correct edges and midpoint', () => {
  assert.equal(smoothstep(0.3, 0.8, 0), 0);
  assert.equal(smoothstep(0.3, 0.8, 0.3), 0);
  assert.equal(smoothstep(0.3, 0.8, 0.8), 1);
  assert.equal(smoothstep(0.3, 0.8, 2), 1);
  assert.ok(Math.abs(smoothstep(0, 1, 0.5) - 0.5) < 1e-12);
});

test('speedMultiplier is 1 at wear 0 and full bonus at wear 1', () => {
  const wear = createWear();
  const { x, z } = centre(7, 7);
  assert.equal(speedMultiplier(wear, x, z), 1);
  addWear(wear, x, z, 1);
  assert.equal(speedMultiplier(wear, x, z), 1 + WEAR_SPEED_BONUS);
});

test('speedMultiplier is monotonic non-decreasing in wear', () => {
  const wear = createWear();
  const { x, z } = centre(7, 7);
  const i = cellIndex(wear, x, z);
  let prev = -Infinity;
  for (let k = 0; k <= 100; k++) {
    wear[i] = k / 100;
    const m = speedMultiplier(wear, x, z);
    assert.ok(m >= prev, `not monotonic at wear ${k / 100}`);
    prev = m;
  }
});
