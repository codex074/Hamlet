import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world as createWorld } from './helpers.js';
import {
  tick, canPlace, placeBuilding, paintZone, canPaintZone, removeAt, setDesiredWorkers,
  buildingAt, isUnlocked, summary, clock,
} from '../src/sim.js';
import { serialize, deserialize } from '../src/save.js';
import { totalStock } from '../src/economy.js';
import {
  DAY_LENGTH, START, SPAWN, NODE_AMOUNT, BUILDINGS, CATHEDRAL_STAGES, REFUND_RATIO,
} from '../src/config.js';
import {
  world, townhall, addBuilt, addVillager, nearestNode, findPlaceSpot, findZoneSpot,
} from './helpers.js';

test('createWorld basics', () => {
  const s = createWorld(1);
  assert.equal(s.version, 4);
  const hall = townhall(s);
  assert.deepEqual([hall.x, hall.z, hall.built], [SPAWN.x, SPAWN.z, true]);
  assert.equal(s.villagers.length, START.villagers);
  for (const v of s.villagers) {
    assert.ok(Math.hypot(v.x - SPAWN.x, v.z - SPAWN.z) <= 6);
    assert.equal(v.role, 'idle');
  }
  for (const [res, n] of Object.entries(START.stock)) assert.equal(hall.stock[res], n);
  assert.equal(hall.stock.planks, 0);
  assert.equal(s.gold, START.gold);
  assert.equal(s.time, (DAY_LENGTH * 6) / 24);
  assert.equal(s.lastDay, 1);
  assert.ok(s.wear instanceof Float32Array);
  assert.ok(s.nodes.length > 0);
  assert.equal(s.events.length, 1);
  const ids = [...s.buildings, ...s.villagers].map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => id < s.nextId));
});

test('createWorld is deterministic per seed', () => {
  const a = createWorld(5);
  const b = createWorld(5);
  tick(a, 30);
  tick(b, 30);
  assert.deepEqual(a.villagers, b.villagers);
});

test('canPlace rejects locked types, townhall/house and a second cathedral', () => {
  const s = world();
  const spot = findPlaceSpot(s, 'woodcutter', SPAWN.x + 15, SPAWN.z);
  assert.equal(canPlace(s, 'tavern', spot.x, spot.z, 0).ok, false);
  assert.match(canPlace(s, 'tavern', spot.x, spot.z, 0).reason, /ปลดล็อก/);
  assert.equal(isUnlocked(s, 'tavern'), false);
  assert.equal(isUnlocked(s, 'woodcutter'), true);
  assert.equal(isUnlocked(s, 'townhall'), false);
  assert.equal(isUnlocked(s, 'house'), false);
  assert.equal(canPlace(s, 'house', spot.x, spot.z, 0).ok, false);
  assert.equal(canPlace(s, 'townhall', spot.x, spot.z, 0).ok, false);
  assert.equal(canPlace(s, 'woodcutter', spot.x, spot.z, 0).ok, true);
  for (let i = 0; i < 20; i++) addVillager(s, SPAWN.x, SPAWN.z);
  assert.equal(isUnlocked(s, 'cathedral'), true);
  const cspot = findPlaceSpot(s, 'cathedral', SPAWN.x + 30, SPAWN.z);
  assert.ok(placeBuilding(s, 'cathedral', cspot.x, cspot.z, 0) > 0);
  const second = findPlaceSpot(s, 'woodcutter', SPAWN.x - 30, SPAWN.z - 30);
  assert.equal(canPlace(s, 'cathedral', second.x, second.z, 0).ok, false);
  assert.match(canPlace(s, 'cathedral', second.x, second.z, 0).reason, /มหาวิหาร/);
});

test('canPlace respects placement rules (overlap with townhall)', () => {
  const s = world();
  assert.equal(canPlace(s, 'woodcutter', SPAWN.x + 2, SPAWN.z, 0).ok, false);
});

test('placeBuilding creates a site and removes overlapping trees into the storage', () => {
  const s = world();
  const spot = findPlaceSpot(s, 'woodcutter', SPAWN.x + 30, SPAWN.z + 10, 60);
  s.nodes.push({ id: 90001, kind: 'tree', x: spot.x + 1, z: spot.z, amount: 4, reserved: null });
  s.nodes.push({ id: 90002, kind: 'tree', x: spot.x - 1, z: spot.z, amount: 3, reserved: null });
  const n0 = s.nodes.length;
  const wood0 = townhall(s).stock.wood;
  const id = placeBuilding(s, 'woodcutter', spot.x, spot.z, 1.2);
  assert.ok(id);
  const b = s.buildings.find((x) => x.id === id);
  assert.equal(b.built, false);
  assert.equal(b.progress, 0);
  assert.deepEqual(b.needed, BUILDINGS.woodcutter.cost);
  assert.notEqual(b.needed, BUILDINGS.woodcutter.cost);
  assert.deepEqual(b.incoming, {});
  assert.equal(b.desiredWorkers, 2);
  assert.deepEqual(b.workers, []);
  assert.equal(b.rot, 1.2);
  assert.ok(s.nodes.length <= n0 - 2);
  assert.ok(townhall(s).stock.wood >= wood0 + 7);
  assert.ok(s.events.at(-1).text.includes('เริ่มก่อสร้าง'));
  assert.equal(placeBuilding(s, 'woodcutter', spot.x, spot.z, 0), null);
});

test('placing a cathedral starts stage 0 and gold-gated stages block until paid', () => {
  const s = world();
  for (let i = 0; i < 20; i++) addVillager(s, SPAWN.x, SPAWN.z);
  const spot = findPlaceSpot(s, 'cathedral', SPAWN.x + 30, SPAWN.z);
  const id = placeBuilding(s, 'cathedral', spot.x, spot.z, 0);
  const c = s.buildings.find((b) => b.id === id);
  assert.equal(c.stage, 0);
  assert.deepEqual(c.needed, CATHEDRAL_STAGES[0].cost);
  // fast-forward: finish stages 0..1
  c.needed = {};
  c.progress = 1;
  tick(s, 0.1);
  assert.equal(c.stage, 1);
  assert.deepEqual(c.needed, CATHEDRAL_STAGES[1].cost);
  assert.equal(c.progress, 0);
  c.needed = {};
  c.progress = 1;
  tick(s, 0.1);
  assert.equal(c.stage, 2);
  assert.equal(c.goldBlocked, 150);
  s.gold = 200;
  tick(s, 0.1);
  assert.equal(c.goldBlocked, 0);
  assert.equal(s.gold, 50);
  c.needed = {};
  c.progress = 1;
  tick(s, 0.1);
  assert.equal(c.stage, 3);
  assert.equal(c.goldBlocked, 300);
  assert.equal(c.built, false);
  s.gold = 300;
  tick(s, 0.1);
  c.needed = {};
  c.progress = 1;
  tick(s, 0.1);
  assert.equal(c.stage, 4);
  assert.equal(c.built, true);
  assert.ok(s.events.at(-1).text.includes('มหาวิหาร'));
});

test('removeAt refunds delivered materials, moves storage stock, releases workers', () => {
  const s = world();
  const hall = townhall(s);
  const store = addBuilt(s, 'storehouse', SPAWN.x + 20, SPAWN.z);
  store.stock.stone = 7;
  store.stock.wood = 3;
  const wood0 = hall.stock.wood;
  const stone0 = hall.stock.stone;
  const v = s.villagers[0];
  const wc = addBuilt(s, 'woodcutter', SPAWN.x - 20, SPAWN.z);
  v.jobId = wc.id;
  wc.workers.push(v.id);
  assert.equal(removeAt(s, hall.x, hall.z), false);          // townhall is permanent
  assert.equal(removeAt(s, store.x + 1, store.z), true);
  assert.ok(!s.buildings.includes(store));
  const refund = Math.floor(15 * REFUND_RATIO);
  assert.equal(hall.stock.wood, wood0 + 3 + refund);
  assert.equal(hall.stock.stone, stone0 + 7);
  assert.equal(removeAt(s, wc.x, wc.z), true);
  assert.equal(v.jobId, null);
  assert.equal(hall.stock.wood, wood0 + 3 + refund + Math.floor(8 * REFUND_RATIO));
  assert.equal(removeAt(s, 10, 10), false);
});

test('removeAt on an unfinished site refunds only what was delivered', () => {
  const s = world();
  const spot = findPlaceSpot(s, 'storehouse', SPAWN.x + 20, SPAWN.z);
  const id = placeBuilding(s, 'storehouse', spot.x, spot.z, 0);
  const site = s.buildings.find((b) => b.id === id);
  site.needed.wood = 7;       // 8 of 15 delivered
  const wood0 = townhall(s).stock.wood;
  assert.equal(removeAt(s, spot.x, spot.z), true);
  assert.equal(townhall(s).stock.wood, wood0 + 4);
});

test('removeAt makes house residents homeless and removes zones', () => {
  const s = world();
  const house = addBuilt(s, 'house', SPAWN.x + 15, SPAWN.z);
  s.villagers[0].homeId = house.id;
  house.residents.push(s.villagers[0].id);
  assert.equal(removeAt(s, house.x, house.z), true);
  assert.equal(s.villagers[0].homeId, null);
  const zspot = findZoneSpot(s, 'residential', 8, SPAWN.x + 30, SPAWN.z);
  const zid = paintZone(s, 'residential', zspot.x, zspot.z, 8);
  assert.ok(zid);
  assert.equal(removeAt(s, zspot.x, zspot.z), true);
  assert.equal(s.zones.length, 0);
});

test('paintZone validates kind and brush size', () => {
  const s = world();
  const z = findZoneSpot(s, 'field', 8, SPAWN.x + 30, SPAWN.z);
  assert.equal(canPaintZone(s, 'swamp', z.x, z.z, 8).ok, false);
  assert.equal(canPaintZone(s, 'field', z.x, z.z, 30).ok, false);
  assert.equal(paintZone(s, 'field', z.x, z.z, 8) > 0, true);
  assert.equal(s.zones[0].kind, 'field');
});

test('setDesiredWorkers clamps and job assignment follows it', () => {
  const s = world();
  const wc = addBuilt(s, 'woodcutter', SPAWN.x + 30, SPAWN.z);
  setDesiredWorkers(s, wc.id, 9);
  assert.equal(wc.desiredWorkers, 2);
  tick(s, 1.1);
  assert.equal(wc.workers.length, 2);
  setDesiredWorkers(s, wc.id, 1);
  tick(s, 1.1);
  assert.equal(wc.workers.length, 1);
  assert.equal(s.villagers.filter((v) => v.jobId === wc.id).length, 1);
  setDesiredWorkers(s, wc.id, -3);
  assert.equal(wc.desiredWorkers, 0);
  tick(s, 1.1);
  assert.equal(summary(s).unemployed, 8);
});

test('buildingAt finds the building whose footprint contains the point', () => {
  const s = world();
  assert.equal(buildingAt(s, SPAWN.x + 3, SPAWN.z).type, 'townhall');
  assert.equal(buildingAt(s, SPAWN.x + 30, SPAWN.z), null);
});

test('summary fields', () => {
  const s = world();
  const sum = summary(s);
  assert.deepEqual(Object.keys(sum).sort(),
    ['adults', 'births', 'children', 'day', 'deaths', 'difficulty', 'elders', 'gold', 'happiness', 'homeless', 'hour',
      'housing', 'isNight', 'ownedPlots', 'pop', 'pregnant', 'sick', 'stock', 'totalPlots', 'unemployed']);
  assert.deepEqual([sum.adults, sum.children, sum.elders, sum.pregnant, sum.births, sum.deaths], [8, 0, 0, 0, 0, 0]);
  assert.equal(sum.pop, 8);
  assert.equal(sum.homeless, 8);
  assert.equal(sum.housing, 0);
  assert.equal(sum.happiness, 1);
  assert.equal(sum.unemployed, 8);
  assert.equal(sum.sick, 0);
  assert.equal(sum.day, 1);
  assert.equal(sum.hour, 6);
  assert.equal(sum.isNight, false);
  assert.deepEqual(sum.stock, totalStock(s));
  assert.equal(clock(s).day, 1);
});

test('tick splits large dt, advances time and counts ticks', () => {
  const s = world();
  tick(s, 1);
  assert.equal(s.tick, 10);
  assert.ok(Math.abs(s.time - 61) < 1e-6);
  tick(s, 0.04);
  assert.equal(s.tick, 11);
});

test('berries regrow over time', () => {
  const s = world();
  const b = nearestNode(s, 'berry', SPAWN.x, SPAWN.z);
  b.amount = 2;
  tick(s, 40);
  assert.ok(b.amount > 3.9 && b.amount <= NODE_AMOUNT.berry);
});

test('midnight is processed once per day and events stay capped at 20', () => {
  const s = world();
  for (let i = 0; i < 30; i++) s.events.push({ t: 0, text: 'x' });
  tick(s, DAY_LENGTH - 60 + 1);
  assert.equal(s.lastDay, 2);
  assert.ok(s.events.length <= 20);
  tick(s, 10);
  assert.equal(s.lastDay, 2);
});

// ---------------------------------------------------------------- integration

test('INTEGRATION: three game days of a small village', () => {
  const t0 = Date.now();
  const s = createWorld(1);
  const zspot = findZoneSpot(s, 'residential', 10, SPAWN.x + 20, SPAWN.z);
  assert.ok(zspot, 'residential spot');
  assert.ok(paintZone(s, 'residential', zspot.x, zspot.z, 10));

  const tree = nearestNode(s, 'tree', SPAWN.x, SPAWN.z);
  const wcSpot = findPlaceSpot(s, 'woodcutter', tree.x, tree.z);
  const wcId = placeBuilding(s, 'woodcutter', wcSpot.x, wcSpot.z, 0);
  assert.ok(wcId, 'woodcutter placed');
  const berry = nearestNode(s, 'berry', SPAWN.x, SPAWN.z);
  const fgSpot = findPlaceSpot(s, 'forager', berry.x, berry.z);
  assert.ok(placeBuilding(s, 'forager', fgSpot.x, fgSpot.z, 0), 'forager placed');
  const stSpot = findPlaceSpot(s, 'storehouse', SPAWN.x - 18, SPAWN.z);
  assert.ok(placeBuilding(s, 'storehouse', stSpot.x, stSpot.z, 0), 'storehouse placed');

  const treeTotal = () => s.nodes.filter((n) => n.kind === 'tree').reduce((a, n) => a + n.amount, 0);
  const trees0 = treeTotal();
  const emptyRuns = new Map();
  let worstEmpty = 0;
  const steps = Math.round((DAY_LENGTH * 3) / 0.1);
  for (let i = 0; i < steps; i++) {
    tick(s, 0.1);
    for (const v of s.villagers) {
      emptyRuns.set(v.id, v.queue.length === 0 ? (emptyRuns.get(v.id) ?? 0) + 1 : 0);
      worstEmpty = Math.max(worstEmpty, emptyRuns.get(v.id));
    }
  }

  const wc = s.buildings.find((b) => b.id === wcId);
  assert.equal(wc.built, true);
  assert.ok(wc.workers.length > 0, 'woodcutter staffed');
  assert.ok(treeTotal() < trees0, 'trees were chopped');
  const houses = s.buildings.filter((b) => b.type === 'house' && b.built);
  assert.ok(houses.length >= 2, `houses built: ${houses.length}`);
  assert.ok(Math.max(...s.wear) > 0.5, `max wear ${Math.max(...s.wear)}`);
  assert.ok(worstEmpty <= 2, `a villager idled with an empty queue for ${worstEmpty} steps`);
  for (const v of s.villagers) assert.ok(['worker', 'builder', 'idle', 'sleeping'].includes(v.role), String(v.role));
  assert.ok(s.villagers.length >= 8);
  assert.equal(clock(s).day, 4);
  assert.ok(s.events.length <= 20);

  const copy = deserialize(serialize(s));
  assert.equal(copy.buildings.length, s.buildings.length);
  assert.equal(copy.villagers.length, s.villagers.length);
  assert.doesNotThrow(() => tick(copy, 10));
  assert.ok(Date.now() - t0 < 20000, `took ${Date.now() - t0} ms`);
});

test('INTEGRATION: thirty game days (seed 5) with fishery, hunter, sheepfarm, herbalist, infirmary, weaver and market', () => {
  const t0 = Date.now();
  const s = createWorld(5);
  for (let i = 0; i < 14; i++) addVillager(s, SPAWN.x + (i % 5), SPAWN.z + 3);   // pop 22 unlocks everything used
  Object.assign(townhall(s).stock, { wood: 400, stone: 150, planks: 120, berries: 80, wool: 10, herbs: 6 });
  const zspot = findZoneSpot(s, 'residential', 12, SPAWN.x + 22, SPAWN.z);
  assert.ok(paintZone(s, 'residential', zspot.x, zspot.z, 12));
  const placed = {};
  const put = (type, tx, tz) => {
    const spot = findPlaceSpot(s, type, tx, tz, 90);
    assert.ok(spot, `spot for ${type}`);
    placed[type] = placeBuilding(s, type, spot.x, spot.z, 0);
    assert.ok(placed[type], `${type} placed`);
  };
  const tree = nearestNode(s, 'tree', SPAWN.x, SPAWN.z);
  put('storehouse', SPAWN.x - 18, SPAWN.z);
  put('woodcutter', tree.x, tree.z);
  put('forager', SPAWN.x, SPAWN.z + 25);
  put('chapel', SPAWN.x - 25, SPAWN.z + 15);
  put('fishery', SPAWN.x, SPAWN.z - 35);
  put('hunter', tree.x, tree.z);
  put('herbalist', tree.x, tree.z);
  put('sheepfarm', SPAWN.x + 30, SPAWN.z + 35);
  put('infirmary', SPAWN.x - 20, SPAWN.z - 15);
  put('weaver', SPAWN.x + 20, SPAWN.z - 20);
  put('market', SPAWN.x + 5, SPAWN.z + 35);

  const seen = new Set();   // events are capped at 20, so collect marriages and births as they happen
  const steps = Math.round((DAY_LENGTH * 30) / 0.1);
  assert.doesNotThrow(() => {
    for (let i = 0; i < steps; i++) {
      tick(s, 0.1);
      if (i % 100 === 0) for (const e of s.events) if (/^(💍|👶)/u.test(e.text)) seen.add(`${e.t}|${e.text}`);
    }
  });
  assert.equal(clock(s).day, 31);
  const marriages = [...seen].filter((t) => t.includes('💍')).length;
  const births = [...seen].filter((t) => t.includes('👶')).length;
  assert.ok(marriages >= 1, `marriages: ${marriages}`);
  assert.ok(births >= 1, `births: ${births}`);
  assert.ok(summary(s).births >= 1);
  for (const v of s.villagers) {
    assert.ok(Number.isFinite(v.age) && v.age < v.deathAge);
    if (v.spouseId != null) assert.equal(s.villagers.find((w) => w.id === v.spouseId)?.spouseId, v.id);
    for (const p of v.parents) assert.ok(typeof p === 'number');
  }
  for (const [type, id] of Object.entries(placed)) {
    const b = s.buildings.find((x) => x.id === id);
    assert.ok(b && b.built, `${type} built`);
  }
  assert.ok(s.villagers.length >= 8);
  assert.ok(totalStock(s).fish + totalStock(s).meat + totalStock(s).herbs > 0, 'new professions produced something');
  assert.ok(s.events.length <= 20 && s.fx.length <= 20);
  const copy = deserialize(serialize(s));
  assert.doesNotThrow(() => tick(copy, 10));
  assert.ok(Date.now() - t0 < 60000, `took ${Date.now() - t0} ms`);
});
