/**
 * Game —— 游戏主控
 * ------------------------------------------------------------------
 * 负责：渲染器/场景、世界加载（地形+地标+天空+天气）、飞机与 AI 管理、
 * 武器系统、任务模式、相机、音效驱动，以及对外事件。
 */
import * as THREE from 'three';
import { Terrain } from '../world/terrain.js';
import { Landmarks } from '../world/landmarks.js';
import { SkyDome, Weather } from '../world/sky.js';
import { WindField } from '../world/wind.js';
import { terrainOptions } from '../world/maps.js';
import { Aircraft } from '../flight/aircraft.js';
import { ProjectileManager } from '../flight/projectiles.js';
import { AIPilot } from '../flight/ai.js';
import { createMission } from './modes.js';
import { audio, SFX_NAMES } from '../audio/audio.js';
import { Emitter, clamp, clamp01, damp, lerp, makeRng, TAU } from '../core/util.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/* ================================================================== 相机 */
export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'chase';        // chase | cockpit | orbit | free | cinematic
    this.chaseDist = 14;
    this.chaseHeight = 4.2;
    this.smooth = 6.0;
    this.orbit = { yaw: 0, pitch: 0.35, dist: 40 };
    this.freePos = new THREE.Vector3();
    this.freeRot = new THREE.Euler();
    this.shake = 0;
    this.fov = 68;
    this.baseFov = 68;
    this._lookAt = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._targetQuat = new THREE.Quaternion();
    this.cockpitOffset = new THREE.Vector3(0, 0.6, -1.2);
    this.initialized = false;
  }
  setMode(m) { this.mode = m; this.initialized = false; }
  addShake(v) { this.shake = Math.min(1.2, this.shake + v); }

  update(dt, aircraft, mission) {
    const cam = this.camera;
    if (!aircraft) {
      if (!this.initialized) { cam.position.set(0, 300, 600); cam.lookAt(0, 0, 0); this.initialized = true; }
      return;
    }
    const body = aircraft.body;
    const speed = body.velocity.length();
    // 抖振：低速/失速/加力时更明显
    const buffet = aircraft.state.stall ? 0.5 : Math.max(0, speed - 240) * 0.0016 + (aircraft.controls.throttle > 0.95 && aircraft.engines.some((e) => e.type === 'jet') ? 0.05 : 0);
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const shakeAmt = (this.shake + buffet) * 0.35;

    if (this.mode === 'cockpit') {
      const off = _v.copy(this.cockpitOffset).applyQuaternion(body.quaternion).add(body.position);
      cam.position.copy(off);
      cam.quaternion.copy(body.quaternion);
      // 轻微滞后，避免完全硬绑定
      cam.rotateY(-aircraft.controls.yaw * 0.05);
      this.fov = this.baseFov + clamp(speed / 30, 0, 12);
    } else if (this.mode === 'chase') {
      const dist = this.chaseDist + clamp(speed * 0.045, 0, 12);
      const desired = _v.set(0, this.chaseHeight, dist).applyQuaternion(body.quaternion).add(body.position);
      if (!this.initialized) { cam.position.copy(desired); this.initialized = true; }
      // 地面/水面避让
      const gy = this._groundY(desired.x, desired.z);
      if (desired.y < gy + 2.5) desired.y = gy + 2.5;
      const k = 1 - Math.exp(-this.smooth * dt);
      cam.position.lerp(desired, k);
      this.camera.lookAt(_v2.copy(body.position).addScaledVector(body.velocity, 0.06));
      // 滚转混合到相机（30%）
      _q.copy(body.quaternion);
      _e.setFromQuaternion(_q, 'YXZ');
      _e.z *= 0.32;
      const blend = new THREE.Quaternion().setFromEuler(_e);
      const look = new THREE.Matrix4().lookAt(cam.position, _v2.copy(body.position).addScaledVector(body.velocity, 0.06), _v3.set(0, 1, 0).applyQuaternion(blend));
      const q2 = new THREE.Quaternion().setFromRotationMatrix(look);
      cam.quaternion.slerp(q2, 1 - Math.exp(-8 * dt));
      this.fov = this.baseFov + clamp(speed * 0.06, 0, 16);
    } else if (this.mode === 'orbit') {
      const d = this.orbit.dist;
      const p = _v.set(
        Math.sin(this.orbit.yaw) * Math.cos(this.orbit.pitch) * d,
        Math.sin(this.orbit.pitch) * d,
        Math.cos(this.orbit.yaw) * Math.cos(this.orbit.pitch) * d
      ).add(body.position);
      cam.position.lerp(p, 1 - Math.exp(-10 * dt));
      cam.lookAt(body.position);
      this.fov = this.baseFov;
    } else {
      this.fov = this.baseFov;
    }
    if (this.shake > 0.001) {
      cam.position.x += (Math.random() - 0.5) * shakeAmt;
      cam.position.y += (Math.random() - 0.5) * shakeAmt;
      cam.position.z += (Math.random() - 0.5) * shakeAmt;
    }
    if (Math.abs(cam.fov - this.fov) > 0.05) { cam.fov = damp(cam.fov, this.fov, 6, dt); cam.updateProjectionMatrix(); }
  }
  _groundY(x, z) { return this.terrainRef ? this.terrainRef.heightAt(x, z) : 0; }
}

/* ================================================================== Game */
export class Game extends Emitter {
  constructor(canvas, opts = {}) {
    super();
    this.canvas = canvas;
    this.opts = opts;
    this.quality = opts.quality ?? 1;
    this.headless = !!opts.headless;
    if (this.headless) {
      // 无 GPU 环境（自动化测试）：用桩渲染器
      this.renderer = {
        shadowMap: { enabled: false, type: null },
        domElement: canvas, outputColorSpace: null, toneMapping: null, toneMappingExposure: 1,
        setPixelRatio() { }, setSize() { }, render() { }, dispose() { }, getContext: () => null,
      };
    } else {
      try {
        this.renderer = new THREE.WebGLRenderer({
          canvas, antialias: this.quality >= 1, powerPreference: 'high-performance',
          stencil: false, logarithmicDepthBuffer: false,
        });
        this.webglAvailable = true;
      } catch (e) {
        // WebGL 不可用：降级为桩渲染器，让游戏逻辑仍可运行（并提示用户）
        console.error('[game] WebGL 不可用，已降级:', e);
        this.headless = true;
        this.webglAvailable = false;
        this.renderer = {
          shadowMap: { enabled: false, type: null },
          domElement: canvas, outputColorSpace: null, toneMapping: null, toneMappingExposure: 1,
          setPixelRatio() { }, setSize() { }, render() { }, dispose() { }, getContext: () => null,
        };
        this.renderError = e;
      }
      this.renderer.setPixelRatio(Math.min((globalThis.devicePixelRatio || 1), this.quality >= 2 ? 2 : 1.5));
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.05;
      this.renderer.shadowMap.enabled = this.quality >= 1 && opts.shadows !== false;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(68, 1, 0.35, 42000);
    this.camera.position.set(0, 300, 600);
    this.rig = new CameraRig(this.camera);
    this.rig.terrainRef = null;

    this.aircraft = [];
    this.player = null;
    this.terrain = null;
    this.landmarks = null;
    this.sky = null;
    this.weather = null;
    this.mapDef = null;
    this.projectiles = null;
    this.mission = null;
    this.sandbox = false;
    this.timeScale = 1;
    this.paused = false;
    this.physicsAccum = 0;
    this.fixedStep = 1 / 120;
    this.maxSubSteps = 5;
    this.clock = 0;
    this.wind = new THREE.Vector3();
    this.windField = null;
    /** 风场采样回调（供 Aircraft 逐机使用；无风场时退回常量风） */
    this.windAt = (x, y, z, out) => (this.windField ? this.windField.sample(x, y, z, out) : out.copy(this.wind));
    this.gravity = 9.81;
    this.stats = { fps: 0, frameMs: 0 };
    this._fpsAccum = 0; this._fpsCount = 0;
    this._env = null;
    this.distanceFlown = 0;
    this._lastPlayerPos = new THREE.Vector3();
    this.onMissionFinished = null;
    this._audioIds = new Set();
    this.resize();
  }

  /* ------------------------------------------------------------ 世界加载 */
  async loadWorld(mapDef, { quality = this.quality, onProgress = () => { } } = {}) {
    this.mapDef = mapDef;
    this.quality = quality;
    onProgress(0.02, '准备场景…');
    this.unloadWorld();

    const opts = terrainOptions(mapDef, quality);
    onProgress(0.08, '生成地形…');
    await frame();
    this.terrain = new Terrain(opts);
    this.terrain.build(this.scene);
    this.rig.terrainRef = this.terrain;
    // 风场（基础风 + 高度梯度 + 地形爬坡气流 + 阵风湍流）
    this.windField = WindField.fromMap(mapDef, this.terrain);
    onProgress(0.45, '搭建地标…');
    await frame();

    this.landmarks = new Landmarks(this.terrain, {
      kit: mapDef.kit, seed: mapDef.id.length * 7919 + mapDef.size, density: quality >= 1 ? 0.7 : 0.45,
      water: mapDef.water !== false,
    });
    this.landmarks.build(this.scene);
    onProgress(0.8, '布置天空与天气…');
    await frame();

    this.sky = new SkyDome(this.scene, {
      timeOfDay: mapDef.timeOfDay ?? 0.4, cloudiness: mapDef.cloudiness ?? 0.4,
      radius: Math.min(13000, Math.max(7000, mapDef.size * 0.8)), shadows: this.renderer.shadowMap.enabled,
      shadowDistance: 420,
      // PMREMGenerator 必须拿到真实 WebGLRenderer 才能跑预处理着色器；
      // 之前没传 → new PMREMGenerator(null) → fromEquirectangular() 静默失败，
      // 于是 scene.environment 永远是 null，金属/玻璃完全没有环境反射。
      // 无头模式用桩渲染器，传 false 直接跳过 IBL。
      renderer: this.headless ? null : this.renderer,
      pmrem: !this.headless,
    });
    this.weather = new Weather(this.scene, { type: mapDef.weather || 'none', count: quality >= 2 ? 3600 : 1800 });
    this.projectiles = new ProjectileManager(this.scene, {
      onEvent: (type, data) => this._onProjectileEvent(type, data),
    });
    onProgress(0.94, '完成…');
    await frame();
    this.emit('world:loaded', { map: mapDef });
    onProgress(1, '');
    return this;
  }

  unloadWorld() {
    for (const ac of this.aircraft) ac.dispose?.();
    this.aircraft.length = 0;
    this.windField = null;
    this.player = null;
    this.projectiles?.dispose(); this.projectiles = null;
    this.landmarks?.dispose(); this.landmarks = null;
    this.terrain?.dispose(); this.terrain = null;
    this.weather?.dispose(); this.weather = null;
    this.sky?.dispose(); this.sky = null;
    this.mission = null;
    for (const id of this._audioIds) audio.engineSet(id, { active: false });
    this._audioIds.clear();
  }

  /* ------------------------------------------------------------ 飞机 */
  /**
   * 生成一架飞机
   * @param {object} craftDef
   * @param {object} o { isPlayer, position, heading, speed, team, callsign, ai, fuel01 }
   */
  spawnAircraft(craftDef, o = {}) {
    const ac = new Aircraft(craftDef, {
      isPlayer: !!o.isPlayer,
      callsign: o.callsign || (o.isPlayer ? 'You' : 'Bandit'),
      team: o.team ?? (o.isPlayer ? 0 : 1),
      position: o.position ? o.position.clone() : new THREE.Vector3(0, 500, 0),
      heading: o.heading ?? 0,
      assist: o.assist ?? (o.isPlayer ? 0.5 : 1),
      shadows: this.renderer.shadowMap.enabled,
      fuel01: o.fuel01 ?? 1,
      onEvent: (type, data) => this._onAircraftEvent(type, data),
    });
    ac.body.velocity.set(0, 0, -1).applyQuaternion(_q.setFromEuler(_e.set(0, o.heading ?? 0, 0))).multiplyScalar(o.speed ?? 0);
    if (o.position) ac.body.position.copy(o.position);
    this.scene.add(ac.group);
    this.aircraft.push(ac);
    if (o.isPlayer) this.player = ac;
    if (o.remote) { ac.remote = true; }
    if (o.ai) {
      ac.pilot = new AIPilot(ac, {
        skill: o.skill ?? 0.5, behavior: o.behavior || 'patrol',
        waypoints: o.waypoints, targetPoint: o.targetPoint, homePoint: o.homePoint,
        cruiseAlt: o.cruiseAlt, waypointRadius: o.waypointRadius,
      });
    }
    this.emit('aircraft:spawned', ac);
    return ac;
  }

  /** 在玩家附近生成一架敌机 */
  spawnEnemy(o = {}) {
    const p = this.player;
    const crafts = this.opts.enemyCrafts || [];
    if (!crafts.length) return null;
    const craft = crafts[Math.floor(Math.random() * crafts.length)];
    const ang = Math.random() * TAU;
    const dist = 900 + Math.random() * 900;
    const base = p ? p.body.position : new THREE.Vector3(0, 600, 0);
    const alt = clamp(base.y + (Math.random() - 0.4) * 300, 120, 2600);
    const pos = new THREE.Vector3(base.x + Math.cos(ang) * dist, alt, base.z + Math.sin(ang) * dist);
    if (this.terrain) pos.y = Math.max(pos.y, this.terrain.heightAt(pos.x, pos.z) + 180);
    const heading = Math.atan2(-(base.x - pos.x), -(base.z - pos.z));
    const ac = this.spawnAircraft(craft, {
      position: pos, heading, speed: 110, team: 1, callsign: 'Bandit-' + (1 + Math.floor(Math.random() * 9)),
      ai: true, skill: o.skill ?? 0.45, behavior: 'dogfight', homePoint: base.clone(),
    });
    if (ac.pilot && this.player) ac.pilot.setTarget(this.player);
    return ac;
  }

  removeAircraft(ac) {
    const i = this.aircraft.indexOf(ac);
    if (i >= 0) this.aircraft.splice(i, 1);
    ac.dispose?.();
    if (ac === this.player) this.player = null;
  }

  /** 把玩家放到出生点 */
  /**
   * 把玩家送回出生点并**完整修复飞机**（对齐原版：重置 = 换一架完好的新飞机）。
   * 无论之前是擦伤、掉件还是已经炸成碎片，都会恢复成满血可飞的状态。
   */
  resetPlayerToSpawn(spawnName = 'main', craftDef = null) {
    const p = this.player;
    if (!p) return;
    const sp = this._spawnPoint(spawnName);
    const gy = this.terrain ? this.terrain.heightAt(sp.position.x, sp.position.z) : 0;
    // 先做完整修复（零件/动力/武器/燃油/质量/惯性全部复位），再摆到跑道上
    p.reset(new THREE.Vector3(sp.position.x, gy + 60, sp.position.z), sp.heading || 0, 0);
    p.placeOnGround(this.terrain, sp.position.x, sp.position.z, sp.heading || 0);
    p.body.position.y = Math.max(p.body.position.y, gy + p.getRestHeight());
    // 相机立刻跟过去，避免从残骸位置慢慢飞过来
    this.rig.initialized = false;
    this.physicsAccum = 0;
    this.emit('player:reset', p);
    audio.sfx('engine_start');
  }

  _spawnPoint(name) {
    const sps = this.terrain?.spawnPoints || [];
    return sps.find((s) => s.name === name) || sps[0] || { name: 'main', position: new THREE.Vector3(0, 200, 0), heading: 0 };
  }

  /**
   * 生成玩家飞机（统一入口）
   * @param {object} craftDef
   * @param {object} o { air, height, speed, spawnName, assist, fuel01 }
   */
  spawnPlayerAircraft(craftDef, o = {}) {
    const sp = this._spawnPoint(o.spawnName || 'main');
    const heading = sp.heading || 0;
    const assist = o.assist ?? 0.5;
    if (o.air) {
      const pos = sp.position.clone();
      pos.y += (o.height ?? 600);
      const ac = this.spawnAircraft(craftDef, { isPlayer: true, position: pos, heading, speed: o.speed ?? 140, assist, fuel01: o.fuel01 });
      return ac;
    }
    const ac = this.spawnAircraft(craftDef, { isPlayer: true, position: sp.position.clone().setY(sp.position.y + 3), heading, speed: 0, assist, fuel01: o.fuel01 });
    ac.placeOnGround(this.terrain, sp.position.x, sp.position.z, heading);
    ac.body.position.y = Math.max(ac.body.position.y, (this.terrain ? this.terrain.heightAt(sp.position.x, sp.position.z) : 0) + ac.getRestHeight() * 0.6);
    return ac;
  }

  /** 在空中生成一架飞机（敌机/僚机） */
  spawnInAir(craftDef, { height = 700, speed = 130, heading = 0, offset = 0, team = 1, ai = false, skill = 0.5 } = {}) {
    const sp = this._spawnPoint('main');
    const pos = new THREE.Vector3(sp.position.x + offset * 60, 0, sp.position.z + offset * 60);
    pos.y = (this.terrain ? this.terrain.heightAt(pos.x, pos.z) : 0) + height;
    return this.spawnAircraft(craftDef, { position: pos, heading, speed, team, ai, skill, assist: 1 });
  }

  /* ------------------------------------------------------------ 任务 */
  startMission(def) {
    this.mission = createMission(this, def || { mode: 'free' });
    this.mission.start();
    this.emit('mission:started', this.mission);
    return this.mission;
  }

  finishMission(success, reason) { this.mission?.finish(success, reason); }

  bestFor(mode) {
    const b = this.opts.getBest?.(this.mapDef?.id, mode);
    return b || null;
  }

  /** 挑选可摧毁的地标作为任务目标 */
  pickDestructibleTargets(n) {
    const cols = (this.landmarks?.colliders || []).filter((c) => c.destructible && !c.destroyed);
    if (!cols.length) return [];
    const rng = makeRng(1234 + (this.mapDef?.size || 0));
    // 优先选择分散的目标
    const shuffled = cols.slice();
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    const out = [];
    for (const c of shuffled) {
      if (out.length >= n) break;
      if (out.some((o) => o.center.distanceTo(c.center) < 180)) continue;
      out.push(c);
    }
    while (out.length < n && shuffled.length) out.push(shuffled[out.length % shuffled.length]);
    return out;
  }

  /* ------------------------------------------------------------ 事件 */
  _onProjectileEvent(type, data) {
    if (type === 'hit') {
      this.emit('combat:hit', data);
    } else if (type === 'kill') {
      // 武器模块给出的是 { target, owner }，统一成 victim/killer
      const victim = data.target, killer = data.owner;
      this.mission?.onKill?.(victim, killer);
      this.emit('combat:kill', { victim, killer, cause: data.cause });
      this.rig.addShake(0.25);
      if (victim === this.player) this.rig.addShake(1.0);
    } else if (type === 'explosion') {
      this.emit('fx:explosion', data);
    }
  }

  onKill(victim, killer) { this.emit('kill', { victim, killer }); }

  /** 切换天气（房主可改） */
  setWeather(type) {
    this.mapDef && (this.mapDef.weather = type);
    if (this.weather) { this.weather.dispose(); this.weather = null; }
    this.weather = new Weather(this.scene, { type: type || 'none', count: this.quality >= 2 ? 3600 : 1800 });
    this.emit('weather', type);
  }

  /** 切换一天中的时间 */
  setTimeOfDay(t) { this.sky?.setTimeOfDay(t); this.mapDef && (this.mapDef.timeOfDay = t); }

  /* ------------------------------------------------------------ 主循环 */
  update(dtRaw) {
    const t0 = (globalThis.performance?.now?.() ?? Date.now());
    const dt = Math.min(0.05, dtRaw) * this.timeScale;
    this.clock += dt;

    if (!this.paused && this.terrain) {
      // 固定步长物理
      this.physicsAccum += dt;
      let steps = 0;
      while (this.physicsAccum >= this.fixedStep && steps < this.maxSubSteps) {
        this._physicsStep(this.fixedStep);
        this.physicsAccum -= this.fixedStep;
        steps++;
      }
      if (this.physicsAccum > this.fixedStep * 8) this.physicsAccum = 0;
      this.mission?.update(dt);
      this.landmarks?.update(dt, this.clock, this.camera);
      this._updateTurrets(dt);
      this.terrain.update(dt);
      // 风场推进（阵风包络/风向摆动），再取一次玩家所在位置的风供 HUD/音效用
      if (this.windField) {
        this.windField.update(dt);
        const p = this.player?.body.position || this.camera.position;
        this.windField.horizontal && this.wind.copy(this.windField.sample(p.x, p.y, p.z, this.wind));
      }
    }

    // 相机
    this.rig.update(dt, this.player, this.mission);
    // 天空/天气跟随
    this.sky?.update(dt, this.camera, this.camera.position);
    this.weather?.update(dt, this.camera.position);

    // 音频
    this._updateAudio(dt);

    // 阴影/雾随高度
    if (this.sky) {
      const alt = this.player?.body.position.y ?? 0;
      this.sky.fog.density = clamp(0.00007 + Math.max(0, 1 - alt / 3000) * 0.00006, 0.00003, 0.0004);
    }

    // 统计
    this._fpsAccum += dtRaw; this._fpsCount++;
    if (this._fpsAccum >= 0.5) { this.stats.fps = this._fpsCount / this._fpsAccum; this._fpsAccum = 0; this._fpsCount = 0; }
    this.stats.frameMs = (globalThis.performance?.now?.() ?? Date.now()) - t0;
  }

  _physicsStep(dt) {
    const env = this._env || (this._env = {});
    env.terrain = this.terrain;
    env.landmarks = this.landmarks;
    env.projectiles = this.projectiles;
    env.gravity = this.gravity;
    env.wind = this.wind;
    // 风场：随位置/高度/地形变化（高度梯度、迎风坡上升、阵风湍流）
    env.windAt = this.windAt;
    env.targets = this.aircraft;
    env.onEvent = (type, data) => this._onAircraftEvent(type, data);
    env.onImpact = (ac, point, strength, col) => this._onImpact(ac, point, strength, col);

    for (const ac of this.aircraft) {
      if (ac.remote) { ac.updateVisualTransform(dt); continue; }   // 远端玩家由联机层插值驱动
      if (!ac.destroyed) {
        ac.update(dt, env);
        if (this.sandbox) { ac.fuel = ac.fuelCapacity; ac.health = 1; }
      } else {
        ac.updateDebris(dt, this.terrain);
      }
    }
    // AI
    for (const ac of this.aircraft) {
      if (ac.pilot && !ac.destroyed) {
        ac.pilot.update(dt, { terrain: this.terrain, landmarks: this.landmarks, aircraft: this.aircraft });
      }
    }
    // 玩家距离统计
    if (this.player) {
      this.distanceFlown += this.player.body.position.distanceTo(this._lastPlayerPos);
      this._lastPlayerPos.copy(this.player.body.position);
    }
    this.projectiles?.update(dt, { terrain: this.terrain, landmarks: this.landmarks, aircraft: this.aircraft });
    // 清理坠毁很久的残骸
    for (let i = this.aircraft.length - 1; i >= 0; i--) {
      const ac = this.aircraft[i];
      if (ac.destroyed && ac !== this.player) {
        ac._deadTime = (ac._deadTime || 0) + dt;
        if (ac._deadTime > 12) this.removeAircraft(ac);
      }
    }
  }

  /** 防空炮塔：对进入射程的玩家（team 0）开火 */
  _updateTurrets(dt) {
    const turrets = this.landmarks?.turrets;
    if (!turrets?.length || !this.projectiles) return;
    for (const t of turrets) {
      if (t.destroyed || (t.health != null && t.health <= 0)) continue;
      if ((t.cooldown ?? 0) > 0) continue;
      const tp = t.position || t.object?.position;
      if (!tp) continue;
      const range = t.range || 900;
      // 找最近的 team 0 飞机
      let best = null, bestD = Infinity;
      for (const ac of this.aircraft) {
        if (ac.destroyed || ac.team !== 0) continue;
        const d = ac.body.position.distanceTo(tp);
        if (d < range && d < bestD) { bestD = d; best = ac; }
      }
      if (!best) continue;
      const aim = _v.copy(best.body.position).addScaledVector(best.body.velocity, bestD / 700 * 0.5).sub(tp).normalize();
      // 命中率随距离下降
      const spread = 0.012 + bestD / range * 0.02;
      aim.x += (Math.random() - 0.5) * spread;
      aim.y += (Math.random() - 0.5) * spread;
      aim.z += (Math.random() - 0.5) * spread;
      aim.normalize();
      this.projectiles.spawnBullet(tp, aim, new THREE.Vector3(), 780, 9, t);
      t.cooldown = 0.9 + Math.random() * 1.1;
      if (bestD < 1400) audio.sfx('cannon', { position: tp, volume: 0.35 });
    }
  }

  /**
   * 飞机事件 → 音效 / 特效 / 计分。
   * 新增音效若当前音频模块还没有（例如 'metal_break'），自动退回一个已有的近似音。
   */
  _onAircraftEvent(type, data) {
    const sfx = (name, fallback, opts) => {
      const n = SFX_NAMES ? (SFX_NAMES.includes(name) ? name : (SFX_NAMES.includes(fallback) ? fallback : null)) : name;
      if (n) audio.sfx(n, opts);
    };
    switch (type) {
      case 'gun': audio.sfx('gun', { position: data.position, volume: 0.5 }); break;
      case 'missile': audio.sfx('missile_launch', { position: data.position }); break;
      case 'chute': sfx('parachute', 'whoosh', { position: data.aircraft.body.position }); break;
      // ---- 损毁 ----
      case 'scrape':                       // 机腹/零件蹭地
        sfx('scrape', 'squeal', { position: data.position, volume: clamp01(0.25 + (data.speed || 0) / 40) });
        break;
      case 'partLost': {                   // 零件脱落
        const kind = data.kind;
        if (kind === 'wing') sfx('wing_tear', 'crash', { position: data.position, volume: 0.9 });
        else if (kind === 'engine') sfx('engine_sputter', 'crash', { position: data.position, volume: 0.8 });
        else sfx('metal_break', 'crash', { position: data.position, volume: 0.75 });
        sfx('damage_alarm', 'alarm', { position: data.position, volume: 0.45 });
        if (this.projectiles) this.projectiles.explosion?.(data.position, 0.35);
        if (data.aircraft === this.player) this.rig.addShake(0.35);
        this.emit('fx:partLost', data);
        break;
      }
      case 'debris':                       // 碎片落地
        sfx('debris_fall', 'thud', { position: data.position, volume: 0.5 });
        break;
      case 'hullHit': {                    // 被武器命中
        const big = data.cause !== 'bullet';
        sfx(big ? 'hull_hit_big' : 'hull_hit', big ? 'thud' : 'click', {
          position: data.position, volume: big ? 0.9 : 0.32,
        });
        if (data.aircraft === this.player) { this.rig.addShake(big ? 0.7 : 0.15); this.emit('combat:playerHit', data); }
        break;
      }
      case 'destroyed': {                  // 整机爆炸
        sfx('explosion_big', 'explosion', { position: data.position, volume: 1 });
        sfx('crash', 'thud', { position: data.position, volume: 0.9 });
        if (this.projectiles) this.projectiles.explosion?.(data.position, 2.6);
        if (data.aircraft === this.player) this.rig.addShake(1.2);
        this.emit('aircraft:destroyed', data);
        break;
      }
      default: break;
    }
    this.emit('aircraft:event', { type, data });
  }

  _onImpact(ac, point, strength, col) {
    const s = clamp01(strength / 40);
    if (s < 0.08) return;
    audio.sfx(strength > 22 ? 'crash' : 'thud', { position: point, volume: clamp01(0.3 + s) });
    this.projectiles?.explosion?.(point, 0.4 + s * 1.6);
    if (ac === this.player) this.rig.addShake(s * 0.8);
    this.emit('impact', { aircraft: ac, point, strength, collider: col });
  }

  _updateAudio(dt) {
    const cam = this.camera.position;
    audio.setListener(cam, this.camera.getWorldDirection(_v).multiplyScalar(60));
    // 每架飞机的发动机
    for (const ac of this.aircraft) {
      for (const e of ac.engines) {
        const dist = e.position.distanceTo(ac.body.position);
        audio.engineSet(ac.uid + ':' + e.id, {
          active: !ac.destroyed && e.rpm01 > 0.02,
          type: e.type,
          rpm01: e.rpm01,
          throttle01: e.throttle01,
          position: _v2.copy(e.position).applyQuaternion(ac.body.quaternion).add(ac.body.position),
        });
        this._audioIds.add(ac.uid + ':' + e.id);
      }
    }
    const p = this.player;
    if (p) {
      const spd = p.state.speed;
      const g = p.controls.gearT;
      audio.windSet(clamp01(spd / 160) * (0.35 + g * 0.3) + (p.state.stall ? 0.2 : 0));
      // 失速警告
      this._stallBeep = this._stallBeep || 0;
      this._stallBeep -= dt;
      if (p.state.stall && this._stallBeep <= 0) { audio.sfx('stall_warn', { volume: 0.5 }); this._stallBeep = 0.55; }
      if (p.state.altitudeAGL < 140 && p.state.verticalSpeed < -9 && !p.controls.gear) {
        this._pullBeep = (this._pullBeep || 0) - dt;
        if (this._pullBeep <= 0) { audio.sfx('pull_up', { volume: 0.6 }); this._pullBeep = 0.7; }
      }
    }
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const w = this.canvas?.clientWidth || (globalThis.innerWidth || 1280);
    const h = this.canvas?.clientHeight || (globalThis.innerHeight || 720);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  setQuality(q) {
    this.quality = q;
    this.renderer.setPixelRatio(Math.min((globalThis.devicePixelRatio || 1), q >= 2 ? 2 : q >= 1 ? 1.5 : 1));
    this.renderer.shadowMap.enabled = q >= 1;
    this.emit('quality:changed', q);
  }

  dispose() {
    this.unloadWorld();
    this.renderer.dispose();
    this.clear();
  }
}

function frame() { return new Promise((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 0))); }
