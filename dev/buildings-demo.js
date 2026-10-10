// Gallery of every building model. Serve the project root, open /dev/buildings-demo.html
//   ?focus=<type>[&level=1..5][&stage=0..4][&seed=n]   close-up of one model ("site" = construction site)
//   &night=1  window glow on, moonlit        &rings=0  hide the config footprint rings
import * as THREE from '../vendor/three.module.js';
import { BUILDINGS } from '../src/config.js';
import { makeBuildingModel, makeSiteModel, WINDOW_MATERIALS } from '../src/render/models.js';
import { getTexture } from '../src/render/textures.js';

const q = new URLSearchParams(location.search);
const canvas = document.getElementById('c');
const labels = document.getElementById('labels');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const night = q.get('night') === '1';
const scene = new THREE.Scene();
const sky = night ? 0x1a2648 : 0x9cc7e8;
scene.background = new THREE.Color(sky);
scene.fog = new THREE.Fog(sky, 200, 520);

const camera = new THREE.PerspectiveCamera(42, 1, 0.3, 1200);

const hemi = new THREE.HemisphereLight(night ? 0x6a7fb8 : 0xcfe4ff, night ? 0x3a4256 : 0x6b5a40, night ? 1.1 : 1.05);
scene.add(hemi);
const sun = new THREE.DirectionalLight(night ? 0x8fa3dc : 0xfff1d6, night ? 1.4 : 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.25;
scene.add(sun, sun.target);
const SUN_DIR = new THREE.Vector3(0.45, 0.75, 0.5).normalize();
for (const m of WINDOW_MATERIALS) m.emissiveIntensity = night ? 1.6 : 0;

// ground
const gtex = getTexture('grass');
if (gtex) gtex.repeat.set(220, 220);
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(900, 900),
  new THREE.MeshLambertMaterial({ color: 0xffffff, map: gtex }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const items = [];
function add(name, group, x, z, radius, rot = 0) {
  group.position.set(x, 0, z);
  group.rotation.y = rot;
  scene.add(group);
  if (q.get('rings') !== '0' && radius) {
    const pts = [];
    for (let i = 0; i <= 64; i++) pts.push(new THREE.Vector3(Math.cos(i / 64 * Math.PI * 2) * radius, 0.06, Math.sin(i / 64 * Math.PI * 2) * radius));
    const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffd860, transparent: true, opacity: 0.55 }));
    ring.position.set(x, 0, z);
    scene.add(ring);
  }
  const pen = group.userData.pen; // sheep pen: green ring (local -> world, ignoring rotation offsets of the demo)
  if (pen && q.get('rings') !== '0') {
    const pts = [];
    for (let i = 0; i <= 48; i++) pts.push(new THREE.Vector3(pen.x + Math.cos(i / 48 * Math.PI * 2) * pen.r, 0.08, pen.z + Math.sin(i / 48 * Math.PI * 2) * pen.r));
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x66ff88, transparent: true, opacity: 0.7 })));
  }
  items.push({ name, group, x, z, radius, tris: group.userData.triangles });
  return group;
}

const focus = q.get('focus');
const seed = +(q.get('seed') || 3);
let center = new THREE.Vector3();
let dist = 200;

if (focus) {
  let g, r;
  if (focus === 'site') { r = +(q.get('radius') || 4); g = makeSiteModel(r, seed); }
  else {
    r = BUILDINGS[focus]?.radius ?? 4;
    g = makeBuildingModel(focus, { level: +(q.get('level') || 1), stage: +(q.get('stage') || 0), seed });
  }
  add(focus, g, 0, 0, r);
  center.set(0, r * 0.45, 0);
  dist = r * 3.4 + 4;
} else {
  // row A: the original building types; row A2: profession buildings
  const place = (types, z) => {
    let x = 0;
    for (const t of types) {
      const r = BUILDINGS[t].radius;
      x += r + 1.5;
      add(t, makeBuildingModel(t, { seed: 3 }), x, z, r);
      x += r + 1.5;
    }
    return x;
  };
  const rowW = Math.max(
    place(['townhall', 'storehouse', 'woodcutter', 'forager', 'quarry', 'sawmill', 'farmhouse', 'mill', 'bakery', 'chapel', 'tavern'], 0),
    place(['fishery', 'hunter', 'herbalist', 'forester', 'sheepfarm', 'ironmine', 'weaver', 'blacksmith', 'infirmary', 'market'], 26),
  );
  // row B: houses, levels 1-5 x 3 seeds
  for (let l = 1; l <= 5; l++) {
    for (let s = 0; s < 3; s++) {
      add(`house L${l} s${s}`, makeBuildingModel('house', { level: l, seed: s * 5 + l }), (l - 1) * 3 * 8 + s * 8 + 4, 52, 3);
    }
  }
  // row C: cathedral stages
  for (let s = 0; s <= 4; s++) add(`cathedral ${s}`, makeBuildingModel('cathedral', { stage: s }), 14 + s * 27, 92, 11);
  add('site r4', makeSiteModel(4, 1), 160, 52, 4);
  add('site r6', makeSiteModel(6, 2), 175, 52, 6);
  center.set(rowW / 2, 0, 40);
  dist = 200;
}

// orbit camera
let yaw = focus ? 0.55 : 0.0, pitch = focus ? 0.38 : 0.62;
if (q.get('yaw')) yaw = +q.get('yaw');
if (q.get('pitch')) pitch = +q.get('pitch');
if (q.get('dist')) dist = +q.get('dist');
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
  } else {
    yaw -= dx * 0.006;
    pitch = Math.min(1.5, Math.max(0.02, pitch + dy * 0.006));
  }
});
canvas.addEventListener('wheel', (e) => { e.preventDefault(); dist = Math.min(500, Math.max(3, dist * (1 + e.deltaY * 0.0012))); }, { passive: false });

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

const labelEls = items.map((it) => {
  const d = document.createElement('div');
  d.textContent = `${it.name} ${Math.round(it.tris || 0)}t`;
  if (!focus) labels.appendChild(d);
  return d;
});

const _v = new THREE.Vector3();
let t0 = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - t0) / 1000);
  t0 = now;
  camera.position.set(
    center.x + Math.sin(yaw) * Math.cos(pitch) * dist,
    center.y + Math.sin(pitch) * dist,
    center.z + Math.cos(yaw) * Math.cos(pitch) * dist,
  );
  camera.lookAt(center);
  sun.target.position.copy(center);
  sun.position.copy(center).addScaledVector(SUN_DIR, 150);
  const sh = Math.min(140, dist * 0.9 + 30);
  const sc = sun.shadow.camera;
  if (sc.right !== sh) { sc.left = -sh; sc.right = sh; sc.top = sh; sc.bottom = -sh; sc.near = 10; sc.far = 400; sc.updateProjectionMatrix(); }
  for (const it of items) {
    const sails = it.group.getObjectByName('sails');
    if (sails) sails.rotation.z -= dt * 0.8;
    const blade = it.group.getObjectByName('sawblade');
    if (blade) blade.rotation.z += dt * 6;
  }
  items.forEach((it, i) => {
    _v.set(it.x, 0.2, it.z + it.radius + 0.5).project(camera);
    const el = labelEls[i];
    el.style.display = _v.z < 1 && !focus ? '' : 'none';
    el.style.left = `${(_v.x * 0.5 + 0.5) * window.innerWidth}px`;
    el.style.top = `${(-_v.y * 0.5 + 0.5) * window.innerHeight}px`;
  });
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.__demo = { camera, items, scene, renderer, set(y, p, d) { yaw = y; pitch = p; dist = d; }, center };
