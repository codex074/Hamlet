import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick, paintZone, canPaintZone, canPlace, isUnlocked, assignJob, summary, BUILDER } from '../src/sim.js';
import { ZONE_BRUSH } from '../src/config.js';
import {
  world, townhall, addBuilt, addSite, addVillager, clearVillagers, nearestNode, SPAWN,
} from './helpers.js';

const R = ZONE_BRUSH.default;

test('woodcutter, quarry and iron mine are retired: not buildable any more', () => {
  const s = world();
  for (const t of ['woodcutter', 'quarry', 'ironmine']) {
    assert.equal(isUnlocked(s, t), false);
    const res = canPlace(s, t, SPAWN.x + 30, SPAWN.z + 10, 0);
    assert.equal(res.ok, false);
    assert.match(res.reason, /เลิกใช้/);
  }
});

test('the harvest brush marks trees under it; the unharvest brush clears them', () => {
  const s = world();
  const tree = nearestNode(s, 'tree', SPAWN.x, SPAWN.z);
  assert.equal(canPaintZone(s, 'harvest', tree.x, tree.z, R).ok, true);
  const n = paintZone(s, 'harvest', tree.x, tree.z, R);
  assert.ok(n >= 1);
  assert.equal(tree.marked, true);
  assert.equal(summary(s).harvest.tree, s.nodes.filter((x) => x.marked && x.kind === 'tree').length);
  // painting the same spot again changes nothing
  assert.equal(canPaintZone(s, 'harvest', tree.x, tree.z, R).ok, false);
  assert.equal(paintZone(s, 'unharvest', tree.x, tree.z, R), n);
  assert.equal(tree.marked, undefined);
  assert.equal(summary(s).harvest.total, 0);
  // bare ground: nothing to mark
  const res = canPaintZone(s, 'harvest', SPAWN.x, SPAWN.z, ZONE_BRUSH.min);
  assert.equal(res.ok, false);
});

test('nodes outside the territory are never marked', () => {
  const s = world(5, { mapSize: 'medium' });
  const outside = s.nodes.find((n) => n.kind === 'tree' && !s.territory.owned[Math.floor(n.z / 80) * s.world.plots + Math.floor(n.x / 80)]);
  assert.ok(outside);
  paintZone(s, 'harvest', outside.x, outside.z, ZONE_BRUSH.min);
  assert.equal(outside.marked, undefined);
});

test('free villagers fell marked trees and carry the wood to storage', () => {
  const s = world();
  clearVillagers(s);
  const tree = nearestNode(s, 'tree', SPAWN.x, SPAWN.z);
  paintZone(s, 'harvest', tree.x, tree.z, ZONE_BRUSH.min);
  const a = addVillager(s, SPAWN.x + 4, SPAWN.z);
  const b = addVillager(s, SPAWN.x - 4, SPAWN.z);
  const wood0 = townhall(s).stock.wood;
  const amount0 = tree.amount;
  tick(s, 60);
  assert.ok(townhall(s).stock.wood > wood0, 'wood delivered');
  assert.ok(!s.nodes.includes(tree) || tree.amount < amount0, 'the marked tree was cut');
  assert.ok(a.coins + b.coins > 0, 'harvesting pays a wage');
});

test('only villagers without a post harvest; idle builders help, elders and workers do not', () => {
  const s = world();
  clearVillagers(s);
  const tree = nearestNode(s, 'tree', SPAWN.x, SPAWN.z);
  paintZone(s, 'harvest', tree.x, tree.z, R);
  const chapel = addBuilt(s, 'chapel', SPAWN.x - 20, SPAWN.z + 10);
  const worker = addVillager(s, SPAWN.x, SPAWN.z);
  assignJob(s, worker.id, chapel.id);
  const elder = addVillager(s, SPAWN.x, SPAWN.z);
  elder.age = 70;
  const builder = addVillager(s, SPAWN.x, SPAWN.z);
  assignJob(s, builder.id, BUILDER);
  tick(s, 3);
  const gathering = (v) => v.queue.some((t) => t.kind === 'gather') || v.res.nodeId != null;
  assert.equal(gathering(worker), false);
  assert.equal(gathering(elder), false);
  assert.equal(gathering(builder), true, 'nothing to build: the builder gathers');
  // with a construction site the builder goes back to building
  addSite(s, 'storehouse', SPAWN.x + 20, SPAWN.z - 10);
  builder.queue = [];
  builder.res = {};
  for (const n of s.nodes) if (n.reserved === builder.id) n.reserved = null;
  tick(s, 0.2);
  assert.equal(builder.role, 'builder');
});

test('marks survive a save round-trip', async () => {
  const { serialize, deserialize } = await import('../src/save.js');
  const s = world();
  const tree = nearestNode(s, 'tree', SPAWN.x, SPAWN.z);
  const n = paintZone(s, 'harvest', tree.x, tree.z, R);
  const back = deserialize(serialize(s));
  assert.equal(back.nodes.filter((x) => x.marked).length, n);
});
