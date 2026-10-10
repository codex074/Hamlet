import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, tick, summary } from '../src/sim.js';
import { buildingProblem, updateBuildingStatus, PAUSE_AFTER, recordFood, foodSummary } from '../src/status.js';
import { emptyStock } from '../src/economy.js';
import { BUILDINGS, DAY_LENGTH } from '../src/config.js';

function world() {
  return createWorld(3, { mapSize: 'small' });
}
function addBuilt(state, type, x, z) {
  const b = {
    id: state.nextId++, type, x, z, rot: 0, built: true, progress: 1, needed: {}, incoming: {},
    workers: [], desiredWorkers: BUILDINGS[type].workers,
  };
  if (BUILDINGS[type].storage) b.stock = emptyStock();
  state.buildings.push(b);
  return b;
}

test('farm without a field zone in range is reported, then paused and resumed', () => {
  const s = world();
  const th = s.buildings.find((b) => b.type === 'townhall');
  const farm = addBuilt(s, 'farmhouse', th.x + 15, th.z);
  assert.equal(buildingProblem(s, farm).code, 'no-field');
  updateBuildingStatus(s);
  assert.equal(!!farm.paused, false);
  s.time += PAUSE_AFTER + 1;
  updateBuildingStatus(s);
  assert.equal(farm.paused, true);
  s.zones.push({ id: s.nextId++, kind: 'field', x: farm.x + 10, z: farm.z, r: 8 });
  updateBuildingStatus(s);
  assert.equal(farm.paused, false);
  assert.notEqual(farm.problem?.code, 'no-field');
});

test('processing building without inputs is reported; with inputs it is fine', () => {
  const s = world();
  const th = s.buildings.find((b) => b.type === 'townhall');
  const bakery = addBuilt(s, 'bakery', th.x + 15, th.z);
  assert.match(buildingProblem(s, bakery).text, /แป้ง/);
  th.stock.flour = 5;
  assert.notEqual(buildingProblem(s, bakery)?.code, 'no-input');   // may still warn 'no-workers'
});

test('paused buildings release their workers to other jobs', () => {
  const s = world();
  const th = s.buildings.find((b) => b.type === 'townhall');
  const smith = addBuilt(s, 'blacksmith', th.x + 15, th.z + 5);
  for (let i = 0; i < 20; i++) tick(s, 0.1);
  assert.equal(smith.workers.length, 1);
  s.time += PAUSE_AFTER + 1;
  for (let i = 0; i < 20; i++) tick(s, 0.1);
  assert.equal(smith.paused, true);
  assert.equal(smith.workers.length, 0);
});

test('food summary tracks production and consumption per day', () => {
  const s = world();
  recordFood(s, 'berries', 12);
  recordFood(s, 'berries', 3, true);
  recordFood(s, 'wood', 99);            // not food
  s.time += DAY_LENGTH;                 // a full day observed
  recordFood(s, 'bread', 6);
  const f = foodSummary(s, { berries: 10, bread: 2 });
  assert.equal(f.stock, 12);
  assert.equal(f.inPerDay, 6);           // yesterday's buckets rolled off
  assert.ok('hoursLeft' in f);
  assert.ok(summary(s).food);
});

test('a villager leaving explains who left and which needs were unmet', async () => {
  const { unmetNeeds } = await import('../src/needs.js');
  const s = world();
  const th = s.buildings.find((b) => b.type === 'townhall');
  const house = addBuilt(s, 'house', th.x + 12, th.z);
  house.level = 2; house.residents = []; house.needsMet = { food: true, religion: false };
  const reasons = unmetNeeds(s, house);
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0].key, 'religion');
  assert.match(reasons[0].why, /โบสถ์/);
});
