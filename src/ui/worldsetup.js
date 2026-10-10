// World settings form (spec §9): shown when creating a cloud village and for a local "new game".
// Builds a self-contained card (.scr-card.ws); screens.js decides where to put it.
// Option lists mirror server/settings.js / normalizeSettings so a value here is always accepted.
import * as CFG from '../config.js';

const LAST_KEY = 'hamlet-last-world';

export const DEFAULT_WORLD = {
  mapSize: 'medium', forest: 'normal', stone: 'normal', berries: 'normal', ore: 'normal', terrain: 'normal',
  rivers: 1, startResources: 'normal', startVillagers: 8, regrowth: 'normal', difficulty: 'normal',
};

const DENSITY = [['low', 'น้อย'], ['normal', 'ปกติ'], ['high', 'มาก']];

const GROUPS = [
  {
    title: '🌲 ธรรมชาติ',
    rows: [
      { key: 'forest', label: '🌳 ป่าไม้', opts: DENSITY },
      { key: 'stone', label: '🪨 หิน', opts: DENSITY },
      { key: 'berries', label: '🫐 พุ่มเบอร์รี่', opts: DENSITY },
      { key: 'ore', label: '⛏️ แร่เหล็ก', opts: DENSITY, hint: 'แร่อยู่บนที่สูง — ภูมิประเทศเนินเขาจะมีแร่มากขึ้น' },
      { key: 'terrain', label: '⛰️ ภูมิประเทศ', opts: [['flat', 'ราบเรียบ'], ['normal', 'ปกติ'], ['hilly', 'เนินเขา']] },
      { key: 'rivers', label: '🌊 แม่น้ำ', opts: [[0, 'ไม่มี'], [1, '1 สาย'], [2, '2 สาย'], [3, '3 สาย']],
        hint: 'ไม่มีแม่น้ำจะมีบ่อน้ำเล็กๆ ให้ตกปลาแทน' },
    ],
  },
  {
    title: '🏘️ การเริ่มต้น',
    rows: [
      { key: 'startResources', label: '📦 ทรัพยากรเริ่มต้น', opts: DENSITY, hint: 'มาก = วัสดุ 2 เท่า และมีทอง 🪙 100' },
      { key: 'startVillagers', label: '👥 ชาวบ้านเริ่มต้น', opts: [[4, '4 คน'], [8, '8 คน'], [12, '12 คน']] },
      { key: 'regrowth', label: '🌱 ป่าฟื้นตัวเอง', opts: [['off', 'ปิด'], ['slow', 'ช้า'], ['normal', 'ปกติ']],
        hint: 'ต้นไม้ใหม่งอกเอง และปลูกเพิ่มได้ด้วยคนปลูกป่า' },
      { key: 'difficulty', label: '⚙️ ความยาก', opts: [['easy', 'ง่าย'], ['normal', 'ปกติ'], ['hard', 'ยาก']],
        hint: 'เปลี่ยนภายหลังได้ที่ ☰ → ตั้งค่า' },
    ],
  },
];

const MAP_CARDS = [
  { id: 'small', name: 'เล็ก', note: 'ทุกแปลงเป็นของคุณ เหมาะเริ่มเล่น' },
  { id: 'medium', name: 'กลาง', note: 'แนะนำ — ซื้อขยายดินแดนได้' },
  { id: 'large', name: 'ใหญ่', note: 'กว้างมาก ใช้เครื่องแรงกว่า' },
];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function mapMetres(id) {
  const sizes = CFG.MAP_SIZES;
  const m = sizes && Number(sizes[id]);
  return m > 0 ? m : { small: 240, medium: 400, large: 560 }[id];
}
const plotMetres = () => (Number(CFG.PLOT_SIZE) > 0 ? Number(CFG.PLOT_SIZE) : 80);
const START_PLOTS = 9;

// ---------- seed ----------
export const MAX_SEED = 2147483647;

// Text -> positive integer seed. Plain numbers are used as typed; anything else is hashed (FNV-1a).
export function seedFromText(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return null;
  if (/^\d{1,10}$/.test(t)) {
    const n = Number(t);
    if (n >= 1 && n <= MAX_SEED) return n;
  }
  let h = 2166136261;
  for (let i = 0; i < t.length; i += 1) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % MAX_SEED) + 1;
}

const randomSeed = () => Math.floor(Math.random() * (MAX_SEED - 1)) + 1;

// ---------- remembered choices ----------
export function sanitizeWorld(raw) {
  const out = { ...DEFAULT_WORLD };
  if (!raw || typeof raw !== 'object') return out;
  const allowed = { mapSize: MAP_CARDS.map((c) => c.id) };
  for (const g of GROUPS) for (const r of g.rows) allowed[r.key] = r.opts.map((o) => o[0]);
  for (const [k, list] of Object.entries(allowed)) if (list.includes(raw[k])) out[k] = raw[k];
  return out;
}

export function loadLastWorld() {
  try { return sanitizeWorld(JSON.parse(localStorage.getItem(LAST_KEY) || 'null')); } catch { return { ...DEFAULT_WORLD }; }
}
function rememberWorld(s) {
  try { localStorage.setItem(LAST_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

// Segmented control: one row of buttons, exactly one selected.
function segmented(opts, value, onChange) {
  const wrap = el('div', 'ws-seg');
  wrap.setAttribute('role', 'radiogroup');
  const btns = opts.map(([val, label]) => {
    const b = el('button', 'ws-opt', label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => onChange(val));
    wrap.appendChild(b);
    return { b, val };
  });
  const set = (v) => {
    for (const { b, val } of btns) {
      const on = val === v;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  };
  set(value);
  return { el: wrap, set, buttons: btns.map((x) => x.b) };
}

// opts: { title, subtitle, withName, nameValue, submitLabel, cancelLabel, onSubmit({name, settings, seed}), onCancel }
// onSubmit may return a promise; a rejection shows its message on the card and re-enables the form.
export function buildWorldForm(opts = {}) {
  const values = sanitizeWorld(opts.initial || loadLastWorld());
  const card = el('div', 'scr-card ws');
  const brand = el('div', 'scr-brand');
  brand.append(el('div', 'scr-logo', '🗺️'), el('h1', null, opts.title || 'สร้างโลกใหม่'),
    el('div', 'scr-tag', opts.subtitle || 'เลือกแผนที่และกติกาของหมู่บ้าน — กำหนดตอนสร้างเท่านั้น'));
  card.appendChild(brand);

  const form = el('form', 'scr-form ws-form');
  form.noValidate = true;
  card.appendChild(form);

  // name (cloud)
  let nameInput = null;
  if (opts.withName) {
    nameInput = el('input');
    nameInput.type = 'text';
    nameInput.name = 'village-name';
    nameInput.maxLength = 30;
    nameInput.placeholder = 'ชื่อหมู่บ้าน (1–30 ตัวอักษร)';
    nameInput.autocomplete = 'off';
    nameInput.value = opts.nameValue || '';
    const row = el('label', 'scr-field');
    row.append(el('span', 'scr-lbl', '🏘️ ชื่อหมู่บ้าน'), nameInput);
    form.appendChild(row);
  }

  // map size cards
  const mapHead = el('div', 'ws-title', '🧭 ขนาดแผนที่');
  const cards = el('div', 'ws-maps');
  cards.setAttribute('role', 'radiogroup');
  const cardEls = {};
  for (const c of MAP_CARDS) {
    const m = mapMetres(c.id);
    const n = Math.max(1, Math.round(m / plotMetres()));
    const b = el('button', 'ws-map');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    const grid = el('div', 'ws-mini');
    grid.style.setProperty('--n', String(n));
    for (let i = 0; i < n * n; i += 1) {
      const mid = Math.floor(n / 2);
      const x = i % n, z = Math.floor(i / n);
      const start = n <= 3 || (Math.abs(x - mid) <= 1 && Math.abs(z - mid) <= 1);
      grid.appendChild(el('i', start ? 'own' : ''));
    }
    b.append(grid, el('b', null, c.name), el('span', 'ws-dim', `${m} × ${m} ม.`),
      el('span', 'ws-plots', `${n}×${n} = ${n * n} แปลง`), el('span', 'ws-note', c.note));
    b.addEventListener('click', () => { values.mapSize = c.id; refresh(); });
    cards.appendChild(b);
    cardEls[c.id] = b;
  }
  form.append(mapHead, cards);
  const summary = el('div', 'ws-summary');
  form.appendChild(summary);

  // segmented option rows
  const segs = {};
  for (const g of GROUPS) {
    form.appendChild(el('div', 'ws-title', g.title));
    for (const r of g.rows) {
      const row = el('div', 'ws-row');
      const lbl = el('div', 'ws-lbl', r.label);
      const seg = segmented(r.opts, values[r.key], (v) => { values[r.key] = v; refresh(); });
      row.append(lbl, seg.el);
      if (r.hint) row.appendChild(el('div', 'scr-hint', r.hint));
      form.appendChild(row);
      segs[r.key] = seg;
    }
  }

  // seed
  form.appendChild(el('div', 'ws-title', '🎲 เมล็ดพันธุ์แผนที่ (Seed)'));
  const seedRow = el('div', 'ws-seed');
  const seedInput = el('input');
  seedInput.type = 'text';
  seedInput.name = 'seed';
  seedInput.maxLength = 30;
  seedInput.placeholder = 'เว้นว่าง = สุ่ม';
  seedInput.autocomplete = 'off';
  seedInput.spellcheck = false;
  const dice = el('button', 'btn ws-dice', '🎲');
  dice.type = 'button';
  dice.title = 'สุ่ม seed';
  dice.setAttribute('aria-label', 'สุ่ม seed');
  dice.addEventListener('click', () => { seedInput.value = String(randomSeed()); });
  seedRow.append(seedInput, dice);
  form.appendChild(seedRow);
  form.appendChild(el('div', 'scr-hint', 'ใส่ตัวเลขหรือข้อความอะไรก็ได้ — seed เดียวกัน + ตั้งค่าเดียวกัน = แผนที่เดียวกัน'));

  const err = el('div', 'scr-err');
  err.setAttribute('role', 'alert');
  err.hidden = true;
  const showErr = (m) => { err.textContent = m || ''; err.hidden = !m; };

  const reset = el('button', 'btn ws-reset', '↺ ค่าเริ่มต้น');
  reset.type = 'button';
  reset.addEventListener('click', () => { Object.assign(values, DEFAULT_WORLD); refresh(); });

  const submit = el('button', 'btn primary scr-submit', opts.submitLabel || 'เริ่มเล่น');
  submit.type = 'submit';
  const actions = el('div', 'ws-actions');
  if (opts.onCancel) {
    const cancel = el('button', 'btn', opts.cancelLabel || 'ยกเลิก');
    cancel.type = 'button';
    cancel.addEventListener('click', () => { if (!pending) opts.onCancel(); });
    actions.appendChild(cancel);
    card.cancelBtn = cancel;
  }
  actions.append(reset, submit);
  form.append(err, actions);

  function refresh() {
    for (const [id, b] of Object.entries(cardEls)) {
      const on = values.mapSize === id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    for (const [k, s] of Object.entries(segs)) s.set(values[k]);
    const n = Math.max(1, Math.round(mapMetres(values.mapSize) / plotMetres()));
    const total = n * n;
    summary.textContent = `พื้นที่ทั้งหมด ${total} แปลง · เริ่มต้น ${Math.min(START_PLOTS, total)} แปลง`
      + (total > START_PLOTS ? ' · ซื้อแปลงเพิ่มด้วยทอง' : '');
  }
  refresh();

  let pending = false;
  function setPending(p) {
    pending = p;
    submit.disabled = reset.disabled = p;
    if (nameInput) nameInput.disabled = p;
    seedInput.disabled = dice.disabled = p;
    form.classList.toggle('pending', p);
    if (card.cancelBtn) card.cancelBtn.disabled = p;
    submit.textContent = p ? 'กำลังสร้าง…' : (opts.submitLabel || 'เริ่มเล่น');
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (pending) return;
    let name;
    if (nameInput) {
      name = nameInput.value.trim();
      if (!name) { showErr('กรุณาตั้งชื่อหมู่บ้าน'); nameInput.focus(); return; }
      if (name.length > 30) { showErr('ชื่อยาวเกินไป (ไม่เกิน 30 ตัวอักษร)'); return; }
    }
    showErr('');
    const settings = { ...values };
    const seed = seedFromText(seedInput.value);
    rememberWorld(settings);
    setPending(true);
    try {
      await opts.onSubmit({ name, settings, seed });
    } catch (e) {
      showErr((e && e.message) || 'เกิดข้อผิดพลาด');
      setPending(false);
    }
  });

  card.focusFirst = () => { (nameInput || cardEls[values.mapSize]).focus(); };
  return card;
}
