import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, randRange, randInt, makeNoise2D, fbm } from '../src/rng.js';

function sequence(rand, n) {
  return Array.from({ length: n }, () => rand());
}

test('mulberry32: same seed gives the same sequence', () => {
  assert.deepEqual(sequence(mulberry32(42), 100), sequence(mulberry32(42), 100));
});

test('mulberry32: different seeds give different sequences', () => {
  assert.notDeepEqual(sequence(mulberry32(1), 20), sequence(mulberry32(2), 20));
});

test('mulberry32: values are always in [0, 1) over 10000 draws', () => {
  const rand = mulberry32(12345);
  for (let i = 0; i < 10000; i++) {
    const v = rand();
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  }
});

test('randRange: values lie in [a, b)', () => {
  const rand = mulberry32(7);
  for (let i = 0; i < 10000; i++) {
    const v = randRange(rand, -3, 5);
    assert.ok(v >= -3 && v < 5, `out of range: ${v}`);
  }
});

test('randInt: bounds are inclusive and both ends are reached', () => {
  const rand = mulberry32(99);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < 10000; i++) {
    const v = randInt(rand, 1, 3);
    assert.equal(Number.isInteger(v), true);
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  assert.equal(min, 1);
  assert.equal(max, 3);
});

test('randInt: a single-value range always returns that value', () => {
  const rand = mulberry32(5);
  for (let i = 0; i < 100; i++) {
    assert.equal(randInt(rand, 4, 4), 4);
  }
});

test('makeNoise2D: values stay in [0, 1] over a 2000-sample grid', () => {
  const noise = makeNoise2D(3);
  let count = 0;
  for (let i = 0; i < 40; i++) {
    for (let j = 0; j < 50; j++) {
      const v = noise(i * 0.37 - 5, j * 0.53 - 7);
      assert.ok(v >= 0 && v <= 1, `out of range: ${v}`);
      count++;
    }
  }
  assert.equal(count, 2000);
});

test('makeNoise2D: same seed and point give the same value', () => {
  const a = makeNoise2D(8);
  const b = makeNoise2D(8);
  for (let i = 0; i < 200; i++) {
    const x = i * 0.13;
    const y = i * 0.29;
    assert.equal(a(x, y), b(x, y));
  }
});

test('makeNoise2D: different seeds produce different fields', () => {
  const a = makeNoise2D(1);
  const b = makeNoise2D(2);
  let differs = false;
  for (let i = 0; i < 50 && !differs; i++) {
    differs = a(i * 0.7, i * 0.3) !== b(i * 0.7, i * 0.3);
  }
  assert.equal(differs, true);
});

test('makeNoise2D: is continuous (small steps change value little)', () => {
  const noise = makeNoise2D(11);
  for (let i = 0; i < 2000; i++) {
    const x = i * 0.11 - 20;
    const y = i * 0.07 + 3;
    assert.ok(Math.abs(noise(x, y) - noise(x + 0.001, y)) < 0.01);
  }
});

test('fbm: result lies in [0, 1]', () => {
  const noise = makeNoise2D(21);
  for (let i = 0; i < 2000; i++) {
    const v = fbm(noise, i * 0.21 - 10, i * 0.17 + 4);
    assert.ok(v >= 0 && v <= 1, `out of range: ${v}`);
  }
});

test('fbm: is deterministic and defaults to 3 octaves', () => {
  const noise = makeNoise2D(4);
  assert.equal(fbm(noise, 1.5, 2.5), fbm(noise, 1.5, 2.5, 3));
  assert.equal(fbm(noise, 1.5, 2.5, 5), fbm(noise, 1.5, 2.5, 5));
});
