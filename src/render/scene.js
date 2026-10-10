// Renderer, lights, sky and day/night cycle.
import * as THREE from '../../vendor/three.module.js';
import { WORLD_SIZE } from '../config.js';

const SHADOW_HALF = 60;   // shadow camera covers ~120 m
const SUN_DISTANCE = 160;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Keyframes over sun elevation e in [-1, 1]. Each stop: [e, value]; values are lerped.
const SKY = [[-1, 0x1a2648], [-0.25, 0x22305a], [0, 0xf0985a], [0.5, 0x8fc4ee], [1, 0x8fc4ee]];
const SUN_COLOR = [[-1, 0x8fa3dc], [-0.1, 0x8fa3dc], [0, 0xffa860], [0.5, 0xfff1d6], [1, 0xfff1d6]];
// Intensities are ~pi x the old "legacy" values: three r155+ divides diffuse light by pi.
const SUN_INTENSITY = [[-1, 1.1], [-0.25, 0.9], [0, 1.3], [0.5, 2.3], [1, 2.5]];
const HEMI_SKY = [[-1, 0x6a7fb8], [-0.25, 0x6a7fb8], [0, 0xffc8a0], [0.5, 0xcfe4ff], [1, 0xcfe4ff]];
const HEMI_GROUND = [[-1, 0x3a4256], [-0.25, 0x3a4256], [0, 0x5a4634], [0.5, 0x6b5a40], [1, 0x6b5a40]];
const HEMI_INTENSITY = [[-1, 1.1], [-0.25, 1.0], [0, 0.9], [0.5, 1.05], [1, 1.1]];

const _a = new THREE.Color();
const _b = new THREE.Color();

function sampleColor(stops, e, out) {
  if (e <= stops[0][0]) return out.set(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    if (e <= stops[i][0]) {
      const [e0, c0] = stops[i - 1];
      const [e1, c1] = stops[i];
      const t = (e - e0) / (e1 - e0);
      _a.set(c0);
      _b.set(c1);
      return out.copy(_a).lerp(_b, t);
    }
  }
  return out.set(stops[stops.length - 1][1]);
}

function sampleNumber(stops, e) {
  if (e <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (e <= stops[i][0]) {
      const [e0, v0] = stops[i - 1];
      const [e1, v1] = stops[i];
      return lerp(v0, v1, (e - e0) / (e1 - e0));
    }
  }
  return stops[stops.length - 1][1];
}

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Filmic tone mapping gives the warm, painterly look the textured models are authored for.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fc4ee);
  scene.fog = new THREE.Fog(0x8fc4ee, 140, 440);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 1200);
  camera.position.set(WORLD_SIZE / 2, 60, WORLD_SIZE / 2 + 60);

  const hemi = new THREE.HemisphereLight(0xcfe4ff, 0x6b5a40, 1.05);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff1d6, 2.3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -SHADOW_HALF; sc.right = SHADOW_HALF; sc.top = SHADOW_HALF; sc.bottom = -SHADOW_HALF;
  sc.near = 10; sc.far = SUN_DISTANCE * 2.4;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.35;
  scene.add(sun);
  scene.add(sun.target);

  const sunDir = new THREE.Vector3(0.4, 0.8, 0.4).normalize();
  const follow = new THREE.Vector3(WORLD_SIZE / 2, 0, WORLD_SIZE / 2);

  function placeSun() {
    sun.target.position.copy(follow);
    sun.position.copy(follow).addScaledVector(sunDir, SUN_DISTANCE);
    sun.target.updateMatrixWorld();
  }

  function sunFollow(target) {
    follow.copy(target);
    placeSun();
  }

  function setTimeOfDay(hour) {
    const h = ((hour % 24) + 24) % 24;
    let e; // sun elevation, positive by day, negative at night (the "sun" light becomes the moon)
    let a; // arc angle 0..pi across the sky
    if (h >= 5 && h < 21) {
      a = Math.PI * (h - 5) / 16;
      e = Math.sin(a);
    } else {
      const nt = ((h - 21 + 24) % 24) / 8;
      a = Math.PI * nt;
      e = -Math.sin(a);
    }
    sunDir.set(Math.cos(a), Math.max(0.15, Math.sin(a) * 0.95 + 0.05), 0.4).normalize();

    sampleColor(SKY, e, _a);
    const sky = _a.clone();
    scene.background.copy(sky);
    scene.fog.color.copy(sky);
    scene.fog.near = lerp(60, 140, clamp01((e + 0.25) / 0.75));
    scene.fog.far = lerp(300, 440, clamp01((e + 0.25) / 0.75));

    sampleColor(SUN_COLOR, e, sun.color);
    sun.intensity = sampleNumber(SUN_INTENSITY, e);
    sampleColor(HEMI_SKY, e, hemi.color);
    sampleColor(HEMI_GROUND, e, hemi.groundColor);
    hemi.intensity = sampleNumber(HEMI_INTENSITY, e);
    placeSun();
  }

  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  resize();
  setTimeOfDay(9);

  return { renderer, scene, camera, sun, hemi, resize, setTimeOfDay, sunFollow };
}
