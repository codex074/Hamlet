// Job assignment UI: the workforce overview, the job picker (for a villager) and the worker picker
// (for a workplace), plus the worker list shown in a workplace's info panel. DOM only.
import { BUILDINGS } from '../config.js';
import * as sim from '../sim.js';

const STAGE_NAME = { child: 'เด็ก', adult: 'ผู้ใหญ่', elder: 'ผู้สูงอายุ' };
const FILTERS = [
  { id: 'all', label: 'ทั้งหมด' },
  { id: 'free', label: 'ว่างงาน' },
  { id: 'builder', label: 'ช่างก่อสร้าง' },
  { id: 'job', label: 'ประจำอาคาร' },
];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const genderIcon = (g) => (g === 'f' ? '<span class="gf">♀</span>' : g === 'm' ? '<span class="gm">♂</span>' : '');
const stageOf = (v) => {
  const a = v.age ?? 30;
  return a < 14 ? 'child' : a >= 55 ? 'elder' : 'adult';
};
const fullName = (v) => [v.name, v.surname].filter(Boolean).join(' ') || `ชาวบ้าน #${v.id}`;

function flags(v) {
  let out = '';
  if (stageOf(v) === 'elder') out += v.gender === 'f' ? '👵' : '👴';
  if (v.pregnant) out += '🤰';
  if (v.sick) out += '🤒';
  return out;
}

// opts: { root, call(name, ...args), getState(), toast(text), icon(type) -> emoji }
export function createWorkforceUI({ root, call, getState, toast, icon }) {
  const BUILDER_ICON = '🏗️';
  const jobIcon = (key, type) => (key === sim.BUILDER ? BUILDER_ICON : key == null ? '🚶' : icon(type));

  // ---------- modal shell ----------
  let modal = null;   // { back, box, kind, render? }
  function closeModal() {
    if (!modal) return;
    modal.back.remove();
    document.removeEventListener('keydown', modal.onKey, true);
    modal = null;
  }
  function openModal(kind, cls, title) {
    closeModal();
    const back = el('div', 'backdrop');
    const box = el('div', `modal-box wf ${cls || ''}`);
    const head = el('div', 'wf-head');
    head.appendChild(el('h2', null, title));
    const x = el('button', 'x', '✕');
    x.type = 'button';
    x.title = 'ปิด (Esc)';
    x.addEventListener('click', closeModal);
    head.appendChild(x);
    box.appendChild(head);
    back.appendChild(box);
    back.addEventListener('mousedown', (e) => { if (e.target === back) closeModal(); });
    const onKey = (e) => { if (e.code === 'Escape') { e.stopPropagation(); closeModal(); } };
    document.addEventListener('keydown', onKey, true);
    root.appendChild(back);
    modal = { back, box, kind, onKey };
    return box;
  }

  function assign(vId, key, label) {
    const r = call('assignJob', vId, key) || { ok: false, reason: 'มอบหมายงานไม่ได้' };
    const state = getState();
    const v = state && state.villagers.find((p) => p.id === vId);
    if (!r.ok) toast(r.reason || 'มอบหมายงานไม่ได้');
    else if (v) toast(key == null ? `${fullName(v)} ว่างงานแล้ว` : `${fullName(v)} → ${label}`);
    return r.ok;
  }

  // ---------- job picker (one villager → a job) ----------
  function openJobPicker(vId) {
    const state = getState();
    const v = state && state.villagers.find((p) => p.id === vId);
    if (!v) return;
    const box = openModal('job', 'wf-pick', `เลือกงานให้ ${fullName(v)}`);
    const st = stageOf(v);
    box.appendChild(el('div', 'wf-sub', `${Math.floor(v.age ?? 0)} ปี · ${STAGE_NAME[st]}${st === 'elder' ? ' (ทำได้เฉพาะงานเบา)' : ''} · ตอนนี้: ${sim.jobTitleOf(state, v)}`));
    const wait = sim.waitingReason(state, v);
    if (wait) box.appendChild(el('div', 'wf-note', `⏳ ${wait}`));
    const list = el('div', 'wf-list');
    const choices = sim.jobChoices(state, vId);
    let lastGroup = '';
    for (const c of choices) {
      const group = c.key == null || c.key === sim.BUILDER ? 'ทั่วไป' : 'ประจำอาคาร';
      if (group !== lastGroup) { list.appendChild(el('div', 'wf-group', group)); lastGroup = group; }
      const btn = el('button', `wf-opt${c.current ? ' cur' : ''}`);
      btn.type = 'button';
      btn.disabled = !c.ok && !c.current;
      let desc;
      if (c.key == null) desc = 'ไม่ทำงาน — เดินเล่นแถวบ้าน';
      else if (c.key === sim.BUILDER) desc = `ขนวัสดุและสร้างอาคาร · ตอนนี้ ${c.count} คน`;
      else desc = `${c.title ? `ตำแหน่ง ${c.title} · ` : ''}คนงาน ${c.count}/${c.max}${c.light ? ' · งานเบา' : ''}`;
      if (!c.ok && c.reason) desc += ` · ${c.reason}`;
      btn.innerHTML = `<span class="wf-ic">${jobIcon(c.key, c.type)}</span><span class="wf-tx"><b>${esc(c.name)}</b><span class="dim">${esc(desc)}</span></span>${c.current ? '<span class="wf-cur">✓ ปัจจุบัน</span>' : ''}`;
      btn.addEventListener('click', () => {
        if (c.current) { closeModal(); return; }
        if (assign(vId, c.key, c.title || c.name)) closeModal();
      });
      list.appendChild(btn);
    }
    box.appendChild(list);
  }

  // ---------- worker picker (one workplace → a villager) ----------
  function openWorkerPicker(bId) {
    const state = getState();
    const b = state && state.buildings.find((x) => x.id === bId);
    if (!b) return;
    const max = BUILDINGS[b.type].workers || 0;
    const title = sim.JOB_TITLE[b.type] || 'คนงาน';
    const where = sim.workplaceName(state, b);
    const box = openModal('worker', 'wf-pick', where.startsWith(title) ? `เลือกคนงาน — ${where}` : `เลือก${title} — ${where}`);
    box.appendChild(el('div', 'wf-sub', `คนงาน ${b.workers.length}/${max}${BUILDINGS[b.type].light ? ' · งานเบา ผู้สูงอายุทำได้' : ' · งานหนัก ต้องเป็นผู้ใหญ่'}`));
    const cands = sim.jobCandidates(state, bId);
    const list = el('div', 'wf-list');
    if (!cands.length) list.appendChild(el('div', 'wf-empty', 'ไม่มีชาวบ้านที่ทำงานนี้ได้'));
    let lastGroup = '';
    for (const c of cands) {
      const group = c.current == null ? 'ว่างงาน' : 'ย้ายจากงานอื่น';
      if (group !== lastGroup) { list.appendChild(el('div', 'wf-group', group)); lastGroup = group; }
      const btn = el('button', 'wf-opt');
      btn.type = 'button';
      const v = state.villagers.find((p) => p.id === c.id) || c;
      const meta = `${c.age} ปี${c.currentName ? ` · ตอนนี้: ${c.currentName}` : ''}${c.sick ? ' · ป่วย (เริ่มงานเมื่อหาย)' : ''}${c.pregnant ? ' · ตั้งครรภ์ (เริ่มงานหลังคลอด)' : ''}`;
      btn.innerHTML = `<span class="wf-ic">${genderIcon(c.gender)}</span><span class="wf-tx"><b>${esc(c.name)} ${flags(v)}</b><span class="dim">${esc(meta)}</span></span>`;
      btn.addEventListener('click', () => { if (assign(c.id, bId, title)) closeModal(); });
      list.appendChild(btn);
    }
    box.appendChild(list);
  }

  // ---------- workforce overview ----------
  let filter = 'all';
  let panelSig = '';
  function openWorkforce() {
    const box = openModal('panel', 'wf-panel', '👥 จัดการงาน');
    box.appendChild(el('div', 'wf-sub', 'ระบบจะไม่ส่งใครไปทำงานเอง — เลือกงานให้ชาวบ้านแต่ละคน ชุดของเขาจะเปลี่ยนตามงานที่ได้รับ'));
    const sum = el('div', 'wf-sum');
    const tabs = el('div', 'wf-tabs');
    for (const f of FILTERS) {
      const t = el('button', `wf-tab${f.id === filter ? ' on' : ''}`, f.label);
      t.type = 'button';
      t.dataset.f = f.id;
      tabs.appendChild(t);
    }
    tabs.addEventListener('click', (e) => {
      const t = e.target.closest('[data-f]');
      if (!t) return;
      filter = t.dataset.f;
      for (const n of tabs.children) n.classList.toggle('on', n.dataset.f === filter);
      panelSig = '';
      renderPanel();
    });
    const rows = el('div', 'wf-rows');
    rows.addEventListener('change', (e) => {
      const sel = e.target.closest('select[data-vid]');
      if (!sel) return;
      const vId = Number(sel.dataset.vid);
      const key = sel.value === '' ? null : sel.value === sim.BUILDER ? sim.BUILDER : Number(sel.value);
      assign(vId, key, sel.selectedOptions[0] ? sel.selectedOptions[0].dataset.title : '');
      sel.blur();
      panelSig = '';
      renderPanel();
    });
    rows.addEventListener('click', (e) => {
      const lk = e.target.closest('[data-vid].lnk');
      if (!lk) return;
      closeModal();
      call('selectVillager', Number(lk.dataset.vid));
    });
    box.append(sum, tabs, rows);
    modal.render = renderPanel;
    modal.parts = { sum, rows };
    panelSig = '';
    renderPanel();
  }

  function optionsHtml(state, v) {
    let h = '';
    for (const c of sim.jobChoices(state, v.id)) {
      const val = c.key == null ? '' : String(c.key);
      const label = c.key == null ? '🚶 ว่างงาน'
        : c.key === sim.BUILDER ? `${BUILDER_ICON} ช่างก่อสร้าง (${c.count})`
          : `${icon(c.type)} ${c.name} (${c.count}/${c.max})${c.ok || c.current ? '' : ` — ${c.reason}`}`;
      h += `<option value="${esc(val)}" data-title="${esc(c.title || c.name)}"${c.current ? ' selected' : ''}${!c.ok && !c.current ? ' disabled' : ''}>${esc(label)}</option>`;
    }
    return h;
  }

  function renderPanel() {
    if (!modal || modal.kind !== 'panel') return;
    const state = getState();
    if (!state) return;
    const people = state.villagers.filter((v) => stageOf(v) !== 'child');
    const posts = state.buildings.filter((b) => b.built && BUILDINGS[b.type] && BUILDINGS[b.type].job)
      .map((b) => `${b.id}:${(b.workers || []).length}:${b.paused ? 1 : 0}`).join(',');
    const sig = `${filter}|${posts}|${people.map((v) => `${v.id}:${v.jobId}:${v.builder ? 1 : 0}:${stageOf(v)}:${v.sick ? 1 : 0}:${v.pregnant ? 1 : 0}`).join(',')}`;
    if (sig === panelSig) return;
    // never rebuild under an open dropdown
    if (modal.box.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
    panelSig = sig;
    const ws = sim.workforceSummary(state);
    const kids = state.villagers.length - people.length;
    modal.parts.sum.innerHTML = `<span>ทำงานได้ <b>${ws.able}</b></span><span class="${ws.free > 0 ? 'hi' : ''}">ว่างงาน <b>${ws.free}</b></span>`
      + `<span class="${ws.sites > 0 && ws.builders === 0 ? 'bad' : ''}">${BUILDER_ICON} ช่างก่อสร้าง <b>${ws.builders}</b>${ws.sites > 0 ? ` <span class="dim">(งานก่อสร้าง ${ws.sites})</span>` : ''}</span>`
      + `<span class="${ws.openSlots > 0 ? 'hi' : ''}">ตำแหน่งว่าง <b>${ws.openSlots}</b></span>${kids ? `<span class="dim">เด็ก ${kids}</span>` : ''}`;
    const shown = people.filter((v) => (filter === 'free' ? v.jobId == null && !v.builder
      : filter === 'builder' ? v.builder : filter === 'job' ? v.jobId != null : true))
      .sort((a, b) => fullName(a).localeCompare(fullName(b), 'th') || a.id - b.id);
    if (!shown.length) {
      modal.parts.rows.innerHTML = `<div class="wf-empty">${filter === 'free' ? 'ทุกคนมีงานทำแล้ว 👍' : 'ไม่มีชาวบ้านในกลุ่มนี้'}</div>`;
      return;
    }
    modal.parts.rows.innerHTML = shown.map((v) => {
      const wait = sim.waitingReason(state, v);
      return `<div class="wf-row"><div class="wf-who">${genderIcon(v.gender)} <button type="button" class="lnk" data-vid="${v.id}">${esc(fullName(v))}</button> ${flags(v)}`
        + `<div class="dim small">${Math.floor(v.age ?? 0)} ปี · ${esc(sim.jobTitleOf(state, v))}${wait ? ` · ⏳ ${esc(wait)}` : ''}</div></div>`
        + `<select data-vid="${v.id}" aria-label="งานของ ${esc(fullName(v))}">${optionsHtml(state, v)}</select></div>`;
    }).join('');
  }

  // ---------- building panel: the worker list ----------
  function workersHtml(b, state) {
    const max = BUILDINGS[b.type].workers || 0;
    const title = sim.JOB_TITLE[b.type] || 'คนงาน';
    const byId = new Map(state.villagers.map((v) => [v.id, v]));
    let h = `<div class="wl-head"><span>${esc(title)} ${b.workers.length}/${max}</span></div><ul class="wl">`;
    for (const id of b.workers) {
      const v = byId.get(id);
      if (!v) continue;
      const wait = sim.waitingReason(state, v);
      h += `<li>${genderIcon(v.gender)} <button type="button" class="lnk" data-vid="${v.id}">${esc(fullName(v))}</button> ${flags(v)}`
        + `${wait ? `<span class="dim small" title="${esc(wait)}"> ⏳</span>` : ''}`
        + `<button type="button" class="wl-x" data-wact="remove" data-vid="${v.id}" title="ปลดออกจากงาน">✕</button></li>`;
    }
    for (let i = b.workers.length; i < max; i++) {
      h += '<li class="empty"><button type="button" class="wl-add" data-wact="add">＋ เพิ่มคนงาน</button></li>';
    }
    return h + '</ul>';
  }

  // Delegated clicks inside the worker list of building bId.
  function onWorkersClick(e, bId) {
    const btn = e.target.closest('[data-wact],[data-vid]');
    if (!btn) return;
    if (btn.dataset.wact === 'add') openWorkerPicker(bId);
    else if (btn.dataset.wact === 'remove') assign(Number(btn.dataset.vid), null, '');
    else call('selectVillager', Number(btn.dataset.vid));
  }

  function refresh() {
    if (modal && modal.render) modal.render();
  }

  return {
    openJobPicker, openWorkerPicker, openWorkforce, closeModal, refresh, workersHtml, onWorkersClick,
    isOpen: () => modal != null,
  };
}
