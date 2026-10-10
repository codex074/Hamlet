// Saplings growing into trees, and natural regrowth of trees, rocks and ore at midnight.
// Pure: no DOM, no globals.
import {
  DAY_LENGTH, EDGE_MARGIN, SPAWN_CLEAR_RADIUS, BUILDINGS, REGROW_TREE_RATE, REGROW_ROCK_BELOW,
  REGROW_ROCK_EVERY, SAPLING_GROW_DAYS,
} from './config.js';
import { heightAt, isWater, oreHeightThreshold } from './terrain.js';
import { sizeOf, spawnOf } from './world.js';
import { nodeAmountFor } from './settings.js';
import { addNode, anyNodeWithin, nodesOfKind, setNodeKind } from './nodeindex.js';

const TREE_GAP = 1.6;
const ROCK_GAP = 4;
const ORE_GAP = 6;
const TRIES = 40;
const SAPLING_NEAR = [2, 6];      // natural saplings appear this far from a tree
const HOUSE_PAD = 1;

// Turns saplings older than SAPLING_GROW_DAYS game days into trees.
export function growSaplings(state) {
  const grown = SAPLING_GROW_DAYS * DAY_LENGTH;
  const amount = nodeAmountFor(state.settings, 'tree');
  for (const n of nodesOfKind(state, 'sapling')) {
    if (state.time - (n.planted ?? 0) < grown) continue;
    setNodeKind(state, n, 'tree');
    n.amount = amount;
    delete n.planted;
    delete n.forester;
  }
}

function blocked(state, x, z, gap) {
  const size = sizeOf(state);
  if (x < EDGE_MARGIN || z < EDGE_MARGIN || x > size - EDGE_MARGIN || z > size - EDGE_MARGIN) return true;
  if (isWater(state.terrain, x, z) || anyNodeWithin(state, x, z, gap)) return true;
  for (const b of state.buildings) {
    if (Math.hypot(x - b.x, z - b.z) < BUILDINGS[b.type].radius + HOUSE_PAD) return true;
  }
  for (const zone of state.zones) if (Math.hypot(x - zone.x, z - zone.z) < zone.r) return true;
  return false;
}

function spawnNode(state, kind, x, z, extra = {}) {
  return addNode(state, { kind, x, z, amount: kind === 'sapling' ? 1 : nodeAmountFor(state.settings, kind),
    reserved: null, ...extra });
}

function naturalSaplings(state, rand) {
  const rate = REGROW_TREE_RATE[state.settings.regrowth];
  const initial = state.initialNodes?.tree ?? 0;
  const trees = nodesOfKind(state, 'tree');
  const standing = trees.length + nodesOfKind(state, 'sapling').length;
  if (!rate || trees.length === 0 || standing >= initial) return;
  let want = initial * rate;
  want = Math.floor(want) + (rand() < want - Math.floor(want) ? 1 : 0);
  want = Math.min(want, initial - standing);
  for (let made = 0; made < want; made++) {
    for (let i = 0; i < TRIES; i++) {
      const tree = trees[Math.floor(rand() * trees.length) % trees.length];
      const ang = rand() * Math.PI * 2;
      const rad = SAPLING_NEAR[0] + rand() * (SAPLING_NEAR[1] - SAPLING_NEAR[0]);
      const x = tree.x + Math.cos(ang) * rad;
      const z = tree.z + Math.sin(ang) * rad;
      if (blocked(state, x, z, TREE_GAP)) continue;
      spawnNode(state, 'sapling', x, z, { planted: state.time });
      break;
    }
  }
}

function randomSpot(state, rand, gap, spotOk) {
  const size = sizeOf(state);
  const spawn = spawnOf(state);
  for (let i = 0; i < TRIES; i++) {
    const x = EDGE_MARGIN + rand() * (size - 2 * EDGE_MARGIN);
    const z = EDGE_MARGIN + rand() * (size - 2 * EDGE_MARGIN);
    if (Math.hypot(x - spawn.x, z - spawn.z) <= SPAWN_CLEAR_RADIUS) continue;
    if (spotOk && !spotOk(x, z)) continue;
    if (!blocked(state, x, z, gap)) return { x, z };
  }
  return null;
}

function refillMinerals(state, rand) {
  const initial = state.initialNodes ?? {};
  const every = REGROW_ROCK_EVERY[state.settings.regrowth] ?? 1;
  if (Math.floor(state.time / DAY_LENGTH) % every !== 0) return;
  const rocks = nodesOfKind(state, 'rock').length;
  if (initial.rock > 0 && rocks < initial.rock * REGROW_ROCK_BELOW) {
    const p = randomSpot(state, rand, ROCK_GAP);
    if (p) spawnNode(state, 'rock', p.x, p.z);
  }
  const ores = nodesOfKind(state, 'ore').length;
  if (initial.ore > 0 && ores < initial.ore * REGROW_ROCK_BELOW) {
    const minH = oreHeightThreshold(state.terrain);
    const p = randomSpot(state, rand, ORE_GAP, (x, z) => heightAt(state.terrain, x, z) >= minH);
    if (p) spawnNode(state, 'ore', p.x, p.z);
  }
}

// Called once per midnight; saplings/trees/rocks/ore appear according to settings.regrowth.
export function processRegrowth(state, rand) {
  if (!state.settings || state.settings.regrowth === 'off') return;
  naturalSaplings(state, rand);
  refillMinerals(state, rand);
}

export function countNodes(nodes) {
  const c = { tree: 0, rock: 0, berry: 0, ore: 0 };
  for (const n of nodes) if (n.kind in c) c[n.kind] += 1;
  return c;
}
