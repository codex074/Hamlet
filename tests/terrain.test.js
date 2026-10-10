import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTerrain, generateNodes, heightAt, isWater, fertilityAt } from '../src/terrain.js';
import { CELL, MAX_HEIGHT, SPAWN_CLEAR_RADIUS } from '../src/config.js';

const SMALL = { mapSize: 'small' };
const GRID = 120;
const SPAWN = { x: 120, z: 120 };

const SEED = 12345;

test('deterministic for same seed', () => {
  const a = generateTerrain(SEED, SMALL);
  const b = generateTerrain(SEED, SMALL);
  for (const i of [0, 100, 5000, 9999, (GRID + 1) * (GRID + 1) - 1]) {
    assert.equal(a.heights[i], b.heights[i]);
  }
  assert.equal(generateNodes(SEED, a, SMALL).length, generateNodes(SEED, b, SMALL).length);
});

test('different seeds differ', () => {
  const a = generateTerrain(1, SMALL);
  const b = generateTerrain(2, SMALL);
  assert.notDeepEqual(Array.from(a.heights.slice(0, 50)), Array.from(b.heights.slice(0, 50)));
});

test('array lengths', () => {
  const t = generateTerrain(SEED, SMALL);
  assert.equal(t.heights.length, (GRID + 1) * (GRID + 1));
  assert.equal(t.fertility.length, GRID * GRID);
  assert.equal(t.water.length, GRID * GRID);
});

test('heights within range', () => {
  const t = generateTerrain(SEED, SMALL);
  for (const h of t.heights) {
    assert.ok(h >= -1 && h <= MAX_HEIGHT + 1, `height ${h} out of range`);
  }
});

test('fertility in [0,1] and zero on water', () => {
  const t = generateTerrain(SEED, SMALL);
  for (let i = 0; i < t.fertility.length; i++) {
    assert.ok(t.fertility[i] >= 0 && t.fertility[i] <= 1);
    if (t.water[i]) assert.equal(t.fertility[i], 0);
  }
});

test('water exists but not near spawn', () => {
  const t = generateTerrain(SEED, SMALL);
  let count = 0;
  for (let iz = 0; iz < GRID; iz++) {
    for (let ix = 0; ix < GRID; ix++) {
      if (!t.water[iz * GRID + ix]) continue;
      count++;
      const d = Math.hypot((ix + 0.5) * CELL - SPAWN.x, (iz + 0.5) * CELL - SPAWN.z);
      assert.ok(d > SPAWN_CLEAR_RADIUS, 'water within spawn clear radius');
    }
  }
  assert.ok(count > 0);
});

test('trees count > 300', () => {
  const t = generateTerrain(SEED, SMALL);
  const nodes = generateNodes(SEED, t, SMALL);
  assert.ok(nodes.filter((n) => n.kind === 'tree').length > 300);
});

test('node ids, fields, spawn clearance and no water', () => {
  const t = generateTerrain(SEED, SMALL);
  const nodes = generateNodes(SEED, t, SMALL);
  nodes.forEach((n, i) => {
    assert.equal(n.id, i + 1);
    assert.equal(n.reserved, null);
    assert.ok(n.amount > 0);
    assert.ok(Math.hypot(n.x - SPAWN.x, n.z - SPAWN.z) > SPAWN_CLEAR_RADIUS - 8);
    assert.equal(isWater(t, n.x, n.z), false);
  });
});

test('heightAt at a vertex equals stored height', () => {
  const t = generateTerrain(SEED, SMALL);
  for (const [ix, iz] of [[0, 0], [10, 20], [60, 60], [GRID, GRID], [GRID, 0]]) {
    assert.ok(Math.abs(heightAt(t, ix * CELL, iz * CELL) - t.heights[iz * (GRID + 1) + ix]) < 1e-6);
  }
  assert.ok(Number.isFinite(heightAt(t, -50, 9999)));
});

test('isWater and fertilityAt clamp to edge cells', () => {
  const t = generateTerrain(SEED, SMALL);
  assert.equal(isWater(t, -10, -10), t.water[0] === 1);
  assert.equal(fertilityAt(t, 1e6, 1e6), t.fertility[GRID * GRID - 1]);
});

test('generation is fast', () => {
  const start = performance.now();
  const t = generateTerrain(SEED, SMALL);
  generateNodes(SEED, t, SMALL);
  assert.ok(performance.now() - start < 1500);
});
