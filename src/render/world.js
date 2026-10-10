// Syncs the simulation state onto three.js objects: buildings, nodes, villagers, zones.
import * as THREE from '../../vendor/three.module.js';
import { BUILDINGS, NODE_COUNTS, NODE_AMOUNT } from '../config.js';
import { heightAt } from '../terrain.js';
import {
  makeBuildingModel, makeSiteModel, NODE_MODELS, VILLAGER_MODEL, CARRY_MODEL, WINDOW_MATERIALS,
} from './models.js';

const VILLAGER_CAP = 300;
const NODE_REFRESH = 0.5; // seconds between node instance rebuilds
const NIGHT_GLOW = 1.2;

const ROLE_COLORS = {
  builder: new THREE.Color(0xe08a30),
  idle: new THREE.Color(0x9a9a9a),
  resource: new THREE.Color(0x4f9a4a),
  production: new THREE.Color(0x4a78c8),
  service: new THREE.Color(0x8a5ab8),
  worker: new THREE.Color(0x6aa0a0),
};
const RES_COLORS = {
  wood: new THREE.Color(0x8b5a2b),
  planks: new THREE.Color(0xd2a56b),
  stone: new THREE.Color(0x9a9a9a),
  berries: new THREE.Color(0xb0204a),
  wheat: new THREE.Color(0xe3c34a),
  flour: new THREE.Color(0xf5f0e0),
  bread: new THREE.Color(0xc98a3b),
};
const WHITE = new THREE.Color(0xffffff);

// Deterministic pseudo-random in [0,1) from an integer id and a salt.
function rnd(id, salt) {
  const s = Math.sin(id * 127.1 + salt * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// Flat translucent disc that hugs the terrain (rings of vertices sampled from heightAt).
function makeZoneGeometry(terrain, x, z, r) {
  const rings = Math.max(2, Math.ceil(r / 2));
  const segs = 40;
  const pos = [];
  const idx = [];
  pos.push(x, heightAt(terrain, x, z) + 0.2, z);
  for (let ri = 1; ri <= rings; ri++) {
    const rr = (ri / rings) * r;
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const px = x + Math.cos(a) * rr;
      const pz = z + Math.sin(a) * rr;
      pos.push(px, heightAt(terrain, px, pz) + 0.2, pz);
    }
  }
  for (let s = 0; s < segs; s++) idx.push(0, 1 + ((s + 1) % segs), 1 + s);
  for (let ri = 1; ri < rings; ri++) {
    const a0 = 1 + (ri - 1) * segs;
    const b0 = 1 + ri * segs;
    for (let s = 0; s < segs; s++) {
      const s2 = (s + 1) % segs;
      idx.push(a0 + s, a0 + s2, b0 + s, a0 + s2, b0 + s2, b0 + s);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  return geo;
}

function disposeGroup(group) {
  group.traverse((o) => {
    if (o.isMesh) o.geometry.dispose();
  });
  for (const m of group.userData.ghostMaterials || []) m.dispose();
}

export function createWorldView(scene, terrain) {
  const root = new THREE.Group();
  root.name = 'world';
  scene.add(root);

  const buildings = new Map();   // id -> { group, signature }
  const zoneMeshes = new Map();  // id -> { mesh, signature }
  let night = false;
  let highlightId = null;
  let clock = 0;
  let nodeTimer = NODE_REFRESH;  // refresh on first sync

  // ------------------------------------------------------------ nodes
  const nodeMeshes = {};
  for (const kind of ['tree', 'rock', 'berry']) {
    const cap = Math.ceil(NODE_COUNTS[kind] * 1.3) + 32;
    const mesh = new THREE.InstancedMesh(NODE_MODELS[kind].geometry, NODE_MODELS[kind].material, cap);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = kind !== 'tree';
    mesh.name = `nodes-${kind}`;
    root.add(mesh);
    nodeMeshes[kind] = mesh;
  }

  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3();
  const _c = new THREE.Color();
  const Y_AXIS = new THREE.Vector3(0, 1, 0);

  function refreshNodes(nodes) {
    const counts = { tree: 0, rock: 0, berry: 0 };
    for (const n of nodes) {
      const mesh = nodeMeshes[n.kind];
      if (!mesh) continue;
      const i = counts[n.kind];
      if (i >= mesh.instanceMatrix.count) continue;
      counts[n.kind]++;
      let s;
      if (n.kind === 'tree') s = 0.8 + rnd(n.id, 1) * 0.5;
      else if (n.kind === 'rock') s = (0.7 + rnd(n.id, 1) * 0.6) * (0.6 + 0.4 * Math.min(1, n.amount / NODE_AMOUNT.rock));
      else s = 0.45 + 0.75 * Math.min(1, Math.max(0, n.amount / NODE_AMOUNT.berry));
      _q.setFromAxisAngle(Y_AXIS, rnd(n.id, 2) * Math.PI * 2);
      _p.set(n.x, heightAt(terrain, n.x, n.z) - 0.05, n.z);
      _s.set(s, n.kind === 'tree' ? s * (0.9 + rnd(n.id, 3) * 0.3) : s, s);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
      if (n.kind === 'tree') {
        const v = 0.85 + rnd(n.id, 4) * 0.3;
        _c.setRGB(v * (0.95 + rnd(n.id, 5) * 0.1), v, v * (0.9 + rnd(n.id, 6) * 0.15));
        mesh.setColorAt(i, _c);
      }
    }
    for (const kind of Object.keys(nodeMeshes)) {
      const mesh = nodeMeshes[kind];
      mesh.count = counts[kind];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------ villagers
  const VILLAGER_SCALE = 1.35; // readable at the default zoom
  const villagerMesh = new THREE.InstancedMesh(VILLAGER_MODEL.geometry, VILLAGER_MODEL.material, VILLAGER_CAP);
  villagerMesh.count = 0;
  villagerMesh.frustumCulled = false;
  villagerMesh.castShadow = true;
  villagerMesh.name = 'villagers';
  villagerMesh.setColorAt(0, WHITE); // allocate instanceColor
  root.add(villagerMesh);

  const carryMesh = new THREE.InstancedMesh(CARRY_MODEL.geometry, CARRY_MODEL.material, VILLAGER_CAP);
  carryMesh.count = 0;
  carryMesh.frustumCulled = false;
  carryMesh.castShadow = true;
  carryMesh.name = 'carried';
  carryMesh.setColorAt(0, WHITE);
  root.add(carryMesh);

  const lastPos = new Map(); // villager id -> { x, z, yaw, moving }

  function syncVillagers(state, dt) {
    const byId = new Map();
    for (const b of state.buildings) byId.set(b.id, b);
    let n = 0;
    let nc = 0;
    const seen = new Set();
    for (const v of state.villagers) {
      if (n >= VILLAGER_CAP) break;
      seen.add(v.id);
      let lp = lastPos.get(v.id);
      if (!lp) { lp = { x: v.x, z: v.z, yaw: rnd(v.id, 9) * Math.PI * 2, moving: 0 }; lastPos.set(v.id, lp); }
      const dx = v.x - lp.x;
      const dz = v.z - lp.z;
      const moved = Math.hypot(dx, dz);
      if (moved > 0.002) lp.yaw = Math.atan2(dx, dz);
      lp.moving = moved > 0.002 ? 1 : 0;
      lp.x = v.x;
      lp.z = v.z;
      if (v.role === 'sleeping') continue;

      let color = ROLE_COLORS.idle;
      if (v.role === 'builder') color = ROLE_COLORS.builder;
      else if (v.role === 'worker') {
        const jb = v.jobId != null ? byId.get(v.jobId) : null;
        const cat = jb ? BUILDINGS[jb.type]?.category : null;
        color = ROLE_COLORS[cat] || ROLE_COLORS.worker;
      }

      const bob = lp.moving ? Math.abs(Math.sin(clock * 9 + v.id)) * 0.09 : 0;
      const y = heightAt(terrain, v.x, v.z) + bob;
      _q.setFromAxisAngle(Y_AXIS, lp.yaw);
      _p.set(v.x, y, v.z);
      _s.set(VILLAGER_SCALE, VILLAGER_SCALE, VILLAGER_SCALE);
      _m.compose(_p, _q, _s);
      villagerMesh.setMatrixAt(n, _m);
      villagerMesh.setColorAt(n, color);
      n++;

      if (v.carry && nc < VILLAGER_CAP) {
        _p.set(v.x, y + 1.95 * VILLAGER_SCALE, v.z);
        _m.compose(_p, _q, _s);
        carryMesh.setMatrixAt(nc, _m);
        carryMesh.setColorAt(nc, RES_COLORS[v.carry.res] || WHITE);
        nc++;
      }
    }
    if (lastPos.size > seen.size) for (const id of lastPos.keys()) if (!seen.has(id)) lastPos.delete(id);
    villagerMesh.count = n;
    carryMesh.count = nc;
    villagerMesh.instanceMatrix.needsUpdate = true;
    carryMesh.instanceMatrix.needsUpdate = true;
    if (villagerMesh.instanceColor) villagerMesh.instanceColor.needsUpdate = true;
    if (carryMesh.instanceColor) carryMesh.instanceColor.needsUpdate = true;
  }

  // ------------------------------------------------------------ buildings
  function ghostify(group) {
    const mats = [];
    group.traverse((o) => {
      if (!o.isMesh) return;
      const m = o.material.clone();
      m.transparent = true;
      m.opacity = 0.5;
      m.depthWrite = false;
      if (m.emissiveIntensity !== undefined) m.emissiveIntensity = 0;
      o.material = m;
      o.castShadow = false;
      mats.push(m);
    });
    return mats;
  }

  function buildGroup(b) {
    const info = BUILDINGS[b.type];
    const group = new THREE.Group();
    group.userData.buildingId = b.id;
    group.userData.type = b.type;
    group.userData.ghostMaterials = [];
    const isSite = !b.built || b.upgrading;

    const solid = b.built || b.type === 'cathedral';
    if (solid) {
      const model = makeBuildingModel(b.type, { level: b.level || 1, stage: b.stage || 0 });
      group.add(model);
      const sails = model.getObjectByName('sails');
      if (sails) group.userData.sails = sails;
    }
    if (isSite) {
      group.add(makeSiteModel(info ? info.radius : 4));
      let ghost;
      if (b.type === 'cathedral') ghost = makeBuildingModel('cathedral', { stage: Math.min(4, (b.stage || 0) + 1) });
      else if (b.type === 'house') ghost = makeBuildingModel('house', { level: Math.min(4, (b.level || 1) + (b.built ? 1 : 0)) });
      else ghost = makeBuildingModel(b.type);
      group.userData.ghostMaterials = ghostify(ghost);
      group.add(ghost);
      group.userData.ghost = ghost;
    }
    return group;
  }

  const signatureOf = (b) => `${b.type}|${b.built}|${b.level}|${b.stage}|${b.upgrading}`;

  function syncBuildings(state, dt) {
    const alive = new Set();
    for (const b of state.buildings) {
      alive.add(b.id);
      const sig = signatureOf(b);
      let entry = buildings.get(b.id);
      if (!entry || entry.signature !== sig) {
        if (entry) { root.remove(entry.group); disposeGroup(entry.group); }
        entry = { group: buildGroup(b), signature: sig };
        buildings.set(b.id, entry);
        root.add(entry.group);
      }
      const g = entry.group;
      g.position.set(b.x, heightAt(terrain, b.x, b.z), b.z);
      g.rotation.y = b.rot || 0;
      if (g.userData.ghost) {
        g.userData.ghost.scale.y = Math.max(0.15, b.progress || 0);
      }
      if (g.userData.sails && b.workers && b.workers.length > 0) {
        g.userData.sails.rotation.z -= dt * 1.1;
      }
    }
    for (const [id, entry] of buildings) {
      if (!alive.has(id)) {
        root.remove(entry.group);
        disposeGroup(entry.group);
        buildings.delete(id);
        if (highlightId === id) highlightId = null;
      }
    }
  }

  // ------------------------------------------------------------ zones
  const zoneMats = {
    residential: new THREE.MeshBasicMaterial({
      color: 0x4fb04a, transparent: true, opacity: 0.18, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
    field: new THREE.MeshBasicMaterial({
      color: 0xe0c030, transparent: true, opacity: 0.18, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
  };

  function syncZones(state) {
    const alive = new Set();
    for (const z of state.zones) {
      alive.add(z.id);
      const sig = `${z.kind}|${z.x}|${z.z}|${z.r}`;
      const entry = zoneMeshes.get(z.id);
      if (entry && entry.signature === sig) continue;
      if (entry) { root.remove(entry.mesh); entry.mesh.geometry.dispose(); }
      const mesh = new THREE.Mesh(makeZoneGeometry(terrain, z.x, z.z, z.r), zoneMats[z.kind] || zoneMats.residential);
      mesh.renderOrder = 2;
      mesh.name = `zone-${z.id}`;
      root.add(mesh);
      zoneMeshes.set(z.id, { mesh, signature: sig });
    }
    for (const [id, entry] of zoneMeshes) {
      if (!alive.has(id)) {
        root.remove(entry.mesh);
        entry.mesh.geometry.dispose();
        zoneMeshes.delete(id);
      }
    }
  }

  // ------------------------------------------------------------ highlight
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.93, 1, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.95, depthTest: false, side: THREE.DoubleSide }),
  );
  ring.renderOrder = 10;
  ring.visible = false;
  ring.name = 'highlight';
  root.add(ring);

  function updateHighlight(state) {
    if (highlightId == null) { ring.visible = false; return; }
    const b = state.buildings.find((x) => x.id === highlightId);
    if (!b) { ring.visible = false; return; }
    const r = (BUILDINGS[b.type]?.radius || 3) + 0.6;
    ring.scale.set(r, 1, r);
    ring.position.set(b.x, heightAt(terrain, b.x, b.z) + 0.35, b.z);
    ring.visible = true;
  }

  // ------------------------------------------------------------ public API
  function sync(state, dt = 0) {
    clock += dt;
    syncBuildings(state, dt);
    syncZones(state);

    nodeTimer += dt;
    if (nodeTimer >= NODE_REFRESH) {
      nodeTimer = 0;
      refreshNodes(state.nodes);
    }
    syncVillagers(state, dt);
    updateHighlight(state);
  }

  function pickBuilding(raycaster) {
    const groups = [];
    for (const { group } of buildings.values()) groups.push(group);
    const hits = raycaster.intersectObjects(groups, true);
    for (const h of hits) {
      let o = h.object;
      while (o && o.userData.buildingId === undefined) o = o.parent;
      if (o) return o.userData.buildingId;
    }
    return null;
  }

  function setHighlight(id) {
    highlightId = id == null ? null : id;
    if (highlightId == null) ring.visible = false;
  }

  function setNight(isNight) {
    night = !!isNight;
    for (const m of WINDOW_MATERIALS) m.emissiveIntensity = night ? NIGHT_GLOW : 0;
  }

  function dispose() {
    for (const { group } of buildings.values()) { root.remove(group); disposeGroup(group); }
    buildings.clear();
    for (const { mesh } of zoneMeshes.values()) { root.remove(mesh); mesh.geometry.dispose(); }
    zoneMeshes.clear();
    for (const mesh of Object.values(nodeMeshes)) { root.remove(mesh); mesh.dispose(); }
    root.remove(villagerMesh); villagerMesh.dispose();
    root.remove(carryMesh); carryMesh.dispose();
    ring.geometry.dispose(); ring.material.dispose();
    zoneMats.residential.dispose(); zoneMats.field.dispose();
    scene.remove(root);
  }

  setNight(false);
  return { sync, pickBuilding, setHighlight, setNight, dispose };
}
