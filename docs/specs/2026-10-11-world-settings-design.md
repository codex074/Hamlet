# Hamlet — World Settings, Territories, Difficulty, Regrowth, Graphics (Design Spec v5)

Approved 2026-10-11. Extends all earlier specs.

## 1. World dimensions become per-world
- Cell size stays 2 m (`CELL`). New per-world dims live on the terrain object and the state:
  `terrain.size` (metres), `terrain.grid` (= size / CELL), and `state.world = { size, grid, plot: 80, plots: size / 80 }`.
- Map sizes (`MAP_SIZES` in config): `small: 240`, `medium: 400`, `large: 560` (3×3, 5×5, 7×7 plots).
- Every module that used `WORLD_SIZE` / `GRID` must read the world's own dims instead:
  terrain helpers read `terrain.size/grid`; wear helpers derive grid from the array (`grid = Math.round(Math.sqrt(wear.length))`);
  placement/sim/needs/animals/families use `state.world`; render reads `terrain.size/grid`.
  `WORLD_SIZE`/`GRID` remain in config only as the small-map defaults and for old saves.
- `SPAWN` becomes the map centre: `{ x: size/2, z: size/2 }` (helper `spawnOf(state|terrain)`).

## 2. World settings (fixed at creation) — `state.settings`
```js
{
  mapSize: 'small'|'medium'|'large',            // default 'medium' for new worlds
  forest: 'low'|'normal'|'high', stone: same, berries: same, ore: same,
  terrain: 'flat'|'normal'|'hilly',
  rivers: 0|1|2|3,                               // default 1
  startResources: 'low'|'normal'|'high',
  startVillagers: 4|8|12,
  regrowth: 'off'|'slow'|'normal',
}
```
- Node counts scale with land area relative to the small map × density (`low 0.5, normal 1, high 1.7`); node amounts × (`low 0.7, normal 1, high 1.4`).
- terrain: height amplitude × (`flat 0.4, normal 1, hilly 1.7`); hilly also raises ore availability. Rivers: N sinuous rivers at different offsets/orientations (horizontal or vertical), never through the central start area (keep ≥ 40 m from SPAWN). 0 rivers → add 1–2 small ponds so fishing is still possible.
- startResources multiplies START.stock (`low 0.5, normal 1, high 2`) and gold (`0 / 0 / 100`).
- `createWorld(seed, settings = DEFAULT_SETTINGS)`; `normalizeSettings(partial)` fills defaults and rejects unknown values.

## 3. Territories
- `state.territory = { owned: number[] (plots*plots, 0/1, row-major pz*plots+px), bought: number }`.
- Start: the 3×3 plots around the centre are owned (small map → everything owned).
- `plotPrice(state)` = round(PLOT_BASE_PRICE (80) × PLOT_PRICE_GROWTH (1.35) ^ bought).
- `plotInfo(state)` → `[{ px, pz, x0, z0, x1, z1, owned, buyable, price }]` — buyable = not owned and edge-adjacent (4-neighbour) to an owned plot.
- `buyPlot(state, px, pz)` → `{ ok, reason }` (Thai reasons: 'ซื้อได้เฉพาะแปลงที่ติดกับดินแดนของคุณ', 'ทองไม่พอ (ต้องใช้ N)'); deducts gold, event `🗺️ ซื้อดินแดนใหม่แล้ว`.
- `isOwned(state, x, z)`; placement (`canPlace`, `canPaintZone`, house sites) requires the whole footprint inside owned land — reason 'อยู่นอกดินแดนของคุณ'.
- Gathering/hunting/fishing/farming targets must be on owned land (nodes outside are ignored; deer outside are not hunted). Villagers may walk anywhere.

## 4. Difficulty (changeable any time) — `state.difficulty: 'easy'|'normal'|'hard'`
`DIFFICULTY` in config: multipliers for hunger rate (0.75/1/1.25), sickness chance (0.5/1/1.5), immigration count (1.4/1/0.7), pregnancy chance (1.3/1/0.8), construction cost of NEW placements (0.75/1/1.25, rounded up, min 1), tax (1.2/1/0.85). `setDifficulty(state, level)`; event `⚙️ เปลี่ยนความยากเป็น…`.

## 5. Regrowth
- New building `forester` ('คนปลูกป่า', category resource, radius 3.5, cost wood 10, workers 1, light: true, unlockPop 8, job 'forester'): worker picks a random owned land point within FORESTER_RADIUS (30) of the building that is ≥ 2.5 m from other nodes/buildings/zones and not on paths (wear < 0.3), walks there, works 6 s, creates node `{ kind: 'sapling', planted: time }`. Saplings become trees after SAPLING_GROW_DAYS (2) game days. Saplings can't be gathered. Max 40 saplings per forester alive.
- Natural regrowth (settings.regrowth ≠ 'off'): each midnight, spawn `slow: 0.5%, normal: 1.5%` of the initial tree count as saplings next to existing trees (2–6 m away, owned or not); rocks/ore: if current count < 60% of initial, spawn one new rock (and one ore if any existed) on suitable land per day (`slow`: every 3 days).
- Initial counts are stored in `state.initialNodes = { tree, rock, berry, ore }`.

## 6. Performance for large maps
- Spatial index for nodes (bucketed grid, 8 m buckets) used by every "nearest node" search; maintained on add/remove.
- `decayWear` once per game-second (scaled dt) instead of every step.
- Render: terrain split into 80 m chunks (frustum-culled); ground detail only within ~120 m of the camera target (re-scattered as the camera moves, deterministic per chunk); unowned land tinted darker; plot borders as thin lines; shadow camera follows the view.

## 7. Graphics settings (per device) — `src/render/graphics.js`
`getGraphics() -> { preset, shadows: 'off'|'low'|'high', grass: 0|0.5|1, effects: boolean, pixelRatio: 1|'auto', showFps: boolean }`,
`setGraphics(partial)`, `onGraphicsChange(fn)`; presets low/medium/high; stored in localStorage `hamlet-graphics` (try/catch). scene.js, nature.js, effects.js, world.js react live.

## 8. Saves & server
- Save version 4. v3 → v4: `settings` = small map + normal everything, `world` = small, territory all owned, difficulty 'normal', initialNodes from current counts.
- Server: `villages.settings TEXT` (JSON ≤ 2 KB). `POST /api/villages { name, settings? }` validates with the same allowed values (server/settings.js mirrors normalizeSettings). `GET /api/villages/:id/save` returns `village.settings`. The client creates a brand-new world with `createWorld(village.seed, village.settings)`.

## 9. UI
- Cloud village creation and local "เกมใหม่" open a **world settings form**: name (cloud), map size cards with dimensions, resource sliders/segments, terrain, rivers, start resources, start villagers, regrowth, seed (random button / text → hashed to int), difficulty. Sensible defaults ('medium', normal…). Shows a summary "พื้นที่ทั้งหมด N แปลง · เริ่มต้น 9 แปลง".
- In-game ☰ → ⚙️ ตั้งค่า: tabs ความยาก (radio + description of multipliers) and กราฟิก (preset + individual controls, FPS counter toggle).
- Build bar: new tab 🗺️ ดินแดน — toggles territory view: plot grid overlay, buyable plots highlighted with price labels; click → confirm → buyPlot. Top bar shows owned plots "🗺️ 9/25".
- Guide: new sections for settings, territories, regrowth/forester; difficulty table.
