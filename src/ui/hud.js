// HUD: top bar, build bar, speed controls, info panel, event log, toast.
// DOM only; all game data comes in through update(summary, state) / showInfo(building, state).
import {
  BUILDINGS, RESOURCES, RESOURCE_INFO, HOUSE_LEVELS, NEED_INFO, CATHEDRAL_STAGES,
  ZONE_BRUSH, GATHER_RADIUS, FIELD_RADIUS, FISH_RADIUS, HUNT_RADIUS, FOODS, SUPPLY_MAX, TOOL_SPEED_BONUS,
  SICK_LEAVE_DAYS, DAY_LENGTH, WATER_RADIUS, THIRSTY_AT, HUNGRY_AT, MARKET_SLOTS, MARKET_TREASURY_SHARE,
  SEASON_DAYS, RAIN_THIRST_MUL, SNOW_SPEED_MUL,
} from '../config.js';
import * as sim from '../sim.js';
import { createWorkforceUI } from './workforce.js';

const { clock, isUnlocked } = sim;

const UPDATE_INTERVAL_MS = 250;

const BUILDING_ICON = {
  storehouse: '📦', woodcutter: '🪓', forager: '🧺', quarry: '⛏️', sawmill: '🪚',
  farmhouse: '🌾', mill: '🌬️', bakery: '🥖', chapel: '⛪', tavern: '🍺', cathedral: '🏰',
  fishery: '🎣', hunter: '🏹', herbalist: '🌿', sheepfarm: '🐑', ironmine: '⚒️',
  weaver: '🧵', blacksmith: '🛠️', infirmary: '🏥', market: '🏪', forester: '🌱', well: '🪣',
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
  market: `พ่อค้าขนสินค้าจากโกดังมาวางขาย (เลือกได้ ${MARKET_SLOTS} รายการ) ชาวบ้านใช้เงินค่าจ้างซื้ออาหารกินที่นี่แทนการเดินไปโกดังไกลๆ ผ้าที่วางขายใช้เป็นเสื้อผ้าของบ้านระดับ 4+ และมีบ่อน้ำในตัว`,
  well: `น้ำดื่มไม่จำกัด ไม่ต้องใช้คนงาน ชาวบ้านที่กระหายน้ำจะเดินมาดื่มที่แหล่งน้ำที่ใกล้ที่สุด บ้านในรัศมี ${WATER_RADIUS} ม. ได้รับความต้องการ "น้ำดื่ม"`,
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

// Harvest brushes (resource tab): mark trees / rocks / ore for free villagers to gather, or clear the marks.
const HARVEST_ITEMS = [
  { zone: 'harvest', icon: '🪓', name: 'เก็บทรัพยากร',
    desc: 'ระบายคลุมต้นไม้ ก้อนหิน หรือสายแร่ที่ต้องการเก็บ ชาวบ้านที่ว่างงาน (และช่างก่อสร้างที่ไม่มีงาน) จะไปตัด/ขุดแล้วขนเข้าโกดังที่ใกล้ที่สุด' },
  { zone: 'unharvest', icon: '🚫', name: 'ยกเลิกการเก็บ',
    desc: 'ระบายคลุมจุดที่เลือกไว้เพื่อยกเลิก — ต้นไม้ หิน และแร่ตรงนั้นจะไม่ถูกเก็บ' },
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
  if (d.waterRadius) return `น้ำดื่ม · ไม่ต้องใช้คนงาน · บ้านในรัศมี ${d.waterRadius} ม.`;
  const parts = [];
  if (d.workers) parts.push(`คนงาน ${d.workers}`);
  if (d.job === 'gather') parts.push(`${NODE_NAME[d.node] || d.node}${d.keepNode ? ' (ไม่ทำให้หมด)' : ''} → ${resNames(d.output)}`);
  else if (d.job === 'farm') parts.push(`ไร่นา → ${resNames(d.output)}`);
  else if (d.job === 'process') parts.push(`${resNames(d.input)} → ${resNames(d.output)}`);
  else if (d.job === 'service') parts.push(`บริการ${SERVICE_NAME[d.service] || ''} รัศมี ${d.serviceRadius} ม.`);
  else if (d.job === 'fish') parts.push(`ตกปลา (ติดน้ำ, รัศมี ${FISH_RADIUS} ม.) → ${resNames(d.output)}`);
  else if (d.job === 'hunt') parts.push(`ล่ากวาง (รัศมี ${HUNT_RADIUS} ม.) → ${resNames(d.output)}`);
  else if (d.job === 'ranch') parts.push(`เลี้ยงแกะ → ${(d.outputs || []).map(resNames).join(' / ')}`);
  else if (d.job === 'market') parts.push(`ขายอาหาร/ผ้าได้ 4 รายการ · ชาวบ้านซื้อด้วยเงินค่าจ้าง · มีบ่อน้ำ`);
  else if (d.job === 'doctor') {
    parts.push(`บริการ${SERVICE_NAME[d.service] || ''} รัศมี ${d.serviceRadius} ม. · ใช้${info(d.supply).name}`);
  }
  return parts.join(' · ');
}

// Tooltip for the season chip: what this season and today's weather change.
function seasonTip(se, w, snow) {
  const pct = (m) => `${m >= 1 ? '+' : ''}${Math.round((m - 1) * 100)}%`;
  const lines = [`${se.icon} ${se.name} วันที่ ${se.day}/${SEASON_DAYS}${se.year > 1 ? ` · ปีที่ ${se.year}` : ''}`];
  const fx = [];
  if (se.farm !== 1) fx.push(`ผลผลิตไร่นา ${pct(se.farm)}`);
  if (se.berry !== 1) fx.push(`เบอร์รี่งอก ${pct(se.berry)}`);
  if (se.hunger !== 1) fx.push(`หิวเร็ว ${pct(se.hunger)}`);
  if (se.thirst !== 1) fx.push(`กระหายน้ำ ${pct(se.thirst)}`);
  if (se.sick !== 1) fx.push(`โอกาสป่วย ${pct(se.sick)}`);
  lines.push(fx.length ? fx.join(' · ') : 'ไม่มีผลพิเศษ');
  if (w.kind === 'rain') lines.push(`🌧️ ฝนตก — กระหายน้ำช้าลง ${Math.round((1 - RAIN_THIRST_MUL) * 100)}%`);
  if (w.kind === 'snow') lines.push('🌨️ หิมะตก — หิมะสะสมบนพื้น');
  if (snow > 0.05) lines.push(`หิมะบนพื้น ${Math.round(snow * 100)}% — เดินช้าลงสูงสุด ${Math.round((1 - SNOW_SPEED_MUL) * 100)}%`);
  return lines.join('\n');
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
      h.append(el('span', 'ic', '🍽️'), rec.total = el('span', 'num', '0'), rec.rate = el('span', 'rate', ''));
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
  const popChip = addChip('pop', '👥', 'ประชากร', 'pop');
  const popSub = el('span', 'sub', '');
  popChip.chip.appendChild(popSub);
  const sickEl = el('span', 'sick', '');
  sickEl.hidden = true;
  popChip.chip.appendChild(sickEl);
  let popHover = false;
  const isHoverPointer = (e) => !e || e.pointerType === 'mouse' || e.pointerType === 'pen';
  popChip.chip.addEventListener('pointerenter', (e) => { if (isHoverPointer(e)) { popHover = true; showPopTip(); } });
  popChip.chip.addEventListener('pointerleave', (e) => { if (isHoverPointer(e)) { popHover = false; hideTip(); } });
  // touch: tapping the chip toggles the breakdown card (no hover on iPad)
  let popTapTimer = 0;
  popChip.chip.addEventListener('click', () => {
    if (!window.matchMedia('(hover: none)').matches) return;
    if (tipEl.classList.contains('show')) { hideTip(); clearTimeout(popTapTimer); return; }
    showPopTip();
    clearTimeout(popTapTimer);
    popTapTimer = setTimeout(hideTip, 4500);
  });
  document.addEventListener('pointerdown', (e) => {
    if (popTapTimer && !popChip.chip.contains(e.target)) { clearTimeout(popTapTimer); popTapTimer = 0; hideTip(); }
  }, true);
  // workforce: free villagers (click → job assignment panel)
  const jobsChip = addChip('jobs', '👷', 'จัดการงาน — คลิกเพื่อมอบหมายงานให้ชาวบ้าน (J)', 'jobs');
  const jobsSub = el('span', 'sub', ' ว่างงาน');
  jobsChip.chip.appendChild(jobsSub);
  jobsChip.chip.style.cursor = 'pointer';
  jobsChip.chip.addEventListener('click', () => openWorkforce());
  addChip('happy', '😊', 'ความสุขเฉลี่ย');
  const terrChip = addChip('terr', '🗺️', 'ดินแดนที่เป็นของคุณ / ทั้งหมด (คลิกเพื่อเปิดมุมมองดินแดน)', 'terr');
  terrChip.chip.hidden = true;
  terrChip.chip.style.cursor = 'pointer';
  terrChip.chip.addEventListener('click', () => toggleTool({ kind: 'territory' }, 'territory'));
  addChip('clock', '☀️', 'เวลา', 'clock');
  addChip('season', '🌸', 'ฤดูกาลและสภาพอากาศ', 'season');

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

  // Tooltip on a build-bar control: hover for mouse/pen, 450 ms long-press for touch (released -> hides).
  // A long-press swallows the click that follows it, so only a short tap selects the tool.
  const LONG_PRESS_MS = 450;
  function bindTip(node, getHtml) {
    let timer = 0, sx = 0, sy = 0;
    node._lp = false;
    node.addEventListener('pointerenter', (e) => { if (isHoverPointer(e)) showTip(getHtml(), node); });
    node.addEventListener('pointerleave', (e) => { if (isHoverPointer(e)) hideTip(); });
    node.addEventListener('pointerdown', (e) => {
      if (isHoverPointer(e)) return;
      clearTimeout(timer);
      node._lp = false;
      sx = e.clientX; sy = e.clientY;
      timer = setTimeout(() => { timer = 0; node._lp = true; showTip(getHtml(), node); }, LONG_PRESS_MS);
    });
    node.addEventListener('pointermove', (e) => {
      if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) { clearTimeout(timer); timer = 0; }
    });
    const end = () => { clearTimeout(timer); timer = 0; if (node._lp) hideTip(); };
    node.addEventListener('pointerup', end);
    node.addEventListener('pointercancel', () => { end(); node._lp = false; });
    node.addEventListener('contextmenu', (e) => { if (!isHoverPointer(e) || node._lp) e.preventDefault(); });
  }
  // true (once) when the click just fired belongs to a long-press that already showed the tooltip
  function lpConsumed(node) {
    if (!node._lp) return false;
    node._lp = false;
    return true;
  }

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
      if (lpConsumed(btn)) return;
      if (rec.locked) { toast(`ปลดล็อกเมื่อประชากร ${def.unlockPop}`); return; }
      toggleTool(def.tool, def.id);
    });
    bindTip(btn, () => def.tip(rec));
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
    // a vertical mouse wheel scrolls the building row sideways
    panel.addEventListener('wheel', (e) => {
      if (panel.scrollWidth <= panel.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      panel.scrollLeft += e.deltaY;
    }, { passive: false });
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
      if (t.id === 'resource') {
        for (const z of HARVEST_ITEMS) {
          const rec = makeToolButton({
            id: `zone:${z.zone}`, tab: t.id, icon: z.icon, name: z.name, costText: 'ฟรี',
            tool: { kind: 'zone', zone: z.zone },
            tip: () => {
              const hv = lastSummary && lastSummary.harvest;
              const now = hv ? `<br><span class="dim">เลือกไว้: 🌲 ${hv.tree} · 🪨 ${hv.rock} · ⛰️ ${hv.ore}</span>` : '';
              return `<b>${z.name}</b><br>${z.desc}<br><span class="dim">ขนาดแปรง ${ZONE_BRUSH.min}–${ZONE_BRUSH.max} ม. ปรับด้วย [ ]</span>${now}`;
            },
          });
          panel.appendChild(rec.btn);
        }
      }
      for (const [type, d] of Object.entries(BUILDINGS)) {
        if (d.category !== t.category || d.retired) continue;
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
  demoTab.addEventListener('click', () => { if (lpConsumed(demoTab)) return; toggleTool({ kind: 'demolish' }, 'demolish'); });
  bindTip(demoTab, () => '<b>รื้อถอน</b><br>แตะอาคารหรือโซนเพื่อรื้อ คืนวัสดุ 50%');

  // 🗺️ ดินแดน: territory view (plot grid, buy plots). Hidden until the sim exposes territories.
  const terrTab = makeTab('territory', '🗺️ ดินแดน');
  terrTab.classList.add('terr');
  terrTab.dataset.tool = 'territory';
  terrTab.hidden = true;
  terrTab.addEventListener('click', () => { if (lpConsumed(terrTab)) return; hideTip(); toggleTool({ kind: 'territory' }, 'territory'); });
  bindTip(terrTab, () => {
    const st = lastState;
    let price = '';
    try { if (st && typeof sim.plotPrice === 'function') price = `<br><span class="dim">แปลงถัดไปราคา 🪙 ${sim.plotPrice(st)}</span>`; } catch (e) { /* ignore */ }
    return `<b>ดินแดน</b><br>แสดงเส้นแบ่งแปลง แตะแปลงที่ติดกับดินแดนของคุณเพื่อซื้อ — วางอาคารและเก็บทรัพยากรได้เฉพาะในดินแดนของคุณ${price}`;
  });

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
  addMenuItem('👥 จัดการงาน', () => openWorkforce());
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
  let infoWkHtml = '';
  const wf = createWorkforceUI({
    root, call, getState: () => lastState, toast: (t) => toast(t), icon: (t) => BUILDING_ICON[t] || '🏠',
  });
  function openWorkforce() {
    if (lastState) wf.openWorkforce();
  }

  // body.info-open lets the CSS move the event log / FPS counter out of the way of the bottom sheet
  function setInfoOpen(open) { document.body.classList.toggle('info-open', !!open); }

  // Narrow / portrait windows show the info panel as a bottom sheet: drag the handle (head) down to dismiss.
  const sheetMq = window.matchMedia('(max-width: 900px), (orientation: portrait)');
  {
    let drag = null;
    infoEl.addEventListener('pointerdown', (e) => {
      if (!sheetMq.matches || e.pointerType === 'mouse') return;
      const head = e.target.closest('.info-head, .info-grip');
      if (!head || e.target.closest('button')) return;
      drag = { id: e.pointerId, y0: e.clientY, dy: 0 };
      infoEl.style.transition = 'none';
      try { head.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    infoEl.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag.dy = Math.max(0, e.clientY - drag.y0);
      infoEl.style.transform = `translateY(${drag.dy}px)`;
    });
    const endDrag = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dy = drag.dy;
      drag = null;
      infoEl.style.transition = '';
      infoEl.style.transform = '';
      if (dy > 70 && e.type === 'pointerup') { closeInfoPanel(); call('closeInfo'); }
    };
    infoEl.addEventListener('pointerup', endDrag);
    infoEl.addEventListener('pointercancel', endDrag);
  }

  // Publish the build bar's height so bottom-anchored UI (info sheet, event log) can stack above it.
  if (typeof ResizeObserver === 'function') {
    const rootStyle = document.documentElement.style;
    new ResizeObserver(() => rootStyle.setProperty('--bb-h', `${Math.ceil(buildbar.getBoundingClientRect().height)}px`)).observe(buildbar);
  }

  function closeInfoPanel() {
    setInfoOpen(false);
    infoId = null;
    infoVid = null;
    infoSig = '';
    infoEl.hidden = true;
    infoEl.textContent = '';
    infoBodyEl = infoWkEl = null;
    infoBodyHtml = '';
    infoWkHtml = '';
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
    infoEl.appendChild(el('div', 'info-grip'));
    const head = el('div', 'info-head');
    head.appendChild(el('span', 'info-title', def.name));
    const x = el('button', 'x', '✕');
    x.type = 'button';
    x.title = 'ปิด (Esc)';
    x.addEventListener('click', () => { closeInfoPanel(); call('closeInfo'); });
    head.appendChild(x);
    infoEl.appendChild(head);
    infoWkEl = null;
    infoWkHtml = '';
    if (def.workers > 0 && b.built) {
      infoWkEl = el('div', 'wbox');
      infoWkEl.addEventListener('click', (e) => { wf.onWorkersClick(e, b.id); renderInfo(lastState); });
      infoEl.appendChild(infoWkEl);
    }
    infoBodyEl = el('div', 'info-body');
    infoBodyEl.addEventListener('click', onInfoClick);
    infoEl.appendChild(infoBodyEl);
    infoBodyHtml = '';
    infoEl.hidden = false;
    infoEl.scrollTop = 0;
    setInfoOpen(true);
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
    const crew = ((state && state.villagers) || []).filter((v) => v.builder && !v.sick && !v.pregnant).length;
    if (crew === 0) {
      h += '<div class="warn small">🏗️ ยังไม่มีช่างก่อสร้าง — ไม่มีใครมาสร้าง</div>'
        + '<button type="button" class="btn small wf-open" data-act="workforce">👥 มอบหมายช่างก่อสร้าง</button>';
    } else {
      h += `<div class="dim small">🏗️ ช่างก่อสร้างในหมู่บ้าน ${crew} คน</div>`;
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
    hungry: ['🍽️', 'หิว'], thirsty: ['💧', 'กระหายน้ำ'],
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
    const pv = ((state && state.villagers) || []).find((p) => p.id === vi.id);
    if (pv) {
      const meter = (label, val, warnAt) => {
        const pct = Math.round(Math.min(1, val || 0) * 100);
        return `<div class="meter${val >= warnAt ? ' hot' : ''}"><span>${label}</span><div class="bar"><i style="width:${pct}%"></i></div><span>${pct}%</span></div>`;
      };
      h += meter('🍽️ หิว', pv.hunger, HUNGRY_AT) + meter('💧 กระหาย', pv.thirst, THIRSTY_AT);
      h += `<div class="small">💰 เงิน ${Math.floor(pv.coins || 0)} <span class="dim">— ได้จากการทำงาน ใช้ซื้ออาหารที่ตลาด</span></div>`;
    }

    const rows = [];
    const buildingName = (t) => (BUILDINGS[t] && BUILDINGS[t].name) || t;
    const v = ((state && state.villagers) || []).find((p) => p.id === vi.id);
    const title = v && typeof sim.jobTitleOf === 'function' ? sim.jobTitleOf(state, v) : null;
    let job;
    if (stage === 'child') job = '<span class="dim">ยังเด็ก</span>';
    else if (vi.job) {
      const where = vi.job.name || buildingName(vi.job.type);
      job = title && title !== where ? `${esc(title)} · ${bLink(vi.job.id, where)}` : bLink(vi.job.id, where);
    }
    else if (v && v.builder) job = `🏗️ ${esc(title)}`;
    else job = v && v.role === 'worker' ? '🪓 ว่างงาน · กำลังเก็บทรัพยากร' : '<span class="warn">ว่างงาน</span>';
    if (stage !== 'child') job += ' <button type="button" class="btn small" data-act="job">เปลี่ยนงาน</button>';
    rows.push(['งาน', job]);
    const wait = v && typeof sim.waitingReason === 'function' ? sim.waitingReason(state, v) : null;
    if (wait) rows.push(['', `<span class="dim small">⏳ ${esc(wait)}</span>`]);
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
    infoEl.appendChild(el('div', 'info-grip'));
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
    infoEl.scrollTop = 0;
    setInfoOpen(true);
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

  // Market: pick up to MARKET_SLOTS goods (toggle chips), stall stock, prices and sales.
  function marketHtml(b, def, state) {
    const sell = Array.isArray(b.sell) ? b.sell : (sim.DEFAULT_MARKET_GOODS || []);
    const goods = sim.MARKET_GOODS || [];
    let h = `<div class="sub">สินค้าที่วางขาย (เลือกได้ ${MARKET_SLOTS} รายการ · ${sell.length}/${MARKET_SLOTS})</div><div class="mkt">`;
    for (const r of goods) {
      const on = sell.includes(r);
      const full = !on && sell.length >= MARKET_SLOTS;
      const have = Math.floor((b.stock && b.stock[r]) || 0);
      const max = typeof sim.stockMaxOf === 'function' ? sim.stockMaxOf(r) : SUPPLY_MAX;
      const price = typeof sim.priceOf === 'function' ? sim.priceOf(r) : null;
      const tip = on ? 'กดเพื่อเลิกขาย (ของที่เหลือยังขายจนหมด)' : full ? `เลือกครบ ${MARKET_SLOTS} รายการแล้ว — เลิกขายอย่างอื่นก่อน` : 'กดเพื่อวางขาย';
      h += `<button type="button" class="mk${on ? ' on' : ''}" data-act="sell" data-res="${r}" ${full ? 'disabled' : ''} title="${esc(tip)}">`
        + `<span class="mk-ic">${info(r).icon}</span><span class="mk-nm">${info(r).name}</span>`
        + `<span class="mk-st">${on || have > 0 ? `${have}/${max}` : ''}</span>`
        + `<span class="mk-pr">${price != null ? `💰${price}` : 'บ้าน'}</span></button>`;
    }
    h += '</div>';
    h += `<div class="dim small">ขายไปแล้ว ${b.sold || 0} ชิ้น · รายรับ 💰${b.revenue || 0} (เข้าคลังหมู่บ้าน ${Math.round(MARKET_TREASURY_SHARE * 100)}% เป็น 🪙)</div>`;
    if (!(b.workers || []).length) h += '<div class="warn small">ไม่มีพ่อค้า — ตลาดปิด ชาวบ้านซื้อของไม่ได้</div>';
    if (!sell.includes('cloth')) h += '<div class="dim small">ไม่ได้ขายผ้า — บ้านในรัศมีจะไม่ได้รับเสื้อผ้าจากตลาดนี้</div>';
    else {
      const covered = ((state && state.buildings) || []).filter((o) => o.type === 'house' && o.built
        && Math.hypot(o.x - b.x, o.z - b.z) <= def.serviceRadius).length;
      h += `<div class="dim small">ผ้าใช้เป็นเสื้อผ้าของบ้าน ${covered} หลังในรัศมี ${def.serviceRadius} ม.</div>`;
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
    if (def.waterRadius) {
      const near = ((state && state.buildings) || []).filter((o) => o.type === 'house' && o.built
        && Math.hypot(o.x - b.x, o.z - b.z) <= def.waterRadius).length;
      return '<div class="stat ok">💧 มีน้ำให้ดื่มตลอด</div>'
        + `<div>บ้านในรัศมี ${def.waterRadius} ม.: ${near} หลัง</div>`
        + '<div class="dim small">ชาวบ้านที่กระหายน้ำจะเดินไปดื่มที่บ่อน้ำ ศาลากลาง ตลาด หรือริมน้ำที่ใกล้ที่สุด — วางบ่อน้ำใกล้บ้านและที่ทำงานเพื่อลดการเดิน</div>';
    }
    const working = !(def.workers > 0 && (b.workers || []).length === 0);
    if (b.problem) {
      h += `<div class="problem ${b.problem.blocking ? 'bad' : ''}"><b>⚠️ ${esc(b.problem.text)}</b>`
        + (b.paused
          ? '<div class="small">หยุดชั่วคราว — คนงานยังประจำอยู่แต่รอจนกว่าจะแก้ปัญหานี้ได้ (ย้ายคนงานไปงานอื่นได้ด้านบน)</div>'
          : b.problem.blocking ? '<div class="small">ถ้ายังไม่แก้ภายใน 2 ชั่วโมงในเกม อาคารจะหยุดชั่วคราว คนงานจะรออยู่จนกว่าจะแก้ได้</div>' : '')
        + '</div>';
    } else {
      h += working ? '<div class="stat ok">ทำงานปกติ</div>' : '<div class="stat warn">ยังไม่มีคนงาน</div>';
    }
    if (b.tooled) h += `<div class="ok small">🔧 มีเครื่องมือ (+${Math.round(TOOL_SPEED_BONUS * 100)}%)</div>`;
    const sickWorkers = ((state && state.villagers) || []).filter((v) => v.sick && v.jobId === b.id).length;
    if (sickWorkers > 0) h += `<div class="warn small">🤒 คนงานป่วย ${sickWorkers} คน (หยุดงานจนกว่าจะหาย)</div>`;
    if (def.job === 'market') h += marketHtml(b, def, state);
    else if (def.supply) h += supplyHtml(b, def, state);
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
    if (btn.dataset.act === 'job') { if (infoVid != null) wf.openJobPicker(infoVid); return; }
    if (btn.dataset.act === 'workforce') { openWorkforce(); return; }
    const b = findBuilding(lastState, infoId);
    if (!b) return;
    if (btn.dataset.act === 'sell') {
      const cur = Array.isArray(b.sell) ? b.sell.slice() : (sim.DEFAULT_MARKET_GOODS || []).slice();
      const r = btn.dataset.res;
      const next = cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r];
      const res = call('setMarketGoods', b.id, next);
      if (res && !res.ok) toast(res.reason);
    } else if (btn.dataset.act === 'upgrade') {
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
      const wk = wf.workersHtml(b, state);
      if (wk !== infoWkHtml) { infoWkHtml = wk; infoWkEl.innerHTML = wk; }
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
  let evState = null;
  function eventTime(t) {
    const day = Math.floor(t / DAY_LENGTH) + 1;
    const mins = Math.floor(((t % DAY_LENGTH) / DAY_LENGTH) * 24 * 60);
    return `วัน ${day} · ${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  }
  // Jump to whatever an event is about: its building (selected) or its place on the map.
  function openEventTarget(e) {
    if (e.bId != null && evState?.buildings.some((b) => b.id === e.bId)) call('selectBuilding', e.bId);
    if (e.vId != null && evState?.villagers.some((v) => v.id === e.vId)) call('selectVillager', e.vId);
    if (Number.isFinite(e.x) && Number.isFinite(e.z)) call('focusAt', e.x, e.z);
  }
  function renderEvents(state) {
    evState = state;
    const evs = (state.events || []).slice(-5).reverse();
    const sig = evs.map((e) => `${e.t}|${e.text}`).join('\n');
    if (sig === eventsSig) return;
    eventsSig = sig;
    eventsEl.textContent = '';
    evs.forEach((e, i) => {
      const row = el('div', `ev${e.kind === 'warn' ? ' warn' : ''}${e.bId != null || Number.isFinite(e.x) ? ' link' : ''}`, e.text);
      row.style.opacity = String(Math.max(0.3, 1 - i * 0.18));
      if (e.detail) row.title = e.detail;
      row.addEventListener('click', () => openEventTarget(e));
      eventsEl.appendChild(row);
    });
    const more = el('button', 'ev-more', `📜 ประวัติทั้งหมด (${(state.events || []).length})`);
    more.type = 'button';
    more.addEventListener('click', () => openHistory());
    eventsEl.appendChild(more);
  }

  // Full, scrollable event history with filters; newest first, grouped by game day.
  function openHistory() {
    if (!evState) return;
    const back = el('div', 'backdrop');
    const box = el('div', 'modal-box history');
    const head = el('div', 'hist-head');
    head.append(el('h2', null, '📜 ประวัติเหตุการณ์'));
    const close = el('button', 'btn', 'ปิด');
    close.type = 'button';
    head.append(close);
    const filters = el('div', 'hist-filters');
    const list = el('div', 'hist-list');
    let filter = 'all';
    const FILTERS = [['all', 'ทั้งหมด'], ['warn', '⚠️ ปัญหา'], ['family', '👪 ครอบครัว'], ['build', '🔨 ก่อสร้าง']];
    const matches = (e) => {
      if (filter === 'all') return true;
      if (filter === 'warn') return e.kind === 'warn' || /^(⚠️|😞|🤒|🕊️)/u.test(e.text) || /ไม่มีอาหาร|ย้ายออก/.test(e.text);
      if (filter === 'family') return e.kind === 'family' || /^(💍|👶|🤰|🕊️)/u.test(e.text);
      if (filter === 'build') return e.kind === 'build' || /ก่อสร้าง|สร้างเสร็จ|อัปเกรด/.test(e.text);
      return true;
    };
    function render() {
      list.textContent = '';
      const evs = (evState.events || []).filter(matches).slice().reverse();
      if (!evs.length) { list.append(el('div', 'dim', 'ยังไม่มีเหตุการณ์ในหมวดนี้')); return; }
      let day = null;
      for (const e of evs) {
        const d = Math.floor(e.t / DAY_LENGTH) + 1;
        if (d !== day) { day = d; list.append(el('div', 'hist-day', `วันที่ ${d}`)); }
        const row = el('div', `hist-row${e.kind === 'warn' ? ' warn' : ''}`);
        row.append(el('span', 'hist-t', eventTime(e.t).split(' · ')[1]), el('span', 'hist-x', e.text));
        if (e.detail) row.append(el('div', 'hist-d', e.detail));
        if (e.bId != null || Number.isFinite(e.x)) {
          row.classList.add('link');
          row.title = 'คลิกเพื่อไปที่ตำแหน่งนี้';
          row.addEventListener('click', () => { back.remove(); openEventTarget(e); });
        }
        list.append(row);
      }
    }
    for (const [id, label] of FILTERS) {
      const b = el('button', `tab${id === filter ? ' open' : ''}`, label);
      b.type = 'button';
      b.addEventListener('click', () => {
        filter = id;
        for (const c of filters.children) c.classList.toggle('open', c === b);
        render();
      });
      filters.append(b);
    }
    box.append(head, filters, list);
    back.append(box);
    const shut = () => { back.remove(); window.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.code === 'Escape') { e.stopPropagation(); shut(); } };
    window.addEventListener('keydown', onKey, true);
    close.addEventListener('click', shut);
    back.addEventListener('click', (e) => { if (e.target === back) shut(); });
    document.body.append(back);
    render();
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
        const f = summary.food;
        if (f && rec.rate) {
          const net = f.net;
          setText(rec.rate, net === 0 ? '' : `${net > 0 ? '▲' : '▼'}${Math.abs(net)}`);
          rec.rate.className = `rate ${net < 0 ? 'down' : 'up'}`;
          const left = f.hoursLeft != null ? ` · จะหมดในอีกประมาณ ${f.hoursLeft < 1 ? 'ไม่ถึง 1' : Math.round(f.hoursLeft)} ชั่วโมงในเกม` : '';
          rec.total.parentNode.title = `อาหารพร้อมกิน ${tot} · ผลิต ${f.inPerDay}/วัน · ต้องการ ~${f.demandPerDay}/วัน${left}`;
        }
      }
    }
    setText(nums.gold.num, String(Math.floor(summary.gold || 0)));
    setText(nums.pop.num, String(summary.pop || 0));
    const ws = summary.workforce;
    if (ws) {
      setText(nums.jobs.num, String(ws.free));
      // highlight when someone could be put to work, or construction has nobody to build it
      const attention = (ws.free > 0 && (ws.openSlots > 0 || ws.sites > 0)) || (ws.sites > 0 && ws.builders === 0);
      nums.jobs.chip.classList.toggle('attn', attention);
      nums.jobs.chip.title = `ว่างงาน ${ws.free} · ช่างก่อสร้าง ${ws.builders} · ตำแหน่งว่าง ${ws.openSlots}${ws.sites ? ` · งานก่อสร้าง ${ws.sites}` : ''} — คลิกเพื่อจัดการงาน (J)`;
    }
    wf.refresh();
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
    const se = summary.season;
    if (se) {
      const w = summary.weather || { kind: 'clear' };
      const wIcon = w.kind === 'rain' ? ' 🌧️' : w.kind === 'snow' ? ' 🌨️' : '';
      setText(nums.season.ic, se.icon);
      setText(nums.season.num, `${se.name} ${se.day}/${SEASON_DAYS}${wIcon}`);
      nums.season.chip.title = seasonTip(se, w, summary.snow || 0);
    }

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

  return { update, showInfo, showVillager, openWorkforce, toast, setActiveTool, setSpeedDisplay, setSaveStatus, showPlotCard, hidePlotCard };
}
