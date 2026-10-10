import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serialize, deserialize, saveGame, loadGame, clearSave } from '../src/save.js';
import { createWorld, tick } from '../src/sim.js';
import { GRID } from '../src/config.js';

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
  assert.equal(data.version, 1);
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
  assert.throws(() => deserialize(JSON.stringify({ ...good, version: 2 })), Error);
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
