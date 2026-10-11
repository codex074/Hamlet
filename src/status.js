// Building health: detects why a workplace cannot produce, pauses it so its workers wait instead of looping,
// and resumes it automatically once the cause is gone. Also keeps rolling food production/consumption stats.
import {
  BUILDINGS, RESOURCE_INFO, FOODS, DAY_LENGTH, FIELD_RADIUS, GATHER_RADIUS, HUNT_RADIUS, HUNGER_PER_SEC, HUNGRY_AT,
} from './config.js';
import { difficultyOf } from './settings.js';
import { distance, storages, nearestStorageWithAll } from './economy.js';
import { isOwned } from './territory.js';
import { pushEvent } from './events.js';
import { seasonEffects } from './seasons.js';
import { farmsGrowing } from './farming.js';

const HOUR = DAY_LENGTH / 24;
const WALKING_SHARE = 1.1;
export const PAUSE_AFTER = 2 * HOUR;     // a blocked workplace is paused after 2 game hours
const NODE_NAME = { tree: 'ต้นไม้', rock: 'ก้อนหิน', berry: 'พุ่มเบอร์รี่', ore: 'สายแร่เหล็ก' };
const resName = (r) => RESOURCE_INFO[r]?.name ?? r;

// Returns null when the building can work, else { code, text, blocking }.
// `blocking` problems pause the building; the others are warnings only.
export function buildingProblem(state, b) {
  if (!b.built || b.upgrading) return null;
  const cfg = BUILDINGS[b.type];
  if (!cfg?.job) return null;
  if (!state.buildings.some((s) => s.built && BUILDINGS[s.type].storage)) {
    return { code: 'no-storage', text: 'ไม่มีโกดังให้เก็บของ', blocking: true };
  }
  switch (cfg.job) {
    case 'gather': {
      const any = state.nodes.some((n) => n.kind === cfg.node && n.amount >= 1
        && distance(n.x, n.z, b.x, b.z) <= GATHER_RADIUS && isOwned(state, n.x, n.z));
      if (!any) return { code: 'no-resource', text: `ไม่มี${NODE_NAME[cfg.node] ?? 'ทรัพยากร'}ในระยะ ${GATHER_RADIUS} ม.`, blocking: true };
      break;
    }
    case 'farm': {
      const field = state.zones.some((z) => z.kind === 'field' && distance(z.x, z.z, b.x, b.z) <= FIELD_RADIUS);
      if (!field) return { code: 'no-field', text: `ไม่มีโซนไร่นาในระยะ ${FIELD_RADIUS} ม.`, blocking: true };
      break;
    }
    case 'process': {
      if (!nearestStorageWithAll(state, b.x, b.z, cfg.input) && !busyProducing(state, b)) {
        const need = Object.keys(cfg.input).map(resName).join(', ');
        // e.g. every farm switched to corn: say why no wheat is coming
        const noFarm = cfg.input.wheat && farmsGrowing(state, 'wheat').length === 0 ? ' — ไม่มีฟาร์มที่ปลูกข้าวสาลี' : '';
        return { code: 'no-input', text: `ขาดวัตถุดิบ: ${need}${noFarm}`, blocking: true };
      }
      break;
    }
    case 'fish': {
      if (Array.isArray(b.shore) && b.shore.length === 0) return { code: 'no-water', text: 'ไม่มีจุดตกปลาริมน้ำในระยะ', blocking: true };
      break;
    }
    case 'hunt': {
      const deer = (state.animals || []).some((a) => a.kind === 'deer'
        && distance(a.x, a.z, b.x, b.z) <= HUNT_RADIUS && isOwned(state, a.x, a.z));
      if (!deer) return { code: 'no-game', text: `ไม่มีกวางในระยะ ${HUNT_RADIUS} ม.`, blocking: true };
      break;
    }
    case 'market': {
      const sell = Array.isArray(b.sell) ? b.sell : [cfg.supply];
      const any = sell.some((r) => (b.stock?.[r] ?? 0) > 0 || storages(state).some((s) => (s.stock[r] ?? 0) > 0));
      if (sell.length === 0) return { code: 'no-goods', text: 'ยังไม่ได้เลือกสินค้าที่จะขาย', blocking: false };
      if (!any) return { code: 'no-supply', text: 'ไม่มีสินค้าที่เลือกไว้ในโกดังเลย — ร้านว่างเปล่า', blocking: false };
      break;
    }
    default: {
      if (cfg.supply && (b.stock?.[cfg.supply] ?? 0) <= 0
        && !storages(state).some((s) => (s.stock[cfg.supply] ?? 0) > 0)) {
        return { code: 'no-supply', text: `ขาด${resName(cfg.supply)} — บริการยังไม่ได้ผล`, blocking: false };
      }
    }
  }
  if ((cfg.workers ?? 0) > 0 && (b.workers?.length ?? 0) === 0) {
    return { code: 'no-workers', text: 'ยังไม่มีคนงาน — กด "เพิ่มคนงาน" เพื่อมอบหมาย', blocking: false };
  }
  return null;
}

// Some worker is already carrying inputs to (or processing at) this building.
function busyProducing(state, b) {
  return state.villagers.some((v) => v.jobId === b.id
    && (v.carry || (v.queue || []).some((t) => t.kind === 'produce' && t.bId === b.id)));
}

// Once per game second: refresh problems, pause buildings blocked for PAUSE_AFTER, resume fixed ones.
export function updateBuildingStatus(state) {
  for (const b of state.buildings) {
    const p = buildingProblem(state, b);
    if (!p) {
      if (b.paused) pushEvent(state, `▶️ ${BUILDINGS[b.type].name} กลับมาทำงานแล้ว`, { kind: 'info', bId: b.id, x: b.x, z: b.z });
      b.problem = null;
      b.paused = false;
      continue;
    }
    // a paused building whose blocking cause is gone resumes (its 'no workers' warning is then expected)
    if (b.paused && !p.blocking) {
      pushEvent(state, `▶️ ${BUILDINGS[b.type].name} กลับมาทำงานแล้ว`, { kind: 'info', bId: b.id, x: b.x, z: b.z });
      b.paused = false;
    }
    if (!b.problem || b.problem.code !== p.code) b.problem = { ...p, since: state.time };
    else b.problem.text = p.text;
    if (p.blocking && !b.paused && state.time - b.problem.since >= PAUSE_AFTER) {
      b.paused = true;
      pushEvent(state, `⚠️ ${BUILDINGS[b.type].name} หยุดชั่วคราว: ${p.text}`, {
        kind: 'warn', bId: b.id, x: b.x, z: b.z,
        detail: 'คนงานยังประจำอาคารนี้แต่จะรอจนกว่าจะแก้ปัญหาได้ อาคารจะกลับมาทำงานเอง หรือย้ายคนงานไปงานอื่นได้ที่แผงอาคาร',
      });
    }
  }
}

// ---------------------------------------------------------------- food statistics

// 24 hourly buckets of food produced / eaten (rolling game day).
function foodLog(state) {
  if (!state.foodLog || !Array.isArray(state.foodLog.buckets)) {
    state.foodLog = { start: state.time, hour: Math.floor(state.time / HOUR), buckets: Array.from({ length: 24 }, () => ({ in: 0, out: 0 })) };
  }
  const log = state.foodLog;
  const hour = Math.floor(state.time / HOUR);
  // clear the buckets of hours that passed since the last record
  for (let h = log.hour + 1; h <= hour && h - log.hour <= 24; h++) log.buckets[h % 24] = { in: 0, out: 0 };
  if (hour - log.hour > 24) log.buckets = Array.from({ length: 24 }, () => ({ in: 0, out: 0 }));
  log.hour = Math.max(log.hour, hour);
  return log;
}

export function recordFood(state, res, n, eaten = false) {
  if (!FOODS.includes(res)) return;
  const log = foodLog(state);
  log.buckets[log.hour % 24][eaten ? 'out' : 'in'] += n;
}

// Meals the whole village needs per game day (each villager eats when hunger reaches HUNGRY_AT).
export function foodDemandPerDay(state) {
  // ×WALKING_SHARE: walking adds hunger (WALK_HUNGER_PER_M), about a tenth on a typical day
  const mealsEach = (DAY_LENGTH * HUNGER_PER_SEC * WALKING_SHARE * seasonEffects(state).hunger
    * (difficultyOf(state)?.hunger ?? 1)) / HUNGRY_AT;
  return Math.round(state.villagers.length * mealsEach);
}

// { inPerDay, outPerDay, demandPerDay, net (production − demand), stock, hoursLeft|null }
export function foodSummary(state, stockTotals) {
  const log = foodLog(state);
  let inDay = 0;
  let outDay = 0;
  for (const bk of log.buckets) { inDay += bk.in; outDay += bk.out; }
  // until a full day has been recorded, extrapolate from the hours observed so far (at least one)
  const observedHours = Math.min(24, Math.max(1, (state.time - (log.start ?? state.time)) / HOUR));
  inDay = Math.round((inDay * 24) / observedHours);
  outDay = Math.round((outDay * 24) / observedHours);
  const stock = FOODS.reduce((a, f) => a + (stockTotals[f] ?? 0), 0);
  // compare against what people NEED: actual eating is capped by whatever food exists
  const demandPerDay = foodDemandPerDay(state);
  const net = inDay - demandPerDay;
  const hoursLeft = net < 0 ? Math.max(0, (stock / -net) * 24) : null;
  return { inPerDay: inDay, outPerDay: outDay, demandPerDay, net, stock, hoursLeft };
}
