// Atmospheric effects: chimney smoke and night fireflies.
// Billboards are instanced camera-facing quads (no gl_PointSize limits), soft procedural puff texture.
// Node-safe: nothing here touches `document` or WebGL until a renderer actually draws the meshes.
import * as THREE from '../../vendor/three.module.js';
import { mulberry32 } from '../rng.js';
import { getGraphics, onGraphicsChange } from './graphics.js';

const MAX_PUFFS = 600;
const PER_SOURCE = 10;

// Soft cloudy blob in the alpha channel (DataTexture, so it also works without a canvas).
function makePuffTexture() {
  const S = 64;
  const data = new Uint8Array(S * S * 4);
  const rand = mulberry32(4242);
  const blobs = [];
  for (let i = 0; i < 7; i++) {
    const a = rand() * Math.PI * 2;
    const r = rand() * 0.22;
    blobs.push([0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r, 0.14 + rand() * 0.12, 0.6 + rand() * 0.4]);
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S;
      const v = (y + 0.5) / S;
      let a = 0;
      for (const [bx, by, br, bw] of blobs) {
        const d2 = ((u - bx) ** 2 + (v - by) ** 2) / (br * br);
        a += bw * Math.exp(-d2 * 1.6);
      }
      const rr = Math.hypot(u - 0.5, v - 0.5) * 2;
      const env = Math.max(0, 1 - rr * rr); // fade to nothing at the quad edge
      const val = Math.min(1, a * 1.1) * Math.min(1, env * 1.6);
      const i = (y * S + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(Math.min(1, val) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

const VERT = /* glsl */`
attribute vec3 iPos;
attribute vec4 iData; // size, alpha, rotation, seed
varying vec2 vUv;
varying float vAlpha;
varying float vSeed;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vAlpha = iData.y;
  vSeed = iData.w;
  float c = cos( iData.z ); float s = sin( iData.z );
  vec2 o = vec2( position.x * c - position.y * s, position.x * s + position.y * c ) * iData.x;
  vec4 mvPosition = modelViewMatrix * vec4( iPos, 1.0 );
  mvPosition.xy += o;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uShade;
varying vec2 vUv;
varying float vAlpha;
varying float vSeed;
#include <fog_pars_fragment>
void main() {
  float a = texture2D( uMap, vUv ).a * vAlpha;
  if ( a < 0.004 ) discard;
  vec3 col = uColor * ( 1.0 - uShade * ( 0.18 + 0.2 * vSeed ) * ( 1.0 - vUv.y * 0.6 ) );
  gl_FragColor = vec4( col, a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

// Camera-facing instanced quads. attrs: iPos (vec3) + iData (vec4: size, alpha, rot, seed).
function makeBillboards(cap, { color, additive = false, uShade = 0.6 }) {
  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute('position', quad.attributes.position);
  geo.setAttribute('uv', quad.attributes.uv);
  const iPos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  const iData = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
  iPos.setUsage(THREE.DynamicDrawUsage);
  iData.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iPos', iPos);
  geo.setAttribute('iData', iData);
  geo.instanceCount = 0;

  const map = makePuffTexture();
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uMap: { value: map }, uColor: { value: new THREE.Color(color) }, uShade: { value: uShade },
    }]),
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    fog: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  return { mesh, geo, mat, map, iPos, iData };
}

// ------------------------------------------------------------------ smoke

export function createSmoke(parent) {
  const bb = makeBillboards(MAX_PUFFS, { color: 0xc4c1bc });
  bb.mesh.name = 'smoke';
  parent.add(bb.mesh);
  // graphics setting 'effects' (live): off hides the billboards and skips the simulation
  let enabled = getGraphics().effects;
  bb.mesh.visible = enabled;
  const offGfx = onGraphicsChange((g) => {
    enabled = g.effects;
    bb.mesh.visible = enabled;
    if (!enabled) { n = 0; bb.geo.instanceCount = 0; }
  });

  const rand = mulberry32(31337);
  // live puffs, structure-of-arrays
  const x = new Float32Array(MAX_PUFFS);
  const y = new Float32Array(MAX_PUFFS);
  const z = new Float32Array(MAX_PUFFS);
  const age = new Float32Array(MAX_PUFFS);
  const life = new Float32Array(MAX_PUFFS);
  const size1 = new Float32Array(MAX_PUFFS);
  const rot0 = new Float32Array(MAX_PUFFS);
  const spin = new Float32Array(MAX_PUFFS);
  const seed = new Float32Array(MAX_PUFFS);
  const rise = new Float32Array(MAX_PUFFS);
  let n = 0;

  let sources = [];
  let acc = [];
  let time = 0;
  let nightMix = 0;
  const day = new THREE.Color(0xc4c1bc);
  const night = new THREE.Color(0x3c4360);

  function setSources(list) {
    sources = (list || []).map((v) => ({ x: v.x, y: v.y, z: v.z }));
    // keep accumulators so existing emitters do not burst when the list is refreshed
    while (acc.length < sources.length) acc.push(rand());
    acc.length = sources.length;
  }

  function emit(s) {
    if (n >= MAX_PUFFS) return;
    const i = n++;
    x[i] = s.x + (rand() - 0.5) * 0.25;
    y[i] = s.y;
    z[i] = s.z + (rand() - 0.5) * 0.25;
    age[i] = 0;
    life[i] = 4.2 + rand() * 2.8;
    size1[i] = 3.0 + rand() * 1.8;
    rot0[i] = rand() * Math.PI * 2;
    spin[i] = (rand() - 0.5) * 0.35;
    seed[i] = rand();
    rise[i] = 1.0 + rand() * 0.5;
  }

  function update(dt, isNight) {
    if (!enabled) return;
    time += dt;
    nightMix += ((isNight ? 1 : 0) - nightMix) * Math.min(1, dt * 0.6);
    bb.mat.uniforms.uColor.value.copy(day).lerp(night, nightMix);
    bb.mat.uniforms.uShade.value = 0.5 + 0.2 * nightMix;

    // emit: ~PER_SOURCE live puffs per source (rate = count / mean lifetime)
    const perSource = Math.max(1, Math.min(PER_SOURCE, Math.floor(MAX_PUFFS / Math.max(1, sources.length))));
    const rate = perSource / 5.6;
    for (let s = 0; s < sources.length; s++) {
      acc[s] += dt * rate;
      while (acc[s] >= 1) { acc[s] -= 1; emit(sources[s]); }
    }

    // wind: steady drift with slow gusts
    const gust = 0.75 + 0.35 * Math.sin(time * 0.31) + 0.15 * Math.sin(time * 0.93 + 1.3);
    const wx = 0.86 * gust;
    const wz = 0.5 * gust;

    const P = bb.iPos.array;
    const D = bb.iData.array;
    for (let i = 0; i < n;) {
      age[i] += dt;
      const t = age[i] / life[i];
      if (t >= 1) { // swap-remove
        const l = --n;
        if (i !== l) {
          x[i] = x[l]; y[i] = y[l]; z[i] = z[l]; age[i] = age[l]; life[i] = life[l]; size1[i] = size1[l];
          rot0[i] = rot0[l]; spin[i] = spin[l]; seed[i] = seed[l]; rise[i] = rise[l];
        }
        continue;
      }
      const lift = rise[i] * (1 - 0.45 * t);
      y[i] += lift * dt;
      const drift = 0.25 + 1.1 * t; // starts rising straight, bends downwind
      x[i] += wx * drift * dt;
      z[i] += wz * drift * dt;
      const ease = 1 - (1 - t) * (1 - t);
      const size = 0.7 + (size1[i] - 0.7) * ease;
      const fadeIn = Math.min(1, t / 0.12);
      const fadeOut = (1 - t) ** 0.9;
      const alpha = 0.9 * fadeIn * fadeOut * (1 - 0.2 * nightMix);
      P[i * 3] = x[i]; P[i * 3 + 1] = y[i]; P[i * 3 + 2] = z[i];
      D[i * 4] = size; D[i * 4 + 1] = alpha; D[i * 4 + 2] = rot0[i] + spin[i] * age[i]; D[i * 4 + 3] = seed[i];
      i++;
    }
    bb.geo.instanceCount = n;
    bb.iPos.needsUpdate = true;
    bb.iData.needsUpdate = true;
  }

  function dispose() {
    offGfx();
    parent.remove(bb.mesh);
    bb.geo.dispose();
    bb.mat.dispose();
    bb.map.dispose();
  }

  return { setSources, update, dispose };
}

// ------------------------------------------------------------------ fireflies

// Fireflies drift around `focus` (e.g. the camera target) and fade in at night.
//   opts.count    number of fireflies (default 140)
//   opts.heightAt (x, z) -> ground height, so they hover 0.4-2.6 m above the terrain
//   opts.radius   half-extent of the area around the focus (default 38 m)
export function createFireflies(parent, opts = {}) {
  const count = opts.count || 140;
  const radius = opts.radius || 38;
  const heightAt = opts.heightAt || (() => 0);
  const bb = makeBillboards(count, { color: 0xd9ff7a, additive: true, uShade: 0 });
  bb.mesh.name = 'fireflies';
  parent.add(bb.mesh);
  let enabled = getGraphics().effects;
  bb.mesh.visible = enabled;
  const offGfx = onGraphicsChange((g) => {
    enabled = g.effects;
    bb.mesh.visible = enabled;
    if (!enabled) bb.geo.instanceCount = 0;
  });

  const rand = mulberry32(8080);
  const fx = new Float32Array(count);
  const fz = new Float32Array(count);
  const fy = new Float32Array(count);
  const ph = new Float32Array(count);
  const sp = new Float32Array(count);
  let init = false;
  let nightMix = 0;
  let time = 0;
  const focusV = new THREE.Vector3(opts.center || 120, 0, opts.center || 120);

  function respawn(i, cx, cz, ring) {
    const a = rand() * Math.PI * 2;
    const r = ring ? radius * (0.7 + rand() * 0.3) : radius * Math.sqrt(rand());
    fx[i] = cx + Math.cos(a) * r;
    fz[i] = cz + Math.sin(a) * r;
    fy[i] = 0.4 + rand() * 2.2;
    ph[i] = rand() * 100;
    sp[i] = 0.5 + rand() * 0.9;
  }

  function update(dt, isNight, focus) {
    if (!enabled) return;
    time += dt;
    if (focus) focusV.copy(focus);
    if (!init) { for (let i = 0; i < count; i++) respawn(i, focusV.x, focusV.z, false); init = true; }
    nightMix += ((isNight ? 1 : 0) - nightMix) * Math.min(1, dt * 0.8);
    if (nightMix < 0.02) { bb.geo.instanceCount = 0; return; }

    const P = bb.iPos.array;
    const D = bb.iData.array;
    for (let i = 0; i < count; i++) {
      const t = time * sp[i] + ph[i];
      fx[i] += Math.sin(t * 0.9) * 0.5 * dt;
      fz[i] += Math.cos(t * 0.7) * 0.5 * dt;
      fy[i] += Math.sin(t * 1.3) * 0.25 * dt;
      if (Math.hypot(fx[i] - focusV.x, fz[i] - focusV.z) > radius * 1.1) respawn(i, focusV.x, focusV.z, true);
      const gx = fx[i] + Math.sin(t * 1.7) * 0.3;
      const gz = fz[i] + Math.cos(t * 1.9) * 0.3;
      P[i * 3] = gx; P[i * 3 + 1] = heightAt(gx, gz) + Math.max(0.35, fy[i]); P[i * 3 + 2] = gz;
      const blink = Math.max(0, Math.sin(t * 2.1)) ** 2;
      D[i * 4] = 0.28 + 0.1 * blink;
      D[i * 4 + 1] = nightMix * (0.15 + 0.85 * blink);
      D[i * 4 + 2] = 0;
      D[i * 4 + 3] = 0.5;
    }
    bb.geo.instanceCount = count;
    bb.iPos.needsUpdate = true;
    bb.iData.needsUpdate = true;
  }

  function dispose() {
    offGfx();
    parent.remove(bb.mesh);
    bb.geo.dispose();
    bb.mat.dispose();
    bb.map.dispose();
  }

  return { update, dispose };
}

// ------------------------------------------------------------------ sparkles (house upgrade)

// Four-point twinkle star with a soft core, alpha channel only.
function makeSparkTexture() {
  const S = 64;
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = ((x + 0.5) / S - 0.5) * 2;
      const v = ((y + 0.5) / S - 0.5) * 2;
      const r2 = u * u + v * v;
      const core = Math.exp(-r2 * 22);
      const star = Math.max(Math.exp(-Math.abs(u) * 26 - Math.abs(v) * 2.6), Math.exp(-Math.abs(v) * 26 - Math.abs(u) * 2.6));
      const a = Math.min(1, core * 1.2 + star * 0.9) * Math.max(0, 1 - r2 * 0.9);
      const i = (y * S + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

const SPARKLE_CAP = 480;
const SPARKLES_PER_BURST = 40;

// Golden twinkling particle burst. burst(x, y, z) (building centre, ground height) spawns ~40 particles that rise and fade over ~2 s.
// Call update(dt) once per frame (allocation-free). Several bursts can overlap (cap 480 live particles).
export function createSparkles(parent) {
  const bb = makeBillboards(SPARKLE_CAP, { color: 0xffcf4a, additive: true, uShade: 0 });
  bb.mesh.name = 'sparkles';
  bb.mat.uniforms.uColor.value.setRGB(1.6, 1.15, 0.3); // over-bright gold so the additive glow reads on sunlit grass
  bb.map.dispose();
  bb.map = makeSparkTexture();
  bb.mat.uniforms.uMap.value = bb.map;
  bb.mesh.renderOrder = 6;
  parent.add(bb.mesh);

  const rand = mulberry32(777);
  const x = new Float32Array(SPARKLE_CAP);
  const y = new Float32Array(SPARKLE_CAP);
  const z = new Float32Array(SPARKLE_CAP);
  const vx = new Float32Array(SPARKLE_CAP);
  const vy = new Float32Array(SPARKLE_CAP);
  const vz = new Float32Array(SPARKLE_CAP);
  const age = new Float32Array(SPARKLE_CAP);
  const life = new Float32Array(SPARKLE_CAP);
  const size = new Float32Array(SPARKLE_CAP);
  const phase = new Float32Array(SPARKLE_CAP);
  const freq = new Float32Array(SPARKLE_CAP);
  let n = 0;

  function burst(bx, by, bz) {
    for (let k = 0; k < SPARKLES_PER_BURST && n < SPARKLE_CAP; k++) {
      const i = n++;
      const a = rand() * Math.PI * 2;
      const r = 1.3 + Math.sqrt(rand()) * 2.2; // a ring around the building so walls do not hide it
      x[i] = bx + Math.cos(a) * r;
      z[i] = bz + Math.sin(a) * r;
      y[i] = by + rand() * 1.2;
      vx[i] = (rand() - 0.5) * 0.5;
      vz[i] = (rand() - 0.5) * 0.5;
      vy[i] = 0.9 + rand() * 1.5;
      age[i] = -rand() * 0.35; // staggered start
      life[i] = 1.5 + rand() * 0.8;
      size[i] = 0.6 + rand() * 0.7;
      phase[i] = rand() * 6.283;
      freq[i] = 9 + rand() * 9;
    }
  }

  function update(dt) {
    const P = bb.iPos.array;
    const D = bb.iData.array;
    let live = 0;
    for (let i = 0; i < n;) {
      age[i] += dt;
      if (age[i] >= life[i]) { // swap-remove
        const l = --n;
        if (i !== l) {
          x[i] = x[l]; y[i] = y[l]; z[i] = z[l]; vx[i] = vx[l]; vy[i] = vy[l]; vz[i] = vz[l];
          age[i] = age[l]; life[i] = life[l]; size[i] = size[l]; phase[i] = phase[l]; freq[i] = freq[l];
        }
        continue;
      }
      if (age[i] > 0) {
        x[i] += vx[i] * dt; y[i] += vy[i] * dt; z[i] += vz[i] * dt;
        vy[i] *= 1 - 0.35 * dt;
      }
      const t = Math.max(0, age[i]) / life[i];
      const twinkle = 0.35 + 0.65 * Math.abs(Math.sin(age[i] * freq[i] + phase[i]));
      const fade = Math.min(1, t / 0.1) * (1 - t) * (1 - t * 0.3);
      const vis = age[i] > 0 ? 1 : 0;
      P[live * 3] = x[i]; P[live * 3 + 1] = y[i]; P[live * 3 + 2] = z[i];
      D[live * 4] = size[i] * (0.7 + 0.5 * twinkle) * (1 - 0.35 * t);
      D[live * 4 + 1] = vis * twinkle * fade;
      D[live * 4 + 2] = age[i] * 1.5 + phase[i];
      D[live * 4 + 3] = 0.5;
      live++;
      i++;
    }
    bb.geo.instanceCount = live;
    bb.iPos.needsUpdate = true;
    bb.iData.needsUpdate = true;
  }

  function dispose() {
    parent.remove(bb.mesh);
    bb.geo.dispose();
    bb.mat.dispose();
    bb.map.dispose();
  }

  return { burst, update, dispose };
}
