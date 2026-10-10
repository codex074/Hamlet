import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../src/rng.js';
import { stepVillager } from '../src/villagers.js';
import { tick, setMarketGoods, assignJob, summary } from '../src/sim.js';
import { ensureMarket, nearestFoodSource, restockTargets } from '../src/market.js';
import { MARKET_PRICE, MARKET_TREASURY_SHARE, MARKET_STOCK_MAX, WAGE_PER_TASK } from '../src/config.js';
import {
  world, townhall, addBuilt, addVillager, clearVillagers, nearestNode, findPlaceSpot, SPAWN,
} from './helpers.js';

function openMarket(s, x, z) {
  const m = ensureMarket(addBuilt(s, 'market', x, z));
  const w = addVillager(s, x + 7, z);
  assignJob(s, w.id, m.id);
  return { m, w };
}

test('the player picks up to 4 goods; only foods and cloth can be sold', () => {
  const s = world();
  const { m } = openMarket(s, SPAWN.x + 30, SPAWN.z);
  assert.deepEqual(m.sell, ['berries', 'bread', 'fish', 'cloth']);
  assert.equal(setMarketGoods(s, m.id, ['berries', 'fish', 'meat', 'bread', 'cloth']).ok, false);
  assert.equal(setMarketGoods(s, m.id, ['wood']).ok, false);
  assert.equal(setMarketGoods(s, m.id, ['meat', 'berries']).ok, true);
  assert.deepEqual(m.sell, ['meat', 'berries']);
  assert.equal(m.stock.meat, 0);
});

test('merchants restock only the chosen goods from storage, emptiest first', () => {
  const s = world();
  clearVillagers(s);
  Object.assign(townhall(s).stock, { berries: 40, fish: 40, bread: 40 });
  const { m } = openMarket(s, SPAWN.x + 18, SPAWN.z);
  setMarketGoods(s, m.id, ['berries', 'fish']);
  m.stock.fish = 5;
  assert.deepEqual(restockTargets(m), ['berries', 'fish']);
  tick(s, 90);
  assert.ok(m.stock.berries >= MARKET_STOCK_MAX / 2, `berries ${m.stock.berries}`);
  assert.ok(m.stock.berries <= MARKET_STOCK_MAX);
  assert.equal(m.stock.bread ?? 0, 0, 'bread was not chosen');
  assert.equal(townhall(s).stock.berries + m.stock.berries, 40);
});

test('a hungry villager with coins buys a meal at a nearer market; the treasury gets a share', () => {
  const s = world();
  clearVillagers(s);
  const { m } = openMarket(s, SPAWN.x + 40, SPAWN.z);
  m.stock.berries = 5;
  const v = addVillager(s, SPAWN.x + 50, SPAWN.z + 4);
  v.hunger = 0.7;
  v.coins = 3;
  const gold0 = s.gold;
  const src = nearestFoodSource(s, v);
  assert.equal(src.b, m);
  assert.equal(src.market, true);
  const rand = mulberry32(2);
  for (let i = 0; i < 100 && v.hunger > 0.1; i++) stepVillager(s, v, 0.1, rand);
  assert.ok(v.hunger < 0.1, 'ate');
  assert.equal(m.stock.berries, 4);
  assert.equal(v.coins, 3 - MARKET_PRICE.berries);
  assert.equal(s.gold, gold0 + MARKET_PRICE.berries * MARKET_TREASURY_SHARE);
  assert.equal(m.sold, 1);
});

test('without coins (or with the market closed) villagers eat for free at storage', () => {
  const s = world();
  clearVillagers(s);
  const { m, w } = openMarket(s, SPAWN.x + 40, SPAWN.z);
  m.stock.berries = 5;
  const v = addVillager(s, SPAWN.x + 50, SPAWN.z + 4);
  v.hunger = 0.7;
  v.coins = 0;
  assert.equal(nearestFoodSource(s, v).market, false);
  v.coins = 5;
  assignJob(s, w.id, null);   // nobody minds the stalls
  assert.equal(nearestFoodSource(s, v).market, false);
});

test('working earns coins', () => {
  const s = world();
  clearVillagers(s);
  const tree = nearestNode(s, 'tree', SPAWN.x, SPAWN.z);
  const spot = findPlaceSpot(s, 'woodcutter', tree.x, tree.z, 20);
  const wc = addBuilt(s, 'woodcutter', spot.x, spot.z);
  const v = addVillager(s, spot.x, spot.z);
  const idle = addVillager(s, SPAWN.x, SPAWN.z);
  assignJob(s, v.id, wc.id);
  tick(s, 60);
  assert.ok(v.coins >= 2 * WAGE_PER_TASK, `coins ${v.coins}`);
  assert.equal(idle.coins, 0);
  assert.ok(summary(s).pop >= 2);
});
