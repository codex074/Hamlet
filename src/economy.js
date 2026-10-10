import { RESOURCES, FOODS, BUILDINGS } from './config.js';

export function emptyStock() {
  const stock = {};
  for (const r of RESOURCES) stock[r] = 0;
  return stock;
}

export function distance(x1, z1, x2, z2) {
  return Math.hypot(x2 - x1, z2 - z1);
}

export function isStorage(b) {
  return BUILDINGS[b.type]?.storage === true && b.built === true;
}

export function storages(state) {
  return state.buildings.filter(isStorage);
}

export function totalStock(state) {
  const total = emptyStock();
  for (const b of storages(state)) {
    for (const r of RESOURCES) total[r] += b.stock[r] ?? 0;
  }
  return total;
}

export function nearestStorage(state, x, z, filter = null) {
  let best = null;
  let bestDist = Infinity;
  for (const b of storages(state)) {
    if (filter && !filter(b)) continue;
    const d = distance(x, z, b.x, b.z);
    if (d < bestDist) {
      best = b;
      bestDist = d;
    }
  }
  return best;
}

export function nearestStorageWith(state, x, z, res, n = 1) {
  return nearestStorage(state, x, z, b => (b.stock[res] ?? 0) >= n);
}

export function nearestStorageWithAll(state, x, z, needs) {
  return nearestStorage(state, x, z, b =>
    Object.entries(needs).every(([res, n]) => (b.stock[res] ?? 0) >= n));
}

export function nearestFoodStorage(state, x, z) {
  return nearestStorage(state, x, z, b => FOODS.some(f => (b.stock[f] ?? 0) > 0));
}

export function addStock(b, res, n) {
  b.stock[res] = (b.stock[res] ?? 0) + n;
}

export function takeStock(b, res, n) {
  const available = b.stock[res] ?? 0;
  const taken = Math.max(0, Math.min(n, available));
  b.stock[res] = available - taken;
  return taken;
}

export function missingFor(state, cost) {
  const total = totalStock(state);
  const missing = {};
  for (const [res, amount] of Object.entries(cost)) {
    const have = res === 'gold' ? state.gold : (total[res] ?? 0);
    if (have < amount) missing[res] = amount - have;
  }
  return missing;
}

export function canAfford(state, cost) {
  return Object.keys(missingFor(state, cost)).length === 0;
}
