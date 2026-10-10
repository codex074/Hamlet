// Nature, atmosphere & effects demo. Serve the project root, open /dev/nature-demo.html
//   ?hour=9 (0-24)   &anim=1 (cycle the day)   &yaw= &pitch= &dist= &cx= &cz=   orbit start
//   &seed=1  &detail=0 (hide ground detail)  &bld=0 (no buildings)
// drag: orbit · shift/right-drag: pan · wheel: zoom
import * as THREE from '../vendor/three.module.js';
import { WORLD_SIZE, GRID, CELL, SPAWN } from '../src/config.js';
import { generateTerrain, generateNodes, heightAt } from '../src/terrain.js';
import { createScene } from '../src/render/scene.js';
import { createTerrainMesh } from '../src/render/terrainMesh.js';
import { createNodesView, createGroundDetail } from '../src/render/nature.js';
import { createSmoke, createFireflies } from '../src/render/effects.js';
import { makeBuildingModel, WINDOW_MATERIALS } from '../src/render/models.js';

const q = new URLSearchParams(location.search);
const canvas = document.getElementById('c');
const hud = document.getElementById('hud');

const sceneApi = createScene(canvas);
const { renderer, scene, camera } = sceneApi;

const seed = +(q.get('seed') || 1);
const terrain = generateTerrain(seed, { mapSize: 'small' });
const nodes = generateNodes(seed, terrain, { mapSize: 'small' });

// ---- fake game state: a few buildings, one field, a trodden path
const state = { nodes, buildings: [], zones: [], wear: new Float32Array(GRID * GRID) };
const cx0 = SPAWN.x; const cz0 = SPAWN.z;
const layout = [
  ['townhall', 0, 0, 0.3], ['house', -12, -6, 0.2], ['house', -14, 6, 1.5], ['house', 12, -8, -0.4], ['house', 14, 5, 2.8],
  ['house', 2, 13, 0.1], ['woodcutter', -22, 14, 0.5], ['mill', 24, 12, 0.9], ['chapel', -4, -18, 0.0], ['farmhouse', 28, -14, 0.4],
  ['tavern', 6, -14, 3.0], ['forager', -26, -8, 0.6],
];
const buildingGroups = [];
const smokeSources = [];
if (q.get('bld') !== '0') {
  for (const [type, dx, dz, rot] of layout) {
    const x = cx0 + dx; const z = cz0 + dz;
    state.buildings.push({ type, x, z, rot });
    const g = makeBuildingModel(type, { seed: state.buildings.length * 3 + 1 });
    g.position.set(x, heightAt(terrain, x, z), z);
    g.rotation.y = rot;
    scene.add(g);
    g.updateMatrixWorld(true);
    buildingGroups.push(g);
    for (const c of g.userData.chimneys || []) smokeSources.push(g.localToWorld(new THREE.Vector3(c.x, c.y, c.z)));
  }
  state.zones.push({ id: 1, kind: 'field', x: cx0 + 36, z: cz0 - 4, r: 10 });
}
// path: townhall -> east, branch -> south-west, loop around the houses
function stamp(x, z, w) {
  const ix = Math.floor(x / CELL); const iz = Math.floor(z / CELL);
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
    const cx = ix + dx; const cz = iz + dz;
    if (cx < 0 || cz < 0 || cx >= GRID || cz >= GRID) continue;
    const d = Math.hypot((cx + 0.5) * CELL - x, (cz + 0.5) * CELL - z);
    const v = w * Math.max(0, 1 - d / 3);
    state.wear[cz * GRID + cx] = Math.max(state.wear[cz * GRID + cx], v);
  }
}
for (let t = 0; t <= 1; t += 0.01) stamp(cx0 + t * 55, cz0 + 4 + Math.sin(t * 6) * 2, 0.95);
for (let t = 0; t <= 1; t += 0.01) stamp(cx0 - t * 26, cz0 + 2 + t * 18, 0.8);
for (let t = 0; t <= 1; t += 0.01) stamp(cx0 - 10 + t * 10, cz0 - 6 - t * 12, 0.6);

// ---- views
const terrainView = createTerrainMesh(terrain);
scene.add(terrainView.mesh, terrainView.water);
terrainView.updateWear(state.wear, state.zones);
const nodesView = createNodesView(scene, terrain);
const ground = q.get('detail') === '0' ? null : createGroundDetail(scene, terrain);
const smoke = createSmoke(scene);
smoke.setSources(smokeSources);
const fireflies = createFireflies(scene, { heightAt: (x, z) => heightAt(terrain, x, z) });

// ---- camera
const center = new THREE.Vector3(+(q.get('cx') || cx0), 0, +(q.get('cz') || cz0));
let yaw = +(q.get('yaw') || 0.7);
let pitch = +(q.get('pitch') || 0.5);
let dist = +(q.get('dist') || 70);
let dragging = false; let panning = false; let lx = 0; let ly = 0;
canvas.addEventListener('pointerdown', (e) => { dragging = true; panning = e.shiftKey || e.button === 2; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - lx; const dy = e.clientY - ly;
  lx = e.clientX; ly = e.clientY;
  if (panning) {
    const s = dist * 0.0016;
    center.x -= (Math.cos(yaw) * dx + Math.sin(yaw) * Math.sin(pitch) * dy) * s;
    center.z -= (-Math.sin(yaw) * dx + Math.cos(yaw) * Math.sin(pitch) * dy) * s;
  } else {
    yaw -= dx * 0.006;
    pitch = Math.min(1.5, Math.max(0.03, pitch + dy * 0.006));
  }
});
canvas.addEventListener('wheel', (e) => { e.preventDefault(); dist = Math.min(300, Math.max(3, dist * (1 + e.deltaY * 0.0012))); }, { passive: false });
addEventListener('resize', () => sceneApi.resize());
sceneApi.resize();

let hour = +(q.get('hour') || 9);
const anim = q.get('anim') === '1';
let last = performance.now();
let frames = 0; let fpsT = 0; let fps = 0;

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (anim) hour = (hour + dt * 0.8) % 24;
  const isNight = hour >= 21 || hour < 5;
  sceneApi.setTimeOfDay(hour);
  for (const m of WINDOW_MATERIALS) m.emissiveIntensity = isNight ? 1.2 : 0;

  center.y = heightAt(terrain, center.x, center.z);
  camera.position.set(
    center.x + Math.sin(yaw) * Math.cos(pitch) * dist,
    center.y + Math.sin(pitch) * dist + 0.5,
    center.z + Math.cos(yaw) * Math.cos(pitch) * dist,
  );
  camera.lookAt(center);
  sceneApi.sunFollow(center);

  nodesView.update(state, dt);
  if (ground) ground.update(state, dt);
  smoke.update(dt, isNight);
  fireflies.update(dt, isNight, center);

  renderer.render(scene, camera);

  frames++; fpsT += dt;
  if (fpsT > 0.5) { fps = frames / fpsT; frames = 0; fpsT = 0; }
  const info = renderer.info;
  hud.textContent = `hour ${hour.toFixed(1)} · ${fps.toFixed(0)} fps · ${info.render.calls} calls · ${(info.render.triangles / 1000).toFixed(0)}k tris`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// advance(seconds): fast-forward the effects clock (handy when the tab renders slowly)
function advance(sec) {
  const isNight = hour >= 21 || hour < 5;
  for (let t = 0; t < sec; t += 0.05) { smoke.update(0.05, isNight); fireflies.update(0.05, isNight, center); nodesView.update(state, 0.05); if (ground) ground.update(state, 0.05); }
}
window.__demo = { smokeSources, advance, THREE, scene, camera, renderer, state, nodesView, ground, smoke, setHour: (h) => { hour = h; }, set: (o) => { if (o.yaw != null) yaw = o.yaw; if (o.pitch != null) pitch = o.pitch; if (o.dist != null) dist = o.dist; if (o.cx != null) center.x = o.cx; if (o.cz != null) center.z = o.cz; } };
