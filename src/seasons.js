// Seasons and weather. The season follows the day number; the weather of each half-day is rolled from
// the seed, so it is the same on every device and after a reload. Snow cover (state.snow, 0..1) builds up
// while it snows and melts otherwise. Pure: no DOM, no globals.
import {
  DAY_LENGTH, SEASON_DAYS, SEASONS, RAIN_THIRST_MUL, SNOW_FALL_PER_SEC, SNOW_MELT_PER_SEC,
} from './config.js';

const HALF_DAY = DAY_LENGTH / 2;

function hash01(a, b) {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

// { index, key, name, icon, day (1..SEASON_DAYS), progress (0..1 through the season), year (1..), ...multipliers }
export function seasonOf(state) {
  const dayIndex = Math.floor((state.time ?? 0) / DAY_LENGTH);
  const n = Math.floor(dayIndex / SEASON_DAYS);
  const index = n % SEASONS.length;
  const inSeason = (state.time ?? 0) / DAY_LENGTH - n * SEASON_DAYS;
  return {
    ...SEASONS[index], index,
    day: Math.floor(inSeason) + 1, progress: inSeason / SEASON_DAYS,
    year: Math.floor(n / SEASONS.length) + 1,
  };
}

// Weather of the half-day containing `time`: 'clear' | 'rain' | 'snow', with an intensity 0..1.
export function weatherAt(state, time = state.time ?? 0) {
  const half = Math.floor(time / HALF_DAY);
  const season = seasonOf({ time });
  const r = hash01(state.seed ?? 0, half);
  if (r >= season.wet) return { kind: 'clear', intensity: 0 };
  return { kind: season.precip, intensity: 0.45 + 0.55 * hash01((state.seed ?? 0) + 7, half) };
}

// Multipliers the simulation uses right now.
export function seasonEffects(state) {
  const s = seasonOf(state);
  const w = weatherAt(state);
  return {
    farm: s.farm, berry: s.berry, hunger: s.hunger, sick: s.sick,
    thirst: s.thirst * (w.kind === 'rain' ? RAIN_THIRST_MUL : 1),
  };
}

// Once per game second: snow piles up while it snows and melts otherwise (twice as fast outside winter).
export function updateSnow(state, dt) {
  const w = weatherAt(state);
  const s = seasonOf(state);
  const cur = state.snow ?? 0;
  if (w.kind === 'snow') state.snow = Math.min(1, cur + SNOW_FALL_PER_SEC * w.intensity * dt);
  else if (cur > 0) state.snow = Math.max(0, cur - SNOW_MELT_PER_SEC * (s.key === 'winter' ? 1 : 2) * dt);
}

// Announces a new season (call once per day change).
export function seasonChangeText(state) {
  const s = seasonOf(state);
  if (s.day !== 1) return null;
  const notes = {
    spring: 'หิมะละลาย ไร่นาและพุ่มเบอร์รี่กลับมาโตตามปกติ',
    summer: 'อากาศร้อน ชาวบ้านกระหายน้ำเร็วขึ้น แต่ไร่นาและเบอร์รี่ให้ผลดี',
    autumn: 'ฤดูเก็บเกี่ยว — ไร่นาให้ผลดี แต่เบอร์รี่งอกช้าลง ฝนตกบ่อย',
    winter: 'หนาวและหิมะตก — ไร่นาได้ผลครึ่งเดียว เบอร์รี่งอกช้ามาก ชาวบ้านหิวเร็วและป่วยง่ายขึ้น เตรียมอาหารสำรองไว้',
  };
  return `${s.icon} เข้าสู่${s.name}${s.year > 1 ? ` (ปีที่ ${s.year})` : ''} — ${notes[s.key]}`;
}
