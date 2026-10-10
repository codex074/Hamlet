// Turntable gallery of every character in src/render/characters.js.
// ?pose=walk|work|idle  ?look=N (all roles in one look)  ?looks=1 (one role in every look, ?role=key)
// ?carry=1 (show every carried good)  ?set=new|old (subset of roles)
import * as THREE from '../vendor/three.module.js';
import { ROLES, LOOKS, CARRY_KINDS, makeCharacterGroup, applyPose, workPoseOf } from '../src/render/characters.js';

const params = new URLSearchParams(location.search);
const pose = params.get('pose') || 'idle';
const look = Number(params.get('look') || 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xc9dcea);
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.1, 200);

scene.add(new THREE.HemisphereLight(0xdfeeff, 0x6b5a40, 2.2));
const sun = new THREE.DirectionalLight(0xfff1d6, 2.6);
sun.position.set(4, 8, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10 });
scene.add(sun);

const ground = new THREE.Mesh(new THREE.CircleGeometry(20, 48), new THREE.MeshLambertMaterial({ color: 0x8fae5a }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

let entries;
if (params.get('looks')) {
  const role = params.get('role') || 'villager';
  entries = LOOKS.map((_, i) => ({ role, look: i, carry: null }));
} else if (params.get('carry')) {
  entries = CARRY_KINDS.map((res, i) => ({ role: 'villager', look: i, carry: res }));
} else {
  const NEW = ['fisher', 'hunter', 'herbalist', 'shepherd', 'miner', 'weaver', 'blacksmith', 'doctor', 'merchant'];
  const keys = params.get('set') === 'new' ? NEW : params.get('set') === 'old' ? Object.keys(ROLES).filter((k) => !NEW.includes(k)) : Object.keys(ROLES);
  entries = keys.map((role) => ({ role, look, carry: null }));
}

const SPACING = 1.25;
const chars = entries.map((e, i) => {
  const workKind = workPoseOf(e.role);
  const g = makeCharacterGroup(e.role, e.look, e.carry);
  const root = new THREE.Group();
  root.position.x = (i - (entries.length - 1) / 2) * SPACING;
  root.add(g);
  scene.add(root);
  return { root, g, workKind, label: e.carry ? e.carry : g.userData.name };
});

const labels = document.getElementById('labels');
const labelEls = chars.map((c) => {
  const d = document.createElement('div');
  d.textContent = c.label;
  labels.appendChild(d);
  return d;
});

let yaw = 0.25, dist = 4 + entries.length * 1.05, dragging = false, lx = 0;
addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; });
addEventListener('pointerup', () => { dragging = false; });
addEventListener('pointermove', (e) => { if (dragging) { yaw -= (e.clientX - lx) * 0.01; lx = e.clientX; } });
addEventListener('wheel', (e) => { dist = Math.min(40, Math.max(1.5, dist * (1 + e.deltaY * 0.001))); });
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

const _v = new THREE.Vector3();
const t0 = performance.now();
function frame() {
  const t = (performance.now() - t0) / 1000;
  camera.position.set(Math.sin(yaw) * dist, 1.3 + dist * 0.1, Math.cos(yaw) * dist);
  camera.lookAt(0, 0.95, 0);
  chars.forEach((c, i) => {
    const kind = c.g.userData.carrying ? 'walk' : pose === 'work' ? c.workKind : pose;
    applyPose(c.g, kind, (pose === 'work' ? (kind === 'chop' ? t * 5 : t * 2) : t * 7) + i);
    _v.set(c.root.position.x, 2.2, 0).project(camera);
    labelEls[i].style.left = `${(_v.x * 0.5 + 0.5) * innerWidth}px`;
    labelEls[i].style.top = `${(-_v.y * 0.5 + 0.5) * innerHeight}px`;
  });
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();
