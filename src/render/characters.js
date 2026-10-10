// Hand-designed villager characters, built from primitives with vertex colours.
// Each character is a set of parts with pivots so limbs can swing:
//   legL/legR pivot at the hips, armL/armR at the shoulders, head at the neck,
//   torso at the ground origin, item attached to the right hand.
// Character faces +Z. Units: metres, ~1.75 m tall.
import * as THREE from '../../vendor/three.module.js';

export const PIVOTS = {
  hipL: [-0.1, 0.84, 0], hipR: [0.1, 0.84, 0],
  shoulderL: [-0.25, 1.33, 0], shoulderR: [0.25, 1.33, 0],
  neck: [0, 1.44, 0],
  hand: [0, -0.54, 0.02],      // item offset inside the right arm
  carry: [0, 1.02, 0.3],       // carried goods, torso space
};

const BOOT = 0x3b2a1e;
const DARK = 0x2a1d14;
const IRON = 0x8c949c;
const WOOD = 0x7a5232;

// ---------------------------------------------------------------- geometry kit

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

function add(list, geo, color, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
  const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(_m);
  geo.dispose();
  list.push({ g, color: new THREE.Color(color) });
  return list;
}

// Merge a part list into one non-indexed geometry with a vertex colour attribute.
function merge(list) {
  let n = 0;
  for (const { g } of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  let o = 0;
  for (const { g, color } of list) {
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    for (let i = 0; i < c; i++) {
      col[(o + i) * 3] = color.r; col[(o + i) * 3 + 1] = color.g; col[(o + i) * 3 + 2] = color.b;
    }
    o += c;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt, rb, h, seg = 8) => new THREE.CylinderGeometry(rt, rb, h, seg);
const sph = (r, w = 8, h = 6) => new THREE.SphereGeometry(r, w, h);
const halfSph = (r, w = 10, h = 5) => new THREE.SphereGeometry(r, w, h, 0, Math.PI * 2, 0, Math.PI / 2);
const cone = (r, h, seg = 8) => new THREE.ConeGeometry(r, h, seg);
const torus = (r, t, seg = 10) => new THREE.TorusGeometry(r, t, 4, seg);

// ---------------------------------------------------------------- looks (face/hair/body variation)

export const LOOKS = [
  { skin: 0xe0b08c, hair: 0x5a3a22, beard: true },
  { skin: 0xc68a62, hair: 0x231a14, beard: false },
  { skin: 0xf0c8a8, hair: 0xc9a050, female: true },
  { skin: 0x9a6442, hair: 0x1a1410, female: true },
  { skin: 0xeab896, hair: 0x8a3a1c, beard: true },
  { skin: 0xd9a27a, hair: 0x9a9a92, beard: true },   // older, grey
];

// ---------------------------------------------------------------- body parts (local space, origin = pivot)

function leg(o) {
  const l = [];
  add(l, cyl(0.085, 0.075, 0.5, 7), o.trousers, 0, -0.27, 0);
  add(l, cyl(0.09, 0.08, 0.16, 7), o.bootTop ?? BOOT, 0, -0.6, 0);
  add(l, box(0.15, 0.1, 0.26), o.boot ?? BOOT, 0, -0.71, 0.04);
  return merge(l);
}

function arm(o) {
  const l = [];
  add(l, sph(0.075, 7, 5), o.sleeve, 0, -0.03, 0, 0, 0, 0, 1, 0.8, 1);
  add(l, cyl(0.07, 0.06, 0.46, 7), o.sleeve, 0, -0.25, 0);
  if (o.cuff) add(l, cyl(0.068, 0.068, 0.05, 7), o.cuff, 0, -0.47, 0);
  add(l, sph(o.glove ? 0.064 : 0.06, 6, 5), o.glove ?? o.skin, 0, -0.54, 0.01, 0, 0, 0, 1, 1.15, 0.9);
  return merge(l);
}

function torso(o) {
  const l = [];
  const long = o.robe || o.female;
  if (long) {
    // ankle-length dress/robe — legs show only boots beneath
    add(l, cyl(0.22, o.robe ? 0.33 : 0.31, 0.7, 12), o.skirt ?? o.tunic, 0, 0.47, 0);
  } else {
    add(l, cyl(0.21, 0.27, 0.34, 10), o.tunic, 0, 0.73, 0);
  }
  add(l, cyl(0.22, 0.21, 0.5, 10), o.tunic, 0, 1.12, 0, 0, 0, 0, 1, 1, 0.82);
  add(l, cyl(0.12, 0.22, 0.1, 10), o.tunic, 0, 1.4, 0, 0, 0, 0, 1, 1, 0.82);
  if (o.belt !== null) {
    add(l, cyl(0.225, 0.225, 0.07, 10), o.belt ?? 0x4a3320, 0, 0.9, 0, 0, 0, 0, 1, 1, 0.84);
    if (!o.ropeBelt) add(l, box(0.07, 0.06, 0.03), 0xc9a24a, 0, 0.9, 0.19);
  }
  add(l, cyl(0.065, 0.07, 0.08, 7), o.skin, 0, 1.47, 0);
  if (o.apron) {
    // apron bib + skirt panel hanging in front
    add(l, box(0.3, 0.42, 0.03), o.apron, 0, 0.66, 0.205, 0.08);
    add(l, box(0.24, 0.3, 0.03), o.apron, 0, 1.08, 0.185);
    add(l, box(0.03, 0.3, 0.02), o.apron, -0.1, 1.33, 0.12, -0.5);
    add(l, box(0.03, 0.3, 0.02), o.apron, 0.1, 1.33, 0.12, -0.5);
  }
  if (o.extraTorso) o.extraTorso(l, o);
  return merge(l);
}

function head(o) {
  const l = [];
  const skin = o.skin;
  add(l, sph(0.15, 10, 8), skin, 0, 0.16, 0, 0, 0, 0, 0.95, 1.06, 0.98);
  add(l, box(0.045, 0.06, 0.06), skin, 0, 0.14, 0.15);                 // nose
  add(l, sph(0.035, 5, 4), skin, -0.145, 0.15, 0);                     // ears
  add(l, sph(0.035, 5, 4), skin, 0.145, 0.15, 0);
  add(l, box(0.03, 0.03, 0.01), DARK, -0.055, 0.19, 0.142);            // eyes
  add(l, box(0.03, 0.03, 0.01), DARK, 0.055, 0.19, 0.142);
  add(l, box(0.07, 0.015, 0.01), 0xa8705a, 0, 0.085, 0.142);           // mouth
  if (o.female) {
    add(l, box(0.05, 0.012, 0.01), DARK, -0.055, 0.215, 0.142, 0, 0, 0.15); // lashes/brows
    add(l, box(0.05, 0.012, 0.01), DARK, 0.055, 0.215, 0.142, 0, 0, -0.15);
  } else {
    add(l, box(0.06, 0.018, 0.012), o.hair, -0.055, 0.225, 0.14);       // brows
    add(l, box(0.06, 0.018, 0.012), o.hair, 0.055, 0.225, 0.14);
  }
  if (!o.bald) add(l, halfSph(0.158, 10, 5), o.hair, 0, 0.17, -0.01, -0.25, 0, 0, 1, 1.05, 1.02);
  if (o.female && !o.hideBraid) {
    // hair down the back + braid
    add(l, box(0.26, 0.22, 0.08), o.hair, 0, 0.08, -0.11);
    add(l, sph(0.05, 6, 5), o.hair, 0, -0.06, -0.15);
    add(l, sph(0.045, 6, 5), o.hair, 0, -0.14, -0.16);
    add(l, sph(0.04, 6, 5), o.hair, 0, -0.21, -0.165);
  }
  if (o.beard && !o.female) add(l, sph(0.11, 8, 5), o.hair, 0, 0.06, 0.07, 0, 0, 0, 1.05, 0.9, 0.8);
  if (o.extraHead) o.extraHead(l, o);
  return merge(l);
}

// ---------------------------------------------------------------- hand items (right-hand local space)

// A tool whose handle runs forward-down from the fist; head(l, hy, hz, a) draws the business end.
function tool(len, headFn, tilt = 1.4) {
  const l = [];
  const dy = -Math.cos(tilt), dz = Math.sin(tilt);
  add(l, cyl(0.022, 0.026, len, 6), WOOD, 0, dy * (len / 2 - 0.12), dz * (len / 2 - 0.12), tilt);
  headFn(l, dy * (len - 0.16), dz * (len - 0.16), tilt);
  return merge(l);
}

const ITEM_BUILDERS = {
  axe: () => tool(0.72, (l, hy, hz, a) => {
    add(l, box(0.05, 0.07, 0.09), 0x5c6168, 0, hy, hz, a);
    add(l, box(0.035, 0.2, 0.15), 0x9aa3ab, 0, hy - 0.05, hz + 0.04, a - 0.1);
    add(l, box(0.036, 0.2, 0.02), 0xd5dade, 0, hy - 0.05, hz + 0.115, a - 0.1);
  }),
  pickaxe: () => tool(0.75, (l, hy, hz, a) => {
    add(l, box(0.05, 0.08, 0.08), 0x5c6168, 0, hy, hz, a);
    add(l, cone(0.035, 0.26, 5), IRON, 0, hy + 0.15, hz, 0);
    add(l, cone(0.035, 0.26, 5), IRON, 0, hy - 0.15, hz, Math.PI);
  }),
  hammer: () => tool(0.45, (l, hy, hz, a) => {
    add(l, box(0.08, 0.08, 0.17), 0x6b7078, 0, hy, hz, a);
  }),
  sickle: () => tool(0.32, (l, hy, hz) => {
    add(l, torus(0.13, 0.016, 10), 0xb8bec4, 0, hy + 0.02, hz + 0.12, 0, Math.PI / 2, 0, 1, 1, 1);
  }, 1.2),
  saw: () => {
    const l = [];
    add(l, box(0.05, 0.1, 0.12), WOOD, 0, -0.02, 0.06);
    add(l, box(0.012, 0.13, 0.62), 0xb8bec4, 0, -0.06, 0.42);
    return merge(l);
  },
  basket: () => {
    const l = [];
    add(l, cyl(0.15, 0.11, 0.16, 9), 0xa8804a, 0, -0.2, 0.04);
    add(l, torus(0.15, 0.015, 10), 0x8a6638, 0, -0.12, 0.04, Math.PI / 2);
    add(l, torus(0.12, 0.012, 10), 0x8a6638, 0, -0.04, 0.04, 0, Math.PI / 2, 0, 1, 1, 0.6);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      add(l, sph(0.04, 5, 4), i % 2 ? 0x6a2a6e : 0xb22a3a, Math.cos(a) * 0.07, -0.1, 0.04 + Math.sin(a) * 0.07);
    }
    return merge(l);
  },
  loaf: () => {
    const l = [];
    add(l, sph(0.09, 8, 5), 0xc48a3e, 0, -0.04, 0.08, 0, 0, 0, 1.5, 0.75, 1);
    add(l, box(0.02, 0.02, 0.1), 0xe8c88a, -0.05, 0.02, 0.08);
    add(l, box(0.02, 0.02, 0.1), 0xe8c88a, 0.05, 0.02, 0.08);
    return merge(l);
  },
  book: () => {
    const l = [];
    add(l, box(0.05, 0.22, 0.17), 0x6a1e22, 0, -0.06, 0.08);
    add(l, box(0.04, 0.2, 0.15), 0xefe3c2, 0.008, -0.06, 0.08);
    add(l, box(0.052, 0.04, 0.04), 0xc9a24a, 0, -0.06, 0.15);
    return merge(l);
  },
  tankard: () => {
    const l = [];
    add(l, cyl(0.055, 0.06, 0.15, 8), 0x8a6a44, 0, -0.04, 0.09);
    add(l, cyl(0.057, 0.057, 0.02, 8), 0x5c4630, 0, 0.02, 0.09);
    add(l, cyl(0.05, 0.05, 0.02, 8), 0xf3ead2, 0, 0.04, 0.09);  // foam
    add(l, torus(0.04, 0.012, 8), 0x5c4630, 0.06, -0.04, 0.09, 0, Math.PI / 2, 0);
    return merge(l);
  },
  scoop: () => tool(0.3, (l, hy, hz) => {
    add(l, cyl(0.07, 0.05, 0.08, 8), 0xb8a070, 0, hy, hz);
  }, 1.1),
};

// ---------------------------------------------------------------- carried goods (torso space, held at chest)

const CARRY_BUILDERS = {
  wood: () => {
    const l = [];
    add(l, cyl(0.075, 0.08, 0.62, 7), 0x6b4a2c, 0, 0, 0, 0, 0, Math.PI / 2);
    add(l, cyl(0.07, 0.07, 0.01, 7), 0xc9a26a, 0.315, 0, 0, 0, 0, Math.PI / 2);
    add(l, cyl(0.07, 0.07, 0.01, 7), 0xc9a26a, -0.315, 0, 0, 0, 0, Math.PI / 2);
    return merge(l);
  },
  planks: () => {
    const l = [];
    add(l, box(0.66, 0.04, 0.16), 0xc49a62, 0, -0.03, 0);
    add(l, box(0.66, 0.04, 0.16), 0xb48a52, 0, 0.015, 0, 0, 0.06, 0);
    add(l, box(0.66, 0.04, 0.16), 0xc49a62, 0, 0.06, 0, 0, -0.04, 0);
    return merge(l);
  },
  stone: () => {
    const l = [];
    add(l, box(0.3, 0.2, 0.22), 0x9a9890, 0, 0, 0, 0.05, 0.1, 0.03);
    return merge(l);
  },
  berries: () => ITEM_BUILDERS.basket().translate(0, 0.16, -0.04),
  wheat: () => {
    const l = [];
    add(l, cyl(0.07, 0.05, 0.6, 7), 0xd9b45a, 0, 0.05, 0, 0.5);
    add(l, cyl(0.075, 0.075, 0.04, 7), 0x8a6638, 0, 0.0, 0, 0.5);
    add(l, sph(0.1, 7, 5), 0xe8c86a, 0, 0.3, 0.15, 0.5, 0, 0, 1, 1.4, 1);
    return merge(l);
  },
  flour: () => {
    const l = [];
    add(l, sph(0.17, 8, 6), 0xe8e0cc, 0, 0, 0, 0, 0, 0, 1.2, 1, 0.9);
    add(l, cyl(0.04, 0.06, 0.08, 6), 0xe8e0cc, 0, 0.17, 0);
    add(l, torus(0.045, 0.012, 6), 0x8a6638, 0, 0.16, 0, Math.PI / 2);
    return merge(l);
  },
  bread: () => {
    const l = [];
    add(l, cyl(0.2, 0.15, 0.08, 10), 0xa8804a, 0, -0.05, 0);
    for (let i = 0; i < 3; i++) add(l, sph(0.07, 7, 4), 0xc48a3e, (i - 1) * 0.11, 0.02, 0, 0, 0, 0, 1.4, 0.8, 1);
    return merge(l);
  },
};

// ---------------------------------------------------------------- characters

// Each role: outfit + item. `look` (from LOOKS) supplies skin/hair/beard/gender.
export const ROLES = {
  villager: {
    name: 'ชาวบ้าน', tunic: 0xcdbb94, sleeve: 0xcdbb94, trousers: 0x6b5a44, skirt: 0x8a7458,
    belt: 0x5c4630, item: null,
  },
  woodcutter: {
    name: 'คนตัดไม้', tunic: 0x4f6b3a, sleeve: 0x4f6b3a, trousers: 0x5b4632, belt: 0x3a2716, skirt: 0x45603a,
    cuff: 0x3d5230, glove: 0x6b4a2c, item: 'axe',
    extraHead(l) {
      add(l, halfSph(0.185, 12, 6), 0x6b4a2c, 0, 0.19, -0.055, -0.55, 0, 0, 1.02, 1.05, 1.0);
      add(l, cyl(0.16, 0.2, 0.12, 12), 0x6b4a2c, 0, 0.03, -0.03, 0.15, 0, 0, 1, 1, 0.9);
      add(l, cone(0.045, 0.24, 6), 0x5c3f25, 0, 0.12, -0.24, -2.5);
    },
    extraTorso(l) {
      add(l, box(0.05, 0.62, 0.03), 0x3a2716, 0, 1.12, 0.17, 0, 0, 0.65);
      add(l, box(0.05, 0.62, 0.03), 0x3a2716, 0, 1.12, -0.17, 0, 0, -0.65);
    },
  },
  forager: {
    name: 'คนเก็บของป่า', tunic: 0x8a6a3a, sleeve: 0x8a6a3a, trousers: 0x5b4a32, skirt: 0x6e5a36,
    belt: 0x4a3320, item: 'basket',
    extraHead(l) {
      // knotted headscarf
      add(l, halfSph(0.168, 10, 5), 0xb5523a, 0, 0.18, -0.015, -0.3, 0, 0, 1.02, 1.0, 1.05);
      add(l, sph(0.045, 5, 4), 0xb5523a, 0, 0.12, -0.17);
      add(l, cone(0.035, 0.12, 5), 0xb5523a, 0.03, 0.06, -0.18, -2.6, 0, 0.3);
    },
    extraTorso(l) {
      // shawl over the shoulders
      add(l, cyl(0.17, 0.26, 0.16, 10), 0x6b8a4a, 0, 1.33, 0, 0, 0, 0, 1, 1, 0.85);
    },
  },
  farmer: {
    name: 'ชาวนา', tunic: 0x5a7590, sleeve: 0x5a7590, trousers: 0x8a7458, skirt: 0x4e6680,
    belt: 0x5c4630, item: 'sickle',
    extraHead(l) {
      // wide-brimmed straw hat
      add(l, cyl(0.3, 0.3, 0.02, 14), 0xe2c374, 0, 0.27, 0);
      add(l, cyl(0.12, 0.16, 0.13, 12), 0xd9b45a, 0, 0.34, 0);
      add(l, cyl(0.162, 0.162, 0.03, 12), 0x8a4a2a, 0, 0.29, 0);
    },
    extraTorso(l) {
      // rolled sleeves feel: lighter undershirt at the collar
      add(l, cyl(0.1, 0.12, 0.05, 8), 0xe8dcc0, 0, 1.44, 0.01);
    },
  },
  quarry: {
    name: 'ช่างหิน', tunic: 0x7a7a72, sleeve: 0x6a6a64, trousers: 0x4a4038, skirt: 0x6a6a64,
    belt: 0x3a2716, apron: 0x6b4a2c, glove: 0x5c4630, item: 'pickaxe',
    extraHead(l) {
      // close leather cap
      add(l, halfSph(0.165, 10, 5), 0x5c4630, 0, 0.19, 0, -0.1, 0, 0, 1, 0.85, 1);
      add(l, cyl(0.168, 0.168, 0.035, 10), 0x4a3828, 0, 0.19, 0);
    },
  },
  builder: {
    name: 'ช่างก่อสร้าง', tunic: 0xc48a3a, sleeve: 0xc48a3a, trousers: 0x5b4632, skirt: 0xa87430,
    belt: 0x3a2716, apron: 0x7a5232, item: 'hammer',
    extraHead(l) {
      // floppy cloth cap
      add(l, halfSph(0.17, 10, 5), 0x8a3a2a, 0, 0.2, -0.02, -0.35, 0, 0.1, 1.05, 0.9, 1.1);
      add(l, sph(0.07, 6, 4), 0x8a3a2a, 0.08, 0.3, -0.12);
    },
    extraTorso(l) {
      // tool pouch on the belt
      add(l, box(0.1, 0.12, 0.06), 0x5c3f25, 0.17, 0.82, 0.12, 0, 0.5);
    },
  },
  sawyer: {
    name: 'ช่างเลื่อย', tunic: 0x3e5a7a, sleeve: 0x3e5a7a, trousers: 0x5b4a32, skirt: 0x37506e,
    belt: 0x3a2716, apron: 0x8a6a44, item: 'saw',
    extraHead(l) {
      add(l, cyl(0.15, 0.17, 0.08, 10), 0x4a3828, 0, 0.29, -0.01);   // felt cap
      add(l, cyl(0.2, 0.2, 0.02, 12), 0x4a3828, 0, 0.25, 0.02, 0.15);
    },
  },
  miller: {
    name: 'ช่างโม่แป้ง', tunic: 0xd8cdb4, sleeve: 0xd8cdb4, trousers: 0x8a7a60, skirt: 0xc8bc9e,
    belt: 0x8a6a44, apron: 0xf2ece0, item: 'scoop',
    extraHead(l) {
      add(l, sph(0.17, 10, 6), 0xf2ece0, 0, 0.27, -0.02, 0, 0, 0, 1, 0.55, 1);   // flat cloth cap
    },
  },
  baker: {
    name: 'คนทำขนมปัง', tunic: 0xe8dcc0, sleeve: 0xe8dcc0, trousers: 0x6b5a44, skirt: 0xd8cbb0,
    belt: null, apron: 0xfaf6ec, item: 'loaf',
    extraHead(l) {
      // puffy baker's toque
      add(l, cyl(0.16, 0.155, 0.08, 10), 0xfaf6ec, 0, 0.27, 0);
      add(l, sph(0.17, 10, 6), 0xfaf6ec, 0, 0.36, 0, 0, 0, 0, 1, 0.7, 1);
    },
  },
  priest: {
    name: 'นักบวช', tunic: 0x4a3426, sleeve: 0x4a3426, trousers: 0x3a2a1e, robe: true,
    belt: 0xd8c89a, ropeBelt: true, cuff: 0x3e2c20, item: 'book', bald: true,
    extraHead(l, o) {
      // tonsure: ring of hair around a bald crown
      add(l, torus(0.13, 0.035, 12), o.hair, 0, 0.22, -0.01, Math.PI / 2);
    },
    extraTorso(l) {
      add(l, halfSph(0.2, 10, 5), 0x4a3426, 0, 1.36, -0.08, -1.9, 0, 0, 1, 0.8, 0.8);   // hood down the back
      add(l, box(0.035, 0.18, 0.02), 0xc9a24a, 0, 1.18, 0.185);                          // wooden cross
      add(l, box(0.11, 0.035, 0.02), 0xc9a24a, 0, 1.22, 0.186);
      add(l, cyl(0.02, 0.02, 0.4, 5), 0xd8c89a, 0.12, 0.7, 0.16, 0, 0, 0.1);             // rope belt tail
    },
  },
  innkeeper: {
    name: 'เจ้าของโรงเตี๊ยม', tunic: 0xe8dcc0, sleeve: 0xe8dcc0, trousers: 0x4a3828, skirt: 0x7a2a2e,
    belt: 0x3a2716, apron: 0xefe6d2, item: 'tankard',
    extraTorso(l) {
      // maroon laced vest over the shirt
      add(l, cyl(0.225, 0.215, 0.44, 10), 0x7a2a2e, 0, 1.12, 0, 0, 0, 0, 1, 1, 0.84);
      add(l, box(0.015, 0.36, 0.01), 0xd8c89a, 0, 1.13, 0.19);
    },
    extraHead(l) {
      add(l, cyl(0.155, 0.165, 0.06, 10), 0x7a2a2e, 0, 0.28, 0);   // small cap
    },
  },
};

// Job building type -> role key.
export const JOB_ROLE = {
  woodcutter: 'woodcutter', forager: 'forager', quarry: 'quarry', sawmill: 'sawyer',
  farmhouse: 'farmer', mill: 'miller', bakery: 'baker', chapel: 'priest', tavern: 'innkeeper',
};

// Build the part geometries for a role in a given look.
export function buildCharacter(roleKey, lookIndex = 0) {
  const role = ROLES[roleKey];
  const look = LOOKS[lookIndex % LOOKS.length];
  const o = { ...role, ...look, skin: look.skin, hair: look.hair, beard: look.beard && !role.bald ? look.beard : false };
  if (look.female) o.hideBraid = !!role.extraHead && roleKey !== 'forager' && roleKey !== 'villager' && roleKey !== 'farmer';
  return {
    name: role.name,
    torso: torso(o),
    head: head(o),
    armL: arm(o),
    armR: arm(o),
    legL: leg(o),
    legR: leg(o),
    item: role.item ? ITEM_BUILDERS[role.item]() : null,
  };
}

export const CARRY_KINDS = Object.keys(CARRY_BUILDERS);
export function buildCarry(res) {
  return (CARRY_BUILDERS[res] || CARRY_BUILDERS.stone)();
}

// ---------------------------------------------------------------- posed assembly (previews)

let previewMat = null;
export function characterMaterial() {
  if (!previewMat) previewMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  return previewMat;
}

// Assemble a character as a Group of meshes for previews.
export function makeCharacterGroup(roleKey, lookIndex = 0, carry = null) {
  const c = buildCharacter(roleKey, lookIndex);
  const mat = characterMaterial();
  const g = new THREE.Group();
  const mesh = (geo) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; return m; };
  const pivot = (geo, p) => { const pv = new THREE.Group(); pv.position.set(...p); pv.add(mesh(geo)); g.add(pv); return pv; };
  g.add(mesh(c.torso));
  const parts = {
    head: pivot(c.head, PIVOTS.neck),
    armL: pivot(c.armL, PIVOTS.shoulderL),
    armR: pivot(c.armR, PIVOTS.shoulderR),
    legL: pivot(c.legL, PIVOTS.hipL),
    legR: pivot(c.legR, PIVOTS.hipR),
  };
  if (c.item && !carry) {
    const it = mesh(c.item);
    it.position.set(...PIVOTS.hand);
    parts.armR.add(it);
  }
  if (carry) {
    const cm = mesh(buildCarry(carry));
    cm.position.set(...PIVOTS.carry);
    g.add(cm);
  }
  g.userData = { parts, name: c.name, carrying: !!carry };
  return g;
}

// Limb angles for a pose; shared by previews and the in-game instanced renderer.
// Returns { legL, legR, armL, armR, armLz, armRz, head, bob }.
const _pose = { legL: 0, legR: 0, armL: 0, armR: 0, armLz: 0, armRz: 0, head: 0, bob: 0 };
export function poseAngles(kind, phase, carrying = false) {
  const P = _pose;
  P.legL = P.legR = P.armL = P.armR = P.armLz = P.armRz = P.head = P.bob = 0;
  if (kind === 'walk') {
    const s = Math.sin(phase);
    P.legL = s * 0.6; P.legR = -s * 0.6;
    P.armL = -s * 0.5; P.armR = s * 0.5;
    P.bob = Math.abs(Math.cos(phase)) * 0.05;
    P.head = Math.sin(phase * 0.5) * 0.05;
  } else if (kind === 'work') {
    const t = ((phase / (Math.PI * 2)) % 1 + 1) % 1;
    const w = t < 0.7 ? t / 0.7 : 1 - (t - 0.7) / 0.3;
    const swing = -0.5 - w * w * 2.3;
    P.armR = swing; P.armL = swing * 0.8; P.armLz = -0.35;
  } else {
    P.armL = Math.sin(phase * 0.3) * 0.04; P.armR = -P.armL;
    P.bob = Math.sin(phase * 0.6) * 0.008;
  }
  if (carrying) {
    // both arms forward cradling the load; legs keep walking
    P.armL = P.armR = -1.15; P.armLz = 0.25; P.armRz = -0.25;
  }
  return P;
}

export function applyPose(group, kind, phase) {
  const p = group.userData.parts;
  const a = poseAngles(kind, phase, group.userData.carrying);
  p.legL.rotation.x = a.legL; p.legR.rotation.x = a.legR;
  p.armL.rotation.set(a.armL, 0, a.armLz); p.armR.rotation.set(a.armR, 0, a.armRz);
  p.head.rotation.y = a.head;
  group.position.y = a.bob;
}
