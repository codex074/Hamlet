// Animals demo: a sheepfarm with a flock grazing in its pen, ~10 deer wandering on a terrain patch,
// iron-ore nodes next to ordinary rocks, and a golden upgrade sparkle burst every 3 s.
// Serve the project root, open /dev/animals-demo.html
//   ?hour=9  &yaw= &pitch= &dist=  (orbit start)  &deer=10  &farms=1|2   drag: orbit · shift/right-drag: pan · wheel: zoom
import * as THREE from '../vendor/three.module.js';
import { SPAWN, WORLD_SIZE, DEER_SPEED } from '../src/config.js';
import { generateTerrain, heightAt, isWater } from '../src/terrain.js';
import { createScene } from '../src/render/scene.js';
import { createTerrainMesh } from '../src/render/terrainMesh.js';
import { createNodesView } from '../src/render/nature.js';
import { createAnimalsView } from '../src/render/animals.js';
import { createSparkles } from '../src/render/effects.js';
import { makeBuildingModel, WINDOW_MATERIALS } from '../src/render/models.js';

const q = new URLSearchParams(location.search);
const canvas = document.getElementById('c');
const hud = document.getElementById('hud');

const sceneApi = createScene(canvas);
const { renderer, scene, camera } = sceneApi;
const terrain = generateTerrain(+(q.get('seed') || 1));
const terrainView = createTerrainMesh(terrain);
scene.add(terrainView.mesh, terrainView.water);

const cx0 = SPAWN.x, cz0 = SPAWN.z;

// ---- fake state
const state = { buildings: [], animals: [], nodes: [] };
const groups = new Map();
function addBuilding(id, type, x, z, rot, opts = {}) {
  state.buildings.push({ id, type, x, z, rot, built: true, upgrading: false });
  const g = makeBuildingModel(type, { seed: id * 3 + 1, ...opts });
  g.position.set(x, heightAt(terrain, x, z), z);
  g.rotation.y = rot;
  scene.add(g);
  g.updateMatrixWorld(true);
  groups.set(id, g);
  return g;
}
const farms = +(q.get('farms') || 1);
addBuilding(1, 'sheepfarm', cx0, cz0, 0.35);
if (farms > 1) addBuilding(2, 'sheepfarm', cx0 + 20, cz0 - 4, -0.7);
const houseG = addBuilding(3, 'house', cx0 - 14, cz0 + 4, 0.4, { level: 5 });
addBuilding(4, 'blacksmith', cx0 - 10, cz0 - 14, 0.2);

// ---- ore + rocks to compare
let nid = 100;
for (let i = 0; i < 5; i++) state.nodes.push({ id: nid++, kind: 'ore', x: cx0 + 14 + i * 3.4, z: cz0 + 22 + (i % 2) * 2, amount: 80 - i * 14 });
for (let i = 0; i < 4; i++) state.nodes.push({ id: nid++, kind: 'rock', x: cx0 + 14 + i * 3.6, z: cz0 + 29, amount: 60 - i * 12 });
const nodesView = createNodesView(scene, terrain);

// ---- deer
const nDeer = +(q.get('deer') || 10);
let seedRng = 7;
const rnd = () => { seedRng = (Math.imul(seedRng, 1664525) + 1013904223) >>> 0; return seedRng / 4294967296; };
function landPoint(x, z, r) {
  for (let t = 0; t < 40; t++) {
    const a = rnd() * Math.PI * 2, d = rnd() * r;
    const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
    if (px > 5 && pz > 5 && px < WORLD_SIZE - 5 && pz < WORLD_SIZE - 5 && !isWater(terrain, px, pz)) return [px, pz];
  }
  return [x, z];
}
for (let i = 0; i < nDeer; i++) {
  const [x, z] = landPoint(cx0 + 4, cz0 + 12, 18);
  state.animals.push({ id: 500 + i, kind: 'deer', x, z, tx: x, tz: z, wait: rnd() * 4, reserved: null });
}
function stepDeer(dt) {
  for (const a of state.animals) {
    if (a.wait > 0) { a.wait -= dt; if (a.wait <= 0) { const [tx, tz] = landPoint(a.x, a.z, 15); a.tx = tx; a.tz = tz; } continue; }
    const dx = a.tx - a.x, dz = a.tz - a.z, d = Math.hypot(dx, dz);
    const sp = DEER_SPEED * dt;
    if (d <= sp) { a.x = a.tx; a.z = a.tz; a.wait = 2 + rnd() * 4; } else { a.x += (dx / d) * sp; a.z += (dz / d) * sp; }
  }
}

// ---- views
const animals = createAnimalsView(scene, terrain);
const sparkles = createSparkles(scene);
let sparkT = 1;
const houseTop = new THREE.Vector3();

// ---- camera
const center = new THREE.Vector3(+(q.get('cx') || cx0 + 2), 0, +(q.get('cz') || cz0 + 6));
let yaw = +(q.get('yaw') || 0.5), pitch = +(q.get('pitch') || 0.55), dist = +(q.get('dist') || 38);
let dragging = false, panning = false, lx = 0, ly = 0;
canvas.addEventListener('pointerdown', (e) => { dragging = true; panning = e.shiftKey || e.button === 2; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - lx, dy = e.clientY - ly;
  lx = e.clientX; ly = e.clientY;
  if (panning) {
    const s = dist * 0.0016;
    center.x -= (Math.cos(yaw) * dx + Math.sin(yaw) * Math.sin(pitch) * dy) * s;
    center.z -= (-Math.sin(yaw) * dx + Math.cos(yaw) * Math.sin(pitch) * dy) * s;
  } else { yaw -= dx * 0.006; pitch = Math.min(1.5, Math.max(0.03, pitch + dy * 0.006)); }
});
canvas.addEventListener('wheel', (e) => { e.preventDefault(); dist = Math.min(200, Math.max(3, dist * (1 + e.deltaY * 0.0012))); }, { passive: false });
addEventListener('resize', () => sceneApi.resize());
sceneApi.resize();

let hour = +(q.get('hour') || 9);
let last = performance.now(), frames = 0, fpsT = 0, fps = 0;
function tick(dt) {
  stepDeer(dt);
  animals.update(state, dt, groups);
  sparkT -= dt;
  if (sparkT <= 0) {
    sparkT = 3;
    houseG.localToWorld(houseTop.set(0, 0.3, 0));
    sparkles.burst(houseTop.x, houseTop.y, houseTop.z);
  }
  sparkles.update(dt);
  nodesView.update(state, dt);
}
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const isNight = hour >= 21 || hour < 5;
  sceneApi.setTimeOfDay(hour);
  for (const m of WINDOW_MATERIALS) m.emissiveIntensity = isNight ? 1.2 : 0;
  tick(dt);
  center.y = heightAt(terrain, center.x, center.z);
  camera.position.set(
    center.x + Math.sin(yaw) * Math.cos(pitch) * dist,
    center.y + Math.sin(pitch) * dist + 0.5,
    center.z + Math.cos(yaw) * Math.cos(pitch) * dist,
  );
  camera.lookAt(center);
  sceneApi.sunFollow(center);
  renderer.render(scene, camera);
  frames++; fpsT += dt;
  if (fpsT > 0.5) { fps = frames / fpsT; frames = 0; fpsT = 0; }
  hud.textContent = `${fps.toFixed(0)} fps · ${renderer.info.render.calls} calls · ${(renderer.info.render.triangles / 1000).toFixed(0)}k tris · deer ${state.animals.length}`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// advance(seconds): fast-forward the simulation clock when the tab renders slowly
function advance(sec) { for (let t = 0; t < sec; t += 0.05) tick(0.05); }
window.__demo = {
  THREE, scene, camera, renderer, state, groups, animals, sparkles, advance,
  setHour: (h) => { hour = h; },
  set: (o) => { if (o.yaw != null) yaw = o.yaw; if (o.pitch != null) pitch = o.pitch; if (o.dist != null) dist = o.dist; if (o.cx != null) center.x = o.cx; if (o.cz != null) center.z = o.cz; },
};
