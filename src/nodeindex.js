// Spatial index over state.nodes (8 m buckets, one table per node kind) and the only place that adds or
// removes nodes. The index lives on a non-enumerable property (never serialised) and rebuilds itself if
// state.nodes was replaced or resized behind its back (tests, migrations). Pure: no DOM, no globals.

const BUCKET = 8;
const STRIDE = 4096;

const key = (bx, bz) => bz * STRIDE + bx;
const bucketOf = (v) => Math.max(0, Math.floor(v / BUCKET));

function build(state) {
  const idx = { arr: state.nodes, len: state.nodes.length, kinds: new Map(), byId: new Map() };
  let maxId = 0;
  for (const n of state.nodes) {
    insert(idx, n);
    if (n.id > maxId) maxId = n.id;
  }
  state.nextNodeId = Math.max(state.nextNodeId ?? 1, maxId + 1);
  Object.defineProperty(state, 'nodeIndex', { value: idx, writable: true, configurable: true, enumerable: false });
  return idx;
}

function insert(idx, n) {
  let table = idx.kinds.get(n.kind);
  if (!table) idx.kinds.set(n.kind, (table = new Map()));
  const k = key(bucketOf(n.x), bucketOf(n.z));
  const list = table.get(k);
  if (list) list.push(n);
  else table.set(k, [n]);
  idx.byId.set(n.id, n);
}

function unlink(idx, n, kind = n.kind) {
  const table = idx.kinds.get(kind);
  const k = key(bucketOf(n.x), bucketOf(n.z));
  const list = table?.get(k);
  if (list) {
    const i = list.indexOf(n);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) table.delete(k);
  }
  idx.byId.delete(n.id);
}

export function getIndex(state) {
  const idx = state.nodeIndex;
  if (idx && idx.arr === state.nodes && idx.len === state.nodes.length) return idx;
  return build(state);
}

export function getNode(state, id) {
  return getIndex(state).byId.get(id) ?? null;
}

// Adds a node (id assigned if missing) and returns it.
export function addNode(state, node) {
  const idx = getIndex(state);
  if (node.id == null) node.id = state.nextNodeId;
  state.nextNodeId = Math.max(state.nextNodeId, node.id + 1);
  node.reserved ??= null;
  state.nodes.push(node);
  idx.len = state.nodes.length;
  insert(idx, node);
  return node;
}

export function removeNode(state, node) {
  const idx = getIndex(state);
  const i = state.nodes.lastIndexOf(node);
  if (i < 0) return false;
  state.nodes.splice(i, 1);
  idx.len = state.nodes.length;
  unlink(idx, node);
  return true;
}

// Changes a node's kind (sapling -> tree) keeping the index consistent.
export function setNodeKind(state, node, kind) {
  const idx = getIndex(state);
  unlink(idx, node);
  node.kind = kind;
  insert(idx, node);
}

// Nodes of `kind` whose centre lies within `radius` of (x, z), unordered.
export function nodesNear(state, kind, x, z, radius) {
  const table = getIndex(state).kinds.get(kind);
  const out = [];
  if (!table) return out;
  const r2 = radius * radius;
  const b0x = bucketOf(x - radius);
  const b1x = bucketOf(x + radius);
  const b0z = bucketOf(z - radius);
  const b1z = bucketOf(z + radius);
  for (let bz = b0z; bz <= b1z; bz++) {
    for (let bx = b0x; bx <= b1x; bx++) {
      const list = table.get(key(bx, bz));
      if (!list) continue;
      for (const n of list) {
        const dx = n.x - x;
        const dz = n.z - z;
        if (dx * dx + dz * dz <= r2) out.push(n);
      }
    }
  }
  return out;
}

// Nodes of every kind within `radius` of (x, z) (strictly closer), unordered.
export function nodesWithin(state, x, z, radius) {
  const out = [];
  const r2 = radius * radius;
  const b0x = bucketOf(x - radius);
  const b1x = bucketOf(x + radius);
  const b0z = bucketOf(z - radius);
  const b1z = bucketOf(z + radius);
  for (const table of getIndex(state).kinds.values()) {
    for (let bz = b0z; bz <= b1z; bz++) {
      for (let bx = b0x; bx <= b1x; bx++) {
        const list = table.get(key(bx, bz));
        if (!list) continue;
        for (const n of list) {
          const dx = n.x - x;
          const dz = n.z - z;
          if (dx * dx + dz * dz < r2) out.push(n);
        }
      }
    }
  }
  return out;
}

// True if any node (any kind) lies strictly closer than `dist` to (x, z).
export function anyNodeWithin(state, x, z, dist) {
  const idx = getIndex(state);
  const d2 = dist * dist;
  const b0x = bucketOf(x - dist);
  const b1x = bucketOf(x + dist);
  const b0z = bucketOf(z - dist);
  const b1z = bucketOf(z + dist);
  for (const table of idx.kinds.values()) {
    for (let bz = b0z; bz <= b1z; bz++) {
      for (let bx = b0x; bx <= b1x; bx++) {
        const list = table.get(key(bx, bz));
        if (!list) continue;
        for (const n of list) {
          const dx = n.x - x;
          const dz = n.z - z;
          if (dx * dx + dz * dz < d2) return true;
        }
      }
    }
  }
  return false;
}

// All nodes of a kind (array copy).
export function nodesOfKind(state, kind) {
  const table = getIndex(state).kinds.get(kind);
  const out = [];
  if (table) for (const list of table.values()) out.push(...list);
  return out;
}
