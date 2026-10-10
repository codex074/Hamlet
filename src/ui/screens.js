// Pre-game screens for cloud mode: sign in / register, choose a username, pick a village.
// Plain DOM (player-supplied text is only ever inserted with textContent). Styles live in style.css (.scr-*).
import * as api from '../net/api.js';
import { buildWorldForm } from './worldsetup.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[ก-ฺเ-๎a-zA-Z0-9_-]+(?: [ก-ฺเ-๎a-zA-Z0-9_-]+)*$/;

// ---------- tiny DOM helpers ----------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function button(label, cls) {
  const b = el('button', cls ? `btn ${cls}` : 'btn', label);
  b.type = 'button';
  return b;
}

// ---------- time formatting ----------
// Server timestamps are epoch milliseconds; tolerate seconds just in case.
export function toMs(t) {
  const n = Number(t) || 0;
  return n > 0 && n < 1e11 ? n * 1000 : n;
}

export function relTime(t, now = Date.now()) {
  const ms = toMs(t);
  if (!ms) return 'ยังไม่เคย';
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 45) return 'เมื่อสักครู่';
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(1, m)} นาทีที่แล้ว`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ชั่วโมงที่แล้ว`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'เมื่อวาน';
  if (d < 30) return `${d} วันที่แล้ว`;
  try {
    return new Date(ms).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

// ---------- host (full-screen animated backdrop + one centred card) ----------
let host = null;

const SCENE_SVG = `
<svg class="scr-hills" viewBox="0 0 1600 500" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
  <path class="h3" d="M0 330 C200 250 380 260 560 310 C760 365 930 240 1140 255 C1330 268 1470 330 1600 290 L1600 500 L0 500Z"/>
  <path class="h2" d="M0 390 C220 320 400 345 600 385 C800 425 980 330 1200 345 C1380 358 1500 400 1600 380 L1600 500 L0 500Z"/>
  <path class="h1" d="M0 445 C260 400 460 430 700 450 C940 470 1120 410 1340 425 C1470 433 1550 455 1600 448 L1600 500 L0 500Z"/>
  <g class="roofs">
    <path d="M300 372 l22 -24 l22 24z"/><rect x="306" y="372" width="32" height="16"/>
    <path d="M980 352 l26 -28 l26 28z"/><rect x="986" y="352" width="40" height="18"/>
    <path d="M1190 380 l18 -20 l18 20z"/><rect x="1195" y="380" width="26" height="14"/>
  </g>
</svg>`;

function ensureHost() {
  if (host && host.isConnected) return host;
  host = el('div', 'scr');
  const bg = el('div', 'scr-bg');
  const scene = el('div', 'scr-scene');
  scene.innerHTML = '<span class="cl c1"></span><span class="cl c2"></span><span class="cl c3"></span>'
    + '<span class="sun"></span>' + SCENE_SVG
    + '<span class="fly f1"></span><span class="fly f2"></span><span class="fly f3"></span><span class="fly f4"></span>';
  bg.appendChild(scene);
  bg.appendChild(el('div', 'scr-veil'));
  host.appendChild(bg);
  document.body.appendChild(host);
  return host;
}

function setCard(card) {
  const h = ensureHost();
  for (const old of h.querySelectorAll(':scope > .scr-card, :scope > .scr-wrap')) old.remove();
  h.appendChild(card);
  h.scrollTop = 0;
  return card;
}

export function closeScreens() {
  if (host) host.remove();
  host = null;
}

function brand(sub) {
  const b = el('div', 'scr-brand');
  b.append(el('div', 'scr-logo', '🏘️'), el('h1', null, 'Hamlet'), el('div', 'scr-tag', sub || 'หมู่บ้านยุคกลาง'));
  return b;
}

function errorBox() {
  const e = el('div', 'scr-err');
  e.setAttribute('role', 'alert');
  e.hidden = true;
  e.show = (msg) => { e.textContent = msg; e.hidden = !msg; };
  return e;
}

// Programmatic focus pops the on-screen keyboard on touch devices, covering half the form: skip it there.
const canAutoFocus = () => !(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

function field(label, input, hint) {
  const row = el('label', 'scr-field');
  row.append(el('span', 'scr-lbl', label), input);
  if (hint) row.appendChild(el('span', 'scr-hint', hint));
  return row;
}

function textInput(type, name, extra = {}) {
  const i = el('input');
  i.type = type;
  i.name = name;
  i.autocapitalize = 'none';
  i.autocorrect = 'off';
  i.spellcheck = false;
  for (const [k, v] of Object.entries(extra)) i.setAttribute(k, v);
  return i;
}

// ---------- modal (confirm / choice) above everything ----------
function modal(build) {
  const back = el('div', 'scr-modal');
  const box = el('div', 'scr-mbox');
  back.appendChild(box);
  const close = () => back.remove();
  build(box, close);
  ensureHost().appendChild(back);
  return { back, close };
}

// ====================================================================
// Auth screen: sign in / register / Google. Resolves with the user.
// ====================================================================
let gsiPromise = null;
function loadGsi() {
  if (window.google && window.google.accounts && window.google.accounts.id) return Promise.resolve(window.google);
  if (gsiPromise) return gsiPromise;
  gsiPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    const timer = setTimeout(() => reject(new Error('gsi timeout')), 10000);
    s.onload = () => { clearTimeout(timer); resolve(window.google); };
    s.onerror = () => { clearTimeout(timer); reject(new Error('gsi failed')); };
    document.head.appendChild(s);
  }).catch((e) => { gsiPromise = null; throw e; });
  return gsiPromise;
}

export function authScreen({ googleClientId = null, notice = '' } = {}) {
  return new Promise((resolve) => {
    let mode = 'login';
    let pending = false;

    const card = el('div', 'scr-card scr-auth');
    card.appendChild(brand());

    const tabs = el('div', 'scr-tabs');
    const tLogin = button('เข้าสู่ระบบ', 'scr-tab');
    const tReg = button('สมัครสมาชิก', 'scr-tab');
    tabs.append(tLogin, tReg);
    card.appendChild(tabs);

    const form = el('form', 'scr-form');
    form.noValidate = true;
    const email = textInput('email', 'email', { autocomplete: 'email', inputmode: 'email', maxlength: '254' });
    const pass = textInput('password', 'password', { autocomplete: 'current-password', maxlength: '128' });
    const confirm = textInput('password', 'confirm', { autocomplete: 'new-password', maxlength: '128' });

    const passRow = field('รหัสผ่าน', pass);
    const toggle = button('แสดง', 'scr-eye');
    toggle.setAttribute('aria-label', 'แสดงหรือซ่อนรหัสผ่าน');
    const wrap = el('span', 'scr-pw');
    pass.replaceWith(wrap);
    wrap.append(pass, toggle);
    const passHint = el('span', 'scr-hint', 'อย่างน้อย 8 ตัวอักษร');
    passRow.appendChild(passHint);
    const confirmRow = field('ยืนยันรหัสผ่าน', confirm);
    const err = errorBox();
    const submit = button('เข้าสู่ระบบ', 'primary scr-submit');
    submit.type = 'submit';
    form.append(field('อีเมล', email), passRow, confirmRow, err, submit);
    card.appendChild(form);

    toggle.addEventListener('click', () => {
      const show = pass.type === 'password';
      pass.type = confirm.type = show ? 'text' : 'password';
      toggle.textContent = show ? 'ซ่อน' : 'แสดง';
    });

    const gwrap = el('div', 'scr-google');
    gwrap.hidden = true;
    gwrap.append(el('div', 'scr-or', 'หรือ'));
    const gbtn = el('div', 'scr-gbtn');
    gwrap.appendChild(gbtn);
    card.appendChild(gwrap);

    function setPending(p) {
      pending = p;
      for (const c of [email, pass, confirm, toggle, tLogin, tReg]) c.disabled = p;
      submit.disabled = p;
      card.classList.toggle('pending', p);
      submit.textContent = p ? 'กำลังดำเนินการ…' : (mode === 'login' ? 'เข้าสู่ระบบ' : 'สมัครสมาชิก');
    }

    function setMode(m) {
      mode = m;
      tLogin.classList.toggle('active', m === 'login');
      tReg.classList.toggle('active', m === 'register');
      confirmRow.hidden = m === 'login';
      passHint.hidden = m === 'login';
      pass.autocomplete = m === 'login' ? 'current-password' : 'new-password';
      submit.textContent = m === 'login' ? 'เข้าสู่ระบบ' : 'สมัครสมาชิก';
      err.show('');
    }
    tLogin.addEventListener('click', () => setMode('login'));
    tReg.addEventListener('click', () => setMode('register'));

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (pending) return;
      const em = email.value.trim();
      const pw = pass.value;
      if (!EMAIL_RE.test(em) || em.length > 254) return err.show('กรุณากรอกอีเมลให้ถูกต้อง');
      if (mode === 'register') {
        if (pw.length < 8) return err.show('รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
        if (pw !== confirm.value) return err.show('รหัสผ่านทั้งสองช่องไม่ตรงกัน');
      } else if (!pw) {
        return err.show('กรุณากรอกรหัสผ่าน');
      }
      err.show('');
      setPending(true);
      try {
        const res = await api.post(mode === 'login' ? '/api/login' : '/api/register', { email: em, password: pw });
        resolve(res.user);
      } catch (e) {
        err.show(e.message);
        setPending(false);
        pass.focus();
      }
    });

    setMode('login');
    if (notice) err.show(notice);
    setCard(card);
    setTimeout(() => { if (canAutoFocus()) email.focus(); }, 50);

    if (googleClientId) {
      loadGsi().then((g) => {
        g.accounts.id.initialize({
          client_id: googleClientId,
          callback: async (resp) => {
            if (pending || !resp || !resp.credential) return;
            err.show('');
            setPending(true);
            try {
              const res = await api.post('/api/google', { credential: resp.credential });
              resolve(res.user);
            } catch (e) {
              err.show(e.message);
              setPending(false);
            }
          },
        });
        const width = Math.max(200, Math.min(320, Math.floor(card.clientWidth - 48)));
        g.accounts.id.renderButton(gbtn, { type: 'standard', theme: 'filled_black', size: 'large', text: 'signin_with', shape: 'pill', locale: 'th', width });
        gwrap.hidden = false;
      }).catch(() => { /* Google unavailable: email sign-in still works */ });
    }
  });
}

// ====================================================================
// Username screen. Resolves with the updated user.
// ====================================================================
export function validateUsername(raw) {
  const v = raw.trim();
  if (!v) return { ok: false, msg: '' };
  if (v.length < 3) return { ok: false, msg: 'สั้นเกินไป — อย่างน้อย 3 ตัวอักษร' };
  if (v.length > 20) return { ok: false, msg: 'ยาวเกินไป — ไม่เกิน 20 ตัวอักษร' };
  if (!USERNAME_RE.test(v)) return { ok: false, msg: 'ใช้ได้เฉพาะภาษาไทย English ตัวเลข _ และ -' };
  return { ok: true, msg: 'ใช้ชื่อนี้ได้' };
}

export function usernameScreen({ user }) {
  return new Promise((resolve, reject) => {
    let pending = false;
    const card = el('div', 'scr-card scr-user');
    card.appendChild(brand('ตั้งชื่อผู้เล่นของคุณ'));
    card.appendChild(el('p', 'scr-lead', 'ชื่อนี้จะใช้แสดงในเกม เลือกชื่อที่คุณชอบได้เลย'));
    const rules = el('ul', 'scr-rules');
    for (const t of ['ยาว 3–20 ตัวอักษร', 'ใช้ได้: ภาษาไทย, English, ตัวเลข, _ และ -', 'เว้นวรรคได้ (ไม่ขึ้นต้น/ลงท้าย) ชื่อซ้ำกับคนอื่นไม่ได้']) rules.appendChild(el('li', null, t));
    card.appendChild(rules);

    const form = el('form', 'scr-form');
    form.noValidate = true;
    const input = textInput('text', 'username', { autocomplete: 'username', maxlength: '40' });
    const live = el('div', 'scr-live');
    const err = errorBox();
    const submit = button('ตั้งชื่อ', 'primary scr-submit');
    submit.type = 'submit';
    submit.disabled = true;
    form.append(field('ชื่อผู้เล่น', input), live, err, submit);
    card.appendChild(form);

    input.addEventListener('input', () => {
      const r = validateUsername(input.value);
      live.textContent = r.msg;
      live.className = `scr-live ${r.msg ? (r.ok ? 'ok' : 'bad') : ''}`;
      submit.disabled = !r.ok || pending;
      err.show('');
    });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const r = validateUsername(input.value);
      if (!r.ok || pending) return;
      pending = true;
      input.disabled = submit.disabled = true;
      submit.textContent = 'กำลังบันทึก…';
      try {
        const res = await api.post('/api/username', { username: input.value.trim() });
        resolve(res.user);
      } catch (e) {
        if (e.status === 401) { reject(e); return; }
        err.show(e.status === 409 ? 'ชื่อนี้มีคนใช้แล้ว' : e.message);
        live.textContent = '';
        live.className = 'scr-live';
        pending = false;
        input.disabled = false;
        submit.disabled = false;
        submit.textContent = 'ตั้งชื่อ';
        input.focus();
      }
    });
    setCard(card);
    setTimeout(() => { if (canAutoFocus()) input.focus(); }, 50);
    void user;
  });
}

// ====================================================================
// Village select. Resolves { action: 'play', village, save } or { action: 'logout' }.
// ====================================================================
export function villageSelectScreen({ user }) {
  return new Promise((resolve, reject) => {
    let villages = [];
    let max = 3;
    let loaded = false;
    let busy = false;
    let editing = null;       // village id being renamed
    let creating = null;     // slot number being filled in
    let playingId = null;
    let globalError = '';
    let focusSel = null;

    const wrapEl = el('div', 'scr-wrap');
    const head = el('div', 'scr-head');
    const hello = el('div', 'scr-hello');
    hello.append(el('span', 'scr-hi', 'สวัสดี '), el('b', null, user.username || ''));
    const logout = button('ออกจากระบบ', 'scr-logout');
    head.append(hello, logout);
    const title = el('h2', 'scr-title', 'เลือกหมู่บ้านของคุณ');
    const err = errorBox();
    const grid = el('div', 'scr-slots');
    const foot = el('div', 'scr-foot', '☁️ เซฟเก็บบนเซิร์ฟเวอร์ เล่นต่อได้ทุกเครื่อง');
    wrapEl.append(head, title, err, grid, foot);

    logout.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      logout.disabled = true;
      try { await api.post('/api/logout'); } catch { /* cookie may already be gone */ }
      resolve({ action: 'logout' });
    });

    function fail(e) {
      if (e && e.status === 401) { reject(e); return true; }
      globalError = (e && e.message) || 'เกิดข้อผิดพลาด';
      return false;
    }

    async function refresh() {
      try {
        const res = await api.get('/api/villages');
        villages = res.villages || [];
        max = res.max || 3;
        loaded = true;
        globalError = '';
      } catch (e) {
        fail(e);
      }
      render();
    }

    async function play(v) {
      if (busy) return;
      busy = true;
      playingId = v.id;
      globalError = '';
      render();
      try {
        const res = await api.get(`/api/villages/${v.id}/save`);
        resolve({ action: 'play', village: { ...v, ...(res.village || {}) }, save: res.save == null ? null : res.save });
      } catch (e) {
        busy = false;
        playingId = null;
        fail(e);
        render();
      }
    }

    function nameInput(value, ph) {
      const i = textInput('text', 'village-name', { maxlength: '30', placeholder: ph || '' });
      i.autocomplete = 'off';
      i.value = value || '';
      return i;
    }

    function emptySlot(n) {
      const c = el('div', 'scr-slot empty click');
      c.appendChild(el('div', 'scr-slotno', `หมู่บ้านที่ ${n}`));
      c.appendChild(el('div', 'scr-plus', '＋'));
      const b = button('สร้างหมู่บ้านใหม่', 'primary');
      b.disabled = busy;
      b.addEventListener('click', () => openCreate(n));
      c.appendChild(b);
      return c;
    }

    // World settings form replaces the list until the village is created (or cancelled).
    function openCreate(n) {
      if (busy) return;
      creating = n;
      editing = null;
      const form = buildWorldForm({
        title: 'สร้างหมู่บ้านใหม่',
        subtitle: `หมู่บ้านที่ ${n} — เลือกแผนที่และกติกา`,
        withName: true,
        submitLabel: 'สร้างและเริ่มเล่น',
        onCancel: () => { creating = null; setCard(wrapEl); render(); },
        onSubmit: async ({ name, settings, seed }) => {
          let res;
          try {
            res = await api.createVillage(name, settings, seed);
          } catch (er) {
            if (er.status === 401) { reject(er); return; }
            throw er;
          }
          creating = null;
          villages = [...villages, res.village];
          setCard(wrapEl);
          await play(res.village);
        },
      });
      setCard(form);
      setTimeout(() => { if (canAutoFocus()) form.focusFirst(); }, 50);
    }

    function filledSlot(v, n) {
      const c = el('div', 'scr-slot');
      c.appendChild(el('div', 'scr-slotno', `หมู่บ้านที่ ${n}`));
      if (editing === v.id) {
        const f = el('form', 'scr-form');
        f.noValidate = true;
        const input = nameInput(v.name);
        const ok = button('บันทึก', 'primary');
        ok.type = 'submit';
        const cancel = button('ยกเลิก');
        const row = el('div', 'scr-btns');
        row.append(cancel, ok);
        const e = errorBox();
        f.append(field('ชื่อหมู่บ้าน', input), e, row);
        cancel.addEventListener('click', () => { editing = null; render(); });
        f.addEventListener('submit', async (ev) => {
          ev.preventDefault();
          if (busy) return;
          const name = input.value.trim();
          if (!name) return e.show('กรุณาตั้งชื่อหมู่บ้าน');
          if (name.length > 30) return e.show('ชื่อยาวเกินไป (ไม่เกิน 30 ตัวอักษร)');
          if (name === v.name) { editing = null; render(); return; }
          busy = true;
          ok.disabled = cancel.disabled = input.disabled = true;
          try {
            await api.patch(`/api/villages/${v.id}`, { name });
            editing = null;
            busy = false;
            await refresh();
          } catch (er) {
            busy = false;
            if (er.status === 401) { reject(er); return; }
            ok.disabled = cancel.disabled = input.disabled = false;
            e.show(er.message);
          }
        });
        c.appendChild(f);
        focusSel = '.scr-slot form input';
        return c;
      }
      const nm = el('div', 'scr-vname', v.name);
      nm.title = v.name;
      c.appendChild(nm);
      const stats = el('div', 'scr-stats');
      if (v.hasSave) stats.textContent = `วันที่ ${v.day || 1} · ประชากร ${v.pop || 0}`;
      else stats.textContent = 'ยังไม่เริ่มเล่น';
      c.appendChild(stats);
      c.appendChild(el('div', 'scr-last', `เล่นล่าสุด ${v.hasSave ? relTime(v.updatedAt) : '—'}`));
      const row = el('div', 'scr-btns');
      const go = button(playingId === v.id ? 'กำลังโหลด…' : 'เล่นต่อ', 'primary');
      const ren = button('เปลี่ยนชื่อ');
      const rm = button('ลบ', 'danger');
      go.disabled = ren.disabled = rm.disabled = busy;
      go.addEventListener('click', () => play(v));
      ren.addEventListener('click', () => { editing = v.id; creating = null; render(); });
      rm.addEventListener('click', () => confirmDelete(v));
      row.append(go, ren, rm);
      c.appendChild(row);
      return c;
    }

    function confirmDelete(v) {
      modal((box, close) => {
        box.appendChild(el('h2', null, 'ลบหมู่บ้าน?'));
        const p = el('p');
        p.append('หมู่บ้าน “', el('b', null, v.name), '” จะถูกลบถาวรและกู้คืนไม่ได้ พิมพ์ชื่อหมู่บ้านให้ตรงกันเพื่อยืนยัน');
        box.appendChild(p);
        const f = el('form', 'scr-form');
        f.noValidate = true;
        const input = nameInput('', v.name);
        const e = errorBox();
        const cancel = button('ยกเลิก');
        const ok = button('ลบหมู่บ้าน', 'danger');
        ok.type = 'submit';
        ok.disabled = true;
        const row = el('div', 'scr-btns');
        row.append(cancel, ok);
        f.append(input, e, row);
        box.appendChild(f);
        input.addEventListener('input', () => { ok.disabled = input.value.trim() !== v.name; });
        cancel.addEventListener('click', close);
        f.addEventListener('submit', async (ev) => {
          ev.preventDefault();
          if (input.value.trim() !== v.name || busy) return;
          busy = true;
          ok.disabled = cancel.disabled = input.disabled = true;
          ok.textContent = 'กำลังลบ…';
          try {
            await api.del(`/api/villages/${v.id}`);
            busy = false;
            close();
            await refresh();
          } catch (er) {
            busy = false;
            if (er.status === 401) { reject(er); return; }
            cancel.disabled = input.disabled = false;
            ok.textContent = 'ลบหมู่บ้าน';
            ok.disabled = input.value.trim() !== v.name;
            e.show(er.message);
          }
        });
        setTimeout(() => { if (canAutoFocus()) input.focus(); }, 30);
      });
    }

    function render() {
      err.show(globalError);
      grid.textContent = '';
      focusSel = null;
      if (!loaded) {
        grid.appendChild(el('div', 'scr-loading', 'กำลังโหลดหมู่บ้าน…'));
        return;
      }
      for (let i = 0; i < max; i += 1) {
        grid.appendChild(i < villages.length ? filledSlot(villages[i], i + 1) : emptySlot(i + 1));
      }
      if (focusSel) {
        const f = grid.querySelector(focusSel);
        if (f) setTimeout(() => { if (canAutoFocus()) f.focus(); }, 20);
      }
    }

    render();
    setCard(wrapEl);
    refresh();
  });
}

// ====================================================================
// Choice between server save and a newer local backup.
// ====================================================================
export function choiceModal({ server, local }) {
  return new Promise((resolve) => {
    modal((box, close) => {
      box.appendChild(el('h2', null, 'พบเซฟที่ใหม่กว่าในเครื่องนี้'));
      box.appendChild(el('p', null, 'เซฟในเครื่องนี้ใหม่กว่าเซฟบนเซิร์ฟเวอร์ (อาจเกิดจากปิดหน้าเว็บก่อนบันทึกเสร็จ) ต้องการใช้เซฟไหน?'));
      const opts = el('div', 'scr-choices');
      const mk = (label, info, kind, cls) => {
        const b = button('', `scr-choice ${cls || ''}`);
        b.append(el('b', null, label), el('span', null, info));
        b.addEventListener('click', () => { close(); resolve(kind); });
        return b;
      };
      const desc = (s) => (s ? `${s.day != null ? `วันที่ ${s.day} · ประชากร ${s.pop} · ` : ''}${relTime(s.t)}` : 'ยังไม่มีเซฟ');
      opts.append(
        mk('ใช้เซฟบนเซิร์ฟเวอร์', desc(server), 'server'),
        mk('ใช้เซฟในเครื่องนี้', desc(local), 'local', 'primary'),
      );
      box.appendChild(opts);
    });
  });
}

// Shown if a village cannot be loaded; offers a way back.
export function fatalScreen(message, { actionLabel = 'กลับไปเลือกหมู่บ้าน', onAction } = {}) {
  const card = el('div', 'scr-card');
  card.appendChild(brand('เกิดข้อผิดพลาด'));
  card.appendChild(el('p', 'scr-lead', message));
  const b = button(actionLabel, 'primary scr-submit');
  b.addEventListener('click', () => { if (onAction) onAction(); });
  card.appendChild(b);
  setCard(card);
}

// ====================================================================
// Local mode: world settings for a brand-new game. Resolves { settings, seed } (seed null = random).
// ====================================================================
export function localWorldScreen() {
  return new Promise((resolve) => {
    const form = buildWorldForm({
      title: 'เริ่มเกมใหม่',
      subtitle: 'เลือกแผนที่และกติกาของหมู่บ้าน — กำหนดตอนสร้างเท่านั้น',
      submitLabel: 'เริ่มเล่น',
      onSubmit: async ({ settings, seed }) => { closeScreens(); resolve({ settings, seed }); },
    });
    setCard(form);
    setTimeout(() => { if (canAutoFocus()) form.focusFirst(); }, 50);
  });
}
