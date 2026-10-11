import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world as createWorld } from './helpers.js';
import { mulberry32 } from '../src/rng.js';
import {
  tick, summary, villagerAt, villagerInfo, household, assignJob, waitingReason, BUILDER,
} from '../src/sim.js';
import { processMidnight, assignHomes, planHouses } from '../src/needs.js';
import {
  processDeaths, processMarriages, processPregnancies, leaveHome, spawnImmigrantGroup, packUnits,
  homelessUnits,
} from '../src/families.js';
import { stepVillager, planNext } from '../src/villagers.js';
import { moveToward } from '../src/taskutil.js';
import { serialize, deserialize } from '../src/save.js';
import { MALE_NAMES, FEMALE_NAMES, SURNAMES } from '../src/names.js';
import {
  DAY_LENGTH, BUILDINGS, CHILD_AGE, ELDER_AGE, DEATH_AGE_MIN, DEATH_AGE_MAX, PREGNANCY_DAYS, START,
  CHILD_PLAY_RADIUS, ELDER_SPEED_MUL, CHILD_SPEED_MUL, PREGNANT_SPEED_MUL, WALK_SPEED,
} from '../src/config.js';
import {
  world, townhall, addBuilt, addVillager, clearVillagers, SPAWN,
} from './helpers.js';

const always = () => 0;
const never = () => 0.999;

function emptyWorld() {
  const s = world();
  clearVillagers(s);
  return s;
}

function person(s, { gender = 'm', age = 30, x = SPAWN.x, z = SPAWN.z, ...rest } = {}) {
  const v = addVillager(s, x, z);
  Object.assign(v, { gender, age, deathAge: 90, ...rest });
  return v;
}

function house(s, x, z, members = [], level = 1) {
  const h = addBuilt(s, 'house', x, z);
  h.level = level;
  h.happiness = 1;
  for (const m of members) {
    m.homeId = h.id;
    h.residents.push(m.id);
  }
  return h;
}

function wed(h, w) {
  h.spouseId = w.id;
  w.spouseId = h.id;
}

function childOf(s, mother, father, age = 5, gender = 'm') {
  const c = person(s, { gender, age, parents: father ? [mother.id, father.id] : [mother.id], surname: (father ?? mother).surname });
  mother.children.push(c.id);
  if (father) father.children.push(c.id);
  return c;
}

test('names: enough Thai-script male, female and family names', () => {
  assert.ok(MALE_NAMES.length >= 30 && FEMALE_NAMES.length >= 30 && SURNAMES.length >= 25);
  for (const n of [...MALE_NAMES, ...FEMALE_NAMES, ...SURNAMES]) assert.match(n, /[฀-๿]/);
});

test('light flag marks the elder-friendly buildings', () => {
  const light = Object.entries(BUILDINGS).filter(([, b]) => b.light).map(([k]) => k).sort();
  assert.deepEqual(light, ['bakery', 'chapel', 'coop', 'forager', 'forester', 'herbalist', 'infirmary', 'market', 'tavern', 'weaver']);
});

test('start: 3 married couples with distinct surnames + 2 single adults, all with names and death ages', () => {
  const s = createWorld(5);
  assert.equal(s.villagers.length, START.villagers);
  const couples = s.villagers.filter((v) => v.gender === 'm' && v.spouseId != null);
  assert.equal(couples.length, 3);
  assert.equal(new Set(couples.map((c) => c.surname)).size, 3);
  for (const h of couples) {
    const w = s.villagers.find((v) => v.id === h.spouseId);
    assert.equal(w.gender, 'f');
    assert.equal(w.spouseId, h.id);
    assert.equal(w.surname, h.surname);
  }
  assert.equal(s.villagers.filter((v) => v.spouseId == null).length, 2);
  for (const v of s.villagers) {
    assert.ok(v.age >= 18 && v.age <= 35, `age ${v.age}`);
    assert.ok(v.deathAge >= DEATH_AGE_MIN && v.deathAge <= DEATH_AGE_MAX);
    assert.ok(v.name && v.surname && ['m', 'f'].includes(v.gender));
    assert.deepEqual([v.parents, v.children, v.pregnant, v.pregnantDays], [[], [], false, 0]);
  }
});

// ---------------------------------------------------------------- ageing & death

test('villagers age one year per game day', () => {
  const s = emptyWorld();
  const v = person(s, { age: 20 });
  const rand = mulberry32(1);
  for (let i = 0; i < DAY_LENGTH * 10; i++) stepVillager(s, v, 0.1, rand);
  assert.ok(Math.abs(v.age - 21) < 1e-6, `age ${v.age}`);
});

test('reaching the death age ends life: event, cleanup, spouse widowed, counter', () => {
  const s = emptyWorld();
  const old = person(s, { age: 79.99, deathAge: 80, name: 'วิลเลียม', surname: 'สมิธ' });
  const wife = person(s, { gender: 'f', age: 70 });
  wed(old, wife);
  const h = house(s, SPAWN.x + 12, SPAWN.z, [old, wife]);
  const store = addBuilt(s, 'chapel', SPAWN.x - 12, SPAWN.z);
  old.jobId = store.id;
  store.workers.push(old.id);
  old.age = 80;
  assert.equal(processDeaths(s), 1);
  assert.ok(!s.villagers.includes(old));
  assert.equal(wife.spouseId, null);
  assert.deepEqual(h.residents, [wife.id]);
  assert.deepEqual(store.workers, []);
  assert.equal(s.deaths, 1);
  assert.ok(s.events.some((e) => e.text === '🕊️ วิลเลียม สมิธ จากไปอย่างสงบในวัย 80 ปี'), s.events.at(-1).text);
  assert.equal(summary(s).deaths, 1);
});

test('death is also applied by the running simulation and at midnight', () => {
  const s = emptyWorld();
  const v = person(s, { age: 60, deathAge: 60.001 });
  const w = person(s, { age: 60, deathAge: 60.001 });
  tick(s, 5);
  assert.ok(!s.villagers.includes(v) && !s.villagers.includes(w));
  assert.equal(s.deaths, 2);
  const u = person(s, { age: 70, deathAge: 70 });
  processMidnight(s, mulberry32(1));
  assert.ok(!s.villagers.includes(u));
});

// ---------------------------------------------------------------- work eligibility

test('children never get jobs, never build, and play near home', () => {
  const s = emptyWorld();
  const mum = person(s, { gender: 'f', age: 30 });
  const dad = person(s, { age: 32 });
  wed(dad, mum);
  const kids = [3, 6, 9, 13].map((a, i) => childOf(s, mum, dad, a, i % 2 ? 'f' : 'm'));
  const home = house(s, SPAWN.x + 16, SPAWN.z + 4, [mum, dad, ...kids]);
  const wc = addBuilt(s, 'woodcutter', SPAWN.x - 10, SPAWN.z + 10);
  addBuilt(s, 'storehouse', SPAWN.x + 6, SPAWN.z - 12);
  const site = s.buildings.at(-1);
  site.built = false;
  site.needed = {};
  for (const k of kids) { k.x = home.x; k.z = home.z; }
  let worst = 0;
  for (let i = 0; i < 600; i++) {
    tick(s, 0.1);
    for (const k of kids) {
      assert.equal(k.jobId, null);
      assert.ok(!k.queue.some((t) => t.kind === 'build' || t.kind === 'take' || t.kind === 'gather'));
      worst = Math.max(worst, Math.hypot(k.x - home.x, k.z - home.z));
    }
  }
  assert.ok(worst <= CHILD_PLAY_RADIUS + 1, `children strayed ${worst} m`);
  assert.deepEqual(wc.workers.filter((id) => kids.some((k) => k.id === id)), []);
});

test('pregnant women and sick villagers keep their post but do not work until able', () => {
  const s = emptyWorld();
  const wc = addBuilt(s, 'woodcutter', SPAWN.x - 10, SPAWN.z + 10);
  const a = person(s, { gender: 'f' });
  const b = person(s, { gender: 'm' });
  const c = person(s, { gender: 'm' });
  tick(s, 1.5);
  assert.equal(wc.workers.length, 0, 'nobody is put to work automatically');
  assert.equal(assignJob(s, a.id, wc.id).ok, true);
  assert.equal(assignJob(s, b.id, wc.id).ok, true);
  assert.equal(assignJob(s, c.id, wc.id).ok, false, 'only 2 slots');
  a.pregnant = true;
  b.sick = true;
  a.queue = [];
  tick(s, 1.5);
  assert.equal(a.jobId, wc.id);
  assert.equal(b.jobId, wc.id);
  assert.deepEqual([...wc.workers].sort(), [a.id, b.id].sort());
  assert.equal(c.jobId, null, 'the free villager is not hired by itself');
  assert.ok(!a.queue.some((t) => t.kind === 'gather'), 'pregnant worker waits instead of chopping');
  assert.match(waitingReason(s, a), /ตั้งครรภ์/);
});

test('elders only take light jobs, lose heavy ones, and never build', () => {
  const s = emptyWorld();
  const wc = addBuilt(s, 'woodcutter', SPAWN.x - 10, SPAWN.z + 10);
  const chapel = addBuilt(s, 'chapel', SPAWN.x + 10, SPAWN.z + 10);
  const gran = person(s, { age: ELDER_AGE + 5 });
  gran.jobId = wc.id;   // aged into an elder while chopping
  tick(s, 1.5);
  assert.equal(gran.jobId, null);
  assert.ok(!wc.workers.includes(gran.id));
  assert.ok(s.events.some((e) => e.vId === gran.id && /อายุมากแล้ว/.test(e.text)));
  assert.equal(assignJob(s, gran.id, wc.id).ok, false);
  assert.equal(assignJob(s, gran.id, BUILDER).ok, false);
  assert.equal(assignJob(s, gran.id, chapel.id).ok, true);
  assert.deepEqual(chapel.workers, [gran.id]);
  // never a builder / hauler, even when flagged by hand
  const site = addBuilt(s, 'storehouse', SPAWN.x, SPAWN.z + 30);
  site.built = false;
  site.needed = { wood: 5 };
  assignJob(s, gran.id, null);
  gran.builder = true;
  gran.queue = [];
  planNext(s, gran, mulberry32(1));
  assert.ok(gran.queue.every((t) => t.kind === 'goto' || t.kind === 'wait'), JSON.stringify(gran.queue));
  assert.notEqual(gran.role, 'builder');
  // an adult next to him builds/hauls only once assigned to the builder crew
  const adult = person(s, { age: 30 });
  planNext(s, adult, mulberry32(1));
  assert.notEqual(adult.role, 'builder');
  adult.queue = [];
  assert.equal(assignJob(s, adult.id, BUILDER).ok, true);
  planNext(s, adult, mulberry32(1));
  assert.equal(adult.role, 'builder');
});

test('a child growing up is announced and stays free until assigned', () => {
  const s = emptyWorld();
  const kid = person(s, { age: 13.9 });
  tick(s, 1.5);
  assert.equal(kid.minor, true);
  kid.age = 14.1;
  tick(s, 1.5);
  assert.equal(kid.minor, undefined);
  assert.ok(s.events.some((e) => e.vId === kid.id && /โตเป็นผู้ใหญ่/.test(e.text)));
  assert.equal(kid.jobId, null);
  assert.equal(kid.builder, false);
});

test('speed: elders, children and pregnant women walk slower', () => {
  const s = emptyWorld();
  const steps = (v) => {
    const x0 = v.x;
    moveToward(s, v, v.x + 100, v.z, 1);
    return v.x - x0;
  };
  const adult = person(s, { age: 30, x: 100, z: 100 });
  const elder = person(s, { age: 60, x: 100, z: 100 });
  const kid = person(s, { age: 6, x: 100, z: 100 });
  const mum = person(s, { gender: 'f', age: 30, x: 100, z: 100, pregnant: true });
  const base = steps(adult);
  assert.ok(base > 0 && base <= WALK_SPEED * 1.7);
  assert.ok(Math.abs(steps(elder) / base - ELDER_SPEED_MUL) < 0.02);
  assert.ok(Math.abs(steps(kid) / base - CHILD_SPEED_MUL) < 0.02);
  assert.ok(Math.abs(steps(mum) / base - PREGNANT_SPEED_MUL) < 0.02);
});

// ---------------------------------------------------------------- marriage

test('marriage pairs opposite genders, never siblings or parent and child', () => {
  const s = emptyWorld();
  const mum = person(s, { gender: 'f', age: 44, surname: 'สมิธ' });
  const dad = person(s, { gender: 'm', age: 46, surname: 'สมิธ' });
  const son = person(s, { gender: 'm', age: 20, x: SPAWN.x + 1, parents: [mum.id, dad.id], surname: 'สมิธ' });
  const daughter = person(s, { gender: 'f', age: 21, x: SPAWN.x + 1, parents: [mum.id, dad.id], surname: 'สมิธ' });
  mum.children.push(son.id, daughter.id);
  dad.children.push(son.id, daughter.id);
  // only kin available: nobody marries
  assert.equal(processMarriages(s, always), 0);
  assert.ok(s.villagers.every((v) => v.spouseId == null));
  // a stranger of each gender
  const man = person(s, { gender: 'm', age: 25, x: SPAWN.x + 30, surname: 'เบเกอร์' });
  const woman = person(s, { gender: 'f', age: 25, x: SPAWN.x + 30, surname: 'คูเปอร์' });
  assert.equal(processMarriages(s, always), 2);
  for (const v of s.villagers) {
    if (v.spouseId == null) continue;
    const sp = s.villagers.find((w) => w.id === v.spouseId);
    assert.notEqual(sp.gender, v.gender);
    assert.equal(sp.spouseId, v.id);
    assert.ok(!v.parents.includes(sp.id) && !sp.parents.includes(v.id));
    assert.ok(!v.parents.some((p) => sp.parents.includes(p)), 'siblings must not marry');
  }
  for (const wife of [daughter, woman, mum]) {
    if (wife.spouseId == null) continue;
    assert.equal(wife.surname, s.villagers.find((v) => v.id === wife.spouseId).surname, 'a bride takes the groom\'s name');
  }
  assert.equal(daughter.spouseId, null, 'her only candidate besides kin is taken');
  assert.ok(s.events.some((e) => e.text.startsWith('💍') && e.text.includes('แต่งงานกับ')));
});

test('marriage respects age limits, sickness, chance and the closest man', () => {
  const s = emptyWorld();
  const w = person(s, { gender: 'f', age: 25, x: 50, z: 50 });
  const far = person(s, { gender: 'm', age: 25, x: 90, z: 50 });
  const near = person(s, { gender: 'm', age: 25, x: 55, z: 50 });
  person(s, { gender: 'm', age: 17, x: 51, z: 50 });
  person(s, { gender: 'm', age: 50, x: 51, z: 50 });
  assert.equal(processMarriages(s, never), 0);
  assert.equal(processMarriages(s, always), 1);
  assert.equal(w.spouseId, near.id);
  assert.equal(far.spouseId, null);
  const s2 = emptyWorld();
  person(s2, { gender: 'f', age: 25 });
  person(s2, { gender: 'm', age: 25, sick: true });
  assert.equal(processMarriages(s2, always), 0);
});

test('the couple moves into one house: husband\'s first, else wife\'s, else both homeless then housed together', () => {
  // husband's house has room
  let s = emptyWorld();
  let h = person(s, { gender: 'm' });
  let w = person(s, { gender: 'f' });
  const hh = house(s, 100, 100, [h]);
  const wh = house(s, 120, 100, [w]);
  processMarriages(s, always);
  assert.equal(w.homeId, hh.id);
  assert.deepEqual(hh.residents.sort(), [h.id, w.id].sort());
  assert.deepEqual(wh.residents, []);
  // husband's house full -> wife's house
  s = emptyWorld();
  h = person(s, { gender: 'm' });
  w = person(s, { gender: 'f' });
  const fill = [person(s), person(s)];
  const full = house(s, 100, 100, [h, ...fill]);
  const hers = house(s, 120, 100, [w]);
  processMarriages(s, always);
  assert.equal(h.homeId, hers.id);
  assert.equal(w.homeId, hers.id);
  assert.equal(full.residents.length, 2);
  // both full -> both homeless, spouse link kept, assignHomes houses them together
  s = emptyWorld();
  h = person(s, { gender: 'm' });
  w = person(s, { gender: 'f' });
  const f1 = house(s, 100, 100, [h, person(s), person(s)]);
  const f2 = house(s, 120, 100, [w, person(s), person(s)]);
  const spare = house(s, 140, 100, []);
  processMarriages(s, always);
  assert.equal(h.homeId, null);
  assert.equal(w.homeId, null);
  assert.equal(h.spouseId, w.id);
  assignHomes(s);
  assert.equal(h.homeId, spare.id);
  assert.equal(w.homeId, spare.id);
  assert.equal(f1.residents.length + f2.residents.length, 4);
});

// ---------------------------------------------------------------- pregnancy & birth

test('pregnancy, then a birth after PREGNANCY_DAYS with links, surname and home', () => {
  const s = emptyWorld();
  const dad = person(s, { gender: 'm', age: 28, surname: 'ฟิชเชอร์' });
  const mum = person(s, { gender: 'f', age: 26, surname: 'ฟิชเชอร์', x: 100, z: 100 });
  wed(dad, mum);
  const home = house(s, 100, 100, [dad, mum]);
  processPregnancies(s, always);
  assert.equal(mum.pregnant, true);
  assert.equal(mum.pregnantDays, 0);
  assert.ok(s.events.some((e) => e.text.startsWith('🤰') && e.text.includes('ตั้งครรภ์')));
  for (let d = 1; d < PREGNANCY_DAYS; d++) {
    processPregnancies(s, never);
    assert.equal(s.villagers.length, 2, 'no baby yet');
    assert.equal(mum.pregnantDays, d);
  }
  processPregnancies(s, never);
  assert.equal(s.villagers.length, 3);
  const baby = s.villagers.at(-1);
  assert.equal(baby.age, 0);
  assert.ok(['m', 'f'].includes(baby.gender));
  assert.deepEqual(baby.parents, [mum.id, dad.id]);
  assert.deepEqual(mum.children, [baby.id]);
  assert.deepEqual(dad.children, [baby.id]);
  assert.equal(baby.surname, 'ฟิชเชอร์');
  assert.equal(baby.homeId, home.id);
  assert.ok(home.residents.includes(baby.id));
  assert.ok(Math.hypot(baby.x - mum.x, baby.z - mum.z) < 2);
  assert.equal(mum.pregnant, false);
  assert.equal(s.births, 1);
  assert.equal(summary(s).births, 1);
  assert.ok(s.events.some((e) => e.text === `👶 ครอบครัวฟิชเชอร์มีลูกคนใหม่ชื่อ ${baby.name}`));
});

test('a newborn may exceed house capacity; conception needs room, health and a happy home', () => {
  const s = emptyWorld();
  const dad = person(s, { gender: 'm' });
  const mum = person(s, { gender: 'f', age: 30, pregnant: true, pregnantDays: PREGNANCY_DAYS - 1, pregnantBy: dad.id });
  wed(dad, mum);
  const kid = person(s, { age: 5 });
  const home = house(s, 100, 100, [dad, mum, kid]);   // full (3/3)
  processPregnancies(s, never);
  assert.equal(home.residents.length, 4);
  // a full house, an unhappy house, a sick wife, a too-old wife: nobody conceives
  const tryOne = (mutate) => {
    const t = emptyWorld();
    const d = person(t, { gender: 'm' });
    const m = person(t, { gender: 'f', age: 30 });
    wed(d, m);
    const hs = house(t, 100, 100, [d, m]);
    mutate({ t, m, hs });
    processPregnancies(t, always);
    return m.pregnant;
  };
  assert.equal(tryOne(() => {}), true);
  assert.equal(tryOne(({ hs }) => { hs.happiness = 0.4; }), false);
  assert.equal(tryOne(({ m }) => { m.sick = true; }), false);
  assert.equal(tryOne(({ m }) => { m.age = 43; }), false);
  assert.equal(tryOne(({ m }) => { m.age = 17; }), false);
  assert.equal(tryOne(({ t, m }) => { person(t, { homeId: m.homeId }); t.buildings.at(-1).residents.push(t.villagers.at(-1).id); }), false);   // 3/3
  assert.equal(tryOne(({ m }) => { m.spouseId = null; }), false);
});

test('midnight family processing runs through processMidnight', () => {
  const s = emptyWorld();
  const dad = person(s, { gender: 'm' });
  const mum = person(s, { gender: 'f' });
  wed(dad, mum);
  house(s, 100, 100, [dad, mum]);
  townhall(s).stock.berries = 50;
  let born = false;
  for (let i = 0; i < 40 && !born; i++) {
    s.time += DAY_LENGTH;
    processMidnight(s, mulberry32(i));
    born = (s.births ?? 0) > 0;
  }
  assert.ok(born, 'a baby arrives within 40 nights');
});

// ---------------------------------------------------------------- housing

test('an unmarried 18-year-old leaves a full parental home and does not move straight back', () => {
  const s = emptyWorld();
  const mum = person(s, { gender: 'f', age: 40 });
  const dad = person(s, { gender: 'm', age: 42 });
  wed(dad, mum);
  const kid = childOf(s, mum, dad, 18);
  const home = house(s, 100, 100, [mum, dad, kid]);
  const young = childOf(s, mum, dad, 10, 'f');
  leaveHome(s);
  assert.equal(kid.homeId, null);
  assert.deepEqual(home.residents.sort(), [mum.id, dad.id].sort());
  assert.equal(young.homeId, null, 'the little one was never housed here in this test');
  assignHomes(s);
  assert.equal(kid.homeId, null, 'the only house is the one he left');
  const other = house(s, 130, 100, []);
  assignHomes(s);
  assert.equal(kid.homeId, other.id);
});

test('leaving home: not under capacity, not married, not a child', () => {
  const s = emptyWorld();
  const mum = person(s, { gender: 'f', age: 40 });
  const kid = childOf(s, mum, null, 19);
  const home = house(s, 100, 100, [mum, kid]);   // 2/3
  leaveHome(s);
  assert.equal(kid.homeId, home.id);
  const kid2 = childOf(s, mum, null, 16);
  home.residents.push(kid2.id);
  kid2.homeId = home.id;
  leaveHome(s);   // full now, but the only adult child is 19 -> leaves; the 16-year-old stays
  assert.equal(kid.homeId, null);
  assert.equal(kid2.homeId, home.id);
  const t = emptyWorld();
  const m2 = person(t, { gender: 'f', age: 40 });
  const married = childOf(t, m2, null, 25);
  const spouse = person(t, { gender: 'f', age: 25 });
  wed(married, spouse);
  const h2 = house(t, 100, 100, [m2, married, spouse]);
  leaveHome(t);
  assert.equal(h2.residents.length, 3);
});

test('assignHomes keeps a parent and child together (families move as one unit)', () => {
  const s = emptyWorld();
  const near = house(s, SPAWN.x + 15, SPAWN.z, [person(s)], 1);      // 2 free places
  const far = house(s, SPAWN.x + 60, SPAWN.z, [], 1);                // 3 free places
  const mum = person(s, { gender: 'f', age: 30 });
  const dad = person(s, { gender: 'm', age: 30 });
  wed(dad, mum);
  const kid = childOf(s, mum, dad, 4);
  const loner = person(s);
  assignHomes(s);
  assert.equal(kid.homeId, mum.homeId);
  assert.equal(dad.homeId, mum.homeId);
  assert.equal(mum.homeId, far.id, 'the family of three needs the roomier house');
  assert.equal(loner.homeId, near.id);
  // a lone mother with a small child
  const t = emptyWorld();
  const n1 = house(t, SPAWN.x + 15, SPAWN.z, [person(t), person(t)], 1);   // 1 free
  const f1 = house(t, SPAWN.x + 40, SPAWN.z, [], 1);
  const mother = person(t, { gender: 'f' });
  const baby = childOf(t, mother, null, 1);
  assignHomes(t);
  assert.equal(mother.homeId, f1.id);
  assert.equal(baby.homeId, f1.id);
  assert.equal(n1.residents.length, 2);
});

test('a child whose parent is housed joins that parent, even over capacity', () => {
  const s = emptyWorld();
  const mum = person(s, { gender: 'f' });
  const h = house(s, 100, 100, [mum, person(s), person(s)]);
  const kid = childOf(s, mum, null, 3);
  assignHomes(s);
  assert.equal(kid.homeId, h.id);
  assert.equal(h.residents.length, 4);
});

test('planHouses treats families as units when judging capacity', () => {
  const s = emptyWorld();
  s.zones.push({ id: s.nextId++, kind: 'residential', x: SPAWN.x + 20, z: SPAWN.z, r: 10 });
  house(s, SPAWN.x + 40, SPAWN.z, [person(s)]);   // 2 free
  house(s, SPAWN.x + 50, SPAWN.z, [person(s)]);   // 2 free
  const mum = person(s, { gender: 'f' });
  const dad = person(s, { gender: 'm' });
  wed(dad, mum);
  childOf(s, mum, dad, 3);                        // a family of three: 4 free places, but no room for 3
  const before = s.buildings.filter((b) => b.type === 'house').length;
  planHouses(s, mulberry32(1));
  assert.equal(s.buildings.filter((b) => b.type === 'house').length, before + 1);
  // singles that fit do not trigger a new house
  const t = emptyWorld();
  t.zones.push({ id: t.nextId++, kind: 'residential', x: SPAWN.x + 20, z: SPAWN.z, r: 10 });
  house(t, SPAWN.x + 40, SPAWN.z, [person(t)]);
  house(t, SPAWN.x + 50, SPAWN.z, [person(t)]);
  person(t); person(t); person(t);
  planHouses(t, mulberry32(1));
  assert.equal(t.buildings.filter((b) => b.type === 'house').length, 2);
});

test('homelessUnits groups couples and children; oversize families take an empty house', () => {
  const s = emptyWorld();
  const mum = person(s, { gender: 'f' });
  const dad = person(s, { gender: 'm' });
  wed(dad, mum);
  const kids = [childOf(s, mum, dad, 2), childOf(s, mum, dad, 5)];
  const solo = person(s);
  const units = homelessUnits(s);
  assert.deepEqual(units.map((u) => u.size), [4, 1]);
  assert.equal(units[1].members[0], solo);
  const slots = [{ id: 1, free: 3, count: 0, cap: 3 }, { id: 2, free: 1, count: 2, cap: 3 }];
  const { placed, unplaced } = packUnits(units, slots);
  assert.equal(unplaced.length, 0);
  assert.equal(placed[0].slot.id, 1, 'a family of four overflows an empty house of three');
  assert.equal(kids.length, 2);
});

// ---------------------------------------------------------------- immigration

test('immigrants sometimes arrive as families (couple + children), sometimes alone', () => {
  const s = emptyWorld();
  let families = 0;
  let singles = 0;
  for (let i = 0; i < 200; i++) {
    const rand = mulberry32(i);
    const group = spawnImmigrantGroup(s, rand, () => ({ x: 4, z: 4 }), 5);
    assert.ok(group.length >= 1 && group.length <= 4);
    if (group.length === 1) {
      singles += 1;
      assert.ok(group[0].age >= 18 && group[0].age <= 40);
      continue;
    }
    families += 1;
    const [h, w, ...kids] = group;
    assert.deepEqual([h.gender, w.gender, h.spouseId, w.spouseId], ['m', 'f', w.id, h.id]);
    assert.ok(h.age >= 20 && h.age <= 40 && w.age >= 20 && w.age <= 40);
    assert.ok(kids.length <= 2);
    for (const k of kids) {
      assert.ok(k.age >= 1 && k.age <= 12);
      assert.deepEqual(k.parents, [w.id, h.id]);
      assert.equal(k.surname, h.surname);
    }
    assert.deepEqual(h.children, kids.map((k) => k.id));
  }
  assert.ok(families > 50 && singles > 50, `${families} families / ${singles} singles`);
  // a group never exceeds the room that is left
  assert.equal(spawnImmigrantGroup(emptyWorld(), always, () => ({ x: 1, z: 1 }), 1).length, 1);
});

test('nightly immigration still brings the usual headcount, families included', () => {
  let sawFamily = false;
  for (let i = 0; i < 12; i++) {
    const s = emptyWorld();
    house(s, 100, 100, [person(s), person(s), person(s)]);
    townhall(s).stock.berries = 600;   // plenty of food: growth is not capped by it
    const pop = s.villagers.length;
    processMidnight(s, mulberry32(i));
    const arrivals = s.villagers.filter((v) => v.homeId == null);
    assert.equal(arrivals.length, 6, 'count 2 + floor(1 * 4)');
    assert.equal(s.villagers.length, pop + 6);
    if (arrivals.some((v) => v.parents.length > 0)) sawFamily = true;
  }
  assert.ok(sawFamily);
});

// ---------------------------------------------------------------- queries

function bigFamily(s) {
  const grandpa = person(s, { gender: 'm', age: 66, name: 'จอห์น', surname: 'สมิธ' });
  const grandma = person(s, { gender: 'f', age: 63, name: 'อลิซ', surname: 'สมิธ' });
  wed(grandpa, grandma);
  const son = childOf(s, grandma, grandpa, 38, 'm');
  Object.assign(son, { name: 'ปีเตอร์' });
  const daughterInLaw = person(s, { gender: 'f', age: 36, name: 'แอนนา', surname: 'สมิธ' });
  wed(son, daughterInLaw);
  const grandkid = childOf(s, daughterInLaw, son, 7, 'f');
  Object.assign(grandkid, { name: 'เอ็มมา' });
  const h = house(s, 100, 100, [grandpa, grandma, son, daughterInLaw, grandkid], 3);
  return { grandpa, grandma, son, daughterInLaw, grandkid, h };
}

test('household lists members with relations (head, spouse, child, grandchild, in-laws)', () => {
  const s = emptyWorld();
  const f = bigFamily(s);
  const rows = household(s, f.h.id);
  assert.equal(rows.length, 5);
  const rel = Object.fromEntries(rows.map((r) => [r.id, r.relation]));
  assert.equal(rel[f.grandpa.id], 'หัวหน้าครอบครัว');
  assert.equal(rel[f.grandma.id], 'คู่สมรส');
  assert.equal(rel[f.son.id], 'ลูก');
  assert.equal(rel[f.grandkid.id], 'หลาน');
  assert.equal(rel[f.daughterInLaw.id], 'ผู้อาศัย');
  assert.equal(rows[0].id, f.grandpa.id);
  const r = rows.find((x) => x.id === f.grandkid.id);
  assert.deepEqual([r.fullName, r.age, r.gender, r.stage], ['เอ็มมา สมิธ', 7, 'f', 'child']);
  assert.ok(Array.isArray(r.status) && r.status.length >= 1);
  assert.equal(rows.find((x) => x.id === f.grandpa.id).stage, 'elder');
  assert.deepEqual(household(s, 424242), []);
});

test('household: the head\'s parents are พ่อ and แม่', () => {
  const s = emptyWorld();
  const dad = person(s, { gender: 'm', age: 50 });
  const mum = person(s, { gender: 'f', age: 49 });
  wed(dad, mum);
  const son = childOf(s, mum, dad, 52);   // an odd family tree, but the eldest man heads the house
  const h = house(s, 100, 100, [son]);
  const wife = person(s, { gender: 'f', age: 40 });
  wed(son, wife);
  h.residents.push(wife.id, dad.id, mum.id);
  wife.homeId = dad.homeId = mum.homeId = h.id;
  assert.equal(household(s, h.id)[0].id, son.id);
  const rel = Object.fromEntries(household(s, h.id).map((r) => [r.id, r.relation]));
  assert.deepEqual([rel[son.id], rel[wife.id], rel[dad.id], rel[mum.id]],
    ['หัวหน้าครอบครัว', 'คู่สมรส', 'พ่อ', 'แม่']);
});

test('villagerInfo: identity, stage, status, job, home, spouse, parents, children, grandchildren', () => {
  const s = emptyWorld();
  const f = bigFamily(s);
  const chapel = addBuilt(s, 'chapel', 130, 130);
  f.grandpa.jobId = chapel.id;
  f.grandpa.role = 'worker';
  f.daughterInLaw.pregnant = true;
  f.son.sick = true;
  f.grandkid.role = 'sleeping';
  const gp = villagerInfo(s, f.grandpa.id);
  assert.deepEqual(
    [gp.id, gp.name, gp.surname, gp.fullName, gp.gender, gp.age, gp.stage],
    [f.grandpa.id, 'จอห์น', 'สมิธ', 'จอห์น สมิธ', 'm', 66, 'elder'],
  );
  assert.deepEqual(gp.status, ['working']);
  assert.deepEqual(gp.job, { id: chapel.id, type: 'chapel', name: BUILDINGS.chapel.name });
  assert.deepEqual(gp.home, { id: f.h.id, level: 3 });
  assert.deepEqual(gp.spouse, { id: f.grandma.id, name: 'อลิซ สมิธ' });
  assert.deepEqual(gp.parents, []);
  assert.deepEqual(gp.children.map((c) => [c.id, c.name, c.age]), [[f.son.id, 'ปีเตอร์ สมิธ', 38]]);
  assert.deepEqual(gp.grandchildren.map((c) => [c.id, c.name, c.age]), [[f.grandkid.id, 'เอ็มมา สมิธ', 7]]);
  assert.deepEqual(villagerInfo(s, f.son.id).status, ['sick', 'idle']);
  assert.deepEqual(villagerInfo(s, f.daughterInLaw.id).status, ['pregnant', 'idle']);
  const kid = villagerInfo(s, f.grandkid.id);
  assert.equal(kid.stage, 'child');
  assert.deepEqual(kid.status, ['sleeping']);
  assert.equal(kid.job, null);
  assert.deepEqual(kid.parents.map((p) => [p.id, p.alive]), [[f.daughterInLaw.id, true], [f.son.id, true]]);
  assert.equal(villagerInfo(s, 999999), null);
  // a dead parent stays listed with their name
  f.grandma.deathAge = 1;
  processDeaths(s);
  const son = villagerInfo(s, f.son.id);
  assert.deepEqual(son.parents.map((p) => [p.name, p.alive]), [['อลิซ สมิธ', false], ['จอห์น สมิธ', true]]);
  assert.equal(villagerInfo(s, f.grandpa.id).spouse, null);
  assert.ok(Array.isArray(JSON.parse(JSON.stringify(son.parents))));
});

test('villagerAt returns the nearest villager within range', () => {
  const s = emptyWorld();
  const a = person(s, { x: 50, z: 50 });
  const b = person(s, { x: 51, z: 50 });
  assert.equal(villagerAt(s, 50.2, 50), a);
  assert.equal(villagerAt(s, 50.9, 50), b);
  assert.equal(villagerAt(s, 60, 50), null);
  assert.equal(villagerAt(s, 52.3, 50), b);
  assert.equal(villagerAt(s, 52.3, 50, 1), null);
});

// ---------------------------------------------------------------- save

test('v3 saves round-trip the family data', () => {
  const s = emptyWorld();
  const f = bigFamily(s);
  s.births = 4;
  s.deaths = 2;
  s.departed = { 7: 'x y' };
  f.daughterInLaw.pregnant = true;
  const copy = deserialize(serialize(s));
  assert.equal(copy.version, 4);
  assert.deepEqual(copy.villagers.find((v) => v.id === f.grandkid.id).parents, [f.daughterInLaw.id, f.son.id]);
  assert.equal(copy.villagers.find((v) => v.id === f.daughterInLaw.id).pregnant, true);
  assert.deepEqual([copy.births, copy.deaths, copy.departed[7]], [4, 2, 'x y']);
});

test('v2 saves migrate to v3: genders, ages, names, couples, children', () => {
  const s = createWorld(9);
  clearVillagers(s);
  // house A: 2 men + 3 women (ages must allow the extra woman to be a child? she is random) ; house B: 1 man
  const A = house(s, 100, 100, [], 3);
  const B = house(s, 130, 100, [], 3);
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const v = addVillager(s, 100, 100);
    v.homeId = A.id;
    A.residents.push(v.id);
    ids.push(v.id);
  }
  const lone = addVillager(s, 130, 100);
  lone.homeId = B.id;
  B.residents.push(lone.id);
  const homeless = addVillager(s, 1, 1);
  const data = JSON.parse(serialize(s));
  data.version = 2;
  for (const v of data.villagers) {
    for (const k of ['name', 'surname', 'gender', 'age', 'deathAge', 'spouseId', 'parents', 'children', 'pregnant', 'pregnantDays', 'pregnantBy']) delete v[k];
  }
  delete data.births; delete data.deaths; delete data.departed;
  const m = deserialize(JSON.stringify(data));
  assert.equal(m.version, 4);
  assert.deepEqual([m.births, m.deaths], [0, 0]);
  const byId = new Map(m.villagers.map((v) => [v.id, v]));
  for (const v of m.villagers) {
    assert.ok(['m', 'f'].includes(v.gender));
    assert.ok(v.age >= 18 && v.age <= 50);
    assert.ok(v.deathAge >= DEATH_AGE_MIN && v.deathAge <= DEATH_AGE_MAX);
    assert.ok(v.name && v.surname);
    assert.equal(v.pregnant, false);
    if (v.spouseId != null) {
      const sp = byId.get(v.spouseId);
      assert.equal(sp.spouseId, v.id);
      assert.notEqual(sp.gender, v.gender);
      assert.equal(sp.homeId, v.homeId, 'couples share a house');
      assert.equal(sp.surname, v.gender === 'f' ? sp.surname : v.surname);
    }
    for (const p of v.parents) {
      const par = byId.get(p);
      assert.ok(par.children.includes(v.id));
      assert.equal(par.homeId, v.homeId);
      assert.ok(par.age - v.age >= 16);
    }
  }
  const inA = ids.map((id) => byId.get(id));
  const men = inA.filter((v) => v.gender === 'm').length;
  const women = inA.length - men;
  const couples = inA.filter((v) => v.gender === 'm' && v.spouseId != null).length;
  assert.equal(couples, Math.min(men, women));
  assert.equal(byId.get(lone.id).spouseId, null);
  assert.equal(byId.get(homeless.id).homeId, null);
  assert.doesNotThrow(() => tick(m, 20));
  assert.doesNotThrow(() => deserialize(serialize(m)));
});

test('v2 migration pairs housemates and makes ageing extras children when the ages allow', () => {
  // brute-force a few seeds: at least one migrated house must contain a parent-child link
  let linked = 0;
  for (let seed = 1; seed <= 40 && linked === 0; seed++) {
    const s = createWorld(seed);
    clearVillagers(s);
    const H = house(s, 100, 100, [], 5);
    for (let i = 0; i < 5; i++) {
      const v = addVillager(s, 100, 100);
      v.homeId = H.id;
      H.residents.push(v.id);
    }
    const data = JSON.parse(serialize(s));
    data.version = 2;
    const m = deserialize(JSON.stringify(data));
    linked += m.villagers.filter((v) => v.parents.length > 0).length;
  }
  assert.ok(linked > 0);
});

// ---------------------------------------------------------------- whole-village run

test('a family village runs for a while without exceptions and ageing keeps counts consistent', () => {
  const s = createWorld(3);
  const sum0 = summary(s);
  assert.equal(sum0.adults + sum0.children + sum0.elders, sum0.pop);
  assert.doesNotThrow(() => tick(s, DAY_LENGTH * 2));
  const sum = summary(s);
  assert.equal(sum.adults + sum.children + sum.elders, sum.pop);
  assert.equal(CHILD_AGE, 14);
});
