// Manual job assignment: the player decides who works where. Nobody is ever put into a job automatically.
// A villager holds one assignment: a workplace (v.jobId), the builder crew (v.builder) or nothing.
// Assignments survive sickness, pregnancy and paused buildings (the villager just waits); they are
// cleared only when the workplace is gone or the villager can never do it again (e.g. an elder in a heavy job).
// Pure: no DOM, no globals.
import { BUILDINGS } from './config.js';
import { pushEvent } from './events.js';
import { fullName } from './names.js';
import { failVillager } from './villagers.js';
import { getBuilding, getVillager, stageOf, canTakeJob } from './taskutil.js';

export const BUILDER = 'builder';

// What the person working at each workplace is called (the uniform they wear matches it).
export const JOB_TITLE = {
  woodcutter: 'คนตัดไม้', forager: 'คนเก็บของป่า', quarry: 'ช่างหิน', sawmill: 'ช่างเลื่อย', farmhouse: 'ชาวนา',
  mill: 'คนโม่แป้ง', bakery: 'คนทำขนมปัง', chapel: 'นักบวช', tavern: 'เจ้าของโรงเตี๊ยม', fishery: 'ชาวประมง',
  hunter: 'นักล่า', herbalist: 'คนเก็บสมุนไพร', forester: 'คนปลูกป่า', sheepfarm: 'คนเลี้ยงแกะ',
  ironmine: 'คนงานเหมือง', weaver: 'ช่างทอผ้า', blacksmith: 'ช่างตีเหล็ก', infirmary: 'หมอ', market: 'พ่อค้า',
};
export const BUILDER_TITLE = 'ช่างก่อสร้าง';

// Title of a villager's assignment ('ว่างงาน' when free).
export function jobTitleOf(state, v) {
  if (v.builder) return BUILDER_TITLE;
  const b = getBuilding(state, v.jobId);
  return b ? JOB_TITLE[b.type] ?? BUILDINGS[b.type]?.name ?? 'คนงาน' : 'ว่างงาน';
}

const isWorkplace = (b) => b.built && BUILDINGS[b.type]?.job != null;
const slotsOf = (b) => BUILDINGS[b.type]?.workers ?? 0;

// Workplaces in a stable order (type order of BUILDINGS, then id) — used for numbering and lists.
export function workplaces(state) {
  const order = Object.keys(BUILDINGS);
  return state.buildings.filter(isWorkplace)
    .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || a.id - b.id);
}

// "คนตัดไม้" or "คนตัดไม้ 2" when the village has more than one of that type.
export function workplaceName(state, b) {
  const name = BUILDINGS[b.type]?.name ?? b.type;
  const same = state.buildings.filter((o) => o.type === b.type && o.built).sort((p, q) => p.id - q.id);
  return same.length > 1 ? `${name} ${same.indexOf(b) + 1}` : name;
}

// Permanent reasons a villager can never take this assignment (temporary ones — sick, pregnant — are allowed).
function blockReason(v, target) {
  const stage = stageOf(v);
  if (stage === 'child') return 'เด็กยังทำงานไม่ได้';
  if (target === BUILDER) return stage === 'elder' ? 'ผู้สูงอายุทำงานก่อสร้างไม่ไหว' : null;
  if (stage === 'elder' && BUILDINGS[target.type]?.light !== true) return 'ผู้สูงอายุทำได้เฉพาะงานเบา';
  return null;
}

// Why an assigned villager is not working right now (null when they can work).
export function waitingReason(state, v) {
  if (v.jobId == null && !v.builder) return null;
  if (v.sick) return 'ป่วยอยู่ จะกลับไปทำงานเมื่อหาย';
  if (v.pregnant) return 'ตั้งครรภ์ จะกลับไปทำงานหลังคลอด';
  const job = getBuilding(state, v.jobId);
  if (job?.paused) return 'อาคารหยุดชั่วคราว รอจนกว่าจะแก้ปัญหาได้';
  return null;
}

// Drops whatever the villager is doing (returning any load to a storage) so the new assignment starts now.
function restart(state, v) {
  if (v.role === 'sleeping') return;   // finish the night first
  failVillager(state, v);
}

function detach(state, v) {
  const old = getBuilding(state, v.jobId);
  if (old) old.workers = old.workers.filter((id) => id !== v.id);
  v.jobId = null;
  v.builder = false;
}

// target: null (unassign), BUILDER, or a workplace building id. Returns { ok, reason? }.
export function assignJob(state, vId, target) {
  const v = getVillager(state, vId);
  if (!v) return { ok: false, reason: 'ไม่พบชาวบ้านคนนี้' };
  if (target == null) {
    if (v.jobId == null && !v.builder) return { ok: true };
    detach(state, v);
    restart(state, v);
    return { ok: true };
  }
  if (target === BUILDER) {
    if (v.builder) return { ok: true };
    const why = blockReason(v, BUILDER);
    if (why) return { ok: false, reason: why };
    detach(state, v);
    v.builder = true;
    restart(state, v);
    return { ok: true };
  }
  const b = getBuilding(state, target);
  if (!b || !isWorkplace(b)) return { ok: false, reason: 'อาคารนี้ยังรับคนงานไม่ได้' };
  if (v.jobId === b.id) return { ok: true };
  const why = blockReason(v, b);
  if (why) return { ok: false, reason: why };
  if (b.workers.length >= slotsOf(b)) return { ok: false, reason: `${workplaceName(state, b)} คนงานเต็มแล้ว` };
  detach(state, v);
  v.jobId = b.id;
  b.workers.push(v.id);
  restart(state, v);
  return { ok: true };
}

// Every assignment the villager could be given, for the job picker.
// [{ key: null|'builder'|bId, name, count, max|null, current, ok, reason }]
export function jobChoices(state, vId) {
  const v = getVillager(state, vId);
  if (!v) return [];
  const builders = state.villagers.filter((w) => w.builder).length;
  const out = [
    { key: null, name: 'ว่างงาน', count: null, max: null, current: v.jobId == null && !v.builder, ok: true },
  ];
  const bWhy = blockReason(v, BUILDER);
  out.push({ key: BUILDER, name: BUILDER_TITLE, count: builders, max: null, current: !!v.builder, ok: !bWhy, reason: bWhy });
  for (const b of workplaces(state)) {
    const current = v.jobId === b.id;
    const full = !current && b.workers.length >= slotsOf(b);
    const why = blockReason(v, b) ?? (full ? 'คนงานเต็มแล้ว' : null);
    out.push({
      key: b.id, type: b.type, name: workplaceName(state, b), title: JOB_TITLE[b.type] ?? null,
      light: BUILDINGS[b.type].light === true, count: b.workers.length, max: slotsOf(b),
      current, ok: !why, reason: why,
    });
  }
  return out;
}

// Villagers who could fill a slot at building bId: free people first, then those working elsewhere.
// [{ id, name, gender, age, stage, current: null|'builder'|bId, currentName, sick, pregnant }]
export function jobCandidates(state, bId) {
  const b = getBuilding(state, bId);
  if (!b || !isWorkplace(b)) return [];
  const out = [];
  for (const v of state.villagers) {
    if (v.jobId === b.id || blockReason(v, b)) continue;
    const cur = v.builder ? BUILDER : v.jobId;
    const curB = getBuilding(state, v.jobId);
    out.push({
      id: v.id, name: fullName(v), gender: v.gender, age: Math.floor(v.age ?? 0), stage: stageOf(v),
      current: cur ?? null, currentName: v.builder ? BUILDER_TITLE : curB ? workplaceName(state, curB) : null,
      sick: !!v.sick, pregnant: !!v.pregnant,
    });
  }
  const rank = (c) => (c.current == null ? 0 : 1);
  return out.sort((p, q) => rank(p) - rank(q) || (p.stage === 'adult' ? 0 : 1) - (q.stage === 'adult' ? 0 : 1)
    || p.name.localeCompare(q.name, 'th') || p.id - q.id);
}

// Counts for the HUD: people able to hold a job, how many are free, builders and empty workplace slots.
export function workforceSummary(state) {
  let able = 0;
  let free = 0;
  let builders = 0;
  for (const v of state.villagers) {
    if (stageOf(v) === 'child') continue;
    able += 1;
    if (v.builder) builders += 1;
    else if (v.jobId == null) free += 1;
  }
  let openSlots = 0;
  for (const b of workplaces(state)) openSlots += Math.max(0, slotsOf(b) - b.workers.length);
  const sites = state.buildings.filter((b) => !b.built || b.upgrading).length;
  return { able, free, builders, openSlots, sites };
}

// Once per game second: keep `b.workers` in step with the villagers' assignments and drop the ones that
// can never be held again. Never fills a job by itself.
export function syncJobs(state) {
  const posts = new Map(workplaces(state).map((b) => [b.id, b]));
  for (const b of state.buildings) b.workers = [];
  for (const v of state.villagers) {
    const grownUp = stageOf(v) !== 'child';
    if (!grownUp) v.minor = true;
    else if (v.minor) {
      delete v.minor;
      pushEvent(state, `🧑 ${fullName(v)} โตเป็นผู้ใหญ่แล้ว พร้อมรับงาน`, { kind: 'family', vId: v.id });
    }
    if (v.builder && blockReason(v, BUILDER)) {
      v.builder = false;
      notifyDropped(state, v, 'ช่างก่อสร้าง');
    }
    if (v.jobId == null) continue;
    const b = posts.get(v.jobId);
    if (!b) {
      v.jobId = null;   // demolished or no longer a workplace
      continue;
    }
    if (blockReason(v, b)) {
      v.jobId = null;
      notifyDropped(state, v, workplaceName(state, b));
      continue;
    }
    if (b.workers.length >= slotsOf(b)) {
      v.jobId = null;   // more people than slots (old saves): the extras become free
      continue;
    }
    b.workers.push(v.id);
    // the post can work again (building resumed, worker recovered): drop the idle stroll and go
    if (v.role === 'idle' && !v.carry && !b.paused && canTakeJob(v, b)
      && v.queue.every((t) => t.kind === 'goto' || t.kind === 'wait')) v.queue = [];
  }
}

function notifyDropped(state, v, jobName) {
  pushEvent(state, `👴 ${fullName(v)} อายุมากแล้ว ทำงาน${jobName}ไม่ไหว — ว่างงาน`, {
    kind: 'info', vId: v.id, detail: 'ผู้สูงอายุทำได้เฉพาะงานเบา (เก็บของป่า โบสถ์ โรงเตี๊ยม ฯลฯ) เลือกงานใหม่ให้ได้ที่ 👥 จัดการงาน',
  });
}
