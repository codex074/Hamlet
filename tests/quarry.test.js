import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick, assignJob, canPlace } from '../src/sim.js';
import { rollAccident, JOB_EXEC } from '../src/jobs.js';
import { BUILDINGS, QUARRY_ACCIDENT_CHANCE, QUARRY_TOOLED_MUL, TOOL_SPEED_BONUS } from '../src/config.js';
import { workTime } from '../src/taskutil.js';
import { world, townhall, addBuilt, addVillager, clearVillagers, SPAWN } from './helpers.js';

test('the quarry is buildable again, takes up to 10 diggers and needs no rocks nearby', () => {
  const s = world();
  assert.equal(BUILDINGS.quarry.workers, 10);
  assert.equal(BUILDINGS.quarry.retired, undefined);
  assert.equal(canPlace(s, 'quarry', SPAWN.x + 30, SPAWN.z + 15, 0).ok, true);
  const q = addBuilt(s, 'quarry', SPAWN.x + 30, SPAWN.z + 15);
  for (let i = 0; i < 12; i++) addVillager(s, SPAWN.x, SPAWN.z);
  let hired = 0;
  for (const v of s.villagers) if (assignJob(s, v.id, q.id).ok) hired += 1;
  assert.equal(hired, 10);
});

test('diggers carry stone to storage without using up any rock', () => {
  const s = world();
  clearVillagers(s);
  s.nodes = s.nodes.filter((n) => n.kind !== 'rock');   // every surface rock is gone
  const q = addBuilt(s, 'quarry', SPAWN.x + 22, SPAWN.z + 8);
  for (let i = 0; i < 3; i++) assignJob(s, addVillager(s, q.x, q.z).id, q.id);
  const stone0 = townhall(s).stock.stone;
  tick(s, 90);
  assert.ok(townhall(s).stock.stone > stone0 + 6, `stone ${townhall(s).stock.stone}`);
});

test('accident odds match the setting; tools halve them and speed up digging', () => {
  const s = world();
  const q = addBuilt(s, 'quarry', SPAWN.x + 22, SPAWN.z + 8);
  const count = (tooled) => {
    q.tooled = tooled;
    let n = 0;
    for (let id = 1; id <= 400; id++) {
      for (let t = 0; t < 100; t++) {
        s.time = 1000 + t * 3.7;
        if (rollAccident(s, { id }, q)) n += 1;
      }
    }
    return n / 40000;
  };
  const bare = count(false);
  const tooled = count(true);
  assert.ok(Math.abs(bare - QUARRY_ACCIDENT_CHANCE) < QUARRY_ACCIDENT_CHANCE * 0.35, `rate ${bare}`);
  assert.ok(tooled < bare * 0.75 && tooled > bare * QUARRY_TOOLED_MUL * 0.5, `tooled ${tooled} vs ${bare}`);
  q.tooled = true;
  assert.ok(Math.abs(workTime(q, 10) - 10 * (1 - TOOL_SPEED_BONUS)) < 1e-9);
});

test('an accident injures (worker rests as sick) or kills the digger', () => {
  const s = world();
  clearVillagers(s);
  const q = addBuilt(s, 'quarry', SPAWN.x + 22, SPAWN.z + 8);
  const find = (want) => {
    for (let id = 1; id < 3000; id++) {
      for (let t = 0; t < 40; t++) {
        s.time = 500 + t;
        if (rollAccident(s, { id }, q) === want) return { id, time: s.time };
      }
    }
    return null;
  };
  // injured
  const hurt = find('injured');
  assert.ok(hurt);
  const a = addVillager(s, q.x, q.z);
  a.id = hurt.id;
  s.time = hurt.time;
  const r1 = JOB_EXEC.dig(s, a, { kind: 'dig', bId: q.id, t: 0.01, out: { stone: 3 } }, 0.1);
  assert.equal(a.sick, true);
  assert.equal(a.carry, null);
  assert.equal(q.accidents.injured, 1);
  assert.notEqual(r1, undefined);
  // killed: removed after the tick, counted as a death, announced
  const dead = find('killed');
  assert.ok(dead);
  const b = addVillager(s, q.x, q.z);
  b.id = dead.id;
  s.time = dead.time;
  const deaths0 = s.deaths ?? 0;
  JOB_EXEC.dig(s, b, { kind: 'dig', bId: q.id, t: 0.01, out: { stone: 3 } }, 0.1);
  assert.equal(b.dead, true);
  assert.equal(s.deaths, deaths0 + 1);
  assert.equal(q.accidents.killed, 1);
  assert.ok(s.events.some((e) => /เสียชีวิตจากอุบัติเหตุในเหมืองหิน/.test(e.text)));
  tick(s, 0.1);
  assert.ok(!s.villagers.some((v) => v.id === dead.id), 'removed from the village');
});
