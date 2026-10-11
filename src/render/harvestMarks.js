// Marks over the trees, rocks and ore veins the player picked for harvesting: a coloured ring on the ground
// around each one (one InstancedMesh). Rebuilt only when the marks change.
import * as THREE from '../../vendor/three.module.js';
import { heightAt } from '../terrain.js';

const COLORS = { tree: 0xff8a1a, rock: 0x4fb4ff, ore: 0xff4a3a };
const RING_R = { tree: 1.3, rock: 1.6, ore: 1.7 };
const START_CAP = 64;
const CHECK_EVERY = 0.4;   // seconds between "did anything change?" checks

export function createHarvestMarks(parent, terrain) {
  const geo = new THREE.RingGeometry(0.66, 1, 24).rotateX(-Math.PI / 2);
  // drawn over everything: in a dense forest the canopy would otherwise hide the marks
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false, depthTest: false, toneMapped: false, fog: false,
  });
  mat.userData.noWeather = true;
  let cap = START_CAP;
  let mesh = make(cap);
  let sig = '';
  let timer = 0;
  let pulse = 0;
  const m4 = new THREE.Matrix4();
  const col = new THREE.Color();

  function make(n) {
    const m = new THREE.InstancedMesh(geo, mat, n);
    m.count = 0;
    m.frustumCulled = false;
    m.renderOrder = 10;
    parent.add(m);
    return m;
  }

  function rebuild(marked) {
    if (marked.length > cap) {
      while (cap < marked.length) cap *= 2;
      parent.remove(mesh);
      mesh.dispose();
      mesh = make(cap);
    }
    marked.forEach((n, i) => {
      const r = RING_R[n.kind] ?? 1.2;
      m4.makeScale(r, 1, r);
      m4.setPosition(n.x, heightAt(terrain, n.x, n.z) + 0.08, n.z);
      mesh.setMatrixAt(i, m4);
      mesh.setColorAt(i, col.set(COLORS[n.kind] ?? 0xffffff));
    });
    mesh.count = marked.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  function update(state, dt) {
    pulse += dt;
    mat.opacity = 0.75 + 0.2 * Math.sin(pulse * 3);
    timer -= dt;
    if (timer > 0) return;
    timer = CHECK_EVERY;
    const marked = state.nodes.filter((n) => n.marked && n.amount >= 1);
    const next = `${state.markVersion ?? 0}|${marked.length}|${marked.length ? marked[marked.length - 1].id : 0}`;
    if (next === sig) return;
    sig = next;
    rebuild(marked);
  }

  function dispose() {
    parent.remove(mesh);
    mesh.dispose();
    geo.dispose();
    mat.dispose();
  }

  return { update, dispose };
}
