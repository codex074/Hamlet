// Terrain split into 80 m chunks (each frustum culled), baked vertex colours, chunked water, and a cheap
// wear / zone / territory recolour pass. Reads terrain.size / terrain.grid (falls back to the small-map config).
import * as THREE from '../../vendor/three.module.js';
import { WORLD_SIZE, GRID, MAX_HEIGHT } from '../config.js';
import { smoothstep } from '../wear.js';
import { mulberry32, makeNoise2D, fbm } from '../rng.js';
import { setViewWorldSize } from './viewworld.js';

const CHUNK = 80;                 // metres per terrain chunk (frustum culled individually)
const WATER_Y = 0.05;
const UV_SCALE = 1 / 9; // detail texture repeats every 9 m

const C = (hex) => new THREE.Color(hex);
// meadow tones (blended with large-scale noise + fertility)
const GRASS_LUSH = C(0x5a9f3a);
const GRASS_MEADOW = C(0x93bd47);
const GRASS_DEEP = C(0x3c8838);
const GRASS_DRY = C(0xb5b04f);
const HIGH_TINT = C(0xaebb78);
const ROCK_EARTH = C(0x8a7b62);
const SAND = C(0xdcc78c);
const WET_SAND = C(0xb89f6c);
const MUD = C(0x5e4b34);
const BED = C(0x453a2c);
const DIRT = C(0x8c6a44);
const DUST = C(0xb28d5e);
const RESIDENTIAL_TINT = C(0xc9a26a);
const FIELD_TINT = C(0xb99c4c);
const FIELD_DARK = C(0x8f7838);
const WATER_SHALLOW = C(0x6fc6c2);
const WATER_DEEP = C(0x2b6f9e);
const WATER_FOAM = C(0xe4f4ee);

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const sstep = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };

// Deterministic per-vertex hash in [0,1).
function hash01(i) {
  const s = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

// Tileable mottled grey texture (multiplies the vertex colours). Null without a DOM (Node).
function makeDetailTexture() {
  if (typeof document === 'undefined') return null;
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  const rand = mulberry32(1337);
  ctx.fillStyle = 'rgb(236,236,236)';
  ctx.fillRect(0, 0, S, S);
  const wrapDraw = (x, y, rad, fn) => {
    for (const dx of [0, S, -S]) for (const dy of [0, S, -S]) {
      if (x + dx + rad < 0 || x + dx - rad > S || y + dy + rad < 0 || y + dy - rad > S) continue;
      fn(x + dx, y + dy);
    }
  };
  // soft light / dark mottling
  for (let i = 0; i < 260; i++) {
    const x = rand() * S; const y = rand() * S; const r = 10 + rand() * 34;
    const v = rand() < 0.45 ? 255 : 170;
    wrapDraw(x, y, r, (px, py) => {
      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, `rgba(${v},${v},${v},${0.14 + rand() * 0.16})`);
      g.addColorStop(1, `rgba(${v},${v},${v},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(px - r, py - r, r * 2, r * 2);
    });
  }
  // tiny grass strokes
  ctx.lineCap = 'round';
  for (let i = 0; i < 2600; i++) {
    const x = rand() * S; const y = rand() * S;
    const a = -Math.PI / 2 + (rand() - 0.5) * 1.3;
    const l = 3 + rand() * 6;
    const light = rand() < 0.45;
    const v = light ? 255 : 170 + rand() * 30;
    ctx.strokeStyle = `rgba(${v},${v},${v},${0.18 + rand() * 0.3})`;
    ctx.lineWidth = 0.8 + rand() * 0.9;
    wrapDraw(x, y, l, (px, py) => {
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l);
      ctx.stroke();
    });
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace; // greyscale multiplier
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}


export function createTerrainMesh(terrain) {
  const SIZE = terrain.size || WORLD_SIZE;
  const G = terrain.grid || GRID;
  setViewWorldSize(SIZE);
  const CELL = SIZE / G;
  const VERTS = G + 1;
  const { heights, fertility, water } = terrain;
  const count = VERTS * VERTS;
  const base = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);   // full-grid working colours; chunks copy their slice
  const dirtShade = new Float32Array(count);

  const nBig = makeNoise2D(11);
  const nMid = makeNoise2D(12);
  const nSmall = makeNoise2D(13);

  const cellWater = (ix, iz) => {
    if (ix < 0 || iz < 0 || ix >= G || iz >= G) return 0;
    return water[iz * G + ix];
  };
  const cellFert = (ix, iz) => fertility[Math.min(G - 1, Math.max(0, iz)) * G + Math.min(G - 1, Math.max(0, ix))];
  const hAt = (ix, iz) => heights[Math.min(G, Math.max(0, iz)) * VERTS + Math.min(G, Math.max(0, ix))];

  const col = new THREE.Color();
  for (let iz = 0; iz < VERTS; iz++) {
    for (let ix = 0; ix < VERTS; ix++) {
      const i = iz * VERTS + ix;
      const h = heights[i];
      const x = ix * CELL;
      const z = iz * CELL;

      // the four cells meeting at this vertex
      const wc = cellWater(ix - 1, iz - 1) + cellWater(ix, iz - 1) + cellWater(ix - 1, iz) + cellWater(ix, iz);
      const fert = (cellFert(ix - 1, iz - 1) + cellFert(ix, iz - 1) + cellFert(ix - 1, iz) + cellFert(ix, iz)) / 4;
      const f = clamp01((fert - 0.3) / 0.4); // fbm clusters around 0.5, so stretch it
      const slope = Math.hypot(hAt(ix + 1, iz) - hAt(ix - 1, iz), hAt(ix, iz + 1) - hAt(ix, iz - 1)) / (4 * CELL) * 2;

      // --- grass: blend 3-4 tones with large-scale noise, fertility and small-scale noise
      const big = clamp01((fbm(nBig, x * 0.022, z * 0.022, 3) - 0.5) * 3.2 + 0.5);
      const mid = clamp01((fbm(nMid, x * 0.055, z * 0.055, 2) - 0.5) * 2.6 + 0.5);
      col.copy(GRASS_LUSH).lerp(GRASS_MEADOW, sstep(0.3, 0.7, big));
      col.lerp(GRASS_DEEP, f * 0.42 * (1 - sstep(0.5, 0.9, big) * 0.5));
      col.lerp(GRASS_DRY, (1 - f) * sstep(0.55, 0.8, mid) * 0.55);
      col.lerp(HIGH_TINT, clamp01(h / MAX_HEIGHT) * 0.3);
      col.lerp(ROCK_EARTH, sstep(0.45, 1.0, slope) * 0.75);
      // small-scale breakup
      const sm = fbm(nSmall, x * 0.42, z * 0.42, 2);
      col.multiplyScalar(0.86 + sm * 0.28 + (hash01(i) - 0.5) * 0.07);

      // --- river banks and bed
      const sandAmt = Math.max(wc > 0 ? 0.85 : 0, sstep(1.1, 0.15, h) * 0.8) * (1 - sstep(0.4, 0.9, slope));
      col.lerp(SAND, sandAmt);
      col.lerp(WET_SAND, sstep(0.45, 0.0, h) * 0.6);
      col.lerp(MUD, clamp01(wc / 4) * 0.55 + (h < -0.2 ? 0.35 : 0));
      col.lerp(BED, sstep(-0.1, -0.6, h) * 0.7);

      base[i * 3] = col.r;
      base[i * 3 + 1] = col.g;
      base[i * 3 + 2] = col.b;
      dirtShade[i] = 0.9 + hash01(i * 1.7 + 3) * 0.2;
    }
  }
  colors.set(base);

  // Smooth global normals (central differences) so chunk borders have no lighting seams.
  const normals = new Float32Array(count * 3);
  for (let iz = 0; iz < VERTS; iz++) {
    for (let ix = 0; ix < VERTS; ix++) {
      const nx = hAt(ix - 1, iz) - hAt(ix + 1, iz);
      const nz = hAt(ix, iz - 1) - hAt(ix, iz + 1);
      const ny = 2 * CELL;
      const l = Math.hypot(nx, ny, nz) || 1;
      const i = (iz * VERTS + ix) * 3;
      normals[i] = nx / l; normals[i + 1] = ny / l; normals[i + 2] = nz / l;
    }
  }

  const detail = makeDetailTexture();
  const terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true, map: detail });

  // ---- zones: one world-space mask (R = residential, G = field) read by the terrain shader, so every
  // brush stroke merges into a single painted patch (no stacked circles). The hook is installed here, at
  // creation, before weather.js wraps the material's onBeforeCompile for snow / rain / autumn.
  const ZONE_PX = 2;   // mask pixels per metre
  const zonePx = Math.min(2048, Math.round(SIZE * ZONE_PX));
  const zoneCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  let zoneTex = null;
  if (zoneCanvas) {
    zoneCanvas.width = zoneCanvas.height = zonePx;
    zoneTex = new THREE.CanvasTexture(zoneCanvas);
    zoneTex.flipY = false;   // canvas row = world z
    zoneTex.generateMipmaps = false;
    zoneTex.minFilter = zoneTex.magFilter = THREE.LinearFilter;
    zoneTex.wrapS = zoneTex.wrapT = THREE.ClampToEdgeWrapping;
  }
  const zoneU = {
    uZoneMap: { value: zoneTex }, uZoneSize: { value: SIZE }, uZoneOn: { value: 0 },
    uResTint: { value: RESIDENTIAL_TINT.clone() }, uFieldTint: { value: FIELD_TINT.clone() }, uFieldDark: { value: FIELD_DARK.clone() },
  };
  terrainMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, zoneU);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vZoneXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvZoneXZ = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uZoneMap; uniform float uZoneSize; uniform float uZoneOn;
uniform vec3 uResTint; uniform vec3 uFieldTint; uniform vec3 uFieldDark;
varying vec2 vZoneXZ;
float zHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float zNoise( vec2 p ) {
  vec2 i = floor( p ); vec2 f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( zHash( i ), zHash( i + vec2( 1.0, 0.0 ) ), f.x ), mix( zHash( i + vec2( 0.0, 1.0 ) ), zHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
if ( uZoneOn > 0.5 ) {
  vec2 zm = texture2D( uZoneMap, vZoneXZ / uZoneSize ).rg;
  float jit = ( zNoise( vZoneXZ * 0.9 ) - 0.5 ) * 0.22;   // brushy, slightly uneven edge
  float res = smoothstep( 0.32 + jit, 0.6 + jit, zm.r );
  float fld = smoothstep( 0.32 + jit, 0.6 + jit, zm.g );
  float resRim = smoothstep( 0.18 + jit, 0.34 + jit, zm.r ) * ( 1.0 - smoothstep( 0.34 + jit, 0.52 + jit, zm.r ) );
  float fldRim = smoothstep( 0.18 + jit, 0.34 + jit, zm.g ) * ( 1.0 - smoothstep( 0.34 + jit, 0.52 + jit, zm.g ) );
  vec3 c = diffuseColor.rgb;
  c = mix( c, uResTint, res * 0.32 );
  float furrow = 0.5 + 0.5 * sin( vZoneXZ.y * 3.14159 );   // 2 m rows, continuous across strokes
  c = mix( c, mix( uFieldDark, uFieldTint, smoothstep( 0.25, 0.75, furrow ) ), fld * 0.62 );
  c *= 1.0 - 0.16 * max( resRim, fldRim );                 // soft outline only around the outer border
  diffuseColor.rgb = c;
}`);
  };
  terrainMat.customProgramCacheKey = () => 'terrain-zones';
  let zoneSig = '';
  // Redraws the mask when the zone set changes (cheap to call every frame).
  function setZones(zones = []) {
    let sum = 0;
    for (const z of zones) sum += z.id;
    const sig = `${zones.length}|${sum}`;
    if (sig === zoneSig || !zoneCanvas) return;
    zoneSig = sig;
    const ctx = zoneCanvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, zonePx, zonePx);
    ctx.globalCompositeOperation = 'lighter';   // channels add: residential (R) and field (G) never mix up
    const k = zonePx / SIZE;
    for (const z of zones) {
      ctx.fillStyle = z.kind === 'field' ? 'rgb(0,255,0)' : 'rgb(255,0,0)';
      ctx.beginPath();
      ctx.arc(z.x * k, z.z * k, z.r * k, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    zoneTex.needsUpdate = true;
    zoneU.uZoneOn.value = zones.length > 0 ? 1 : 0;
  }
  const cellsPerChunk = Math.max(1, Math.round(CHUNK / CELL));
  const nChunks = Math.ceil(G / cellsPerChunk);

  const group = new THREE.Group();
  group.name = 'terrain';
  const chunks = [];       // { mesh, colorAttr, ix0, iz0, w, h }
  const indexCache = new Map();

  function chunkIndex(w, h, parity) {
    const key = `${w}x${h}x${parity}`;
    let idx = indexCache.get(key);
    if (idx) return idx;
    const vw = w + 1;
    idx = (vw * (h + 1) > 65535 ? new Uint32Array(w * h * 6) : new Uint16Array(w * h * 6));
    let k = 0;
    for (let iz = 0; iz < h; iz++) {
      for (let ix = 0; ix < w; ix++) {
        const a = iz * vw + ix;
        const b = a + 1;
        const c = a + vw;
        const d = c + 1;
        if ((ix + iz + parity) % 2 === 0) {
          idx[k++] = a; idx[k++] = c; idx[k++] = b;
          idx[k++] = b; idx[k++] = c; idx[k++] = d;
        } else {
          idx[k++] = a; idx[k++] = c; idx[k++] = d;
          idx[k++] = a; idx[k++] = d; idx[k++] = b;
        }
      }
    }
    indexCache.set(key, idx);
    return idx;
  }

  for (let cz = 0; cz < nChunks; cz++) {
    for (let cx = 0; cx < nChunks; cx++) {
      const ix0 = cx * cellsPerChunk;
      const iz0 = cz * cellsPerChunk;
      const w = Math.min(cellsPerChunk, G - ix0);
      const h = Math.min(cellsPerChunk, G - iz0);
      const vw = w + 1;
      const vh = h + 1;
      const pos = new Float32Array(vw * vh * 3);
      const nor = new Float32Array(vw * vh * 3);
      const uv = new Float32Array(vw * vh * 2);
      const clr = new Float32Array(vw * vh * 3);
      for (let j = 0; j < vh; j++) {
        for (let i = 0; i < vw; i++) {
          const gi = (iz0 + j) * VERTS + (ix0 + i);
          const li = j * vw + i;
          pos[li * 3] = (ix0 + i) * CELL;
          pos[li * 3 + 1] = heights[gi];
          pos[li * 3 + 2] = (iz0 + j) * CELL;
          nor[li * 3] = normals[gi * 3]; nor[li * 3 + 1] = normals[gi * 3 + 1]; nor[li * 3 + 2] = normals[gi * 3 + 2];
          uv[li * 2] = (ix0 + i) * CELL * UV_SCALE;
          uv[li * 2 + 1] = (iz0 + j) * CELL * UV_SCALE;
          clr[li * 3] = base[gi * 3]; clr[li * 3 + 1] = base[gi * 3 + 1]; clr[li * 3 + 2] = base[gi * 3 + 2];
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      const colorAttr = new THREE.BufferAttribute(clr, 3);
      colorAttr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('color', colorAttr);
      geo.setIndex(new THREE.BufferAttribute(chunkIndex(w, h, (ix0 + iz0) % 2), 1));
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      const mesh = new THREE.Mesh(geo, terrainMat);
      mesh.receiveShadow = true;
      mesh.name = `terrain-${cx}-${cz}`;
      group.add(mesh);
      chunks.push({ mesh, colorAttr, ix0, iz0, w, h, vw });
    }
  }
  // Ray picks call intersectObject(group, false): forward to the chunk meshes (cheap bounding-sphere reject each).
  group.raycast = (raycaster, intersects) => {
    for (const c of chunks) c.mesh.raycast(raycaster, intersects);
  };

  // ---- water: chunked too; only quads near/below the water line, with per-vertex depth colour + alpha
  const waterGroup = new THREE.Group();
  waterGroup.name = 'water';
  const timeU = { value: 0 };
  const waterMat = new THREE.MeshStandardMaterial({
    vertexColors: true, transparent: true, depthWrite: false, roughness: 0.28, metalness: 0,
  });
  waterMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = timeU;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying vec3 vWPos;')
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec2 q = vWPos.xz;
  float s = sin( q.x * 1.7 - uTime * 0.9 + sin( q.y * 0.8 + uTime * 0.5 ) * 2.0 ) * sin( q.y * 2.1 + uTime * 0.7 + q.x * 0.6 );
  diffuseColor.rgb *= 0.95 + 0.07 * s;
}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  vec2 p = vWPos.xz;
  float t = uTime;
  vec2 g = vec2(
    cos( p.x * 0.9 - t * 1.1 + sin( p.y * 0.6 + t * 0.7 ) * 1.5 ) * 0.9 + cos( p.x * 2.3 - p.y * 1.7 + t * 1.9 ) * 0.5,
    cos( p.y * 1.1 - t * 0.9 + sin( p.x * 0.5 + t * 0.6 ) * 1.5 ) * 0.9 + cos( p.y * 2.1 + p.x * 1.3 - t * 1.7 ) * 0.5 );
  vec3 gw = vec3( g.x, 0.0, g.y ) * 0.06;
  normal = normalize( normal + ( viewMatrix * vec4( gw, 0.0 ) ).xyz );
}`);
  };
  const depthAt = (i) => WATER_Y - heights[i];
  const waterTmp = new THREE.Color();
  const waterOnBefore = () => { timeU.value = (typeof performance !== 'undefined' ? performance.now() : 0) / 1000; };

  for (const ch of chunks) {
    const wPos = [];
    const wCol = [];
    const wIdx = [];
    const wMap = new Map();
    const useVert = (i) => {
      let v = wMap.get(i);
      if (v !== undefined) return v;
      const ix = i % VERTS;
      const iz = (i - ix) / VERTS;
      const d = depthAt(i);
      const t = sstep(0.0, 0.8, d);
      waterTmp.copy(WATER_SHALLOW).lerp(WATER_DEEP, t);
      const foam = sstep(0.16, -0.02, d);
      waterTmp.lerp(WATER_FOAM, foam * 0.55);
      const alpha = 0.3 + 0.62 * sstep(0.0, 0.75, d);
      wPos.push(ix * CELL, WATER_Y, iz * CELL);
      wCol.push(waterTmp.r, waterTmp.g, waterTmp.b, alpha);
      v = wPos.length / 3 - 1;
      wMap.set(i, v);
      return v;
    };
    for (let j = 0; j < ch.h; j++) {
      for (let i = 0; i < ch.w; i++) {
        const ix = ch.ix0 + i;
        const iz = ch.iz0 + j;
        const a = iz * VERTS + ix;
        const b = a + 1;
        const c = a + VERTS;
        const d = c + 1;
        if (depthAt(a) < -0.25 && depthAt(b) < -0.25 && depthAt(c) < -0.25 && depthAt(d) < -0.25) continue;
        const va = useVert(a); const vb = useVert(b); const vc = useVert(c); const vd = useVert(d);
        if ((ix + iz) % 2 === 0) wIdx.push(va, vc, vb, vb, vc, vd);
        else wIdx.push(va, vc, vd, va, vd, vb);
      }
    }
    if (!wIdx.length) continue;
    const up = new Float32Array(wPos.length);
    for (let k = 1; k < up.length; k += 3) up[k] = 1;
    const waterGeo = new THREE.BufferGeometry();
    waterGeo.setAttribute('position', new THREE.Float32BufferAttribute(wPos, 3));
    waterGeo.setAttribute('normal', new THREE.BufferAttribute(up, 3));
    waterGeo.setAttribute('color', new THREE.Float32BufferAttribute(wCol, 4));
    waterGeo.setIndex(wIdx);
    waterGeo.computeBoundingSphere();
    const wm = new THREE.Mesh(waterGeo, waterMat);
    wm.renderOrder = 1;
    wm.name = 'water-chunk';
    wm.onBeforeRender = waterOnBefore;   // self-animated: no update() call needed from the integrator
    waterGroup.add(wm);
  }

  const tmp = new THREE.Color();

  // ---- territory: unowned land is desaturated and darkened (per-vertex amount 0..1, blended over the border cell)
  let unowned = null;          // Float32Array(count) or null when everything is owned
  let territorySig = '';
  let lastWear = null;

  function setTerritory(territory) {
    const owned = territory && territory.owned;
    if (!owned || !owned.length) {
      if (unowned) { unowned = null; territorySig = ''; recolor(); }
      return;
    }
    let sig = owned.length + ':';
    for (let i = 0; i < owned.length; i++) sig += owned[i] ? '1' : '0';
    if (sig === territorySig) return;
    territorySig = sig;
    const plots = Math.max(1, Math.round(Math.sqrt(owned.length)));
    const plot = SIZE / plots;
    let allOwned = true;
    for (let i = 0; i < owned.length; i++) if (!owned[i]) { allOwned = false; break; }
    if (allOwned) { unowned = null; recolor(); return; }
    const cellVal = new Float32Array(G * G);
    for (let iz = 0; iz < G; iz++) {
      const pz = Math.min(plots - 1, Math.floor(((iz + 0.5) * CELL) / plot));
      for (let ix = 0; ix < G; ix++) {
        const px = Math.min(plots - 1, Math.floor(((ix + 0.5) * CELL) / plot));
        cellVal[iz * G + ix] = owned[pz * plots + px] ? 0 : 1;
      }
    }
    const u = new Float32Array(count);
    for (let iz = 0; iz < VERTS; iz++) {
      for (let ix = 0; ix < VERTS; ix++) {
        const x0 = Math.max(0, ix - 1);
        const x1 = Math.min(G - 1, ix);
        const z0 = Math.max(0, iz - 1);
        const z1 = Math.min(G - 1, iz);
        u[iz * VERTS + ix] = (cellVal[z0 * G + x0] + cellVal[z0 * G + x1] + cellVal[z1 * G + x0] + cellVal[z1 * G + x1]) / 4;
      }
    }
    unowned = u;
    recolor();
  }

  // Recolour: base -> wear (dirt paths) -> unowned dimming, then copy into the chunks. Zones are painted by
  // the shader from the zone mask (setZones).
  function recolor() {
    colors.set(base);
    const wear = lastWear;
    if (wear && wear.length) {
      const wg = Math.round(Math.sqrt(wear.length));   // wear grid is derived from the array itself
      const wcell = SIZE / wg;
      const ratio = wcell / CELL;
      const wAtCell = (cx, cz) => wear[Math.min(wg - 1, Math.max(0, cz)) * wg + Math.min(wg - 1, Math.max(0, cx))];
      for (let iz = 0; iz < VERTS; iz++) {
        for (let ix = 0; ix < VERTS; ix++) {
          // strongest of the (up to) four wear cells touching this vertex
          const px = (ix * CELL) / wcell;
          const pz = (iz * CELL) / wcell;
          const fx = Math.floor(px);
          const fz = Math.floor(pz);
          const onX = ratio <= 1 && Math.abs(px - fx) < 1e-6;
          const onZ = ratio <= 1 && Math.abs(pz - fz) < 1e-6;
          let w;
          if (onX && onZ) {
            w = wAtCell(fx - 1, fz - 1);
            const w1 = wAtCell(fx, fz - 1); if (w1 > w) w = w1;
            const w2 = wAtCell(fx - 1, fz); if (w2 > w) w = w2;
            const w3 = wAtCell(fx, fz); if (w3 > w) w = w3;
          } else {
            w = wAtCell(fx, fz);
          }
          if (w <= 0.15) continue;
          const t = smoothstep(0.15, 0.8, w);
          const vi = iz * VERTS + ix;
          const i = vi * 3;
          // trodden earth: dusty-light where well worn, mottled per vertex
          tmp.copy(DIRT).lerp(DUST, smoothstep(0.55, 1, w) * 0.5).multiplyScalar(dirtShade[vi]);
          colors[i] += (tmp.r - colors[i]) * t;
          colors[i + 1] += (tmp.g - colors[i + 1]) * t;
          colors[i + 2] += (tmp.b - colors[i + 2]) * t;
        }
      }
    }

    if (unowned) {
      for (let vi = 0; vi < count; vi++) {
        const a = unowned[vi];
        if (a <= 0.001) continue;
        const i = vi * 3;
        const r = colors[i]; const g = colors[i + 1]; const b = colors[i + 2];
        const lum = 0.3 * r + 0.59 * g + 0.11 * b;
        const dim = 1 - 0.34 * a;
        const sat = 1 - 0.62 * a;
        colors[i] = (lum + (r - lum) * sat) * dim;
        colors[i + 1] = (lum + (g - lum) * sat) * dim;
        colors[i + 2] = (lum + (b - lum) * sat * 0.9) * dim;
      }
    }

    for (const ch of chunks) {
      const arr = ch.colorAttr.array;
      let changed = false;
      for (let j = 0; j <= ch.h; j++) {
        let gi = ((ch.iz0 + j) * VERTS + ch.ix0) * 3;
        let li = j * ch.vw * 3;
        for (let n = 0; n < ch.vw * 3; n++, gi++, li++) {
          if (arr[li] !== colors[gi]) { arr[li] = colors[gi]; changed = true; }
        }
      }
      if (changed) ch.colorAttr.needsUpdate = true;
    }
  }

  // wear: Float32Array (any square grid); zones: [{kind,x,z,r}]; territory: state.territory (optional here —
  // the world view also pushes it via group.userData.setTerritory).
  function updateWear(wear, zones = [], territory) {
    lastWear = wear;
    setZones(zones);
    if (territory !== undefined) {
      // setTerritory() recolours on change; otherwise recolour here
      const before = territorySig;
      setTerritory(territory);
      if (territorySig !== before) return;
    }
    recolor();
  }

  group.userData.setTerritory = setTerritory;
  group.userData.size = SIZE;

  function dispose() {
    for (const c of chunks) c.mesh.geometry.dispose();
    for (const m of waterGroup.children) m.geometry.dispose();
    terrainMat.dispose();
    waterMat.dispose();
    if (detail) detail.dispose();
    if (zoneTex) zoneTex.dispose();
  }

  return { mesh: group, water: waterGroup, updateWear, setTerritory, setZones, dispose };
}
