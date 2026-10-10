// Syncs the simulation state onto three.js objects: buildings, nodes, villagers, zones.
import * as THREE from '../../vendor/three.module.js';
import { BUILDINGS } from '../config.js';
import { heightAt } from '../terrain.js';
import {
  makeBuildingModel, makeSiteModel, WINDOW_MATERIALS,
} from './models.js';
import { createNodesView, createGroundDetail } from './nature.js';
import { createSmoke, createFireflies, createSparkles } from './effects.js';
import { createAnimalsView } from './animals.js';
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
  const animals = createAnimalsView(root, terrain);
  const sparkles = createSparkles(root);
  const modelGroups = new Map();   // buildingId -> finished model group (animals read userData.pen from it)
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
      else if (b.type === 'house') ghost = makeBuildingModel('house', { level: Math.min(5, (b.level || 1) + (b.built ? 1 : 0)), seed: b.id });
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

  // villager highlight: a small ring that follows the selected villager
  const vRing = new THREE.Mesh(
    new THREE.RingGeometry(0.55, 0.68, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x9fe0ff, transparent: true, opacity: 0.95, depthTest: false, side: THREE.DoubleSide }),
  );
  vRing.renderOrder = 10;
  vRing.visible = false;
  root.add(vRing);
  let highlightVillagerId = null;
  let lastState = null;

  function updateVillagerHighlight(state) {
    const v = highlightVillagerId == null ? null : state.villagers.find((x) => x.id === highlightVillagerId);
    if (!v || v.role === 'sleeping') { vRing.visible = false; return; }
    vRing.position.set(v.x, heightAt(terrain, v.x, v.z) + 0.08, v.z);
    vRing.visible = true;
  }

  // Nearest villager whose body (a vertical segment ~0.2–1.9 m above ground) passes within 1.2 m of the ray.
  const _seg0 = new THREE.Vector3();
  const _seg1 = new THREE.Vector3();
  const _onRay = new THREE.Vector3();
  const _onSeg = new THREE.Vector3();
  function pickVillager(raycaster) {
    if (!lastState) return null;
    let best = null;
    let bestT = Infinity;
    for (const v of lastState.villagers) {
      if (v.role === 'sleeping') continue;
      const y = heightAt(terrain, v.x, v.z);
      _seg0.set(v.x, y + 0.2, v.z);
      _seg1.set(v.x, y + 1.9, v.z);
      const d2 = raycaster.ray.distanceSqToSegment(_seg0, _seg1, _onRay, _onSeg);
      if (d2 > 1.2 * 1.2) continue;
      const t = _onRay.distanceTo(raycaster.ray.origin);
      if (t < bestT) { bestT = t; best = v.id; }
    }
    return best;
  }

  function setHighlightVillager(id) {
    highlightVillagerId = id == null ? null : id;
    if (highlightVillagerId == null) vRing.visible = false;
  }

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
    modelGroups.clear();
    for (const [id, { group }] of buildings) if (group.userData.model) modelGroups.set(id, group.userData.model);
    animals.update(state, dt, modelGroups);
    if (state.fx && state.fx.length) {
      for (const fx of state.fx) if (fx.kind === 'upgrade') sparkles.burst(fx.x, heightAt(terrain, fx.x, fx.z), fx.z);
      state.fx.length = 0;
    }
    sparkles.update(dt);
    updateHighlight(state);
    updateVillagerHighlight(state);
    lastState = state;
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
    animals.dispose(); sparkles.dispose();
    villagerView.dispose();
    ring.geometry.dispose(); ring.material.dispose();
    vRing.geometry.dispose(); vRing.material.dispose();
    zoneMats.residential.dispose(); zoneMats.field.dispose();
    scene.remove(root);
  }

  setNight(false);
  return { sync, pickBuilding, pickVillager, setHighlight, setHighlightVillager, setNight, dispose };
}
