// Procedural storybook-medieval models: a small "kit of parts" (timber frames, roofs, windows, doors,
// props) baked into ONE merged mesh per material. Textures come from ./textures.js (all procedural).
// Buildings face +z (door on the +z side) and have their origin at ground centre.
//
// Public API:
//   MAT, WINDOW_MATERIALS, NODE_MODELS, VILLAGER_MODEL, CARRY_MODEL           (unchanged shapes)
//   makeBuildingModel(type, { level = 1, stage = 0, seed = 0 } = {}) -> THREE.Group
//   makeSiteModel(radius = 4, seed = 0) -> THREE.Group
// group.userData.chimneys = [{x,y,z}, ...] (local chimney-top positions, for smoke).
// Named children: 'sails' (mill; spin rotation.z), 'sawblade' (sawmill; spin rotation.z), 'flag' (townhall).
import * as THREE from '../../vendor/three.module.js';
import { BUILDINGS } from '../config.js';
import { getTexture } from './textures.js';

// ---------------------------------------------------------------- legacy flat materials (kept for compatibility)

function lambert(color, extra = {}) {
  return new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
}

export const MAT = {
  thatch: lambert(0xc59b3f),
  thatchDark: lambert(0x8f6a2e),
  timber: lambert(0x5a3d26),
  timberLight: lambert(0xa8814f),
  plank: lambert(0xd0a870),
  plaster: lambert(0xe8dcc0),
  daub: lambert(0xb89f72),
  stone: lambert(0x8f8f8a),
  stoneDark: lambert(0x6c6c68),
  stoneLight: lambert(0xb4b2a8),
  tile: lambert(0x9a4b30),
  slate: lambert(0x585d6c),
  door: lambert(0x3e2a1a),
  iron: lambert(0x6a6e75),
  gold: lambert(0xd9a92e),
  red: lambert(0xb0302a),
  cloth: lambert(0xe9e2cc, { side: THREE.DoubleSide }),
  hay: lambert(0xd8b650),
  barrel: lambert(0x7a5230),
  basket: lambert(0xb48a52),
  berry: lambert(0xb0204a),
  dark: lambert(0x1c1815),
};

// ---------------------------------------------------------------- real materials

// Every material that should glow at night. world.js drives emissiveIntensity on these.
export const WINDOW_MATERIALS = [];

function glassMat(color, emissive) {
  const m = new THREE.MeshLambertMaterial({
    color, emissive: new THREE.Color(emissive), emissiveIntensity: 0, flatShading: true,
  });
  WINDOW_MATERIALS.push(m);
  return m;
}

const WINDOW = glassMat(0x2c3340, 0xffc060);
const STAINED = [
  glassMat(0x8a1f2a, 0xff3040),
  glassMat(0x1f3f8a, 0x3060ff),
  glassMat(0xb08a1a, 0xffc830),
  glassMat(0x1f7a3a, 0x30d060),
];

// key -> [texture name, metres per texture repeat]
const TEXSPEC = {
  plaster: ['plaster', 5], timber: ['timber', 2.4], planks: ['planks', 2], thatch: ['thatch', 2.4],
  shingles: ['shingles', 2.2], slate: ['slate', 2.4], tiles: ['roofTiles', 2.4], stone: ['stoneWall', 3],
  cobble: ['cobble', 2], hay: ['hay', 1.6], flat: [null, 1], cloth: [null, 1],
};
const SOLID = {};
for (const key of Object.keys(TEXSPEC)) {
  SOLID[key] = new THREE.MeshLambertMaterial({
    color: 0xffffff, vertexColors: true, side: key === 'cloth' ? THREE.DoubleSide : THREE.FrontSide,
  });
}
const PARTMAT = { ...SOLID, win: WINDOW, st0: STAINED[0], st1: STAINED[1], st2: STAINED[2], st3: STAINED[3] };
const AO_KEYS = new Set(['plaster', 'timber', 'planks', 'stone', 'cobble', 'hay', 'flat']);

let mapsReady = false;
function ensureMaps() {
  if (mapsReady) return;
  mapsReady = true;
  for (const [key, [tex]] of Object.entries(TEXSPEC)) {
    if (!tex) continue;
    SOLID[key].map = getTexture(tex);
    SOLID[key].needsUpdate = true;
  }
}

// ---------------------------------------------------------------- rng + colour

function makeRng(seed) {
  let a = (Math.imul((seed | 0) ^ 0x9e3779b9, 2654435761) + 0x7f4a7c15) >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.range = (lo, hi) => lo + (hi - lo) * r();
  r.int = (n) => Math.floor(r() * n);
  r.pick = (arr) => arr[Math.floor(r() * arr.length) % arr.length];
  r.chance = (p) => r() < p;
  r.sign = () => (r() < 0.5 ? -1 : 1);
  return r;
}

const _col = new THREE.Color();
const colCache = new Map();
function rgb(c) {
  if (c === undefined || c === null) return [1, 1, 1];
  if (Array.isArray(c)) return c;
  let v = colCache.get(c);
  if (!v) { _col.set(c); v = [_col.r, _col.g, _col.b]; colCache.set(c, v); }
  return v;
}

// ---------------------------------------------------------------- raw geometry generators
// A geometry is { p: [x,y,z...], n: [..], u: [u,v...] } (non-indexed, flat shaded, CCW = outside).
// u/v are in metres; NaN means "box-project me from the final position".

function newGeo() { return { p: [], n: [], u: [] }; }

function tri(g, a, b, c, ua, ub, uc) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz);
  if (l < 1e-9) return;
  nx /= l; ny /= l; nz /= l;
  g.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  g.n.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  if (ua) g.u.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
  else g.u.push(NaN, NaN, NaN, NaN, NaN, NaN);
}

function quadG(g, a, b, c, d, ua, ub, uc, ud) {
  tri(g, a, b, c, ua, ub, uc);
  tri(g, a, c, d, ua, uc, ud);
}

// Box / square frustum, base at y=0 centred on xz. ys = extra horizontal split fractions.
// o.uv -> explicit slanted-face uvs (roofs, spires); else NaN (box projection).
function frustum(w0, d0, w1, d1, h, o = {}) {
  const g = newGeo();
  const ys = [0, ...(o.ys || []), 1];
  const lv = ys.map((t) => ({ y: t * h, hw: (w0 + (w1 - w0) * t) / 2, hd: (d0 + (d1 - d0) * t) / 2 }));
  const tip = w1 < 1e-4 && d1 < 1e-4;
  let vAcc = [0, 0, 0, 0];
  for (let i = 0; i < lv.length - 1; i++) {
    const A = lv[i], B = lv[i + 1];
    const last = i === lv.length - 2;
    const faces0 = [
      // [BL, BR, TR, TL] for +z, +x, -z, -x
      [[-A.hw, A.y, A.hd], [A.hw, A.y, A.hd], [B.hw, B.y, B.hd], [-B.hw, B.y, B.hd], A.hw, B.hw, Math.hypot(h * (B.y - A.y) / h, (B.hd - A.hd))],
      [[A.hw, A.y, A.hd], [A.hw, A.y, -A.hd], [B.hw, B.y, -B.hd], [B.hw, B.y, B.hd], A.hd, B.hd, Math.hypot(B.y - A.y, B.hw - A.hw)],
      [[A.hw, A.y, -A.hd], [-A.hw, A.y, -A.hd], [-B.hw, B.y, -B.hd], [B.hw, B.y, -B.hd], A.hw, B.hw, Math.hypot(B.y - A.y, B.hd - A.hd)],
      [[-A.hw, A.y, -A.hd], [-A.hw, A.y, A.hd], [-B.hw, B.y, B.hd], [-B.hw, B.y, -B.hd], A.hd, B.hd, Math.hypot(B.y - A.y, B.hw - A.hw)],
    ];
    const faces = o.nbk ? faces0.map((f, i) => (i === 2 ? null : f)) : faces0;
    faces.forEach((f, fi) => {
      if (!f) return;
      const [bl, br, tr, tl, ha, hb, slant] = f;
      const v0 = vAcc[fi];
      const v1 = v0 + slant;
      const uv = o.uv;
      const uo = (o.uo || 0) + fi * 0.37;
      if (last && tip) {
        tri(g, bl, br, tr, uv ? [uo - ha, v0] : null, uv ? [uo + ha, v0] : null, uv ? [uo, v1] : null);
      } else {
        quadG(g, bl, br, tr, tl,
          uv ? [uo - ha, v0] : null, uv ? [uo + ha, v0] : null, uv ? [uo + hb, v1] : null, uv ? [uo - hb, v1] : null);
      }
      vAcc[fi] = v1;
    });
  }
  const T = lv[lv.length - 1];
  if (!tip) {
    quadG(g, [-T.hw, T.y, -T.hd], [-T.hw, T.y, T.hd], [T.hw, T.y, T.hd], [T.hw, T.y, -T.hd]);
  }
  if (!o.nb) {
    const B0 = lv[0];
    quadG(g, [-B0.hw, 0, -B0.hd], [B0.hw, 0, -B0.hd], [B0.hw, 0, B0.hd], [-B0.hw, 0, B0.hd]);
  }
  return g;
}

const UNIT_BOX = frustum(1, 1, 1, 1, 1);
const UNIT_BOX_NB = frustum(1, 1, 1, 1, 1, { nb: true });
const UNIT_BOX_WALL = frustum(1, 1, 1, 1, 1, { nb: true, nbk: true }); // wall-mounted: no back/bottom

// Lathe around y, base at y=0. Flat faces; o.caps ('both'|'top'|'none'), o.rot start angle.
function lathe(rb, rt, h, seg, o = {}) {
  const g = newGeo();
  const rot = o.rot || 0;
  const P = (a, r, y) => [Math.sin(a) * r, y, Math.cos(a) * r];
  const caps = o.caps || 'both';
  for (let i = 0; i < seg; i++) {
    const a0 = rot + (i / seg) * Math.PI * 2;
    const a1 = rot + ((i + 1) / seg) * Math.PI * 2;
    if (rt < 1e-4) tri(g, P(a0, rb, 0), P(a1, rb, 0), [0, h, 0]);
    else quadG(g, P(a0, rb, 0), P(a1, rb, 0), P(a1, rt, h), P(a0, rt, h));
    if (rt >= 1e-4 && caps !== 'none') tri(g, [0, h, 0], P(a0, rt, h), P(a1, rt, h));
    if (caps === 'both') tri(g, [0, 0, 0], P(a1, rb, 0), P(a0, rb, 0));
  }
  return g;
}

// Unit sphere (or upper hemisphere with base at y=0) with flat facets.
function sphereG(seg, rings, hemi = false) {
  const g = newGeo();
  const tmax = hemi ? Math.PI / 2 : Math.PI;
  const P = (th, a) => [Math.sin(th) * Math.sin(a), Math.cos(th), Math.sin(th) * Math.cos(a)];
  for (let j = 0; j < rings; j++) {
    const t0 = (j / rings) * tmax;
    const t1 = ((j + 1) / rings) * tmax;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      if (j === 0) tri(g, P(t1, a0), P(t1, a1), [0, 1, 0]);
      else if (j === rings - 1 && !hemi) tri(g, [0, -1, 0], P(t0, a1), P(t0, a0));
      else quadG(g, P(t1, a0), P(t1, a1), P(t0, a1), P(t0, a0));
    }
  }
  return g;
}

// Flat polygon facing +z from a convex ccw outline [[x,y]...]
function shapeG(pts, uvScale = 0) {
  const g = newGeo();
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  cx /= pts.length; cy /= pts.length;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    tri(g, [cx, cy, 0], [a[0], a[1], 0], [b[0], b[1], 0]);
  }
  return g;
}

// Outline of an arch opening, open at the bottom: right base -> up -> arc -> down left base.
function archOutline(w, h, pointed, seg = 5) {
  const pts = [];
  const hw = w / 2;
  if (pointed) {
    const sh = h - 0.866 * w;
    pts.push([hw, 0], [hw, sh]);
    for (let i = 1; i <= seg; i++) {
      const th = (i / seg) * (Math.PI / 3);
      pts.push([-hw + w * Math.cos(th), sh + w * Math.sin(th)]);
    }
    // the last point is the apex; mirror the left side
    for (let i = seg - 1; i >= 1; i--) {
      const th = (i / seg) * (Math.PI / 3);
      pts.push([hw - w * Math.cos(th), sh + w * Math.sin(th)]);
    }
    pts.push([-hw, sh], [-hw, 0]);
  } else {
    const sh = h - hw;
    pts.push([hw, 0], [hw, sh]);
    for (let i = 1; i < seg * 2; i++) {
      const th = (i / (seg * 2)) * Math.PI;
      pts.push([Math.cos(th) * hw, sh + Math.sin(th) * hw]);
    }
    pts.push([-hw, sh], [-hw, 0]);
  }
  return pts;
}

// Filled arch (convex) facing +z.
function archShapeG(w, h, pointed) {
  return shapeG(archOutline(w, h, pointed));
}

// Ring (frame) between two outlines of equal point count, with depth; faces +z.
function archFrameG(wo, ho, wi, hi, depth, pointed) {
  const g = newGeo();
  const O = archOutline(wo, ho, pointed);
  const I = archOutline(wi, hi, pointed);
  const n = Math.min(O.length, I.length);
  const z1 = depth, z0 = 0;
  for (let i = 0; i < n - 1; i++) {
    const o0 = O[i], o1 = O[i + 1], i0 = I[i], i1 = I[i + 1];
    // front (+z), outline runs right -> left over the top (ccw seen from +z)
    quadG(g, [o0[0], o0[1], z1], [o1[0], o1[1], z1], [i1[0], i1[1], z1], [i0[0], i0[1], z1]);
    // outer side wall
    quadG(g, [o0[0], o0[1], z0], [o1[0], o1[1], z0], [o1[0], o1[1], z1], [o0[0], o0[1], z1]);
    // inner reveal
    quadG(g, [i1[0], i1[1], z0], [i0[0], i0[1], z0], [i0[0], i0[1], z1], [i1[0], i1[1], z1]);
  }
  return g;
}

// Gable roof shell, ridge along x, centred; local y=0 is the wall-top level at z=+-d/2.
// d = wall depth (across z), oz = extra overhang each side, R = rise over d/2, t = thickness.
function roofGeo(p, r) {
  const { L, d, oz, R, t, bulge = 0, rag = 0, cap = 0, fr = [1], segLen = 0.9 } = p;
  const g = newGeo();
  const half = d / 2;
  const hw = half + oz;
  const yu = (z) => R * (1 - Math.abs(z) / half);
  const zs = [];
  for (const f of fr) zs.push(-hw * f);
  zs.push(0);
  for (let i = fr.length - 1; i >= 0; i--) zs.push(hw * fr[i]);
  const n = zs.length;
  const nx = Math.max(1, Math.round(L / segLen));
  const xs = [];
  for (let j = 0; j <= nx; j++) xs.push(-L / 2 + (L * j) / nx);
  const yt = zs.map((z) => {
    const fz = Math.abs(z) / hw;
    return yu(z) + t + bulge * Math.pow(Math.sin(Math.PI * (1 - fz)), 0.8) + cap * Math.max(0, 1 - fz / 0.16);
  });
  const yb = zs.map((z) => yu(z));
  const s = [0];
  for (let i = 1; i < n; i++) s.push(s[i - 1] + Math.hypot(zs[i] - zs[i - 1], yt[i] - yt[i - 1]));
  const lipL = [], lipR = [];
  for (let j = 0; j <= nx; j++) { lipL.push(rag * r()); lipR.push(rag * r()); }
  const T = (i, j) => [xs[j], yt[i], zs[i]];
  const B = (i, j) => {
    const lip = i === 0 ? lipL[j] : i === n - 1 ? lipR[j] : 0;
    const zi = i === 0 || i === n - 1 ? zs[i] * 0.97 : zs[i];
    return [xs[j], yb[i] - lip, zi];
  };
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < nx; j++) {
      const uA = [xs[j], s[i]], uB = [xs[j + 1], s[i]], uC = [xs[j + 1], s[i + 1]], uD = [xs[j], s[i + 1]];
      quadG(g, T(i, j), T(i + 1, j), T(i + 1, j + 1), T(i, j + 1), uA, uD, uC, uB);
      quadG(g, B(i, j), B(i, j + 1), B(i + 1, j + 1), B(i + 1, j), uA, uB, uC, uD);
    }
  }
  for (let j = 0; j < nx; j++) {
    // eave lips (left faces -z, right faces +z)
    quadG(g, T(0, j), T(0, j + 1), B(0, j + 1), B(0, j));
    quadG(g, T(n - 1, j + 1), T(n - 1, j), B(n - 1, j), B(n - 1, j + 1));
  }
  for (let i = 0; i < n - 1; i++) {
    quadG(g, B(i, nx), T(i, nx), T(i + 1, nx), B(i + 1, nx));   // +x end
    quadG(g, B(i, 0), B(i + 1, 0), T(i + 1, 0), T(i, 0));        // -x end
  }
  g.topAt = (z) => yu(z) + t;
  return g;
}

// Triangular gable-end prism (base d at y=0, apex R), thickness th along z; +z/-z faces.
function gableFillG(d, R, th) {
  const g = newGeo();
  const hz = th / 2;
  const BL = [-d / 2, 0], BR = [d / 2, 0], AP = [0, R];
  tri(g, [BL[0], BL[1], hz], [BR[0], BR[1], hz], [AP[0], AP[1], hz]);
  tri(g, [BR[0], BR[1], -hz], [BL[0], BL[1], -hz], [AP[0], AP[1], -hz]);
  quadG(g, [BR[0], 0, hz], [BR[0], 0, -hz], [AP[0], AP[1], -hz], [AP[0], AP[1], hz]);
  quadG(g, [BL[0], 0, -hz], [BL[0], 0, hz], [AP[0], AP[1], hz], [AP[0], AP[1], -hz]);
  return g;
}

// ---------------------------------------------------------------- the Kit

const _V = new THREE.Vector3();
const _Q = new THREE.Quaternion();
const _E = new THREE.Euler();
const _S = new THREE.Vector3();
const _Y = new THREE.Vector3(0, 1, 0);
const _N3 = new THREE.Matrix3();
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

class Kit {
  constructor(rng) {
    this.r = rng;
    this.parts = {};
    this.stack = [new THREE.Matrix4()];
    this.named = [];
    this.tops = [];
  }

  get m() { return this.stack[this.stack.length - 1]; }

  push(x = 0, y = 0, z = 0, ry = 0, s = 1, rz = 0, rx = 0) {
    _E.set(rx, ry, rz, 'YXZ');
    const m = new THREE.Matrix4().compose(_V.set(x, y, z), _Q.setFromEuler(_E), _S.set(s, s, s));
    this.stack.push(this.m.clone().multiply(m));
    return this;
  }

  pop() { this.stack.pop(); return this; }

  pt(x, y, z) { return new THREE.Vector3(x, y, z).applyMatrix4(this.m); }

  // Bake geometry g through (stack * local) into the part for material `key`.
  emit(key, g, local, col, o = {}) {
    const M = local ? this.m.clone().multiply(local) : this.m;
    const e = M.elements;
    const ne = _N3.getNormalMatrix(M).elements;
    const part = this.parts[key] || (this.parts[key] = { p: [], n: [], u: [], c: [] });
    const spec = TEXSPEC[key];
    const sc = spec ? 1 / spec[1] : 1;
    const base = rgb(col);
    const j = o.j === undefined ? 0.05 : o.j;
    const bright = (1 + (this.r() - 0.5) * 2 * j) * (key === 'timber' ? 1.35 : key === 'planks' ? 1.12 : key === 'stone' ? 1.12 : 1);
    const useAo = AO_KEYS.has(key) && o.ao !== false;
    const uo = o.uo || 0, vo = o.vo || 0;
    const swap = !!o.swap;
    const nv = g.p.length / 3;
    for (let i = 0; i < nv; i++) {
      const x = g.p[3 * i], y = g.p[3 * i + 1], z = g.p[3 * i + 2];
      const X = e[0] * x + e[4] * y + e[8] * z + e[12];
      const Y = e[1] * x + e[5] * y + e[9] * z + e[13];
      const Z = e[2] * x + e[6] * y + e[10] * z + e[14];
      const gx = g.n[3 * i], gy = g.n[3 * i + 1], gz = g.n[3 * i + 2];
      let NX = ne[0] * gx + ne[3] * gy + ne[6] * gz;
      let NY = ne[1] * gx + ne[4] * gy + ne[7] * gz;
      let NZ = ne[2] * gx + ne[5] * gy + ne[8] * gz;
      const nl = Math.hypot(NX, NY, NZ) || 1;
      NX /= nl; NY /= nl; NZ /= nl;
      let u = g.u[2 * i], v = g.u[2 * i + 1];
      if (u !== u) {
        const ax = Math.abs(NX), ay = Math.abs(NY), az = Math.abs(NZ);
        if (ay >= ax && ay >= az) { u = X; v = Z; } else if (ax >= az) { u = Z; v = Y; } else { u = X; v = Y; }
      }
      u = u * sc + uo; v = v * sc + vo;
      if (swap) { const t = u; u = v; v = t; }
      let f = bright;
      if (useAo) f *= 0.62 + 0.38 * smooth(0, 1.3, Y);
      part.p.push(X, Y, Z);
      part.n.push(NX, NY, NZ);
      part.u.push(u, v);
      part.c.push(base[0] * f, base[1] * f, base[2] * f);
    }
  }

  local(x, y, z, rx, ry, rz, sx, sy, sz) {
    _E.set(rx || 0, ry || 0, rz || 0, 'YXZ');
    return new THREE.Matrix4().compose(_V.set(x, y, z), _Q.setFromEuler(_E), _S.set(sx, sy, sz));
  }

  // Box with centre x/z, bottom at y. o: c colour, rx/ry/rz, nb (no bottom), swap, ao, j
  box(key, w, h, d, x, y, z, o = {}) {
    let g = o.wall ? UNIT_BOX_WALL : o.nb ? UNIT_BOX_NB : UNIT_BOX;
    let wy = this.m.elements[13] + y;
    if (o.ao !== false && AO_KEYS.has(key) && h > 1.3 && wy < 0.4 && !o.rx && !o.rz) {
      const ys = [];
      for (const yy of [0.4, 1.0]) if (yy - wy < h - 0.1 && yy - wy > 0.1) ys.push((yy - wy) / h);
      if (ys.length) g = frustum(1, 1, 1, 1, 1, { ys, nb: o.nb });
    }
    if (o.swap === undefined && key === 'timber' && w > h * 1.3 && w > d * 1.3) o = { ...o, swap: true };
    this.emit(key, g, this.local(x, y, z, o.rx, o.ry, o.rz, w, h, d), o.c, o);
  }

  // Bar from a to b (arrays) with cross-section tw x td; `up` rolls it.
  bar(key, a, b, tw, td, o = {}) {
    const dir = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = dir.length();
    if (len < 1e-5) return;
    dir.normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(_Y, dir);
    if (o.roll) q.multiply(new THREE.Quaternion().setFromAxisAngle(_Y, o.roll));
    const m = new THREE.Matrix4().compose(new THREE.Vector3(a[0], a[1], a[2]), q, new THREE.Vector3(tw, len, td));
    this.emit(key, o.wall ? UNIT_BOX_WALL : UNIT_BOX, m, o.c, { ...o, swap: o.swap ?? (key === 'timber' && Math.abs(dir.y) < 0.6) });
  }

  // Lathe cylinder / cone (rb bottom radius, rt top radius).
  cyl(key, rb, rt, h, x, y, z, seg = 8, o = {}) {
    const g = lathe(1, rt / rb, 1, seg, { caps: o.caps, rot: o.rot });
    this.emit(key, g, this.local(x, y, z, o.rx, o.ry, o.rz, rb, h, rb), o.c, o);
  }

  cone(key, r, h, x, y, z, seg = 8, o = {}) { this.cyl(key, r, 0, h, x, y, z, seg, o); }

  // Flat disc facing +y (rotate with rx/rz to face elsewhere), radius r at (x,y,z).
  disc(key, r, x, y, z, seg = 6, o = {}) {
    const g = newGeo();
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      tri(g, [0, 0, 0], [Math.sin(a0), 0, Math.cos(a0)], [Math.sin(a1), 0, Math.cos(a1)]);
    }
    this.emit(key, g, this.local(x, y, z, o.rx, o.ry, o.rz, r, 1, r), o.c, o);
  }

  // Ellipsoid (or dome) centred at x,y,z with radii rx,ry,rz.
  sph(key, rx, ry, rz, x, y, z, seg = 6, rings = 4, o = {}) {
    const g = sphereG(seg, rings, !!o.hemi);
    this.emit(key, g, this.local(x, y, z, o.rx, o.ry, o.rz, rx, ry, rz), o.c, o);
  }

  // Square/rect frustum with explicit slanted uvs (spires, pyramids, chimneys). Base at y.
  frus(key, w0, d0, w1, d1, h, x, y, z, o = {}) {
    const g = frustum(w0, d0, w1, d1, h, { uv: o.uv !== false, nb: true, uo: this.r() * 3 });
    this.emit(key, g, this.local(x, y, z, o.rx, o.ry, o.rz, 1, 1, 1), o.c, o);
  }

  pyr(key, w, d, h, x, y, z, o = {}) { this.frus(key, w, d, 0, 0, h, x, y, z, o); }

  // Arbitrary geometry through a local transform.
  geo(key, g, x, y, z, ry, o = {}) {
    this.emit(key, g, this.local(x, y, z, o.rx, ry, o.rz, o.sx || 1, o.sy || 1, o.sz || 1), o.c, o);
  }

  // Quad from four points (ccw from the visible side), in current stack space.
  quad(key, a, b, c, d, o = {}) {
    const g = newGeo();
    quadG(g, a, b, c, d);
    this.emit(key, g, null, o.c, { ao: false, ...o });
  }

  // Gable roof; see roofGeo. Returns the geometry (for topAt).
  roof(key, p, x, y, z, ry, o = {}) {
    const g = roofGeo(p, this.r);
    this.emit(key, g, this.local(x, y, z, 0, ry, 0, 1, 1, 1), o.c, { ao: false, ...o });
    return g;
  }

  // Sub-assembly that becomes its own named child (pivot at x,y,z in the current stack space).
  sub(name, x, y, z) {
    const s = new Kit(this.r);
    const p = this.pt(x, y, z);
    this.named.push({ name, kit: s, pos: p });
    return s;
  }

  chimneyTop(x, y, z) {
    const p = this.pt(x, y, z);
    this.tops.push({ x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3) });
  }

  // Convert parts into meshes appended to `group`.
  bake(group, opts = {}) {
    for (const [key, part] of Object.entries(this.parts)) {
      if (!part.p.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(part.p, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(part.n, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(part.u, 2));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(part.c, 3));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, PARTMAT[key]);
      const isGlass = key === 'win' || /^st\d$/.test(key);
      mesh.name = isGlass ? 'window' : key;
      mesh.castShadow = !isGlass;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    for (const n of this.named) {
      const sg = new THREE.Group();
      sg.name = n.name;
      sg.position.copy(n.pos);
      n.kit.bake(sg);
      group.add(sg);
    }
    return group;
  }

  triCount() {
    let t = 0;
    for (const p of Object.values(this.parts)) t += p.p.length / 9;
    for (const n of this.named) t += n.kit.triCount();
    return t;
  }
}

// ---------------------------------------------------------------- palette

const TIMBERS = [0x5b3b25, 0x4d3220, 0x654428];
const IRON = 0x3a3836;
const GOLD = 0xe0b038;
const PLASTERS = [0xf3ead2, 0xefc47c, 0xf0c4b0, 0xfbf8ee, 0xdfe6bc];  // cream, ochre, pale pink, whitewash, sage
const STONES = [0xe0dacb, 0xcfc8b6, 0xbdb6a4];
const SHUTTERS = [0x4f7a62, 0x5a74a4, 0xa8503f, 0x7a5535, 0xb8923a];
const FLOWERS = [0xd8433a, 0xf2c230, 0x4a6fd0, 0xf6f2e6, 0xe27aa8];
const WOODS = [0xd4aa78, 0xc29a68, 0xb08658];
const GREENS = [0x5f9040, 0x6fa24a, 0x4f8038, 0x78a850];
const SOIL = 0x5a4228;

// ---------------------------------------------------------------- generic helpers

// free spans of [a,b] not covered by blocks [{a,b}]
function spans(a, b, blocks) {
  let cur = [[a, b]];
  for (const bl of blocks) {
    const next = [];
    for (const [s, e] of cur) {
      if (bl.b <= s || bl.a >= e) { next.push([s, e]); continue; }
      if (bl.a > s) next.push([s, bl.a]);
      if (bl.b < e) next.push([bl.b, e]);
    }
    cur = next;
  }
  return cur.filter(([s, e]) => e - s > 0.06);
}

// Timber framing on a +z facing plane at z=0, x in [-fw/2, fw/2], y in [0, fh] (stack must be at the face).
function frameFace(k, fw, fh, o = {}) {
  const T = o.tw ?? 0.12;
  const D = o.dp ?? 0.09;
  const c = o.tc ?? 0x5b3b25;
  const holes = o.holes || [];
  const hx = fw / 2;
  const wb = (w, h, x, y) => k.box('timber', w, h, D, x, y, D / 2, { c, wall: true, j: 0.08 });
  // sill beam (broken by doors), head beam
  for (const [s, e] of spans(-hx, hx, holes.filter((h) => h.y0 <= 0.05).map((h) => ({ a: h.x0, b: h.x1 })))) {
    wb(e - s, T, (s + e) / 2, 0);
  }
  wb(fw, T * 1.25, 0, fh - T * 1.25);
  if (o.mid !== undefined) {
    for (const [s, e] of spans(-hx, hx, holes.filter((h) => o.mid > h.y0 && o.mid < h.y1).map((h) => ({ a: h.x0, b: h.x1 })))) {
      wb(e - s, T * 0.9, (s + e) / 2, o.mid);
    }
  }
  const n = Math.max(1, Math.round(fw / (o.sp ?? 1.45)));
  const xs = [];
  for (let i = 0; i <= n; i++) xs.push(-hx + (fw * i) / n);
  const y0 = T, y1 = fh - T * 1.25;
  for (let i = 1; i < n; i++) {
    const x = xs[i];
    const blocks = holes.filter((h) => x + T / 2 > h.x0 && x - T / 2 < h.x1).map((h) => ({ a: h.y0, b: h.y1 }));
    for (const [s, e] of spans(y0, y1, blocks)) wb(T, e - s, x, s);
  }
  if (o.braces !== false) {
    for (let i = 0; i < n; i++) {
      const xa = xs[i], xb = xs[i + 1];
      if (holes.some((h) => xa < h.x1 && xb > h.x0 && y0 < h.y1 && y1 > h.y0)) continue;
      if (k.r() > (o.bp ?? 0.55)) continue;
      const dir = ((i + (o.flip ? 1 : 0)) % 2 === 0) ? 1 : -1;
      const a = dir > 0 ? [xa + T * 0.4, y0, D / 2] : [xb - T * 0.4, y0, D / 2];
      const b = dir > 0 ? [xb - T * 0.4, y1, D / 2] : [xa + T * 0.4, y1, D / 2];
      k.bar('timber', a, b, T * 0.85, D * 0.9, { c, j: 0.08, wall: true });
    }
  }
}

function flowerBox(k, x, y, w) {
  k.box('planks', w, 0.14, 0.2, x, y, 0.12, { c: 0x8a6240, wall: true });
  k.box('flat', w - 0.04, 0.1, 0.16, x, y + 0.13, 0.12, { c: k.r.pick(GREENS), wall: true });
  const n = Math.max(2, Math.round(w / 0.25));
  for (let i = 0; i < n; i++) {
    const fx = x - w / 2 + 0.1 + ((w - 0.2) * (i + 0.5)) / n;
    k.sph('flat', 0.05, 0.05, 0.05, fx, y + 0.27, 0.12 + (k.r() - 0.5) * 0.05, 4, 2, { c: k.r.pick(FLOWERS), ao: false });
  }
}

// Rectangular window on a +z plane. x = centre, y = sill height.
function windowAt(k, x, y, w, h, o = {}) {
  const tc = o.tc ?? 0x4d3220;
  const fw = 0.07;
  const glass = o.glass || 'win';
  k.quad(glass, [x - w / 2, y, 0.035], [x + w / 2, y, 0.035], [x + w / 2, y + h, 0.035], [x - w / 2, y + h, 0.035]);
  const fb = (bw, bh, bx, by, d = 0.1) => k.box('timber', bw, bh, d, bx, by, d / 2, { c: tc, wall: true, j: 0.06 });
  fb(w + fw * 2, fw, x, y + h);
  fb(fw, h, x - w / 2 - fw / 2, y);
  fb(fw, h, x + w / 2 + fw / 2, y);
  k.box('timber', 0.035, h, 0.07, x, y, 0.04, { c: tc, wall: true });
  k.box(o.sill || 'stone', w + 0.28, 0.06, 0.22, x, y - fw - 0.06, 0.11, { c: 0xd8d0be, wall: true });
  if (o.shut) {
    const sc = o.shutc ?? 0x4f7a62;
    for (const s of [-1, 1]) {
      k.box('plaster', w * 0.5, h + 0.04, 0.045, x + s * (w / 2 + fw + w * 0.25 + 0.01), y - 0.02, 0.06, { c: sc, wall: true, ao: false });
    }
  }
  if (o.flowers) flowerBox(k, x, y - fw - 0.22, w + 0.12);
}

// Arched window (stone surround + glass), face-local at z=0.
function archWindowAt(k, x, y, w, h, o = {}) {
  const pointed = o.pointed !== false;
  k.push(x, y, 0);
  k.geo(o.glass || 'win', archShapeG(w, h, pointed), 0, 0, 0.04, 0);
  k.geo('stone', archFrameG(w + 0.5, h + 0.28, w, h, 0.14, pointed), 0, -0.02, 0, 0, { c: 0xe6e0d0, wall: true });
  if (o.bars !== false) {
    k.box('stone', 0.07, h * 0.62, 0.08, 0, 0, 0.06, { c: 0xdcd5c4, wall: true });
    k.box('stone', w, 0.06, 0.08, 0, h * 0.34, 0.06, { c: 0xdcd5c4, wall: true });
  }
  k.box('stone', w + 0.55, 0.1, 0.24, 0, -0.1, 0.12, { c: 0xdcd5c4, wall: true });
  k.pop();
}

// Plank door on a +z plane. x = centre; o.arch -> stone arch surround; o.awning; o.step
function doorAt(k, x, w, h, o = {}) {
  const tc = o.tc ?? 0x4d3220;
  const lc = o.leaf ?? 0x7d5a38;
  if (o.arch) {
    k.push(x, 0, 0);
    k.geo('flat', archShapeG(w, h, false), 0, 0, 0.02, 0, { c: 0x1a120c, ao: false });
    k.geo('planks', archShapeG(w - 0.08, h - 0.04, false), 0, 0, 0.05, 0, { c: lc });
    k.geo('stone', archFrameG(w + 0.6, h + 0.3, w, h, 0.18, false), 0, 0, 0, 0, { c: 0xe2dccb, wall: true });
    for (const yy of [h * 0.25, h * 0.55]) k.box('flat', w * 0.8, 0.07, 0.03, 0, yy, 0.07, { c: IRON, wall: true });
    k.pop();
  } else {
    k.box('flat', w, h, 0.03, x, 0, 0.012, { c: 0x1a120c, wall: true });
    k.box('planks', w - 0.06, h - 0.04, 0.06, x, 0, 0.04, { c: lc, wall: true });
    k.box('timber', 0.13, h + 0.14, 0.14, x - w / 2 - 0.05, 0, 0.07, { c: tc, wall: true });
    k.box('timber', 0.13, h + 0.14, 0.14, x + w / 2 + 0.05, 0, 0.07, { c: tc, wall: true });
    k.box('timber', w + 0.36, 0.14, 0.16, x, h, 0.08, { c: tc, wall: true });
    for (const yy of [h * 0.2, h * 0.7]) k.box('flat', w * 0.75, 0.06, 0.025, x - w * 0.1, yy, 0.085, { c: IRON, wall: true });
    k.sph('flat', 0.04, 0.04, 0.04, x + w * 0.32, h * 0.48, 0.1, 4, 2, { c: IRON, ao: false });
  }
  if (o.step !== false) k.box('stone', w + 0.5, 0.1, 0.42, x, 0, 0.21, { c: 0xcfc8b6, wall: true, nb: true });
  if (o.awning) {
    const aw = w + 0.7;
    k.box('shingles', aw, 0.07, 0.8, x, h + 0.42, 0.42, { c: o.awning, rx: 0.32, ao: false });
    for (const s of [-1, 1]) k.bar('timber', [x + s * (aw / 2 - 0.1), h + 0.1, 0.06], [x + s * (aw / 2 - 0.1), h + 0.5, 0.7], 0.07, 0.07, { c: tc });
  }
}

// Stone chimney stack. (x,z) centre, y base, h height of tapered stack. Registers smoke position.
function chimneyAt(k, x, y, z, h, w = 0.55, d = w, c = 0xd5ceba) {
  k.frus('stone', w, d, w * 0.82, d * 0.82, h, x, y, z, { c });
  k.box('stone', w * 0.98, 0.14, d * 0.98, x, y + h, z, { c: 0xb0a998 });
  k.box('stone', w * 0.5, 0.1, d * 0.5, x, y + h + 0.14, z, { c: 0x2a2420, ao: false });
  k.chimneyTop(x, y + h + 0.3, z);
}

// Hanging lantern / wall lantern on a +z plane. Glows at night (window material).
function lanternAt(k, x, y, z = 0, arm = 0.3) {
  k.bar('flat', [x, y + 0.2, z + 0.02], [x, y + 0.2, z + arm], 0.04, 0.04, { c: IRON });
  k.box('flat', 0.16, 0.03, 0.16, x, y + 0.12, z + arm, { c: IRON, ao: false });
  k.box('win', 0.11, 0.17, 0.11, x, y - 0.02, z + arm, { ao: false });
  k.pyr('flat', 0.17, 0.17, 0.1, x, y + 0.15, z + arm, { c: IRON });
}

// ---------------------------------------------------------------- props

function barrel(k, x, z, y = 0, s = 1, c) {
  const col = c ?? k.r.pick(WOODS);
  k.push(x, y, z, k.r() * 6.28, s);
  k.cyl('planks', 0.27, 0.34, 0.32, 0, 0, 0, 7, { c: col, caps: 'none' });
  k.cyl('planks', 0.34, 0.27, 0.32, 0, 0.32, 0, 7, { c: col, caps: 'top' });
  k.cyl('flat', 0.35, 0.35, 0.05, 0, 0.1, 0, 7, { c: IRON, caps: 'none' });
  k.cyl('flat', 0.35, 0.35, 0.05, 0, 0.5, 0, 7, { c: IRON, caps: 'none' });
  k.pop();
}

function crate(k, x, z, y = 0, s = 1, ry = 0, c) {
  k.push(x, y, z, ry, s);
  const col = c ?? k.r.pick(WOODS);
  k.box('planks', 0.62, 0.5, 0.52, 0, 0, 0, { c: col, nb: true });
  for (const sx of [-1, 1]) {
    k.box('timber', 0.07, 0.5, 0.56, sx * 0.3, 0, 0, { c: 0x6a4a2c, nb: true });
  }
  k.bar('timber', [-0.28, 0.05, 0.27], [0.28, 0.45, 0.27], 0.06, 0.03, { c: 0x6a4a2c });
  k.pop();
}

function sack(k, x, z, y = 0, c = 0xcdb98a, s = 1) {
  k.push(x, y, z, k.r() * 6.28, s);
  k.sph('flat', 0.22, 0.24, 0.17, 0, 0.2, 0, 6, 3, { c, rz: (k.r() - 0.5) * 0.3 });
  k.cone('flat', 0.08, 0.14, 0, 0.38, 0, 5, { c: 0xa89468, caps: 'none' });
  k.pop();
}

function hayBale(k, x, z, y = 0, ry = 0, s = 1) {
  k.push(x, y, z, ry, s);
  k.box('hay', 0.95, 0.5, 0.52, 0, 0, 0, { c: 0xf0d890, nb: true });
  for (const sx of [-0.28, 0.28]) k.box('flat', 0.04, 0.52, 0.55, sx, 0, 0, { c: 0x6a4a2c, nb: true, ao: false });
  k.pop();
}

function logPile(k, x, z, ry = 0, len = 1.4, rows = [3, 2, 1], y = 0) {
  k.push(x, y, z, ry);
  const R = 0.14;
  rows.forEach((n, ri) => {
    for (let i = 0; i < n; i++) {
      const lx = (i - (n - 1) / 2) * R * 2.08;
      const ly = R + ri * R * 1.8;
      const l = len * (0.9 + k.r() * 0.2);
      k.cyl('timber', R, R, l, lx, ly, -l / 2, 6, { c: k.r.pick([0x7a5a3a, 0x6a4a2c, 0x8a6a46]), caps: 'none', rx: Math.PI / 2, j: 0.1 });
      k.disc('flat', R * 0.9, lx, ly, l / 2 + 0.005, 6, { rx: Math.PI / 2, c: 0xd8b886, ao: false });
    }
  });
  k.pop();
}

function stoneBlocks(k, x, z, n = 3, ry = 0) {
  k.push(x, 0, z, ry);
  for (let i = 0; i < n; i++) {
    const w = 0.6 + k.r() * 0.35, h = 0.35 + k.r() * 0.2, d = 0.45 + k.r() * 0.2;
    const bx = (i % 2) * 0.55 + (k.r() - 0.5) * 0.1;
    const lvl = Math.floor(i / 2);
    k.box('stone', w, h, d, bx - 0.3, lvl * 0.42, (k.r() - 0.5) * 0.1, { c: k.r.pick(STONES), ry: (k.r() - 0.5) * 0.3 });
  }
  k.pop();
}

function bush(k, x, z, r = 0.45) {
  k.push(x, 0, z, k.r() * 6.28);
  for (let i = 0; i < 2; i++) {
    const a = i * 3.1 + k.r();
    const rr = r * (0.7 + k.r() * 0.4);
    k.sph('flat', rr, rr * 0.8, rr, Math.cos(a) * r * 0.4, rr * 0.7, Math.sin(a) * r * 0.4, 5, 3, { c: k.r.pick(GREENS), j: 0.1 });
  }
  if (k.r() < 0.5) k.sph('flat', 0.05, 0.05, 0.05, r * 0.2, r * 1.1, r * 0.1, 4, 2, { c: k.r.pick(FLOWERS), ao: false });
  k.pop();
}

function flowerBed(k, x, z, w = 1.0, d = 0.5, ry = 0) {
  k.push(x, 0, z, ry);
  const t = 0.07;
  k.box('planks', w, 0.16, t, 0, 0, d / 2 - t / 2, { c: 0x8a6240 });
  k.box('planks', w, 0.16, t, 0, 0, -d / 2 + t / 2, { c: 0x8a6240 });
  for (const sx of [-1, 1]) k.box('planks', t, 0.16, d - 2 * t, sx * (w / 2 - t / 2), 0, 0, { c: 0x8a6240 });
  k.box('flat', w - 2 * t, 0.13, d - 2 * t, 0, 0, 0, { c: SOIL, nb: true });
  const n = Math.min(8, Math.max(4, Math.round(w * d * 12)));
  for (let i = 0; i < n; i++) {
    const fx = (k.r() - 0.5) * (w - 0.2), fz = (k.r() - 0.5) * (d - 0.2);
    k.sph('flat', 0.05, 0.05, 0.05, fx, 0.27 + k.r() * 0.08, fz, 4, 2, { c: k.r.pick(FLOWERS), ao: false });
    if (i % 3 === 0) k.sph('flat', 0.1, 0.09, 0.1, fx, 0.16, fz, 4, 2, { c: k.r.pick(GREENS) });
  }
  k.pop();
}

// Fence between two points. kind: 'rail' | 'wattle' | 'picket'
function fence(k, x1, z1, x2, z2, kind = 'rail', h = 0.7) {
  const len = Math.hypot(x2 - x1, z2 - z1);
  const n = Math.max(1, Math.round(len / (kind === 'picket' ? 1.2 : 0.95)));
  const ry = Math.atan2(x2 - x1, z2 - z1);
  k.push(x1, 0, z1, ry);
  const col = kind === 'wattle' ? 0x8a6a44 : kind === 'picket' ? 0xf0e8d4 : 0x7a5a3a;
  for (let i = 0; i <= n; i++) {
    const pz = (len * i) / n;
    k.box(kind === 'picket' ? 'plaster' : 'timber', 0.1, h * (0.9 + k.r() * 0.25), 0.1, 0, 0, pz, { c: col, rz: (k.r() - 0.5) * 0.08, j: 0.1 });
  }
  if (kind === 'wattle') {
    for (let i = 0; i < 4; i++) {
      const yy = 0.1 + i * h * 0.22;
      k.bar('timber', [i % 2 ? 0.03 : -0.03, yy, 0], [i % 2 ? -0.03 : 0.03, yy, len], 0.05, 0.05, { c: k.r.pick([0x8a6a44, 0x9a7a52, 0x7a5a38]) });
    }
  } else {
    for (const yy of [h * 0.35, h * 0.75]) k.bar('timber', [0, yy, 0], [0, yy, len], 0.06, 0.05, { c: col });
    if (kind === 'picket') {
      const pn = Math.round(len / 0.2);
      for (let i = 0; i < pn; i++) {
        const pz = (len * (i + 0.5)) / pn;
        k.box('plaster', 0.03, h * 0.85, 0.11, 0.06, 0.03, pz, { c: 0xf4eedc, nb: true, j: 0.06 });
      }
    }
  }
  k.pop();
}

function wheel(k, x, y, z, r, ry = 0) {
  // wheel axis along local x after push; disc in the yz plane
  k.push(x, y, z, ry);
  k.cyl('timber', r, r, 0.07, 0, 0, 0, 8, { c: 0x6a4a2c, rz: Math.PI / 2, caps: 'none' });
  k.bar('timber', [0, -r, 0], [0, r, 0], 0.07, 0.07, { c: 0x6a4a2c });
  k.bar('timber', [0, 0, -r], [0, 0, r], 0.07, 0.07, { c: 0x6a4a2c });
  k.pop();
}

function cart(k, x, z, ry = 0, load = 'hay') {
  k.push(x, 0, z, ry);
  k.box('planks', 0.8, 0.1, 1.3, 0, 0.42, 0, { c: 0xb08658 });
  for (const s of [-1, 1]) {
    k.box('planks', 0.05, 0.24, 1.3, s * 0.38, 0.52, 0, { c: 0xa87f50 });
    k.box('planks', 0.8, 0.24, 0.05, 0, 0.52, s * 0.62, { c: 0xa87f50 });
    wheel(k, s * 0.47, 0.34, 0, 0.34);
  }
  k.cyl('timber', 0.04, 0.04, 1.0, 0.5, 0.34, 0, 5, { c: 0x4d3220, rz: Math.PI / 2, caps: 'none' });
  k.bar('timber', [0.3, 0.45, 0.6], [0.3, 0.55, 1.7], 0.07, 0.07, { c: 0x6a4a2c });
  k.bar('timber', [-0.3, 0.45, 0.6], [-0.3, 0.55, 1.7], 0.07, 0.07, { c: 0x6a4a2c });
  if (load === 'hay') k.sph('hay', 0.42, 0.34, 0.6, 0, 0.55, 0, 6, 3, { c: 0xf0d890 });
  else if (load === 'sacks') { sack(k, -0.15, -0.2, 0.5, 0xdad0b0); sack(k, 0.15, 0.25, 0.5, 0xcdb98a); }
  k.pop();
}

function bench(k, x, z, ry = 0, len = 1.2) {
  k.push(x, 0, z, ry);
  k.box('planks', len, 0.07, 0.3, 0, 0.42, 0, { c: 0xc29a68 });
  for (const s of [-1, 1]) k.box('timber', 0.07, 0.42, 0.26, s * (len / 2 - 0.12), 0, 0, { c: 0x5b3b25 });
  k.pop();
}

function table(k, x, z, ry = 0) {
  k.push(x, 0, z, ry);
  k.box('planks', 1.0, 0.06, 0.6, 0, 0.7, 0, { c: 0xc29a68 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box('timber', 0.07, 0.7, 0.07, sx * 0.42, 0, sz * 0.24, { c: 0x5b3b25 });
  k.cyl('flat', 0.08, 0.06, 0.14, 0.15, 0.76, 0.05, 6, { c: 0xb8923a, j: 0 });
  k.pop();
}

function well(k, x, z) {
  k.push(x, 0, z, 0);
  k.cyl('stone', 0.62, 0.58, 0.62, 0, 0, 0, 8, { c: 0xd8d0be, caps: 'none' });
  k.cyl('stone', 0.66, 0.66, 0.1, 0, 0.62, 0, 8, { c: 0xc7bfae, caps: 'top' });
  k.disc('flat', 0.45, 0, 0.5, 0, 8, { c: 0x2a4a5c, ao: false });
  for (const s of [-1, 1]) k.box('timber', 0.1, 1.5, 0.1, s * 0.62, 0.55, 0, { c: 0x5b3b25 });
  k.roof('shingles', { L: 1.7, d: 0.8, oz: 0.2, R: 0.45, t: 0.08, segLen: 1.0 }, 0, 2.0, 0, 0, { c: 0xb4a080 });
  k.cyl('timber', 0.05, 0.05, 1.3, 0, 1.5, 0, 5, { c: 0x4d3220, rz: Math.PI / 2, caps: 'none' });
  k.cyl('planks', 0.1, 0.08, 0.14, 0.2, 0.9, 0, 6, { c: 0xa87f50 });
  k.pop();
}

function mushrooms(k, x, z) {
  for (let i = 0; i < 3; i++) {
    const px = x + (k.r() - 0.5) * 0.4, pz = z + (k.r() - 0.5) * 0.4, s = 0.6 + k.r() * 0.6;
    k.cyl('flat', 0.03 * s, 0.03 * s, 0.1 * s, px, 0, pz, 4, { c: 0xece4d0, caps: 'none' });
    k.sph('flat', 0.08 * s, 0.05 * s, 0.08 * s, px, 0.1 * s, pz, 5, 2, { c: k.r() < 0.5 ? 0xb8452f : 0xa07a4a, hemi: true, ao: false });
  }
}

function woodpile(k, x, z, ry = 0, w = 1.4, rows = 3) {
  // stacked short logs, ends facing +z (local), leaning against a wall behind
  k.push(x, 0, z, ry);
  const R = 0.1;
  const per = Math.max(2, Math.round(w / (R * 2.1)));
  for (let r = 0; r < rows; r++) {
    const cnt = per - (r % 2);
    for (let i = 0; i < cnt; i++) {
      const lx = (i - (cnt - 1) / 2) * R * 2.1;
      const ly = R + r * R * 1.8;
      k.cyl('timber', R, R, 0.45, lx, ly, -0.22, 5, { c: k.r.pick([0x7a5a3a, 0x6a4a2c, 0x8a6a46]), caps: 'none', rx: Math.PI / 2, j: 0.1 });
      k.disc('flat', R * 0.85, lx, ly, 0.235, 5, { rx: Math.PI / 2, c: 0xdcbf8c, ao: false });
    }
  }
  k.pop();
}

function banner(k, x, y, z, w, h, c = 0xa9362e, ry = 0) {
  k.push(x, y, z, ry);
  k.box('timber', w + 0.2, 0.06, 0.06, 0, h, 0.02, { c: 0x4d3220 });
  const g = newGeo();
  const p = (px, py) => [px, py, 0.04];
  tri(g, p(-w / 2, h), p(-w / 2, 0.25), p(w / 2, h));
  tri(g, p(w / 2, h), p(-w / 2, 0.25), p(w / 2, 0.25));
  tri(g, p(-w / 2, 0.25), p(0, 0), p(w / 2, 0.25));
  k.geo('cloth', g, 0, 0, 0, 0, { c, ao: false });
  k.disc('flat', w * 0.22, 0, h * 0.55, 0.05, 6, { rx: Math.PI / 2, c: GOLD, ao: false });
  k.pop();
}

// Crooked noticeboard / signpost board
function signBoard(k, x, y, z, w, h, c = 0xc29a68, ry = 0) {
  k.push(x, y, z, ry);
  k.box('planks', w, h, 0.05, 0, 0, 0, { c });
  k.box('timber', w + 0.06, 0.04, 0.07, 0, h, 0, { c: 0x4d3220 });
  k.pop();
}

// wrap a prop-only pseudo-random scatter helper: place fn at (x,z) with small jitter
const jitterPos = (k, x, z, a = 0.12) => [x + (k.r() - 0.5) * a, z + (k.r() - 0.5) * a];

// ---------------------------------------------------------------- walls, roofs, assemblies

const ROOFS = {
  thatch: { key: 'thatch', t: 0.42, bulge: 0.17, rag: 0.14, cap: 0.15, fr: [1, 0.66, 0.36, 0.12], segLen: 0.75 },
  shingles: { key: 'shingles', t: 0.13, rag: 0.03, fr: [1], segLen: 1.2 },
  slate: { key: 'slate', t: 0.12, rag: 0.02, fr: [1], segLen: 1.2 },
  tiles: { key: 'tiles', t: 0.15, rag: 0.02, fr: [1], segLen: 1.2 },
};
const RIDGE = { shingles: 0x6a4a2c, slate: 0x4f5664, tiles: 0xc0603c };

// Gable roof over a w x d wall block whose top is at y. Ridge along local x. Returns {R, t, top(z)}.
function gableRoof(k, o) {
  const sp = ROOFS[o.type];
  const L = o.w + o.ox * 2;
  const R = o.R;
  k.push(o.x || 0, o.y, o.z || 0, o.ry || 0);
  const g = k.roof(sp.key, {
    L, d: o.d, oz: o.oz, R, t: sp.t, bulge: sp.bulge, rag: sp.rag, cap: sp.cap, fr: sp.fr, segLen: sp.segLen,
  }, 0, 0, 0, 0, { c: o.tint, j: 0.03 });
  if (o.fill) {
    for (const s of [-1, 1]) {
      if (o.fill.only && o.fill.only !== s) continue;
      k.geo(o.fill.key, gableFillG(o.d, R, 0.2), s * (o.w / 2 - 0.1), 0, 0, s * Math.PI / 2, { c: o.fill.tint });
    }
  }
  const half = o.d / 2, hw = half + o.oz;
  if (o.type !== 'thatch') {
    const tc = o.tc ?? 0x4d3220;
    for (const s of [-1, 1]) {
      const x = s * (L / 2 + 0.01);
      for (const q of [-1, 1]) {
        k.bar('timber', [x, g.topAt(q * hw) - 0.02, q * hw], [x, R + sp.t - 0.02, 0], 0.07, 0.17, { c: tc });
      }
    }
    k.box('flat', L + 0.12, 0.13, 0.17, 0, R + sp.t - 0.04, 0, { c: RIDGE[o.type], ao: false });
  } else {
    // crossed spars at the gable tips
    for (const s of [-1, 1]) {
      const x = s * (L / 2 + 0.02);
      const yt = R + sp.t + sp.cap;
      k.bar('timber', [x, yt - 0.12, -0.22], [x, yt + 0.28, 0.2], 0.05, 0.05, { c: 0x6a4a2c });
      k.bar('timber', [x, yt - 0.12, 0.22], [x, yt + 0.28, -0.2], 0.05, 0.05, { c: 0x6a4a2c });
    }
  }
  k.pop();
  return { R, t: sp.t, ridge: R + sp.t + (sp.cap || 0), top: (z) => R * (1 - Math.abs(z) / half) + sp.t };
}

// Timber detailing on a gable end triangle (face plane at x = +-w/2, handled by caller's push).
function gableFrame(k, d, R, tc) {
  const D = 0.08, T = 0.1;
  k.bar('timber', [-d / 2, 0.02, D / 2], [0, R - 0.05, D / 2], T, D, { c: tc });
  k.bar('timber', [d / 2, 0.02, D / 2], [0, R - 0.05, D / 2], T, D, { c: tc });
  k.box('timber', T, R - 0.05, D, 0, 0, D / 2, { c: tc, wall: true });
  k.box('timber', d * 0.5, T, D, 0, R * 0.38, D / 2, { c: tc, wall: true });
}

const FACES = [
  { k: 'f', ry: 0, px: (w, d) => [0, d / 2], fw: (w, d) => w },
  { k: 'r', ry: Math.PI / 2, px: (w, d) => [w / 2, 0], fw: (w, d) => d },
  { k: 'b', ry: Math.PI, px: (w, d) => [0, -d / 2], fw: (w, d) => w },
  { k: 'l', ry: -Math.PI / 2, px: (w, d) => [-w / 2, 0], fw: (w, d) => d },
];

function drawOp(k, op, st) {
  switch (op.t) {
    case 'win': windowAt(k, op.x, op.y, op.w ?? 0.6, op.h ?? 0.75, { shut: op.shut, shutc: op.shutc ?? st?.shut, flowers: op.flowers, tc: op.tc ?? st?.timber, glass: op.glass, sill: op.sill }); break;
    case 'awin': archWindowAt(k, op.x, op.y, op.w ?? 0.7, op.h ?? 1.5, { pointed: op.pointed, glass: op.glass, bars: op.bars }); break;
    case 'door': doorAt(k, op.x, op.w ?? 0.85, op.h ?? 1.7, { arch: op.arch, awning: op.awning, step: op.step, leaf: op.leaf, tc: st?.timber }); break;
    case 'lantern': lanternAt(k, op.x, op.y, 0.02, op.arm ?? 0.28); break;
    case 'fn': op.fn(k); break;
    default: break;
  }
}

const holeOf = (op) => {
  if (op.t === 'win') {
    const w = op.w ?? 0.6, h = op.h ?? 0.75;
    return { x0: op.x - w / 2 - (op.shut ? w * 0.6 : 0.2), x1: op.x + w / 2 + (op.shut ? w * 0.6 : 0.2), y0: op.y - 0.25, y1: op.y + h + 0.15 };
  }
  if (op.t === 'door') {
    const w = op.w ?? 0.85, h = op.h ?? 1.7;
    return { x0: op.x - w / 2 - 0.25, x1: op.x + w / 2 + 0.25, y0: -1, y1: h + 0.25 };
  }
  if (op.t === 'hole') return { x0: op.x0, x1: op.x1, y0: op.y0, y1: op.y1 };
  return null;
};

// One storey: wall block + optional timber frame + openings on faces f/r/b/l.
function storey(k, o) {
  const { w, d, h, y = 0, mat = 'plaster' } = o;
  k.push(o.x || 0, 0, o.z || 0, 0);
  k.box(mat, w, h, d, 0, y, 0, { c: o.tint, nb: y < 0.01 });
  for (const f of FACES) {
    const ops = o[f.k] || [];
    const [px, pz] = f.px(w, d);
    k.push(px, y, pz, f.ry);
    const fw = f.fw(w, d);
    if (o.frame) {
      frameFace(k, fw, h, {
        holes: ops.map(holeOf).filter(Boolean), tc: o.tc, mid: o.mid, sp: o.sp, bp: o.bp, flip: f.k === 'b' || f.k === 'l', tw: o.tw,
      });
    }
    for (const op of ops) drawOp(k, op, o.st);
    k.pop();
  }
  if (o.frame && o.posts !== false) {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      k.box('timber', 0.17, h, 0.17, sx * w / 2, y, sz * d / 2, { c: o.tc, nb: y < 0.01 });
    }
  }
  k.pop();
}

function plinth(k, w, d, h = 0.3, x = 0, z = 0, c = 0xcfc8b6) {
  k.box('stone', w + 0.16, h, d + 0.16, x, 0, z, { c, nb: true, j: 0.04 });
}

// Tall stone chimney stack standing against a gable end (face at x = side * w/2).
function gableChimney(k, side, w, z, wallTop, ridgeTop, c = 0xd5ceba) {
  const x = side * (w / 2 + 0.26);
  k.frus('stone', 0.62, 0.92, 0.56, 0.8, wallTop, x, 0, z, { c });
  k.box('stone', 0.66, 0.1, 0.86, x, wallTop - 0.02, z, { c: 0xb8b1a0 });
  const h2 = ridgeTop + 0.55 - wallTop;
  k.frus('stone', 0.48, 0.62, 0.4, 0.52, h2, x - side * 0.04, wallTop, z, { c });
  k.box('stone', 0.52, 0.12, 0.66, x - side * 0.04, ridgeTop + 0.55, z, { c: 0xb0a998 });
  k.box('stone', 0.26, 0.1, 0.36, x - side * 0.04, ridgeTop + 0.67, z, { c: 0x2a2420, ao: false });
  k.chimneyTop(x - side * 0.04, ridgeTop + 0.8, z);
}

function dormerAt(k, o) {
  const { x, y0, zf, d, R, t, depth = 0.95, bw = 0.95, bh = 0.95, type = 'shingles' } = o;
  const ys = y0 + R * (1 - zf / (d / 2)) + t - 0.1;
  k.box('plaster', bw, bh, depth, x, ys, zf - depth / 2, { c: o.wallTint, nb: true });
  k.push(x, ys, zf, 0);
  windowAt(k, 0, 0.25, 0.4, 0.5, { shut: true, shutc: o.shut, tc: o.tc });
  gableFrame(k, bw, 0.01, o.tc);
  k.pop();
  gableRoof(k, { w: depth, d: bw, y: ys + bh, x, z: zf - depth / 2, ry: Math.PI / 2, type, R: 0.42, ox: 0.16, oz: 0.12, tint: o.tint, fill: { key: 'plaster', tint: o.wallTint }, tc: o.tc });
}

function weatherVane(k, x, y, z) {
  k.bar('flat', [x, y, z], [x, y + 0.7, z], 0.035, 0.035, { c: IRON });
  k.bar('flat', [x - 0.25, y + 0.62, z], [x + 0.25, y + 0.68, z], 0.05, 0.02, { c: GOLD, ao: false });
  k.pyr('flat', 0.08, 0.08, 0.12, x + 0.27, y + 0.67, z, { c: GOLD, rz: -Math.PI / 2 });
}

// ---------------------------------------------------------------- houses

function houseLevel1(k, st) {
  const w = 2.5, d = 2.0, h = 1.5, y0 = 0.16;
  k.box('stone', w + 0.14, y0, d + 0.14, 0, 0, 0, { c: st.stone, nb: true });
  const tint = 0xe6c690 * 0 + (st.plaster === 0xfbf8ee ? 0xe8cf9c : st.plaster === 0xdfe6bc ? 0xd9d4a4 : 0xe6c690);
  storey(k, {
    w, d, h, y: y0, tint, frame: true, tc: st.timber, st, sp: 1.3, bp: 0.0, tw: 0.1,
    f: [
      { t: 'door', x: -0.6, w: 0.68, h: 1.2, step: false },
      { t: 'win', x: 0.55, y: 0.65, w: 0.42, h: 0.46, shut: true },
    ],
    r: [], l: [{ t: 'win', x: 0.1, y: 0.7, w: 0.4, h: 0.45, shut: true }],
    b: [{ t: 'win', x: 0, y: 0.7, w: 0.4, h: 0.45, shut: false }],
  });
  const roof = gableRoof(k, { w, d, y: y0 + h, type: 'thatch', R: 1.5, ox: 0.3, oz: 0.5, tint: st.thatch, fill: { key: 'plaster', tint }, tc: st.timber });
  gableChimney(k, 1, w, 0.0, y0 + h + 0.35, y0 + h + roof.ridge);
  // props
  k.push(0, 0, 0, 0);
  logPile(k, -0.2, -1.55, Math.PI, 1.2, [3, 2]);
  barrel(k, -1.55, 1.25, 0, 0.9);
  barrel(k, -1.95, 1.0, 0, 0.8);
  fence(k, 1.1, 1.75, 2.2, 1.1, 'wattle', 0.6);
  bush(k, 1.55, 1.95, 0.4);
  hayBale(k, 1.9, 0.05, 0, 0.3, 0.8);
  mushrooms(k, -1.9, -0.4);
  k.pop();
}

function houseLevel2(k, st) {
  const w = 3.5, d = 2.7, h = 2.0, y0 = 0.28;
  plinth(k, w, d, y0, 0, 0, st.stone);
  const thatchy = st.thatchy;
  storey(k, {
    w, d, h, y: y0, tint: st.plaster, frame: true, tc: st.timber, st, mid: 1.05,
    f: [
      { t: 'door', x: -0.95, w: 0.8, h: 1.55, awning: thatchy ? undefined : st.shingle },
      { t: 'win', x: 0.45, y: 0.75, w: 0.62, h: 0.7, shut: true, flowers: true },
      { t: 'win', x: 1.25, y: 0.9, w: 0.4, h: 0.5, shut: false },
    ],
    r: [], l: [{ t: 'win', x: 0, y: 0.8, w: 0.55, h: 0.65, shut: true }],
    b: [{ t: 'win', x: -0.6, y: 0.8, w: 0.55, h: 0.65, shut: true }, { t: 'win', x: 0.8, y: 0.8, w: 0.55, h: 0.65, shut: true }],
  });
  const R = thatchy ? 1.55 : 1.2;
  const roof = gableRoof(k, {
    w, d, y: y0 + h, type: thatchy ? 'thatch' : 'shingles', R, ox: thatchy ? 0.3 : 0.28, oz: thatchy ? 0.4 : 0.38,
    tint: thatchy ? st.thatch : st.shingle, fill: { key: 'plaster', tint: st.plaster }, tc: st.timber,
  });
  for (const s of [-1, 1]) {
    k.push(s * w / 2, y0 + h, 0, s * Math.PI / 2);
    gableFrame(k, d, R, st.timber);
    k.pop();
  }
  gableChimney(k, 1, w, 0.0, y0 + h + 0.25, y0 + h + roof.ridge);
  // props
  woodpile(k, -1.95, -0.2, -Math.PI / 2, 1.1, 3);
  barrel(k, -1.8, 1.75, 0, 1);
  crate(k, -1.45, 1.95, 0, 0.9, 0.3);
  flowerBed(k, 0.5, 1.75, 1.0, 0.4);
  bench(k, 1.45, 1.75, 0, 0.9);
  bush(k, 2.0, 1.2, 0.4);
  bush(k, -2.1, 1.0, 0.35);
  if (!thatchy) hayBale(k, 1.8, -1.6, 0, 0.5, 0.8);
  else fence(k, 1.4, -1.9, 2.3, -0.9, 'wattle', 0.6);
}

function houseLevel3(k, st) {
  const w = 3.4, d = 2.6, h1 = 1.9, h2 = 1.75, y0 = 0.25, jet = 0.3;
  plinth(k, w, d, y0, 0, 0, st.stone);
  const wu = w + 0.12, du = d + jet + 0.04, zu = (jet + 0.04) / 2 - 0.04;
  const tc = st.timber;
  storey(k, {
    w, d, h: h1, y: y0, tint: st.plaster, frame: true, tc, st, mid: 1.0,
    f: [
      { t: 'door', x: -0.95, w: 0.85, h: 1.55, awning: st.shingle },
      { t: 'win', x: 0.55, y: 0.7, w: 0.62, h: 0.75, shut: true, flowers: true },
      { t: 'lantern', x: -0.3, y: 1.55 },
    ],
    r: [{ t: 'win', x: 0, y: 0.8, w: 0.55, h: 0.7, shut: true }],
    l: [{ t: 'win', x: 0, y: 0.8, w: 0.55, h: 0.7, shut: true }],
    b: [{ t: 'win', x: 0, y: 0.8, w: 0.55, h: 0.7, shut: true }],
  });
  const yb = y0 + h1;
  // jetty beams
  k.box('timber', wu + 0.06, 0.2, 0.34, 0, yb - 0.1, d / 2 + 0.03, { c: tc });
  for (const x of [-1.2, -0.4, 0.4, 1.2]) k.bar('timber', [x, yb - 0.55, d / 2 - 0.02], [x, yb - 0.1, d / 2 + 0.28], 0.1, 0.1, { c: tc });
  storey(k, {
    w: wu, d: du, h: h2, y: yb, z: zu, tint: st.plaster, frame: true, tc, st, mid: undefined, sp: 0.95,
    f: [
      { t: 'win', x: -0.9, y: 0.55, w: 0.58, h: 0.75, shut: true, flowers: true },
      { t: 'win', x: 0.9, y: 0.55, w: 0.58, h: 0.75, shut: true, flowers: true },
    ],
    r: [{ t: 'win', x: 0, y: 0.6, w: 0.5, h: 0.7, shut: true }],
    l: [{ t: 'win', x: 0, y: 0.6, w: 0.5, h: 0.7, shut: true }],
    b: [{ t: 'win', x: 0, y: 0.6, w: 0.5, h: 0.7, shut: true }],
  });
  const type = st.thatchy ? 'tiles' : 'shingles';
  const R = 1.35;
  const roof = gableRoof(k, {
    w: wu, d: du, y: yb + h2, z: zu, type, R, ox: 0.3, oz: 0.34, tint: st.thatchy ? st.tile : st.shingle,
    fill: { key: 'plaster', tint: st.plaster }, tc,
  });
  for (const s of [-1, 1]) {
    k.push(s * wu / 2, yb + h2, zu, s * Math.PI / 2);
    gableFrame(k, du, R, tc);
    k.pop();
  }
  gableChimney(k, -1, wu, zu - 0.1, yb + h2 + 0.2, yb + h2 + roof.ridge);
  woodpile(k, 1.95, -0.5, Math.PI / 2, 1.0, 3);
  flowerBed(k, 0.5, 2.15, 1.1, 0.4);
  barrel(k, -1.9, 1.95, 0, 0.9);
  barrel(k, -1.5, 2.15, 0, 0.8);
  fence(k, -0.2, 2.5, -1.0, 2.5, 'picket', 0.6);
  fence(k, 1.2, 2.5, 1.9, 2.0, 'picket', 0.6);
  bush(k, 2.1, 1.1, 0.4);
  bush(k, -2.15, 0.2, 0.4);
}

function houseLevel4(k, st) {
  const w = 3.8, d = 2.9, h1 = 2.1, h2 = 1.85, y0 = 0.3;
  plinth(k, w, d, y0, 0, 0, 0xb8b2a0);
  const tc = st.timber;
  const stoneT = 0xe6dfcf;
  storey(k, {
    w, d, h: h1, y: y0, mat: 'stone', tint: stoneT, st,
    f: [
      { t: 'door', x: 0, w: 0.95, h: 1.75, arch: true },
      { t: 'win', x: -1.15, y: 0.75, w: 0.6, h: 0.85, shut: false, sill: 'stone' },
      { t: 'win', x: 1.15, y: 0.75, w: 0.6, h: 0.85, shut: false },
      { t: 'lantern', x: -0.8, y: 1.75 },
      { t: 'lantern', x: 0.8, y: 1.75 },
    ],
    r: [{ t: 'win', x: 0, y: 0.8, w: 0.6, h: 0.85, shut: false }],
    l: [{ t: 'win', x: 0, y: 0.8, w: 0.6, h: 0.85, shut: false }],
    b: [{ t: 'win', x: -0.7, y: 0.8, w: 0.6, h: 0.85 }, { t: 'win', x: 0.7, y: 0.8, w: 0.6, h: 0.85 }],
  });
  // stone quoins at the corners
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      const wq = i % 2 ? 0.34 : 0.46;
      k.box('stone', wq, 0.34, wq, sx * w / 2, y0 + i * 0.4, sz * d / 2, { c: 0xf0ead8, ry: 0 });
    }
  }
  k.box('timber', w + 0.1, 0.12, d + 0.1, 0, y0 + h1, 0, { c: tc, nb: true });
  const yb = y0 + h1 + 0.12;
  storey(k, {
    w, d, h: h2 - 0.12, y: yb, tint: st.plaster, frame: true, tc, st, sp: 0.95,
    f: [
      { t: 'win', x: -1.2, y: 0.5, w: 0.55, h: 0.8, shut: true, flowers: true },
      { t: 'win', x: 0, y: 0.5, w: 0.55, h: 0.8, shut: true, flowers: true },
      { t: 'win', x: 1.2, y: 0.5, w: 0.55, h: 0.8, shut: true, flowers: true },
    ],
    r: [{ t: 'win', x: 0, y: 0.5, w: 0.55, h: 0.8, shut: true }],
    l: [{ t: 'win', x: 0, y: 0.5, w: 0.55, h: 0.8, shut: true }],
    b: [{ t: 'win', x: 0, y: 0.5, w: 0.55, h: 0.8, shut: true }],
  });
  const top = yb + h2 - 0.12;
  const R = 1.7;
  const roof = gableRoof(k, { w, d, y: top, type: 'slate', R, ox: 0.25, oz: 0.3, tint: 0xd4d8e2, fill: { key: 'plaster', tint: st.plaster }, tc });
  for (const s of [-1, 1]) {
    k.push(s * w / 2, top, 0, s * Math.PI / 2);
    gableFrame(k, d, R, tc);
    k.pop();
  }
  for (const x of [-0.95, 0.95]) {
    dormerAt(k, { x, y0: top, zf: d / 2 - 0.12, d, R, t: roof.t, type: 'slate', tint: 0xd4d8e2, wallTint: st.plaster, shut: st.shut, tc });
  }
  gableChimney(k, 1, w, 0.0, top + 0.1, top + R + 0.05, 0xe6dfcf);
  gableChimney(k, -1, w, 0.0, top + 0.1, top + R + 0.05, 0xe6dfcf);
  weatherVane(k, 0.0, top + R + roof.t, 0);
  // garden
  k.box('cobble', 0.9, 0.05, 1.0, 0, 0, 2.05, { c: 0xd8d0be, nb: true });
  flowerBed(k, -1.35, 2.2, 1.0, 0.42);
  flowerBed(k, 1.35, 2.2, 1.0, 0.42);
  fence(k, -1.9, 2.3, -0.75, 2.6, 'picket', 0.62);
  fence(k, 0.75, 2.6, 1.9, 2.3, 'picket', 0.62);
  bush(k, -2.1, 1.55, 0.35);
  bush(k, 2.1, 1.55, 0.35);
  barrel(k, 2.2, -1.5, 0, 0.9);
  woodpile(k, -2.2, -1.2, -Math.PI / 2, 1.0, 2);
}

// ---------------------------------------------------------------- towers & shared bits

// Narrow dark slit window with stone surround on a +z plane.
function slitAt(k, x, y, h = 0.7) {
  k.box('stone', 0.34, h + 0.2, 0.1, x, y - 0.1, 0, { c: 0xe6e0d0, wall: true });
  k.box('flat', 0.14, h, 0.05, x, y, 0.06, { c: 0x16100c, wall: true, ao: false });
}

// Open arched belfry opening (dark) on a +z plane.
function belfryArch(k, x, y, w, h) {
  k.push(x, y, 0);
  k.geo('flat', archShapeG(w, h, true), 0, 0, 0.03, 0, { c: 0x120d0a, ao: false });
  k.geo('stone', archFrameG(w + 0.4, h + 0.2, w, h, 0.14, true), 0, 0, 0, 0, { c: 0xe6e0d0, wall: true });
  for (let i = 0; i < 4; i++) k.box('timber', w * 0.8, 0.05, 0.05, 0, h * 0.12 + i * 0.17, 0.07, { c: 0x4d3220, rz: 0.3, wall: true });
  k.pop();
}

// Square stone tower with belfry and spire. Origin at (x,z), base y0.
function belfryTower(k, o) {
  const { x, z, w, h, y0 = 0, bh = 1.7, spire = 3.0, tint = 0xe6dfcf, front = [], slits = true, cross = true } = o;
  const open = (cx) => ({ t: 'fn', fn: (kk) => belfryArch(kk, cx, 0.2, 0.7, 1.2) });
  const sl = slits ? [{ t: 'fn', fn: (kk) => slitAt(kk, 0, h * 0.45) }, { t: 'fn', fn: (kk) => slitAt(kk, 0, h * 0.72) }] : [];
  storey(k, { w, d: w, h, y: y0, x, z, mat: 'stone', tint, f: [...front, ...sl], r: [...sl], b: [...sl], l: [...sl] });
  k.box('stone', w + 0.3, 0.2, w + 0.3, x, y0 + h, z, { c: 0xcfc8b6, nb: true });
  const yb = y0 + h + 0.2;
  storey(k, { w: w - 0.1, d: w - 0.1, h: bh, y: yb, x, z, mat: 'stone', tint, f: [open(0)], r: [open(0)], b: [open(0)], l: [open(0)] });
  k.box('stone', w + 0.35, 0.2, w + 0.35, x, yb + bh, z, { c: 0xcfc8b6, nb: true });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    k.pyr('stone', 0.4, 0.4, 0.5, x + sx * (w / 2 + 0.05), yb + bh + 0.2, z + sz * (w / 2 + 0.05), { c: 0xd8d1c0 });
  }
  const top = yb + bh + 0.2;
  k.pyr('slate', w + 0.6, w + 0.6, spire, x, top, z, { c: 0xd4d8e2 });
  if (cross) {
    k.box('flat', 0.1, 0.8, 0.1, x, top + spire - 0.05, z, { c: GOLD, ao: false });
    k.box('flat', 0.4, 0.09, 0.09, x, top + spire + 0.4, z, { c: GOLD, ao: false });
  }
  return top + spire;
}

function clockFace(k, x, y, z, r = 0.5) {
  k.push(x, y, z, 0);
  k.cyl('flat', r + 0.08, r + 0.08, 0.06, 0, 0, 0, 10, { c: GOLD, rx: Math.PI / 2, ao: false });
  k.cyl('flat', r, r, 0.07, 0, 0, 0, 10, { c: 0xf4eedc, rx: Math.PI / 2, ao: false });
  k.bar('flat', [0, 0, 0.08], [0, r * 0.7, 0.08], 0.05, 0.02, { c: IRON, ao: false });
  k.bar('flat', [0, 0, 0.08], [r * 0.5, -r * 0.15, 0.08], 0.05, 0.02, { c: IRON, ao: false });
  k.pop();
}

// ---------------------------------------------------------------- buildings

function townhall(k, st) {
  const tc = TIMBERS[0];
  const plaster = st.plaster;
  const w = 6.8, d = 4.6, h1 = 2.4, h2 = 2.2, y0 = 0.55;
  const hx = 0.7;
  k.push(hx, 0, 0, 0);
  k.box('stone', w + 0.7, y0, d + 0.7, 0, 0, 0, { c: 0xbdb7a5, nb: true });
  const wn = (x, y, shut = true, ww = 0.7, hh = 1.0) => ({ t: 'win', x, y, w: ww, h: hh, shut, shutc: st.shut });
  storey(k, {
    w, d, h: h1, y: y0, tint: plaster, frame: true, tc, st, mid: 1.2, sp: 1.3,
    f: [{ t: 'door', x: 0, w: 1.5, h: 2.05, arch: true, step: false }, wn(-2.2, 0.7), wn(2.2, 0.7), wn(-3.0, 0.8, false, 0.4, 0.8), wn(3.0, 0.8, false, 0.4, 0.8)],
    r: [wn(0, 0.7)], l: [wn(0, 0.7)],
    b: [wn(-2.2, 0.7), wn(0, 0.7), wn(2.2, 0.7)],
  });
  const yb = y0 + h1;
  const wu = w + 0.2, du = d + 0.5, zu = 0.25;
  k.box('timber', wu + 0.1, 0.26, 0.5, 0, yb - 0.13, d / 2 + 0.05, { c: tc });
  for (let i = -3; i <= 3; i++) k.bar('timber', [i * 1.0, yb - 0.6, d / 2 - 0.02], [i * 1.0, yb - 0.1, d / 2 + 0.4], 0.1, 0.1, { c: tc });
  storey(k, {
    w: wu, d: du, h: h2, y: yb, z: zu, tint: plaster, frame: true, tc, st, sp: 1.1,
    f: [wn(-2.2, 0.6), wn(2.2, 0.6), wn(-3.1, 0.7, false, 0.4, 0.9), wn(3.1, 0.7, false, 0.4, 0.9)],
    r: [wn(-0.7, 0.6), wn(0.9, 0.6)], l: [wn(-0.7, 0.6), wn(0.9, 0.6)],
    b: [wn(-2.4, 0.6), wn(-0.8, 0.6), wn(0.8, 0.6), wn(2.4, 0.6)],
  });
  const R = 2.2;
  const roof = gableRoof(k, { w: wu, d: du, y: yb + h2, z: zu, type: 'tiles', R, ox: 0.4, oz: 0.4, tint: st.tile, fill: { key: 'plaster', tint: plaster }, tc });
  for (const s of [-1, 1]) {
    k.push(s * wu / 2, yb + h2, zu, s * Math.PI / 2);
    gableFrame(k, du, R, tc);
    k.pop();
  }
  gableChimney(k, 1, wu, zu - 0.6, yb + h2 + 0.2, yb + h2 + roof.ridge);
  // front gabled bay on posts, over the entrance
  const bd = 1.25, bw = 3.0, zf = zu + du / 2 + bd; // front plane of the bay
  const bzc = zu + du / 2 + bd / 2 - 0.1;
  k.box('timber', bw, 0.22, bd + 0.2, 0, yb - 0.22, bzc, { c: tc });
  storey(k, {
    w: bw, d: bd + 0.2, h: h2, y: yb, z: bzc, tint: plaster, frame: true, tc, st, sp: 1.0,
    f: [wn(-0.85, 0.55, true, 0.55, 0.8), wn(0.85, 0.55, true, 0.55, 0.8)],
    r: [], l: [], b: [],
  });
  gableRoof(k, { w: bd + 0.2, d: bw, y: yb + h2, x: 0, z: bzc, ry: Math.PI / 2, type: 'tiles', R: 1.25, ox: 0.28, oz: 0.3, tint: st.tile, fill: { key: 'plaster', tint: plaster }, tc });
  k.push(0, yb + h2, zf - 0.1, 0);
  gableFrame(k, bw, 1.25, tc);
  k.pop();
  const pzf = zf - 0.1;
  for (const s of [-1, 1]) {
    k.box('timber', 0.3, yb - y0, 0.3, s * (bw / 2 - 0.15), y0, pzf - 0.15, { c: tc });
    k.bar('timber', [s * (bw / 2 - 0.15), yb - 0.9, pzf - 0.15], [s * (bw / 2 - 0.15), yb - 0.1, pzf - bd * 0.6], 0.12, 0.12, { c: tc });
    k.bar('timber', [s * (bw / 2 - 0.15), yb - 0.9, pzf - 0.15], [s * (bw / 2 - 0.5), yb - 0.1, pzf - 0.15], 0.12, 0.12, { c: tc });
  }
  for (let i = 0; i < 3; i++) {
    const zz = d / 2 + 0.35 + i * 0.45 + 0.1;
    k.box('stone', 3.6 + i * 0.3, 0.55 - 0.18 * (i + 1) + 0.0, 0.45, 0, 0, d / 2 + 0.35 + 0.1 + i * 0.45, { c: 0xcfc8b6, nb: true });
    void zz;
  }
  lanternAt(k, -1.1, 1.6, d / 2 + 0.0 + y0 * 0, 0.0);
  k.pop();
  // banners on the posts
  banner(k, hx - bw / 2 + 0.15 - 0.45, 1.6, zu + du / 2 + bd + 0.05 - 0.1, 0.55, 1.5, 0xa9362e, 0);
  banner(k, hx + bw / 2 - 0.15 + 0.45, 1.6, zu + du / 2 + bd + 0.05 - 0.1, 0.55, 1.5, 0x2f5a9a, 0);
  // corner tower with clock and flag
  const tx = -3.55, tz = 0.35;
  const topY = belfryTower(k, { x: tx, z: tz, w: 2.2, h: 6.6, bh: 1.6, spire: 2.6, cross: false, front: [{ t: 'fn', fn: (kk) => clockFace(kk, 0, 4.3, 0.1, 0.5) }] });
  const f = k.sub('flag', tx, topY + 0.1, tz);
  f.box('timber', 0.08, 1.9, 0.08, 0, 0, 0, { c: 0x4d3220 });
  const fg = newGeo();
  tri(fg, [0, 1.85, 0.0], [0, 1.1, 0.0], [1.0, 1.55, 0.05]);
  tri(fg, [0, 1.85, 0.0], [1.0, 1.55, 0.05], [1.0, 1.85, 0.0]);
  tri(fg, [1.0, 1.85, 0.0], [1.0, 1.55, 0.05], [1.35, 1.7, 0.05]);
  f.geo('cloth', fg, 0, 0, 0, 0, { c: 0xa9362e, ao: false });
  f.sph('flat', 0.08, 0.08, 0.08, 0, 1.92, 0, 4, 3, { c: GOLD, ao: false });
  // props
  bench(k, hx - 2.6, 3.35, 0, 1.2);
  bench(k, hx + 2.6, 3.35, 0, 1.2);
  barrel(k, hx + 3.8, 2.7, 0, 1);
  barrel(k, hx + 4.2, 2.3, 0, 0.9);
  crate(k, hx + 3.7, 3.2, 0, 0.9, 0.3);
  signBoard(k, hx - 3.9, 0.5, 3.3, 0.9, 0.7, 0xc29a68, 0.3);
  k.box('timber', 0.1, 1.2, 0.1, hx - 3.9, 0, 3.3, { c: 0x4d3220 });
  flowerBed(k, hx - 1.9, 2.95, 1.2, 0.4);
  flowerBed(k, hx + 1.9, 2.95, 1.2, 0.4);
  well(k, hx + 2.5, -3.0);
}

function storehouse(k, st) {
  const w = 5.8, d = 4.2, h = 2.3, y0 = 0.3;
  const tc = TIMBERS[1];
  k.box('stone', w + 0.3, y0, d + 0.3, 0, 0, 0, { c: 0xb8b2a0, nb: true });
  storey(k, {
    w, d, h, y: y0, mat: 'planks', tint: 0xdcc096, frame: true, tc, st, sp: 1.45, bp: 0.85, tw: 0.14,
    f: [
      {
        t: 'fn', fn: (kk) => {
          // big double barn door, left leaf swung open
          kk.box('flat', 2.3, 2.0, 0.04, 0, 0, 0.02, { c: 0x1a120c, wall: true, ao: false });
          kk.sph('hay', 0.7, 0.55, 0.4, 0.5, 0.45, -0.1, 6, 3, { c: 0xf0d890 });
          kk.box('timber', 0.18, 2.2, 0.18, -1.25, 0, 0.09, { c: tc, wall: true });
          kk.box('timber', 0.18, 2.2, 0.18, 1.25, 0, 0.09, { c: tc, wall: true });
          kk.box('timber', 2.8, 0.2, 0.2, 0, 2.0, 0.1, { c: tc, wall: true });
          // right leaf closed
          kk.box('planks', 1.1, 1.95, 0.07, 0.58, 0, 0.06, { c: 0x8a6240, wall: true });
          kk.bar('timber', [0.1, 0.1, 0.11], [1.1, 1.85, 0.11], 0.1, 0.03, { c: tc });
          kk.bar('timber', [1.1, 0.1, 0.11], [0.1, 1.85, 0.11], 0.1, 0.03, { c: tc });
          // left leaf open (swung outward)
          kk.push(-1.1, 0, 0.1, -1.15);
          kk.box('planks', 1.05, 1.95, 0.07, -0.52, 0, 0.0, { c: 0x8a6240 });
          kk.bar('timber', [-0.05, 0.1, 0.05], [-1.0, 1.85, 0.05], 0.1, 0.03, { c: tc });
          kk.bar('timber', [-1.0, 0.1, 0.05], [-0.05, 1.85, 0.05], 0.1, 0.03, { c: tc });
          kk.pop();
        },
      },
      { t: 'win', x: -2.15, y: 1.0, w: 0.4, h: 0.5, shut: true, shutc: st.shut },
      { t: 'win', x: 2.15, y: 1.0, w: 0.4, h: 0.5, shut: true, shutc: st.shut },
    ],
    r: [{
      t: 'fn', fn: (kk) => {
        kk.box('flat', 0.9, 0.9, 0.04, 0, 1.0, 0.02, { c: 0x1a120c, wall: true, ao: false });
        kk.box('planks', 0.4, 0.8, 0.06, -0.22, 1.02, 0.06, { c: 0x8a6240, wall: true });
        kk.box('timber', 1.1, 0.12, 0.12, 0, 1.95, 0.08, { c: tc, wall: true });
      },
    }],
    l: [], b: [],
  });
  const roof = gableRoof(k, { w, d, y: y0 + h, type: 'thatch', R: 2.1, ox: 0.4, oz: 0.5, tint: st.thatch, fill: { key: 'planks', tint: 0xdcc096 }, tc });
  // hoist beam over the loft door on the +x gable
  k.bar('timber', [w / 2 + 0.0, y0 + h + 0.65, 0.0], [w / 2 + 0.75, y0 + h + 0.65, 0.0], 0.1, 0.1, { c: tc });
  k.bar('flat', [w / 2 + 0.7, y0 + h + 0.62, 0.0], [w / 2 + 0.7, y0 + h - 0.1, 0.0], 0.025, 0.025, { c: 0x8a7a5a });
  sack(k, 1.7, 2.75, 0, 0xcdb98a);
  sack(k, 1.3, 2.9, 0, 0xdad0b0, 0.9);
  sack(k, 1.55, 2.55, 0.3, 0xcdb98a, 0.9);
  crate(k, -2.5, 2.85, 0, 1.0, 0.2);
  crate(k, -2.5, 2.85, 0.5, 0.85, 0.7);
  crate(k, -1.95, 3.0, 0, 0.9, -0.2);
  barrel(k, -3.0, 2.2, 0, 1);
  barrel(k, -3.05, 1.6, 0, 1);
  hayBale(k, -3.4, 0.2, 0, 0.5);
  cart(k, 2.9, 2.3, -1.45, 'sacks');
  stoneBlocks(k, 0, -2.9, 0);
}

function woodcutter(k, st) {
  const w = 2.6, d = 2.1, h = 1.7, y0 = 0.2;
  const tc = TIMBERS[2];
  k.push(-0.5, 0, -0.5, 0);
  k.box('stone', w + 0.16, y0, d + 0.16, 0, 0, 0, { c: 0xb8b2a0, nb: true });
  storey(k, {
    w, d, h, y: y0, mat: 'planks', tint: 0xe0c08e, frame: true, tc, st, sp: 1.3, bp: 0.4,
    f: [{ t: 'door', x: 0.5, w: 0.75, h: 1.4, step: false }, { t: 'win', x: -0.6, y: 0.75, w: 0.45, h: 0.5, shut: true, shutc: st.shut }],
    r: [], l: [{ t: 'win', x: 0, y: 0.75, w: 0.45, h: 0.5, shut: false }], b: [],
  });
  const roof = gableRoof(k, { w, d, y: y0 + h, type: 'shingles', R: 1.1, ox: 0.3, oz: 0.35, tint: st.shingle, fill: { key: 'planks', tint: 0xe0c08e }, tc });
  chimneyAt(k, -0.7, y0 + h + 0.3, -0.35, 1.0, 0.4, 0.4);
  // lean-to wood store on the +x side
  k.push(w / 2 + 0.05, 0, 0.1, 0);
  for (const sz of [-1, 1]) k.box('timber', 0.14, 1.4, 0.14, 0.9, 0, sz * 0.8, { c: tc });
  k.box('shingles', 1.1, 0.07, 1.9, 0.5, 1.5, 0, { c: st.shingle, rz: 0.2, ao: false });
  woodpile(k, 0.5, -0.1, -Math.PI / 2 + Math.PI / 2, 1.3, 4);
  k.pop();
  k.pop();
  // chopping block + axe, log piles
  k.cyl('timber', 0.3, 0.32, 0.5, -1.55, 0, 1.75, 7, { c: 0x8a6a46 });
  k.disc('flat', 0.28, -1.55, 0.5, 1.75, 7, { c: 0xdcbf8c, ao: false });
  k.bar('timber', [-1.55, 0.72, 1.75], [-1.2, 0.58, 1.78], 0.05, 0.05, { c: 0x6a4a2c });
  k.box('flat', 0.18, 0.12, 0.04, -1.58, 0.5, 1.75, { c: IRON, rz: 0.2 });
  logPile(k, 1.7, 1.55, 0.3, 1.5, [3, 2, 1]);
  logPile(k, 2.2, 0.3, -1.4, 1.4, [3, 2]);
  // sawhorse
  k.push(0.4, 0, 2.05, 0.2);
  for (const sx of [-1, 1]) {
    k.bar('timber', [sx * 0.4, 0, -0.2], [sx * 0.15, 0.62, 0], 0.07, 0.07, { c: 0x6a4a2c });
    k.bar('timber', [sx * 0.4, 0, 0.2], [sx * 0.15, 0.62, 0], 0.07, 0.07, { c: 0x6a4a2c });
  }
  k.cyl('timber', 0.1, 0.1, 1.1, 0.55, 0.7, 0, 6, { c: 0x7a5a3a, rz: Math.PI / 2, caps: 'none' });
  k.pop();
  barrel(k, -2.4, 0.6, 0, 0.9);
  bush(k, -2.2, -1.5, 0.45);
  mushrooms(k, -1.3, 2.4);
}

function forager(k, st) {
  const r = 1.2, h = 1.5, seg = 9;
  const rot = -Math.PI / seg;
  k.push(-0.4, 0, -0.3, 0);
  k.cyl('stone', r + 0.15, r + 0.1, 0.28, 0, 0, 0, seg, { c: 0xbdb7a5, caps: 'none', rot });
  k.cyl('plaster', r, r * 0.95, h, 0, 0.28, 0, seg, { c: st.plaster === 0xfbf8ee ? 0xeed8a8 : st.plaster, caps: 'none', rot });
  const ap = r * Math.cos(Math.PI / seg);
  for (let i = 0; i < seg; i++) {
    const a = rot + (i / seg) * Math.PI * 2;
    k.bar('timber', [Math.sin(a) * (r + 0.03), 0.28, Math.cos(a) * (r + 0.03)], [Math.sin(a) * (r * 0.95 + 0.03), 0.28 + h, Math.cos(a) * (r * 0.95 + 0.03)], 0.12, 0.12, { c: TIMBERS[0] });
  }
  k.cyl('timber', r + 0.04, r + 0.04, 0.14, 0, 0.28 + h - 0.1, 0, seg, { c: TIMBERS[0], caps: 'none', rot });
  // thatch cone with ragged brim
  k.cyl('thatch', r + 0.75, r * 0.15, 1.95, 0, 0.28 + h - 0.12, 0, seg, { c: st.thatch, caps: 'none', rot, j: 0.03 });
  k.cyl('thatch', r + 0.78, r + 0.55, 0.22, 0, 0.28 + h - 0.12 - 0.14, 0, seg, { c: st.thatch, caps: 'none', rot, j: 0.04 });
  k.cyl('flat', 0.12, 0.08, 0.3, 0, 0.28 + h + 1.65, 0, 5, { c: 0x6a4a2c });
  // door and window on the +z face
  k.push(0, 0.28, ap * (1 - 0.0) + 0.0, 0);
  doorAt(k, 0, 0.7, 1.25, { step: true });
  k.pop();
  k.push(Math.sin(rot + 2 * Math.PI / seg * 2.5) * ap, 0.28, Math.cos(rot + 2 * Math.PI / seg * 2.5) * ap, rot + 2 * Math.PI / seg * 2.5);
  windowAt(k, 0, 0.7, 0.4, 0.45, { shut: true, shutc: st.shut });
  k.pop();
  k.pop();
  // baskets of berries
  const basket = (x, z, s = 1) => {
    k.cyl('planks', 0.26 * s, 0.34 * s, 0.34 * s, x, 0, z, 7, { c: 0xc29a68, caps: 'none' });
    for (let i = 0; i < 6; i++) {
      const a = i * 1.05;
      k.sph('flat', 0.075, 0.075, 0.075, x + Math.cos(a) * 0.15 * s, 0.34 * s + 0.04, z + Math.sin(a) * 0.15 * s, 4, 2, { c: i % 3 === 0 ? 0xc2243e : 0x8a2a5c, ao: false });
    }
    k.sph('flat', 0.2 * s, 0.07, 0.2 * s, x, 0.32 * s, z, 5, 2, { c: 0x4f7f34 });
  };
  basket(1.7, 1.5);
  basket(2.15, 0.7, 0.9);
  basket(1.1, 2.15, 0.85);
  // drying rack with herb bundles
  k.push(-2.05, 0, 1.7, 0.5);
  for (const sx of [-1, 1]) {
    k.bar('timber', [sx * 0.75, 0, -0.2], [sx * 0.75, 1.5, 0], 0.07, 0.07, { c: 0x6a4a2c });
    k.bar('timber', [sx * 0.75, 0, 0.2], [sx * 0.75, 1.5, 0], 0.07, 0.07, { c: 0x6a4a2c });
  }
  k.bar('timber', [-0.8, 1.5, 0], [0.8, 1.5, 0], 0.07, 0.07, { c: 0x6a4a2c });
  k.bar('timber', [-0.8, 1.1, 0], [0.8, 1.1, 0], 0.05, 0.05, { c: 0x6a4a2c });
  for (let i = 0; i < 6; i++) {
    const hx2 = -0.6 + i * 0.24;
    k.cone('flat', 0.09, 0.4, hx2, 1.08 - 0.4 + 0.0, 0.0, 5, { c: i % 2 ? 0x7a9a48 : 0xb8923a, rx: Math.PI, caps: 'none' });
  }
  k.pop();
  bench(k, 0.2, 2.35, 0.2, 0.9);
  bush(k, -2.1, -1.9, 0.5);
  bush(k, 2.2, -1.4, 0.45);
  mushrooms(k, 2.4, 2.0);
  mushrooms(k, -1.0, -2.3);
  crate(k, 2.3, -0.5, 0, 0.85, 0.5);
}

function quarry(k, st) {
  const tc = TIMBERS[1];
  k.push(-1.4, 0, -1.2, 0);
  const w = 2.4, d = 2.0, h = 1.6, y0 = 0.16;
  k.box('stone', w + 0.14, y0, d + 0.14, 0, 0, 0, { c: 0xb8b2a0, nb: true });
  storey(k, {
    w, d, h, y: y0, mat: 'stone', tint: 0xe6dfcf, st,
    f: [{ t: 'door', x: 0.5, w: 0.75, h: 1.4, step: false }, { t: 'win', x: -0.6, y: 0.75, w: 0.4, h: 0.45, shut: true, shutc: st.shut }],
    r: [], l: [{ t: 'win', x: 0, y: 0.75, w: 0.4, h: 0.45 }], b: [],
  });
  k.box('timber', w + 0.1, 0.12, d + 0.1, 0, y0 + h, 0, { c: tc, nb: true });
  const roof = gableRoof(k, { w, d, y: y0 + h + 0.12, type: 'shingles', R: 1.0, ox: 0.28, oz: 0.3, tint: 0xa59a88, fill: { key: 'stone', tint: 0xe6dfcf }, tc });
  chimneyAt(k, 0.6, y0 + h + 0.2, -0.3, 1.2, 0.4, 0.4);
  k.pop();
  // cut stone stacks
  stoneBlocks(k, 1.3, 2.2, 4, 0.3);
  stoneBlocks(k, -0.9, 2.5, 3, -0.2);
  k.box('stone', 1.0, 0.5, 0.8, 2.3, 0, 0.8, { c: 0xd8d2c0, ry: 0.4 });
  k.box('stone', 0.8, 0.4, 0.7, 2.4, 0.5, 0.9, { c: 0xc7c0ae, ry: 0.1 });
  // rubble
  for (let i = 0; i < 6; i++) {
    const a = k.r() * 6.28, rr = 0.2 + k.r() * 0.15;
    k.sph('stone', rr, rr * 0.7, rr, 2.4 + Math.cos(a) * 0.6, rr * 0.5, -0.6 + Math.sin(a) * 0.5, 5, 3, { c: k.r.pick(STONES) });
  }
  // wooden crane with treadwheel
  const cx = 1.5, cz = -1.5;
  k.push(cx, 0, cz, 0.3);
  for (const sx of [-1, 1]) {
    k.bar('timber', [sx * 0.9, 0, 0.5], [sx * 0.1, 3.4, 0], 0.16, 0.16, { c: tc });
    k.bar('timber', [sx * 0.9, 0, -0.5], [sx * 0.1, 3.4, 0], 0.16, 0.16, { c: tc });
  }
  k.bar('timber', [-0.9, 1.2, 0.35], [0.9, 1.2, 0.35], 0.1, 0.1, { c: tc });
  k.bar('timber', [-0.1, 3.4, 0], [0.1, 3.4, 0], 0.2, 0.2, { c: tc });
  // wheel on the side
  k.push(1.05, 1.55, 0, 0);
  k.cyl('timber', 1.05, 1.05, 0.14, 0.0, 0, 0, 10, { c: 0x6a4a2c, rz: Math.PI / 2, caps: 'none' });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI;
    k.bar('timber', [0, Math.sin(a) * 1.05, Math.cos(a) * 1.05], [0, -Math.sin(a) * 1.05, -Math.cos(a) * 1.05], 0.1, 0.1, { c: 0x6a4a2c });
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    k.box('planks', 0.4, 0.05, 0.22, 0.05, Math.sin(a) * 1.0, Math.cos(a) * 1.0, { c: 0xa87f50, rx: -a, ao: false });
  }
  k.pop();
  // hanging rope + stone block
  k.bar('flat', [0, 3.3, 0.0], [0, 1.45, 0.0], 0.03, 0.03, { c: 0x8a7a5a });
  k.box('stone', 0.5, 0.4, 0.5, 0, 0.95, 0, { c: 0xd8d2c0 });
  k.bar('flat', [-0.2, 1.5, 0], [0, 1.35, 0], 0.025, 0.025, { c: 0x8a7a5a });
  k.pop();
  // pickaxes and a barrow
  k.bar('timber', [-2.3, 0.0, 1.0], [-2.1, 1.0, 1.2], 0.06, 0.06, { c: 0x6a4a2c });
  k.box('flat', 0.4, 0.06, 0.06, -2.1, 1.0, 1.2, { c: IRON, rz: 0.2, ao: false });
  k.push(-2.0, 0, 2.0, 0.5);
  k.box('planks', 0.6, 0.12, 0.9, 0, 0.3, 0, { c: 0xa87f50 });
  wheel(k, 0, 0.2, 0.55, 0.2);
  k.pop();
  barrel(k, -2.4, -0.3, 0, 0.9);
}

// Round window with stone ring and spokes, +z plane. glass: material key(s) (array -> coloured wedges)
function roseAt(k, x, y, r, glass = 'win') {
  k.push(x, y, 0);
  const seg = 10;
  const keys = Array.isArray(glass) ? glass : [glass];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const g = newGeo();
    tri(g, [0, 0, 0.04], [Math.cos(a0) * r, Math.sin(a0) * r, 0.04], [Math.cos(a1) * r, Math.sin(a1) * r, 0.04]);
    k.geo(keys[i % keys.length], g, 0, 0, 0, 0, { ao: false });
  }
  k.cyl('stone', r + 0.22, r + 0.22, 0.12, 0, 0, 0, seg, { c: 0xe2dccb, rx: Math.PI / 2, caps: 'none' });
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2 + Math.PI / seg;
    k.bar('stone', [0, 0, 0.06], [Math.cos(a) * r, Math.sin(a) * r, 0.06], 0.07, 0.07, { c: 0xdcd5c4 });
  }
  const rg = newGeo();
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    quadG(rg, [Math.cos(a0) * (r + 0.22), Math.sin(a0) * (r + 0.22), 0.12], [Math.cos(a1) * (r + 0.22), Math.sin(a1) * (r + 0.22), 0.12],
      [Math.cos(a1) * r, Math.sin(a1) * r, 0.12], [Math.cos(a0) * r, Math.sin(a0) * r, 0.12]);
  }
  k.geo('stone', rg, 0, 0, 0, 0, { c: 0xe2dccb, ao: false });
  k.pop();
}

function sawGeo(R, teeth) {
  const g = newGeo();
  const pts = [];
  for (let i = 0; i < teeth * 2; i++) {
    const a = (i / (teeth * 2)) * Math.PI * 2;
    const rr = i % 2 ? R : R * 0.88;
    pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
  }
  const hz = 0.025;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    tri(g, [0, 0, hz], [a[0], a[1], hz], [b[0], b[1], hz]);
    tri(g, [0, 0, -hz], [b[0], b[1], -hz], [a[0], a[1], -hz]);
    quadG(g, [a[0], a[1], -hz], [b[0], b[1], -hz], [b[0], b[1], hz], [a[0], a[1], hz]);
  }
  return g;
}

function sawmill(k, st) {
  const tc = TIMBERS[1];
  k.box('planks', 6.0, 0.16, 3.8, 0, 0, 0, { c: 0xb89060, nb: true });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    k.box('timber', 0.26, 2.7, 0.26, sx * 2.75, 0.16, sz * 1.65, { c: tc });
    k.bar('timber', [sx * 2.75, 1.7, sz * 1.65], [sx * 2.2, 2.7, sz * 1.65], 0.1, 0.1, { c: tc });
    k.bar('timber', [sx * 2.75, 1.7, sz * 1.65], [sx * 2.75, 2.7, sz * 1.1], 0.1, 0.1, { c: tc });
  }
  k.box('timber', 6.1, 0.22, 0.24, 0, 2.7, 1.65, { c: tc });
  k.box('timber', 6.1, 0.22, 0.24, 0, 2.7, -1.65, { c: tc });
  for (const sx of [-1, 1]) k.box('timber', 0.24, 0.22, 3.6, sx * 2.75, 2.7, 0, { c: tc });
  const roof = gableRoof(k, { w: 6.0, d: 3.8, y: 2.92, type: 'shingles', R: 1.25, ox: 0.35, oz: 0.4, tint: st.shingle, fill: { key: 'planks', tint: 0xd8b888 }, tc });
  // back wall planks
  k.box('planks', 5.3, 2.3, 0.1, 0, 0.16, -1.8, { c: 0xdcc096, nb: true });
  // saw bench and frame
  k.box('planks', 3.8, 0.12, 1.0, 0.3, 0.93, 0.15, { c: 0xc29a68 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box('timber', 0.14, 0.77, 0.14, 0.3 + sx * 1.8, 0.16, 0.15 + sz * 0.4, { c: tc });
  for (const sx of [-1, 1]) {
    k.box('timber', 0.18, 2.2, 0.18, 0.2 + sx * 1.0, 0.16, 0.15, { c: tc });
    k.bar('timber', [0.2 + sx * 1.0, 0.7, 0.15], [0.2 + sx * 1.5, 0.16, 0.5], 0.1, 0.1, { c: tc });
  }
  k.box('timber', 2.3, 0.16, 0.2, 0.2, 2.15, 0.15, { c: tc });
  const sb = k.sub('sawblade', 0.2, 1.45, 0.15);
  sb.geo('flat', sawGeo(0.88, 14), 0, 0, 0, 0, { c: 0xa7aab0, ao: false });
  sb.cyl('flat', 0.14, 0.14, 0.14, 0, 0, -0.07, 8, { c: 0x5a5a5e, rx: Math.PI / 2, ao: false });
  // log being cut + stack
  k.cyl('timber', 0.24, 0.24, 2.6, -1.7, 1.2, 0.15, 7, { c: 0x7a5a3a, rz: Math.PI / 2, caps: 'none' });
  k.disc('flat', 0.22, -1.7 + 0.0, 1.2, 0.15, 7, { rz: Math.PI / 2, c: 0xdcbf8c, ao: false });
  // finished planks stack with spacers
  for (let i = 0; i < 5; i++) {
    k.box('planks', 1.9, 0.1, 0.62, 2.45 + (k.r() - 0.5) * 0.05, 0.16 + i * 0.16, 2.35 + (k.r() - 0.5) * 0.04, { c: k.r.pick(WOODS), ry: 0.04 });
    k.box('timber', 0.1, 0.06, 0.66, 1.85, 0.26 + i * 0.16, 2.35, { c: tc });
    k.box('timber', 0.1, 0.06, 0.66, 3.05, 0.26 + i * 0.16, 2.35, { c: tc });
  }
  logPile(k, -2.3, 2.45, 0.1, 1.9, [4, 3, 2, 1]);
  // sawhorse + sawdust
  k.disc('flat', 0.7, 0.4, 0.17, 0.9, 7, { c: 0xd8bc86, ao: false });
  k.push(1.6, 0.16, 1.05, 0.3);
  for (const sx of [-1, 1]) {
    k.bar('timber', [sx * 0.45, 0, -0.18], [sx * 0.2, 0.6, 0], 0.07, 0.07, { c: 0x6a4a2c });
    k.bar('timber', [sx * 0.45, 0, 0.18], [sx * 0.2, 0.6, 0], 0.07, 0.07, { c: 0x6a4a2c });
  }
  k.bar('timber', [-0.3, 0.62, 0], [0.3, 0.62, 0], 0.1, 0.1, { c: 0x6a4a2c });
  k.pop();
  barrel(k, -3.4, 0.7, 0, 0.9);
  lanternAt(k, 2.75 - 0.0, 2.0, 1.65, 0.0);
}

function farmhouse(k, st) {
  const w = 4.2, d = 3.0, h = 2.1, y0 = 0.25;
  const tc = st.timber;
  k.push(-0.6, 0, -0.5, 0);
  plinth(k, w, d, y0, 0, 0, st.stone);
  storey(k, {
    w, d, h, y: y0, tint: st.plaster, frame: true, tc, st, mid: 1.0,
    f: [
      { t: 'door', x: -0.4, w: 0.85, h: 1.65 },
      { t: 'win', x: -1.5, y: 0.75, w: 0.6, h: 0.7, shut: true },
      { t: 'win', x: 0.75, y: 0.75, w: 0.6, h: 0.7, shut: true, flowers: true },
      { t: 'win', x: 1.5, y: 0.8, w: 0.4, h: 0.5 },
    ],
    r: [{ t: 'win', x: 0, y: 0.8, w: 0.55, h: 0.7, shut: true }],
    l: [{ t: 'win', x: 0, y: 0.8, w: 0.55, h: 0.7, shut: true }],
    b: [{ t: 'win', x: -0.9, y: 0.8, w: 0.55, h: 0.7, shut: true }, { t: 'win', x: 0.9, y: 0.8, w: 0.55, h: 0.7, shut: true }],
  });
  const R = 1.55;
  const roof = gableRoof(k, { w, d, y: y0 + h, type: 'thatch', R, ox: 0.3, oz: 0.42, tint: st.thatch, fill: { key: 'plaster', tint: st.plaster }, tc });
  for (const s of [-1, 1]) {
    k.push(s * w / 2, y0 + h, 0, s * Math.PI / 2);
    gableFrame(k, d, R, tc);
    k.pop();
  }
  gableChimney(k, -1, w, 0.0, y0 + h + 0.3, y0 + h + roof.ridge);
  k.pop();
  // hay bales, cart, fence, scarecrow, sheaves
  hayBale(k, 2.0, -1.5, 0, 0.2);
  hayBale(k, 2.1, -1.5, 0.5, 0.3, 0.9);
  hayBale(k, 2.3, -0.6, 0, -0.3);
  hayBale(k, 2.0, 0.0, 0, 0.1, 0.9);
  cart(k, 2.7, 1.9, -1.4, 'hay');
  fence(k, -3.6, 1.8, -1.6, 2.3, 'rail', 0.75);
  fence(k, -1.6, 2.3, -0.6, 2.3, 'rail', 0.75);
  for (let i = 0; i < 4; i++) {
    k.cone('hay', 0.28, 0.75, -3.3 + i * 0.4, 0, 0.9 + (i % 2) * 0.2, 6, { c: 0xf0d890, caps: 'none' });
    k.box('flat', 0.4, 0.04, 0.04, -3.3 + i * 0.4, 0.35, 0.9 + (i % 2) * 0.2, { c: 0x6a4a2c, ao: false });
  }
  // scarecrow
  k.push(0.4, 0, 2.7, 0.3);
  k.bar('timber', [0, 0, 0], [0, 1.5, 0], 0.07, 0.07, { c: 0x6a4a2c });
  k.bar('timber', [-0.55, 1.25, 0], [0.55, 1.25, 0], 0.06, 0.06, { c: 0x6a4a2c });
  k.sph('flat', 0.15, 0.15, 0.15, 0, 1.6, 0, 5, 3, { c: 0xdcc88a });
  k.cyl('flat', 0.28, 0.12, 0.05, 0, 1.73, 0, 6, { c: 0x6a4a2c });
  k.cone('flat', 0.14, 0.2, 0, 1.76, 0, 6, { c: 0x6a4a2c });
  k.box('cloth', 0.34, 0.5, 0.12, 0, 0.8, 0, { c: 0x8a5a3a, ao: false });
  k.pop();
  barrel(k, -3.5, -0.3, 0, 1);
  crate(k, -3.55, -1.0, 0, 0.9, 0.3);
}

function mill(k, st) {
  const seg = 8, rot = -Math.PI / seg;
  const rb = 1.6, rt = 1.1, H = 4.4;
  const rAt = (y) => rb + (rt - rb) * (y / H);
  const apAt = (y) => rAt(y) * Math.cos(Math.PI / seg);
  k.cyl('stone', rb + 0.25, rb + 0.12, 0.5, 0, 0, 0, seg, { c: 0xbdb7a5, caps: 'none', rot });
  k.cyl('plaster', rb, rt, H, 0, 0.5, 0, seg, { c: 0xf6f0e0, caps: 'none', rot });
  for (const y of [0.5, 2.6]) {
    k.cyl('timber', rAt(y) + 0.06, rAt(y) + 0.06, 0.13, 0, y, 0, seg, { c: TIMBERS[0], caps: 'none', rot });
  }
  const yt = 0.5 + H;
  k.cyl('timber', rt + 0.15, rt + 0.1, 0.18, 0, yt - 0.08, 0, seg, { c: TIMBERS[0], rot });
  // shingled cap
  k.cyl('shingles', rt + 0.28, rt * 0.82, 0.7, 0, yt + 0.1, 0, seg, { c: 0x9a7a54, caps: 'none', rot });
  k.cyl('shingles', rt * 0.82, rt * 0.4, 0.7, 0, yt + 0.8, 0, seg, { c: 0x9a7a54, caps: 'none', rot });
  k.cyl('shingles', rt * 0.4, 0.0, 0.5, 0, yt + 1.5, 0, seg, { c: 0x8a6a46, caps: 'none', rot });
  k.sph('flat', 0.1, 0.1, 0.1, 0, yt + 2.02, 0, 4, 3, { c: GOLD, ao: false });
  // face-mounted details
  const onFace = (i, y, fn) => {
    const a = i * Math.PI / 4;
    const ap = apAt(y);
    k.push(Math.sin(a) * ap, y, Math.cos(a) * ap, a);
    fn();
    k.pop();
  };
  onFace(0, 0.6, () => { doorAt(k, 0, 0.95, 1.7, { arch: true, step: true }); });
  onFace(0, 3.4, () => { windowAt(k, 0, 0, 0.5, 0.7, { shut: true, shutc: st.shut }); });
  onFace(2, 1.9, () => { windowAt(k, 0, 0, 0.45, 0.6, { shut: true, shutc: st.shut }); });
  onFace(6, 1.9, () => { windowAt(k, 0, 0, 0.45, 0.6, { shut: true, shutc: st.shut }); });
  onFace(4, 1.9, () => { windowAt(k, 0, 0, 0.45, 0.6, { shut: true, shutc: st.shut }); });
  onFace(0, 3.1, () => { k.box('timber', 1.6, 0.12, 0.5, 0, 0, 0.1, { c: TIMBERS[0], wall: true }); });
  // sails: 4 lattice arms on a hub at the cap front, spinning about z
  const hubY = yt + 0.55, hubZ = rt * 0.9 + 0.55;
  k.cyl('timber', 0.13, 0.13, 1.0, 0, hubY, hubZ - 0.9, 6, { c: TIMBERS[0], rx: Math.PI / 2 });
  const sails = k.sub('sails', 0, hubY, hubZ);
  sails.stack[0].scale(new THREE.Vector3(0.88, 0.88, 1));
  sails.cyl('timber', 0.3, 0.26, 0.4, 0, 0, -0.05, 6, { c: TIMBERS[0], rx: Math.PI / 2 });
  for (let a = 0; a < 4; a++) {
    sails.push(0, 0, 0, 0, 1, a * Math.PI / 2);
    sails.box('timber', 0.16, 4.5, 0.12, 0, 0.1, 0.3, { c: TIMBERS[1], wall: false });
    // lattice frame on one side of the stock
    for (const sx of [0.15, 1.0]) sails.box('timber', 0.07, 3.1, 0.07, sx + 0.05, 1.2, 0.36, { c: 0x6a4a2c });
    for (let i = 0; i <= 8; i++) sails.box('timber', 0.95, 0.045, 0.045, 0.62, 1.2 + i * 0.385, 0.38, { c: 0x6a4a2c, nb: true });
    // sail cloth on the outer part
    sails.quad('cloth', [0.2, 2.5, 0.4], [0.97, 2.5, 0.4], [0.97, 4.1, 0.4], [0.2, 4.1, 0.4], { c: 0xece4cc });
    sails.pop();
  }
  // props
  sack(k, 1.9, 1.9, 0, 0xefe8d8);
  sack(k, 2.25, 1.7, 0, 0xefe8d8, 0.95);
  sack(k, 2.0, 2.25, 0, 0xdad0b0, 0.9);
  sack(k, 2.05, 1.95, 0.35, 0xefe8d8, 0.9);
  cart(k, -2.1, 1.7, -0.4, 'sacks');
  for (let i = 0; i < 3; i++) k.cone('hay', 0.26, 0.7, -2.3 + i * 0.4, 0, -1.4, 6, { c: 0xf0d890, caps: 'none' });
  barrel(k, 2.5, -0.6, 0, 0.9);
  bush(k, -2.4, -0.4, 0.4);
  stoneBlocks(k, 0.5, -2.5, 2);
}

function bakery(k, st) {
  const w = 3.5, d = 2.8, h = 2.0, y0 = 0.25;
  const tc = st.timber;
  k.push(-0.4, 0, -0.3, 0);
  plinth(k, w, d, y0, 0, 0, st.stone);
  const awnCol = [0xa9362e, 0xf1e8d2];
  storey(k, {
    w, d, h, y: y0, tint: st.plaster, frame: true, tc, st, mid: 1.0,
    f: [
      { t: 'door', x: -0.9, w: 0.85, h: 1.65, step: true },
      {
        t: 'fn', fn: (kk) => {
          // serving window with shelf and loaves
          windowAt(kk, 0.7, 0.8, 0.85, 0.7, { shut: true, shutc: 0x8a5a3a, tc });
          kk.box('planks', 1.1, 0.07, 0.4, 0.7, 0.78, 0.2, { c: 0xc29a68 });
          for (let i = 0; i < 4; i++) kk.sph('flat', 0.12, 0.07, 0.07, 0.4 + i * 0.22, 0.88, 0.22, 5, 3, { c: 0xd9a050, ao: false });
          // striped awning
          for (let i = 0; i < 6; i++) {
            const x0 = 0.7 - 0.6 + i * 0.2;
            kk.quad('cloth', [x0, 1.95, 0.05], [x0 + 0.2, 1.95, 0.05], [x0 + 0.2, 1.62, 0.72], [x0, 1.62, 0.72], { c: awnCol[i % 2], ao: false });
          }
          kk.box('flat', 1.2, 0.05, 0.05, 0.7, 1.58, 0.72, { c: 0x4d3220, wall: true });
        },
      },
      { t: 'lantern', x: -1.5, y: 1.55 },
    ],
    r: [{ t: 'win', x: 0, y: 0.8, w: 0.55, h: 0.7, shut: true }],
    l: [], b: [{ t: 'win', x: 0, y: 0.8, w: 0.55, h: 0.7, shut: true }],
  });
  const R = 1.35;
  const roof = gableRoof(k, { w, d, y: y0 + h, type: 'tiles', R, ox: 0.28, oz: 0.34, tint: st.tile, fill: { key: 'plaster', tint: st.plaster }, tc });
  for (const s of [-1, 1]) {
    k.push(s * w / 2, y0 + h, 0, s * Math.PI / 2);
    gableFrame(k, d, R, tc);
    k.pop();
  }
  chimneyAt(k, 0.9, y0 + h + 0.4, -0.5, 1.3, 0.55, 0.55);
  // brick oven on the left side
  const ox = -w / 2 - 0.95;
  k.box('stone', 1.5, 0.55, 1.4, ox, 0, 0.1, { c: 0xe0d6c0, nb: true });
  k.sph('stone', 0.78, 0.7, 0.72, ox, 0.55, 0.1, 8, 4, { c: 0xd9a58a, hemi: true });
  k.box('flat', 0.5, 0.38, 0.06, ox + 0.0, 0.62, 0.78, { c: 0x1a120c, ao: false });
  chimneyAt(k, ox - 0.1, 1.1, -0.35, 1.0, 0.36, 0.36, 0xdcd0b8);
  k.pop();
  // props: bread baskets, flour sacks, bench, firewood, sign
  const loafBasket = (x, z) => {
    k.cyl('planks', 0.26, 0.34, 0.3, x, 0, z, 7, { c: 0xc29a68, caps: 'none' });
    for (let i = 0; i < 4; i++) k.sph('flat', 0.14, 0.08, 0.08, x + (i % 2 - 0.5) * 0.18, 0.3, z + (i > 1 ? 0.1 : -0.1), 5, 3, { c: 0xd9a050, ao: false, ry: i });
  };
  loafBasket(1.35, 1.9);
  loafBasket(0.9, 2.15);
  sack(k, 1.9, 1.3, 0, 0xefe8d8);
  sack(k, 2.15, 1.55, 0, 0xefe8d8, 0.9);
  bench(k, -1.4, 1.95, 0.1, 1.1);
  woodpile(k, -2.95, 1.2, 0.2, 1.0, 3);
  k.push(-0.4 + 1.3, 0, -0.3 + 1.45, 0);
  k.bar('flat', [0.25, 1.9, 0.02], [0.25, 1.9, 0.6], 0.04, 0.04, { c: IRON });
  k.bar('flat', [0.25, 2.2, 0.02], [0.25, 1.88, 0.02], 0.04, 0.04, { c: IRON });
  k.pop();
  flowerBed(k, 2.1, -0.4, 0.45, 1.0, 0);
}

function chapel(k, st) {
  const w = 5.9, d = 3.6, h = 3.1, y0 = 0.3;
  const tc = TIMBERS[1];
  const stoneT = 0xe6dfcf;
  const awin = (x) => ({ t: 'awin', x, y: 0.95, w: 0.62, h: 1.55 });
  const buttress = (x) => ({ t: 'fn', fn: (kk) => kk.frus('stone', 0.5, 0.6, 0.34, 0.26, 2.85, x, 0, 0.2, { c: 0xd8d1c0 }) });
  k.push(0, 0, -0.9, -Math.PI / 2);
  k.box('stone', w + 0.3, y0, d + 0.3, 0, 0, 0, { c: 0xb0aa98, nb: true });
  storey(k, {
    w, d, h, y: y0, mat: 'stone', tint: stoneT, st,
    f: [awin(-1.9), awin(0), awin(1.9), buttress(-0.95), buttress(0.95), buttress(-2.85), buttress(2.85)],
    b: [awin(-1.9), awin(0), awin(1.9), buttress(-0.95), buttress(0.95), buttress(-2.85), buttress(2.85)],
    l: [{ t: 'fn', fn: (kk) => roseAt(kk, 0, 1.9, 0.5, 'win') }],
    r: [],
  });
  k.box('stone', w + 0.1, 0.16, d + 0.1, 0, y0 + h, 0, { c: 0xcfc8b6, nb: true });
  const R = 2.0;
  const roof = gableRoof(k, { w, d, y: y0 + h + 0.16, type: 'slate', R, ox: 0.28, oz: 0.35, tint: 0xd4d8e2, fill: { key: 'stone', tint: stoneT }, tc });
  k.pop();
  // front bell tower
  const topY = belfryTower(k, {
    x: 0, z: 3.15, w: 2.4, h: 4.6, bh: 1.7, spire: 3.4, tint: stoneT,
    front: [{ t: 'door', x: 0, w: 1.1, h: 2.0, arch: true, step: true }, { t: 'lantern', x: -1.0, y: 1.6 }, { t: 'lantern', x: 1.0, y: 1.6 }],
  });
  // graveyard on the +x side
  fence(k, 2.5, -0.5, 3.8, -0.5, 'picket', 0.5);
  fence(k, 3.8, -0.5, 3.8, -2.5, 'picket', 0.5);
  fence(k, 2.5, -2.5, 3.8, -2.5, 'picket', 0.5);
  const stoneAt = (x, z, ry, cross) => {
    k.push(x, 0, z, ry);
    if (cross) {
      k.box('stone', 0.14, 0.7, 0.1, 0, 0, 0, { c: 0xd0cab8 });
      k.box('stone', 0.42, 0.12, 0.1, 0, 0.42, 0, { c: 0xd0cab8 });
    } else {
      k.box('stone', 0.36, 0.5, 0.1, 0, 0, 0, { c: 0xc7c0ae });
      k.sph('stone', 0.18, 0.12, 0.05, 0, 0.5, 0, 5, 2, { c: 0xc7c0ae, hemi: true });
    }
    k.pop();
  };
  stoneAt(3.0, -1.0, 0.1, false);
  stoneAt(3.4, -1.7, -0.15, true);
  stoneAt(2.95, -2.1, 0.2, false);
  stoneAt(3.5, -0.9, 0, false);
  bush(k, 2.2, 1.7, 0.4);
  bush(k, -2.2, 1.9, 0.4);
  flowerBed(k, -2.1, -1.0, 0.45, 1.4, 0);
  bench(k, -2.8, 0.6, Math.PI / 2, 1.1);
}

function tavern(k, st) {
  const w = 5.6, d = 3.9, h1 = 2.3, h2 = 2.05, y0 = 0.3, jet = 0.38;
  const tc = TIMBERS[0];
  plinth(k, w, d, y0, 0, 0, st.stone);
  const wn = (x, y, sh = true, ww = 0.7, hh = 0.85, fl = false) => ({ t: 'win', x, y, w: ww, h: hh, shut: sh, shutc: st.shut, flowers: fl });
  storey(k, {
    w, d, h: h1, y: y0, tint: st.plaster, frame: true, tc, st, mid: 1.15,
    f: [
      { t: 'door', x: 0.3, w: 1.0, h: 1.85, awning: 0xc89a6a },
      wn(-1.7, 0.85, true, 0.8, 0.9, true), wn(1.95, 0.85, true, 0.8, 0.9, true),
      { t: 'lantern', x: -0.5, y: 1.65 },
    ],
    r: [wn(-0.6, 0.85), wn(0.9, 0.85)], l: [wn(-0.6, 0.85), wn(0.9, 0.85)],
    b: [wn(-1.7, 0.85), wn(0, 0.85), wn(1.7, 0.85)],
  });
  const yb = y0 + h1;
  const wu = w + 0.14, du = d + jet + 0.04, zu = (jet + 0.04) / 2 - 0.04;
  k.box('timber', wu + 0.06, 0.22, 0.36, 0, yb - 0.11, d / 2 + 0.05, { c: tc });
  for (let i = -2; i <= 2; i++) k.bar('timber', [i * 1.15, yb - 0.55, d / 2 - 0.02], [i * 1.15, yb - 0.1, d / 2 + 0.3], 0.1, 0.1, { c: tc });
  storey(k, {
    w: wu, d: du, h: h2, y: yb, z: zu, tint: st.plaster, frame: true, tc, st, sp: 0.95,
    f: [wn(-1.9, 0.5, true, 0.6, 0.8, true), wn(-0.6, 0.5, true, 0.6, 0.8, true), wn(0.7, 0.5, true, 0.6, 0.8, true), wn(2.0, 0.5, true, 0.6, 0.8, true)],
    r: [wn(-0.6, 0.5), wn(0.9, 0.5)], l: [wn(-0.6, 0.5), wn(0.9, 0.5)],
    b: [wn(-1.7, 0.5), wn(0, 0.5), wn(1.7, 0.5)],
  });
  const R = 2.0;
  const roof = gableRoof(k, { w: wu, d: du, y: yb + h2, z: zu, type: 'tiles', R, ox: 0.32, oz: 0.38, tint: st.tile, fill: { key: 'plaster', tint: st.plaster }, tc });
  for (const s of [-1, 1]) {
    k.push(s * wu / 2, yb + h2, zu, s * Math.PI / 2);
    gableFrame(k, du, R, tc);
    k.pop();
  }
  dormerAt(k, { x: 0.65, y0: yb + h2, zf: zu + du / 2 - 0.15, d: du, R, t: roof.t, type: 'tiles', tint: st.tile, wallTint: st.plaster, shut: st.shut, tc, bw: 1.1 });
  gableChimney(k, 1, wu, zu - 0.2, yb + h2 + 0.2, yb + h2 + roof.ridge);
  chimneyAt(k, -1.6, yb + h2 + 0.9, zu - 0.5, 1.4, 0.55, 0.55);
  // hanging sign (tankard) from the right front corner
  k.bar('timber', [w / 2 + 0.05, yb - 0.2, d / 2 + 0.35], [w / 2 + 0.05, yb - 0.2, d / 2 + 1.55], 0.12, 0.12, { c: tc });
  k.bar('flat', [w / 2 + 0.05, yb - 0.2, d / 2 + 1.55], [w / 2 + 0.05, yb - 0.75, d / 2 + 1.55], 0.03, 0.03, { c: IRON });
  k.box('planks', 0.07, 0.8, 0.85, w / 2 + 0.05, yb - 1.6, d / 2 + 1.12, { c: 0xe0c898 });
  k.bar('flat', [w / 2 + 0.05, yb - 0.3, d / 2 + 0.75], [w / 2 + 0.05, yb - 0.8, d / 2 + 0.75], 0.03, 0.03, { c: IRON });
  k.bar('flat', [w / 2 + 0.05, yb - 0.3, d / 2 + 1.5], [w / 2 + 0.05, yb - 0.8, d / 2 + 1.5], 0.03, 0.03, { c: IRON });
  k.cyl('flat', 0.22, 0.2, 0.42, w / 2 + 0.12, yb - 1.55, d / 2 + 1.12, 7, { c: 0xe0b038, rz: 0, ao: false });
  k.cyl('flat', 0.2, 0.2, 0.1, w / 2 + 0.12, yb - 1.15, d / 2 + 1.12, 7, { c: 0xf8f4e8, ao: false });
  k.bar('flat', [w / 2 + 0.28, yb - 1.4, d / 2 + 1.12], [w / 2 + 0.28, yb - 1.55, d / 2 + 1.12], 0.08, 0.08, { c: 0xe0b038, ao: false });
  // outdoor seating, barrels, lantern post
  table(k, -2.1, 3.0, 0.1);
  bench(k, -2.1, 3.55, 0, 1.0);
  bench(k, -2.1, 2.45, 0, 1.0);
  table(k, -3.2, 2.3, 0.4);
  barrel(k, 3.2, 2.1, 0, 1);
  barrel(k, 3.55, 1.6, 0, 1);
  barrel(k, 3.35, 2.15, 0.62, 0.85);
  crate(k, 2.6, 2.75, 0, 0.9, 0.2);
  k.box('timber', 0.1, 2.0, 0.1, 1.8, 0, 3.3, { c: tc });
  lanternAt(k, 1.8, 1.85, 3.3, 0.0);
  flowerBed(k, 0.4, 2.55, 1.0, 0.4);
}

// ---------------------------------------------------------------- scaffolding

const POLE = 0x8a6a46;
const ROPE = 0xb8a070;

function ladder(k, x, z, ry, H, lean = 0.22) {
  k.push(x, 0, z, ry);
  for (const sx of [-1, 1]) k.bar('timber', [sx * 0.22, 0, lean * H], [sx * 0.22, H, 0], 0.06, 0.05, { c: POLE });
  const n = Math.floor(H / 0.32);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    k.bar('timber', [-0.22, H * t, lean * H * (1 - t)], [0.22, H * t, lean * H * (1 - t)], 0.04, 0.04, { c: 0xa88a60 });
  }
  k.pop();
}

// Straight scaffold run (two pole lines 0.9 apart) from (x1,z1) to (x2,z2); the inner line is on the +local x side.
function scaffoldRun(k, x1, z1, x2, z2, H = 4, levels = 2, opt = {}) {
  const len = Math.hypot(x2 - x1, z2 - z1);
  if (len < 0.5) return;
  const n = Math.max(1, Math.round(len / 2.2));
  const wid = 0.9;
  k.push(x1, 0, z1, Math.atan2(x2 - x1, z2 - z1));
  for (let i = 0; i <= n; i++) {
    const pz = (len * i) / n + (i > 0 && i < n ? (k.r() - 0.5) * 0.15 : 0);
    for (const px of [0, wid]) {
      const hh = H + 0.4 + k.r() * 0.5;
      k.cyl('timber', 0.06, 0.075, hh, px, 0, pz, 5, { c: POLE, j: 0.1, rz: (k.r() - 0.5) * 0.03 });
    }
    for (let j = 1; j <= levels; j++) {
      const y = (H * j) / (levels + 0.25);
      k.bar('timber', [0, y, pz], [wid, y, pz], 0.07, 0.07, { c: 0x7a5a3a });
      k.box('flat', 0.13, 0.07, 0.13, 0, y - 0.03, pz, { c: ROPE, ao: false });
      k.box('flat', 0.13, 0.07, 0.13, wid, y - 0.03, pz, { c: ROPE, ao: false });
    }
  }
  for (let j = 1; j <= levels; j++) {
    const y = (H * j) / (levels + 0.25);
    for (const px of [0, wid]) k.bar('timber', [px, y, 0], [px, y, len], 0.07, 0.07, { c: 0x7a5a3a });
    if (opt.deck !== false && j <= 2) {
      const pn = Math.max(1, Math.floor(len / 1.2));
      for (let i = 0; i < pn; i++) {
        k.box('planks', 1.0, 0.05, len / pn - 0.03, wid / 2, y + 0.03, (len * (i + 0.5)) / pn, { c: k.r.pick(WOODS), ry: (k.r() - 0.5) * 0.02 });
      }
    }
  }
  k.bar('timber', [0, 0.1, 0], [0, H * 0.85, len], 0.06, 0.05, { c: 0x7a5a3a });
  k.bar('timber', [0, 0.1, len], [0, H * 0.85, 0], 0.06, 0.05, { c: 0x7a5a3a });
  k.pop();
}

function plankPile(k, x, z, ry = 0, n = 5) {
  k.push(x, 0, z, ry);
  for (let i = 0; i < n; i++) {
    k.box('planks', 1.6 + k.r() * 0.2, 0.09, 0.45, (k.r() - 0.5) * 0.06, 0.1 + i * 0.1, (k.r() - 0.5) * 0.04, { c: k.r.pick(WOODS), ry: (k.r() - 0.5) * 0.06 });
  }
  for (const sx of [-0.6, 0.6]) k.box('timber', 0.1, 0.1, 0.5, sx, 0, 0, { c: 0x6a4a2c });
  k.pop();
}

// ---------------------------------------------------------------- cathedral

const CROSS = [
  [-4, 6], [4, 6], [4, 1.5], [8, 1.5], [8, -3.5], [4, -3.5],
  [4, -8.5], [-4, -8.5], [-4, -3.5], [-8, -3.5], [-8, 1.5], [-4, 1.5],
];
const CATH_C = [0, -1.5];

function cathedral(k, stage, st) {
  const T = 0.8;
  const wallH = 7;
  const stoneT = 0xe4ddcb;
  const stoneD = 0xcfc8b6;
  const stained = stage >= 4;
  const glass = (i) => (stained ? `st${i % 4}` : 'win');

  // cobble floor slabs
  k.box('cobble', 8.0, 0.14, 14.9, 0, 0, -1.25, { c: 0xcfc6b0, nb: true });
  k.box('cobble', 16.0, 0.14, 5.4, 0, 0, -1.0, { c: 0xcfc6b0, nb: true });

  const edges = [];
  for (let i = 0; i < CROSS.length; i++) {
    const [x1, z1] = CROSS[i];
    const [x2, z2] = CROSS[(i + 1) % CROSS.length];
    const mx = (x1 + x2) / 2, mz = (z1 + z2) / 2;
    const horizontal = z1 === z2;
    const len = Math.abs(horizontal ? x2 - x1 : z2 - z1);
    let nx = horizontal ? 0 : 1, nz = horizontal ? 1 : 0;
    if ((mx - CATH_C[0]) * nx + (mz - CATH_C[1]) * nz < 0) { nx = -nx; nz = -nz; }
    edges.push({ x1, z1, x2, z2, mx, mz, horizontal, len, nx, nz, ry: Math.atan2(nx, nz) });
  }

  if (stage === 0) {
    // foundation courses of rough stones + scaffolding outline
    for (const e of edges) {
      let pos = -e.len / 2;
      while (pos < e.len / 2 - 0.3) {
        const l = Math.min(0.9 + k.r() * 0.8, e.len / 2 - pos);
        const cx = pos + l / 2;
        const px = e.mx + (e.horizontal ? cx : 0), pz = e.mz + (e.horizontal ? 0 : cx);
        k.box('stone', e.horizontal ? l - 0.04 : 0.95, 0.5, e.horizontal ? 0.95 : l - 0.04, px, 0, pz, { c: k.r.pick(STONES), ry: (k.r() - 0.5) * 0.04, nb: true });
        if (k.r() < 0.45) {
          k.box('stone', e.horizontal ? l * 0.7 : 0.8, 0.4, e.horizontal ? 0.8 : l * 0.7, px, 0.5, pz, { c: k.r.pick(STONES), ry: (k.r() - 0.5) * 0.08 });
        }
        pos += l;
      }
    }
    for (const e of edges) {
      const ox = e.nx * 0.9, oz = e.nz * 0.9;
      scaffoldRun(k, e.x1 + ox, e.z1 + oz, e.x2 + ox, e.z2 + oz, 3.0, 1, { deck: false });
    }
    stoneBlocks(k, 0, 8.6, 4, 0.1);
    stoneBlocks(k, -2.5, 9.0, 3, -0.3);
    stoneBlocks(k, 2.8, 8.8, 3, 0.4);
    plankPile(k, 5.5, 5.5, 0.5);
    plankPile(k, -5.5, 6.0, -0.4);
    logPile(k, 6.5, 3.5, 1.2, 2.0, [4, 3, 2]);
    return;
  }

  // walls, buttresses, windows
  for (const e of edges) {
    const frontEdge = e.horizontal && e.z1 === 6;
    if (e.horizontal) k.box('stone', e.len + T, wallH, T, e.mx, 0, e.mz, { c: stoneT });
    else k.box('stone', T, wallH, e.len + T, e.mx, 0, e.mz, { c: stoneT });
    // plinth
    k.box('stone', e.horizontal ? e.len + T + 0.3 : T + 0.3, 0.8, e.horizontal ? T + 0.3 : e.len + T + 0.3, e.mx, 0, e.mz, { c: stoneD, nb: true });
    k.push(e.mx + e.nx * (T / 2), 0, e.mz + e.nz * (T / 2), e.ry);
    const nb = Math.max(1, Math.round(e.len / 3.0));
    for (let b = 0; b <= nb; b++) {
      const bx = -e.len / 2 + (e.len * b) / nb;
      const frus = k.frus('stone', 0.85, 1.1, 0.5, 0.42, wallH - 0.5, bx, 0, 0.45, { c: stoneD });
      void frus;
      if (stage >= 4) k.pyr('stone', 0.6, 0.6, 1.1, bx, wallH - 0.5, 0.45, { c: stoneD });
    }
    if (stage >= 2 && !(frontEdge && stage >= 3)) {
      const nw = Math.max(1, nb);
      for (let w = 0; w < nw; w++) {
        const wx = -e.len / 2 + (e.len * (w + 0.5)) / nw;
        if (frontEdge) {
          if (w === Math.floor(nw / 2) || nw === 1) continue;
        }
        archWindowAt(k, wx, 2.7, 1.0, 3.4, { glass: glass(w + edges.indexOf(e)) });
      }
    }
    if (stage >= 2 && frontEdge && stage < 3) {
      doorAt(k, 0, 2.2, 4.0, { arch: true, step: true });
    }
    k.pop();
  }
  // wall-top cornice
  for (const e of edges) {
    if (e.horizontal) k.box('stone', e.len + T + 0.3, 0.3, T + 0.3, e.mx, wallH, e.mz, { c: stoneD, nb: true });
    else k.box('stone', T + 0.3, 0.3, e.len + T + 0.3, e.mx, wallH, e.mz, { c: stoneD, nb: true });
  }

  const top = wallH + 0.3;
  if (stage === 1) {
    // unfinished: ragged wall tops, one scaffold side, tools
    for (const e of edges) {
      const n = Math.floor(e.len / 1.2);
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n - 0.5;
        if (k.r() < 0.5) {
          k.box('stone', e.horizontal ? 0.9 : 0.8, 0.35, e.horizontal ? 0.8 : 0.9,
            e.mx + (e.horizontal ? t * e.len : 0), top, e.mz + (e.horizontal ? 0 : t * e.len), { c: k.r.pick(STONES) });
        }
      }
    }
    const lx = -4.0 - 1.0;
    scaffoldRun(k, lx, 5.5, lx, -8.5, 6.5, 3);
    ladder(k, lx - 0.3, 1.0, Math.PI / 2, 6.0, 0.15);
    // portal
    k.push(0, 0, 6 + T / 2, 0);
    doorAt(k, 0, 2.2, 4.0, { arch: true, step: true });
    k.pop();
    stoneBlocks(k, 3.0, 8.2, 4, 0.2);
    stoneBlocks(k, -2.0, 8.8, 3, -0.3);
    plankPile(k, 6.0, 5.0, 0.4);
    // simple crane
    const cx = 6.5, cz = -6.5;
    k.bar('timber', [cx, 0, cz], [cx, 8.5, cz], 0.22, 0.22, { c: POLE });
    k.bar('timber', [cx, 8.3, cz], [cx - 5.2, 8.0, cz + 2.4], 0.16, 0.16, { c: POLE });
    k.bar('timber', [cx, 6.0, cz], [cx - 3.2, 7.9, cz + 1.4], 0.1, 0.1, { c: POLE });
    k.bar('flat', [cx - 4.9, 8.0, cz + 2.3], [cx - 4.9, 3.4, cz + 2.3], 0.03, 0.03, { c: ROPE });
    k.box('stone', 0.8, 0.6, 0.8, cx - 4.9, 2.8, cz + 2.3, { c: stoneT });
    return;
  }

  // roofs (slate)
  const slate = 0xd4d8e2;
  const navW = 8 + T;
  gableRoof(k, { w: 14.5 + T + 0.2, d: navW, y: top, x: 0, z: -1.25, ry: Math.PI / 2, type: 'slate', R: 4.5, ox: 0.3, oz: 0.4, tint: slate, fill: { key: 'stone', tint: stoneT }, tc: 0x4f5664 });
  gableRoof(k, { w: 16 + T, d: 5 + T, y: top, x: 0, z: -1.0, type: 'slate', R: 3.0, ox: 0.3, oz: 0.4, tint: slate, fill: { key: 'stone', tint: stoneT }, tc: 0x4f5664 });
  // roses on the gable ends
  const roseGlass = stained ? ['st0', 'st1', 'st2', 'st3'] : 'win';
  for (const s of [-1, 1]) {
    k.push(s * (8 + T / 2 + 0.05), top + 0.5, -1.0, s * Math.PI / 2);
    roseAt(k, 0, 0.8, 1.05, roseGlass);
    k.pop();
  }
  k.push(0, top + 0.6, -8.5 - T / 2 - 0.05, Math.PI);
  roseAt(k, 0, 1.0, 1.35, roseGlass);
  k.pop();
  // gable-top crosses
  for (const [x, y, z] of [[0, top + 4.6, -9.1], [8.4, top + 3.0, -1.0], [-8.4, top + 3.0, -1.0]]) {
    k.box('flat', 0.1, 0.7, 0.1, x, y, z, { c: GOLD, ao: false });
    k.box('flat', 0.4, 0.09, 0.09, x, y + 0.4, z, { c: GOLD, ao: false });
  }

  if (stage >= 3) {
    const towerW = 4.2;
    const topY = belfryTower(k, {
      x: 0, z: 7.6, w: towerW, h: 9.4, bh: 2.7, spire: stage >= 4 ? 11.5 : 3.2, y0: 0, tint: stoneT, cross: stage >= 4, slits: stage < 4,
      front: [
        { t: 'door', x: 0, w: 2.2, h: 3.9, arch: true, step: true },
        { t: 'fn', fn: (kk) => roseAt(kk, 0, 6.4, 0.85, stage >= 4 ? ['st0', 'st2', 'st1', 'st3'] : 'win') },
        { t: 'lantern', x: -1.8, y: 2.5 }, { t: 'lantern', x: 1.8, y: 2.5 },
      ],
    });
    for (const sx of [-1, 1]) {
      k.frus('stone', 1.0, 1.0, 0.7, 0.7, 9.4, sx * (towerW / 2 + 0.2), 0, 7.6 + towerW / 2 + 0.2, { c: stoneD });
    }
    // steps
    for (let i = 0; i < 3; i++) k.box('stone', 3.6 + i * 0.4, 0.16, 0.5, 0, i * 0.0, 9.9 + 0.5 * (2 - i) + 0.0, { c: stoneD, nb: true });
    if (stage >= 4) {
      // tower corner pinnacles and statues in niches
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        k.frus('stone', 0.55, 0.55, 0.4, 0.4, 0.9, sx * (towerW / 2 + 0.2), 11.1, 7.6 + sz * (towerW / 2 + 0.2), { c: stoneD });
        k.pyr('stone', 0.5, 0.5, 1.4, sx * (towerW / 2 + 0.2), 12.0, 7.6 + sz * (towerW / 2 + 0.2), { c: stoneD });
      }
      for (const sx of [-1, 1]) {
        const px = sx * 1.7, py = 6.4, pz = 7.6 + towerW / 2 + 0.05;
        k.box('stone', 0.7, 1.4, 0.35, px, py, pz, { c: 0xd0c9b6, wall: true });
        k.cyl('stone', 0.2, 0.14, 0.9, px, py + 0.2, pz + 0.18, 6, { c: 0xece6d6, ao: false });
        k.sph('stone', 0.12, 0.12, 0.12, px, py + 1.2, pz + 0.18, 5, 3, { c: 0xece6d6, ao: false });
      }
      // crossing spirelet
      k.frus('stone', 1.8, 1.8, 1.4, 1.4, 1.4, 0, top + 4.2, -1.5, { c: stoneD });
      k.pyr('slate', 2.2, 2.2, 4.2, 0, top + 5.6, -1.5, { c: slate });
      k.box('flat', 0.1, 0.7, 0.1, 0, top + 9.7, -1.5, { c: GOLD, ao: false });
      k.box('flat', 0.4, 0.09, 0.09, 0, top + 10.1, -1.5, { c: GOLD, ao: false });
      // statues along the nave ridge
      for (const z of [-6, 3]) {
        k.cyl('stone', 0.18, 0.12, 0.8, 0, top + 4.45, z, 6, { c: 0xece6d6, ao: false });
        k.sph('stone', 0.11, 0.11, 0.11, 0, top + 5.3, z, 5, 3, { c: 0xece6d6, ao: false });
      }
    }
  } else if (stage >= 2) {
    // roof still open at the front: a simple porch and scaffold remnant
    plankPile(k, 5.5, 7.5, 0.3, 3);
  }
}

// ---------------------------------------------------------------- site (scaffolding)

export function makeSiteModel(radius = 4, seed = 0) {
  ensureMaps();
  const k = new Kit(makeRng(seed * 977 + 31));
  const s = radius * 0.75;
  const H = Math.min(5.5, radius * 0.75 + 1.8);
  const open = k.r.int(4);
  const cs = [[-s, -s], [s, -s], [s, s], [-s, s]];
  for (let i = 0; i < 4; i++) {
    if (i === open) continue;
    const [x1, z1] = cs[i], [x2, z2] = cs[(i + 1) % 4];
    // inner line toward the building centre: scaffold local +x must point inward
    const dx = x2 - x1, dz = z2 - z1;
    const l = Math.hypot(dx, dz);
    const nx = -dz / l, nz = dx / l; // left normal; inward if dot with (-p) > 0
    const inward = nx * (-x1) + nz * (-z1) > 0;
    const sgn = inward ? 1 : -1;
    // local x axis for atan2(dx,dz) rotation is (cos, 0, -sin) of the heading, i.e. the right-hand side
    const rx = dz / l, rz = -dx / l;
    const side = (rx * (-x1) + rz * (-z1)) > 0 ? 0 : 1;
    void sgn;
    if (side === 0) scaffoldRun(k, x1, z1, x2, z2, H, 2);
    else scaffoldRun(k, x2, z2, x1, z1, H, 2);
  }
  // ladders and piles outside the scaffold
  const lad = (open + 1 + k.r.int(2)) % 4;
  const [lx, lz] = cs[lad];
  ladder(k, lx * 0.3, lz > 0 ? s + 0.25 : -s - 0.25, lz > 0 ? 0 : Math.PI, H * 0.95, 0.16);
  const [ox, oz] = cs[open];
  plankPile(k, ox * 0.5 + (k.r() - 0.5) * 0.5, oz * 1.06, k.r() * 3, 5);
  plankPile(k, ox * 0.1 - Math.sign(ox) * 0.9, oz * 1.08, k.r() * 3, 3);
  stoneBlocks(k, -ox * 0.6, -oz * 1.1, 3, k.r() * 3);
  barrel(k, ox * 0.9, oz * 0.5, 0, 0.9);
  crate(k, ox * 0.9 + 0.4, oz * 0.35, 0, 0.9, 0.3);
  // crane pole
  const [kx, kz] = cs[open];
  const cx = kx * 0.98, cz = kz * 0.98;
  k.bar('timber', [cx, 0, cz], [cx, H + 1.8, cz], 0.18, 0.18, { c: POLE });
  const bx = -Math.sign(kx) * 2.4, bz = -Math.sign(kz) * 2.4;
  k.bar('timber', [cx, H + 1.6, cz], [cx + bx, H + 1.1, cz + bz], 0.12, 0.12, { c: POLE });
  k.bar('timber', [cx, H - 0.4, cz], [cx + bx * 0.55, H + 0.95, cz + bz * 0.55], 0.08, 0.08, { c: POLE });
  k.bar('flat', [cx + bx * 0.95, H + 1.15, cz + bz * 0.95], [cx + bx * 0.95, 1.4, cz + bz * 0.95], 0.025, 0.025, { c: ROPE });
  k.box('stone', 0.5, 0.4, 0.5, cx + bx * 0.95, 0.95, cz + bz * 0.95, { c: 0xd8d2c0 });
  const g = new THREE.Group();
  g.name = 'site';
  k.bake(g);
  g.userData.chimneys = [];
  g.userData.triangles = k.triCount();
  return g;
}

// ---------------------------------------------------------------- public: buildings

function styleFor(seed) {
  const r = makeRng(seed * 7919 + 13);
  return {
    plaster: r.pick(PLASTERS), timber: r.pick(TIMBERS), shut: r.pick(SHUTTERS),
    thatchy: r.chance(0.5), shingle: r.pick([0xdcb080, 0xc89f72, 0xb4a48a]), tile: r.pick([0xf4b898, 0xe8a080, 0xf0c0a0]),
    stone: r.pick(STONES), thatch: r.pick([0xf5e2b0, 0xfff0c8, 0xe8d09c]),
  };
}

const BUILDERS = {
  townhall, storehouse, woodcutter, forager, quarry, sawmill, farmhouse, mill, bakery, chapel, tavern,
};

export function makeBuildingModel(type, { level = 1, stage = 0, seed = 0 } = {}) {
  ensureMaps();
  const st = styleFor(seed);
  const k = new Kit(makeRng(seed * 1013 + 7 + type.length * 31 + (type.charCodeAt(0) | 0)));
  if (type === 'house') {
    const lv = Math.max(1, Math.min(4, level | 0));
    [houseLevel1, houseLevel2, houseLevel3, houseLevel4][lv - 1](k, st);
  } else if (type === 'cathedral') {
    cathedral(k, Math.max(0, Math.min(4, stage | 0)), st);
  } else if (BUILDERS[type]) {
    BUILDERS[type](k, st);
  } else {
    const r = BUILDINGS[type]?.radius ?? 3;
    k.box('plaster', r, r * 0.7, r, 0, 0, 0, { c: st.plaster });
  }
  const g = new THREE.Group();
  g.name = type;
  k.bake(g);
  g.userData.chimneys = k.tops;
  g.userData.triangles = k.triCount();
  return g;
}

// ---------------------------------------------------------------- merged vertex-colour geometry

// Merge parts [{geo, color, m?}] into one non-indexed geometry with vertex colours.
function mergeParts(parts) {
  const pos = [];
  const nor = [];
  const col = [];
  const c = new THREE.Color();
  for (const p of parts) {
    let geo = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
    if (p.m) geo.applyMatrix4(p.m);
    c.set(p.color);
    const p3 = geo.attributes.position;
    const n3 = geo.attributes.normal;
    for (let i = 0; i < p3.count; i++) {
      pos.push(p3.getX(i), p3.getY(i), p3.getZ(i));
      nor.push(n3.getX(i), n3.getY(i), n3.getZ(i));
      col.push(c.r, c.g, c.b);
    }
    geo.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return out;
}

function at(x, y, z, sx = 1, sy = sx, sz = sx, ry = 0) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)),
    new THREE.Vector3(sx, sy, sz),
  );
}

const VERT_MAT = () => new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

function treeGeometry() {
  const trunk = new THREE.CylinderGeometry(0.18, 0.28, 1.5, 6);
  const c1 = new THREE.ConeGeometry(1.7, 2.4, 7);
  const c2 = new THREE.ConeGeometry(1.3, 2.1, 7);
  const c3 = new THREE.ConeGeometry(0.85, 1.7, 7);
  return mergeParts([
    { geo: trunk, color: 0x6b4a2a, m: at(0, 0.75, 0) },
    { geo: c1, color: 0x2f6b34, m: at(0, 2.2, 0) },
    { geo: c2, color: 0x3a7d3c, m: at(0, 3.4, 0, 1, 1, 1, 0.5) },
    { geo: c3, color: 0x4a8f45, m: at(0, 4.5, 0, 1, 1, 1, 1.0) },
  ]);
}

function rockGeometry() {
  const jiggle = (geo, seed) => {
    const p = geo.attributes.position;
    const memo = new Map();
    for (let i = 0; i < p.count; i++) {
      const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
      let f = memo.get(k);
      if (f === undefined) {
        f = 0.82 + 0.36 * (Math.abs(Math.sin((i * 12.9898 + seed) * 43758.5453)) % 1);
        memo.set(k, f);
      }
      p.setXYZ(i, p.getX(i) * f, p.getY(i) * f, p.getZ(i) * f);
    }
    geo.computeVertexNormals();
    return geo;
  };
  const a = jiggle(new THREE.IcosahedronGeometry(1, 0), 1);
  const b = jiggle(new THREE.IcosahedronGeometry(0.6, 0), 7);
  return mergeParts([
    { geo: a, color: 0x8b8b87, m: at(0, 0.7, 0, 1.5, 0.95, 1.25, 0.3) },
    { geo: b, color: 0x777773, m: at(1.2, 0.35, 0.5, 1, 0.8, 1, 1.1) },
  ]);
}

function berryGeometry() {
  const parts = [];
  const blob = (x, z, r, color) => parts.push({
    geo: new THREE.IcosahedronGeometry(r, 0), color, m: at(x, r * 0.75, z, 1, 0.8, 1),
  });
  blob(0, 0, 0.6, 0x3f7a3a);
  blob(0.55, 0.2, 0.42, 0x4f8d44);
  blob(-0.45, -0.25, 0.45, 0x356f35);
  const spots = [[0.1, 0.62, 0.3], [0.5, 0.5, 0.35], [-0.4, 0.38, -0.3], [-0.2, 0.5, 0.45],
    [0.62, 0.35, -0.2], [0.0, 0.7, -0.15], [0.35, 0.45, 0.62], [-0.6, 0.3, 0.1]];
  for (const [x, y, z] of spots) {
    parts.push({ geo: new THREE.IcosahedronGeometry(0.1, 0), color: 0xc2243e, m: at(x, y, z) });
  }
  return mergeParts(parts);
}

export const NODE_MODELS = {
  tree: { geometry: treeGeometry(), material: VERT_MAT() },
  rock: { geometry: rockGeometry(), material: VERT_MAT() },
  berry: { geometry: berryGeometry(), material: VERT_MAT() },
};

// ~1.6 m tall, origin at the feet, white so instanceColor tints it. Nose marks +z (facing).
export const VILLAGER_MODEL = {
  geometry: mergeParts([
    { geo: new THREE.CylinderGeometry(0.2, 0.3, 1.05, 7), color: 0xffffff, m: at(0, 0.575, 0) },
    { geo: new THREE.SphereGeometry(0.21, 7, 5), color: 0xffe0c8, m: at(0, 1.38, 0) },
    { geo: new THREE.BoxGeometry(0.08, 0.08, 0.1), color: 0xd9a888, m: at(0, 1.36, 0.22) },
    { geo: new THREE.ConeGeometry(0.24, 0.22, 7), color: 0x6b4a2a, m: at(0, 1.58, 0) },
  ]),
  material: VERT_MAT(),
};

export const CARRY_MODEL = {
  geometry: new THREE.BoxGeometry(0.34, 0.3, 0.34),
  material: new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }),
};
