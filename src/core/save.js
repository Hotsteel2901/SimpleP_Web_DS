/**
 * 存档与玩家档案（localStorage）
 * ------------------------------------------------------------------
 * 保存：金钱、解锁地图、拥有的机型、自建机型、涂装、最佳成绩、设置、统计。
 */
import { store, deepClone } from './util.js';

const KEY = 'sp2.profile.v1';

export function defaultProfile() {
  return {
    version: 1,
    name: 'Pilot',
    money: 45000,
    xp: 0,
    level: 1,
    unlockedMaps: ['archipelago', 'skypark', 'snowstone', 'maywar', 'vetusta', 'raceway', 'naval', 'boneyard', 'stratos'],
    ownedCrafts: {},           // craftId -> true（库存机默认全部拥有）
    customCrafts: [],          // 自建机型定义
    best: {},                  // `${mapId}:${mode}` -> { score, time, date }
    stats: { flights: 0, landings: 0, crashes: 0, kills: 0, distance: 0, flightTime: 0, collected: 0, racesWon: 0 },
    settings: {
      quality: 1,               // 0 低 / 1 中 / 2 高
      shadows: true,
      musicVolume: 0.55,
      sfxVolume: 0.8,
      masterVolume: 0.9,
      muted: false,
      units: 'metric',
      invertPitch: false,
      sensitivity: 1.0,
      controlMode: 'mouse',
      showHud: true,
      showFps: false,
      cameraMode: 'chase',
      assist: 0.5,
      autoThrottle: false,
      showTutorial: true,
      // 联机
      serverUrl: '',          // 留空 = 同源 /ws
      turnUrl: '', turnUser: '', turnCred: '',
      playerName: 'Pilot',
    },
    collected: {},             // `${mapId}:${itemId}` -> true
    seenIntro: false,
  };
}

export class SaveManager {
  constructor() { this.profile = this.load(); }
  load() {
    const p = store.get(KEY, null);
    const def = defaultProfile();
    if (!p) return def;
    // 兼容合并
    return {
      ...def, ...p,
      stats: { ...def.stats, ...(p.stats || {}) },
      settings: { ...def.settings, ...(p.settings || {}) },
      best: { ...def.best, ...(p.best || {}) },
      collected: { ...def.collected, ...(p.collected || {}) },
      customCrafts: Array.isArray(p.customCrafts) ? p.customCrafts : [],
      unlockedMaps: Array.isArray(p.unlockedMaps) && p.unlockedMaps.length ? p.unlockedMaps : def.unlockedMaps,
    };
  }
  save() { return store.set(KEY, this.profile); }
  reset() { this.profile = defaultProfile(); this.save(); return this.profile; }

  get settings() { return this.profile.settings; }
  setSetting(k, v) { this.profile.settings[k] = v; this.save(); }

  addMoney(v) { this.profile.money = Math.max(0, this.profile.money + v); this.save(); }
  spend(v) { if (this.profile.money < v) return false; this.profile.money -= v; this.save(); return true; }
  addXp(v) {
    this.profile.xp += v;
    while (this.profile.xp >= this.profile.level * 1000) { this.profile.xp -= this.profile.level * 1000; this.profile.level++; }
    this.save();
  }

  recordBest(mapId, mode, entry) {
    const k = `${mapId}:${mode}`;
    const cur = this.profile.best[k];
    const better = !cur
      || (entry.time != null && (cur.time == null || entry.time < cur.time))
      || (entry.score != null && (cur.score == null || entry.score > cur.score));
    if (better) { this.profile.best[k] = { ...entry, date: Date.now() }; this.save(); }
    return better;
  }
  getBest(mapId, mode) { return this.profile.best[`${mapId}:${mode}`] || null; }

  addCustomCraft(craft) {
    const arr = this.profile.customCrafts;
    const i = arr.findIndex((c) => c.id === craft.id);
    if (i >= 0) arr[i] = deepClone(craft); else arr.push(deepClone(craft));
    this.save();
  }
  removeCustomCraft(id) {
    this.profile.customCrafts = this.profile.customCrafts.filter((c) => c.id !== id);
    this.save();
  }
  markCollected(mapId, itemId) { this.profile.collected[`${mapId}:${itemId}`] = true; this.save(); }
  isCollected(mapId, itemId) { return !!this.profile.collected[`${mapId}:${itemId}`]; }
  countCollected(mapId) {
    const pre = `${mapId}:`; let n = 0;
    for (const k in this.profile.collected) if (k.startsWith(pre)) n++;
    return n;
  }
}

export const save = new SaveManager();
