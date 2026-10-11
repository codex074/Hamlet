// Nature: trees / saplings / rocks / iron ore outcrops / berry bushes (resource nodes) and instanced ground detail
// (grass, flowers, pebbles). Large-map ready: nodes live in 40 m chunks of InstancedMeshes (frustum culled, rebuilt
// only when a chunk's contents change); ground detail is scattered per 40 m chunk (deterministic) and only
// instantiated within ~110 m of the view target.
// Everything is procedural, vertex-coloured, instanced and wind-swayed in the vertex shader.
// Node-safe: no `document` and no WebGL needed at import time.
import * as THREE from '../../vendor/three.module.js';
import * as CFG from '../config.js';
import { NODE_AMOUNT, BUILDINGS, WORLD_SIZE, MAX_HEIGHT, DAY_LENGTH } from '../config.js';
import { heightAt, isWater, fertilityAt } from '../terrain.js';
import { mulberry32, makeNoise2D } from '../rng.js';
import { getGraphics, onGraphicsChange } from './graphics.js';

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

// Build the BufferGeometry. Identical vertices (same position, normal and colour) are welded into an indexed
// geometry: blobs / cones share most of their vertices, which roughly halves vertex-shader work per tree.
// weld=false keeps the exact triangle-soup order (the berry geometry relies on it for its per-vertex attributes).
function finish(b, weld = true) {
  const geo = new THREE.BufferGeometry();
  const n = b.pos.length / 3;
  if (weld) {
    const map = new Map();
    const pos = []; const nor = []; const col = []; const index = new Uint32Array(n);
    const q = (v, f) => Math.round(v * f);
    for (let i = 0; i < n; i++) {
      const x = b.pos[i * 3]; const y = b.pos[i * 3 + 1]; const z = b.pos[i * 3 + 2];
      const key = `${q(x, 2000)},${q(y, 2000)},${q(z, 2000)}|${q(b.nor[i * 3], 500)},${q(b.nor[i * 3 + 1], 500)},${q(b.nor[i * 3 + 2], 500)}|${q(b.col[i * 3], 250)},${q(b.col[i * 3 + 1], 250)},${q(b.col[i * 3 + 2], 250)}`;
      let id = map.get(key);
      if (id === undefined) {
        id = pos.length / 3;
        map.set(key, id);
        pos.push(x, y, z); nor.push(b.nor[i * 3], b.nor[i * 3 + 1], b.nor[i * 3 + 2]); col.push(b.col[i * 3], b.col[i * 3 + 1], b.col[i * 3 + 2]);
      }
      index[i] = id;
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(pos.length / 3 > 65535 ? index : new Uint16Array(index), 1));
  } else {
    geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
  }
  geo.computeBoundingSphere();
  geo.userData.triangles = n / 3;
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


// ------------------------------------------------------------------ iron ore outcrops

const ORE_BASE = [C(0x7a746f), C(0x857e78), C(0x6b6662)];
const ORE_RUST = [C(0xb8581e), C(0xcf7a2a), C(0xa04a20)];
const ORE_DARK = C(0x35302f);
const ORE_GLINT = C(0xe08a3c);

function addOreRock(b, { detail = 1, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, ry = 0, seed = 0, jitter = 0.2, flat = -0.5, tone = 0, rust = 1 }) {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  lump(geo, jitter, seed);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) if (p.getY(i) < flat) p.setY(i, flat);
  const col = new THREE.Color();
  addPart(b, geo, compose(x, y, z, sx, sy, sz, ry), (cx, cy, cz, nx, ny) => {
    const h = hash3(cx * 5, cy * 5, cz * 5, seed);
    col.copy(ORE_BASE[tone % 3]).multiplyScalar(0.8 + 0.36 * h);
    // slanted mineral veins: bands tilted across the outcrop
    const band = Math.sin((cy - y) * 7.5 + (cx - x) * 2.6 + (cz - z) * 1.7 + seed * 2.1);
    const band2 = Math.sin((cy - y) * 3.1 - (cx - x) * 3.4 + seed * 5.3);
    if (band > 0.8 - 0.2 * rust) col.lerp(ORE_RUST[Math.floor(h * 2.99)], 0.6 + 0.35 * h);
    else if (band < -0.88) col.lerp(ORE_DARK, 0.7);
    else if (band2 > 0.95) col.lerp(ORE_DARK, 0.3);
    if (h > 0.93) col.lerp(ORE_GLINT, 0.6);
    col.lerp(C(0x4a4442), clamp(0.5 * (1 - (cy - y) / sy)) * 0.4); // darker low down
    if (ny > 0.55 && h < 0.5) col.lerp(C(0x7b665a), 0.25); // dusty top
    if (ny < -0.1) col.multiplyScalar(0.7);
    return col;
  }, 'flat', 0, true);
}

function oreA() { // rounded mound with a rusty seam and angular chunks around it
  const b = createBuilder();
  addOreRock(b, { x: 0, y: 0.6, sx: 1.2, sy: 0.95, sz: 1.0, ry: 0.4, seed: 11, jitter: 0.2, flat: -0.6 });
  addOreRock(b, { detail: 0, x: 0.2, y: 1.05, z: -0.1, sx: 0.6, sy: 0.55, sz: 0.55, ry: 0.9, seed: 12, tone: 1, jitter: 0.24, flat: -0.4 });
  addOreRock(b, { detail: 0, x: 1.15, y: 0.26, z: 0.5, sx: 0.48, sy: 0.36, sz: 0.44, ry: 1.3, seed: 13, tone: 2, rust: 1.6, flat: -0.55 });
  addOreRock(b, { detail: 0, x: -0.95, y: 0.2, z: -0.65, sx: 0.4, sy: 0.3, sz: 0.36, ry: 2.2, seed: 14, tone: 0, rust: 1.6, flat: -0.55 });
  addOreRock(b, { detail: 0, x: -0.5, y: 0.14, z: 0.95, sx: 0.28, sy: 0.22, sz: 0.3, ry: 0.5, seed: 15, tone: 1, rust: 1.8, flat: -0.5 });
  return finish(b);
}

function oreB() { // tall jagged outcrop leaning over a low shelf
  const b = createBuilder();
  addOreRock(b, { x: 0, y: 0.78, sx: 0.85, sy: 1.2, sz: 0.8, ry: 0.2, seed: 21, jitter: 0.25, flat: -0.7, tone: 1 });
  addOreRock(b, { detail: 0, x: 0.7, y: 0.42, z: 0.15, sx: 0.58, sy: 0.7, sz: 0.5, ry: 1.0, seed: 22, tone: 0, rust: 1.4, flat: -0.6 });
  addOreRock(b, { detail: 0, x: -0.6, y: 0.3, z: 0.5, sx: 0.55, sy: 0.45, sz: 0.5, ry: 2.0, seed: 23, tone: 2, flat: -0.6 });
  addOreRock(b, { detail: 0, x: 0.1, y: 0.16, z: -0.95, sx: 0.5, sy: 0.3, sz: 0.4, ry: 0.4, seed: 24, tone: 1, rust: 1.7, flat: -0.5 });
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
  const geo = finish(b, false);
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

// ------------------------------------------------------------------ sapling model

// A young tree: thin leaning trunk, a loose cluster of fresh light-green blobs and a tie-stake. Authored at
// its fully grown size (~3 m); the instance scale carries the growth stage.
function saplingGeometry() {
  const b = createBuilder();
  addTrunk(b, { h: 1.5, r0: 0.07, r1: 0.04, radial: 5, seed: 6, lean: [0.1, 0.05] });
  const top = C(0xb3dc62);
  addBlob(b, 0.1, 2.05, 0.04, 0.72, { detail: 1, base: C(0x4f9a38), top, seed: 41, sy: 1.1, amp: 0.15 });
  addBlob(b, 0.5, 1.62, 0.12, 0.4, { detail: 0, base: C(0x5aa63d), top, seed: 42, amp: 0.2 });
  addBlob(b, -0.38, 1.55, -0.16, 0.42, { detail: 0, base: C(0x4a9238), top, seed: 43, amp: 0.2 });
  addBlob(b, 0.08, 2.62, 0.0, 0.36, { detail: 0, base: C(0x62b043), top: C(0xc8e676), seed: 44, amp: 0.2 });
  // stake with a loop of twine
  const stake = new THREE.CylinderGeometry(0.025, 0.03, 1.35, 5, 1, true);
  stake.translate(0, 0.675, 0);
  addPart(b, stake, compose(0.26, 0, 0.2), (x, y, z) => { tmpCol.set(0xa98a5a).multiplyScalar(0.85 + 0.2 * hash3(x * 9, y * 5, z * 9, 3)); return tmpCol; });
  const twine = new THREE.TorusGeometry(0.13, 0.012, 3, 6);
  addPart(b, twine, compose(0.14, 0.95, 0.1, 1, 1, 1, 0, Math.PI / 2), () => tmpCol.set(0xd9c79a));
  return finish(b);
}

// ------------------------------------------------------------------ nodes view

const NODE_REFRESH = 0.5;
const NODE_CHUNK = 40;          // metres per instancing chunk (frustum culled)
const BERRY_MAX = NODE_AMOUNT.berry;
const SLOT_TREE = 0;            // 0..3 tree variants
const SLOT_ROCK = 4;            // 4..6
const SLOT_ORE = 7;             // 7..8
const SLOT_BUSH = 9;
const SLOT_BERRY = 10;
const SLOT_COUNT = 11;

export function createNodesView(parent, terrain) {
  const SIZE = terrain.size || WORLD_SIZE;
  const nc = Math.max(1, Math.ceil(SIZE / NODE_CHUNK));
  const root = new THREE.Group();
  root.name = 'nature-nodes';
  parent.add(root);

  const treeMat = makeVegMaterial({ amp: 0.12, height: 5.2 });
  const bushMat = makeVegMaterial({ amp: 0.05, height: 1.0 });
  const berryMat = makeVegMaterial({ amp: 0.05, height: 1.0, berries: true });
  const saplingMat = makeVegMaterial({ amp: 0.1, height: 2.6 });
  const rockMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

  const geometries = [];
  const slotGeo = [pineA(), pineB(), oak(), birch(), rockA(), rockB(), rockC(), oreA(), oreB(), bushGeometry(), berryGeometry()];
  geometries.push(...slotGeo);
  const slotMat = [treeMat, treeMat, treeMat, treeMat, rockMat, rockMat, rockMat, rockMat, rockMat, bushMat, berryMat];
  const slotName = ['trees-pine', 'trees-fir', 'trees-oak', 'trees-birch', 'rocks-a', 'rocks-b', 'rocks-c', 'ore-a', 'ore-b', 'bushes', 'berries'];
  const slotShadow = [true, true, true, true, true, true, true, true, true, true, false];

  const biome = makeNoise2D(2024);
  const mats = [treeMat, bushMat, berryMat, saplingMat];

  const chunks = new Array(nc * nc).fill(null);   // { meshes: [InstancedMesh|null] * SLOT_COUNT }
  const lastSig = new Float64Array(nc * nc).fill(-1);
  const lastCnt = new Int32Array(nc * nc).fill(-1);
  const sig = new Float64Array(nc * nc);
  const cnt = new Int32Array(nc * nc);

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const eu = new THREE.Euler();
  const pv = new THREE.Vector3();
  const sv = new THREE.Vector3();
  const color = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);

  function pickTreeVariant(n, h) {
    const lowN = biome(n.x * 0.03, n.z * 0.03);
    const pine = clamp(0.28 + (lowN - 0.5) * 1.5 + (h / MAX_HEIGHT) * 0.7, 0.05, 0.92);
    if (rnd(n.id, 7) < pine) return rnd(n.id, 8) < 0.55 ? 0 : 1;
    return rnd(n.id, 9) < 0.58 ? 2 : 3;
  }

  // Berry meshes need their own aFill attribute, so each gets a light geometry that shares the vertex buffers.
  function berryGeometryFor(cap) {
    const src = slotGeo[SLOT_BERRY];
    const g = new THREE.BufferGeometry();
    for (const name of Object.keys(src.attributes)) g.setAttribute(name, src.attributes[name]);
    const fill = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    fill.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aFill', fill);
    g.boundingSphere = src.boundingSphere ? src.boundingSphere.clone() : null;
    return g;
  }

  function ensureMesh(chunk, slot, need) {
    let m = chunk.meshes[slot];
    if (m && need <= m.instanceMatrix.count) return m;
    if (m) {
      root.remove(m);
      m.dispose();
      if (slot === SLOT_BERRY) m.geometry.dispose();
    }
    const cap = Math.max(8, Math.ceil(need * 1.5));
    const geo = slot === SLOT_BERRY ? berryGeometryFor(cap) : slotGeo[slot];
    m = new THREE.InstancedMesh(geo, slotMat[slot], cap);
    m.count = 0;
    m.frustumCulled = true;       // per-chunk bounding sphere is set on every rebuild
    m.castShadow = slotShadow[slot];
    m.receiveShadow = slot !== SLOT_BERRY;
    m.name = slotName[slot];
    root.add(m);
    chunk.meshes[slot] = m;
    return m;
  }

  const lists = new Map();   // dirty chunk index -> node array (reused per refresh)
  const slotOf = [];
  const hOf = [];
  const slotCount = new Int32Array(SLOT_COUNT);
  const slotFill = new Int32Array(SLOT_COUNT);

  function rebuildChunk(ci, list) {
    let chunk = chunks[ci];
    if (!chunk) chunk = chunks[ci] = { meshes: new Array(SLOT_COUNT).fill(null) };
    slotCount.fill(0);
    slotFill.fill(0);
    let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (let k = 0; k < list.length; k++) {
      const n = list[k];
      const h = heightAt(terrain, n.x, n.z);
      hOf[k] = h;
      let slot;
      if (n.kind === 'tree') slot = SLOT_TREE + pickTreeVariant(n, h);
      else if (n.kind === 'rock') slot = SLOT_ROCK + (Math.floor(rnd(n.id, 10) * 3) % 3);
      else if (n.kind === 'ore') slot = SLOT_ORE + (Math.floor(rnd(n.id, 10) * 2) % 2);
      else if (n.kind === 'berry') slot = SLOT_BUSH;
      else slot = -1;
      slotOf[k] = slot;
      if (slot < 0) continue;
      slotCount[slot]++;
      if (slot === SLOT_BUSH) slotCount[SLOT_BERRY]++;
      if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
      if (n.z < minZ) minZ = n.z; if (n.z > maxZ) maxZ = n.z;
      if (h < minY) minY = h; if (h > maxY) maxY = h;
    }
    for (let s = 0; s < SLOT_COUNT; s++) if (slotCount[s] > 0) ensureMesh(chunk, s, slotCount[s]);

    for (let k = 0; k < list.length; k++) {
      const n = list[k];
      const slot = slotOf[k];
      if (slot < 0) continue;
      const h = hOf[k];
      const yaw = rnd(n.id, 2) * Math.PI * 2;
      if (n.kind === 'tree') {
        const mesh = chunk.meshes[slot];
        const i = slotFill[slot]++;
        // every chop shows: the tree shrinks and starts to lean until it is felled
        const cut = 1 - Math.min(1, n.amount / NODE_AMOUNT.tree);
        const s = (0.82 + rnd(n.id, 1) * 0.5) * (1 - 0.5 * cut);
        const lean = cut * 0.32;
        eu.set((rnd(n.id, 11) - 0.5) * 0.07 + lean, yaw, (rnd(n.id, 12) - 0.5) * 0.07);
        q.setFromEuler(eu);
        pv.set(n.x, h - 0.08, n.z);
        sv.set(s * (0.92 + rnd(n.id, 13) * 0.16), s * (0.9 + rnd(n.id, 3) * 0.3), s * (0.92 + rnd(n.id, 14) * 0.16));
        m4.compose(pv, q, sv);
        mesh.setMatrixAt(i, m4);
        const tone = 0.88 + rnd(n.id, 4) * 0.24;
        color.setRGB(tone * (0.94 + rnd(n.id, 5) * 0.12), tone, tone * (0.88 + rnd(n.id, 6) * 0.2));
        if (slot >= 2 && rnd(n.id, 15) < 0.12) color.multiply(tmpCol.setRGB(1.28, 1.02, 0.62)); // a few autumn-leaning trees
        mesh.setColorAt(i, color);
      } else if (n.kind === 'rock') {
        const mesh = chunk.meshes[slot];
        const i = slotFill[slot]++;
        const s = (0.75 + rnd(n.id, 1) * 0.6) * (0.3 + 0.7 * Math.min(1, n.amount / NODE_AMOUNT.rock));
        q.setFromAxisAngle(up, yaw);
        pv.set(n.x, h - 0.1, n.z);
        sv.set(s, s * (0.85 + rnd(n.id, 3) * 0.3), s);
        m4.compose(pv, q, sv);
        mesh.setMatrixAt(i, m4);
        const t = 0.9 + rnd(n.id, 4) * 0.2;
        mesh.setColorAt(i, color.setRGB(t, t * 0.99, t * 0.96));
      } else if (n.kind === 'ore') {
        const mesh = chunk.meshes[slot];
        const i = slotFill[slot]++;
        const s = (0.85 + rnd(n.id, 1) * 0.45) * (0.3 + 0.7 * Math.min(1, n.amount / NODE_AMOUNT.ore));
        q.setFromAxisAngle(up, yaw);
        pv.set(n.x, h - 0.1, n.z);
        sv.set(s, s * (0.85 + rnd(n.id, 3) * 0.3), s);
        m4.compose(pv, q, sv);
        mesh.setMatrixAt(i, m4);
        const t = 0.92 + rnd(n.id, 4) * 0.16;
        mesh.setColorAt(i, color.setRGB(t, t, t));
      } else if (n.kind === 'berry') {
        const bushMesh = chunk.meshes[SLOT_BUSH];
        const berryMesh = chunk.meshes[SLOT_BERRY];
        const i = slotFill[SLOT_BUSH]++;
        const ratio = clamp(n.amount / BERRY_MAX);
        const s = (0.95 + rnd(n.id, 1) * 0.35) * (0.88 + 0.22 * ratio);
        q.setFromAxisAngle(up, yaw);
        pv.set(n.x, h - 0.05, n.z);
        sv.set(s, s, s);
        m4.compose(pv, q, sv);
        bushMesh.setMatrixAt(i, m4);
        berryMesh.setMatrixAt(i, m4);
        const t = 0.9 + rnd(n.id, 4) * 0.2;
        bushMesh.setColorAt(i, color.setRGB(t * (0.95 + rnd(n.id, 5) * 0.1), t, t * 0.95));
        // red bushes keep the vertex colours, a share turn deep purple
        if (rnd(n.id, 16) < 0.4) berryMesh.setColorAt(i, color.setRGB(0.55, 0.8, 2.3));
        else berryMesh.setColorAt(i, color.setRGB(1, 1, 1));
        berryMesh.geometry.attributes.aFill.array[i] = n.amount > 0.05 ? 0.1 + 0.9 * ratio : 0;
      }
    }

    const hasAny = Number.isFinite(minX);
    const cxm = hasAny ? (minX + maxX) / 2 : 0;
    const czm = hasAny ? (minZ + maxZ) / 2 : 0;
    const cym = hasAny ? (minY + maxY) / 2 + 3 : 0;
    const rad = hasAny ? Math.hypot((maxX - minX) / 2, (maxZ - minZ) / 2, (maxY - minY) / 2 + 4) + 5 : 1;
    for (let s = 0; s < SLOT_COUNT; s++) {
      const m = chunk.meshes[s];
      if (!m) continue;
      const c = slotCount[s];
      m.count = c;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      if (s === SLOT_BERRY) m.geometry.attributes.aFill.needsUpdate = true;
      if (!m.boundingSphere) m.boundingSphere = new THREE.Sphere();
      m.boundingSphere.center.set(cxm, cym, czm);
      m.boundingSphere.radius = rad;
      m.visible = c > 0;
    }
  }

  // ---- saplings: one small global InstancedMesh; scale follows (time - planted) / grow time
  let saplingMesh = null;
  let saplingCap = 0;
  const saplingGeo = saplingGeometry();
  geometries.push(saplingGeo);
  const saplings = [];
  const GROW_SECONDS = (CFG.SAPLING_GROW_DAYS ?? 2) * DAY_LENGTH;

  function refreshSaplings(time) {
    const n = saplings.length;
    if (n > saplingCap || (!saplingMesh && n > 0)) {
      if (saplingMesh) { root.remove(saplingMesh); saplingMesh.dispose(); }
      saplingCap = Math.ceil(n * 1.5) + 32;
      saplingMesh = new THREE.InstancedMesh(saplingGeo, saplingMat, saplingCap);
      saplingMesh.frustumCulled = false;
      saplingMesh.castShadow = true;
      saplingMesh.receiveShadow = true;
      saplingMesh.name = 'saplings';
      root.add(saplingMesh);
    }
    if (!saplingMesh) return;
    for (let i = 0; i < n; i++) {
      const nd = saplings[i];
      const p = clamp((time - (nd.planted || 0)) / GROW_SECONDS);
      const s = (0.2 + 0.85 * (p * (2 - p))) * (0.92 + rnd(nd.id, 1) * 0.16);   // ease-out growth
      const h = heightAt(terrain, nd.x, nd.z);
      eu.set((rnd(nd.id, 11) - 0.5) * 0.08, rnd(nd.id, 2) * Math.PI * 2, (rnd(nd.id, 12) - 0.5) * 0.08);
      q.setFromEuler(eu);
      pv.set(nd.x, h - 0.05, nd.z);
      sv.set(s, s, s);
      m4.compose(pv, q, sv);
      saplingMesh.setMatrixAt(i, m4);
      const t = 1.05 - 0.2 * p + rnd(nd.id, 4) * 0.1;   // fresher green while young
      saplingMesh.setColorAt(i, color.setRGB(t, t * 1.02, t * 0.9));
    }
    saplingMesh.count = n;
    saplingMesh.instanceMatrix.needsUpdate = true;
    if (saplingMesh.instanceColor) saplingMesh.instanceColor.needsUpdate = true;
  }

  let timer = NODE_REFRESH;
  let time = 0;
  let lastSaplingSig = -1;

  const cidx = (v) => Math.min(nc - 1, Math.max(0, Math.floor(v / NODE_CHUNK)));

  function refresh(state) {
    const nodes = state.nodes;
    sig.fill(0);
    cnt.fill(0);
    saplings.length = 0;
    for (let k = 0; k < nodes.length; k++) {
      const n = nodes[k];
      if (n.kind === 'sapling') { saplings.push(n); continue; }
      const ci = cidx(n.z) * nc + cidx(n.x);
      sig[ci] = (sig[ci] * 31 + n.id * 7 + Math.round(n.amount * 8) + (n.kind === 'tree' ? 1 : n.kind === 'rock' ? 2 : n.kind === 'ore' ? 4 : 3)) % 1000000007;
      cnt[ci]++;
    }
    let dirty = 0;
    lists.clear();
    for (let ci = 0; ci < nc * nc; ci++) {
      if (sig[ci] !== lastSig[ci] || cnt[ci] !== lastCnt[ci]) {
        if (cnt[ci] === 0 && lastCnt[ci] <= 0 && !chunks[ci]) { lastSig[ci] = sig[ci]; lastCnt[ci] = cnt[ci]; continue; }
        lists.set(ci, []);
        dirty++;
      }
    }
    if (dirty) {
      for (let k = 0; k < nodes.length; k++) {
        const n = nodes[k];
        if (n.kind === 'sapling') continue;
        const l = lists.get(cidx(n.z) * nc + cidx(n.x));
        if (l) l.push(n);
      }
      for (const [ci, list] of lists) {
        rebuildChunk(ci, list);
        lastSig[ci] = sig[ci];
        lastCnt[ci] = cnt[ci];
      }
    }
  }

  function update(state, dt = 0) {
    time += dt;
    for (const m of mats) m.userData.timeU.value = time;
    timer += dt;
    if (timer < NODE_REFRESH) return;
    timer = 0;
    refresh(state);
    refreshSaplings(state.time || 0);
    lastSaplingSig = saplings.length;
  }
  void lastSaplingSig;

  function dispose() {
    for (const c of chunks) {
      if (!c) continue;
      for (const m of c.meshes) { if (!m) continue; root.remove(m); m.dispose(); if (m.geometry.attributes.aFill) m.geometry.dispose(); }
    }
    if (saplingMesh) { root.remove(saplingMesh); saplingMesh.dispose(); }
    geometries.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
    rockMat.dispose();
    parent.remove(root);
  }

  return { update, dispose };
}

// ------------------------------------------------------------------ ground detail

const DETAIL_REFRESH = 2;
const GD_CHUNK = 40;            // scatter chunk size (metres); each chunk is generated deterministically from its index
const GD_MOVE = 6;              // rebuild the live instance set after the focus moved this far
const GD_GEN_BUDGET_MS = 6;     // chunk generation budget per update (the first update is unbudgeted)

function tuftGeometry() {
  const b = createBuilder();
  const rand = mulberry32(5);
  const blades = 6;
  const colBase = C(0x2f5e24);
  const colMid = C(0x62a038);
  const colTip = C(0xa3cf56);
  const upv = new THREE.Vector3(0, 1, 0);
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
      b.nor.push(upv.x, upv.y, upv.z);
      b.col.push(col.r, col.g, col.b);
    }
  }
  return finish(b);
}

function flowerGeometry(petal, centre) {
  const b = createBuilder();
  const upn = [0, 1, 0];
  const stem = C(0x4f8a35);
  const stemTop = C(0x6aa840);
  const push = (x, y, z, c) => { b.pos.push(x, y, z); b.nor.push(upn[0], upn[1], upn[2]); b.col.push(c.r, c.g, c.b); };
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
  const SIZE = terrain.size || WORLD_SIZE;
  const nc = Math.max(1, Math.ceil(SIZE / GD_CHUNK));
  const root = new THREE.Group();
  root.name = 'nature-ground-detail';
  parent.add(root);

  const clump = makeNoise2D(311);
  const patchN = makeNoise2D(412);

  // land test: returns terrain height or null
  const slopeAt = (x, z) => {
    const dx = heightAt(terrain, x + 1, z) - heightAt(terrain, x - 1, z);
    const dz = heightAt(terrain, x, z + 1) - heightAt(terrain, x, z - 1);
    return Math.hypot(dx, dz) * 0.5;
  };
  const lo = 3;
  const hi = SIZE - 3;
  function landAt(x, z, minH = 0.12, maxSlope = 0.75) {
    if (isWater(terrain, x, z)) return null;
    const h = heightAt(terrain, x, z);
    if (h < minH) return null;
    if (slopeAt(x, z) > maxSlope) return null;
    return h;
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

  // layers: instances within [near, far] of the focus; density fades out between them (each instance has a rank)
  const layers = [
    { name: 'grass-tufts', geo: tuftGeo, mat: tuftMat, cap: 9000, near: 35, far: 110, grass: true },
    ...flowerSpecs.map(([name], i) => ({ name, geo: flowerGeos[i], mat: flowerMat, cap: 1600, near: 25, far: 80, grass: true })),
    { name: 'pebbles', geo: pebbleGeo, mat: pebbleMat, cap: 900, near: 30, far: 90, grass: false },
  ];
  for (const L of layers) {
    L.mesh = new THREE.InstancedMesh(L.geo, L.mat, L.cap);
    L.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(L.cap * 3), 3);
    L.mesh.count = 0;
    L.mesh.frustumCulled = false;
    L.mesh.castShadow = false;
    L.mesh.receiveShadow = true;
    L.mesh.name = L.name;
    root.add(L.mesh);
  }

  // ---- deterministic per-chunk scatter ------------------------------------------------------
  const chunkData = new Map();   // index -> [ {n, mat, col, x, z, rank} per layer ]

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const eu = new THREE.Euler();
  const pv = new THREE.Vector3();
  const sv = new THREE.Vector3();
  const color = new THREE.Color();

  function newSet(max) {
    return { n: 0, mat: new Float32Array(max * 16), col: new Float32Array(max * 3), x: new Float32Array(max), z: new Float32Array(max), rank: new Float32Array(max) };
  }
  function putTo(set, rand, x, z, h, scale, yaw, tilt, c) {
    const i = set.n++;
    eu.set((rand() - 0.5) * tilt, yaw, (rand() - 0.5) * tilt);
    q.setFromEuler(eu);
    pv.set(x, h - 0.02, z);
    sv.set(scale * (0.85 + rand() * 0.3), scale, scale * (0.85 + rand() * 0.3));
    m4.compose(pv, q, sv);
    m4.toArray(set.mat, i * 16);
    set.col[i * 3] = c.r; set.col[i * 3 + 1] = c.g; set.col[i * 3 + 2] = c.b;
    set.x[i] = x; set.z[i] = z;
    set.rank[i] = rand();
  }

  const TUFTS_PER_CHUNK = 460;
  const FLOWERS_PER_CHUNK = 34;
  const PEBBLES_PER_CHUNK = 7;

  function genChunk(cx, cz) {
    const rand = mulberry32((((cx + 1) * 73856093) ^ ((cz + 1) * 19349663) ^ 90210) >>> 0);
    const x0 = Math.max(lo, cx * GD_CHUNK);
    const x1 = Math.min(hi, (cx + 1) * GD_CHUNK);
    const z0 = Math.max(lo, cz * GD_CHUNK);
    const z1 = Math.min(hi, (cz + 1) * GD_CHUNK);
    const out = layers.map((L, i) => newSet(i === 0 ? TUFTS_PER_CHUNK : i <= 3 ? FLOWERS_PER_CHUNK : PEBBLES_PER_CHUNK));
    if (x1 <= x0 || z1 <= z0) return out;
    const rx = () => x0 + rand() * (x1 - x0);
    const rz = () => z0 + rand() * (z1 - z0);

    // grass tufts: clumped, denser on fertile ground
    const tufts = out[0];
    let guard = 0;
    while (tufts.n < TUFTS_PER_CHUNK && guard++ < TUFTS_PER_CHUNK * 5) {
      const x = rx(); const z = rz();
      const h = landAt(x, z);
      if (h === null) continue;
      const f = clamp((fertilityAt(terrain, x, z) - 0.3) / 0.4);
      const cl = smooth(0.35, 0.6, clump(x * 0.11, z * 0.11)) * 0.8 + 0.2;
      const bank = smooth(0.1, 0.9, h);
      if (rand() > (0.55 + 0.45 * f) * cl * bank) continue;
      const dry = 1 - f;
      color.setRGB(
        (0.88 + dry * 0.28) * (0.9 + rand() * 0.2),
        (0.98 + f * 0.05) * (0.9 + rand() * 0.2),
        (0.62 + f * 0.3) * (0.9 + rand() * 0.2),
      );
      putTo(tufts, rand, x, z, h, 0.65 + rand() * 0.6 + f * 0.2, rand() * Math.PI * 2, 0.25, color);
    }

    // flowers: meadow patches of one colour, plus the odd stray
    const patches = [];
    guard = 0;
    while (patches.length < 2 && guard++ < 40) {
      const x = rx(); const z = rz();
      if (patchN(x * 0.05, z * 0.05) < 0.4) continue;
      if (landAt(x, z, 0.5, 0.5) === null) continue;
      patches.push({ x, z, kind: Math.floor(rand() * 3), r: 1.6 + rand() * 2.4 });
    }
    guard = 0;
    let placed = 0;
    while (placed < FLOWERS_PER_CHUNK && guard++ < FLOWERS_PER_CHUNK * 8 && patches.length) {
      let x; let z; let kind;
      if (rand() < 0.85) {
        const p = patches[Math.floor(rand() * patches.length)];
        const a = rand() * Math.PI * 2;
        const rr = Math.sqrt(rand()) * p.r;
        x = p.x + Math.cos(a) * rr;
        z = p.z + Math.sin(a) * rr;
        kind = rand() < 0.85 ? p.kind : Math.floor(rand() * 3);
      } else {
        x = rx(); z = rz();
        kind = Math.floor(rand() * 3);
      }
      if (x < lo || z < lo || x > hi || z > hi) continue;
      const h = landAt(x, z, 0.5, 0.5);
      if (h === null) continue;
      const set = out[1 + kind];
      if (set.n >= FLOWERS_PER_CHUNK) continue;
      const t = 0.92 + rand() * 0.16;
      putTo(set, rand, x, z, h, 0.8 + rand() * 0.6, rand() * Math.PI * 2, 0.3, color.setRGB(t, t, t));
      placed++;
    }

    // pebbles: mostly on and near the river banks
    const peb = out[4];
    guard = 0;
    while (peb.n < PEBBLES_PER_CHUNK && guard++ < 160) {
      const x = rx(); const z = rz();
      if (isWater(terrain, x, z)) continue;
      const h = heightAt(terrain, x, z);
      if (h < -0.4 || slopeAt(x, z) > 1.0) continue;
      const bank = h < 0.9;
      if (!bank && rand() > 0.12) continue;
      const t = 0.78 + rand() * 0.42;
      putTo(peb, rand, x, z, h, 0.7 + rand() * 1.1, rand() * Math.PI * 2, 0.4, color.setRGB(t * (rand() < 0.3 ? 1.1 : 1), t, t * (rand() < 0.3 ? 0.88 : 1)));
    }
    return out;
  }

  // ---- the live set: instances near the focus, minus anything under buildings / fields / worn paths ----
  let grass = getGraphics().grass;
  let focusX = SIZE / 2;
  let focusZ = SIZE / 2;
  let builtX = NaN;
  let builtZ = NaN;
  let timer = DETAIL_REFRESH;
  let time = 0;
  let forceRebuild = true;
  let pending = false;
  let first = true;

  const offGfx = onGraphicsChange((g) => { grass = g.grass; forceRebuild = true; });

  function wearSample(wear, x, z) {
    const g = Math.round(Math.sqrt(wear.length));
    const c = SIZE / g;
    const ix = Math.min(g - 1, Math.max(0, Math.floor(x / c)));
    const iz = Math.min(g - 1, Math.max(0, Math.floor(z / c)));
    return wear[iz * g + ix];
  }

  function rebuild(state) {
    const bl = [];
    for (const b of state.buildings || []) {
      const info = BUILDINGS[b.type];
      const r = (info ? info.radius : 4) + 0.5;
      bl.push(b.x, b.z, r * r);
    }
    const fields = [];
    for (const z of state.zones || []) if (z.kind === 'field') fields.push(z.x, z.z, z.r * z.r);
    const wear = state.wear;
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    pending = false;

    for (let li = 0; li < layers.length; li++) {
      const L = layers[li];
      const g = L.grass ? grass : 1;
      let n = 0;
      if (g > 0) {
        const mArr = L.mesh.instanceMatrix.array;
        const cArr = L.mesh.instanceColor.array;
        const cx0 = Math.max(0, Math.floor((focusX - L.far) / GD_CHUNK));
        const cx1 = Math.min(nc - 1, Math.floor((focusX + L.far) / GD_CHUNK));
        const cz0 = Math.max(0, Math.floor((focusZ - L.far) / GD_CHUNK));
        const cz1 = Math.min(nc - 1, Math.floor((focusZ + L.far) / GD_CHUNK));
        const span = L.far - L.near;
        for (let cz = cz0; cz <= cz1; cz++) {
          for (let cx = cx0; cx <= cx1; cx++) {
            // nearest point of the chunk rectangle to the focus
            const nx = Math.max(cx * GD_CHUNK, Math.min(focusX, (cx + 1) * GD_CHUNK));
            const nz = Math.max(cz * GD_CHUNK, Math.min(focusZ, (cz + 1) * GD_CHUNK));
            if ((nx - focusX) ** 2 + (nz - focusZ) ** 2 > L.far * L.far) continue;
            const key = cz * nc + cx;
            let data = chunkData.get(key);
            if (!data) {
              if (!first && typeof performance !== 'undefined' && performance.now() - t0 > GD_GEN_BUDGET_MS) { pending = true; continue; }
              data = genChunk(cx, cz);
              chunkData.set(key, data);
            }
            const set = data[li];
            for (let i = 0; i < set.n && n < L.cap; i++) {
              const u = set.rank[i] / g;
              if (u >= 1) continue;
              const x = set.x[i]; const z = set.z[i];
              const dx = x - focusX; const dz = z - focusZ;
              const d2 = dx * dx + dz * dz;
              const thr = L.far - u * span;
              if (d2 > thr * thr) continue;
              let hide = false;
              for (let k = 0; k < bl.length && !hide; k += 3) {
                const ex = x - bl[k]; const ez = z - bl[k + 1];
                if (ex * ex + ez * ez < bl[k + 2]) hide = true;
              }
              for (let k = 0; k < fields.length && !hide; k += 3) {
                const ex = x - fields[k]; const ez = z - fields[k + 1];
                if (ex * ex + ez * ez < fields[k + 2]) hide = true;
              }
              if (!hide && wear && wearSample(wear, x, z) > 0.35) hide = true;
              if (hide) continue;
              mArr.set(set.mat.subarray(i * 16, i * 16 + 16), n * 16);
              cArr[n * 3] = set.col[i * 3]; cArr[n * 3 + 1] = set.col[i * 3 + 1]; cArr[n * 3 + 2] = set.col[i * 3 + 2];
              n++;
            }
          }
        }
      }
      L.mesh.count = n;
      L.mesh.visible = n > 0;
      L.mesh.instanceMatrix.needsUpdate = true;
      L.mesh.instanceColor.needsUpdate = true;
    }
    first = false;
    builtX = focusX;
    builtZ = focusZ;
    forceRebuild = pending;
  }

  const windMats = [tuftMat, flowerMat];

  // focus: the view target ({x, z}); falls back to the last known one
  function update(state, dt = 0, focus) {
    time += dt;
    for (const m of windMats) m.userData.timeU.value = time;
    if (focus) { focusX = focus.x; focusZ = focus.z; }
    timer += dt;
    const moved = Math.hypot(focusX - builtX, focusZ - builtZ);
    if (forceRebuild || !(moved < GD_MOVE) || timer >= DETAIL_REFRESH) {
      timer = 0;
      rebuild(state);
    }
  }

  function dispose() {
    offGfx();
    for (const L of layers) { root.remove(L.mesh); L.mesh.dispose(); }
    [tuftGeo, ...flowerGeos, pebbleGeo].forEach((g) => g.dispose());
    [tuftMat, flowerMat, pebbleMat].forEach((m) => m.dispose());
    chunkData.clear();
    parent.remove(root);
  }

  return { update, dispose };
}
