// Large-map stress demo (560 m world, thousands of trees, saplings, territories, graphics presets).
//   /dev/bigmap-demo.html
//   ?walk=1|0   auto-fly the camera across the map (default 1; space toggles)
//   ?preset=low|medium|high   graphics preset (keys 1/2/3)       ?size=small|medium|large (default large)
//   ?territory=1  show the territory view (key T)                ?trees=N  extra random trees (default: enough for ~6000)
//   ?hour=10  fixed time of day                                  ?cx= &cz= &dist= start the camera there (with walk=0)
// Keys: F toggle FPS counter · wasd/qe/wheel/right-drag = camera (see camera.js).
import * as THREE from '../vendor/three.module.js';
import { generateTerrain, generateNodes, heightAt } from '../src/terrain.js';
import { createWear, addWear } from '../src/wear.js';
import { createTerritory, plotInfo } from '../src/territory.js';
import { createScene } from '../src/render/scene.js';
import { createCameraController } from '../src/render/camera.js';
import { createTerrainMesh } from '../src/render/terrainMesh.js';
import { createWorldView } from '../src/render/world.js';
import { getGraphics, setGraphics } from '../src/render/graphics.js';
import { mulberry32 } from '../src/rng.js';
import { DAY_LENGTH } from '../src/config.js';

const q = new URLSearchParams(location.search);
const SEED = +(q.get('seed') || 7);
const settings = { mapSize: q.get('size') || 'large', forest: 'high', terrain: 'hilly', rivers: 2 };

const t0 = performance.now();
const terrain = generateTerrain(SEED, settings);
const nodes = generateNodes(SEED, terrain, settings);
const size = terrain.size;
let nextId = nodes.reduce((m, n) => Math.max(m, n.id), 0) + 1;

// top up to thousands of trees (forest density = many small stands) so the culling has something to do
const want = +(q.get('trees') || 6500);
const rand = mulberry32(99);
let treeCount = nodes.filter((n) => n.kind === 'tree').length;
for (let guard = 0; treeCount < want && guard < want * 20; guard++) {
  const x = 6 + rand() * (size - 12);
  const z = 6 + rand() * (size - 12);
  const h = heightAt(terrain, x, z);
  if (h < 0.3 || Math.hypot(x - size / 2, z - size / 2) < 24) continue;
  nodes.push({ id: nextId++, kind: 'tree', x, z, amount: 4, reserved: null });
  treeCount++;
}

const plots = Math.round(size / 80);
const centre = size / 2;
const state = {
  time: 0, gold: 400, nodes, buildings: [], zones: [], villagers: [], events: [],
  terrain, wear: createWear(terrain.grid), settings,
  world: { size, grid: terrain.grid, plot: 80, plots },
  territory: createTerritory(plots),
};

// a small village in the middle + one forester with a nursery of saplings in different growth stages
let bid = 1;
const add = (type, dx, dz, rot, extra = {}) => state.buildings.push({
  id: bid++, type, x: centre + dx, z: centre + dz, rot, built: true, progress: 1, workers: [], ...extra,
});
add('townhall', 0, 0, 0);
add('house', 14, -8, 0.3, { level: 2 }); add('house', -15, 6, 1.5, { level: 1 }); add('house', 16, 10, -0.4, { level: 3 });
add('woodcutter', -24, -12, 0.5); add('storehouse', 4, 20, 0); add('chapel', -10, -22, 0.1);
add('forester', 26, -22, -0.6);
for (let i = 0; i < 36; i++) {
  const a = rand() * Math.PI * 2;
  const r = 5 + rand() * 22;
  nodes.push({
    id: nextId++, kind: 'sapling', x: centre + 26 + Math.cos(a) * r, z: centre - 22 + Math.sin(a) * r, amount: 1,
    planted: -rand() * DAY_LENGTH * 2.1,
  });
}
state.time = 0;
for (const b of state.buildings.slice(1)) {
  for (let i = 0; i < 30; i++) {
    const t = i / 30;
    for (let k = 0; k < 14; k++) addWear(state.wear, centre + (b.x - centre) * t, centre + (b.z - centre) * t, 0.06);
  }
}

if (q.get('preset')) setGraphics({ preset: q.get('preset') });
setGraphics({ showFps: true });

const canvas = document.getElementById('c');
const S = createScene(canvas);
const terrainView = createTerrainMesh(terrain);
S.scene.add(terrainView.mesh, terrainView.water);
const controls = createCameraController(S.camera, canvas, (x, z) => heightAt(terrain, x, z), terrain);
controls.setPanWithLeftMouse(true);
const world = createWorldView(S.scene, terrain);
window.addEventListener('resize', () => S.resize());
S.resize();
terrainView.updateWear(state.wear, state.zones, state.territory);

let territoryOn = q.get('territory') === '1';
const setTerritory = (on) => { territoryOn = on; world.setTerritoryView(on, (st) => plotInfo(st)); };
if (territoryOn) setTerritory(true);
state.gold = 120;

let walk = q.get('walk') !== '0';
if (!walk) {
  controls.target.set(+(q.get('cx') || centre), 0, +(q.get('cz') || centre));
}
const hour = +(q.get('hour') || 10);
S.setTimeOfDay(hour);

window.addEventListener('keydown', (e) => {
  if (e.key === ' ') { walk = !walk; e.preventDefault(); }
  else if (e.key.toLowerCase() === 't') setTerritory(!territoryOn);
  else if (e.key.toLowerCase() === 'f') setGraphics({ showFps: !getGraphics().showFps });
  else if (e.key === '1') setGraphics({ preset: 'low' });
  else if (e.key === '2') setGraphics({ preset: 'medium' });
  else if (e.key === '3') setGraphics({ preset: 'high' });
  else if (e.key === 'b') { // buy the first buyable plot (prices rise)
    const p = plotInfo(state).find((x) => x.buyable);
    if (p) { state.territory.owned[p.pz * plots + p.px] = 1; state.territory.bought++; }
  }
});

// ---- camera walk: a loop through the map corners/edges at 3 zoom levels
const route = [];
{
  const m = size * 0.12;
  const pts = [[centre, centre], [m, m], [size - m, m], [size - m, size - m], [m, size - m], [centre, centre]];
  for (const p of pts) route.push(p);
}
let routeT = 0;
const ROUTE_SPEED = 9;       // metres per second along the route
let routeLen = 0;
const segLen = [];
for (let i = 1; i < route.length; i++) { const l = Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]); segLen.push(l); routeLen += l; }
function routePoint(d) {
  d = ((d % routeLen) + routeLen) % routeLen;
  for (let i = 0; i < segLen.length; i++) {
    if (d <= segLen[i]) { const t = d / segLen[i]; return [route[i][0] + (route[i + 1][0] - route[i][0]) * t, route[i][1] + (route[i + 1][1] - route[i][1]) * t]; }
    d -= segLen[i];
  }
  return route[0];
}

// ---- stats
const hud = document.getElementById('hud');
const stats = { frames: 0, t: performance.now(), fps: 0, worst: 0, fpsMin: 1e9, fpsMax: 0, samples: [] };
window.demo = { S, world, state, terrain, controls, stats, setTerritory, treeCount, genMs: 0 };
window.demo.genMs = performance.now() - t0;

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  state.time += dt * 60;       // fast-forward game time so sapling growth is visible (1 real second = 1 game minute)
  if (walk) {
    routeT += ROUTE_SPEED * dt;
    const [x, z] = routePoint(routeT);
    controls.target.x = x; controls.target.z = z;
  }
  controls.update(dt);
  S.sunFollow(controls.target);
  world.sync(state, dt);
  S.renderer.render(S.scene, S.camera);

  stats.frames++;
  stats.worst = Math.max(stats.worst, dt * 1000);
  if (now - stats.t >= 1000) {
    stats.fps = (stats.frames * 1000) / (now - stats.t);
    stats.samples.push(stats.fps);
    stats.fpsMin = Math.min(stats.fpsMin, stats.fps);
    stats.fpsMax = Math.max(stats.fpsMax, stats.fps);
    stats.frames = 0; stats.t = now;
    const info = S.renderer.info;
    const avg = stats.samples.reduce((a, b) => a + b, 0) / stats.samples.length;
    hud.textContent = `${size} m world · ${nodes.length} nodes (${treeCount} trees) · build ${window.demo.genMs.toFixed(0)} ms\n` +
      `fps ${stats.fps.toFixed(0)} (avg ${avg.toFixed(1)}, min ${stats.fpsMin.toFixed(0)}, max ${stats.fpsMax.toFixed(0)}) · worst frame ${stats.worst.toFixed(0)} ms\n` +
      `calls ${info.render.calls} · tris ${(info.render.triangles / 1000).toFixed(0)}k · preset ${getGraphics().preset} · target ${controls.target.x.toFixed(0)},${controls.target.z.toFixed(0)}\n` +
      `keys: space walk · T territory · B buy plot · F fps · 1/2/3 preset`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
