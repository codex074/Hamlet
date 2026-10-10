// HUD: top bar, build bar, speed controls, info panel, event log, toast.
// DOM only; all game data comes in through update(summary, state) / showInfo(building, state).
import {
  BUILDINGS, RESOURCES, RESOURCE_INFO, HOUSE_LEVELS, NEED_INFO, CATHEDRAL_STAGES,
  ZONE_BRUSH, GATHER_RADIUS, FIELD_RADIUS, FISH_RADIUS, HUNT_RADIUS, FOODS, SUPPLY_MAX, TOOL_SPEED_BONUS,
  SICK_LEAVE_DAYS,
} from '../config.js';
import * as sim from '../sim.js';

const { clock, isUnlocked } = sim;

const UPDATE_INTERVAL_MS = 250;

const BUILDING_ICON = {
  storehouse: '📦', woodcutter: '🪓', forager: '🧺', quarry: '⛏️', sawmill: '🪚',
  farmhouse: '🌾', mill: '🌬️', bakery: '🥖', chapel: '⛪', tavern: '🍺', cathedral: '🏰',
  fishery: '🎣', hunter: '🏹', herbalist: '🌿', sheepfarm: '🐑', ironmine: '⚒️',
  weaver: '🧵', blacksmith: '🛠️', infirmary: '🏥', market: '🏪',
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
  fishery: 'ชาวประมงตกปลาจากชายน้ำ ต้องวางติดแหล่งน้ำ (แม่น้ำ) แล้วส่งปลาเข้าโกดัง เป็นอาหารเพิ่มความหลากหลาย',
  hunter: `นักล่าออกล่ากวางป่าในรัศมี ${HUNT_RADIUS} ม. แล้วส่งเนื้อเข้าโกดัง กวางมีจำนวนจำกัดแต่เกิดใหม่เรื่อยๆ`,
  herbalist: `เก็บสมุนไพรตามต้นไม้ในรัศมี ${GATHER_RADIUS} ม. โดยไม่ทำให้ต้นไม้หมด สมุนไพรใช้รักษาคนป่วยที่สถานพยาบาล`,
  sheepfarm: 'คอกแกะ เลี้ยงแกะสลับให้เนื้อและขนแกะ ขนแกะส่งต่อให้ช่างทอผ้า',
  ironmine: 'ขุดแร่เหล็กจากเส้นแร่บนที่สูง ส่งต่อให้โรงตีเหล็กทำเครื่องมือ',
  weaver: 'ทอขนแกะเป็นผ้า ผ้าไปเติมที่ตลาดเพื่อให้บ้านระดับสูงมีเสื้อผ้า',
  blacksmith: 'ตีแร่เหล็กเป็นเครื่องมือ อาคารผลิตที่มีเครื่องมือจะทำงานเร็วขึ้น และใช้อัปเกรดบ้านระดับสูงสุด',
  infirmary: 'หมอรักษาคนป่วยในรัศมี ต้องมีสมุนไพรในคลังของสถานพยาบาล และให้บริการด้านสุขภาพแก่บ้านรอบๆ',
  market: 'พ่อค้าขายผ้าให้บ้านในรัศมี ต้องมีผ้าในคลังของตลาด บ้านระดับ 4 ขึ้นไปต้องการเสื้อผ้า',
  cathedral: 'สิ่งก่อสร้างยิ่งใหญ่ สร้างทีละ 4 ขั้น ต้องใช้ทองด้วย สร้างได้เพียงหลังเดียว',
};

const NODE_NAME = { tree: 'ต้นไม้', rock: 'ก้อนหิน', berry: 'พุ่มเบอร์รี่', ore: 'เส้นแร่' };
const SERVICE_NAME = { religion: 'ศาสนา', entertainment: 'ความบันเทิง', health: 'สุขภาพ', clothing: 'เสื้อผ้า' };

// Top-bar resource groups (every RESOURCES entry appears in exactly one popover).
const RES_GROUPS = [
  { id: 'mat', label: 'วัสดุ', items: ['wood', 'planks', 'stone', 'ore', 'tools'], head: ['wood', 'planks', 'stone'] },
  { id: 'food', label: 'อาหาร', items: ['berries', 'bread', 'fish', 'meat', 'wheat', 'flour'], headTotal: FOODS },
  { id: 'goods', label: 'สินค้า', items: ['wool', 'cloth', 'herbs'], head: ['cloth', 'herbs'] },
];

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
  if (d.job === 'gather') parts.push(`${NODE_NAME[d.node] || d.node}${d.keepNode ? ' (ไม่ทำให้หมด)' : ''} → ${resNames(d.output)}`);
  else if (d.job === 'farm') parts.push(`ไร่นา → ${resNames(d.output)}`);
  else if (d.job === 'process') parts.push(`${resNames(d.input)} → ${resNames(d.output)}`);
  else if (d.job === 'service') parts.push(`บริการ${SERVICE_NAME[d.service] || ''} รัศมี ${d.serviceRadius} ม.`);
  else if (d.job === 'fish') parts.push(`ตกปลา (ติดน้ำ, รัศมี ${FISH_RADIUS} ม.) → ${resNames(d.output)}`);
  else if (d.job === 'hunt') parts.push(`ล่ากวาง (รัศมี ${HUNT_RADIUS} ม.) → ${resNames(d.output)}`);
  else if (d.job === 'ranch') parts.push(`เลี้ยงแกะ → ${(d.outputs || []).map(resNames).join(' / ')}`);
  else if (d.job === 'doctor' || d.job === 'market') {
    parts.push(`บริการ${SERVICE_NAME[d.service] || ''} รัศมี ${d.serviceRadius} ม. · ใช้${info(d.supply).name}`);
  }
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
  // 14 resources: three compact groups with a popover listing every item
  const heads = {};   // groupId -> { total?: node, items: {res: node} }
  const groupChips = [];
  for (const g of RES_GROUPS) {
    const chip = el('div', 'chip grp');
    chip.appendChild(el('span', 'gl', g.label));
    const hd = el('span', 'hd');
    const rec = { items: {}, total: null, g };
    if (g.headTotal) {
      const h = el('span', 'h');
      h.append(el('span', 'ic', '🍽️'), rec.total = el('span', 'num', '0'));
      h.title = `อาหารพร้อมกิน: ${g.headTotal.map((r) => info(r).name).join(' + ')}`;
      hd.appendChild(h);
    } else {
      for (const r of g.head) {
        const h = el('span', 'h');
        h.title = info(r).name;
        h.append(el('span', 'ic', info(r).icon), rec.items[r] = el('span', 'num', '0'));
        hd.appendChild(h);
      }
    }
    chip.appendChild(hd);
    chip.appendChild(el('span', 'caret', '▾'));
    const pop = el('div', 'gpop');
    pop.appendChild(el('div', 'gpt', g.label));
    const grid = el('div', 'gpg');
    for (const r of g.items) {
      const row = el('div', 'gpi');
      const n = el('span', 'num', '0');
      row.append(el('span', 'ic', info(r).icon), el('span', 'nm', info(r).name), n);
      grid.appendChild(row);
      nums[r] = { num: n };
    }
    pop.appendChild(grid);
    chip.appendChild(pop);
    chip.addEventListener('click', (e) => {
      if (pop.contains(e.target)) return;
      const open = !chip.classList.contains('open');
      for (const c of groupChips) c.classList.remove('open');
      chip.classList.toggle('open', open);
    });
    chip.addEventListener('mouseleave', () => chip.classList.remove('open'));
    topbar.appendChild(chip);
    groupChips.push(chip);
    heads[g.id] = rec;
  }
  document.addEventListener('click', (e) => {
    if (!topbar.contains(e.target)) for (const c of groupChips) c.classList.remove('open');
  });
  addChip('gold', info('gold').icon, info('gold').name, 'gold');
  const popChip = addChip('pop', '👥', 'ประชากร');
  const popSub = el('span', 'sub', '');
  popChip.chip.appendChild(popSub);
  const sickEl = el('span', 'sick', '');
  sickEl.hidden = true;
  popChip.chip.appendChild(sickEl);
  let popHover = false;
  popChip.chip.addEventListener('mouseenter', () => { popHover = true; showPopTip(); });
  popChip.chip.addEventListener('mouseleave', () => { popHover = false; hideTip(); });
  addChip('happy', '😊', 'ความสุขเฉลี่ย');
  const terrChip = addChip('terr', '🗺️', 'ดินแดนที่เป็นของคุณ / ทั้งหมด (คลิกเพื่อเปิดมุมมองดินแดน)', 'terr');
  terrChip.chip.hidden = true;
  terrChip.chip.style.cursor = 'pointer';
  terrChip.chip.addEventListener('click', () => toggleTool({ kind: 'territory' }, 'territory'));
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

  // Population breakdown (families spec §10); counts a missing field as unknown.
  function popTipHtml() {
    const s = lastSummary || {};
    const pop = s.pop || 0;
    const has = (k) => typeof s[k] === 'number';
    let h = `<b>ประชากร ${pop}</b>`;
    if (has('children') || has('elders')) {
      const ch = s.children || 0, el2 = s.elders || 0;
      h += `<br>ผู้ใหญ่ ${Math.max(0, pop - ch - el2)} · เด็ก ${ch} · ผู้สูงอายุ ${el2}`;
      h += `<br>ตั้งครรภ์ ${s.pregnant || 0}`;
    }
    if (has('births') || has('deaths')) h += `<br>เกิดทั้งหมด ${s.births || 0} · เสียชีวิต ${s.deaths || 0}`;
    h += `<br><span class="dim">ที่อยู่อาศัยรองรับ ${s.housing != null ? s.housing : '-'} · ไร้บ้าน ${s.homeless || 0}</span>`;
    return h;
  }
  function showPopTip() { showTip(popTipHtml(), nums.pop.chip); }

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

  // 🗺️ ดินแดน: territory view (plot grid, buy plots). Hidden until the sim exposes territories.
  const terrTab = makeTab('territory', '🗺️ ดินแดน');
  terrTab.classList.add('terr');
  terrTab.dataset.tool = 'territory';
  terrTab.hidden = true;
  terrTab.addEventListener('click', () => { hideTip(); toggleTool({ kind: 'territory' }, 'territory'); });
  terrTab.addEventListener('mouseenter', () => {
    const st = lastState;
    let price = '';
    try { if (st && typeof sim.plotPrice === 'function') price = `<br><span class="dim">แปลงถัดไปราคา 🪙 ${sim.plotPrice(st)}</span>`; } catch (e) { /* ignore */ }
    showTip(`<b>ดินแดน</b><br>แสดงเส้นแบ่งแปลง คลิกแปลงที่ติดกับดินแดนของคุณเพื่อซื้อ — วางอาคารและเก็บทรัพยากรได้เฉพาะในดินแดนของคุณ${price}`, terrTab);
  });
  terrTab.addEventListener('mouseleave', hideTip);

  function renderTabs() {
    for (const t of TAB_DEFS) {
      tabButtons[t.id].classList.toggle('open', openTab === t.id);
      panels[t.id].hidden = openTab !== t.id;
      const hasActive = toolButtons.some((r) => r.tab === t.id && r.id === activeToolId);
      tabButtons[t.id].classList.toggle('has-active', hasActive);
    }
    demoTab.classList.toggle('active', activeToolId === 'demolish');
    terrTab.classList.toggle('active', activeToolId === 'territory');
    terrChip.chip.classList.toggle('on', activeToolId === 'territory');
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
    return b;
  }
  function allAutoOn() {
    const houses = ((lastState && lastState.buildings) || []).filter((b) => b.type === 'house');
    return houses.length === 0 || houses.every((h) => h.autoUpgrade !== false);
  }
  function refreshMenu() {
    autoBtn.textContent = `⬆️ อัปเกรดอัตโนมัติทุกหลัง: ${allAutoOn() ? 'เปิด' : 'ปิด'}`;
  }
  addMenuItem('📖 วิธีเล่น', () => call('showHelp'));
  const autoBtn = addMenuItem('', () => {
    const on = !allAutoOn();
    call('setAutoUpgrade', null, on);
    toast(`อัปเกรดอัตโนมัติทุกหลัง: ${on ? 'เปิด' : 'ปิด'}`);
  });
  addMenuItem('⚙️ ตั้งค่า', () => call('showSettings'));
  addMenuItem('💾 บันทึกเกม', () => { call('saveGame'); toast('บันทึกเกมแล้ว'); });
  const cloud = !!(handlers && handlers.cloud);
  if (cloud) {
    // cloud villages are replaced by deleting / recreating them on the select screen
    addMenuItem('🏘️ กลับไปเลือกหมู่บ้าน', () => call('backToSelect'));
    addMenuItem('🚪 ออกจากระบบ', () => call('logout'));
  } else {
    addMenuItem('🆕 เกมใหม่', () => confirmDialog('เริ่มเกมใหม่?', 'หมู่บ้านปัจจุบันจะถูกลบและไม่สามารถกู้คืนได้', 'เกมใหม่', () => call('newGame')));
  }

  // cloud save status ("☁️ บันทึกแล้ว hh:mm" / "⚠️ บันทึกไม่สำเร็จ") under the speed buttons
  const saveEl = el('div', 'savestatus');
  saveEl.hidden = true;
  root.appendChild(saveEl);
  function setSaveStatus(kind, text) {
    saveEl.hidden = !text;
    setText(saveEl, text || '');
    saveEl.dataset.kind = kind || '';
  }

  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); refreshMenu(); menuEl.hidden = !menuEl.hidden; });
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
  let infoVid = null;   // villager id when the panel shows a villager instead of a building

  function closeInfoPanel() {
    infoId = null;
    infoVid = null;
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
    infoBodyEl.addEventListener('click', onInfoClick);
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

  const esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

  function levelOf(n) {
    return HOUSE_LEVELS[Math.max(0, Math.min(HOUSE_LEVELS.length - 1, (n || 1) - 1))];
  }

  function safeUpgradeStatus(state, b) {
    try {
      return typeof sim.upgradeStatus === 'function' ? sim.upgradeStatus(state, b) : null;
    } catch (e) {
      return null;
    }
  }

  function costChips(cost, missing) {
    return Object.entries(cost || {})
      .filter(([, n]) => n > 0)
      .map(([r, n]) => {
        const short = (missing && missing[r] > 0);
        return `<span class="rc${short ? ' short' : ''}">${info(r).icon} ${info(r).name} ×${n}${short ? ` (ขาด ${Math.ceil(missing[r])})` : ''}</span>`;
      }).join('');
  }

  // ---------- families & villagers ----------
  const STAGE_NAME = { child: 'เด็ก', adult: 'ผู้ใหญ่', elder: 'ผู้สูงอายุ' };
  const STATUS_INFO = {
    sick: ['🤒', 'ป่วย'], pregnant: ['🤰', 'ตั้งครรภ์'], sleeping: ['💤', 'หลับ'],
    working: ['🔨', 'ทำงาน'], idle: ['🚶', 'ว่าง'], builder: ['🏗️', 'ช่างก่อสร้าง'],
  };
  const genderIcon = (g) => (g === 'f' ? '<span class="gf">♀</span>' : g === 'm' ? '<span class="gm">♂</span>' : '');
  const ageText = (a) => `${Math.floor(Number(a) || 0)} ปี`;

  function stageIcon(stage, gender) {
    if (stage === 'child') return '👶';
    if (stage === 'elder') return gender === 'f' ? '👵' : '👴';
    return '';
  }

  // Icon string for a household row (stage + status).
  function statusIcons(m) {
    const st = Array.isArray(m.status) ? m.status : [];
    let out = stageIcon(m.stage, m.gender);
    for (const k of ['pregnant', 'sick', 'builder', 'working', 'sleeping']) {
      if (st.includes(k)) out += STATUS_INFO[k][0];
    }
    return out;
  }

  const vLink = (id, text) => `<button type="button" class="lnk" data-vid="${Number(id)}">${esc(text)}</button>`;
  const bLink = (id, text) => `<button type="button" class="lnk" data-bid="${Number(id)}">${esc(text)}</button>`;

  function safeCall(fn, ...args) {
    try { return typeof fn === 'function' ? fn(...args) : null; } catch (e) { return null; }
  }

  function familyHtml(b, state) {
    const members = safeCall(sim.household, state, b.id);
    if (!Array.isArray(members) || !members.length) return '';
    const byId = new Map(((state && state.villagers) || []).map((v) => [v.id, v]));
    let surname = '';
    for (const m of members) {
      const v = byId.get(m.id);
      surname = (v && v.surname) || '';
      if (!surname && m.fullName) surname = String(m.fullName).trim().split(/\s+/).slice(1).join(' ');
      if (surname) break;
    }
    let h = `<div class="sub">👪 ครอบครัว${esc(surname)}</div><ul class="fam">`;
    for (const m of members) {
      const rel = m.relation && m.relation !== 'ผู้อาศัย' ? m.relation : '';
      h += `<li>${genderIcon(m.gender)} ${vLink(m.id, m.fullName || m.name || `#${m.id}`)}
        <span class="dim">${ageText(m.age)}${rel ? ` · ${esc(rel)}` : ''}</span> <span class="si">${statusIcons(m)}</span></li>`;
    }
    return h + '</ul>';
  }

  function villagerFallback(state, id) {
    const v = ((state && state.villagers) || []).find((x) => x.id === id);
    if (!v) return null;
    const age = v.age != null ? v.age : 0;
    return {
      id: v.id, fullName: [v.name, v.surname].filter(Boolean).join(' ') || `ชาวบ้าน #${v.id}`, gender: v.gender,
      age, stage: age < 14 ? 'child' : age >= 55 ? 'elder' : 'adult',
      status: [v.sick ? 'sick' : null, v.pregnant ? 'pregnant' : null].filter(Boolean),
      job: null, home: null, spouse: null, parents: [], children: [], grandchildren: [],
    };
  }

  function villagerBody(vi, state) {
    const stage = vi.stage || 'adult';
    const sub = `${ageText(vi.age)} · ${STAGE_NAME[stage] || stage}`;
    let h = `<div class="stat">${genderIcon(vi.gender)} ${esc(sub)} ${stageIcon(stage, vi.gender)}</div>`;
    const chips = (vi.status || []).filter((k) => STATUS_INFO[k])
      .map((k) => `<span class="chp ${k}">${STATUS_INFO[k][0]} ${STATUS_INFO[k][1]}</span>`).join('');
    if (chips) h += `<div class="chps">${chips}</div>`;

    const rows = [];
    const buildingName = (t) => (BUILDINGS[t] && BUILDINGS[t].name) || t;
    rows.push(['งาน', vi.job
      ? bLink(vi.job.id, vi.job.name || buildingName(vi.job.type))
      : `<span class="dim">${stage === 'child' ? 'ยังเด็ก' : 'ไม่มีงานประจำ'}</span>`]);
    rows.push(['บ้าน', vi.home
      ? bLink(vi.home.id, `บ้านระดับ ${vi.home.level || 1}`)
      : '<span class="dim">ไร้บ้าน</span>']);
    if (vi.spouse) rows.push(['คู่สมรส', vLink(vi.spouse.id, vi.spouse.name)]);
    h += '<div class="vrows">' + rows.map(([k, v]) => `<div class="vr"><span class="dim">${k}</span><span>${v}</span></div>`).join('') + '</div>';

    if ((vi.parents || []).length) {
      h += '<div class="sub">พ่อแม่</div><div class="rels">'
        + vi.parents.map((p) => (p.alive === false
          ? `<span class="dim">${esc(p.name)} (เสียชีวิต)</span>` : vLink(p.id, p.name))).join('') + '</div>';
    }
    const kin = (title, arr) => ((arr || []).length
      ? `<div class="sub">${title}</div><div class="rels">${arr.map((c) => `<span>${vLink(c.id, c.name)}<span class="dim"> ${ageText(c.age)}</span></span>`).join('')}</div>`
      : '');
    h += kin('ลูก', vi.children) + kin('หลาน', vi.grandchildren);
    return h;
  }

  function buildVillagerShell(vi) {
    infoEl.textContent = '';
    const head = el('div', 'info-head');
    head.appendChild(el('span', 'info-title', vi.fullName || vi.name || 'ชาวบ้าน'));
    const x = el('button', 'x', '✕');
    x.type = 'button';
    x.title = 'ปิด (Esc)';
    x.addEventListener('click', () => { closeInfoPanel(); call('closeInfo'); });
    head.appendChild(x);
    infoEl.appendChild(head);
    infoWkEl = null;
    infoBodyEl = el('div', 'info-body');
    infoBodyEl.addEventListener('click', onInfoClick);
    infoEl.appendChild(infoBodyEl);
    infoBodyHtml = '';
    infoEl.hidden = false;
  }

  function renderVillager(state) {
    let vi = safeCall(sim.villagerInfo, state, infoVid);
    if (!vi) vi = villagerFallback(state, infoVid);
    if (!vi) { closeInfoPanel(); call('closeInfo'); return; }
    const sig = `v${vi.id}|${vi.fullName}`;
    if (sig !== infoSig) { infoSig = sig; buildVillagerShell(vi); }
    const html = villagerBody(vi, state);
    if (html !== infoBodyHtml) { infoBodyHtml = html; infoBodyEl.innerHTML = html; }
  }

  function showVillager(id) {
    if (id == null) { if (infoVid != null) closeInfoPanel(); return; }
    infoId = null;
    infoVid = id;
    infoSig = '';
    if (lastState) renderVillager(lastState);
  }

  function houseHtml(b, state) {
    const lvl = levelOf(b.level);
    const res = (b.residents || []).length;
    const hp = b.happiness != null ? b.happiness : 1;
    const villagers = (state && state.villagers) || [];
    const sickHere = villagers.filter((v) => v.sick && v.homeId === b.id).length;
    let h = `<div class="stat ok">ระดับ ${lvl.level}: ${lvl.name}</div>`;
    h += `<div>👥 ผู้อยู่อาศัย ${res}/${lvl.capacity}</div>`;
    h += `<div>${happyFace(hp)} ความสุข ${Math.round(hp * 100)}%</div>`;
    if (sickHere > 0) h += `<div class="warn">🤒 ป่วย ${sickHere} คน</div>`;
    h += '<div class="sub">ความต้องการตอนนี้</div><ul>';
    for (const n of lvl.needs) {
      const ok = b.needsMet && b.needsMet[n];
      h += `<li>${ok ? '✅' : '❌'} ${NEED_INFO[n] || n}</li>`;
    }
    h += '</ul>';
    const foods = (b.foodsToday || []).map((f) => info(f).icon).join(' ');
    h += `<div class="sub">อาหารที่กินวันนี้</div><div>${foods || '<span class="dim">ยังไม่มี</span>'}</div>`;
    h += familyHtml(b, state);

    if (b.upgrading) return h;   // progress bar is rendered by siteHtml
    const st = safeUpgradeStatus(state, b);
    const next = st ? (st.nextLevel == null ? null
      : typeof st.nextLevel === 'object' ? st.nextLevel : levelOf(st.nextLevel)) : HOUSE_LEVELS[lvl.level] || null;
    if (!next) {
      h += '<div class="sub ok">ระดับสูงสุดแล้ว</div>';
      return h;
    }
    h += `<div class="upg"><div class="uph">อัปเกรดเป็น ${esc(next.name)}</div>`;
    const needs = st && Array.isArray(st.needs)
      ? st.needs
      : next.needs.map((k) => ({ key: k, name: NEED_INFO[k] || k, met: !!(b.needsMet && b.needsMet[k]) }));
    h += '<ul>' + needs.map((n) => `<li>${n.met ? '✅' : '❌'} ${esc(n.name || NEED_INFO[n.key] || n.key)}</li>`).join('') + '</ul>';
    const cost = (st && st.cost) || next.upgradeCost;
    if (cost) h += `<div class="sub">วัสดุที่ใช้</div><div class="rcs">${costChips(cost, st && st.missing)}</div>`;
    const can = !!(st && st.canUpgrade);
    const why = can ? 'เริ่มอัปเกรดบ้านหลังนี้ทันที' : ((st && st.reason) || 'ยังอัปเกรดไม่ได้');
    h += `<div class="upgrow" title="${esc(why)}"><button type="button" class="btn primary ubtn" data-act="upgrade" ${can ? '' : 'disabled'}>⬆️ อัปเกรด</button></div>`;
    if (!can) h += `<div class="warn small">${esc(why)}</div>`;
    h += '</div>';
    const auto = b.autoUpgrade !== false;
    h += `<div class="autorow"><span>อัปเกรดอัตโนมัติ</span><button type="button" class="tgl${auto ? ' on' : ''}" data-act="auto" title="อัปเกรดเองทุกเที่ยงคืนเมื่อพร้อม">${auto ? 'เปิด' : 'ปิด'}</button></div>`;
    return h;
  }

  function stockHtml(b) {
    const entries = RESOURCES.filter((r) => b.stock && b.stock[r] > 0);
    let h = '<div class="sub">ของในคลัง</div>';
    if (!entries.length) return h + '<div class="dim">ว่างเปล่า</div>';
    h += '<div class="rcs">' + entries.map((r) => `<span class="rc">${info(r).icon} ${info(r).name} ${Math.floor(b.stock[r])}</span>`).join('') + '</div>';
    return h;
  }

  function supplyHtml(b, def, state) {
    const sup = def.supply;
    const have = Math.floor((b.stock && b.stock[sup]) || 0);
    let h = `<div class="sub">คลังสำหรับให้บริการ</div><div class="stat ${have > 0 ? 'ok' : 'warn'}">${info(sup).icon} ${info(sup).name} ${have}/${SUPPLY_MAX}</div>`;
    const covered = ((state && state.buildings) || []).filter((o) => o.type === 'house' && o.built
      && Math.hypot(o.x - b.x, o.z - b.z) <= def.serviceRadius).length;
    h += `<div class="dim">ครอบคลุมบ้าน ${covered} หลังในรัศมี ${def.serviceRadius} ม.</div>`;
    if (def.job === 'doctor') {
      h += have > 0
        ? '<div class="dim">หมอรักษาคนป่วยในรัศมีด้วยสมุนไพรจากคลังนี้</div>'
        : '<div class="warn small">ไม่มีสมุนไพร — บริการสุขภาพหยุดจนกว่าจะมีสมุนไพรส่งมา</div>';
    } else {
      h += have > 0
        ? '<div class="dim">พ่อค้านำผ้ามาเติม บ้านระดับ 4+ ใช้ผ้าตอนเที่ยงคืน</div>'
        : '<div class="warn small">ไม่มีผ้า — บ้านในรัศมีจะไม่ได้รับเสื้อผ้า</div>';
    }
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
      if (b.type === 'house' && b.upgrading) h += houseHtml(b, state);
      return h;
    }
    if (b.type === 'house') return houseHtml(b, state);
    const working = !(def.workers > 0 && (b.workers || []).length === 0);
    h += working ? '<div class="stat ok">ทำงานปกติ</div>' : '<div class="stat warn">ยังไม่มีคนงาน</div>';
    if (b.tooled) h += `<div class="ok small">🔧 มีเครื่องมือ (+${Math.round(TOOL_SPEED_BONUS * 100)}%)</div>`;
    const sickWorkers = ((state && state.villagers) || []).filter((v) => v.sick && v.jobId === b.id).length;
    if (sickWorkers > 0) h += `<div class="warn small">🤒 คนงานป่วย ${sickWorkers} คน (ออกจากงานชั่วคราว)</div>`;
    if (def.supply) h += supplyHtml(b, def, state);
    else if (def.storage || b.stock) h += stockHtml(b);
    return h;
  }

  function onInfoClick(e) {
    const lk = e.target.closest && e.target.closest('[data-vid],[data-bid]');
    if (lk) {
      if (lk.dataset.vid != null) call('selectVillager', Number(lk.dataset.vid));
      else call('selectBuilding', Number(lk.dataset.bid));
      return;
    }
    const btn = e.target.closest && e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const b = findBuilding(lastState, infoId);
    if (!b) return;
    if (btn.dataset.act === 'upgrade') {
      const r = call('requestUpgrade', b.id);
      if (r && r.ok) toast(`เริ่มอัปเกรดบ้านเป็น${(() => { const st = safeUpgradeStatus(lastState, b); const n = st && st.nextLevel; return n && typeof n === 'object' ? n.name : levelOf((b.level || 1) + 1).name; })()}`);
      else toast((r && r.reason) || 'อัปเกรดไม่ได้');
    } else if (btn.dataset.act === 'auto') {
      call('setAutoUpgrade', b.id, b.autoUpgrade === false);
    }
    renderInfo(lastState);
  }

  function renderInfo(state) {
    if (infoVid != null) { renderVillager(state); return; }
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
    infoVid = null;
    infoId = building.id;
    infoSig = '';
    renderInfo(lastState || { buildings: [building], gold: 0 });
  }

  // ===== plot purchase card (territory view) =====
  let plotCard = null;
  function hidePlotCard() {
    if (plotCard) plotCard.remove();
    plotCard = null;
  }
  // plot: { px, pz, price }, at: { x, y } client coords, gold: current gold, onBuy(): called on confirm
  function showPlotCard(plot, at, gold, onBuy) {
    hidePlotCard();
    const card = el('div', 'plotcard');
    card.appendChild(el('div', 'pc-q', `ซื้อแปลงนี้ 🪙${plot.price}?`));
    const short = (gold || 0) < plot.price;
    card.appendChild(el('div', `pc-sub${short ? ' short' : ''}`,
      short ? `ทองไม่พอ (มี ${Math.floor(gold || 0)}, ขาด ${Math.ceil(plot.price - (gold || 0))})` : `แปลง ${plot.px + 1},${plot.pz + 1} · มีทอง ${Math.floor(gold || 0)}`));
    const row = el('div', 'pc-row');
    const no = el('button', 'btn', 'ยกเลิก');
    const yes = el('button', 'btn primary', 'ซื้อ');
    no.type = yes.type = 'button';
    yes.disabled = short;
    no.addEventListener('click', hidePlotCard);
    yes.addEventListener('click', () => { hidePlotCard(); onBuy(); });
    row.append(no, yes);
    card.appendChild(row);
    card.addEventListener('pointerdown', (e) => e.stopPropagation());
    root.appendChild(card);
    const w = card.offsetWidth, h = card.offsetHeight;
    const x = Math.max(8, Math.min(window.innerWidth - w - 8, (at ? at.x : window.innerWidth / 2) - w / 2));
    const y = Math.max(8, Math.min(window.innerHeight - h - 8, (at ? at.y : window.innerHeight / 2) - h - 14));
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
    plotCard = card;
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
    for (const res of RESOURCES) if (nums[res]) setText(nums[res].num, String(Math.floor(stock[res] || 0)));
    for (const g of RES_GROUPS) {
      const rec = heads[g.id];
      for (const [r, node] of Object.entries(rec.items)) setText(node, String(Math.floor(stock[r] || 0)));
      if (rec.total) {
        const tot = g.headTotal.reduce((acc, r) => acc + Math.floor(stock[r] || 0), 0);
        setText(rec.total, String(tot));
        rec.total.parentNode.classList.toggle('low', tot < (summary.pop || 0));
      }
    }
    setText(nums.gold.num, String(Math.floor(summary.gold || 0)));
    setText(nums.pop.num, String(summary.pop || 0));
    setText(popSub, ` (ไร้บ้าน ${summary.homeless || 0})`);
    const sick = summary.sick != null ? summary.sick : ((state && state.villagers) || []).filter((v) => v.sick).length;
    sickEl.hidden = !(sick > 0);
    setText(sickEl, sick > 0 ? ` 🤒 ${sick}` : '');
    if (popHover) showPopTip();
    const h = summary.happiness != null ? summary.happiness : 1;
    setText(nums.happy.ic, happyFace(h));
    setText(nums.happy.num, `${Math.round(h * 100)}%`);
    const c = clock(state);
    setText(nums.clock.ic, c.isNight ? '🌙' : '☀️');
    setText(nums.clock.num, `วันที่ ${c.day} · ${pad2(c.hour)}:${pad2(c.minute)}`);

    const hasTerr = typeof sim.plotInfo === 'function' && !!state.territory;
    terrTab.hidden = !hasTerr;
    terrChip.chip.hidden = !hasTerr;
    if (hasTerr) {
      const own = summary.ownedPlots != null ? summary.ownedPlots : null;
      const tot = summary.totalPlots != null ? summary.totalPlots : (state.world ? state.world.plots * state.world.plots : null);
      if (own != null && tot != null) setText(terrChip.num, `${own}/${tot}`);
    }

    refreshButtons(summary, state);
    renderEvents(state);
    renderInfo(state);
  }

  return { update, showInfo, showVillager, toast, setActiveTool, setSpeedDisplay, setSaveStatus, showPlotCard, hidePlotCard };
}
