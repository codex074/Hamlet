import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tick, assignJob, paintZone, tutorialView, skipTutorial, resumeTutorial, BUILDER, TUTORIAL_STEPS,
} from '../src/sim.js';
import { serialize, deserialize } from '../src/save.js';
import { world, addBuilt, addHouse, addVillager, nearestNode, findZoneSpot, SPAWN } from './helpers.js';

const done = (s) => tutorialView(s).steps.filter((x) => x.done).map((x) => x.id);

test('a new village starts the checklist at the first step', () => {
  const s = world();
  const view = tutorialView(s);
  assert.equal(view.active, true);
  assert.equal(view.doneCount, 0);
  assert.equal(view.total, TUTORIAL_STEPS.length);
  assert.equal(view.current.id, 'builders');
  assert.ok(view.steps.every((x) => x.title && x.text));
});

test('steps tick off from what the player actually does, in any order, and stay done', () => {
  const s = world();
  const [a, b] = s.villagers;
  const tree = nearestNode(s, 'tree', SPAWN.x, SPAWN.z);
  paintZone(s, 'harvest', tree.x, tree.z, 8);          // a later step first
  tick(s, 1.1);
  assert.deepEqual(done(s), ['harvest']);
  assert.equal(tutorialView(s).current.id, 'builders', 'the current step is the first one not done');
  assignJob(s, a.id, BUILDER);
  assignJob(s, b.id, BUILDER);
  const z = findZoneSpot(s, 'residential', 8, SPAWN.x + 20, SPAWN.z);
  paintZone(s, 'residential', z.x, z.z, 8);
  tick(s, 1.1);
  assert.deepEqual(done(s), ['builders', 'zone', 'harvest']);
  assignJob(s, a.id, null);                            // undoing it later does not un-tick the step
  tick(s, 1.1);
  assert.ok(done(s).includes('builders'));
});

test('the checklist completes once every goal is met', () => {
  const s = world();
  const [a, b] = s.villagers;
  assignJob(s, a.id, BUILDER);
  assignJob(s, b.id, BUILDER);
  const z = findZoneSpot(s, 'residential', 8, SPAWN.x + 20, SPAWN.z);
  paintZone(s, 'residential', z.x, z.z, 8);
  const f = addBuilt(s, 'forager', SPAWN.x - 20, SPAWN.z + 10);
  assignJob(s, s.villagers[2].id, f.id);
  const tree = nearestNode(s, 'tree', SPAWN.x, SPAWN.z);
  paintZone(s, 'harvest', tree.x, tree.z, 8);
  addHouse(s, SPAWN.x + 25, SPAWN.z + 20, 1);
  addBuilt(s, 'well', SPAWN.x - 10, SPAWN.z + 12);
  addVillager(s, SPAWN.x, SPAWN.z);
  tick(s, 1.1);
  const view = tutorialView(s);
  assert.equal(view.doneCount, view.total);
  assert.equal(view.complete, true);
  assert.equal(view.current, null);
});

test('skip hides it; resume shows it again with finished steps already ticked', () => {
  const s = world();
  const [a, b] = s.villagers;
  skipTutorial(s);
  assert.equal(tutorialView(s).active, false);
  assignJob(s, a.id, BUILDER);
  assignJob(s, b.id, BUILDER);
  tick(s, 1.1);
  assert.equal(tutorialView(s).doneCount, 0, 'nothing is tracked while skipped');
  resumeTutorial(s);
  assert.equal(tutorialView(s).active, true);
  assert.ok(done(s).includes('builders'));
});

test('progress survives a save; saves from before the checklist skip it', () => {
  const s = world();
  const [a, b] = s.villagers;
  assignJob(s, a.id, BUILDER);
  assignJob(s, b.id, BUILDER);
  tick(s, 1.1);
  const back = deserialize(serialize(s));
  assert.ok(done(back).includes('builders'));
  delete s.tutorial;
  const old = deserialize(serialize(s));
  assert.equal(tutorialView(old).active, false);
});
