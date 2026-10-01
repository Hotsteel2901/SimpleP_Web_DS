/**
 * tests/touch-smoke.mjs —— 移动端触摸控制层（src/ui/touch.js）的 jsdom 冒烟测试
 * --------------------------------------------------------------------------
 * 覆盖：
 *   · 精简布局：中央 ±15% 留空、控件互不重叠、全部 ≥44px、开火 ≥76px、可见按钮 ≤12
 *   · 双摇杆（左 = 俯仰/滚转，右 = 方向舵 + 刹车/减速板）、单开关襟翼、大号开火 + 武器选择器
 *   · 武器映射（机炮→fire1、导弹→fire2、炸弹→bomb、干扰弹→flare）、余量置灰
 *   · consumeEdges() 键集合固定（宿主 input.js 依赖）、一次性边沿消费后清空
 *   · 油门持久、setOpacity/setScale（store 记忆）、显隐、dispose、touch 回退、纯 Node 安全
 *
 * 说明：jsdom 没有布局引擎，getBoundingClientRect() 恒为 0；本模块的几何由 JS 计算后写成
 * inline px（浏览器中 inline 覆盖样式表，即最终几何），因此测试直接读取元素的 inline 几何做
 * 「中心留空 / 互不重叠 / 尺寸」判定 —— 这与真机上的布局一致。
 *
 * 运行： npm i jsdom --no-save && node tests/touch-smoke.mjs
 */
import { JSDOM } from 'jsdom';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ 环境 */
const dom = new JSDOM(
  '<!doctype html><html><body><div id="ui"></div><div id="hud"></div></body></html>',
  { pretendToBeVisual: true, url: 'http://localhost/' },
);
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
try { Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true }); } catch { /* ignore */ }
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.Event = window.Event;
globalThis.localStorage = window.localStorage;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);

const cssText = () => (document.getElementById('sp2-widgets')?.textContent || '');

/* ------------------------------------------------------------------ 断言框架 */
let fails = 0;
let count = 0;
const ok = (name, fn) => {
  count++;
  try { fn(); console.log('✅', name); }
  catch (e) { fails++; console.log('❌', name, '->', e.message); console.log(String(e.stack).split('\n').slice(1, 4).join('\n')); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || '断言失败'); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/* ------------------------------------------------------------------ 事件 / 几何工具 */
let pid = 100;
const nextPid = () => ++pid;
const P = (type, x, y, id) => new window.PointerEvent(type, {
  bubbles: true, cancelable: true, clientX: x, clientY: y,
  pointerId: id, pointerType: 'touch', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
});
const T = (type, x, y, id) => {
  const ev = new window.Event(type, { bubbles: true, cancelable: true });
  const t = { identifier: id, clientX: x, clientY: y };
  ev.changedTouches = [t];
  ev.touches = type === 'touchend' || type === 'touchcancel' ? [] : [t];
  return ev;
};
const press = (node, id, x = 0, y = 0) => node.dispatchEvent(P('pointerdown', x, y, id));
const release = (node, id, x = 0, y = 0) => node.dispatchEvent(P('pointerup', x, y, id));
const tap = (node, x = 0, y = 0) => { const id = nextPid(); press(node, id, x, y); release(node, id, x, y); };
const stubRect = (node, top, height, left = 900, width = 60) => {
  node.getBoundingClientRect = () => ({ top, left, width, height, right: left + width, bottom: top + height, x: left, y: top });
};
const setViewport = (w, h) => {
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: h, configurable: true });
};
/** 读取元素的 inline 几何（= 浏览器最终几何）。 */
const boxOf = (el) => {
  const b = {
    x: parseFloat(el.style.left), y: parseFloat(el.style.top),
    w: parseFloat(el.style.width), h: parseFloat(el.style.height),
  };
  b.x1 = b.x + b.w; b.y1 = b.y + b.h;
  return b;
};
const intersects = (a, b) => a.x < b.x1 - 1e-6 && a.x1 > b.x + 1e-6 && a.y < b.y1 - 1e-6 && a.y1 > b.y + 1e-6;

/* ------------------------------------------------------------------ 布局不变量 */
const container = document.getElementById('ui');
const CENTER_OF = (w, h) => ({ x: w * 0.35, y: h * 0.35, w: w * 0.30, h: h * 0.30 });

/** 可见且由 JS 管理几何的元素（排除隐藏的、以及没有 inline 几何的子项）。 */
const geoCtls = (t) => [...t.el.querySelectorAll('[data-ctl]')]
  .filter((e) => !e.hidden && !e.closest('[hidden]') && Number.isFinite(parseFloat(e.style.left)));

/**
 * 校验一个视口下的布局不变量。
 * @param {number} w @param {number} h @param {number} scale
 */
const checkLayout = (w, h, scale) => {
  localStorage.clear();
  setViewport(w, h);
  const t = new TouchControls({ container });
  try {
    if (scale !== 1) { t.setScale(scale); t.setLayout(); }
    const nodes = geoCtls(t);
    const center = CENTER_OF(w, h);
    const where = ` @${w}x${h} scale=${scale}`;
    for (const e of nodes) {
      const b = boxOf(e);
      const name = e.dataset.ctl;
      assert(b.w > 0 && b.h > 0 && Number.isFinite(b.x) && Number.isFinite(b.y), `几何缺失 ${name}${where}`);
      assert(b.x >= -0.5 && b.y >= -0.5 && b.x1 <= w + 0.5 && b.y1 <= h + 0.5,
        `控件出屏 ${name} ${JSON.stringify(b)}${where}`);
      assert(!intersects(b, center), `控件进入中央 ±15% 留空区：${name} ${JSON.stringify(b)}${where}`);
    }
    // 可见控件两两不相交（zone 是不可见感应区，menu 是弹出层，单独校验）
    const solid = nodes.filter((e) => e.dataset.role !== 'zone' && e.dataset.role !== 'menu');
    for (let i = 0; i < solid.length; i++) {
      for (let j = i + 1; j < solid.length; j++) {
        if (intersects(boxOf(solid[i]), boxOf(solid[j]))) {
          throw new Error(`控件重叠：${solid[i].dataset.ctl} × ${solid[j].dataset.ctl}${where}`);
        }
      }
    }
    // 尺寸
    const btns = nodes.filter((e) => e.tagName === 'BUTTON');
    for (const e of btns) {
      const b = boxOf(e);
      assert(b.w >= 44 - 1e-6 && b.h >= 44 - 1e-6, `按钮小于 44px：${e.dataset.ctl} ${b.w}x${b.h}${where}`);
    }
    const fire = nodes.find((e) => e.dataset.ctl === 'fire');
    assert(fire, '缺少开火按钮');
    assert(boxOf(fire).w >= 76 - 1e-6 && boxOf(fire).h >= 76 - 1e-6, `开火按钮小于 76px${where}`);
    // 所有可点区域 ≥44px：油门容器 ≥52（内部 ＋/− 触区 = 容器宽 − 8 ≥ 44），轨道 CSS 宽度下限 44
    const throttle = nodes.find((e) => e.dataset.ctl === 'throttle');
    assert(boxOf(throttle).w >= 52 - 1e-6, `油门容器过窄，＋/− 触区会小于 44px${where}`);
    const css = cssText();
    assert(/\.sp2-touch-step\{[\s\S]*?height:clamp\(44px/.test(css), `＋/− 油门触区高度下限不是 44px${where}`);
    assert(/\.sp2-touch-track\{[\s\S]*?width:max\(44px/.test(css), `油门轨道宽度下限不是 44px${where}`);
    // 长期可见按钮数量
    assert(btns.length <= 12, `长期可见按钮 ${btns.length} 个（>12）${where}`);
    assert(btns.length >= 8, `按钮过少（${btns.length}）${where}`);
  } finally { t.dispose(); }
  localStorage.clear();
};

/* ------------------------------------------------------------------ 开始 */
const { TouchControls, isTouchDevice } = await import('../src/ui/touch.js');
const { Input } = await import('../src/core/input.js');
localStorage.clear();

/* ============================ 1. 触摸探测 ============================ */
ok('isTouchDevice() 为安全特性探测', () => {
  assert(typeof isTouchDevice() === 'boolean', '应返回布尔值');
  delete window.ontouchstart;
  window.navigator.maxTouchPoints = 0;
  assert(isTouchDevice() === false, '无触摸能力时应为 false');
  window.navigator.maxTouchPoints = 5;
  assert(isTouchDevice() === true, 'maxTouchPoints>0 时应为 true');
  delete window.navigator.maxTouchPoints;
  window.ontouchstart = null;
  assert(isTouchDevice() === true, "'ontouchstart' in window 时应为 true");
});

/* ============================ 2. 构造 / 控件清单 ============================ */
setViewport(812, 375);
const tc = new TouchControls({ container, radius: 75 });

ok('构造：根元素绝对定位、inset:0、pointer-events:none', () => {
  assert(tc.el && tc.el.parentNode === container, '未挂载到 container');
  assert(tc.el.style.position === 'absolute', 'position 应为 absolute');
  assert(tc.el.style.pointerEvents === 'none', '根应 pointer-events:none');
  assert(tc.el.classList.contains('sp2-touch-root'), '缺少 sp2-touch-root 类');
  assert(parseFloat(tc.el.style.left) === 0 && parseFloat(tc.el.style.top) === 0, 'inset 未归零');
});

ok('控件清单：双摇杆 + 油门 + 大号开火 + 武器选择器 + 6 开关 + 暂停 + 仪表', () => {
  const need = ['stickL', 'stickR', 'rudderL', 'rudderR', 'throttle', 'fire', 'selector', 'menu',
    'sw0', 'sw1', 'sw2', 'sw3', 'sw4', 'sw5', 'pause', 'readout', 'zoneL', 'zoneR', 'hint'];
  for (const n of need) assert(tc.el.querySelector(`[data-ctl="${n}"]`), '缺少控件 ' + n);
  // 旧版 12 圆按钮簇已删除
  for (const old of ['flapsUp', 'flapsDown', 'fire1', 'fire2', 'bomb', 'flare', 'brake', 'camera', 'reset', 'chute']) {
    assert(!tc.el.querySelector(`[data-action="${old}"]`), '旧按钮仍存在：' + old);
  }
  assert(tc.el.querySelectorAll('[data-ctl="fire"]').length === 1, '开火按钮应唯一');
  assert(tc.el.querySelectorAll('[data-ctl="selector"]').length === 1, '选择器应唯一');
  assert(tc.el.querySelectorAll('[data-switch]').length === 6, '开关应为 6 个');
  // 横屏宽屏的长期可见按钮应远少于 12 个
  const visible = [...tc.el.querySelectorAll('button')].filter((b) => !b.hidden && !b.closest('[hidden]'));
  assert(visible.length <= 12, `长期可见按钮 ${visible.length} 个（>12）`);
});

ok('中文标签 + Unicode 图标（无外部图片）', () => {
  const labels = [...tc.el.querySelectorAll('.sp2-touch-label')].map((n) => n.textContent);
  for (const s of ['开火', '机炮', '导弹', '炸弹', '干扰弹', '左舵', '右舵', '暂停',
    '起落架', '襟翼', '减速板', '视角', '伞', '重置']) {
    assert(labels.includes(s), '缺少中文标签 ' + s);
  }
  assert(tc.el.querySelectorAll('.sp2-touch-icon').length >= 14, '缺少图标');
  assert(!tc.el.querySelector('img'), '不应使用外部图片');
});

ok('CSS 只注入一次：sp2-touch- 前缀 + 44/76px 下限 + 安全区 + 减少动效', () => {
  const css = cssText();
  assert(css.includes('.sp2-touch-root{'), 'CSS 未注入');
  assert((css.match(/\.sp2-touch-root\{/g) || []).length === 1, 'CSS 被重复注入');
  assert(document.querySelectorAll('style#sp2-widgets').length === 1, '样式元素应唯一');
  const mine = css.slice(css.indexOf('.sp2-touch-root{'));
  const bad = [...mine.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]).filter((c) => !c.startsWith('sp2-touch-'));
  assert(bad.length === 0, '存在非 sp2-touch- 前缀类名：' + bad.slice(0, 5).join(','));
  assert(/min-width:44px/.test(mine) && /min-height:44px/.test(mine), '按钮缺少 44px 下限');
  assert(/\.sp2-touch-fire\{[\s\S]*?min-width:76px/.test(mine), '开火按钮缺少 76px 下限');
  for (const k of ['top', 'right', 'bottom', 'left']) {
    assert(mine.includes(`env(safe-area-inset-${k}`), '缺少安全区适配 ' + k);
  }
  assert(mine.includes('prefers-reduced-motion'), '缺少减少动效适配');
  assert(mine.includes('clamp(') && mine.includes('vmin'), '缺少 clamp()/vmin 自适应尺寸');
});

ok('静止时所有轴为 0，consumeEdges() 键集合固定（13 键）', () => {
  const a = tc.axes;
  for (const k of ['pitch', 'roll', 'yaw', 'throttle', 'brake', 'flaps', 'airbrake']) assert(a[k] === 0, k + ' 应为 0');
  const e = tc.consumeEdges();
  const expect = ['gear', 'camera', 'reset', 'pause', 'fire2', 'bomb', 'flare', 'chute',
    'autolevel', 'boost', 'fire1', 'brake', 'airbrake'];
  assert(Object.keys(e).length === expect.length, `边沿键数量应为 ${expect.length}，实际 ${Object.keys(e).length}`);
  for (const k of expect) { assert(k in e, '缺少键 ' + k); assert(e[k] === false, k + ' 应为 false'); }
});

/* ============================ 3. 左摇杆（俯仰/滚转） ============================ */
const zoneL = tc.el.querySelector('[data-ctl="zoneL"]');
const stickL = tc.el.querySelector('[data-ctl="stickL"]');

ok('左摇杆死区：微动（<8%）不产生轴量', () => {
  const id = nextPid();
  const radius = tc.radius;
  press(zoneL, id, 100, 600);
  zoneL.dispatchEvent(P('pointermove', 100 + radius * 0.05, 600, id));
  const roll = tc.axes.roll;
  zoneL.dispatchEvent(P('pointermove', 100, 600 + radius * 0.05, id));
  const pitch = tc.axes.pitch;
  release(zoneL, id, 100, 600);
  assert(roll === 0, '死区内 roll 应为 0，实际 ' + roll);
  assert(pitch === 0, '死区内 pitch 应为 0，实际 ' + pitch);
});

ok('左摇杆满舵：x→roll=±1，上推→pitch=-1（低头）', () => {
  const id = nextPid();
  press(zoneL, id, 100, 600);
  zoneL.dispatchEvent(P('pointermove', 100 + 300, 600, id));
  const right = tc.axes.roll;
  zoneL.dispatchEvent(P('pointermove', 100 - 300, 600, id));
  const left = tc.axes.roll;
  zoneL.dispatchEvent(P('pointermove', 100, 600 - 300, id));
  const up = tc.axes.pitch;
  const upRoll = tc.axes.roll;
  zoneL.dispatchEvent(P('pointermove', 100, 600 + 300, id));
  const down = tc.axes.pitch;
  release(zoneL, id, 100, 600);
  assert(right === 1, '右推应 roll=1，实际 ' + right);
  assert(left === -1, '左推应 roll=-1，实际 ' + left);
  assert(up === -1, '上推应 pitch=-1（低头），实际 ' + up);
  assert(upRoll === 0, '纯上推时 roll 应为 0');
  assert(down === 1, '下拉应 pitch=+1（抬头），实际 ' + down);
});

ok('左摇杆圆形钳制：斜向合成量不超过 1', () => {
  const id = nextPid();
  press(zoneL, id, 100, 600);
  zoneL.dispatchEvent(P('pointermove', 400, 900, id));
  const a = tc.axes;
  release(zoneL, id, 400, 900);
  assert(Math.hypot(a.roll, a.pitch) <= 1 + 1e-9, '斜向合成量不应超过 1');
  assert(a.roll > 0.6 && a.pitch > 0.6, '斜向应同时有效');
});

ok('松手后 ~0.18s 临界阻尼回中，摇杆环回到待命位', () => {
  const id = nextPid();
  press(zoneL, id, 100, 600);
  zoneL.dispatchEvent(P('pointermove', 100 + 300, 600, id));
  const full = tc.axes.roll;
  release(zoneL, id, 100, 600);
  const stillFloat = stickL.classList.contains('sp2-touch-stick--float');
  const justAfter = tc.axes.roll;
  assert(near(full, 1, 1e-9), '满舵未生效：' + full);
  assert(stillFloat, '松手瞬间不应立刻跳回');
  assert(near(justAfter, 1, 1e-9), '回中发生在 update() 里，松手瞬间轴量应保持');
  for (let i = 0; i < 6; i++) tc.update(1 / 60);
  const mid = Math.abs(tc.axes.roll);
  assert(mid > 0 && mid < 1, `回中应单调衰减（${mid}）`);
  for (let i = 0; i < 20; i++) tc.update(1 / 60);
  assert(tc.axes.roll === 0 && tc.axes.pitch === 0, '0.18s 后应完全回中');
  assert(!stickL.classList.contains('sp2-touch-stick--float'), '回中后摇杆环应回到待命位');
});

ok('浮动摇杆：环心跟随手指落点（按到哪就从哪开始）', () => {
  const id = nextPid();
  press(zoneL, id, 220, 300);
  const left = stickL.style.left;
  const top = stickL.style.top;
  const w = parseFloat(stickL.style.width);
  zoneL.dispatchEvent(P('pointermove', 220 + tc.radius, 300, id));
  const roll = tc.axes.roll;
  release(zoneL, id, 220, 300);
  for (let i = 0; i < 30; i++) tc.update(1 / 60);
  assert(near(parseFloat(left), 220 - w / 2, 0.02) && near(parseFloat(top), 300 - w / 2, 0.02),
    `环心未跟随落点：${left},${top} (w=${w})`);
  assert(near(roll, 1, 1e-9), '以落点为圆心的行程换算错误：' + roll);
  assert(!stickL.classList.contains('sp2-touch-stick--float'), '应恢复待命位');
});

/* ============================ 4. 右摇杆（方向舵 / 刹车 / 减速板） ============================ */
const zoneR = tc.el.querySelector('[data-ctl="zoneR"]');
const stickR = tc.el.querySelector('[data-ctl="stickR"]');

ok('右摇杆（横屏宽屏）：水平轴 → yaw，松手回中', () => {
  assert(!stickR.hidden, '宽屏应启用方向舵摇杆');
  const id = nextPid();
  press(zoneR, id, 700, 300);
  zoneR.dispatchEvent(P('pointermove', 700 + tc.radius, 300, id));
  const rightYaw = tc.axes.yaw;
  zoneR.dispatchEvent(P('pointermove', 700 - tc.radius, 300, id));
  const leftYaw = tc.axes.yaw;
  release(zoneR, id, 700, 300);
  const justAfter = tc.axes.yaw;
  assert(rightYaw === 1, '右偏航应为 1，实际 ' + rightYaw);
  assert(leftYaw === -1, '左偏航应为 -1，实际 ' + leftYaw);
  assert(justAfter === -1, '回中发生在 update() 里');
  for (let i = 0; i < 30; i++) tc.update(1 / 60);
  assert(tc.axes.yaw === 0, '松手后方向舵应回中');
});

ok('右摇杆垂直轴：下拉 = 刹车，上推 = 减速板（不丢功能）', () => {
  const id = nextPid();
  press(zoneR, id, 700, 300);
  zoneR.dispatchEvent(P('pointermove', 700, 300 + tc.radius * 0.8, id));
  const brakeDown = tc.axes.brake;
  const e1 = tc.consumeEdges();
  zoneR.dispatchEvent(P('pointermove', 700, 300 - tc.radius * 0.8, id));
  const abUp = tc.axes.airbrake;
  const yawMid = tc.axes.yaw;
  release(zoneR, id, 700, 300);
  const brakeAfter = tc.axes.brake;
  assert(brakeDown === 1, '下拉应触发刹车，实际 ' + brakeDown);
  assert(e1.brake === true, 'consumeEdges().brake 应汇报按住电平');
  assert(abUp === 1, '上推应触发减速板，实际 ' + abUp);
  assert(yawMid === 0, '垂直动作不应产生偏航');
  assert(brakeAfter === 0, '松手后刹车应释放');
});

ok('窄屏自动二选一：隐藏右摇杆，改用 左舵/右舵 按钮', () => {
  setViewport(568, 320);
  tc.setLayout();
  const rl = tc.el.querySelector('[data-ctl="rudderL"]');
  const rr = tc.el.querySelector('[data-ctl="rudderR"]');
  assert(stickR.hidden, '窄屏应隐藏方向舵摇杆');
  assert(!rl.hidden && !rr.hidden, '窄屏应显示左右舵按钮');
  assert(zoneR.hidden, '窄屏不应再占用右半屏感应区');
  const idL = nextPid();
  const idR = nextPid();
  press(rr, idR);
  const y1 = tc.axes.yaw;
  press(rl, idL);
  const y2 = tc.axes.yaw;
  release(rl, idL);
  const y3 = tc.axes.yaw;
  release(rr, idR);
  for (let i = 0; i < 30; i++) tc.update(1 / 60);
  assert(y1 === 1 && y2 === -1 && y3 === 1, `左右舵按钮异常：${y1}/${y2}/${y3}`);
  assert(tc.axes.yaw === 0, '松开后应回中');
  setViewport(812, 375);
  tc.setLayout();
  assert(!stickR.hidden && rl.hidden && rr.hidden, '宽屏应切回方向舵摇杆');
});

/* ============================ 5. 油门 ============================ */
const track = tc.el.querySelector('.sp2-touch-track');

ok('油门拖动：按轨道高度线性映射，松手后保持（不回弹）', () => {
  stubRect(track, 100, 200);
  const id = nextPid();
  press(track, id, 930, 250);
  const v1 = tc.throttle;
  track.dispatchEvent(P('pointermove', 930, 150, id));
  const v2 = tc.throttle;
  release(track, id, 930, 150);
  for (let i = 0; i < 30; i++) tc.update(1 / 60);
  assert(near(v1, 0.25, 1e-6), '油门应为 0.25，实际 ' + v1);
  assert(near(v2, 0.75, 1e-6), '拖动应为 0.75，实际 ' + v2);
  assert(near(tc.throttle, 0.75, 1e-6), '松手后油门应保持');
  assert(near(tc.axes.throttle, 0.75, 1e-6), 'axes.throttle 不同步');
  assert(tc.el.querySelector('.sp2-touch-throttle-value').textContent === '75%', '百分比显示错误');
});

ok('油门 ± 微调、钳制与 setThrottle', () => {
  const steps = tc.el.querySelectorAll('.sp2-touch-step');
  tap(steps[0]);
  assert(near(tc.throttle, 0.8, 1e-6), '步进 + 失败：' + tc.throttle);
  tap(steps[1]); tap(steps[1]);
  assert(near(tc.throttle, 0.7, 1e-6), '步进 − 失败：' + tc.throttle);
  tc.setThrottle(2); assert(tc.throttle === 1, 'setThrottle 应钳制到 1');
  tc.setThrottle(-5); assert(tc.throttle === 0, 'setThrottle 应钳制到 0');
  tc.setThrottle(0.6); assert(near(tc.throttle, 0.6, 1e-6), 'setThrottle 失败');
});

ok('油门可选持久化（store）', () => {
  const a = new TouchControls({ container, rememberThrottle: true });
  a.setThrottle(0.42);
  a.dispose();
  const b = new TouchControls({ container, rememberThrottle: true });
  assert(near(b.throttle, 0.42, 1e-6), '未记住上次油门：' + b.throttle);
  b.dispose();
  localStorage.clear();
});

/* ============================ 6. 大号开火 + 武器选择器 ============================ */
const fire = tc.el.querySelector('[data-ctl="fire"]');
const selector = tc.el.querySelector('[data-ctl="selector"]');
const menu = tc.el.querySelector('[data-ctl="menu"]');

ok('开火按钮 ≥76px 且按下有反馈', () => {
  const b = boxOf(fire);
  assert(b.w >= 76 && b.h >= 76, `开火按钮应 ≥76px，实际 ${b.w}x${b.h}`);
  assert(fire.classList.contains('sp2-touch-fire'), '缺少开火按钮专属类');
  const id = nextPid();
  press(fire, id);
  assert(fire.classList.contains('sp2-touch-btn--on'), '按下应有按压态');
  release(fire, id);
  assert(!fire.classList.contains('sp2-touch-btn--on'), '松开应移除按压态');
});

ok('武器映射：机炮→fire1（按住电平）/ 导弹→fire2', () => {
  tc.setWeapon('fire1');
  const id1 = nextPid();
  press(fire, id1);
  let e = tc.consumeEdges();
  tc.update(1 / 60);
  const again = tc.consumeEdges();
  release(fire, id1);
  assert(e.fire1 === true, '机炮应按住电平汇报 fire1');
  assert(e.fire2 === false && e.bomb === false && e.flare === false, '机炮不应触发其它武器键');
  assert(again.fire1 === true, '按住应每帧持续汇报 fire1');
  assert(tc.consumeEdges().fire1 === false, '松开后应停止汇报 fire1');
  tc.setWeapon('fire2');
  const id2 = nextPid();
  press(fire, id2);
  e = tc.consumeEdges();
  release(fire, id2);
  assert(e.fire2 === true && e.fire1 === false, '导弹应汇报 fire2');
});

ok('武器映射：炸弹 / 干扰弹为边沿 + 按住节奏连发', () => {
  tc.setWeapon('bomb');
  const id = nextPid();
  press(fire, id);
  const first = tc.consumeEdges();
  const second = tc.consumeEdges();
  assert(first.bomb === true, '炸弹应在按下时产生边沿');
  assert(second.bomb === false, '边沿应被 consume 清空');
  tc.update(0.2);
  assert(tc.consumeEdges().bomb === false, '未到连发间隔不应补边沿');
  tc.update(0.25); tc.update(0.25); tc.update(0.25);
  assert(tc.consumeEdges().bomb === true, '按住应节奏连发');
  release(fire, id);
  tc.setWeapon('flare');
  const id2 = nextPid();
  press(fire, id2);
  const fl = tc.consumeEdges();
  release(fire, id2);
  assert(fl.flare === true, '干扰弹应产生 flare 边沿');
  assert(fl.bomb === false, '切换武器后不应再发炸弹');
});

ok('武器选择器：弹出列表 → 选择 → 收起并更新显示', () => {
  assert(menu.hidden, '默认应收起');
  tap(selector);
  assert(!menu.hidden, '点击选择器应展开列表');
  const items = tc.el.querySelectorAll('[data-role="menu-item"]');
  assert(items.length === 4, '列表应有 4 项');
  assert([...items].map((b) => b.dataset.weapon).join(',') === 'fire1,fire2,bomb,flare',
    '列表顺序应为 机炮/导弹/炸弹/干扰弹');
  tap(tc.el.querySelector('[data-ctl="wpn1"]'));
  assert(tc.weapon === 'fire2', '应选中导弹，实际 ' + tc.weapon);
  assert(menu.hidden, '选择后应收起列表');
  assert(selector.querySelector('.sp2-touch-label').textContent === '导弹', '选择器未更新武器名');
  assert(fire.querySelector('.sp2-touch-icon').textContent === '\u{1F680}', '开火按钮图标未跟随武器');
  tap(selector);
  tap(selector);
  assert(menu.hidden, '再次点击应收起');
  tc.setWeapon('fire1');
});

ok('余量：显示在列表/仪表，为 0 时置灰且不可开火', () => {
  tc.setAmmo({ fire1: 12, fire2: 0, bomb: 3, flare: null });
  const item0 = tc.el.querySelector('[data-ctl="wpn0"]');
  const item1 = tc.el.querySelector('[data-ctl="wpn1"]');
  assert(item0.querySelector('.sp2-touch-ammo').textContent === '12', '列表余量显示错误');
  assert(!item0.classList.contains('sp2-touch-btn--off'), '有余量不应置灰');
  assert(item1.classList.contains('sp2-touch-btn--off'), '余量 0 应置灰');
  tc.setWeapon('fire2');
  assert(fire.classList.contains('sp2-touch-btn--off'), '无余量时开火按钮应置灰');
  const id = nextPid();
  press(fire, id);
  const e = tc.consumeEdges();
  release(fire, id);
  assert(e.fire2 === false, '无余量时不应产生开火边沿');
  tc.setWeapon('fire1');
  assert(!fire.classList.contains('sp2-touch-btn--off'), '切回机炮应恢复可用');
  tc.setAmmo({ fire1: null, fire2: null, bomb: null, flare: null });
});

/* ============================ 7. 开关行 ============================ */
const sw = (id) => tc.el.querySelector(`[data-switch="${id}"]`);

ok('起落架开关：一次边沿 + 指示灯 + 仪表 GEAR', () => {
  const before = tc.consumeEdges().gear;
  tap(sw('gear'));
  const e = tc.consumeEdges();
  assert(before === false, '初始不应有 gear 边沿');
  assert(e.gear === true, '起落架应产生 gear 边沿');
  assert(tc.consumeEdges().gear === false, '边沿应被清空');
  assert(sw('gear').classList.contains('sp2-touch-btn--on'), '起落架应点亮');
  const readout = tc.el.querySelector('[data-ctl="readout"]');
  tc.setGear(false);
  assert(readout.textContent.includes('GEAR'), '仪表应含 GEAR');
  tc.setGear(true);
  assert(readout.textContent.includes('▼'), '放下起落架应显示 ▼');
  tc.setGear(false);
  assert(readout.textContent.includes('▲'), '收起起落架应显示 ▲');
});

ok('襟翼：单个开关循环 0 → 1/3 → 2/3 → 1 → 0（上下都可调，功能不丢）', () => {
  const seen = [];
  for (let i = 0; i < 4; i++) { tap(sw('flap')); seen.push(+tc.axes.flaps.toFixed(3)); }
  assert(near(seen[0], 1 / 3, 1e-3) && near(seen[1], 2 / 3, 1e-3) && near(seen[2], 1, 1e-3) && near(seen[3], 0, 1e-3),
    '襟翼档位异常：' + JSON.stringify(seen));
  assert(tc.axes.flaps === 0, '循环应回到 0');
  assert(sw('flap').classList.contains('sp2-touch-btn--on') === false, '0 档不应点亮');
  tap(sw('flap'));
  assert(sw('flap').classList.contains('sp2-touch-btn--on'), '非 0 档应点亮');
  tap(sw('flap')); tap(sw('flap')); tap(sw('flap'));
  assert(tc.axes.flaps === 0, '应回到 0 档');
});

ok('减速板开关（锁定）：axes.airbrake 与 consumeEdges 电平', () => {
  tap(sw('airbrake'));
  assert(tc.axes.airbrake === 1, '减速板应开启');
  assert(tc.consumeEdges().airbrake === true, '应汇报 airbrake 电平');
  assert(sw('airbrake').classList.contains('sp2-touch-btn--on'), '应点亮');
  tap(sw('airbrake'));
  assert(tc.axes.airbrake === 0, '再按应关闭');
  assert(sw('airbrake').classList.contains('sp2-touch-btn--on') === false, '应熄灭');
});

ok('视角 / 伞 / 重置 为一次性边沿', () => {
  for (const id of ['camera', 'chute', 'reset']) {
    tap(sw(id));
    assert(tc.consumeEdges()[id] === true, id + ' 未产生边沿');
    assert(tc.consumeEdges()[id] === false, id + ' 边沿未清空');
  }
});

ok('暂停按钮为一次性边沿 pause', () => {
  tap(tc.el.querySelector('[data-ctl="pause"]'));
  assert(tc.consumeEdges().pause === true, 'pause 边沿缺失');
  assert(tc.consumeEdges().pause === false, 'pause 边沿未清空');
});

ok('仪表读数：油门% / 武器+余量 / FLAP', () => {
  const readout = tc.el.querySelector('[data-ctl="readout"]');
  tc.setThrottle(0.42);
  tc.setWeapon('bomb');
  tc.setAmmo({ bomb: 7 });
  const txt = readout.textContent;
  assert(txt.includes('42%'), '应显示油门百分比：' + txt);
  assert(txt.includes('炸弹') && txt.includes('7'), '应显示当前武器与余量：' + txt);
  assert(/FLAP\s*\d+%/.test(txt), '应显示襟翼状态：' + txt);
  tc.setAmmo({ bomb: null });
  tc.setWeapon('fire1');
  tc.setThrottle(0.6);
});

/* ============================ 8. 多点触控 / 显隐 ============================ */
ok('多点触控：左摇杆 + 右摇杆 + 开火 + 油门可同时操作', () => {
  stubRect(track, 100, 200);
  const idL = nextPid(), idR = nextPid(), idF = nextPid(), idT = nextPid();
  press(zoneL, idL, 100, 600);
  zoneL.dispatchEvent(P('pointermove', 100 + 300, 600, idL));
  press(zoneR, idR, 700, 300);
  zoneR.dispatchEvent(P('pointermove', 700 + 300, 300, idR));
  press(fire, idF);
  press(track, idT, 930, 100);
  const a = tc.axes;
  const e = tc.consumeEdges();
  release(zoneL, idL, 100, 600);
  release(zoneR, idR, 700, 300);
  release(fire, idF);
  release(track, idT, 930, 100);
  assert(a.roll === 1, '左摇杆未生效：' + a.roll);
  assert(a.yaw === 1, '右摇杆未生效：' + a.yaw);
  assert(e.fire1 === true, '开火未生效');
  assert(near(a.throttle, 1, 1e-6), '油门未生效：' + a.throttle);
  for (let i = 0; i < 30; i++) tc.update(1 / 60);
});

ok('setVisible：隐藏时释放瞬时输入，但保留油门 / 襟翼', () => {
  tc.setThrottle(0.6);
  const id = nextPid();
  press(zoneL, id, 100, 600);
  zoneL.dispatchEvent(P('pointermove', 100 + 300, 600, id));
  press(fire, id);
  const rolled = tc.axes.roll;
  tc.setVisible(false);
  const hiddenVisible = tc.visible;
  const hiddenClass = tc.el.classList.contains('sp2-touch-hidden');
  const afterRoll = tc.axes.roll;
  const afterFire = tc.consumeEdges().fire1;
  const keptThrottle = tc.throttle;
  release(zoneL, id, 100, 600);
  release(fire, id);
  assert(rolled === 1, '前置条件：摇杆满舵');
  assert(hiddenVisible === false && hiddenClass, '隐藏状态异常');
  assert(afterRoll === 0 && afterFire === false, '隐藏时应释放输入');
  assert(near(keptThrottle, 0.6, 1e-6), '隐藏不应重置油门');
  tc.setVisible(true);
  assert(tc.visible === true && !tc.el.classList.contains('sp2-touch-hidden'), '恢复显示失败');
});

/* ============================ 9. 布局不变量 ============================ */
ok('横屏布局：中央 ±15% 留空、互不重叠、≥44px、开火 ≥76px、可见按钮 ≤12', () => {
  for (const [w, h] of [[480, 320], [568, 320], [667, 375], [812, 375], [896, 414], [1024, 768], [1180, 820]]) {
    checkLayout(w, h, 1);
  }
});

ok('竖屏布局：不重叠、不进入中央留空区、可完全游玩', () => {
  for (const [w, h] of [[320, 568], [360, 640], [390, 844], [414, 896], [768, 1024]]) {
    checkLayout(w, h, 1);
    localStorage.clear();
    setViewport(w, h);
    const t = new TouchControls({ container });
    assert(!t.el.querySelector('[data-ctl="hint"]').hidden, `竖屏应显示提示 @${w}x${h}`);
    assert(t.el.querySelector('[data-ctl="stickR"]').hidden, `竖屏应隐藏方向舵摇杆 @${w}x${h}`);
    assert(!t.el.querySelector('[data-ctl="rudderL"]').hidden, `竖屏应显示左舵按钮 @${w}x${h}`);
    t.dispose();
    localStorage.clear();
  }
  setViewport(812, 375);
  tc.setLayout();
});

ok('缩放 0.8 / 1.3 下布局不变量依旧成立', () => {
  for (const s of [0.8, 1.3]) {
    for (const [w, h] of [[480, 320], [812, 375], [1024, 768], [360, 640]]) checkLayout(w, h, s);
  }
});

ok('横竖屏结构：开关行横排/两列，摇杆与方向舵按钮二选一', () => {
  localStorage.clear();
  setViewport(812, 375);
  const t = new TouchControls({ container });
  const swBoxes = [0, 1, 2, 3, 4, 5].map((i) => boxOf(t.el.querySelector(`[data-ctl="sw${i}"]`)));
  for (const b of swBoxes) assert(near(b.y, swBoxes[0].y, 0.01), '横屏开关应在同一行');
  assert(swBoxes[1].x > swBoxes[0].x, '横屏开关应横向排列');
  assert(!t.el.querySelector('[data-ctl="stickR"]').hidden, '横屏宽屏应有方向舵摇杆');
  assert(t.el.querySelector('[data-ctl="rudderL"]').hidden, '横屏宽屏不应同时显示左右舵按钮');
  t.dispose();

  setViewport(360, 640);
  const t2 = new TouchControls({ container });
  const sw2 = [0, 1, 2, 3, 4, 5].map((i) => boxOf(t2.el.querySelector(`[data-ctl="sw${i}"]`)));
  assert(near(sw2[1].y, sw2[0].y, 0.01) && sw2[1].x > sw2[0].x, '竖屏开关应为两列');
  assert(near(sw2[2].x, sw2[0].x, 0.01) && sw2[2].y > sw2[0].y, '竖屏开关应换行排列');
  t2.dispose();
  localStorage.clear();
  setViewport(812, 375);
  tc.setLayout();
});

ok('展开的武器列表也在屏内且不遮挡中央', () => {
  for (const [w, h] of [[812, 375], [568, 320], [360, 640]]) {
    localStorage.clear();
    setViewport(w, h);
    const t = new TouchControls({ container });
    tap(t.el.querySelector('[data-ctl="selector"]'));
    const m = t.el.querySelector('[data-ctl="menu"]');
    assert(!m.hidden, '列表未展开');
    const b = boxOf(m);
    assert(b.x >= -0.5 && b.y >= -0.5 && b.x1 <= w + 0.5 && b.y1 <= h + 0.5, `列表出屏 ${w}x${h}`);
    assert(!intersects(b, CENTER_OF(w, h)), `列表遮挡中央 ${w}x${h}`);
    t.dispose();
    localStorage.clear();
  }
  setViewport(812, 375);
  tc.setLayout();
});

/* ============================ 10. 可调：透明度 / 缩放 ============================ */
ok('setOpacity / setScale 生效并被 store 记住', () => {
  localStorage.clear();
  setViewport(1024, 768);
  const a = new TouchControls({ container });
  const fireBefore = boxOf(a.el.querySelector('[data-ctl="fire"]')).w;
  a.setOpacity(0.55);
  a.setScale(1.25);
  const fireAfter = boxOf(a.el.querySelector('[data-ctl="fire"]')).w;
  assert(a.el.style.opacity === '0.55', '透明度未落到根元素：' + a.el.style.opacity);
  assert(a.opacity === 0.55 && a.scale === 1.25, 'setOpacity/setScale 未生效');
  assert(fireAfter > fireBefore * 1.15, `缩放未改变控件尺寸：${fireBefore} → ${fireAfter}`);
  a.dispose();
  const b = new TouchControls({ container });
  assert(near(b.opacity, 0.55, 1e-6), '透明度未被 store 记住：' + b.opacity);
  assert(near(b.scale, 1.25, 1e-6), '缩放未被 store 记住：' + b.scale);
  assert(b.el.style.opacity === '0.55', '恢复的透明度未应用');
  b.setScale(1);
  b.setOpacity(1);
  assert(b.scale === 1 && b.opacity === 1, '复位失败');
  b.dispose();
  const c = new TouchControls({ container });
  c.setOpacity(0.05); assert(c.opacity === 0.3, '透明度下限应为 0.3');
  c.setScale(9); assert(c.scale === 1.3, '缩放上限应为 1.3');
  c.setScale(0.1); assert(c.scale === 0.8, '缩放下限应为 0.8');
  c.dispose();
  localStorage.clear();
  setViewport(812, 375);
  tc.setLayout();
});

/* ============================ 11. 反馈 / 动效 ============================ */
ok('按下触发 navigator.vibrate(10)（恰好一次）', () => {
  const calls = [];
  window.navigator.vibrate = (ms) => { calls.push(ms); return true; };
  try {
    tap(sw('camera'));
    assert(calls.length === 1 && calls[0] === 10, '应恰好调用一次 vibrate(10)：' + JSON.stringify(calls));
  } finally { delete window.navigator.vibrate; }
  tap(sw('camera'));   // 无 vibrate 时不应抛异常
});

ok('prefers-reduced-motion：跳过震动并立即回中', () => {
  const prev = window.matchMedia;
  window.matchMedia = (q) => ({
    matches: true, media: q, onchange: null,
    addListener() { }, removeListener() { }, addEventListener() { }, removeEventListener() { }, dispatchEvent() { return false; },
  });
  const calls = [];
  window.navigator.vibrate = (ms) => { calls.push(ms); return true; };
  try {
    const r = new TouchControls({ container, radius: 75 });
    assert(r.reducedMotion === true, '未识别减少动效偏好');
    const z = r.el.querySelector('[data-ctl="zoneL"]');
    const id = nextPid();
    press(z, id, 100, 600);
    z.dispatchEvent(P('pointermove', 100 + 300, 600, id));
    tap(r.el.querySelector('[data-switch="gear"]'));
    assert(calls.length === 0, '减少动效下不应震动');
    release(z, id, 100, 600);
    r.update(1 / 60);
    assert(r.axes.roll === 0, '减少动效下应瞬间回中');
    r.dispose();
  } finally {
    if (prev === undefined) delete window.matchMedia; else window.matchMedia = prev;
    delete window.navigator.vibrate;
  }
});

/* ============================ 12. touch 事件回退 ============================ */
ok('无 PointerEvent 时回退到 touch 事件（摇杆/油门/开火/开关）', () => {
  const saved = window.PointerEvent;
  window.PointerEvent = undefined;
  try {
    const t = new TouchControls({ container, radius: 75 });
    const z = t.el.querySelector('[data-ctl="zoneL"]');
    const tr = t.el.querySelector('.sp2-touch-track');
    stubRect(tr, 100, 200);
    z.dispatchEvent(T('touchstart', 100, 600, 1));
    z.dispatchEvent(T('touchmove', 100 + 75 * 0.54, 600, 1));
    const linear = t.axes.roll;
    z.dispatchEvent(T('touchmove', 400, 600, 1));
    const full = t.axes.roll;
    z.dispatchEvent(T('touchend', 400, 600, 1));
    for (let i = 0; i < 30; i++) t.update(1 / 60);
    assert(near(linear, (0.54 - 0.08) / 0.92, 1e-6), 'touch 摇杆死区映射错误：' + linear);
    assert(full === 1, 'touch 摇杆满舵错误：' + full);
    assert(t.axes.roll === 0, 'touch 摇杆回中失败');
    tr.dispatchEvent(T('touchstart', 930, 150, 2));
    const th = t.throttle;
    tr.dispatchEvent(T('touchend', 930, 150, 2));
    assert(near(th, 0.75, 1e-6), 'touch 油门失败：' + th);
    const f = t.el.querySelector('[data-ctl="fire"]');
    f.dispatchEvent(T('touchstart', 0, 0, 3));
    const fe = t.consumeEdges();
    f.dispatchEvent(T('touchend', 0, 0, 3));
    assert(fe.fire1 === true, 'touch 开火未生效');
    const g = t.el.querySelector('[data-switch="gear"]');
    g.dispatchEvent(T('touchstart', 0, 0, 4));
    const ge = t.consumeEdges();
    g.dispatchEvent(T('touchend', 0, 0, 4));
    assert(ge.gear === true, 'touch 开关未生效');
    t.dispose();
  } finally { window.PointerEvent = saved; }
});

/* ============================ 13. 健壮性 ============================ */
ok('缺 container / 空参数也能构造，且不抛异常', () => {
  const list = [new TouchControls(), new TouchControls({ container: undefined }), new TouchControls(null)];
  for (const t of list) {
    assert(t.el && t.el.parentNode === null, '无容器时不应挂载');
    t.update(1 / 60); t.setLayout(); t.setThrottle(0.33); t.setVisible(false);
    t.setOpacity(0.5); t.setScale(1.1);
    assert(t.axes.throttle === 0.33, '无容器时 API 仍应可用');
    assert(t.consumeEdges().gear === false, '无容器时边沿应可消费');
    t.dispose();
  }
  localStorage.clear();
});

ok('onChange 回调被触发，且回调抛异常不影响输入', () => {
  let n = 0;
  const t = new TouchControls({ container, onChange: () => { n++; throw new Error('boom'); } });
  const z = t.el.querySelector('[data-ctl="zoneL"]');
  const id = nextPid();
  press(z, id, 100, 600);
  z.dispatchEvent(P('pointermove', 400, 600, id));
  const roll = t.axes.roll;
  release(z, id, 400, 600);
  assert(n > 0, 'onChange 未被调用');
  assert(roll === 1, '回调异常不应影响输入采集');
  t.dispose();
});

ok('dispose：移除 DOM、可重复调用、之后事件不抛异常', () => {
  const t = new TouchControls({ container });
  const root = t.el;
  t.dispose();
  assert(root.parentNode === null, 'dispose 应移除根元素');
  t.dispose();
  t.update(1 / 60); t.setLayout(); t.consumeEdges();
  assert(t.el, '根引用保留（已脱离文档）');
});

ok('样式注入幂等：多次构造只有一个 style 与一份 touch CSS', () => {
  const many = [new TouchControls({ container }), new TouchControls({ container }), new TouchControls({ container })];
  assert(document.querySelectorAll('style#sp2-widgets').length === 1, 'style 元素应唯一');
  assert((cssText().match(/\.sp2-touch-root\{/g) || []).length === 1, 'CSS 正文被重复注入');
  for (const t of many) t.dispose();
});

ok('纯 Node（无 document / window）导入与构造安全', () => {
  const code = `
    import { TouchControls, isTouchDevice } from './src/ui/touch.js';
    if (isTouchDevice() !== false) { console.error('isTouchDevice 应为 false'); process.exit(3); }
    const t = new TouchControls({ container: null });
    if (t.el !== null) { console.error('无 document 时 el 应为 null'); process.exit(4); }
    t.setThrottle(0.3); t.update(1/60); t.setLayout(); t.setVisible(false);
    t.setOpacity(0.6); t.setScale(1.2);
    const a = t.axes;
    if (a.throttle !== 0.3 || a.pitch !== 0 || a.roll !== 0) { console.error('轴量异常'); process.exit(5); }
    if (Object.keys(t.consumeEdges()).length !== 13) { console.error('边沿字段数量异常'); process.exit(6); }
    if (t.getLayout() !== null) { console.error('无 document 时 layout 应为 null'); process.exit(7); }
    t.dispose();
    console.log('nodom-ok');
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, encoding: 'utf8' });
  assert(out.includes('nodom-ok'), '子进程输出异常：' + out);
});

/* ============================ 14. 与 core/input.js 集成 ============================ */
ok('与 core/input.js 集成：touch 模式下轴量与边沿正确合流', () => {
  localStorage.clear();
  setViewport(812, 375);
  const input = new Input(document.body, { pointerLock: false });
  input.mode = 'touch';
  const t = new TouchControls({ container, radius: 75 });
  input.touch = t;
  try {
    const z = t.el.querySelector('[data-ctl="zoneL"]');
    const zr = t.el.querySelector('[data-ctl="zoneR"]');
    const tr = t.el.querySelector('.sp2-touch-track');
    stubRect(tr, 100, 200);
    const idL = nextPid();
    press(z, idL, 100, 600);
    z.dispatchEvent(P('pointermove', 400, 600, idL));
    let a = input.update(1 / 60, {});
    assert(a.roll === 1, 'input.axes.roll 未合流：' + a.roll);
    release(z, idL, 400, 600);
    const idR = nextPid();
    press(zr, idR, 700, 300);
    zr.dispatchEvent(P('pointermove', 700 + 75, 300, idR));
    a = input.update(1 / 60, {});
    assert(a.yaw === 1, 'input.axes.yaw 未合流：' + a.yaw);
    release(zr, idR, 700, 300);
    const idT = nextPid();
    press(tr, idT, 930, 150);
    release(tr, idT, 930, 150);
    a = input.update(1 / 60, {});
    assert(near(a.throttle, 0.75, 1e-6), '油门未合流：' + a.throttle);
    // 机炮（按住）→ input.edges.fire1
    t.setWeapon('fire1');
    const f = t.el.querySelector('[data-ctl="fire"]');
    const idF = nextPid();
    press(f, idF);
    input.update(1 / 60, {});
    assert(input.edges.fire1 === true, 'fire1 按住未合流');
    release(f, idF);
    input.update(1 / 60, {});
    assert(input.edges.fire1 === false, 'fire1 松开未合流');
    // 导弹（按住电平 → fire2）
    t.setWeapon('fire2');
    const idF2 = nextPid();
    press(f, idF2);
    input.update(1 / 60, {});
    assert(input.edges.fire2 === true, 'fire2 未合流');
    release(f, idF2);
    // 炸弹（一次性边沿只亮一帧）
    t.setWeapon('bomb');
    tap(f);
    input.update(1 / 60, {});
    assert(input.edges.bomb === true, 'bomb 边沿未合流');
    input.update(1 / 60, {});
    assert(input.edges.bomb === false, 'bomb 边沿未清空');
    // 起落架 / 刹车
    tap(t.el.querySelector('[data-switch="gear"]'));
    input.update(1 / 60, {});
    assert(input.edges.gear === true, 'gear 边沿未合流');
    const idB = nextPid();
    press(zr, idB, 700, 300);
    zr.dispatchEvent(P('pointermove', 700, 300 + 60, idB));
    a = input.update(1 / 60, {});
    assert(a.brake === 1, 'brake 未合流');
    release(zr, idB, 700, 300);
    a = input.update(1 / 60, {});
    assert(a.brake === 0, 'brake 松开未合流');
  } finally {
    input.dispose();
    t.dispose();
    localStorage.clear();
    setViewport(812, 375);
  }
});

/* ------------------------------------------------------------------ 收尾 */
tc.dispose();
console.log(fails ? `\n❌ 触摸控制测试：${count - fails}/${count} 通过，${fails} 项失败` : `\n✅ 触摸控制测试全部通过（${count} 项）`);
process.exit(fails ? 1 : 0);
