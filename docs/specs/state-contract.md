# Hamlet — State & Module Contract

Authoritative shapes and APIs shared by every module. All constants come from `src/config.js`.
The game design rationale is in `docs/specs/2026-10-10-hamlet-design.md`.

## Existing modules (already written — read, don't rewrite)

- `src/rng.js` — `mulberry32(seed)->rand()`, `randRange(rand,a,b)`, `randInt(rand,a,b)`, `makeNoise2D(seed)`, `fbm(noise,x,y,oct)`
- `src/wear.js` — `createWear()`, `cellIndex(x,z)`, `addWear(wear,x,z,amt)`, `decayWear(wear,dt)`, `wearAt(wear,x,z)`, `smoothstep(a,b,v)`, `speedMultiplier(wear,x,z)`
- `src/economy.js` — `emptyStock()`, `distance(x1,z1,x2,z2)`, `isStorage(b)`, `storages(state)`, `totalStock(state)`, `nearestStorage(state,x,z,filter)`, `nearestStorageWith(state,x,z,res,n)`, `nearestStorageWithAll(state,x,z,needs)`, `nearestFoodStorage(state,x,z)`, `addStock(b,res,n)`, `takeStock(b,res,n)->taken`, `canAfford(state,cost)`, `missingFor(state,cost)`
- `src/terrain.js` — `generateTerrain(seed)->{heights,fertility,water}`, `generateNodes(seed,terrain)->nodes`, `heightAt(t,x,z)`, `isWater(t,x,z)`, `fertilityAt(t,x,z)`. `heights` are vertex heights, `(GRID+1)²`, index `iz*(GRID+1)+ix`, vertex at `(ix*CELL, iz*CELL)`.
- `src/placement.js` — `footprintOK(state,x,z,r,opts,geo)`, `canPlace(state,type,x,z,rot)`, `canPaintZone(state,kind,x,z,r)`, `nodesUnder(state,x,z,r)->ids`, `findHouseSite(state,zone,rand)->{x,z,rot}|null`. Results are `{ok:true}` or `{ok:false, reason:'<Thai text>'}`.

## State object

```js
state = {
  version: 1,
  seed: number,
  tick: number,            // number of sim steps so far (used to derive per-step rand)
  time: number,            // game seconds; starts at DAY_LENGTH * 6/24 (06:00 of day 1)
  lastDay: number,         // last day number whose midnight was processed
  gold: number,
  nextId: number,          // shared id counter for buildings, zones, villagers
  terrain: { heights, fertility, water },  // NOT saved; regenerated from seed
  nodes: [ { id, kind:'tree'|'rock'|'berry', x, z, amount, reserved: villagerId|null } ],
  buildings: [ Building ],
  zones: [ { id, kind:'residential'|'field', x, z, r } ],
  villagers: [ Villager ],
  wear: Float32Array(GRID*GRID),
  events: [ { t: time, text: 'Thai message' } ],   // newest last, keep max 20
}
```

### Building

```js
{
  id, type, x, z, rot,
  built: boolean,          // true when finished (townhall starts built)
  progress: 0..1,          // construction/upgrade work done
  needed: { res: n },      // materials still to be delivered to the site (cost copy at placement)
  incoming: { res: n },    // amounts currently being carried to the site (reserved by haulers)
  stock: {...} | undefined,// storage buildings only (emptyStock() when built)
  desiredWorkers: n,       // defaults to BUILDINGS[type].workers
  workers: [villagerId],
  // houses only
  zoneId, level: 1..4, residents: [villagerId], upgrading: boolean,
  starvedToday: false, breadToday: false, happiness: 1, unhappyDays: 0,
  needsMet: { food, bread, religion, entertainment, cathedral },  // booleans from last evaluation
  // cathedral only
  stage: 0..4,             // completed stages; site is "built" only when stage === 4
  goldBlocked: number,     // >0 while waiting for gold to start the current stage
}
```

A building is a **site** when `!built || upgrading`. A site is **ready to build** when every value in `needed` is 0.
Build speed: each builder adds `dt / buildTime` to `progress` (`buildTime` from BUILDINGS, cathedral stage, or 8 for house upgrades).

### Villager

```js
{
  id, x, z,
  homeId: buildingId|null,
  jobId: buildingId|null,
  hunger: 0..1,
  carry: { res, n } | null,
  queue: [ Task ],         // queue[0] is the current task
  res: { nodeId?, siteId?, siteRes?, siteN? },  // reservations to release on failure
  role: 'worker'|'builder'|'idle'|'sleeping',   // for rendering colour/label only
}
```

### Task kinds (`queue` entries)

| kind | fields | behaviour |
|---|---|---|
| `goto` | `x, z` | walk straight at `WALK_SPEED × speedMultiplier(wear) × (isWater ? WATER_SPEED_MUL : 1)`; add wear `WEAR_PER_STEP*dt` at current position; done when within 0.3 m |
| `wait` | `t` | count down |
| `take` | `bId, res, n` | take from storage into `carry`; fail if building gone or 0 taken |
| `put` | `bId` | add `carry` to storage stock; if building gone, re-route to nearest storage |
| `deliver` | `bId` | site: `needed[res] -= n`, `incoming[res] -= n`, clear `res.site*`; fail if site gone |
| `gather` | `nodeId, t, out:{res:n}` | count down `t` at the node, then `node.amount -= 1`, `carry = out`, release node; trees with amount 0 are removed from `state.nodes`; fail if node gone/empty |
| `produce` | `bId, t, out:{res:n}` | count down at workplace, then `carry = out` (farm: wheat scaled by fertility; process: output) |
| `build` | `bId, t` | add progress while counting down `t` (max 10 s) — completion is handled by sim |
| `eat` | `bId` | take 1 bread (else 1 berries) from storage, `hunger = 0`, mark home `breadToday` if bread; fail if none |
| `staff` | `bId, t` | stand at service building for `t` seconds |
| `sleep` | — | stay until it is no longer night |

On failure: clear queue, release reservations (`node.reserved = null`, `site.incoming[res] -= n`), and if carrying, queue `goto` nearest storage + `put`.

## Sim API (`src/sim.js`) — used by UI/render

```js
createWorld(seed) -> state
tick(state, dt)                       // advances dt game-seconds in sub-steps of <= 0.1
canPlace(state, type, x, z, rot) -> {ok, reason}   // also checks unlock + single cathedral
placeBuilding(state, type, x, z, rot) -> id|null
canPaintZone(state, kind, x, z, r) -> {ok, reason}
paintZone(state, kind, x, z, r) -> id|null
removeAt(state, x, z) -> boolean
setDesiredWorkers(state, bId, n)
buildingAt(state, x, z) -> building|null
isUnlocked(state, type) -> boolean
clock(state) -> { day, hour, minute, isNight }
summary(state) -> { stock, gold, pop, homeless, housing, happiness, day, hour, isNight, unemployed }
serviceCovered(state, house, service) -> boolean
```

## Save API (`src/save.js`)

```js
serialize(state) -> string          // JSON; wear as plain array; terrain omitted
deserialize(str) -> state           // regenerates terrain from seed; throws on invalid
saveGame(state) / loadGame() -> state|null / clearSave()   // localStorage key 'hamlet-save-v1', all wrapped in try/catch
```
