// Crops on the fields: plants along the furrow ridges of every field zone, of the crop its farm grows
// (wheat, corn, beans). They sprout in spring, stand green in summer, ripen in autumn and are stubble in
// winter; where a farmer just harvested they are cut down and grow back. A field without a farm stays bare.
// One InstancedMesh per (crop, look); rebuilt only when something visible changes.
import * as THREE from '../../vendor/three.module.js';
import { FIELD_RADIUS, CROPS } from '../config.js';
import { heightAt } from '../terrain.js';
import { seasonOf } from '../seasons.js';

const ROW = 2;                                          // furrow period (matches the terrain shader)
const STEP = { wheat: 0.5, corn: 0.95, beans: 0.8 };    // spacing along a row
const ROWS = { wheat: 2, corn: 1, beans: 1 };           // plant rows per furrow (wheat grows dense)
const MAX_PER_ZONE = 520;
const MAX_TOTAL = 7000;
const REGROW = 150;            // game seconds for a harvested patch to grow back
const CUT_R = 2.4;             // metres around a harvest spot that get cut
const REBUILD_EVERY = 0.5;     // seconds between checks

function hash(a, b) {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// ---------------------------------------------------------------- geometry (vertex-coloured, merged)

function part(geo, color, m) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.applyMatrix4(m);
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

function merge(parts) {
  let n = 0;
  for (const p of parts) n += p.attributes.position.count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) {
    pos.set(p.attributes.position.array, o);
    nor.set(p.attributes.normal.array, o);
    col.set(p.attributes.color.array, o);
    o += p.attributes.position.count * 3;
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

const M = () => new THREE.Matrix4();
const at = (x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
  M().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));

// A tuft of wheat: a few stalks with ears, leaning slightly apart.
function wheat(ripe) {
  const stalk = ripe ? 0xd6b35c : 0x7fae4a;
  const ear = ripe ? 0xe9c466 : 0x9cc25a;
  const l = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const lean = 0.1 + hash(i, 3) * 0.14;
    const h = 0.7 + hash(i, 7) * 0.25;
    const x = Math.cos(a) * 0.08;
    const z = Math.sin(a) * 0.08;
    l.push(part(new THREE.CylinderGeometry(0.014, 0.02, h, 4, 1, true), stalk,
      at(x + Math.cos(a) * h * lean * 0.5, h / 2, z + Math.sin(a) * h * lean * 0.5, Math.sin(a) * lean, 0, -Math.cos(a) * lean)));
    l.push(part(new THREE.SphereGeometry(0.042, 5, 3), ear,
      at(x + Math.cos(a) * h * lean, h + 0.04, z + Math.sin(a) * h * lean, Math.sin(a) * lean, 0, -Math.cos(a) * lean, 1, 2.6, 1)));
  }
  return merge(l);
}

// One corn plant: tall stalk, broad leaves, a cob, a tassel.
function corn(ripe) {
  const stalk = ripe ? 0xa8894e : 0x5f9a3e;
  const leaf = ripe ? 0x8a6a3a : 0x6aac46;   // dry brown leaves stand out from autumn grass
  const l = [];
  l.push(part(new THREE.CylinderGeometry(0.022, 0.032, 1.7, 5, 1, true), stalk, at(0, 0.85, 0)));
  for (let i = 0; i < 5; i++) {
    const y = 0.35 + i * 0.27;
    const a = i * 2.4;
    l.push(part(new THREE.BoxGeometry(0.55 - i * 0.05, 0.015, 0.1), leaf,
      at(Math.cos(a) * 0.2, y, Math.sin(a) * 0.2, 0, -a, -0.45 - hash(i, 2) * 0.25)));
  }
  l.push(part(new THREE.CylinderGeometry(0.06, 0.045, 0.3, 6), ripe ? 0xf4c62c : 0x8ab656, at(0.08, 0.95, 0, 0, 0, -0.35)));
  if (ripe) l.push(part(new THREE.CylinderGeometry(0.055, 0.04, 0.26, 6), 0xf4c62c, at(-0.07, 0.72, 0.03, 0, 0, 0.4)));   // a second cob
  if (ripe) l.push(part(new THREE.ConeGeometry(0.05, 0.12, 5), 0xa89a5c, at(0.1, 1.08, 0, 0, 0, -0.35)));   // open husk
  l.push(part(new THREE.ConeGeometry(0.06, 0.22, 5), ripe ? 0xb08a4a : 0xc8b860, at(0, 1.8, 0)));          // tassel
  return merge(l);
}

// A low bean bush with hanging pods.
function beans(ripe) {
  const leaf = ripe ? 0x7f8a3c : 0x4f8f3a;
  const pod = ripe ? 0xa48c4e : 0x7ab84c;
  const l = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    l.push(part(new THREE.IcosahedronGeometry(0.15 + hash(i, 5) * 0.05, 0), leaf,
      at(Math.cos(a) * 0.12, 0.2 + hash(i, 9) * 0.12, Math.sin(a) * 0.12, 0, a, 0, 1, 0.75, 1)));
  }
  l.push(part(new THREE.IcosahedronGeometry(0.16, 0), leaf, at(0, 0.38, 0, 0, 0, 0, 1, 0.8, 1)));
  for (let i = 0; i < 5; i++) {
    const a = i * 1.3;
    l.push(part(new THREE.CylinderGeometry(0.014, 0.01, 0.16, 4), pod, at(Math.cos(a) * 0.2, 0.17, Math.sin(a) * 0.2, 0.2, 0, 0.25)));
  }
  return merge(l);
}

// Cut stalks left after the harvest / in winter.
function stubble(crop) {
  const c = crop === 'beans' ? 0x8a7a48 : 0xb89a58;
  const l = [];
  const n = crop === 'corn' ? 1 : 4;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = n === 1 ? 0 : 0.05;
    const h = crop === 'corn' ? 0.22 : 0.1;
    l.push(part(new THREE.CylinderGeometry(crop === 'corn' ? 0.03 : 0.01, crop === 'corn' ? 0.035 : 0.013, h, 4), c,
      at(Math.cos(a) * r, h / 2, Math.sin(a) * r)));
  }
  return merge(l);
}

const BUILD = { wheat, corn, beans };

// ---------------------------------------------------------------- view

export function createCropsView(parent, terrain) {
  const root = new THREE.Group();
  root.name = 'crops';
  parent.add(root);
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.userData.noWeather = true;   // the crops show their own season; no autumn gold on gold wheat
  const looks = new Map();          // `${crop}|${look}` -> { geo, mesh, cap, n }
  let sig = '';
  let timer = 0;
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();

  function batch(crop, look, need) {
    const key = `${crop}|${look}`;
    let b = looks.get(key);
    if (!b) {
      const geo = look === 'stubble' ? stubble(crop) : BUILD[crop](look === 'ripe');
      b = { geo, mesh: null, cap: 0, n: 0 };
      looks.set(key, b);
    }
    if (need > b.cap) {
      if (b.mesh) { root.remove(b.mesh); b.mesh.dispose(); }
      b.cap = Math.max(64, Math.ceil(need * 1.3));
      b.mesh = new THREE.InstancedMesh(b.geo, mat, b.cap);
      b.mesh.frustumCulled = false;
      b.mesh.receiveShadow = true;
      root.add(b.mesh);
    }
    return b;
  }

  // Which farm works each field zone: the nearest farm within FIELD_RADIUS of its centre.
  function farmFor(state, zone) {
    let best = null;
    let bd = Infinity;
    for (const b of state.buildings) {
      if (b.type !== 'farmhouse' || !b.built) continue;
      const d = Math.hypot(b.x - zone.x, b.z - zone.z);
      if (d <= FIELD_RADIUS && d < bd) { best = b; bd = d; }
    }
    return best;
  }

  // Look and size of a plant right now: season stage, then any recent harvest near it.
  function stageOf(state) {
    const se = seasonOf(state);
    const t = se.progress;
    if (se.key === 'spring') return { look: 'green', scale: 0.25 + 0.6 * t };
    if (se.key === 'summer') return { look: t > 0.75 ? 'ripe' : 'green', scale: 0.85 + 0.15 * t };
    if (se.key === 'autumn') return { look: 'ripe', scale: 1 };
    return { look: 'stubble', scale: 1 };
  }

  function rebuild(state) {
    const fields = state.zones.filter((z) => z.kind === 'field').sort((a, b) => a.id - b.id);
    const stage = stageOf(state);
    const plants = [];   // { crop, x, z, look, scale, yaw }
    const taken = new Set();
    const now = state.time ?? 0;
    for (const zone of fields) {
      const farm = farmFor(state, zone);
      if (!farm) continue;   // nobody farms it: bare furrows
      const crop = farm.crop && CROPS[farm.crop] ? farm.crop : 'wheat';
      const cuts = (farm.harvests || []).filter((h) => now - h.t < REGROW);
      let step = STEP[crop];
      const area = Math.PI * zone.r * zone.r;
      while ((area / ((ROW / ROWS[crop]) * step)) > MAX_PER_ZONE) step *= 1.15;
      const rowGap = ROW / ROWS[crop];
      const z0 = Math.floor((zone.z - zone.r) / ROW) * ROW + rowGap * 0.25;   // on the ridge of each furrow
      for (let gz = z0; gz <= zone.z + zone.r; gz += rowGap) {
        const half = Math.sqrt(Math.max(0, zone.r * zone.r - (gz - zone.z) ** 2)) - 0.4;
        if (half <= 0) continue;
        const ix0 = Math.ceil((zone.x - half) / step);
        const ix1 = Math.floor((zone.x + half) / step);
        for (let ix = ix0; ix <= ix1; ix++) {
          const key = `${ix}|${Math.round(gz / rowGap)}|${crop}`;
          if (taken.has(key)) continue;   // overlapping strokes: one plant per spot
          taken.add(key);
          const x = ix * step + (hash(ix, gz) - 0.5) * step * 0.35;
          const z = gz + (hash(gz, ix) - 0.5) * 0.25;
          let look = stage.look;
          let scale = stage.scale * (0.85 + hash(ix * 3, gz) * 0.3);
          for (const h of cuts) {
            if (Math.hypot(h.x - x, h.z - z) > CUT_R) continue;
            const age = (now - h.t) / REGROW;   // 0 just cut .. 1 grown back
            if (age < 0.25 || stage.look === 'stubble') { look = 'stubble'; scale = 1; }
            else { look = 'green'; scale = Math.min(scale, 0.25 + 0.75 * age); }
            break;
          }
          plants.push({ crop, x, z, look, scale, yaw: hash(ix, gz * 7) * Math.PI * 2 });
          if (plants.length >= MAX_TOTAL) break;
        }
        if (plants.length >= MAX_TOTAL) break;
      }
    }

    const counts = new Map();
    for (const pl of plants) counts.set(`${pl.crop}|${pl.look}`, (counts.get(`${pl.crop}|${pl.look}`) || 0) + 1);
    for (const b of looks.values()) b.n = 0;
    for (const [key, n] of counts) { const [crop, look] = key.split('|'); batch(crop, look, n); }
    for (const pl of plants) {
      const b = looks.get(`${pl.crop}|${pl.look}`);
      e.set(0, pl.yaw, 0);
      q.setFromEuler(e);
      p.set(pl.x, heightAt(terrain, pl.x, pl.z) - 0.02, pl.z);
      s.set(pl.scale, pl.scale, pl.scale);
      m4.compose(p, q, s);
      b.mesh.setMatrixAt(b.n++, m4);
    }
    for (const b of looks.values()) {
      if (!b.mesh) continue;
      b.mesh.count = b.n;
      b.mesh.visible = b.n > 0;
      b.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  function update(state, dt) {
    timer -= dt;
    if (timer > 0) return;
    timer = REBUILD_EVERY;
    const fields = state.zones.filter((z) => z.kind === 'field');
    if (!fields.length && !sig) return;
    const now = state.time ?? 0;
    let farms = '';
    let regrowing = false;
    for (const b of state.buildings) {
      if (b.type !== 'farmhouse') continue;
      farms += `${b.id}:${b.built ? 1 : 0}:${b.crop || 'wheat'}:${(b.harvests || []).length}:${b.harvests?.at(-1)?.t ?? 0};`;
      if ((b.harvests || []).some((h) => now - h.t < REGROW)) regrowing = true;
    }
    const se = seasonOf(state);
    const stageKey = `${se.key}:${Math.floor(se.progress * 20)}`;
    let zsum = 0;
    for (const z of fields) zsum += z.id;
    const next = `${fields.length}|${zsum}|${farms}|${stageKey}|${regrowing ? Math.floor(now / 5) : ''}`;
    if (next === sig) return;
    sig = next;
    rebuild(state);
  }

  function dispose() {
    for (const b of looks.values()) { if (b.mesh) { root.remove(b.mesh); b.mesh.dispose(); } b.geo.dispose(); }
    mat.dispose();
    parent.remove(root);
  }

  return { update, dispose };
}
