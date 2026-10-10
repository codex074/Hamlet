// Event log and visual-effect queue shared by the sim modules. Pure: no DOM, no globals.
const MAX_EVENTS = 300;   // history the player can scroll back through
const MAX_FX = 20;

// meta (optional): { kind: 'warn'|'family'|'build'|'info', detail: 'longer explanation', bId, vId, x, z }
export function pushEvent(state, text, meta = null) {
  const e = { t: state.time, text };
  if (meta) Object.assign(e, meta);
  state.events.push(e);
  while (state.events.length > MAX_EVENTS) state.events.shift();
}

// One-shot visual effect for the renderer (it consumes and clears state.fx).
export function pushFx(state, x, z, kind) {
  if (!state.fx) state.fx = [];
  state.fx.push({ t: state.time, x, z, kind });
  while (state.fx.length > MAX_FX) state.fx.shift();
}
