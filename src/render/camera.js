// RTS camera: orbits `target`, pans on the ground plane, zooms by changing distance.
import * as THREE from '../../vendor/three.module.js';
import { WORLD_SIZE } from '../config.js';
import { getViewWorldSize } from './viewworld.js';

const DIST_MIN = 15;
const DIST_MAX_SMALL = 160;
const DIST_MAX_BIG = 220;   // maps larger than 300 m can zoom out further
const PITCH_NEAR = 0.55;
const PITCH_FAR = 1.1;
const DRAG_THRESHOLD = 4; // px before a left-button pan counts as a drag
const PITCH_MIN = 0.3;    // limits for the two-finger tilt (pitch = base pitch for the zoom level + tilt)
const PITCH_MAX = 1.35;
const TILT_MIN = -0.6;
const TILT_MAX = 0.5;
const TAP_SLOP = 10;      // px a touch may move and still be a tap / long-press
const TAP_MAX_MS = 300;
const LONG_PRESS_MS = 500;
const CLAIM_BEGIN_PX = 4; // a claimed one-finger drag (zone brush / ghost) starts after this much movement ...
const CLAIM_BEGIN_MS = 110; // ... or this long, so a second finger can still turn it into a pinch

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function isTyping(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

// `world` (optional 4th argument, or setWorld() later): the terrain object ({ size }) or a plain size in metres.
// The pan target is clamped to [0, size]. Without it the size published by createTerrainMesh() is used
// (see viewworld.js), and finally the small-map default (WORLD_SIZE).
//
// Input is Pointer Events. Mouse: left-drag pans when no tool wants the left button, right-drag rotates, middle-drag
// pans, wheel zooms. Touch / pen: one finger pans (ground-anchored, with a little inertia), two fingers pinch-zoom
// around their midpoint, twist to rotate and drag vertically to tilt. Taps / long-presses and "claimed" one-finger
// drags (zone brush, moving the build ghost) are handed to a touch handler installed with setTouchHandler():
//   { claim(x, y) -> bool, claimBegin(x, y), claimMove(x, y), claimEnd(cancelled), tap(x, y), longPress(x, y) }
export function createCameraController(camera, domElement, getGroundHeight, world) {
  let explicitSize = null;
  const worldSize = () => explicitSize || getViewWorldSize() || WORLD_SIZE;
  const distMax = () => (worldSize() > 300 ? DIST_MAX_BIG : DIST_MAX_SMALL);   // big maps can zoom out further
  function setWorld(w) {
    const size = typeof w === 'number' ? w : w && w.size;
    explicitSize = size > 0 ? size : null;
    distGoal = Math.min(distGoal, distMax());
  }
  const target = new THREE.Vector3();
  let yaw = 0.6;
  let dist = 70;
  let distGoal = 70;
  let tilt = 0;          // extra pitch from the two-finger tilt gesture (0 = the zoom-dependent default)
  if (world !== undefined) setWorld(world);
  target.set(worldSize() / 2, getGroundHeight(worldSize() / 2, worldSize() / 2), worldSize() / 2);
  let panLeft = false;
  let drag = null;       // mouse: { mode:'rotate'|'pan', x, y, moved }
  let lastDragMoved = false;
  const keys = new Set();

  // touch state
  let touchHandler = null;
  const touches = new Map();   // pointerId -> { id, x, y, sx, sy }
  let gesture = null;          // { type:'single'|'claim'|'multi'|'dead', ... }
  let inertia = null;          // { vx, vz } in m/s, decays
  let lastGesture = 0;         // gesture counter (diagnostics / tests)

  const basePitch = (d) => {
    const t = clamp((d - DIST_MIN) / (distMax() - DIST_MIN), 0, 1);
    return PITCH_NEAR + (PITCH_FAR - PITCH_NEAR) * t;
  };
  const pitchFor = (d) => clamp(basePitch(d) + tilt, PITCH_MIN, PITCH_MAX);

  // Ground-plane basis for the current yaw.
  const forward = () => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });
  const right = () => ({ x: Math.cos(yaw), z: -Math.sin(yaw) });

  function moveTarget(dx, dz) {
    target.x = clamp(target.x + dx, 0, worldSize());
    target.z = clamp(target.z + dz, 0, worldSize());
  }

  // Where the ray through screen point (cx, cy) meets the horizontal plane through `target`, as an (x, z) offset from
  // `target`, for the CURRENT yaw / pitch / dist (the camera is always looking at `target`). Independent of where
  // `target` is, which is what lets the gestures keep a ground point glued under the fingers. Null above the horizon.
  function groundOffset(cx, cy) {
    const rect = domElement.getBoundingClientRect();
    const w = rect.width || window.innerWidth;
    const h = rect.height || window.innerHeight;
    const nx = ((cx - rect.left) / w) * 2 - 1;
    const ny = -(((cy - rect.top) / h) * 2 - 1);
    const th = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const px = nx * th * (w / h);
    const py = ny * th;
    const pitch = pitchFor(dist);
    const sp = Math.sin(pitch), cp = Math.cos(pitch), sy = Math.sin(yaw), cy_ = Math.cos(yaw);
    const dy = py * cp - sp;
    if (dy > -0.02) return null;
    const dx = px * cy_ - py * sp * sy - sy * cp;
    const dz = -px * sy - py * sp * cy_ - cy_ * cp;
    const t = -dist * sp / dy;
    return { x: dist * sy * cp + t * dx, z: dist * cy_ * cp + t * dz };
  }

  // Run `change()` (which alters yaw / dist / tilt) while keeping the ground point that was under `from` under `to`.
  function anchored(fromX, fromY, toX, toY, change) {
    const o0 = groundOffset(fromX, fromY);
    if (change) change();
    if (!o0) return;
    const gx = target.x + o0.x;
    const gz = target.z + o0.z;
    const o1 = groundOffset(toX, toY);
    if (!o1) return;
    target.x = clamp(gx - o1.x, 0, worldSize());
    target.z = clamp(gz - o1.z, 0, worldSize());
  }
  // NB: `anchored` measures the anchor with the state BEFORE change() but the target offset with the state AFTER it.
  // That is exactly "the ground point under `from` before the gesture step ends up under `to` after it".
  // The anchor is the world point g = target + o0; afterwards target' = g - o1, so g sits at o1 from the target.

  // ---- keyboard / mouse input
  const onKeyDown = (e) => {
    if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'].includes(k)) {
      keys.add(k);
      if (k.startsWith('arrow')) e.preventDefault();
    }
  };
  const onKeyUp = (e) => { keys.delete(e.key.toLowerCase()); };
  const onBlur = () => { keys.clear(); drag = null; cancelTouches(); };

  const onWheel = (e) => {
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 33;
    // Trackpad pinch arrives as a ctrlKey wheel with small deltas: scale it up so the zoom feels 1:1 and smooth.
    distGoal = clamp(distGoal * Math.exp(dy * (e.ctrlKey ? 0.01 : 0.0012)), DIST_MIN, distMax());
  };

  const isMouse = (e) => e.pointerType === 'mouse' || !e.pointerType;

  function capture(e) {
    try { domElement.setPointerCapture(e.pointerId); } catch { /* synthetic / already released pointer */ }
  }

  // Middle button: stop the browser's auto-scroll cursor.
  const onMouseDown = (e) => { if (e.button === 1) e.preventDefault(); };

  function mouseDown(e) {
    if (e.button === 2) drag = { mode: 'rotate', x: e.clientX, y: e.clientY, moved: false };
    else if (e.button === 1) { e.preventDefault(); drag = { mode: 'pan', x: e.clientX, y: e.clientY, moved: false }; }
    else if (e.button === 0 && panLeft) drag = { mode: 'pan', x: e.clientX, y: e.clientY, moved: false, left: true, sx: e.clientX, sy: e.clientY };
    if (e.button === 0) lastDragMoved = false;
    if (drag) capture(e);
  }

  function mouseMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.left && !drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > DRAG_THRESHOLD) {
      drag.moved = true;
      lastDragMoved = true;
    }
    if (drag.mode === 'rotate') {
      yaw -= dx * 0.005;
    } else {
      // Drag the ground under the cursor: ~1 world metre per pixel-ratio at the target.
      const h = domElement.clientHeight || window.innerHeight;
      const perPx = (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / h;
      const f = forward();
      const r = right();
      const kz = perPx / Math.max(0.3, Math.sin(pitchFor(dist)));
      moveTarget(-r.x * dx * perPx + f.x * dy * kz, -r.z * dx * perPx + f.z * dy * kz);
    }
  }

  function mouseUp(e) {
    if (drag && ((e.button === 2 && drag.mode === 'rotate') || (e.button !== 2 && drag.mode === 'pan'))) drag = null;
  }

  // ---- touch / pen input
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function clearGestureTimers() {
    if (!gesture) return;
    if (gesture.longTimer) { clearTimeout(gesture.longTimer); gesture.longTimer = 0; }
    if (gesture.claimTimer) { clearTimeout(gesture.claimTimer); gesture.claimTimer = 0; }
  }

  function endClaim(cancelled) {
    if (!gesture || gesture.type !== 'claim') return;
    clearGestureTimers();
    if (touchHandler && touchHandler.claimEnd) touchHandler.claimEnd(cancelled, gesture.begun);
  }

  function cancelTouches() {
    if (gesture && gesture.type === 'claim') endClaim(true);
    clearGestureTimers();
    touches.clear();
    gesture = null;
  }

  function claimBegin() {
    if (!gesture || gesture.type !== 'claim' || gesture.begun) return;
    gesture.begun = true;
    const t = touches.get(gesture.id);
    if (touchHandler && touchHandler.claimBegin && t) touchHandler.claimBegin(t.x, t.y);
  }

  const firstTwo = () => {
    const it = touches.values();
    const a = it.next().value;
    const b = it.next().value;
    return a && b ? [a, b] : null;
  };

  function startMulti() {
    const two = firstTwo();
    if (!two) return;
    const [a, b] = two;
    clearGestureTimers();
    gesture = {
      type: 'multi',
      a: a.id, b: b.id,
      mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2,
      sep: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
      ang: Math.atan2(b.y - a.y, b.x - a.x),
      sx: (a.x + b.x) / 2, sy: (a.y + b.y) / 2,
      sep0: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
      angTot: 0,
      mode: 'undecided',
    };
    lastGesture++;
  }

  function touchDown(e) {
    capture(e);
    touches.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
    inertia = null;
    if (touches.size === 1) {
      lastGesture++;
      gesture = {
        type: 'single', id: e.pointerId, t0: nowMs(), px: e.clientX, py: e.clientY,
        moved: false, consumed: false, lastMoveT: nowMs(), vx: 0, vz: 0, longTimer: 0, claimTimer: 0,
      };
      if (touchHandler && touchHandler.claim && touchHandler.claim(e.clientX, e.clientY)) {
        gesture.type = 'claim';
        gesture.begun = false;
        gesture.claimTimer = setTimeout(claimBegin, CLAIM_BEGIN_MS);
      } else if (touchHandler && touchHandler.longPress) {
        const id = e.pointerId;
        gesture.longTimer = setTimeout(() => {
          const t = touches.get(id);
          if (!t || !gesture || gesture.type !== 'single' || gesture.moved || gesture.consumed) return;
          gesture.consumed = true;
          touchHandler.longPress(t.x, t.y);
        }, LONG_PRESS_MS);
      }
    } else if (touches.size === 2) {
      if (gesture && gesture.type === 'claim') endClaim(true);
      startMulti();
    }
    // 3+ fingers: the gesture keeps using the first two
  }

  function touchMove(e) {
    const t = touches.get(e.pointerId);
    if (!t || !gesture) return;
    t.x = e.clientX;
    t.y = e.clientY;
    const g = gesture;
    if (g.type === 'single') {
      if (e.pointerId !== g.id) return;
      if (!g.moved) {
        if (Math.hypot(t.x - t.sx, t.y - t.sy) <= TAP_SLOP) return;
        g.moved = true;
        if (g.longTimer) { clearTimeout(g.longTimer); g.longTimer = 0; }
        if (g.consumed) return;
        // start panning from where the finger went down, so the first step has no visible jump
        g.px = t.sx;
        g.py = t.sy;
      }
      if (g.consumed) return;
      const bx = target.x, bz = target.z;
      anchored(g.px, g.py, t.x, t.y, null);
      g.px = t.x;
      g.py = t.y;
      const now = nowMs();
      const dt = Math.max(1, now - g.lastMoveT) / 1000;
      g.lastMoveT = now;
      g.vx = g.vx * 0.5 + ((target.x - bx) / dt) * 0.5;
      g.vz = g.vz * 0.5 + ((target.z - bz) / dt) * 0.5;
    } else if (g.type === 'claim') {
      if (e.pointerId !== g.id) return;
      if (!g.begun && Math.hypot(t.x - t.sx, t.y - t.sy) > CLAIM_BEGIN_PX) claimBegin();
      if (g.begun && touchHandler && touchHandler.claimMove) touchHandler.claimMove(t.x, t.y);
    } else if (g.type === 'multi') {
      if (e.pointerId !== g.a && e.pointerId !== g.b) return;
      const a = touches.get(g.a);
      const b = touches.get(g.b);
      if (!a || !b) return;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const sep = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      let dAng = ang - g.ang;
      if (dAng > Math.PI) dAng -= Math.PI * 2;
      else if (dAng < -Math.PI) dAng += Math.PI * 2;
      g.angTot += dAng;
      if (g.mode === 'undecided') {
        // Decide once: a parallel, mostly vertical two-finger drag tilts; anything else is pinch / twist / pan.
        const mv = Math.hypot(mx - g.sx, my - g.sy);
        const ds = Math.abs(sep - g.sep0);
        const arc = Math.abs(g.angTot) * g.sep0 / 2;
        if (Math.max(mv, ds, arc) >= 9) {
          g.mode = mv > ds * 1.2 && mv > arc * 1.2 && Math.abs(my - g.sy) > Math.abs(mx - g.sx) * 1.4 ? 'tilt' : 'free';
        }
      }
      const tiltMode = g.mode === 'tilt';
      const toY = tiltMode ? g.my : my;   // while tilting, only the horizontal part of the drag pans
      anchored(g.mx, g.my, mx, toY, () => {
        const nd = clamp(dist * (g.sep / sep), DIST_MIN, distMax());
        dist = nd;
        distGoal = nd;
        yaw += dAng;
        if (tiltMode) tilt = clamp(tilt + (my - g.my) * 0.004, TILT_MIN, TILT_MAX);
      });
      g.mx = mx;
      g.my = my;
      g.sep = sep;
      g.ang = ang;
    }
  }

  function touchUp(e, cancelled) {
    const t = touches.get(e.pointerId);
    if (!t) return;
    const g = gesture;
    t.x = e.clientX;
    t.y = e.clientY;
    touches.delete(e.pointerId);
    try { domElement.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (!g) return;
    if (g.type === 'single' && e.pointerId === g.id) {
      clearGestureTimers();
      const dt = nowMs() - g.t0;
      if (!cancelled && !g.moved && !g.consumed && dt <= TAP_MAX_MS) {
        if (touchHandler && touchHandler.tap) touchHandler.tap(t.x, t.y);
      } else if (!cancelled && g.moved && !g.consumed && nowMs() - g.lastMoveT < 90) {
        const sp = Math.hypot(g.vx, g.vz);
        if (sp > 3) inertia = { vx: g.vx, vz: g.vz };
      }
      gesture = null;
    } else if (g.type === 'claim' && e.pointerId === g.id) {
      if (!cancelled && !g.begun) claimBegin();   // a quick tap still counts as a (tiny) drag
      endClaim(cancelled);
      gesture = null;
    } else if (g.type === 'multi') {
      if (e.pointerId === g.a || e.pointerId === g.b) {
        if (touches.size >= 2) startMulti();   // a third finger takes over: no jump
        else gesture = { type: 'dead' };       // ignore the last finger until everybody lifted
      }
    }
    if (touches.size === 0) { gesture = null; }
  }

  // ---- pointer event plumbing
  const onPointerDown = (e) => {
    if (isMouse(e)) mouseDown(e);
    else touchDown(e);
  };
  const onPointerMove = (e) => {
    if (isMouse(e)) mouseMove(e);
    else touchMove(e);
  };
  const onPointerUp = (e) => {
    if (isMouse(e)) mouseUp(e);
    else touchUp(e, false);
  };
  const onPointerCancel = (e) => {
    if (isMouse(e)) { drag = null; return; }
    touchUp(e, true);
  };

  const onContextMenu = (e) => e.preventDefault();

  // Safari: stop the page-level pinch / rotate gestures. On a desktop trackpad (no touch pointers) they drive the
  // camera instead: pinch zooms, twist rotates.
  let gScale = 1;
  let gRot = 0;
  const onGestureStart = (e) => { e.preventDefault(); gScale = 1; gRot = 0; };
  const onGestureChange = (e) => {
    e.preventDefault();
    if (touches.size === 0 && e.scale) {
      distGoal = clamp(distGoal * (gScale / e.scale), DIST_MIN, distMax());
      yaw += THREE.MathUtils.degToRad((e.rotation || 0) - gRot);
    }
    gScale = e.scale || 1;
    gRot = e.rotation || 0;
  };
  const onGestureEnd = (e) => e.preventDefault();
  // Belt and braces against iOS page scroll / bounce / double-tap zoom starting on the canvas.
  const stopTouch = (e) => { if (e.cancelable) e.preventDefault(); };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  domElement.addEventListener('wheel', onWheel, { passive: false });
  domElement.addEventListener('pointerdown', onPointerDown);
  domElement.addEventListener('mousedown', onMouseDown);
  domElement.addEventListener('contextmenu', onContextMenu);
  domElement.addEventListener('touchstart', stopTouch, { passive: false });
  domElement.addEventListener('touchmove', stopTouch, { passive: false });
  document.addEventListener('gesturestart', onGestureStart, { passive: false });
  document.addEventListener('gesturechange', onGestureChange, { passive: false });
  document.addEventListener('gestureend', onGestureEnd, { passive: false });
  domElement.style.touchAction = 'none';

  function update(dt) {
    dt = Math.min(dt, 0.1);
    // rotate
    if (keys.has('q')) yaw -= 1.6 * dt;
    if (keys.has('e')) yaw += 1.6 * dt;
    // pan
    let mx = 0;
    let mz = 0;
    if (keys.has('w') || keys.has('arrowup')) mz += 1;
    if (keys.has('s') || keys.has('arrowdown')) mz -= 1;
    if (keys.has('d') || keys.has('arrowright')) mx += 1;
    if (keys.has('a') || keys.has('arrowleft')) mx -= 1;
    if (mx || mz) {
      const len = Math.hypot(mx, mz);
      const speed = dist * 0.7 * (keys.has('shift') ? 2 : 1) * dt / len;
      const f = forward();
      const r = right();
      moveTarget((f.x * mz + r.x * mx) * speed, (f.z * mz + r.z * mx) * speed);
    }
    // touch flick inertia
    if (inertia) {
      moveTarget(inertia.vx * dt, inertia.vz * dt);
      const k = Math.exp(-3.5 * dt);
      inertia.vx *= k;
      inertia.vz *= k;
      if (Math.hypot(inertia.vx, inertia.vz) < 0.6) inertia = null;
    }
    // smooth zoom
    dist += (distGoal - dist) * Math.min(1, dt * 10);
    // follow ground
    const gy = getGroundHeight(target.x, target.z);
    target.y += (gy - target.y) * Math.min(1, dt * 8);

    const pitch = pitchFor(dist);
    const cp = Math.cos(pitch);
    camera.position.set(
      target.x + Math.sin(yaw) * cp * dist,
      target.y + Math.sin(pitch) * dist,
      target.z + Math.cos(yaw) * cp * dist,
    );
    // never dip below the terrain under the camera
    const floor = getGroundHeight(camera.position.x, camera.position.z) + 2;
    if (camera.position.y < floor) camera.position.y = floor;
    camera.lookAt(target);
  }

  function dispose() {
    cancelTouches();
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    domElement.removeEventListener('wheel', onWheel);
    domElement.removeEventListener('pointerdown', onPointerDown);
    domElement.removeEventListener('mousedown', onMouseDown);
    domElement.removeEventListener('contextmenu', onContextMenu);
    domElement.removeEventListener('touchstart', stopTouch);
    domElement.removeEventListener('touchmove', stopTouch);
    document.removeEventListener('gesturestart', onGestureStart);
    document.removeEventListener('gesturechange', onGestureChange);
    document.removeEventListener('gestureend', onGestureEnd);
  }

  update(0);

  return {
    target,
    update,
    dispose,
    setWorld(w) { setWorld(w); moveTarget(0, 0); },
    setPanWithLeftMouse(v) { panLeft = !!v; },
    setTouchHandler(h) { touchHandler = h || null; },
    // Abort whatever touch gesture is in progress (e.g. when a modal opens).
    cancelTouches,
    // True if the last left-button press turned into a pan drag (so main can ignore the click).
    wasDragged() { return lastDragMoved; },
    get yaw() { return yaw; },
    get dist() { return dist; },
    get pitch() { return pitchFor(dist); },
    get tilt() { return tilt; },
    get touchCount() { return touches.size; },
    get gestureMode() { return gesture ? (gesture.mode ? `${gesture.type}:${gesture.mode}` : gesture.type) : null; },
    get gestureId() { return lastGesture; },
  };
}
