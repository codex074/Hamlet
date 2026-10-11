import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../src/rng.js';
import {
  clock, serviceCovered, cathedralDone, evaluateHouse, processMidnight, assignHomes, planHouses,
} from '../src/needs.js';
import { DAY_LENGTH, LEAVE_AFTER_DAYS, EDGE_MARGIN, WORLD_SIZE } from '../src/config.js';
import {
  world, townhall, addBuilt, addHouse, addStaffedService, addVillager, clearVillagers, SPAWN,
} from './helpers.js';

const hour = (h) => (DAY_LENGTH * h) / 24;

function emptyWorld() {
  const s = world();
  clearVillagers(s);
  return s;
}

test('clock math: day, hour, minute and night boundaries', () => {
  const s = world();
  s.time = hour(6);
  assert.deepEqual(clock(s), { day: 1, hour: 6, minute: 0, isNight: false });
  s.time = hour(13.5);
  assert.deepEqual(clock(s), { day: 1, hour: 13, minute: 30, isNight: false });
  s.time = hour(21);
  assert.equal(clock(s).isNight, true);
  s.time = hour(4.99);
  assert.equal(clock(s).isNight, true);
  s.time = hour(5);
  assert.equal(clock(s).isNight, false);
  s.time = DAY_LENGTH * 2 + hour(1);
  assert.deepEqual(clock(s), { day: 3, hour: 1, minute: 0, isNight: true });
});

test('serviceCovered requires a built, staffed building within radius', () => {
  const s = emptyWorld();
  const house = addHouse(s, 100, 100, 1);
  assert.equal(serviceCovered(s, house, 'religion'), false);
  const chapel = addStaffedService(s, 'chapel', 120, 100);
  assert.equal(serviceCovered(s, house, 'religion'), true);
  assert.equal(serviceCovered(s, house, 'entertainment'), false);
  // worker wanders off -> not staffed
  const w = s.villagers.find((v) => v.jobId === chapel.id);
  w.x = 200;
  assert.equal(serviceCovered(s, house, 'religion'), false);
  // asleep at home still counts
  w.role = 'sleeping';
  assert.equal(serviceCovered(s, house, 'religion'), true);
  // too far
  const far = addHouse(s, 100 + 100, 100, 1);
  assert.equal(serviceCovered(s, far, 'religion'), false);
  // unbuilt
  chapel.built = false;
  assert.equal(serviceCovered(s, house, 'religion'), false);
});

test('cathedralDone only when the cathedral is built', () => {
  const s = world();
  assert.equal(cathedralDone(s), false);
  const c = addBuilt(s, 'cathedral', 60, 60);
  c.built = false;
  assert.equal(cathedralDone(s), false);
  c.built = true;
  assert.equal(cathedralDone(s), true);
});

test('evaluateHouse computes needsMet and happiness fractions', () => {
  const s = emptyWorld();
  const h1 = addHouse(s, 100, 100, 2, 1);   // within WATER_RADIUS of the townhall's well
  evaluateHouse(s, h1);
  assert.equal(h1.needsMet.food, true);
  assert.equal(h1.needsMet.water, true);
  assert.equal(h1.happiness, 1);
  h1.starvedToday = true;
  evaluateHouse(s, h1);
  assert.equal(h1.happiness, 0.5);
  h1.parchedToday = true;
  evaluateHouse(s, h1);
  assert.equal(h1.needsMet.water, false);
  assert.equal(h1.happiness, 0);

  const h2 = addHouse(s, 100, 120, 2, 2);
  evaluateHouse(s, h2);
  assert.equal(h2.happiness, 2 / 3);    // food + water ok, religion missing
  addStaffedService(s, 'chapel', 110, 120);
  evaluateHouse(s, h2);
  assert.equal(h2.happiness, 1);

  const h3 = addHouse(s, 60, 170, 2, 3);
  evaluateHouse(s, h3);
  assert.equal(h3.needsMet.water, false, 'no well in reach');
  addBuilt(s, 'well', 66, 170);
  addStaffedService(s, 'chapel', 60, 180);
  evaluateHouse(s, h3);
  assert.equal(h3.happiness, 0.5);      // food + water + religion of food/water/variety2/religion/entertainment/health
  h3.foodsToday = ['bread', 'fish'];
  evaluateHouse(s, h3);
  assert.equal(h3.happiness, 4 / 6);

  const h0 = addHouse(s, 40, 40, 0, 1);
  evaluateHouse(s, h0);
  assert.equal(h0.needsMet.food, false);
});

test('processMidnight pays tax scaled by happiness', () => {
  const s = emptyWorld();
  townhall(s).stock.berries = 0;
  addHouse(s, 100, 100, 3, 1);
  processMidnight(s, mulberry32(1));
  assert.equal(s.gold, 3);
  const h2 = addHouse(s, 100, 120, 2, 2);   // food + water of 3 -> happiness 2/3, tax 2*2*2/3
  h2.starvedToday = false;
  processMidnight(s, mulberry32(1));
  assert.ok(Math.abs(s.gold - (3 + 3 + 8 / 3)) < 0.11, String(s.gold));
});

test('processMidnight starts an upgrade when all next-level needs are met', () => {
  const s = emptyWorld();
  townhall(s).stock.berries = 0;
  const h = addHouse(s, 100, 100, 2, 1);
  processMidnight(s, mulberry32(1));
  assert.equal(h.upgrading, false);       // no chapel yet
  addStaffedService(s, 'chapel', 110, 100);
  h.starvedToday = false;
  processMidnight(s, mulberry32(1));
  assert.equal(h.upgrading, true);
  assert.deepEqual(h.needed, { planks: 6 });
  assert.deepEqual(h.incoming, {});
  assert.equal(h.progress, 0);
  assert.ok(s.events.some((e) => e.text.includes('ไพร่')));
  assert.equal(h.starvedToday, false);
  assert.deepEqual(h.foodsToday, []);
});

test('processMidnight: happy village attracts immigrants at the map edge', () => {
  const s = emptyWorld();
  addHouse(s, 100, 100, 3, 1);
  townhall(s).stock.berries = 600;   // plenty of food: growth is not capped by it
  const pop = s.villagers.length;
  processMidnight(s, mulberry32(7));
  assert.equal(s.villagers.length, pop + 6);   // 2 + floor(1 * 4)
  const newcomers = s.villagers.slice(pop);
  for (const v of newcomers) {
    const onEdge = [v.x, v.z].some((c) => Math.abs(c - EDGE_MARGIN) < 1e-9 || Math.abs(c - (WORLD_SIZE - EDGE_MARGIN)) < 1e-9);
    assert.ok(onEdge, `${v.x},${v.z}`);
    assert.equal(v.homeId, null);
  }
  assert.ok(s.events.some((e) => e.text.includes('ย้ายเข้ามา')));
});

test('immigration stops with too many homeless; none when unhappy or no food', () => {
  const s = emptyWorld();
  townhall(s).stock.berries = 0;
  processMidnight(s, mulberry32(1));
  assert.equal(s.villagers.length, 0);          // no houses and no food
  townhall(s).stock.berries = 10;
  for (let i = 0; i < 7; i++) addVillager(s, SPAWN.x, SPAWN.z);
  processMidnight(s, mulberry32(1));
  assert.equal(s.villagers.length, 7);          // 7 homeless > 6
  clearVillagers(s);
  townhall(s).stock.berries = 600;
  processMidnight(s, mulberry32(1));
  assert.equal(s.villagers.length, 4);          // no houses, food -> 0.6 -> 2 + 2
});

test('unhappy house loses a resident after LEAVE_AFTER_DAYS days', () => {
  const s = emptyWorld();
  townhall(s).stock.berries = 0;
  const h = addHouse(s, 100, 100, 2, 1);
  const leaver = s.villagers[1].id;
  for (let day = 1; day < LEAVE_AFTER_DAYS; day++) {
    h.starvedToday = true;
    h.parchedToday = true;
    processMidnight(s, mulberry32(day));
    assert.equal(s.villagers.length, 2);
    assert.equal(h.unhappyDays, day);
  }
  h.starvedToday = true;
  h.parchedToday = true;
  processMidnight(s, mulberry32(9));
  assert.equal(s.villagers.length, 1);
  assert.equal(h.residents.length, 1);
  assert.ok(!s.villagers.some((v) => v.id === leaver));
  assert.equal(h.unhappyDays, 0);
  assert.ok(s.events.some((e) => e.text.includes('ย้ายออก')));
});

test('assignHomes fills houses nearest to the townhall first, respecting capacity', () => {
  const s = emptyWorld();
  const near = addHouse(s, SPAWN.x + 15, SPAWN.z, 0, 1);
  const far = addHouse(s, SPAWN.x + 60, SPAWN.z, 0, 1);
  for (let i = 0; i < 5; i++) addVillager(s, SPAWN.x, SPAWN.z);
  assignHomes(s);
  assert.equal(near.residents.length, 3);
  assert.equal(far.residents.length, 2);
  assert.equal(s.villagers.filter((v) => v.homeId == null).length, 0);
  // a removed house makes its residents homeless again
  s.buildings.splice(s.buildings.indexOf(far), 1);
  assignHomes(s);
  assert.equal(s.villagers.filter((v) => v.homeId == null).length, 2);
});

test('planHouses creates one house site in a residential zone, removing trees underneath', () => {
  const s = world();
  s.zones.push({ id: s.nextId++, kind: 'residential', x: SPAWN.x + 20, z: SPAWN.z, r: 10 });
  const zone = s.zones[0];
  // put a tree in the zone so something is probably cleared
  const hall = townhall(s);
  const wood0 = hall.stock.wood;
  s.nodes.push({ id: 99999, kind: 'tree', x: zone.x, z: zone.z, amount: 4, reserved: null });
  const rand = mulberry32(3);
  for (let i = 0; i < 5; i++) planHouses(s, rand);
  const sites = s.buildings.filter((b) => b.type === 'house');
  assert.equal(sites.length, 2);           // never more than 2 unbuilt at once
  const h = sites[0];
  assert.equal(h.built, false);
  assert.equal(h.zoneId, zone.id);
  assert.deepEqual(h.needed, { wood: 6 });
  assert.equal(h.level, 1);
  for (const site of sites) {
    assert.ok(!s.nodes.some((n) => Math.hypot(n.x - site.x, n.z - site.z) < 3));
  }
  assert.ok(hall.stock.wood >= wood0);
});

test('planHouses does not build when capacity suffices', () => {
  const s = emptyWorld();
  s.zones.push({ id: s.nextId++, kind: 'residential', x: SPAWN.x + 20, z: SPAWN.z, r: 10 });
  addVillager(s, 1, 1);
  planHouses(s, mulberry32(1));
  assert.equal(s.buildings.filter((b) => b.type === 'house').length, 1);
  planHouses(s, mulberry32(1));      // 1 unbuilt site = capacity 3 >= 1 homeless
  assert.equal(s.buildings.filter((b) => b.type === 'house').length, 1);
});

test('planHouses warns once per day when homeless but no residential zone', () => {
  const s = world();
  const rand = mulberry32(1);
  const count = () => s.events.filter((e) => e.text.includes('ระบายโซนที่อยู่อาศัย')).length;
  planHouses(s, rand);
  planHouses(s, rand);
  assert.equal(count(), 1);
  s.time += DAY_LENGTH;
  planHouses(s, rand);
  assert.equal(count(), 2);
});

// ---------------------------------------------------------------- thirst & wells

test('thirsty villagers walk to the nearest water source and drink', async () => {
  const { stepVillager } = await import('../src/villagers.js');
  const { nearestWater } = await import('../src/water.js');
  const s = emptyWorld();
  const v = addVillager(s, SPAWN.x + 40, SPAWN.z + 40);
  const well = addBuilt(s, 'well', SPAWN.x + 48, SPAWN.z + 40);
  assert.equal(nearestWater(s, v.x, v.z).b, well, 'the well is nearer than the townhall');
  v.thirst = 0.7;
  const rand = mulberry32(3);
  for (let i = 0; i < 100 && v.thirst > 0.1; i++) stepVillager(s, v, 0.1, rand);
  assert.ok(v.thirst < 0.1, `drank, thirst ${v.thirst}`);
  assert.ok(Math.hypot(v.x - well.x, v.z - well.z) < 4);
});

test('walking makes villagers thirstier and hungrier than standing still', async () => {
  const { stepVillager } = await import('../src/villagers.js');
  const s = emptyWorld();
  const still = addVillager(s, SPAWN.x + 20, SPAWN.z);
  const walker = addVillager(s, SPAWN.x + 20, SPAWN.z + 5);
  const loaded = addVillager(s, SPAWN.x + 20, SPAWN.z + 10);
  still.queue = [{ kind: 'wait', t: 99 }];
  walker.queue = [{ kind: 'goto', x: SPAWN.x + 60, z: SPAWN.z + 5 }];
  loaded.queue = [{ kind: 'goto', x: SPAWN.x + 60, z: SPAWN.z + 10 }];
  loaded.carry = { res: 'stone', n: 5 };
  for (const v of [still, walker, loaded]) { v.hunger = 0; v.thirst = 0; v.role = 'worker'; }
  const rand = mulberry32(1);
  for (let i = 0; i < 50; i++) for (const v of [still, walker, loaded]) stepVillager(s, v, 0.1, rand);
  assert.ok(walker.thirst > still.thirst && walker.hunger > still.hunger);
  assert.ok(loaded.thirst > walker.thirst, 'a load makes walking harder');
});

test('a parched resident fails the house water need until midnight', async () => {
  const { stepVillager } = await import('../src/villagers.js');
  const s = emptyWorld();
  const h = addHouse(s, 100, 100, 1, 1);
  const v = s.villagers.at(-1);
  v.thirst = 0.95;
  v.queue = [{ kind: 'wait', t: 99 }];
  stepVillager(s, v, 0.1, mulberry32(1));
  assert.equal(h.parchedToday, true);
  evaluateHouse(s, h);
  assert.equal(h.needsMet.water, false);
  processMidnight(s, mulberry32(1));
  assert.equal(h.parchedToday, false);
});

test('immigration follows food: none when production falls short and the reserve is low, fewer when tight', () => {
  const s = emptyWorld();
  addHouse(s, 100, 100, 3, 1);
  townhall(s).stock.berries = 5;            // less than a day of food, nothing produced
  processMidnight(s, mulberry32(7));
  assert.equal(s.villagers.length, 3);
  assert.ok(s.events.some((e) => /ไม่มีใครย้ายเข้ามา — ผลิตอาหารได้/.test(e.text)));
  townhall(s).stock.berries = 40;           // a reserve but no production: just one newcomer
  processMidnight(s, mulberry32(8));
  assert.equal(s.villagers.length, 4);
});
