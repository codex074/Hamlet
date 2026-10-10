// Syncs the simulation state onto three.js objects: buildings, nodes, villagers, zones.
import * as THREE from '../../vendor/three.module.js';
import * as CFG from '../config.js';
import { BUILDINGS } from '../config.js';
import { heightAt } from '../terrain.js';
import {
  makeBuildingModel, makeSiteModel, WINDOW_MATERIALS,
} from './models.js';
import { createNodesView, createGroundDetail } from './nature.js';
import { createSmoke, createFireflies, createSparkles } from './effects.js';
import { createAnimalsView } from './animals.js';
import { createVillagerView } from './villagerView.js';
import { getGraphics, onGraphicsChange } from './graphics.js';

const NIGHT_GLOW = 1.2;
const _lab = new THREE.Vector3();


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


// ------------------------------------------------------------------ territory helpers

const FRONTIER_COLOR = 0xffe9a8;
const GRID_COLOR = 0xfff4d6;

// Ground-hugging grid mesh over a rectangle (step metres between vertices, lifted a little off the terrain).
function makePlotGeometry(terrain, x0, z0, x1, z1, step = 2, lift = 0.25) {
  const nx = Math.max(1, Math.round((x1 - x0) / step));
  const nz = Math.max(1, Math.round((z1 - z0) / step));
  const pos = new Float32Array((nx + 1) * (nz + 1) * 3);
  let k = 0;
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = x0 + ((x1 - x0) * i) / nx;
      const z = z0 + ((z1 - z0) * j) / nz;
      pos[k++] = x; pos[k++] = heightAt(terrain, x, z) + lift; pos[k++] = z;
    }
  }
  const idx = [];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      idx.push(a, a + nx + 1, a + 1, a + 1, a + nx + 1, a + nx + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

// Thin ribbon strips following the terrain along axis-aligned segments [[x0,z0,x1,z1], ...].
function makeRibbonGeometry(terrain, segs, width, lift = 0.22) {
  const pos = [];
  const idx = [];
  for (const [ax, az, bx, bz] of segs) {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(len / 2));
    const dx = (bx - ax) / len;
    const dz = (bz - az) / len;
    const nxv = -dz * width / 2;
    const nzv = dx * width / 2;
    const base = pos.length / 3;
    for (let i = 0; i <= n; i++) {
      const x = ax + ((bx - ax) * i) / n;
      const z = az + ((bz - az) * i) / n;
      const x1 = x + nxv; const z1 = z + nzv;
      const x2 = x - nxv; const z2 = z - nzv;
      pos.push(x1, heightAt(terrain, x1, z1) + lift, z1, x2, heightAt(terrain, x2, z2) + lift, z2);
    }
    for (let i = 0; i < n; i++) {
      const a = base + i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

const POLY_OFFSET = { polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 };

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

  const view = scene.userData.view || null;   // { camera, target, canvas, renderer } published by createScene()
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


  // ------------------------------------------------------------ territory (spec §3)
  // Unowned land is dimmed by the terrain mesh itself (it exposes userData.setTerritory); here we draw the
  // frontier line, the plot grid and the buyable-plot highlights + price labels.
  let terrainObj = null;
  let territorySig = '';
  let plotCount = 1;
  let plotSize = CFG.PLOT_SIZE || 80;
  const worldSize = terrain.size || CFG.WORLD_SIZE;

  const frontierMat = new THREE.MeshBasicMaterial({
    color: FRONTIER_COLOR, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, ...POLY_OFFSET,
  });
  const gridMat = new THREE.MeshBasicMaterial({
    color: GRID_COLOR, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide, ...POLY_OFFSET,
  });
  let frontierMesh = null;
  let gridMesh = null;
  let ownedCache = null;

  const buyMat = new THREE.MeshBasicMaterial({ color: 0x55e08e, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide, ...POLY_OFFSET });
  const brokeMat = new THREE.MeshBasicMaterial({ color: 0xe2a07c, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide, ...POLY_OFFSET });
  const hoverMat = new THREE.MeshBasicMaterial({ color: 0xfff0b0, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide, ...POLY_OFFSET });
  let territoryOn = false;
  let plotsSource = null;        // array of plotInfo entries, or fn(state) -> array
  let plotList = [];
  let plotListSig = '';
  const plotMeshes = new Map();  // "px,pz" -> Mesh (shared geometry per plot, material by affordability)
  let hoverKey = null;
  let hoverMesh = null;
  let outlineMesh = null;        // gold outline around every buyable plot
  const outlineMat = new THREE.MeshBasicMaterial({ color: 0xffd95a, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide, ...POLY_OFFSET });
  let labelRoot = null;
  const labels = new Map();      // "px,pz" -> { el, plot }
  let pulse = 0;

  function replaceMesh(old, geo, mat, order) {
    if (old) { root.remove(old); old.geometry.dispose(); }
    if (!geo) return null;
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = order;
    m.frustumCulled = true;
    root.add(m);
    return m;
  }

  // Edges between plots as [x0,z0,x1,z1]; frontier = owned|unowned boundary, grid = every other internal edge.
  function rebuildBorders() {
    const owned = ownedCache;
    const frontier = [];
    const grid = [];
    if (owned && plotCount > 1) {
      const P = plotCount;
      const at = (px, pz) => owned[pz * P + px];
      for (let pz = 0; pz < P; pz++) {
        for (let px = 0; px < P; px++) {
          if (px + 1 < P) {
            const seg = [(px + 1) * plotSize, pz * plotSize, (px + 1) * plotSize, (pz + 1) * plotSize];
            (!!at(px, pz) !== !!at(px + 1, pz) ? frontier : grid).push(seg);
          }
          if (pz + 1 < P) {
            const seg = [px * plotSize, (pz + 1) * plotSize, (px + 1) * plotSize, (pz + 1) * plotSize];
            (!!at(px, pz) !== !!at(px, pz + 1) ? frontier : grid).push(seg);
          }
        }
      }
    }
    frontierMesh = replaceMesh(frontierMesh, frontier.length ? makeRibbonGeometry(terrain, frontier, 0.7) : null, frontierMat, 3);
    gridMesh = replaceMesh(gridMesh, grid.length ? makeRibbonGeometry(terrain, grid, 0.4) : null, gridMat, 3);
    if (gridMesh) gridMesh.visible = territoryOn;
  }

  function syncTerritory(state) {
    if (!terrainObj) terrainObj = scene.getObjectByName('terrain') || null;
    const t = state.territory;
    if (terrainObj && terrainObj.userData.setTerritory) terrainObj.userData.setTerritory(t);   // dedups internally
    const owned = t && t.owned && t.owned.length ? t.owned : null;
    let sig = '';
    if (owned) { sig = owned.length + ':'; for (let i = 0; i < owned.length; i++) sig += owned[i] ? '1' : '0'; }
    if (sig === territorySig) return;
    territorySig = sig;
    ownedCache = owned;
    plotCount = owned ? Math.max(1, Math.round(Math.sqrt(owned.length))) : 1;
    plotSize = worldSize / plotCount;
    rebuildBorders();
  }

  function plotKey(p) { return p.px + ',' + p.pz; }

  function rebuildPlotMeshes() {
    for (const m of plotMeshes.values()) { root.remove(m); m.geometry.dispose(); }
    plotMeshes.clear();
    hoverMesh = null;
    const outline = [];
    for (const p of plotList) {
      if (!p.buyable) continue;
      const m = new THREE.Mesh(makePlotGeometry(terrain, p.x0, p.z0, p.x1, p.z1), buyMat);
      m.renderOrder = 2;
      m.name = 'plot-' + plotKey(p);
      root.add(m);
      plotMeshes.set(plotKey(p), m);
      outline.push([p.x0, p.z0, p.x1, p.z0], [p.x1, p.z0, p.x1, p.z1], [p.x1, p.z1, p.x0, p.z1], [p.x0, p.z1, p.x0, p.z0]);
    }
    outlineMesh = replaceMesh(outlineMesh, outline.length ? makeRibbonGeometry(terrain, outline, 1.1, 0.3) : null, outlineMat, 4);
  }

  function ensureLabelRoot() {
    if (labelRoot || typeof document === 'undefined') return;
    labelRoot = document.createElement('div');
    labelRoot.className = 'plot-labels';
    labelRoot.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;overflow:hidden;z-index:6;';
    const host = (view && view.canvas && view.canvas.parentElement) || document.body;
    host.appendChild(labelRoot);
  }

  function rebuildLabels() {
    if (typeof document === 'undefined') return;
    ensureLabelRoot();
    for (const l of labels.values()) l.el.remove();
    labels.clear();
    for (const p of plotList) {
      if (!p.buyable) continue;
      const el = document.createElement('div');
      el.className = 'plot-label';
      el.style.cssText = 'position:absolute;left:0;top:0;white-space:nowrap;padding:3px 9px;border-radius:12px;' +
        'font:600 13px/1.2 system-ui,sans-serif;background:rgba(40,30,18,0.85);border:1px solid #c9a24a;' +
        'color:#ffd77a;box-shadow:0 1px 4px rgba(0,0,0,0.45);will-change:transform;display:none;';
      el.textContent = '🪙 ' + p.price;
      labelRoot.appendChild(el);
      labels.set(plotKey(p), { el, plot: p, text: el.textContent, afford: true });
    }
  }

  function clearTerritoryView() {
    for (const m of plotMeshes.values()) { root.remove(m); m.geometry.dispose(); }
    plotMeshes.clear();
    hoverMesh = null;
    outlineMesh = replaceMesh(outlineMesh, null, outlineMat, 4);
    for (const l of labels.values()) l.el.remove();
    labels.clear();
    if (labelRoot) { labelRoot.remove(); labelRoot = null; }
    plotListSig = '';
    if (gridMesh) gridMesh.visible = false;
  }

  function resolvePlots(state) {
    const src = typeof plotsSource === 'function' ? plotsSource(state) : plotsSource;
    return Array.isArray(src) ? src : [];
  }

  function updateTerritoryView(state, dt) {
    if (!territoryOn) return;
    const list = resolvePlots(state);
    let sig = list.length + ':';
    for (const p of list) if (p.buyable) sig += p.px + ',' + p.pz + ',' + p.price + ';';
    if (sig !== plotListSig) {
      plotListSig = sig;
      plotList = list;
      rebuildPlotMeshes();
      rebuildLabels();
    }
    pulse += dt;
    const pul = 0.5 + 0.5 * Math.sin(pulse * 2.6);
    buyMat.opacity = 0.3 + 0.22 * pul;
    brokeMat.opacity = 0.2 + 0.12 * pul;
    const gold = typeof state.gold === 'number' ? state.gold : Infinity;
    for (const [key, m] of plotMeshes) {
      const l = labels.get(key);
      const afford = !l || l.plot.price <= gold;
      m.material = key === hoverKey ? hoverMat : afford ? buyMat : brokeMat;
    }
    // price labels follow their plot centre on screen
    if (view && labels.size) {
      const cam = view.camera;
      cam.updateMatrixWorld();
      const w = view.canvas.clientWidth || window.innerWidth;
      const h = view.canvas.clientHeight || window.innerHeight;
      for (const l of labels.values()) {
        const p = l.plot;
        const cx = (p.x0 + p.x1) / 2;
        const cz = (p.z0 + p.z1) / 2;
        _lab.set(cx, heightAt(terrain, cx, cz) + 3, cz).project(cam);
        const visible = _lab.z < 1 && Math.abs(_lab.x) < 1.15 && Math.abs(_lab.y) < 1.15;
        if (!visible) { l.el.style.display = 'none'; continue; }
        const afford = p.price <= gold;
        if (afford !== l.afford) { l.afford = afford; l.el.style.color = afford ? '#ffd77a' : '#ff9d8a'; l.el.style.borderColor = afford ? '#c9a24a' : '#b0675a'; }
        l.el.style.display = '';
        l.el.style.transform = `translate(${Math.round((_lab.x * 0.5 + 0.5) * w)}px, ${Math.round((-_lab.y * 0.5 + 0.5) * h)}px) translate(-50%, -50%)`;
      }
    }
  }

  // setTerritoryView(on, plots): plots = plotInfo(state) array, or a function (state) => array that is re-evaluated
  // every frame (cheap diffing) so the highlights/prices follow gold & purchases without re-calling this.
  function setTerritoryView(on, plots) {
    const was = territoryOn;
    territoryOn = !!on;
    if (plots !== undefined) plotsSource = plots;
    if (!territoryOn) { if (was) clearTerritoryView(); return; }
    plotListSig = '';   // force a rebuild on the next sync
    if (gridMesh) gridMesh.visible = true;
    if (lastState) updateTerritoryView(lastState, 0);
  }

  // Highlight one buyable plot more strongly (e.g. under the mouse); pass null to clear.
  function setPlotHover(px, pz) {
    hoverKey = px == null ? null : px + ',' + pz;
  }

  // Which plot a world position lies in -> { px, pz } (clamped).
  function plotAt(x, z) {
    return {
      px: Math.min(plotCount - 1, Math.max(0, Math.floor(x / plotSize))),
      pz: Math.min(plotCount - 1, Math.max(0, Math.floor(z / plotSize))),
    };
  }

  // ------------------------------------------------------------ FPS counter (graphics.showFps)
  let fpsEl = null;
  let fpsFrames = 0;
  let fpsT0 = typeof performance !== 'undefined' ? performance.now() : 0;
  let fpsPlaced = 0;

  function applyFpsSetting(g) {
    if (typeof document === 'undefined') return;
    if (g.showFps && !fpsEl) {
      fpsEl = document.createElement('div');
      fpsEl.className = 'fps-counter';
      fpsEl.style.cssText = 'position:fixed;left:8px;top:48px;z-index:7;pointer-events:none;padding:2px 8px;border-radius:6px;' +
        'font:600 12px/1.4 ui-monospace,Menlo,monospace;color:#d8f5c0;background:rgba(20,16,10,0.62);font-variant-numeric:tabular-nums;';
      fpsEl.textContent = 'FPS …';
      document.body.appendChild(fpsEl);
      fpsFrames = 0;
      fpsT0 = performance.now();
      fpsPlaced = -1e9;
    } else if (!g.showFps && fpsEl) {
      fpsEl.remove();
      fpsEl = null;
    }
  }
  applyFpsSetting(getGraphics());
  const offGfx = onGraphicsChange(applyFpsSetting);

  function tickFps() {
    if (!fpsEl) return;
    fpsFrames++;
    const now = performance.now();
    if (now - fpsT0 < 500) return;
    const fps = (fpsFrames * 1000) / (now - fpsT0);
    fpsFrames = 0;
    fpsT0 = now;
    const info = view && view.renderer ? view.renderer.info.render : null;
    fpsEl.textContent = `${fps.toFixed(0)} FPS` + (info ? ` · ${info.calls} calls · ${(info.triangles / 1000).toFixed(0)}k tris` : '');
    fpsEl.style.color = fps >= 50 ? '#d8f5c0' : fps >= 30 ? '#ffe9a0' : '#ffb0a0';
    // sit just under the top bar, wherever it wraps to
    if (now - fpsPlaced > 1500) {
      fpsPlaced = now;
      const tb = document.getElementById('topbar');
      if (tb) {
        const r = tb.getBoundingClientRect();
        fpsEl.style.top = Math.max(8, Math.round(r.bottom + 6)) + 'px';
      }
    }
  }

  // ------------------------------------------------------------ public API
  function sync(state, dt = 0) {
    clock += dt;
    syncBuildings(state, dt);
    syncZones(state);

    nodesView.update(state, dt);
    groundDetail.update(state, dt, view && view.targetSet ? view.target : undefined);
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
    syncTerritory(state);
    updateTerritoryView(state, dt);
    tickFps();
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
    clearTerritoryView();
    for (const m of [frontierMesh, gridMesh]) if (m) { root.remove(m); m.geometry.dispose(); }
    [frontierMat, gridMat, buyMat, brokeMat, hoverMat, outlineMat].forEach((m) => m.dispose());
    offGfx();
    if (fpsEl) { fpsEl.remove(); fpsEl = null; }
    scene.remove(root);
  }

  setNight(false);
  return {
    sync, pickBuilding, pickVillager, setHighlight, setHighlightVillager, setNight, dispose,
    setTerritoryView, setPlotHover, plotAt,
  };
}
