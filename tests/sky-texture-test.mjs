/**
 * 天空/环境贴图回归测试
 * ------------------------------------------------------------------
 * 背景：曾出现一个致命 bug —— SkyDome._updateEnv() 把 THREE.Color.getHex()
 * 返回的十进制数字传给了 makeSkyTexture()，而后者内部走 canvas 的
 * addColorStop()，只接受 CSS 颜色字符串，于是抛：
 *     SyntaxError: The value provided ('3109075') could not be parsed as a color.
 * 由于 _updateEnv() 是从 SkyDome 构造函数里调用的，异常一路冒泡到
 * Game.loadWorld()，导致真实浏览器里「根本进不去游戏」。
 *
 * 关键：这个 bug 在 Node 下**不会触发**，因为 makeSkyTexture() 在
 * `typeof document === 'undefined'` 时会提前 return null，压根走不到
 * addColorStop()。所以常规无头测试全是绿的，却漏掉了它。
 *
 * 本测试的做法：注入一个「会真正校验颜色参数」的假 canvas，让 Node 环境下
 * 也能走到 addColorStop()，从而覆盖这条路径。
 *
 * 用法： node tests/sky-texture-test.mjs
 */
import assert from 'node:assert/strict';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ✅ ' + name); }
  catch (e) { fail++; console.log('  ❌ ' + name + '\n       ' + e.message); }
};

/* ================================================================
 * 假 canvas：模拟浏览器行为，并严格校验 addColorStop 的颜色参数
 * ================================================================ */
const CSS_COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|[a-z]+$)/i;

function makeFakeGradient() {
  const stops = [];
  return {
    stops,
    addColorStop(offset, color) {
      // 复刻浏览器行为：非法的颜色（比如纯数字）一律抛 SyntaxError
      if (typeof color !== 'string' || !CSS_COLOR_RE.test(color.trim())) {
        const err = new SyntaxError(
          "Failed to execute 'addColorStop' on 'CanvasGradient': " +
          "The value provided ('" + color + "') could not be parsed as a color."
        );
        throw err;
      }
      if (!(offset >= 0 && offset <= 1)) throw new Error('addColorStop offset 越界: ' + offset);
      stops.push({ offset, color });
    },
  };
}

function makeFakeCtx(cv) {
  const img = { data: new Uint8ClampedArray(cv.width * cv.height * 4), width: cv.width, height: cv.height };
  return {
    canvas: cv,
    fillStyle: '#000',
    createLinearGradient: () => makeFakeGradient(),
    createRadialGradient: () => makeFakeGradient(),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {},
    fillRect() {},
    drawImage() {},
    save() {}, restore() {}, translate() {}, scale() {}, rotate() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, fill() {}, stroke() {},
    set fillStyle2(v) {}, get fillStyle2() { return '#000'; },
    createPattern: () => null,
    measureText: () => ({ width: 10 }),
    fillText() {},
    font: '10px sans-serif',
    globalAlpha: 1,
    textAlign: 'left',
    textBaseline: 'top',
    _imgData: img,
  };
}

/** 安装全局 document/window 桩，使 util.js 的 canvas() 能返回可用画布 */
function installDom() {
  const created = [];
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') return { style: {}, appendChild() {}, removeChild() {} };
      const cv = {
        width: 0, height: 0, style: {}, tagName: 'CANVAS',
        _ctx: null,
        getContext(kind) {
          if (kind !== '2d') return null;
          if (!this._ctx) this._ctx = makeFakeCtx(this);
          return this._ctx;
        },
      };
      created.push(cv);
      return cv;
    },
    createElementNS() { return this.createElement('canvas'); },
  };
  globalThis.window = globalThis.window || globalThis;
}
function uninstallDom() {
  delete globalThis.document;
}

installDom();

/* ================================================================
 * 1. makeSkyTexture 只接受 CSS 颜色字符串
 * ================================================================ */
console.log('\n--- 1) makeSkyTexture 的颜色参数校验 ---');

const util = await import('../src/core/util.js');
const THREE = await import('three');

t('传入十六进制字符串 → 正常生成', () => {
  const tex = util.makeSkyTexture('#0c2033', '#15455f', '#05090e', 64);
  assert.ok(tex, '应返回贴图');
});

t('传入 rgb() 字符串 → 正常生成', () => {
  const tex = util.makeSkyTexture('rgb(12,32,51)', 'rgb(21,69,95)', 'rgb(5,9,14)', 64);
  assert.ok(tex);
});

t('传入数字（getHex 的返回值）→ 必须抛错（这正是曾经的 bug）', () => {
  assert.throws(
    () => util.makeSkyTexture(3109075, 1394015, 329230, 64),
    /could not be parsed as a color/,
    '数字颜色应当被拒绝'
  );
});

t('THREE.Color.getStyle() 是合法输入', () => {
  const c = new THREE.Color(0x2f7ff0);
  const tex = util.makeSkyTexture(c.getStyle(), c.getStyle(), c.getStyle(), 64);
  assert.ok(tex, 'getStyle() 生成的 rgb() 应被接受');
});

t('THREE.Color.getHex() 是非法输入（防止回归）', () => {
  const c = new THREE.Color(0x2f7ff0);
  assert.throws(() => util.makeSkyTexture(c.getHex(), c.getHex(), c.getHex(), 64));
});

/* ================================================================
 * 2. SkyDome 全时段走一遍 —— 确保 applyTimeOfDay 不抛异常
 * ================================================================ */
console.log('\n--- 2) SkyDome 在全部时段构建 + 切换，不得抛异常 ---');

const { SkyDome } = await import('../src/world/sky.js');

t('构造 SkyDome 不抛异常（真实渲染器路径）', () => {
  const scene = new THREE.Scene();
  const dome = new SkyDome(scene, { timeOfDay: 0.42, cloudiness: 0.4 });
  assert.ok(dome, '应创建成功');
  assert.ok(scene.environment !== undefined, 'environment 字段可读');
  dome.dispose?.();
});

t('遍历 0→1 整圈 timeOfDay，applyTimeOfDay 全部安全', () => {
  const scene = new THREE.Scene();
  const dome = new SkyDome(scene, { timeOfDay: 0.5 });
  for (let i = 0; i <= 20; i++) {
    const tod = i / 20;
    assert.doesNotThrow(() => dome.setTimeOfDay(tod), `timeOfDay=${tod} 抛异常`);
  }
  dome.dispose?.();
});

t('pmrem 为 null 时 _updateEnv 安全返回', () => {
  const scene = new THREE.Scene();
  const dome = new SkyDome(scene, { timeOfDay: 0.5 });
  dome.pmrem = null;
  assert.doesNotThrow(() => dome._updateEnv({ top: new THREE.Color(0x2f7ff0), hor: new THREE.Color(0xbfe2ff), bot: new THREE.Color(0x8fa6b4), amb: 0.5 }));
  dome.dispose?.();
});

/* ================================================================
 * 3. 模拟"IBL 生成失败"时，整个流程仍能继续（不能拖垮 loadWorld）
 * ================================================================ */
console.log('\n--- 3) IBL 失败必须被吞掉，不得中断世界加载 ---');

t('_updateEnv 内部抛错时，applyTimeOfDay 不向外抛', () => {
  const scene = new THREE.Scene();
  const dome = new SkyDome(scene, { timeOfDay: 0.5 });
  // 让 pmrem 变成一个会爆炸的对象，模拟底层异常
  dome.pmrem = { fromEquirectangular() { throw new Error('模拟 PMREM 崩溃'); }, dispose() {} };
  dome._envT = -1;
  assert.doesNotThrow(() => dome.applyTimeOfDay(), 'IBL 异常不应冒泡到 applyTimeOfDay');
  dome.dispose?.();
});

uninstallDom();

console.log(`\n天空/环境贴图测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
