// Families: ageing & death, marriage, pregnancy & birth, households, villager queries, save migration.
// Pure: no DOM, no globals.
import {
  CHILD_AGE, MARRY_MIN, MARRY_MAX, MARRY_CHANCE, FERTILE_MIN, FERTILE_MAX, PREGNANCY_CHANCE,
  PREGNANCY_DAYS, PREGNANCY_MIN_HAPPINESS, LEAVE_HOME_AGE, HOUSE_LEVELS, BUILDINGS, DEATH_AGE_MIN,
  DEATH_AGE_MAX, START, START_AGE, FAMILY_IMMIGRANT_CHANCE, IMMIGRANT_ADULT_AGE, IMMIGRANT_COUPLE_AGE,
  IMMIGRANT_CHILD_AGE, IMMIGRANT_MAX_CHILDREN, PARENT_MIN_GAP,
} from './config.js';
import { mulberry32, randRange, randInt } from './rng.js';
import { pickGivenName, pickSurname, fullName } from './names.js';
import { pushEvent } from './events.js';
import { createVillager, removeVillager } from './villagers.js';
import { stageOf, canWork, canBuild, canTakeJob } from './taskutil.js';

export { stageOf, canWork, canBuild, canTakeJob };

const MAX_NEWBORN_OFFSET = 0.6;

function byId(state) {
  return new Map(state.villagers.map((v) => [v.id, v]));
}

function houseOf(state, v) {
  return v.homeId == null ? null : state.buildings.find((b) => b.id === v.homeId && b.type === 'house') ?? null;
}

function capacityOf(house) {
  return HOUSE_LEVELS[house.level - 1].capacity;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

// ---------- ageing & death ----------

// Villagers who reached their death age pass away peacefully. Returns how many died.
export function processDeaths(state) {
  const dying = state.villagers.filter((v) => v.age >= v.deathAge);
  for (const v of dying) {
    const age = Math.floor(v.age);
    removeVillager(state, v.id);
    state.deaths = (state.deaths ?? 0) + 1;
    pushEvent(state, `🕊️ ${fullName(v)} จากไปอย่างสงบในวัย ${age} ปี`);
  }
  return dying.length;
}

// ---------- creating people (start, immigrants) ----------

function linkSpouses(h, w) {
  h.spouseId = w.id;
  w.spouseId = h.id;
}

function linkChild(child, mother, father) {
  child.parents = father ? [mother.id, father.id] : [mother.id];
  mother.children.push(child.id);
  if (father) father.children.push(child.id);
}

// A married couple sharing the husband's surname. Returns [husband, wife].
function spawnCouple(state, place, rand, ageRange, surname) {
  const p = place();
  const h = createVillager(state, p.x, p.z, { gender: 'm', age: randRange(rand, ...ageRange), surname });
  const q = place();
  const w = createVillager(state, q.x, q.z, { gender: 'f', age: randRange(rand, ...ageRange), surname });
  linkSpouses(h, w);
  return [h, w];
}

// Founding villagers: START.couples married couples (distinct surnames) + START.singles single adults.
export function createStartingVillagers(state, rand, place) {
  const out = [];
  const used = [];
  for (let i = 0; i < START.couples; i++) {
    const surname = pickSurname(rand, used);
    used.push(surname);
    out.push(...spawnCouple(state, place, rand, START_AGE.couple, surname));
  }
  for (let i = 0; i < START.singles; i++) {
    const p = place();
    out.push(createVillager(state, p.x, p.z, {
      gender: i % 2 === 0 ? 'm' : 'f', age: randRange(rand, ...START_AGE.single),
      surname: pickSurname(rand, used),
    }));
  }
  state.villagers.push(...out);
  return out;
}

// One immigrant group of at most `max` people at `place()`: a family (couple + 0-2 children) with
// FAMILY_IMMIGRANT_CHANCE, otherwise a single adult. Returns the new villagers (already in the state).
export function spawnImmigrantGroup(state, rand, place, max) {
  const out = [];
  if (max >= 2 && rand() < FAMILY_IMMIGRANT_CHANCE) {
    const [h, w] = spawnCouple(state, place, rand, IMMIGRANT_COUPLE_AGE, pickSurname(rand));
    out.push(h, w);
    const kids = Math.min(randInt(rand, 0, IMMIGRANT_MAX_CHILDREN), max - 2);
    for (let i = 0; i < kids; i++) {
      const p = place();
      const kid = createVillager(state, p.x, p.z, {
        age: randRange(rand, ...IMMIGRANT_CHILD_AGE), surname: h.surname,
      });
      linkChild(kid, w, h);
      out.push(kid);
    }
  } else {
    const p = place();
    out.push(createVillager(state, p.x, p.z, { age: randRange(rand, ...IMMIGRANT_ADULT_AGE) }));
  }
  state.villagers.push(...out);
  return out;
}

// ---------- housing units & placement ----------

// Homeless villagers grouped into households that must be housed together:
// spouses, and minor children with their (homeless) parents.
export function homelessUnits(state) {
  const homeless = state.villagers.filter((v) => v.homeId == null);
  const parent = new Map(homeless.map((v) => [v.id, v.id]));
  const find = (id) => {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)));
      id = parent.get(id);
    }
    return id;
  };
  const union = (a, b) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
  };
  for (const v of homeless) {
    if (v.spouseId != null) union(v.id, v.spouseId);
    if (stageOf(v) === 'child') for (const p of v.parents) union(v.id, p);
  }
  const groups = new Map();
  for (const v of homeless) {
    const root = find(v.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(v);
  }
  return [...groups.values()]
    .map((members) => ({
      members, size: members.length, minId: Math.min(...members.map((m) => m.id)),
      avoid: new Set(members.map((m) => m.avoidHomeId).filter((id) => id != null)),
    }))
    .sort((a, b) => b.size - a.size || a.minId - b.minId);
}

// A slot is { id, free, count, cap }; slots must already be ordered by preference.
// A unit fits when free >= size; a unit bigger than the capacity may take a whole empty slot (overcrowded).
function slotFits(slot, unit) {
  if (unit.avoid.has(slot.id)) return false;
  return slot.free >= unit.size || (slot.count === 0 && unit.size > slot.cap);
}

// Greedy packing. Returns { placed: [{ unit, slot }], unplaced: [unit] }; mutates slot.free / slot.count.
export function packUnits(units, slots) {
  const placed = [];
  const unplaced = [];
  for (const unit of units) {
    const slot = slots.find((s) => slotFits(s, unit));
    if (!slot) {
      unplaced.push(unit);
      continue;
    }
    slot.free -= unit.size;
    slot.count += unit.size;
    placed.push({ unit, slot });
  }
  return { placed, unplaced };
}

// Minor children join a housed parent (even over capacity); spouses join each other's home if there is room.
export function attachToFamily(state) {
  const people = byId(state);
  for (const v of state.villagers) {
    if (v.homeId != null) continue;
    let house = null;
    if (stageOf(v) === 'child') {
      for (const pid of v.parents) {
        const p = people.get(pid);
        house = p ? houseOf(state, p) : null;
        if (house) break;
      }
    } else if (v.spouseId != null) {
      const sp = people.get(v.spouseId);
      const h = sp ? houseOf(state, sp) : null;
      if (h && h.residents.length < capacityOf(h)) house = h;
    }
    if (!house) continue;
    house.residents.push(v.id);
    v.homeId = house.id;
    delete v.avoidHomeId;
  }
}

// ---------- leaving home ----------

// Unmarried adults living with a parent move out when the house is full (with their own small children).
export function leaveHome(state) {
  for (const v of [...state.villagers]) {
    if (v.spouseId != null || v.age < LEAVE_HOME_AGE) continue;
    const home = houseOf(state, v);
    if (!home || home.residents.length < capacityOf(home)) continue;
    if (!v.parents.some((pid) => home.residents.includes(pid))) continue;
    for (const m of unitOf(state, v)) {
      leaveHouse(state, m);
      m.avoidHomeId = home.id;
    }
  }
}

// ---------- marriage ----------

function related(a, b) {
  if (a.parents.includes(b.id) || b.parents.includes(a.id)) return true;
  return a.parents.some((p) => b.parents.includes(p));
}

// A person plus the minor children who live with them.
function unitOf(state, person) {
  const kids = state.villagers.filter((c) => c.id !== person.id && c.age < CHILD_AGE
    && c.parents.includes(person.id) && c.homeId === person.homeId);
  return [person, ...kids];
}

function leaveHouse(state, member) {
  const old = houseOf(state, member);
  if (old) old.residents = old.residents.filter((id) => id !== member.id);
  member.homeId = null;
}

function moveUnit(state, members, house) {
  for (const m of members) {
    leaveHouse(state, m);
    house.residents.push(m.id);
    m.homeId = house.id;
  }
}

function room(house) {
  return capacityOf(house) - house.residents.length;
}

// The couple ends up under one roof: husband's house, else wife's house, else both homeless (assignHomes rehouses them).
function joinHouseholds(state, husband, wife) {
  if (husband.homeId != null && husband.homeId === wife.homeId) return;
  const wifeUnit = unitOf(state, wife);
  const husbandUnit = unitOf(state, husband);
  const hh = houseOf(state, husband);
  const wh = houseOf(state, wife);
  if (hh && room(hh) >= wifeUnit.length) moveUnit(state, wifeUnit, hh);
  else if (wh && room(wh) >= husbandUnit.length) moveUnit(state, husbandUnit, wh);
  else for (const m of [...wifeUnit, ...husbandUnit]) leaveHouse(state, m);
}

export function marry(state, husband, wife) {
  linkSpouses(husband, wife);
  wife.surname = husband.surname;
  joinHouseholds(state, husband, wife);
  pushEvent(state, `💍 ${fullName(husband)} แต่งงานกับ ${fullName(wife)}`);
}

// Each eligible woman marries the closest eligible man (not kin) with probability MARRY_CHANCE.
export function processMarriages(state, rand) {
  const single = state.villagers.filter((v) => v.spouseId == null && !v.sick
    && v.age >= MARRY_MIN && v.age <= MARRY_MAX);
  const women = single.filter((v) => v.gender === 'f');
  let men = single.filter((v) => v.gender === 'm');
  let count = 0;
  for (const w of women) {
    const roll = rand();
    if (roll >= MARRY_CHANCE) continue;
    let best = null;
    let bestD = Infinity;
    for (const m of men) {
      if (related(w, m)) continue;
      const d = dist(w, m);
      if (d < bestD) {
        best = m;
        bestD = d;
      }
    }
    if (!best) continue;
    men = men.filter((m) => m !== best);
    marry(state, best, w);
    count += 1;
  }
  return count;
}

// ---------- pregnancy & birth ----------

function giveBirth(state, mother, rand) {
  const people = byId(state);
  const father = people.get(mother.pregnantBy ?? mother.spouseId) ?? null;
  const gender = rand() < 0.5 ? 'm' : 'f';
  const surname = father ? father.surname : mother.surname;
  const baby = createVillager(state, mother.x + (rand() - 0.5) * MAX_NEWBORN_OFFSET * 2,
    mother.z + (rand() - 0.5) * MAX_NEWBORN_OFFSET * 2, { gender, age: 0, surname });
  baby.name = pickGivenName(gender, rand);
  linkChild(baby, mother, father);
  if (!father && mother.pregnantBy != null) baby.parents = [mother.id, mother.pregnantBy];   // late father
  baby.deathAge = randRange(rand, DEATH_AGE_MIN, DEATH_AGE_MAX);
  state.villagers.push(baby);
  const home = houseOf(state, mother);
  if (home) {
    home.residents.push(baby.id);   // babies always stay with the mother, even over capacity
    baby.homeId = home.id;
  }
  mother.pregnant = false;
  mother.pregnantDays = 0;
  mother.pregnantBy = null;
  state.births = (state.births ?? 0) + 1;
  pushEvent(state, `👶 ครอบครัว${surname}มีลูกคนใหม่ชื่อ ${baby.name}`);
  return baby;
}

function canConceive(state, w, people) {
  if (w.gender !== 'f' || w.pregnant || w.sick || w.spouseId == null) return false;
  if (w.age < FERTILE_MIN || w.age > FERTILE_MAX || !people.has(w.spouseId)) return false;
  const home = houseOf(state, w);
  return home != null && home.residents.length < capacityOf(home) && home.happiness >= PREGNANCY_MIN_HAPPINESS;
}

export function processPregnancies(state, rand) {
  const people = byId(state);
  for (const w of [...state.villagers]) {
    if (!w.pregnant) continue;
    w.pregnantDays += 1;
    if (w.pregnantDays >= PREGNANCY_DAYS) giveBirth(state, w, rand);
  }
  for (const w of state.villagers) {
    if (!canConceive(state, w, people)) continue;
    if (rand() >= PREGNANCY_CHANCE) continue;
    w.pregnant = true;
    w.pregnantDays = 0;
    w.pregnantBy = w.spouseId;
    pushEvent(state, `🤰 ${fullName(w)} ตั้งครรภ์`);
  }
}

// Midnight family business: children leave full homes, couples marry, wives conceive, babies arrive.
export function processFamilies(state, rand) {
  leaveHome(state);
  processMarriages(state, rand);
  processPregnancies(state, rand);
}

// ---------- queries ----------

export function villagerAt(state, x, z, maxDist = 1.5) {
  let best = null;
  let bestD = maxDist;
  for (const v of state.villagers) {
    const d = Math.hypot(v.x - x, v.z - z);
    if (d <= bestD) {
      best = v;
      bestD = d;
    }
  }
  return best;
}

const ROLE_STATUS = { sleeping: 'sleeping', worker: 'working', builder: 'builder' };

function statusOf(v) {
  const out = [];
  if (v.sick) out.push('sick');
  if (v.pregnant) out.push('pregnant');
  out.push(ROLE_STATUS[v.role] ?? 'idle');
  return out;
}

function nameOfDeparted(state, id) {
  return state.departed?.[id] ?? '?';
}

export function villagerInfo(state, id) {
  const people = byId(state);
  const v = people.get(id);
  if (!v) return null;
  const job = v.jobId != null ? state.buildings.find((b) => b.id === v.jobId) : null;
  const home = houseOf(state, v);
  const spouse = v.spouseId != null ? people.get(v.spouseId) : null;
  const kids = v.children.map((c) => people.get(c)).filter(Boolean);
  const grandkids = kids.flatMap((k) => k.children.map((c) => people.get(c)).filter(Boolean));
  const brief = (p) => ({ id: p.id, name: fullName(p), age: Math.floor(p.age) });
  return {
    id: v.id, name: v.name, surname: v.surname, fullName: fullName(v), gender: v.gender,
    age: Math.floor(v.age), stage: stageOf(v), status: statusOf(v),
    job: job ? { id: job.id, type: job.type, name: BUILDINGS[job.type].name } : null,
    home: home ? { id: home.id, level: home.level } : null,
    spouse: spouse ? { id: spouse.id, name: fullName(spouse) } : null,
    parents: v.parents.map((pid) => {
      const p = people.get(pid);
      return { id: pid, name: p ? fullName(p) : nameOfDeparted(state, pid), alive: p != null };
    }),
    children: kids.map(brief),
    grandchildren: grandkids.map(brief),
  };
}

function pickHead(members) {
  const adults = members.filter((m) => stageOf(m) !== 'child');
  const pool = adults.length > 0 ? adults : members;
  const married = pool.filter((m) => m.spouseId != null && members.some((o) => o.id === m.spouseId));
  const ranked = (married.length > 0 ? married : pool).slice()
    .sort((a, b) => (a.gender === b.gender ? 0 : a.gender === 'm' ? -1 : 1) || b.age - a.age || a.id - b.id);
  return ranked[0];
}

export function household(state, houseId) {
  const house = state.buildings.find((b) => b.id === houseId && b.type === 'house');
  if (!house) return [];
  const people = byId(state);
  const members = house.residents.map((id) => people.get(id)).filter(Boolean);
  if (members.length === 0) return [];
  const head = pickHead(members);
  const spouse = head.spouseId != null ? people.get(head.spouseId) : null;
  const childIds = new Set([...head.children, ...(spouse ? spouse.children : [])]);
  const grandIds = new Set();
  for (const cid of childIds) for (const g of people.get(cid)?.children ?? []) grandIds.add(g);
  const RANK = { 'หัวหน้าครอบครัว': 0, 'คู่สมรส': 1, 'พ่อ': 2, 'แม่': 2, 'ลูก': 3, 'หลาน': 4, 'ผู้อาศัย': 5 };
  const relationOf = (m) => {
    if (m.id === head.id) return 'หัวหน้าครอบครัว';
    if (m.id === head.spouseId) return 'คู่สมรส';
    if (childIds.has(m.id)) return 'ลูก';
    if (grandIds.has(m.id)) return 'หลาน';
    if (head.parents.includes(m.id)) return m.gender === 'f' ? 'แม่' : 'พ่อ';
    return 'ผู้อาศัย';
  };
  return members
    .map((m) => ({
      id: m.id, fullName: fullName(m), age: Math.floor(m.age), gender: m.gender, stage: stageOf(m),
      relation: relationOf(m), status: statusOf(m), _age: m.age,
    }))
    .sort((a, b) => RANK[a.relation] - RANK[b.relation] || b._age - a._age || a.id - b.id)
    .map(({ _age, ...row }) => row);
}

// ---------- summary counts ----------

export function populationCounts(state) {
  let children = 0;
  let elders = 0;
  let pregnant = 0;
  for (const v of state.villagers) {
    const st = stageOf(v);
    if (st === 'child') children += 1;
    else if (st === 'elder') elders += 1;
    if (v.pregnant) pregnant += 1;
  }
  return { children, elders, pregnant, adults: state.villagers.length - children - elders };
}

// ---------- save migration (v2 -> v3) ----------

// Gives every villager a gender, age, names and family links. Housemates are paired into couples
// (one man + one woman where possible); leftover residents become their children when the ages allow.
export function migrateVillagersToV3(state) {
  const seed = state.seed ?? 0;
  const rand = mulberry32((Math.imul(seed | 0, 2654435761) ^ 0x9e3779b9) >>> 0);
  const used = [];
  for (const v of state.villagers) {
    const gender = mulberry32((Math.imul(seed | 0, 40503) + v.id) >>> 0)() < 0.5 ? 'm' : 'f';
    const surname = pickSurname(rand, used);
    used.push(surname);
    Object.assign(v, {
      gender, age: randRange(rand, 18, 50), deathAge: randRange(rand, DEATH_AGE_MIN, DEATH_AGE_MAX),
      name: pickGivenName(gender, rand), surname, spouseId: null, parents: [], children: [],
      pregnant: false, pregnantDays: 0, pregnantBy: null,
    });
  }
  const people = byId(state);
  for (const house of state.buildings) {
    if (house.type !== 'house') continue;
    const members = (house.residents ?? []).map((id) => people.get(id)).filter(Boolean)
      .sort((a, b) => a.id - b.id);
    const men = members.filter((m) => m.gender === 'm');
    const women = members.filter((m) => m.gender === 'f');
    const couples = [];
    for (let i = 0; i < Math.min(men.length, women.length); i++) {
      linkSpouses(men[i], women[i]);
      women[i].surname = men[i].surname;
      couples.push([men[i], women[i]]);
    }
    const extras = [...men.slice(couples.length), ...women.slice(couples.length)].sort((a, b) => a.id - b.id);
    for (const e of extras) {
      const parents = couples.find(([h, w]) => Math.min(h.age, w.age) - e.age >= PARENT_MIN_GAP);
      if (!parents) continue;
      const [h, w] = parents;
      linkChild(e, w, h);
      e.surname = h.surname;
    }
  }
  state.births = 0;
  state.deaths = 0;
  state.departed = {};
}
