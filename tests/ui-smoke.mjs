/** 用 jsdom 冒烟测试界面模块（菜单/组件/HUD）。 */
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body><div id="hud"></div><div id="ui"></div></body></html>', { pretendToBeVisual: true });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
try { Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true }); } catch {}
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.requestAnimationFrame = window.requestAnimationFrame?.bind(window) || ((cb) => setTimeout(() => cb(Date.now()), 16));
globalThis.cancelAnimationFrame = window.cancelAnimationFrame?.bind(window) || clearTimeout;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.performance = globalThis.performance || { now: () => Date.now() };
// canvas 2d stub
window.HTMLCanvasElement.prototype.getContext = function (type) {
  if (type !== '2d') return null;
  const noop = () => {};
  return {
    canvas: this, save: noop, restore: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    arc: noop, arcTo: noop, ellipse: noop, rect: noop, fill: noop, stroke: noop, fillRect: noop, strokeRect: noop,
    clearRect: noop, clip: noop, translate: noop, rotate: noop, scale: noop, setTransform: noop, transform: noop,
    fillText: noop, strokeText: noop, measureText: () => ({ width: 20 }), createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }), createPattern: () => null, drawImage: noop, putImageData: noop,
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }),
    setLineDash: noop, quadraticCurveTo: noop, bezierCurveTo: noop,
  };
};
let fails = 0;
const ok = (name, fn) => { try { fn(); console.log('✅', name); } catch (e) { fails++; console.log('❌', name, '->', e.message); console.log(String(e.stack).split('\n').slice(1, 4).join('\n')); } };

// menu.js
const { stockCrafts } = await import('../src/build/crafts.js');
const stockList = stockCrafts();
const { UI } = await import('../src/ui/menu.js');
const fakeApp = {
  save: { profile: { money: 100, level: 1, customCrafts: [], unlockedMaps: [], stats: { flightTime: 0 } }, settings: {}, getBest: () => null, save() {}, reset() {} },
  input: { bindings: {}, saveBindings() {} },
  allCrafts: () => stockList,
  craftStats: () => ({ mass: 1000, cost: 0, thrust: 3000, wingArea: 20, fuel: 100, hp: 100, guns: 0, missiles: 0, size: { x: 10, y: 2, z: 8 }, com: { x: 0, y: 0, z: 0 }, partCount: 10, wingLoading: 50 }),
  airStart: false, state: 'menu', game: null,
  openBuilder() {}, startFlight() {}, quitToMenu() {}, restartFlight() {}, enterFlightFree() {}, applySettings() {},
};
const ui = new UI(fakeApp);
ok('UI 构造', () => { if (!ui.root) throw new Error('无 root'); });
ok('主菜单', () => ui.mainMenu());
ok('地图选择', () => ui.mapSelect());
ok('任务选择', () => ui.missionSelect());
ok('载具库', () => ui.craftLibrary());
ok('设置', () => ui.settings());
ok('帮助', () => ui.help());
ok('暂停', () => ui.pause({ mission: { name: 'x', objective: 'y' } }));
ok('结算', () => ui.result({}, { success: true, name: 't', score: 100, money: 10, timeElapsed: 3, progress: { current: 1, total: 2 } }));

// HUD
const { HUD } = await import('../src/ui/hud.js');
const hud = new HUD(document.getElementById('hud'));
ok('HUD 构造/显示', () => { hud.setVisible(true); hud.resize(); });
ok('HUD 空状态更新', () => { for (let i = 0; i < 10; i++) hud.update(1 / 60, { state: null, camera: null, mission: null, units: 'metric', fps: 60 }); });
const THREE = await import('three');
const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000); cam.position.set(0, 50, 0); cam.updateMatrixWorld();
const st = { speed: 100, mach: 0.3, altitudeASL: 500, altitudeAGL: 400, verticalSpeed: -3, heading: 90, pitch: 4, roll: -12,
  throttle: 0.8, rpm01: 0.9, aoa: 0.05, gForce: 1.4, stall: false, fuel01: 0.7, health01: 0.8,
  gearDown: true, gear01: 1, flaps01: 0.2, airbrake01: 0, warnings: ['LOW FUEL'],
  weapons: [{ name: '机炮', ammo: 120, active: true }, { name: '导弹', ammo: 2 }] };
const mission = { name: '竞速', mode: 'race', objective: '穿过光环', progress: { current: 1, total: 5 }, timerSec: 42.5, timeElapsed: 12, score: 500, money: 0,
  competitors: [{ name: 'Bot', score: 300, isPlayer: false, worldPos: new THREE.Vector3(100, 500, 0), distance: 300 }],
  targets: [{ id: 't1', position: new THREE.Vector3(200, 500, -50), alive: true, health01: 0.6, team: 1 }],
  entities: [], checkpoints: [{ index: 0, position: new THREE.Vector3(0, 500, -200), radius: 35, passed: false, isNext: true }],
  cargoHealth01: 1, cargoCount: 0, warnings: [], messages: [{ text: '测试', kind: 'info', ttl: 2 }] };
ok('HUD 完整更新', () => { for (let i = 0; i < 30; i++) hud.update(1 / 60, { state: st, camera: cam, mission, units: 'metric', fps: 60, showFps: true }); });
ok('HUD 英制/消息/闪烁', () => { hud.update(1 / 60, { state: st, camera: cam, mission, units: 'imperial', fps: 60 }); hud.showMessage('hi'); hud.flash('damage'); });
ok('HUD dispose', () => hud.dispose());

// 触控 + 输入管线集成
try {
  const { TouchControls } = await import('../src/ui/touch.js');
  const { Input } = await import('../src/core/input.js');
  const tc = new TouchControls({ container: document.getElementById('ui') });
  const glCanvas = document.getElementById('gl') || (() => { const c = document.createElement('canvas'); c.id = 'gl'; document.body.appendChild(c); return c; })();
  const input = new Input(glCanvas);
  input.mode = 'touch';
  input.touch = tc;
  ok('触控模块构造', () => { if (!tc.el) throw new Error('无 root'); tc.setVisible(true); tc.setLayout(); });
  ok('触控油门进入统一输入管线', () => {
    tc.setThrottle(0.65);
    input.update(1 / 60, {});
    if (Math.abs(input.axes.throttle - 0.65) > 0.02) throw new Error('油门=' + input.axes.throttle);
  });
  ok('触控操纵面进入统一输入管线', () => {
    // 直接注入轴（模拟摇杆满舵）
    tc._axes = { pitch: 0.5, roll: -0.8, yaw: 0.2, throttle: 0.65, brake: 0, flaps: 0.3, airbrake: 0 };
    Object.defineProperty(tc, 'axes', { configurable: true, get: () => tc._axes });
    input.update(1 / 60, {});
    if (Math.abs(input.axes.roll + 0.8) > 0.02) throw new Error('roll=' + input.axes.roll);
    if (Math.abs(input.axes.pitch - 0.5) > 0.02) throw new Error('pitch=' + input.axes.pitch);
    if (Math.abs(input.axes.flaps - 0.3) > 0.02) throw new Error('flaps=' + input.axes.flaps);
  });
  ok('触控按钮边沿进入统一输入管线', () => {
    const a = { roll: 0, pitch: 0, yaw: 0, throttle: 0.5, brake: 0, flaps: 0, airbrake: 0 };
    Object.defineProperty(tc, 'axes', { configurable: true, get: () => a });
    let pending = { gear: true, fire1: true, camera: true, bomb: true };
    tc.consumeEdges = () => { const p = pending; pending = {}; return p; };
    input.update(1 / 60, {});
    if (!input.edges.gear) throw new Error('gear 边沿丢失');
    if (!input.edges.fire1) throw new Error('fire1 丢失');
    if (!input.edges.camera) throw new Error('camera 边沿丢失');
    if (!input.edges.bomb) throw new Error('bomb 边沿丢失');
    input.update(1 / 60, {});
    if (input.edges.gear) throw new Error('gear 边沿未清除');
  });
  ok('触控模式不请求指针锁定', () => {
    let locked = false;
    glCanvas.requestPointerLock = () => { locked = true; };
    input.requestPointerLock();
    if (locked) throw new Error('触屏模式不应锁定指针');
  });
  ok('触控 dispose', () => { tc.dispose(); input.dispose?.(); });
} catch (e) {
  fails++; console.log('❌ 触控集成', e.message);
}

// Builder（需要 WebGL，无 GPU 时应当优雅降级/报错而不是卡死）
try {
  const { Builder } = await import('../src/ui/builder.js');
  ok('Builder 模块导入', () => { if (typeof Builder !== 'function') throw new Error('未导出 Builder 类'); });
  try {
    const b = new Builder({ container: document.getElementById('ui'), getCrafts: () => [], onExit() {}, onSave() {}, onFly() {} });
    ok('Builder 构造', () => { b.open(stockList[0]); b.update(1 / 60); b.resize(); b.close(); });
  } catch (e) {
    console.log('⚠️  Builder 构造需要 WebGL（Node 环境预期失败）:', e.message.slice(0, 120));
  }
} catch (e) {
  fails++; console.log('❌ Builder 导入失败', e.message);
}

// 移动端样式：加上 sp2-touch-device 后，主菜单动作按钮应变成大号列表行
try {
  document.body.classList.add('sp2-touch-device');
  ui.mainMenu();
  const card = document.querySelector('.sp2-card--action');
  if (!card) { console.log('⚠️  未找到 .sp2-card--action（结构可能变了）'); }
  else {
    const cs = window.getComputedStyle(card);
    const disp = cs.display, minH = cs.minHeight;
    if (disp === '' && minH === '') {
      console.log('⚠️  jsdom 未解析外部样式表，跳过移动端样式断言');
    } else {
      ok('移动端：动作按钮为 flex 布局', () => { if (disp !== 'flex') throw new Error('display=' + disp); });
      ok('移动端：动作按钮高度 ≥72px', () => { if (parseFloat(minH) < 72) throw new Error('min-height=' + minH); });
    }
    ok('移动端：菜单内含图标与文字结构', () => {
      if (!card.querySelector('.sp2-card__icon')) throw new Error('缺少 .sp2-card__icon');
      if (!card.querySelector('.sp2-card__text')) throw new Error('缺少 .sp2-card__text');
    });
  }
  document.body.classList.remove('sp2-touch-device');
} catch (e) { fails++; console.log('❌ 移动端样式', e.message); }

console.log(fails ? `\n❌ ${fails} 项失败` : '\n✅ 界面模块全部通过');
process.exit(fails ? 1 : 0);
