// Hamlet entry point: boots the world, wires sim <-> render <-> UI, runs the game loop.
import * as THREE from '../vendor/three.module.js';
import { createScene } from './render/scene.js';
import { createCameraController } from './render/camera.js';
import { createTerrainMesh } from './render/terrainMesh.js';
import { createWorldView } from './render/world.js';
import * as sim from './sim.js';
import { saveGame, loadGame, clearSave, deserialize } from './save.js';
import { startSession } from './net/session.js';
import { heightAt } from './terrain.js';
import { SPAWN } from './config.js';
import { createHUD } from './ui/hud.js';
import { createTools } from './ui/tools.js';
import { createTouchControls } from './ui/touch.js';
import { GUIDE } from './ui/guide.js';
import { createSettingsPanel } from './ui/settings.js';
import { localWorldScreen } from './ui/screens.js';

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

const DIFFICULTIES = ['easy', 'normal', 'hard'];
const randomSeed = () => Math.floor(Math.random() * 2147483646) + 1;

// New world: settings go to createWorld(seed, settings) (older sims ignore the extra argument).
// The initial difficulty is part of the form's settings but lives on state.difficulty.
function createNewWorld(seed, settings) {
  const st = settings && typeof settings === 'object' ? settings : null;
  const state = sim.createWorld(seed, st || undefined);
  if (st && DIFFICULTIES.includes(st.difficulty)) state.difficulty = st.difficulty;
  return state;
}

function boot(session) {
  const cloud = session.mode === 'cloud';
  if (cloud) document.body.classList.add('cloud');
  if (loadingEl) loadingEl.textContent = 'กำลังสร้างหมู่บ้าน…';

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
  let state = null;
  if (cloud) {
    try {
      // village.settings === null: village made before world settings existed -> small map defaults
      state = session.initialSave
        ? deserialize(session.initialSave)
        : createNewWorld(Number(session.village.seed) || (session.village.id * 7919 + 1), session.village.settings || { mapSize: 'small' });
    } catch (err) {
      console.error(err);
      showFatal(`โหลดหมู่บ้านไม่สำเร็จ: ${err.message || err}`);
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'btn primary';
      back.style.marginLeft = '12px';
      back.textContent = 'กลับไปเลือกหมู่บ้าน';
      back.addEventListener('click', () => session.backToSelect());
      loadingEl.appendChild(back);
      return;
    }
  } else {
    state = loadGame();
    if (!state) {
      const w = session.newWorld || {};
      state = createNewWorld(w.seed || randomSeed(), w.settings || null);
    }
  }

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
  const saver = cloud ? session.saver : null;
  function save() {
    if (skipSave) return Promise.resolve(false);
    if (saver) return saver.save(state);
    saveGame(state);
    return Promise.resolve(true);
  }
  // Cloud: save, then leave. Stays in the game (with a toast) if the server could not be reached.
  async function leaveVillage(after) {
    const ok = await save();
    if (!ok) {
      hud.toast('บันทึกไม่สำเร็จ — ยังไม่ออกจากหมู่บ้าน ลองใหม่อีกครั้ง');
      return;
    }
    skipSave = true;
    after();
  }

  let tools = null;
  let settingsPanel = null;
  const handlers = {
    selectTool: (t) => tools && tools.select(t),
    setSpeed,
    setWorkers: (id, n) => sim.setDesiredWorkers(state, id, n),
    requestUpgrade: (id) => (typeof sim.requestUpgrade === 'function' ? sim.requestUpgrade(state, id) : { ok: false, reason: 'ยังอัปเกรดไม่ได้' }),
    setAutoUpgrade: (id, on) => { if (typeof sim.setAutoUpgrade === 'function') sim.setAutoUpgrade(state, id, on); },
    closeInfo: () => tools && tools.deselect(),
    selectVillager: (id) => tools && tools.selectVillager(id),
    selectBuilding: (id) => tools && tools.selectBuilding(id),
    saveGame: () => { save(); },
    newGame: () => {
      skipSave = true;
      clearSave();
      location.reload();
    },
    showHelp: () => showHelp(false),
    showSettings: () => settingsPanel && settingsPanel.open(),
    cloud,
    backToSelect: () => leaveVillage(() => session.backToSelect()),
    logout: () => leaveVillage(() => session.logout()),
  };

  hud = createHUD(document.body, handlers);
  tools = createTools({
    THREE, scene, camera, canvas,
    getState: () => state,
    sim, hud, terrainHeight, pickGround, worldView, cameraController,
  });
  createTouchControls({ root: document.body, tools });
  hud.setSpeedDisplay(speed);
  settingsPanel = createSettingsPanel({
    root: document.body,
    getState: () => state,
    setDifficulty: (level) => (typeof sim.setDifficulty === 'function' ? sim.setDifficulty(state, level) : { ok: false, reason: 'ยังเปลี่ยนความยากไม่ได้' }),
    toast: (t) => hud.toast(t),
  });
  if (saver) saver.setStatusListener((s) => hud.setSaveStatus(s.kind, s.text));

  // ---------- input ----------
  function isTyping(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  // Camera gestures (pan / pinch / twist / tilt) and touch taps are handled by the camera controller on pointer events;
  // these listeners are the mouse path (hover ghost, click to place / select).
  canvas.addEventListener('pointermove', (e) => tools.onPointerMove(e));
  canvas.addEventListener('pointerdown', (e) => tools.onPointerDown(e));
  canvas.addEventListener('pointerleave', (e) => tools.onPointerLeave(e));
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

  // ---------- one tab per village ----------
  // If the same village is opened in another tab, this (older) tab stops saving so it can't overwrite it.
  const villageKey = cloud ? `cloud:${session.village.id}` : 'local';
  try {
    const channel = new BroadcastChannel('hamlet-tabs');
    channel.onmessage = (e) => {
      if (e.data && e.data.type === 'opened' && e.data.village === villageKey && !skipSave) {
        skipSave = true;
        setSpeed(0);
        showTakenOver();
      }
    };
    channel.postMessage({ type: 'opened', village: villageKey });
  } catch { /* BroadcastChannel unavailable: nothing to coordinate */ }
  function showTakenOver() {
    const back = document.createElement('div');
    back.className = 'backdrop';
    back.innerHTML = `<div class="modal-box"><h2>หมู่บ้านนี้เปิดอยู่ในแท็บอื่น</h2>
      <p>แท็บนี้หยุดเล่นและหยุดบันทึกแล้ว เพื่อไม่ให้เซฟทับกัน เล่นต่อในแท็บใหม่ได้เลย</p>
      <div class="modal-actions"><button class="btn primary" type="button">โหลดหน้านี้ใหม่</button></div></div>`;
    back.querySelector('button').addEventListener('click', () => location.reload());
    document.body.appendChild(back);
  }

  // ---------- autosave ----------
  setInterval(save, 30000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
  window.addEventListener('beforeunload', () => {
    if (skipSave) return;
    if (saver) saver.saveOnExit(state);
    else saveGame(state);
  });
  if (saver && (!session.initialSave || session.dirty)) setTimeout(save, 3000);

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
      <div class="modal-box guide">
        <h2>วิธีเล่น Hamlet</h2>
        <div class="guide-body">
          <nav class="guide-tabs">${GUIDE.map((g) => `<button type="button" data-id="${g.id}">${g.title}</button>`).join('')}</nav>
          <section class="guide-page"></section>
        </div>
        <div class="modal-actions"><button class="btn primary close" type="button">${firstRun ? 'เริ่มเล่น' : 'ปิด'}</button></div>
      </div>`;
    const page = back.querySelector('.guide-page');
    const tabs = back.querySelectorAll('.guide-tabs button');
    const open = (id) => {
      const g = GUIDE.find((x) => x.id === id) || GUIDE[0];
      page.innerHTML = g.html;
      page.scrollTop = 0;
      tabs.forEach((t) => t.classList.toggle('active', t.dataset.id === g.id));
    };
    tabs.forEach((t) => t.addEventListener('click', () => open(t.dataset.id)));
    open('start');
    const close = () => {
      back.remove();
      window.removeEventListener('keydown', onKey, true);
      helpOpen = false;
      markHelpSeen();
      if (firstRun && speed === 0) setSpeed(resumeSpeed || 1);
    };
    const onKey = (e) => { if (e.code === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('keydown', onKey, true);
    back.querySelector('.close').addEventListener('click', close);
    back.addEventListener('click', (e) => { if (e.target === back) close(); });
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

async function start() {
  if (!webglAvailable()) {
    showFatal('ไม่สามารถเปิด WebGL ได้ — กรุณาใช้ Safari หรือ Chrome รุ่นใหม่ และเปิดใช้การเร่งความเร็วด้วยฮาร์ดแวร์');
    return;
  }
  let session;
  try {
    session = await startSession();
  } catch (err) {
    console.error(err);
    session = { mode: 'local' };
  }
  if (session.mode === 'local' && !loadGame()) {
    // first run (or after "เกมใหม่"): choose the world before it is generated
    if (loadingEl) loadingEl.hidden = true;
    try {
      session.newWorld = await localWorldScreen();
    } catch (err) {
      console.error(err);
    }
    if (loadingEl) loadingEl.hidden = false;
  }
  boot(session);
}

start();
