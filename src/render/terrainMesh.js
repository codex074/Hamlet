// Terrain mesh with baked vertex colours, a water plane, and a cheap wear/zone recolour pass.
import * as THREE from '../../vendor/three.module.js';
import { WORLD_SIZE, GRID, CELL, MAX_HEIGHT } from '../config.js';
import { smoothstep } from '../wear.js';
import { mulberry32, makeNoise2D, fbm } from '../rng.js';

const VERTS = GRID + 1;
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
  const { heights, fertility, water } = terrain;
  const count = VERTS * VERTS;
  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const colors = new Float32Array(count * 3);
  const base = new Float32Array(count * 3);
  const dirtShade = new Float32Array(count);

  const nBig = makeNoise2D(11);
  const nMid = makeNoise2D(12);
  const nSmall = makeNoise2D(13);

  const cellWater = (ix, iz) => {
    if (ix < 0 || iz < 0 || ix >= GRID || iz >= GRID) return 0;
    return water[iz * GRID + ix];
  };
  const cellFert = (ix, iz) => fertility[Math.min(GRID - 1, Math.max(0, iz)) * GRID + Math.min(GRID - 1, Math.max(0, ix))];
  const hAt = (ix, iz) => heights[Math.min(GRID, Math.max(0, iz)) * VERTS + Math.min(GRID, Math.max(0, ix))];

  const col = new THREE.Color();
  for (let iz = 0; iz < VERTS; iz++) {
    for (let ix = 0; ix < VERTS; ix++) {
      const i = iz * VERTS + ix;
      const h = heights[i];
      const x = ix * CELL;
      const z = iz * CELL;
      positions[i * 3] = x;
      positions[i * 3 + 1] = h;
      positions[i * 3 + 2] = z;
      uvs[i * 2] = x * UV_SCALE;
      uvs[i * 2 + 1] = z * UV_SCALE;

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

  const indices = new Uint32Array(GRID * GRID * 6);
  let k = 0;
  for (let iz = 0; iz < GRID; iz++) {
    for (let ix = 0; ix < GRID; ix++) {
      const a = iz * VERTS + ix;
      const b = a + 1;
      const c = a + VERTS;
      const d = c + 1;
      // alternate the diagonal for a less regular look
      if ((ix + iz) % 2 === 0) {
        indices[k++] = a; indices[k++] = c; indices[k++] = b;
        indices[k++] = b; indices[k++] = c; indices[k++] = d;
      } else {
        indices[k++] = a; indices[k++] = c; indices[k++] = d;
        indices[k++] = a; indices[k++] = d; indices[k++] = b;
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  const colorAttr = new THREE.BufferAttribute(colors, 3);
  colorAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('color', colorAttr);
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const detail = makeDetailTexture();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshLambertMaterial({ vertexColors: true, map: detail }),
  );
  mesh.receiveShadow = true;
  mesh.name = 'terrain';

  // ---- water: only quads near/below the water line, with per-vertex depth colour + alpha
  const wPos = [];
  const wCol = [];
  const wIdx = [];
  const wMap = new Int32Array(count).fill(-1);
  const depthAt = (i) => WATER_Y - heights[i];
  const useVert = (i) => {
    if (wMap[i] >= 0) return wMap[i];
    const ix = i % VERTS;
    const iz = (i - ix) / VERTS;
    const d = depthAt(i);
    const t = sstep(0.0, 0.8, d);
    const c = new THREE.Color().copy(WATER_SHALLOW).lerp(WATER_DEEP, t);
    const foam = sstep(0.16, -0.02, d);
    c.lerp(WATER_FOAM, foam * 0.55);
    const alpha = 0.3 + 0.62 * sstep(0.0, 0.75, d);
    wPos.push(ix * CELL, WATER_Y, iz * CELL);
    wCol.push(c.r, c.g, c.b, alpha);
    wMap[i] = wPos.length / 3 - 1;
    return wMap[i];
  };
  for (let iz = 0; iz < GRID; iz++) {
    for (let ix = 0; ix < GRID; ix++) {
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
  const waterGeo = new THREE.BufferGeometry();
  waterGeo.setAttribute('position', new THREE.Float32BufferAttribute(wPos, 3));
  waterGeo.setAttribute('color', new THREE.Float32BufferAttribute(wCol, 4));
  waterGeo.setIndex(wIdx);
  waterGeo.computeVertexNormals();
  waterGeo.computeBoundingSphere();

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
  const waterMesh = new THREE.Mesh(waterGeo, waterMat);
  waterMesh.renderOrder = 1;
  waterMesh.name = 'water';
  // self-animated: no update() call needed from the integrator
  waterMesh.onBeforeRender = () => { timeU.value = (typeof performance !== 'undefined' ? performance.now() : 0) / 1000; };

  const tmp = new THREE.Color();

  // Recolour: base -> zone tint -> wear (dirt paths on top). ~15k vertices, runs once a second.
  function updateWear(wear, zones = []) {
    colors.set(base);

    for (const z of zones) {
      const residential = z.kind === 'residential';
      const ix0 = Math.max(0, Math.floor((z.x - z.r) / CELL));
      const ix1 = Math.min(GRID, Math.ceil((z.x + z.r) / CELL));
      const iz0 = Math.max(0, Math.floor((z.z - z.r) / CELL));
      const iz1 = Math.min(GRID, Math.ceil((z.z + z.r) / CELL));
      for (let iz = iz0; iz <= iz1; iz++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const d = Math.hypot(ix * CELL - z.x, iz * CELL - z.z);
          if (d > z.r) continue;
          const i = (iz * VERTS + ix) * 3;
          tmp.setRGB(colors[i], colors[i + 1], colors[i + 2]);
          if (residential) {
            tmp.lerp(RESIDENTIAL_TINT, 0.22);
          } else {
            // ploughed furrows: alternate rows light / dark
            tmp.lerp(iz % 2 === 0 ? FIELD_TINT : FIELD_DARK, 0.6);
          }
          colors[i] = tmp.r; colors[i + 1] = tmp.g; colors[i + 2] = tmp.b;
        }
      }
    }

    for (let iz = 0; iz < VERTS; iz++) {
      const rz0 = Math.max(0, iz - 1) * GRID;
      const rz1 = Math.min(GRID - 1, iz) * GRID;
      for (let ix = 0; ix < VERTS; ix++) {
        const cx0 = Math.max(0, ix - 1);
        const cx1 = Math.min(GRID - 1, ix);
        // strongest of the four cells touching this vertex
        let w = wear[rz0 + cx0];
        const w1 = wear[rz0 + cx1];
        const w2 = wear[rz1 + cx0];
        const w3 = wear[rz1 + cx1];
        if (w1 > w) w = w1;
        if (w2 > w) w = w2;
        if (w3 > w) w = w3;
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
    colorAttr.needsUpdate = true;
  }

  return { mesh, water: waterMesh, updateWear };
}
