import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world as createWorld } from './helpers.js';
import { serialize, deserialize, saveGame, loadGame, clearSave } from '../src/save.js';
import { tick } from '../src/sim.js';
import { GRID, DEER_COUNT } from '../src/config.js';
import { addHouse, addBuilt, SPAWN } from './helpers.js';

function withStorage(fn) {
  const store = new Map();
  const fake = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const old = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true, writable: true });
  try {
    return fn(store);
  } finally {
    if (old) Object.defineProperty(globalThis, 'localStorage', old);
    else delete globalThis.localStorage;
  }
}

test('serialize omits terrain and writes wear as a plain array', () => {
  const s = createWorld(3);
  tick(s, 5);
  const data = JSON.parse(serialize(s));
  assert.equal(data.terrain, undefined);
  assert.ok(Array.isArray(data.wear));
  assert.equal(data.wear.length, GRID * GRID);
  assert.equal(data.version, 4);
});

test('deserialize round-trips state and regenerates terrain', () => {
  const s = createWorld(3);
  tick(s, 20);
  const r = deserialize(serialize(s));
  assert.ok(r.wear instanceof Float32Array);
  assert.equal(r.wear.length, GRID * GRID);
  assert.deepEqual(Array.from(r.wear), Array.from(s.wear));
  assert.deepEqual(r.terrain.water, s.terrain.water);
  assert.equal(r.terrain.heights.length, s.terrain.heights.length);
  assert.equal(r.buildings.length, s.buildings.length);
  assert.equal(r.villagers.length, s.villagers.length);
  assert.equal(r.nodes.length, s.nodes.length);
  assert.equal(r.time, s.time);
  assert.equal(r.nextId, s.nextId);
  assert.doesNotThrow(() => tick(r, 5));
});

test('deserialize throws on invalid input', () => {
  const s = createWorld(3);
  const good = JSON.parse(serialize(s));
  assert.throws(() => deserialize('not json'), Error);
  assert.throws(() => deserialize('null'), Error);
  assert.throws(() => deserialize(JSON.stringify({ ...good, version: 5 })), Error);
  assert.throws(() => deserialize(JSON.stringify({ ...good, buildings: 5 })), Error);
  assert.throws(() => deserialize(JSON.stringify({ ...good, villagers: undefined })), Error);
  assert.throws(() => deserialize(JSON.stringify({ ...good, wear: [1, 2] })), Error);
  assert.throws(() => deserialize(JSON.stringify({ ...good, seed: 'x' })), Error);
});

test('save helpers are safe when localStorage is undefined (Node)', () => {
  assert.equal(globalThis.localStorage, undefined);
  const s = createWorld(1);
  assert.equal(saveGame(s), false);
  assert.equal(loadGame(), null);
  assert.doesNotThrow(() => clearSave());
});

test('saveGame / loadGame / clearSave use the hamlet-save-v1 key', () => {
  withStorage((store) => {
    const s = createWorld(2);
    assert.equal(loadGame(), null);
    assert.equal(saveGame(s), true);
    assert.ok(store.has('hamlet-save-v1'));
    const loaded = loadGame();
    assert.equal(loaded.seed, 2);
    assert.equal(loaded.villagers.length, s.villagers.length);
    clearSave();
    assert.equal(loadGame(), null);
  });
});

test('loadGame returns null for corrupt saves and storage errors', () => {
  withStorage((store) => {
    store.set('hamlet-save-v1', '{broken');
    assert.equal(loadGame(), null);
  });
  const boom = () => { throw new Error('denied'); };
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: boom, setItem: boom, removeItem: boom }, configurable: true, writable: true,
  });
  try {
    assert.equal(loadGame(), null);
    assert.equal(saveGame(createWorld(1)), false);
    assert.doesNotThrow(() => clearSave());
  } finally {
    delete globalThis.localStorage;
  }
});

test('v1 saves migrate (to v4): deer, fx, sickness, house and supply fields, ore veins', () => {
  const s = createWorld(3);
  addHouse(s, 100, 100, 2, 2);
  const maxId = Math.max(...s.nodes.filter((n) => n.kind !== 'ore').map((n) => n.id));
  const v1 = JSON.parse(serialize(s));
  v1.version = 1;
  delete v1.animals;
  delete v1.fx;
  delete v1.deerTimer;
  v1.nodes = v1.nodes.filter((n) => n.kind !== 'ore');
  for (const b of v1.buildings) {
    if (b.type !== 'house') { delete b.tooled; continue; }
    delete b.autoUpgrade;
    delete b.foodsToday;
    b.breadToday = true;
    b.needsMet = { food: true, bread: true, religion: false, entertainment: false, cathedral: false };
  }
  for (const v of v1.villagers) { delete v.sick; delete v.sickDays; delete v.healer; }
  const m = deserialize(JSON.stringify(v1));
  assert.equal(m.version, 4);
  assert.deepEqual(m.fx, []);
  assert.ok(m.animals.length > 0 && m.animals.length <= DEER_COUNT);
  const house = m.buildings.find((b) => b.type === 'house');
  assert.equal(house.autoUpgrade, true);
  assert.deepEqual(house.foodsToday, []);
  assert.equal(house.breadToday, undefined);
  assert.equal(house.needsMet.bread, undefined);
  assert.equal(house.needsMet.variety2, false);
  for (const v of m.villagers) assert.deepEqual([v.sick, v.sickDays, v.healer], [false, 0, null]);
  const ore = m.nodes.filter((n) => n.kind === 'ore');
  assert.ok(ore.length > 0);
  assert.ok(ore.every((n) => n.id > maxId));
  assert.equal(new Set(m.nodes.map((n) => n.id)).size, m.nodes.length);
  assert.equal(JSON.parse(serialize(m)).version, 4);
  assert.doesNotThrow(() => tick(m, 20));
  assert.doesNotThrow(() => deserialize(serialize(m)));
});

test('saves from before manual jobs turn the jobless adults into builders; workers keep their posts', () => {
  const s = createWorld(1);
  const wc = addBuilt(s, 'woodcutter', SPAWN.x + 30, SPAWN.z);
  const [w, free, kid] = s.villagers;
  w.jobId = wc.id;
  kid.age = 8;
  delete s.manualJobs;
  for (const v of s.villagers) delete v.builder;
  const back = deserialize(serialize(s));
  assert.equal(back.manualJobs, true);
  const by = (id) => back.villagers.find((v) => v.id === id);
  assert.equal(by(w.id).jobId, wc.id);
  assert.equal(by(w.id).builder, false);
  assert.equal(by(free.id).builder, true);
  assert.equal(by(kid.id).builder, false);
  // a save made after the change is left alone
  const again = deserialize(serialize(back));
  assert.equal(again.villagers.filter((v) => v.builder).length, back.villagers.filter((v) => v.builder).length);
});

test('rocks and ore veins from older saves are rescaled to the new trip counts (same share left)', () => {
  const s = createWorld(1);
  const rock = s.nodes.find((n) => n.kind === 'rock');
  const ore = s.nodes.find((n) => n.kind === 'ore');
  const tree = s.nodes.find((n) => n.kind === 'tree');
  delete s.nodeAmountsV2;
  rock.amount = 60;
  ore.amount = 40;
  const t0 = tree.amount;
  const back = deserialize(serialize(s));
  const by = (id) => back.nodes.find((n) => n.id === id);
  assert.equal(by(rock.id).amount, 20);
  assert.equal(by(ore.id).amount, Math.ceil(40 * 25 / 80));
  assert.equal(by(tree.id).amount, t0, 'trees are unchanged');
  const again = deserialize(serialize(back));
  assert.equal(again.nodes.find((n) => n.id === rock.id).amount, 20, 'only once');
});
