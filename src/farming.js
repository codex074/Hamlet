// Crops: what each farm grows (player's choice), crops unlocking one by one as the village grows, and the
// recent harvest spots the renderer uses to show plants being cut and growing back. Pure: no DOM, no globals.
import { BUILDINGS, CROPS, HARVEST_MARKS, DAY_LENGTH } from './config.js';
import { pushEvent } from './events.js';

export const CROP_KEYS = Object.keys(CROPS);
export const cropOf = (b) => (b?.crop && CROPS[b.crop] ? b.crop : 'wheat');
const isFarm = (b) => BUILDINGS[b?.type]?.job === 'farm';

// Unlocks are remembered once reached, so a shrinking village never loses a crop it already grows.
// Villages from before crops existed start with whatever their population already allows (no events).
export function ensureCrops(state) {
  if (Array.isArray(state.cropsUnlocked)) return;
  state.cropsUnlocked = CROP_KEYS.filter((k) => state.villagers.length >= CROPS[k].unlockPop);
}

export function cropUnlocked(state, crop) {
  ensureCrops(state);
  return state.cropsUnlocked.includes(crop);
}

// Once per game second: announce each crop the village has grown enough to unlock.
export function updateCrops(state) {
  ensureCrops(state);
  for (const k of CROP_KEYS) {
    if (state.cropsUnlocked.includes(k) || state.villagers.length < CROPS[k].unlockPop) continue;
    state.cropsUnlocked.push(k);
    const c = CROPS[k];
    pushEvent(state, `${c.icon} ปลดล็อก${c.name}แล้ว — เลือกปลูกได้ที่แผงของฟาร์ม`, {
      kind: 'info', detail: `${c.name}: ${c.use}`,
    });
  }
}

export function setFarmCrop(state, bId, crop) {
  const b = state.buildings.find((x) => x.id === bId);
  if (!b || !isFarm(b)) return { ok: false, reason: 'ไม่ใช่ฟาร์ม' };
  if (!CROPS[crop]) return { ok: false, reason: 'ไม่มีพืชชนิดนี้' };
  if (!cropUnlocked(state, crop)) {
    return { ok: false, reason: `${CROPS[crop].name}ยังไม่ปลดล็อก (ต้องมีประชากร ${CROPS[crop].unlockPop} คน)` };
  }
  b.crop = crop;
  return { ok: true };
}

// A farmer just harvested at (x, z): remember it (newest last, at most HARVEST_MARKS, none older than a day).
export function recordHarvest(state, b, x, z) {
  const list = (b.harvests ??= []);
  list.push({ x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10, t: state.time });
  while (list.length > HARVEST_MARKS || (list.length && state.time - list[0].t > DAY_LENGTH)) list.shift();
}

// Farms that grow `crop` (e.g. so the mill can explain why no wheat is coming).
export function farmsGrowing(state, crop) {
  return state.buildings.filter((b) => isFarm(b) && cropOf(b) === crop);
}
