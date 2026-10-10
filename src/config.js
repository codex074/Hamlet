// Game data only — no logic. All tuning numbers live here.

export const WORLD_SIZE = 240;          // metres, x,z ∈ [0, WORLD_SIZE]
export const GRID = 120;                // heightmap / wear / fertility cells per side
export const CELL = WORLD_SIZE / GRID;  // 2 m
export const MAX_HEIGHT = 14;
export const RIVER_WIDTH = 8;
export const SPAWN = { x: WORLD_SIZE / 2, z: WORLD_SIZE / 2 };   // small-map centre; use spawnOf(state) for the real one
export const SPAWN_CLEAR_RADIUS = 25;
export const EDGE_MARGIN = 4;
export const MAX_SLOPE = 2.5;           // max height difference under a footprint

export const NODE_COUNTS = { tree: 900, rock: 40, berry: 60, ore: 14 };
export const NODE_AMOUNT = { tree: 4, rock: 60, berry: 12, ore: 80 };
export const ORE_MIN_HEIGHT = 0.5;      // ore veins only where height >= this fraction of MAX_HEIGHT
export const BERRY_REGROW_PER_SEC = 1 / 20; // berries regrow per bush per second

export const DAY_LENGTH = 240;          // seconds of game time per day
export const NIGHT_START = 21, NIGHT_END = 5; // hours
export const HUNGER_PER_SEC = 1 / 120;
export const HUNGRY_AT = 0.6;
export const STARVING_AT = 0.9;

export const WALK_SPEED = 3.2;
export const WATER_SPEED_MUL = 0.4;
export const WEAR_PER_STEP = 0.06;      // per second of walking on a cell
export const WEAR_DECAY = 0.0015;       // per second, every cell
export const WEAR_PATH_MIN = 0.3, WEAR_PATH_MAX = 0.8, WEAR_SPEED_BONUS = 0.6;

export const CARRY_MAX = 5;
export const GATHER_RADIUS = 40;
export const FIELD_RADIUS = 30;
export const SERVICE_STAFFED_DIST = 6;
export const IDLE_WANDER_RADIUS = 10;

export const RESOURCES = ['wood', 'planks', 'stone', 'berries', 'wheat', 'flour', 'bread',
  'fish', 'meat', 'wool', 'cloth', 'herbs', 'ore', 'tools'];
export const FOODS = ['bread', 'meat', 'fish', 'berries'];   // preference order when eating (rotates for variety)

export const RESOURCE_INFO = {
  wood:    { name: 'ไม้ซุง',     icon: '🪵' },
  planks:  { name: 'ไม้แปรรูป',  icon: '🪚' },
  stone:   { name: 'หิน',        icon: '🪨' },
  berries: { name: 'เบอร์รี่',    icon: '🫐' },
  wheat:   { name: 'ข้าวสาลี',   icon: '🌾' },
  flour:   { name: 'แป้ง',       icon: '🥣' },
  bread:   { name: 'ขนมปัง',     icon: '🍞' },
  fish:    { name: 'ปลา',        icon: '🐟' },
  meat:    { name: 'เนื้อ',       icon: '🍖' },
  wool:    { name: 'ขนแกะ',      icon: '🧶' },
  cloth:   { name: 'ผ้า',         icon: '🧣' },
  herbs:   { name: 'สมุนไพร',    icon: '🌿' },
  ore:     { name: 'แร่เหล็ก',    icon: '⛰️' },
  tools:   { name: 'เครื่องมือ',   icon: '🔧' },
  gold:    { name: 'ทอง',        icon: '🪙' },
};

// job kinds: 'gather' | 'farm' | 'process' | 'service' | 'fish' | 'ranch' | 'hunt' | 'doctor' | 'market' | null
export const BUILDINGS = {
  townhall:   { name: 'ศาลากลาง', category: null, radius: 6, cost: {}, buildTime: 0,
                storage: true, workers: 0, job: null, unlockPop: 0 },
  storehouse: { name: 'โกดัง', category: 'resource', radius: 4.5, cost: { wood: 15 }, buildTime: 20,
                storage: true, workers: 0, job: null, unlockPop: 0 },
  woodcutter: { name: 'คนตัดไม้', category: 'resource', radius: 3.5, cost: { wood: 8 }, buildTime: 15,
                workers: 2, job: 'gather', node: 'tree', output: { wood: 2 }, time: 6, unlockPop: 0 },
  forager:    { name: 'คนเก็บของป่า', category: 'resource', radius: 3.5, cost: { wood: 8 }, buildTime: 15,
                workers: 2, job: 'gather', node: 'berry', output: { berries: 2 }, time: 5, unlockPop: 0, light: true },
  quarry:     { name: 'เหมืองหิน', category: 'resource', radius: 4, cost: { wood: 12 }, buildTime: 20,
                workers: 2, job: 'gather', node: 'rock', output: { stone: 2 }, time: 8, unlockPop: 0 },
  sawmill:    { name: 'โรงเลื่อย', category: 'production', radius: 4.5, cost: { wood: 15, stone: 6 }, buildTime: 30,
                workers: 2, job: 'process', input: { wood: 2 }, output: { planks: 1 }, time: 6, unlockPop: 8 },
  farmhouse:  { name: 'ฟาร์ม', category: 'production', radius: 4.5, cost: { wood: 12, planks: 4 }, buildTime: 30,
                workers: 3, job: 'farm', output: { wheat: 3 }, time: 8, unlockPop: 12 },
  mill:       { name: 'โรงสี', category: 'production', radius: 4, cost: { wood: 12, stone: 10 }, buildTime: 35,
                workers: 1, job: 'process', input: { wheat: 2 }, output: { flour: 2 }, time: 6, unlockPop: 12 },
  bakery:     { name: 'ร้านขนมปัง', category: 'production', radius: 4, cost: { planks: 10, stone: 6 }, buildTime: 30,
                workers: 1, job: 'process', input: { flour: 1 }, output: { bread: 3 }, time: 6, unlockPop: 12, light: true },
  chapel:     { name: 'โบสถ์', category: 'service', radius: 5, cost: { wood: 15, stone: 12 }, buildTime: 40,
                workers: 1, job: 'service', service: 'religion', serviceRadius: 45, unlockPop: 6, light: true },
  tavern:     { name: 'โรงเตี๊ยม', category: 'service', radius: 5, cost: { planks: 15, stone: 8 }, buildTime: 40,
                workers: 1, job: 'service', service: 'entertainment', serviceRadius: 45, unlockPop: 20, light: true },
  fishery:    { name: 'ท่าประมง', category: 'resource', radius: 4, cost: { wood: 10 }, buildTime: 20,
                workers: 2, job: 'fish', output: { fish: 2 }, time: 10, unlockPop: 10, nearWater: true },
  hunter:     { name: 'กระท่อมนักล่า', category: 'resource', radius: 3.5, cost: { wood: 10 }, buildTime: 15,
                workers: 1, job: 'hunt', output: { meat: 3 }, time: 4, unlockPop: 8 },
  herbalist:  { name: 'คนเก็บสมุนไพร', category: 'resource', radius: 3.5, cost: { wood: 10 }, buildTime: 15,
                workers: 1, job: 'gather', node: 'tree', keepNode: true, output: { herbs: 1 }, time: 7, unlockPop: 10, light: true },
  forester:   { name: 'คนปลูกป่า', category: 'resource', radius: 3.5, cost: { wood: 10 }, buildTime: 15,
                workers: 1, job: 'forester', time: 6, unlockPop: 8, light: true },
  sheepfarm:  { name: 'คอกแกะ', category: 'resource', radius: 7, cost: { wood: 15, planks: 6 }, buildTime: 35,
                workers: 2, job: 'ranch', outputs: [{ meat: 2 }, { wool: 2 }], time: 9, unlockPop: 15 },
  ironmine:   { name: 'เหมืองแร่เหล็ก', category: 'resource', radius: 4.5, cost: { wood: 15, planks: 8 }, buildTime: 35,
                workers: 2, job: 'gather', node: 'ore', output: { ore: 2 }, time: 10, unlockPop: 25 },
  weaver:     { name: 'ช่างทอผ้า', category: 'production', radius: 4, cost: { planks: 12, stone: 4 }, buildTime: 30,
                workers: 1, job: 'process', input: { wool: 2 }, output: { cloth: 1 }, time: 8, unlockPop: 20, light: true },
  blacksmith: { name: 'โรงตีเหล็ก', category: 'production', radius: 4.5, cost: { planks: 10, stone: 12 }, buildTime: 40,
                workers: 1, job: 'process', input: { ore: 2 }, output: { tools: 1 }, time: 10, unlockPop: 25 },
  infirmary:  { name: 'สถานพยาบาล', category: 'service', radius: 5, cost: { planks: 12, stone: 10 }, buildTime: 40,
                workers: 2, job: 'doctor', service: 'health', serviceRadius: 50, supply: 'herbs', unlockPop: 15, light: true },
  market:     { name: 'ตลาด', category: 'service', radius: 6, cost: { planks: 15, stone: 6 }, buildTime: 40,
                workers: 2, job: 'market', service: 'clothing', serviceRadius: 50, supply: 'cloth', unlockPop: 20, light: true },
  cathedral:  { name: 'มหาวิหาร', category: 'monument', radius: 11, cost: {}, buildTime: 0,
                workers: 0, job: null, unlockPop: 25, monument: true },
  house:      { name: 'บ้าน', category: null, radius: 3, cost: { wood: 6 }, buildTime: 12,
                workers: 0, job: null, unlockPop: 0 },
};

export const CATHEDRAL_STAGES = [
  { name: 'ฐานราก',          cost: { stone: 30, wood: 20 },                 buildTime: 40 },
  { name: 'ตัวโบสถ์',         cost: { stone: 40, planks: 25 },               buildTime: 40 },
  { name: 'หอระฆัง',         cost: { stone: 40, planks: 20 }, gold: 150,   buildTime: 40 },
  { name: 'ยอดแหลมและกระจกสี', cost: { stone: 30, planks: 20 }, gold: 300,   buildTime: 40 },
];

// House levels (index = level - 1).
// needs: 'food' | 'variety2' | 'variety3' | 'religion' | 'entertainment' | 'health' | 'clothing' | 'cathedral'
export const HOUSE_LEVELS = [
  { level: 1, name: 'ผู้มาใหม่', needs: ['food'], capacity: 3, tax: 1, upgradeCost: null },
  { level: 2, name: 'ไพร่', needs: ['food', 'religion'], capacity: 4, tax: 2, upgradeCost: { planks: 6 } },
  { level: 3, name: 'สามัญชน', needs: ['food', 'variety2', 'religion', 'entertainment', 'health'],
    capacity: 5, tax: 4, upgradeCost: { stone: 8, planks: 6 } },
  { level: 4, name: 'ชาวเมือง', needs: ['food', 'variety3', 'religion', 'entertainment', 'health', 'clothing'],
    capacity: 6, tax: 7, upgradeCost: { stone: 12, planks: 8 } },
  { level: 5, name: 'ขุนนาง', needs: ['food', 'variety3', 'religion', 'entertainment', 'health', 'clothing', 'cathedral'],
    capacity: 7, tax: 12, upgradeCost: { stone: 20, planks: 12, tools: 4 } },
];

export const NEED_INFO = {
  food:          'อาหาร',
  variety2:      'อาหาร 2 ชนิด',
  variety3:      'อาหาร 3 ชนิด',
  health:        'สุขภาพ',
  clothing:      'เสื้อผ้า',
  religion:      'ศาสนา',
  entertainment: 'ความบันเทิง',
  cathedral:     'มหาวิหาร',
};

export const IMMIGRATION_MIN_HAPPINESS = 0.5;
export const IMMIGRATION_MAX_HOMELESS = 6;
export const LEAVE_HAPPINESS = 0.25;
export const LEAVE_AFTER_DAYS = 2;
export const REFUND_RATIO = 0.5;
export const BUILDER_RESERVE = 3;      // villagers kept job-free while construction sites exist

export const START = {
  villagers: 8,           // = couples * 2 + singles
  couples: 3,
  singles: 2,
  stock: { wood: 60, stone: 10, berries: 40 },
  gold: 0,
};

// Sickness
export const SICK_CHANCE_PER_DAY = 0.04;    // base chance per villager per midnight
export const SICK_HUNGRY_MUL = 2.5;         // if the villager starved that day
export const SICK_COVERED_MUL = 0.4;        // if their house has health coverage
export const SICK_LEAVE_DAYS = 3;           // untreated sick villagers leave after this many midnights
export const SICK_SPEED_MUL = 0.6;
export const HEAL_TIME = 6;                 // seconds a doctor spends treating
// Services that hold a supply (infirmary: herbs, market: cloth)
export const SUPPLY_MAX = 10;               // stock a service building keeps on hand
export const CLOTH_PER_HOUSE_PER_DAY = 0.5; // consumed from the covering market at midnight
export const HERBS_PER_HEAL = 1;
// Tools
export const TOOL_SPEED_BONUS = 0.3;        // work-time reduction share for 'tooled' buildings
export const TOOLS_PER_BUILDING_PER_DAY = 1;
// Fishing / hunting / ranching
export const FISH_RADIUS = 25;              // fishers look for shore spots this close to the fishery
export const NEAR_WATER_DIST = 12;           // fishery must have water within radius + this
export const HUNT_RADIUS = 60;
export const HUNT_SHOT_DIST = 6;
export const DEER_COUNT = 24;
export const DEER_RESPAWN_SEC = 90;
export const DEER_SPEED = 1.4;
export const UPGRADE_BUILD_TIME = 8;

// Families, ageing & births (1 game day = 1 year of age)
export const CHILD_AGE = 14;                // younger than this: child (no work, no building)
export const ELDER_AGE = 55;                // from this age: elder (light jobs only)
export const DEATH_AGE_MIN = 70, DEATH_AGE_MAX = 85;
export const ELDER_SPEED_MUL = 0.75, CHILD_SPEED_MUL = 0.9, PREGNANT_SPEED_MUL = 0.8;
export const CHILD_PLAY_RADIUS = 12;        // children stay this close to home
export const MARRY_MIN = 18, MARRY_MAX = 45;
export const MARRY_CHANCE = 0.35;           // per eligible woman per night
export const FERTILE_MIN = 18, FERTILE_MAX = 42;
export const PREGNANCY_CHANCE = 0.3;        // per eligible wife per night
export const PREGNANCY_DAYS = 2;            // midnights until birth
export const PREGNANCY_MIN_HAPPINESS = 0.5; // house happiness needed to conceive
export const LEAVE_HOME_AGE = 18;           // unmarried adults leave a full parental home
export const START_AGE = { couple: [20, 35], single: [18, 30] };
export const FAMILY_IMMIGRANT_CHANCE = 0.5; // share of immigrant groups that arrive as a family
export const IMMIGRANT_ADULT_AGE = [18, 40], IMMIGRANT_COUPLE_AGE = [20, 40], IMMIGRANT_CHILD_AGE = [1, 12];
export const IMMIGRANT_MAX_CHILDREN = 2;
export const PARENT_MIN_GAP = 16;           // save migration: parent must be this much older than a child

export const ZONE_BRUSH = { min: 6, max: 14, default: 9 };
export const HOUSE_SITE_TRIES = 30;

// ---------- world settings (fixed at creation), territories, difficulty, regrowth ----------
// WORLD_SIZE / GRID above are the small-map defaults (and what pre-v4 saves use); every world carries its own dims.
export const MAP_SIZES = { small: 240, medium: 400, large: 560 };   // metres
export const PLOT_SIZE = 80;                                          // metres per territory plot
export const DENSITY_MUL = { low: 0.5, normal: 1, high: 1.7 };         // node counts
export const AMOUNT_MUL = { low: 0.7, normal: 1, high: 1.4 };          // node amounts
export const TERRAIN_AMP = { flat: 0.4, normal: 1, hilly: 1.7 };       // height amplitude
export const HILLY_ORE_MUL = 1.3;                                      // extra ore veins on hilly maps
export const START_STOCK_MUL = { low: 0.5, normal: 1, high: 2 };
export const START_GOLD_BONUS = { low: 0, normal: 0, high: 100 };
export const START_LAYOUT = {                                          // startVillagers -> founders
  4: { couples: 1, singles: 2 },
  8: { couples: 3, singles: 2 },
  12: { couples: 5, singles: 2 },
};
export const RIVER_MIN_SPAWN_DIST = 40;   // water never closer than this to the map centre

export const DEFAULT_SETTINGS = {
  mapSize: 'medium',
  forest: 'normal', stone: 'normal', berries: 'normal', ore: 'normal',
  terrain: 'normal',
  rivers: 1,
  startResources: 'normal',
  startVillagers: 8,
  regrowth: 'normal',
};
export const SETTINGS_OPTIONS = {
  mapSize: ['small', 'medium', 'large'],
  forest: ['low', 'normal', 'high'], stone: ['low', 'normal', 'high'],
  berries: ['low', 'normal', 'high'], ore: ['low', 'normal', 'high'],
  terrain: ['flat', 'normal', 'hilly'],
  rivers: [0, 1, 2, 3],
  startResources: ['low', 'normal', 'high'],
  startVillagers: [4, 8, 12],
  regrowth: ['off', 'slow', 'normal'],
};

export const START_PLOTS = 3;             // the 3x3 plots around the centre start owned
export const PLOT_BASE_PRICE = 80;
export const PLOT_PRICE_GROWTH = 1.35;

// Multipliers, changeable any time via setDifficulty. cost = construction cost of NEW placements.
export const DIFFICULTY = {
  easy:   { name: 'ง่าย',  hunger: 0.75, sickness: 0.5, immigration: 1.4, pregnancy: 1.3, cost: 0.75, tax: 1.2 },
  normal: { name: 'ปกติ',  hunger: 1,    sickness: 1,   immigration: 1,   pregnancy: 1,   cost: 1,    tax: 1 },
  hard:   { name: 'ยาก',   hunger: 1.25, sickness: 1.5, immigration: 0.7, pregnancy: 0.8, cost: 1.25, tax: 0.85 },
};

// Regrowth
export const FORESTER_RADIUS = 30;
export const SAPLING_GROW_DAYS = 2;
export const MAX_SAPLINGS_PER_FORESTER = 40;
export const SAPLING_GAP = 2.5;           // forester plants this far from other nodes/buildings/zones
export const SAPLING_PATH_WEAR = 0.3;     // never plant on worn paths
export const REGROW_TREE_RATE = { slow: 0.005, normal: 0.015 };   // share of initial trees per midnight
export const REGROW_ROCK_BELOW = 0.6;     // respawn rocks/ore while count < this share of the initial count
export const REGROW_ROCK_EVERY = { slow: 3, normal: 1 };          // days between rock/ore respawns
