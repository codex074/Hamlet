// Player tools: build (ghost), zone brush, demolish, and building selection.
import { BUILDINGS, ZONE_BRUSH, GATHER_RADIUS, FIELD_RADIUS, FISH_RADIUS, HUNT_RADIUS } from '../config.js';
import { makeBuildingModel } from '../render/models.js';

const ROT_STEP = Math.PI / 12; // 15 degrees
const EVAL_INTERVAL = 0.05;    // seconds between re-evaluations while the camera moves
const CLICK_SLOP = 5;          // px

export function toolId(tool) {
  if (!tool) return null;
  if (tool.kind === 'build') return `build:${tool.type}`;
  if (tool.kind === 'zone') return `zone:${tool.zone}`;
  return tool.kind; // 'demolish'
}

export function createTools({ THREE, scene, camera, canvas, getState, sim, hud, terrainHeight, pickGround, worldView, cameraController }) {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const pointer = { has: false, cx: 0, cy: 0 };
  let ground = null;       // {x, z} under the pointer, or null
  let evalTimer = 0;

  let current = null;      // active tool descriptor
  let selectedId = null;   // selected building id (no-tool mode)
  let selectedVid = null;  // selected villager id (no-tool mode)

  // build tool
  let ghost = null;
  let ghostMats = [];
  let ghostValid = null;
  let rot = 0;
  let buildRing = null;

  // zone tool
  let brushR = ZONE_BRUSH.default;
  let zoneRing = null;
  let painting = false;
  let lastPaint = null;

  // demolish tool
  let hoverId = null;

  // territory view
  let terrSig = '';

  // click tracking
  let downInfo = null;     // { x, y, button }

  const COL_OK = new THREE.Color(0x66e070);
  const COL_BAD = new THREE.Color(0xf05a4a);

  // ---------- helpers ----------
  function updateNdc(cx, cy) {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
  }

  function setPointer(e) {
    pointer.has = true;
    pointer.cx = e.clientX;
    pointer.cy = e.clientY;
    updateNdc(e.clientX, e.clientY);
    ground = pickGround(ndc) || null;
  }

  // A ribbon laid on the terrain (follows the height field).
  function makeRing(opacity) {
    const SEGS = 160;
    const pos = new Float32Array((SEGS + 1) * 2 * 3);
    const idx = [];
    for (let i = 0; i < SEGS; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, depthTest: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 20;
    mesh.visible = false;
    scene.add(mesh);
    return {
      mesh,
      setColor(c) { mat.color.copy(c); },
      set(x, z, r, width) {
        const w = width / 2;
        for (let i = 0; i <= SEGS; i++) {
          const a = (i / SEGS) * Math.PI * 2;
          const cs = Math.cos(a), sn = Math.sin(a);
          const x0 = x + cs * (r - w), z0 = z + sn * (r - w);
          const x1 = x + cs * (r + w), z1 = z + sn * (r + w);
          const o = i * 6;
          pos[o] = x0; pos[o + 1] = terrainHeight(x0, z0) + 0.3; pos[o + 2] = z0;
          pos[o + 3] = x1; pos[o + 4] = terrainHeight(x1, z1) + 0.3; pos[o + 5] = z1;
        }
        geo.attributes.position.needsUpdate = true;
        mesh.visible = true;
      },
      hide() { mesh.visible = false; },
      dispose() { scene.remove(mesh); geo.dispose(); mat.dispose(); },
    };
  }

  function disposeGhost() {
    if (ghost) scene.remove(ghost);
    for (const m of ghostMats) m.dispose();
    ghost = null;
    ghostMats = [];
    ghostValid = null;
  }

  function createGhost(type) {
    const model = type === 'cathedral' ? makeBuildingModel(type, { stage: 4 }) : makeBuildingModel(type);
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = false;
      o.receiveShadow = false;
      const wasArray = Array.isArray(o.material);
      const mats = (wasArray ? o.material : [o.material]).map((m) => {
        const c = m.clone();
        c.transparent = true;
        c.opacity = 0.55;
        c.depthWrite = false;
        c.userData.baseColor = c.color ? c.color.clone() : null;
        ghostMats.push(c);
        return c;
      });
      o.material = wasArray ? mats : mats[0];
    });
    model.visible = false;
    scene.add(model);
    ghost = model;
  }

  function tintGhost(valid) {
    if (valid === ghostValid) return;
    ghostValid = valid;
    const tint = valid ? COL_OK : COL_BAD;
    for (const m of ghostMats) {
      if (m.userData.baseColor) m.color.copy(m.userData.baseColor).lerp(tint, 0.6);
      if (m.emissive) { m.emissive.copy(tint).multiplyScalar(0.25); m.emissiveIntensity = 1; }
    }
  }

  function buildRingRadius(type) {
    const d = BUILDINGS[type];
    if (!d) return 0;
    if (d.serviceRadius) return d.serviceRadius;   // service, doctor, market
    if (d.job === 'gather') return GATHER_RADIUS;
    if (d.job === 'farm') return FIELD_RADIUS;
    if (d.job === 'fish') return FISH_RADIUS;
    if (d.job === 'hunt') return HUNT_RADIUS;
    return 0;
  }

  function clearSelection() {
    selectedId = null;
    selectedVid = null;
    worldView.setHighlight(null);
    worldView.setHighlightVillager?.(null);
    hud.showInfo(null, getState());
  }

  function selectBuilding(id) {
    const state = getState();
    const b = id == null ? null : state.buildings.find((bb) => bb.id === id);
    if (!b) return;
    selectedVid = null;
    worldView.setHighlightVillager?.(null);
    selectedId = b.id;
    worldView.setHighlight(b.id);
    hud.showInfo(b, state);
  }

  function selectVillager(id) {
    const state = getState();
    if (id == null || !state.villagers.some((v) => v.id === id)) return;
    selectedId = null;
    worldView.setHighlight(null);
    selectedVid = id;
    worldView.setHighlightVillager?.(id);
    hud.showVillager?.(id);
  }

  // Villager under the pointer: world ray pick, else nearest to the ground point.
  function pickVillagerId(state) {
    if (typeof worldView.pickVillager === 'function') {
      const id = worldView.pickVillager(raycaster);
      return id == null ? null : id;
    }
    if (ground && typeof sim.villagerAt === 'function') {
      const v = sim.villagerAt(state, ground.x, ground.z, 1.5);
      return v ? v.id : null;
    }
    return null;
  }

  // ---------- tool lifecycle ----------
  function cleanupCurrent() {
    disposeGhost();
    if (buildRing) { buildRing.dispose(); buildRing = null; }
    if (zoneRing) { zoneRing.dispose(); zoneRing = null; }
    painting = false;
    lastPaint = null;
    hoverId = null;
    worldView.setHighlight(null);
    if (current && current.kind === 'territory') setTerritory(false);
    if (hud.hidePlotCard) hud.hidePlotCard();
  }

  // ---------- territory view ----------
  const territoryOk = () => typeof sim.plotInfo === 'function' && typeof worldView.setTerritoryView === 'function';
  const signature = (state) => (state.territory ? `${state.territory.bought}|${(state.territory.owned || []).join('')}` : '');

  function setTerritory(on) {
    if (typeof worldView.setTerritoryView !== 'function') return;
    const state = getState();
    try {
      worldView.setTerritoryView(on, on && typeof sim.plotInfo === 'function' ? sim.plotInfo(state) : null);
    } catch (err) {
      console.error(err);
    }
    terrSig = on ? signature(state) : '';
  }

  function plotAt(state, g) {
    if (!g || typeof sim.plotInfo !== 'function') return null;
    return sim.plotInfo(state).find((p) => g.x >= p.x0 && g.x < p.x1 && g.z >= p.z0 && g.z < p.z1) || null;
  }

  function territoryClick(e) {
    const state = getState();
    const p = plotAt(state, ground);
    if (!p) { if (hud.hidePlotCard) hud.hidePlotCard(); return; }
    if (p.owned) {
      if (hud.hidePlotCard) hud.hidePlotCard();
      hud.toast('แปลงนี้เป็นของคุณแล้ว');
      return;
    }
    if (!p.buyable) {
      if (hud.hidePlotCard) hud.hidePlotCard();
      hud.toast('ซื้อได้เฉพาะแปลงที่ติดกับดินแดนของคุณ');
      return;
    }
    if (!hud.showPlotCard) return;
    hud.showPlotCard(p, { x: e.clientX, y: e.clientY }, state.gold, () => {
      const r = sim.buyPlot(state, p.px, p.pz);
      if (r && r.ok) {
        hud.toast('🗺️ ซื้อดินแดนใหม่แล้ว');
        setTerritory(true);   // redraw: new owner, next prices, new buyable plots
      } else {
        hud.toast((r && r.reason) || 'ซื้อแปลงนี้ไม่ได้');
      }
    });
  }

  function select(tool) {
    cleanupCurrent();
    current = tool || null;
    cameraController.setPanWithLeftMouse(!current || current.kind === 'territory');
    if (current && current.kind === 'territory' && !territoryOk()) {
      current = null;
      cameraController.setPanWithLeftMouse(true);
      hud.toast('ยังไม่รองรับระบบดินแดน');
    }
    if (current) {
      if (selectedId != null || selectedVid != null) clearSelection();
      if (current.kind === 'build') {
        createGhost(current.type);
        const r = buildRingRadius(current.type);
        if (r > 0) {
          buildRing = makeRing(0.55);
          buildRing.setColor(new THREE.Color(0xffe9a0));
        }
      } else if (current.kind === 'zone') {
        zoneRing = makeRing(0.7);
      } else if (current.kind === 'territory') {
        setTerritory(true);
      }
    }
    hud.setActiveTool(toolId(current));
    evaluate();
  }

  // ---------- per-tool evaluation (pointer or camera moved) ----------
  function evaluate() {
    if (!current || !pointer.has) return;
    const state = getState();
    if (current.kind === 'build') {
      if (!ground || !ghost) {
        if (ghost) ghost.visible = false;
        if (buildRing) buildRing.hide();
        return;
      }
      const { x, z } = ground;
      ghost.visible = true;
      ghost.position.set(x, terrainHeight(x, z), z);
      ghost.rotation.y = rot;
      const res = sim.canPlace(state, current.type, x, z, rot);
      tintGhost(!!(res && res.ok));
      if (buildRing) {
        const r = buildRingRadius(current.type);
        buildRing.set(x, z, r, Math.max(0.5, r * 0.012));
      }
    } else if (current.kind === 'zone') {
      if (!ground) { zoneRing.hide(); return; }
      const res = sim.canPaintZone(state, current.zone, ground.x, ground.z, brushR);
      zoneRing.setColor(res && res.ok ? COL_OK : COL_BAD);
      zoneRing.set(ground.x, ground.z, brushR, 0.5);
      if (painting) paintStep(ground.x, ground.z, false);
    } else if (current.kind === 'demolish') {
      const id = pickBuildingId();
      if (id !== hoverId) { hoverId = id; worldView.setHighlight(id); }
    }
  }

  function pickBuildingId() {
    updateNdc(pointer.cx, pointer.cy);
    const id = worldView.pickBuilding(raycaster);
    return id == null ? null : id;
  }

  function paintStep(x, z, first) {
    const state = getState();
    if (!first && lastPaint) {
      const d = Math.hypot(x - lastPaint.x, z - lastPaint.z);
      if (d < brushR * 0.6) return;
    }
    const res = sim.canPaintZone(state, current.zone, x, z, brushR);
    if (res && res.ok) {
      sim.paintZone(state, current.zone, x, z, brushR);
      lastPaint = { x, z };
    } else if (first && res && res.reason) {
      hud.toast(res.reason);
    }
  }

  // ---------- events ----------
  function onPointerMove(e) {
    setPointer(e);
    if (downInfo && downInfo.button === 0 && !downInfo.moved) {
      if (Math.hypot(e.clientX - downInfo.x, e.clientY - downInfo.y) >= CLICK_SLOP) downInfo.moved = true;
    }
    if (downInfo && downInfo.button === 2 && !downInfo.moved) {
      if (Math.hypot(e.clientX - downInfo.x, e.clientY - downInfo.y) >= CLICK_SLOP) downInfo.moved = true;
    }
    evalTimer = 0;
    evaluate();
  }

  function onPointerLeave() {
    if (painting) return;
    pointer.has = false;
    ground = null;
    if (ghost) ghost.visible = false;
    if (buildRing) buildRing.hide();
    if (zoneRing) zoneRing.hide();
    if (hoverId != null) { hoverId = null; worldView.setHighlight(null); }
  }

  function onPointerDown(e) {
    setPointer(e);
    downInfo = { x: e.clientX, y: e.clientY, button: e.button, moved: false };
    if (e.button !== 0 || !current) return;
    const state = getState();

    if (current.kind === 'build') {
      if (!ground) return;
      const { x, z } = ground;
      const check = sim.canPlace(state, current.type, x, z, rot);
      if (!check || !check.ok) {
        hud.toast((check && check.reason) || 'วางตรงนี้ไม่ได้');
        return;
      }
      const id = sim.placeBuilding(state, current.type, x, z, rot);
      if (id == null) hud.toast('วางอาคารไม่สำเร็จ (วัสดุหรือทองไม่พอ)');
      evaluate();
    } else if (current.kind === 'zone') {
      if (!ground) return;
      painting = true;
      lastPaint = null;
      paintStep(ground.x, ground.z, true);
    } else if (current.kind === 'demolish') {
      let target = null;
      const id = pickBuildingId();
      if (id != null) {
        const b = state.buildings.find((bb) => bb.id === id);
        if (b) target = { x: b.x, z: b.z };
      }
      if (!target && ground) target = ground;
      if (!target) return;
      const ok = sim.removeAt(state, target.x, target.z);
      hud.toast(ok ? 'รื้อถอนแล้ว (คืนวัสดุ 50%)' : 'ไม่มีอะไรให้รื้อตรงนี้');
      hoverId = null;
      worldView.setHighlight(null);
      evaluate();
    }
  }

  function onPointerUp(e) {
    const d = downInfo;
    downInfo = null;
    if (e.button === 0) painting = false;
    if (!d || d.button !== e.button) return;
    const isClick = !d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < CLICK_SLOP;

    if (e.button === 2) {
      // right-click without dragging cancels the tool
      if (isClick && current) select(null);
      return;
    }
    if (e.button === 0 && current && current.kind === 'territory' && isClick) {
      setPointer(e);
      territoryClick(e);
      return;
    }
    if (e.button === 0 && !current && isClick) {
      setPointer(e);
      const state = getState();
      const vid = pickVillagerId(state);
      if (vid != null) { selectVillager(vid); return; }
      const id = worldView.pickBuilding(raycaster);
      const b = id == null ? null : state.buildings.find((bb) => bb.id === id);
      if (b) {
        selectBuilding(b.id);
      } else if (selectedId != null || selectedVid != null) {
        clearSelection();
      }
    }
  }

  function onKey(e) {
    switch (e.code) {
      case 'Escape':
        if (current) { select(null); return true; }
        if (selectedId != null || selectedVid != null) { clearSelection(); return true; }
        return false;
      case 'KeyR':
        if (current && current.kind === 'build') {
          rot = (rot + ROT_STEP) % (Math.PI * 2);
          evaluate();
          return true;
        }
        return false;
      case 'BracketLeft':
      case 'BracketRight':
        if (current && current.kind === 'zone') {
          const dir = e.code === 'BracketRight' ? 1 : -1;
          brushR = Math.max(ZONE_BRUSH.min, Math.min(ZONE_BRUSH.max, brushR + dir));
          evaluate();
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  // Shift+wheel rotates the ghost; returns true when the event was consumed.
  function onWheel(e) {
    if (!(current && current.kind === 'build' && e.shiftKey)) return false;
    const delta = e.deltaY || e.deltaX;
    if (!delta) return true;
    rot = (rot + (delta > 0 ? ROT_STEP : -ROT_STEP) + Math.PI * 2) % (Math.PI * 2);
    evaluate();
    return true;
  }

  function update(dt) {
    const state = getState();
    if (current && current.kind === 'territory' && signature(state) !== terrSig) setTerritory(true);
    if (selectedId != null && !state.buildings.some((b) => b.id === selectedId)) {
      selectedId = null;
      worldView.setHighlight(null);
      hud.showInfo(null, state);
    }
    if (selectedVid != null && !state.villagers.some((v) => v.id === selectedVid)) {
      selectedVid = null;
      worldView.setHighlightVillager?.(null);
      hud.showInfo(null, state);
    }
    if (!current || !pointer.has) return;
    evalTimer += dt;
    if (evalTimer >= EVAL_INTERVAL) {
      evalTimer = 0;
      updateNdc(pointer.cx, pointer.cy);
      ground = pickGround(ndc) || null;
      evaluate();
    }
  }

  select(null);

  return {
    get current() { return current; },
    select,
    update,
    onPointerMove,
    onPointerDown,
    onPointerUp,
    onPointerLeave,
    onKey,
    onWheel,
    selectBuilding,
    selectVillager,
    deselect() {
      if (selectedId != null) { selectedId = null; worldView.setHighlight(null); }
      if (selectedVid != null) { selectedVid = null; worldView.setHighlightVillager?.(null); }
    },
  };
}
