// World settings: defaults, validation and the per-setting multipliers. Pure: no DOM, no globals.
import {
  DEFAULT_SETTINGS, SETTINGS_OPTIONS, MAP_SIZES, PLOT_SIZE, DIFFICULTY, NODE_AMOUNT, AMOUNT_MUL,
} from './config.js';

export { DEFAULT_SETTINGS, SETTINGS_OPTIONS };

// Settings of pre-v4 worlds: the original 240 m map, everything normal.
export const LEGACY_SETTINGS = { ...DEFAULT_SETTINGS, mapSize: 'small' };

function pick(key, value) {
  const options = SETTINGS_OPTIONS[key];
  if (options.includes(value)) return value;
  // numeric options also accept numeric strings ("2")
  if (typeof options[0] === 'number' && typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (options.includes(n)) return n;
  }
  return undefined;
}

// Problems found in a (partial) settings object; [] when every given value is allowed.
export function settingsProblems(partial) {
  if (partial == null) return [];
  if (typeof partial !== 'object' || Array.isArray(partial)) return ['settings must be an object'];
  const problems = [];
  for (const [key, value] of Object.entries(partial)) {
    if (!(key in SETTINGS_OPTIONS)) problems.push(`unknown setting: ${key}`);
    else if (value !== undefined && pick(key, value) === undefined) problems.push(`invalid value for ${key}`);
  }
  return problems;
}

// Fills defaults; unknown keys are dropped and invalid values fall back to the default.
export function normalizeSettings(partial) {
  const out = { ...DEFAULT_SETTINGS };
  if (partial && typeof partial === 'object' && !Array.isArray(partial)) {
    for (const key of Object.keys(SETTINGS_OPTIONS)) {
      const v = pick(key, partial[key]);
      if (v !== undefined) out[key] = v;
    }
  }
  return out;
}

export function mapSizeOf(settings) {
  return MAP_SIZES[settings.mapSize] ?? MAP_SIZES.small;
}

export function worldDims(settings) {
  const size = mapSizeOf(settings);
  return { size, grid: size / 2, plot: PLOT_SIZE, plots: size / PLOT_SIZE };
}

// Node amount per kind for a world's settings (berry regrowth also caps at this).
export function nodeAmountFor(settings, kind) {
  const key = { tree: 'forest', rock: 'stone', berry: 'berries', ore: 'ore' }[kind];
  const mul = AMOUNT_MUL[settings?.[key] ?? 'normal'] ?? 1;
  return Math.max(1, Math.round(NODE_AMOUNT[kind] * mul));
}

// Difficulty multipliers for a state (defaults to normal for old/fake states).
export function difficultyOf(state) {
  return DIFFICULTY[state?.difficulty] ?? DIFFICULTY.normal;
}
