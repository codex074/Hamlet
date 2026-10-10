// In-game settings panel (☰ -> ⚙️ ตั้งค่า): difficulty (per world, changeable any time) and
// graphics (per device, applied live through src/render/graphics.js).
import * as CFG from '../config.js';

export const DIFF_LEVELS = [
  ['easy', 'ง่าย', 'ชาวบ้านหิวช้า ป่วยน้อย ผู้อพยพมาก สร้างถูก ภาษีดี'],
  ['normal', 'ปกติ', 'สมดุลตามที่ออกแบบไว้'],
  ['hard', 'ยาก', 'หิวเร็ว ป่วยบ่อย ผู้อพยพน้อย สร้างแพง ภาษีน้อย'],
];

// Effect rows. `aliases` are tried in order against config DIFFICULTY (shape is [level][key] or [key][level]);
// `good` says which direction helps the player; `fallback` are the spec values (§4).
const EFFECTS = [
  { id: 'hunger', label: '🍽️ อัตราความหิว', aliases: ['hunger', 'hungerRate', 'hungerMul'], good: -1, fb: [0.75, 1, 1.25] },
  { id: 'sick', label: '🤒 โอกาสป่วย', aliases: ['sickness', 'sick', 'sicknessChance', 'sickChance'], good: -1, fb: [0.5, 1, 1.5] },
  { id: 'immig', label: '🚶 ผู้อพยพเข้า', aliases: ['immigration', 'immigrants', 'immigrationCount', 'immigrate'], good: 1, fb: [1.4, 1, 0.7] },
  { id: 'preg', label: '🤰 โอกาสตั้งครรภ์', aliases: ['pregnancy', 'pregnancyChance', 'birth', 'fertility'], good: 1, fb: [1.3, 1, 0.8] },
  { id: 'cost', label: '🔨 ค่าก่อสร้าง (ใหม่)', aliases: ['cost', 'buildCost', 'construction', 'constructionCost'], good: -1, fb: [0.75, 1, 1.25] },
  { id: 'tax', label: '🪙 ภาษี', aliases: ['tax', 'taxes', 'taxIncome'], good: 1, fb: [1.2, 1, 0.85] },
];

function diffValue(effect, level, idx) {
  const D = CFG.DIFFICULTY;
  if (D && typeof D === 'object') {
    for (const a of effect.aliases) {
      const v = D[level] && D[level][a] != null ? D[level][a] : (D[a] && D[a][level] != null ? D[a][level] : null);
      if (Number.isFinite(Number(v))) return Number(v);
    }
  }
  return effect.fb[idx];
}

const fmtMul = (v) => `×${Math.round(v * 100) / 100}`;

// Shared with the guide: <table> of every effect at every level (current = level to highlight).
export function difficultyTableHtml(current) {
  let h = '<table class="gt dt"><tr><th>ผลต่อเกม</th>';
  for (const [id, name] of DIFF_LEVELS) h += `<th class="${id === current ? 'cur' : ''}">${name}</th>`;
  h += '</tr>';
  for (const e of EFFECTS) {
    h += `<tr><td>${e.label}</td>`;
    DIFF_LEVELS.forEach(([id], i) => {
      const v = diffValue(e, id, i);
      const cls = Math.abs(v - 1) < 0.005 ? '' : (v - 1) * e.good > 0 ? 'good' : 'bad';
      h += `<td class="${cls}${id === current ? ' cur' : ''}">${fmtMul(v)}</td>`;
    });
    h += '</tr>';
  }
  return `${h}</table>`;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function seg(opts, onPick) {
  const wrap = el('div', 'ws-seg');
  wrap.setAttribute('role', 'radiogroup');
  const btns = opts.map(([val, label]) => {
    const b = el('button', 'ws-opt', label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => onPick(val));
    wrap.appendChild(b);
    return { b, val };
  });
  return {
    el: wrap,
    set(v) {
      for (const { b, val } of btns) {
        const on = String(val) === String(v);
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      }
    },
  };
}

let graphicsMod;   // undefined = not tried, null = unavailable
async function loadGraphics() {
  if (graphicsMod !== undefined) return graphicsMod;
  try {
    const m = await import('../render/graphics.js');
    graphicsMod = typeof m.getGraphics === 'function' && typeof m.setGraphics === 'function' ? m : null;
  } catch {
    graphicsMod = null;
  }
  return graphicsMod;
}

// opts: { root, getState, setDifficulty(level) -> result|undefined, toast(text) }
export function createSettingsPanel({ root = document.body, getState, setDifficulty, toast } = {}) {
  let back = null;
  let onKey = null;
  let unsub = null;

  function close() {
    if (!back) return;
    back.remove();
    back = null;
    window.removeEventListener('keydown', onKey, true);
    if (typeof unsub === 'function') { try { unsub(); } catch { /* ignore */ } }
    unsub = null;
  }

  // ----- difficulty page -----
  function difficultyPage(page) {
    const state = getState ? getState() : null;
    const canSet = typeof setDifficulty === 'function';
    let current = (state && state.difficulty) || 'normal';
    page.appendChild(el('p', 'st-lead', 'เปลี่ยนความยากได้ทุกเมื่อ มีผลทันทีกับหมู่บ้านนี้ (ค่าก่อสร้างมีผลกับอาคารที่วางใหม่เท่านั้น)'));
    const list = el('div', 'st-radios');
    const rows = DIFF_LEVELS.map(([id, name, desc]) => {
      const lab = el('label', 'st-radio');
      const r = el('input');
      r.type = 'radio';
      r.name = 'difficulty';
      r.value = id;
      r.disabled = !canSet;
      const t = el('span', 'st-rt');
      t.append(el('b', null, name), el('span', 'st-rd', desc));
      lab.append(r, t);
      list.appendChild(lab);
      r.addEventListener('change', () => {
        if (!r.checked) return;
        const res = setDifficulty(id);
        if (res && res.ok === false) {
          toast && toast(res.reason || 'เปลี่ยนความยากไม่ได้');
        } else {
          current = id;
          toast && toast(`ความยาก: ${name}`);
        }
        refresh();
      });
      return { r, id, lab };
    });
    page.appendChild(list);
    const tbl = el('div', 'st-table');
    page.append(el('div', 'st-sub', 'ผลของแต่ละระดับ (เทียบกับ "ปกติ")'), tbl);
    page.appendChild(el('div', 'scr-hint', 'สีเขียว = เป็นผลดีต่อผู้เล่น · สีแดง = เป็นผลเสีย'));
    if (!canSet) page.appendChild(el('div', 'st-warn', 'เวอร์ชันนี้ยังเปลี่ยนความยากระหว่างเล่นไม่ได้'));
    function refresh() {
      const st = getState ? getState() : null;
      if (st && st.difficulty) current = st.difficulty;
      for (const row of rows) {
        row.r.checked = row.id === current;
        row.lab.classList.toggle('on', row.id === current);
      }
      tbl.innerHTML = difficultyTableHtml(current);
    }
    refresh();
  }

  // ----- graphics page -----
  async function graphicsPage(page) {
    const g = await loadGraphics();
    if (!g) {
      page.appendChild(el('p', 'st-lead', 'ยังไม่มีตัวเลือกกราฟิกในเวอร์ชันนี้'));
      return;
    }
    page.appendChild(el('p', 'st-lead', 'ตั้งค่ากราฟิกของอุปกรณ์นี้ มีผลทันที — ถ้าเครื่องช้าหรือร้อน ให้เลือก "ต่ำ"'));
    const apply = (partial) => { try { g.setGraphics(partial); } catch (e) { console.error(e); } sync(); };

    const row = (label, ctl, hint) => {
      const r = el('div', 'ws-row');
      r.append(el('div', 'ws-lbl', label), ctl);
      if (hint) r.appendChild(el('div', 'scr-hint', hint));
      page.appendChild(r);
    };
    const preset = seg([['low', 'ต่ำ'], ['medium', 'กลาง'], ['high', 'สูง']], (v) => apply({ preset: v }));
    const shadows = seg([['off', 'ปิด'], ['low', 'ต่ำ'], ['high', 'สูง']], (v) => apply({ shadows: v }));
    const grass = seg([[0, 'ไม่มี'], [0.5, 'บางตา'], [1, 'เต็ม']], (v) => apply({ grass: v }));
    const effects = seg([[true, 'เปิด'], [false, 'ปิด']], (v) => apply({ effects: v }));
    const ratio = seg([[1, '1× (เบา)'], ['auto', 'อัตโนมัติ (คมชัด)']], (v) => apply({ pixelRatio: v }));
    const fps = seg([[true, 'แสดง'], [false, 'ซ่อน']], (v) => apply({ showFps: v }));
    row('🎚️ ชุดตั้งค่า', preset.el, 'เลือกชุดสำเร็จรูป แล้วปรับรายการด้านล่างต่อได้');
    row('🌑 เงา', shadows.el);
    row('🌿 หญ้าและรายละเอียดพื้น', grass.el);
    row('✨ เอฟเฟกต์ (ควัน ฝุ่น แสง)', effects.el);
    row('🖥️ ความละเอียด', ratio.el, 'อัตโนมัติคมชัดบนจอ Retina แต่ใช้แรงเครื่องมากกว่า');
    row('📈 ตัวนับ FPS', fps.el);

    function sync() {
      let cur = {};
      try { cur = g.getGraphics() || {}; } catch { /* ignore */ }
      preset.set(cur.preset);
      shadows.set(cur.shadows);
      grass.set(cur.grass);
      effects.set(!!cur.effects);
      ratio.set(cur.pixelRatio);
      fps.set(!!cur.showFps);
    }
    sync();
    if (typeof g.onGraphicsChange === 'function') {
      try { unsub = g.onGraphicsChange(sync); } catch { /* ignore */ }
    }
  }

  function open(tab = 'difficulty') {
    if (back) close();
    back = el('div', 'backdrop');
    const box = el('div', 'modal-box st-box');
    box.appendChild(el('h2', null, '⚙️ ตั้งค่า'));
    const tabs = el('div', 'st-tabs');
    const body = el('div', 'st-body');
    const defs = [['difficulty', '⚔️ ความยาก'], ['graphics', '🖼️ กราฟิก']];
    const btns = defs.map(([id, label]) => {
      const b = el('button', 'st-tab', label);
      b.type = 'button';
      b.addEventListener('click', () => show(id));
      tabs.appendChild(b);
      return { b, id };
    });
    async function show(id) {
      if (typeof unsub === 'function') { try { unsub(); } catch { /* ignore */ } }
      unsub = null;
      for (const x of btns) x.b.classList.toggle('active', x.id === id);
      body.textContent = '';
      body.scrollTop = 0;
      const page = el('div', 'st-page');
      body.appendChild(page);
      if (id === 'graphics') await graphicsPage(page);
      else difficultyPage(page);
    }
    const act = el('div', 'modal-actions');
    const ok = el('button', 'btn primary', 'ปิด');
    ok.type = 'button';
    ok.addEventListener('click', close);
    act.appendChild(ok);
    box.append(tabs, body, act);
    back.appendChild(box);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    onKey = (e) => { if (e.code === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('keydown', onKey, true);
    root.appendChild(back);
    show(tab);
  }

  return { open, close, get isOpen() { return !!back; } };
}
