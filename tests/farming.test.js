import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick, assignJob, setFarmCrop, cropUnlocked, paintZone, setMarketGoods } from '../src/sim.js';
import { buildingProblem } from '../src/status.js';
import { serialize, deserialize } from '../src/save.js';
import { CROPS, FOODS, MARKET_PRICE, HARVEST_MARKS } from '../src/config.js';
import { totalStock } from '../src/economy.js';
import {
  world, townhall, addBuilt, addVillager, addHouse, clearVillagers, findZoneSpot, SPAWN,
} from './helpers.js';

const grow = (s, n) => { while (s.villagers.length < n) addVillager(s, SPAWN.x, SPAWN.z); };

test('crops unlock one by one with population, are announced once and stay unlocked', () => {
  const s = world();
  assert.deepEqual(s.cropsUnlocked, []);
  grow(s, CROPS.wheat.unlockPop);
  tick(s, 1.1);
  assert.equal(cropUnlocked(s, 'wheat'), true);
  assert.equal(cropUnlocked(s, 'corn'), false);
  grow(s, CROPS.beans.unlockPop);
  tick(s, 1.1);
  assert.ok(cropUnlocked(s, 'corn') && cropUnlocked(s, 'beans'));
  const news = s.events.filter((e) => /ปลดล็อก(ข้าวสาลี|ข้าวโพด|ถั่ว)แล้ว/.test(e.text));
  assert.equal(news.length, 3);
  s.villagers.length = 5;   // the village shrinks: crops already unlocked stay
  tick(s, 1.1);
  assert.equal(cropUnlocked(s, 'beans'), true);
  assert.equal(s.events.filter((e) => /ปลดล็อก(ข้าวสาลี|ข้าวโพด|ถั่ว)แล้ว/.test(e.text)).length, 3);
});

test('a farm grows wheat by default and switches only to unlocked crops', () => {
  const s = world();
  const farm = addBuilt(s, 'farmhouse', SPAWN.x + 25, SPAWN.z);
  assert.equal(farm.crop, undefined);
  grow(s, CROPS.corn.unlockPop - 1);
  tick(s, 1.1);
  const locked = setFarmCrop(s, farm.id, 'corn');
  assert.equal(locked.ok, false);
  assert.match(locked.reason, /ยังไม่ปลดล็อก/);
  grow(s, CROPS.corn.unlockPop);
  tick(s, 1.1);
  assert.equal(setFarmCrop(s, farm.id, 'corn').ok, true);
  assert.equal(farm.crop, 'corn');
  assert.equal(setFarmCrop(s, farm.id, 'rice').ok, false);
  assert.equal(setFarmCrop(s, townhall(s).id, 'corn').ok, false);
});

test('farmers bring in the chosen crop and their harvest spots are remembered', () => {
  const s = world();
  clearVillagers(s);
  grow(s, CROPS.corn.unlockPop);
  tick(s, 1.1);
  const farm = addBuilt(s, 'farmhouse', SPAWN.x + 22, SPAWN.z + 6);
  const z = findZoneSpot(s, 'field', 8, farm.x + 12, farm.z, 30);
  paintZone(s, 'field', z.x, z.z, 8);
  setFarmCrop(s, farm.id, 'corn');
  for (const v of s.villagers.slice(0, 3)) assignJob(s, v.id, farm.id);
  townhall(s).stock.bread = 500;   // corn is food too: keep hungry villagers on bread so the count shows the harvest
  const corn0 = totalStock(s).corn;
  tick(s, 80);
  assert.ok(totalStock(s).corn > corn0, `corn ${totalStock(s).corn}`);
  assert.equal(totalStock(s).wheat, 0, 'no wheat from a corn farm');
  assert.ok(farm.harvests.length > 0 && farm.harvests.length <= HARVEST_MARKS);
  assert.ok(farm.harvests.every((h) => Math.hypot(h.x - z.x, h.z - z.z) <= 8.5));
});

test('corn and beans are food: eaten from storage, sold at the market, counted for variety', () => {
  assert.ok(FOODS.includes('corn') && FOODS.includes('beans'));
  assert.ok(MARKET_PRICE.corn > 0 && MARKET_PRICE.beans > 0);
  const s = world();
  clearVillagers(s);
  const hall = townhall(s);
  for (const f of FOODS) hall.stock[f] = 0;
  hall.stock.beans = 5;
  const h = addHouse(s, SPAWN.x + 20, SPAWN.z + 10, 1);
  const v = s.villagers.at(-1);
  v.hunger = 0.7;
  v.x = hall.x + 8;
  v.z = hall.z;
  tick(s, 15);
  assert.equal(hall.stock.beans, 4);
  assert.deepEqual(h.foodsToday, ['beans']);
  const m = addBuilt(s, 'market', SPAWN.x - 25, SPAWN.z + 10);
  assert.equal(setMarketGoods(s, m.id, ['corn', 'beans', 'bread', 'cloth']).ok, true);
});

test('the mill explains when no farm grows wheat', () => {
  const s = world();
  grow(s, CROPS.corn.unlockPop);
  tick(s, 1.1);
  const farm = addBuilt(s, 'farmhouse', SPAWN.x + 25, SPAWN.z);
  const mill = addBuilt(s, 'mill', SPAWN.x - 25, SPAWN.z);
  townhall(s).stock.wheat = 0;
  assert.doesNotMatch(buildingProblem(s, mill).text, /ไม่มีฟาร์มที่ปลูกข้าวสาลี/);
  setFarmCrop(s, farm.id, 'corn');
  assert.match(buildingProblem(s, mill).text, /ไม่มีฟาร์มที่ปลูกข้าวสาลี/);
});

test('older villages get the crops their population allows, without announcements', () => {
  const s = world();
  grow(s, CROPS.corn.unlockPop);
  delete s.cropsUnlocked;
  const back = deserialize(serialize(s));
  assert.deepEqual(back.cropsUnlocked, ['wheat', 'corn']);
  tick(back, 1.1);
  assert.ok(!back.events.some((e) => /ปลดล็อก(ข้าวสาลี|ข้าวโพด)แล้ว/.test(e.text)));
});
