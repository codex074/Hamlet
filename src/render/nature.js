// Nature: trees / rocks / berry bushes (resource nodes) and instanced ground detail (grass, flowers, pebbles).
// Everything is procedural, vertex-coloured, instanced and wind-swayed in the vertex shader.
// Node-safe: no `document` and no WebGL needed at import time.
import * as THREE from '../../vendor/three.module.js';
import { NODE_COUNTS, NODE_AMOUNT, BUILDINGS, WORLD_SIZE, MAX_HEIGHT, SPAWN } from '../config.js';
import { heightAt, isWater, fertilityAt } from '../terrain.js';
import { wearAt } from '../wear.js';
import { mulberry32, makeNoise2D } from '../rng.js';

// ------------------------------------------------------------------ small helpers

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };

// Deterministic pseudo-random in [0,1) from an integer id and a salt.
function rnd(id, salt) {
  const s = Math.sin(id * 127.1 + salt * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// Position-based hash in [0,1): identical for coincident vertices.
function hash3(x, y, z, seed = 0) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 19.19) * 43758.5453;
  return s - Math.floor(s);
}

const C = (hex) => new THREE.Color(hex);

// ------------------------------------------------------------------ geometry builder

function createBuilder() {
  return { pos: [], nor: [], col: [] };
}

const _m = new THREE.Matrix4();
const _nm = new THREE.Matrix3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _cen = new THREE.Vector3();

// Add a geometry transformed by `m` into the builder.
//   mode 'geo'    : use the geometry's own normals
//   mode 'flat'   : per-face normals
//   mode 'sphere' : normals radiate from the part centre (blended with +y by `up`) -> soft round canopies
// colorFn(x, y, z, nx, ny, nz) returns a THREE.Color (it may reuse one instance).
// faceColor: evaluate colorFn once per face at the centroid (crisp faceted rocks).
function addPart(b, geo0, m, colorFn, mode = 'geo', up = 0, faceColor = false) {
  const g = geo0.index ? geo0.toNonIndexed() : geo0.clone();
  const p = g.attributes.position;
  const nA = g.attributes.normal;
  _nm.getNormalMatrix(m);
  _cen.set(0, 0, 0).applyMatrix4(m);
  const wp = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const wn = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (let t = 0; t < p.count; t += 3) {
    for (let k = 0; k < 3; k++) wp[k].fromBufferAttribute(p, t + k).applyMatrix4(m);
    _a.subVectors(wp[1], wp[0]);
    _b.subVectors(wp[2], wp[0]);
    const face = _c.crossVectors(_a, _b).normalize().clone();
    for (let k = 0; k < 3; k++) {
      if (mode === 'flat') wn[k].copy(face);
      else if (mode === 'sphere') {
        wn[k].subVectors(wp[k], _cen).normalize();
        wn[k].y += up;
        wn[k].normalize();
      } else wn[k].fromBufferAttribute(nA, t + k).applyMatrix3(_nm).normalize();
    }
    let fc = null;
    if (faceColor) {
      const cx = (wp[0].x + wp[1].x + wp[2].x) / 3;
      const cy = (wp[0].y + wp[1].y + wp[2].y) / 3;
      const cz = (wp[0].z + wp[1].z + wp[2].z) / 3;
      fc = colorFn(cx, cy, cz, face.x, face.y, face.z).clone();
    }
    for (let k = 0; k < 3; k++) {
      b.pos.push(wp[k].x, wp[k].y, wp[k].z);
      b.nor.push(wn[k].x, wn[k].y, wn[k].z);
      const col = fc || colorFn(wp[k].x, wp[k].y, wp[k].z, wn[k].x, wn[k].y, wn[k].z);
      b.col.push(col.r, col.g, col.b);
    }
  }
  g.dispose();
}

function finish(b) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
  geo.computeBoundingSphere();
  geo.userData.triangles = b.pos.length / 9;
  return geo;
}

function compose(x, y, z, sx = 1, sy = sx, sz = sx, ry = 0, rx = 0, rz = 0) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
}

// Radially displace vertices by a position-hash (coincident vertices move together).
function lump(geo, amp, seed) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i); const y = p.getY(i); const z = p.getZ(i);
    const f = 1 + amp * (hash3(x, y, z, seed) - 0.5) * 2;
    p.setXYZ(i, x * f, y * f, z * f);
  }
  return geo;
}

// ------------------------------------------------------------------ tree models

const BARK = [C(0x4b3223), C(0x7a5738)];
const BARK_DARK = C(0x3a2618);
const BIRCH_WHITE = C(0xeae4d2);
const BIRCH_MARK = C(0x35302a);
const MOSS = C(0x5e7f3a);

const tmpCol = new THREE.Color();

function trunkColor(x, y, z, flareTop = 0.45) {
  const t = clamp(y / 2.2);
  tmpCol.copy(BARK[0]).lerp(BARK[1], t);
  if (y < flareTop) tmpCol.lerp(BARK_DARK, 0.35 * (1 - y / flareTop));
  // faint mossy base
  tmpCol.lerp(MOSS, 0.22 * smooth(0.5, 0.0, y) * hash3(x * 5, 0, z * 5, 2));
  tmpCol.multiplyScalar(0.88 + 0.24 * hash3(x * 9, y * 4, z * 9, 5));
  return tmpCol;
}

// Trunk with root flare. h = trunk height, r0 = base radius, r1 = top radius.
function addTrunk(b, { h, r0, r1, radial = 6, lean = [0, 0], seed = 0, pale = false }) {
  const flare = new THREE.CylinderGeometry(r0, r0 * 1.85, 0.5, radial, 1, true);
  lump(flare, 0.12, seed + 3);
  addPart(b, flare, compose(0, 0.2, 0, 1, 1, 1, seed * 0.7), pale
    ? (x, y, z) => { tmpCol.copy(BIRCH_WHITE).multiplyScalar(0.78 + 0.1 * hash3(x * 7, 0, z * 7)); tmpCol.lerp(BARK_DARK, 0.4 * smooth(0.35, 0.0, y)); return tmpCol; }
    : (x, y, z) => trunkColor(x, y, z));
  const segs = pale ? 5 : 1;
  const geo = new THREE.CylinderGeometry(r1, r0, h, radial, segs, true);
  geo.translate(0, h / 2, 0);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = p.getY(i) / h;
    p.setX(i, p.getX(i) + lean[0] * t * t);
    p.setZ(i, p.getZ(i) + lean[1] * t * t);
  }
  addPart(b, geo, compose(0, 0, 0, 1, 1, 1, seed * 0.7), pale
    ? (x, y, z) => {
      const band = Math.floor(y * 2.6);
      const mark = hash3(band, Math.round(x * 20), Math.round(z * 20), seed) > 0.62 && hash3(band, 0, 0, seed + 1) > 0.35;
      tmpCol.copy(BIRCH_WHITE).lerp(BIRCH_MARK, mark ? 0.85 : 0);
      tmpCol.multiplyScalar(0.9 + 0.12 * hash3(x * 9, y * 3, z * 9));
      return tmpCol;
    }
    : (x, y, z) => trunkColor(x, y, z));
}

// Lumpy leaf blob with soft sphere normals and a top-light gradient.
function addBlob(b, cx, cy, cz, r, { detail = 0, sy = 1, base, top, seed = 0, amp = 0.16 }) {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  lump(geo, amp, seed);
  const col = new THREE.Color();
  const bc = base.clone();
  const tc = top.clone();
  addPart(b, geo, compose(cx, cy, cz, r, r * sy, r, seed * 1.3), (x, y, z, nx, ny) => {
    const t = clamp((y - cy) / (r * sy) * 0.5 + 0.5);
    col.copy(bc).lerp(tc, smooth(0.45, 1.0, t) * 0.8);
    col.multiplyScalar((0.52 + 0.52 * t) * (0.88 + 0.24 * clamp(ny * 0.5 + 0.5)));
    col.multiplyScalar(0.94 + 0.12 * hash3(x * 6, y * 6, z * 6, seed));
    return col;
  }, 'sphere', 0.35);
}

// Layered conifer tier: a jittered cone that is darker on the rim / underside and bright at the tip.
function addTier(b, y0, h, r, { radial = 8, base, top, seed = 0, ox = 0, oz = 0 }) {
  const geo = new THREE.ConeGeometry(r, h, radial, 1, false);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) < -h / 2 + 0.001) { // rim vertices only
      const a = Math.atan2(p.getZ(i), p.getX(i));
      const f = 0.84 + 0.32 * hash3(Math.round(a * 50), seed, 0, seed);
      p.setX(i, p.getX(i) * f);
      p.setZ(i, p.getZ(i) * f);
      p.setY(i, p.getY(i) - 0.12 * hash3(Math.round(a * 40), 1, seed));
    }
  }
  geo.computeVertexNormals();
  const col = new THREE.Color();
  addPart(b, geo, compose(ox, y0 + h / 2, oz, 1, 1, 1, seed * 0.9), (x, y, z, nx, ny) => {
    const t = clamp((y - y0) / h);
    col.copy(base).lerp(top, t * t);
    col.multiplyScalar((0.7 + 0.45 * t) * (ny < -0.6 ? 0.55 : 1) * (0.92 + 0.16 * hash3(x * 8, y * 8, z * 8, seed)));
    return col;
  }, 'geo');
}

function pineA() {
  const b = createBuilder();
  addTrunk(b, { h: 1.9, r0: 0.2, r1: 0.14, radial: 6, seed: 1 });
  const tiers = [[0.9, 1.9, 1.75], [1.75, 1.75, 1.42], [2.55, 1.6, 1.12], [3.3, 1.45, 0.82], [4.0, 1.5, 0.52]];
  tiers.forEach(([y, h, r], i) => {
    const t = i / (tiers.length - 1);
    addTier(b, y, h, r, {
      radial: 9, seed: 10 + i, ox: (hash3(i, 1, 2) - 0.5) * 0.18, oz: (hash3(i, 3, 4) - 0.5) * 0.18,
      base: C(0x2d6a3a).lerp(C(0x3f8a45), t), top: C(0x5aa04e).lerp(C(0x86bb5e), t),
    });
  });
  return finish(b);
}

function pineB() {
  const b = createBuilder();
  addTrunk(b, { h: 1.5, r0: 0.17, r1: 0.11, radial: 5, seed: 2 });
  const n = 6;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const y = 1.0 + i * 0.78;
    const r = 1.32 - t * 0.98;
    addTier(b, y, 1.45 - t * 0.35, r, {
      radial: 7, seed: 40 + i, ox: (hash3(i, 5, 2) - 0.5) * 0.14, oz: (hash3(i, 9, 4) - 0.5) * 0.14,
      base: C(0x2a5a46).lerp(C(0x3b7a56), t), top: C(0x4f9068).lerp(C(0x7ab883), t),
    });
  }
  return finish(b);
}

function oak() {
  const b = createBuilder();
  addTrunk(b, { h: 2.3, r0: 0.3, r1: 0.2, radial: 6, seed: 3, lean: [0.12, -0.08] });
  // two branch stubs reaching into the canopy
  const br = new THREE.CylinderGeometry(0.07, 0.12, 1.2, 5, 1, true);
  br.translate(0, 0.6, 0);
  addPart(b, br, compose(0.05, 1.7, 0, 1, 1, 1, 0, 0, -0.75), (x, y, z) => trunkColor(x, y + 0.6, z));
  addPart(b, br, compose(0, 1.9, 0.0, 1, 1, 1, 0, 0.7, 0.2), (x, y, z) => trunkColor(x, y + 0.6, z));
  const base = C(0x3a742d);
  const top = C(0x86b845);
  addBlob(b, 0.0, 3.6, 0.0, 1.55, { detail: 1, base, top, seed: 11, sy: 0.88 });
  addBlob(b, 1.1, 3.0, 0.45, 1.05, { detail: 1, base: C(0x437f33), top, seed: 12 });
  addBlob(b, -1.05, 3.05, -0.35, 1.12, { detail: 0, base: C(0x3a7330), top, seed: 13, amp: 0.2 });
  addBlob(b, 0.2, 3.1, -1.05, 0.95, { detail: 0, base: C(0x3d7a31), top, seed: 14, amp: 0.2 });
  addBlob(b, -0.2, 3.15, 1.05, 0.95, { detail: 0, base: C(0x45842f), top, seed: 15, amp: 0.2 });
  addBlob(b, 0.35, 4.55, 0.1, 0.85, { detail: 0, base: C(0x4d8c34), top: C(0xa4cd55), seed: 16, amp: 0.2 });
  return finish(b);
}

function birch() {
  const b = createBuilder();
  addTrunk(b, { h: 3.7, r0: 0.15, r1: 0.08, radial: 5, seed: 4, lean: [0.28, 0.1], pale: true });
  const base = C(0x5f9a35);
  const top = C(0xb6d760);
  const lx = 0.28; const lz = 0.1; // follow the trunk lean at the top
  addBlob(b, lx + 0.0, 4.0, lz, 1.05, { detail: 1, base, top, seed: 21, sy: 1.25, amp: 0.14 });
  addBlob(b, lx + 0.7, 3.35, lz + 0.2, 0.74, { detail: 0, base: C(0x5c9634), top, seed: 22, sy: 1.15 });
  addBlob(b, lx - 0.65, 3.4, lz - 0.2, 0.78, { detail: 0, base: C(0x679f38), top, seed: 23, sy: 1.15 });
  addBlob(b, lx + 0.1, 4.85, lz, 0.6, { detail: 0, base: C(0x74ad3c), top: C(0xc4e06a), seed: 24, sy: 1.2 });
  return finish(b);
}

// ------------------------------------------------------------------ rock models

const STONE = [C(0x8d897f), C(0x827f78), C(0x9a958a)];
const MOSS_A = C(0x6d8f3e);
const MOSS_B = C(0x587b34);
const LICHEN = C(0xb9b496);

function addRock(b, { detail = 1, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, ry = 0, seed = 0, jitter = 0.2, flat = -0.5, tone = 0, moss = 1 }) {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  lump(geo, jitter, seed);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) if (p.getY(i) < flat) p.setY(i, flat);
  const col = new THREE.Color();
  addPart(b, geo, compose(x, y, z, sx, sy, sz, ry), (cx, cy, cz, nx, ny) => {
    const h = hash3(cx * 5, cy * 5, cz * 5, seed);
    col.copy(STONE[tone % 3]).multiplyScalar(0.82 + 0.34 * h);
    col.lerp(C(0x6a645c), clamp(0.5 * (1 - (cy - y) / sy)) * 0.5); // darker low down
    const m = smooth(0.38, 0.78, ny + 0.28 * (hash3(cx * 3, 0, cz * 3, seed + 1) - 0.5)) * moss;
    col.lerp(h > 0.5 ? MOSS_A : MOSS_B, m * 0.85);
    if (ny > 0.3 && h > 0.9) col.lerp(LICHEN, 0.5);
    if (ny < -0.1) col.multiplyScalar(0.72);
    return col;
  }, 'flat', 0, true);
}

function rockA() { // big rounded boulder with a companion stone
  const b = createBuilder();
  addRock(b, { x: 0, y: 0.62, sx: 1.25, sy: 0.9, sz: 1.05, ry: 0.3, seed: 1, jitter: 0.17, flat: -0.62 });
  addRock(b, { detail: 0, x: 1.15, y: 0.28, z: 0.45, sx: 0.55, sy: 0.4, sz: 0.5, ry: 1.1, seed: 2, tone: 1, flat: -0.6 });
  addRock(b, { detail: 0, x: -0.85, y: 0.18, z: -0.7, sx: 0.36, sy: 0.28, sz: 0.34, ry: 2.1, seed: 3, tone: 2, flat: -0.6 });
  return finish(b);
}

function rockB() { // low wide slab
  const b = createBuilder();
  addRock(b, { x: 0, y: 0.42, sx: 1.5, sy: 0.6, sz: 1.1, ry: 0.9, seed: 4, jitter: 0.2, flat: -0.65, tone: 1 });
  addRock(b, { detail: 0, x: 0.2, y: 0.8, z: -0.1, sx: 0.7, sy: 0.38, sz: 0.62, ry: 0.2, seed: 5, tone: 0, flat: -0.5 });
  addRock(b, { detail: 0, x: -1.3, y: 0.18, z: 0.55, sx: 0.42, sy: 0.3, sz: 0.4, ry: 1.7, seed: 6, tone: 2, flat: -0.6 });
  return finish(b);
}

function rockC() { // tall angular outcrop
  const b = createBuilder();
  addRock(b, { x: 0, y: 0.8, sx: 0.85, sy: 1.15, sz: 0.8, ry: 0.5, seed: 7, jitter: 0.24, flat: -0.7, tone: 2 });
  addRock(b, { detail: 0, x: 0.75, y: 0.4, z: 0.2, sx: 0.55, sy: 0.7, sz: 0.5, ry: 0.9, seed: 8, tone: 0, flat: -0.6 });
  addRock(b, { detail: 0, x: -0.5, y: 0.25, z: 0.75, sx: 0.5, sy: 0.38, sz: 0.5, ry: 2.0, seed: 9, tone: 1, flat: -0.6 });
  return finish(b);
}

// ------------------------------------------------------------------ berry bush

const BUSH_BLOBS = [
  [0.0, 0.52, 0.0, 0.66, 1], [0.58, 0.4, 0.16, 0.46, 0], [-0.52, 0.4, -0.18, 0.5, 0], [0.04, 0.44, -0.56, 0.42, 0], [-0.1, 0.4, 0.55, 0.42, 0],
];
const BERRY_COUNT = 12;

function bushGeometry() {
  const b = createBuilder();
  BUSH_BLOBS.forEach(([x, y, z, r, d], i) => addBlob(b, x, y, z, r, {
    detail: d, sy: 0.85, seed: 31 + i, amp: 0.13,
    base: C(0x3f8434).lerp(C(0x2f6f2e), (i % 2) * 0.5), top: C(0x9ccb4e),
  }));
  return finish(b);
}

// Berry clusters on the bush surface. aCenter / aIndex let the shader scale each berry to 0 by amount.
function berryGeometry() {
  const rand = mulberry32(777);
  const berries = [];
  // 3 clusters of 4 berries, each tucked against the bush surface
  for (let c = 0; c < 3; c++) {
    const [bx, by, bz, br] = BUSH_BLOBS[(c * 2 + 1) % BUSH_BLOBS.length];
    const a = (c / 3) * Math.PI * 2 + rand() * 1.2;
    const ey = 0.25 + rand() * 0.55; // elevation of the cluster centre on the blob
    const cx = Math.cos(a) * Math.sqrt(1 - ey * ey);
    const cz = Math.sin(a) * Math.sqrt(1 - ey * ey);
    for (let j = 0; j < 4; j++) {
      const jx = cx + (rand() - 0.5) * 0.55;
      const jy = ey + (rand() - 0.5) * 0.45;
      const jz = cz + (rand() - 0.5) * 0.55;
      const l = Math.hypot(jx, jy, jz);
      berries.push({ x: bx + (jx / l) * br * 1.02, y: by + (Math.max(jy, 0.05) / l) * br * 0.88, z: bz + (jz / l) * br * 1.02, rank: berries.length });
    }
  }
  // shuffle ranks so they appear spread out as the amount grows
  for (let i = berries.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = berries[i].rank; berries[i].rank = berries[j].rank; berries[j].rank = t;
  }
  const palette = [C(0xc7243d), C(0xd9374a), C(0xa81a38), C(0xe24a4a)];
  const b = createBuilder();
  const centers = [];
  const ranks = [];
  berries.forEach((bb, i) => {
    const before = b.pos.length / 3;
    const geo = new THREE.IcosahedronGeometry(0.11, 0);
    const col = palette[i % palette.length];
    addPart(b, geo, compose(bb.x, bb.y, bb.z, 1, 0.92, 1, i), (x, y, z, nx, ny) => {
      tmpCol.copy(col).multiplyScalar(0.8 + 0.35 * clamp(ny * 0.5 + 0.5));
      return tmpCol;
    }, 'sphere', 0.15);
    const n = b.pos.length / 3 - before;
    for (let k = 0; k < n; k++) { centers.push(bb.x, bb.y, bb.z); ranks.push(bb.rank); }
  });
  const geo = finish(b);
  geo.setAttribute('aCenter', new THREE.Float32BufferAttribute(centers, 3));
  geo.setAttribute('aIndex', new THREE.Float32BufferAttribute(ranks, 1));
  return geo;
}

// ------------------------------------------------------------------ materials with wind sway

const FRONT_FLIP = 'gl_FrontFacing ? 1.0 : - 1.0';

// Vertex-coloured Lambert material that bends with height (uniform time, per-instance phase) in a shared
// world-space wind direction. `berries` adds the per-berry amount scaling; `noFlip` keeps two-sided blades
// lit like the ground instead of flipping their normal on back faces.
function makeVegMaterial({ amp, height, berries = false, noFlip = false, doubleSide = false }) {
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true, side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
  });
  const timeU = { value: 0 };
  mat.userData.timeU = timeU;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = timeU;
    shader.uniforms.uAmp = { value: amp };
    shader.uniforms.uH = { value: height };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
uniform float uTime; uniform float uAmp; uniform float uH;
${berries ? 'attribute vec3 aCenter; attribute float aIndex; attribute float aFill;' : ''}`)
      .replace('#include <begin_vertex>', `vec3 transformed = vec3( position );
${berries ? `{
  float vis = clamp( aFill * ${BERRY_COUNT}.0 - aIndex, 0.0, 1.0 );
  transformed = aCenter + ( transformed - aCenter ) * vis;
}` : ''}
#ifdef USE_INSTANCING
  mat3 imx = mat3( instanceMatrix );
  vec3 ip = instanceMatrix[3].xyz;
#else
  mat3 imx = mat3( 1.0 );
  vec3 ip = vec3( 0.0 );
#endif
{
  float tt = clamp( position.y / uH, 0.0, 1.0 );
  float ph = dot( ip.xz, vec2( 0.11, 0.07 ) );
  float g = sin( uTime * 1.25 + ph ) * 0.55 + sin( uTime * 2.7 + ph * 1.9 + ip.x * 0.3 ) * 0.25 + 0.45;
  vec3 dW = vec3( 0.86, 0.0, 0.5 ) * ( g * tt * tt * uAmp );
  transformed += ( dW * imx ) / max( dot( imx[0], imx[0] ), 1e-4 );
}`);
    if (noFlip) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        THREE.ShaderChunk.normal_fragment_begin.replace(FRONT_FLIP, '1.0'),
      );
    }
  };
  mat.customProgramCacheKey = () => `veg|${berries ? 1 : 0}|${noFlip ? 1 : 0}`;
  return mat;
}

// ------------------------------------------------------------------ nodes view

const NODE_REFRESH = 0.5;
const BERRY_MAX = NODE_AMOUNT.berry;

export function createNodesView(parent, terrain) {
  const root = new THREE.Group();
  root.name = 'nature-nodes';
  parent.add(root);

  const treeCap = Math.ceil(NODE_COUNTS.tree * 1.3) + 32;
  const rockCap = Math.ceil(NODE_COUNTS.rock * 1.3) + 32;
  const berryCap = Math.ceil(NODE_COUNTS.berry * 1.3) + 32;

  const treeMat = makeVegMaterial({ amp: 0.12, height: 5.2 });
  const bushMat = makeVegMaterial({ amp: 0.05, height: 1.0 });
  const berryMat = makeVegMaterial({ amp: 0.05, height: 1.0, berries: true });
  const rockMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

  const geometries = [];
  function mk(name, geo, mat, cap, { cast = true, receive = true } = {}) {
    geometries.push(geo);
    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    mesh.name = name;
    root.add(mesh);
    return mesh;
  }

  const treeMeshes = [
    mk('trees-pine', pineA(), treeMat, treeCap),
    mk('trees-fir', pineB(), treeMat, treeCap),
    mk('trees-oak', oak(), treeMat, treeCap),
    mk('trees-birch', birch(), treeMat, treeCap),
  ];
  const rockMeshes = [
    mk('rocks-a', rockA(), rockMat, rockCap),
    mk('rocks-b', rockB(), rockMat, rockCap),
    mk('rocks-c', rockC(), rockMat, rockCap),
  ];
  const bushMesh = mk('bushes', bushGeometry(), bushMat, berryCap);
  const berryGeo = berryGeometry();
  const fillAttr = new THREE.InstancedBufferAttribute(new Float32Array(berryCap), 1);
  fillAttr.setUsage(THREE.DynamicDrawUsage);
  berryGeo.setAttribute('aFill', fillAttr);
  const berryMesh = mk('berries', berryGeo, berryMat, berryCap, { cast: false, receive: false });

  const biome = makeNoise2D(2024);
  const mats = [treeMat, bushMat, berryMat];

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const eu = new THREE.Euler();
  const pv = new THREE.Vector3();
  const sv = new THREE.Vector3();
  const color = new THREE.Color();

  function pickTreeVariant(n, h) {
    const lowN = biome(n.x * 0.03, n.z * 0.03);
    const pine = clamp(0.28 + (lowN - 0.5) * 1.5 + (h / MAX_HEIGHT) * 0.7, 0.05, 0.92);
    if (rnd(n.id, 7) < pine) return rnd(n.id, 8) < 0.55 ? 0 : 1;
    return rnd(n.id, 9) < 0.58 ? 2 : 3;
  }

  function refresh(nodes) {
    const tc = [0, 0, 0, 0];
    const rc = [0, 0, 0];
    let bc = 0;
    for (const n of nodes) {
      const h = heightAt(terrain, n.x, n.z);
      const yaw = rnd(n.id, 2) * Math.PI * 2;
      if (n.kind === 'tree') {
        const v = pickTreeVariant(n, h);
        const mesh = treeMeshes[v];
        const i = tc[v];
        if (i >= treeCap) continue;
        tc[v]++;
        const s = 0.82 + rnd(n.id, 1) * 0.5;
        eu.set((rnd(n.id, 11) - 0.5) * 0.07, yaw, (rnd(n.id, 12) - 0.5) * 0.07);
        q.setFromEuler(eu);
        pv.set(n.x, h - 0.08, n.z);
        sv.set(s * (0.92 + rnd(n.id, 13) * 0.16), s * (0.9 + rnd(n.id, 3) * 0.3), s * (0.92 + rnd(n.id, 14) * 0.16));
        m4.compose(pv, q, sv);
        mesh.setMatrixAt(i, m4);
        const tone = 0.88 + rnd(n.id, 4) * 0.24;
        color.setRGB(tone * (0.94 + rnd(n.id, 5) * 0.12), tone, tone * (0.88 + rnd(n.id, 6) * 0.2));
        if (v >= 2 && rnd(n.id, 15) < 0.12) color.multiply(tmpCol.setRGB(1.28, 1.02, 0.62)); // a few autumn-leaning trees
        mesh.setColorAt(i, color);
      } else if (n.kind === 'rock') {
        const v = Math.floor(rnd(n.id, 10) * 3) % 3;
        const mesh = rockMeshes[v];
        const i = rc[v];
        if (i >= rockCap) continue;
        rc[v]++;
        const s = (0.75 + rnd(n.id, 1) * 0.6) * (0.6 + 0.4 * Math.min(1, n.amount / NODE_AMOUNT.rock));
        q.setFromAxisAngle(pv.set(0, 1, 0), yaw);
        pv.set(n.x, h - 0.1, n.z);
        sv.set(s, s * (0.85 + rnd(n.id, 3) * 0.3), s);
        m4.compose(pv, q, sv);
        mesh.setMatrixAt(i, m4);
        const t = 0.9 + rnd(n.id, 4) * 0.2;
        mesh.setColorAt(i, color.setRGB(t, t * 0.99, t * 0.96));
      } else if (n.kind === 'berry') {
        if (bc >= berryCap) continue;
        const ratio = clamp(n.amount / BERRY_MAX);
        const s = (0.95 + rnd(n.id, 1) * 0.35) * (0.88 + 0.22 * ratio);
        q.setFromAxisAngle(pv.set(0, 1, 0), yaw);
        pv.set(n.x, h - 0.05, n.z);
        sv.set(s, s, s);
        m4.compose(pv, q, sv);
        bushMesh.setMatrixAt(bc, m4);
        berryMesh.setMatrixAt(bc, m4);
        const t = 0.9 + rnd(n.id, 4) * 0.2;
        bushMesh.setColorAt(bc, color.setRGB(t * (0.95 + rnd(n.id, 5) * 0.1), t, t * 0.95));
        // red bushes keep the vertex colours, a share turn deep purple
        if (rnd(n.id, 16) < 0.4) berryMesh.setColorAt(bc, color.setRGB(0.55, 0.8, 2.3));
        else berryMesh.setColorAt(bc, color.setRGB(1, 1, 1));
        fillAttr.array[bc] = n.amount > 0.05 ? 0.1 + 0.9 * ratio : 0;
        bc++;
      }
    }
    treeMeshes.forEach((m, i) => { m.count = tc[i]; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; });
    rockMeshes.forEach((m, i) => { m.count = rc[i]; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; });
    for (const m of [bushMesh, berryMesh]) {
      m.count = bc;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    fillAttr.needsUpdate = true;
  }

  let timer = NODE_REFRESH;
  let time = 0;
  let lastSig = NaN;

  function signature(nodes) {
    let s = nodes.length;
    for (const n of nodes) s = (s * 31 + n.id * 7 + Math.round(n.amount * 8) + (n.kind === 'tree' ? 1 : n.kind === 'rock' ? 2 : 3)) % 1000000007;
    return s;
  }

  function update(state, dt = 0) {
    time += dt;
    for (const m of mats) m.userData.timeU.value = time;
    timer += dt;
    if (timer < NODE_REFRESH) return;
    timer = 0;
    const sig = signature(state.nodes);
    if (sig === lastSig) return;
    lastSig = sig;
    refresh(state.nodes);
  }

  function dispose() {
    for (const m of [...treeMeshes, ...rockMeshes, bushMesh, berryMesh]) { root.remove(m); m.dispose(); }
    geometries.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
    rockMat.dispose();
    parent.remove(root);
  }

  return { update, dispose };
}

// ------------------------------------------------------------------ ground detail

const TUFT_N = 8000;
const FLOWER_N = 1500;
const PEBBLE_N = 600;
const DETAIL_REFRESH = 2;

function tuftGeometry() {
  const b = createBuilder();
  const rand = mulberry32(5);
  const blades = 6;
  const colBase = C(0x2f5e24);
  const colMid = C(0x62a038);
  const colTip = C(0xa3cf56);
  const up = new THREE.Vector3(0, 1, 0);
  const verts = [];
  for (let k = 0; k < blades; k++) {
    const a = (k / blades) * Math.PI * 2 + rand() * 0.8;
    const off = 0.02 + rand() * 0.13;
    const h = 0.2 + rand() * 0.3 + (k === 0 ? 0.12 : 0);
    const w = 0.03 + rand() * 0.02;
    const lean = 0.2 + rand() * 0.45;
    const ca = Math.cos(a); const sa = Math.sin(a);
    const px = -sa; const pz = ca; // perpendicular (blade width direction)
    const bx = ca * off; const bz = sa * off;
    const mk = (u, y, t) => { // u in [-1,1] across, y height, t lean factor
      const l = lean * t * t * h;
      return [bx + px * w * u + ca * l, y, bz + pz * w * u + sa * l, y / h];
    };
    const BL = mk(-1, 0, 0); const BR = mk(1, 0, 0);
    const ML = mk(-0.7, h * 0.55, 0.55); const MR = mk(0.7, h * 0.55, 0.55);
    const T = mk(0, h, 1);
    verts.push([BL, BR, ML], [BR, MR, ML], [ML, MR, T]);
  }
  const col = new THREE.Color();
  for (const tri of verts) {
    for (const v of tri) {
      const t = v[3];
      if (t < 0.5) col.copy(colBase).lerp(colMid, t * 2);
      else col.copy(colMid).lerp(colTip, (t - 0.5) * 2);
      b.pos.push(v[0], v[1], v[2]);
      b.nor.push(up.x, up.y, up.z);
      b.col.push(col.r, col.g, col.b);
    }
  }
  return finish(b);
}

function flowerGeometry(petal, centre) {
  const b = createBuilder();
  const up = [0, 1, 0];
  const stem = C(0x4f8a35);
  const stemTop = C(0x6aa840);
  const push = (x, y, z, c) => { b.pos.push(x, y, z); b.nor.push(up[0], up[1], up[2]); b.col.push(c.r, c.g, c.b); };
  const h = 0.3;
  const w = 0.012;
  const tilt = 0.05;
  for (const [cx, cz] of [[1, 0], [0, 1]]) {
    push(-cx * w, 0, -cz * w, stem); push(cx * w, 0, cz * w, stem); push(-cx * w * 0.8 + tilt, h, -cz * w * 0.8, stemTop);
    push(cx * w, 0, cz * w, stem); push(cx * w * 0.8 + tilt, h, cz * w * 0.8, stemTop); push(-cx * w * 0.8 + tilt, h, -cz * w * 0.8, stemTop);
  }
  // petal fan: 7 petals around a centre, slightly cupped upward
  const n = 7;
  const R = 0.075;
  const hc = h + 0.012;
  const cc = C(centre);
  const pc = C(petal);
  const pcLight = pc.clone().multiplyScalar(1.12);
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    push(tilt, hc + 0.012, 0, cc);
    push(tilt + Math.cos(a0) * R, hc, Math.sin(a0) * R, i % 2 ? pc : pcLight);
    push(tilt + Math.cos(a1) * R, hc, Math.sin(a1) * R, (i + 1) % 2 ? pc : pcLight);
  }
  return finish(b);
}

function pebbleGeometry() {
  const b = createBuilder();
  const geo = new THREE.IcosahedronGeometry(1, 0);
  lump(geo, 0.22, 3);
  addPart(b, geo, compose(0, 0.05, 0, 0.14, 0.085, 0.11), (cx, cy, cz, nx, ny) => {
    tmpCol.set(0xb4ada0).multiplyScalar(0.8 + 0.3 * hash3(cx * 40, cy * 40, cz * 40) + 0.12 * ny);
    return tmpCol;
  }, 'flat', 0, true);
  return finish(b);
}

export function createGroundDetail(parent, terrain) {
  const root = new THREE.Group();
  root.name = 'nature-ground-detail';
  parent.add(root);

  const rand = mulberry32(90210);
  const clump = makeNoise2D(311);
  const patchN = makeNoise2D(412);

  // land test: returns terrain height or null
  const slopeAt = (x, z) => {
    const dx = heightAt(terrain, x + 1, z) - heightAt(terrain, x - 1, z);
    const dz = heightAt(terrain, x, z + 1) - heightAt(terrain, x, z - 1);
    return Math.hypot(dx, dz) * 0.5;
  };
  const lo = 3;
  const hi = WORLD_SIZE - 3;
  function landAt(x, z, minH = 0.12, maxSlope = 0.75) {
    if (isWater(terrain, x, z)) return null;
    const h = heightAt(terrain, x, z);
    if (h < minH) return null;
    if (slopeAt(x, z) > maxSlope) return null;
    return h;
  }

  const items = []; // { mesh, base: Float32Array, hidden: Uint8Array, x:[], z:[] }

  function makeSet(name, geo, mat, n, { receive = true } = {}) {
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = receive;
    mesh.name = name;
    root.add(mesh);
    return { mesh, n: 0, cap: n, x: new Float32Array(n), z: new Float32Array(n), hidden: new Uint8Array(n), base: new Float32Array(n * 16) };
  }

  const tuftMat = makeVegMaterial({ amp: 0.14, height: 0.7, noFlip: true, doubleSide: true });
  const flowerMat = makeVegMaterial({ amp: 0.12, height: 0.4, noFlip: true, doubleSide: true });
  const pebbleMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

  const tuftGeo = tuftGeometry();
  const flowerSpecs = [
    ['flowers-white', 0xf6f2e6, 0xf2c230],
    ['flowers-yellow', 0xf4cf2a, 0xd9791c],
    ['flowers-purple', 0x9a62c8, 0xf0e2a0],
  ];
  const flowerGeos = flowerSpecs.map(([, p, c]) => flowerGeometry(p, c));
  const pebbleGeo = pebbleGeometry();

  const tufts = makeSet('grass-tufts', tuftGeo, tuftMat, TUFT_N);
  const flowerSets = flowerSpecs.map(([name], i) => makeSet(name, flowerGeos[i], flowerMat, Math.ceil(FLOWER_N * 0.6)));
  const pebbles = makeSet('pebbles', pebbleGeo, pebbleMat, PEBBLE_N);

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const eu = new THREE.Euler();
  const pv = new THREE.Vector3();
  const sv = new THREE.Vector3();
  const color = new THREE.Color();

  function put(set, x, z, h, scale, yaw, tilt = 0.12) {
    const i = set.n++;
    eu.set((rand() - 0.5) * tilt, yaw, (rand() - 0.5) * tilt);
    q.setFromEuler(eu);
    pv.set(x, h - 0.02, z);
    sv.set(scale * (0.85 + rand() * 0.3), scale, scale * (0.85 + rand() * 0.3));
    m4.compose(pv, q, sv);
    set.mesh.setMatrixAt(i, m4);
    set.x[i] = x;
    set.z[i] = z;
    m4.toArray(set.base, i * 16);
    return i;
  }

  // ---- grass tufts: clumped, denser on fertile ground; ~60% of them around the starting area where the
  // village is built, the rest spread over the map
  const TUFT_NEAR = Math.floor(TUFT_N * 0.6);
  let guard = 0;
  while (tufts.n < TUFT_N && guard++ < TUFT_N * 60) {
    const near = tufts.n < TUFT_NEAR;
    let x; let z;
    if (near) {
      const a = rand() * Math.PI * 2;
      const r = 62 * Math.sqrt(rand());
      x = SPAWN.x + Math.cos(a) * r;
      z = SPAWN.z + Math.sin(a) * r;
    } else {
      x = lo + rand() * (hi - lo);
      z = lo + rand() * (hi - lo);
    }
    if (x < lo || z < lo || x > hi || z > hi) continue;
    const h = landAt(x, z);
    if (h === null) continue;
    const f = clamp((fertilityAt(terrain, x, z) - 0.3) / 0.4);
    const cl = smooth(0.35, 0.6, clump(x * 0.11, z * 0.11)) * 0.8 + 0.2;
    const bank = smooth(0.1, 0.9, h);
    if (rand() > (0.55 + 0.45 * f) * cl * bank) continue;
    const i = put(tufts, x, z, h, 0.65 + rand() * 0.6 + f * 0.2, rand() * Math.PI * 2, 0.25);
    // tint matches the terrain's dry -> lush range
    const dry = 1 - f;
    color.setRGB(
      (0.88 + dry * 0.28) * (0.9 + rand() * 0.2),
      (0.98 + f * 0.05) * (0.9 + rand() * 0.2),
      (0.62 + f * 0.3) * (0.9 + rand() * 0.2),
    );
    tufts.mesh.setColorAt(i, color);
  }

  // ---- flowers: meadow patches of one colour, plus the odd stray
  const patches = [];
  guard = 0;
  while (patches.length < 70 && guard++ < 4000) {
    const x = lo + rand() * (hi - lo);
    const z = lo + rand() * (hi - lo);
    if (landAt(x, z, 0.5, 0.5) === null) continue;
    if (patchN(x * 0.05, z * 0.05) < 0.4) continue;
    patches.push({ x, z, kind: Math.floor(rand() * 3), r: 1.4 + rand() * 2.2 });
  }
  guard = 0;
  let placedFlowers = 0;
  while (placedFlowers < FLOWER_N && guard++ < FLOWER_N * 30 && patches.length) {
    let x; let z; let kind;
    if (rand() < 0.85) {
      const p = patches[Math.floor(rand() * patches.length)];
      const a = rand() * Math.PI * 2;
      const rr = Math.sqrt(rand()) * p.r;
      x = p.x + Math.cos(a) * rr;
      z = p.z + Math.sin(a) * rr;
      kind = rand() < 0.85 ? p.kind : Math.floor(rand() * 3);
    } else {
      x = lo + rand() * (hi - lo);
      z = lo + rand() * (hi - lo);
      kind = Math.floor(rand() * 3);
    }
    const h = landAt(x, z, 0.5, 0.5);
    if (h === null) continue;
    const set = flowerSets[kind];
    if (set.n >= set.cap) continue;
    const i = put(set, x, z, h, 0.8 + rand() * 0.6, rand() * Math.PI * 2, 0.3);
    const t = 0.92 + rand() * 0.16;
    set.mesh.setColorAt(i, color.setRGB(t, t, t));
    placedFlowers++;
  }

  // ---- pebbles: mostly on and near the river banks
  guard = 0;
  while (pebbles.n < PEBBLE_N && guard++ < PEBBLE_N * 200) {
    const x = lo + rand() * (hi - lo);
    const z = lo + rand() * (hi - lo);
    if (isWater(terrain, x, z)) continue;
    const h = heightAt(terrain, x, z);
    if (h < -0.4 || slopeAt(x, z) > 1.0) continue;
    const bank = h < 0.9;
    if (!bank && rand() > 0.22) continue;
    const i = put(pebbles, x, z, h, 0.7 + rand() * 1.1, rand() * Math.PI * 2, 0.4);
    const t = 0.78 + rand() * 0.42;
    pebbles.mesh.setColorAt(i, color.setRGB(t * (rand() < 0.3 ? 1.1 : 1), t, t * (rand() < 0.3 ? 0.88 : 1)));
  }

  const sets = [tufts, ...flowerSets, pebbles];
  for (const s of sets) {
    s.mesh.count = s.n;
    s.mesh.instanceMatrix.needsUpdate = true;
    if (s.mesh.instanceColor) s.mesh.instanceColor.needsUpdate = true;
  }

  // ---- hiding under buildings / fields / worn paths
  const ZERO = new Float32Array(16);
  let timer = DETAIL_REFRESH;
  let time = 0;

  function recompute(state) {
    const bl = [];
    for (const b of state.buildings || []) {
      const info = BUILDINGS[b.type];
      const r = (info ? info.radius : 4) + 0.5;
      bl.push(b.x, b.z, r * r);
    }
    const fields = [];
    for (const z of state.zones || []) if (z.kind === 'field') fields.push(z.x, z.z, z.r * z.r);
    const wear = state.wear;
    for (const s of sets) {
      let changed = false;
      for (let i = 0; i < s.n; i++) {
        const x = s.x[i]; const z = s.z[i];
        let hide = false;
        for (let k = 0; k < bl.length && !hide; k += 3) {
          const dx = x - bl[k]; const dz = z - bl[k + 1];
          if (dx * dx + dz * dz < bl[k + 2]) hide = true;
        }
        for (let k = 0; k < fields.length && !hide; k += 3) {
          const dx = x - fields[k]; const dz = z - fields[k + 1];
          if (dx * dx + dz * dz < fields[k + 2]) hide = true;
        }
        if (!hide && wear && wearAt(wear, x, z) > 0.35) hide = true;
        const h = hide ? 1 : 0;
        if (h !== s.hidden[i]) {
          s.hidden[i] = h;
          const arr = s.mesh.instanceMatrix.array;
          if (h) arr.set(ZERO, i * 16);
          else arr.set(s.base.subarray(i * 16, i * 16 + 16), i * 16);
          changed = true;
        }
      }
      if (changed) s.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  const windMats = [tuftMat, flowerMat];

  function update(state, dt = 0) {
    time += dt;
    for (const m of windMats) m.userData.timeU.value = time;
    timer += dt;
    if (timer >= DETAIL_REFRESH) {
      timer = 0;
      recompute(state);
    }
  }

  function dispose() {
    for (const s of sets) { root.remove(s.mesh); s.mesh.dispose(); }
    [tuftGeo, ...flowerGeos, pebbleGeo].forEach((g) => g.dispose());
    [tuftMat, flowerMat, pebbleMat].forEach((m) => m.dispose());
    parent.remove(root);
  }

  return { update, dispose };
}
