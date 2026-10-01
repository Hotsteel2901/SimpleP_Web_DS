/**
 * tests/builder-smoke.mjs —— 机库建造器（src/ui/builder.js）冒烟测试
 * ==================================================================
 * 用 jsdom 跑真实的 DOM/事件路径。WebGL 在 jsdom 里不可用，
 * 因此用一个「假渲染器 + 纯 JS 场景」把渲染调用吃掉，从而可以验证：
 *   - 构造 / 净化坏数据 / 载入库存机 / 预览装配 / 撤销重做 / JSON 往返 / 生命周期
 *   - 触屏交互：点按选中（相机不动）、拖动已选零件（按步长吸附）、
 *     未选中第一次拖动只选中、长按小菜单、模式切换、手柄命中半径
 *   - 数值微调面板（扳手）：−/＋ 步进、长按连点（400ms/80ms）、一次按压只一条撤销、
 *     实时数值反馈、镜像/复制/删除
 *   - 触屏布局：根类名、底部面板搬运（零件库/微调/属性/统计）、chip、两列网格、按钮 ≥44px
 *   - 双指手势：捏合缩放 / 平移 / 两指绕圈旋转视角
 *
 * 运行： node tests/builder-smoke.mjs      （需要 jsdom：npm i jsdom --no-save）
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

/* ------------------------------------------------------------------ jsdom 环境 */
const dom = new JSDOM(`<!doctype html><html><head></head><body>
  <div id="ui"></div><div class="sp2-menu" style="display:flex">主菜单</div>
</body></html>`, { pretendToBeVisual: true, url: 'http://localhost:8080/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
try { Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true }); } catch (e) { /* Node 自带 navigator */ }
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.Element = window.Element;
globalThis.localStorage = window.localStorage;
globalThis.devicePixelRatio = 1;

const THREE = await import('three');
const { Builder, isTouchDevice } = await import('../src/ui/builder.js');
const { stockCrafts } = await import('../src/build/crafts.js');
const { PART_DEFS } = await import('../src/build/parts.js');

/* ------------------------------------------------------------------ 测试脚手架 */
let passed = 0;
const failures = [];
function ok(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) {
    failures.push(name);
    console.error('  ✗', name, '\n     ', e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e);
    process.exitCode = 1;
  }
}
async function okAsync(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) {
    failures.push(name);
    console.error('  ✗', name, '\n     ', e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e);
    process.exitCode = 1;
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 800, H = 450;

/** 给元素一个假的布局尺寸（jsdom 不做布局） */
function size(el, w, h) {
  Object.defineProperty(el, 'clientWidth', { value: w, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: h, configurable: true });
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h, x: 0, y: 0 });
  return el;
}

/** jsdom 没有 WebGL：装一个假渲染器 + 纯 JS 场景，模拟浏览器里渲染器可用 */
function installFakeGL(b) {
  b._renderer = {
    shadowMap: {}, domElement: b.canvas,
    setSize() {}, setPixelRatio() {}, dispose() {}, forceContextLoss() {}, render() {},
  };
  b._broken = false;
  b._brokenNote?.classList.add('sp-hidden');
  b._scene = new THREE.Scene();
  b._camera = new THREE.PerspectiveCamera(55, W / H, 0.1, 3000);
  b._buildSceneStatics();
  b._buildGizmo();
  b._rebuildPreview();
  b._frameCraft();
  b._updateCamera();
  b._camera.updateMatrixWorld(true);
}

/** 世界坐标 -> 屏幕 CSS 像素（与 builder 内 _updateNDC 使用同一块 800×450 舞台） */
function screenOf(b, pos) {
  const v = new THREE.Vector3(pos[0], pos[1], pos[2]).project(b._camera);
  return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H };
}

/** 找一个"在其屏幕位置上射线确实命中自己"的零件（避免遮挡造成不确定性） */
function findHittable(b) {
  for (const p of b.craft.parts) {
    const s = screenOf(b, p.pos);
    if (s.x < 6 || s.y < 6 || s.x > W - 6 || s.y > H - 6) continue;
    const hit = b._pickPart(s.x, s.y);
    if (hit && hit.uid === p.uid) return { part: p, s };
  }
  return null;
}

/** 分发一个 pointer 事件（jsdom 没有 PointerEvent，直接补属性） */
function pointer(b, type, props = {}) {
  const ev = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, {
    clientX: 0, clientY: 0, button: 0, buttons: 0, pointerId: 1, pointerType: 'touch', shiftKey: false,
  }, props);
  b._stage.dispatchEvent(ev);
  return ev;
}
function tap(b, x, y, opts = {}) {
  pointer(b, 'pointerdown', { clientX: x, clientY: y, ...opts });
  pointer(b, 'pointerup', { clientX: x, clientY: y, ...opts });
}
function drag(b, from, to, opts = {}) {
  pointer(b, 'pointerdown', { clientX: from.x, clientY: from.y, ...opts });
  const steps = 4;
  for (let i = 1; i <= steps; i++) {
    pointer(b, 'pointermove', {
      clientX: from.x + (to.x - from.x) * i / steps,
      clientY: from.y + (to.y - from.y) * i / steps,
      ...opts,
    });
  }
  pointer(b, 'pointerup', { clientX: to.x, clientY: to.y, ...opts });
}
/** 分发一个"按下"事件到元素（nudge 按钮连点用） */
function press(el) {
  const ev = new window.Event('pointerdown', { bubbles: true, cancelable: true });
  Object.assign(ev, { clientX: 0, clientY: 0, button: 0, pointerId: 1, pointerType: 'touch' });
  el.dispatchEvent(ev);
}
function releaseWindow() {
  window.dispatchEvent(new window.Event('pointerup'));
}

const container = document.getElementById('ui');
const clone = (o) => JSON.parse(JSON.stringify(o));
const stocks = stockCrafts();
const trainer = stocks.find((c) => c.name === 'Sky Trainer');

/* ------------------------------------------------------------------ 构造 */
console.log('# 构造 / 降级 / 净化');
const b = new Builder({ container, onExit() {}, onFly() {}, onSave() {}, getCrafts: () => [] });
size(b._stage, W, H);
size(container, 1280, 720);
ok('isTouchDevice() 返回布尔值，且默认布局与之一致', () => {
  assert.equal(typeof isTouchDevice(), 'boolean');
  assert.equal(b.touchLayout, isTouchDevice());
});
ok('构造成功并挂载到容器', () => {
  assert.ok(b.el);
  assert.equal(container.children.length, 1);
  assert.ok(b.craft && Array.isArray(b.craft.parts));
  assert.equal(b.mode, 'move', '默认模式 = 移动');
  assert.equal(b.nudgePanelVisible, false, '桌面默认不展开微调面板');
});
ok('open() 在 WebGL 不可用时仍可用（降级）', () => {
  b.open();
  assert.equal(b._open, true);
  assert.equal(b._broken, true);
  assert.ok(b.el.classList.contains('sp2-builder'));
});
ok('setCraft(null / 垃圾数据) 不抛异常', () => {
  b.setCraft(null);
  b.setCraft({ parts: 'nope' });
  b.setCraft({ parts: [null, 1, { def: '不存在' }, { def: 'wing', pos: 'x', size: [1] }] });
  assert.equal(b.craft.parts.length, 1);
  assert.deepEqual(b.craft.parts[0].pos, [0, 0, 0]);
  assert.equal(b.craft.parts[0].size.length, 3);
});
ok('重复 uid 会被重新分配', () => {
  const clean = b._sanitizeCraft({ parts: [{ def: 'wing', uid: 7, pos: [1, 0, 0] }, { def: 'wing', uid: 7, pos: [-1, 0, 0] }] });
  assert.notEqual(clean.parts[0].uid, clean.parts[1].uid);
});

/* ------------------------------------------------------------------ 载入 + 预览 */
console.log('# 载入库存机 / 预览 / 面板');
ok('open(库存机) 克隆并净化（不污染源数据）', () => {
  b.open(clone(trainer));
  assert.equal(b.craft.parts.length, trainer.parts.length);
  assert.notEqual(b.craft.parts, trainer.parts);
  assert.notEqual(b.craft.parts[0], trainer.parts[0]);
  assert.equal(b._history.length, 0);
});
ok('隐藏可能盖住建造器的主菜单（.sp2-menu）', () => {
  assert.equal(document.querySelector('.sp2-menu').style.display, 'none');
});
ok('预览模型与飞行装配一致，且世界坐标 == part.pos', () => {
  installFakeGL(b);
  assert.equal(b._preview.meshes.size, b.craft.parts.length);
  const p = b.craft.parts[0];
  const m = b._preview.meshes.get(p.uid);
  b._preview.group.updateMatrixWorld(true);
  const w = new THREE.Vector3();
  m.getWorldPosition(w);
  assert.ok(w.distanceTo(new THREE.Vector3(...p.pos)) < 1e-6);
});
ok('渲染一帧 / 统计与面板刷新不抛异常', () => {
  b.update(0.016);
  b._refreshStats();
  b._refreshPanels();
  assert.ok(b._statsBody.children.length > 5);
});

/* ------------------------------------------------------------------ 点按 / 拖动 */
console.log('# 点按（tap）与拖动（触屏核心）');
ok('点按零件 = 选中，且相机完全不动', () => {
  b.clearSelection();
  const found = findHittable(b);
  assert.ok(found, '应能找到可命中的零件');
  const yaw0 = b._orbit.yaw, pitch0 = b._orbit.pitch, dist0 = b._orbit.dist;
  const target0 = b._orbit.target.clone();
  tap(b, found.s.x, found.s.y);
  assert.equal(b.selectedParts().length, 1);
  assert.equal(b.selectedParts()[0].uid, found.part.uid);
  assert.equal(b._orbit.yaw, yaw0);
  assert.equal(b._orbit.pitch, pitch0);
  assert.equal(b._orbit.dist, dist0);
  assert.equal(b._orbit.target.distanceTo(target0), 0);
});
ok('点按空白 = 取消选择，相机不动', () => {
  const yaw0 = b._orbit.yaw;
  tap(b, W - 20, 20);
  assert.equal(b.selectedParts().length, 0);
  assert.equal(b._orbit.yaw, yaw0);
});
ok('点按的小抖动（< 10px）仍视为点按', () => {
  const found = findHittable(b);
  const yaw0 = b._orbit.yaw;
  pointer(b, 'pointerdown', { clientX: found.s.x, clientY: found.s.y });
  pointer(b, 'pointermove', { clientX: found.s.x + 6, clientY: found.s.y + 5 });
  pointer(b, 'pointerup', { clientX: found.s.x + 6, clientY: found.s.y + 5 });
  assert.equal(b.selectedParts().length, 1, '抖动仍应选中');
  assert.equal(b.selectedParts()[0].uid, found.part.uid);
  assert.equal(b._orbit.yaw, yaw0, '抖动不应旋转相机');
});
ok('手上有零件时：点按=放置，拖动=转视角（不误拖零件）', () => {
  const found = findHittable(b);
  const part = found.part;
  const p0 = part.pos.slice();
  // 拿起一个零件（进入"手上"状态）
  b._ghostDef = 'fin';
  b._buildGhost();
  const n0 = b.craft.parts.length;
  const yaw0 = b._orbit.yaw;
  tap(b, found.s.x, found.s.y);
  assert.equal(b.craft.parts.length > n0, true, '点按应放置手上的零件');
  assert.equal(b._orbit.yaw, yaw0, '放置不应旋转相机');
  assert.deepEqual(part.pos, p0, '不应移动原有零件');
  // 手上还有零件时拖动 = 转视角，不应移动零件
  b._ghostDef = 'fin';
  b._buildGhost();
  const yaw1 = b._orbit.yaw;
  drag(b, { x: W - 90, y: H - 60 }, { x: W - 40, y: H - 40 });
  assert.notEqual(b._orbit.yaw, yaw1, '手上拿着零件时拖动应转视角');
  assert.deepEqual(part.pos, p0, '不应移动零件');
  b._clearGhost();
});
ok('拖动已选零件 = 平移，按 step 吸附、相机不动', () => {
  const found = findHittable(b);
  assert.ok(found, '应能找到可命中的零件');
  b._selUids = new Set([found.part.uid]);
  const part = found.part;
  const p0 = part.pos.slice();
  const s = found.s;
  const yaw0 = b._orbit.yaw, pitch0 = b._orbit.pitch;
  drag(b, s, { x: s.x + 70, y: s.y + 30 });
  const d = [part.pos[0] - p0[0], part.pos[1] - p0[1], part.pos[2] - p0[2]];
  const moved = Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]);
  assert.ok(moved > 0, '零件应发生位移');
  for (const v of d) {
    const k = v / b.step;
    assert.ok(Math.abs(k - Math.round(k)) < 1e-6, `位移 ${v} 未吸附到步长 ${b.step}`);
  }
  assert.equal(b._orbit.yaw, yaw0, '拖动零件不应旋转相机');
  assert.equal(b._orbit.pitch, pitch0);
});
ok('拖动未选中零件：第一次只选中，不位移', () => {
  b.clearSelection();
  const found = findHittable(b);
  assert.ok(found);
  const p0 = found.part.pos.slice();
  drag(b, found.s, { x: found.s.x + 60, y: found.s.y });
  assert.equal(b.selectedParts().length, 1, '第一次拖动应选中');
  assert.equal(b.selectedParts()[0].uid, found.part.uid);
  assert.deepEqual(found.part.pos, p0, '第一次拖动不应移动零件');
});
ok('第二次拖动同一零件才移动', () => {
  const part = b.selectedParts()[0];
  const p0 = part.pos.slice();
  const s = screenOf(b, part.pos);
  drag(b, s, { x: s.x + 60, y: s.y });
  const moved = Math.abs(part.pos[0] - p0[0]) + Math.abs(part.pos[1] - p0[1]) + Math.abs(part.pos[2] - p0[2]);
  assert.ok(moved > 0, '第二次拖动应移动零件');
});
ok('拖动空白 = 旋转相机（桌面/触屏一致）', () => {
  b.clearSelection();
  const yaw0 = b._orbit.yaw;
  drag(b, { x: W - 100, y: H - 50 }, { x: W - 40, y: H - 20 });
  assert.notEqual(b._orbit.yaw, yaw0, '空白拖动应旋转相机');
});
ok('视角模式下拖动零件只旋转相机', () => {
  b.setMode('view');
  const part = b.craft.parts[0];
  b._selUids = new Set([part.uid]);
  const p0 = part.pos.slice();
  const yaw0 = b._orbit.yaw;
  const s = screenOf(b, part.pos);
  drag(b, s, { x: s.x + 60, y: s.y + 20 });
  assert.deepEqual(part.pos, p0, '视角模式不应移动零件');
  assert.notEqual(b._orbit.yaw, yaw0, '视角模式应旋转相机');
  b.setMode('move');
});
ok('旋转模式：拖动已选零件按 15° 吸附旋转', () => {
  b.setMode('rotate');
  const found = findHittable(b);
  b._selUids = new Set([found.part.uid]);
  b._rotAxis = 1;
  const r0 = found.part.rot[1];
  drag(b, found.s, { x: found.s.x + 80, y: found.s.y });
  const d = found.part.rot[1] - r0;
  assert.notEqual(d, 0, '应产生旋转');
  assert.equal(Math.abs(d) % 15, 0, `旋转 ${d}° 不是 15° 的整数倍`);
  b.setMode('move');
});

/* ------------------------------------------------------------------ 手柄 */
console.log('# 变换手柄（屏幕空间命中 ≥28px / 轴向映射）');
/** 取手柄某轴的屏幕线段 */
function axisSeg(b, i) {
  const g = b._gizmo.position;
  const proj = (v) => { const p = v.clone().project(b._camera); return { x: (p.x * 0.5 + 0.5) * W, y: (-p.y * 0.5 + 0.5) * H }; };
  const tip = g.clone();
  tip.setComponent(i, tip.getComponent(i) + 1.06 * b._gizmo.scale.x);
  return [proj(g), proj(tip)];
}
/** 线段上 u 处、再垂直偏移 perp px 的点 */
function onAxisPoint(seg, u, perp) {
  const [a, t] = seg;
  const dx = t.x - a.x, dy = t.y - a.y, len = Math.hypot(dx, dy) || 1;
  const x = a.x + dx * u, y = a.y + dy * u;
  return { x: x - (dy / len) * perp, y: y + (dx / len) * perp };
}
ok('触屏手柄命中半径 ≥28px（中心留死区）', () => {
  b.setTouchLayout(true);
  const found = findHittable(b);
  b._selUids = new Set([found.part.uid]);
  b._updateGizmoTransform();
  assert.equal(b._gizmo.visible, true);
  const seg = axisSeg(b, 1);
  const onAxis = onAxisPoint(seg, 0.8, 0);
  assert.ok(b._pickGizmoHandle(onAxis.x, onAxis.y), '轴线上应命中');
  const near = onAxisPoint(seg, 0.8, 27);
  const h = b._pickGizmoHandle(near.x, near.y);
  assert.ok(h, '距轴线 27px 应命中（半径 ≥28px）');
  assert.equal(h.kind, 'move');
  const o = screenOf(b, b._gizmo.position.toArray());
  assert.equal(b._pickGizmoHandle(o.x + 200, o.y + 200), null, '远处不应命中');
  assert.equal(b._pickGizmoHandle(o.x, o.y), null, '零件中心是死区（留给拖动零件）');
});
ok('鼠标手柄命中半径更小（14px）', () => {
  b.setTouchLayout(false);
  const found = findHittable(b);
  b._selUids = new Set([found.part.uid]);
  b._updateGizmoTransform();
  const seg = axisSeg(b, 1);
  const near = onAxisPoint(seg, 0.8, 11);
  assert.ok(b._pickGizmoHandle(near.x, near.y), '11px 处应命中');
  const far = onAxisPoint(seg, 0.8, 20);
  const h = b._pickGizmoHandle(far.x, far.y);
  assert.ok(!h || h.axis !== 1, `距轴线 20px 不应再命中该轴（鼠标半径 14px）: ${JSON.stringify(h)}`);
});
ok('拖动手柄沿对应轴移动（桌面回归 + 轴向映射正确）', () => {
  const found = findHittable(b);
  b._selUids = new Set([found.part.uid]);
  b._updateGizmoTransform();
  const seg = axisSeg(b, 1);
  const from = onAxisPoint(seg, 0.75, 0);
  const dx = seg[1].x - seg[0].x, dy = seg[1].y - seg[0].y;
  const len = Math.hypot(dx, dy) || 1;
  const p0 = found.part.pos.slice();
  drag(b, from, { x: from.x + dx / len * 70, y: from.y + dy / len * 70 }, { pointerType: 'mouse' });
  assert.ok(found.part.pos[1] > p0[1], `应沿 Y 轴正向移动：${p0[1]} -> ${found.part.pos[1]}`);
  assert.equal(found.part.pos[0], p0[0], 'X 不应变化');
  assert.equal(found.part.pos[2], p0[2], 'Z 不应变化');
});
ok('拖动手柄只入栈一条撤销', () => {
  const found = findHittable(b);
  b._selUids = new Set([found.part.uid]);
  b._updateGizmoTransform();
  const seg = axisSeg(b, 1);
  const from = onAxisPoint(seg, 0.75, 0);
  const dx = seg[1].x - seg[0].x, dy = seg[1].y - seg[0].y;
  const len = Math.hypot(dx, dy) || 1;
  const h0 = b._history.length;
  drag(b, from, { x: from.x + dx / len * 60, y: from.y + dy / len * 60 }, { pointerType: 'mouse' });
  assert.equal(b._history.length, h0 + 1);
});
ok('手柄模式切换：rotate 用圆环 / view 隐藏', () => {
  b.setMode('rotate');
  assert.equal(b._gizmoMode, 'rotate');
  assert.equal(b._modeEls.rotate.classList.contains('sp2-builder__mode--active'), true);
  b._updateGizmoTransform();
  assert.equal(b._gizmo.visible, true);
  b.setMode('view');
  b._updateGizmoTransform();
  assert.equal(b._gizmo.visible, false, '视角模式应隐藏手柄');
  assert.equal(b._pickGizmoHandle(400, 225), null);
  b.setMode('move');
  assert.equal(b._gizmoMode, 'move');
});

/* ------------------------------------------------------------------ 数值微调面板 */
console.log('# 数值微调（扳手）面板');
ok('桌面工具栏扳手可切换微调面板', () => {
  b.setTouchLayout(false);
  b.nudgePanel.el.classList.add('sp-hidden');
  b._nudgeVisible = false;
  b.toggleNudgePanel(true);
  assert.equal(b.nudgePanelVisible, true);
  assert.equal(b.nudgePanel.el.classList.contains('sp-hidden'), false);
  b.toggleNudgePanel(false);
  assert.equal(b.nudgePanelVisible, false);
  assert.equal(b.nudgePanel.el.classList.contains('sp-hidden'), true);
  b.toggleNudgePanel(true);
});
ok('面板包含 位置/旋转/尺寸 各三行 −/＋ 与实时数值', () => {
  const found = findHittable(b);
  b._selUids = new Set([found.part.uid]);
  b._refreshNudgePanel();
  const rows = b.nudgePanel.body.querySelectorAll('.sp2-builder__nrow');
  assert.equal(rows.length, 9, `应有 9 行（3 位置 + 3 旋转 + 3 尺寸），实际 ${rows.length}`);
  assert.equal(b.nudgePanel.body.querySelectorAll('.sp2-builder__nbtn').length, 18, '应有 18 个 −/＋ 按钮');
  assert.ok(b._nudge.posStep && b._nudge.rotStep, '应有步长下拉');
  assert.ok(/X/.test(rows[0].textContent), rows[0].textContent);
  assert.ok(/m/.test(b._nudge.pos[0].textContent), b._nudge.pos[0].textContent);
  const posOpts = Array.from(b._nudge.posStep.select.options).map((o) => o.value);
  for (const v of ['0.05', '0.25', '1']) assert.ok(posOpts.includes(v), `位置步长缺少 ${v}`);
  const rotOpts = Array.from(b._nudge.rotStep.select.options).map((o) => o.value);
  assert.deepEqual(rotOpts, ['15', '5', '1'], '旋转步长应为 15/5/1');
});
ok('−/＋ 步进：位置按 step、旋转按 rotStep', () => {
  const found = findHittable(b);
  b._selUids = new Set([found.part.uid]);
  b._refreshNudgePanel();
  const p0 = found.part.pos[0];
  b._nudgeBy('pos', 0, 1);
  assert.ok(Math.abs(found.part.pos[0] - (p0 + b.step)) < 1e-6, `pos ${found.part.pos[0]} != ${p0 + b.step}`);
  assert.ok(b._nudge.pos[0].textContent.includes(found.part.pos[0].toFixed(2)), '数值应实时反映位置');
  const r0 = found.part.rot[1];
  b._nudgeBy('rot', 1, -1);
  assert.ok(Math.abs(found.part.rot[1] - (r0 - b._rotStep)) < 1e-6);
  const s0 = found.part.size[2];
  b._nudgeBy('size', 2, 1);
  assert.ok(found.part.size[2] > s0, '尺寸 + 应变大');
  b._nudgeBy('size', 2, -1);
  assert.ok(found.part.size[2] < s0 + 1e-9, '尺寸 − 应还原');
});
ok('微调带动镜像伙伴（对称开启时）', () => {
  b.symmetry = 'x';
  const p = b.craft.parts.find((x) => x.def === 'wing' && x.pos[0] > 0.5);
  const m = b._mirrorPartner(p, 'x');
  assert.ok(m, '库存机翼应有镜像');
  b._selUids = new Set([p.uid]);
  b._refreshNudgePanel();
  const [px, mx] = [p.pos[0], m.pos[0]];
  b._nudgeBy('pos', 0, 1);
  assert.ok(Math.abs(p.pos[0] - (px + b.step)) < 1e-6);
  assert.ok(Math.abs(m.pos[0] - (mx - b.step)) < 1e-6);
  b.symmetry = 'none';
});
ok('面板操作行含 镜像到另一侧 / 复制 / 删除', () => {
  const texts = Array.from(b.nudgePanel.body.querySelectorAll('.sp-btn')).map((n) => n.textContent).join('|');
  assert.ok(/镜像到另一侧/.test(texts), texts);
  assert.ok(/复制/.test(texts), texts);
  assert.ok(/删除/.test(texts), texts);
});
await okAsync('长按 −/＋ 连续微调：400ms 后每 80ms 重复，松手即停，只入栈一条撤销', async () => {
  const found = findHittable(b);
  b._selUids = new Set([found.part.uid]);
  b._refreshNudgePanel();
  b._nudgeSession = null;    // 清掉上一段按压的合并状态，本段按压应独立入栈一条
  // 取"位置 X 的 +"按钮（第 1 行第 2 个按钮 = 索引 1）
  const btns = b.nudgePanel.body.querySelectorAll('.sp2-builder__nbtn');
  const plus = btns[1];
  assert.equal(plus.textContent, '＋');
  const p0 = found.part.pos[0];
  const uid0 = found.part.uid;
  const h0 = b._history.length;
  press(plus);
  await wait(80);
  const afterPress = found.part.pos[0];
  assert.ok(Math.abs(afterPress - (p0 + b.step)) < 1e-6, '按下立即步进一次');
  await wait(600);
  const afterRepeat = found.part.pos[0];
  assert.ok(afterRepeat > afterPress + b.step * 2, `长按应连续步进：${afterPress} -> ${afterRepeat}`);
  assert.equal(b._history.length, h0 + 1, '整段按压只应产生一条撤销');
  releaseWindow();
  const atRelease = found.part.pos[0];
  await wait(250);
  assert.equal(found.part.pos[0], atRelease, '松手后应停止步进');
  b.undo();
  const restored = b.craft.parts.find((x) => x.uid === uid0);
  assert.ok(restored, '撤销后零件仍应存在');
  assert.ok(Math.abs(restored.pos[0] - p0) < 1e-6, `一次撤销应回到按压前（${restored.pos[0]} vs ${p0}）`);
});
ok('触屏：微调是底部面板的一个标签页，选中零件后自动可见', () => {
  b.setTouchLayout(true);
  const tabs = Array.from(b._sheetTabs.querySelectorAll('.sp2-builder__sheet-tab')).map((n) => n.textContent);
  assert.deepEqual(tabs, ['零件库', '微调', '属性', '统计'], tabs.join('|'));
  assert.ok(b._sheetPanes.nudge.contains(b.nudgePanel.body), '微调面板应搬进底部面板');
  b.clearSelection();
  const found = findHittable(b);
  b._selUids = new Set([found.part.uid]);
  b._onSelectionChanged();
  assert.equal(b._sheetTab, 'nudge', '选中零件应自动切到微调');
  assert.equal(b._sheetPanes.nudge.hidden, false);
  b.clearSelection();
  b._onSelectionChanged();
  assert.equal(b._sheetTab, 'parts', '取消选中应回到零件库');
});
ok('触屏无选中时提示先选零件', () => {
  b.clearSelection();
  b.toggleNudgePanel(true);
  assert.notEqual(b._sheetTab, 'nudge');
});

/* ------------------------------------------------------------------ 长按菜单 */
console.log('# 长按小菜单');
await okAsync('长按 500ms 弹出小菜单（删除/复制/镜像）', async () => {
  b.setTouchLayout(true);
  const found = findHittable(b);
  b.clearSelection();
  pointer(b, 'pointerdown', { clientX: found.s.x, clientY: found.s.y, pointerType: 'touch' });
  assert.ok(b._longPress, '长按计时已启动');
  await wait(620);
  assert.ok(b._ctxMenu, '小菜单应已出现');
  assert.equal(b.selectedParts()[0]?.uid, found.part.uid, '长按应选中该零件');
  const items = b._ctxMenu.querySelectorAll('.sp-btn');
  const labels = Array.from(items).map((n) => n.textContent).join('|');
  assert.ok(items.length >= 3, `菜单项数量 ${items.length}`);
  for (const t of ['删除', '复制', '镜像']) assert.ok(labels.includes(t), labels);
  pointer(b, 'pointerup', { clientX: found.s.x, clientY: found.s.y, pointerType: 'touch' });
  b._closeContextMenu();
  assert.equal(b._ctxMenu, null, '菜单应可关闭');
});
ok('长按后移动（> 10px）会取消菜单', () => {
  const found = findHittable(b);
  pointer(b, 'pointerdown', { clientX: found.s.x, clientY: found.s.y, pointerType: 'touch', pointerId: 9 });
  pointer(b, 'pointermove', { clientX: found.s.x + 40, clientY: found.s.y, pointerId: 9, pointerType: 'touch' });
  assert.equal(b._longPress, null, '移动后长按应被取消');
  pointer(b, 'pointerup', { clientX: found.s.x + 40, clientY: found.s.y, pointerId: 9, pointerType: 'touch' });
});
ok('鼠标不做长按（用右键）', () => {
  const found = findHittable(b);
  b._selUids = new Set([found.part.uid]);
  pointer(b, 'pointerdown', { clientX: found.s.x, clientY: found.s.y, pointerType: 'mouse', button: 0 });
  assert.equal(b._longPress, null);
  pointer(b, 'pointerup', { clientX: found.s.x, clientY: found.s.y, pointerType: 'mouse', button: 0 });
});
ok('镜像动作：补齐/移除左右镜像', () => {
  const part = b.craft.parts.find((p) => p.def === 'wing' && p.pos[0] > 0);
  b._selUids = new Set([part.uid]);
  const n0 = b.craft.parts.length;
  const hadMirror = !!b._mirrorPartner(part, 'x');
  b._mirrorSelected();
  if (hadMirror) assert.ok(b.craft.parts.length <= n0);
  else assert.equal(b.craft.parts.length, n0 + 1);
});

/* ------------------------------------------------------------------ 双指手势 */
console.log('# 双指手势');
const touchEv = (touches) => ({ touches, preventDefault() {} });
ok('两指捏合 = 缩放', () => {
  const dist0 = b._orbit.dist;
  b._onTouchGesture(touchEv([{ clientX: 100, clientY: 100 }, { clientX: 200, clientY: 100 }]));
  b._onTouchGesture(touchEv([{ clientX: 60, clientY: 100 }, { clientX: 240, clientY: 100 }]));
  assert.notEqual(b._orbit.dist, dist0, '捏合应改变距离');
  b._onTouchGesture(touchEv([{ clientX: 100, clientY: 100 }]));
});
ok('两指整体拖动 = 平移', () => {
  b._onTouchGesture(touchEv([{ clientX: 100, clientY: 100 }, { clientX: 200, clientY: 100 }]));
  const t0 = b._orbit.target.clone();
  b._onTouchGesture(touchEv([{ clientX: 140, clientY: 130 }, { clientX: 240, clientY: 130 }]));
  assert.ok(b._orbit.target.distanceTo(t0) > 0, '平移应改变相机目标');
  b._onTouchGesture(touchEv([{ clientX: 100, clientY: 100 }]));
});
ok('两指绕圈 = 旋转视角（yaw/pitch）', () => {
  b._onTouchGesture(touchEv([{ clientX: 300, clientY: 200 }, { clientX: 400, clientY: 200 }]));
  const yaw0 = b._orbit.yaw, pitch0 = b._orbit.pitch;
  b._onTouchGesture(touchEv([{ clientX: 350, clientY: 150 }, { clientX: 350, clientY: 250 }]));
  assert.notEqual(b._orbit.yaw, yaw0, 'yaw 应变化');
  assert.notEqual(b._orbit.pitch, pitch0, 'pitch 应变化');
  b._onTouchGesture(touchEv([]));
});
ok('滚轮仍然缩放（桌面回归）', () => {
  const d0 = b._orbit.dist;
  b._onWheel({ deltaY: 120, preventDefault() {} });
  assert.notEqual(b._orbit.dist, d0);
});
ok('双指介入会中断单指手势', () => {
  const found = findHittable(b);
  b._selUids = new Set([found.part.uid]);
  pointer(b, 'pointerdown', { clientX: found.s.x, clientY: found.s.y, pointerId: 1, pointerType: 'touch' });
  assert.ok(b._drag, '单指手势存在');
  pointer(b, 'pointerdown', { clientX: 10, clientY: 10, pointerId: 2, pointerType: 'touch' });
  assert.equal(b._drag, null, '第二指按下应中断单指手势');
  pointer(b, 'pointerup', { clientX: 10, clientY: 10, pointerId: 2, pointerType: 'touch' });
  pointer(b, 'pointerup', { clientX: found.s.x, clientY: found.s.y, pointerId: 1, pointerType: 'touch' });
});

/* ------------------------------------------------------------------ 触屏布局 */
console.log('# 触屏布局');
ok('setTouchLayout(true) 应用触屏类名', () => {
  b.setTouchLayout(true);
  assert.equal(b.touchLayout, true);
  assert.equal(b.el.classList.contains('sp2-builder--touch'), true);
});
ok('四个面板 body 搬进底部面板', () => {
  assert.ok(b._sheetPanes.parts.contains(b.palettePanel.body));
  assert.ok(b._sheetPanes.nudge.contains(b.nudgePanel.body));
  assert.ok(b._sheetPanes.props.contains(b.propsPanel.body));
  assert.ok(b._sheetPanes.stats.contains(b.statsPanel.body));
  assert.equal(b._sheetTabs.querySelectorAll('.sp2-builder__sheet-tab').length, 4);
});
ok('触屏网格：两列、每项含图标与名称', () => {
  const cards = b._grid.querySelectorAll('.sp2-builder__card');
  const active = Object.values(PART_DEFS).filter((d) => d.cat === b._cat).length;
  assert.equal(cards.length, active, `卡片数 ${cards.length} != 当前分类零件数 ${active}`);
  assert.ok(cards[0].querySelector('.sp2-builder__card-name'));
  assert.ok(cards[0].querySelector('.sp2-builder__card-icon'));
  const css = document.getElementById('sp2-widgets').textContent.replace(/\s+/g, '');
  assert.ok(/sp2-builder__grid\{[^}]*grid-template-columns:repeat\(2/.test(css), '应为两列网格');
});
ok('分类 chip 可切换并高亮', () => {
  assert.equal(b._chips.querySelectorAll('.sp2-builder__chip').length, 9);
  const wingChip = Array.from(b._chips.querySelectorAll('.sp2-builder__chip')).find((c) => c.textContent.includes('机翼'));
  wingChip.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(b._cat, 'wing');
  assert.equal(wingChip.classList.contains('sp2-builder__chip--active'), true);
});
ok('点网格卡片 → 手上拿零件 + 面板收起', () => {
  b.setSheetExpanded(true);
  b._grid.querySelectorAll('.sp2-builder__card')[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.ok(b._ghostDef, '应拿起一个零件');
  assert.equal(b._sheetExpanded, false, '选完零件应收起面板');
  b._clearGhost();
});
ok('底部面板展开/收起 + “＋ 添加零件”大按钮', () => {
  b.setSheetExpanded(false);
  assert.equal(b._sheet.classList.contains('sp2-builder__sheet--expanded'), false);
  assert.equal(b._addBtn.hidden, false);
  b.setSheetExpanded(true);
  assert.equal(b._addBtn.hidden, true);
  b.setSheetExpanded(false);
});
ok('标签页切换隐藏/显示对应面板', () => {
  b.setSheetTab('stats');
  assert.equal(b._sheetPanes.stats.hidden, false);
  assert.equal(b._sheetPanes.parts.hidden, true);
  assert.equal(b._sheetTabEls.stats.classList.contains('sp2-builder__sheet-tab--active'), true);
  b.setSheetTab('parts');
  assert.equal(b._sheetPanes.parts.hidden, false);
});
ok('选中零件后出现提示条（零件名 + 拖动提示 + 实时坐标）', () => {
  const found = findHittable(b);
  b._selUids = new Set([found.part.uid]);
  b._syncSelBar();
  assert.equal(b._selBar.hidden, false);
  const txt = b._selText.textContent;
  assert.ok(/选中/.test(txt), txt);
  assert.ok(/拖动/.test(txt), txt);
  assert.ok(/[XYZ]/.test(txt), txt);
  b.clearSelection();
  assert.equal(b._selBar.hidden, true);
});
ok('触屏可点区域 ≥44px、顶部按钮 ≥48px、使用安全区（CSS 断言）', () => {
  const css = document.getElementById('sp2-widgets').textContent || '';
  const idx = css.indexOf('.sp2-builder--touch');
  assert.ok(idx >= 0, '应注入触屏样式');
  const block = css.slice(idx);
  const mins = [...block.matchAll(/min-height:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
  assert.ok(mins.length > 0);
  assert.ok(Math.min(...mins) >= 44, `触屏最小可点高度 ${Math.min(...mins)}px < 44px`);
  assert.ok(/min-width:48px/.test(block), '顶部按钮应 ≥48px 宽');
  assert.ok(/safe-area-inset/.test(block), '应使用安全区变量');
  assert.ok(/sp2-builder__nbtn\{min-width:44px/.test(block.replace(/\s+/g, '')), '微调按钮 ≥44px');
});
ok('触屏工具栏包含必要按钮与模式切换', () => {
  assert.ok(b.toolbar.querySelectorAll('.sp-btn').length >= 7, '工具栏按钮数量');
  assert.ok(b._modeEls.move && b._modeEls.rotate && b._modeEls.view);
  assert.equal(b._moreBtn.classList.contains('sp2-builder__touchonly'), true);
  const texts = Array.from(b.toolbar.querySelectorAll('.sp-btn')).map((n) => n.textContent).join('|');
  for (const t of ['返回', '新建', '载入', '保存', '试飞', '撤销', '重做', '微调']) {
    assert.ok(texts.includes(t), `触屏工具栏缺少「${t}」：${texts}`);
  }
});
ok('竖屏提示 / 首次操作提示', () => {
  b._cancelTouchHint();
  assert.equal(b._touchHint.hidden, true);
  window.localStorage.removeItem('sp2.builder.touchHintSeen');
  Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
  Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true });
  b._updatePortraitHint();
  assert.equal(b._portraitHint.hidden, false, '竖屏应提示横屏更舒适');
  b._maybeShowTouchHint();
  assert.equal(b._touchHint.hidden, false, '首次打开应显示操作提示');
  b._cancelTouchHint();
  assert.equal(b._touchHint.hidden, true);
  Object.defineProperty(window, 'innerHeight', { value: 450, configurable: true });
  Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
  b._updatePortraitHint();
  assert.equal(b._portraitHint.hidden, true);
});
ok('切回桌面布局：面板回到侧栏、触屏类名移除', () => {
  b.setTouchLayout(false);
  assert.equal(b.el.classList.contains('sp2-builder--touch'), false);
  assert.ok(b.palettePanel.el.contains(b.palettePanel.body));
  assert.ok(b.nudgePanel.el.contains(b.nudgePanel.body));
  assert.ok(b.propsPanel.el.contains(b.propsPanel.body));
  assert.ok(b.statsPanel.el.contains(b.statsPanel.body));
  assert.equal(b._addBtn.hidden, true);
});
ok('竖屏也能放置/移动零件', () => {
  b.setTouchLayout(true);
  const n0 = b.craft.parts.length;
  b._ghostDef = 'fin';
  b._buildGhost();
  b._ghostPlacement = { pos: [1.5, 1, 1], rot: [0, 0, 0], attached: null };
  b._placeInHand();
  assert.equal(b.craft.parts.length, n0 + (b.symmetry === 'none' ? 1 : 2));
  b._clearGhost();
  b.setTouchLayout(false);
});

/* ------------------------------------------------------------------ 对称 / 编辑 */
console.log('# 对称 / 编辑 / 撤销');
/** 重新载入一份干净的库存机（前面的拖动会破坏左右对称） */
function freshCraft() {
  b.open(clone(trainer));
  installFakeGL(b);
  b.setTouchLayout(false);
}
ok('镜像 X 放置生成左右两份（位置/旋转镜像）', () => {
  freshCraft();
  b.symmetry = 'x';
  const n0 = b.craft.parts.length;
  b._ghostDef = 'fin';
  b._buildGhost();
  b._ghostPlacement = { pos: [2.5, 1.5, 0.5], rot: [5, 10, -15], attached: null };
  b._placeInHand();
  assert.equal(b.craft.parts.length, n0 + 2);
  const created = b.selectedParts()[0];
  const m = b._mirrorPartner(created, 'x');
  assert.ok(m);
  assert.equal(m.pos[0], -created.pos[0]);
  assert.equal(m.rot[1], -created.rot[1]);
  b._clearGhost();
});
ok('镜像 X 且 x≈0 只生成一份', () => {
  const n0 = b.craft.parts.length;
  b._ghostDef = 'fuselage_block';
  b._buildGhost();
  b._ghostPlacement = { pos: [0, 1, 2], rot: [0, 0, 0], attached: null };
  b._placeInHand();
  assert.equal(b.craft.parts.length, n0 + 1);
  b._clearGhost();
});
ok('方向键微调带动镜像伙伴', () => {
  freshCraft();
  b.symmetry = 'x';
  const p = b.craft.parts.find((x) => x.def === 'wing' && x.pos[0] > 0.5);
  const m = b._mirrorPartner(p, 'x');
  assert.ok(m, '库存机翼应有镜像');
  b._selUids = new Set([p.uid]);
  const [px, mx] = [p.pos[0], m.pos[0]];
  b._nudgeSelection(0.25, 0.5, 0);
  assert.equal(p.pos[0], px + 0.25);
  assert.equal(m.pos[0], mx - 0.25);
  assert.equal(m.pos[1], p.pos[1]);
});
ok('镜像删除成对移除', () => {
  b.symmetry = 'x';
  const p = b.craft.parts.find((x) => x.def === 'wing' && x.pos[0] > 0.5);
  const m = b._mirrorPartner(p, 'x');
  assert.ok(p && m, '库存机翼应有镜像');
  b._selUids = new Set([p.uid]);
  const n0 = b.craft.parts.length;
  b.deleteSelected();
  assert.equal(b.craft.parts.length, n0 - 2);
  assert.equal(b.craft.parts.includes(m), false);
});
ok('撤销 / 重做', () => {
  const n1 = b.craft.parts.length;
  b._selUids = new Set([b.craft.parts[0].uid]);
  b.deleteSelected();
  assert.equal(b.craft.parts.length, n1 - 1);
  b.undo();
  assert.equal(b.craft.parts.length, n1);
  b.redo();
  assert.equal(b.craft.parts.length, n1 - 1);
  b.undo();
});
ok('撤销栈上限 ≥ 40', () => {
  for (let i = 0; i < 60; i++) b._pushHistory();
  assert.ok(b._history.length >= 40, `实际上限 ${b._history.length}`);
  b._history.length = 0; b._future.length = 0;
});
ok('拖动零件只在开始时记录一次快照', () => {
  const found = findHittable(b);
  b._selUids = new Set([found.part.uid]);
  const h0 = b._history.length;
  drag(b, found.s, { x: found.s.x + 80, y: found.s.y + 40 });
  assert.equal(b._history.length, h0 + 1, '一次拖动应只产生一个撤销点');
});

/* ------------------------------------------------------------------ 属性 / 统计 */
console.log('# 属性 / 统计 / JSON');
ok('修改 props / 缩放 / 上色', () => {
  freshCraft();
  const wing = b.craft.parts.find((x) => x.def === 'wing');
  b._selUids = new Set([wing.uid]);
  b._setPropForSelection('wing', 'dihedral', 12);
  assert.equal(wing.props.dihedral, 12);
  b._scaleSelection(1, 1.5, 0.22);
  assert.ok(Math.abs(wing.size[1] - 0.33) < 1e-6);
  b._paintSelection('#ff0000');
  assert.equal(wing.color, '#ff0000');
  b.clearSelection();
  b._paintAll('#123456');
  assert.ok(b.craft.parts.every((p) => p.color === '#123456'));
  b._paintAll('bad-color');
  assert.equal(b.craft.parts[0].color, '#c9d3dd');
});
ok('空机型给出引导提示', () => {
  const backup = b._craft;
  b._craft = { parts: [] };
  const s = b._balanceWarnings({ mass: 0, thrust: 0, wingArea: 0, com: { x: 0, y: 0, z: 0 }, size: { x: 0, y: 0, z: 0 }, partCount: 0, fuel: 0 });
  assert.ok(s.length === 1 && /空机型/.test(s[0].text));
  b._craft = backup;
});
ok('无主翼 / 无发动机 → 错误提示', () => {
  b.setCraft({ name: 'x', parts: [{ def: 'fuselage_block', pos: [0, 0, 0] }] });
  const texts = b._balanceWarnings({ mass: 55, thrust: 0, wingArea: 0, com: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 2 }, partCount: 1, fuel: 0 }).map((w) => w.text).join('|');
  assert.ok(/主翼/.test(texts), texts);
  assert.ok(/发动机/.test(texts), texts);
});
ok('重心靠后 → 不稳定警告', () => {
  b.setCraft({ parts: [{ def: 'wing', pos: [0, 0, 0] }, { def: 'engine_jet', pos: [0, 0, 3] }] });
  const texts = b._balanceWarnings({ mass: 300, thrust: 20000, wingArea: 12, com: { x: 0, y: 0, z: 2 }, size: { x: 10, y: 1, z: 4 }, partCount: 10, fuel: 100 }).map((w) => w.text).join('|');
  assert.ok(/重心过于靠后/.test(texts), texts);
});
ok('统计抛错时不崩（降级显示错误行）', () => {
  const backup = b._craft;
  b._craft = { parts: [{ uid: 1, def: 'wing', pos: null, rot: null, size: null, color: '#fff', props: {} }] };
  b._refreshStats();
  assert.ok(b._statsBody.children.length >= 1);
  b._craft = backup;
});
ok('自动配平可运行', () => { b._autoBalance(); });
ok('导出/导入 JSON 往返一致，uid 唯一', () => {
  b.open(clone(trainer));
  installFakeGL(b);
  const back = b._sanitizeCraft(JSON.parse(JSON.stringify(b.craft)));
  assert.equal(back.parts.length, b.craft.parts.length);
  assert.equal(back.name, b.craft.name);
  assert.deepEqual(back.parts[0].pos, b.craft.parts[0].pos);
  const uids = b.craft.parts.map((p) => p.uid);
  assert.equal(new Set(uids).size, uids.length);
});

/* ------------------------------------------------------------------ 生命周期 */
console.log('# 生命周期');
ok('update(dt) / resize() 不抛异常', () => { b.update(0.016); b.update(NaN); b.resize(); });
ok('close() 释放预览与场景资源，DOM 保留', () => {
  b.close();
  assert.equal(b._open, false);
  assert.equal(b._preview, null);
  assert.equal(b._gizmo, null);
  assert.equal(b._scene, null);
  assert.equal(b.el.classList.contains('sp-hidden'), true);
  assert.equal(container.children.length, 1);
  assert.equal(b._ctxMenu, null);
  assert.equal(b._longPress, null);
  assert.equal(b._pointers.size, 0);
});
ok('再次 open() 可用（触屏布局重新应用）', () => {
  b.setTouchLayout(true);
  b.open(clone(trainer));
  assert.equal(b._open, true);
  assert.equal(b.el.classList.contains('sp2-builder--touch'), true);
  installFakeGL(b);
  assert.ok(b._preview.meshes.size > 0);
});
ok('dispose() 卸载 DOM，之后调用 API 安全', () => {
  b.dispose();
  assert.equal(container.children.length, 0);
  assert.equal(b._disposed, true);
  b.open();
  b.update(0.016);
  b.setCraft({ parts: [] });
  b.undo(); b.redo();
  b.setMode('rotate');
  b.toggleNudgePanel(true);
  b.setTouchLayout(false);
  b.dispose();
});

console.log(`\n通过 ${passed} 项检查${failures.length ? `（失败 ${failures.length} 项：${failures.join('、')}）` : '，全部通过 ✅'}`);
try { dom.window.close(); } catch (e) { /* 忽略 */ }
