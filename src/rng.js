// Seeded random numbers and value noise. Pure: no DOM, no globals.

// Mulberry32: small, fast, deterministic PRNG. Returns floats in [0, 1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Float in [a, b).
export function randRange(rand, a, b) {
  return a + (b - a) * rand();
}

// Integer in [a, b] (both ends inclusive).
export function randInt(rand, a, b) {
  return a + Math.floor(rand() * (b - a + 1));
}

// Integer hash of a lattice point and seed, mapped to [0, 1).
function latticeValue(ix, iy, seed) {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(seed, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Smoothstep fade: 3t^2 - 2t^3, zero slope at lattice points.
function fade(t) {
  return t * t * (3 - 2 * t);
}

// 2D value noise. Returns noise(x, y) in [0, 1], smooth and deterministic.
export function makeNoise2D(seed) {
  const s = seed | 0;
  return function noise(x, y) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = fade(x - x0);
    const ty = fade(y - y0);
    const v00 = latticeValue(x0, y0, s);
    const v10 = latticeValue(x0 + 1, y0, s);
    const v01 = latticeValue(x0, y0 + 1, s);
    const v11 = latticeValue(x0 + 1, y0 + 1, s);
    const top = v00 + (v10 - v00) * tx;
    const bottom = v01 + (v11 - v01) * tx;
    return top + (bottom - top) * ty;
  };
}

// Fractal noise: octaves of noise, doubling frequency and halving amplitude.
// Normalized so the result stays in [0, 1].
export function fbm(noise, x, y, octaves = 3) {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x * freq, y * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}
