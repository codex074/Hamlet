// Visual test page for the render layer. Serve from project root:
//   python3 -m http.server 8080  ->  http://localhost:8080/dev/render-demo.html
import * as THREE from '../vendor/three.module.js';
import { SPAWN, GRID, WORLD_SIZE } from '../src/config.js';
import { generateTerrain, generateNodes, heightAt } from '../src/terrain.js';
import { createWear, addWear } from '../src/wear.js';
import { createScene } from '../src/render/scene.js';
import { createCameraController } from '../src/render/camera.js';
import { createTerrainMesh } from '../src/render/terrainMesh.js';
import { createWorldView } from '../src/render/world.js';

const SEED = 1;
const terrain = generateTerrain(SEED);
const nodes = generateNodes(SEED, terrain);

// ---- fake state
let nextId = 1;
const buildings = [];
function addBuilding(type, x, z, rot, extra = {}) {
  const b = {
    id: nextId++, type, x, z, rot, built: true, progress: 1, needed: {}, incoming: {},
    desiredWorkers: 0, workers: [], ...extra,
  };
  buildings.push(b);
  return b;
}

addBuilding('townhall', SPAWN.x, SPAWN.z, 0);

const ringTypes = [
  ['storehouse'], ['woodcutter'], ['forager'], ['quarry'], ['sawmill'], ['farmhouse'], ['mill'],
  ['bakery'], ['chapel'], ['tavern'],
  ['house', { level: 1 }], ['house', { level: 2 }], ['house', { level: 3 }], ['house', { level: 4 }],
  ['storehouse', { built: false, progress: 0.4 }],
];
const RING_R = 38;
ringTypes.forEach(([type, extra], i) => {
  const a = (i / ringTypes.length) * Math.PI * 2;
  const x = SPAWN.x + Math.cos(a) * RING_R;
  const z = SPAWN.z + Math.sin(a) * RING_R;
  const rot = Math.atan2(SPAWN.x - x, SPAWN.z - z);
  const b = addBuilding(type, x, z, rot, extra);
  if (type === 'mill') b.workers = [1];
  if (type === 'house') { b.upgrading = false; }
});
addBuilding('cathedral', SPAWN.x + 70, SPAWN.z + 5, -Math.PI / 2, { stage: 4 });
addBuilding('cathedral', SPAWN.x - 75, SPAWN.z + 10, Math.PI / 2, { stage: 2, built: false, progress: 0.5 });
addBuilding('house', SPAWN.x + 12, SPAWN.z + 14, 0.3, { level: 2, upgrading: true, progress: 0.5 });

const zones = [
  { id: nextId++, kind: 'residential', x: SPAWN.x - 40, z: SPAWN.z + 60, r: 10 },
  { id: nextId++, kind: 'field', x: SPAWN.x + 45, z: SPAWN.z + 62, r: 13 },
];

const villagers = [];
for (let i = 0; i < 20; i++) {
  const roles = ['worker', 'builder', 'idle', 'worker', 'sleeping'];
  villagers.push({
    id: nextId++, x: SPAWN.x, z: SPAWN.z, homeId: null,
    jobId: buildings[1 + (i % 10)].id, hunger: 0,
    carry: i % 3 === 0 ? { res: ['wood', 'planks', 'stone', 'berries', 'wheat', 'flour', 'bread'][i % 7], n: 2 } : null,
    queue: [], res: {}, role: i === 19 ? 'sleeping' : roles[i % 4],
    _r: 8 + (i % 7) * 4, _a: (i / 20) * Math.PI * 2, _w: (i % 2 ? 1 : -1) * (0.15 + (i % 5) * 0.03),
  });
}

const wear = createWear();
function paintLine(x1, z1, x2, z2) {
  const n = Math.ceil(Math.hypot(x2 - x1, z2 - z1) / 1.0);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    for (let k = 0; k < 14; k++) addWear(wear, x1 + (x2 - x1) * t, z1 + (z2 - z1) * t, 0.06);
  }
}
for (const b of buildings.slice(1, 12)) paintLine(SPAWN.x, SPAWN.z, b.x, b.z);
paintLine(SPAWN.x - 60, SPAWN.z - 20, SPAWN.x + 60, SPAWN.z - 20);

const state = {
  version: 1, seed: SEED, tick: 0, time: 0, lastDay: 0, gold: 0, nextId,
  terrain, nodes, buildings, zones, villagers, wear, events: [],
};

// ---- render setup
const canvas = document.getElementById('c');
const S = createScene(canvas);
const controls = createCameraController(S.camera, canvas, (x, z) => heightAt(terrain, x, z));
controls.setPanWithLeftMouse(true);
const terrainView = createTerrainMesh(terrain);
S.scene.add(terrainView.mesh, terrainView.water);
const world = createWorldView(S.scene, terrain);

window.addEventListener('resize', () => S.resize());
S.resize();
terrainView.updateWear(wear, zones);

// click a building to highlight it
const ray = new THREE.Raycaster();
canvas.addEventListener('click', (e) => {
  if (controls.wasDragged()) return;
  const ndc = new THREE.Vector2((e.clientX / canvas.clientWidth) * 2 - 1, -(e.clientY / canvas.clientHeight) * 2 + 1);
  ray.setFromCamera(ndc, S.camera);
  world.setHighlight(world.pickBuilding(ray));
});

const params = new URLSearchParams(location.search);
let hour = Number(params.get('hour') ?? 8);
const timeSpeed = Number(params.get('speed') ?? 0.4); // game hours per real second
window.demo = { controls, S, state, world, SPAWN }; // for poking from the console
let last = performance.now();
let wearTimer = 0;
let wasNight = null;

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  hour = (hour + dt * timeSpeed) % 24; // default: full day in 60 s
  S.setTimeOfDay(hour);
  const isNight = hour >= 21 || hour < 5;
  if (isNight !== wasNight) { world.setNight(isNight); wasNight = isNight; }

  for (const v of villagers) {
    v._a += v._w * dt;
    v.x = SPAWN.x + Math.cos(v._a) * v._r;
    v.z = SPAWN.z + Math.sin(v._a) * v._r;
  }

  controls.update(dt);
  S.sunFollow(controls.target);

  wearTimer += dt;
  if (wearTimer >= 1) { wearTimer = 0; terrainView.updateWear(wear, zones); }

  world.sync(state, dt);
  S.renderer.render(S.scene, S.camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
