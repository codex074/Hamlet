// Game data only — no logic. All tuning numbers live here.

export const WORLD_SIZE = 240;          // metres, x,z ∈ [0, WORLD_SIZE]
export const GRID = 120;                // heightmap / wear / fertility cells per side
export const CELL = WORLD_SIZE / GRID;  // 2 m
export const MAX_HEIGHT = 14;
export const RIVER_WIDTH = 8;
export const SPAWN = { x: WORLD_SIZE / 2, z: WORLD_SIZE / 2 };
export const SPAWN_CLEAR_RADIUS = 25;
export const EDGE_MARGIN = 4;
export const MAX_SLOPE = 2.5;           // max height difference under a footprint

export const NODE_COUNTS = { tree: 900, rock: 40, berry: 60 };
export const NODE_AMOUNT = { tree: 4, rock: 60, berry: 12 };
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

export const RESOURCES = ['wood', 'planks', 'stone', 'berries', 'wheat', 'flour', 'bread'];
export const FOODS = ['bread', 'berries'];   // preference order when eating

export const RESOURCE_INFO = {
  wood:    { name: 'ไม้ซุง',     icon: '🪵' },
  planks:  { name: 'ไม้แปรรูป',  icon: '🪚' },
  stone:   { name: 'หิน',        icon: '🪨' },
  berries: { name: 'เบอร์รี่',    icon: '🫐' },
  wheat:   { name: 'ข้าวสาลี',   icon: '🌾' },
  flour:   { name: 'แป้ง',       icon: '🥣' },
  bread:   { name: 'ขนมปัง',     icon: '🍞' },
  gold:    { name: 'ทอง',        icon: '🪙' },
};

// job kinds: 'gather' | 'farm' | 'process' | 'service' | null
export const BUILDINGS = {
  townhall:   { name: 'ศาลากลาง', category: null, radius: 6, cost: {}, buildTime: 0,
                storage: true, workers: 0, job: null, unlockPop: 0 },
  storehouse: { name: 'โกดัง', category: 'resource', radius: 4.5, cost: { wood: 15 }, buildTime: 20,
                storage: true, workers: 0, job: null, unlockPop: 0 },
  woodcutter: { name: 'คนตัดไม้', category: 'resource', radius: 3.5, cost: { wood: 8 }, buildTime: 15,
                workers: 2, job: 'gather', node: 'tree', output: { wood: 2 }, time: 6, unlockPop: 0 },
  forager:    { name: 'คนเก็บของป่า', category: 'resource', radius: 3.5, cost: { wood: 8 }, buildTime: 15,
                workers: 2, job: 'gather', node: 'berry', output: { berries: 2 }, time: 5, unlockPop: 0 },
  quarry:     { name: 'เหมืองหิน', category: 'resource', radius: 4, cost: { wood: 12 }, buildTime: 20,
                workers: 2, job: 'gather', node: 'rock', output: { stone: 2 }, time: 8, unlockPop: 0 },
  sawmill:    { name: 'โรงเลื่อย', category: 'production', radius: 4.5, cost: { wood: 15, stone: 6 }, buildTime: 30,
                workers: 2, job: 'process', input: { wood: 2 }, output: { planks: 1 }, time: 6, unlockPop: 8 },
  farmhouse:  { name: 'ฟาร์ม', category: 'production', radius: 4.5, cost: { wood: 12, planks: 4 }, buildTime: 30,
                workers: 3, job: 'farm', output: { wheat: 3 }, time: 8, unlockPop: 12 },
  mill:       { name: 'โรงสี', category: 'production', radius: 4, cost: { wood: 12, stone: 10 }, buildTime: 35,
                workers: 1, job: 'process', input: { wheat: 2 }, output: { flour: 2 }, time: 6, unlockPop: 12 },
  bakery:     { name: 'ร้านขนมปัง', category: 'production', radius: 4, cost: { planks: 10, stone: 6 }, buildTime: 30,
                workers: 1, job: 'process', input: { flour: 1 }, output: { bread: 3 }, time: 6, unlockPop: 12 },
  chapel:     { name: 'โบสถ์', category: 'service', radius: 5, cost: { wood: 15, stone: 12 }, buildTime: 40,
                workers: 1, job: 'service', service: 'religion', serviceRadius: 45, unlockPop: 6 },
  tavern:     { name: 'โรงเตี๊ยม', category: 'service', radius: 5, cost: { planks: 15, stone: 8 }, buildTime: 40,
                workers: 1, job: 'service', service: 'entertainment', serviceRadius: 45, unlockPop: 20 },
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

// House levels (index = level - 1). needs: subset of 'food' | 'bread' | 'religion' | 'entertainment' | 'cathedral'
export const HOUSE_LEVELS = [
  { level: 1, name: 'ผู้มาใหม่', needs: ['food'],                                              capacity: 3, tax: 1, upgradeCost: null },
  { level: 2, name: 'ไพร่',     needs: ['food', 'religion'],                                  capacity: 4, tax: 2, upgradeCost: { planks: 6 } },
  { level: 3, name: 'สามัญชน',  needs: ['food', 'bread', 'religion', 'entertainment'],        capacity: 5, tax: 4, upgradeCost: { stone: 8, planks: 6 } },
  { level: 4, name: 'ชาวเมือง', needs: ['food', 'bread', 'religion', 'entertainment', 'cathedral'], capacity: 6, tax: 7, upgradeCost: { stone: 12, planks: 8 } },
];

export const NEED_INFO = {
  food:          'อาหาร',
  bread:         'ขนมปัง',
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
  villagers: 8,
  stock: { wood: 60, stone: 10, berries: 40 },
  gold: 0,
};

export const ZONE_BRUSH = { min: 6, max: 14, default: 9 };
export const HOUSE_SITE_TRIES = 30;
