import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick, assignJob } from '../src/sim.js';
import { feedFor } from '../src/jobs.js';
import { buildingProblem } from '../src/status.js';
import { BUILDINGS, FOODS } from '../src/config.js';
import { world, townhall, addBuilt, addVillager, clearVillagers, SPAWN } from './helpers.js';

const pens = ['coop', 'pigsty', 'cattle'];

function setup(type, stock) {
  const s = world();
  clearVillagers(s);
  const hall = townhall(s);
  for (const f of FOODS) hall.stock[f] = 0;
  hall.stock.bread = 300;   // villagers eat bread, not the feed
  Object.assign(hall.stock, stock);
  const b = addBuilt(s, type, SPAWN.x + 24, SPAWN.z + 8);
  for (let i = 0; i < BUILDINGS[type].workers; i++) assignJob(s, addVillager(s, b.x, b.z).id, b.id);
  return { s, b, hall };
}

test('each pen eats crops and gives meat', () => {
  for (const type of pens) {
    const cfg = BUILDINGS[type];
    assert.equal(cfg.job, 'livestock');
    assert.ok(cfg.feed.length > 0 && cfg.feedPer > 0 && cfg.output.meat > 0);
    const feed = cfg.feed[0];
    const { s, hall } = setup(type, { [feed]: 40 });
    tick(s, 90);
    assert.ok(hall.stock.meat > 0, `${type}: meat ${hall.stock.meat}`);
    const eaten = 40 - hall.stock[feed];
    const rounds = hall.stock.meat / cfg.output.meat;
    assert.ok(eaten >= cfg.feedPer && Math.abs(eaten - rounds * cfg.feedPer) <= cfg.feedPer * BUILDINGS[type].workers,
      `${type}: ate ${eaten} for ${hall.stock.meat} meat`);
  }
});

test('the most plentiful accepted feed is used; feed the animals do not eat is left alone', () => {
  const { s, b, hall } = setup('pigsty', { corn: 3, beans: 30, wheat: 50 });
  assert.equal(feedFor(s, b), 'beans');
  tick(s, 60);
  assert.ok(hall.stock.beans < 30);
  assert.equal(hall.stock.wheat, 50, 'pigs do not take wheat');
});

test('a pen without feed is reported (and only while nothing is in storage)', () => {
  const { s, b, hall } = setup('cattle', {});
  assert.equal(buildingProblem(s, b).code, 'no-input');
  assert.match(buildingProblem(s, b).text, /ขาดอาหารสัตว์/);
  hall.stock.corn = 10;
  assert.notEqual(buildingProblem(s, b)?.code, 'no-input');
});

test('the chicken coop is light work (elders can keep hens); pigs and cattle are not', () => {
  assert.equal(BUILDINGS.coop.light, true);
  assert.ok(!BUILDINGS.pigsty.light && !BUILDINGS.cattle.light);
  const { s, b } = setup('coop', { wheat: 10 });
  const gran = addVillager(s, b.x, b.z);
  gran.age = 70;
  assert.equal(assignJob(s, gran.id, b.id).ok, false, 'coop is full (1 worker)');
  const pig = addBuilt(s, 'pigsty', SPAWN.x - 24, SPAWN.z);
  assert.equal(assignJob(s, gran.id, pig.id).ok, false);
});
