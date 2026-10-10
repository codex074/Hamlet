// Sickness: nightly rolls, untreated villagers moving away. Pure: no DOM, no globals.
import {
  SICK_CHANCE_PER_DAY, SICK_HUNGRY_MUL, SICK_COVERED_MUL, SICK_LEAVE_DAYS,
} from './config.js';
import { difficultyOf } from './settings.js';
import { pushEvent } from './events.js';
import { fullName } from './names.js';
import { failVillager, removeVillager } from './villagers.js';

// Existing patients get a day worse; those past the limit leave the village.
export function ageSickness(state) {
  const leaving = [];
  for (const v of state.villagers) {
    if (!v.sick) continue;
    v.sickDays += 1;
    if (v.sickDays >= SICK_LEAVE_DAYS) leaving.push(v.id);
  }
  const hasClinic = state.buildings.some((b) => b.built && b.type === 'infirmary');
  for (const id of leaving) {
    const v = state.villagers.find((w) => w.id === id);
    pushEvent(state, `🤒 ${v ? fullName(v) : 'ชาวบ้าน'} ป่วยหนักจนย้ายออก`, {
      kind: 'warn', x: v?.x, z: v?.z,
      detail: `ป่วยติดกัน ${SICK_LEAVE_DAYS} วันโดยไม่ได้รับการรักษา · `
        + (hasClinic ? 'สถานพยาบาลอาจขาดสมุนไพรหรือหมอ' : 'ยังไม่มีสถานพยาบาล — สร้างสถานพยาบาลและคนเก็บสมุนไพร'),
    });
    removeVillager(state, id);
  }
  return leaving.length;
}

function sickChance(state, v) {
  const home = state.buildings.find((b) => b.id === v.homeId);
  let p = SICK_CHANCE_PER_DAY * difficultyOf(state).sickness;
  if (home?.starvedToday) p *= SICK_HUNGRY_MUL;
  if (home?.needsMet?.health) p *= SICK_COVERED_MUL;
  return p;
}

// Each healthy villager may fall ill; returns how many did.
export function rollSickness(state, rand) {
  let count = 0;
  for (const v of state.villagers) {
    if (v.sick || rand() >= sickChance(state, v)) continue;
    v.sick = true;
    v.sickDays = 0;
    v.healer = null;
    failVillager(state, v);   // drop whatever they were doing; planNext sends them to rest
    count += 1;
  }
  if (count > 0) pushEvent(state, `ชาวบ้านป่วย ${count} คน`);
  return count;
}

export function processSickness(state, rand) {
  ageSickness(state);
  rollSickness(state, rand);
}
