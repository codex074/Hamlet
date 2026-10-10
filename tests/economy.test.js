import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyStock, distance, isStorage, storages, totalStock,
  nearestStorage, nearestStorageWith, nearestStorageWithAll, nearestFoodStorage,
  addStock, takeStock, canAfford, missingFor,
} from '../src/economy.js';
import { RESOURCES } from '../src/config.js';

function makeState() {
  const stock = (over = {}) => ({ ...emptyStock(), ...over });
  return {
    gold: 5,
    buildings: [
      { id: 1, type: 'townhall', x: 0, z: 0, built: true, stock: stock({ wood: 10, berries: 4 }) },
      { id: 2, type: 'storehouse', x: 10, z: 0, built: true, stock: stock({ wood: 20, stone: 3, bread: 2 }) },
      { id: 3, type: 'storehouse', x: 1, z: 0, built: false, stock: stock({ wood: 100 }) },
      { id: 4, type: 'woodcutter', x: 2, z: 0, built: true, stock: undefined },
    ],
  };
}

test('emptyStock has every resource at zero', () => {
  const s = emptyStock();
  assert.deepEqual(Object.keys(s).sort(), [...RESOURCES].sort());
  assert.ok(Object.values(s).every(v => v === 0));
});

test('distance is Euclidean', () => {
  assert.equal(distance(0, 0, 3, 4), 5);
  assert.equal(distance(1, 1, 1, 1), 0);
});

test('isStorage requires storage type and built', () => {
  const st = makeState().buildings;
  assert.equal(isStorage(st[0]), true);
  assert.equal(isStorage(st[1]), true);
  assert.equal(isStorage(st[2]), false);
  assert.equal(isStorage(st[3]), false);
});

test('storages excludes unbuilt and non-storage buildings', () => {
  const ids = storages(makeState()).map(b => b.id);
  assert.deepEqual(ids, [1, 2]);
});

test('totalStock sums only storages and covers all resources', () => {
  const t = totalStock(makeState());
  assert.deepEqual(Object.keys(t).sort(), [...RESOURCES].sort());
  assert.equal(t.wood, 30);
  assert.equal(t.stone, 3);
  assert.equal(t.berries, 4);
  assert.equal(t.bread, 2);
  assert.equal(t.planks, 0);
});

test('nearestStorage picks the closest storage', () => {
  const state = makeState();
  assert.equal(nearestStorage(state, 8, 0).id, 2);
  assert.equal(nearestStorage(state, 1, 0).id, 1);
});

test('nearestStorage respects filter and returns null when none match', () => {
  const state = makeState();
  assert.equal(nearestStorage(state, 8, 0, b => b.id === 1).id, 1);
  assert.equal(nearestStorage(state, 0, 0, () => false), null);
});

test('nearestStorage returns null with no storages', () => {
  assert.equal(nearestStorage({ gold: 0, buildings: [] }, 0, 0), null);
});

test('nearestStorageWith respects the amount threshold', () => {
  const state = makeState();
  assert.equal(nearestStorageWith(state, 8, 0, 'wood').id, 2);
  assert.equal(nearestStorageWith(state, 8, 0, 'wood', 15).id, 2);
  assert.equal(nearestStorageWith(state, 8, 0, 'berries').id, 1);
  assert.equal(nearestStorageWith(state, 8, 0, 'stone', 4), null);
});

test('nearestStorageWithAll requires every resource amount', () => {
  const state = makeState();
  assert.equal(nearestStorageWithAll(state, 8, 0, { wood: 5, stone: 3 }).id, 2);
  assert.equal(nearestStorageWithAll(state, 8, 0, { wood: 5, berries: 1 }).id, 1);
  assert.equal(nearestStorageWithAll(state, 8, 0, { wood: 5, berries: 5 }), null);
});

test('nearestFoodStorage finds nearest storage with any food', () => {
  const state = makeState();
  assert.equal(nearestFoodStorage(state, 8, 0).id, 2);
  state.buildings[1].stock.bread = 0;
  assert.equal(nearestFoodStorage(state, 8, 0).id, 1);
  state.buildings[0].stock.berries = 0;
  assert.equal(nearestFoodStorage(state, 8, 0), null);
});

test('addStock increases the stock', () => {
  const b = { stock: emptyStock() };
  addStock(b, 'wood', 7);
  addStock(b, 'wood', 3);
  assert.equal(b.stock.wood, 10);
});

test('takeStock removes at most what is available and returns it', () => {
  const b = { stock: { ...emptyStock(), wood: 4 } };
  assert.equal(takeStock(b, 'wood', 3), 3);
  assert.equal(b.stock.wood, 1);
  assert.equal(takeStock(b, 'wood', 10), 1);
  assert.equal(b.stock.wood, 0);
  assert.equal(takeStock(b, 'wood', 5), 0);
  assert.equal(b.stock.wood, 0);
});

test('canAfford checks resource totals and gold', () => {
  const state = makeState();
  assert.equal(canAfford(state, { wood: 30, stone: 3 }), true);
  assert.equal(canAfford(state, { wood: 31 }), false);
  assert.equal(canAfford(state, { gold: 5 }), true);
  assert.equal(canAfford(state, { gold: 6 }), false);
  assert.equal(canAfford(state, {}), true);
});

test('missingFor reports only shortfalls including gold', () => {
  const state = makeState();
  assert.deepEqual(missingFor(state, { wood: 35, stone: 1, gold: 9 }), { wood: 5, gold: 4 });
  assert.deepEqual(missingFor(state, { wood: 10 }), {});
  assert.deepEqual(missingFor(state, { planks: 2 }), { planks: 2 });
});
