// Per-device graphics settings (not part of the save). Stored in localStorage 'hamlet-graphics'.
//   getGraphics() -> { preset, shadows: 'off'|'low'|'high', grass: 0|0.5|1, effects: boolean,
//                      pixelRatio: 1|'auto', showFps: boolean }
//   setGraphics(partial)  merge + validate + persist + notify (a { preset } entry applies a whole preset)
//   onGraphicsChange(fn)  fn(settings) is called after every change; returns an unsubscribe function
// Renderers (scene.js, nature.js, effects.js, world.js) subscribe and react live.
// Node-safe: no DOM/localStorage access at import time, every storage call is wrapped in try/catch.

const KEY = 'hamlet-graphics';

export const GRAPHICS_PRESETS = {
  low: { shadows: 'off', grass: 0, effects: false, pixelRatio: 1 },
  medium: { shadows: 'low', grass: 0.5, effects: true, pixelRatio: 1 },
  high: { shadows: 'high', grass: 1, effects: true, pixelRatio: 'auto' },
};
export const GRAPHICS_OPTIONS = {
  preset: ['low', 'medium', 'high', 'custom'],
  shadows: ['off', 'low', 'high'],
  grass: [0, 0.5, 1],
  effects: [false, true],
  pixelRatio: [1, 'auto'],
};

const DEFAULT = { preset: 'high', ...GRAPHICS_PRESETS.high, showFps: false };

let current = null;
const listeners = new Set();

function presetOf(g) {
  for (const [name, p] of Object.entries(GRAPHICS_PRESETS)) {
    if (g.shadows === p.shadows && g.grass === p.grass && g.effects === p.effects && g.pixelRatio === p.pixelRatio) return name;
  }
  return 'custom';
}

// Keep only known keys with allowed values.
function sanitize(src, base) {
  const out = { ...base };
  if (!src || typeof src !== 'object') return out;
  if (GRAPHICS_OPTIONS.shadows.includes(src.shadows)) out.shadows = src.shadows;
  if (GRAPHICS_OPTIONS.grass.includes(Number(src.grass)) && src.grass !== null && src.grass !== '') out.grass = Number(src.grass);
  if (typeof src.effects === 'boolean') out.effects = src.effects;
  if (src.pixelRatio === 1 || src.pixelRatio === '1') out.pixelRatio = 1;
  else if (src.pixelRatio === 'auto') out.pixelRatio = 'auto';
  if (typeof src.showFps === 'boolean') out.showFps = src.showFps;
  out.preset = presetOf(out);
  return out;
}

function load() {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT };
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT };
    return sanitize(JSON.parse(raw), DEFAULT);
  } catch (e) {
    return { ...DEFAULT };
  }
}

function save() {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch (e) { /* private mode / quota: ignore */ }
}

export function getGraphics() {
  if (!current) current = load();
  return { ...current };
}

export function setGraphics(partial = {}) {
  if (!current) current = load();
  const { preset, ...rest } = partial || {};
  let next = { ...current };
  if (GRAPHICS_PRESETS[preset]) next = { ...next, ...GRAPHICS_PRESETS[preset] };
  // individual values in the same call win over the preset's ("preset + tweak")
  next = sanitize({ ...next, ...rest }, next);
  const changed = Object.keys(next).some((k) => next[k] !== current[k]);
  current = next;
  if (!changed) return getGraphics();
  save();
  const snap = getGraphics();
  for (const fn of [...listeners]) {
    try { fn(snap); } catch (e) { console.error(e); }
  }
  return snap;
}

export function onGraphicsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Test helper: forget the cached value and listeners (re-reads storage on next get).
export function _resetGraphicsForTests() {
  current = null;
  listeners.clear();
}
