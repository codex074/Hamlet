// Renders villagers with the hand-made characters from characters.js.
// One InstancedMesh per (role, look, part); limbs are posed per instance every frame.
import * as THREE from '../../vendor/three.module.js';
import { heightAt } from '../terrain.js';
import {
  PIVOTS, LOOKS, JOB_ROLE, CARRY_KINDS, buildCharacter, buildCarry, characterMaterial, poseAngles,
} from './characters.js';

const SCALE = 1.2;               // characters are life-size; scale up a touch for readability
const START_CAP = 16;
const PARTS = ['torso', 'head', 'armL', 'armR', 'legL', 'legR', 'item'];
const WORK_TASKS = new Set(['gather', 'produce', 'build', 'staff']);
const STRIDE = 4.6;              // walk-cycle radians per metre

function hash(id, k) {
  const x = Math.sin(id * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function roleOf(v, byId) {
  if (v.role === 'builder') return 'builder';
  if (v.jobId != null) {
    const b = byId.get(v.jobId);
    if (b && JOB_ROLE[b.type]) return JOB_ROLE[b.type];
  }
  return 'villager';
}

export function createVillagerView(parent) {
  const root = new THREE.Group();
  root.name = 'villagers';
  parent.add(root);
  const mat = characterMaterial();

  // ---- lazily-built instanced batches
  const variants = new Map();   // key -> { geos, meshes: {part: InstancedMesh}, cap, n }
  const carries = new Map();    // res -> { geo, mesh, cap, n }

  function makeMesh(geo, cap) {
    const m = new THREE.InstancedMesh(geo, mat, cap);
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = true;
    root.add(m);
    return m;
  }

  function variant(role, look) {
    const key = `${role}|${look}`;
    let v = variants.get(key);
    if (!v) {
      const geos = buildCharacter(role, look);
      v = { geos, meshes: {}, cap: START_CAP, n: 0 };
      for (const p of PARTS) if (geos[p]) v.meshes[p] = makeMesh(geos[p], v.cap);
      variants.set(key, v);
    }
    if (v.n >= v.cap) grow(v);
    return v;
  }

  function grow(v) {
    v.cap *= 2;
    for (const p of PARTS) {
      const old = v.meshes[p];
      if (!old) continue;
      const m = makeMesh(v.geos[p], v.cap);
      m.instanceMatrix.array.set(old.instanceMatrix.array);
      root.remove(old);
      old.dispose();
      v.meshes[p] = m;
    }
  }

  function carryBatch(res) {
    const key = CARRY_KINDS.includes(res) ? res : 'stone';
    let c = carries.get(key);
    if (!c) {
      const geo = buildCarry(key);
      c = { geo, mesh: makeMesh(geo, START_CAP), cap: START_CAP, n: 0 };
      carries.set(key, c);
    }
    if (c.n >= c.cap) {
      c.cap *= 2;
      const m = makeMesh(c.geo, c.cap);
      m.instanceMatrix.array.set(c.mesh.instanceMatrix.array);
      root.remove(c.mesh);
      c.mesh.dispose();
      c.mesh = m;
    }
    return c;
  }

  // ---- per-villager motion memory
  const memory = new Map(); // id -> { x, z, yaw, phase, moving }

  const base = new THREE.Matrix4();
  const local = new THREE.Matrix4();
  const out = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const ONE = new THREE.Vector3(1, 1, 1);

  function put(mesh, i, pivot, rx, rz, extraY = 0) {
    e.set(rx, 0, rz);
    q.setFromEuler(e);
    local.compose(p.set(pivot[0], pivot[1] + extraY, pivot[2]), q, ONE);
    out.multiplyMatrices(base, local);
    mesh.setMatrixAt(i, out);
  }

  function update(state, dt, time) {
    for (const v of variants.values()) v.n = 0;
    for (const c of carries.values()) c.n = 0;
    const byId = new Map();
    for (const b of state.buildings) byId.set(b.id, b);
    const seen = new Set();

    for (const v of state.villagers) {
      seen.add(v.id);
      let m = memory.get(v.id);
      if (!m) { m = { x: v.x, z: v.z, yaw: hash(v.id, 1) * Math.PI * 2, phase: hash(v.id, 2) * 6, moving: 0 }; memory.set(v.id, m); }
      const dx = v.x - m.x, dz = v.z - m.z;
      const moved = Math.hypot(dx, dz);
      m.moving = moved > 0.002 ? 1 : Math.max(0, m.moving - dt * 6);
      if (moved > 0.002) {
        const target = Math.atan2(dx, dz);
        let d = target - m.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        m.yaw += d * Math.min(1, dt * 12);
        m.phase += moved * STRIDE;
      }
      m.x = v.x; m.z = v.z;
      if (v.role === 'sleeping') continue;

      const task = v.queue && v.queue[0] ? v.queue[0].kind : null;
      const carrying = !!v.carry;
      let kind = 'idle';
      let phase = time * 1.0 + v.id;
      if (m.moving > 0.5) { kind = 'walk'; phase = m.phase; }
      else if (!carrying && WORK_TASKS.has(task) && task !== 'staff') { kind = 'work'; phase = time * 5 + v.id; }
      const a = poseAngles(kind, phase, carrying);

      const sc = SCALE * (0.92 + hash(v.id, 3) * 0.16);
      e.set(0, m.yaw, 0);
      q.setFromEuler(e);
      base.compose(p.set(v.x, heightAt(state.terrain, v.x, v.z) + a.bob, v.z), q, s.set(sc, sc, sc));

      const role = roleOf(v, byId);
      const look = Math.floor(hash(v.id, 4) * LOOKS.length);
      const vb = variant(role, look);
      const i = vb.n++;
      const M = vb.meshes;
      put(M.torso, i, [0, 0, 0], 0, 0);
      e.set(0, a.head, 0); q.setFromEuler(e);
      local.compose(p.set(...PIVOTS.neck), q, ONE);
      out.multiplyMatrices(base, local);
      M.head.setMatrixAt(i, out);
      put(M.legL, i, PIVOTS.hipL, a.legL, 0);
      put(M.legR, i, PIVOTS.hipR, a.legR, 0);
      put(M.armL, i, PIVOTS.shoulderL, a.armL, a.armLz);
      put(M.armR, i, PIVOTS.shoulderR, a.armR, a.armRz);
      if (M.item) {
        if (carrying) {
          // keep the slot but tuck the tool away (zero scale)
          out.makeScale(0, 0, 0);
          M.item.setMatrixAt(i, out);
        } else {
          // item follows the right arm: arm transform × hand offset
          e.set(a.armR, 0, a.armRz); q.setFromEuler(e);
          local.compose(p.set(...PIVOTS.shoulderR), q, ONE);
          out.multiplyMatrices(base, local);
          local.makeTranslation(...PIVOTS.hand);
          out.multiply(local);
          M.item.setMatrixAt(i, out);
        }
      }
      if (carrying) {
        const c = carryBatch(v.carry.res);
        local.makeTranslation(...PIVOTS.carry);
        out.multiplyMatrices(base, local);
        c.mesh.setMatrixAt(c.n++, out);
      }
    }

    for (const v of variants.values()) {
      for (const mesh of Object.values(v.meshes)) {
        mesh.count = v.n;
        mesh.visible = v.n > 0;
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
    for (const c of carries.values()) {
      c.mesh.count = c.n;
      c.mesh.visible = c.n > 0;
      c.mesh.instanceMatrix.needsUpdate = true;
    }
    if (memory.size > seen.size) for (const id of memory.keys()) if (!seen.has(id)) memory.delete(id);
  }

  function dispose() {
    for (const v of variants.values()) for (const m of Object.values(v.meshes)) m.dispose();
    for (const c of carries.values()) c.mesh.dispose();
    parent.remove(root);
  }

  return { update, dispose };
}

