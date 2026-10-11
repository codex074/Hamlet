// Seasons and weather on screen: falling rain / snow around the view, and a shared shader patch on the
// lit materials (terrain, nature, buildings) that whitens upward-facing surfaces under snow, darkens them
// when wet, turns greens gold in autumn and dull in winter. Villagers and animals opt out
// (material.userData.noWeather). The sky's overcast amount is handed to scene.js via setOvercast().
import * as THREE from '../../vendor/three.module.js';
import { heightAt } from '../terrain.js';
import { seasonOf, weatherAt } from '../seasons.js';
import { getGraphics, onGraphicsChange } from './graphics.js';

const BOX = 80;            // width of the precipitation box around the view target
const TOP = 34;            // particles spawn this high above the ground
const RAIN_SPEED = 26;
const SNOW_SPEED = 2.4;
const DROP_LEN = 0.9;
const WIND = new THREE.Vector2(0.35, 0.15);   // slant of rain, drift of snow (per metre fallen)
const COUNTS = { rain: { on: 2200, off: 700 }, snow: { on: 2600, off: 900 } };

// Shared uniforms for every patched material.
const U = {
  uSnow: { value: 0 }, uWet: { value: 0 }, uAutumn: { value: 0 }, uDull: { value: 0 },
};

const PATCH = `
{
  vec3 upV = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
  float up = dot( normal, upV );
  float green = clamp( ( diffuseColor.g - max( diffuseColor.r, diffuseColor.b ) ) * 6.0, 0.0, 1.0 );
  vec3 gold = vec3( diffuseColor.g * 1.32 + 0.04, diffuseColor.g * 0.8, diffuseColor.b * 0.45 );
  diffuseColor.rgb = mix( diffuseColor.rgb, gold, green * uAutumn * 0.75 );
  float lum = dot( diffuseColor.rgb, vec3( 0.3, 0.5, 0.2 ) );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( lum * 1.02, lum * 0.97, lum * 0.86 ), green * uDull );
  diffuseColor.rgb *= 1.0 - 0.24 * uWet;
  float s = smoothstep( 0.42, 0.82, up ) * uSnow;
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.9, 0.93, 0.98 ), s );
}
#include <emissivemap_fragment>`;

const patched = new WeakSet();

function patchMaterial(m) {
  if (patched.has(m)) return;
  patched.add(m);
  if (m.userData.noWeather || m.transparent) return;
  if (!(m.isMeshLambertMaterial || m.isMeshStandardMaterial)) return;
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey();   // keep materials with different patches on different programs
  m.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(m, shader, renderer);
    Object.assign(shader.uniforms, U);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uSnow; uniform float uWet; uniform float uAutumn; uniform float uDull;')
      .replace('#include <emissivemap_fragment>', PATCH);
  };
  m.customProgramCacheKey = () => `${prevKey}|wx`;
  m.needsUpdate = true;
}

function snowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.8)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const approach = (cur, target, rate, dt) => cur + (target - cur) * Math.min(1, rate * dt);

// Season colour targets: gold leaves through autumn, dull and bare through winter, green again in spring.
function seasonTargets(state) {
  const s = seasonOf(state);
  const p = s.progress;
  const autumn = s.key === 'autumn' ? Math.min(1, p * 6) : s.key === 'winter' ? Math.max(0, 1 - p * 3) : 0;
  const dull = s.key === 'winter' ? Math.min(1, p * 3) * 0.75 : s.key === 'spring' ? Math.max(0, 1 - p * 4) * 0.75 : 0;
  return { autumn, dull };
}

// sceneApi: from createScene (scene, setOvercast). terrain: for ground heights.
export function createWeatherView(sceneApi, terrain) {
  const { scene } = sceneApi;
  const view = scene.userData.view;
  const root = new THREE.Group();
  root.name = 'weather';
  scene.add(root);

  let effects = getGraphics().effects !== false;
  const offGfx = onGraphicsChange((g) => { effects = g.effects !== false; });

  // ---- rain: short line segments
  const rainN = COUNTS.rain.on;
  const rainPos = new Float32Array(rainN * 6);
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3).setUsage(THREE.DynamicDrawUsage));
  const rainMat = new THREE.LineBasicMaterial({ color: 0xb8c8d8, transparent: true, opacity: 0, depthWrite: false, fog: true });
  const rain = new THREE.LineSegments(rainGeo, rainMat);
  rain.frustumCulled = false;
  rain.visible = false;
  root.add(rain);

  // ---- snow: soft points
  const snowN = COUNTS.snow.on;
  const snowPos = new Float32Array(snowN * 3);
  const snowPhase = new Float32Array(snowN);
  const snowGeo = new THREE.BufferGeometry();
  snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3).setUsage(THREE.DynamicDrawUsage));
  const snowMat = new THREE.PointsMaterial({
    size: 0.65, map: snowTexture(), transparent: true, opacity: 0, depthWrite: false, sizeAttenuation: true, fog: true,
  });
  const snow = new THREE.Points(snowGeo, snowMat);
  snow.frustumCulled = false;
  snow.visible = false;
  root.add(snow);

  const centre = new THREE.Vector3();
  let seeded = false;
  const rnd = Math.random;

  function spawnRain(i, cx, cz, anyHeight) {
    const x = cx + (rnd() - 0.5) * BOX;
    const z = cz + (rnd() - 0.5) * BOX;
    const y = heightAt(terrain, x, z) + (anyHeight ? rnd() * TOP : TOP * (0.8 + rnd() * 0.2));
    const o = i * 6;
    rainPos[o] = x; rainPos[o + 1] = y; rainPos[o + 2] = z;
    rainPos[o + 3] = x - WIND.x * DROP_LEN; rainPos[o + 4] = y - DROP_LEN; rainPos[o + 5] = z - WIND.y * DROP_LEN;
  }

  function spawnSnow(i, cx, cz, anyHeight) {
    const x = cx + (rnd() - 0.5) * BOX;
    const z = cz + (rnd() - 0.5) * BOX;
    const o = i * 3;
    snowPos[o] = x;
    snowPos[o + 1] = heightAt(terrain, x, z) + (anyHeight ? rnd() * TOP : TOP * (0.8 + rnd() * 0.2));
    snowPos[o + 2] = z;
    snowPhase[i] = rnd() * 6.28;
  }

  // keeps a particle inside the box around the moving view (wraps across the edges)
  function wrap(v, c) {
    const h = BOX / 2;
    if (v < c - h) return v + BOX;
    if (v > c + h) return v - BOX;
    return v;
  }

  // smoothed state
  let rainAmt = 0;
  let snowAmt = 0;
  let wet = 0;
  let cover = 0;
  let autumn = null;
  let dull = null;
  let patchTimer = 0;
  let time = 0;

  function patchScene() {
    scene.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) patchMaterial(m);
    });
  }

  function update(state, dt) {
    time += dt;
    patchTimer -= dt;
    if (patchTimer <= 0) { patchTimer = 1; patchScene(); }   // buildings and nature appear over time

    if (view && view.targetSet) centre.copy(view.target);
    else centre.set(state.world?.size / 2 || 120, 0, state.world?.size / 2 || 120);
    if (!seeded) {
      for (let i = 0; i < rainN; i++) spawnRain(i, centre.x, centre.z, true);
      for (let i = 0; i < snowN; i++) spawnSnow(i, centre.x, centre.z, true);
      seeded = true;
    }

    const w = weatherAt(state);
    rainAmt = approach(rainAmt, w.kind === 'rain' ? w.intensity : 0, 0.6, dt);
    snowAmt = approach(snowAmt, w.kind === 'snow' ? w.intensity : 0, 0.6, dt);
    wet = w.kind === 'rain' ? approach(wet, 0.4 + 0.6 * w.intensity, 0.25, dt) : Math.max(0, wet - dt / 40);
    cover = approach(cover, state.snow ?? 0, 1.5, dt);
    const st = seasonTargets(state);
    autumn = autumn == null ? st.autumn : approach(autumn, st.autumn, 0.5, dt);
    dull = dull == null ? st.dull : approach(dull, st.dull, 0.5, dt);
    U.uSnow.value = cover;
    U.uWet.value = wet;
    U.uAutumn.value = autumn;
    U.uDull.value = dull;
    if (sceneApi.setOvercast) sceneApi.setOvercast(Math.max(rainAmt, snowAmt * 0.85), cover);

    // ---- rain
    const rainShow = Math.floor((effects ? COUNTS.rain.on : COUNTS.rain.off) * rainAmt);
    rain.visible = rainShow > 0;
    if (rain.visible) {
      const fall = RAIN_SPEED * dt;
      for (let i = 0; i < rainShow; i++) {
        const o = i * 6;
        let x = wrap(rainPos[o] + WIND.x * fall, centre.x);
        let z = wrap(rainPos[o + 2] + WIND.y * fall, centre.z);
        const y = rainPos[o + 1] - fall;
        if (y < heightAt(terrain, x, z)) { spawnRain(i, centre.x, centre.z, false); continue; }
        rainPos[o] = x; rainPos[o + 1] = y; rainPos[o + 2] = z;
        rainPos[o + 3] = x - WIND.x * DROP_LEN; rainPos[o + 4] = y - DROP_LEN; rainPos[o + 5] = z - WIND.y * DROP_LEN;
      }
      rainGeo.setDrawRange(0, rainShow * 2);
      rainGeo.attributes.position.needsUpdate = true;
      rainMat.opacity = 0.18 + 0.32 * rainAmt;
    }

    // ---- snow
    const snowShow = Math.floor((effects ? COUNTS.snow.on : COUNTS.snow.off) * snowAmt);
    snow.visible = snowShow > 0;
    if (snow.visible) {
      const fall = SNOW_SPEED * dt;
      for (let i = 0; i < snowShow; i++) {
        const o = i * 3;
        const sway = Math.sin(time * 1.3 + snowPhase[i]) * 0.6 * dt;
        const x = wrap(snowPos[o] + WIND.x * fall + sway, centre.x);
        const z = wrap(snowPos[o + 2] + WIND.y * fall + Math.cos(time + snowPhase[i]) * 0.4 * dt, centre.z);
        const y = snowPos[o + 1] - fall;
        if (y < heightAt(terrain, x, z)) { spawnSnow(i, centre.x, centre.z, false); continue; }
        snowPos[o] = x; snowPos[o + 1] = y; snowPos[o + 2] = z;
      }
      snowGeo.setDrawRange(0, snowShow);
      snowGeo.attributes.position.needsUpdate = true;
      snowMat.opacity = 0.55 + 0.4 * snowAmt;
    }
  }

  function dispose() {
    offGfx();
    rainGeo.dispose(); rainMat.dispose();
    snowGeo.dispose(); snowMat.map.dispose(); snowMat.dispose();
    scene.remove(root);
  }

  return { update, dispose };
}
