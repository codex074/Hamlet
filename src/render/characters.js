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

// Tessellation scales with size: big curved parts stay smooth, tiny details stay cheap.
const segs = (r, lo = 6, hi = 16) => Math.max(lo, Math.min(hi, Math.round(r * 100)));
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt, rb, h) => new THREE.CylinderGeometry(rt, rb, h, segs(Math.max(rt, rb), 8, 16));
const sph = (r) => new THREE.SphereGeometry(r, segs(r, 6, 16), segs(r, 5, 11));
const halfSph = (r) => new THREE.SphereGeometry(r, segs(r, 10, 16), 6, 0, Math.PI * 2, 0, Math.PI / 2);
const cone = (r, h) => new THREE.ConeGeometry(r, h, segs(r, 6, 14));
const torus = (r, t) => new THREE.TorusGeometry(r, t, 5, segs(r * 1.2, 10, 24));
const capsule = (r, len) => new THREE.CapsuleGeometry(r, len, 3, segs(r * 1.3, 6, 10));
// Curved sheet in front of the body: open cylinder arc of `span` radians centred on +Z.
const arc = (rt, rb, h, span) => new THREE.CylinderGeometry(rt, rb, h, 14, 1, true, -span / 2, span);
// Rounded box: a sphere squashed into the box's proportions.
const rbox = (w, h, d) => new THREE.SphereGeometry(0.5, 10, 7).scale(w, h, d);
// Body of revolution from [radius, y] pairs (bottom to top).
const lathe = (pts, seg = 16) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);

// ---------------------------------------------------------------- looks (face/hair/body variation)

export const LOOKS = [
  { skin: 0xe0b08c, hair: 0x5a3a22, beard: true },
  { skin: 0xc68a62, hair: 0x231a14, beard: false },
  { skin: 0xf0c8a8, hair: 0xc9a050, female: true },
  { skin: 0x9a6442, hair: 0x1a1410, female: true },
  { skin: 0xeab896, hair: 0x8a3a1c, beard: true },
  { skin: 0xd9a27a, hair: 0x9a9a92, beard: true, elder: true },
  { skin: 0xe8bc9a, hair: 0x8a3a1c, female: true },
  { skin: 0xc68a62, hair: 0x3a2618, female: true },
  { skin: 0xf0c8a8, hair: 0xb8b8b0, female: true, elder: true },
  { skin: 0x9a6442, hair: 0xa8a8a0, beard: false, elder: true },
  { skin: 0xf2cdb0, hair: 0xd9b46a, beard: false },
];

// Pick a look index that matches a villager's gender and age group, varied by id.
const LOOK_GROUPS = {};
LOOKS.forEach((l, i) => {
  const k = `${l.female ? 'f' : 'm'}${l.elder ? 'e' : ''}`;
  (LOOK_GROUPS[k] = LOOK_GROUPS[k] || []).push(i);
});
export function pickLook(gender, elder, seed) {
  const group = LOOK_GROUPS[`${gender === 'f' ? 'f' : 'm'}${elder ? 'e' : ''}`];
  return group[Math.abs(Math.floor(seed)) % group.length];
}

// ---------------------------------------------------------------- body parts (local space, origin = pivot)

function leg(o) {
  const l = [];
  add(l, capsule(0.082, 0.4), o.trousers, 0, -0.29, 0);                          // whole leg, rounded knee/hip
  add(l, cyl(0.088, 0.082, 0.17), o.bootTop ?? BOOT, 0, -0.6, 0);               // boot shaft
  add(l, sph(0.088), o.bootTop ?? BOOT, 0, -0.52, 0, 0, 0, 0, 1, 0.5, 1);       // rolled boot cuff
  add(l, capsule(0.065, 0.13), o.boot ?? BOOT, 0, -0.705, 0.045, Math.PI / 2, 0, 0, 1.15, 1, 0.85); // rounded foot
  return merge(l);
}

function arm(o) {
  const l = [];
  add(l, sph(0.078), o.sleeve, 0, -0.03, 0, 0, 0, 0, 1, 0.85, 1);              // shoulder
  add(l, capsule(0.066, 0.4), o.sleeve, 0, -0.25, 0);                           // sleeve
  if (o.cuff) add(l, torus(0.06, 0.02), o.cuff, 0, -0.46, 0, Math.PI / 2);
  // mitten hand with a thumb
  add(l, sph(o.glove ? 0.064 : 0.06), o.glove ?? o.skin, 0, -0.54, 0.01, 0, 0, 0, 0.9, 1.2, 0.95);
  add(l, sph(0.026), o.glove ?? o.skin, 0.035, -0.51, 0.045);
  return merge(l);
}

// Tunic silhouette: flared hem, cinched waist, rounded chest and shoulders closing at the neck.
const TUNIC_SHORT = [[0, 0.56], [0.27, 0.565], [0.268, 0.6], [0.24, 0.72], [0.215, 0.86], [0.212, 0.93],
  [0.228, 1.06], [0.232, 1.2], [0.215, 1.31], [0.17, 1.39], [0.1, 1.44], [0, 1.455]];
const TUNIC_LONG = [[0, 0.12], [0.3, 0.125], [0.3, 0.17], [0.27, 0.42], [0.235, 0.72], [0.212, 0.9],
  [0.228, 1.06], [0.232, 1.2], [0.215, 1.31], [0.17, 1.39], [0.1, 1.44], [0, 1.455]];

function torso(o) {
  const l = [];
  const long = o.robe || o.female;
  const prof = long ? TUNIC_LONG.map(([r, y]) => [o.robe && y < 0.5 ? r * 1.08 : r, y]) : TUNIC_SHORT;
  const lowColor = long ? (o.skirt ?? o.tunic) : o.tunic;
  // two lathes so dresses can have a skirt colour below the waist
  add(l, lathe(prof.filter(([, y]) => y <= 0.93).concat([[0, 0.93]])), lowColor, 0, 0, 0, 0, 0, 0, 1, 1, 0.84);
  add(l, lathe([[0, 0.9], [0.214, 0.9]].concat(prof.filter(([, y]) => y > 0.93))), o.tunic, 0, 0, 0, 0, 0, 0, 1, 1, 0.84);
  if (o.belt !== null) {
    add(l, torus(0.215, 0.028), o.belt ?? 0x4a3320, 0, 0.9, 0, Math.PI / 2, 0, 0, 1, 0.84, 1);
    if (!o.ropeBelt) add(l, rbox(0.075, 0.065, 0.035), 0xc9a24a, 0, 0.9, 0.185);
  }
  add(l, cyl(0.062, 0.07, 0.1), o.skin, 0, 1.47, 0);                            // neck
  if (o.apron) {
    // apron: curved panels wrapping the front of the body (open cylinder arcs)
    add(l, arc(0.245, 0.29, 0.42, 1.5), o.apron, 0, 0.68, 0, 0, 0, 0, 1, 1, 0.86);
    add(l, arc(0.236, 0.232, 0.3, 1.1), o.apron, 0, 1.09, 0, 0, 0, 0, 1, 1, 0.86);
    add(l, torus(0.244, 0.012), o.apron, 0, 0.885, 0, Math.PI / 2, 0, 0, 1, 0.86, 1);
    add(l, torus(0.115, 0.013), o.apron, 0, 1.38, 0.035, Math.PI / 2 - 0.55, 0, 0, 1, 1, 1); // neck strap
  }
  if (o.extraTorso) o.extraTorso(l, o);
  return merge(l);
}

function head(o) {
  const l = [];
  const skin = o.skin;
  add(l, sph(0.15), skin, 0, 0.16, 0, 0, 0, 0, 0.95, 1.06, 0.98);       // skull
  add(l, sph(0.1), skin, 0, 0.08, 0.045, 0, 0, 0, 1.1, 0.8, 1);         // jaw/cheeks
  add(l, sph(0.032), skin, 0, 0.14, 0.155, 0, 0, 0, 0.9, 1.15, 1);              // nose
  add(l, sph(0.034), skin, -0.145, 0.15, 0, 0, 0, 0, 0.6, 1, 0.9);              // ears
  add(l, sph(0.034), skin, 0.145, 0.15, 0, 0, 0, 0, 0.6, 1, 0.9);
  add(l, sph(0.018), DARK, -0.055, 0.19, 0.137);                                // eyes
  add(l, sph(0.018), DARK, 0.055, 0.19, 0.137);
  add(l, capsule(0.009, 0.05), 0xa8705a, 0, 0.085, 0.14, 0, 0, Math.PI / 2);    // mouth
  const browC = o.female ? DARK : o.hair;
  const browT = o.female ? 0.007 : 0.011;
  add(l, capsule(browT, 0.045), browC, -0.055, 0.222, 0.138, 0, 0, Math.PI / 2 + (o.female ? 0.15 : 0));
  add(l, capsule(browT, 0.045), browC, 0.055, 0.222, 0.138, 0, 0, Math.PI / 2 - (o.female ? 0.15 : 0));
  if (!o.bald) add(l, halfSph(0.158), o.hair, 0, 0.17, -0.01, -0.25, 0, 0, 1, 1.05, 1.02);
  if (o.female && !o.hideBraid) {
    // hair falling down the back + braid
    add(l, sph(0.14), o.hair, 0, 0.1, -0.08, 0, 0, 0, 1, 1.15, 0.7);
    add(l, sph(0.05), o.hair, 0, -0.06, -0.15);
    add(l, sph(0.045), o.hair, 0, -0.14, -0.16);
    add(l, sph(0.04), o.hair, 0, -0.21, -0.165);
    add(l, sph(0.025), 0xb5523a, 0, -0.26, -0.165);                              // ribbon
  }
  if (o.beard && !o.female) {
    add(l, sph(0.11), o.hair, 0, 0.055, 0.07, 0, 0, 0, 1.05, 0.9, 0.8);
    add(l, capsule(0.016, 0.07), o.hair, -0.035, 0.105, 0.145, 0, 0, Math.PI / 2 - 0.35); // moustache
    add(l, capsule(0.016, 0.07), o.hair, 0.035, 0.105, 0.145, 0, 0, Math.PI / 2 + 0.35);
  }
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
    add(l, rbox(0.06, 0.08, 0.1), 0x5c6168, 0, hy, hz, a);
    add(l, cyl(0.11, 0.11, 0.035).rotateZ(Math.PI / 2).scale(1, 1, 0.75), 0x9aa3ab, 0, hy - 0.05, hz + 0.06, a - 0.1);
  }),
  pickaxe: () => tool(0.75, (l, hy, hz, a) => {
    add(l, rbox(0.06, 0.09, 0.09), 0x5c6168, 0, hy, hz, a);
    add(l, cone(0.035, 0.26, 5), IRON, 0, hy + 0.15, hz, 0);
    add(l, cone(0.035, 0.26, 5), IRON, 0, hy - 0.15, hz, Math.PI);
  }),
  hammer: () => tool(0.45, (l, hy, hz, a) => {
    add(l, cyl(0.045, 0.045, 0.17), 0x6b7078, 0, hy, hz, a + Math.PI / 2);
  }),
  sickle: () => tool(0.32, (l, hy, hz) => {
    add(l, torus(0.13, 0.016, 10), 0xb8bec4, 0, hy + 0.02, hz + 0.12, 0, Math.PI / 2, 0, 1, 1, 1);
  }, 1.2),
  saw: () => {
    const l = [];
    add(l, rbox(0.06, 0.11, 0.13), WOOD, 0, -0.02, 0.06);
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
    add(l, capsule(0.012, 0.08), 0xe8c88a, -0.05, 0.02, 0.08, Math.PI / 2);
    add(l, capsule(0.012, 0.08), 0xe8c88a, 0.05, 0.02, 0.08, Math.PI / 2);
    return merge(l);
  },
  book: () => {
    const l = [];
    add(l, box(0.05, 0.22, 0.17), 0x6a1e22, 0, -0.06, 0.08);
    add(l, box(0.04, 0.2, 0.15), 0xefe3c2, 0.008, -0.06, 0.08);
    add(l, sph(0.022), 0xc9a24a, 0.02, -0.06, 0.16);
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
  rod: () => {
    // long fishing rod held forward and up, line dangling from the tip
    const l = [];
    const a = 0.75, L = 2.0, dy = Math.cos(a), dz = Math.sin(a);
    add(l, cyl(0.012, 0.025, L), 0x8a6a3a, 0, dy * (L / 2 - 0.15), dz * (L / 2 - 0.15), a);
    add(l, cyl(0.035, 0.035, 0.05), 0x5c4630, 0, -0.02, 0.02, a + Math.PI / 2);          // reel
    const ty = dy * (L - 0.15), tz = dz * (L - 0.15);
    add(l, cyl(0.003, 0.003, 1.1), 0xe8e8e0, 0, ty - 0.55, tz);                          // line
    add(l, sph(0.025), 0xc23a2a, 0, ty - 1.1, tz);                                         // float
    return merge(l);
  },
  bow: () => {
    const l = [];
    add(l, new THREE.TorusGeometry(0.42, 0.018, 5, 18, Math.PI * 0.8).rotateZ(Math.PI * 0.6), 0x6b4a2c, 0, -0.02, 0.06, 0, Math.PI / 2, 0);
    add(l, cyl(0.004, 0.004, 0.78), 0xe8dcc0, 0, -0.02, -0.06);                            // string
    add(l, rbox(0.04, 0.12, 0.05), 0x3a2716, 0, -0.02, 0.06);                               // grip
    return merge(l);
  },
  crook: () => {
    const l = [];
    add(l, cyl(0.022, 0.026, 1.6), 0x7a5232, 0, 0.12, 0.08);
    add(l, new THREE.TorusGeometry(0.09, 0.02, 5, 12, Math.PI * 1.3), 0x7a5232, 0, 0.94, 0.17, 0, Math.PI / 2, 0);
    return merge(l);
  },
  herbs: () => {
    const l = [];
    add(l, cyl(0.025, 0.03, 0.18), 0x6b4a2c, 0, -0.08, 0.06);                             // tied stems
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      add(l, sph(0.045), i % 2 ? 0x5a8a3a : 0x7aa84a, Math.cos(a) * 0.04, 0.04, 0.06 + Math.sin(a) * 0.04, 0, 0, 0, 0.7, 1.5, 0.7);
    }
    add(l, sph(0.02), 0xb88ad8, 0.02, 0.1, 0.07);                                           // a flower
    return merge(l);
  },
  spindle: () => {
    const l = [];
    add(l, cyl(0.01, 0.01, 0.34), 0xc9a26a, 0, -0.04, 0.08);
    add(l, sph(0.065), 0xe8e0cc, 0, -0.1, 0.08, 0, 0, 0, 1, 0.8, 1);                       // wool on the spindle
    add(l, cyl(0.03, 0.03, 0.015), 0x8a6638, 0, -0.2, 0.08);                                // whorl
    return merge(l);
  },
  potion: () => {
    const l = [];
    add(l, sph(0.055), 0x6ab0a0, 0, -0.06, 0.08);
    add(l, cyl(0.018, 0.022, 0.06), 0x6ab0a0, 0, 0.0, 0.08);
    add(l, cyl(0.021, 0.021, 0.025), 0x8a6638, 0, 0.04, 0.08);                              // cork
    return merge(l);
  },
  purse: () => {
    const l = [];
    add(l, sph(0.07), 0x7a3a2a, 0, -0.1, 0.06, 0, 0, 0, 1, 1.15, 0.85);
    add(l, torus(0.03, 0.01), 0xc9a24a, 0, -0.02, 0.06, Math.PI / 2);
    add(l, sph(0.018), 0xe8c050, 0.03, -0.01, 0.09);                                         // coin peeking out
    return merge(l);
  },
  sapling: () => {
    // a young tree in a clay pot, held in front
    const l = [];
    add(l, cyl(0.07, 0.05, 0.1), 0xa85a3a, 0, -0.1, 0.1);
    add(l, cyl(0.072, 0.072, 0.015), 0x6b4a2c, 0, -0.05, 0.1);
    add(l, cyl(0.008, 0.01, 0.3), 0x7a5232, 0, 0.1, 0.1);
    add(l, sph(0.07), 0x5a9a3a, 0, 0.27, 0.1, 0, 0, 0, 1, 1.2, 1);
    add(l, sph(0.05), 0x6aaa48, 0.05, 0.2, 0.12);
    return merge(l);
  },
  cane: () => {
    const l = [];
    add(l, cyl(0.018, 0.022, 0.92), 0x6b4a2c, 0, -0.42, 0.06);
    add(l, sph(0.035), 0x5c3f25, 0, 0.04, 0.06);
    return merge(l);
  },
  bighammer: () => tool(0.5, (l, hy, hz, a) => {
    add(l, cyl(0.055, 0.055, 0.2), 0x55595e, 0, hy, hz, a + Math.PI / 2);
  }),
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
    add(l, rbox(0.7, 0.05, 0.17), 0xc49a62, 0, -0.03, 0);
    add(l, rbox(0.7, 0.05, 0.17), 0xb48a52, 0, 0.015, 0, 0, 0.06, 0);
    add(l, rbox(0.7, 0.05, 0.17), 0xc49a62, 0, 0.06, 0, 0, -0.04, 0);
    return merge(l);
  },
  stone: () => {
    const l = [];
    add(l, rbox(0.32, 0.22, 0.24), 0x9a9890, 0, 0, 0, 0.05, 0.1, 0.03);
    add(l, rbox(0.14, 0.1, 0.12), 0xa8a69e, 0.08, 0.08, 0.02, 0.3, 0.2, 0);
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
  corn: () => {
    const l = [];
    for (let i = 0; i < 3; i++) {
      add(l, cyl(0.045, 0.035, 0.26, 6), 0xe8c23a, (i - 1) * 0.09, 0.02 * (i % 2), 0, 0, 0, Math.PI / 2 + (i - 1) * 0.15);
      add(l, cyl(0.05, 0.02, 0.1, 5), 0x9ab25a, (i - 1) * 0.09 - 0.15, 0.02 * (i % 2), 0, 0, 0, Math.PI / 2);   // husk
    }
    return merge(l);
  },
  beans: () => {
    const l = [];
    add(l, sph(0.16, 8, 6), 0xa08a5a, 0, 0, 0, 0, 0, 0, 1.15, 0.95, 0.9);   // sack
    add(l, cyl(0.05, 0.07, 0.07, 6), 0xa08a5a, 0, 0.16, 0);
    add(l, torus(0.05, 0.012, 6), 0x6b4a2c, 0, 0.15, 0, Math.PI / 2);
    for (let i = 0; i < 4; i++) add(l, sph(0.03, 5, 4), 0x6b4226, (i - 1.5) * 0.04, 0.2, 0.01 * i);   // beans on top
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
  child: {
    name: 'เด็ก', tunic: 0xb8c88a, sleeve: 0xb8c88a, trousers: 0x8a7458, skirt: 0xc89a8a,
    belt: 0x8a6a44, item: null,
  },
  elder: {
    name: 'ผู้สูงอายุ', tunic: 0x8a7a68, sleeve: 0x8a7a68, trousers: 0x5b4a3a, skirt: 0x6e5e4e,
    belt: 0x4a3320, item: 'cane',
    extraTorso(l) {
      add(l, cyl(0.2, 0.28, 0.36), 0x6b5a48, 0, 1.2, -0.02, 0, 0, 0, 1, 1, 0.86);   // warm shawl
    },
  },
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
      // leather baldric looping diagonally around the chest
      add(l, torus(0.235, 0.02), 0x3a2716, 0, 1.13, 0, Math.PI / 2, 0.62, 0, 1, 0.86, 1);
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
      add(l, rbox(0.11, 0.13, 0.07), 0x5c3f25, 0.17, 0.82, 0.12, 0, 0.5);
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
  fisher: {
    name: 'ชาวประมง', tunic: 0x5e7a86, sleeve: 0x5e7a86, trousers: 0x6b5a44, skirt: 0x52707c,
    belt: 0x3a2716, item: 'rod', workPose: 'fish',
    extraHead(l) {
      // floppy waxed-canvas hat
      add(l, cyl(0.24, 0.26, 0.03), 0x7a6a3a, 0, 0.26, -0.01, 0.12);
      add(l, halfSph(0.16), 0x7a6a3a, 0, 0.26, -0.01, 0, 0, 0, 1, 0.75, 1);
    },
    extraTorso(l) {
      // wicker creel on the back with a strap
      add(l, rbox(0.26, 0.24, 0.16), 0xa8804a, 0, 1.05, -0.26);
      add(l, torus(0.2, 0.014), 0x3a2716, 0, 1.15, -0.02, Math.PI / 2, -0.55, 0, 1, 0.86, 1);
    },
  },
  hunter: {
    name: 'นักล่า', tunic: 0x3e5a32, sleeve: 0x5c4630, trousers: 0x4a3828, skirt: 0x3e5a32,
    belt: 0x2a1d14, glove: 0x4a3828, item: 'bow', workPose: 'aim',
    extraHead(l) {
      // pointed felt cap with a feather
      add(l, cone(0.17, 0.2), 0x2e4a2a, 0, 0.34, -0.03, -0.25);
      add(l, cyl(0.17, 0.17, 0.04), 0x2e4a2a, 0, 0.26, 0);
      add(l, capsule(0.012, 0.22), 0xc23a2a, 0.12, 0.36, -0.06, -0.6, 0, -0.3);
    },
    extraTorso(l) {
      // quiver of arrows across the back
      add(l, cyl(0.05, 0.045, 0.5), 0x6b4a2c, 0.08, 1.12, -0.22, 0.2, 0, -0.35);
      for (let i = 0; i < 3; i++) add(l, cyl(0.006, 0.006, 0.18), 0xe8dcc0, 0.15 + i * 0.02, 1.42, -0.17 - i * 0.01, 0.2, 0, -0.35);
      add(l, torus(0.22, 0.014), 0x2a1d14, 0, 1.13, 0, Math.PI / 2, 0.6, 0, 1, 0.86, 1);
    },
  },
  herbalist: {
    name: 'คนเก็บสมุนไพร', tunic: 0x6b7a4a, sleeve: 0x6b7a4a, trousers: 0x5b4a32, skirt: 0x5e6c42,
    belt: 0x4a3320, item: 'herbs', workPose: 'tend',
    extraHead(l) {
      // deep green hood worn up
      add(l, halfSph(0.19), 0x3e5a3a, 0, 0.17, -0.04, -0.35, 0, 0, 1.03, 1.1, 1.05);
      add(l, cyl(0.16, 0.2, 0.12), 0x3e5a3a, 0, 0.03, -0.03, 0.15, 0, 0, 1, 1, 0.9);
    },
    extraTorso(l) {
      add(l, rbox(0.16, 0.18, 0.08), 0x8a6a44, -0.2, 0.84, 0.08, 0, -0.5);   // satchel
      add(l, torus(0.22, 0.012), 0x5c4630, 0, 1.13, 0, Math.PI / 2, -0.6, 0, 1, 0.86, 1);
      add(l, sph(0.03), 0x7aa84a, -0.2, 0.95, 0.12);                          // leaves poking out
    },
  },
  shepherd: {
    name: 'คนเลี้ยงแกะ', tunic: 0x9a8a6a, sleeve: 0x9a8a6a, trousers: 0x6b5a44, skirt: 0x8a7a5a,
    belt: 0x5c4630, item: 'crook', workPose: 'tend',
    extraHead(l) {
      add(l, cyl(0.26, 0.26, 0.02), 0xc9a860, 0, 0.27, 0);                 // straw hat
      add(l, cyl(0.12, 0.16, 0.12), 0xc9a860, 0, 0.33, 0);
    },
    extraTorso(l) {
      // undyed wool cloak around the shoulders
      add(l, cyl(0.2, 0.3, 0.42), 0xe8e0cc, 0, 1.18, -0.02, 0, 0, 0, 1, 1, 0.86);
    },
  },
  miner: {
    name: 'คนขุดแร่', tunic: 0x5a5650, sleeve: 0x5a5650, trousers: 0x3e3a34, skirt: 0x5a5650,
    belt: 0x2a1d14, apron: 0x4a3828, glove: 0x3e3a34, item: 'pickaxe',
    extraHead(l) {
      // padded leather helmet with a candle lamp
      add(l, halfSph(0.17), 0x6b4a2c, 0, 0.19, 0, -0.05, 0, 0, 1, 0.9, 1);
      add(l, cyl(0.18, 0.18, 0.03), 0x5c3f25, 0, 0.19, 0);
      add(l, cyl(0.025, 0.025, 0.06), 0xf0e8d0, 0, 0.36, 0.06);
      add(l, sph(0.018), 0xffb040, 0, 0.405, 0.06);
    },
  },
  weaver: {
    name: 'ช่างทอผ้า', tunic: 0x6a4a7a, sleeve: 0x6a4a7a, trousers: 0x4a3828, skirt: 0x5a3e6a,
    belt: 0xc9a24a, apron: 0xe8dcc0, item: 'spindle', workPose: 'tend',
    extraHead(l) {
      add(l, halfSph(0.17), 0x3e6a9a, 0, 0.18, -0.015, -0.3, 0, 0, 1.02, 1.0, 1.05);   // blue headscarf
      add(l, sph(0.04), 0x3e6a9a, 0, 0.11, -0.17);
    },
    extraTorso(l) {
      for (let i = 0; i < 3; i++) add(l, torus(0.04, 0.02), [0xc23a2a, 0x3e6a9a, 0xd9b45a][i], -0.18 + i * 0.05, 0.86, 0.17, 0, 0, Math.PI / 2); // yarn skeins on the belt
    },
  },
  blacksmith: {
    name: 'ช่างตีเหล็ก', tunic: 0x7a3a2a, sleeve: null, trousers: 0x3e3a34, skirt: 0x7a3a2a,
    belt: 0x2a1d14, apron: 0x3a2716, glove: 0x2a1d14, item: 'bighammer', bald: true, beard: true,
  },
  doctor: {
    name: 'หมอ', tunic: 0x2e2a3a, sleeve: 0x2e2a3a, trousers: 0x2a2620, robe: true,
    belt: 0x6b4a2c, collar: 0xe8e0d0, item: 'potion', workPose: 'heal',
    extraHead(l) {
      add(l, cyl(0.15, 0.16, 0.1), 0x1e1a26, 0, 0.3, 0);                    // physician's cap
      add(l, cyl(0.18, 0.18, 0.02), 0x1e1a26, 0, 0.25, 0);
    },
    extraTorso(l) {
      add(l, torus(0.1, 0.03), 0xe8e0d0, 0, 1.43, 0, Math.PI / 2);         // white collar
      add(l, rbox(0.18, 0.16, 0.08), 0x6b4a2c, 0.21, 0.82, 0.06, 0, 0.5);  // medicine bag
      add(l, sph(0.022), 0xc9a24a, 0.24, 0.86, 0.1);
      add(l, torus(0.22, 0.012), 0x4a3320, 0, 1.13, 0, Math.PI / 2, 0.6, 0, 1, 0.86, 1);
    },
  },
  forester: {
    name: 'คนปลูกป่า', tunic: 0x5a6a3a, sleeve: 0x5a6a3a, trousers: 0x4a3a28, skirt: 0x4e5e34,
    belt: 0x3a2716, apron: 0x7a6a4a, glove: 0x5c4630, item: 'sapling', workPose: 'tend',
    extraHead(l) {
      // wide brimmed felt hat with a sprig of leaves in the band
      add(l, cyl(0.25, 0.25, 0.025), 0x4a5a2e, 0, 0.27, 0);
      add(l, cyl(0.13, 0.16, 0.12), 0x4a5a2e, 0, 0.33, 0);
      add(l, cyl(0.162, 0.162, 0.03), 0x3a2716, 0, 0.29, 0);
      add(l, sph(0.035), 0x6aaa48, 0.14, 0.31, 0.05, 0, 0, 0, 0.6, 1.4, 0.6);
      add(l, sph(0.03), 0x5a9a3a, 0.15, 0.33, 0.0, 0, 0, 0, 0.6, 1.3, 0.6);
    },
  },
  merchant: {
    name: 'พ่อค้า', tunic: 0x2e6a4a, sleeve: 0xc9a24a, trousers: 0x5a2a2a, skirt: 0x2e6a4a,
    belt: 0x5c3f25, cuff: 0xc9a24a, item: 'purse', workPose: 'tend',
    extraHead(l) {
      // floppy velvet beret with a feather
      add(l, sph(0.19), 0x7a2a2e, 0.02, 0.28, -0.01, 0, 0, -0.15, 1, 0.38, 1);
      add(l, capsule(0.012, 0.2), 0xf0e8d0, -0.1, 0.36, -0.05, -0.4, 0, 0.5);
    },
    extraTorso(l) {
      add(l, torus(0.225, 0.02), 0xc9a24a, 0, 0.62, 0, Math.PI / 2, 0, 0, 1, 0.86, 1);  // gold-trimmed hem
    },
  },
};

// Job building type -> role key.
export const JOB_ROLE = {
  woodcutter: 'woodcutter', forager: 'forager', quarry: 'quarry', sawmill: 'sawyer',
  farmhouse: 'farmer', mill: 'miller', bakery: 'baker', chapel: 'priest', tavern: 'innkeeper',
  fishery: 'fisher', hunter: 'hunter', herbalist: 'herbalist', sheepfarm: 'shepherd', ironmine: 'miner',
  weaver: 'weaver', blacksmith: 'blacksmith', infirmary: 'doctor', market: 'merchant', forester: 'forester',
  coop: 'shepherd', pigsty: 'shepherd', cattle: 'shepherd',
};

// Work animation per role (default 'chop').
export function workPoseOf(roleKey) {
  return ROLES[roleKey]?.workPose || 'chop';
}

// Build the part geometries for a role in a given look.
// opts: { pregnant, child } — pregnant adds a belly; child drops beards and adult extras.
export function buildCharacter(roleKey, lookIndex = 0, opts = {}) {
  const role = ROLES[roleKey] || ROLES.villager;
  const look = LOOKS[lookIndex % LOOKS.length];
  const o = { ...role, ...look, skin: look.skin, hair: look.hair, beard: role.beard || (look.beard && !role.bald) };
  if (role.sleeve === null) o.sleeve = look.skin;   // bare, rolled-up arms
  if (look.female) o.hideBraid = !!role.extraHead && !['forager', 'villager', 'farmer', 'child', 'elder'].includes(roleKey);
  if (opts.child) { o.beard = false; o.bald = false; }
  if (opts.pregnant) {
    const prev = o.extraTorso;
    o.extraTorso = (l, oo) => {
      if (prev) prev(l, oo);
      add(l, sph(0.2), oo.skirt ?? oo.tunic, 0, 0.98, 0.1, 0, 0, 0, 1, 1.05, 1);   // rounded belly
    };
  }
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
  if (!previewMat) {
    previewMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    previewMat.userData.noWeather = true;   // villagers do not turn white in the snow
  }
  return previewMat;
}

// Assemble a character as a Group of meshes for previews.
export function makeCharacterGroup(roleKey, lookIndex = 0, carry = null, opts = {}) {
  const c = buildCharacter(roleKey, lookIndex, opts);
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
  } else if (kind === 'work' || kind === 'chop') {
    const t = ((phase / (Math.PI * 2)) % 1 + 1) % 1;
    const w = t < 0.7 ? t / 0.7 : 1 - (t - 0.7) / 0.3;
    const swing = -0.5 - w * w * 2.3;
    P.armR = swing; P.armL = swing * 0.8; P.armLz = -0.35;
  } else if (kind === 'aim') {
    // draw the bow: left arm extended, right arm pulling back, then release
    const t = ((phase / (Math.PI * 2)) % 1 + 1) % 1;
    P.armL = -1.5; P.armLz = 0.15;
    P.armR = -1.35 + Math.min(1, t * 1.6) * 0.25; P.armRz = -0.5 - Math.min(1, t * 1.6) * 0.35;
    P.head = 0.2;
  } else if (kind === 'fish') {
    // hold the rod out, small twitches
    P.armR = -0.9 + Math.sin(phase * 0.8) * 0.06; P.armL = -0.7; P.armLz = -0.3;
    P.bob = Math.sin(phase * 0.5) * 0.006;
  } else if (kind === 'tend' || kind === 'heal') {
    // lean-in handiwork: both hands busy in front
    P.armR = -0.8 + Math.sin(phase * 1.6) * 0.25; P.armL = -0.7 + Math.cos(phase * 1.6) * 0.2;
    P.armLz = 0.2; P.armRz = -0.2;
    P.head = Math.sin(phase * 0.4) * 0.1;
  } else if (kind === 'sick') {
    // shuffling, arms hugging the belly
    const s = Math.sin(phase);
    P.legL = s * 0.3; P.legR = -s * 0.3;
    P.armL = -0.55; P.armR = -0.55; P.armLz = 0.45; P.armRz = -0.45;
    P.bob = Math.abs(Math.cos(phase)) * 0.02;
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
