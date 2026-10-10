// Procedural low-poly models built from three.js core primitives. No assets, no addons.
// Buildings face +z (the door is on the +z side) and have their origin at ground centre.
import * as THREE from '../../vendor/three.module.js';
import { BUILDINGS } from '../config.js';

// ---------------------------------------------------------------- materials

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

// ---------------------------------------------------------------- primitive helpers

function put(g, geo, material, x, y, z, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

// Box with its BOTTOM at y.
function box(g, material, w, h, d, x, y, z, ry = 0) {
  return put(g, new THREE.BoxGeometry(w, h, d), material, x, y + h / 2, z, 0, ry, 0);
}

// Cylinder with its BOTTOM at y.
function cyl(g, material, rTop, rBot, h, x, y, z, seg = 8) {
  return put(g, new THREE.CylinderGeometry(rTop, rBot, h, seg), material, x, y + h / 2, z);
}

// Square-based cone aligned to an axis-aligned w x d footprint, base at y.
function pyramid(g, material, w, d, h, x, y, z) {
  const geo = new THREE.ConeGeometry(1, h, 4, 1);
  geo.rotateY(Math.PI / 4);
  geo.scale(w / Math.SQRT2, 1, d / Math.SQRT2);
  return put(g, geo, material, x, y + h / 2, z);
}

function cone(g, material, r, h, x, y, z, seg = 8) {
  return put(g, new THREE.ConeGeometry(r, h, seg), material, x, y + h / 2, z);
}

// Triangular prism roof: ridge runs along x (length len), base width w across z, height h, base at y.
function gableGeometry(len, w, h) {
  const l = len / 2;
  const hw = w / 2;
  const D = [-l, 0, hw], C = [l, 0, hw], B = [l, 0, -hw], A = [-l, 0, -hw];
  const R1 = [-l, h, 0], R2 = [l, h, 0];
  const tris = [
    D, C, R2, D, R2, R1,   // front slope
    B, A, R1, B, R1, R2,   // back slope
    C, B, R2,              // +x end
    A, D, R1,              // -x end
  ];
  const pos = new Float32Array(tris.length * 3);
  tris.forEach((v, i) => pos.set(v, i * 3));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

function gable(g, material, len, w, h, x, y, z, ry = 0) {
  return put(g, gableGeometry(len, w, h), material, x, y, z, 0, ry, 0);
}

// Cylinder between two points.
function pole(g, material, x1, y1, z1, x2, y2, z2, r = 0.12) {
  const a = new THREE.Vector3(x1, y1, z1);
  const b = new THREE.Vector3(x2, y2, z2);
  const dir = b.clone().sub(a);
  const len = dir.length();
  const m = put(g, new THREE.CylinderGeometry(r, r, len, 5), material, 0, 0, 0);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return m;
}

// Glowing window (name 'window') with a timber frame behind it. Faces +z, rotate with ry.
function win(g, x, y, z, ry = 0, w = 0.5, h = 0.65, material = WINDOW) {
  const holder = new THREE.Group();
  holder.position.set(x, y, z);
  holder.rotation.y = ry;
  put(holder, new THREE.BoxGeometry(w + 0.16, h + 0.16, 0.1), MAT.timber, 0, 0, 0.02);
  const m = put(holder, new THREE.BoxGeometry(w, h, 0.1), material, 0, 0, 0.08);
  m.name = 'window';
  g.add(holder);
  return m;
}

function door(g, x, z, w = 0.9, h = 1.7, ry = 0, y = 0) {
  const holder = new THREE.Group();
  holder.position.set(x, y, z);
  holder.rotation.y = ry;
  box(holder, MAT.door, w, h, 0.14, 0, 0, 0);
  g.add(holder);
}

function chimney(g, x, y, z, h, w = 0.6) {
  box(g, MAT.stone, w, h, w, x, y, z);
  box(g, MAT.stoneDark, w + 0.15, 0.15, w + 0.15, x, y + h, z);
}

// Generic gabled cottage, ridge along x, door on +z. Returns the top y of the walls.
function cottage(g, o) {
  const {
    w, d, h, wall, roof, roofH, y = 0, ov = 0.35, x = 0, z = 0,
    beams = false, windows = 1, doorX = 0, sideWindows = 0, doorW = 0.9,
  } = o;
  box(g, wall, w, h, d, x, y, z);
  gable(g, roof, w + ov * 2, d + ov * 2, roofH, x, y + h, z);
  if (beams) {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      box(g, MAT.timber, 0.22, h, 0.22, x + sx * w / 2, y, z + sz * d / 2);
    }
    box(g, MAT.timber, w + 0.22, 0.2, 0.2, x, y + h - 0.2, z + d / 2);
    box(g, MAT.timber, w + 0.22, 0.2, 0.2, x, y + h - 0.2, z - d / 2);
    box(g, MAT.timber, w + 0.22, 0.2, 0.2, x, y, z + d / 2);
  }
  door(g, x + doorX, z + d / 2 + 0.03, doorW, Math.min(1.7, h * 0.78), 0, y);
  const winY = y + h * 0.58;
  if (windows >= 1) {
    const side = doorX === 0 ? w * 0.3 : 0;
    if (doorX === 0 && windows >= 2) {
      win(g, x - side, winY, z + d / 2);
      win(g, x + side, winY, z + d / 2);
    } else {
      win(g, x + (doorX > 0 ? -w * 0.25 : w * 0.25), winY, z + d / 2);
    }
  }
  for (let i = 0; i < sideWindows; i++) {
    const zz = z + (sideWindows === 1 ? 0 : (i / (sideWindows - 1) - 0.5) * d * 0.6);
    win(g, x + w / 2, winY, zz, Math.PI / 2);
    win(g, x - w / 2, winY, zz, -Math.PI / 2);
  }
  return y + h;
}

// ---------------------------------------------------------------- buildings

function townhall(g) {
  box(g, MAT.stone, 10.8, 0.6, 6.8, 0, 0, 0);
  const top = cottage(g, {
    w: 10, d: 6, h: 4, y: 0.6, wall: MAT.plaster, roof: MAT.thatchDark, roofH: 4.2, ov: 0.8,
    beams: true, windows: 0, doorW: 0.1,
  });
  // studs on the long faces
  for (let i = -4; i <= 4; i += 2) {
    box(g, MAT.timber, 0.2, 4, 0.14, i, 0.6, 3.04);
    box(g, MAT.timber, 0.2, 4, 0.14, i, 0.6, -3.04);
  }
  // front porch with double door
  box(g, MAT.door, 2, 2.4, 0.16, 0, 0.6, 3.04);
  box(g, MAT.timber, 0.25, 3.2, 0.25, -1.5, 0.6, 4.4);
  box(g, MAT.timber, 0.25, 3.2, 0.25, 1.5, 0.6, 4.4);
  gable(g, MAT.thatch, 3.6, 3.4, 1.4, 0, 3.8, 3.8, Math.PI / 2);
  box(g, MAT.stoneLight, 3.6, 0.2, 2.4, 0, 0.4, 4.2);
  for (const x of [-3.6, -1.9, 1.9, 3.6]) win(g, x, 2.9, 3.02, 0, 0.6, 0.8);
  for (const x of [-3.2, 0, 3.2]) win(g, x, 2.9, -3.02, Math.PI, 0.6, 0.8);
  win(g, 5.02, 2.9, 0, Math.PI / 2, 0.6, 0.8);
  win(g, -5.02, 2.9, 0, -Math.PI / 2, 0.6, 0.8);
  chimney(g, 3.4, 3.2, -1.2, 5.6, 0.8);
  // flag
  const poleTop = top + 4.2;
  cyl(g, MAT.timber, 0.08, 0.1, 3.8, -5.3, poleTop - 3.8 + 0.1, 0, 5);
  const flag = box(g, MAT.red, 0.06, 1.0, 1.8, -5.3, poleTop - 1.1, 0.95);
  flag.name = 'flag';
  box(g, MAT.gold, 0.08, 0.2, 1.8, -5.3, poleTop - 0.7, 0.95);
}

function storehouse(g) {
  box(g, MAT.stoneDark, 8.4, 0.4, 5.8, 0, 0, 0);
  cottage(g, {
    w: 8, d: 5.4, h: 3, y: 0.4, wall: MAT.timberLight, roof: MAT.thatchDark, roofH: 2.6, ov: 0.5,
    beams: true, windows: 0, doorW: 0.1,
  });
  for (let i = -3; i <= 3; i += 1) box(g, MAT.timber, 0.08, 3, 0.06, i, 0.4, 2.72);
  box(g, MAT.door, 2.8, 2.4, 0.16, 0, 0.4, 2.74);
  put(g, new THREE.BoxGeometry(3.2, 0.12, 0.1), MAT.timber, 0, 1.6, 2.84, 0, 0, 0.7);
  put(g, new THREE.BoxGeometry(3.2, 0.12, 0.1), MAT.timber, 0, 1.6, 2.84, 0, 0, -0.7);
  win(g, -3.1, 2.4, 2.72, 0, 0.5, 0.5);
  win(g, 3.1, 2.4, 2.72, 0, 0.5, 0.5);
  box(g, MAT.plank, 0.9, 0.8, 0.9, 3.4, 0, 3.7);
  box(g, MAT.plank, 0.9, 0.8, 0.9, 3.4, 0.8, 3.7, 0.4);
  box(g, MAT.plank, 0.9, 0.8, 0.9, 2.4, 0, 3.8, 0.2);
  put(g, new THREE.SphereGeometry(0.45, 6, 5), MAT.hay, -3.4, 0.4, 3.7);
  put(g, new THREE.SphereGeometry(0.4, 6, 5), MAT.hay, -2.7, 0.35, 3.9);
}

function woodcutter(g) {
  cottage(g, {
    w: 2.8, d: 2.4, h: 1.9, x: -0.6, z: -0.4, wall: MAT.timberLight, roof: MAT.thatchDark, roofH: 1.5,
    windows: 1, doorX: 0.55,
  });
  // log pile: 3 + 2 + 1 rows, logs run along z
  const logGeo = () => new THREE.CylinderGeometry(0.22, 0.22, 1.8, 6);
  const rows = [[3, 0.22], [2, 0.62], [1, 1.02]];
  for (const [n, y] of rows) {
    for (let i = 0; i < n; i++) {
      put(g, logGeo(), MAT.barrel, 1.9 + (i - (n - 1) / 2) * 0.46, y, 0.8, Math.PI / 2, 0, 0);
    }
  }
  cyl(g, MAT.timberLight, 0.4, 0.45, 0.55, -1.7, 0, 2.0, 7);
  box(g, MAT.timber, 0.08, 0.7, 0.08, -1.7, 0.55, 2.0).rotation.z = 0.5;
  box(g, MAT.iron, 0.3, 0.2, 0.06, -1.55, 1.1, 2.0);
}

function forager(g) {
  cyl(g, MAT.daub, 1.3, 1.4, 1.7, -0.5, 0, -0.3, 9);
  cone(g, MAT.thatch, 1.9, 1.7, -0.5, 1.7, -0.3, 9);
  door(g, -0.5, 1.1, 0.7, 1.35);
  win(g, -1.55, 1.1, 0.3, -Math.PI / 2 + 0.2, 0.4, 0.5);
  for (const [x, z] of [[1.9, 1.3], [2.5, 0.2], [1.2, 2.2]]) {
    cyl(g, MAT.basket, 0.34, 0.26, 0.42, x, 0, z, 7);
    for (let i = 0; i < 4; i++) {
      put(g, new THREE.SphereGeometry(0.1, 5, 4), MAT.berry, x + (i % 2 - 0.5) * 0.2, 0.46, z + (i > 1 ? 0.12 : -0.12));
    }
  }
  pole(g, MAT.timber, -2.4, 0, 1.4, -2.4, 1.6, 1.4, 0.06);
  pole(g, MAT.timber, -1.6, 0, 2.4, -1.6, 1.6, 2.4, 0.06);
  pole(g, MAT.timber, -2.4, 1.6, 1.4, -1.6, 1.6, 2.4, 0.05);
}

function quarry(g) {
  cottage(g, {
    w: 2.4, d: 2.2, h: 1.7, x: -1.6, z: -1.2, wall: MAT.stoneLight, roof: MAT.thatchDark, roofH: 1.2,
    windows: 1, doorX: 0.5,
  });
  box(g, MAT.stone, 1.4, 0.8, 1.0, 0.8, 0, 2.2, 0.3);
  box(g, MAT.stoneLight, 1.1, 0.7, 0.9, 1.0, 0.8, 2.2, -0.2);
  box(g, MAT.stoneDark, 0.9, 0.6, 0.8, -0.6, 0, 2.6, 0.5);
  box(g, MAT.stone, 0.7, 0.5, 0.7, 2.2, 0, 1.4, 0.8);
  // tripod crane
  const apex = [2.0, 3.8, -1.5];
  for (const [x, z] of [[1.1, -0.7], [2.9, -0.7], [2.0, -2.8]]) {
    pole(g, MAT.timber, x, 0, z, apex[0], apex[1], apex[2], 0.1);
  }
  pole(g, MAT.timberLight, 2.0, 3.7, -1.5, 3.6, 3.4, -0.4, 0.09);
  pole(g, MAT.iron, 3.6, 3.4, -0.4, 3.6, 1.5, -0.4, 0.03);
  box(g, MAT.stone, 0.6, 0.6, 0.6, 3.6, 0.9, -0.4);
}

function sawmill(g) {
  box(g, MAT.plank, 6.2, 0.2, 4.0, 0, 0, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    box(g, MAT.timber, 0.25, 2.8, 0.25, sx * 2.8, 0.2, sz * 1.7);
  }
  const roof = put(g, new THREE.BoxGeometry(7, 0.22, 4.8), MAT.thatchDark, 0, 3.15, 0, -0.16, 0, 0);
  roof.name = 'roof';
  box(g, MAT.timber, 6.2, 0.2, 0.2, 0, 2.5, -1.7);
  box(g, MAT.timberLight, 3.2, 0.8, 1.0, 0, 0.2, 0.2);
  const blade = put(g, new THREE.CylinderGeometry(0.95, 0.95, 0.06, 14), MAT.iron, 0, 1.4, 0.2, Math.PI / 2, 0, 0);
  blade.name = 'sawblade';
  put(g, new THREE.CylinderGeometry(0.24, 0.24, 3.0, 6), MAT.barrel, -0.8, 1.2, 0.2, 0, 0, Math.PI / 2);
  box(g, MAT.plank, 1.9, 0.18, 0.9, 2.9, 0.0, 2.3);
  box(g, MAT.plank, 1.8, 0.18, 0.9, 2.9, 0.18, 2.3, 0.1);
  box(g, MAT.plank, 1.9, 0.18, 0.9, 2.9, 0.36, 2.3, -0.05);
  box(g, MAT.plank, 1.7, 0.18, 0.9, 2.9, 0.54, 2.3, 0.08);
  put(g, new THREE.CylinderGeometry(0.28, 0.28, 2.2, 6), MAT.barrel, -2.6, 0.28, 2.4, 0, 0, Math.PI / 2);
  put(g, new THREE.CylinderGeometry(0.28, 0.28, 2.2, 6), MAT.barrel, -2.5, 0.78, 2.4, 0, 0, Math.PI / 2);
}

function farmhouse(g) {
  cottage(g, {
    w: 5, d: 3.6, h: 2.4, x: -1, z: -0.5, wall: MAT.plaster, roof: MAT.thatch, roofH: 2.3, ov: 0.45,
    beams: true, windows: 2, doorX: 0, sideWindows: 1,
  });
  chimney(g, 0.4, 1.6, -1.4, 3.2);
  for (const [x, z, s] of [[2.9, 1.8, 1], [3.1, -0.1, 0.85], [-3.0, 2.5, 0.9]]) {
    cyl(g, MAT.hay, 0.9 * s, 0.95 * s, 1.0 * s, x, 0, z, 8);
    cone(g, MAT.hay, 1.0 * s, 1.0 * s, x, 1.0 * s, z, 8);
  }
  for (let i = 0; i < 4; i++) box(g, MAT.timberLight, 0.12, 0.8, 0.12, -3.8 + i * 0.9, 0, 3.4);
  box(g, MAT.timberLight, 2.8, 0.1, 0.08, -2.4, 0.6, 3.4);
}

function mill(g) {
  cyl(g, MAT.stoneLight, 1.35, 2.0, 5.5, 0, 0, 0, 8);
  cyl(g, MAT.timber, 1.75, 1.75, 0.16, 0, 2.8, 0, 8);
  cone(g, MAT.thatchDark, 1.9, 1.9, 0, 5.4, 0, 8);
  door(g, 0, 1.92, 0.9, 1.6);
  win(g, 0, 3.6, 1.58, 0, 0.4, 0.55);
  win(g, 1.2, 2.2, 1.3, 0.7, 0.35, 0.5);
  box(g, MAT.plank, 0.8, 0.5, 0.6, 2.4, 0, 1.6, 0.3);
  box(g, MAT.cloth, 0.55, 0.65, 0.4, -2.4, 0, 1.5);
  // sails (spun by world.js)
  const sails = new THREE.Group();
  sails.name = 'sails';
  sails.position.set(0, 4.7, 1.55);
  put(sails, new THREE.CylinderGeometry(0.28, 0.28, 0.5, 6), MAT.timber, 0, 0, 0.1, Math.PI / 2, 0, 0);
  for (let k = 0; k < 4; k++) {
    const arm = new THREE.Group();
    arm.rotation.z = k * Math.PI / 2;
    put(arm, new THREE.BoxGeometry(0.16, 4.3, 0.12), MAT.timber, 0, 2.3, 0.18);
    put(arm, new THREE.BoxGeometry(0.9, 2.8, 0.05), MAT.cloth, 0.55, 2.9, 0.18);
    sails.add(arm);
  }
  g.add(sails);
}

function bakery(g) {
  cottage(g, {
    w: 4, d: 3.2, h: 2.2, x: -0.3, z: -0.3, wall: MAT.plaster, roof: MAT.tile, roofH: 1.8, ov: 0.35,
    beams: true, windows: 2, doorX: 0,
  });
  chimney(g, 1.0, 1.4, -1.0, 3.4, 0.8);
  // oven dome
  put(g, new THREE.SphereGeometry(0.95, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), MAT.stone, -2.9, 0, 0.1);
  win(g, -2.95, 0.4, 0.95, 0.15, 0.4, 0.35);
  // awning + bread sign
  put(g, new THREE.BoxGeometry(1.6, 0.1, 0.9), MAT.red, -0.3, 2.0, 1.75, 0.25, 0, 0);
  pole(g, MAT.iron, 1.4, 1.9, 1.35, 1.4, 1.9, 2.0, 0.04);
  put(g, new THREE.CylinderGeometry(0.28, 0.28, 0.08, 8), MAT.gold, 1.4, 1.55, 2.0, 0, 0, Math.PI / 2);
  box(g, MAT.basket, 0.6, 0.3, 0.45, 1.8, 0, 1.9);
  box(g, MAT.plank, 0.5, 0.2, 0.4, -1.8, 0, 1.9, 0.2);
}

function chapel(g) {
  // nave (ridge along z)
  box(g, MAT.stoneDark, 4.6, 0.4, 7.4, 0, 0, -1);
  box(g, MAT.plaster, 4, 3.4, 7, 0, 0.4, -1);
  gable(g, MAT.slate, 7.8, 5, 2.4, 0, 3.8, -1, Math.PI / 2);
  // bell tower at the front
  box(g, MAT.stoneLight, 2.4, 6.0, 2.4, 0, 0.4, 3.7);
  for (const s of [-1, 1]) {
    box(g, MAT.dark, 0.1, 1.3, 0.8, s * 1.2, 4.4, 3.7);
    box(g, MAT.dark, 0.8, 1.3, 0.1, 0, 4.4, 3.7 + s * 1.2);
  }
  pyramid(g, MAT.slate, 2.9, 2.9, 2.6, 0, 6.4, 3.7);
  box(g, MAT.gold, 0.12, 1.0, 0.12, 0, 9.0, 3.7);
  box(g, MAT.gold, 0.6, 0.12, 0.12, 0, 9.5, 3.7);
  door(g, 0, 4.92, 1.1, 2.0, 0, 0.4);
  win(g, 0, 4.1, 4.92, 0, 0.35, 0.8);
  for (const z of [-3, -1, 1]) {
    win(g, 2.02, 2.2, z, Math.PI / 2, 0.5, 1.2);
    win(g, -2.02, 2.2, z, -Math.PI / 2, 0.5, 1.2);
  }
  for (const s of [-1, 1]) for (const z of [-4.4, 0.4]) box(g, MAT.stone, 0.4, 2.8, 0.4, s * 2.1, 0.4, z);
}

function tavern(g) {
  box(g, MAT.stoneDark, 6.6, 0.3, 5.0, 0, 0, 0);
  box(g, MAT.plaster, 6.2, 2.5, 4.6, 0, 0.3, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(g, MAT.timber, 0.24, 2.5, 0.24, sx * 3.1, 0.3, sz * 2.3);
  // jettied upper floor
  box(g, MAT.timber, 7.0, 0.25, 5.4, 0, 2.8, 0);
  box(g, MAT.plaster, 6.8, 2.3, 5.2, 0, 3.05, 0);
  for (let i = -3; i <= 3; i += 1.5) {
    box(g, MAT.timber, 0.2, 2.3, 0.12, i, 3.05, 2.64);
    box(g, MAT.timber, 0.2, 2.3, 0.12, i, 3.05, -2.64);
  }
  box(g, MAT.timber, 6.9, 0.18, 0.14, 0, 4.1, 2.66);
  gable(g, MAT.tile, 7.8, 6.4, 2.6, 0, 5.35, 0);
  chimney(g, -2.4, 3.6, -1.2, 3.9, 0.7);
  door(g, 0, 2.33, 1.1, 2.0, 0, 0.3);
  win(g, -2.0, 1.5, 2.33, 0, 0.7, 0.7);
  win(g, 2.0, 1.5, 2.33, 0, 0.7, 0.7);
  for (const x of [-2.3, 0, 2.3]) win(g, x, 4.2, 2.7, 0, 0.65, 0.75);
  for (const z of [-1, 1]) {
    win(g, 3.12, 1.5, z, Math.PI / 2, 0.55, 0.65);
    win(g, 3.42, 4.2, z, Math.PI / 2, 0.55, 0.75);
    win(g, -3.42, 4.2, z, -Math.PI / 2, 0.55, 0.75);
  }
  // hanging sign
  box(g, MAT.timber, 0.12, 0.12, 1.4, 3.0, 3.1, 3.2);
  box(g, MAT.gold, 0.08, 0.75, 0.95, 3.0, 2.3, 3.5);
  put(g, new THREE.CylinderGeometry(0.15, 0.13, 0.28, 6), MAT.red, 3.08, 2.55, 3.5);
  // barrels
  for (const [x, z] of [[-3.5, 3.0], [-2.7, 3.3], [-3.2, 2.5]]) {
    cyl(g, MAT.barrel, 0.36, 0.4, 0.85, x, 0, z, 8);
    cyl(g, MAT.iron, 0.4, 0.4, 0.06, x, 0.2, z, 8);
  }
}

// ---------------------------------------------------------------- houses

function house(g, level) {
  if (level <= 1) {
    cottage(g, {
      w: 2.6, d: 2.2, h: 1.6, wall: MAT.daub, roof: MAT.thatch, roofH: 1.5, ov: 0.35,
      windows: 1, doorX: -0.6,
    });
  } else if (level === 2) {
    cottage(g, {
      w: 3.8, d: 3.0, h: 2.2, wall: MAT.plaster, roof: MAT.thatch, roofH: 1.9, ov: 0.4,
      beams: true, windows: 1, doorX: -0.9, sideWindows: 1,
    });
    chimney(g, 1.2, 1.5, -0.8, 2.6);
  } else if (level === 3) {
    box(g, MAT.stoneDark, 4.6, 0.3, 3.6, 0, 0, 0);
    box(g, MAT.plaster, 4.4, 2.3, 3.4, 0, 0.3, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(g, MAT.timber, 0.2, 2.3, 0.2, sx * 2.2, 0.3, sz * 1.7);
    box(g, MAT.timber, 4.9, 0.2, 3.9, 0, 2.6, 0);
    box(g, MAT.plaster, 4.8, 2.1, 3.8, 0, 2.8, 0);
    for (let i = -2; i <= 2; i += 1) box(g, MAT.timber, 0.16, 2.1, 0.1, i, 2.8, 1.93);
    gable(g, MAT.tile, 5.6, 4.8, 2.0, 0, 4.9, 0);
    chimney(g, 1.6, 3.4, -1.0, 3.4, 0.65);
    door(g, -1.0, 1.73, 1.0, 1.8, 0, 0.3);
    win(g, 1.0, 1.4, 1.73);
    win(g, -1.3, 3.8, 1.97);
    win(g, 0, 3.8, 1.97);
    win(g, 1.3, 3.8, 1.97);
    win(g, 2.4, 1.4, 0, Math.PI / 2);
    win(g, 2.5, 3.8, 0, Math.PI / 2);
    win(g, -2.4, 1.4, 0, -Math.PI / 2);
  } else {
    // stone manor
    box(g, MAT.stoneDark, 5.6, 0.4, 4.6, 0, 0, 0);
    box(g, MAT.stone, 5.2, 3.0, 4.2, 0, 0.4, 0);
    box(g, MAT.stoneLight, 5.2, 0.2, 4.2, 0, 3.4, 0);
    box(g, MAT.stoneLight, 4.6, 2.2, 3.6, 0, 3.6, 0);
    box(g, MAT.timber, 4.8, 0.14, 3.8, 0, 3.6, 0);
    gable(g, MAT.slate, 5.8, 4.7, 2.4, 0, 5.8, 0);
    for (const sx of [-1, 1]) {
      cyl(g, MAT.stone, 0.75, 0.8, 5.6, sx * 2.55, 0.4, -1.8, 8);
      cone(g, MAT.slate, 1.0, 1.9, sx * 2.55, 6.0, -1.8, 8);
    }
    chimney(g, 1.4, 5.0, -1.0, 3.2, 0.7);
    box(g, MAT.gold, 1.5, 0.16, 0.2, 0, 2.6, 2.2);
    door(g, 0, 2.12, 1.2, 2.2, 0, 0.4);
    for (const x of [-1.8, 1.8]) win(g, x, 1.9, 2.12, 0, 0.55, 0.9);
    for (const x of [-1.5, 0, 1.5]) win(g, x, 4.6, 1.83, 0, 0.5, 0.8);
    win(g, 2.62, 1.9, 0.4, Math.PI / 2, 0.55, 0.9);
    win(g, 2.32, 4.6, 0.2, Math.PI / 2, 0.5, 0.8);
    win(g, -2.62, 1.9, 0.4, -Math.PI / 2, 0.55, 0.9);
    win(g, -2.32, 4.6, 0.2, -Math.PI / 2, 0.5, 0.8);
  }
}

// ---------------------------------------------------------------- cathedral

// Cross-shaped plan, nave along z, entrance at +z.
const CROSS = [
  [-4, 7], [4, 7], [4, 1.5], [8, 1.5], [8, -3.5], [4, -3.5],
  [4, -9], [-4, -9], [-4, -3.5], [-8, -3.5], [-8, 1.5], [-4, 1.5],
];
const CATH_CENTROID = [0, -1.5];

function cathedral(g, stage) {
  const T = 0.8;
  const wallH = stage >= 1 ? 7 : 0.5;
  const wallMat = stage >= 1 ? MAT.stoneLight : MAT.stoneDark;
  // floor slabs
  box(g, MAT.stoneDark, 8.4, 0.15, 16.4, 0, 0, -1);
  box(g, MAT.stoneDark, 16.4, 0.15, 5.4, 0, 0, -1);
  let wi = 0;
  for (let i = 0; i < CROSS.length; i++) {
    const [x1, z1] = CROSS[i];
    const [x2, z2] = CROSS[(i + 1) % CROSS.length];
    const mx = (x1 + x2) / 2;
    const mz = (z1 + z2) / 2;
    const horizontal = z1 === z2;
    const len = Math.abs(horizontal ? x2 - x1 : z2 - z1);
    if (horizontal) box(g, wallMat, len + T, wallH, T, mx, 0, mz);
    else box(g, wallMat, T, wallH, len + T, mx, 0, mz);
    if (stage < 1) continue;
    // outward normal
    let nx = horizontal ? 0 : 1;
    let nz = horizontal ? 1 : 0;
    if ((mx - CATH_CENTROID[0]) * nx + (mz - CATH_CENTROID[1]) * nz < 0) { nx = -nx; nz = -nz; }
    const ry = Math.atan2(nx, nz);
    const count = Math.floor(len / 3.4);
    for (let k = 0; k < count; k++) {
      const t = (k + 0.5) / count - 0.5;
      const px = mx + (horizontal ? t * len : 0) + nx * (T / 2);
      const pz = mz + (horizontal ? 0 : t * len) + nz * (T / 2);
      if (stage >= 3 && horizontal && z1 === 7) continue; // hidden behind the tower
      const m = stage >= 4 ? STAINED[wi++ % 4] : WINDOW;
      win(g, px, 3.9, pz, ry, 0.9, 2.6, m);
    }
    // buttresses at corners
    box(g, MAT.stone, 0.7, wallH - 0.5, 0.7, x1, 0, z1);
  }
  if (stage >= 1) {
    // rose windows on the transept gables
    if (stage >= 2) {
      for (const s of [-1, 1]) {
        const rose = put(g, new THREE.CylinderGeometry(1.1, 1.1, 0.14, 10), stage >= 4 ? STAINED[(s + 3) % 4] : WINDOW,
          s * (8 + T / 2 + 0.04), 8.1, -1, 0, 0, Math.PI / 2);
        rose.name = 'window';
      }
    }
  }
  if (stage >= 1 && stage < 3) door(g, 0, 7 + T / 2 + 0.02, 2.0, 3.4);
  if (stage >= 2) {
    gable(g, MAT.slate, 17.0, 9.8, 4.4, 0, 7, -1, Math.PI / 2);
    gable(g, MAT.slate, 17.0, 6.4, 2.9, 0, 7, -1, 0);
  }
  if (stage >= 3) {
    // bell tower
    box(g, MAT.stoneLight, 4.6, 13, 4.6, 0, 0, 8.7);
    box(g, MAT.stoneDark, 5.0, 0.4, 5.0, 0, 13, 8.7);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      pyramid(g, MAT.stoneDark, 0.6, 0.6, 1.0, sx * 2.2, 13.4, 8.7 + sz * 2.2);
    }
    for (const s of [-1, 1]) {
      box(g, MAT.dark, 0.1, 2.4, 1.2, s * 2.3, 9.8, 8.7);
      box(g, MAT.dark, 1.2, 2.4, 0.1, 0, 9.8, 8.7 + s * 2.3);
    }
    door(g, 0, 11.03, 2.0, 3.6);
    win(g, 0, 6.6, 11.02, 0, 0.7, 1.6, stage >= 4 ? STAINED[2] : WINDOW);
    box(g, MAT.stoneDark, 4.9, 0.25, 0.2, 0, 7.8, 11.05);
    box(g, MAT.stoneDark, 4.9, 0.25, 0.2, 0, 12.2, 11.05);
  }
  if (stage >= 4) {
    pyramid(g, MAT.slate, 4.9, 4.9, 11, 0, 13.4, 8.7);
    box(g, MAT.gold, 0.14, 1.8, 0.14, 0, 24.4, 8.7);
    box(g, MAT.gold, 0.9, 0.14, 0.14, 0, 25.0, 8.7);
    // spirelet over the crossing
    pyramid(g, MAT.slate, 2.2, 2.2, 3.4, 0, 11.4, -1);
  }
}

// ---------------------------------------------------------------- public: buildings

const BUILDERS = {
  townhall, storehouse, woodcutter, forager, quarry, sawmill, farmhouse, mill, bakery, chapel, tavern,
};

export function makeBuildingModel(type, { level = 1, stage = 0 } = {}) {
  const g = new THREE.Group();
  g.name = type;
  if (type === 'house') house(g, Math.max(1, Math.min(4, level)));
  else if (type === 'cathedral') cathedral(g, Math.max(0, Math.min(4, stage)));
  else if (BUILDERS[type]) BUILDERS[type](g);
  else {
    const r = BUILDINGS[type]?.radius ?? 3;
    box(g, MAT.plaster, r, r * 0.7, r, 0, 0, 0);
  }
  return g;
}

// Wooden scaffold frame for construction sites.
export function makeSiteModel(radius = 4) {
  const g = new THREE.Group();
  g.name = 'site';
  const s = radius * 0.75;
  const H = Math.min(5, radius * 0.9 + 1.5);
  const m = MAT.timberLight;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(g, m, 0.24, H, 0.24, sx * s, 0, sz * s);
  for (const f of [0.4, 0.8]) {
    const y = H * f;
    for (const sz of [-1, 1]) box(g, m, s * 2 + 0.24, 0.16, 0.16, 0, y, sz * s);
    for (const sx of [-1, 1]) box(g, m, 0.16, 0.16, s * 2 + 0.24, sx * s, y, 0);
  }
  for (const sz of [-1, 1]) {
    pole(g, m, -s, 0.1, sz * s, s, H * 0.8, sz * s, 0.07);
  }
  for (const sx of [-1, 1]) {
    pole(g, m, sx * s, 0.1, -s, sx * s, H * 0.8, s, 0.07);
  }
  // ground clutter
  box(g, MAT.plank, 1.4, 0.16, 0.5, s * 0.5, 0, s + 0.9, 0.3);
  box(g, MAT.plank, 1.4, 0.16, 0.5, s * 0.5, 0.16, s + 0.9, 0.2);
  box(g, MAT.barrel, 0.5, 0.5, 0.5, -s * 0.6, 0, s + 0.8);
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
