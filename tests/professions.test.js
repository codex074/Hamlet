import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../src/rng.js';
import { stepVillager, planNext } from '../src/villagers.js';
import {
  tick, upgradeStatus, requestUpgrade, setAutoUpgrade, summary, placeBuilding, canPlace,
} from '../src/sim.js';
import { evaluateHouse, processMidnight } from '../src/needs.js';
import { rollSickness } from '../src/sickness.js';
import { generateTerrain, generateNodes, heightAt } from '../src/terrain.js';
import {
  CLOTH_PER_HOUSE_PER_DAY, SICK_LEAVE_DAYS, SICK_SPEED_MUL, TOOL_SPEED_BONUS, NODE_COUNTS,
  ORE_MIN_HEIGHT, MAX_HEIGHT, DEER_COUNT, SICK_CHANCE_PER_DAY, BUILDINGS,
} from '../src/config.js';
import {
  world, townhall, addBuilt, addHouse, addStaffedService, addVillager, clearVillagers, findPlaceSpot,
  spiral, SPAWN, SMALL,
} from './helpers.js';

function runSteps(state, v, seconds, rand = mulberry32(5)) {
  for (let i = 0; i < Math.round(seconds / 0.1); i++) stepVillager(state, v, 0.1, rand);
}

// Built workplace with exactly one villager employed there (all others removed).
function staffed(state, type, x, z) {
  const b = addBuilt(state, type, x, z);
  clearVillagers(state);
  const w = addVillager(state, x, z);
  w.jobId = b.id;
  b.workers.push(w.id);
  return { b, w };
}

// Enough villagers to unlock every building (placement checks need the population).
function unlockAll(state) {
  for (let i = 0; i < 25; i++) addVillager(state, SPAWN.x, SPAWN.z);
}

function treeTotal(s) {
  return s.nodes.filter((n) => n.kind === 'tree').reduce((a, n) => a + n.amount, 0);
}

// ---------------------------------------------------------------- food variety

test('villager eats a food the household has not had today before repeating', () => {
  const s = world();
  const hall = townhall(s);
  Object.assign(hall.stock, { bread: 5, meat: 5, fish: 5, berries: 5 });
  const home = addBuilt(s, 'house', SPAWN.x + 12, SPAWN.z);
  const v = s.villagers[0];
  v.homeId = home.id;
  const order = [];
  for (let i = 0; i < 5; i++) {
    v.hunger = 0.8;
    v.queue = [];
    runSteps(s, v, 12);
    order.push(home.foodsToday.length);
  }
  assert.deepEqual(home.foodsToday, ['bread', 'meat', 'fish', 'berries']);
  assert.deepEqual(order.slice(0, 4), [1, 2, 3, 4]);
  assert.equal(hall.stock.bread + hall.stock.meat + hall.stock.fish + hall.stock.berries, 15);
});

test('evaluateHouse derives variety2 / variety3 from foodsToday', () => {
  const s = world();
  clearVillagers(s);
  const h = addHouse(s, 100, 100, 2, 3);
  evaluateHouse(s, h);
  assert.deepEqual([h.needsMet.variety2, h.needsMet.variety3], [false, false]);
  h.foodsToday = ['bread', 'fish'];
  evaluateHouse(s, h);
  assert.deepEqual([h.needsMet.variety2, h.needsMet.variety3], [true, false]);
  h.foodsToday = ['bread', 'fish', 'meat'];
  evaluateHouse(s, h);
  assert.deepEqual([h.needsMet.variety2, h.needsMet.variety3], [true, true]);
});

// ---------------------------------------------------------------- upgrades

test('upgradeStatus lists the next-level checklist, cost and missing materials', () => {
  const s = world();
  clearVillagers(s);
  const h = addHouse(s, 100, 100, 2, 1);
  evaluateHouse(s, h);
  let st = upgradeStatus(s, h);
  assert.equal(st.level, 1);
  assert.equal(st.nextLevel, 2);
  assert.deepEqual(st.needs.map((n) => [n.key, n.met]), [['food', true], ['religion', false]]);
  assert.equal(st.canUpgrade, false);
  assert.match(st.reason, /ศาสนา/);
  assert.deepEqual(st.cost, { planks: 6 });
  assert.deepEqual(st.missing, { planks: 6 });
  addStaffedService(s, 'chapel', 110, 100);
  evaluateHouse(s, h);
  st = upgradeStatus(s, h);
  assert.equal(st.canUpgrade, true);
  townhall(s).stock.planks = 6;
  assert.deepEqual(upgradeStatus(s, h).missing, {});
  const top = addHouse(s, 100, 130, 1, 5);
  const topSt = upgradeStatus(s, top);
  assert.equal(topSt.nextLevel, null);
  assert.equal(topSt.canUpgrade, false);
});

test('requestUpgrade starts an upgrade once, refuses otherwise, and completion adds fx', () => {
  const s = world();
  clearVillagers(s);
  const h = addHouse(s, 100, 100, 2, 1);
  assert.equal(requestUpgrade(s, h.id).ok, false);
  assert.equal(requestUpgrade(s, 99999).ok, false);
  addStaffedService(s, 'chapel', 110, 100);
  const r = requestUpgrade(s, h.id);
  assert.deepEqual(r, { ok: true, reason: '' });
  assert.equal(h.upgrading, true);
  assert.deepEqual(h.needed, { planks: 6 });
  assert.equal(h.progress, 0);
  const again = requestUpgrade(s, h.id);
  assert.equal(again.ok, false);
  assert.equal(upgradeStatus(s, h).canUpgrade, false);
  h.needed = {};
  h.progress = 1;
  tick(s, 0.1);
  assert.equal(h.level, 2);
  assert.equal(h.upgrading, false);
  assert.ok(s.events.some((e) => e.text === 'บ้านอัปเกรดเป็นไพร่แล้ว'));
  assert.equal(s.fx.length, 1);
  assert.deepEqual([s.fx[0].x, s.fx[0].z, s.fx[0].kind], [100, 100, 'upgrade']);
});

test('autoUpgrade off stops the midnight upgrade; setAutoUpgrade toggles one or all houses', () => {
  const s = world();
  clearVillagers(s);
  townhall(s).stock.berries = 0;
  const h = addHouse(s, 100, 100, 2, 1);
  const h2 = addHouse(s, 100, 130, 2, 1);
  addStaffedService(s, 'chapel', 110, 115);
  assert.equal(h.autoUpgrade, true);
  setAutoUpgrade(s, null, false);
  assert.equal(h.autoUpgrade || h2.autoUpgrade, false);
  processMidnight(s, mulberry32(1));
  assert.equal(h.upgrading || h2.upgrading, false);
  setAutoUpgrade(s, h.id, true);
  assert.equal(h2.autoUpgrade, false);
  processMidnight(s, mulberry32(1));
  assert.equal(h.upgrading, true);
  assert.equal(h2.upgrading, false);
});

// ---------------------------------------------------------------- fishery

test('fishery needs water nearby; fishers deliver fish to storage', () => {
  const s = world();
  unlockAll(s);
  const far = spiral(SPAWN.x, SPAWN.z, (x, z) => canPlace(s, 'fishery', x, z, 0).reason === 'ต้องวางติดแหล่งน้ำ');
  assert.ok(far, 'a dry spot is rejected for a fishery');
  assert.equal(placeBuilding(s, 'fishery', far.x, far.z, 0), null);
  const spot = spiral(SPAWN.x, SPAWN.z, (x, z) => canPlace(s, 'fishery', x, z, 0).ok, 120);
  assert.ok(spot, 'a shoreline spot exists');
  assert.ok(placeBuilding(s, 'fishery', spot.x, spot.z, 0) > 0);
  const { b } = staffed(s, 'fishery', spot.x + 0.01, spot.z);
  tick(s, 150);
  assert.ok(b.shore.length > 0 && b.shore.length <= 12);
  assert.ok(townhall(s).stock.fish >= 1, `fish ${townhall(s).stock.fish}`);
});

// ---------------------------------------------------------------- ranch / hunter / herbalist / ore

test('sheepfarm alternates meat and wool', () => {
  const s = world();
  unlockAll(s);
  const spot = findPlaceSpot(s, 'sheepfarm', SPAWN.x + 25, SPAWN.z);
  const { b } = staffed(s, 'sheepfarm', spot.x, spot.z);
  tick(s, 140);
  assert.ok(b.cycle >= 2, `cycle ${b.cycle}`);
  assert.ok(townhall(s).stock.meat >= 2, 'meat');
  assert.ok(townhall(s).stock.wool >= 2, 'wool');
});

test('hunter kills a deer and brings meat to storage', () => {
  const s = world();
  const spot = findPlaceSpot(s, 'hunter', SPAWN.x + 25, SPAWN.z);
  const { b } = staffed(s, 'hunter', spot.x, spot.z);
  s.animals = [{ id: 7777, kind: 'deer', x: spot.x + 12, z: spot.z + 3, tx: spot.x + 12, tz: spot.z + 3, wait: 5, reserved: null }];
  s.deerTimer = 9999;
  tick(s, 1.5);
  assert.equal(s.animals[0].reserved, b.workers[0], 'deer reserved');
  tick(s, 60);
  assert.equal(s.animals.length, 0, 'deer removed');
  assert.equal(townhall(s).stock.meat, 3);
});

test('herbalist brings herbs without using up trees', () => {
  const s = world();
  unlockAll(s);
  const tree = s.nodes.find((n) => n.kind === 'tree' && Math.hypot(n.x - SPAWN.x, n.z - SPAWN.z) < 60);
  const spot = findPlaceSpot(s, 'herbalist', tree.x, tree.z, 20);
  staffed(s, 'herbalist', spot.x, spot.z);
  const before = treeTotal(s);
  const count = s.nodes.length;
  tick(s, 150);
  assert.ok(townhall(s).stock.herbs >= 2, `herbs ${townhall(s).stock.herbs}`);
  assert.equal(treeTotal(s), before);
  assert.equal(s.nodes.length, count);
  assert.ok(s.nodes.every((n) => n.reserved == null));
});

test('ore veins sit on high ground, deterministic, spaced apart', () => {
  for (const seed of [1, 2, 5]) {
    const t = generateTerrain(seed, SMALL);
    const ore = generateNodes(seed, t, SMALL).filter((n) => n.kind === 'ore');
    assert.equal(ore.length, NODE_COUNTS.ore, `seed ${seed}`);
    for (const n of ore) {
      assert.ok(heightAt(t, n.x, n.z) >= ORE_MIN_HEIGHT * MAX_HEIGHT - 1e-9, `seed ${seed} height`);
      assert.ok(Math.hypot(n.x - SPAWN.x, n.z - SPAWN.z) > 25);
    }
    for (let i = 0; i < ore.length; i++) {
      for (let j = i + 1; j < ore.length; j++) {
        assert.ok(Math.hypot(ore[i].x - ore[j].x, ore[i].z - ore[j].z) >= 6);
      }
    }
    assert.deepEqual(generateNodes(seed, t, SMALL).filter((n) => n.kind === 'ore'), ore);
  }
});

test('ironmine workers mine ore nodes and deliver ore', () => {
  const s = world();
  unlockAll(s);
  const ore = s.nodes.find((n) => n.kind === 'ore');
  const mine = spiral(ore.x, ore.z, (x, z) => canPlace(s, 'ironmine', x, z, 0).ok
    && canPlace(s, 'storehouse', x + 9, z, 0).ok, 40);
  assert.ok(mine, 'a mine spot near the vein');
  const store = addBuilt(s, 'storehouse', mine.x + 9, mine.z);
  staffed(s, 'ironmine', mine.x, mine.z);
  tick(s, 120);
  assert.ok(store.stock.ore >= 2, `ore ${store.stock.ore}`);
  assert.ok(s.nodes.some((n) => n.kind === 'ore' && n.amount < 80), 'a vein was worked');
});

// ---------------------------------------------------------------- doctor / sickness

test('doctor fetches herbs from storage, then heals a sick villager', () => {
  const s = world();
  townhall(s).stock.herbs = 5;
  const { b, w } = staffed(s, 'infirmary', SPAWN.x + 15, SPAWN.z);
  const patient = addVillager(s, SPAWN.x + 4, SPAWN.z + 4);
  patient.sick = true;
  tick(s, 12);
  assert.ok(b.stock.herbs >= 1, `fetched herbs ${b.stock.herbs}`);
    tick(s, 60);
  assert.equal(patient.sick, false);
  assert.equal(patient.healer, null);
  assert.equal(summary(s).sick, 0);
  assert.ok(townhall(s).stock.herbs + b.stock.herbs < 5 + 0.5, 'a herb was used');
  assert.equal(w.res.patientId, undefined);
});

test('doctor does not treat without herbs and returns the herb if the patient disappears', () => {
  const s = world();
  const { b, w } = staffed(s, 'infirmary', SPAWN.x + 15, SPAWN.z);
  const patient = addVillager(s, SPAWN.x + 4, SPAWN.z + 4);
  patient.sick = true;
  tick(s, 20);
  assert.equal(patient.sick, true);
  assert.equal(patient.healer, null);
  b.stock.herbs = 2;
  tick(s, 9);
  assert.equal(patient.healer, w.id);
  assert.equal(b.stock.herbs, 1);
  s.villagers.splice(s.villagers.indexOf(patient), 1);
  tick(s, 0.5);
  assert.equal(b.stock.herbs, 2);
});

test('rollSickness: base chance, hunger and health-coverage multipliers', () => {
  const s = world();
  clearVillagers(s);
  const h = addHouse(s, 100, 100, 3, 1);
  assert.equal(rollSickness(s, () => 0.99), 0);
  const mid = SICK_CHANCE_PER_DAY + 0.01;
  assert.equal(rollSickness(s, () => mid), 0);
  h.starvedToday = true;
  assert.equal(rollSickness(s, () => mid), 3);
  assert.ok(s.events.some((e) => e.text === 'ชาวบ้านป่วย 3 คน'));
  assert.ok(s.villagers.every((v) => v.sick && v.sickDays === 0));
  for (const v of s.villagers) v.sick = false;
  h.starvedToday = false;
  h.needsMet.health = true;
  assert.equal(rollSickness(s, () => SICK_CHANCE_PER_DAY * 0.5), 0);
  assert.equal(rollSickness(s, () => SICK_CHANCE_PER_DAY * 0.3), 3);
});

test('sick villagers rest at home, walk slowly, and leave after SICK_LEAVE_DAYS midnights', () => {
  const s = world();
  clearVillagers(s);
  townhall(s).stock.berries = 0;
  const h = addHouse(s, SPAWN.x + 20, SPAWN.z, 2, 1);
  const [a, b] = s.villagers;
  a.sick = true;
  b.x = SPAWN.x;
  a.x = SPAWN.x;
  planNext(s, a, mulberry32(1));
  assert.deepEqual(a.queue.map((t) => t.kind), ['goto', 'rest']);
  const x0 = a.x;
  runSteps(s, a, 1);
  const sickStep = a.x - x0;
  assert.ok(Math.abs(sickStep - 3.2 * SICK_SPEED_MUL) < 0.7, `step ${sickStep}`);
  a.sickDays = SICK_LEAVE_DAYS - 2;
  processMidnight(s, mulberry32(1));
  assert.equal(a.sickDays, SICK_LEAVE_DAYS - 1);
  assert.ok(s.villagers.includes(a));
  processMidnight(s, mulberry32(1));
  assert.ok(!s.villagers.includes(a));
  assert.ok(!h.residents.includes(a.id));
  assert.ok(s.events.some((e) => e.text.includes('ป่วยหนักย้ายออกไป')));
});

// ---------------------------------------------------------------- market / clothing

test('market vendors stock cloth; houses consume it at midnight and clothing needs stock', () => {
  const s = world();
  clearVillagers(s);
  const house = addHouse(s, 100, 100, 2, 4);
  const market = addStaffedService(s, 'market', 110, 100);
  evaluateHouse(s, house);
  assert.equal(house.needsMet.clothing, false, 'no cloth yet');
  market.stock.cloth = 3;
  evaluateHouse(s, house);
  assert.equal(house.needsMet.clothing, true);
  processMidnight(s, mulberry32(1));
  assert.equal(market.stock.cloth, 3 - CLOTH_PER_HOUSE_PER_DAY);
  assert.equal(house.needsMet.clothing, true);
  market.stock.cloth = 0;
  evaluateHouse(s, house);
  assert.equal(house.needsMet.clothing, false);
});

test('market vendor carries cloth from storage into the market stock', () => {
  const s = world();
  townhall(s).stock.cloth = 20;
  const { b } = staffed(s, 'market', SPAWN.x + 15, SPAWN.z);
  tick(s, 40);
  assert.equal(b.stock.cloth >= 5, true, `cloth ${b.stock.cloth}`);
  assert.ok(b.stock.cloth <= 10);
  assert.equal(townhall(s).stock.cloth + b.stock.cloth, 20);
});

// ---------------------------------------------------------------- tools

test('tools are used up at midnight and speed up work', () => {
  const s = world();
  const hall = townhall(s);
  hall.stock.tools = 1;
  const a = addBuilt(s, 'woodcutter', SPAWN.x + 20, SPAWN.z);
  const c = addBuilt(s, 'woodcutter', SPAWN.x - 20, SPAWN.z);
  const [v1, v2] = s.villagers;
  v1.jobId = a.id;
  a.workers.push(v1.id);
  v2.jobId = c.id;
  c.workers.push(v2.id);
  processMidnight(s, mulberry32(1));
  assert.equal(hall.stock.tools, 0);
  assert.equal(a.tooled, true);
  assert.equal(c.tooled, false);
  planNext(s, v1, mulberry32(1));
  planNext(s, v2, mulberry32(1));
  const t1 = v1.queue.find((t) => t.kind === 'gather').t;
  const t2 = v2.queue.find((t) => t.kind === 'gather').t;
  assert.ok(Math.abs(t1 - BUILDINGS.woodcutter.time * (1 - TOOL_SPEED_BONUS)) < 1e-9);
  assert.equal(t2, BUILDINGS.woodcutter.time);
  processMidnight(s, mulberry32(1));
  assert.equal(a.tooled, false, 'needs fresh tools each day');
});

// ---------------------------------------------------------------- animals

test('createWorld spawns deer on land away from the spawn point', () => {
  const s = world(2);
  assert.ok(s.animals.length > 0 && s.animals.length <= DEER_COUNT);
  for (const d of s.animals) {
    assert.equal(d.kind, 'deer');
    assert.ok(Math.hypot(d.x - SPAWN.x, d.z - SPAWN.z) > 25);
    assert.equal(d.reserved, null);
  }
  const before = JSON.stringify(s.animals.map((d) => [d.x, d.z]));
  tick(s, 30);
  assert.notEqual(JSON.stringify(s.animals.map((d) => [d.x, d.z])), before, 'deer wander');
});

test('deer respawn when the herd is depleted', () => {
  const s = world(2);
  s.animals = s.animals.slice(0, 3);
  tick(s, 100);
  assert.equal(s.animals.length, 4);
});
