// Beginner checklist card (top-left): the current step with a "show me" button, progress, collapse and skip.
// The steps and their progress live in the sim (src/tutorial.js); this is DOM only.
import { DAY_LENGTH } from '../config.js';
import * as sim from '../sim.js';

const PREF_OFF = 'hamlet-tutorial-off';       // "don't show the checklist in new villages"
const PREF_FOLD = 'hamlet-tutorial-folded';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
function pref(key) {
  try { return localStorage.getItem(key) === '1'; } catch (e) { return false; }
}
function setPref(key, on) {
  try { if (on) localStorage.setItem(key, '1'); else localStorage.removeItem(key); } catch (e) { /* private mode */ }
}

function nearestNodeTo(state, kind, x, z) {
  let best = null;
  let bd = Infinity;
  for (const n of state.nodes) {
    if (n.kind !== kind || n.amount < 1) continue;
    const d = Math.hypot(n.x - x, n.z - z);
    if (d < bd && sim.isOwned(state, n.x, n.z)) { best = n; bd = d; }
  }
  return best;
}

// opts: { root, call(name, ...args), toast(text), pointTo(toolId), openWorkforce() }
export function createTutorialCard({ root, call, toast, pointTo, openWorkforce }) {
  const card = el('div', 'tut');
  card.id = 'tutorial';
  card.hidden = true;
  root.appendChild(card);
  let folded = pref(PREF_FOLD);
  let sig = '';
  let seen = null;          // ids already done when we last looked (to celebrate new ones)
  let lastState = null;
  let confirming = false;
  let autoSkipChecked = false;

  card.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  card.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tact]');
    if (!b || !lastState) return;
    const act = b.dataset.tact;
    if (act === 'fold') { folded = !folded; setPref(PREF_FOLD, folded); sig = ''; render(lastState); }
    else if (act === 'skip') { confirming = true; sig = ''; render(lastState); }
    else if (act === 'cancel') { confirming = false; sig = ''; render(lastState); }
    else if (act === 'confirm') {
      const never = card.querySelector('input[name="never"]');
      setPref(PREF_OFF, !!(never && never.checked));
      sim.skipTutorial(lastState);
      confirming = false;
      toast('ข้ามคำแนะนำแล้ว — เปิดใหม่ได้ที่ ☰ → 🎯 คำแนะนำเริ่มต้น');
      sig = '';
      render(lastState);
    } else if (act === 'done') {
      sim.skipTutorial(lastState);   // finished: just hide it
      sig = '';
      render(lastState);
    } else if (act === 'show') {
      showMe(lastState);
    }
  });

  function showMe(state) {
    const view = sim.tutorialView(state);
    const step = view.current;
    if (!step || !step.action) return;
    const a = step.action;
    const hall = state.buildings.find((b) => b.type === 'townhall');
    if (a.kind === 'workforce') {
      openWorkforce();
    } else if (a.kind === 'tool') {
      call('selectTool', a.tool);
      pointTo(a.tool.kind === 'zone' ? `zone:${a.tool.zone}` : `build:${a.tool.type}`);
      const target = a.focus === 'berry' ? nearestNodeTo(state, 'berry', hall.x, hall.z)
        : a.focus === 'tree' ? nearestNodeTo(state, 'tree', hall.x, hall.z) : hall;
      if (target) call('focusAt', target.x, target.z);
    } else if (a.kind === 'building') {
      const b = state.buildings.find((x) => x.type === a.type && x.built) || state.buildings.find((x) => x.type === a.type);
      if (b) {
        call('focusAt', b.x, b.z);
        if (b.built) call('selectBuilding', b.id);
        else toast('กำลังสร้างอยู่ — รอให้เสร็จก่อนแล้วค่อยเลือกคนงาน');
      } else {
        toast('ยังไม่มีอาคารนี้ — วางก่อนแล้วรอให้สร้างเสร็จ');
      }
    } else if (a.kind === 'speed') {
      call('setSpeed', 3);
      toast('⏩ เร่งเวลา 3× แล้ว');
    }
  }

  function stepsHtml(view) {
    let h = '<ol class="tut-steps">';
    for (const s of view.steps) {
      const cur = view.current && view.current.id === s.id;
      h += `<li class="${s.done ? 'done' : cur ? 'cur' : 'todo'}"><span class="tut-mark">${s.done ? '✅' : cur ? '👉' : '⬜'}</span>`
        + `<span class="tut-t">${esc(s.title)}</span>`;
      if (cur) {
        h += `<div class="tut-text">${esc(s.text)}</div>`;
        if (s.action) h += '<button type="button" class="btn small primary" data-tact="show">👀 แสดงให้ดู</button>';
      }
      h += '</li>';
    }
    return `${h}</ol>`;
  }

  function render(state) {
    lastState = state;
    if (!state) return;
    const view = sim.tutorialView(state);
    // a returning player who switched the checklist off: skip it in a brand-new village
    if (!autoSkipChecked) {
      autoSkipChecked = true;
      if (view.active && view.doneCount === 0 && (state.time ?? 0) < DAY_LENGTH && pref(PREF_OFF)) {
        sim.skipTutorial(state);
        card.hidden = true;
        return;
      }
    }
    if (!view.active) { card.hidden = true; sig = 'off'; seen = null; return; }
    const ids = view.steps.filter((s) => s.done).map((s) => s.id);
    if (seen) {
      for (const s of view.steps) {
        if (s.done && !seen.includes(s.id)) toast(`✅ ${s.title}`);
      }
    }
    seen = ids;
    const next = `${ids.join(',')}|${folded}|${confirming}|${view.complete}`;
    if (next === sig) return;
    sig = next;
    card.hidden = false;
    card.classList.toggle('folded', folded);
    const pct = Math.round((view.doneCount / view.total) * 100);
    let h = '<div class="tut-head">'
      + `<span class="tut-title">🎯 เริ่มต้นหมู่บ้าน</span><span class="tut-count">${view.doneCount}/${view.total}</span>`
      + `<button type="button" class="tut-ic" data-tact="fold" title="${folded ? 'ขยาย' : 'ย่อ'}">${folded ? '▾' : '▴'}</button>`
      + '<button type="button" class="tut-ic" data-tact="skip" title="ข้ามคำแนะนำ">✕</button></div>'
      + `<div class="tut-bar"><i style="width:${pct}%"></i></div>`;
    if (confirming) {
      h += '<div class="tut-confirm"><div>ข้ามคำแนะนำสำหรับมือใหม่?</div>'
        + '<label><input type="checkbox" name="never"> ไม่ต้องแสดงในหมู่บ้านใหม่</label>'
        + '<div class="tut-row"><button type="button" class="btn small" data-tact="cancel">ยกเลิก</button>'
        + '<button type="button" class="btn small primary" data-tact="confirm">ข้าม</button></div></div>';
    } else if (view.complete) {
      h += '<div class="tut-done">🎉 <b>ยอดเยี่ยม!</b> หมู่บ้านของคุณพร้อมเติบโตแล้ว<br>'
        + '<span class="dim">ระบบอื่นๆ (ตลาด ฤดูกาล ครอบครัว มหาวิหาร) ดูได้ที่ ☰ → 📖 วิธีเล่น</span>'
        + '<div class="tut-row"><button type="button" class="btn small primary" data-tact="done">ปิด</button></div></div>';
    } else if (folded) {
      h += view.current ? `<div class="tut-fold">👉 ${esc(view.current.title)}</div>` : '';
    } else {
      h += stepsHtml(view);
    }
    card.innerHTML = h;
  }

  // Menu: show the checklist again.
  function reopen(state) {
    if (!state) return;
    sim.resumeTutorial(state);
    setPref(PREF_OFF, false);
    folded = false;
    setPref(PREF_FOLD, false);
    seen = null;
    sig = '';
    render(state);
  }

  return { render, reopen };
}
