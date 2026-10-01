/**
 * 移动端启动/飞行回归测试
 * ------------------------------------------------------------------
 * 专门锁住「手机上进飞行后操作区完全消失」这类问题：
 * 用一个「触屏 + 小屏」的 jsdom 环境跑完整启动流程，然后真的起飞一次，
 * 断言虚拟摇杆/油门/按钮簇都显示出来。
 * 需要 jsdom：npm i jsdom --no-save
 */
import { JSDOM } from 'jsdom';

const html = `<!doctype html><html><body>
  <canvas id="gl" width="800" height="400"></canvas><div id="hud"></div><div id="ui"></div>
  <div id="boot"><p id="bootStatus"></p><button id="bootStart"></button></div>
  <div id="fatal" style="display:none"><pre id="fatalMsg"></pre></div>
</body></html>`;

const dom = new JSDOM(html, { pretendToBeVisual: true, url: 'http://localhost:8080/' });
const { window } = dom;
// 伪装成手机：小屏 + 触摸支持
Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true });
window.ontouchstart = null;
Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 5, configurable: true });

globalThis.window = window;
globalThis.document = window.document;
try { Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true }); } catch { }
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.setTimeout = setTimeout;
globalThis.addEventListener = window.addEventListener.bind(window);

const stub2d = () => {
  const noop = () => { };
  return {
    canvas: null, save: noop, restore: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    arc: noop, rect: noop, fill: noop, stroke: noop, fillRect: noop, strokeRect: noop, clearRect: noop, clip: noop,
    translate: noop, rotate: noop, scale: noop, setTransform: noop, fillText: noop, strokeText: noop,
    measureText: () => ({ width: 20 }), createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }), drawImage: noop, putImageData: noop, setLineDash: noop,
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h }),
  };
};
window.HTMLCanvasElement.prototype.getContext = function (type) { return type === '2d' ? stub2d() : null; };
window.HTMLCanvasElement.prototype.requestPointerLock = function () { };
window.Element.prototype.setPointerCapture = function () { };
window.Element.prototype.releasePointerCapture = function () { };

let fails = 0;
const ok = (cond, name, extra = '') => {
  if (cond) console.log('✅', name, extra);
  else { fails++; console.log('❌', name, extra); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await import('../src/main.js');
await sleep(500);
const app = window.__sp2;
ok(!!app, 'main.js 在移动端环境启动');
if (!app) { console.log('无法继续'); process.exit(1); }

ok(app.isTouch === true, '识别为触屏设备', `(isTouch=${app.isTouch})`);
ok(document.body.classList.contains('sp2-touch-device'), 'body 带上了 sp2-touch-device 类');
ok(app.save.settings.controlMode === 'touch', '操纵方式自动切到 touch', `(=${app.save.settings.controlMode})`);
ok(app.input.mode === 'touch', 'Input 使用 touch 模式', `(=${app.input.mode})`);

// 起飞
const crafts = app.allCrafts();
await app.startFlight(crafts[0].id, 'archipelago', { mode: 'free' });
await sleep(400);
ok(app.state === 'flight', '进入飞行状态', `(state=${app.state})`);
ok(!!app.touch, '触屏控件已创建');
if (app.touch) {
  ok(app.touch.visible === true, '★ 触屏控件在飞行中可见（这次 bug 的核心）');
  const el = app.touch.el;
  const btns = el ? el.querySelectorAll('button, [class*="btn"], [class*="button"]') : [];
  ok(btns.length >= 10, '按钮簇数量足够', `(${btns.length} 个)`);
  const stick = el?.querySelector('[class*="stick"], [class*="zone"]');
  ok(!!stick, '虚拟摇杆存在');
  const thr = el?.querySelector('[class*="throttle"]');
  ok(!!thr, '油门控件存在');
  // 控件必须真的能覆盖屏幕（不是 display:none / 0 尺寸）
  const cs = window.getComputedStyle(el);
  ok(cs.display !== 'none' && cs.visibility !== 'hidden', '控件根节点没有被隐藏', `(display=${cs.display})`);
}
ok(app.hud?.forceCompact === true, '手机使用紧凑 HUD', `(forceCompact=${app.hud?.forceCompact})`);
ok(app.ui.visible === false, '飞行中主菜单已关闭');

// 触屏按钮应当进入统一输入管线
if (app.touch) {
  app.touch.setThrottle(0.8);
  await sleep(80);
  ok(Math.abs(app.input.axes.throttle - 0.8) < 0.06, '触屏油门进入 input.axes', `(=${app.input.axes.throttle.toFixed(2)})`);
  // 直接调一次 input.update，避免被主循环的下一帧清掉
  let pending = { gear: true, fire1: true, camera: true };
  app.touch.consumeEdges = () => { const p = pending; pending = {}; return p; };
  app.input.update(1 / 60, {});
  ok(app.input.edges.gear === true, '触屏「起落架」边沿进入 input.edges');
  ok(app.input.edges.fire1 === true, '触屏「机炮」按住电平进入 input.edges');
  ok(app.input.edges.camera === true, '触屏「视角」边沿进入 input.edges');
  app.input.update(1 / 60, {});
  ok(app.input.edges.gear === false && app.input.edges.camera === false, '单次边沿下一帧被清空（不会重复触发）');
}

// 暂停时应隐藏操作区，恢复后重新出现
app.pauseGame();
await sleep(150);
ok(app.touch ? app.touch.visible === false : true, '暂停时隐藏操作区');
app.resumeGame();
await sleep(200);
ok(app.touch ? app.touch.visible === true : false, '恢复后操作区回来');

console.log(fails ? `\n❌ ${fails} 项失败` : '\n✅ 移动端启动/飞行全部通过');
process.exit(fails ? 1 : 0);
