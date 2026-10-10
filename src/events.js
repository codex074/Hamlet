// Event log and visual-effect queue shared by the sim modules. Pure: no DOM, no globals.
const MAX_EVENTS = 20;
const MAX_FX = 20;

export function pushEvent(state, text) {
  state.events.push({ t: state.time, text });
  while (state.events.length > MAX_EVENTS) state.events.shift();
}

// One-shot visual effect for the renderer (it consumes and clears state.fx).
export function pushFx(state, x, z, kind) {
  if (!state.fx) state.fx = [];
  state.fx.push({ t: state.time, x, z, kind });
  while (state.fx.length > MAX_FX) state.fx.shift();
}
