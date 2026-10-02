/**
 * 地图（世界）与玩法模式定义
 * ------------------------------------------------------------------
 * 每张地图 = 地形参数 + 地标套件 + 环境（时间/天气/音乐）+ 可用玩法列表。
 * 全部程序化生成，无需下载资源。
 */
import * as THREE from 'three';

/* ================================================================== 玩法模式 */
export const GAME_MODES = {
  free: {
    id: 'free', name: '自由飞行', icon: '🕊', music: 'flight',
    desc: '没有目标，尽情探索地图。飞行时留意隐藏机型与地标。',
    hint: '按 C 切换座舱/追尾视角，R 重置飞机',
  },
  race: {
    id: 'race', name: '空中竞速', icon: '🏁', music: 'race',
    desc: '按顺序穿过所有光环，用时最短者获胜。',
    hint: '贴着光环中心穿过可以更快',
  },
  ground_race: {
    id: 'ground_race', name: '地面竞速', icon: '🏎', music: 'race',
    desc: '驾车沿赛道跑完所有检查点。',
    hint: '过弯前刹车，出弯再给油',
  },
  combat: {
    id: 'combat', name: '空中缠斗', icon: '⚔', music: 'combat',
    desc: '击落所有敌机，小心对方的导弹。',
    hint: '咬住敌机尾部再开火；G 释放干扰弹',
  },
  strike: {
    id: 'strike', name: '对地打击', icon: '🎯', music: 'combat',
    desc: '摧毁全部地面目标，注意防空火力。',
    hint: '低空高速进入，投弹后立即脱离',
  },
  cargo: {
    id: 'cargo', name: '货运任务', icon: '📦', music: 'flight',
    desc: '把货物安全运到投放区，货物受损会扣分。',
    hint: '轻柔起降，别做剧烈机动',
  },
  landing: {
    id: 'landing', name: '降落挑战', icon: '🛬', music: 'flight',
    desc: '把飞机稳稳降在指定跑道上，接地越轻分越高。',
    hint: '放襟翼、控制下降率在 2 m/s 以内',
  },
  carrier: {
    id: 'carrier', name: '航母起降', icon: '⚓', music: 'combat',
    desc: '在航空母舰上完成弹射起飞与拦阻着舰。',
    hint: '着舰时对准斜角甲板中线，勾住拦阻索',
  },
  collect: {
    id: 'collect', name: '寻宝收集', icon: '💎', music: 'flight',
    desc: '找齐地图上隐藏的机型与金杯。',
    hint: '它们常藏在山顶、桥下、楼顶或水底',
  },
  missile: {
    id: 'missile', name: '导弹试验', icon: '🚀', music: 'combat',
    desc: '试射导弹摧毁靶机与靶标，检验你的武器设计。',
    hint: '锁定后等 0.6 秒再发射命中率更高',
  },
  sandbox: {
    id: 'sandbox', name: '沙盒', icon: '🧪', music: 'hangar',
    desc: '无限制：无限燃料、无敌、随便撞。',
    hint: '按 B 打开建造器随时改装',
  },
};

/* ================================================================== 地图 */
/**
 * @typedef {object} MapDef
 *  id, name, nameEn, kit, biome, size, segments, desc, music, timeOfDay, weather, cloudiness,
 *  heightScale, water, landRatioHint, flatRegions, missions, unlockCost, tags
 */

export const MAPS = [
  {
    id: 'archipelago', name: '群岛世界', nameEn: 'SimplePlanes Archipelago', kit: 'archipelago', biome: 'green',
    size: 16000, segments: 288, seaLevel: 0, heightScale: 760, water: true,
    desc: '787 平方公里的主世界：机场、公路、河流、城镇与赛道应有尽有。新手从这里开始。',
    music: 'flight', timeOfDay: 0.40, weather: 'none', cloudiness: 0.45,
    unlockCost: 0, tags: ['主世界', '机场', '城市'],
    flatRegions: [
      { name: 'main', x: -2400, z: 900, radius: 420, height: 34, heading: 0.0 },   // Wright 机场
      { name: 'alt', x: 2900, z: -1800, radius: 360, height: 62, heading: 1.2 },   // Bandit 机场
      { name: 'outpost', x: 500, z: 3200, radius: 280, height: 120, heading: 2.6 },// 山地简易跑道
    ],
    missions: [
      { mode: 'free' },
      { mode: 'race', rings: 12, laps: 1 },
      { mode: 'cargo', crates: 3 },
      { mode: 'collect', items: 12 },
      { mode: 'landing', pads: 3 },
    ],
  },
  {
    id: 'skypark', name: '天空公园', nameEn: 'Sky Park City', kit: 'skypark', biome: 'tropical',
    size: 9000, segments: 224, seaLevel: 0, heightScale: 320, water: true,
    desc: '漂浮在云海上的白色城市与公园岛，热气球与观景平台点缀其间。',
    music: 'city', timeOfDay: 0.30, weather: 'none', cloudiness: 0.6,
    unlockCost: 0, tags: ['城市', '观光'],
    // fixed: 同 stratos —— 天空公园是悬浮城市，出生平台抬高到 210m 才有「云海之上」的观感
    flatRegions: [{ name: 'main', x: 0, z: -900, radius: 330, height: 210, heading: 0, fixed: true }],
    missions: [
      { mode: 'free' },
      { mode: 'race', rings: 10, laps: 2 },
      { mode: 'collect', items: 10 },
      { mode: 'landing', pads: 2 },
    ],
  },
  {
    id: 'snowstone', name: '雪石岛', nameEn: 'Snowstone', kit: 'snowstone', biome: 'snow',
    size: 12000, segments: 256, seaLevel: 0, heightScale: 1250, water: true,
    desc: '冰封的极地岛屿。雷达穹顶、冰屋与失事的二战舰队静卧在暴风雪中。',
    music: 'snow', timeOfDay: 0.22, weather: 'snow', cloudiness: 0.75,
    unlockCost: 0, tags: ['极地', '舰队'],
    flatRegions: [{ name: 'main', x: -1600, z: 1500, radius: 380, height: 40, heading: 0.4 }],
    missions: [
      { mode: 'free' },
      { mode: 'strike', targets: 8 },
      { mode: 'combat', enemies: 3 },
      { mode: 'carrier', ship: 'fleet' },
      { mode: 'collect', items: 10 },
    ],
  },
  {
    id: 'maywar', name: '玛伊瓦沙漠', nameEn: 'Maywar', kit: 'maywar', biome: 'desert',
    size: 13000, segments: 256, seaLevel: 0, heightScale: 520, water: true,
    desc: '烈日下的沙丘、绿洲小镇与古代遗迹。海盗船会向低空飞行的你开火。',
    music: 'desert', timeOfDay: 0.55, weather: 'none', cloudiness: 0.15,
    unlockCost: 0, tags: ['沙漠', '海盗'],
    flatRegions: [{ name: 'main', x: 1200, z: -1400, radius: 420, height: 70, heading: 2.0 }],
    missions: [
      { mode: 'free' },
      { mode: 'strike', targets: 10 },
      { mode: 'race', rings: 11, laps: 1 },
      { mode: 'cargo', crates: 3 },
      { mode: 'collect', items: 10 },
    ],
  },
  {
    id: 'vetusta', name: '维图斯塔城', nameEn: 'Vetusta City', kit: 'vetusta', biome: 'city',
    size: 11000, segments: 256, seaLevel: 0, heightScale: 260, water: true,
    desc: '密集的摩天楼、高架路与霓虹招牌。楼顶停机坪是绝佳的降落点。',
    music: 'city', timeOfDay: 0.86, weather: 'none', cloudiness: 0.35,
    unlockCost: 0, tags: ['城市', '夜间', '楼顶降落'],
    flatRegions: [{ name: 'main', x: -3300, z: 3000, radius: 400, height: 30, heading: 0 }],
    missions: [
      { mode: 'free' },
      { mode: 'race', rings: 14, laps: 1 },
      { mode: 'strike', targets: 12 },
      { mode: 'landing', pads: 4 },
      { mode: 'collect', items: 12 },
      { mode: 'combat', enemies: 2 },
    ],
  },
  {
    id: 'raceway', name: '环礁赛道', nameEn: 'Raceway Isle', kit: 'raceway', biome: 'tropical',
    size: 9000, segments: 224, seaLevel: 0, heightScale: 380, water: true,
    desc: '为竞速而生的小岛：地面赛道与空中光环赛道同场竞技。',
    music: 'race', timeOfDay: 0.45, weather: 'none', cloudiness: 0.3,
    unlockCost: 0, tags: ['竞速', '赛道'],
    flatRegions: [{ name: 'main', x: 0, z: 0, radius: 700, height: 40, heading: 0 }],
    missions: [
      { mode: 'race', rings: 12, laps: 2 },
      { mode: 'ground_race', checkpoints: 14 },
      { mode: 'free' },
      { mode: 'collect', items: 8 },
    ],
  },
  {
    id: 'naval', name: '舰队海域', nameEn: 'Naval Group', kit: 'naval', biome: 'green',
    size: 14000, segments: 256, seaLevel: 0, heightScale: 420, water: true,
    desc: 'USS Tiny 航母战斗群、二战舰队与传说中的深海巨怪。舰载机的舞台。',
    music: 'combat', timeOfDay: 0.34, weather: 'none', cloudiness: 0.5,
    unlockCost: 0, tags: ['航母', '海战'],
    flatRegions: [{ name: 'main', x: -3000, z: 2500, radius: 400, height: 20, heading: 0.9 }],
    missions: [
      { mode: 'carrier', ship: 'carrier' },
      { mode: 'strike', targets: 14 },
      { mode: 'combat', enemies: 4 },
      { mode: 'free' },
      { mode: 'missile', targets: 8 },
      { mode: 'collect', items: 10 },
    ],
  },
  {
    id: 'boneyard', name: '飞机坟场', nameEn: 'The Boneyard', kit: 'boneyard', biome: 'desert',
    size: 10000, segments: 240, seaLevel: 0, heightScale: 300, water: true,
    desc: '数千架退役机体沉睡的荒漠。适合练习超低空穿行与精确投弹。',
    music: 'desert', timeOfDay: 0.60, weather: 'none', cloudiness: 0.1,
    unlockCost: 0, tags: ['训练', '超低空'],
    flatRegions: [{ name: 'main', x: -1200, z: -900, radius: 440, height: 50, heading: 2.4 }],
    missions: [
      { mode: 'free' },
      { mode: 'strike', targets: 12 },
      { mode: 'cargo', crates: 4 },
      { mode: 'missile', targets: 6 },
      { mode: 'collect', items: 10 },
    ],
  },
  {
    id: 'stratos', name: '同温层', nameEn: 'Stratos', kit: 'stratos', biome: 'rocky',
    size: 14000, segments: 256, seaLevel: 700, heightScale: 600, water: true,
    desc: '万米之上的浮空岛群与巨型飞艇。空气稀薄，小心失速。',
    music: 'flight', timeOfDay: 0.48, weather: 'none', cloudiness: 0.8,
    unlockCost: 0, tags: ['高空', '浮空岛', '挑战'],
    // fixed: 浮空岛图，主岛/出生平台刻意悬在云海之上（landmarks 的浮岛按 seaLevel+N 独立建造），
    // 不能被地形自动平整逻辑拉回地面，否则玩家出生点会掉到海面、与浮岛差出 800m
    flatRegions: [{ name: 'main', x: 0, z: -2200, radius: 360, height: 1600, heading: 0, fixed: true }],
    missions: [
      { mode: 'free' },
      { mode: 'race', rings: 16, laps: 1 },
      { mode: 'combat', enemies: 3 },
      { mode: 'collect', items: 14 },
      { mode: 'landing', pads: 3 },
    ],
  },
];

export function getMap(id) { return MAPS.find((m) => m.id === id) || MAPS[0]; }

/** 生成地形构造参数 */
export function terrainOptions(map, quality = 1) {
  const seg = Math.round(map.segments * (quality === 0 ? 0.6 : quality === 2 ? 1.15 : 1));
  return {
    seed: hashString(map.id),
    size: map.size,
    segments: Math.min(420, Math.max(96, seg)),
    biome: map.biome,
    seaLevel: map.seaLevel ?? 0,
    heightScale: map.heightScale,
    water: map.water !== false,
    islands: true,
    flatRegions: (map.flatRegions || []).map((r) => ({ ...r })),
  };
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 100000;
}

/** 出生点：优先取地形给的 spawnPoints，其次 flatRegions */
export function spawnPointFor(map, terrain, name = 'main') {
  const sp = terrain?.spawnPoints || [];
  const found = sp.find((s) => s.name === name) || sp[0];
  if (found) return found;
  const r = (map.flatRegions || [])[0];
  if (r) return { name, position: new THREE.Vector3(r.x, r.height, r.z), heading: r.heading || 0, runwayLength: (r.radius || 200) * 2 };
  return { name, position: new THREE.Vector3(0, 300, 0), heading: 0, runwayLength: 500 };
}
