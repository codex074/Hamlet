// Beginner checklist: the first steps of a new village, ticked off from the state itself (so it can never
// get out of step with what the player actually did). Finished steps stay finished. Stored in
// state.tutorial = { done: { [id]: time }, skipped, startPop }. Pure: no DOM, no globals.
import { BUILDINGS } from './config.js';

const built = (state, type) => state.buildings.some((b) => b.type === type && b.built);
const placed = (state, type) => state.buildings.some((b) => b.type === type);

// action (for the UI): { kind: 'workforce' } | { kind: 'tool', tool, focus? } | { kind: 'building', type }
// | { kind: 'speed' } | null. focus: 'berry' | 'tree' | 'hall' tells the camera where to look.
export const TUTORIAL_STEPS = [
  {
    id: 'builders', title: 'มอบหมายช่างก่อสร้าง 2 คน',
    text: 'ชาวบ้านจะไม่ทำงานเองจนกว่าคุณจะเลือกให้ — เปิด 👷 จัดการงาน แล้วเลือก "ช่างก่อสร้าง" ให้ 2 คน ช่างจะขนวัสดุและสร้างทุกอย่างที่คุณวาง',
    check: (s) => s.villagers.filter((v) => v.builder).length >= 2,
    action: { kind: 'workforce' },
  },
  {
    id: 'zone', title: 'ระบายโซนที่อยู่อาศัย',
    text: 'แท็บ ที่อยู่ → 🏘️ โซนที่อยู่อาศัย แล้วลากระบายบนพื้นว่างใกล้ศาลากลาง ช่างจะสร้างบ้านให้คนไร้บ้านในโซนนี้',
    check: (s) => s.zones.some((z) => z.kind === 'residential'),
    action: { kind: 'tool', tool: { kind: 'zone', zone: 'residential' }, focus: 'hall' },
  },
  {
    id: 'forager', title: 'วางคนเก็บของป่า',
    text: 'แท็บ ทรัพยากร → 🧺 คนเก็บของป่า วางใกล้พุ่มเบอร์รี่ (พุ่มเขียวมีลูกแดง) ให้พุ่มไม้อยู่ในวงสีเหลือง — นี่คืออาหารชุดแรกของหมู่บ้าน',
    check: (s) => placed(s, 'forager'),
    action: { kind: 'tool', tool: { kind: 'build', type: 'forager' }, focus: 'berry' },
  },
  {
    id: 'foragerWorkers', title: 'เลือกคนงานให้คนเก็บของป่า',
    text: 'เมื่อสร้างเสร็จ คลิกอาคาร แล้วกด ＋ เพิ่มคนงาน เลือกชาวบ้านที่ว่าง (ใส่ได้ถึง 4 คน)',
    check: (s) => s.buildings.some((b) => b.type === 'forager' && b.built && (b.workers?.length ?? 0) > 0),
    action: { kind: 'building', type: 'forager' },
  },
  {
    id: 'harvest', title: 'ระบายเลือกต้นไม้ให้ตัด',
    text: 'แท็บ ทรัพยากร → 🪓 เก็บทรัพยากร แล้วระบายคลุมต้นไม้ใกล้ๆ (มีวงสีส้มขึ้น) ชาวบ้านที่ว่างงานจะไปตัดแล้วขนไม้เข้าโกดังเอง',
    check: (s) => s.nodes.some((n) => n.marked) || (s.tutorial?.harvested ?? false),
    action: { kind: 'tool', tool: { kind: 'zone', zone: 'harvest' }, focus: 'tree' },
  },
  {
    id: 'house', title: 'รอบ้านหลังแรกสร้างเสร็จ',
    text: 'ช่างก่อสร้างจะขนไม้มาสร้างบ้านในโซนเอง กด ⏩ 3× เพื่อเร่งเวลาได้',
    check: (s) => built(s, 'house'),
    action: { kind: 'speed' },
  },
  {
    id: 'well', title: 'สร้างบ่อน้ำใกล้บ้าน',
    text: `แท็บ บริการ → 🪣 บ่อน้ำ บ้านทุกหลังต้องมีแหล่งน้ำในระยะ ${BUILDINGS.well?.waterRadius ?? 35} ม. ชาวบ้านจะเดินไปดื่มที่บ่อที่ใกล้ที่สุด`,
    check: (s) => placed(s, 'well'),
    action: { kind: 'tool', tool: { kind: 'build', type: 'well' }, focus: 'hall' },
  },
  {
    id: 'grow', title: 'ให้หมู่บ้านเติบโต',
    text: 'ถ้าชาวบ้านมีความสุขและอาหารพอ จะมีคนใหม่ย้ายเข้ามาทุกเที่ยงคืน — มอบหมายงานให้คนใหม่ และดูอาคารที่ปลดล็อกเพิ่มในแถบด้านล่าง',
    check: (s) => s.villagers.length >= (s.tutorial?.startPop ?? 8) + 2,
    action: { kind: 'workforce' },
  },
];

// A brand-new village starts the checklist; `skip` (player preference) starts it already skipped.
export function startTutorial(state, skip = false) {
  state.tutorial = { done: {}, skipped: !!skip, startPop: state.villagers.length };
}

// Saves from before the checklist: those players already know the game.
export function ensureTutorial(state) {
  if (!state.tutorial) state.tutorial = { done: {}, skipped: true, startPop: state.villagers.length };
}

// Once per game second: tick off every step whose goal is met (in any order; finished steps stay finished).
export function updateTutorial(state) {
  const t = state.tutorial;
  if (!t || t.skipped || t.complete) return;
  if (state.nodes.some((n) => n.marked)) t.harvested = true;
  for (const step of TUTORIAL_STEPS) {
    if (!t.done[step.id] && step.check(state)) t.done[step.id] = state.time;
  }
  if (TUTORIAL_STEPS.every((s) => t.done[s.id] != null)) t.complete = state.time;
}

// What the UI shows: { active, complete, skipped, doneCount, total, current, steps: [{ id, title, text, done, action }] }
export function tutorialView(state) {
  const t = state.tutorial;
  if (!t) return { active: false, steps: [], total: TUTORIAL_STEPS.length, doneCount: 0 };
  const steps = TUTORIAL_STEPS.map((s) => ({
    id: s.id, title: s.title, text: s.text, action: s.action, done: t.done[s.id] != null,
  }));
  const current = steps.find((s) => !s.done) ?? null;
  return {
    active: !t.skipped, complete: !!t.complete, skipped: !!t.skipped,
    doneCount: steps.filter((s) => s.done).length, total: steps.length, current, steps,
  };
}

export function skipTutorial(state) {
  ensureTutorial(state);
  state.tutorial.skipped = true;
}

// Shows the checklist again (from the menu); steps already met are ticked straight away.
export function resumeTutorial(state) {
  ensureTutorial(state);
  state.tutorial.skipped = false;
  delete state.tutorial.complete;
  updateTutorial(state);
}
