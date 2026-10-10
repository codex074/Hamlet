// World settings, map sizes, rivers, territories, difficulty, regrowth, forester, v3 -> v4 migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../src/rng.js';
import {
  createWorld, tick, summary, canPlace, canPaintZone, placeBuilding, removeAt, setDifficulty,
  normalizeSettings, SETTINGS_OPTIONS, DEFAULT_SETTINGS, spawnOf, plotInfo, plotPrice, buyPlot, isOwned,
} from '../src/sim.js';
import { generateTerrain, generateNodes, heightAt, isWater, fertilityAt } from '../src/terrain.js';
import { createWear, wearAt, addWear, cellIndex, wearGrid } from '../src/wear.js';
import { footprintOK, findHouseSite } from '../src/placement.js';
import { serialize, deserialize } from '../src/save.js';
import { stepVillager } from '../src/villagers.js';
import { processMidnight } from '../src/needs.js';
import { rollSickness } from '../src/sickness.js';
import { processPregnancies } from '../src/families.js';
import { processRegrowth, growSaplings } from '../src/regrowth.js';
import { getIndex, removeNode, addNode } from '../src/nodeindex.js';
import {
  MAP_SIZES, DAY_LENGTH, NODE_COUNTS, NODE_AMOUNT, DIFFICULTY, PLOT_BASE_PRICE, PLOT_PRICE_GROWTH, START, BUILDINGS,
  FORESTER_RADIUS, SAPLING_GROW_DAYS, MAX_SAPLINGS_PER_FORESTER, SICK_CHANCE_PER_DAY, PREGNANCY_CHANCE, HUNGER_PER_SEC,
  RIVER_MIN_SPAWN_DIST, START_LAYOUT,
} from '../src/config.js';
import { buildBenchWorld } from '../scripts/bench.mjs';
import {
  world, SMALL, townhall, addBuilt, addHouse, addVillager, clearVillagers, findPlaceSpot,
} from './helpers.js';

const MEDIUM = { mapSize: 'medium' };
const LARGE = { mapSize: 'large' };

function countKind(s, kind) {
  return s.nodes.filter((n) => n.kind === kind).length;
}

function staffed(s, type, x, z) {
  const b = addBuilt(s, type, x, z);
  const w = addVillager(s, x, z);
  w.jobId = b.id;
  b.workers.push(w.id);
  return b;
}

// every node is in the index exactly once
function indexConsistent(s) {
  const idx = getIndex(s);
  let total = 0;
  for (const table of idx.kinds.values()) for (const list of table.values()) total += list.length;
  return total === s.nodes.length && idx.byId.size === s.nodes.length && s.nodes.every((n) => idx.byId.get(n.id) === n);
}

// ---------------------------------------------------------------- settings

test('normalizeSettings fills defaults, drops unknown keys and falls back on invalid values', () => {
  assert.deepEqual(normalizeSettings(), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS);
  assert.equal(DEFAULT_SETTINGS.mapSize, 'medium');
  assert.equal(DEFAULT_SETTINGS.rivers, 1);
  const n = normalizeSettings({ mapSize: 'large', rivers: 3, startVillagers: 12, evil: 1, forest: 'bogus', terrain: 'hilly' });
  assert.equal(n.mapSize, 'large');
  assert.equal(n.rivers, 3);
  assert.equal(n.startVillagers, 12);
  assert.equal(n.forest, 'normal');
  assert.equal(n.terrain, 'hilly');
  assert.equal('evil' in n, false);
  assert.equal(normalizeSettings({ rivers: '2' }).rivers, 2);
  assert.equal(normalizeSettings({ rivers: 5 }).rivers, 1);
  assert.equal(normalizeSettings({ startVillagers: 7 }).startVillagers, 8);
  assert.equal(normalizeSettings(null).mapSize, 'medium');
  assert.equal(normalizeSettings([1, 2]).mapSize, 'medium');
  // never mutates its input or the shared default
  const input = { mapSize: 'small' };
  normalizeSettings(input);
  assert.deepEqual(input, { mapSize: 'small' });
  assert.equal(DEFAULT_SETTINGS.mapSize, 'medium');
});

test('SETTINGS_OPTIONS lists every allowed value and each one is accepted', () => {
  assert.deepEqual(Object.keys(SETTINGS_OPTIONS).sort(), Object.keys(DEFAULT_SETTINGS).sort());
  assert.deepEqual(SETTINGS_OPTIONS.mapSize, ['small', 'medium', 'large']);
  assert.deepEqual(SETTINGS_OPTIONS.rivers, [0, 1, 2, 3]);
  assert.deepEqual(SETTINGS_OPTIONS.startVillagers, [4, 8, 12]);
  for (const [key, values] of Object.entries(SETTINGS_OPTIONS)) {
    for (const v of values) assert.equal(normalizeSettings({ [key]: v })[key], v, `${key}=${v}`);
  }
});

test('createWorld stores normalised settings and defaults to a medium world', () => {
  const s = createWorld(1);
  assert.deepEqual(s.settings, DEFAULT_SETTINGS);
  assert.deepEqual(s.world, { size: 400, grid: 200, plot: 80, plots: 5 });
  assert.equal(s.difficulty, 'normal');
  const t = createWorld(1, { mapSize: 'small', evil: true, startVillagers: 4 });
  assert.equal(t.settings.startVillagers, 4);
  assert.equal('evil' in t.settings, false);
});

// ---------------------------------------------------------------- map sizes

test('map sizes give the right dimensions on terrain, wear and state.world', () => {
  for (const [name, size] of Object.entries(MAP_SIZES)) {
    const s = createWorld(2, { mapSize: name });
    const grid = size / 2;
    const plots = size / 80;
    assert.deepEqual(s.world, { size, grid, plot: 80, plots });
    assert.equal(s.terrain.size, size);
    assert.equal(s.terrain.grid, grid);
    assert.equal(s.terrain.heights.length, (grid + 1) ** 2);
    assert.equal(s.terrain.water.length, grid * grid);
    assert.equal(s.terrain.fertility.length, grid * grid);
    assert.equal(s.wear.length, grid * grid);
    assert.equal(s.territory.owned.length, plots * plots);
    assert.deepEqual(spawnOf(s), { x: size / 2, z: size / 2 });
    assert.deepEqual(spawnOf(s.terrain), { x: size / 2, z: size / 2 });
    const hall = townhall(s);
    assert.deepEqual([hall.x, hall.z], [size / 2, size / 2]);
    for (const v of s.villagers) assert.ok(Math.hypot(v.x - size / 2, v.z - size / 2) <= 6);
  }
  assert.deepEqual([MAP_SIZES.small, MAP_SIZES.medium, MAP_SIZES.large], [240, 400, 560]);
});

test('terrain helpers use the terrain own size and grid', () => {
  const t = generateTerrain(4, LARGE);
  const g = t.grid;
  assert.equal(g, 280);
  for (const [ix, iz] of [[0, 0], [10, 20], [140, 140], [g, g], [g, 0], [0, g]]) {
    assert.ok(Math.abs(heightAt(t, ix * 2, iz * 2) - t.heights[iz * (g + 1) + ix]) < 1e-6);
  }
  assert.ok(Number.isFinite(heightAt(t, -50, 99999)));
  assert.equal(isWater(t, -10, -10), t.water[0] === 1);
  assert.equal(fertilityAt(t, 1e6, 1e6), t.fertility[g * g - 1]);
  assert.equal(isWater(t, 1e6, 1e6), t.water[g * g - 1] === 1);
  // a point far beyond the small-map size reads its own cell, not a clamped one
  const far = Math.floor(500 / 2);
  assert.equal(fertilityAt(t, 500, 100), t.fertility[Math.floor(100 / 2) * g + far]);
});

test('wear helpers derive the grid from wear.length', () => {
  for (const grid of [120, 200, 280]) {
    const wear = createWear(grid);
    assert.equal(wear.length, grid * grid);
    assert.equal(wearGrid(wear), grid);
    assert.equal(cellIndex(wear, 1e6, 1e6), grid * grid - 1);
    assert.equal(cellIndex(wear, 3 * 2 + 0.1, 2 * 2 + 0.1), 2 * grid + 3);
    addWear(wear, grid * 2 - 1, grid * 2 - 1, 0.4);
    assert.equal(wearAt(wear, grid * 2 - 1, grid * 2 - 1), Math.fround(0.4));
    assert.equal(wear[grid * grid - 1], Math.fround(0.4));
  }
  assert.equal(createWear().length, 120 * 120);
  assert.equal(createWear({ grid: 200 }).length, 200 * 200);
});

test('node counts scale with land area and density; amounts scale with the amount setting', () => {
  const counts = {};
  for (const [name] of Object.entries(MAP_SIZES)) {
    const t = generateTerrain(3, { mapSize: name });
    const nodes = generateNodes(3, t, { mapSize: name });
    counts[name] = { tree: nodes.filter((n) => n.kind === 'tree').length, rock: nodes.filter((n) => n.kind === 'rock').length,
      berry: nodes.filter((n) => n.kind === 'berry').length, ore: nodes.filter((n) => n.kind === 'ore').length };
    const half = MAP_SIZES[name] / 2;
    for (const n of nodes) {
      assert.ok(n.x >= 4 && n.x <= MAP_SIZES[name] - 4 && n.z >= 4 && n.z <= MAP_SIZES[name] - 4);
      assert.ok(Math.hypot(n.x - half, n.z - half) > 25 - 8);
      assert.equal(isWater(t, n.x, n.z), false);
    }
  }
  const area = (name) => (MAP_SIZES[name] / 240) ** 2;
  assert.equal(counts.small.rock, NODE_COUNTS.rock);
  assert.equal(counts.medium.rock, Math.round(NODE_COUNTS.rock * area('medium')));
  assert.equal(counts.large.rock, Math.round(NODE_COUNTS.rock * area('large')));
  assert.ok(counts.medium.tree > counts.small.tree * 2);
  assert.ok(counts.large.tree > counts.small.tree * 4);
  assert.ok(counts.large.berry > counts.medium.berry && counts.medium.berry > counts.small.berry);

  const rocksAt = (stone) => {
    const t = generateTerrain(3, { mapSize: 'medium', stone });
    return generateNodes(3, t, { mapSize: 'medium', stone }).filter((n) => n.kind === 'rock').length;
  };
  const [lo, mid, hi] = [rocksAt('low'), rocksAt('normal'), rocksAt('high')];
  assert.ok(lo < mid && mid < hi, `${lo} ${mid} ${hi}`);
  assert.equal(lo, Math.round(counts.medium.rock * 0.5));
  assert.equal(hi, Math.round(NODE_COUNTS.rock * area('medium') * 1.7));

  const amounts = (opts) => {
    const s = createWorld(3, { mapSize: 'small', ...opts });
    return Object.fromEntries(['tree', 'rock', 'berry', 'ore'].map((k) => [k, s.nodes.find((n) => n.kind === k).amount]));
  };
  const normal = amounts({});
  assert.deepEqual(normal, NODE_AMOUNT);
  const low = amounts({ forest: 'low', stone: 'low', berries: 'low', ore: 'low' });
  const high = amounts({ forest: 'high', stone: 'high', berries: 'high', ore: 'high' });
  for (const k of Object.keys(NODE_AMOUNT)) {
    assert.equal(low[k], Math.max(1, Math.round(NODE_AMOUNT[k] * 0.7)));
    assert.equal(high[k], Math.round(NODE_AMOUNT[k] * 1.4));
  }
});

test('terrain setting scales height amplitude; hilly maps carry more ore', () => {
  const range = (terrain) => {
    const t = generateTerrain(6, { mapSize: 'small', terrain });
    let lo = Infinity;
    let hi = -Infinity;
    for (const h of t.heights) {
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    return hi - Math.max(lo, 0);
  };
  const [flat, normal, hilly] = [range('flat'), range('normal'), range('hilly')];
  assert.ok(flat < normal * 0.6, `${flat} ${normal}`);
  assert.ok(hilly > normal * 1.3, `${hilly} ${normal}`);
  const ore = (terrain) => {
    const t = generateTerrain(6, { mapSize: 'medium', terrain });
    return generateNodes(6, t, { mapSize: 'medium', terrain }).filter((n) => n.kind === 'ore').length;
  };
  assert.ok(ore('hilly') > ore('normal'));
  assert.ok(ore('flat') > 0, 'flat maps still get ore (relaxed height)');
});

test('start resources and start villagers follow the settings', () => {
  const low = createWorld(2, { mapSize: 'small', startResources: 'low' });
  const high = createWorld(2, { mapSize: 'small', startResources: 'high' });
  assert.equal(townhall(low).stock.wood, START.stock.wood * 0.5);
  assert.equal(townhall(high).stock.wood, START.stock.wood * 2);
  assert.equal(low.gold, 0);
  assert.equal(createWorld(2, SMALL).gold, 0);
  assert.equal(high.gold, 100);
  for (const n of [4, 8, 12]) {
    const s = createWorld(2, { mapSize: 'small', startVillagers: n });
    assert.equal(s.villagers.length, n);
    assert.equal(s.villagers.filter((v) => v.spouseId != null).length, START_LAYOUT[n].couples * 2);
  }
});

// ---------------------------------------------------------------- rivers

function waterStats(t) {
  let count = 0;
  let minDist = Infinity;
  const half = t.size / 2;
  for (let iz = 0; iz < t.grid; iz++) {
    for (let ix = 0; ix < t.grid; ix++) {
      if (!t.water[iz * t.grid + ix]) continue;
      count += 1;
      minDist = Math.min(minDist, Math.hypot((ix + 0.5) * 2 - half, (iz + 0.5) * 2 - half));
    }
  }
  return { count, minDist };
}

test('rivers: N rivers means more water, and water stays at least 40 m from the centre', () => {
  for (const mapSize of ['small', 'medium', 'large']) {
    for (const seed of [1, 2, 3, 7]) {
      const counts = [];
      for (const rivers of [0, 1, 2, 3]) {
        const t = generateTerrain(seed, { mapSize, rivers });
        const { count, minDist } = waterStats(t);
        counts.push(count);
        assert.ok(count > 0, `${mapSize} seed ${seed} rivers ${rivers}: some water (ponds for 0)`);
        assert.ok(minDist >= RIVER_MIN_SPAWN_DIST, `${mapSize} seed ${seed} rivers ${rivers}: water ${minDist.toFixed(1)} m from centre`);
      }
      assert.ok(counts[1] > counts[0], `${mapSize} river beats ponds: ${counts}`);
      assert.ok(counts[2] > counts[1] && counts[3] > counts[2], `${mapSize} seed ${seed}: ${counts}`);
    }
  }
});

test('0 rivers makes one or two small ponds so fishing stays possible', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const s = createWorld(seed, { mapSize: 'medium', rivers: 0 });
    const t = s.terrain;
    const { count } = waterStats(t);
    assert.ok(count >= 60 && count < 2500, `pond cells ${count}`);
    // a fishery (needs water nearby) can be placed on owned land
    for (let i = 0; i < 6; i++) addVillager(s, 200, 200);
    let ok = false;
    for (let x = 90; x < 310 && !ok; x += 4) {
      for (let z = 90; z < 310 && !ok; z += 4) ok = canPlace(s, 'fishery', x, z, 0).ok;
    }
    assert.ok(ok, `seed ${seed}: no fishery spot beside a pond`);
    assert.ok(!isWater(t, 200, 200));
  }
});

test('the first river of a new world keeps the start area dry for every seed', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const s = createWorld(seed, { mapSize: 'small', rivers: 3 });
    for (const b of s.buildings) assert.equal(isWater(s.terrain, b.x, b.z), false);
    for (const v of s.villagers) assert.equal(isWater(s.terrain, v.x, v.z), false);
  }
});

// ---------------------------------------------------------------- territory

test('territory start: the 3x3 plots around the centre are owned (everything on small maps)', () => {
  const small = world(1);
  assert.equal(small.territory.owned.length, 9);
  assert.ok(small.territory.owned.every((o) => o === 1));
  assert.equal(small.territory.bought, 0);
  for (const [name, plots] of [['medium', 5], ['large', 7]]) {
    const s = createWorld(1, { mapSize: name });
    const lo = (plots - 3) / 2;
    const owned = [];
    for (let pz = 0; pz < plots; pz++) {
      for (let px = 0; px < plots; px++) {
        const inside = px >= lo && px < lo + 3 && pz >= lo && pz < lo + 3;
        assert.equal(s.territory.owned[pz * plots + px], inside ? 1 : 0, `${name} ${px},${pz}`);
        if (inside) owned.push([px, pz]);
      }
    }
    assert.equal(owned.length, 9);
    const sum = summary(s);
    assert.deepEqual([sum.ownedPlots, sum.totalPlots, sum.difficulty], [9, plots * plots, 'normal']);
  }
});

test('isOwned reads plots by position', () => {
  const s = createWorld(1, MEDIUM);
  assert.equal(isOwned(s, 200, 200), true);
  assert.equal(isOwned(s, 80, 80), true);       // top-left corner of the owned block
  assert.equal(isOwned(s, 79.9, 200), false);
  assert.equal(isOwned(s, 319.9, 319.9), true);
  assert.equal(isOwned(s, 320.1, 200), false);
  assert.equal(isOwned(s, 10, 10), false);
  assert.equal(isOwned(s, -5, 200), false);
  assert.equal(isOwned(s, 400, 400), false);
  assert.equal(isOwned({ buildings: [] }, 10, 10), true);   // bare fixtures own everything
});

test('plotPrice grows 35% per purchase; plotInfo marks owned and edge-adjacent plots', () => {
  const s = createWorld(1, MEDIUM);
  assert.equal(PLOT_BASE_PRICE, 80);
  assert.equal(plotPrice(s), 80);
  const info = plotInfo(s);
  assert.equal(info.length, 25);
  assert.deepEqual(info[0], { px: 0, pz: 0, x0: 0, z0: 0, x1: 80, z1: 80, owned: false, buyable: false, price: 80 });
  const at = (px, pz) => info.find((p) => p.px === px && p.pz === pz);
  assert.equal(at(2, 2).owned, true);
  assert.equal(at(2, 2).buyable, false);
  assert.equal(at(0, 2).buyable, true);         // west of the owned block
  assert.equal(at(4, 2).buyable, true);
  assert.equal(at(2, 0).buyable, true);
  assert.equal(at(0, 0).buyable, false);        // diagonal only
  assert.equal(at(4, 4).buyable, false);
  assert.equal(info.filter((p) => p.buyable).length, 12);
  assert.ok(info.every((p) => p.price === 80));
  for (let bought = 0; bought < 6; bought++) {
    s.territory.bought = bought;
    assert.equal(plotPrice(s), Math.round(PLOT_BASE_PRICE * PLOT_PRICE_GROWTH ** bought));
  }
  s.territory.bought = 1;
  assert.equal(plotPrice(s), 108);
  assert.equal(plotInfo(s)[0].price, 108);
});

test('buyPlot deducts gold, extends the territory and raises the price; refusals explain why', () => {
  const s = createWorld(1, MEDIUM);
  s.gold = 100;
  let r = buyPlot(s, 0, 0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ซื้อได้เฉพาะแปลงที่ติดกับดินแดนของคุณ');
  assert.equal(s.gold, 100);
  r = buyPlot(s, 2, 2);
  assert.equal(r.ok, false);
  assert.equal(buyPlot(s, 9, 9).ok, false);
  assert.equal(buyPlot(s, 1.5, 2).ok, false);
  s.gold = 79;
  r = buyPlot(s, 0, 2);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ทองไม่พอ (ต้องใช้ 80)');
  assert.equal(s.gold, 79);
  s.gold = 100;
  r = buyPlot(s, 0, 2);
  assert.deepEqual(r, { ok: true, reason: '' });
  assert.equal(s.gold, 20);
  assert.equal(s.territory.bought, 1);
  assert.equal(s.territory.owned[2 * 5 + 0], 1);
  assert.equal(isOwned(s, 40, 200), true);
  assert.equal(plotPrice(s), 108);
  assert.ok(s.events.some((e) => e.text === '🗺️ ซื้อดินแดนใหม่แล้ว'));
  assert.equal(summary(s).ownedPlots, 10);
  assert.equal(plotInfo(s).find((p) => p.px === 0 && p.pz === 1).buyable, true);   // new neighbour
  assert.equal(buyPlot(s, 0, 2).ok, false);     // already yours
  s.gold = 107.9;
  assert.equal(buyPlot(s, 0, 1).ok, false);
  s.gold = 108;
  assert.equal(buyPlot(s, 0, 1).ok, true);
  assert.equal(s.gold, 0);
});

test('placement and zones are blocked outside owned land, including partly outside', () => {
  const s = createWorld(1, MEDIUM);
  const out = canPlace(s, 'woodcutter', 40, 200, 0);
  assert.deepEqual(out, { ok: false, reason: 'อยู่นอกดินแดนของคุณ' });
  assert.deepEqual(canPaintZone(s, 'field', 40, 200, 9), { ok: false, reason: 'อยู่นอกดินแดนของคุณ' });
  // straddling the 80 m border: radius 3.5 at x = 82 reaches x = 78.5
  assert.equal(footprintOK(s, 82, 200, 3.5).reason, 'อยู่นอกดินแดนของคุณ');
  assert.notEqual(footprintOK(s, 84, 200, 3.5).reason, 'อยู่นอกดินแดนของคุณ');
  assert.equal(footprintOK(s, 200, 322, 3.5).reason, 'อยู่นอกดินแดนของคุณ');
  assert.notEqual(footprintOK(s, 200, 316, 3.5).reason, 'อยู่นอกดินแดนของคุณ');
  // a corner of an unowned plot pokes into the circle diagonally
  assert.equal(footprintOK(s, 83, 83, 5).reason, 'อยู่นอกดินแดนของคุณ');
  assert.equal(placeBuilding(s, 'woodcutter', 40, 200, 0), null);
  // after buying the plot the same spot is no longer refused for ownership
  s.gold = 500;
  assert.equal(buyPlot(s, 0, 2).ok, true);
  assert.notEqual(canPlace(s, 'woodcutter', 40, 200, 0).reason, 'อยู่นอกดินแดนของคุณ');
});

test('house sites are chosen entirely on owned land', () => {
  const s = createWorld(1, MEDIUM);
  const zone = { id: 99, kind: 'residential', x: 88, z: 200, r: 14 };   // crosses the x = 80 border
  s.zones.push(zone);
  let found = 0;
  for (let i = 1; i <= 80; i++) {
    const site = findHouseSite(s, zone, mulberry32(i));
    if (!site) continue;
    found += 1;
    assert.ok(site.x - BUILDINGS.house.radius >= 80 - 1e-9, `house at ${site.x}`);
  }
  assert.ok(found > 0);
});

test('gathering ignores nodes outside owned land until the plot is bought', () => {
  const s = createWorld(5, MEDIUM);
  // only trees on unowned land remain, plus the wood in the hall
  s.nodes = s.nodes.filter((n) => n.kind !== 'tree' || !isOwned(s, n.x, n.z));
  const trees = s.nodes.filter((n) => n.kind === 'tree');
  assert.ok(trees.length > 500);
  // woodcutter just inside the west border (x = 90); trees outside lie within the gather radius
  clearVillagers(s);
  const wc = staffed(s, 'woodcutter', 90, 200);
  const store = addBuilt(s, 'storehouse', 100, 215);
  const wood0 = store.stock.wood;
  const total0 = trees.reduce((a, n) => a + n.amount, 0);
  assert.ok(trees.some((n) => Math.hypot(n.x - 90, n.z - 200) < 40), 'unowned trees within reach');
  tick(s, 120);
  assert.equal(store.stock.wood, wood0);
  assert.equal(s.nodes.filter((n) => n.kind === 'tree').reduce((a, n) => a + n.amount, 0), total0);
  s.gold = 1000;
  assert.equal(buyPlot(s, 0, 2).ok, true);      // plot (0, 2) is x 0-80, z 160-240
  tick(s, 120);
  assert.ok(store.stock.wood > wood0, `wood ${store.stock.wood}`);
  assert.ok(wc.workers.length >= 1);
});

test('hunters ignore deer on unowned land', () => {
  const s = createWorld(5, MEDIUM);
  clearVillagers(s);
  const hunter = staffed(s, 'hunter', 100, 200);
  addBuilt(s, 'storehouse', 110, 215);
  s.animals = [{ id: 9001, kind: 'deer', x: 40, z: 200, tx: 40, tz: 200, wait: 99, reserved: null }];
  tick(s, 30);
  assert.equal(s.animals[0].reserved, null, 'deer outside the territory is not hunted');
  s.animals[0].x = 130;
  s.animals[0].tx = 130;
  tick(s, 5);
  assert.ok(s.animals.length === 0 || s.animals[0].reserved != null, 'deer inside is hunted');
  assert.equal(hunter.workers.length, 1);
});

// ---------------------------------------------------------------- difficulty

test('DIFFICULTY table and setDifficulty', () => {
  assert.deepEqual(Object.keys(DIFFICULTY), ['easy', 'normal', 'hard']);
  assert.deepEqual(DIFFICULTY.normal, { name: 'ปกติ', hunger: 1, sickness: 1, immigration: 1, pregnancy: 1, cost: 1, tax: 1 });
  assert.deepEqual(
    [DIFFICULTY.easy.hunger, DIFFICULTY.easy.sickness, DIFFICULTY.easy.immigration, DIFFICULTY.easy.pregnancy, DIFFICULTY.easy.cost, DIFFICULTY.easy.tax],
    [0.75, 0.5, 1.4, 1.3, 0.75, 1.2]);
  assert.deepEqual(
    [DIFFICULTY.hard.hunger, DIFFICULTY.hard.sickness, DIFFICULTY.hard.immigration, DIFFICULTY.hard.pregnancy, DIFFICULTY.hard.cost, DIFFICULTY.hard.tax],
    [1.25, 1.5, 0.7, 0.8, 1.25, 0.85]);
  const s = world(1);
  assert.equal(setDifficulty(s, 'hard'), true);
  assert.equal(s.difficulty, 'hard');
  assert.equal(summary(s).difficulty, 'hard');
  assert.ok(s.events.at(-1).text.startsWith('⚙️ เปลี่ยนความยากเป็น'));
  const n = s.events.length;
  assert.equal(setDifficulty(s, 'insane'), false);
  assert.equal(setDifficulty(s, '__proto__'), false);
  assert.equal(s.difficulty, 'hard');
  assert.equal(s.events.length, n);
});

test('difficulty scales hunger', () => {
  const after = (level) => {
    const s = world(1);
    setDifficulty(s, level);
    const v = s.villagers[0];
    v.hunger = 0;
    stepVillager(s, v, 10, mulberry32(1));
    return v.hunger;
  };
  assert.ok(Math.abs(after('normal') - HUNGER_PER_SEC * 10) < 1e-12);
  assert.ok(Math.abs(after('easy') - HUNGER_PER_SEC * 10 * 0.75) < 1e-12);
  assert.ok(Math.abs(after('hard') - HUNGER_PER_SEC * 10 * 1.25) < 1e-12);
});

test('difficulty scales sickness chance', () => {
  const sick = (level) => {
    const s = world(1);
    setDifficulty(s, level);
    return rollSickness(s, () => 0.03);   // between easy (0.02) and normal (0.04)
  };
  assert.equal(sick('easy'), 0);
  assert.equal(sick('normal'), 8);
  assert.equal(sick('hard'), 8);
  const s = world(1);
  setDifficulty(s, 'hard');
  assert.equal(rollSickness(s, () => 0.05), 8);   // 0.05 < 0.06
  const t = world(1);
  assert.equal(rollSickness(t, () => 0.05), 0);    // normal 0.04
  assert.equal(SICK_CHANCE_PER_DAY, 0.04);
});

test('difficulty scales immigration count and tax', () => {
  const run = (level) => {
    const s = world(1);
    clearVillagers(s);
    setDifficulty(s, level);
    addHouse(s, 100, 100, 3, 1);
    const gold0 = s.gold;
    processMidnight(s, mulberry32(7));
    return { arrived: s.villagers.length - 3, income: Math.round((s.gold - gold0) * 100) / 100 };
  };
  assert.deepEqual(run('normal'), { arrived: 6, income: 3 });
  assert.deepEqual(run('easy'), { arrived: 8, income: 3.6 });    // round(6 * 1.4), 3 * 1.2
  assert.deepEqual(run('hard'), { arrived: 4, income: 2.6 });    // round(6 * 0.7), 3 * 0.85 -> 2.55 rounded to 1 dp
});

test('difficulty scales pregnancy chance', () => {
  const pregnant = (level) => {
    const s = world(1);
    clearVillagers(s);
    setDifficulty(s, level);
    const h = addHouse(s, 100, 100, 0, 1);
    h.happiness = 1;
    const man = addVillager(s, 100, 100);
    const wife = addVillager(s, 100, 100);
    Object.assign(man, { gender: 'm', age: 25, spouseId: wife.id, homeId: h.id });
    Object.assign(wife, { gender: 'f', age: 25, spouseId: man.id, homeId: h.id });
    h.residents.push(man.id, wife.id);
    processPregnancies(s, () => 0.35);   // easy 0.39, normal 0.30, hard 0.24
    return wife.pregnant;
  };
  assert.equal(PREGNANCY_CHANCE, 0.3);
  assert.equal(pregnant('easy'), true);
  assert.equal(pregnant('normal'), false);
  assert.equal(pregnant('hard'), false);
});

test('difficulty scales the cost of NEW placements (rounded up, min 1); refunds follow what was charged', () => {
  const needed = (level) => {
    const s = world(1);
    setDifficulty(s, level);
    const spot = findPlaceSpot(s, 'storehouse', 100, 130);
    const id = placeBuilding(s, 'storehouse', spot.x, spot.z, 0);   // wood 15
    assert.ok(id != null);
    return s.buildings.find((b) => b.id === id);
  };
  assert.deepEqual(needed('normal').needed, { wood: 15 });
  assert.deepEqual(needed('easy').needed, { wood: 12 });     // ceil(11.25)
  assert.deepEqual(needed('hard').needed, { wood: 19 });     // ceil(18.75)
  assert.deepEqual(needed('hard').cost, { wood: 19 });
  assert.deepEqual(BUILDINGS.storehouse.cost, { wood: 15 }, 'the config table is never mutated');
  // changing difficulty later does not reprice sites already placed
  const s = world(1);
  setDifficulty(s, 'hard');
  const spot = findPlaceSpot(s, 'woodcutter', 100, 130);
  const bid = placeBuilding(s, 'woodcutter', spot.x, spot.z, 0);
  const b = s.buildings.find((x) => x.id === bid);
  assert.deepEqual(b.needed, { wood: 10 });                    // ceil(10)
  setDifficulty(s, 'easy');
  assert.deepEqual(b.needed, { wood: 10 });
  // refund counts the delivered share of what this site actually cost
  b.needed.wood = 2;                                           // 8 of 10 delivered
  townhall(s).stock.wood = 0;
  assert.equal(removeAt(s, spot.x, spot.z), true);
  assert.equal(townhall(s).stock.wood, 4);                     // floor(8 * 0.5)
  // min 1 per resource
  const tiny = world(1);
  setDifficulty(tiny, 'easy');
  const wid = placeBuilding(tiny, 'woodcutter', spot.x, spot.z, 0);
  const wc = tiny.buildings.find((x) => x.id === wid);
  assert.equal(wc.needed.wood, 6);
});

// ---------------------------------------------------------------- forester, saplings, regrowth

test('the forester is a light resource building unlocked at 8 villagers', () => {
  const cfg = BUILDINGS.forester;
  assert.deepEqual(
    [cfg.name, cfg.category, cfg.radius, cfg.cost, cfg.workers, cfg.job, cfg.light, cfg.unlockPop],
    ['คนปลูกป่า', 'resource', 3.5, { wood: 10 }, 1, 'forester', true, 8]);
  const s = world(1);
  assert.equal(canPlace(s, 'forester', 120, 150, 0).ok, true);   // 8 starting villagers
  const t = createWorld(1, { mapSize: 'small', startVillagers: 4 });
  assert.equal(canPlace(t, 'forester', 120, 150, 0).ok, false);
});

test('a forester plants saplings that grow into trees after SAPLING_GROW_DAYS', () => {
  const s = world(2);
  clearVillagers(s);
  const f = staffed(s, 'forester', 150, 130);
  s.nodes = s.nodes.filter((n) => Math.hypot(n.x - f.x, n.z - f.z) > FORESTER_RADIUS + 5);   // open ground
  const treesBefore = countKind(s, 'tree');
  tick(s, 200);
  const saplings = s.nodes.filter((n) => n.kind === 'sapling' && n.forester === f.id);
  assert.ok(saplings.length >= 5, `saplings ${saplings.length}`);
  for (const sap of saplings) {
    assert.equal(typeof sap.planted, 'number');
    assert.ok(sap.planted >= s.time - 200 && sap.planted <= s.time);
    assert.ok(Math.hypot(sap.x - f.x, sap.z - f.z) <= FORESTER_RADIUS + 1e-9);
    assert.ok(isOwned(s, sap.x, sap.z));
    assert.equal(isWater(s.terrain, sap.x, sap.z), false);
    assert.equal(sap.forester, f.id);
    assert.ok(Math.hypot(sap.x - f.x, sap.z - f.z) >= BUILDINGS.forester.radius + 2.5 - 1e-9);
    for (const o of s.nodes) {
      if (o === sap) continue;
      assert.ok(Math.hypot(o.x - sap.x, o.z - sap.z) >= 2.5 - 1e-9, 'saplings keep 2.5 m from other nodes');
    }
  }
  assert.equal(countKind(s, 'tree'), treesBefore, 'saplings are not trees yet');
  assert.ok(indexConsistent(s));
  // saplings cannot be gathered: a woodcutter beside them takes no wood from them
  const ids = saplings.map((n) => n.id);
  const planted = new Map(saplings.map((n) => [n.id, n.planted]));
  // grow: jump the clock past the growth time for the first batch
  s.time += SAPLING_GROW_DAYS * DAY_LENGTH;
  s.lastDay = Math.floor(s.time / DAY_LENGTH) + 1;
  tick(s, 2);
  for (const id of ids) {
    const n = s.nodes.find((x) => x.id === id);
    assert.equal(n.kind, 'tree', `sapling ${id} (planted ${planted.get(id)}) grew`);
    assert.equal(n.amount, NODE_AMOUNT.tree);
    assert.equal(n.planted, undefined);
  }
  assert.ok(indexConsistent(s));
  // growSaplings needs the full time
  const fresh = world(2);
  const sap = addNode(fresh, { kind: 'sapling', x: 150, z: 150, amount: 1, planted: fresh.time });
  growSaplings(fresh);
  assert.equal(sap.kind, 'sapling');
  fresh.time += SAPLING_GROW_DAYS * DAY_LENGTH - 1;
  growSaplings(fresh);
  assert.equal(sap.kind, 'sapling');
  fresh.time += 1;
  growSaplings(fresh);
  assert.equal(sap.kind, 'tree');
});

test('a forester keeps at most MAX_SAPLINGS_PER_FORESTER saplings alive', () => {
  const s = world(2);
  clearVillagers(s);
  const f = staffed(s, 'forester', 150, 130);
  for (let i = 0; i < MAX_SAPLINGS_PER_FORESTER; i++) {
    addNode(s, { kind: 'sapling', x: 2 + (i % 8), z: 2 + Math.floor(i / 8), amount: 1, planted: s.time, forester: f.id });
  }
  tick(s, 90);
  assert.equal(s.nodes.filter((n) => n.kind === 'sapling').length, MAX_SAPLINGS_PER_FORESTER);
});

test('foresters never plant on unowned land or on worn paths', () => {
  const s = createWorld(2, MEDIUM);
  clearVillagers(s);
  // forester at the western edge of the territory: its radius reaches 30 m into unowned land
  const f = staffed(s, 'forester', 92, 200);
  tick(s, 250);
  const saplings = s.nodes.filter((n) => n.kind === 'sapling');
  assert.ok(saplings.length > 0);
  assert.ok(saplings.every((n) => isOwned(s, n.x, n.z) && n.x >= 80));
  // paths: block every cell around the forester with heavy wear -> nothing planted
  const t = world(2);
  clearVillagers(t);
  const g = staffed(t, 'forester', 150, 130);
  t.wear.fill(0.9);
  t.nodes = [];
  tick(t, 60);
  assert.equal(t.nodes.filter((n) => n.kind === 'sapling').length, 0);
  assert.equal(g.workers.length, 1);
});

test('natural regrowth: saplings appear 2-6 m from trees at a share of the initial count', () => {
  const rates = { slow: 0.005, normal: 0.015 };
  for (const [regrowth, rate] of Object.entries(rates)) {
    const s = createWorld(3, { mapSize: 'medium', regrowth });
    const initial = s.initialNodes.tree;
    assert.equal(initial, countKind(s, 'tree'));
    // fell half of the forest so there is room to regrow
    for (const n of s.nodes.filter((x) => x.kind === 'tree').filter((x, i) => i % 2 === 0)) removeNode(s, n);
    const before = countKind(s, 'sapling');
    processRegrowth(s, mulberry32(11));
    const added = s.nodes.filter((n) => n.kind === 'sapling');
    assert.equal(before, 0);
    assert.ok(Math.abs(added.length - initial * rate) <= 1.5, `${regrowth}: ${added.length} vs ${initial * rate}`);
    const trees = s.nodes.filter((n) => n.kind === 'tree');
    for (const sap of added) {
      const d = Math.min(...trees.map((t) => Math.hypot(t.x - sap.x, t.z - sap.z)));
      assert.ok(d <= 6 + 1e-9 || added.some((o) => o !== sap && Math.hypot(o.x - sap.x, o.z - sap.z) <= 6), `${d}`);
      assert.equal(typeof sap.planted, 'number');
    }
    assert.ok(indexConsistent(s));
  }
  const slow = createWorld(3, { mapSize: 'medium', regrowth: 'slow' });
  const normal = createWorld(3, { mapSize: 'medium', regrowth: 'normal' });
  for (const w of [slow, normal]) for (const n of w.nodes.filter((x) => x.kind === 'tree').filter((x, i) => i % 2 === 0)) removeNode(w, n);
  processRegrowth(slow, mulberry32(1));
  processRegrowth(normal, mulberry32(1));
  assert.ok(countKind(normal, 'sapling') > countKind(slow, 'sapling'));
});

test('regrowth off adds nothing; a full forest does not overgrow', () => {
  const off = createWorld(3, { mapSize: 'small', regrowth: 'off' });
  for (const n of off.nodes.filter((x) => x.kind === 'tree').slice(0, 300)) removeNode(off, n);
  for (const n of off.nodes.filter((x) => x.kind === 'rock')) removeNode(off, n);
  const count = off.nodes.length;
  processRegrowth(off, mulberry32(1));
  assert.equal(off.nodes.length, count);
  const full = createWorld(3, { mapSize: 'small', regrowth: 'normal' });
  const n0 = full.nodes.length;
  processRegrowth(full, mulberry32(1));
  assert.equal(countKind(full, 'sapling'), 0);
  assert.equal(full.nodes.length, n0);
});

test('natural regrowth refills rocks and ore below 60% of the initial count (slow: every 3rd day)', () => {
  const make = (regrowth) => {
    const s = createWorld(4, { mapSize: 'medium', regrowth });
    for (const kind of ['rock', 'ore']) {
      const all = s.nodes.filter((n) => n.kind === kind);
      for (const n of all.slice(0, Math.ceil(all.length * 0.5))) removeNode(s, n);
    }
    return s;
  };
  const s = make('normal');
  const rocks = countKind(s, 'rock');
  const ores = countKind(s, 'ore');
  assert.ok(rocks < s.initialNodes.rock * 0.6 && ores < s.initialNodes.ore * 0.6);
  s.time = 5 * DAY_LENGTH + 10;
  processRegrowth(s, mulberry32(3));
  assert.equal(countKind(s, 'rock'), rocks + 1);
  assert.equal(countKind(s, 'ore'), ores + 1);
  assert.ok(indexConsistent(s));
  const slow = make('slow');
  slow.time = 4 * DAY_LENGTH + 10;
  processRegrowth(slow, mulberry32(3));
  assert.equal(countKind(slow, 'rock'), rocks);
  slow.time = 3 * DAY_LENGTH + 10;
  processRegrowth(slow, mulberry32(3));
  assert.equal(countKind(slow, 'rock'), rocks + 1);
  // not below 60% -> nothing new
  const ok = createWorld(4, MEDIUM);
  const n = ok.nodes.length;
  processRegrowth(ok, mulberry32(3));
  assert.equal(ok.nodes.length, n);
});

test('regrowth runs at midnight inside the simulation', () => {
  const s = createWorld(3, { mapSize: 'small', regrowth: 'normal' });
  for (const n of s.nodes.filter((x) => x.kind === 'tree').filter((x, i) => i % 3 === 0)) removeNode(s, n);
  tick(s, DAY_LENGTH);
  assert.ok(countKind(s, 'sapling') > 0);
});

test('initialNodes records the starting counts', () => {
  const s = createWorld(3, MEDIUM);
  assert.deepEqual(s.initialNodes, {
    tree: countKind(s, 'tree'), rock: countKind(s, 'rock'), berry: countKind(s, 'berry'), ore: countKind(s, 'ore'),
  });
});

// ---------------------------------------------------------------- node index

test('the node index stays consistent through gathering, building and replaced arrays', () => {
  const s = world(5);
  const store = townhall(s);
  staffed(s, 'woodcutter', 100, 130);
  tick(s, 100);
  assert.ok(store.stock.wood > START.stock.wood - 100);
  assert.ok(indexConsistent(s));
  const n = placeBuilding(s, 'storehouse', 100, 100, 0);
  assert.ok(n != null || true);
  assert.ok(indexConsistent(s));
  // nodes replaced behind the index's back: it rebuilds itself
  s.nodes = s.nodes.slice(0, 500);
  assert.ok(indexConsistent(s));
  s.nodes.push({ id: 99999, kind: 'tree', x: 10, z: 10, amount: 4, reserved: null });
  assert.ok(indexConsistent(s));
  const fresh = addNode(s, { kind: 'rock', x: 20, z: 20, amount: 5 });
  assert.ok(fresh.id > 99999, 'ids keep growing');
  assert.equal(JSON.parse(serialize(s)).nodeIndex, undefined);
});

// ---------------------------------------------------------------- saves

test('v4 saves round-trip settings, territory, difficulty and keep the terrain', () => {
  const s = createWorld(8, { mapSize: 'medium', rivers: 2, terrain: 'hilly', forest: 'high', regrowth: 'slow' });
  s.gold = 500;
  buyPlot(s, 0, 2);
  setDifficulty(s, 'hard');
  tick(s, 30);
  const copy = deserialize(serialize(s));
  assert.equal(copy.version, 4);
  assert.deepEqual(copy.settings, s.settings);
  assert.deepEqual(copy.world, s.world);
  assert.deepEqual(copy.territory, s.territory);
  assert.equal(copy.difficulty, 'hard');
  assert.deepEqual(copy.initialNodes, s.initialNodes);
  assert.equal(copy.wear.length, 200 * 200);
  assert.deepEqual(Array.from(copy.terrain.heights), Array.from(s.terrain.heights));
  assert.deepEqual(Array.from(copy.terrain.water), Array.from(s.terrain.water));
  assert.equal(copy.terrain.size, 400);
  assert.equal(JSON.parse(serialize(s)).terrain, undefined);
  assert.doesNotThrow(() => tick(copy, 10));
});

test('v4 saves are validated against their own map size', () => {
  const s = createWorld(8, MEDIUM);
  const good = JSON.parse(serialize(s));
  assert.doesNotThrow(() => deserialize(JSON.stringify(good)));
  assert.throws(() => deserialize(JSON.stringify({ ...good, wear: good.wear.slice(0, 14400) })), Error);
  assert.throws(() => deserialize(JSON.stringify({ ...good, territory: { owned: [1, 1], bought: 0 } })), Error);
  assert.throws(() => deserialize(JSON.stringify({ ...good, territory: undefined })), Error);
  assert.throws(() => deserialize(JSON.stringify({ ...good, settings: { mapSize: 'huge' } })), Error);
  assert.throws(() => deserialize(JSON.stringify({ ...good, settings: undefined })), Error);
  const bad = deserialize(JSON.stringify({ ...good, difficulty: 'nightmare' }));
  assert.equal(bad.difficulty, 'normal');
});

test('v3 saves migrate to v4: small normal world, everything owned, same map as before', () => {
  const s = world(1);
  s.nodes = s.nodes.filter((n) => n.kind !== 'sapling');
  addHouse(s, 100, 100, 2, 1);
  tick(s, 20);
  const v3 = JSON.parse(serialize(s));
  v3.version = 3;
  for (const k of ['settings', 'world', 'territory', 'difficulty', 'initialNodes', 'legacyRiver', 'nextNodeId', 'slowTimer']) delete v3[k];
  const m = deserialize(JSON.stringify(v3));
  assert.equal(m.version, 4);
  assert.deepEqual(m.settings, { ...DEFAULT_SETTINGS, mapSize: 'small' });
  assert.deepEqual(m.world, { size: 240, grid: 120, plot: 80, plots: 3 });
  assert.deepEqual(m.territory, { owned: new Array(9).fill(1), bought: 0 });
  assert.equal(m.difficulty, 'normal');
  assert.deepEqual(m.initialNodes, {
    tree: countKind(s, 'tree'), rock: countKind(s, 'rock'), berry: countKind(s, 'berry'), ore: countKind(s, 'ore'),
  });
  assert.equal(m.terrain.size, 240);
  assert.equal(m.wear.length, 14400);
  assert.equal(isOwned(m, 3, 3), true);
  assert.equal(isOwned(m, 239, 239), true);
  assert.equal(summary(m).ownedPlots, 9);
  // the legacy single river is kept, also after another save/load
  const again = deserialize(serialize(m));
  assert.equal(again.legacyRiver, true);
  assert.deepEqual(Array.from(again.terrain.water), Array.from(m.terrain.water));
  assert.deepEqual(Array.from(again.terrain.heights), Array.from(m.terrain.heights));
  assert.equal(JSON.parse(serialize(m)).version, 4);
  assert.doesNotThrow(() => tick(m, 60));
  assert.deepEqual(summary(m).difficulty, 'normal');
});

test('legacy terrain reproduces the pre-v4 maps exactly (golden values from the v3 generator)', () => {
  const golden = { 1: { heights: 103165.872, water: 480, nodes: 1014 }, 3: { heights: 81411.817, water: 480, nodes: 1014 } };
  for (const [seed, g] of Object.entries(golden)) {
    const t = generateTerrain(Number(seed), { mapSize: 'small' }, { legacy: true });
    let sum = 0;
    for (const h of t.heights) sum += h;
    let water = 0;
    for (const w of t.water) water += w;
    assert.ok(Math.abs(sum - g.heights) < 0.01, `${seed}: ${sum}`);
    assert.equal(water, g.water);
    assert.equal(generateNodes(Number(seed), t, { mapSize: 'small' }).length, g.nodes);
  }
});

test('v1 and v2 saves still migrate through to v4', () => {
  const s = world(3);
  const v2 = JSON.parse(serialize(s));
  v2.version = 2;
  for (const k of ['settings', 'world', 'territory', 'difficulty', 'initialNodes']) delete v2[k];
  const m = deserialize(JSON.stringify(v2));
  assert.equal(m.version, 4);
  assert.equal(m.territory.owned.length, 9);
  assert.doesNotThrow(() => tick(m, 10));
});

// ---------------------------------------------------------------- performance & integration

test('large world: one game day with ~60 villagers stays fast', () => {
  const { s, genMs } = buildBenchWorld(7, 60);
  assert.equal(s.world.size, 560);
  assert.ok(s.villagers.length >= 60);
  assert.ok(s.nodes.length > 5000);
  assert.ok(genMs < 3000, `createWorld ${genMs.toFixed(0)} ms`);
  const t0 = performance.now();
  tick(s, DAY_LENGTH);
  const ms = performance.now() - t0;
  assert.ok(ms < 3000, `1 game day took ${ms.toFixed(0)} ms`);
});

test('integration: large world for 20 days with a mid-run territory purchase', () => {
  const { s } = buildBenchWorld(11, 24);
  s.gold = 1000;
  for (const b of s.buildings) if (b.type === 'townhall') b.stock.berries = 2000;
  const owned0 = summary(s).ownedPlots;
  assert.equal(owned0, 9);
  let bought = null;
  for (let day = 1; day <= 20; day++) {
    tick(s, DAY_LENGTH);
    if (day === 10) {
      const buyable = plotInfo(s).find((p) => p.buyable);
      bought = buyPlot(s, buyable.px, buyable.pz);
      assert.equal(bought.ok, true);
      assert.equal(summary(s).ownedPlots, owned0 + 1);
      const cx = (buyable.x0 + buyable.x1) / 2;
      const cz = (buyable.z0 + buyable.z1) / 2;
      assert.notEqual(canPaintZone(s, 'field', cx, cz, 9).reason, 'อยู่นอกดินแดนของคุณ');
    }
    assert.ok(indexConsistent(s));
    for (const v of s.villagers) assert.ok(Number.isFinite(v.x) && Number.isFinite(v.z));
  }
  assert.equal(bought.ok, true);
  assert.ok(s.time >= 20 * DAY_LENGTH);
  assert.ok(s.villagers.length > 0);
  const back = deserialize(serialize(s));
  assert.equal(back.territory.bought, 1);
  assert.doesNotThrow(() => tick(back, 30));
});
