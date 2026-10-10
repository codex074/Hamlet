// Benchmark: 'large' world (560 m), ~60 villagers, one game day. Run: node scripts/bench.mjs
import { createWorld, tick, placeBuilding, paintZone } from '../src/sim.js';
import { createVillager } from '../src/villagers.js';
import { DAY_LENGTH, BUILDINGS } from '../src/config.js';
import { spawnOf } from '../src/world.js';
import { addBuilt, findPlaceSpot, findZoneSpot, staffVillage } from '../tests/helpers.js';

export function buildBenchWorld(seed = 7, villagers = 60) {
  const t0 = performance.now();
  const s = createWorld(seed, { mapSize: 'large', forest: 'high', startVillagers: 12 });
  const genMs = performance.now() - t0;
  const c = spawnOf(s);
  for (let i = s.villagers.length; i < villagers; i++) {
    const v = createVillager(s, c.x + (i % 8) * 1.5, c.z + Math.floor(i / 8) * 1.5);
    s.villagers.push(v);
  }
  for (const b of s.buildings) if (b.type === 'townhall') for (const r of Object.keys(b.stock)) b.stock[r] = 400;
  s.gold = 5000;
  const place = (type, dx, dz) => {
    const p = findPlaceSpot(s, type, c.x + dx, c.z + dz, 80);
    if (p) addBuilt(s, type, p.x, p.z);
  };
  place('storehouse', -20, 0);
  for (const [t, n] of [['woodcutter', 3], ['forager', 2], ['quarry', 2], ['hunter', 1], ['forester', 2], ['sawmill', 1],
    ['chapel', 1], ['farmhouse', 1], ['fishery', 1], ['sheepfarm', 1]]) {
    for (let i = 0; i < n; i++) place(t, -40 + i * 18, 25 + (i % 3) * 14);
  }
  const z = findZoneSpot(s, 'residential', 12, c.x + 25, c.z, 60);
  if (z) paintZone(s, 'residential', z.x, z.z, 12);
  const f = findZoneSpot(s, 'field', 12, c.x - 25, c.z - 20, 60);
  if (f) paintZone(s, 'field', f.x, f.z, 12);
  staffVillage(s, 6);
  return { s, genMs };
}

if (process.argv[1] && process.argv[1].endsWith('bench.mjs')) {
  const { s, genMs } = buildBenchWorld();
  console.log(`createWorld(large): ${genMs.toFixed(0)} ms, ${s.nodes.length} nodes, ${s.villagers.length} villagers, ${s.buildings.length} buildings`);
  const t0 = performance.now();
  tick(s, DAY_LENGTH);
  const ms = performance.now() - t0;
  console.log(`1 game day: ${ms.toFixed(0)} ms (pop ${s.villagers.length}, nodes ${s.nodes.length})`);
  const t1 = performance.now();
  tick(s, DAY_LENGTH);
  console.log(`2nd game day: ${(performance.now() - t1).toFixed(0)} ms (pop ${s.villagers.length})`);
}
