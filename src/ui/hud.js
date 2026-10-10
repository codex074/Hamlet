// HUD: top bar, build bar, speed controls, info panel, event log, toast.
// DOM only; all game data comes in through update(summary, state) / showInfo(building, state).
import {
  BUILDINGS, RESOURCES, RESOURCE_INFO, HOUSE_LEVELS, NEED_INFO, CATHEDRAL_STAGES,
  ZONE_BRUSH, GATHER_RADIUS, FIELD_RADIUS,
} from '../config.js';
import { clock, isUnlocked } from '../sim.js';

const UPDATE_INTERVAL_MS = 250;

const BUILDING_ICON = {
  storehouse: '📦', woodcutter: '🪓', forager: '🧺', quarry: '⛏️', sawmill: '🪚',
  farmhouse: '🌾', mill: '🌬️', bakery: '🥖', chapel: '⛪', tavern: '🍺', cathedral: '🏰',
};

const BUILDING_DESC = {
  storehouse: 'เก็บทรัพยากรของหมู่บ้าน ชาวบ้านนำของมาเก็บและหยิบไปใช้ที่นี่',
  woodcutter: `ตัดต้นไม้ในรัศมี ${GATHER_RADIUS} ม. แล้วส่งไม้ซุงเข้าโกดัง`,
  forager: `เก็บเบอร์รี่จากพุ่มไม้ในรัศมี ${GATHER_RADIUS} ม. เป็นอาหารเริ่มต้น`,
  quarry: `ขุดหินจากก้อนหินในรัศมี ${GATHER_RADIUS} ม.`,
  sawmill: 'แปรรูปไม้ซุงเป็นไม้แปรรูปสำหรับสร้างและอัปเกรดบ้าน',
  farmhouse: `ปลูกข้าวสาลีในโซนไร่นารัศมี ${FIELD_RADIUS} ม. ดินยิ่งอุดมยิ่งได้ผลผลิตมาก`,
  mill: 'บดข้าวสาลีเป็นแป้ง',
  bakery: 'อบแป้งเป็นขนมปัง อาหารที่ชนชั้นสูงขึ้นต้องการ',
  chapel: 'ให้บริการด้านศาสนาแก่บ้านที่อยู่ในรัศมี ต้องมีคนประจำ',
  tavern: 'ให้ความบันเทิงแก่บ้านที่อยู่ในรัศมี ต้องมีคนประจำ',
  cathedral: 'สิ่งก่อสร้างยิ่งใหญ่ สร้างทีละ 4 ขั้น ต้องใช้ทองด้วย สร้างได้เพียงหลังเดียว',
};

const NODE_NAME = { tree: 'ต้นไม้', rock: 'ก้อนหิน', berry: 'พุ่มเบอร์รี่' };
const SERVICE_NAME = { religion: 'ศาสนา', entertainment: 'ความบันเทิง' };

const ZONE_ITEMS = [
  { zone: 'residential', icon: '🏘️', name: 'โซนที่อยู่อาศัย',
    desc: 'ระบายพื้นที่ให้ชาวบ้านสร้างบ้านเอง (บ้านละ ไม้ซุง 6) ลากเมาส์เพื่อระบาย' },
  { zone: 'field', icon: '🌱', name: 'โซนไร่นา',
    desc: 'ระบายพื้นที่ปลูกข้าวสาลีให้ฟาร์ม ดินอุดมจะให้ผลผลิตมากกว่า' },
];

const TAB_DEFS = [
  { id: 'residential', label: 'ที่อยู่' },
  { id: 'resource', label: 'ทรัพยากร', category: 'resource' },
  { id: 'production', label: 'ผลิต', category: 'production' },
  { id: 'service', label: 'บริการ', category: 'service' },
  { id: 'monument', label: 'อนุสรณ์', category: 'monument' },
];

// ---------- small helpers ----------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const info = (res) => RESOURCE_INFO[res] || { name: res, icon: '' };
const pad2 = (n) => String(n).padStart(2, '0');

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function resNames(obj) {
  return Object.entries(obj || {}).map(([r, n]) => `${info(r).name} ${n}`).join(' + ');
}

function resIcons(obj) {
  return Object.entries(obj || {}).map(([r, n]) => `${info(r).icon}${n}`).join(' ');
}

function resChips(obj) {
  return Object.entries(obj || {})
    .filter(([, n]) => n > 0)
    .map(([r, n]) => `<span class="rc">${info(r).icon} ${info(r).name} ×${n}</span>`)
    .join('');
}

function jobLine(type) {
  const d = BUILDINGS[type];
  if (d.storage) return 'เก็บทรัพยากร · ไม่ต้องใช้คนงาน';
  const parts = [];
  if (d.workers) parts.push(`คนงาน ${d.workers}`);
  if (d.job === 'gather') parts.push(`${NODE_NAME[d.node] || d.node} → ${resNames(d.output)}`);
  else if (d.job === 'farm') parts.push(`ไร่นา → ${resNames(d.output)}`);
  else if (d.job === 'process') parts.push(`${resNames(d.input)} → ${resNames(d.output)}`);
  else if (d.job === 'service') parts.push(`บริการ${SERVICE_NAME[d.service] || ''} รัศมี ${d.serviceRadius} ม.`);
  return parts.join(' · ');
}

function happyFace(h) {
  if (h >= 0.75) return '😊';
  if (h >= 0.5) return '🙂';
  if (h >= 0.3) return '😐';
  if (h >= 0.15) return '😟';
  return '😠';
}

// ---------- HUD ----------
export function createHUD(root, handlers = {}) {
  const call = (name, ...args) => (handlers && typeof handlers[name] === 'function' ? handlers[name](...args) : undefined);
  const q = (sel) => root.querySelector(sel);

  const topbar = q('#topbar');
  const buildbar = q('#buildbar');
  const speedEl = q('#speed');
  const infoEl = q('#info');
  const eventsEl = q('#events');
  const tipEl = q('#tooltip');
  const toastEl = q('#toast');
  const menuEl = q('#menu');

  let lastState = null;
  let lastSummary = null;
  let lastUpdate = 0;
  let activeToolId = null;
  let openTab = 'residential';

  // Keep keyboard focus off HUD buttons (Space must always mean pause).
  for (const c of [buildbar, speedEl, infoEl, menuEl]) {
    c.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  }

  // ===== top bar =====
  const nums = {};
  function addChip(key, icon, title, cls) {
    const c = el('div', 'chip' + (cls ? ' ' + cls : ''));
    if (title) c.title = title;
    const ic = el('span', 'ic', icon);
    const num = el('span', 'num', '0');
    c.append(ic, num);
    topbar.appendChild(c);
    nums[key] = { chip: c, ic, num };
    return nums[key];
  }
  for (const res of RESOURCES) addChip(res, info(res).icon, info(res).name);
  addChip('gold', info('gold').icon, info('gold').name, 'gold');
  const popChip = addChip('pop', '👥', 'ประชากร');
  const popSub = el('span', 'sub', '');
  popChip.chip.appendChild(popSub);
  addChip('happy', '😊', 'ความสุขเฉลี่ย');
  addChip('clock', '☀️', 'เวลา', 'clock');

  // ===== tooltip =====
  function showTip(html, anchor) {
    tipEl.innerHTML = html;
    tipEl.classList.add('show');
    const r = anchor.getBoundingClientRect();
    const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(window.innerWidth - tw - 8, left));
    let top = r.top - th - 10;
    if (top < 8) top = r.bottom + 10;
    tipEl.style.left = `${left}px`;
    tipEl.style.top = `${top}px`;
  }
  function hideTip() { tipEl.classList.remove('show'); }

  // ===== build bar =====
  const toolButtons = []; // { btn, id, tab, type?, costs:[{span,res,n}], locked }
  const tabButtons = {};
  const panels = {};

  function toggleTool(tool, id) {
    if (activeToolId === id) call('selectTool', null);
    else call('selectTool', tool);
  }

  function makeToolButton(def) {
    const btn = el('button', 'bbtn');
    btn.type = 'button';
    btn.dataset.tool = def.id;
    btn.append(el('div', 'ic', def.icon), el('div', 'nm', def.name));
    const cs = el('div', 'cs');
    const costs = [];
    if (def.costText) {
      cs.textContent = def.costText;
    } else {
      for (const [res, n] of Object.entries(def.cost || {})) {
        const span = el('span', 'c', `${info(res).icon}${n}`);
        cs.appendChild(span);
        costs.push({ span, res, n });
      }
    }
    btn.appendChild(cs);
    const lk = el('div', 'lk', def.unlockPop != null ? `🔒 ปลดล็อกเมื่อประชากร ${def.unlockPop}` : '');
    btn.appendChild(lk);
    const rec = { btn, id: def.id, tab: def.tab, type: def.type, costs, locked: false, unlockPop: def.unlockPop };
    toolButtons.push(rec);
    btn.addEventListener('click', () => {
      if (rec.locked) { toast(`ปลดล็อกเมื่อประชากร ${def.unlockPop}`); return; }
      toggleTool(def.tool, def.id);
    });
    btn.addEventListener('mouseenter', () => showTip(def.tip(rec), btn));
    btn.addEventListener('mouseleave', hideTip);
    return rec;
  }

  const tabsRow = el('div', 'tabs');
  buildbar.appendChild(tabsRow);

  function makeTab(id, label) {
    const b = el('button', 'tab', label);
    b.type = 'button';
    tabsRow.appendChild(b);
    tabButtons[id] = b;
    return b;
  }

  for (const t of TAB_DEFS) {
    const tb = makeTab(t.id, t.label);
    const panel = el('div', 'items');
    panels[t.id] = panel;
    buildbar.appendChild(panel);
    tb.addEventListener('click', () => { openTab = openTab === t.id ? null : t.id; renderTabs(); hideTip(); });

    if (t.id === 'residential') {
      for (const z of ZONE_ITEMS) {
        const rec = makeToolButton({
          id: `zone:${z.zone}`, tab: t.id, icon: z.icon, name: z.name, costText: 'ฟรี',
          tool: { kind: 'zone', zone: z.zone },
          tip: () => `<b>${z.name}</b><br>${z.desc}<br><span class="dim">ขนาดแปรง ${ZONE_BRUSH.min}–${ZONE_BRUSH.max} ม. ปรับด้วย [ ]</span>`,
        });
        panel.appendChild(rec.btn);
      }
    } else {
      for (const [type, d] of Object.entries(BUILDINGS)) {
        if (d.category !== t.category) continue;
        const isCath = type === 'cathedral';
        const rec = makeToolButton({
          id: `build:${type}`, tab: t.id, type, icon: BUILDING_ICON[type] || '🏠', name: d.name,
          cost: d.cost, costText: isCath ? 'ทีละขั้น' : null, unlockPop: d.unlockPop,
          tool: { kind: 'build', type },
          tip: (r) => {
            let h = `<b>${d.name}</b><br>${BUILDING_DESC[type] || ''}`;
            const jl = jobLine(type);
            if (jl) h += `<br><span class="dim">${jl}</span>`;
            if (isCath) {
              h += `<br><span class="dim">ขั้นแรก: ${resIcons(CATHEDRAL_STAGES[0].cost)}</span>`;
            } else if (Object.keys(d.cost).length) {
              h += `<br><span class="dim">ค่าสร้าง ${resNames(d.cost)}</span>`;
            }
            if (r.locked) h += `<br><span class="warn">🔒 ปลดล็อกเมื่อประชากร ${d.unlockPop}</span>`;
            return h;
          },
        });
        panel.appendChild(rec.btn);
      }
    }
  }

  const demoTab = makeTab('demolish', '🔨 รื้อถอน');
  demoTab.classList.add('demolish');
  demoTab.dataset.tool = 'demolish';
  demoTab.addEventListener('click', () => toggleTool({ kind: 'demolish' }, 'demolish'));
  demoTab.addEventListener('mouseenter', () => showTip('<b>รื้อถอน</b><br>คลิกอาคารหรือโซนเพื่อรื้อ คืนวัสดุ 50%', demoTab));
  demoTab.addEventListener('mouseleave', hideTip);

  function renderTabs() {
    for (const t of TAB_DEFS) {
      tabButtons[t.id].classList.toggle('open', openTab === t.id);
      panels[t.id].hidden = openTab !== t.id;
      const hasActive = toolButtons.some((r) => r.tab === t.id && r.id === activeToolId);
      tabButtons[t.id].classList.toggle('has-active', hasActive);
    }
    demoTab.classList.toggle('active', activeToolId === 'demolish');
  }
  renderTabs();

  function setActiveTool(id) {
    activeToolId = id || null;
    for (const r of toolButtons) r.btn.classList.toggle('active', r.id === activeToolId);
    renderTabs();
  }

  // ===== speed + menu =====
  const speedBtns = {};
  const SPEEDS = [[0, '⏸'], [1, '1×'], [2, '2×'], [3, '3×']];
  for (const [n, label] of SPEEDS) {
    const b = el('button', null, label);
    b.type = 'button';
    b.title = n === 0 ? 'หยุด (Space)' : `ความเร็ว ${n}× (กด ${n})`;
    b.addEventListener('click', () => call('setSpeed', n));
    speedEl.appendChild(b);
    speedBtns[n] = b;
  }
  speedEl.appendChild(el('div', 'sep'));
  const menuBtn = el('button', null, '☰');
  menuBtn.type = 'button';
  menuBtn.title = 'เมนู';
  speedEl.appendChild(menuBtn);

  function setSpeedDisplay(n) {
    for (const [k, b] of Object.entries(speedBtns)) b.classList.toggle('active', Number(k) === n);
  }
  setSpeedDisplay(1);

  function addMenuItem(label, fn) {
    const b = el('button', null, label);
    b.type = 'button';
    b.addEventListener('click', () => { menuEl.hidden = true; fn(); });
    menuEl.appendChild(b);
  }
  addMenuItem('📖 วิธีเล่น', () => call('showHelp'));
  addMenuItem('💾 บันทึกเกม', () => { call('saveGame'); toast('บันทึกเกมแล้ว'); });
  addMenuItem('🆕 เกมใหม่', () => confirmDialog('เริ่มเกมใหม่?', 'หมู่บ้านปัจจุบันจะถูกลบและไม่สามารถกู้คืนได้', 'เกมใหม่', () => call('newGame')));

  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); menuEl.hidden = !menuEl.hidden; });
  document.addEventListener('click', (e) => {
    if (!menuEl.hidden && !menuEl.contains(e.target) && e.target !== menuBtn) menuEl.hidden = true;
  });

  function confirmDialog(title, body, okLabel, onOk) {
    const back = el('div', 'backdrop');
    const box = el('div', 'modal-box');
    box.append(el('h2', null, title), el('p', null, body));
    const act = el('div', 'modal-actions');
    const cancel = el('button', 'btn', 'ยกเลิก');
    const ok = el('button', 'btn danger', okLabel);
    cancel.type = ok.type = 'button';
    cancel.addEventListener('click', () => back.remove());
    ok.addEventListener('click', () => { back.remove(); onOk(); });
    back.addEventListener('mousedown', (e) => { if (e.target === back) back.remove(); });
    act.append(cancel, ok);
    box.appendChild(act);
    back.appendChild(box);
    root.appendChild(back);
  }

  // ===== toast =====
  let toastTimer = 0;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2500);
  }

  // ===== info panel =====
  let infoId = null;
  let infoSig = '';
  let infoBodyEl = null;
  let infoWkEl = null;
  let infoBodyHtml = '';

  function closeInfoPanel() {
    infoId = null;
    infoSig = '';
    infoEl.hidden = true;
    infoEl.textContent = '';
    infoBodyEl = infoWkEl = null;
    infoBodyHtml = '';
  }

  function findBuilding(state, id) {
    if (!state) return null;
    return state.buildings.find((b) => b.id === id) || null;
  }

  function isSite(b) {
    return !b.built || !!b.upgrading;
  }

  function buildInfoShell(b) {
    const def = BUILDINGS[b.type];
    infoEl.textContent = '';
    const head = el('div', 'info-head');
    head.appendChild(el('span', 'info-title', def.name));
    const x = el('button', 'x', '✕');
    x.type = 'button';
    x.title = 'ปิด (Esc)';
    x.addEventListener('click', () => { closeInfoPanel(); call('closeInfo'); });
    head.appendChild(x);
    infoEl.appendChild(head);
    infoWkEl = null;
    if (def.workers > 0 && b.built) {
      const row = el('div', 'wrow');
      row.appendChild(el('span', null, 'คนงาน'));
      const minus = el('button', null, '−');
      const wk = el('span', 'wk', '');
      const plus = el('button', null, '+');
      minus.type = plus.type = 'button';
      minus.addEventListener('click', () => adjustWorkers(-1));
      plus.addEventListener('click', () => adjustWorkers(1));
      row.append(minus, wk, plus);
      infoEl.appendChild(row);
      infoWkEl = wk;
    }
    infoBodyEl = el('div', 'info-body');
    infoEl.appendChild(infoBodyEl);
    infoBodyHtml = '';
    infoEl.hidden = false;
  }

  function adjustWorkers(delta) {
    const b = findBuilding(lastState, infoId);
    if (!b) return;
    const max = BUILDINGS[b.type].workers;
    const cur = b.desiredWorkers != null ? b.desiredWorkers : max;
    const next = Math.max(0, Math.min(max, cur + delta));
    if (next === cur) return;
    call('setWorkers', b.id, next);
    renderInfo(lastState);
  }

  function siteHtml(b, state) {
    const pct = Math.floor((b.progress || 0) * 100);
    let h = '';
    if (b.type === 'cathedral') {
      const st = CATHEDRAL_STAGES[Math.min(b.stage || 0, CATHEDRAL_STAGES.length - 1)];
      h += `<div class="stat">กำลังก่อสร้าง ขั้น ${(b.stage || 0) + 1}/${CATHEDRAL_STAGES.length}: ${st.name} ${pct}%</div>`;
    } else if (b.upgrading) {
      h += `<div class="stat">กำลังอัปเกรด ${pct}%</div>`;
    } else {
      h += `<div class="stat">กำลังก่อสร้าง ${pct}%</div>`;
    }
    h += `<div class="bar"><i style="width:${pct}%"></i></div>`;
    const miss = Object.entries(b.needed || {}).filter(([, n]) => n > 0);
    if (b.goldBlocked > 0) {
      h += `<div class="warn">🪙 รอทอง ${b.goldBlocked} เพื่อเริ่มขั้นนี้ (มี ${Math.floor(state.gold || 0)})</div>`;
    }
    if (miss.length) {
      h += `<div class="sub">วัสดุที่ขาด</div><div class="rcs">${resChips(Object.fromEntries(miss))}</div>`;
    } else if (!(b.goldBlocked > 0)) {
      h += '<div class="sub ok">วัสดุครบ รอช่างก่อสร้าง</div>';
    }
    return h;
  }

  function cathedralStagesHtml(b) {
    const stage = b.stage || 0;
    let h = '<div class="sub">ขั้นตอนการสร้าง</div><ul>';
    CATHEDRAL_STAGES.forEach((s, i) => {
      const done = i < stage;
      const cur = i === stage && stage < CATHEDRAL_STAGES.length;
      const mark = done ? '✅' : cur ? '🔨' : '⬜';
      let cost = resChips(s.cost);
      if (s.gold) cost += `<span class="rc">🪙 ทอง ×${s.gold}</span>`;
      h += `<li class="${cur ? 'cur' : done ? '' : 'dim'}">${mark} ${i + 1}. ${s.name}`;
      if (cur) h += `<div class="rcs">${cost}</div>`;
      h += '</li>';
    });
    return h + '</ul>';
  }

  function houseHtml(b) {
    const lvl = HOUSE_LEVELS[Math.max(0, Math.min(HOUSE_LEVELS.length - 1, (b.level || 1) - 1))];
    const res = (b.residents || []).length;
    let h = `<div class="stat ok">ระดับ ${lvl.level}: ${lvl.name}</div>`;
    h += `<div>👥 ผู้อยู่อาศัย ${res}/${lvl.capacity}</div>`;
    h += `<div>${happyFace(b.happiness != null ? b.happiness : 1)} ความสุข ${Math.round((b.happiness != null ? b.happiness : 1) * 100)}%</div>`;
    h += '<div class="sub">ความต้องการ</div><ul>';
    for (const n of lvl.needs) {
      const ok = b.needsMet && b.needsMet[n];
      h += `<li>${ok ? '✅' : '❌'} ${NEED_INFO[n] || n}</li>`;
    }
    h += '</ul>';
    const next = HOUSE_LEVELS[lvl.level];
    if (next) {
      const extra = next.needs.filter((n) => !lvl.needs.includes(n)).map((n) => NEED_INFO[n]).join(', ');
      h += `<div class="sub">ระดับถัดไป: ${next.name}`;
      if (extra) h += ` · ต้องการเพิ่ม ${extra}`;
      h += '</div>';
      if (next.upgradeCost) h += `<div class="rcs">${resChips(next.upgradeCost)}</div>`;
    } else {
      h += '<div class="sub ok">ระดับสูงสุดแล้ว</div>';
    }
    return h;
  }

  function stockHtml(b) {
    const entries = RESOURCES.filter((r) => b.stock && b.stock[r] > 0);
    let h = '<div class="sub">ของในคลัง</div>';
    if (!entries.length) return h + '<div class="dim">ว่างเปล่า</div>';
    h += '<div class="rcs">' + entries.map((r) => `<span class="rc">${info(r).icon} ${info(r).name} ${Math.floor(b.stock[r])}</span>`).join('') + '</div>';
    return h;
  }

  function infoBody(b, state) {
    const def = BUILDINGS[b.type];
    let h = '';
    if (b.type === 'cathedral') {
      if (isSite(b)) h += siteHtml(b, state);
      else h += '<div class="stat ok">สร้างเสร็จสมบูรณ์</div>';
      h += cathedralStagesHtml(b);
      return h;
    }
    if (isSite(b)) {
      h += siteHtml(b, state);
      if (b.type === 'house' && b.upgrading) h += houseHtml(b);
      return h;
    }
    if (b.type === 'house') return houseHtml(b);
    const working = !(def.workers > 0 && (b.workers || []).length === 0);
    h += working ? '<div class="stat ok">ทำงานปกติ</div>' : '<div class="stat warn">ยังไม่มีคนงาน</div>';
    if (def.storage || b.stock) h += stockHtml(b);
    return h;
  }

  function renderInfo(state) {
    if (infoId == null) return;
    const b = findBuilding(state, infoId);
    if (!b) { closeInfoPanel(); call('closeInfo'); return; }
    const sig = `${b.id}|${b.type}|${b.built}`;
    if (sig !== infoSig) { infoSig = sig; buildInfoShell(b); }
    if (infoWkEl) {
      const max = BUILDINGS[b.type].workers;
      const want = b.desiredWorkers != null ? b.desiredWorkers : max;
      setText(infoWkEl, `${(b.workers || []).length}/${want}`);
    }
    const html = infoBody(b, state);
    if (html !== infoBodyHtml) { infoBodyHtml = html; infoBodyEl.innerHTML = html; }
  }

  function showInfo(building, state) {
    if (state) lastState = state;
    if (!building) { closeInfoPanel(); return; }
    infoId = building.id;
    infoSig = '';
    renderInfo(lastState || { buildings: [building], gold: 0 });
  }

  // ===== events =====
  let eventsSig = '';
  function renderEvents(state) {
    const evs = (state.events || []).slice(-5).reverse();
    const sig = evs.map((e) => `${e.t}|${e.text}`).join('\n');
    if (sig === eventsSig) return;
    eventsSig = sig;
    eventsEl.textContent = '';
    evs.forEach((e, i) => {
      const row = el('div', 'ev', e.text);
      row.style.opacity = String(Math.max(0.3, 1 - i * 0.18));
      eventsEl.appendChild(row);
    });
  }

  // ===== per-tick update =====
  function refreshButtons(summary, state) {
    const pop = summary.pop || 0;
    for (const r of toolButtons) {
      if (r.type) {
        const locked = !isUnlocked(state, r.type);
        if (locked !== r.locked) {
          r.locked = locked;
          r.btn.classList.toggle('locked', locked);
        }
      }
      for (const c of r.costs) {
        const short = ((summary.stock && summary.stock[c.res]) || 0) < c.n;
        if (c.short !== short) { c.short = short; c.span.classList.toggle('short', short); }
      }
    }
    return pop;
  }

  function update(summary, state) {
    lastSummary = summary;
    lastState = state;
    const now = performance.now();
    if (now - lastUpdate < UPDATE_INTERVAL_MS) return;
    lastUpdate = now;

    const stock = summary.stock || {};
    for (const res of RESOURCES) setText(nums[res].num, String(Math.floor(stock[res] || 0)));
    setText(nums.gold.num, String(Math.floor(summary.gold || 0)));
    setText(nums.pop.num, String(summary.pop || 0));
    setText(popSub, ` (ไร้บ้าน ${summary.homeless || 0})`);
    nums.pop.chip.title = `ประชากร ${summary.pop || 0} · ที่อยู่อาศัยรองรับ ${summary.housing != null ? summary.housing : '-'}`;
    const h = summary.happiness != null ? summary.happiness : 1;
    setText(nums.happy.ic, happyFace(h));
    setText(nums.happy.num, `${Math.round(h * 100)}%`);
    const c = clock(state);
    setText(nums.clock.ic, c.isNight ? '🌙' : '☀️');
    setText(nums.clock.num, `วันที่ ${c.day} · ${pad2(c.hour)}:${pad2(c.minute)}`);

    refreshButtons(summary, state);
    renderEvents(state);
    renderInfo(state);
  }

  return { update, showInfo, toast, setActiveTool, setSpeedDisplay };
}
