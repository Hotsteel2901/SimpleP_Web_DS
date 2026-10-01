/**
 * SimplePlanes 2 (three.js 复刻) —— 主程序
 * ------------------------------------------------------------------
 * 引导、状态机（菜单/飞行/机库）、主循环、全局按键、设置应用。
 */
import * as THREE from 'three';
import { Game } from './game/game.js';
import { Input } from './core/input.js';
import { save } from './core/save.js';
import { audio } from './audio/audio.js';
import { UI } from './ui/menu.js';
import { stockCrafts, defineCraft } from './build/crafts.js';
import { computeCraftStats } from './flight/aircraft.js';
import { getMap, GAME_MODES } from './world/maps.js';
import { Toast } from './ui/widgets.js';
import { MultiplayerSession } from './net/mp.js';
import { clamp, fmt, store } from './core/util.js';

/** HUD / Builder 采用动态导入，缺失时游戏仍可运行 */
let HUDClass = null, BuilderClass = null, TouchControlsClass = null;
try { ({ HUD: HUDClass } = await import('./ui/hud.js')); } catch (e) { console.warn('[main] HUD 模块不可用:', e.message); }
try { ({ Builder: BuilderClass } = await import('./ui/builder.js')); } catch (e) { console.warn('[main] Builder 模块不可用:', e.message); }
try { ({ TouchControls: TouchControlsClass } = await import('./ui/touch.js')); } catch (e) { console.warn('[main] TouchControls 模块不可用:', e.message); }

class App {
  constructor() {
    this.state = 'boot';
    this.save = save;             // 供 UI 访问档案
    this.airStart = false;
    this.currentCraft = null;
    this.currentMap = 'archipelago';
    this.currentMissionDef = { mode: 'free' };
    this.frameCount = 0;
    this._last = performance.now();

    // 画布
    this.canvas = document.getElementById('gl');
    this.game = new Game(this.canvas, {
      quality: save.settings.quality,
      shadows: save.settings.shadows,
      getBest: (mapId, mode) => save.getBest(mapId, mode),
      enemyCrafts: null,
    });
    this.game.onMissionFinished = (m) => this.onMissionFinished(m);
    this.game.on('kill', (d) => { if (this.mp?.status === 'playing' && d.victim === this.game.player) this.mp.reportKill('self'); });
    if (this.game.webglAvailable === false) {
      const box = document.getElementById('fatal');
      if (box) {
        box.style.display = 'flex';
        document.getElementById('fatalMsg').textContent =
          '无法创建 WebGL 上下文。请确认浏览器已启用硬件加速（WebGL2），然后刷新页面。\n\n' + (this.game.renderError?.message || '');
      }
    }

    this.input = new Input(this.canvas);
    this.input.mode = save.settings.controlMode;
    this.input.sensitivity = save.settings.sensitivity;
    this.input.invertPitch = save.settings.invertPitch;

    // HUD
    this.hudRoot = document.getElementById('hud');
    this.hud = HUDClass ? new HUDClass(this.hudRoot) : null;
    this.hud?.setVisible(false);
    try { this.hud?.setCompact(this.isTouch ? true : null); } catch (e) { /* 忽略 */ }

    this.mp = null;                 // 联机会话（首次进入联机时创建）
    this.isTouch = false;
    this.touch = null;
    this.ui = new UI(this);
    this.applySettings();
    this.bindGlobal();
    this.setupMobile();
    window.addEventListener('resize', () => this.onResize());
  }

  /* ------------------------------------------------------------ 启动 */
  async boot() {
    this.ui.loading('正在准备…', 0.1);
    // 首次交互后初始化音频
    const unlock = async () => {
      try {
        await audio.init();
        audio.setMasterVolume(save.settings.masterVolume);
        audio.setMusicVolume(save.settings.musicVolume);
        audio.setSfxVolume(save.settings.sfxVolume);
        audio.setMuted(save.settings.muted);
        audio.playMusic('menu');
      } catch (e) { console.warn('[audio]', e); }
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    await this.loadStockCrafts();
    this.ui.loadingDone();
    this.setState('menu');
    this.ui.mainMenu();
    this.loop();
  }

  async loadStockCrafts() {
    this.stock = stockCrafts();
    this.game.opts.enemyCrafts = this.stock.filter((c) => ['Simple Jet', 'Warhound', 'Barnstormer'].includes(c.name));
  }

  allCrafts() {
    return [...this.stock, ...save.profile.customCrafts];
  }
  craftStats(c) {
    try { return computeCraftStats(c); } catch (e) { console.warn(e); return { mass: 0, cost: 0, thrust: 0, wingArea: 0, fuel: 0, hp: 0, guns: 0, missiles: 0, size: new THREE.Vector3(), com: new THREE.Vector3(), partCount: 0, wingLoading: Infinity }; }
  }

  /**
   * 统一的状态切换入口：所有界面显隐都从这里同步，避免出现
   * “菜单没关掉 / 建造器被盖住 / HUD 还在跑” 这类层级打架问题。
   */
  setState(next) {
    const prev = this.state;
    if (prev === next) return;
    this.state = next;
    this._syncOverlays();
    this.emit?.('state', { prev, next });
  }

  /** 根据当前状态同步所有覆盖层（菜单 / HUD / 触屏 / 建造器） */
  _syncOverlays() {
    const st = this.state;
    const wantMenu = (st === 'menu' || st === 'loading');
    // 菜单
    if (this.ui) {
      if (!wantMenu) this.ui.hide();
      else if (!this.ui.visible && this.ui.screen !== 'pause' && this.ui.screen !== 'result') { /* 由各界面自己 show */ }
    }
    // 建造器：只在离开建造器状态时关闭（打开由 openBuilder 自己负责，避免重复 open）
    if (this.builder && st !== 'builder' && this.builder._open && !this._builderKeepOpen) {
      this.builder.close();
    }
    // HUD + 触屏
    const flying = (st === 'flight');
    if (this.hud) this.hud.setVisible(!!save.settings.showHud && flying);
    // 触屏设备在飞行中必须始终有操作区（操纵方式只决定摇杆是否驱动飞机，不能决定控件显不显示）
    this.showTouchControls(flying && !this.game.paused && this.isTouch);
    if (flying && !this.game.paused) this.input.enabled = true;
  }

  applySettings() {
    const s = save.settings;
    this.game.setQuality?.(s.quality);
    if (this.game.renderer) {
      this.game.renderer.shadowMap.enabled = s.shadows && s.quality >= 1;
      if (this.game.sky?.sun) this.game.sky.sun.castShadow = this.game.renderer.shadowMap.enabled;
    }
    this.input.mode = s.controlMode;
    this.input.sensitivity = s.sensitivity;
    this.input.invertPitch = s.invertPitch;
    if (this.hud) this.hud.units = s.units;
  }

  /* ------------------------------------------------------------ 全局按键 */
  bindGlobal() {
    this.input.on('keydown', (e) => {
      if (e.code === 'Escape') {
        if (this.state === 'flight') {
          if (this.game.paused) { this.resumeGame(); } else { this.pauseGame(); }
        }
      }
      if (this.state === 'flight') {
        if (e.code === 'KeyC') this.cycleCamera();
        if (e.code === 'KeyY') { this.game.resetPlayerToSpawn('main'); Toast.push('已回到出生点', { kind: 'info' }); }
        if (e.code === 'KeyL') {
          const p = this.game.player;
          if (p) { p.assist = p.assist > 0.05 ? 0 : save.settings.assist || 0.5; Toast.push(p.assist > 0 ? '飞行辅助：开' : '飞行辅助：关'); }
        }
        if (e.code === 'KeyB' && e.ctrlKey) this.openBuilder(this.currentCraft, true);
      }
    });
  }

  /** 暂停（键盘 Esc / 触屏⏸ 共用） */
  pauseGame() {
    if (this.state !== 'flight' || this.game.paused) return;
    this.game.paused = true;
    this.showTouchControls(false);
    this.ui.pause(this.game);
  }

  /** 恢复 */
  resumeGame() {
    if (!this.game.paused) return;
    this.game.paused = false;
    this.input.enabled = true;
    this.setState('flight');
    this.ui.hide();
    this.showTouchControls(true);
  }

  cycleCamera() {
    const rig = this.game.rig;
    const order = ['chase', 'cockpit', 'orbit'];
    const i = order.indexOf(rig.mode);
    rig.setMode(order[(i + 1) % order.length]);
    Toast.push('视角：' + { chase: '追尾', cockpit: '座舱', orbit: '环绕' }[rig.mode], { duration: 1.2 });
  }

  /* ------------------------------------------------------------ 飞行 */
  async startFlight(craftId, mapId, missionDef) {
    // 防连点：正在加载时忽略重复请求，避免两个世界互相踩踏
    if (this.state === 'loading') return;
    this._flightToken = (this._flightToken || 0) + 1;
    const token = this._flightToken;
    const craft = this.allCrafts().find((c) => c.id === craftId) || this.stock[0];
    const map = getMap(mapId);
    this.currentCraft = craft;
    this.currentMap = mapId;
    this.currentMissionDef = missionDef || { mode: 'free' };
    this.setState('loading');
    this.ui.loading(`正在生成 ${map.name}…`, 0.05);
    if (this.hud) this.hud.setVisible(false);
    try {
      await audio.init();
    } catch { /* 忽略 */ }
    try {
      await this.game.loadWorld(map, {
        quality: save.settings.quality,
        onProgress: (p, text) => this.ui.loading(`正在生成 ${map.name}… ${text || ''}`, p),
      });
    } catch (e) {
      console.error('[main] 世界加载失败', e);
      Toast.push('世界加载失败：' + e.message, { kind: 'error', duration: 6 });
      this.ui.loadingDone();
      this.setState('menu');
      this.ui.mainMenu();
      return;
    }
    if (token !== this._flightToken) return;   // 期间又发起了新的起飞
    this.ui.loading('准备起飞…', 0.97);
    const assist = save.settings.assist;

    const air = this.airStart || this.currentMissionDef.mode === 'race' || this.currentMissionDef.mode === 'combat';
    this.game.spawnPlayerAircraft(craft, {
      air,
      height: this.currentMissionDef.mode === 'race' ? 380 : 650,
      speed: this.currentMissionDef.mode === 'race' ? 120 : 150,
      assist,
    });

    this.game.startMission(this.currentMissionDef);
    this.game.sandbox = this.currentMissionDef.mode === 'sandbox';
    this.game.rig.setMode(save.settings.cameraMode || 'chase');
    this.game.paused = false;
    this.game.timeScale = 1;
    this.ui.loadingDone();
    this.ui.hide();                     // 关键：关闭菜单覆盖层，否则会一直挡住画面
    this.input.enabled = true;
    this.input.throttle = 0;
    if (this.hud) {
      this.hud.setCompact(this.isTouch ? true : null);   // 手机用简化 HUD
      this.hud.setVisible(save.settings.showHud);
      this.hud.resize();
    }
    this.showTouchControls(true);
    this.setState('flight');
    try { audio.playMusic(this.currentMissionDef.mode === 'race' ? 'race' : (GAME_MODES[this.currentMissionDef.mode]?.music || map.music || 'flight')); } catch { }
    Toast.push(`${map.name} · ${GAME_MODES[this.currentMissionDef.mode]?.name || ''}`, { kind: 'info', duration: 3 });
    document.body.classList.remove('sp2-menu-open');
  }

  enterFlightFree() {
    this.ui.hide();
    this.showTouchControls(true);
    this.setState('flight');
    this.input.enabled = true;
    this.game.paused = false;
    this.game.startMission({ mode: 'free' });
    if (this.hud) { this.hud.setVisible(save.settings.showHud); }
  }

  restartFlight() {
    const craft = this.currentCraft?.id, map = this.currentMap, mission = this.currentMissionDef;
    this.game.unloadWorld();
    this.startFlight(craft, map, mission);
  }

  quitToMenu() {
    this.showTouchControls(false);
    this.game.unloadWorld();
    this.game.paused = true;
    this.setState('menu');
    this.input.enabled = false;
    if (this.hud) this.hud.setVisible(false);
    try { audio.playMusic('menu'); } catch { }
    this.ui.mainMenu();
  }

  onMissionFinished(mission) {
    if (this._resultShown) return;
    this._resultShown = true;
    const map = this.game.mapDef;
    save.recordBest(map?.id || this.currentMap, mission.mode, { time: mission.timeElapsed, score: Math.round(mission.score) });
    save.addMoney(mission.money);
    save.addXp(Math.round(mission.score * 0.5));
    save.profile.stats.flights++;
    if (mission.mode === 'race' && mission.success) save.profile.stats.racesWon++;
    save.save();
    try { audio.playMusic(mission.success ? 'victory' : 'failure'); } catch { }
    setTimeout(() => {
      this.game.paused = true;
      this.setState('menu');
      if (this.hud) this.hud.setVisible(false);
      this.ui.result(this.game, mission);
      this._resultShown = false;
    }, mission.success ? 2600 : 2000);
  }

  /* ------------------------------------------------------------ 机库 */
  async openBuilder(craft = null, fromPause = false) {
    if (!BuilderClass) { Toast.push('建造器模块不可用', { kind: 'error' }); return; }
    this._builderReturn = fromPause ? 'flight' : 'menu';
    if (fromPause) this.game.paused = true;
    this._builderKeepOpen = true;
    this.setState('builder');
    this.ui.hide();                       // 关键：进入建造器必须关掉菜单，否则会被盖住
    this.input.enabled = false;
    if (this.hud) this.hud.setVisible(false);
    if (!this.builder) {
      const host = document.getElementById('ui');
      this.builder = new BuilderClass({
        container: host,
        getCrafts: () => save.profile.customCrafts,
        onExit: () => this.closeBuilder(),
        onSave: (c) => { save.addCustomCraft(c); Toast.push(`已保存「${c.name}」`, { kind: 'success' }); },
        onFly: (c) => { save.addCustomCraft(c); this.closeBuilder(true).then(() => this.startFlight(c.id, this.currentMap, this.currentMissionDef)); },
      });
    }
    this.builder.open(craft || undefined);
    this._builderKeepOpen = false;
    this.ui.hide();
    try { audio.playMusic('hangar'); } catch { }
    document.body.classList.add('sp2-menu-open');
  }

  async closeBuilder(fly = false) {
    if (this.builder) this.builder.close();
    if (fly) return;
    if (this._builderReturn === 'flight') {
      this.game.paused = false;
      this.setState('flight');
      this.input.enabled = true;
      if (this.hud) this.hud.setVisible(save.settings.showHud);
      this.showTouchControls(this.input.mode === 'touch');
    } else {
      this.setState('menu');
      this.ui.mainMenu();
      try { audio.playMusic('menu'); } catch { }
    }
  }

  /** 把联机玩家合并进 HUD 的 mission 数据（对手列表 / 目标框） */
  _hudMission() {
    const base = this.game.mission ? this.game.mission.hud : null;
    const mp = this.mp;
    if (!mp || mp.status !== 'playing') return base;
    const p = this.game.player;
    const competitors = [];
    const entities = [];
    for (const pl of mp.playerList) {
      const remote = mp.players.get(pl.id);
      const pos = pl.me ? (p ? p.body.position : null) : remote?.ac?.body.position;
      if (!pos) continue;
      const dist = p ? pos.distanceTo(p.body.position) : 0;
      competitors.push({ name: pl.name + (pl.mode === 'p2p' ? '' : ' ⟳'), score: 0, isPlayer: pl.me, worldPos: pos, distance: dist });
      if (!pl.me) {
        const ac = remote?.ac;
        entities.push({
          id: pl.id, position: pos, alive: !(ac?.destroyed), health01: ac ? ac.health : 1,
          hostile: true, label: pl.name, distance: dist,
        });
      }
    }
    return {
      ...(base || {}),
      name: base?.name || '联机自由飞行', mode: base?.mode || 'free',
      objective: base?.objective || '与其它玩家一起飞',
      progress: base?.progress || { current: mp.playerCount, total: mp.playerCount },
      score: base?.score ?? 0, money: base?.money ?? 0,
      competitors: [...(base?.competitors || []), ...competitors],
      entities: [...(base?.entities || []), ...entities],
      targets: base?.targets || [], checkpoints: base?.checkpoints || [],
      cargoHealth01: base?.cargoHealth01 ?? 1, cargoCount: base?.cargoCount ?? 0,
      messages: base?.messages || [], warnings: base?.warnings || [],
      timerSec: base?.timerSec ?? null, timeElapsed: base?.timeElapsed ?? 0,
      multiplayer: { players: mp.playerCount, room: mp.room?.name, host: mp.isHost },
    };
  }

  /* ------------------------------------------------------------ 联机 */
  ensureMP() {
    if (this.mp) return this.mp;
    this.mp = new MultiplayerSession(this.game, {
      playerName: this.save.profile.name || 'Pilot',
      serverUrl: this.save.settings.serverUrl || undefined,
      iceServers: this.save.settings.turnUrl
        ? [{ urls: this.save.settings.turnUrl, username: this.save.settings.turnUser, credential: this.save.settings.turnCred }]
        : undefined,
    });
    const mp = this.mp;
    mp.on('status', (st) => {
      if (st === 'playing') { this.ui.lobby(); }
      else if (this.ui.screen === 'mp' || this.ui.screen === 'lobby') this.ui.multiplayer();
    });
    mp.on('room', () => this.ui.refreshLobby());
    mp.on('players', () => this.ui.refreshLobby());
    mp.on('chat', (e) => this.ui.appendChat(e));
    mp.on('killfeed', (t) => this.ui.killFeed(t));
    mp.on('error', (m) => Toast.push('联机：' + m, { kind: 'error', duration: 6 }));
    mp.on('kicked', (m) => Toast.push('你被房主移出了房间', { kind: 'error' }));
    mp.on('room-closed', () => { Toast.push('房间已关闭', { kind: 'warn' }); this.ui.multiplayer(); });
    mp.on('activity', (v) => Toast.push('房主切换玩法：' + (GAME_MODES[v]?.name || v), { kind: 'info' }));
    return mp;
  }

  async hostRoom(opts) {
    const mp = this.ensureMP();
    Toast.push('正在连接联机服务器…', { kind: 'info', duration: 2 });
    if (!(await mp.connect())) { Toast.push('无法连接联机服务器：' + mp.lastError, { kind: 'error', duration: 6 }); this.ui.multiplayer(); return; }
    await mp.host(opts);
  }

  async joinRoom(roomId) {
    if (!roomId) return;
    const mp = this.ensureMP();
    if (!(await mp.connect())) { Toast.push('无法连接联机服务器：' + mp.lastError, { kind: 'error', duration: 6 }); this.ui.multiplayer(); return; }
    await mp.join(roomId);
  }

  /** 进入联机战斗：加载房主指定的地图，并在同一个房间里同步 */
  async startMultiplayerFlight(mapId, missionDef) {
    if (this.state === 'loading') return;
    const mp = this.ensureMP();
    const craft = this.currentCraft || this.allCrafts()[0];
    this.currentCraft = craft;
    this.currentMap = mapId || 'archipelago';
    this.currentMissionDef = missionDef || { mode: 'free' };
    this.setState('loading');
    this.ui.loading('正在进入联机战场…', 0.05);
    try {
      await this.game.loadWorld(getMap(this.currentMap), {
        quality: this.save.settings.quality,
        onProgress: (p, t) => this.ui.loading('正在生成地图… ' + (t || ''), p),
      });
    } catch (e) {
      Toast.push('世界加载失败：' + e.message, { kind: 'error' });
      this.ui.loadingDone(); this.setState('menu'); this.ui.mainMenu(); return;
    }
    this.game.spawnPlayerAircraft(craft, { air: true, height: 500, speed: 140, assist: this.save.settings.assist });
    this.game.startMission(this.currentMissionDef);
    this.game.rig.setMode(this.save.settings.cameraMode || 'chase');
    this.game.paused = false;
    this.ui.loadingDone();
    this.ui.hide();
    this.input.enabled = true; this.input.throttle = 0;
    if (this.hud) { this.hud.setVisible(this.save.settings.showHud); this.hud.resize(); }
    this.showTouchControls(true);
    this.setState('flight');
    try { audio.playMusic(GAME_MODES[this.currentMissionDef.mode]?.music || 'flight'); } catch { }
    // 通知房间内其它玩家
    mp._broadcast({ t: 'mission', mode: this.currentMissionDef.mode, mapId: this.currentMap });
  }

  copyPlayerCraft(peerId) {
    const p = this.mp?.players.get(peerId);
    if (!p?.parts) { Toast.push('对方没有共享机型', { kind: 'warn' }); return; }
    try {
      const craft = { ...p.parts, id: 'copy_' + Date.now().toString(36), builtin: false, desc: '来自 ' + (p.name || '玩家') + ' 的机型' };
      this.save.addCustomCraft(craft);
      Toast.push(`已保存「${craft.name}」到机库`, { kind: 'success' });
    } catch (e) { Toast.push('复制失败：' + e.message, { kind: 'error' }); }
  }

  /* ------------------------------------------------------------ 移动端 */
  /** 是否为触屏为主的设备（手机 / 平板）。粗指针是最可靠的信号。 */
  detectTouch() {
    if (typeof window === 'undefined') return false;
    let hasTouch = false, coarse = false, small = false;
    try {
      hasTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0 || (navigator.msMaxTouchPoints || 0) > 0;
      coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
      small = Math.min(window.innerWidth || 9999, window.innerHeight || 9999) <= 900;
    } catch (e) { /* 忽略 */ }
    // 手机：有触摸且屏幕不大；平板：粗指针（iPad Pro 这种大屏也要给操作区）
    return hasTouch && (small || coarse);
  }

  setupMobile() {
    this.isTouch = this.detectTouch();
    document.body.classList.toggle('sp2-touch-device', this.isTouch);
    try { this.hud?.setCompact(this.isTouch ? true : null); } catch (e) { /* 忽略 */ }
    if (!this.isTouch) return;
    // 移动端默认：触摸操纵 + 低画质
    // 注意：即使之前玩过（mobileInit 已置位）也要纠正，否则老用户会停在默认的 'mouse'，
    // 导致飞行时操作区完全不显示。
    if (this.save.settings.controlMode !== 'touch' && this.save.settings.controlMode !== 'keys') {
      this.save.setSetting('controlMode', 'touch');
    }
    this.input.mode = this.save.settings.controlMode === 'touch' ? 'touch' : this.input.mode;
    if (!store.get('sp2.mobileInit', false)) {
      this.save.setSetting('quality', 0);
      this.save.setSetting('shadows', false);
      store.set('sp2.mobileInit', true);
    }
    // 首次触摸请求全屏 + 横屏
    const goFull = () => {
      try {
        const el = document.documentElement;
        if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).catch(() => { });
        if (screen.orientation?.lock) screen.orientation.lock('landscape').catch(() => { });
      } catch { /* 忽略 */ }
      window.removeEventListener('touchend', goFull);
      window.removeEventListener('pointerdown', goFull);
    };
    window.addEventListener('touchend', goFull, { once: true });
    window.addEventListener('pointerdown', goFull, { once: true });
    // 阻止双指缩放/双击放大
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('dblclick', (e) => e.preventDefault());
    window.addEventListener('orientationchange', () => setTimeout(() => this.onResize(), 220));
  }

  /** 触碰布局：屏幕方向变化时重排 */
  onResize() {
    this.game.resize();
    this.hud?.resize();
    this.builder?.resize();
    this.touch?.setLayout?.();
    // 旋转/改变窗口后重新判定是否为触屏设备（横竖屏切换不影响，但接/拔鼠标键盘会）
    const t = this.detectTouch();
    if (t !== this.isTouch) {
      this.isTouch = t;
      document.body.classList.toggle('sp2-touch-device', t);
      try { this.hud?.setCompact(t ? true : null); } catch (e) { /* 忽略 */ }
      this._syncOverlays();
    }
  }

  async showTouchControls(on) {
    if (!TouchControlsClass) return;
    if (!this.touch) {
      // 即使当前判定为非触屏设备，只要真的用上了触屏，也允许建立控件
      if (!this.isTouch) return;
      this.touch = new TouchControlsClass({ container: document.getElementById('ui') });
      this.input.touch = this.touch;
      this.input.mode = 'touch';
    }
    const want = !!on && this.isTouch;
    this.touch.setVisible(want);
    if (want) { this.touch.setThrottle(this.input.throttle); this.touch.setLayout?.(); }
  }

  /* ------------------------------------------------------------ 循环 */
  loop() {
    const now = performance.now();
    let dt = (now - this._last) / 1000;
    this._last = now;
    if (dt > 0.25) dt = 0.25;
    this.frameCount++;

    try {
      if (this.state === 'flight') {
        // 保险：任何路径漏关菜单都能自愈（但不要关掉暂停/结算界面）
        if (this.ui.visible && this.ui.screen !== 'pause' && this.ui.screen !== 'result') this.ui.hide();
        const axes = this.input.update(dt, { aimAssist: true });
        // 触屏/手柄的边沿动作（移动端没有键盘，必须在这里处理）
        const ed = this.input.edges || {};
        if (ed.pause) { this.game.paused ? this.resumeGame() : this.pauseGame(); }
        else {
          if (ed.camera) this.cycleCamera();
          if (ed.reset) { this.game.resetPlayerToSpawn('main'); Toast.push('已回到出生点', { kind: 'info', duration: 1.5 }); }
        }
        this.mp?.update(dt);
        const p = this.game.player;
        if (p && !p.destroyed) {
          this.input.applyTo(p);
          p.inputTarget.autoThrottle = save.settings.autoThrottle;
        }
        // 触屏仪表：把真实弹药余量与起落架状态同步给控件（4Hz 足够）
        if (this.touch && this.touch.visible) {
          this._touchSyncAccum = (this._touchSyncAccum || 0) + dt;
          if (this._touchSyncAccum > 0.25) {
            this._touchSyncAccum = 0;
            try {
              const wp = p?.weapons || [];
              const ammo = { fire1: 0, fire2: 0, bomb: 0, flare: 0 };
              for (const w of wp) {
                const t = w.spec?.type;
                if (t === 'gun') ammo.fire1 += w.ammo;
                else if (t === 'missile') ammo.fire2 += w.ammo;
                else if (t === 'bomb') ammo.bomb += w.ammo;
                else if (t === 'flare') ammo.flare += w.ammo;
              }
              this.touch.setAmmo?.(ammo);
              this.touch.setGear?.(!!p?.controls.gear);
            } catch (e) { /* 忽略 */ }
          }
        }

        // 联机阵亡后自动重生
        if (this.mp?.status === 'playing' && p && p.destroyed && !p.crashed) {
          this._respawnTimer = (this._respawnTimer || 0) + dt;
          if (this._respawnTimer > 5) {
            this._respawnTimer = 0;
            const sp = this.game._spawnPoint('main');
            const pos = new THREE.Vector3(sp.position.x, (this.game.terrain?.heightAt(sp.position.x, sp.position.z) || 0) + 600, sp.position.z);
            this.mp.respawn(pos, sp.heading || 0, 130);
            p.crashed = false;
            Toast.push('已重新部署', { kind: 'info', duration: 2 });
          }
        } else this._respawnTimer = 0;
        this.game.update(dt);
        this.game.render();
        if (this.hud && save.settings.showHud) {
          this.hud.update(dt, {
            state: p ? p.state : null,
            camera: this.game.camera,
            mission: this._hudMission(),
            units: save.settings.units,
            fps: this.game.stats.fps,
            showFps: save.settings.showFps,
            player: p,
          });
        }
      } else if (this.state === 'builder') {
        // 保险：建造器界面绝不能被菜单盖住
        if (this.ui.visible) this.ui.hide();
        this.builder?.update(dt);
        if (this.hud) this.hud.setVisible(false);
      } else {
        // 菜单：仍然渲染世界（如果已加载）以获得动态背景
        if (this.game.terrain && !this.game.paused) { /* 保持静止背景 */ }
        this.game.render?.();
      }
    } catch (e) {
      console.error('[main] 循环异常', e);
      if (!this._errShown) { this._errShown = true; Toast.push('运行异常：' + e.message, { kind: 'error', duration: 8 }); }
    }
    requestAnimationFrame(() => this.loop());
  }

  onResize() {
    this.game.resize();
    this.hud?.resize();
    this.builder?.resize();
  }
}

/* ================================================================== 启动 */
const app = new App();
window.__sp2 = app;   // 便于调试
app.boot();

// 首次点击画布时确保音频可用
document.addEventListener('pointerdown', () => { if (!audio.ready) audio.init?.().catch(() => { }); }, { once: true });
