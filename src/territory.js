// Territories: the world is a grid of 80 m plots; only owned plots may be built on or worked.
// Pure: no DOM, no globals.
import { START_PLOTS, PLOT_BASE_PRICE, PLOT_PRICE_GROWTH } from './config.js';
import { pushEvent } from './events.js';

// Fresh territory: the START_PLOTS x START_PLOTS block around the centre (everything on small maps).
export function createTerritory(plots) {
  const owned = new Array(plots * plots).fill(0);
  const lo = Math.max(0, Math.floor((plots - START_PLOTS) / 2));
  const hi = Math.min(plots - 1, lo + START_PLOTS - 1);
  for (let pz = lo; pz <= hi; pz++) for (let px = lo; px <= hi; px++) owned[pz * plots + px] = 1;
  return { owned, bought: 0 };
}

export function allOwnedTerritory(plots) {
  return { owned: new Array(plots * plots).fill(1), bought: 0 };
}

function plotsOf(state) {
  return state.world?.plots ?? 0;
}

function plotSize(state) {
  return state.world?.plot ?? 80;
}

// Ownership of plot (px, pz); false outside the grid.
function plotOwned(state, px, pz) {
  const n = plotsOf(state);
  if (px < 0 || pz < 0 || px >= n || pz >= n) return false;
  return state.territory.owned[pz * n + px] === 1;
}

// Is the point on owned land? States without territory data (bare fixtures) own everything.
export function isOwned(state, x, z) {
  if (!state.territory || !state.world) return true;
  const size = state.world.size;
  if (x < 0 || z < 0 || x > size || z > size) return false;
  const n = state.world.plots;
  const px = Math.min(n - 1, Math.floor(x / state.world.plot));
  const pz = Math.min(n - 1, Math.floor(z / state.world.plot));
  return state.territory.owned[pz * n + px] === 1;
}

// True if the whole circle (x, z, r) lies on owned land.
export function circleOwned(state, x, z, r) {
  if (!state.territory || !state.world) return true;
  const { plot, plots, size } = state.world;
  if (x - r < 0 || z - r < 0 || x + r > size || z + r > size) return false;
  const p0x = Math.max(0, Math.floor((x - r) / plot));
  const p1x = Math.min(plots - 1, Math.floor((x + r) / plot));
  const p0z = Math.max(0, Math.floor((z - r) / plot));
  const p1z = Math.min(plots - 1, Math.floor((z + r) / plot));
  for (let pz = p0z; pz <= p1z; pz++) {
    for (let px = p0x; px <= p1x; px++) {
      if (state.territory.owned[pz * plots + px] === 1) continue;
      // unowned plot: does the circle reach into its rectangle?
      const cx = Math.min(Math.max(x, px * plot), (px + 1) * plot);
      const cz = Math.min(Math.max(z, pz * plot), (pz + 1) * plot);
      if (Math.hypot(x - cx, z - cz) < r) return false;
    }
  }
  return true;
}

export function plotPrice(state) {
  return Math.round(PLOT_BASE_PRICE * PLOT_PRICE_GROWTH ** (state.territory?.bought ?? 0));
}

function buyable(state, px, pz) {
  return !plotOwned(state, px, pz) && px >= 0 && pz >= 0 && px < plotsOf(state) && pz < plotsOf(state)
    && (plotOwned(state, px - 1, pz) || plotOwned(state, px + 1, pz)
      || plotOwned(state, px, pz - 1) || plotOwned(state, px, pz + 1));
}

// One entry per plot, row-major: { px, pz, x0, z0, x1, z1, owned, buyable, price }.
export function plotInfo(state) {
  const n = plotsOf(state);
  const size = plotSize(state);
  const price = plotPrice(state);
  const out = [];
  for (let pz = 0; pz < n; pz++) {
    for (let px = 0; px < n; px++) {
      const owned = plotOwned(state, px, pz);
      out.push({
        px, pz, x0: px * size, z0: pz * size, x1: (px + 1) * size, z1: (pz + 1) * size,
        owned, buyable: !owned && buyable(state, px, pz), price,
      });
    }
  }
  return out;
}

export function buyPlot(state, px, pz) {
  const n = plotsOf(state);
  if (!Number.isInteger(px) || !Number.isInteger(pz) || px < 0 || pz < 0 || px >= n || pz >= n) {
    return { ok: false, reason: 'ไม่พบแปลงที่ดิน' };
  }
  if (plotOwned(state, px, pz)) return { ok: false, reason: 'แปลงนี้เป็นของคุณแล้ว' };
  if (!buyable(state, px, pz)) return { ok: false, reason: 'ซื้อได้เฉพาะแปลงที่ติดกับดินแดนของคุณ' };
  const price = plotPrice(state);
  if (state.gold < price) return { ok: false, reason: `ทองไม่พอ (ต้องใช้ ${price})` };
  state.gold = Math.round((state.gold - price) * 10) / 10;
  state.territory.owned[pz * n + px] = 1;
  state.territory.bought += 1;
  pushEvent(state, '🗺️ ซื้อดินแดนใหม่แล้ว');
  return { ok: true, reason: '' };
}

export function ownedPlotCount(state) {
  return state.territory ? state.territory.owned.reduce((a, b) => a + b, 0) : plotsOf(state) ** 2;
}
