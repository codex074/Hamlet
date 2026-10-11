import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick } from '../src/sim.js';
import { seasonOf, weatherAt, seasonEffects, updateSnow } from '../src/seasons.js';
import { moveToward } from '../src/taskutil.js';
import { DAY_LENGTH, SEASON_DAYS, SEASONS, RAIN_THIRST_MUL } from '../src/config.js';
import { world, addVillager, clearVillagers, SPAWN } from './helpers.js';

const dayStart = (d) => (d - 1) * DAY_LENGTH;   // time at the start of game day d

test('the year cycles spring → summer → autumn → winter every SEASON_DAYS days', () => {
  const keys = [1, SEASON_DAYS + 1, 2 * SEASON_DAYS + 1, 3 * SEASON_DAYS + 1, 4 * SEASON_DAYS + 1]
    .map((d) => seasonOf({ time: dayStart(d) + 1 }));
  assert.deepEqual(keys.map((s) => s.key), ['spring', 'summer', 'autumn', 'winter', 'spring']);
  assert.equal(keys[4].year, 2);
  assert.equal(seasonOf({ time: dayStart(3) + 5 }).day, 3);
});

test('weather is deterministic per seed and half-day; winter brings snow, other seasons rain', () => {
  const s = world(4);
  const seen = { spring: new Set(), winter: new Set() };
  for (let d = 1; d <= 4 * SEASON_DAYS; d++) {
    for (const h of [0.1, 0.6]) {
      const time = dayStart(d) + h * DAY_LENGTH;
      const w = weatherAt(s, time);
      assert.deepEqual(w, weatherAt({ seed: s.seed }, time), 'same seed and time → same weather');
      const key = seasonOf({ time }).key;
      if (seen[key]) seen[key].add(w.kind);
    }
  }
  assert.ok(!seen.spring.has('snow'));
  assert.ok(!seen.winter.has('rain'));
  assert.ok(seen.winter.has('snow'), 'it snows at some point in winter');
});

test('season effects: neutral spring, lean winter, rain eases thirst', () => {
  const winter = SEASONS.find((x) => x.key === 'winter');
  const s = world(1);
  s.time = dayStart(1) + 1;
  const spring = seasonEffects(s);
  assert.deepEqual([spring.farm, spring.berry, spring.hunger, spring.sick], [1, 1, 1, 1]);
  s.time = dayStart(3 * SEASON_DAYS + 1) + 1;
  const w = seasonEffects(s);
  assert.equal(w.farm, winter.farm);
  assert.ok(w.berry < 0.5 && w.hunger > 1);
  // find a rainy half-day in spring
  for (let t = 0; t < SEASON_DAYS * DAY_LENGTH; t += DAY_LENGTH / 2) {
    if (weatherAt(s, t + 1).kind !== 'rain') continue;
    s.time = t + 1;
    assert.equal(seasonEffects(s).thirst, RAIN_THIRST_MUL);
    return;
  }
  assert.fail('no rain in the first spring');
});

test('snow piles up while it snows, melts afterwards, and slows walking', () => {
  const s = world(4);
  let snowy = null;
  for (let t = dayStart(3 * SEASON_DAYS + 1); t < dayStart(4 * SEASON_DAYS + 1); t += DAY_LENGTH / 2) {
    if (weatherAt(s, t + 1).kind === 'snow') { snowy = t + 1; break; }
  }
  assert.ok(snowy != null);
  s.time = snowy;
  s.snow = 0;
  updateSnow(s, 60);
  assert.ok(s.snow > 0);
  s.snow = 1;
  clearVillagers(s);
  const a = addVillager(s, SPAWN.x, SPAWN.z);
  moveToward(s, a, a.x + 100, a.z, 1);
  const deep = a.x - SPAWN.x;
  s.snow = 0;
  a.x = SPAWN.x;
  moveToward(s, a, a.x + 100, a.z, 1);
  assert.ok(deep < a.x - SPAWN.x, 'slower in deep snow');
  s.time = dayStart(1) + 1;   // spring: no snowfall, melts
  s.snow = 0.5;
  if (weatherAt(s).kind !== 'snow') { updateSnow(s, 60); assert.ok(s.snow < 0.5); }
});

test('a new season is announced at midnight', () => {
  const s = world(2);
  tick(s, dayStart(SEASON_DAYS + 1) - s.time + 2);
  assert.ok(s.events.some((e) => e.text.includes('เข้าสู่ฤดูร้อน')));
});
