// RTS camera: orbits `target`, pans on the ground plane, zooms by changing distance.
import * as THREE from '../../vendor/three.module.js';
import { WORLD_SIZE, SPAWN } from '../config.js';

const DIST_MIN = 15;
const DIST_MAX = 160;
const PITCH_NEAR = 0.55;
const PITCH_FAR = 1.1;
const DRAG_THRESHOLD = 4; // px before a left-button pan counts as a drag

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function isTyping(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

export function createCameraController(camera, domElement, getGroundHeight) {
  const target = new THREE.Vector3(SPAWN.x, getGroundHeight(SPAWN.x, SPAWN.z), SPAWN.z);
  let yaw = 0.6;
  let dist = 70;
  let distGoal = 70;
  let panLeft = false;
  let drag = null;       // { mode:'rotate'|'pan', x, y, moved }
  let lastDragMoved = false;
  const keys = new Set();

  const pitchFor = (d) => {
    const t = clamp((d - DIST_MIN) / (DIST_MAX - DIST_MIN), 0, 1);
    return PITCH_NEAR + (PITCH_FAR - PITCH_NEAR) * t;
  };

  // Ground-plane basis for the current yaw.
  const forward = () => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });
  const right = () => ({ x: Math.cos(yaw), z: -Math.sin(yaw) });

  function moveTarget(dx, dz) {
    target.x = clamp(target.x + dx, 0, WORLD_SIZE);
    target.z = clamp(target.z + dz, 0, WORLD_SIZE);
  }

  // ---- input handlers
  const onKeyDown = (e) => {
    if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'].includes(k)) {
      keys.add(k);
      if (k.startsWith('arrow')) e.preventDefault();
    }
  };
  const onKeyUp = (e) => { keys.delete(e.key.toLowerCase()); };
  const onBlur = () => { keys.clear(); drag = null; };

  const onWheel = (e) => {
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 33;
    distGoal = clamp(distGoal * Math.exp(dy * 0.0012), DIST_MIN, DIST_MAX);
  };

  const onMouseDown = (e) => {
    if (e.button === 2) drag = { mode: 'rotate', x: e.clientX, y: e.clientY, moved: false };
    else if (e.button === 1) { e.preventDefault(); drag = { mode: 'pan', x: e.clientX, y: e.clientY, moved: false }; }
    else if (e.button === 0 && panLeft) drag = { mode: 'pan', x: e.clientX, y: e.clientY, moved: false, left: true, sx: e.clientX, sy: e.clientY };
    if (e.button === 0) lastDragMoved = false;
  };

  const onMouseMove = (e) => {
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
  };

  const onMouseUp = (e) => {
    if (drag && ((e.button === 2 && drag.mode === 'rotate') || (e.button !== 2 && drag.mode === 'pan'))) drag = null;
  };

  const onContextMenu = (e) => e.preventDefault();

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  domElement.addEventListener('wheel', onWheel, { passive: false });
  domElement.addEventListener('mousedown', onMouseDown);
  domElement.addEventListener('contextmenu', onContextMenu);

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
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    domElement.removeEventListener('wheel', onWheel);
    domElement.removeEventListener('mousedown', onMouseDown);
    domElement.removeEventListener('contextmenu', onContextMenu);
  }

  update(0);

  return {
    target,
    update,
    dispose,
    setPanWithLeftMouse(v) { panLeft = !!v; },
    // True if the last left-button press turned into a pan drag (so main can ignore the click).
    wasDragged() { return lastDragMoved; },
    get yaw() { return yaw; },
    get dist() { return dist; },
  };
}
