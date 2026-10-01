/**
 * 玩法模式 / 任务系统
 * ------------------------------------------------------------------
 * 每个模式继承 Mission，负责：布置目标、判定胜负、计分，并向 HUD 提供状态。
 * 依赖 Game 提供：terrain / landmarks / aircraft / player / projectiles / 通知接口。
 */
import * as THREE from 'three';
import { clamp, clamp01, lerp, fmtTime, makeRng } from '../core/util.js';
import { GAME_MODES } from '../world/maps.js';

const _v = new THREE.Vector3();

let msgSeq = 0;

export class Mission {
  /**
   * @param {object} game
   * @param {object} def { mode, ...params }
   */
  constructor(game, def) {
    this.game = game;
    this.def = def || { mode: 'free' };
    this.mode = this.def.mode || 'free';
    this.info = GAME_MODES[this.mode] || GAME_MODES.free;
    this.name = this.info.name;
    this.timeElapsed = 0;
    this.timeLimit = this.def.timeLimit ?? null;
    this.timerSec = this.timeLimit;
    this.score = 0;
    this.money = 0;
    this.progress = { current: 0, total: 1 };
    this.objective = this.info.desc;
    this.finished = false;
    this.success = false;
    this.messages = [];
    this.competitors = [];
    this.targets = [];
    this.entities = [];
    this.checkpoints = [];
    this.cargoHealth01 = 1;
    this.cargoCount = 0;
    this.failReason = '';
    this._notified = new Set();
  }

  /* ------------------------------------------------------------ 生命周期 */
  start() { }
  update(dt) {
    if (this.finished) return;
    this.timeElapsed += dt;
    if (this.timeLimit != null) {
      this.timerSec = Math.max(0, this.timeLimit - this.timeElapsed);
      if (this.timerSec <= 0) this.finish(false, '时间到');
    }
    for (const m of this.messages) m.ttl -= dt;
    this.messages = this.messages.filter((m) => m.ttl > 0);
  }
  finish(success, reason = '') {
    if (this.finished) return;
    this.finished = true;
    this.success = success;
    this.failReason = reason;
    this.game.onMissionFinished?.(this);
  }
  notify(text, kind = 'info', ttl = 4) {
    this.messages.push({ text, kind, ttl, id: ++msgSeq });
    if (this.messages.length > 6) this.messages.shift();
  }

  get player() { return this.game.player; }
  get terrain() { return this.game.terrain; }
  get landmarks() { return this.game.landmarks; }

  /** HUD 状态 */
  get hud() {
    return {
      name: this.name, mode: this.mode, objective: this.objective,
      progress: this.progress, timerSec: this.timerSec, timeElapsed: this.timeElapsed,
      score: this.score, money: this.money, best: this.game.bestFor?.(this.mode) ?? null,
      competitors: this.competitors, targets: this.targets, entities: this.entities,
      checkpoints: this.checkpoints, cargoHealth01: this.cargoHealth01, cargoCount: this.cargoCount,
      messages: this.messages, finishText: this.finished ? (this.success ? '任务完成' : '任务失败') : null,
    };
  }
}

/* ================================================================== 自由飞行 */
export class FreeFlightMission extends Mission {
  constructor(game, def) { super(game, def); this.progress = { current: 0, total: 1 }; this.objective = '自由探索 —— 熟悉你的飞机'; }
  update(dt) {
    super.update(dt);
    const p = this.player;
    if (p) this.score = Math.round(p.body.position.length() * 0.01);
  }
}

/* ================================================================== 收集 */
export class CollectMission extends Mission {
  start() {
    const items = this.landmarks?.collectibles || [];
    this.progress = { current: 0, total: Math.max(1, items.length) };
    this.objective = `找齐隐藏的机型与宝物（0/${items.length}）`;
  }
  update(dt) {
    super.update(dt);
    const p = this.player; if (!p) return;
    const items = this.landmarks?.collectibles || [];
    let n = 0;
    for (const it of items) {
      if (it.collected) { n++; continue; }
      if (it.position.distanceTo(p.body.position) < (it.radius || 16)) {
        it.collected = true;
        this.game.onCollect?.(it);
        this.score += 500; this.money += 250;
        n++;
        this.notify(`发现 ${it.name || '隐藏机型'}！ +500`, 'success');
      }
    }
    this.progress.current = n;
    this.objective = `找齐隐藏的机型与宝物（${n}/${items.length}）`;
    if (items.length && n >= items.length) this.finish(true, '全部收集完成');
  }
}

/* ================================================================== 竞速 */
export class RaceMission extends Mission {
  start() {
    // 若该地图没有预置光环，则按地形自动生成一条环形赛道
    let rings = this.landmarks?.raceRings || [];
    if (!rings.length && this.landmarks?.makeAirCircuit) {
      const lp = this.landmarks._primary?.() || { x: 0, z: 0 };
      const terrain = this.terrain;
      const cx = lp.x ?? 0, cz = lp.z ?? 0;
      const gy = terrain ? terrain.heightAt(cx, cz) : 0;
      const count = this.def.rings || 12;
      try {
        this.landmarks.makeAirCircuit(cx, cz, Math.min(3000, Math.max(900, (terrain?.size || 9000) * 0.18)), {
          count, altitude: Math.max(gy + 220, (terrain?.seaLevel ?? 0) + 220), variance: 130, ringRadius: 36,
        });
        rings = this.landmarks.raceRings;
        this.notify('已自动生成环形赛道', 'info', 3);
      } catch (e) { console.warn('[race] 自动赛道失败', e); }
    }
    this.rings = rings;
    this.laps = Math.max(1, this.def.laps || 1);
    this.lap = 0;
    this.next = 0;
    this.progress = { current: 0, total: rings.length * this.laps };
    this.objective = `穿过所有光环（第 1/${this.laps} 圈）`;
    for (const r of rings) r.passed = false;
    this.timeLimit = this.def.timeLimit ?? null;
    this.bestLap = Infinity;
    this.lapStart = 0;
    // 简单对手
    if (this.def.bots) {
      this.competitors = Array.from({ length: this.def.bots }, (_, i) => ({
        name: ['Ripley', 'Hoover', 'Vega', 'Kilo', 'Zephyr'][i % 5], score: 0, isPlayer: false,
        worldPos: new THREE.Vector3(), distance: 0,
      }));
    }
  }
  update(dt) {
    super.update(dt);
    const p = this.player; if (!p || !this.rings?.length) return;
    const r = this.rings[this.next];
    if (!r) return;
    r.isNext = true;
    const d = p.body.position.distanceTo(r.position);
    // 穿过判定（半径略放宽，手感更好）
    if (d < (r.radius || 35) * 1.18 + 5) {
      r.passed = true; r.isNext = false;
      this.next++;
      this.score += 250;
      this.game.onRingPass?.(this.next);
      if (this.next >= this.rings.length) {
        this.lap++;
        const lapTime = this.timeElapsed - this.lapStart;
        this.bestLap = Math.min(this.bestLap, lapTime);
        this.lapStart = this.timeElapsed;
        if (this.lap >= this.laps) {
          this.score += Math.max(0, Math.round((300 - this.timeElapsed) * 20));
          this.finish(true, `用时 ${fmtTime(this.timeElapsed)}`);
          return;
        }
        for (const rr of this.rings) rr.passed = false;
        this.next = 0;
        this.notify(`第 ${this.lap} 圈完成  ${fmtTime(lapTime)}`, 'success', 3.5);
      }
      this.progress.current = this.lap * this.rings.length + this.next;
      this.objective = `穿过所有光环（第 ${Math.min(this.lap + 1, this.laps)}/${this.laps} 圈，下一个 #${this.next + 1}）`;
    }
    // 落后提醒
    if (d > 2500 && !this._notified.has('far')) {
      this._notified.add('far');
      this.notify('飞回下一个光环！', 'warn', 3);
      setTimeout(() => this._notified.delete('far'), 6000);
    }
    // 对手（模拟）
    for (const c of this.competitors) {
      c.score += dt * (55 + Math.random() * 30);
    }
  }
}

/* ================================================================== 空战 */
export class CombatMission extends Mission {
  constructor(game, def) { super(game, def); this.total = def.enemies || 3; }
  start() {
    this.progress = { current: 0, total: this.total };
    this.objective = `击落所有敌机（0/${this.total}）`;
    this.spawned = 0;
    this.spawnTimer = 1.5;
    this.kills = 0;
    this.entities = [];
  }
  update(dt) {
    super.update(dt);
    this.spawnTimer -= dt;
    const alive = this.game.aircraft.filter((a) => a.team === 1 && !a.destroyed);
    if (this.spawned < this.total && this.spawnTimer <= 0 && alive.length < 3) {
      this.spawnTimer = 6;
      const ac = this.game.spawnEnemy({ skill: 0.35 + this.spawned * 0.12 });
      if (ac) {
        this.spawned++;
        if (this.spawned === 1) this.notify('敌机进入战区！', 'warn', 4);
        ac.pilot.behavior = 'dogfight';
      }
    }
    const p = this.player;
    if (p && p.destroyed) { this.finish(false, '你的飞机被击落'); return; }
    const remaining = this.total - this.kills;
    this.progress.current = this.kills;
    this.objective = `击落所有敌机（${this.kills}/${this.total}）`;
    const aliveEnemies = this.game.aircraft.filter((a) => a.team === 1 && !a.destroyed);
    this.entities = aliveEnemies.map((a) => ({
      id: a.uid, position: a.body.position, alive: true, health01: a.health, hostile: true,
      label: a.callsign, distance: p ? a.body.position.distanceTo(p.body.position) : 0,
    }));
    if (this.kills >= this.total) this.finish(true, '空域已清空');
  }
  onKill(victim, killer) {
    if (victim.team === 1 && killer === this.player) {
      this.kills++; this.score += 800; this.money += 600;
      this.notify('击落敌机！ +800', 'success');
      this.game.onKill?.(victim, killer);
    }
  }
}

/* ================================================================== 对地打击 */
export class StrikeMission extends Mission {
  constructor(game, def) { super(game, def); this.total = def.targets || 8; }
  start() {
    this.progress = { current: 0, total: this.total };
    this.objective = `摧毁地面目标（0/${this.total}）`;
    this.destroyed = 0;
    const cols = this.game.pickDestructibleTargets(this.total);
    this.tracked = cols;
    if (!cols.length) this.notify('本图没有可摧毁目标，已切换为自由飞行', 'warn', 5);
    // 防空炮
    this.aaSites = (this.landmarks?.turrets || []).slice(0, 4);
  }
  update(dt) {
    super.update(dt);
    let n = 0;
    this.targets = [];
    for (const c of this.tracked) {
      if (c.destroyed) n++;
      this.targets.push({ id: c.id, position: c.center, alive: !c.destroyed, health01: c.health01 ?? 1, team: 2, label: c.kind });
    }
    if (n !== this.destroyed) { this.score += (n - this.destroyed) * 400; this.money += (n - this.destroyed) * 250; }
    this.destroyed = n;
    this.progress.current = n;
    this.objective = `摧毁地面目标（${n}/${this.total}）`;
    const p = this.player;
    if (p && p.destroyed) { this.finish(false, '你的飞机被击落'); return; }
    if (n >= this.total) this.finish(true, '目标全部摧毁');
  }
}

/* ================================================================== 货运 */
export class CargoMission extends Mission {
  constructor(game, def) { super(game, def); this.total = def.crates || 3; }
  start() {
    this.progress = { current: 0, total: this.total };
    this.objective = '起飞前往取货点';
    this.phase = 'pickup';
    this.index = 0;
    this.delivered = 0;
    this.cargoHealth01 = 1;
    const anchors = this.landmarks?.anchors || {};
    this.pickups = (anchors.cargo || []).slice(0, this.total);
    this.dropzones = (anchors.dropzones || []).slice(0, this.total);
    if (!this.pickups.length) {
      // 退化：用着陆点当取货点
      this.pickups = (anchors.landingPads || []).slice(0, this.total);
    }
    for (const p of this.pickups) this.checkpoints.push({ index: this.checkpoints.length, position: p.position, radius: p.radius || 40, passed: false, isNext: true, label: '取货' });
    for (const p of this.dropzones) this.checkpoints.push({ index: this.checkpoints.length, position: p.position, radius: p.radius || 40, passed: false, isNext: false, label: '投放' });
  }
  update(dt) {
    super.update(dt);
    const p = this.player; if (!p) return;
    const anchors = this.landmarks?.anchors || {};
    const crates = anchors.cargo || [];
    // 取货：低速经过取货点
    if (this.phase === 'pickup') {
      const target = this.pickups[this.index];
      for (const c of this.checkpoints) c.isNext = (c.label === '取货' && c.position === target?.position);
      if (target) {
        const d = p.body.position.distanceTo(target.position);
        const agl = p.state.altitudeAGL;
        if (d < (target.radius || 40) && agl < 60 && p.state.speed < 60) {
          this.phase = 'deliver';
          this.cargoCount = 1;
          this.notify('货物已装载，前往投放区', 'success');
          const cpHit = this.checkpoints.find((c) => c.position === target.position);
          if (cpHit) cpHit.passed = true;
        }
      }
      this.objective = '低空低速通过取货点装载货物';
    } else {
      const target = this.dropzones[this.index];
      const cp = this.checkpoints.filter((c) => c.label === '投放')[this.index];
      for (const c of this.checkpoints) c.isNext = (c === cp);
      if (target) {
        const d = p.body.position.distanceTo(target.position);
        const agl = p.state.altitudeAGL;
        const gentle = p.state.verticalSpeed > -6;
        if (d < (target.radius || 40) && agl < 45 && p.state.speed < 55 && gentle) {
          this.delivered++; this.index++; this.cargoCount = 0;
          this.score += 700 + Math.round(this.cargoHealth01 * 300);
          this.money += 500;
          if (cp) cp.passed = true;
          this.notify(`第 ${this.delivered} 批货物送达！`, 'success');
          this.phase = this.index >= this.total ? 'done' : 'pickup';
          if (this.phase === 'done') { this.finish(true, '全部货物送达'); return; }
        }
      }
      this.objective = `把货物送到投放区（${this.delivered}/${this.total}）`;
      // 货物损坏：粗暴机动
      const rough = Math.abs(p.state.gForce - 1) > 4 || p.state.verticalSpeed < -18 || p.state.speed > 200;
      if (rough) {
        this.cargoHealth01 = clamp01(this.cargoHealth01 - dt * 0.12);
        if (this.cargoHealth01 <= 0.05 && !this._notified.has('cargoDead')) {
          this._notified.add('cargoDead');
          this.finish(false, '货物损坏');
        }
      }
    }
    this.progress.current = this.delivered;
  }
}

/* ================================================================== 降落挑战 */
export class LandingMission extends Mission {
  constructor(game, def) { super(game, def); this.total = def.pads || 3; }
  start() {
    const anchors = this.landmarks?.anchors || {};
    const pads = (anchors.landingPads || []).slice(0, this.total);
    this.pads = pads;
    this.landedPads = new Set();
    this.checkpoints = pads.map((p, i) => ({ index: i, position: p.position, radius: p.radius || 45, passed: false, isNext: i === 0, label: p.name }));
    this.progress = { current: 0, total: pads.length || 1 };
    this.objective = '前往第一个降落点';
    this.wasAirborne = false;
    this.touchdownRate = 0;
    this.crashed = false;
  }
  update(dt) {
    super.update(dt);
    const p = this.player; if (!p) return;
    if (p.state.altitudeAGL > 8) this.wasAirborne = true;
    this.checkpoints.forEach((c, i) => { c.isNext = !this.landedPads.has(i) && [...this.landedPads].length === i; });
    if (!this.wasAirborne) return;
    if (p.groundContact && p.state.speed < 12 && p.state.health01 > 0.35) {
      const pos = p.body.position;
      for (let i = 0; i < this.pads.length; i++) {
        if (this.landedPads.has(i)) continue;
        const pad = this.pads[i];
        if (pos.distanceTo(pad.position) < (pad.radius || 45) + 25) {
          this.landedPads.add(i);
          const rate = Math.abs(this.lastVs || 0);
          const quality = clamp01(1 - rate / 6);
          const pts = Math.round(300 + quality * 700);
          this.score += pts; this.money += Math.round(pts * 0.6);
          if (i < this.checkpoints.length) this.checkpoints[i].passed = true;
          this.notify(`着陆成功！下降率 ${rate.toFixed(1)} m/s，+${pts}`, quality > 0.6 ? 'success' : 'warn', 4);
          this.wasAirborne = false;
          this.progress.current = this.landedPads.size;
          if (this.landedPads.size >= this.pads.length) { this.finish(true, '全部降落点完成'); return; }
          break;
        }
      }
    }
    if (p.destroyed) { this.finish(false, '坠毁'); return; }
    this.lastVs = p.state.verticalSpeed;
    this.objective = `降落挑战（${this.landedPads.size}/${this.pads.length}）`;
  }
}

/* ================================================================== 航母起降 */
export class CarrierMission extends Mission {
  start() {
    const anchors = this.landmarks?.anchors || {};
    this.deck = (anchors.landingPads || []).find((p) => /carrier|航母|deck/i.test(p.name || '')) || (anchors.landingPads || [])[0];
    this.progress = { current: 0, total: 2 };
    this.phase = 'takeoff';
    this.objective = this.deck ? '从航母弹射起飞' : '找到航母';
    this.checkpoints = this.deck ? [{ index: 0, position: this.deck.position, radius: this.deck.radius || 80, passed: false, isNext: true, label: '航母' }] : [];
    this.airborneTime = 0;
  }
  update(dt) {
    super.update(dt);
    const p = this.player; if (!p || !this.deck) return;
    const d = p.body.position.distanceTo(this.deck.position);
    const agl = p.state.altitudeAGL;
    if (this.phase === 'takeoff') {
      if (agl > 60) { this.phase = 'pattern'; this.objective = '绕场一圈后返回着舰'; this.notify('已升空，绕场后着舰', 'info', 4); }
    } else if (this.phase === 'pattern') {
      this.airborneTime += dt;
      if (this.airborneTime > 8 && d < (this.deck.radius || 80) + 40 && agl < 25 && p.state.speed < 90) {
        this.phase = 'landed';
        this.score += 1500; this.money += 900;
        this.progress.current = 1;
        this.notify('着舰成功！+1500', 'success', 4);
        this.phase = 'done';
        this.finish(true, '航母起降完成');
      }
    }
    this.progress.current = this.phase === 'takeoff' ? 0 : 1;
  }
}

/* ================================================================== 导弹试验 */
export class MissileMission extends Mission {
  constructor(game, def) { super(game, def); this.total = def.targets || 6; }
  start() {
    this.missiles = 0;
    this.destroyed = 0;
    this.progress = { current: 0, total: this.total };
    this.objective = `用导弹摧毁靶标（0/${this.total}）`;
    const cols = this.game.pickDestructibleTargets(this.total);
    this.tracked = cols;
  }
  update(dt) {
    super.update(dt);
    let n = 0;
    this.targets = this.tracked.map((c) => {
      if (c.destroyed) n++;
      return { id: c.id, position: c.center, alive: !c.destroyed, health01: c.health01 ?? 1, team: 2, label: '靶标' };
    });
    if (n !== this.destroyed) { this.score += (n - (this.destroyed || 0)) * 600; this.money += (n - (this.destroyed || 0)) * 300; }
    this.destroyed = n;
    this.progress.current = n;
    this.objective = `用导弹摧毁靶标（${n}/${this.total}）`;
    if (n >= this.total) this.finish(true, '靶标全部摧毁');
    const p = this.player;
    if (p && p.destroyed) this.finish(false, '坠毁');
  }
}

/* ================================================================== 地面竞速 */
export class GroundRaceMission extends RaceMission {
  start() {
    const anchors = this.landmarks?.anchors || {};
    let cps = (anchors.checkpoints || []).slice(0, this.def.checkpoints || 12);
    if (!cps.length) {
      // 退化：用降落点/兴趣点当作检查点
      cps = [...(anchors.landingPads || []), ...(anchors.checkpoints || [])];
    }
    this.rings = cps.map((c, i) => ({ index: i, position: c.position, radius: c.radius || 40, passed: false, isNext: i === 0, object: null, ground: true }));
    this.laps = 1; this.lap = 0; this.next = 0;
    this.progress = { current: 0, total: this.rings.length };
    this.objective = '沿赛道跑完全部检查点';
    this.timeLimit = this.def.timeLimit ?? null;
  }
}

/* ================================================================== 沙盒 */
export class SandboxMission extends Mission {
  start() {
    this.objective = '沙盒模式：无限燃料，随便撞';
    if (this.player) this.player.fuel = this.player.fuelCapacity = 9999;
    this.game.sandbox = true;
  }
}

/* ================================================================== 工厂 */
export function createMission(game, def) {
  switch (def.mode) {
    case 'race': return new RaceMission(game, def);
    case 'ground_race': return new GroundRaceMission(game, def);
    case 'combat': return new CombatMission(game, def);
    case 'strike': return new StrikeMission(game, def);
    case 'cargo': return new CargoMission(game, def);
    case 'landing': return new LandingMission(game, def);
    case 'carrier': return new CarrierMission(game, def);
    case 'collect': return new CollectMission(game, def);
    case 'missile': return new MissileMission(game, def);
    case 'sandbox': return new SandboxMission(game, def);
    default: return new FreeFlightMission(game, def);
  }
}
