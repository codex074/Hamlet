// Harvest orders: the player paints over trees, rocks and ore veins to mark them; villagers without a job
// (and builders with nothing to build) walk to the nearest marked node, gather it and carry the goods to
// the nearest storage. This replaces the woodcutter and iron mine buildings; surface rocks are finite, after
// that stone comes from the quarry (jobs.js). Pure: no DOM, no globals.
import { BUILDINGS, ZONE_BRUSH } from './config.js';
import { distance, nearestStorage } from './economy.js';
import { nodesWithin } from './nodeindex.js';
import { isOwned } from './territory.js';
import { gotoPoint, gotoBuilding } from './taskutil.js';

// What each kind of node yields per trip and how long one trip's work takes (from the retired buildings).
export const HARVEST = {
  tree: { res: 'wood', n: BUILDINGS.woodcutter.output.wood, time: BUILDINGS.woodcutter.time, name: 'ต้นไม้' },
  rock: { res: 'stone', n: 3, time: 8, name: 'ก้อนหิน' },
  ore: { res: 'ore', n: BUILDINGS.ironmine.output.ore, time: BUILDINGS.ironmine.time, name: 'สายแร่' },
};
export const HARVEST_BRUSHES = ['harvest', 'unharvest'];

const harvestable = (n) => HARVEST[n.kind] != null && n.amount >= 1;

// Nodes under the brush that this stroke would change.
function brushNodes(state, x, z, r, mark) {
  return nodesWithin(state, x, z, r)
    .filter((n) => harvestable(n) && !!n.marked !== mark && isOwned(state, n.x, n.z));
}

export function canMark(state, kind, x, z, r) {
  if (r < ZONE_BRUSH.min || r > ZONE_BRUSH.max) return { ok: false, reason: 'ขนาดแปรงไม่ถูกต้อง' };
  const mark = kind === 'harvest';
  if (brushNodes(state, x, z, r, mark).length > 0) return { ok: true };
  const any = nodesWithin(state, x, z, r).some(harvestable);
  if (!any) return { ok: false, reason: 'ไม่มีต้นไม้ ก้อนหิน หรือสายแร่ตรงนี้' };
  return { ok: false, reason: mark ? 'เลือกไว้หมดแล้ว (หรืออยู่นอกดินแดน)' : 'ไม่มีอะไรถูกเลือกไว้ตรงนี้' };
}

// Marks (kind 'harvest') or clears (kind 'unharvest') every harvestable node under the brush.
// Returns how many nodes changed.
export function markResources(state, kind, x, z, r) {
  const mark = kind === 'harvest';
  const nodes = brushNodes(state, x, z, r, mark);
  for (const n of nodes) {
    if (mark) n.marked = true;
    else delete n.marked;
  }
  if (nodes.length) state.markVersion = (state.markVersion ?? 0) + 1;
  return nodes.length;
}

export function markedNodes(state) {
  return state.nodes.filter((n) => n.marked && harvestable(n));
}

// Counts per kind for the HUD: { tree, rock, ore, total }.
export function harvestSummary(state) {
  const out = { tree: 0, rock: 0, ore: 0, total: 0 };
  for (const n of state.nodes) {
    if (!n.marked || !harvestable(n)) continue;
    out[n.kind] += 1;
    out.total += 1;
  }
  return out;
}

// Sends v to the nearest free marked node; false when there is nothing to harvest (or no storage).
export function planHarvest(state, v) {
  let best = null;
  let bestD = Infinity;
  for (const n of state.nodes) {
    if (!n.marked || n.reserved != null || !harvestable(n) || !isOwned(state, n.x, n.z)) continue;
    const d = distance(v.x, v.z, n.x, n.z);
    if (d < bestD) { best = n; bestD = d; }
  }
  if (!best) return false;
  const store = nearestStorage(state, best.x, best.z);
  if (!store) return false;
  const h = HARVEST[best.kind];
  best.reserved = v.id;
  v.res.nodeId = best.id;
  v.queue.push(
    gotoPoint(best.x, best.z),
    { kind: 'gather', nodeId: best.id, t: h.time, out: { [h.res]: h.n }, keep: false },
    gotoBuilding(store, best.x, best.z),
    { kind: 'put', bId: store.id },
  );
  return true;
}

