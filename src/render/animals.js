// Animals: render-only sheep inside every built sheepfarm pen, and deer driven by state.animals.
// Everything is instanced (one InstancedMesh per body part), vertex-coloured, flat/soft shaded and animated by
// writing per-instance matrices every frame (allocation-free: only module-level scratch objects are touched).
// Node-safe: no `document` / WebGL needed at import time.
//
//   createAnimalsView(parent, terrain) -> { update(state, dt, buildingGroups), dispose() }
//     state.buildings   [{ id, type, built, upgrading }]  -> sheep for each built 'sheepfarm'
//     buildingGroups    Map buildingId -> THREE.Group (world.js); the group's userData.pen = { x, z, r } is the
//                       local pen centre / radius; sheep wander + graze inside it (converted with matrixWorld)
//     state.animals     [{ id, kind: 'deer', x, z, tx, tz, wait }] -> smoothly interpolated deer
import * as THREE from '../../vendor/three.module.js';
import { heightAt } from '../terrain.js';
import { DEER_COUNT } from '../config.js';

export const SHEEP_PER_FARM = 6;
const MAX_FARMS = 16;
const SHEEP_CAP = MAX_FARMS * SHEEP_PER_FARM;
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

  // sheep parts
  const sBody = mk('sheep-body', sheepBody(), SHEEP_CAP);
  const sHead = mk('sheep-head', sheepHead(), SHEEP_CAP);
  const sLeg = mk('sheep-legs', sheepLeg(), SHEEP_CAP * 4);
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

  // ---------------------------------------------------------------- sheep
  // Block per farm (SHEEP_PER_FARM sheep). Positions are local offsets from the pen centre.
  const farmOf = new Map();               // building id -> block index
  const blockFarm = new Int32Array(MAX_FARMS).fill(-1);
  const blockSeen = new Int32Array(MAX_FARMS);
  const blockGroup = new Array(MAX_FARMS).fill(null);
  const sx = new Float32Array(SHEEP_CAP);
  const sz = new Float32Array(SHEEP_CAP);
  const stx = new Float32Array(SHEEP_CAP);
  const stz = new Float32Array(SHEEP_CAP);
  const syaw = new Float32Array(SHEEP_CAP);
  const sspd = new Float32Array(SHEEP_CAP);
  const stimer = new Float32Array(SHEEP_CAP);
  const sphase = new Float32Array(SHEEP_CAP);
  const sgraze = new Float32Array(SHEEP_CAP);   // 0..1 head-down blend
  const sstate = new Uint8Array(SHEEP_CAP);     // 0 graze, 1 walk
  let frame = 0;
  let time = 0;
  let rs = 12345;
  const rand = () => { rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0; return rs / 4294967296; };

  function pickTarget(i, pen) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * pen.r * 0.92;
    stx[i] = Math.sin(a) * r;
    stz[i] = Math.cos(a) * r;
  }

  function allocBlock(id, pen) {
    for (let b = 0; b < MAX_FARMS; b++) {
      if (blockFarm[b] !== -1) continue;
      blockFarm[b] = id;
      farmOf.set(id, b);
      for (let k = 0; k < SHEEP_PER_FARM; k++) {
        const i = b * SHEEP_PER_FARM + k;
        const a = rand() * Math.PI * 2;
        const r = Math.sqrt(rand()) * pen.r * 0.85;
        sx[i] = Math.sin(a) * r; sz[i] = Math.cos(a) * r;
        syaw[i] = rand() * Math.PI * 2;
        sspd[i] = 0; sphase[i] = rand() * 6.28; sgraze[i] = 0;
        sstate[i] = 0; stimer[i] = rand() * 4;
        pickTarget(i, pen);
      }
      return b;
    }
    return -1;
  }

  function updateSheep(state, dt, groups) {
    let n = 0;
    const blds = state.buildings || [];
    for (let bi = 0; bi < blds.length; bi++) {
      const b = blds[bi];
      if (b.type !== 'sheepfarm' || !b.built || b.upgrading) continue;
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
    for (let b = 0; b < MAX_FARMS; b++) {
      if (blockFarm[b] === -1) continue;
      const g = blockGroup[b];
      const pen = g.userData.pen;
      g.updateMatrixWorld();
      const e = g.matrixWorld.elements;
      const gyaw = Math.atan2(e[8], e[0]);
      const gs = Math.hypot(e[0], e[8]) || 1;
      const lim = pen.r * 0.95;
      for (let k = 0; k < SHEEP_PER_FARM; k++) {
        const i = b * SHEEP_PER_FARM + k;
        // --- behaviour
        let want = 0;
        if (sstate[i] === 0) {
          stimer[i] -= dt;
          if (stimer[i] <= 0) { sstate[i] = 1; pickTarget(i, pen); }
        } else {
          const dx = stx[i] - sx[i], dz = stz[i] - sz[i];
          const d = Math.hypot(dx, dz);
          if (d < 0.2) { sstate[i] = 0; stimer[i] = 2.5 + rand() * 5; }
          else {
            const dy = wrapPi(Math.atan2(dx, dz) - syaw[i]);
            syaw[i] += dy * Math.min(1, dt * 4);
            want = 0.55 + 0.15 * hash01(i) ;
            if (Math.abs(dy) > 1.0) want *= 0.3;
          }
        }
        sspd[i] += (want - sspd[i]) * Math.min(1, dt * 4);
        sx[i] += Math.sin(syaw[i]) * sspd[i] * dt;
        sz[i] += Math.cos(syaw[i]) * sspd[i] * dt;
        // --- soft separation from flock mates
        for (let j = b * SHEEP_PER_FARM; j < b * SHEEP_PER_FARM + SHEEP_PER_FARM; j++) {
          if (j === i) continue;
          const ox = sx[i] - sx[j], oz = sz[i] - sz[j];
          const dd = ox * ox + oz * oz;
          if (dd < 0.36 && dd > 1e-6) {
            const d = Math.sqrt(dd);
            const push = (0.6 - d) * 0.5 * Math.min(1, dt * 6);
            sx[i] += (ox / d) * push; sz[i] += (oz / d) * push;
          }
        }
        const r2 = Math.hypot(sx[i], sz[i]);
        if (r2 > lim) { sx[i] *= lim / r2; sz[i] *= lim / r2; }
        // --- pose
        const grazing = sstate[i] === 0 ? 1 : 0;
        sgraze[i] += (grazing - sgraze[i]) * Math.min(1, dt * 3);
        sphase[i] += sspd[i] * dt * 9;
        const lx = pen.x + sx[i], lz = pen.z + sz[i];
        const wx = e[0] * lx + e[8] * lz + e[12];
        const wz = e[2] * lx + e[10] * lz + e[14];
        const wy = heightAt(terrain, wx, wz);
        const walk = clamp01(sspd[i] / 0.55);
        const bob = Math.abs(Math.sin(sphase[i])) * 0.025 * walk;
        const sc = (0.92 + hash01(i + 3) * 0.2) * gs;
        qy.setFromAxisAngle(_Y, syaw[i] + gyaw);
        pos.set(wx, wy + bob, wz);
        scl.set(sc, sc, sc);
        bodyM.compose(pos, qy, scl);
        sBody.setMatrixAt(n, bodyM);
        // head: down grazing (with a chewing bob), slightly nodding when walking
        const pitch = sgraze[i] * (0.95 + 0.1 * Math.sin(time * 5 + i * 1.7)) + (1 - sgraze[i]) * (0.12 + 0.06 * Math.sin(sphase[i] * 2));
        sHead.setMatrixAt(n, part(0, 0.66, 0.36, pitch));
        // legs: diagonal pairs swing while walking
        const sw = Math.sin(sphase[i]) * 0.55 * walk;
        sLeg.setMatrixAt(n * 4, part(0.14, 0.4, 0.24, sw));
        sLeg.setMatrixAt(n * 4 + 1, part(-0.14, 0.4, 0.24, -sw));
        sLeg.setMatrixAt(n * 4 + 2, part(0.14, 0.4, -0.24, -sw));
        sLeg.setMatrixAt(n * 4 + 3, part(-0.14, 0.4, -0.24, sw));
        // per-sheep tint follows the sheep (slot i), whatever instance index it lands on
        const t = 0.93 + hash01(i + 1) * 0.1;
        sBody.setColorAt(n, tint.setRGB(t, t * 0.99, t * (0.94 + hash01(i + 9) * 0.08)));
        if (hash01(i + 40) < 0.18) sHead.setColorAt(n, tint.setRGB(1.3, 1.12, 1.0)); else sHead.setColorAt(n, tint.setRGB(1, 1, 1));
        n++;
      }
    }
    sBody.count = n; sHead.count = n; sLeg.count = n * 4;
    sBody.instanceMatrix.needsUpdate = true;
    sHead.instanceMatrix.needsUpdate = true;
    sLeg.instanceMatrix.needsUpdate = true;
    sBody.instanceColor.needsUpdate = true;
    sHead.instanceColor.needsUpdate = true;
  }

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
    updateSheep(state, dt, buildingGroups);
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
