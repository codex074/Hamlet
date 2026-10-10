// Terrain mesh with baked vertex colours, a water plane, and a cheap wear/zone recolour pass.
import * as THREE from '../../vendor/three.module.js';
import { WORLD_SIZE, GRID, CELL, MAX_HEIGHT } from '../config.js';
import { smoothstep } from '../wear.js';

const VERTS = GRID + 1;
const WATER_Y = 0.05;

const C = (hex) => new THREE.Color(hex);
const GRASS_DRY = C(0x9aa84a);
const GRASS_LUSH = C(0x4f9a3c);
const HIGH_TINT = C(0xb9c27c);
const SAND = C(0xd8c58a);
const MUD = C(0x5b4a36);
const DIRT = C(0x8a6a45);
const RESIDENTIAL_TINT = C(0xc9a26a);
const FIELD_TINT = C(0xb59a4e);
const FIELD_DARK = C(0x8f7838);

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Deterministic per-vertex hash in [0,1).
function hash01(i) {
  const s = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

export function createTerrainMesh(terrain) {
  const { heights, fertility, water } = terrain;
  const count = VERTS * VERTS;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const base = new Float32Array(count * 3);

  const cellWater = (ix, iz) => {
    if (ix < 0 || iz < 0 || ix >= GRID || iz >= GRID) return 0;
    return water[iz * GRID + ix];
  };
  const cellFert = (ix, iz) => fertility[Math.min(GRID - 1, Math.max(0, iz)) * GRID + Math.min(GRID - 1, Math.max(0, ix))];

  const col = new THREE.Color();
  for (let iz = 0; iz < VERTS; iz++) {
    for (let ix = 0; ix < VERTS; ix++) {
      const i = iz * VERTS + ix;
      const h = heights[i];
      positions[i * 3] = ix * CELL;
      positions[i * 3 + 1] = h;
      positions[i * 3 + 2] = iz * CELL;

      // the four cells meeting at this vertex
      const wc = cellWater(ix - 1, iz - 1) + cellWater(ix, iz - 1) + cellWater(ix - 1, iz) + cellWater(ix, iz);
      const fert = (cellFert(ix - 1, iz - 1) + cellFert(ix, iz - 1) + cellFert(ix - 1, iz) + cellFert(ix, iz)) / 4;
      // fbm clusters around 0.5, so stretch it
      const f = clamp01((fert - 0.3) / 0.4);

      col.copy(GRASS_DRY).lerp(GRASS_LUSH, f);
      col.lerp(HIGH_TINT, clamp01(h / MAX_HEIGHT) * 0.35);
      // sand on banks / low ground, mud under water
      const lowSand = clamp01((0.9 - h) / 0.9) * 0.7;
      const sand = Math.max(wc > 0 ? 0.9 : 0, lowSand);
      col.lerp(SAND, sand);
      col.lerp(MUD, clamp01(wc / 4) * 0.9 + (h < -0.3 ? 0.3 : 0));
      // gentle speckle so large flats are not a single flat colour
      const v = 0.94 + hash01(i) * 0.12;
      col.multiplyScalar(v);

      base[i * 3] = col.r;
      base[i * 3 + 1] = col.g;
      base[i * 3 + 2] = col.b;
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
  const colorAttr = new THREE.BufferAttribute(colors, 3);
  colorAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('color', colorAttr);
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
  );
  mesh.receiveShadow = true;
  mesh.name = 'terrain';

  const waterGeo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE);
  waterGeo.rotateX(-Math.PI / 2);
  const waterMesh = new THREE.Mesh(
    waterGeo,
    new THREE.MeshLambertMaterial({
      color: 0x3b78a8, transparent: true, opacity: 0.8, depthWrite: false, flatShading: true,
    }),
  );
  waterMesh.position.set(WORLD_SIZE / 2, WATER_Y, WORLD_SIZE / 2);
  waterMesh.renderOrder = 1;
  waterMesh.name = 'water';

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
        const i = (iz * VERTS + ix) * 3;
        colors[i] += (DIRT.r - colors[i]) * t;
        colors[i + 1] += (DIRT.g - colors[i + 1]) * t;
        colors[i + 2] += (DIRT.b - colors[i + 2]) * t;
      }
    }
    colorAttr.needsUpdate = true;
  }

  return { mesh, water: waterMesh, updateWear };
}
