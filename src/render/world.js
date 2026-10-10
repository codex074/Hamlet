// Syncs the simulation state onto three.js objects: buildings, nodes, villagers, zones.
import * as THREE from '../../vendor/three.module.js';
import { BUILDINGS } from '../config.js';
import { heightAt } from '../terrain.js';
import {
  makeBuildingModel, makeSiteModel, WINDOW_MATERIALS,
} from './models.js';
import { createNodesView, createGroundDetail } from './nature.js';
import { createSmoke, createFireflies } from './effects.js';
import { createVillagerView } from './villagerView.js';

const NIGHT_GLOW = 1.2;


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

  // ------------------------------------------------------------ nature & effects
  const nodesView = createNodesView(root, terrain);
  const groundDetail = createGroundDetail(root, terrain);
  const smoke = createSmoke(root);
  const fireflies = createFireflies(root, { heightAt: (x, z) => heightAt(terrain, x, z) });
  let smokeDirty = true;
  const _v = new THREE.Vector3();
  const fireflyFocus = new THREE.Vector3();

  // Chimney tops of finished buildings, in world space.
  function refreshSmoke() {
    const sources = [];
    for (const { group } of buildings.values()) {
      const model = group.userData.model;
      const chimneys = model && model.userData.chimneys;
      if (!chimneys || group.userData.ghost) continue;
      group.updateMatrixWorld(true);
      for (const c of chimneys) sources.push(model.localToWorld(_v.set(c.x, c.y, c.z)).clone());
    }
    smoke.setSources(sources);
    smokeDirty = false;
  }

  // ------------------------------------------------------------ villagers
  const villagerView = createVillagerView(root);

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
      const model = makeBuildingModel(b.type, { level: b.level || 1, stage: b.stage || 0, seed: b.id });
      group.add(model);
      group.userData.model = model;
      const sails = model.getObjectByName('sails') || model.getObjectByName('sawblade');
      if (sails) group.userData.sails = sails;
    }
    if (isSite) {
      group.add(makeSiteModel(info ? info.radius : 4, b.id));
      let ghost;
      if (b.type === 'cathedral') ghost = makeBuildingModel('cathedral', { stage: Math.min(4, (b.stage || 0) + 1), seed: b.id });
      else if (b.type === 'house') ghost = makeBuildingModel('house', { level: Math.min(4, (b.level || 1) + (b.built ? 1 : 0)), seed: b.id });
      else ghost = makeBuildingModel(b.type, { seed: b.id });
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
        smokeDirty = true;
      }
      const g = entry.group;
      g.position.set(b.x, heightAt(terrain, b.x, b.z), b.z);
      g.rotation.y = b.rot || 0;
      if (g.userData.ghost) {
        g.userData.ghost.scale.y = Math.max(0.15, b.progress || 0);
      }
      if (g.userData.sails && b.workers && b.workers.length > 0) {
        g.userData.sails.rotation.z -= dt * (b.type === 'sawmill' ? 6 : 1.1);
      }
    }
    for (const [id, entry] of buildings) {
      if (!alive.has(id)) {
        root.remove(entry.group);
        disposeGroup(entry.group);
        buildings.delete(id);
        smokeDirty = true;
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

    nodesView.update(state, dt);
    groundDetail.update(state, dt);
    if (smokeDirty) refreshSmoke();
    smoke.update(dt, night);
    const th = state.buildings.find((b) => b.type === 'townhall');
    if (th) fireflyFocus.set(th.x, heightAt(terrain, th.x, th.z), th.z);
    fireflies.update(dt, night, fireflyFocus);
    villagerView.update(state, dt, clock);
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
    nodesView.dispose(); groundDetail.dispose(); smoke.dispose(); fireflies.dispose();
    villagerView.dispose();
    ring.geometry.dispose(); ring.material.dispose();
    zoneMats.residential.dispose(); zoneMats.field.dispose();
    scene.remove(root);
  }

  setNight(false);
  return { sync, pickBuilding, setHighlight, setNight, dispose };
}
