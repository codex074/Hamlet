// Server-side validation of world settings sent when creating a village.
// Mirrors the allowed values of the game's normalizeSettings (src/settings.js); unknown keys are dropped,
// invalid values fall back to the defaults, so the stored JSON is always small and well-formed.
const DENSITY = ['low', 'normal', 'high'];
const OPTIONS = {
  mapSize: ['small', 'medium', 'large'],
  forest: DENSITY,
  stone: DENSITY,
  berries: DENSITY,
  ore: DENSITY,
  terrain: ['flat', 'normal', 'hilly'],
  rivers: [0, 1, 2, 3],
  startResources: DENSITY,
  startVillagers: [4, 8, 12],
  regrowth: ['off', 'slow', 'normal'],
  difficulty: ['easy', 'normal', 'hard'],
};
const DEFAULTS = {
  mapSize: 'medium', forest: 'normal', stone: 'normal', berries: 'normal', ore: 'normal', terrain: 'normal',
  rivers: 1, startResources: 'normal', startVillagers: 8, regrowth: 'normal', difficulty: 'normal',
};

export function cleanSettings(input) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = {};
  for (const [key, allowed] of Object.entries(OPTIONS)) {
    out[key] = allowed.includes(src[key]) ? src[key] : DEFAULTS[key];
  }
  return out;
}
