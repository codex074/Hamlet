// Markets and money: the goods a market sells (picked by the player), restocking targets, villagers' coins,
// and buying a meal at a market. Pure: no DOM, no globals.
import {
  BUILDINGS, FOODS, MARKET_SLOTS, MARKET_STOCK_MAX, MARKET_RESTOCK_AT, MARKET_PRICE, MARKET_TREASURY_SHARE,
  SUPPLY_MAX,
} from './config.js';
import { distance, nearestFoodStorage } from './economy.js';
import { recordFood } from './status.js';
import { getBuilding } from './taskutil.js';

// Everything a market can sell: the foods villagers buy and cloth for the houses' clothing need.
export const MARKET_GOODS = [...FOODS, 'cloth'];
export const DEFAULT_MARKET_GOODS = ['berries', 'bread', 'fish', 'cloth'];

export const isMarket = (b) => BUILDINGS[b.type]?.job === 'market';
export const stockMaxOf = (res) => (res === 'cloth' ? SUPPLY_MAX : MARKET_STOCK_MAX);
export const priceOf = (res) => MARKET_PRICE[res] ?? null;

// Fills in the selling list and stock slots (markets from older saves, or built in tests).
export function ensureMarket(b) {
  if (!Array.isArray(b.sell)) b.sell = [...DEFAULT_MARKET_GOODS];
  b.stock ??= {};
  for (const r of b.sell) b.stock[r] ??= 0;
  b.sold ??= 0;
  b.revenue ??= 0;
  return b;
}

// list: up to MARKET_SLOTS distinct goods from MARKET_GOODS. Goods taken off the list are still sold
// until their stock runs out, but are no longer restocked.
export function setMarketGoods(state, bId, list) {
  const b = getBuilding(state, bId);
  if (!b || !isMarket(b)) return { ok: false, reason: 'ไม่ใช่ตลาด' };
  const goods = [...new Set(list)].filter((r) => MARKET_GOODS.includes(r));
  if (goods.length !== list.length) return { ok: false, reason: 'สินค้านี้ขายที่ตลาดไม่ได้' };
  if (goods.length > MARKET_SLOTS) return { ok: false, reason: `เลือกขายได้ไม่เกิน ${MARKET_SLOTS} รายการ` };
  ensureMarket(b);
  b.sell = goods;
  for (const r of goods) b.stock[r] ??= 0;
  return { ok: true };
}

// The selected good merchants should fetch next (emptiest first), or null when all are stocked enough.
export function restockTargets(b) {
  ensureMarket(b);
  return b.sell
    .map((r) => ({ res: r, fill: (b.stock[r] ?? 0) / stockMaxOf(r) }))
    .filter((x) => x.fill < MARKET_RESTOCK_AT)
    .sort((p, q) => p.fill - q.fill)
    .map((x) => x.res);
}

// A market sells only while somebody works there and it is not paused.
export function isOpen(b) {
  return b.built && !b.paused && (b.workers?.length ?? 0) > 0;
}

// The food the villager would buy here: one the household has not eaten today first, and affordable.
export function marketFoodFor(state, v, b) {
  if (!isOpen(b)) return null;
  const coins = v.coins ?? 0;
  const home = getBuilding(state, v.homeId);
  const eaten = home?.foodsToday ?? [];
  const ok = FOODS.filter((f) => (b.stock?.[f] ?? 0) >= 1 && priceOf(f) != null && priceOf(f) <= coins);
  return ok.find((f) => !eaten.includes(f)) ?? ok[0] ?? null;
}

// Nearest place to eat: a storage (free) or a market the villager can afford. { b, market } or null.
export function nearestFoodSource(state, v) {
  const store = nearestFoodStorage(state, v.x, v.z);
  let best = store ? { b: store, market: false } : null;
  let bestD = store ? distance(v.x, v.z, store.x, store.z) : Infinity;
  for (const b of state.buildings) {
    if (!isMarket(b) || !marketFoodFor(state, v, b)) continue;
    const d = distance(v.x, v.z, b.x, b.z);
    if (d < bestD) { best = { b, market: true }; bestD = d; }
  }
  return best;
}

// Buys and eats one meal at market b. Returns the food eaten, or null when nothing suitable was left.
export function buyMeal(state, v, b) {
  const food = marketFoodFor(state, v, b);
  if (!food) return null;
  const price = priceOf(food);
  b.stock[food] -= 1;
  v.coins = (v.coins ?? 0) - price;
  b.sold = (b.sold ?? 0) + 1;
  b.revenue = Math.round(((b.revenue ?? 0) + price) * 10) / 10;
  state.gold = Math.round(((state.gold ?? 0) + price * MARKET_TREASURY_SHARE) * 10) / 10;
  recordFood(state, food, 1, true);
  return food;
}
