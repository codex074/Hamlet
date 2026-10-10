import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  samplePoints, footprintOK, canPlace, canPaintZone, nodesUnder, findHouseSite,
} from '../src/placement.js';
import { BUILDINGS } from '../src/config.js';

const geo = { heightAt: () => 1, isWater: (t, x) => x > 200 };

function makeState(extra = {}) {
  return { terrain: {}, buildings: [], zones: [], nodes: [], ...extra };
}

function seqRand(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

test('samplePoints returns centre plus 8 points on the circle', () => {
  const pts = samplePoints(10, 20, 5);
  assert.equal(pts.length, 9);
  assert.deepEqual(pts[0], [10, 20]);
  for (const [px, pz] of pts.slice(1)) {
    assert.ok(Math.abs(Math.hypot(px - 10, pz - 20) - 5) < 1e-9);
  }
});

test('footprintOK accepts a valid placement', () => {
  assert.deepEqual(footprintOK(makeState(), 100, 100, 3, {}, geo), { ok: true });
});

test('footprintOK rejects outside the map', () => {
  const s = makeState();
  assert.equal(footprintOK(s, 5, 100, 3, {}, geo).reason, 'นอกแผนที่');
  assert.equal(footprintOK(s, 100, 5, 3, {}, geo).reason, 'นอกแผนที่');
  assert.equal(footprintOK(s, 100, 237, 3, {}, geo).reason, 'นอกแผนที่');
  assert.equal(footprintOK(s, 237, 100, 3, {}, geo).reason, 'นอกแผนที่');
});

test('footprintOK rejects water', () => {
  const r = footprintOK(makeState(), 201, 100, 3, {}, geo);
  assert.deepEqual(r, { ok: false, reason: 'อยู่บนน้ำ' });
  // only the rim touches water
  assert.equal(footprintOK(makeState(), 198, 100, 3, {}, geo).reason, 'อยู่บนน้ำ');
});

test('footprintOK rejects steep ground', () => {
  const steep = { heightAt: (t, x) => (x > 100 ? 5 : 1), isWater: () => false };
  const r = footprintOK(makeState(), 100, 100, 3, {}, steep);
  assert.deepEqual(r, { ok: false, reason: 'พื้นชันเกินไป' });
});

test('footprintOK rejects overlap with a building and honours ignoreId', () => {
  const s = makeState({ buildings: [{ id: 7, type: 'house', x: 100, z: 100, rot: 0 }] });
  // 3 + 3 + 0.5 = 6.5 required distance
  assert.equal(footprintOK(s, 106, 100, 3, {}, geo).reason, 'ทับอาคารอื่น');
  assert.equal(footprintOK(s, 106.6, 100, 3, {}, geo).ok, true);
  assert.equal(footprintOK(s, 106, 100, 3, { ignoreId: 7 }, geo).ok, true);
});

test('footprintOK rejects zone overlap unless ignoreZones', () => {
  const s = makeState({ zones: [{ id: 1, kind: 'residential', x: 100, z: 100, r: 9 }] });
  assert.equal(footprintOK(s, 105, 100, 3, {}, geo).reason, 'ทับโซน');
  assert.equal(footprintOK(s, 105, 100, 3, { ignoreZones: true }, geo).ok, true);
  assert.equal(footprintOK(s, 112.1, 100, 3, {}, geo).ok, true);
});

test('canPlace uses the building radius', () => {
  const s = makeState();
  assert.equal(canPlace(s, 'cathedral', 100, 100, 0, geo).ok, true);
  assert.equal(canPlace(s, 'cathedral', 12, 100, 0, geo).reason, 'นอกแผนที่');
  assert.equal(canPlace(s, 'townhall', 10, 100, 0, geo).ok, true);
});

test('canPaintZone checks bounds, water, buildings and zones', () => {
  const s = makeState({
    buildings: [
      { id: 1, type: 'house', x: 100, z: 100, rot: 0 },
      { id: 2, type: 'chapel', x: 60, z: 60, rot: 0 },
    ],
    zones: [{ id: 1, kind: 'field', x: 140, z: 140, r: 8 }],
  });
  assert.equal(canPaintZone(s, 'residential', 3, 100, 6, geo).reason, 'นอกแผนที่');
  assert.equal(canPaintZone(s, 'residential', 210, 100, 6, geo).reason, 'อยู่บนน้ำ');
  assert.equal(canPaintZone(s, 'residential', 100, 100, 9, geo).ok, true); // houses allowed
  assert.equal(canPaintZone(s, 'residential', 62, 60, 6, geo).reason, 'ทับอาคารอื่น');
  assert.equal(canPaintZone(s, 'residential', 145, 140, 6, geo).reason, 'ทับโซนอื่น');
  assert.equal(canPaintZone(s, 'field', 145, 140, 6, geo).ok, true); // same kind allowed
});

test('nodesUnder returns ids within r + 0.8', () => {
  const s = makeState({
    nodes: [
      { id: 1, kind: 'tree', x: 100, z: 100 },
      { id: 2, kind: 'tree', x: 103.7, z: 100 },
      { id: 3, kind: 'rock', x: 104, z: 100 },
    ],
  });
  assert.deepEqual(nodesUnder(s, 100, 100, 3), [1, 2]);
  assert.deepEqual(nodesUnder(s, 100, 100, 0), [1]);
});

test('findHouseSite returns a point inside the zone away from existing houses', () => {
  const zone = { id: 1, kind: 'residential', x: 100, z: 100, r: 14 };
  const s = makeState({
    zones: [zone],
    buildings: [{ id: 1, type: 'house', x: 100, z: 100, rot: 0 }],
  });
  const houseR = BUILDINGS.house.radius;
  const site = findHouseSite(s, zone, seqRand(42), geo);
  assert.ok(site);
  assert.ok(Math.hypot(site.x - zone.x, site.z - zone.z) <= zone.r - houseR + 1e-9);
  assert.ok(Math.hypot(site.x - 100, site.z - 100) >= 2 * houseR + 0.5);
  assert.ok(site.rot >= 0 && site.rot < Math.PI * 2);
});

test('findHouseSite returns null when the zone is full', () => {
  const zone = { id: 1, kind: 'residential', x: 100, z: 100, r: 3.5 };
  const s = makeState({
    zones: [zone],
    buildings: [{ id: 1, type: 'house', x: 100, z: 100, rot: 0 }],
  });
  assert.equal(findHouseSite(s, zone, seqRand(5), geo), null);
});
