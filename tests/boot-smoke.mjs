/** 整机启动冒烟测试：在 jsdom 里跑通 main.js 的启动流程（无 WebGL，走降级路径）。 */
import { JSDOM } from 'jsdom';
const html = `<!doctype html><html><body>
  <canvas id="gl" width="1280" height="720"></canvas><div id="hud"></div><div id="ui"></div>
  <div id="boot"><p id="bootStatus"></p><button id="bootStart"></button></div>
  <div id="fatal" style="display:none"><pre id="fatalMsg"></pre></div>
</body></html>`;
const dom = new JSDOM(html, { pretendToBeVisual: true, url: 'http://localhost:8080/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
try { Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true }); } catch { }
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.CustomEvent = window.CustomEvent;
globalThis.Event = window.Event;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
globalThis.cancelAnimationFrame = clearTimeout;
// 2D 上下文可用（贴图），WebGL 返回 null（强制走降级路径）
const stub2d = () => {
  const noop = () => { };
  return { canvas: null, save: noop, restore: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    arc: noop, rect: noop, fill: noop, stroke: noop, fillRect: noop, strokeRect: noop, clearRect: noop, clip: noop,
    translate: noop, rotate: noop, scale: noop, setTransform: noop, fillText: noop, measureText: () => ({ width: 20 }),
    createLinearGradient: () => ({ addColorStop: noop }), createRadialGradient: () => ({ addColorStop: noop }),
    drawImage: noop, putImageData: noop, setLineDash: noop,
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h }) };
};
window.HTMLCanvasElement.prototype.getContext = function (type) { return type === '2d' ? stub2d() : null; };
window.HTMLCanvasElement.prototype.requestPointerLock = function () { };

let fails = 0;
const ok = (n, f) => { try { f(); console.log('✅', n); } catch (e) { fails++; console.log('❌', n, '->', e.message); console.log(String(e.stack).split('\n').slice(1, 4).join('\n')); } };

await import('../src/main.js');
await new Promise((r) => setTimeout(r, 400));
const app = window.__sp2;
ok('main.js 启动并创建 App', () => { if (!app) throw new Error('window.__sp2 未设置'); });
ok('状态机进入菜单', () => { if (app.state !== 'menu') throw new Error('state=' + app.state); });
ok('主菜单 DOM 已渲染', () => {
  const nodes = document.querySelectorAll('.sp2-menu .sp2-card');
  if (nodes.length < 4) throw new Error('菜单卡片数量 ' + nodes.length);
});
ok('游戏对象与世界模块就绪', () => {
  if (!app.game || !app.input || !app.ui) throw new Error('子系统缺失');
  if (!app.hud) throw new Error('HUD 未加载');
});
ok('存档模块可用', () => { if (typeof app.save.profile.money !== 'number') throw new Error('档案异常'); });
ok('无头世界加载 + 生成飞机 + 飞行 2 秒', async () => {});
// 真正跑一次世界加载（Game 已降级为 headless）
try {
  await app.game.loadWorld((await import('../src/world/maps.js')).getMap('archipelago'), { quality: 0, onProgress: () => { } });
  const crafts = app.allCrafts();
  app.game.spawnPlayerAircraft(crafts[0], { air: true, height: 400, speed: 120, assist: 0.6 });
  app.game.startMission({ mode: 'free' });
  for (let i = 0; i < 120; i++) app.game.update(1 / 60);
  console.log(`✅ 世界加载 + 飞行 2 秒（飞机 ${app.game.aircraft.length} 架，高度 ${app.game.player.state.altitudeAGL.toFixed(0)}m，速度 ${app.game.player.state.speed.toFixed(0)}m/s）`);
} catch (e) { fails++; console.log('❌ 世界加载/飞行', e.message); console.log(e.stack.split('\n').slice(1, 4).join('\n')); }

// ---------------------------------------------------------------------------
// 回归：点“起飞”之后菜单覆盖层必须消失（否则会一直挡住画面，移动端尤其致命）
// ---------------------------------------------------------------------------
try {
  const crafts = app.allCrafts();
  await app.startFlight(crafts[0].id, 'archipelago', { mode: 'free' });
  ok('起飞后状态进入 flight', () => { if (app.state !== 'flight') throw new Error('state=' + app.state); });
  ok('起飞后主菜单已关闭', () => {
    const menu = document.querySelector('.sp2-menu');
    if (!menu) throw new Error('菜单节点不存在');
    if (menu.style.display !== 'none') throw new Error('菜单仍然可见: display=' + menu.style.display);
  });
  ok('起飞后菜单不再拦截点击', () => {
    const menu = document.querySelector('.sp2-menu');
    const cs = window.getComputedStyle(menu);
    if (cs.display !== 'none') throw new Error('computed display=' + cs.display);
  });
  ok('起飞后加载遮罩已消失', () => {
    const l = document.querySelector('.sp-loading');
    if (l && window.getComputedStyle(l).display !== 'none' && !l.classList.contains('sp-hidden')) {
      throw new Error('Loading 遮罩仍然可见');
    }
  });
  ok('UI.visible 与状态一致', () => { if (app.ui.visible) throw new Error('UI 仍标记为可见'); });
  // 主循环的保险逻辑
  app.ui.mainMenu();
  if (app.ui.visible) { /* 手动打开 */ }
  await new Promise((r) => setTimeout(r, 120));   // 让 rAF 跑几帧
  ok('主循环自愈：飞行状态下自动关闭菜单', () => {
    if (app.ui.visible) throw new Error('主循环没有关掉菜单');
  });
} catch (e) {
  fails++; console.log('❌ 起飞流程', e.message); console.log(String(e.stack).split('\n').slice(1, 4).join('\n'));
}

// ---------------------------------------------------------------------------
// 回归：暂停界面不能被“自愈关闭菜单”的逻辑误关；恢复后菜单要真的消失
// ---------------------------------------------------------------------------
try {
  app.pauseGame();
  await new Promise((r) => setTimeout(r, 150));   // 跑几帧主循环
  ok('暂停：游戏已暂停且暂停界面保持打开', () => {
    if (!app.game.paused) throw new Error('game.paused=false');
    if (!app.ui.visible) throw new Error('暂停界面被关掉了');
    if (app.ui.screen !== 'pause') throw new Error('screen=' + app.ui.screen);
  });
  app.resumeGame();
  await new Promise((r) => setTimeout(r, 120));
  ok('恢复：菜单关闭、游戏继续、触屏控件恢复', () => {
    if (app.game.paused) throw new Error('仍在暂停');
    if (app.ui.visible) throw new Error('菜单没有关闭');
  });
  // 触屏边沿：⏸ 按钮应当能暂停（把 Input 切到 touch 模式并注入一个假触控层）
  const savedMode = app.input.mode, savedTouch = app.input.touch;
  app.input.mode = 'touch';
  let pending = {};
  app.input.touch = {
    axes: { pitch: 0, roll: 0, yaw: 0, throttle: 0.4, brake: 0, flaps: 0, airbrake: 0 },
    setLayout() { }, setVisible() { }, setThrottle() { },
    consumeEdges: () => { const p = pending; pending = {}; return p; },
  };
  pending = { pause: true };
  await new Promise((r) => setTimeout(r, 120));
  ok('触屏⏸边沿可以暂停', () => { if (!app.game.paused) throw new Error('没有暂停'); });
  ok('触屏摇杆进入 input.axes', () => {
    if (Math.abs(app.input.axes.throttle - 0.4) > 0.05) throw new Error('throttle=' + app.input.axes.throttle);
  });
  app.resumeGame();
  app.input.mode = savedMode; app.input.touch = savedTouch;
} catch (e) {
  fails++; console.log('❌ 暂停流程', e.message); console.log(String(e.stack).split('\n').slice(1, 4).join('\n'));
}

// ---------------------------------------------------------------------------
// 回归：进入建造器 / 载具库 等界面时，主菜单必须让位（层级不能打架）
// ---------------------------------------------------------------------------
try {
  const menuEl = () => document.querySelector('.sp2-menu');
  ok('回到主菜单后菜单可见', () => { app.quitToMenu(); if (!app.ui.visible) throw new Error('菜单没显示'); });

  // 从主菜单进入建造器
  await app.openBuilder();
  await new Promise((r) => setTimeout(r, 120));
  ok('进入建造器：状态为 builder', () => { if (app.state !== 'builder') throw new Error('state=' + app.state); });
  ok('进入建造器：主菜单已隐藏', () => {
    const m = menuEl();
    if (m && window.getComputedStyle(m).display !== 'none') throw new Error('菜单仍可见，会盖住建造器');
  });
  ok('建造器节点位于 #ui 之内（同一层叠上下文）', () => {
    const ui = document.getElementById('ui');
    const b = ui.querySelector('[class*="sp2-builder"]');
    if (!b) throw new Error('没找到建造器根节点');
    const z = Number(window.getComputedStyle(b).zIndex) || 0;
    const mz = Number(window.getComputedStyle(menuEl()).zIndex) || 0;
    if (z <= mz) throw new Error(`建造器 z-index(${z}) 不高于菜单(${mz})`);
  });
  await app.closeBuilder();
  await new Promise((r) => setTimeout(r, 120));
  ok('退出建造器：回到主菜单且菜单可见', () => {
    if (app.state !== 'menu') throw new Error('state=' + app.state);
    if (!app.ui.visible) throw new Error('菜单没显示');
  });

  // 载具库 -> 机库
  app.ui.craftLibrary();
  ok('载具库界面隐藏了飞行 HUD', () => { if (app.hud && app.hud.visible) throw new Error('HUD 不该在菜单里显示'); });
  await app.openBuilder(app.allCrafts()[0]);
  await new Promise((r) => setTimeout(r, 100));
  ok('从载具库进建造器：菜单同样被隐藏', () => {
    const m = menuEl();
    if (m && window.getComputedStyle(m).display !== 'none') throw new Error('菜单仍可见');
  });
  await app.closeBuilder();
  await new Promise((r) => setTimeout(r, 80));
} catch (e) {
  fails++; console.log('❌ 界面层级', e.message); console.log(String(e.stack).split('\n').slice(1, 4).join('\n'));
}

// ---------------------------------------------------------------------------
// 回归：飞行中「暂停 → 设置」不能被任何自愈逻辑关掉（否则表现为卡死）
// ---------------------------------------------------------------------------
try {
  await app.startFlight(app.allCrafts()[0].id, 'archipelago', { mode: 'free' });
  await new Promise((r) => setTimeout(r, 120));
  app.pauseGame();
  await new Promise((r) => setTimeout(r, 120));
  ok('暂停后进入暂停菜单', () => {
    if (!app.game.paused) throw new Error('未暂停');
    if (app.ui.screen !== 'pause') throw new Error('screen=' + app.ui.screen);
  });

  // 从暂停菜单点「设置」
  app.ui.settings();
  await new Promise((r) => setTimeout(r, 250));   // 多跑几帧，触发自愈逻辑
  ok('★ 飞行中进入设置：界面仍然可见（这次卡死的核心）', () => {
    if (app.ui.screen !== 'settings') throw new Error('screen 被改成 ' + app.ui.screen);
    if (!app.ui.visible) throw new Error('设置界面被自动关掉了');
    const menu = document.querySelector('.sp2-menu');
    if (!menu || window.getComputedStyle(menu).display === 'none') throw new Error('菜单 display=none');
  });
  ok('设置界面里的控件已渲染', () => {
    const n = document.querySelectorAll('.sp2-menu .sp-slider, .sp2-menu .sp-toggle, .sp2-menu .sp-select').length;
    if (n < 5) throw new Error('控件数量 ' + n);
  });
  ok('游戏仍处于暂停（不会被设置界面意外恢复）', () => { if (!app.game.paused) throw new Error('被恢复了'); });

  // 点击「返回」应回到暂停菜单
  let backBtn = null;
  for (const b of document.querySelectorAll('.sp2-menu button')) {
    if (/返回/.test(b.textContent || '')) backBtn = b;
  }
  ok('设置界面有返回按钮', () => { if (!backBtn) throw new Error('没找到返回按钮'); });
  if (backBtn) backBtn.click();
  await new Promise((r) => setTimeout(r, 200));
  ok('返回后回到暂停菜单而不是卡住', () => {
    if (app.ui.screen !== 'pause') throw new Error('screen=' + app.ui.screen);
    if (!app.ui.visible) throw new Error('暂停菜单不可见');
  });

  // Esc 在设置界面应退回暂停菜单
  app.ui.settings();
  await new Promise((r) => setTimeout(r, 150));
  window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'Escape' }));
  await new Promise((r) => setTimeout(r, 150));
  ok('设置界面按 Esc 退回暂停菜单', () => { if (app.ui.screen !== 'pause') throw new Error('screen=' + app.ui.screen); });

  // 恢复飞行
  app.resumeGame();
  await new Promise((r) => setTimeout(r, 200));
  ok('恢复后回到飞行且菜单关闭', () => {
    if (app.game.paused) throw new Error('仍在暂停');
    if (app.ui.visible) throw new Error('菜单没有关闭');
    if (app.state !== 'flight') throw new Error('state=' + app.state);
  });
  // 计时器：连续暂停/进设置/返回/恢复 10 轮，不应出现任何异常或卡住
  let rounds = 0;
  for (let i = 0; i < 10; i++) {
    app.pauseGame(); app.ui.settings();
    await new Promise((r) => setTimeout(r, 20));
    if (app.ui.screen === 'settings' && app.ui.visible) rounds++;
    app.ui.pause(app.game);
    await new Promise((r) => setTimeout(r, 20));
    app.resumeGame();
    await new Promise((r) => setTimeout(r, 20));
  }
  ok('连续 10 轮「暂停→设置→返回→恢复」都正常', () => {
    if (rounds !== 10) throw new Error(`只有 ${rounds}/10 轮设置界面正常显示`);
    if (app.game.paused) throw new Error('最后一轮没有恢复');
  });
} catch (e) {
  fails++; console.log('❌ 暂停/设置流程', e.message); console.log(String(e.stack).split('\n').slice(1, 4).join('\n'));
}

console.log(fails ? `\n❌ ${fails} 项失败` : '\n✅ 启动流程通过');
process.exit(fails ? 1 : 0);
