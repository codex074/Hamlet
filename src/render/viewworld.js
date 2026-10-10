// Tiny shared registry: the size (metres) of the world currently being rendered. createTerrainMesh() publishes it,
// the camera controller reads it when it was not given the terrain explicitly, so panning is clamped to the real map.
let size = null;

export function setViewWorldSize(s) {
  size = s > 0 ? s : null;
}

export function getViewWorldSize() {
  return size;
}
