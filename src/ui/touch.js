// On-screen controls for touch play (iPad): a floating action bar above the build bar.
//   build tool : ↻ หมุน (tap = 15 deg, hold = spin)   ✓ วาง   ✕ ยกเลิก
//   zone tool  : −  brush size  +   ✓ เสร็จ
//   demolish / territory / a selected building or villager : ✕ ปิด (the Esc equivalent)
// Shown only while touch / pen is the active input (tools.touchMode: coarse pointer, or touch seen) and something
// is active. Buttons react on pointerdown (instant feedback), act on pointerup, and are at least 48 px big.

const HOLD_MS = 380;   // press-and-hold on ↻ starts continuous rotation

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// Button that acts on pointerup (inside the button) with a pressed look from pointerdown on.
// opts.hold: { start(), stop() } -> after HOLD_MS of pressing, `start` runs and the release no longer counts as a tap.
function pressable(btn, onTap, opts = {}) {
  let down = null;   // pointerId
  let timer = 0;
  let held = false;
  btn.type = 'button';
  btn.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    down = e.pointerId;
    held = false;
    btn.classList.add('down');
    try { btn.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    if (opts.hold) {
      timer = setTimeout(() => { held = true; opts.hold.start(); }, HOLD_MS);
    }
  });
  const finish = (e, ok) => {
    if (down !== e.pointerId) return;
    down = null;
    clearTimeout(timer);
    btn.classList.remove('down');
    if (held) { held = false; opts.hold.stop(); return; }
    if (!ok) return;
    const r = btn.getBoundingClientRect();
    const inside = e.clientX >= r.left - 8 && e.clientX <= r.right + 8 && e.clientY >= r.top - 8 && e.clientY <= r.bottom + 8;
    if (inside) onTap();
  };
  btn.addEventListener('pointerup', (e) => finish(e, true));
  btn.addEventListener('pointercancel', (e) => finish(e, false));
  btn.addEventListener('lostpointercapture', (e) => { if (down === e.pointerId) finish(e, false); });
  // keyboard / assistive activation (a click with no pointer behind it)
  btn.addEventListener('click', (e) => { if (e.detail === 0) onTap(); });
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  return btn;
}

export function createTouchControls({ root = document.body, tools }) {
  const bar = el('div', 'tc-bar');
  bar.id = 'touchbar';
  bar.hidden = true;
  const caption = el('div', 'tc-cap');
  const row = el('div', 'tc-row');
  bar.append(caption, row);

  const rotateBtn = el('button', 'tc-btn tc-rot');
  rotateBtn.innerHTML = '<span class="tc-ic">↻</span><span class="tc-tx">หมุน</span>';
  const placeBtn = el('button', 'tc-btn tc-ok');
  placeBtn.innerHTML = '<span class="tc-ic">✓</span><span class="tc-tx">วาง</span>';
  const cancelBtn = el('button', 'tc-btn tc-no');
  cancelBtn.innerHTML = '<span class="tc-ic">✕</span><span class="tc-tx">ยกเลิก</span>';
  const minusBtn = el('button', 'tc-btn tc-sq', '−');
  const brushLbl = el('div', 'tc-lbl');
  const plusBtn = el('button', 'tc-btn tc-sq', '+');
  const doneBtn = el('button', 'tc-btn tc-ok');
  doneBtn.innerHTML = '<span class="tc-ic">✓</span><span class="tc-tx">เสร็จ</span>';
  const closeBtn = el('button', 'tc-btn tc-no');
  closeBtn.innerHTML = '<span class="tc-ic">✕</span><span class="tc-tx">ปิด</span>';
  row.append(rotateBtn, placeBtn, cancelBtn, minusBtn, brushLbl, plusBtn, doneBtn, closeBtn);

  // continuous rotation while ↻ is held
  let spin = 0;
  let spinLast = 0;
  const spinFrame = (now) => {
    const dt = Math.min(0.05, (now - spinLast) / 1000);
    spinLast = now;
    tools.touch.rotate(tools.touch.rotateRate * dt);
    spin = requestAnimationFrame(spinFrame);
  };
  pressable(rotateBtn, () => tools.touch.rotateStep(1), {
    hold: {
      start() { spinLast = performance.now(); spin = requestAnimationFrame(spinFrame); },
      stop() { cancelAnimationFrame(spin); spin = 0; },
    },
  });
  pressable(placeBtn, () => tools.touch.place());
  pressable(cancelBtn, () => tools.touch.cancel());
  pressable(minusBtn, () => tools.touch.brush(-1));
  pressable(plusBtn, () => tools.touch.brush(1));
  pressable(doneBtn, () => tools.touch.done());
  pressable(closeBtn, () => tools.touch.cancel());

  root.appendChild(bar);

  let sig = '';
  function sync(s) {
    const show = !!s.active && (s.kind != null || s.selection);
    if (bar.hidden === show) bar.hidden = !show;
    if (!show) { sig = ''; return; }
    const mode = s.kind === 'build' ? 'build' : s.kind === 'zone' ? 'zone' : 'close';
    const ready = mode === 'build' ? (s.hasSpot && s.valid === true) : true;
    const next = [mode, s.kind, s.name, s.hasSpot, s.valid, s.reason, s.brush, s.selection].join('|');
    if (next === sig) return;
    sig = next;
    bar.dataset.mode = mode;
    bar.dataset.sel = s.kind == null ? '1' : '0';
    rotateBtn.hidden = placeBtn.hidden = cancelBtn.hidden = mode !== 'build';
    minusBtn.hidden = brushLbl.hidden = plusBtn.hidden = doneBtn.hidden = mode !== 'zone';
    closeBtn.hidden = mode !== 'close';
    placeBtn.classList.toggle('is-off', !ready);
    placeBtn.setAttribute('aria-disabled', ready ? 'false' : 'true');
    minusBtn.classList.toggle('is-off', s.brush <= s.brushMin);
    plusBtn.classList.toggle('is-off', s.brush >= s.brushMax);
    brushLbl.textContent = `แปรง ${s.brush} ม.`;
    let text = '';
    let warn = false;
    if (mode === 'build') {
      if (!s.hasSpot) text = 'แตะบนแผนที่เพื่อเลือกที่วางอาคาร';
      else if (s.valid === false) { text = s.reason || 'วางตรงนี้ไม่ได้'; warn = true; }
      else text = `${s.name} · แตะที่อื่นหรือลากตัวอาคารเพื่อย้าย`;
    } else if (mode === 'zone') {
      text = 'ลากนิ้วเพื่อระบายโซน · สองนิ้วเลื่อน/ย่อขยายแผนที่';
    } else if (s.kind === 'demolish') {
      text = 'โหมดรื้อถอน · แตะอาคารที่ต้องการรื้อ';
    } else if (s.kind === 'territory') {
      text = 'โหมดดินแดน · แตะแปลงที่ต้องการซื้อ';
    }
    caption.textContent = text;
    caption.hidden = !text;
    caption.classList.toggle('warn', warn);
  }

  tools.setTouchUI({ sync });
  return {
    sync,
    destroy() {
      cancelAnimationFrame(spin);
      bar.remove();
      tools.setTouchUI(null);
    },
  };
}
