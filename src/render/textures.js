// Procedural painterly textures (canvas, generated lazily, cached). No image files.
// All textures tile seamlessly. Base tones are kept light-ish so material/vertex colours can tint them.
// Node-safe: with no `document` every getTexture() returns null (callers fall back to flat colours).
import * as THREE from '../../vendor/three.module.js';

const cache = new Map();

export const TEXTURE_NAMES = [
  'plaster', 'timber', 'planks', 'thatch', 'shingles', 'slate', 'stoneWall', 'cobble', 'roofTiles', 'hay', 'grass',
];

// ---------------------------------------------------------------- helpers

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}

function makeRng(seed) {
  let a = seed >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.range = (lo, hi) => lo + (hi - lo) * r();
  r.pick = (arr) => arr[Math.floor(r() * arr.length) % arr.length];
  return r;
}

const rgba = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const hex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const jit = (c, r, amt) => {
  const d = (r() - 0.5) * 2 * amt;
  return [c[0] + d, c[1] + d * 0.92, c[2] + d * 0.8];
};

// Run fn(x, y) at x/y and at the wrapped copies that spill over the tile edge.
function wrap(S, x, y, rad, fn) {
  const xs = [0];
  const ys = [0];
  if (x - rad < 0) xs.push(S);
  if (x + rad > S) xs.push(-S);
  if (y - rad < 0) ys.push(S);
  if (y + rad > S) ys.push(-S);
  for (const dx of xs) for (const dy of ys) fn(x + dx, y + dy);
}

function blob(ctx, S, x, y, rad, col, alpha) {
  wrap(S, x, y, rad, (px, py) => {
    const g = ctx.createRadialGradient(px, py, 0, px, py, rad);
    g.addColorStop(0, rgba(col, alpha));
    g.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g;
    ctx.fillRect(px - rad, py - rad, rad * 2, rad * 2);
  });
}

function blobs(ctx, S, r, n, rMin, rMax, cols, aMin, aMax) {
  for (let i = 0; i < n; i++) {
    blob(ctx, S, r() * S, r() * S, r.range(rMin, rMax), r.pick(cols), r.range(aMin, aMax));
  }
}

function speckle(ctx, S, r, n, cols, sMin, sMax, aMin, aMax) {
  for (let i = 0; i < n; i++) {
    const s = r.range(sMin, sMax);
    const x = r() * S;
    const y = r() * S;
    ctx.fillStyle = rgba(r.pick(cols), r.range(aMin, aMax));
    wrap(S, x, y, s, (px, py) => ctx.fillRect(px, py, s, s));
  }
}

// Line of given width/colour from (x,y) along angle a, wrapping across tile edges.
function stroke(ctx, S, x, y, len, a, w, col) {
  const dx = Math.cos(a) * len;
  const dy = Math.sin(a) * len;
  ctx.strokeStyle = col;
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  const rad = Math.abs(dx) + Math.abs(dy) + w;
  wrap(S, x, y, rad, (px, py) => {
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + dx, py + dy);
    ctx.stroke();
  });
}

// Per-pixel brightness noise (cheap film grain that breaks up flat colour).
function grain(ctx, S, r, amount) {
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * amount;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

function roundRect(ctx, x, y, w, h, rad) {
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

// ---------------------------------------------------------------- painters

function paintPlaster(ctx, S, r) {
  ctx.fillStyle = '#f0e5ca';
  ctx.fillRect(0, 0, S, S);
  blobs(ctx, S, r, 26, 90, 190, [hex(0xdccba4), hex(0xfff7e2), hex(0xd2c4a6), hex(0xf4e2b8)], 0.1, 0.22);
  blobs(ctx, S, r, 120, 24, 70, [hex(0xd6c49a), hex(0xfff4da), hex(0xc9b88f), hex(0xe9d9b2)], 0.06, 0.16);
  // trowel sweeps
  for (let i = 0; i < 44; i++) {
    const x = r() * S;
    const y = r() * S;
    const a = r.range(-0.5, 0.5);
    stroke(ctx, S, x, y, r.range(50, 130), a, r.range(8, 20), rgba(r() < 0.5 ? [255, 250, 232] : [190, 170, 130], 0.07));
  }
  speckle(ctx, S, r, 1400, [hex(0x8a7a5a), hex(0x6a5c42)], 1, 2.6, 0.1, 0.3);
  speckle(ctx, S, r, 700, [hex(0xffffff)], 1, 2.4, 0.12, 0.3);
  // hairline cracks
  for (let i = 0; i < 7; i++) {
    let x = r() * S;
    let y = r() * S;
    let a = r.range(0, 6.28);
    ctx.strokeStyle = rgba([110, 92, 66], 0.35);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 0; k < 6; k++) {
      a += r.range(-0.7, 0.7);
      x += Math.cos(a) * r.range(8, 20);
      y += Math.sin(a) * r.range(8, 20);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // dirt creeping up from the bottom (canvas bottom == ground level)
  const gd = ctx.createLinearGradient(0, S * 0.7, 0, S);
  gd.addColorStop(0, 'rgba(110,86,52,0)');
  gd.addColorStop(1, 'rgba(110,86,52,0.34)');
  ctx.fillStyle = gd;
  ctx.fillRect(0, S * 0.7, S, S * 0.3);
  for (let i = 0; i < 26; i++) {
    const x = r() * S;
    const len = r.range(20, 110);
    const g = ctx.createLinearGradient(0, S, 0, S - len);
    g.addColorStop(0, 'rgba(100,78,48,0.28)');
    g.addColorStop(1, 'rgba(100,78,48,0)');
    ctx.fillStyle = g;
    const w = r.range(3, 10);
    wrap(S, x, S, w, (px) => ctx.fillRect(px, S - len, w, len));
  }
  blobs(ctx, S, r, 10, 14, 34, [hex(0x6e5a3a)], 0.12, 0.25);
  grain(ctx, S, r, 12);
}

function paintTimber(ctx, S, r) {
  ctx.fillStyle = '#b08a5c';
  ctx.fillRect(0, 0, S, S);
  blobs(ctx, S, r, 18, 40, 100, [hex(0x8e6a42), hex(0xc29c68), hex(0x9a7448)], 0.18, 0.34);
  // long grain
  for (let i = 0; i < 150; i++) {
    const x = r() * S;
    const dark = r() < 0.6;
    const col = dark ? rgba([55, 35, 18], r.range(0.15, 0.4)) : rgba([190, 150, 100], r.range(0.1, 0.28));
    ctx.strokeStyle = col;
    ctx.lineWidth = r.range(0.8, 3);
    ctx.beginPath();
    let px = x;
    ctx.moveTo(px, 0);
    const ph = r() * 6;
    for (let y = 0; y <= S; y += 16) {
      px = x + Math.sin(y * 0.02 + ph) * 2.2;
      ctx.lineTo(px, y);
    }
    ctx.stroke();
  }
  // knots
  for (let i = 0; i < 3; i++) {
    const x = r() * S;
    const y = r() * S;
    for (let k = 4; k >= 1; k--) {
      ctx.strokeStyle = rgba([40, 25, 12], 0.12 + (4 - k) * 0.08);
      ctx.lineWidth = 2;
      wrap(S, x, y, 40, (px, py) => {
        ctx.beginPath();
        ctx.ellipse(px, py, k * 4, k * 9, 0, 0, 6.28);
        ctx.stroke();
      });
    }
  }
  speckle(ctx, S, r, 500, [hex(0x2a1a0c)], 1, 2.4, 0.15, 0.4);
  grain(ctx, S, r, 14);
}

function paintPlanks(ctx, S, r) {
  ctx.fillStyle = '#7a5a38';
  ctx.fillRect(0, 0, S, S);
  const n = 6;
  const bw = S / n;
  for (let i = 0; i < n; i++) {
    const base = jit(hex(0xd2aa76), r, 22);
    const x0 = i * bw;
    const g = ctx.createLinearGradient(x0, 0, x0 + bw, 0);
    g.addColorStop(0, rgba(mix(base, [255, 235, 190], 0.1)));
    g.addColorStop(1, rgba(mix(base, [60, 38, 18], 0.18)));
    ctx.fillStyle = g;
    ctx.fillRect(x0 + 1, 0, bw - 2, S);
    for (let k = 0; k < 16; k++) {
      const x = x0 + r.range(3, bw - 3);
      ctx.strokeStyle = rgba(r() < 0.7 ? [70, 46, 22] : [225, 190, 140], r.range(0.1, 0.32));
      ctx.lineWidth = r.range(0.7, 2);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      const ph = r() * 6;
      for (let y = 0; y <= S; y += 16) ctx.lineTo(x + Math.sin(y * 0.03 + ph) * 1.8, y);
      ctx.stroke();
    }
    if (r() < 0.8) {
      const kx = x0 + r.range(10, bw - 10);
      const ky = r() * S;
      for (let q = 3; q >= 1; q--) {
        ctx.strokeStyle = rgba([45, 28, 12], 0.25);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(kx, ky, q * 2.4, q * 6, 0, 0, 6.28);
        ctx.stroke();
      }
    }
    // dark seam
    ctx.fillStyle = 'rgba(30,18,8,0.7)';
    ctx.fillRect(x0 - 1.5, 0, 3, S);
    // nails
    ctx.fillStyle = 'rgba(40,36,34,0.85)';
    for (const ny of [S * 0.1, S * 0.5, S * 0.9]) {
      ctx.beginPath(); ctx.arc(x0 + bw * 0.5, ny, 2.2, 0, 6.28); ctx.fill();
    }
  }
  blobs(ctx, S, r, 10, 30, 70, [hex(0x4a3018)], 0.08, 0.18);
  grain(ctx, S, r, 12);
}

function paintThatch(ctx, S, r) {
  ctx.fillStyle = '#c59c4a';
  ctx.fillRect(0, 0, S, S);
  blobs(ctx, S, r, 30, 40, 110, [hex(0xa9812f), hex(0xe0bd70), hex(0x937026), hex(0xd4ac55)], 0.2, 0.36);
  const pal = [hex(0xe8c978), hex(0xd2a94f), hex(0xb98a36), hex(0xf0d98f), hex(0x9a7428), hex(0xc99a42), hex(0xdcb860)];
  const courses = 8;
  const ch = S / courses;
  for (let c = 0; c < courses; c++) {
    const y0 = c * ch;
    // straw stalks laid down the slope (canvas vertical), bunched per course
    for (let i = 0; i < 780; i++) {
      const x = r() * S;
      const y = y0 + r() * ch * 1.05;
      const col = rgba(jit(r.pick(pal), r, 14), r.range(0.45, 0.95));
      stroke(ctx, S, x, y, r.range(10, 26), Math.PI / 2 + r.range(-0.16, 0.16), r.range(1.1, 2.6), col);
    }
    // shadow under the course above, lighter lip on the lower edge
    const g = ctx.createLinearGradient(0, y0, 0, y0 + ch * 0.4);
    g.addColorStop(0, 'rgba(60,38,8,0.55)');
    g.addColorStop(1, 'rgba(60,38,8,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, y0, S, ch * 0.4);
    ctx.fillStyle = 'rgba(255,232,150,0.18)';
    ctx.fillRect(0, y0 + ch - 3, S, 2);
    // a few binding twigs
    ctx.strokeStyle = 'rgba(70,46,16,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, y0 + ch * 0.72);
    for (let x = 0; x <= S; x += 32) ctx.lineTo(x, y0 + ch * 0.72 + r.range(-2, 2));
    ctx.stroke();
  }
  speckle(ctx, S, r, 400, [hex(0x5a3f12)], 1, 2, 0.15, 0.35);
  grain(ctx, S, r, 10);
}

function paintShingles(ctx, S, r) {
  ctx.fillStyle = '#4a3a2a';
  ctx.fillRect(0, 0, S, S);
  const rows = 8;
  const rh = S / rows;
  const cols = 8;
  const cw = S / cols;
  for (let row = 0; row < rows; row++) {
    const off = (row % 2) * cw * 0.5 + r.range(-4, 4);
    for (let c = 0; c < cols; c++) {
      const x0 = c * cw + off;
      const y0 = row * rh;
      const hue = r.range(22, 38);
      const l = r.range(58, 74);
      const base = `hsl(${hue},${r.range(24, 38)}%,${l}%)`;
      const tile = (px) => {
        const g = ctx.createLinearGradient(0, y0, 0, y0 + rh + 8);
        g.addColorStop(0, `hsl(${hue},24%,${l - 14}%)`);
        g.addColorStop(0.3, base);
        g.addColorStop(1, `hsl(${hue},24%,${l + 4}%)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        const w = cw - 3;
        ctx.moveTo(px + 1, y0);
        ctx.lineTo(px + 1 + w, y0);
        ctx.lineTo(px + 1 + w, y0 + rh + 6 - r.range(0, 3));
        ctx.lineTo(px + 1 + w * 0.5, y0 + rh + 9);
        ctx.lineTo(px + 1, y0 + rh + 6 - r.range(0, 3));
        ctx.closePath();
        ctx.fill();
        // grain
        for (let k = 0; k < 7; k++) {
          ctx.strokeStyle = rgba(r() < 0.6 ? [60, 44, 28] : [230, 205, 170], r.range(0.08, 0.2));
          ctx.lineWidth = r.range(0.7, 1.8);
          const gx = px + r.range(4, cw - 4);
          ctx.beginPath();
          ctx.moveTo(gx, y0 + 2);
          ctx.lineTo(gx + r.range(-2, 2), y0 + rh + 4);
          ctx.stroke();
        }
        // dark under-edge
        ctx.fillStyle = 'rgba(30,20,10,0.38)';
        ctx.fillRect(px + 1, y0 + rh - 1, w, 3);
      };
      tile(x0);
      if (x0 + cw > S) tile(x0 - S);
      if (x0 < 0) tile(x0 + S);
    }
  }
  blobs(ctx, S, r, 14, 30, 90, [hex(0x6a7a48), hex(0xffe9c0), hex(0x3a2a1a)], 0.05, 0.14);
  grain(ctx, S, r, 10);
}

function paintSlate(ctx, S, r) {
  ctx.fillStyle = '#2f3540';
  ctx.fillRect(0, 0, S, S);
  const rows = 12;
  const rh = S / rows;
  const cols = 9;
  const cw = S / cols;
  for (let row = 0; row < rows; row++) {
    const off = (row % 2) * cw * 0.5;
    for (let c = 0; c < cols; c++) {
      const x0 = c * cw + off;
      const y0 = row * rh;
      const l = r.range(46, 64);
      const hue = r.range(208, 224);
      const sat = r.range(10, 22);
      const tile = (px) => {
        const g = ctx.createLinearGradient(0, y0, 0, y0 + rh + 4);
        g.addColorStop(0, `hsl(${hue},${sat}%,${l - 10}%)`);
        g.addColorStop(0.5, `hsl(${hue},${sat}%,${l}%)`);
        g.addColorStop(1, `hsl(${hue},${sat}%,${l + 5}%)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(px + 1, y0);
        ctx.lineTo(px + cw - 1.5, y0);
        ctx.lineTo(px + cw - 1.5 + r.range(-1, 1), y0 + rh + 4);
        ctx.lineTo(px + 1 + r.range(-1, 1), y0 + rh + 4);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        ctx.fillRect(px + 2, y0 + rh * 0.4, cw - 5, 1.5);
        ctx.fillStyle = 'rgba(10,14,22,0.5)';
        ctx.fillRect(px + 1, y0 + rh, cw - 2, 3);
        if (r() < 0.25) {
          ctx.strokeStyle = 'rgba(20,26,36,0.3)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px + r.range(5, cw - 5), y0 + 2);
          ctx.lineTo(px + r.range(5, cw - 5), y0 + rh);
          ctx.stroke();
        }
      };
      tile(x0);
      if (x0 + cw > S) tile(x0 - S);
    }
  }
  blobs(ctx, S, r, 18, 30, 90, [hex(0x8d9aaa), hex(0x4a5666), hex(0x7a8f6a)], 0.05, 0.14);
  grain(ctx, S, r, 9);
}

function paintRoofTiles(ctx, S, r) {
  ctx.fillStyle = '#5a2a1c';
  ctx.fillRect(0, 0, S, S);
  const rows = 9;
  const rh = S / rows;
  const cols = 8;
  const cw = S / cols;
  for (let row = 0; row < rows; row++) {
    const off = (row % 2) * cw * 0.5;
    for (let c = 0; c < cols; c++) {
      const x0 = c * cw + off;
      const y0 = row * rh;
      const hue = r.range(10, 22);
      const l = r.range(48, 62);
      const sat = r.range(48, 62);
      const tile = (px) => {
        const g = ctx.createLinearGradient(0, y0, 0, y0 + rh * 1.4);
        g.addColorStop(0, `hsl(${hue},${sat}%,${l - 16}%)`);
        g.addColorStop(0.55, `hsl(${hue},${sat}%,${l}%)`);
        g.addColorStop(1, `hsl(${hue},${sat}%,${l + 6}%)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(px + 1, y0);
        ctx.lineTo(px + cw - 1, y0);
        ctx.lineTo(px + cw - 1, y0 + rh * 0.95);
        ctx.arc(px + cw / 2, y0 + rh * 0.95, cw / 2 - 1, 0, Math.PI, false);
        ctx.closePath();
        ctx.fill();
        // curved highlight ridge
        ctx.strokeStyle = 'rgba(255,200,150,0.18)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(px + cw * 0.3, y0 + 2);
        ctx.lineTo(px + cw * 0.3, y0 + rh * 0.9);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(50,16,8,0.45)';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.arc(px + cw / 2, y0 + rh * 0.95, cw / 2 - 1, 0.1, Math.PI - 0.1, false);
        ctx.stroke();
      };
      tile(x0);
      if (x0 + cw > S) tile(x0 - S);
    }
  }
  blobs(ctx, S, r, 20, 30, 90, [hex(0x6a7a40), hex(0xf0b080), hex(0x3a1a10)], 0.05, 0.15);
  grain(ctx, S, r, 10);
}

function paintStoneWall(ctx, S, r) {
  ctx.fillStyle = '#8f897b';
  ctx.fillRect(0, 0, S, S);
  const pal = [hex(0xc2bcab), hex(0xb2ac9b), hex(0xcdc6b3), hex(0xa9a392), hex(0xbab29c), hex(0xb7b9a6), hex(0xc7b8a0)];
  // course heights that sum to S
  const heights = [];
  let sum = 0;
  while (sum < S - 40) { const h = r.range(46, 80); heights.push(h); sum += h; }
  const k = S / sum;
  let y = 0;
  for (let ci = 0; ci < heights.length; ci++) {
    const h = heights[ci] * k;
    const widths = [];
    let wsum = 0;
    while (wsum < S - 50) { const w = r.range(56, 128); widths.push(w); wsum += w; }
    const kw = S / wsum;
    let x = r.range(0, 30);
    for (const w0 of widths) {
      const w = w0 * kw;
      const base = jit(r.pick(pal), r, 12);
      const moss = r() < 0.07;
      const col = moss ? mix(base, hex(0x8a9a68), 0.5) : base;
      const draw = (px, py) => {
        const rad = r.range(8, 15);
        roundRect(ctx, px + 2.5, py + 2.5, w - 5, h - 5, rad);
        const g = ctx.createLinearGradient(px, py, px + w * 0.3, py + h);
        g.addColorStop(0, rgba(mix(col, [255, 250, 235], 0.22)));
        g.addColorStop(0.55, rgba(col));
        g.addColorStop(1, rgba(mix(col, [70, 62, 50], 0.3)));
        ctx.fillStyle = g;
        ctx.fill();
        // chips and cracks
        for (let q = 0; q < 6; q++) {
          ctx.fillStyle = rgba(r() < 0.5 ? [90, 82, 70] : [240, 235, 220], r.range(0.08, 0.2));
          ctx.fillRect(px + r.range(8, w - 8), py + r.range(6, h - 6), r.range(2, 6), r.range(2, 5));
        }
        ctx.strokeStyle = 'rgba(40,34,26,0.35)';
        ctx.lineWidth = 1.5;
        roundRect(ctx, px + 2.5, py + 2.5, w - 5, h - 5, rad);
        ctx.stroke();
      };
      wrap(S, x + w / 2, y + h / 2, Math.max(w, h) / 2 + 4, (cx, cy) => draw(cx - w / 2, cy - h / 2));
      x += w;
    }
    y += h;
  }
  blobs(ctx, S, r, 18, 30, 90, [hex(0x6a7a4a), hex(0xffffff), hex(0x4a4234)], 0.04, 0.12);
  grain(ctx, S, r, 12);
}

function paintCobble(ctx, S, r) {
  ctx.fillStyle = '#5a5244';
  ctx.fillRect(0, 0, S, S);
  const n = 9;
  const cs = S / n;
  const pal = [hex(0xb4ad9c), hex(0xa29c8c), hex(0xc0b8a4), hex(0x9a9484), hex(0xb0a58e), hex(0xa8a89a)];
  for (let gy = 0; gy < n; gy++) {
    for (let gx = 0; gx < n; gx++) {
      const cx = (gx + 0.5 + (gy % 2) * 0.35 + r.range(-0.12, 0.12)) * cs;
      const cy = (gy + 0.5 + r.range(-0.1, 0.1)) * cs;
      const rx = cs * r.range(0.4, 0.5);
      const ry = cs * r.range(0.36, 0.46);
      const rot = r.range(0, 3.14);
      const col = jit(r.pick(pal), r, 14);
      wrap(S, cx, cy, cs, (px, py) => {
        const g = ctx.createRadialGradient(px - rx * 0.3, py - ry * 0.3, 2, px, py, rx * 1.1);
        g.addColorStop(0, rgba(mix(col, [255, 250, 235], 0.2)));
        g.addColorStop(1, rgba(mix(col, [60, 52, 42], 0.3)));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(px, py, rx, ry, rot, 0, 6.28);
        ctx.fill();
      });
    }
  }
  blobs(ctx, S, r, 14, 20, 60, [hex(0x6a5a3a), hex(0x7a8a50)], 0.08, 0.2);
  speckle(ctx, S, r, 500, [hex(0x2a2418)], 1, 2.4, 0.2, 0.45);
  grain(ctx, S, r, 12);
}

function paintHay(ctx, S, r) {
  ctx.fillStyle = '#c9a647';
  ctx.fillRect(0, 0, S, S);
  blobs(ctx, S, r, 20, 30, 80, [hex(0xa88326), hex(0xe6c872), hex(0xb89438)], 0.2, 0.36);
  const pal = [hex(0xf0d98a), hex(0xd8b552), hex(0xb08a30), hex(0xe4c566), hex(0x8e6c20), hex(0xf5e6a8)];
  for (let i = 0; i < 2600; i++) {
    const col = rgba(jit(r.pick(pal), r, 12), r.range(0.4, 0.9));
    stroke(ctx, S, r() * S, r() * S, r.range(10, 32), r.range(-0.55, 0.55) + (r() < 0.2 ? 1.2 : 0), r.range(1, 2.4), col);
  }
  grain(ctx, S, r, 10);
}

function paintGrass(ctx, S, r) {
  ctx.fillStyle = '#6f9d48';
  ctx.fillRect(0, 0, S, S);
  blobs(ctx, S, r, 40, 50, 140, [hex(0x5a8a3c), hex(0x86b058), hex(0x7a9a40), hex(0x64904a)], 0.16, 0.3);
  const pal = [hex(0x8cba5c), hex(0x4f7e34), hex(0xa4c868), hex(0x68964a), hex(0x3f6e2c)];
  for (let i = 0; i < 4200; i++) {
    stroke(ctx, S, r() * S, r() * S, r.range(5, 13), -Math.PI / 2 + r.range(-0.7, 0.7), r.range(1, 2),
      rgba(r.pick(pal), r.range(0.4, 0.85)));
  }
  speckle(ctx, S, r, 60, [hex(0xf4e060), hex(0xffffff), hex(0xe86a8a)], 2, 3.5, 0.5, 0.9);
  grain(ctx, S, r, 8);
}

const PAINTERS = {
  plaster: [512, paintPlaster],
  timber: [256, paintTimber],
  planks: [256, paintPlanks],
  thatch: [512, paintThatch],
  shingles: [512, paintShingles],
  slate: [512, paintSlate],
  roofTiles: [512, paintRoofTiles],
  stoneWall: [512, paintStoneWall],
  cobble: [256, paintCobble],
  hay: [256, paintHay],
  grass: [512, paintGrass],
};

// ---------------------------------------------------------------- public

// -> THREE.Texture | null. Cached; RepeatWrapping; sRGB; anisotropy 4.
export function getTexture(name) {
  if (cache.has(name)) return cache.get(name);
  let tex = null;
  const entry = PAINTERS[name];
  if (entry && typeof document !== 'undefined') {
    const [S, paint] = entry;
    const canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) {
      paint(ctx, S, makeRng(hashStr(name)));
      tex = new THREE.CanvasTexture(canvas);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      tex.name = name;
    }
  }
  cache.set(name, tex);
  return tex;
}
