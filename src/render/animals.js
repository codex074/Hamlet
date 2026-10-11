// Animals: render-only flocks inside farm pens (sheep, pigs, cows, chickens) and deer driven by state.animals.
// Everything is instanced (one InstancedMesh per body part), vertex-coloured, flat/soft shaded and animated by
// writing per-instance matrices every frame (allocation-free: only module-level scratch objects are touched).
// Node-safe: no `document` / WebGL needed at import time.
//
//   createAnimalsView(parent, terrain) -> { update(state, dt, buildingGroups), dispose() }
//     state.buildings   [{ id, type, built, upgrading }]  -> a flock for each built sheepfarm / pigsty / cattle / coop
//     buildingGroups    Map buildingId -> THREE.Group (world.js); the group's userData.pen = { x, z, r } is the
//                       local pen centre / radius; sheep wander + graze inside it (converted with matrixWorld)
//     state.animals     [{ id, kind: 'deer', x, z, tx, tz, wait }] -> smoothly interpolated deer
import * as THREE from '../../vendor/three.module.js';
import { heightAt } from '../terrain.js';
import { DEER_COUNT } from '../config.js';

export const SHEEP_PER_FARM = 6;
const MAX_FARMS = 16;
const DEER_CAP = Math.max(24, (DEER_COUNT || 24) * 2) + 8;

// ------------------------------------------------------------------ geometry building

const _m = new THREE.Matrix4();
const _nm = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _one = new THREE.Vector3(1, 1, 1);
const _Y = new THREE.Vector3(0, 1, 0);
const _AX = new THREE.Vector3(1, 0, 0);
const _AZ = new THREE.Vector3(0, 0, 1);

const hex = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

function builder() { return { p: [], n: [], c: [] }; }

// Add `geo` (any three geometry) transformed by m. smooth: normals radiate from the unit-sphere position
// (correct for ellipsoids). colorFn(y, ny) -> [r,g,b].
function addGeo(b, geo0, m, colorFn, smooth = true) {
  const g = geo0.index ? geo0.toNonIndexed() : geo0;
  const P = g.attributes.position;
  const N = g.attributes.normal;
  _nm.getNormalMatrix(m);
  for (let i = 0; i < P.count; i++) {
    _v.fromBufferAttribute(P, i);
    if (smooth) _n.copy(_v); else _n.fromBufferAttribute(N, i);
    _n.applyMatrix3(_nm).normalize();
    _v.applyMatrix4(m);
    b.p.push(_v.x, _v.y, _v.z);
    b.n.push(_n.x, _n.y, _n.z);
    const col = colorFn(_v.y, _n.y);
    b.c.push(col[0], col[1], col[2]);
  }
  if (g !== geo0) g.dispose();
}

const TRI_CACHE = {};
function ico(detail) { return TRI_CACHE[detail] || (TRI_CACHE[detail] = new THREE.IcosahedronGeometry(1, detail)); }

function ell(b, x, y, z, rx, ry, rz, color, { detail = 1, ex = 0, ey = 0, ez = 0, shade = 0.35 } = {}) {
  _q.setFromEuler(_e.set(ex, ey, ez, 'YXZ'));
  _m.compose(_v.set(x, y, z), _q, _n.set(rx, ry, rz));
  const col = hex(color);
  const y0 = y - ry;
  addGeo(b, ico(detail), _m.clone(), (wy, ny) => {
    const k = 1 - shade * (1 - Math.min(1, Math.max(0, (wy - y0) / (ry * 2 + 1e-6)))) - (ny < -0.3 ? 0.12 : 0);
    return [col[0] * k, col[1] * k, col[2] * k];
  }, true);
}

// tapered bar from a to c (arrays), radius r0 at a -> r1 at c.
function bar(b, a, c, r0, r1, color, seg = 5) {
  const dx = c[0] - a[0], dy = c[1] - a[1], dz = c[2] - a[2];
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-5) return;
  _v.set(dx / len, dy / len, dz / len);
  _q.setFromUnitVectors(_Y, _v);
  _m.compose(new THREE.Vector3((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2), _q, _one);
  const geo = new THREE.CylinderGeometry(r1, r0, len, seg, 1);
  const col = hex(color);
  addGeo(b, geo, _m.clone(), () => col, false);
  geo.dispose();
}

function finish(b) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.n, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(b.c, 3));
  geo.computeBoundingSphere();
  geo.userData.triangles = b.p.length / 9;
  return geo;
}

// ---- sheep (facing +z, origin on the ground under the body) ----

const WOOL = 0xf4eedd;
const WOOL_SH = 0xe2d8c0;
const SKIN = 0x3b312b;

function sheepBody() {
  const b = builder();
  ell(b, 0, 0.56, 0, 0.3, 0.27, 0.42, WOOL, { detail: 1 });
  const lumps = [
    [0.17, 0.66, 0.2, 0.17], [-0.17, 0.66, 0.2, 0.17], [0.19, 0.64, -0.12, 0.18], [-0.19, 0.64, -0.12, 0.18],
    [0.0, 0.76, 0.02, 0.2], [0.0, 0.7, -0.3, 0.18], [0.2, 0.5, 0.0, 0.17], [-0.2, 0.5, 0.0, 0.17],
    [0.0, 0.6, 0.34, 0.16], [0.12, 0.52, -0.28, 0.15], [-0.12, 0.52, -0.28, 0.15],
  ];
  lumps.forEach(([x, y, z, r], i) => ell(b, x, y, z, r, r * 0.92, r, i % 3 === 0 ? WOOL_SH : WOOL, { detail: 0, shade: 0.28 }));
  ell(b, 0, 0.52, -0.43, 0.06, 0.05, 0.05, WOOL_SH, { detail: 0 }); // tail tuft
  return finish(b);
}

// pivot at the neck joint; head hangs forward / down
function sheepHead() {
  const b = builder();
  ell(b, 0, -0.04, 0.13, 0.085, 0.1, 0.15, SKIN, { detail: 1, ex: 0.35, shade: 0.15 });
  ell(b, 0, -0.1, 0.25, 0.05, 0.05, 0.06, 0x2a221e, { detail: 0, shade: 0.1 });
  ell(b, 0.11, 0.02, 0.06, 0.085, 0.03, 0.045, SKIN, { detail: 0, ez: -0.4, shade: 0.1 });
  ell(b, -0.11, 0.02, 0.06, 0.085, 0.03, 0.045, SKIN, { detail: 0, ez: 0.4, shade: 0.1 });
  ell(b, 0, 0.09, 0.06, 0.09, 0.07, 0.08, WOOL, { detail: 0, shade: 0.2 }); // fringe
  ell(b, 0.03, 0.01, 0.2, 0.012, 0.012, 0.012, 0xe8e0c8, { detail: 0 });
  return finish(b);
}

// pivot at the hip, hangs down
function sheepLeg() {
  const b = builder();
  bar(b, [0, 0, 0], [0, -0.33, 0], 0.05, 0.034, SKIN, 5);
  ell(b, 0, -0.34, 0.01, 0.04, 0.025, 0.05, 0x241c18, { detail: 0, shade: 0 });
  return finish(b);
}

// ---- pig (facing +z) ----

const PIG = 0xeba7a0;
const PIG_D = 0xd88d88;

function pigBody() {
  const b = builder();
  ell(b, 0, 0.42, 0, 0.27, 0.25, 0.44, PIG, { detail: 1, shade: 0.25 });
  ell(b, 0, 0.47, -0.42, 0.04, 0.04, 0.04, PIG_D, { detail: 0 });            // curly tail
  ell(b, 0.03, 0.53, -0.45, 0.03, 0.03, 0.03, PIG_D, { detail: 0 });
  return finish(b);
}
function pigHead() {
  const b = builder();
  ell(b, 0, 0, 0.12, 0.17, 0.16, 0.17, PIG, { detail: 1, shade: 0.2 });
  ell(b, 0, -0.03, 0.29, 0.08, 0.065, 0.04, PIG_D, { detail: 0, shade: 0.1 }); // snout
  ell(b, 0.03, -0.03, 0.33, 0.012, 0.016, 0.006, 0x5a2e2a, { detail: 0 });
  ell(b, -0.03, -0.03, 0.33, 0.012, 0.016, 0.006, 0x5a2e2a, { detail: 0 });
  ell(b, 0.11, 0.13, 0.08, 0.07, 0.03, 0.06, PIG_D, { detail: 0, ez: -0.6 });  // ears
  ell(b, -0.11, 0.13, 0.08, 0.07, 0.03, 0.06, PIG_D, { detail: 0, ez: 0.6 });
  ell(b, 0.07, 0.06, 0.25, 0.015, 0.015, 0.012, 0x1e1614, { detail: 0 });
  ell(b, -0.07, 0.06, 0.25, 0.015, 0.015, 0.012, 0x1e1614, { detail: 0 });
  return finish(b);
}
function pigLeg() {
  const b = builder();
  bar(b, [0, 0, 0], [0, -0.22, 0], 0.055, 0.045, PIG, 5);
  ell(b, 0, -0.23, 0.01, 0.045, 0.025, 0.05, 0x4a3a34, { detail: 0, shade: 0 });
  return finish(b);
}

// ---- cow (facing +z) ----

const COW = 0xf2ece0;
const COW_PATCH = 0x3a2a22;

function cowBody() {
  const b = builder();
  ell(b, 0, 0.82, 0, 0.34, 0.33, 0.62, COW, { detail: 1, shade: 0.22 });
  ell(b, 0.2, 0.92, 0.15, 0.17, 0.2, 0.24, COW_PATCH, { detail: 0, shade: 0.1 });   // patches
  ell(b, -0.18, 0.8, -0.25, 0.18, 0.22, 0.22, COW_PATCH, { detail: 0, shade: 0.1 });
  ell(b, 0.05, 1.05, -0.35, 0.16, 0.08, 0.16, COW_PATCH, { detail: 0, shade: 0.1 });
  ell(b, 0, 0.5, -0.2, 0.11, 0.07, 0.1, 0xe8a8a0, { detail: 0 });                    // udder
  bar(b, [0, 0.95, -0.6], [0.02, 0.45, -0.7], 0.025, 0.02, COW, 4);                   // tail
  ell(b, 0.02, 0.43, -0.71, 0.04, 0.07, 0.04, COW_PATCH, { detail: 0 });
  return finish(b);
}
function cowHead() {
  const b = builder();
  ell(b, 0, 0, 0.16, 0.15, 0.17, 0.25, COW, { detail: 1, shade: 0.15 });
  ell(b, 0.04, 0.06, 0.12, 0.1, 0.1, 0.12, COW_PATCH, { detail: 0, shade: 0.05 });
  ell(b, 0, -0.07, 0.38, 0.11, 0.09, 0.07, 0xe0a8a0, { detail: 0, shade: 0.1 });     // muzzle
  ell(b, 0.18, 0.08, 0.06, 0.09, 0.035, 0.05, COW, { detail: 0, ez: -0.3 });         // ears
  ell(b, -0.18, 0.08, 0.06, 0.09, 0.035, 0.05, COW, { detail: 0, ez: 0.3 });
  bar(b, [0.09, 0.14, 0.06], [0.2, 0.24, 0.05], 0.025, 0.012, 0xe8dcc0, 4);          // horns
  bar(b, [-0.09, 0.14, 0.06], [-0.2, 0.24, 0.05], 0.025, 0.012, 0xe8dcc0, 4);
  ell(b, 0.1, 0.05, 0.3, 0.018, 0.018, 0.015, 0x1e1614, { detail: 0 });
  ell(b, -0.1, 0.05, 0.3, 0.018, 0.018, 0.015, 0x1e1614, { detail: 0 });
  return finish(b);
}
function cowLeg() {
  const b = builder();
  bar(b, [0, 0, 0], [0, -0.52, 0], 0.075, 0.05, COW, 5);
  ell(b, 0, -0.54, 0.01, 0.055, 0.035, 0.065, 0x2a2420, { detail: 0, shade: 0 });
  return finish(b);
}

// ---- chicken (facing +z) ----

const HEN = 0xf6f1e4;

function henBody() {
  const b = builder();
  ell(b, 0, 0.2, 0, 0.11, 0.11, 0.14, HEN, { detail: 1, shade: 0.25 });
  ell(b, 0, 0.27, -0.13, 0.06, 0.09, 0.05, HEN, { detail: 0, ex: -0.5 });            // tail
  ell(b, 0.1, 0.21, 0, 0.03, 0.07, 0.1, 0xe8e0cc, { detail: 0 });                     // wings
  ell(b, -0.1, 0.21, 0, 0.03, 0.07, 0.1, 0xe8e0cc, { detail: 0 });
  return finish(b);
}
function henHead() {
  const b = builder();
  ell(b, 0, 0.04, 0.04, 0.06, 0.07, 0.06, HEN, { detail: 1, shade: 0.15 });
  ell(b, 0, 0.12, 0.04, 0.015, 0.035, 0.04, 0xd8342a, { detail: 0 });                 // comb
  ell(b, 0, 0.01, 0.09, 0.012, 0.025, 0.015, 0xd8342a, { detail: 0 });                // wattle
  ell(b, 0, 0.04, 0.11, 0.02, 0.012, 0.03, 0xe8b030, { detail: 0 });                  // beak
  ell(b, 0.04, 0.06, 0.07, 0.008, 0.008, 0.008, 0x1e1614, { detail: 0 });
  ell(b, -0.04, 0.06, 0.07, 0.008, 0.008, 0.008, 0x1e1614, { detail: 0 });
  return finish(b);
}
function henLeg() {
  const b = builder();
  bar(b, [0, 0, 0], [0, -0.11, 0], 0.012, 0.01, 0xe0a83a, 4);
  ell(b, 0, -0.115, 0.02, 0.02, 0.006, 0.03, 0xe0a83a, { detail: 0, shade: 0 });
  return finish(b);
}

// ---- deer (facing +z) ----

const FUR = 0x8f5f33;
const FUR_D = 0x6e4626;
const BELLY = 0xd2ba92;
const TAIL = 0xf8f2e6;

function deerBody() {
  const b = builder();
  ell(b, 0, 0.8, 0.0, 0.22, 0.23, 0.5, FUR, { detail: 1, shade: 0.4 });
  ell(b, 0, 0.72, 0.0, 0.19, 0.13, 0.42, BELLY, { detail: 0, shade: 0.1 });
  ell(b, 0, 0.86, -0.3, 0.2, 0.22, 0.26, FUR, { detail: 0, shade: 0.3 }); // rump
  ell(b, 0, 0.9, 0.32, 0.19, 0.22, 0.24, FUR, { detail: 0, shade: 0.3 }); // chest
  bar(b, [0, 0.95, 0.38], [0, 1.3, 0.58], 0.13, 0.085, FUR, 6);          // neck
  ell(b, 0, 1.1, 0.5, 0.075, 0.16, 0.11, BELLY, { detail: 0, shade: 0.1, ex: 0.5 }); // throat patch
  // white tail / rump patch
  ell(b, 0, 0.93, -0.53, 0.08, 0.11, 0.06, TAIL, { detail: 0, shade: 0.1, ex: -0.4 });
  return finish(b);
}

// pivot at the top of the neck
function deerHead() {
  const b = builder();
  ell(b, 0, -0.03, 0.12, 0.085, 0.09, 0.17, FUR, { detail: 1, ex: 0.3, shade: 0.2 });
  ell(b, 0, -0.1, 0.27, 0.05, 0.05, 0.07, 0x3a2a20, { detail: 0, shade: 0.1 });
  ell(b, 0.11, 0.07, -0.01, 0.1, 0.04, 0.055, FUR_D, { detail: 0, ez: -0.7, shade: 0.1 });
  ell(b, -0.11, 0.07, -0.01, 0.1, 0.04, 0.055, FUR_D, { detail: 0, ez: 0.7, shade: 0.1 });
  return finish(b);
}

function deerLeg() {
  const b = builder();
  bar(b, [0, 0, 0], [0, -0.34, 0.01], 0.07, 0.046, FUR, 5);
  bar(b, [0, -0.34, 0.01], [0, -0.62, 0.0], 0.04, 0.028, FUR_D, 5);
  bar(b, [0, -0.6, 0.0], [0, -0.67, 0.01], 0.036, 0.032, 0x2a201a, 5);
  return finish(b);
}

function deerAntlers() {
  const b = builder();
  const BONE = 0xcdbb98;
  for (const s of [-1, 1]) {
    const P = [[0.05, 0.1, 0.02], [0.1, 0.3, 0.0], [0.17, 0.5, -0.05], [0.2, 0.72, -0.02]];
    for (let i = 0; i < 3; i++) {
      bar(b, [s * P[i][0], P[i][1], P[i][2]], [s * P[i + 1][0], P[i + 1][1], P[i + 1][2]], 0.022 - i * 0.003, 0.018 - i * 0.003, BONE, 4);
    }
    bar(b, [s * 0.1, 0.3, 0.0], [s * 0.1, 0.5, 0.12], 0.015, 0.01, BONE, 4);
    bar(b, [s * 0.17, 0.5, -0.05], [s * 0.3, 0.64, -0.02], 0.014, 0.01, BONE, 4);
    bar(b, [s * 0.2, 0.72, -0.02], [s * 0.1, 0.86, 0.04], 0.012, 0.008, BONE, 4);
    bar(b, [s * 0.2, 0.72, -0.02], [s * 0.3, 0.84, -0.04], 0.012, 0.008, BONE, 4);
  }
  return finish(b);
}

// ------------------------------------------------------------------ view

const wrapPi = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function hash01(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export function createAnimalsView(parent, terrain) {
  const root = new THREE.Group();
  root.name = 'animals';
  parent.add(root);

  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.userData.noWeather = true;   // no snow caps on the deer
  const geos = [];
  const meshes = [];
  function mk(name, geo, cap) {
    geos.push(geo);
    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.name = name;
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // allocate the colour attribute once (per-instance tint), so nothing is allocated per frame
    const c = new THREE.Color();
    for (let i = 0; i < cap; i++) mesh.setColorAt(i, c.setRGB(1, 1, 1));
    root.add(mesh);
    meshes.push(mesh);
    return mesh;
  }

  // deer parts
  const dBody = mk('deer-body', deerBody(), DEER_CAP);
  const dHead = mk('deer-head', deerHead(), DEER_CAP);
  const dLeg = mk('deer-legs', deerLeg(), DEER_CAP * 4);
  const dAnt = mk('deer-antlers', deerAntlers(), DEER_CAP);

  const tint = new THREE.Color();

  // scratch
  const bodyM = new THREE.Matrix4();
  const partM = new THREE.Matrix4();
  const outM = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const qy = new THREE.Quaternion();
  const qx = new THREE.Quaternion();
  const posL = new THREE.Vector3();

  // child matrix: bodyM * translate(x,y,z) * rotateX(pitch)  (written into outM)
  function part(x, y, z, pitch, sx = 1) {
    qx.setFromAxisAngle(_AX, pitch);
    posL.set(x, y, z);
    scl.set(sx, sx, sx);
    partM.compose(posL, qx, scl);
    outM.multiplyMatrices(bodyM, partM);
    return outM;
  }

  // ---------------------------------------------------------------- pen animals
  // One flock per built farm of `spec.type`, wandering and grazing inside its model's userData.pen. Positions
  // are local offsets from the pen centre; one block of `spec.per` animals per farm.
  let frame = 0;
  let time = 0;
  let rs = 12345;
  const rand = () => { rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0; return rs / 4294967296; };

  function createFlock(spec) {
    const per = spec.per;
    const cap = MAX_FARMS * per;
    const nLegs = spec.legs.length;
    const body = mk(`${spec.name}-body`, spec.body(), cap);
    const head = mk(`${spec.name}-head`, spec.head(), cap);
    const legs = mk(`${spec.name}-legs`, spec.leg(), cap * nLegs);
    const farmOf = new Map();               // building id -> block index
    const blockFarm = new Int32Array(MAX_FARMS).fill(-1);
    const blockSeen = new Int32Array(MAX_FARMS);
    const blockGroup = new Array(MAX_FARMS).fill(null);
    const ax = new Float32Array(cap);
    const az = new Float32Array(cap);
    const atx = new Float32Array(cap);
    const atz = new Float32Array(cap);
    const ayaw = new Float32Array(cap);
    const aspd = new Float32Array(cap);
    const atimer = new Float32Array(cap);
    const aphase = new Float32Array(cap);
    const agraze = new Float32Array(cap);   // 0..1 head-down blend
    const astate = new Uint8Array(cap);     // 0 graze, 1 walk

    function pickTarget(i, pen) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * pen.r * 0.92;
      atx[i] = Math.sin(a) * r;
      atz[i] = Math.cos(a) * r;
    }

    function allocBlock(id, pen) {
      for (let b = 0; b < MAX_FARMS; b++) {
        if (blockFarm[b] !== -1) continue;
        blockFarm[b] = id;
        farmOf.set(id, b);
        for (let k = 0; k < per; k++) {
          const i = b * per + k;
          const a = rand() * Math.PI * 2;
          const r = Math.sqrt(rand()) * pen.r * 0.85;
          ax[i] = Math.sin(a) * r; az[i] = Math.cos(a) * r;
          ayaw[i] = rand() * Math.PI * 2;
          aspd[i] = 0; aphase[i] = rand() * 6.28; agraze[i] = 0;
          astate[i] = 0; atimer[i] = rand() * 4;
          pickTarget(i, pen);
        }
        return b;
      }
      return -1;
    }

    function update(state, dt, groups) {
      let n = 0;
      for (const b of state.buildings || []) {
        if (b.type !== spec.type || !b.built || b.upgrading) continue;
        const g = groups && groups.get(b.id);
        const pen = g && g.userData && g.userData.pen;
        if (!pen) continue;
        let blk = farmOf.get(b.id);
        if (blk === undefined) {
          blk = allocBlock(b.id, pen);
          if (blk < 0) continue;
          g.updateMatrixWorld(true);
        }
        blockSeen[blk] = frame;
        blockGroup[blk] = g;
      }
      // release blocks whose farm vanished
      for (let b = 0; b < MAX_FARMS; b++) {
        if (blockFarm[b] !== -1 && blockSeen[b] !== frame) { farmOf.delete(blockFarm[b]); blockFarm[b] = -1; blockGroup[b] = null; }
      }
      const sep2 = spec.sep * spec.sep;
      for (let b = 0; b < MAX_FARMS; b++) {
        if (blockFarm[b] === -1) continue;
        const g = blockGroup[b];
        const pen = g.userData.pen;
        g.updateMatrixWorld();
        const e = g.matrixWorld.elements;
        const gyaw = Math.atan2(e[8], e[0]);
        const gs = Math.hypot(e[0], e[8]) || 1;
        const lim = pen.r * 0.95;
        for (let k = 0; k < per; k++) {
          const i = b * per + k;
          // --- behaviour: graze a while, then walk to a new spot
          let want = 0;
          if (astate[i] === 0) {
            atimer[i] -= dt;
            if (atimer[i] <= 0) { astate[i] = 1; pickTarget(i, pen); }
          } else {
            const dx = atx[i] - ax[i], dz = atz[i] - az[i];
            const d = Math.hypot(dx, dz);
            if (d < 0.2) { astate[i] = 0; atimer[i] = spec.rest[0] + rand() * spec.rest[1]; }
            else {
              const dy = wrapPi(Math.atan2(dx, dz) - ayaw[i]);
              ayaw[i] += dy * Math.min(1, dt * 4);
              want = spec.speed * (1 + 0.27 * hash01(i));
              if (Math.abs(dy) > 1.0) want *= 0.3;
            }
          }
          aspd[i] += (want - aspd[i]) * Math.min(1, dt * 4);
          ax[i] += Math.sin(ayaw[i]) * aspd[i] * dt;
          az[i] += Math.cos(ayaw[i]) * aspd[i] * dt;
          // --- soft separation from flock mates
          for (let j = b * per; j < b * per + per; j++) {
            if (j === i) continue;
            const ox = ax[i] - ax[j], oz = az[i] - az[j];
            const dd = ox * ox + oz * oz;
            if (dd < sep2 && dd > 1e-6) {
              const d = Math.sqrt(dd);
              const push = (spec.sep - d) * 0.5 * Math.min(1, dt * 6);
              ax[i] += (ox / d) * push; az[i] += (oz / d) * push;
            }
          }
          const r2 = Math.hypot(ax[i], az[i]);
          if (r2 > lim) { ax[i] *= lim / r2; az[i] *= lim / r2; }
          // --- pose
          const grazing = astate[i] === 0 ? 1 : 0;
          agraze[i] += (grazing - agraze[i]) * Math.min(1, dt * 3);
          aphase[i] += aspd[i] * dt * spec.stride;
          const lx = pen.x + ax[i], lz = pen.z + az[i];
          const wx = e[0] * lx + e[8] * lz + e[12];
          const wz = e[2] * lx + e[10] * lz + e[14];
          const wy = heightAt(terrain, wx, wz);
          const walk = clamp01(aspd[i] / spec.speed);
          const bob = Math.abs(Math.sin(aphase[i])) * spec.bob * walk;
          const sc = (spec.scale[0] + hash01(i + 3) * spec.scale[1]) * gs;
          qy.setFromAxisAngle(_Y, ayaw[i] + gyaw);
          pos.set(wx, wy + bob, wz);
          scl.set(sc, sc, sc);
          bodyM.compose(pos, qy, scl);
          body.setMatrixAt(n, bodyM);
          // head: down grazing / pecking, gently nodding while walking
          const nib = spec.peck ? Math.max(0, Math.sin(time * spec.peck + i * 1.7)) : 0.1 * Math.sin(time * 5 + i * 1.7);
          const pitch = agraze[i] * (spec.graze + nib) + (1 - agraze[i]) * (0.12 + 0.06 * Math.sin(aphase[i] * 2));
          const h = spec.headAt;
          head.setMatrixAt(n, part(h[0], h[1], h[2], pitch));
          // legs swing in diagonal pairs while walking
          const sw = Math.sin(aphase[i]) * spec.swing * walk;
          for (let L = 0; L < nLegs; L++) {
            const lg = spec.legs[L];
            legs.setMatrixAt(n * nLegs + L, part(lg[0], lg[1], lg[2], (L === 0 || L === 3) ? sw : -sw));
          }
          spec.tint(i, tint);
          body.setColorAt(n, tint);
          head.setColorAt(n, spec.headTint ? spec.headTint(i, tint) : tint);
          n++;
        }
      }
      body.count = n; head.count = n; legs.count = n * nLegs;
      body.instanceMatrix.needsUpdate = true;
      head.instanceMatrix.needsUpdate = true;
      legs.instanceMatrix.needsUpdate = true;
      body.instanceColor.needsUpdate = true;
      head.instanceColor.needsUpdate = true;
    }

    return { update };
  }

  const LEGS4 = (x, y, z) => [[x, y, z], [-x, y, z], [x, y, -z], [-x, y, -z]];
  const flocks = [
    createFlock({
      name: 'sheep', type: 'sheepfarm', per: SHEEP_PER_FARM, body: sheepBody, head: sheepHead, leg: sheepLeg,
      headAt: [0, 0.66, 0.36], legs: LEGS4(0.14, 0.4, 0.24), speed: 0.55, sep: 0.6, scale: [0.92, 0.2],
      swing: 0.55, graze: 0.95, stride: 9, bob: 0.025, rest: [2.5, 5],
      tint: (i, c) => { const t = 0.93 + hash01(i + 1) * 0.1; return c.setRGB(t, t * 0.99, t * (0.94 + hash01(i + 9) * 0.08)); },
      headTint: (i, c) => (hash01(i + 40) < 0.18 ? c.setRGB(1.3, 1.12, 1.0) : c.setRGB(1, 1, 1)),
    }),
    createFlock({
      name: 'pig', type: 'pigsty', per: 5, body: pigBody, head: pigHead, leg: pigLeg,
      headAt: [0, 0.46, 0.4], legs: LEGS4(0.14, 0.24, 0.26), speed: 0.45, sep: 0.7, scale: [0.88, 0.25],
      swing: 0.6, graze: 0.7, stride: 11, bob: 0.02, rest: [2, 4],
      tint: (i, c) => (hash01(i + 5) < 0.25 ? c.setRGB(0.62, 0.48, 0.42) : c.setRGB(1, 0.95 + hash01(i) * 0.05, 0.95)),
    }),
    createFlock({
      name: 'cow', type: 'cattle', per: 4, body: cowBody, head: cowHead, leg: cowLeg,
      headAt: [0, 0.98, 0.62], legs: LEGS4(0.2, 0.56, 0.42), speed: 0.4, sep: 1.2, scale: [0.9, 0.15],
      swing: 0.45, graze: 1.0, stride: 6, bob: 0.02, rest: [3, 6],
      tint: (i, c) => (hash01(i + 7) < 0.35 ? c.setRGB(0.72, 0.5, 0.34) : c.setRGB(1, 1, 1)),
    }),
    createFlock({
      name: 'chicken', type: 'coop', per: 8, body: henBody, head: henHead, leg: henLeg,
      headAt: [0, 0.29, 0.12], legs: [[0.05, 0.12, 0], [-0.05, 0.12, 0]], speed: 0.5, sep: 0.28, scale: [0.85, 0.3],
      swing: 0.8, graze: 0.9, peck: 9, stride: 22, bob: 0.015, rest: [1, 3],
      tint: (i, c) => (hash01(i + 11) < 0.4 ? c.setRGB(0.78, 0.5, 0.3) : c.setRGB(1, 1, 1)),
    }),
  ];

  // ---------------------------------------------------------------- deer
  const deerSlot = new Map();               // animal id -> slot
  const slotId = new Int32Array(DEER_CAP).fill(-1);
  const slotSeen = new Int32Array(DEER_CAP);
  const ddx = new Float32Array(DEER_CAP);
  const ddz = new Float32Array(DEER_CAP);
  const dyaw = new Float32Array(DEER_CAP);
  const dspd = new Float32Array(DEER_CAP);
  const dphase = new Float32Array(DEER_CAP);
  const dhead = new Float32Array(DEER_CAP);
  const dscale = new Float32Array(DEER_CAP);
  const dhasAnt = new Uint8Array(DEER_CAP);
  let deerActive = 0;
  const activeList = new Int32Array(DEER_CAP);

  function allocDeer(a) {
    for (let s = 0; s < DEER_CAP; s++) {
      if (slotId[s] !== -1) continue;
      slotId[s] = a.id;
      deerSlot.set(a.id, s);
      ddx[s] = a.x; ddz[s] = a.z;
      const h = hash01(a.id * 1.37);
      dyaw[s] = Math.atan2((a.tx ?? a.x) - a.x, (a.tz ?? a.z + 1) - a.z) || h * 6.28;
      dspd[s] = 0; dphase[s] = h * 6.28; dhead[s] = 0;
      dscale[s] = 0.92 + hash01(a.id * 3.1) * 0.2;
      dhasAnt[s] = hash01(a.id * 5.7) < 0.55 ? 1 : 0;
      return s;
    }
    return -1;
  }

  function updateDeer(state, dt) {
    const list = state.animals || [];
    deerActive = 0;
    for (let ai = 0; ai < list.length; ai++) {
      const a = list[ai];
      if (a.kind && a.kind !== 'deer') continue;
      let s = deerSlot.get(a.id);
      if (s === undefined) { s = allocDeer(a); if (s < 0) continue; }
      slotSeen[s] = frame;
      activeList[deerActive++] = s;
      // smooth towards the simulated position
      const k = Math.min(1, dt * 7);
      const ox = ddx[s], oz = ddz[s];
      const ex = a.x - ox, ez = a.z - oz;
      if (ex * ex + ez * ez > 36) { ddx[s] = a.x; ddz[s] = a.z; } // teleport (respawn) -> snap
      else { ddx[s] += ex * k; ddz[s] += ez * k; }
      const mvx = ddx[s] - ox, mvz = ddz[s] - oz;
      const dist = Math.hypot(mvx, mvz);
      const spd = dt > 1e-5 ? dist / dt : 0;
      dspd[s] += (spd - dspd[s]) * Math.min(1, dt * 6);
      if (dist > 1e-4 && dspd[s] > 0.15) {
        dyaw[s] += wrapPi(Math.atan2(mvx, mvz) - dyaw[s]) * Math.min(1, dt * 6);
      }
      dphase[s] += dspd[s] * dt * 4.2;
    }
    // free slots whose animal is gone (hunted / despawned)
    for (let s = 0; s < DEER_CAP; s++) {
      if (slotId[s] !== -1 && slotSeen[s] !== frame) { deerSlot.delete(slotId[s]); slotId[s] = -1; }
    }
    // instances
    let n = 0, na = 0;
    for (let q = 0; q < deerActive; q++) {
      const s = activeList[q];
      const x = ddx[s], z = ddz[s];
      const y = heightAt(terrain, x, z);
      const moving = clamp01((dspd[s] - 0.1) / 0.8);
      const bob = Math.abs(Math.sin(dphase[s])) * 0.035 * moving;
      const sc = dscale[s];
      qy.setFromAxisAngle(_Y, dyaw[s]);
      pos.set(x, y + bob, z);
      scl.set(sc, sc, sc);
      bodyM.compose(pos, qy, scl);
      dBody.setMatrixAt(n, bodyM);
      const tt = 0.86 + hash01(s + 77) * 0.28;
      dBody.setColorAt(n, tint.setRGB(tt, tt * (0.96 + hash01(s + 5) * 0.06), tt * 0.95));
      // head: grazing when idle, raised when running
      const idle = dspd[s] < 0.12 ? 1 : 0;
      dhead[s] += ((idle ? 0.75 : dspd[s] > 2.2 ? -0.12 : 0.08) - dhead[s]) * Math.min(1, dt * 3);
      const nod = idle ? 0.06 * Math.sin(time * 3 + s) : 0.05 * Math.sin(dphase[s] * 2);
      dHead.setMatrixAt(n, part(0, 1.3, 0.58, dhead[s] + nod));
      if (dhasAnt[s]) dAnt.setMatrixAt(na++, part(0, 1.3, 0.58, dhead[s] + nod + 0.15));
      const sw = Math.sin(dphase[s]) * 0.65 * moving;
      dLeg.setMatrixAt(n * 4, part(0.11, 0.7, 0.36, sw));
      dLeg.setMatrixAt(n * 4 + 1, part(-0.11, 0.7, 0.36, -sw));
      dLeg.setMatrixAt(n * 4 + 2, part(0.11, 0.7, -0.36, -sw));
      dLeg.setMatrixAt(n * 4 + 3, part(-0.11, 0.7, -0.36, sw));
      n++;
    }
    dBody.count = n; dHead.count = n; dLeg.count = n * 4; dAnt.count = na;
    for (const m of [dBody, dHead, dLeg, dAnt]) m.instanceMatrix.needsUpdate = true;
    dBody.instanceColor.needsUpdate = true;
  }

  function update(state, dt, buildingGroups) {
    if (!state) return;
    dt = Math.min(0.1, Math.max(0, dt || 0));
    time += dt;
    frame++;
    for (const f of flocks) f.update(state, dt, buildingGroups);
    updateDeer(state, dt);
  }

  function dispose() {
    for (const m of meshes) { root.remove(m); m.dispose(); }
    geos.forEach((g) => g.dispose());
    mat.dispose();
    parent.remove(root);
  }

  return { update, dispose };
}
