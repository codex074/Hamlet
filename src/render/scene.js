// Renderer, lights, sky and day/night cycle.
import * as THREE from '../../vendor/three.module.js';
import { getGraphics, onGraphicsChange } from './graphics.js';

const SHADOW_HALF_MIN = 40;    // shadow camera half-extent follows the zoom: tight when close, wider when far
const SHADOW_HALF_MAX = 110;
const SHADOW_MAP = { low: 1024, high: 2048 };
const SUN_DISTANCE = 160;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Keyframes over sun elevation e in [-1, 1]. Each stop: [e, value]; values are lerped.
// Sky is a gradient dome: horizon colour (also the fog colour, so distance melts into the sky) and zenith colour.
const SKY_HORIZON = [[-1, 0x24325e], [-0.25, 0x2c3d6c], [-0.05, 0x8f6f86], [0.04, 0xf6a064], [0.25, 0xf0cfa0], [0.55, 0xb6d6f0], [1, 0xbcdcf2]];
const SKY_ZENITH = [[-1, 0x0b1334], [-0.25, 0x131d44], [-0.05, 0x2c3a72], [0.04, 0x3d58a8], [0.3, 0x3f7fd2], [1, 0x2f78d2]];
const SUN_COLOR = [[-1, 0x8fa3dc], [-0.1, 0x8fa3dc], [0, 0xffa24f], [0.2, 0xffd096], [0.5, 0xfff1d6], [1, 0xfff1d6]];
// Intensities are ~pi x the old "legacy" values: three r155+ divides diffuse light by pi.
const SUN_INTENSITY = [[-1, 1.1], [-0.25, 0.9], [0, 1.3], [0.2, 1.9], [0.5, 2.3], [1, 2.5]];
const HEMI_SKY = [[-1, 0x6a7fb8], [-0.25, 0x6a7fb8], [0, 0xffc8a0], [0.5, 0xcfe4ff], [1, 0xcfe4ff]];
const HEMI_GROUND = [[-1, 0x3a4256], [-0.25, 0x3a4256], [0, 0x6a5238], [0.5, 0x7a6444], [1, 0x7a6444]];
const HEMI_INTENSITY = [[-1, 1.1], [-0.25, 1.0], [0, 0.9], [0.5, 1.05], [1, 1.1]];
// Filmic tone mapping darkens; lift exposure a touch at night so the moonlit village stays readable.
const EXPOSURE = [[-1, 1.18], [-0.25, 1.12], [0, 1.0], [0.5, 0.95], [1, 0.95]];

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


// ---------------------------------------------------------------- sky dome
const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

const SKY_FRAG = `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uGlow;
uniform float uNight;
varying vec3 vDir;
float hash13( vec3 p ) {
  p = fract( p * 0.1031 );
  p += dot( p, p.zyx + 31.32 );
  return fract( ( p.x + p.y ) * p.z );
}
void main() {
  vec3 d = normalize( vDir );
  float h = d.y;
  float t = smoothstep( -0.02, 0.8, h );
  vec3 col = mix( uHorizon, uZenith, pow( t, 0.5 ) );
  col = mix( col, uHorizon, smoothstep( 0.0, -0.25, h ) );
  // soft haze hugging the horizon
  col = mix( col, uHorizon, exp( -abs( h ) * 8.0 ) * 0.3 );
  // sun / moon glow and disc
  float sd = max( dot( d, normalize( uSunDir ) ), 0.0 );
  col += uSunColor * ( pow( sd, 5.0 ) * 0.16 + pow( sd, 48.0 ) * 0.32 ) * uGlow;
  col += uSunColor * smoothstep( 0.99935, 0.99975, sd ) * 1.4 * ( 0.5 + 0.5 * uGlow );
  // a few stars when it is dark
  if ( uNight > 0.01 && h > 0.02 ) {
    vec3 p = d * 120.0;
    vec3 id = floor( p );
    float r = hash13( id );
    float star = step( 0.994, r ) * smoothstep( 0.45, 0.0, length( fract( p ) - 0.5 ) );
    col += vec3( 0.85, 0.9, 1.0 ) * star * uNight * smoothstep( 0.02, 0.35, h ) * ( 0.6 + 0.4 * hash13( id + 7.0 ) );
  }
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function createSkyDome() {
  const geo = new THREE.SphereGeometry(900, 32, 20);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: new THREE.Color(0x3c82d6) },
      uHorizon: { value: new THREE.Color(0xc2e0f2) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.4).normalize() },
      uSunColor: { value: new THREE.Color(0xfff1d6) },
      uGlow: { value: 1 },
      uNight: { value: 0 },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const dome = new THREE.Mesh(geo, mat);
  dome.name = 'sky';
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  dome.onBeforeRender = (renderer, scene, camera) => { dome.position.copy(camera.position); };
  return dome;
}

// 'auto' follows the display but caps at 1.5×: on Retina that is nearly as sharp as 2× at ~55% of the pixels.
function pixelRatioFor(g) {
  if (g.pixelRatio === 1) return 1;
  return Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 1.5);
}

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  const gfx0 = getGraphics();
  renderer.setPixelRatio(pixelRatioFor(gfx0));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Filmic tone mapping gives the warm, painterly look the textured models are authored for.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xc2e0f2);
  scene.fog = new THREE.Fog(0xc2e0f2, 140, 440);
  const dome = createSkyDome();
  scene.add(dome);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 1200);
  camera.position.set(120, 60, 180);
  // Other render modules (world view, nature) find the camera / view target here without extra wiring.
  const view = { camera, target: new THREE.Vector3(120, 0, 120), targetSet: false, canvas, renderer };
  scene.userData.view = view;

  const hemi = new THREE.HemisphereLight(0xcfe4ff, 0x6b5a40, 1.05);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff1d6, 2.3);
  sun.castShadow = true;
  const sc = sun.shadow.camera;
  let shadowHalf = 60;
  let shadowSize = 0;
  sc.near = 10; sc.far = SUN_DISTANCE * 2.4;
  sun.shadow.bias = -0.0005;     // small, with a generous normalBias: no acne on roofs / terrain facets
  sun.shadow.normalBias = 0.32;
  sun.shadow.radius = 2;
  scene.add(sun);
  scene.add(sun.target);

  const sunDir = new THREE.Vector3(0.4, 0.8, 0.4).normalize();
  const follow = new THREE.Vector3(120, 0, 120);
  const snapped = new THREE.Vector3();
  const _lr = new THREE.Vector3();
  const _lu = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);

  function applyShadowSettings(g) {
    const on = g.shadows !== 'off';
    sun.castShadow = on;
    renderer.shadowMap.enabled = on;
    if (on) {
      const size = SHADOW_MAP[g.shadows] || 2048;
      if (size !== shadowSize) {
        shadowSize = size;
        sun.shadow.mapSize.set(size, size);
        if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      }
    }
    scene.traverse((o) => { if (o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) m.needsUpdate = true; } });
  }

  function setShadowHalf(h) {
    if (h === shadowHalf && sc.right === h) return;
    shadowHalf = h;
    sc.left = -h; sc.right = h; sc.top = h; sc.bottom = -h;
    sc.updateProjectionMatrix();
  }

  // Shadow camera is centred on the view target; the centre is snapped to whole shadow texels in light space
  // so shadows do not shimmer while the camera pans.
  function placeSun() {
    snapped.copy(follow);
    if (shadowSize > 0) {
      const texel = (2 * shadowHalf) / shadowSize;
      _lr.crossVectors(_up, sunDir).normalize();
      _lu.crossVectors(sunDir, _lr).normalize();
      const dr = snapped.dot(_lr);
      const du = snapped.dot(_lu);
      snapped.addScaledVector(_lr, Math.round(dr / texel) * texel - dr);
      snapped.addScaledVector(_lu, Math.round(du / texel) * texel - du);
    }
    sun.target.position.copy(snapped);
    sun.position.copy(snapped).addScaledVector(sunDir, SUN_DISTANCE);
    sun.target.updateMatrixWorld();
  }

  function sunFollow(target) {
    follow.copy(target);
    view.target.copy(target);
    view.targetSet = true;
    const d = camera.position.distanceTo(target);
    setShadowHalf(Math.min(SHADOW_HALF_MAX, Math.max(SHADOW_HALF_MIN, Math.round((d * 0.8) / 10) * 10)));
    placeSun();
  }

  // Bad weather greys the sky, dims the sun and pulls the fog in; snow on the ground brightens the bounce light.
  let overcast = 0;
  let groundSnow = 0;
  const GREY = new THREE.Color();
  function greyOut(c, amt) {
    const l = c.r * 0.3 + c.g * 0.55 + c.b * 0.15;
    GREY.setRGB(l * 0.92, l * 0.95, l * 1.0);
    c.lerp(GREY, amt);
  }
  function setOvercast(amount, snow = 0) {
    overcast = clamp01(amount);
    groundSnow = clamp01(snow);
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

    const u = dome.material.uniforms;
    sampleColor(SKY_HORIZON, e, _a);
    scene.background.copy(_a);
    scene.fog.color.copy(_a);   // fog == dome horizon, so distant terrain melts into the sky
    u.uHorizon.value.copy(_a);
    sampleColor(SKY_ZENITH, e, u.uZenith.value);
    u.uSunDir.value.copy(sunDir);
    sampleColor(SUN_COLOR, e, u.uSunColor.value);
    u.uGlow.value = e > 0 ? 1 : 0.45;
    u.uNight.value = clamp01((-e - 0.05) / 0.3);
    renderer.toneMappingExposure = sampleNumber(EXPOSURE, e);
    scene.fog.near = lerp(60, 140, clamp01((e + 0.25) / 0.75));
    scene.fog.far = lerp(300, 440, clamp01((e + 0.25) / 0.75));

    sampleColor(SUN_COLOR, e, sun.color);
    sun.intensity = sampleNumber(SUN_INTENSITY, e);
    sampleColor(HEMI_SKY, e, hemi.color);
    sampleColor(HEMI_GROUND, e, hemi.groundColor);
    hemi.intensity = sampleNumber(HEMI_INTENSITY, e);
    if (overcast > 0.001) {
      const g = overcast * 0.85;
      greyOut(scene.background, g);
      greyOut(scene.fog.color, g);
      greyOut(u.uHorizon.value, g);
      greyOut(u.uZenith.value, g);
      u.uGlow.value *= 1 - overcast * 0.8;
      sun.intensity *= 1 - overcast * 0.6;
      hemi.intensity *= 1 + overcast * 0.08;
      scene.fog.near *= 1 - overcast * 0.55;
      scene.fog.far *= 1 - overcast * 0.4;
    }
    if (groundSnow > 0.001) hemi.groundColor.lerp(GREY.setRGB(0.85, 0.88, 0.95), groundSnow * 0.6);
    placeSun();
  }

  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function applyGraphics(g) {
    renderer.setPixelRatio(pixelRatioFor(g));
    applyShadowSettings(g);
    setShadowHalf(shadowHalf);
    resize();
    placeSun();
  }

  setShadowHalf(60);
  applyShadowSettings(gfx0);
  resize();
  setTimeOfDay(9);
  const offGraphics = onGraphicsChange(applyGraphics);

  function dispose() { offGraphics(); }

  return { renderer, scene, camera, sun, hemi, resize, setTimeOfDay, setOvercast, sunFollow, dispose };
}
