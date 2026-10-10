// Hamlet entry point: boots the world, wires sim <-> render <-> UI, runs the game loop.
import * as THREE from '../vendor/three.module.js';
import { createScene } from './render/scene.js';
import { createCameraController } from './render/camera.js';
import { createTerrainMesh } from './render/terrainMesh.js';
import { createWorldView } from './render/world.js';
import * as sim from './sim.js';
import { saveGame, loadGame, clearSave } from './save.js';
import { heightAt } from './terrain.js';
import { SPAWN } from './config.js';
import { createHUD } from './ui/hud.js';
import { createTools } from './ui/tools.js';

const loadingEl = document.getElementById('loading');
const canvas = document.getElementById('game');

function showFatal(message) {
  if (!loadingEl) return;
  loadingEl.classList.add('fatal');
  loadingEl.hidden = false;
  loadingEl.style.display = 'flex';
  loadingEl.textContent = message;
}

let firstFrameDone = false;
window.addEventListener('error', (e) => {
  if (!firstFrameDone) showFatal(`เกิดข้อผิดพลาดระหว่างเริ่มเกม: ${e.message || e}`);
});
window.addEventListener('unhandledrejection', (e) => {
  if (!firstFrameDone) showFatal(`เกิดข้อผิดพลาดระหว่างเริ่มเกม: ${(e.reason && e.reason.message) || e.reason}`);
});

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch (e) {
    return false;
  }
}

function boot() {
  if (!webglAvailable()) {
    showFatal('ไม่สามารถเปิด WebGL ได้ — กรุณาใช้ Safari หรือ Chrome รุ่นใหม่ และเปิดใช้การเร่งความเร็วด้วยฮาร์ดแวร์');
    return;
  }

  let sceneApi;
  try {
    sceneApi = createScene(canvas);
  } catch (err) {
    showFatal('ไม่สามารถสร้างฉาก 3 มิติได้ — เบราว์เซอร์ของคุณอาจไม่รองรับ WebGL');
    console.error(err);
    return;
  }
  const { renderer, scene, camera } = sceneApi;

  // ---------- world ----------
  let state = loadGame();
  if (!state) state = sim.createWorld(Math.floor(Math.random() * 2147483647) + 1);

  const terrainView = createTerrainMesh(state.terrain);
  scene.add(terrainView.mesh);
  if (terrainView.water) scene.add(terrainView.water);
  const worldView = createWorldView(scene, state.terrain);

  const terrainHeight = (x, z) => heightAt(state.terrain, x, z);
  const cameraController = createCameraController(camera, canvas, terrainHeight);
  const townhall = state.buildings.find((b) => b.type === 'townhall');
  const home = townhall || SPAWN;
  cameraController.target.set(home.x, terrainHeight(home.x, home.z), home.z);

  // ---------- picking ----------
  const groundRay = new THREE.Raycaster();
  function pickGround(ndc) {
    groundRay.setFromCamera(ndc, camera);
    const hit = groundRay.intersectObject(terrainView.mesh, false)[0];
    return hit ? { x: hit.point.x, z: hit.point.z } : null;
  }

  // ---------- speed ----------
  let speed = 1;
  let prevSpeed = 1;
  let hud = null;
  function setSpeed(n) {
    if (n > 0) prevSpeed = n;
    speed = n;
    if (hud) hud.setSpeedDisplay(n);
  }
  function togglePause() {
    setSpeed(speed > 0 ? 0 : prevSpeed || 1);
  }

  // ---------- saving ----------
  let skipSave = false;
  function save() {
    if (!skipSave) saveGame(state);
  }

  let tools = null;
  const handlers = {
    selectTool: (t) => tools && tools.select(t),
    setSpeed,
    setWorkers: (id, n) => sim.setDesiredWorkers(state, id, n),
    closeInfo: () => tools && tools.deselect(),
    saveGame: save,
    newGame: () => {
      skipSave = true;
      clearSave();
      location.reload();
    },
    showHelp: () => showHelp(false),
  };

  hud = createHUD(document.body, handlers);
  tools = createTools({
    THREE, scene, camera, canvas,
    getState: () => state,
    sim, hud, terrainHeight, pickGround, worldView, cameraController,
  });
  hud.setSpeedDisplay(speed);

  // ---------- input ----------
  function isTyping(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  canvas.addEventListener('pointermove', (e) => tools.onPointerMove(e));
  canvas.addEventListener('pointerdown', (e) => tools.onPointerDown(e));
  canvas.addEventListener('pointerleave', () => tools.onPointerLeave());
  window.addEventListener('pointerup', (e) => tools.onPointerUp(e));
  // capture phase so Shift+wheel rotation preempts the camera's zoom handler
  window.addEventListener('wheel', (e) => {
    if (e.target === canvas && tools.onWheel(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, { passive: false, capture: true });

  window.addEventListener('keydown', (e) => {
    if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (tools.onKey(e)) { e.preventDefault(); return; }
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
        if (!e.repeat) togglePause();
        break;
      case 'Digit1': case 'Numpad1': setSpeed(1); break;
      case 'Digit2': case 'Numpad2': setSpeed(2); break;
      case 'Digit3': case 'Numpad3': setSpeed(3); break;
      default: break;
    }
  });

  window.addEventListener('resize', () => sceneApi.resize());
  sceneApi.resize();

  // ---------- autosave ----------
  setInterval(save, 30000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
  window.addEventListener('beforeunload', save);

  // ---------- help card ----------
  function helpSeen() {
    try { return !!localStorage.getItem('hamlet-help-seen'); } catch (e) { return false; }
  }
  function markHelpSeen() {
    try { localStorage.setItem('hamlet-help-seen', '1'); } catch (e) { /* ignore */ }
  }
  let helpOpen = false;
  function showHelp(firstRun) {
    if (helpOpen) return;
    helpOpen = true;
    const resumeSpeed = speed;
    if (firstRun) setSpeed(0);
    const back = document.createElement('div');
    back.className = 'backdrop';
    back.innerHTML = `
      <div class="modal-box">
        <h2>ยินดีต้อนรับสู่ Hamlet</h2>
        <p>สร้างหมู่บ้านยุคกลางของคุณให้เติบโต</p>
        <h3>การควบคุม</h3>
        <div class="ctrls">
          <b>เลื่อน</b><span>WASD / ลากเมาส์ซ้าย</span>
          <b>หมุน</b><span>Q/E / คลิกขวาลาก</span>
          <b>ซูม</b><span>ล้อเมาส์</span>
          <b>หมุนอาคาร</b><span>R</span>
          <b>ยกเลิก</b><span>Esc</span>
          <b>หยุด</b><span>Space</span>
        </div>
        <h3>เป้าหมาย</h3>
        <ol>
          <li>ระบายโซนที่อยู่อาศัย</li>
          <li>สร้างคนตัดไม้ / คนเก็บของป่า</li>
          <li>ทำให้ชาวบ้านมีความสุขเพื่อให้หมู่บ้านเติบโต</li>
        </ol>
        <div class="modal-actions"><button class="btn primary" type="button">เริ่มเล่น</button></div>
      </div>`;
    const btn = back.querySelector('button');
    btn.addEventListener('click', () => {
      back.remove();
      helpOpen = false;
      markHelpSeen();
      if (firstRun && speed === 0) setSpeed(resumeSpeed || 1);
    });
    document.body.appendChild(back);
  }
  if (!helpSeen()) showHelp(true);

  // ---------- main loop ----------
  let last = performance.now();
  let wearTimer = 0;

  function frame(now) {
    requestAnimationFrame(frame);
    const realDt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;

    if (speed > 0) sim.tick(state, realDt * speed);
    cameraController.update(realDt);
    worldView.sync(state, realDt);

    wearTimer += realDt;
    if (wearTimer >= 1) {
      wearTimer = 0;
      terrainView.updateWear(state.wear, state.zones);
    }

    const c = sim.clock(state);
    sceneApi.setTimeOfDay(c.hour + c.minute / 60);
    worldView.setNight(c.isNight);
    sceneApi.sunFollow(cameraController.target);

    tools.update(realDt);
    hud.update(sim.summary(state), state);

    renderer.render(scene, camera);

    if (!firstFrameDone) {
      firstFrameDone = true;
      if (loadingEl) loadingEl.remove();
    }
  }
  terrainView.updateWear(state.wear, state.zones);
  requestAnimationFrame(frame);
}

boot();
