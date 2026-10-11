import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../src/rng.js';
import { stepVillager, failVillager, planNext, releaseReservations } from '../src/villagers.js';
import { tick, removeAt } from '../src/sim.js';
import { totalStock } from '../src/economy.js';
import { NODE_AMOUNT } from '../src/config.js';
import {
  world, townhall, addBuilt, addSite, nearestNode, SPAWN, findPlaceSpot, clearVillagers, addVillager, hire,
  makeBuilders,
} from './helpers.js';

function runSteps(state, v, seconds, rand = mulberry32(5)) {
  for (let i = 0; i < Math.round(seconds / 0.1); i++) stepVillager(state, v, 0.1, rand);
}

test('hungry villager walks to storage and eats', () => {
  const s = world();
  const v = s.villagers[0];
  v.hunger = 0.7;
  v.x = SPAWN.x + 20;
  const before = s.buildings[0].stock.berries;
  runSteps(s, v, 15);
  assert.ok(v.hunger < 0.2, `hunger reset (walking afterwards adds a little), got ${v.hunger}`);
  assert.equal(s.buildings[0].stock.berries, before - 1);
});

test('villager prefers bread over berries and records it in the home foodsToday', () => {
  const s = world();
  const hall = townhall(s);
  hall.stock.bread = 2;
  const home = addBuilt(s, 'house', SPAWN.x + 12, SPAWN.z);
  const v = s.villagers[0];
  v.homeId = home.id;
  v.hunger = 0.8;
  runSteps(s, v, 10);
  assert.equal(hall.stock.bread, 1);
  assert.deepEqual(home.foodsToday, ['bread']);
});

test('hungry villager with no food in stock does not try to eat', () => {
  const s = world();
  townhall(s).stock.berries = 0;
  const v = s.villagers[0];
  v.hunger = 0.9;
  runSteps(s, v, 5);
  assert.ok(v.hunger >= 0.9);
  assert.ok(v.queue.every((t) => t.kind !== 'eat'));
});

test('woodcutter workers gather a tree and deliver wood within 60 s', () => {
  const s = world();
  const tree = nearestNode(s, 'tree', SPAWN.x, SPAWN.z);
  const spot = findPlaceSpot(s, 'forager', tree.x, tree.z, 20);
  const wc = addBuilt(s, 'woodcutter', spot.x, spot.z);
  const wood0 = totalStock(s).wood;
  const treeSum = s.nodes.filter((n) => n.kind === 'tree').reduce((a, n) => a + n.amount, 0);
  hire(s, wc);
  tick(s, 60);
  assert.equal(wc.workers.length, 2);
  assert.ok(totalStock(s).wood > wood0, 'wood delivered to storage');
  const after = s.nodes.filter((n) => n.kind === 'tree').reduce((a, n) => a + n.amount, 0);
  assert.ok(after < treeSum);
  assert.ok(s.nodes.every((n) => n.reserved == null || s.villagers.some((v) => v.id === n.reserved)));
});

test('builder hauls materials to a site and completes it', () => {
  const s = world();
  const site = addSite(s, 'storehouse', SPAWN.x + 14, SPAWN.z);
  const wood0 = totalStock(s).wood;
  tick(s, 30);
  assert.equal(site.progress, 0, 'nobody builds without an assigned builder');
  makeBuilders(s);
  tick(s, 90);
  assert.equal(site.built, true);
  assert.deepEqual(site.needed, { wood: 0 });
  assert.equal(totalStock(s).wood, wood0 - 15);
  assert.ok(site.stock, 'storehouse got a stock');
  assert.deepEqual(site.incoming, { wood: 0 });
});

test('planNext reserves materials for the lowest-id site', () => {
  const s = world();
  const a = addSite(s, 'storehouse', SPAWN.x + 14, SPAWN.z);
  addSite(s, 'woodcutter', SPAWN.x - 14, SPAWN.z);
  const v = s.villagers[0];
  v.builder = true;
  planNext(s, v, mulberry32(1));
  assert.equal(v.role, 'builder');
  assert.equal(v.res.siteId, a.id);
  assert.equal(a.incoming.wood, 5);
  assert.deepEqual(v.queue.map((t) => t.kind), ['goto', 'take', 'goto', 'deliver']);
});

test('removing the target site mid-delivery fails gracefully and returns the load', () => {
  const s = world();
  const hall = townhall(s);
  const site = addSite(s, 'storehouse', SPAWN.x + 25, SPAWN.z);
  clearVillagers(s);
  const v = addVillager(s, SPAWN.x, SPAWN.z);
  v.builder = true;
  const rand = mulberry32(2);
  for (let i = 0; i < 400 && !(v.carry && v.queue[0]?.kind === 'goto' && v.queue[1]?.kind === 'deliver'); i++) {
    stepVillager(s, v, 0.1, rand);
  }
  assert.ok(v.carry, 'picked up wood');
  assert.equal(site.incoming.wood, 5);
  assert.equal(hall.stock.wood, 55);
  assert.equal(removeAt(s, site.x, site.z), true);
  assert.deepEqual(v.res, {});
  assert.doesNotThrow(() => runSteps(s, v, 40, rand));
  assert.equal(v.carry, null);
  assert.equal(hall.stock.wood, 60);
});

test('stepping a task that references a removed building never throws', () => {
  const s = world();
  const v = s.villagers[0];
  const kinds = [
    { kind: 'take', bId: 9999, res: 'wood', n: 1 },
    { kind: 'put', bId: 9999 },
    { kind: 'deliver', bId: 9999 },
    { kind: 'produce', bId: 9999, t: 1, out: { wood: 1 } },
    { kind: 'build', bId: 9999, t: 1 },
    { kind: 'eat', bId: 9999 },
    { kind: 'staff', bId: 9999, t: 1 },
    { kind: 'gather', nodeId: 987654, t: 1, out: { wood: 2 } },
    { kind: 'bogus' },
  ];
  for (const t of kinds) {
    v.queue = [t];
    v.carry = null;
    assert.doesNotThrow(() => stepVillager(s, v, 0.1, mulberry32(1)), t.kind);
  }
});

test('gather target disappearing releases state and does not throw', () => {
  const s = world();
  const tree = nearestNode(s, 'tree', SPAWN.x, SPAWN.z);
  const spot = findPlaceSpot(s, 'forager', tree.x, tree.z, 20);
  const wc = addBuilt(s, 'woodcutter', spot.x, spot.z);
  clearVillagers(s);
  const v = addVillager(s, SPAWN.x, SPAWN.z);
  v.jobId = wc.id;
  wc.workers.push(v.id);
  const rand = mulberry32(3);
  stepVillager(s, v, 0.1, rand);
  assert.equal(v.queue[0].kind, 'goto');
  const node = s.nodes.find((n) => n.id === v.res.nodeId);
  assert.equal(node.reserved, v.id);
  s.nodes.splice(s.nodes.indexOf(node), 1);
  assert.doesNotThrow(() => runSteps(s, v, 30, rand));
  assert.ok(v.queue.length > 0);
});

test('failVillager releases node and site reservations and queues a put when carrying', () => {
  const s = world();
  const site = addSite(s, 'storehouse', SPAWN.x + 14, SPAWN.z);
  const node = s.nodes[0];
  const v = s.villagers[0];
  node.reserved = v.id;
  site.incoming.wood = 5;
  v.res = { nodeId: node.id, siteId: site.id, siteRes: 'wood', siteN: 5 };
  v.carry = { res: 'wood', n: 3 };
  v.queue = [{ kind: 'wait', t: 5 }];
  failVillager(s, v);
  assert.equal(node.reserved, null);
  assert.equal(site.incoming.wood, 0);
  assert.deepEqual(v.res, {});
  assert.deepEqual(v.queue.map((t) => t.kind), ['goto', 'put']);
  releaseReservations(s, v);   // idempotent
});

test('villager goes home and sleeps at night', () => {
  const s = world();
  const home = addBuilt(s, 'house', SPAWN.x + 12, SPAWN.z);
  const v = s.villagers[0];
  v.homeId = home.id;
  s.time = 22 * 10;   // 22:00
  runSteps(s, v, 10);
  assert.equal(v.role, 'sleeping');
  assert.ok(Math.hypot(v.x - home.x, v.z - home.z) < 4 + 0.5);
  assert.equal(v.queue[0].kind, 'sleep');
});

test('mill worker turns wheat into flour via the storage', () => {
  const s = world();
  const hall = townhall(s);
  hall.stock.wheat = 4;
  const mill = addBuilt(s, 'mill', SPAWN.x + 12, SPAWN.z);
  clearVillagers(s);
  const v = addVillager(s, SPAWN.x, SPAWN.z);
  v.jobId = mill.id;
  mill.workers.push(v.id);
  tick(s, 40);
  assert.ok(hall.stock.flour >= 2);
  assert.ok(hall.stock.wheat <= 2);
});

test('farm worker harvests wheat from a field zone', () => {
  const s = world();
  const hall = townhall(s);
  const farm = addBuilt(s, 'farmhouse', SPAWN.x + 14, SPAWN.z + 16);
  s.zones.push({ id: s.nextId++, kind: 'field', x: SPAWN.x + 14, z: SPAWN.z + 30, r: 8 });
  clearVillagers(s);
  const v = addVillager(s, SPAWN.x, SPAWN.z);
  v.jobId = farm.id;
  farm.workers.push(v.id);
  tick(s, 40);
  assert.ok(hall.stock.wheat >= 2, `wheat ${hall.stock.wheat}`);
});

test('service worker stands at the building', () => {
  const s = world();
  const chapel = addBuilt(s, 'chapel', SPAWN.x + 14, SPAWN.z);
  const v = s.villagers[0];
  v.jobId = chapel.id;
  chapel.workers.push(v.id);
  runSteps(s, v, 12);
  assert.ok(Math.hypot(v.x - chapel.x, v.z - chapel.z) <= 6);
});

test('berry nodes are kept when emptied, gather skips empty nodes', () => {
  const s = world();
  const berry = nearestNode(s, 'berry', SPAWN.x, SPAWN.z);
  berry.amount = 0.5;
  const spot = findPlaceSpot(s, 'forager', berry.x, berry.z, 20);
  const fg = addBuilt(s, 'forager', spot.x, spot.z);
  clearVillagers(s);
  const v = addVillager(s, spot.x, spot.z);
  v.jobId = fg.id;
  fg.workers.push(v.id);
  stepVillager(s, v, 0.1, mulberry32(1));
  assert.notEqual(v.res.nodeId, berry.id);
  assert.ok(berry.amount <= NODE_AMOUNT.berry);
});
