/**
 * src/world/landmarks.js
 * -----------------------------------------------------------------------------
 * 程序化地标 / 建筑 / 跑道 / 城市 / 船只 / 赛道 / 竞速圆环 / 收集物。
 *
 * 设计要点：
 *  1) 零外部资源：几何全部用 three 内置体（Box/Cylinder/Cone/Sphere/Torus/
 *     Lathe/Extrude/Capsule/Tube）+ 手工合并；贴图全部用 Canvas 现场绘制。
 *  2) 所有对象挂在 `this.root`（THREE.Group, name='landmarks'）下，整体卸载方便；
 *     root 永远位于原点且无旋转，因此子对象的 position 即世界坐标。
 *  3) 大量重复元素（树 / 路灯 / 围栏桩 / 集装箱 / 废机体 / 机库柱）走
 *     InstancedMesh，单 draw call 绘制上千个实例。
 *  4) 碰撞体是世界坐标的纯数据对象（box/sphere），构造期一次性生成，每帧只读
 *     （只有浮动的船只/气球会原地更新 center，不产生新对象）。
 *  5) 贴图 / 几何 / 材质全部去重缓存，dispose() 统一释放。
 *  6) 动态灯最多 3 盏（其余靠 emissive + 加法混合发光贴图），保证夜景氛围也便宜。
 *  7) 无 DOM（Node 单测）时自动降级为纯色材质，不会抛异常。
 *
 * 与物理模块的约定：
 *  - colliders 里的每个对象都是世界坐标的纯数据：
 *    box -> {center, halfExtents}，sphere -> {center, radius}；
 *  - `sensor === true` 的碰撞体是“触发体”（竞速环 ring / 云门 gate / 收集物 collectible），
 *    物理层做实体碰撞时必须跳过它们，只用它们做穿环/拾取的触发判定；
 *  - `destroyed === true` 表示已被摧毁（物体已隐藏并替换为燃烧残骸），物理层应停止碰撞；
 *  - 船只/气球/浮空岛等浮动体的 center 会在 update() 里原地更新（不重新分配对象）。
 *
 * 典型用法：
 *   const lm = new Landmarks(terrain, { kit: 'vetusta', seed: 7, density: 0.7 }).build(scene);
 *   // 每帧： lm.update(dt, time, camera);
 *   // 命中： lm.damage(collider, 120) -> true 表示本次摧毁；lm.destroyedCount
 *   // 换图： lm.dispose();
 * -----------------------------------------------------------------------------
 */
import * as THREE from 'three';

/** 全部地标套件名。 */
export const LANDMARK_KITS = [
  'archipelago', 'skypark', 'snowstone', 'maywar', 'vetusta',
  'raceway', 'naval', 'boneyard', 'stratos',
];

// =============================================================================
// 基础工具
// =============================================================================

/** 确定性伪随机（mulberry32），保证同一 seed 生成同一世界。 */
function makeRNG(seed) {
  let a = (seed | 0) >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 与顺序无关的确定性哈希 0..1，用于贴图里的“随机”花纹。 */
function hash01(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function lerp(a, b, t) { return a + (b - a) * t; }

/** 是否具备 Canvas 环境（浏览器）。Node 下为 false，贴图全部返回 null。 */
function hasCanvas() {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

/**
 * 把若干几何合并成一个 BufferGeometry（可选每段顶点色 / 变换矩阵）。
 * three 的 examples/jsm 未随 vendor 打包，这里自己实现（支持 indexed 输入）。
 * @param {Array<THREE.BufferGeometry | {geo:THREE.BufferGeometry, matrix?:THREE.Matrix4, color?:number}>} parts
 * @returns {THREE.BufferGeometry}
 */
function mergeGeos(parts) {
  const pos = [], nor = [], uvs = [], cols = [];
  let useColor = false;
  const norm = parts.map((p) => (p && p.geo ? p : { geo: p }));
  for (const p of norm) if (p.color !== undefined) useColor = true;

  for (const p of norm) {
    if (!p.geo) continue;
    let g = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
    if (p.matrix) g.applyMatrix4(p.matrix);
    const aPos = g.getAttribute('position');
    if (!aPos) { g.dispose(); continue; }
    const aNor = g.getAttribute('normal');
    const aUv = g.getAttribute('uv');
    const c = p.color !== undefined ? new THREE.Color(p.color) : null;
    for (let i = 0; i < aPos.count; i++) {
      pos.push(aPos.getX(i), aPos.getY(i), aPos.getZ(i));
      if (aNor) nor.push(aNor.getX(i), aNor.getY(i), aNor.getZ(i));
      else nor.push(0, 1, 0);
      if (aUv) uvs.push(aUv.getX(i), aUv.getY(i));
      else uvs.push(0, 0);
      if (useColor) {
        if (c) cols.push(c.r, c.g, c.b);
        else cols.push(1, 1, 1);
      }
    }
    g.dispose();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  if (useColor) geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  geo.computeBoundingSphere();
  return geo;
}

/** 便捷：平移矩阵。 */
function mat4(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz));
  m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy, sz));
  return m;
}

/**
 * 手工把盒体贴图的 UV 按真实尺寸缩放：3m 一个窗格，屋顶/底面 UV 钉在贴图
 * 的墙面色区域（避免屋顶发光）。BoxGeometry 顶点顺序：+X,-X,+Y,-Y,+Z,-Z。
 */
function scaleBoxUV(geo, w, h, d, metersPerTile = 3, roofU = 0.02, roofV = 0.02) {
  const uv = geo.getAttribute('uv');
  if (!uv) return geo;
  const su = [d / metersPerTile, d / metersPerTile, roofU, roofU, w / metersPerTile, w / metersPerTile];
  const sv = [h / metersPerTile, h / metersPerTile, roofV, roofV, h / metersPerTile, h / metersPerTile];
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < 4; i++) {
      const idx = f * 4 + i;
      if (idx >= uv.count) break;
      if (f === 2 || f === 3) { uv.setXY(idx, su[f], sv[f]); }
      else uv.setXY(idx, uv.getX(idx) * su[f], uv.getY(idx) * sv[f]);
    }
  }
  uv.needsUpdate = true;
  return geo;
}

// =============================================================================
// 程序化贴图工厂（Canvas）
// =============================================================================

/** 在 ctx 上撒噪点。 */
function speckle(ctx, w, h, count, colors, alpha = 0.12, size = 2) {
  for (let i = 0; i < count; i++) {
    const x = hash01(i * 3.1) * w;
    const y = hash01(i * 7.7 + 5) * h;
    ctx.globalAlpha = alpha * (0.35 + hash01(i * 11.3) * 0.65);
    ctx.fillStyle = colors[(i * 13) % colors.length];
    ctx.fillRect(x, y, size, size);
  }
  ctx.globalAlpha = 1;
}

/** 径向渐变发光贴图（火焰 / 星 / 灯）。 */
function radialDraw(ctx, w, h, inner, outer, hard = 0.0) {
  const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  if (hard > 0) {
    g.addColorStop(0, inner);
    g.addColorStop(hard, inner);
    g.addColorStop(1, outer);
  } else {
    g.addColorStop(0, inner);
    g.addColorStop(0.45, inner);
    g.addColorStop(1, outer);
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

/**
 * 贴图缓存。同名贴图只生成一次；无 DOM 时全部返回 null（材质退化为纯色）。
 */
class TextureFactory {
  constructor() {
    this.enabled = hasCanvas();
    this._cache = new Map();
    this._textures = [];
  }

  _finish(key, canvas, opts = {}) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    if (opts.clamp) {
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    } else {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
    }
    const r = opts.repeat || 1;
    t.repeat.set(r, r);
    t.anisotropy = opts.aniso || 4;
    t.needsUpdate = true;
    this._cache.set(key, t);
    this._textures.push(t);
    return t;
  }

  /** 取（或生成）一张贴图。draw(ctx,w,h) 负责绘制。 */
  get(key, w, h, draw, opts) {
    if (!this.enabled) return null;
    const hit = this._cache.get(key);
    if (hit) return hit;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    try { draw(ctx, w, h); } catch (e) { /* 绘制失败也不能崩，退化为纯色 */ }
    return this._finish(key, canvas, opts);
  }

  // ---------------- 具体贴图 ----------------

  /** 高层建筑窗户：同一张图既当 map 又当 emissiveMap，亮窗自发光。 */
  windows(style = 0) {
    const pals = [
      { wall: '#232833', lit: ['#cfe8ff', '#9fd6ff', '#ffe6b0'], dark: '#11141c' },
      { wall: '#2b2530', lit: ['#ffd9a0', '#ffb168', '#fff0cf'], dark: '#161219' },
      { wall: '#1f2a2c', lit: ['#a8fff0', '#7fe6ff', '#e8ffd0'], dark: '#0e1416' },
      { wall: '#2a2a34', lit: ['#ffb6f0', '#b79bff', '#8fe0ff'], dark: '#131320' },
    ];
    return this.get('win' + style, 256, 256, (ctx, w, h) => {
      const pal = pals[style % pals.length];
      ctx.fillStyle = pal.wall;
      ctx.fillRect(0, 0, w, h);
      speckle(ctx, w, h, 900, ['#ffffff', '#000000'], 0.05, 2);
      const cols = 8, rows = 10, pad = 7;
      const cw = (w - pad * 2) / cols, ch = (h - pad * 2) / rows;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = pad + c * cw + 2, y = pad + r * ch + 2;
          const ww = cw - 4, wh = ch - 5;
          const lit = hash01(r * 31.7 + c * 17.3 + style * 5.1) > 0.42;
          if (lit) {
            ctx.fillStyle = pal.lit[(r + c * 2) % pal.lit.length];
            ctx.globalAlpha = 0.75 + hash01(r * 3.3 + c * 9.1) * 0.25;
          } else {
            ctx.fillStyle = pal.dark;
            ctx.globalAlpha = 1;
          }
          ctx.fillRect(x, y, ww, wh);
          ctx.globalAlpha = 1;
          // 窗框高光
          ctx.fillStyle = 'rgba(255,255,255,0.06)';
          ctx.fillRect(x, y, ww, 1.5);
        }
      }
      // 顶部与底部楼层暗带（贴图接缝处看起来像楼层梁）
      ctx.fillStyle = pal.wall;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(0, 0, w, pad * 0.6);
      ctx.fillRect(0, h - pad * 0.6, w, pad * 0.6);
      ctx.fillRect(0, 0, pad * 0.6, h);
      ctx.fillRect(w - pad * 0.6, 0, pad * 0.6, h);
      ctx.globalAlpha = 1;
    });
  }

  concrete() {
    return this.get('concrete', 256, 256, (ctx, w, h) => {
      ctx.fillStyle = '#8d8f92'; ctx.fillRect(0, 0, w, h);
      speckle(ctx, w, h, 2600, ['#ffffff', '#5c5e61', '#a9abae'], 0.12, 2);
      ctx.strokeStyle = 'rgba(60,62,66,0.55)'; ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        ctx.beginPath(); ctx.moveTo((w / 4) * i, 0); ctx.lineTo((w / 4) * i, h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, (h / 4) * i); ctx.lineTo(w, (h / 4) * i); ctx.stroke();
      }
      ctx.fillStyle = 'rgba(40,42,45,0.25)';
      for (let i = 0; i < 12; i++) ctx.fillRect(hash01(i * 5.5) * w, 0, 1 + hash01(i * 2.2) * 2, h);
    }, { repeat: 1 });
  }

  asphalt() {
    return this.get('asphalt', 256, 256, (ctx, w, h) => {
      ctx.fillStyle = '#2c2e31'; ctx.fillRect(0, 0, w, h);
      speckle(ctx, w, h, 4200, ['#4a4d51', '#1b1c1e', '#6a6d72'], 0.35, 2);
      ctx.fillStyle = 'rgba(20,20,22,0.35)';
      for (let i = 0; i < 10; i++) {
        ctx.beginPath();
        ctx.ellipse(hash01(i * 9.1) * w, hash01(i * 4.4) * h, 12 + hash01(i * 6.6) * 26, 8 + hash01(i) * 18, hash01(i * 8) * 3, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  /** 跑道：U=长度方向，V=宽度方向（不重复，一条跑道一张图）。 */
  runway(lengthM, widthM, label = '27') {
    const w = 1024, h = 128;
    return this.get(`rwy${Math.round(lengthM)}_${Math.round(widthM)}_${label}`, w, h, (ctx) => {
      ctx.fillStyle = '#31343a'; ctx.fillRect(0, 0, w, h);
      speckle(ctx, w, h, 2600, ['#4d5157', '#22242a', '#75797f'], 0.3, 2);
      ctx.fillStyle = '#e8ecef';
      // 两侧边线
      ctx.fillRect(0, 3, w, 2.4);
      ctx.fillRect(0, h - 5.4, w, 2.4);
      // 中线虚线
      const dash = 26, gap = 22;
      for (let x = 6; x < w - 40; x += dash + gap) ctx.fillRect(x, h / 2 - 2, dash, 4);
      // 两端入口横条
      for (let i = 0; i < 8; i++) {
        const bw = 5, gapw = 6;
        ctx.fillRect(10 + i * (bw + gapw), 14, bw, h - 28);
        ctx.fillRect(w - 18 - i * (bw + gapw), 14, bw, h - 28);
      }
      // 接地带
      for (const base of [90, 150]) {
        ctx.fillRect(base, 26, 10, 22);
        ctx.fillRect(base, h - 48, 10, 22);
        ctx.fillRect(w - base - 10, 26, 10, 22);
        ctx.fillRect(w - base - 10, h - 48, 10, 22);
      }
      // 跑道号
      ctx.save();
      ctx.translate(52, h / 2); ctx.rotate(-Math.PI / 2);
      ctx.font = 'bold 34px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, 0, 0);
      ctx.restore();
      // 胎痕
      ctx.fillStyle = 'rgba(10,10,12,0.35)';
      for (let i = 0; i < 8; i++) ctx.fillRect(120 + i * 90, 40, 46, 8);
    }, { clamp: true, aniso: 8 });
  }

  /** 航母飞行甲板：斜角甲板 + 弹射器 + 拦阻索标记。 */
  carrierDeck(lengthM, widthM, name = 'TINY') {
    const w = 1024, h = 512;
    return this.get(`deck${name}`, w, h, (ctx) => {
      ctx.fillStyle = '#3b3f45'; ctx.fillRect(0, 0, w, h);
      speckle(ctx, w, h, 5000, ['#565b62', '#282b30', '#82878e'], 0.28, 2);
      // 甲板防滑纹（斜向细纹）
      ctx.strokeStyle = 'rgba(255,255,255,0.035)'; ctx.lineWidth = 1;
      for (let x = -h; x < w; x += 6) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + h, h); ctx.stroke();
      }
      // 斜角甲板中心线
      ctx.strokeStyle = '#eef2f5'; ctx.lineWidth = 4; ctx.setLineDash([34, 26]);
      ctx.beginPath(); ctx.moveTo(90, h - 96); ctx.lineTo(w - 120, 90); ctx.stroke();
      ctx.setLineDash([]);
      // 轴向降落中心线
      ctx.beginPath(); ctx.moveTo(60, h / 2); ctx.lineTo(w - 60, h / 2); ctx.stroke();
      // 弹射器轨道
      ctx.strokeStyle = '#d8dde2'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(40, h / 2 - 34); ctx.lineTo(520, h / 2 - 34); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(40, h / 2 + 34); ctx.lineTo(430, h / 2 + 34); ctx.stroke();
      // 拦阻索
      ctx.strokeStyle = '#f2c14e'; ctx.lineWidth = 2.5;
      for (let i = 0; i < 4; i++) {
        const x = 300 + i * 42;
        ctx.beginPath(); ctx.moveTo(x, h / 2 - 120); ctx.lineTo(x, h / 2 + 120); ctx.stroke();
      }
      // 升降机方块
      ctx.strokeStyle = '#f2f5f8'; ctx.lineWidth = 3;
      ctx.strokeRect(w - 210, h - 190, 96, 96);
      ctx.strokeRect(w - 210, h / 2 + 150, 96, 96);
      // 舰名
      ctx.save();
      ctx.translate(w - 70, h - 26); ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = '#e6ebef'; ctx.font = 'bold 40px system-ui, sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(name, 0, 0);
      ctx.restore();
      // 中轴线
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    }, { clamp: true, aniso: 8 });
  }

  hazard(a = '#e03a3a', b = '#f2f2f2') {
    return this.get('hazard' + a + b, 128, 128, (ctx, w, h) => {
      ctx.fillStyle = b; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = a;
      for (let i = -h; i < w + h; i += 32) {
        ctx.beginPath();
        ctx.moveTo(i, 0); ctx.lineTo(i + 16, 0); ctx.lineTo(i + 16 - h, h); ctx.lineTo(i - h, h);
        ctx.closePath(); ctx.fill();
      }
      speckle(ctx, w, h, 400, ['#000000'], 0.08, 2);
    }, { repeat: 4 });
  }

  metal() {
    return this.get('metal', 256, 256, (ctx, w, h) => {
      ctx.fillStyle = '#6f7782'; ctx.fillRect(0, 0, w, h);
      speckle(ctx, w, h, 2000, ['#8b939e', '#4c535c'], 0.22, 2);
      ctx.strokeStyle = 'rgba(30,34,40,0.5)'; ctx.lineWidth = 1.5;
      for (let i = 0; i <= 4; i++) {
        ctx.beginPath(); ctx.moveTo(0, (h / 4) * i); ctx.lineTo(w, (h / 4) * i); ctx.stroke();
      }
      for (let x = 6; x < w; x += 16) {
        for (let y = 6; y < h; y += 64) {
          ctx.fillStyle = 'rgba(220,228,236,0.5)';
          ctx.fillRect(x, y, 2, 2);
        }
      }
      ctx.fillStyle = 'rgba(120,70,40,0.18)';
      for (let i = 0; i < 8; i++) {
        ctx.beginPath();
        ctx.ellipse(hash01(i * 3.7) * w, hash01(i * 8.1) * h, 10 + hash01(i) * 24, 6 + hash01(i * 2) * 16, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  rust() {
    return this.get('rust', 256, 256, (ctx, w, h) => {
      ctx.fillStyle = '#5a4a3c'; ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 220; i++) {
        ctx.globalAlpha = 0.12 + hash01(i * 3.3) * 0.3;
        ctx.fillStyle = ['#8a5a2b', '#3b2f26', '#a9713a', '#6b5238'][i % 4];
        ctx.beginPath();
        ctx.ellipse(hash01(i * 5.1) * w, hash01(i * 9.7) * h, 4 + hash01(i) * 26, 3 + hash01(i * 2.2) * 20, hash01(i * 7) * 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      speckle(ctx, w, h, 1500, ['#c9a06a', '#221a14'], 0.18, 2);
    });
  }

  wood() {
    return this.get('wood', 256, 256, (ctx, w, h) => {
      ctx.fillStyle = '#8a6440'; ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 8; i++) {
        ctx.fillStyle = i % 2 ? 'rgba(70,48,28,0.35)' : 'rgba(190,150,110,0.16)';
        ctx.fillRect(0, i * 32, w, 30);
        ctx.fillStyle = 'rgba(50,34,20,0.55)';
        ctx.fillRect(0, i * 32 + 30, w, 2);
      }
      ctx.strokeStyle = 'rgba(90,60,34,0.35)'; ctx.lineWidth = 1;
      for (let i = 0; i < 60; i++) {
        const y = hash01(i * 4.4) * h;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.bezierCurveTo(w * 0.3, y + 4, w * 0.6, y - 4, w, y + 1); ctx.stroke();
      }
    });
  }

  /** 霓虹招牌（透明背景 + 发光文字）。 */
  neon(text, color = '#00d0ff') {
    return this.get('neon' + text + color, 512, 128, (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = 'bold 78px system-ui, sans-serif';
      ctx.shadowColor = color; ctx.shadowBlur = 26;
      ctx.fillStyle = color;
      ctx.fillText(text, w / 2, h / 2 + 2);
      ctx.shadowBlur = 12;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, w / 2, h / 2 + 2);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = color; ctx.lineWidth = 3;
      ctx.strokeRect(8, 8, w - 16, h - 16);
      ctx.globalAlpha = 1;
    }, { clamp: true });
  }

  glow(color = '#ffffff', hard = 0.25) {
    return this.get('glow' + color + hard, 128, 128, (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      radialDraw(ctx, w, h, color, 'rgba(0,0,0,0)', hard);
    }, { clamp: true });
  }

  star() {
    return this.get('star', 128, 128, (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      radialDraw(ctx, w, h, 'rgba(255,255,255,0.95)', 'rgba(255,220,120,0)', 0.18);
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(255,246,200,0.9)';
      ctx.lineWidth = 5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(w * 0.5, 6); ctx.lineTo(w * 0.5, h - 6); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(10, h * 0.5); ctx.lineTo(w - 10, h * 0.5); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,230,150,0.5)';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(18, 18); ctx.lineTo(w - 18, h - 18); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(w - 18, 18); ctx.lineTo(18, h - 18); ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }, { clamp: true });
  }

  ice() {
    return this.get('ice', 256, 256, (ctx, w, h) => {
      ctx.fillStyle = '#cfe6f2'; ctx.fillRect(0, 0, w, h);
      speckle(ctx, w, h, 2400, ['#ffffff', '#9dc4d8', '#eaf6ff'], 0.3, 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1.6;
      for (let i = 0; i < 26; i++) {
        const x = hash01(i * 6.1) * w, y = hash01(i * 2.7) * h;
        ctx.beginPath(); ctx.moveTo(x, y);
        ctx.lineTo(x + (hash01(i) - 0.5) * 90, y + (hash01(i * 3) - 0.5) * 90);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(120,170,200,0.4)'; ctx.lineWidth = 1;
      for (let i = 0; i < 40; i++) {
        const x = hash01(i * 8.3) * w, y = hash01(i * 5.9) * h;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 30, y + 12); ctx.stroke();
      }
    });
  }

  sand() {
    return this.get('sand', 256, 256, (ctx, w, h) => {
      ctx.fillStyle = '#c8a066'; ctx.fillRect(0, 0, w, h);
      speckle(ctx, w, h, 3000, ['#e0c48c', '#a67f4c', '#d8b478'], 0.25, 2);
      ctx.strokeStyle = 'rgba(150,116,70,0.3)'; ctx.lineWidth = 2;
      for (let i = 0; i < 16; i++) {
        const y = (i / 16) * h;
        ctx.beginPath();
        ctx.moveTo(0, y);
        for (let x = 0; x <= w; x += 16) ctx.lineTo(x, y + Math.sin(x * 0.06 + i) * 4);
        ctx.stroke();
      }
    });
  }

  grass() {
    return this.get('grass', 256, 256, (ctx, w, h) => {
      ctx.fillStyle = '#3f6b32'; ctx.fillRect(0, 0, w, h);
      speckle(ctx, w, h, 3000, ['#548c3c', '#2c4d24', '#6ba14a'], 0.3, 2);
      ctx.strokeStyle = 'rgba(120,180,90,0.25)'; ctx.lineWidth = 1;
      for (let i = 0; i < 700; i++) {
        const x = hash01(i * 3.1) * w, y = hash01(i * 7.3) * h;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (hash01(i) - 0.5) * 3, y - 5); ctx.stroke();
      }
    });
  }

  roofGravel() {
    return this.get('roof', 128, 128, (ctx, w, h) => {
      ctx.fillStyle = '#4b4e52'; ctx.fillRect(0, 0, w, h);
      speckle(ctx, w, h, 1500, ['#6a6e73', '#34373a', '#82868b'], 0.35, 2);
      ctx.fillStyle = 'rgba(30,32,34,0.4)';
      for (let i = 0; i < 6; i++) ctx.fillRect(hash01(i * 4.4) * w, hash01(i * 6.6) * h, 12, 2);
    });
  }

  container() {
    return this.get('container', 128, 128, (ctx, w, h) => {
      ctx.fillStyle = '#b9bec4'; ctx.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x += 8) {
        ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(x, 0, 3, h);
        ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fillRect(x + 4, 0, 2, h);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(0, 0, w, 6); ctx.fillRect(0, h - 6, w, 6);
      speckle(ctx, w, h, 600, ['#7a5a3a', '#ffffff'], 0.14, 2);
    }, { repeat: 2 });
  }

  flag(colorA = '#e8edf2', colorB = '#c0392b') {
    return this.get('flag' + colorA + colorB, 128, 96, (ctx, w, h) => {
      ctx.fillStyle = colorA; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = colorB;
      for (let i = 0; i < 4; i++) if (i % 2 === 0) ctx.fillRect(0, (h / 4) * i, w, h / 8);
      ctx.fillStyle = colorB; ctx.fillRect(0, 0, w, h / 6);
      ctx.globalAlpha = 0.12;
      for (let i = 0; i < 40; i++) {
        ctx.fillStyle = i % 2 ? '#000' : '#fff';
        ctx.fillRect(hash01(i * 3.3) * w, hash01(i * 5.5) * h, 10, 3);
      }
      ctx.globalAlpha = 1;
    }, { clamp: true });
  }

  /**
   * 悬索桥/高架桥面：U 方向横跨桥面，V 方向沿桥长（虚线沿 V 排布）。
   * 用 clamp 单张铺满，虚线数量按桥长估算，避免超长几何拉伸贴图。
   */
  roadDeck(lengthM) {
    const dashes = clamp(Math.round(lengthM / 14), 24, 400);
    const w = 256, h = 2048;
    return this.get(`deck${dashes}`, w, h, (ctx) => {
      ctx.fillStyle = '#33363b'; ctx.fillRect(0, 0, w, h);
      speckle(ctx, w, h, 2600, ['#4d5157', '#24262a', '#6b7076'], 0.22, 2);
      ctx.fillStyle = 'rgba(238,242,246,0.92)';
      ctx.fillRect(6, 0, 4, h);
      ctx.fillRect(w - 10, 0, 4, h);
      ctx.fillStyle = '#e8b53c';
      ctx.fillRect(w / 2 - 5, 0, 3.5, h);
      ctx.fillRect(w / 2 + 2, 0, 3.5, h);
      ctx.fillStyle = 'rgba(236,240,244,0.85)';
      const period = h / dashes;
      for (const lane of [0.26, 0.74]) {
        const x = w * lane - 1.5;
        for (let d = 0; d < dashes; d++) ctx.fillRect(x, d * period, 3, period * 0.45);
      }
    }, { clamp: true, aniso: 8 });
  }

  /** 石砌城墙（程序化砌块 + 风化），用于城堡。 */
  stoneWall(tint = '#8b8375') {
    return this.get('stone' + tint, 256, 256, (ctx, w, h) => {
      ctx.fillStyle = tint; ctx.fillRect(0, 0, w, h);
      const rows = 8, cols = 5;
      const bh = h / rows, bw = w / cols;
      for (let r = 0; r < rows; r++) {
        const off = (r % 2) * bw * 0.5;
        for (let c = -1; c <= cols; c++) {
          const x = off + c * bw, y = r * bh;
          const shade = 0.8 + hash01(r * 13.7 + c * 7.3) * 0.42;
          ctx.fillStyle = `rgba(255,255,255,${(shade - 1) * 0.55 + 0.05})`;
          ctx.fillRect(x + 1.5, y + 1.5, bw - 3, bh - 3);
          ctx.fillStyle = 'rgba(0,0,0,0.20)';
          ctx.fillRect(x, y + bh - 2.2, bw, 2.2);
          ctx.fillRect(x + bw - 2.2, y, 2.2, bh);
        }
      }
      speckle(ctx, w, h, 1400, ['#5f5a50', '#b9b2a4', '#7a6f5e'], 0.18, 2);
    });
  }

  /** 混凝土/沥青之外的地面铺装（广场砖）。 */
  pavement() {
    return this.get('pave', 128, 128, (ctx, w, h) => {
      ctx.fillStyle = '#7d7f83'; ctx.fillRect(0, 0, w, h);
      speckle(ctx, w, h, 900, ['#96989c', '#5f6165'], 0.2, 2);
      ctx.strokeStyle = 'rgba(50,52,56,0.5)'; ctx.lineWidth = 1.5;
      for (let i = 0; i <= 4; i++) {
        ctx.beginPath(); ctx.moveTo((w / 4) * i, 0); ctx.lineTo((w / 4) * i, h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, (h / 4) * i); ctx.lineTo(w, (h / 4) * i); ctx.stroke();
      }
    });
  }

  dispose() {
    for (const t of this._textures) t.dispose();
    this._textures.length = 0;
    this._cache.clear();
  }
}

// =============================================================================
// 可复用的小几何（单位化：底面 y=0，高度 1，带顶点色）
// =============================================================================

/** 针叶树：树干 + 三层锥体。 */
function coniferGeo() {
  const parts = [];
  parts.push({ geo: new THREE.CylinderGeometry(0.035, 0.05, 0.22, 5), matrix: mat4(0, 0.11, 0), color: 0x4a3826 });
  const layers = [
    { y: 0.2, r: 0.30, h: 0.42, c: 0x2c5a2e },
    { y: 0.44, r: 0.24, h: 0.36, c: 0x336b33 },
    { y: 0.66, r: 0.17, h: 0.34, c: 0x3d7a3a },
  ];
  for (const l of layers) {
    parts.push({ geo: new THREE.ConeGeometry(l.r, l.h, 7), matrix: mat4(0, l.y + l.h / 2, 0), color: l.c });
  }
  return mergeGeos(parts);
}

/** 阔叶树：树干 + 三个球状树冠。 */
function broadleafGeo() {
  const parts = [];
  parts.push({ geo: new THREE.CylinderGeometry(0.045, 0.07, 0.4, 6), matrix: mat4(0, 0.2, 0), color: 0x53412c });
  parts.push({ geo: new THREE.IcosahedronGeometry(0.26, 0), matrix: mat4(0, 0.62, 0), color: 0x2f6b32 });
  parts.push({ geo: new THREE.IcosahedronGeometry(0.18, 0), matrix: mat4(0.16, 0.78, 0.06), color: 0x3a7d38 });
  parts.push({ geo: new THREE.IcosahedronGeometry(0.16, 0), matrix: mat4(-0.15, 0.74, -0.08), color: 0x275c2a });
  return mergeGeos(parts);
}

/** 棕榈树：弯曲树干 + 6 片叶子。 */
function palmGeo() {
  const parts = [];
  let x = 0, y = 0, ang = 0.16;
  for (let i = 0; i < 5; i++) {
    const seg = new THREE.CylinderGeometry(0.03 - i * 0.003, 0.038 - i * 0.003, 0.22, 5);
    const dx = Math.sin(ang) * 0.2, dy = Math.cos(ang) * 0.2;
    parts.push({ geo: seg, matrix: mat4(x + dx / 2, y + dy / 2, 0, 0, 0, -ang), color: 0x6b5334 });
    x += dx; y += dy; ang += 0.14;
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    parts.push({
      geo: new THREE.ConeGeometry(0.07, 0.52, 4),
      matrix: mat4(x + Math.cos(a) * 0.22, y + 0.05, Math.sin(a) * 0.22, Math.cos(a) * 1.25, -a, Math.sin(a) * 1.25),
      color: i % 2 ? 0x3f7a35 : 0x4f8f3c,
    });
  }
  return mergeGeos(parts);
}

/** 枯树/沙漠树：扭曲枝干，可用于 boneyard / 沙漠。 */
function deadTreeGeo() {
  const parts = [];
  parts.push({ geo: new THREE.CylinderGeometry(0.03, 0.075, 0.62, 5), matrix: mat4(0, 0.31, 0), color: 0x6a5a46 });
  const branches = [
    [0.12, 0.5, 0, 0.55], [-0.14, 0.56, 0.1, -0.7],
    [0.05, 0.68, -0.12, 0.35], [-0.06, 0.74, 0.08, -0.3],
  ];
  for (const b of branches) {
    parts.push({
      geo: new THREE.CylinderGeometry(0.012, 0.028, 0.34, 4),
      matrix: mat4(b[0], b[1], b[2], 0, 0, b[3]),
      color: 0x5c4d3b,
    });
  }
  return mergeGeos(parts);
}

/** 灌木/岩石块（低矮细节）。 */
function bushGeo() {
  const parts = [];
  parts.push({ geo: new THREE.IcosahedronGeometry(0.3, 0), matrix: mat4(0, 0.24, 0, 0, 0, 0, 1, 0.7, 1), color: 0x3a6330 });
  parts.push({ geo: new THREE.IcosahedronGeometry(0.2, 0), matrix: mat4(0.22, 0.16, 0.1, 0, 0.6, 0), color: 0x44703a });
  return mergeGeos(parts);
}

/** 路灯：立杆 + 灯臂（灯头自发光另用 InstancedMesh 叠加）。 */
function streetlightGeo() {
  const parts = [];
  parts.push({ geo: new THREE.CylinderGeometry(0.11, 0.16, 8.4, 6), matrix: mat4(0, 4.2, 0), color: 0x3c4148 });
  parts.push({ geo: new THREE.CylinderGeometry(0.09, 0.09, 2.1, 5), matrix: mat4(1.0, 8.5, 0, 0, 0, Math.PI / 2), color: 0x3c4148 });
  return mergeGeos(parts);
}

/** 围栏桩（铁丝网立柱）。 */
function fencePostGeo() {
  return mergeGeos([
    { geo: new THREE.CylinderGeometry(0.09, 0.11, 3.2, 5), matrix: mat4(0, 1.6, 0), color: 0x50463a },
    { geo: new THREE.CylinderGeometry(0.14, 0.14, 0.1, 5), matrix: mat4(0, 3.2, 0), color: 0x50463a },
  ]);
}

/** 废弃机体（boneyard 原型，可直接 InstancedMesh）。 */
function wreckCraftGeo() {
  const parts = [];
  parts.push({ geo: new THREE.CylinderGeometry(0.55, 0.32, 6.4, 8), matrix: mat4(0, 1.5, 0, Math.PI / 2, 0, 0), color: 0x8d9299 });
  parts.push({ geo: new THREE.SphereGeometry(0.56, 8, 6), matrix: mat4(0, 1.5, -3.2), color: 0x9aa0a7 });
  parts.push({ geo: new THREE.ConeGeometry(0.55, 1.5, 8), matrix: mat4(0, 1.5, 3.6, Math.PI / 2, 0, 0), color: 0x7d838a });
  parts.push({ geo: new THREE.BoxGeometry(11.5, 0.24, 1.9), matrix: mat4(0, 1.5, -0.1, 0, 0, 0.06), color: 0x7f858c });
  parts.push({ geo: new THREE.BoxGeometry(4.2, 0.2, 1.4), matrix: mat4(0, 2.1, 3.3, 0, 0, 0.1), color: 0x767c83 });
  parts.push({ geo: new THREE.BoxGeometry(0.22, 1.9, 1.3), matrix: mat4(0, 2.9, 3.4), color: 0x71777e });
  return mergeGeos(parts);
}

/** 迷你隐藏飞机（收集物用的“craft”）。 */
function miniCraftGeo() {
  const parts = [];
  parts.push({ geo: new THREE.CylinderGeometry(0.42, 0.24, 3.6, 8), matrix: mat4(0, 0, 0, Math.PI / 2, 0, 0), color: 0xd8dee5 });
  parts.push({ geo: new THREE.ConeGeometry(0.42, 1.0, 8), matrix: mat4(0, 0, -2.3, -Math.PI / 2, 0, 0), color: 0xe8503a });
  parts.push({ geo: new THREE.BoxGeometry(5.2, 0.16, 1.3), matrix: mat4(0, -0.05, 0.1), color: 0xcfd6dd });
  parts.push({ geo: new THREE.BoxGeometry(1.9, 0.14, 0.7), matrix: mat4(0, 0.5, 1.6), color: 0xcfd6dd });
  parts.push({ geo: new THREE.BoxGeometry(0.14, 1.1, 0.7), matrix: mat4(0, 1.0, 1.6), color: 0xe8503a });
  parts.push({ geo: new THREE.CylinderGeometry(0.34, 0.34, 0.1, 8), matrix: mat4(0, 0, -2.6, Math.PI / 2, 0, 0), color: 0x3a3f45 });
  return mergeGeos(parts);
}

// =============================================================================
// Landmarks
// =============================================================================

export class Landmarks {
  /**
   * @param {object} terrain   terrain.js 的 Terrain 实例（可传 null，全部退化到海平面）
   * @param {object} [opts]    { kit, seed, density, water, seaLevel, maxColliders }
   */
  constructor(terrain, opts = {}) {
    const o = opts || {};
    this.terrain = terrain || null;
    this.kit = LANDMARK_KITS.indexOf(o.kit) >= 0 ? o.kit : 'archipelago';
    this.seed = (typeof o.seed === 'number' ? o.seed : 1337) | 0;
    this.density = clamp(typeof o.density === 'number' ? o.density : 0.6, 0, 1);
    this.water = o.water !== false;
    this.seaLevel = typeof o.seaLevel === 'number' ? o.seaLevel
      : (this.terrain && typeof this.terrain.seaLevel === 'number' ? this.terrain.seaLevel : 0);
    /** 碰撞体硬上限（物理模块每帧线性扫描，必须保持小数组）。 */
    this.maxColliders = typeof o.maxColliders === 'number' ? o.maxColliders : 780;

    this.root = new THREE.Group();
    this.root.name = 'landmarks';

    this._rng = makeRNG(this.seed);
    this._tex = new TextureFactory();
    this._geoCache = new Map();
    this._mats = {};
    this._matsOwned = [];
    this._instanced = [];
    this._spinners = [];      // 旋转件（雷达/风扇/起重机/螺旋桨）
    this._swayers = [];       // 摆动件（抽油机/风向袋/吊钩）
    this._bobbers = [];       // 浮动件（船/气球/飞艇）
    this._flames = [];        // 火焰（锥体/光斑）
    this._glows = [];         // 发光精灵
    this._billboards = [];    // 需要朝向相机的平面
    this._wrecks = [];        // 残骸
    this._rings = [];
    this._collectibles = [];
    this._turrets = [];
    this._colliders = [];
    this._anchors = { cargo: [], dropzones: [], targets: [], checkpoints: [], landingPads: [] };
    this._stats = { buildings: 0, trees: 0, roads: 0, area: 0 };
    this._skippedColliders = 0;
    this._lights = 0;
    this._destroyed = 0;
    this._flameBudget = 24;
    this._built = false;
    this._scene = null;
    this._ringCurve = null;

    // 复用临时对象：update() 内绝不 new，避免 GC 抖动
    this._tv = new THREE.Vector3();
    this._tv2 = new THREE.Vector3();
    this._tq = new THREE.Quaternion();
    this._te = new THREE.Euler();
    this._tm = new THREE.Matrix4();
    this._ts = new THREE.Vector3(1, 1, 1);
    this._tcol = new THREE.Color();

    // 生成序号
    this._colliderSeq = 0;
    this._noBuild = [];   // 禁区（跑道/城区内部不种树）
    this._pois = [];      // 主要兴趣点 { name, position, kind }
    this._customColliders = 0;
    this._bins = {};

    this._initGeometry();
    this._initMaterials();
  }

  // ------------------------------ 只读接口 ------------------------------

  /** 是否已构建。 */
  get built() { return this._built; }

  /** 碰撞体数组（世界坐标纯数据，构造后基本只读）。 */
  get colliders() { return this._colliders; }

  /** 竞速圆环（按飞行顺序）。 */
  get raceRings() { return this._rings; }

  /** 收集物（隐藏飞机 / 金币 / 星星）。 */
  get collectibles() { return this._collectibles; }

  /** 防御炮塔。 */
  get turrets() { return this._turrets; }

  /** 任务锚点。 */
  get anchors() { return this._anchors; }

  /** 已被摧毁的碰撞体数量。 */
  get destroyedCount() { return this._destroyed; }

  /** 统计信息（UI 展示）。 */
  get stats() {
    const size = this._worldSize();
    return {
      buildings: this._stats.buildings,
      trees: this._stats.trees,
      roads: this._stats.roads,
      area: this._stats.area || Math.round(size * size),
      kit: this.kit,
      colliders: this._colliders.length,
      skippedColliders: this._skippedColliders,
      rings: this._rings.length,
      collectibles: this._collectibles.length,
      turrets: this._turrets.length,
      destroyed: this._destroyed,
      aircraft: this._stats.aircraft || 0,
      instancedMeshes: this._instanced.length,
      dynamicLights: this._lights,
    };
  }

  // ------------------------------ 构建 ------------------------------

  /**
   * 生成整套地标并加入场景。
   * @param {THREE.Scene} scene
   * @returns {this}
   */
  build(scene) {
    if (this._built) return this;
    this._scene = scene || null;

    switch (this.kit) {
      case 'skypark': this._kitSkypark(); break;
      case 'snowstone': this._kitSnowstone(); break;
      case 'maywar': this._kitMaywar(); break;
      case 'vetusta': this._kitVetusta(); break;
      case 'raceway': this._kitRaceway(); break;
      case 'naval': this._kitNaval(); break;
      case 'boneyard': this._kitBoneyard(); break;
      case 'stratos': this._kitStratos(); break;
      case 'archipelago':
      default: this._kitArchipelago(); break;
    }

    this._flushBins();
    this._addSpawnAnchors();
    this._ensureMinimumAnchors();
    if (!this._stats.area) {
      const size = this._worldSize();
      this._stats.area = Math.round(size * size);
    }
    if (scene && typeof scene.add === 'function') scene.add(this.root);
    this._built = true;
    return this;
  }

  // ===========================================================================
  // 几何 / 材质初始化
  // ===========================================================================

  _initGeometry() {
    const G = this._geoCache;
    const put = (k, g) => { G.set(k, g); return g; };
    put('unitBox', new THREE.BoxGeometry(1, 1, 1));
    put('unitPlane', new THREE.PlaneGeometry(1, 1));
    put('unitCyl', new THREE.CylinderGeometry(1, 1, 1, 12));
    put('unitCyl6', new THREE.CylinderGeometry(1, 1, 1, 6));
    put('unitCone', new THREE.ConeGeometry(1, 1, 10));
    put('unitCone4', new THREE.ConeGeometry(1, 1, 4));
    put('unitSphere', new THREE.SphereGeometry(1, 14, 10));
    put('dome', new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2));
    put('unitCapsule', new THREE.CapsuleGeometry(1, 2, 4, 10));
    put('treeConifer', coniferGeo());
    put('treeBroadleaf', broadleafGeo());
    put('treePalm', palmGeo());
    put('treeDead', deadTreeGeo());
    put('bush', bushGeo());
    put('streetlight', streetlightGeo());
    put('fencePost', fencePostGeo());
    put('wreckCraft', wreckCraftGeo());
    put('miniCraft', miniCraftGeo());
    // 雷达抛物面（半球缺，开口朝 -Z）
    put('dish', (() => {
      const g = new THREE.SphereGeometry(1, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.42);
      g.rotateX(Math.PI / 2);
      return g;
    })());
    put('tetra', new THREE.TetrahedronGeometry(1, 0));
    put('icosa', new THREE.IcosahedronGeometry(1, 0));
  }

  /** 取（或惰性创建）共享几何。 */
  _G(key, factory) {
    const hit = this._geoCache.get(key);
    if (hit) return hit;
    const g = factory ? factory() : new THREE.BufferGeometry();
    this._geoCache.set(key, g);
    return g;
  }

  _initMaterials() {
    const tex = this._tex;
    const owned = this._matsOwned;
    const M = (name, mat) => { this._mats[name] = mat; owned.push(mat); return mat; };
    const std = (o) => new THREE.MeshStandardMaterial(o);
    const basic = (o) => new THREE.MeshBasicMaterial(o);

    // 建筑：亮窗贴图同时作为 map 与 emissiveMap，夜景自发光
    const winTex = [0, 1, 2, 3].map((i) => tex.windows(i));
    M('buildings', winTex.map((t) => std({
      map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0.95,
      color: 0xffffff, roughness: 0.72, metalness: 0.14,
    })));

    const concreteTex = tex.concrete();
    M('concrete', std({ map: concreteTex, color: 0xbfc3c8, roughness: 0.9, metalness: 0.04 }));
    M('concreteDark', std({ map: concreteTex, color: 0x6d7176, roughness: 0.92, metalness: 0.05 }));
    M('pavement', std({ map: tex.pavement(), color: 0xffffff, roughness: 0.95, metalness: 0.02 }));
    M('roof', std({ map: tex.roofGravel(), color: 0x8a8f94, roughness: 0.98, metalness: 0.03 }));
    M('asphalt', std({ map: tex.asphalt(), color: 0xffffff, roughness: 0.95, metalness: 0.02 }));
    M('metal', std({ map: tex.metal(), color: 0xffffff, roughness: 0.55, metalness: 0.55 }));
    M('metalDark', std({ map: tex.metal(), color: 0x5a6068, roughness: 0.6, metalness: 0.5 }));
    M('rust', std({ map: tex.rust(), color: 0xffffff, roughness: 0.92, metalness: 0.3 }));
    M('wood', std({ map: tex.wood(), color: 0xffffff, roughness: 0.85, metalness: 0.02 }));
    M('ice', std({ map: tex.ice(), color: 0xffffff, roughness: 0.25, metalness: 0.1, transparent: true, opacity: 0.95 }));
    M('sand', std({ map: tex.sand(), color: 0xffffff, roughness: 0.98, metalness: 0.0 }));
    M('grass', std({ map: tex.grass(), color: 0xffffff, roughness: 0.95, metalness: 0.0 }));
    M('container', std({ map: tex.container(), color: 0xffffff, roughness: 0.72, metalness: 0.35 }));
    M('glass', std({
      color: 0x9fd8ff, roughness: 0.08, metalness: 0.65, transparent: true, opacity: 0.34,
      side: THREE.DoubleSide, depthWrite: false,
    }));
    M('glassNeon', std({
      color: 0x11202a, emissive: 0x2ad4ff, emissiveIntensity: 1.1, roughness: 0.15, metalness: 0.4,
      transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false,
    }));
    M('hazard', std({ map: tex.hazard('#e03a3a', '#f2f2f2'), color: 0xffffff, roughness: 0.7 }));
    M('paintWhite', std({ color: 0xeef2f5, roughness: 0.6, metalness: 0.1 }));
    M('paintRed', std({ color: 0xc0392b, roughness: 0.65, metalness: 0.08 }));
    M('paintYellow', std({ color: 0xf2c14e, roughness: 0.6, metalness: 0.1 }));
    M('paintYellowEmis', std({ color: 0xf2c14e, emissive: 0xd88b1a, emissiveIntensity: 0.7, roughness: 0.55 }));
    M('hullGray', std({ color: 0x7d858e, roughness: 0.62, metalness: 0.45 }));
    M('hullDark', std({ color: 0x3f464e, roughness: 0.7, metalness: 0.4 }));
    M('hullRed', std({ color: 0x8c3b31, roughness: 0.7, metalness: 0.25 }));
    M('sail', std({ color: 0xe9e2d0, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide }));
    M('balloon', [
      std({ color: 0xe8503a, roughness: 0.75, side: THREE.DoubleSide }),
      std({ color: 0x2f8fd8, roughness: 0.75, side: THREE.DoubleSide }),
      std({ color: 0xf2c14e, roughness: 0.75, side: THREE.DoubleSide }),
      std({ color: 0x6ab04c, roughness: 0.75, side: THREE.DoubleSide }),
    ]);
    M('gold', std({ color: 0xffcc44, emissive: 0xff9f1a, emissiveIntensity: 0.85, roughness: 0.25, metalness: 1.0 }));
    M('star', basic({
      map: tex.star(), color: 0xffffff, transparent: true, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    M('wreck', std({ color: 0x33363b, roughness: 0.95, metalness: 0.25 }));
    M('wreckBurnt', std({ color: 0x1d1f22, roughness: 0.98, metalness: 0.2, emissive: 0x120500, emissiveIntensity: 0.6 }));
    M('scrap', std({ map: tex.rust(), color: 0x8a8f96, roughness: 0.9, metalness: 0.45 }));
    M('craftBody', std({ map: tex.metal(), color: 0xd6dde4, roughness: 0.42, metalness: 0.5 }));
    M('treeLeaf', std({ vertexColors: true, roughness: 0.92, metalness: 0.0 }));
    M('treeLeafSnow', std({ vertexColors: true, roughness: 0.95, metalness: 0.0, color: 0xd8e8f2 }));
    M('lampGlow', basic({ color: 0xffd9a0 }));
    M('lampGlowCool', basic({ color: 0xd8f0ff }));
    M('beaconRed', std({ color: 0x511, emissive: 0xff2b2b, emissiveIntensity: 1.0, roughness: 0.5 }));
    M('beaconWhite', std({ color: 0x666, emissive: 0xffffff, emissiveIntensity: 1.0, roughness: 0.5 }));
    M('flameCore', basic({ color: 0xffe08a, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
    M('flameOuter', basic({ color: 0xff6a14, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    M('bandWhite', std({ color: 0xe8edf2, roughness: 0.6 }));

    // 霓虹招牌（每 kit 若干，数量有限）
    M('neon', {});
    this._mats.neon = {};
    for (const spec of [
      ['VETUSTA', '#00d0ff'], ['HOTEL', '#ff4fa3'], ['SKYPARK', '#8fe0ff'],
      ['CASINO', '#ffb347'], ['TINY', '#7cff9b'], ['RACE', '#ff6b3d'],
      ['OIL', '#ffd166'], ['MOTEL', '#b79bff'],
      ['COCHRAN', '#4fd1ff'], ['NEW YOKE', '#ff8f3d'],
    ]) {
      const t = tex.neon(spec[0], spec[1]);
      const m = std({
        map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 1.15,
        transparent: true, side: THREE.DoubleSide, roughness: 0.5, depthWrite: false,
      });
      M('neon_' + spec[0], m);
      this._mats.neon[spec[0]] = m;
    }

    // 发光精灵材质（火焰光晕 / 灯光）——少量共享
    const glowWarm = tex.glow('#ffb347', 0.2);
    const glowCool = tex.glow('#9fe8ff', 0.2);
    const glowRed = tex.glow('#ff4433', 0.25);
    const smat = (map, color, opacity) => new THREE.SpriteMaterial({
      map, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    M('sprFlame', smat(glowWarm, 0xffffff, 0.85));
    M('sprCool', smat(glowCool, 0xffffff, 0.7));
    M('sprRed', smat(glowRed, 0xffffff, 0.8));
    M('sprStar', smat(tex.glow('#ffe9a8', 0.15), 0xffffff, 0.95));
  }

  // ===========================================================================
  // 地形查询（对 terrain.js 做防御式调用：缺失/异常都不崩）
  // ===========================================================================

  _worldSize() {
    const t = this.terrain;
    if (t && typeof t.size === 'number' && isFinite(t.size)) return t.size;
    if (t && t.opts && typeof t.opts.size === 'number') return t.opts.size;
    return 16000;
  }

  _heightAt(x, z) {
    const t = this.terrain;
    if (t && typeof t.heightAt === 'function') {
      const h = t.heightAt(x, z);
      if (typeof h === 'number' && isFinite(h)) return h;
    }
    return this.seaLevel;
  }

  _isWater(x, z) {
    const t = this.terrain;
    if (t && typeof t.isWater === 'function') {
      try { return !!t.isWater(x, z); } catch (e) { /* 落到下面的高度判断 */ }
    }
    return this._heightAt(x, z) < this.seaLevel;
  }

  _regionAt(x, z) {
    const t = this.terrain;
    if (t && typeof t.regionAt === 'function') {
      try { return t.regionAt(x, z); } catch (e) { return null; }
    }
    return null;
  }

  _randomLandPoint() {
    const t = this.terrain;
    if (t && typeof t.randomLandPoint === 'function') {
      try {
        const p = t.randomLandPoint(this._rng);
        if (p && isFinite(p.x) && isFinite(p.z)) {
          return { x: p.x, y: isFinite(p.y) ? p.y : this._heightAt(p.x, p.z), z: p.z };
        }
      } catch (e) { /* 回退到拒绝采样 */ }
    }
    const size = this._worldSize() * 0.86;
    for (let i = 0; i < 24; i++) {
      const x = (this._rng() - 0.5) * size;
      const z = (this._rng() - 0.5) * size;
      if (!this._isWater(x, z)) return { x, y: this._heightAt(x, z), z };
    }
    return null;
  }

  /**
   * 找一个起伏最小的平地（跑道/城区用）。
   * @param {boolean} [avoid] 跳过已登记禁区的候选点（避免把机场盖到城里）
   */
  _findFlatSpot(cx, cz, searchR = 1800, flatR = 150, avoid = false, axisLen = 0) {
    let best = null;
    for (let i = 0; i < 26; i++) {
      const a = this._rng() * Math.PI * 2;
      const d = i === 0 ? 0 : Math.sqrt(this._rng()) * searchR;
      const x = cx + Math.cos(a) * d;
      const z = cz + Math.sin(a) * d;
      if (avoid && this._isReserved(x, z)) continue;
      let lo = Infinity, hi = -Infinity, ok = true;
      const probes = 8;
      const sample = (px, pz) => {
        if (!ok) return;
        if (this._isWater(px, pz)) { ok = false; return; }
        const h = this._heightAt(px, pz);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      };
      for (let k = 0; k < probes; k++) {
        const aa = (k / probes) * Math.PI * 2;
        sample(x + Math.cos(aa) * flatR, z + Math.sin(aa) * flatR);
      }
      if (axisLen > 0) {
        // 长跑道：按真实矩形足迹取样（含停机坪侧向宽度，两种走向各取一遍），
        // 这样选出的场地整块都平，跑道底板不会悬空或穿山
        const halfW = Math.max(flatR, 240);
        for (let o = 0; o < 2; o++) {
          for (let fi = 0; fi <= 6; fi++) {
            const f = (fi / 6 - 0.5) * axisLen;
            for (let ri = -2; ri <= 2; ri++) {
              const r = (ri / 2) * halfW;
              if (o === 0) sample(x + f, z + r);
              else sample(x + r, z + f);
            }
          }
        }
      }
      if (!ok) continue;
      const rough = hi - lo;
      if (!best || rough < best.rough) best = { x, y: (lo + hi) * 0.5, z, rough };
      if (rough < 2.5) break;
    }
    if (!best) {
      const y = Math.max(this._heightAt(cx, cz), this.seaLevel);
      best = { x: cx, y, z: cz, rough: 99 };
    }
    return best;
  }

  /** 找一片水面（码头/海军用）；找不到就返回地形基准点。 */
  _findWaterSpot(cx, cz, searchR = 2600) {
    for (let i = 0; i < 60; i++) {
      const a = this._rng() * Math.PI * 2;
      const d = 120 + Math.sqrt(this._rng()) * searchR;
      const x = cx + Math.cos(a) * d;
      const z = cz + Math.sin(a) * d;
      if (this._isWater(x, z)) {
        // 要求周边也大多是水（避免站在巴掌大的水洼里）
        let wet = 0;
        for (let k = 0; k < 5; k++) {
          const aa = (k / 5) * Math.PI * 2;
          if (this._isWater(x + Math.cos(aa) * 90, z + Math.sin(aa) * 90)) wet++;
        }
        if (wet >= 3) return { x, y: this.seaLevel, z };
      }
    }
    return { x: cx, y: this.seaLevel, z: cz };
  }

  /** 主基准点：优先地形 spawnPoint[0]，否则原点周围找块平地。 */
  _primary() {
    const t = this.terrain;
    if (t && t.spawnPoints && t.spawnPoints.length) {
      const sp = t.spawnPoints[0];
      if (sp && sp.position) {
        return {
          x: sp.position.x, y: sp.position.y, z: sp.position.z,
          heading: typeof sp.heading === 'number' ? sp.heading : 0,
          runwayLength: sp.runwayLength || 900,
          fromSpawn: true,
        };
      }
    }
    const flat = this._findFlatSpot(0, 0, this._worldSize() * 0.18, 220);
    return { x: flat.x, y: flat.y, z: flat.z, heading: 0, runwayLength: 900, fromSpawn: false };
  }

  // ===========================================================================
  // 通用构造辅助
  // ===========================================================================

  /** 加一个网格（position 即世界坐标，因为 root 永远在原点）。 */
  mesh(geo, material, x = 0, y = 0, z = 0, opts) {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    this._xform(m, opts);
    (opts && opts.parent ? opts.parent : this.root).add(m);
    return m;
  }

  _xform(obj, o) {
    if (!o) return obj;
    if (o.rx || o.ry || o.rz) obj.rotation.set(o.rx || 0, o.ry || 0, o.rz || 0);
    if (o.sx !== undefined || o.sy !== undefined || o.sz !== undefined) {
      obj.scale.set(o.sx !== undefined ? o.sx : 1, o.sy !== undefined ? o.sy : 1, o.sz !== undefined ? o.sz : 1);
    } else if (o.s !== undefined) {
      obj.scale.setScalar(o.s);
    }
    if (o.name) obj.name = o.name;
    return obj;
  }

  box(w, h, d, material, x, y, z, opts) {
    return this.mesh(this._G('unitBox'), material, x, y, z,
      Object.assign({ sx: w, sy: h, sz: d }, opts || {}));
  }

  cyl(rt, rb, h, material, x, y, z, opts) {
    const seg = (opts && opts.seg) || 12;
    const g = this._G('cyl' + rt.toFixed(2) + '_' + rb.toFixed(2) + '_' + seg,
      () => new THREE.CylinderGeometry(rt, rb, 1, seg));
    return this.mesh(g, material, x, y, z, Object.assign({ sy: h }, opts || {}));
  }

  cone(r, h, material, x, y, z, opts) {
    const seg = (opts && opts.seg) || 10;
    const g = this._G('cone' + seg, () => new THREE.ConeGeometry(1, 1, seg));
    return this.mesh(g, material, x, y, z, Object.assign({ sx: r, sy: h, sz: r }, opts || {}));
  }

  sphere(r, material, x, y, z, opts) {
    return this.mesh(this._G('unitSphere'), material, x, y, z, Object.assign({ s: r }, opts || {}));
  }

  plane(w, d, material, x, y, z, opts) {
    return this.mesh(this._G('unitPlane'), material, x, y, z,
      Object.assign({ rx: -Math.PI / 2, sx: w, sy: d }, opts || {}));
  }

  group(x = 0, y = 0, z = 0, parent) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    (parent || this.root).add(g);
    return g;
  }

  /** 生成一个 InstancedMesh（默认满实例数，之后用 setMatrixAt 填）。 */
  instance(geoKey, material, count, opts = {}) {
    const geo = typeof geoKey === 'string' ? this._G(geoKey, opts.factory) : geoKey;
    const im = new THREE.InstancedMesh(geo, material, count);
    im.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    im.frustumCulled = opts.frustumCulled !== false;
    im.name = opts.name || 'instanced';
    im.userData.filled = 0;
    if (opts.castShadow) im.castShadow = true;
    this.root.add(im);
    this._instanced.push(im);
    return im;
  }

  /** 在任意父节点下创建实例网格（桥梁吊索/栏杆这类局部坐标实例）。 */
  instanceIn(parent, geoKey, material, count, opts = {}) {
    const geo = typeof geoKey === 'string' ? this._G(geoKey, opts.factory) : geoKey;
    const im = new THREE.InstancedMesh(geo, material, count);
    im.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    im.frustumCulled = opts.frustumCulled !== false;
    im.name = opts.name || 'instanced';
    im.userData.filled = 0;
    (parent || this.root).add(im);
    this._instanced.push(im);
    return im;
  }

  /**
   * 用位置/旋转/缩放填写一个实例槽位。
   * @param {number} s 水平缩放（宽/深）
   * @param {number} [sY] 垂直缩放（默认与 s 相同，用于树木这类需要拉高的实例）
   */
  setInstance(im, i, x, y, z, ry = 0, s = 1, tilt = 0, color, sY) {
    this._tv.set(x, y, z);
    this._te.set(tilt, ry, tilt * 0.6);
    this._tq.setFromEuler(this._te);
    this._ts.set(s, sY === undefined ? s : sY, s);
    this._tm.compose(this._tv, this._tq, this._ts);
    im.setMatrixAt(i, this._tm);
    im.userData.filled = i + 1;
    if (color !== undefined) im.setColorAt(i, this._tcol.set(color));
  }

  /** 收尾 InstancedMesh：标记矩阵（与实例色）需要上传。 */
  finishInstance(im) {
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    return im;
  }

  /** 非等比缩放版实例写入（集装箱/废料等需要任意长宽高）。 */
  setInstanceXYZ(im, i, x, y, z, ry, sx, sy, sz, tilt = 0, color) {
    this._tv.set(x, y, z);
    this._te.set(tilt, ry, tilt * 0.6);
    this._tq.setFromEuler(this._te);
    this._ts.set(sx, sy, sz);
    this._tm.compose(this._tv, this._tq, this._ts);
    im.setMatrixAt(i, this._tm);
    im.userData.filled = i + 1;
    if (color !== undefined) im.setColorAt(i, this._tcol.set(color));
  }

  /**
   * 用一串球体近似胶囊碰撞体（对旋转的船只 AABB 不成立，球体与朝向无关）。
   * @returns {Array<object>} 生成的碰撞体
   */
  addCapsuleSpheres(kind, x, y, z, heading, halfLen, radius, o = {}) {
    const dirX = -Math.sin(heading), dirZ = -Math.cos(heading);
    const n = Math.max(1, Math.min(10, Math.ceil(halfLen / Math.max(1, radius * 0.9))));
    const out = [];
    for (let i = 0; i < n; i++) {
      const f = n === 1 ? 0 : (i / (n - 1)) * 2 * halfLen - halfLen;
      out.push(this.addSphereCollider(kind, x + dirX * f, y, z + dirZ * f, radius, o));
    }
    return out;
  }

  /** 添加动态灯；超过 3 盏直接忽略（保持便宜）。 */
  addLight(light) {
    if (this._lights >= 3) return null;
    this._lights++;
    this.root.add(light);
    return light;
  }

  _poi(name, x, y, z, kind = 'poi', radius = 90) {
    const p = new THREE.Vector3(x, y, z);
    this._pois.push({ name, position: p, kind });
    this._anchor('checkpoints', name, p, radius);
    return p;
  }

  _anchor(type, name, pos, radius) {
    const arr = this._anchors[type];
    if (!arr) return null;
    const a = {
      id: `${this.kit}_${type}_${arr.length}`,
      name,
      position: pos && pos.isVector3 ? pos.clone() : new THREE.Vector3(pos.x, pos.y, pos.z),
      radius: radius || 60,
    };
    arr.push(a);
    return a;
  }

  /** 在半径 r 内登记“禁止种树/摆件”的禁区。 */
  _reserve(x, z, r) { this._noBuild.push({ x, z, r }); }

  _isReserved(x, z) {
    const list = this._noBuild;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const dx = x - b.x, dz = z - b.z;
      if (dx * dx + dz * dz < b.r * b.r) return true;
    }
    return false;
  }

  // ===========================================================================
  // 碰撞体
  // ===========================================================================

  /** 世界坐标盒碰撞体；oriented=true 时 halfExtents 保存旋转后的世界 AABB。 */
  addBoxCollider(kind, cx, cy, cz, hx, hy, hz, o = {}) {
    if (this._colliders.length >= this.maxColliders) { this._skippedColliders++; return null; }
    const heading = typeof o.heading === 'number' && Number.isFinite(o.heading) ? o.heading : 0;
    const localHalfExtents = o.oriented ? new THREE.Vector3(hx, hy, hz) : null;
    const halfExtents = localHalfExtents
      ? new THREE.Vector3(
        Math.abs(Math.cos(heading)) * hx + Math.abs(Math.sin(heading)) * hz,
        hy,
        Math.abs(Math.sin(heading)) * hx + Math.abs(Math.cos(heading)) * hz,
      )
      : new THREE.Vector3(hx, hy, hz);
    const c = {
      id: o.id || `${this.kit}_${kind}_${this._colliderSeq++}`,
      kind,
      shape: 'box',
      center: new THREE.Vector3(cx, cy, cz),
      // 通用碰撞/空间哈希使用保守世界 AABB；落地查询另用局部尺寸与朝向。
      halfExtents,
      localHalfExtents,
      quaternion: localHalfExtents
        ? new THREE.Quaternion(0, Math.sin(heading * 0.5), 0, Math.cos(heading * 0.5))
        : null,
      destructible: !!o.destructible,
      health: typeof o.health === 'number' ? o.health : 0,
      maxHealth: typeof o.health === 'number' ? o.health : 0,
      mass: typeof o.mass === 'number' ? o.mass : 0,
      static: o.static !== false,
      object: o.object || null,
      sensor: !!o.sensor,
      floating: !!o.floating,
      name: o.name || kind,
      heading,
      platformCos: localHalfExtents ? Math.cos(heading) : 1,
      platformSin: localHalfExtents ? Math.sin(heading) : 0,
      surfaceY: Number.isFinite(o.surfaceY) ? o.surfaceY : null,
      surfaceSlope: Number.isFinite(o.surfaceSlope) ? o.surfaceSlope : 0,
      // 顶面由起落架平台逻辑单向承载；用于浮空岛等有厚实体的可降落表面。
      oneWayTop: o.oneWayTop === true,
      destroyed: false,
    };
    this._colliders.push(c);
    if (c.object) c.object.userData.collider = c;
    if (o.floating) this._addBobber(c, cy, o);
    this._customColliders++;
    return c;
  }

  /** 注册浮动件（同一 Object3D 只建一条 bobber，多个碰撞体共享）。 */
  _addBobber(c, cy, o) {
    const obj = c.object || null;
    let b = null;
    if (obj) {
      for (let i = 0; i < this._bobbers.length; i++) {
        if (this._bobbers[i].obj === obj) { b = this._bobbers[i]; break; }
      }
    }
    if (!b) {
      b = {
        obj,
        colliders: [],
        baseY: obj ? obj.position.y : cy,
        amp: o.bobAmp || 0.9, speed: o.bobSpeed || 0.7,
        phase: this._rng() * Math.PI * 2,
        roll: o.bobRoll || 0.02, pitch: o.bobPitch || 0.012,
      };
      this._bobbers.push(b);
    }
    b.colliders.push({ c, off: cy - (obj ? obj.position.y : cy) });
    return b;
  }

  /**
   * 世界坐标球碰撞体（shape='sphere'；船只/圆环/收集物都用它，与朝向无关）。
   */
  addSphereCollider(kind, cx, cy, cz, radius, o = {}) {
    if (this._colliders.length >= this.maxColliders) { this._skippedColliders++; return null; }
    const c = {
      id: o.id || `${this.kit}_${kind}_${this._colliderSeq++}`,
      kind,
      shape: 'sphere',
      center: new THREE.Vector3(cx, cy, cz),
      radius,
      destructible: !!o.destructible,
      health: typeof o.health === 'number' ? o.health : 0,
      maxHealth: typeof o.health === 'number' ? o.health : 0,
      mass: typeof o.mass === 'number' ? o.mass : 0,
      static: o.static !== false,
      object: o.object || null,
      sensor: !!o.sensor,
      floating: !!o.floating,
      name: o.name || kind,
      heading: typeof o.heading === 'number' ? o.heading : 0,
      destroyed: false,
    };
    this._colliders.push(c);
    if (c.object) c.object.userData.collider = c;
    if (o.floating) this._addBobber(c, cy, o);
    this._customColliders++;
    return c;
  }

  /**
   * 对碰撞体造成伤害；生命归零时隐藏原对象并生成燃烧残骸。
   * @returns {boolean} 本次调用是否摧毁了它
   */
  damage(collider, amount) {
    if (!collider || collider.destroyed) return false;
    const dmg = Number(amount);
    if (!collider.destructible) return false;
    collider.health -= (isFinite(dmg) ? Math.max(0, dmg) : 0);
    if (collider.health > 0) return false;
    collider.health = 0;
    collider.destroyed = true;
    this._destroyed++;
    this._spawnWreck(collider);
    return true;
  }

  /** 直接摧毁（内部/脚本用）。 */
  destroy(collider) { return this.damage(collider, Infinity); }

  _spawnWreck(c) {
    const obj = c.object;
    if (obj) obj.visible = false;

    const isBox = c.shape === 'box';
    const hx = isBox ? c.halfExtents.x : c.radius;
    const hy = isBox ? c.halfExtents.y : c.radius;
    const hz = isBox ? c.halfExtents.z : c.radius;

    const grp = this.group(0, 0, 0);
    grp.rotation.y = this._rng() * Math.PI * 2;

    // 残骸主体
    let hull;
    if (obj && obj.isMesh && !obj.isInstancedMesh && obj.geometry) {
      // 直接复用原几何（颜色变黑 + 轻微凹陷），视觉上最像“同一个东西烧毁了”
      hull = new THREE.Mesh(obj.geometry, this._mats.wreckBurnt);
      hull.position.copy(obj.position);
      hull.quaternion.copy(obj.quaternion);
      hull.scale.copy(obj.scale).multiplyScalar(0.94);
      this.root.add(hull);
      grp.position.copy(c.center);
      grp.rotation.set(0, 0, 0);
    } else {
      hull = new THREE.Mesh(this._G('unitBox'), this._mats.wreck);
      hull.scale.set(Math.max(1.4, hx * 1.7), Math.max(1, hy * 1.5), Math.max(1.4, hz * 1.7));
      hull.rotation.set((this._rng() - 0.5) * 0.5, 0, (this._rng() - 0.5) * 0.5);
      grp.add(hull);
      // 碎片
      for (let i = 0; i < 3; i++) {
        const d = new THREE.Mesh(this._G('unitBox'), this._mats.scrap);
        const s = 0.25 + this._rng() * 0.5;
        d.scale.set(Math.max(0.8, hx * s), Math.max(0.4, hy * s * 0.5), Math.max(0.8, hz * s));
        d.position.set((this._rng() - 0.5) * hx * 1.8, -hy * 0.7 + this._rng() * hy * 0.4, (this._rng() - 0.5) * hz * 1.8);
        d.rotation.set(this._rng() * 3, this._rng() * 3, this._rng() * 3);
        grp.add(d);
      }
    }

    // 火焰（数量受限，避免大规模摧毁时爆帧）
    const flames = [];
    const burn = this._wrecks.length < this._flameBudget;
    if (burn) {
      const big = Math.max(2, Math.min(14, Math.max(hx, hy, hz) * 0.5));
      const flameMatA = this._mats.flameCore.clone();
      const flameMatB = this._mats.flameOuter.clone();
      for (let i = 0; i < 3; i++) {
        const cone = new THREE.Mesh(this._G('unitCone', () => new THREE.ConeGeometry(1, 1, 7)),
          i === 0 ? flameMatA : flameMatB);
        const s = big * (i === 0 ? 1.0 : 0.65);
        cone.scale.set(s, s * 1.7, s);
        cone.position.set((this._rng() - 0.5) * hx, hy * 0.5 + s * 0.6, (this._rng() - 0.5) * hz);
        cone.material.depthWrite = false;
        grp.add(cone);
        flames.push({ mesh: cone, base: s, phase: this._rng() * 6.28, speed: 6 + this._rng() * 5, mat: cone.material });
      }
      const spr = new THREE.Sprite(this._mats.sprFlame);
      spr.scale.setScalar(big * 6);
      spr.position.y = hy * 0.6;
      grp.add(spr);
      flames.push({ sprite: spr, base: big * 6, phase: this._rng() * 6.28, speed: 4 });
      this._glows.push({ sprite: spr, base: big * 6, phase: this._rng() * 6.28 });
    }

    this._wrecks.push({
      group: grp, collider: c, burning: burn, flames,
      fall: !!c.floating, vy: 0, life: 0,
    });
  }

  // ===========================================================================
  // 圆环 / 收集物 / 炮塔
  // ===========================================================================

  /**
   * 用一条闭合 Catmull-Rom 曲线生成有序空中赛道。
   * 圆环半径约 35m，环面法线沿飞行切线（机头 -Z 约定下即从环中穿过）。
   */
  makeRingCircuit(points, count = 12, radius = 35) {
    const verts = points.map((p) => (p && p.isVector3 ? p.clone() : new THREE.Vector3(p[0], p[1], p[2])));
    const curve = new THREE.CatmullRomCurve3(verts, true, 'catmullrom', 0.5);
    this._ringCurve = curve;
    const geo = this._G(`torus${radius}`, () => new THREE.TorusGeometry(radius, Math.max(1.1, radius * 0.042), 8, 36));
    const zAxis = new THREE.Vector3(0, 0, 1);
    const n = Math.max(2, count | 0);

    // 清掉旧环（同一次构建内一般只调用一次）
    for (const r of this._rings) {
      if (r.object && r.object.parent) r.object.parent.remove(r.object);
      if (r.material) { const i = this._matsOwned.indexOf(r.material); if (i >= 0) this._matsOwned.splice(i, 1); r.material.dispose(); }
    }
    this._rings.length = 0;

    for (let i = 0; i < n; i++) {
      const t = i / n;
      const pos = curve.getPointAt(t);
      const tan = curve.getTangentAt(t).normalize();
      const mat = new THREE.MeshStandardMaterial({
        color: 0x0b2b33, emissive: 0x22e0ff, emissiveIntensity: 1.15,
        roughness: 0.35, metalness: 0.25, transparent: true, opacity: 0.66,
        side: THREE.DoubleSide, depthWrite: false,
      });
      this._matsOwned.push(mat);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(pos);
      mesh.quaternion.setFromUnitVectors(zAxis, tan);
      mesh.name = `ring_${i}`;
      this.root.add(mesh);
      const ring = {
        index: i, position: pos.clone(), radius, object: mesh,
        passed: false, material: mat,
      };
      mesh.userData.ring = ring;
      this._rings.push(ring);
      // 供物理层做“穿环”触发的 sensor 球（sensor=true 表示不参与实体碰撞）
      this.addSphereCollider('ring', pos.x, pos.y, pos.z, radius * 0.85, {
        sensor: true, id: `${this.kit}_ring_${i}`, name: `Ring ${i + 1}`, object: mesh, static: true,
      });
    }
    return this._rings;
  }

  /** 游戏判定穿环后调用（也可自行改 ring.passed）。 */
  markRingPassed(index, passed = true) {
    const r = this._rings[index];
    if (!r) return false;
    r.passed = passed;
    if (r.material) {
      r.material.color.set(passed ? 0x0d3320 : 0x0b2b33);
      r.material.emissive.set(passed ? 0x49ff9a : 0x22e0ff);
    }
    return true;
  }

  /** 重置所有圆环的通过状态（重新开始比赛时调用）。 */
  resetRings() {
    for (const r of this._rings) {
      r.passed = false;
      if (r.object) r.object.visible = true;
      if (r.material) {
        r.material.color.set(0x0b2b33);
        r.material.emissive.set(0x22e0ff);
        r.material.opacity = 0.66;
      }
    }
  }

  /**
   * 添加收集物。
   * @param {'craft'|'coin'|'star'} kind
   */
  addCollectible(kind, x, y, z, name) {
    const id = `${this.kit}_col_${this._collectibles.length}`;
    let obj;
    if (kind === 'craft') {
      obj = new THREE.Mesh(this._G('miniCraft'), this._mats.craftBody);
    } else if (kind === 'coin') {
      obj = new THREE.Mesh(this._G('coin', () => new THREE.CylinderGeometry(1, 1, 0.14, 18)),
        this._mats.gold);
      obj.scale.setScalar(4.2);
      obj.rotation.x = Math.PI / 2;
    } else {
      obj = new THREE.Mesh(this._G('starQuad', () => new THREE.PlaneGeometry(1, 1)), this._mats.star);
      obj.scale.setScalar(16);
    }
    obj.position.set(x, y, z);
    obj.name = id;
    this.root.add(obj);
    // 光晕（精灵自动朝向相机）
    const spr = new THREE.Sprite(this._mats.sprStar);
    spr.scale.setScalar(kind === 'craft' ? 22 : 26);
    spr.position.copy(obj.position);
    this.root.add(spr);

    const item = {
      id, name: name || id, position: new THREE.Vector3(x, y, z),
      collected: false, object: obj, kind, glows: spr, phase: this._rng() * 6.28,
    };
    const col = this.addSphereCollider('collectible', x, y, z, kind === 'craft' ? 7 : 6, {
      sensor: true, id: `${id}_trigger`, name: item.name, object: obj, static: true,
    });
    item.collider = col;
    this._collectibles.push(item);
    return item;
  }

  /** 收集（游戏调用）：隐藏并标记。 */
  collect(item) {
    if (!item || item.collected) return false;
    item.collected = true;
    if (item.object) item.object.visible = false;
    if (item.glows) item.glows.visible = false;
    return true;
  }

  /** 防空炮塔（会对飞机开火的防御目标）。 */
  addTurret(x, y, z, opts = {}) {
    const base = this.group(x, y, z);
    base.name = 'turret';
    const pad = this.mesh(this._G('unitCyl6'), this._mats.concrete, 0, 0.7, 0, { sx: 5.2, sy: 1.4, sz: 5.2, parent: base });
    pad.name = 'turretPad';
    const dome = this.sphere(3.0, this._mats.hullDark, 0, 2.4, 0, { parent: base });
    dome.scale.set(3.0, 1.6, 3.0);
    const head = this.group(0, 3.4, 0, base);
    const body = this.box(4.4, 2.2, 3.6, this._mats.metal, 0, 0, 0, { parent: head });
    body.name = 'turretBody';
    const barrels = new THREE.Group();
    head.add(barrels);
    for (const off of [-1.1, 1.1]) {
      const b = this.cyl(0.32, 0.32, 9, this._mats.hullDark, off, 0.35, -4.6, { parent: barrels, seg: 8 });
      b.rotation.x = Math.PI / 2;
      b.name = 'barrel';
    }
    const col = this.addSphereCollider('tower', x, y + 3.2, z, 3.4, {
      destructible: true, health: opts.health || 140, mass: 1200,
      name: opts.name || 'AA Turret', object: base,
    });
    const t = {
      id: `${this.kit}_turret_${this._turrets.length}`,
      position: new THREE.Vector3(x, y, z),
      object: base, head, barrels, collider: col,
      range: opts.range || 1200, cooldown: 0, fireInterval: opts.fireInterval || 1.4,
      health: col ? col.health : 0, phase: this._rng() * 6.28, alive: true,
    };
    this._turrets.push(t);
    this._anchor('targets', t.id, t.position, 40);
    return t;
  }

  // ===========================================================================
  // 每帧更新（无分配）
  // ===========================================================================

  update(dt, time, camera) {
    if (!this._built) return;
    const d = clamp(isFinite(dt) ? dt : 0, 0, 0.1);
    const t = isFinite(time) ? time : 0;

    // 旋转件：雷达/风扇/螺旋桨/起重机（用绝对时间，暂停恢复后仍稳定）
    for (let i = 0; i < this._spinners.length; i++) {
      const s = this._spinners[i];
      if (!s.obj) continue;
      if (s.axis === 'y') s.obj.rotation.y = s.phase + t * s.speed;
      else if (s.axis === 'x') s.obj.rotation.x = s.phase + t * s.speed;
      else s.obj.rotation.z = s.phase + t * s.speed;
    }

    // 摆动件：抽油机横梁 / 风向袋 / 吊钩（正弦摆动，不会积累角度）
    for (let i = 0; i < this._swayers.length; i++) {
      const s = this._swayers[i];
      if (!s.obj) continue;
      const v = s.base + Math.sin(t * s.speed + s.phase) * s.amp;
      if (s.axis === 'x') s.obj.rotation.x = v;
      else if (s.axis === 'y') s.obj.rotation.y = v;
      else s.obj.rotation.z = v;
    }

    // 浮动件：船只/气球/浮空岛（同一物体的多个碰撞体共享一条 bobber）
    for (let i = 0; i < this._bobbers.length; i++) {
      const b = this._bobbers[i];
      const obj = b.obj;
      const y = b.baseY + Math.sin(t * b.speed + b.phase) * b.amp;
      if (obj) {
        obj.position.y = y;
        obj.rotation.z = Math.sin(t * b.speed * 0.8 + b.phase) * b.roll;
        obj.rotation.x = Math.sin(t * b.speed * 0.62 + b.phase * 1.7) * b.pitch;
      }
      const cl = b.colliders;
      if (cl) {
        for (let k = 0; k < cl.length; k++) {
          const c = cl[k].c;
          if (c && !c.destroyed) c.center.y = y + cl[k].off;
        }
      }
    }

    // 常驻火焰（钻井平台火炬 / 热气球燃烧器）
    for (let i = 0; i < this._flames.length; i++) {
      const f = this._flames[i];
      const flick = 0.78 + 0.28 * Math.sin(t * f.speed + f.phase) + 0.1 * Math.sin(t * f.speed * 4.3 + f.phase);
      if (f.mesh) f.mesh.scale.set(f.base * flick, f.base * 2.1 * flick, f.base * flick);
      if (f.mat) f.mat.opacity = 0.45 + 0.5 * flick;
    }

    // 圆环呼吸
    for (let i = 0; i < this._rings.length; i++) {
      const r = this._rings[i];
      if (!r.object) continue;
      const pulse = 1 + Math.sin(t * 2.1 + r.index * 0.55) * 0.025;
      r.object.scale.setScalar(pulse);
      if (r.material) {
        const base = r.passed ? 1.5 : 1.05;
        r.material.emissiveIntensity = base + Math.sin(t * 3.1 + r.index) * 0.22;
      }
    }

    // 收集物：自转 + 上下浮动；光晕呼吸
    for (let i = 0; i < this._collectibles.length; i++) {
      const c = this._collectibles[i];
      if (c.collected || !c.object) continue;
      c.object.rotation.y = t * 0.9 + c.phase;
      if (c.kind === 'coin') c.object.rotation.z = t * 1.6 + c.phase;
      const bob = Math.sin(t * 1.3 + c.phase) * 1.6;
      c.object.position.y = c.position.y + bob;
      if (c.glows) {
        c.glows.position.y = c.object.position.y;
        const s = (c.kind === 'craft' ? 22 : 26) * (0.92 + Math.sin(t * 2.4 + c.phase) * 0.08);
        c.glows.scale.setScalar(s);
      }
      if (c.collider && !c.collider.destroyed) c.collider.center.y = c.object.position.y;
    }

    // 残骸：火焰闪烁 + 落水/坠地沉降
    for (let i = 0; i < this._wrecks.length; i++) {
      const w = this._wrecks[i];
      w.life += d;
      if (w.fall) {
        w.vy -= 9.0 * d;
        w.group.position.y += w.vy * d;
        const floor = this.seaLevel - 3;
        if (w.group.position.y <= floor) {
          w.group.position.y = floor;
          w.vy = 0;
          w.fall = false;
          w.group.rotation.z = 0.5;
        }
      }
      const fl = w.flames;
      for (let k = 0; k < fl.length; k++) {
        const f = fl[k];
        const flick = 0.78 + 0.34 * Math.sin(t * f.speed + f.phase) + 0.12 * Math.sin(t * f.speed * 3.7 + f.phase);
        if (f.mesh) {
          f.mesh.scale.set(f.base * flick, f.base * 1.7 * flick, f.base * flick);
          if (f.mat) f.mat.opacity = 0.55 + 0.4 * flick;
        } else if (f.sprite) {
          f.sprite.scale.setScalar(f.base * (0.85 + flick * 0.3));
        }
      }
    }

    // 炮塔：死亡后停止；有相机时缓慢瞄准
    for (let i = 0; i < this._turrets.length; i++) {
      const tu = this._turrets[i];
      if (!tu.alive) continue;
      if (tu.collider && tu.collider.destroyed) { tu.alive = false; tu.head.visible = false; continue; }
      if (tu.cooldown > 0) tu.cooldown -= d;
      let targetYaw = Math.sin(t * 0.35 + tu.phase) * Math.PI * 0.8;
      let pitch = 0;
      if (camera && camera.position) {
        const dx = camera.position.x - tu.position.x;
        const dz = camera.position.z - tu.position.z;
        const dy = camera.position.y - tu.position.y;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < tu.range) {
          // 平滑转向目标（速度有限，别瞬移）
          const want = Math.atan2(dx, dz) + Math.PI;
          let diff = want - tu.head.rotation.y;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          targetYaw = tu.head.rotation.y + clamp(diff, -1.2 * d, 1.2 * d);
          pitch = clamp(Math.atan2(dy, Math.max(1, dist)), -0.25, 0.9);
        }
      }
      tu.head.rotation.y = targetYaw;
      if (tu.barrels) tu.barrels.rotation.x = -pitch;
    }

    // 共享信标材质整体呼吸（所有红色障碍灯同步闪，成本 O(1)）
    const blink = 0.5 + 0.5 * Math.sin(t * 3.4);
    if (this._mats.beaconRed) this._mats.beaconRed.emissiveIntensity = 0.35 + blink * 1.5;
    if (this._mats.beaconWhite) this._mats.beaconWhite.emissiveIntensity = 0.4 + (1 - blink) * 1.5;

    // 广告牌/灯柱朝向相机（廉价 billboard：只绕 Y 轴）
    if (camera && camera.position) {
      for (let i = 0; i < this._billboards.length; i++) {
        const b = this._billboards[i];
        if (!b.obj) continue;
        const dx = camera.position.x - b.obj.position.x;
        const dz = camera.position.z - b.obj.position.z;
        b.obj.rotation.y = Math.atan2(dx, dz) + (b.flip ? Math.PI : 0);
      }
    }
  }

  // ===========================================================================
  // 收尾 / 清理
  // ===========================================================================

  _addSpawnAnchors() {
    const t = this.terrain;
    const sp = t && t.spawnPoints;
    if (sp && sp.length) {
      for (let i = 0; i < sp.length; i++) {
        const s = sp[i];
        if (!s || !s.position) continue;
        this._anchor('landingPads', s.name || `spawn_${i}`, s.position, Math.max(60, (s.runwayLength || 400) * 0.35));
      }
    }
    if (!this._anchors.landingPads.length) {
      this._anchor('landingPads', 'main', this.root.position, 120);
    }
  }

  /** 兜底：任何 kit 都必须至少有 landingPads 与 checkpoints。 */
  _ensureMinimumAnchors() {
    if (!this._anchors.checkpoints.length) {
      const p = this._pois.length ? this._pois[0].position : new THREE.Vector3(0, this.seaLevel + 40, 0);
      this._anchor('checkpoints', 'center', p, 150);
    }
    if (!this._anchors.landingPads.length) {
      const p = this._pois.length ? this._pois[0].position : new THREE.Vector3(0, this.seaLevel + 5, 0);
      this._anchor('landingPads', 'center', p, 120);
    }
  }

  /** 释放几何/材质/贴图，并把 root 从场景移除。 */
  dispose() {
    if (this.root.parent) this.root.parent.remove(this.root);
    else if (this._scene && typeof this._scene.remove === 'function') this._scene.remove(this.root);

    this.root.traverse((o) => {
      if (o.geometry && typeof o.geometry.dispose === 'function') o.geometry.dispose();
      const m = o.material;
      if (Array.isArray(m)) for (const mm of m) { if (mm && mm.dispose) mm.dispose(); }
      else if (m && m.dispose) m.dispose();
      if (o.isInstancedMesh && typeof o.dispose === 'function') o.dispose();
    });
    for (const g of this._geoCache.values()) if (g && g.dispose) g.dispose();
    for (const m of this._matsOwned) if (m && m.dispose) m.dispose();
    this._matsOwned.length = 0;
    this._tex.dispose();
    this._geoCache.clear();
    this._mats = {};

    this._instanced.length = 0;
    this._spinners.length = 0;
    this._swayers.length = 0;
    this._bobbers.length = 0;
    this._flames.length = 0;
    this._glows.length = 0;
    this._billboards.length = 0;
    this._wrecks.length = 0;
    this._rings.length = 0;
    this._collectibles.length = 0;
    this._turrets.length = 0;
    this._colliders.length = 0;
    this._anchors = { cargo: [], dropzones: [], targets: [], checkpoints: [], landingPads: [] };
    this._noBuild.length = 0;
    this._pois.length = 0;
    this._bins = {};
    if (typeof this.root.clear === 'function') this.root.clear();
    this._ringCurve = null;
    this._built = false;
    this._scene = null;
    return this;
  }

  /**
   * 合并桶：把大量小装饰（屋顶设备/花坛/障碍灯）攒起来，
   * build() 结束时每种材质合并成一个 Mesh，显著减少 draw call。
   */
  _binAdd(key, geo) {
    if (!this._bins[key]) this._bins[key] = [];
    this._bins[key].push(geo);
  }

  _flushBins() {
    const mats = {
      roof: this._mats.roof,
      pave: this._mats.pavement,
      planter: this._mats.concrete,
      foliage: this._mats.treeLeaf,
      beacon: this._mats.beaconRed,
      metal: this._mats.metal,
    };
    for (const key of Object.keys(this._bins)) {
      const list = this._bins[key];
      if (!list || !list.length) continue;
      const m = this.mergedMesh(list, mats[key] || this._mats.concrete, 'bin_' + key);
      if (m) m.name = 'bin_' + key;
      list.length = 0;
    }
  }

  /** 惰性创建附加材质（保持 dispose 可追踪）。 */
  _mat(key, factory) {
    let m = this._mats[key];
    if (!m) {
      m = factory();
      this._mats[key] = m;
      this._matsOwned.push(m);
    }
    return m;
  }

  // ===========================================================================
  // 贴合地形的带状网格（道路 / 赛道 / 连接道）
  // ===========================================================================

  /**
   * 沿一串平面点生成带状网格，顶点高度取地形高度（可加 lift）。
   * @param {Array<Array<number>|{x:number,z:number}>} pts 平面点列（[x,z] 或 {x,z}）
   * @param {number} width 带宽（米）
   */
  ribbonGeometry(pts, width, opts = {}) {
    const n = pts.length;
    if (n < 2) return null;
    const closed = !!opts.closed;
    const lift = opts.lift !== undefined ? opts.lift : 0.15;
    const uvScale = opts.uvScale || 8;
    const half = width / 2;
    // 点可以是 [x,z] / [x,y,z] / {x,z} / {x,y,z}；带 y 时按 y 铺（山路/桥面）
    const P = pts.map((p) => {
      if (Array.isArray(p)) return p.length > 2 ? { x: p[0], y: p[1], z: p[2] } : { x: p[0], z: p[1] };
      return p;
    });
    const pos = [], uv = [], idx = [];
    let run = 0;
    for (let i = 0; i < n; i++) {
      const p = P[i];
      let pi = i - 1, ni = i + 1;
      if (pi < 0) pi = closed ? n - 1 : 0;
      if (ni >= n) ni = closed ? 0 : n - 1;
      const a = P[pi], b = P[ni];
      let dx = b.x - a.x, dz = b.z - a.z;
      const dl = Math.hypot(dx, dz) || 1;
      dx /= dl; dz /= dl;
      const nx = -dz, nz = dx;   // 左法线
      const y = p.y !== undefined ? p.y + lift
        : (opts.altitude !== undefined ? opts.altitude : this._heightAt(p.x, p.z) + lift);
      pos.push(p.x + nx * half, y, p.z + nz * half);
      pos.push(p.x - nx * half, y, p.z - nz * half);
      if (i > 0) run += Math.hypot(p.x - P[i - 1].x, p.z - P[i - 1].z);
      const v = run / uvScale;
      uv.push(0, v, 1, v);
    }
    // 顶面法线必须朝上：right -> next-left 的原始绕序是顺时针（-Y）。
    // 反转绕序，否则 MeshStandardMaterial 的 FrontSide 会从上方把道路整片剔除。
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    if (closed) {
      const a = (n - 1) * 2;
      idx.push(a, 0, a + 1, a + 1, 0, 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /** 生成一条带状路面（含可选中央虚线）。 */
  ribbon(pts, width, material, opts = {}) {
    const g = this.ribbonGeometry(pts, width, opts);
    if (!g) return null;
    const m = new THREE.Mesh(g, material);
    m.name = opts.name || 'ribbon';
    this.root.add(m);
    this._stats.roads++;
    if (opts.centerLine) {
      const dg = this.ribbonGeometry(pts, opts.centerWidth || 0.4, Object.assign({}, opts, {
        lift: (opts.lift !== undefined ? opts.lift : 0.15) + 0.03, uvScale: opts.dashScale || 6,
      }));
      if (dg) {
        const dashTex = this._tex.get('dash', 16, 64, (ctx, w, h) => {
          ctx.clearRect(0, 0, w, h);
          ctx.fillStyle = '#e8ecef';
          ctx.fillRect(0, 6, w, 30);
        }, { clamp: false });
        const dm = new THREE.Mesh(dg, this._mat('roadDash', () => new THREE.MeshStandardMaterial({
          map: dashTex, color: 0xffffff, roughness: 0.7, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide,
        })));
        dm.name = (opts.name || 'road') + '_dash';
        this.root.add(dm);
      }
    }
    return m;
  }

  /**
   * 把若干几何合并成一个 Mesh（减少 draw call）。
   * @param {THREE.Object3D} [parent] 默认挂在 this.root；给船只等局部坐标时传组
   */
  mergedMesh(geos, material, name = 'merged', parent) {
    const list = geos.filter(Boolean);
    if (!list.length) return null;
    const g = mergeGeos(list);
    for (const gg of list) {
      const src = gg && gg.geo ? gg.geo : gg;
      if (src && typeof src.dispose === 'function') src.dispose();
    }
    const m = new THREE.Mesh(g, material);
    m.name = name;
    (parent || this.root).add(m);
    return m;
  }

  // ===========================================================================
  // 机场（跑道 / 停机坪 / 机库 / 塔台 / 风向袋 / 油罐）
  // ===========================================================================

  /**
   * 为大型机场选址：足迹内起伏最小、尽量不占水面。
   * 候选 = 地形平整区(spawnPoints) + 目标点周围的随机点；
   * 评分 = 足迹落差 + 水面占比惩罚（平整区天然平，优先命中）。
   */
  _findAirportSpot(cx, cz, len, halfW, opts = {}) {
    const backW = opts.backW !== undefined ? opts.backW : 140;
    const cand = [];
    const t = this.terrain;
    if (t && t.spawnPoints) {
      for (let i = 0; i < t.spawnPoints.length; i++) {
        const sp = t.spawnPoints[i];
        if (!sp || !sp.position || sp.name === 'sea') continue;
        cand.push({ x: sp.position.x, z: sp.position.z });
      }
    }
    const searchR = opts.searchR || 3200;
    for (let i = 0; i < 22; i++) {
      const a = this._rng() * Math.PI * 2;
      const d = Math.sqrt(this._rng()) * searchR;
      cand.push({ x: cx + Math.cos(a) * d, z: cz + Math.sin(a) * d });
    }
    let best = null;
    for (const c of cand) {
      if (this._isReserved(c.x, c.z)) continue;
      let lo = Infinity, hi = -Infinity, wet = 0, n = 0;
      for (let o = 0; o < 2; o++) {
        for (let fi = 0; fi <= 8; fi++) {
          const f = (fi / 8 - 0.5) * len;
          for (let ri = -3; ri <= 3; ri++) {
            const r = -backW + ((ri + 3) / 6) * (halfW + backW);   // 非对称：另一侧只留窄边
            const px = o === 0 ? c.x + f : c.x + r;
            const pz = o === 0 ? c.z + r : c.z + f;
            const h = this._heightAt(px, pz);
            if (h < lo) lo = h;
            if (h > hi) hi = h;
            if (this._isWater(px, pz)) wet++;
            n++;
          }
        }
      }
      const relief = hi - lo;
      const score = relief + (wet / Math.max(1, n)) * 350;   // 平 + 尽量干燥
      if (!best || score < best.score) {
        // 安全余量：采样网格之间的地形可能更高，抬一点避免结构被埋
        best = {
          score, x: c.x, z: c.z, y: hi + clamp(relief * 0.12, 3, 30),
          relief, lo, wet: wet / Math.max(1, n), rough: relief,
        };
      }
    }
    if (!best) {
      const y = Math.max(this._heightAt(cx, cz), this.seaLevel);
      best = { score: 1e9, x: cx, z: cz, y, relief: 0, lo: y, wet: 0, rough: 99 };
    }
    return best;
  }

  /**
   * 机场放坡裙边：从底板边缘（slabTop）向外下坡接回地形，
   * 让高原式机场看起来像人工平整出来的路堤/削坡，而不是悬空的板子。
   */
  _buildSlabSkirt(x, z, ry, halfLen, halfWid, slabTop, run, material, name) {
    const cos = Math.cos(ry), sin = Math.sin(ry);
    const L2W = (lx, lz) => ({ x: x + lx * cos + lz * sin, z: z - lx * sin + lz * cos });
    // 周长采样点（矩形四边）
    const step = 70;
    const per = [];
    const nx = Math.max(2, Math.round((halfLen * 2) / step));
    const nz = Math.max(2, Math.round((halfWid * 2) / step));
    for (let i = 0; i <= nx; i++) per.push([-halfLen + (i / nx) * halfLen * 2, -halfWid]);
    for (let i = 0; i <= nz; i++) per.push([halfLen, -halfWid + (i / nz) * halfWid * 2]);
    for (let i = 0; i <= nx; i++) per.push([halfLen - (i / nx) * halfLen * 2, halfWid]);
    for (let i = 0; i <= nz; i++) per.push([-halfLen, halfWid - (i / nz) * halfWid * 2]);
    const pos = [], uv = [], idx = [];
    let run2 = 0;
    for (let i = 0; i < per.length; i++) {
      const p = per[i];
      const inner = L2W(p[0], p[1]);
      const nx2 = Math.abs(p[0]) > halfLen - 0.01 ? Math.sign(p[0]) : 0;
      const nz2 = Math.abs(p[1]) > halfWid - 0.01 ? Math.sign(p[1]) : 0;
      const outX = p[0] + nx2 * run, outZ = p[1] + nz2 * run;
      const outer = L2W(outX, outZ);
      const oy = Math.max(this._heightAt(outer.x, outer.z), this.seaLevel - 1);
      pos.push(inner.x, slabTop, inner.z, outer.x, oy, outer.z);
      if (i > 0) run2 += Math.hypot(p[0] - per[i - 1][0], p[1] - per[i - 1][1]);
      uv.push(0, run2 / 14, 1, run2 / 14);
    }
    for (let i = 0; i < per.length - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, material);
    m.name = name || 'runway_skirt';
    this.root.add(m);
    return m;
  }

  /**
   * 出生跑道专用：在“锚点必须落在跑道上”的前提下微调跑道中心，
   * 让尽量少的地形埋住跑道（出生点高度是固定的，不能随意抬高）。
   */
  _levelRunwayAround(ax, az, len, wid, heading, keepY) {
    const sin = Math.sin(heading), cos = Math.cos(heading);
    let best = null;
    for (let ox = -2; ox <= 2; ox++) {
      for (let oz = -2; oz <= 2; oz++) {
        const dx = ox * 280, dz = oz * 280;
        if (Math.hypot(dx, dz) > len / 2 - 150) continue;      // 锚点必须还在跑道上
        const cx2 = ax + dx, cz2 = az + dz;
        let hi = -Infinity, lo = Infinity;
        for (let i = 0; i <= 32; i++) {
          const f = (i / 32 - 0.5) * len;
          for (const rr of [-wid, 0, wid]) {
            const px = cx2 - f * sin + rr * cos;
            const pz = cz2 - f * cos - rr * sin;
            const h = this._heightAt(px, pz);
            if (h > hi) hi = h;
            if (h < lo) lo = h;
          }
        }
        const poke = Math.max(0, hi - keepY);                  // 埋进山体的量
        const float2 = Math.max(0, keepY - lo);                // 悬空量（不美观但可接受）
        const score = poke + float2 * 0.25;
        if (!best || score < best.score) {
          best = { score, x: cx2, z: cz2, hi, lo, poke, float: float2 };
        }
      }
    }
    return best || { score: 0, x: ax, z: az, hi: keepY, lo: keepY, poke: 0, float: 0 };
  }

  /**
   * 建一座机场。
   * @param {number} x @param {number} z @param {number} heading 跑道朝向（弧度，0 = -Z）
   */
  buildAirport(x, z, heading, opts = {}) {
    const len = opts.length || 1100;
    const wid = opts.width || 45;
    const ry = heading || 0;
    const sin = Math.sin(ry), cos = Math.cos(ry);
    // 本地(前向 f, 右向 r) -> 世界
    const W = (f, r) => ({ x: x - f * sin + r * cos, z: z - f * cos - r * sin });
    let baseY = opts.y !== undefined ? opts.y : this._heightAt(x, z);
    let slabH = opts.slabThickness || 4.5;
    let skirtRun = 0;
    const apronW0 = opts.apron || 240;
    if (opts.autoLevel) {
      // 超长跑道：以“跑道 + 停机坪 + 航站楼 + 停车场”足迹内的最高点为基准
      // （跑道永不被地形穿透），底板做薄，四周用放坡裙边接回地形
      const reach = wid / 2 + (opts.parking ? apronW0 + 230 : (apronW0 + 80));
      let lo = Infinity, hi = -Infinity;
      const fSteps = 76, rSteps = 9;
      for (let o = 0; o < 2; o++) {
        for (let i = 0; i <= fSteps; i++) {
          const f = (i / fSteps - 0.5) * len;
          for (let k = -rSteps; k <= rSteps; k++) {
            const r = -wid + ((k + rSteps) / (2 * rSteps)) * (reach + wid);  // 非对称：另一侧只留一点余量
            const px = o === 0 ? x - f * sin + r * cos : x - f * cos - r * sin;
            const pz = o === 0 ? z - f * cos - r * sin : z + f * sin + r * cos;
            const hh = this._heightAt(px, pz);
            if (hh < lo) lo = hh;
            if (hh > hi) hi = hh;
          }
        }
      }
      if (opts.y === undefined) baseY = hi + 8;      // 采样点之间的地形凸起余量（地形网格 60m）
      slabH = opts.slabThickness || 8;
      skirtRun = clamp((hi - lo) * 1.7, 70, 520);
    } else if (opts.skirt) {
      // 不改变跑道高度（例如出生点跑道），只做放坡/削坡让边缘自然衔接地形
      let lo = Infinity, hi = -Infinity;
      const reach0 = wid / 2 + apronW0 + 40;
      for (let i = 0; i <= 8; i++) {
        const f = (i / 8 - 0.5) * len;
        for (let k = -2; k <= 2; k++) {
          const r = (k / 2) * reach0;
          const px = x - f * sin + r * cos;
          const pz = z - f * cos - r * sin;
          const hh = this._heightAt(px, pz);
          if (hh < lo) lo = hh;
          if (hh > hi) hi = hh;
        }
      }
      skirtRun = clamp((hi - lo) * 1.7, 60, 420);
    }
    const slabTop = baseY + 0.35;
    const name = opts.name || 'Airport';
    this._reserve(x, z, Math.max(len, 700) * 0.75);

    // 跑道底座（把地形垫平）+ 停机坪底板
    const slab = this.box(wid + 46, slabH, len + 60, this._mats.concrete, x, slabTop - slabH / 2, z, { ry });
    slab.name = 'runway_slab';
    this.addBoxCollider('runway', x, slab.position.y, z, (wid + 46) / 2, slabH / 2, (len + 60) / 2, {
      object: slab, static: true, name: name + ' runway', heading: ry, oriented: true,
      surfaceY: slabTop + 0.04,
    });

    // 沥青跑道面
    const rGeo = new THREE.PlaneGeometry(len, wid);
    rGeo.rotateX(-Math.PI / 2);
    rGeo.rotateY(Math.PI / 2);
    const rMat = this._mat('runway' + Math.round(len), () => new THREE.MeshStandardMaterial({
      map: this._tex.runway(len, wid, opts.label || '27'), color: 0xffffff, roughness: 0.9, metalness: 0.03,
    }));
    const rw = new THREE.Mesh(rGeo, rMat);
    rw.position.set(x, slabTop + 0.04, z);
    rw.rotation.y = ry;
    rw.name = 'runway';
    this.root.add(rw);
    this._stats.roads++;

    // 停机坪（与跑道相邻，朝右舷展开）
    const apronW = opts.apron || 240;
    const apronC = W(0, wid / 2 + apronW / 2);
    const apron = this.box(apronW, slabH, len * 0.62, this._mats.asphalt, apronC.x, slabTop - slabH / 2, apronC.z, { ry });
    apron.name = 'apron';
    this.addBoxCollider('runway', apronC.x, apron.position.y, apronC.z, apronW / 2, slabH / 2, len * 0.31, {
      object: apron, static: true, name: name + ' apron', heading: ry, oriented: true,
      surfaceY: slabTop,
    });
    // 停机位黄线（先按 heading 旋转再平移到世界坐标，避免整体旋转导致漂移）
    const gateGeos = [];
    for (let i = 0; i < 5; i++) {
      const f = -len * 0.24 + i * (len * 0.12);
      const p = W(f, wid / 2 + apronW * 0.55);
      for (const side of [-1, 1]) {
        const g2 = new THREE.BoxGeometry(1.2, 0.06, 34);
        g2.applyMatrix4(mat4(0, 0, 0, 0, ry, 0));
        g2.translate(p.x + side * 12 * cos, slabTop + 0.1, p.z - side * 12 * sin);
        gateGeos.push(g2);
      }
      const g3 = new THREE.BoxGeometry(25, 0.06, 1.2);
      g3.applyMatrix4(mat4(0, 0, 0, 0, ry, 0));
      g3.translate(p.x, slabTop + 0.1, p.z);
      gateGeos.push(g3);
    }
    this.mergedMesh(gateGeos, this._mats.paintYellow, 'apron_gates');

    // 机库 ×3
    for (let i = 0; i < 3; i++) {
      const f = -len * 0.3 + i * (len * 0.3);
      const p = W(f, wid / 2 + apronW * 0.92);
      this.buildHangar(p.x, slabTop, p.z, 62, 15, 52, ry);
    }
    // 塔台
    const tp = W(-len * 0.42, wid / 2 + apronW * 0.5);
    this.buildControlTower(tp.x, slabTop, tp.z, 40, ry);
    // 风向袋（会随风向缓慢转动）
    const wp = W(len * 0.44, wid / 2 + 26);
    this.buildWindsock(wp.x, slabTop, wp.z);
    // 油罐
    let fp = W(opts.terminal ? len * 0.34 : -len * 0.05, wid / 2 + apronW + (opts.terminal ? 250 : 40));
    for (let k = 0; k < 8 && this._isWater(fp.x, fp.z); k++) {
      fp = W(opts.terminal ? len * 0.34 : -len * 0.05, wid / 2 + apronW + (opts.terminal ? 250 : 40) - k * 26);
    }
    for (let i = 0; i < 3; i++) {
      const px = fp.x + Math.cos(ry) * (i * 22 - 22);
      const pz = fp.z - Math.sin(ry) * (i * 22 - 22);
      const tank = this.cyl(9, 9, 14, this._mats.metal, px, slabTop + 7, pz, { seg: 14 });
      tank.name = 'fuel_tank';
      this.sphere(9, this._mats.metalDark, px, slabTop + 14, pz, { sy: 0.35 });
      this.addSphereCollider('prop', px, slabTop + 7, pz, 9.5, {
        destructible: true, health: 500, mass: 6000, name: name + ' fuel tank', object: tank,
      });
    }
    // 集装箱 + 补给箱（可摧毁）
    for (let i = 0; i < 4; i++) {
      const f = W(len * 0.35 + i * 9 - 12, wid / 2 + apronW * 0.25);
      this.buildCrate(f.x, slabTop, f.z, this._rng() * 0.6);
    }

    // 放坡裙边（高原机场：把底板四周接回地形；也覆盖停机坪/停车场一侧）
    if ((opts.autoLevel || opts.skirt) && skirtRun > 0) {
      const skirtW = wid / 2 + apronW0 + (opts.parking ? 260 : 40);
      this._buildSlabSkirt(x, z, ry, (len + 60) / 2, skirtW, slabTop, skirtRun,
        this._mat('slabSkirt', () => new THREE.MeshStandardMaterial({
          map: this._tex.sand(), color: 0x8f8676, roughness: 0.98, metalness: 0.02,
          side: THREE.DoubleSide,                // 削坡/填方两个方向都要可见
        })), name + ' skirt');
    }
    // 滑行道
    if (opts.taxiway) {
      this.buildTaxiway(x, z, ry, { length: len * 0.9, y: slabTop, runwayWidth: wid, offset: 52 });
    }
    // 航站楼 + 廊桥 + 停车场（大型民用机场）
    if (opts.terminal) {
      const tLong = Math.min(280, len * 0.24);
      const tDepth = 48;
      // 航站楼紧贴停机坪外沿：局部 X 沿跑道方向（ry + 90°），深度朝停机坪
      const tc = W(0, wid / 2 + apronW + tDepth / 2 + 6);
      this.buildTerminal(tc.x, slabTop, tc.z, ry + Math.PI / 2, {
        length: tLong, depth: tDepth, height: 22,
      });
      // 廊桥：从航站楼近侧朝停机坪伸出（局部 +Z 指向 -r 方向）
      const nBridge = opts.gates || 4;
      const bridgeRy = ry - Math.PI / 2;
      for (let i = 0; i < nBridge; i++) {
        const f = -tLong * 0.3 + i * (tLong * 0.6 / Math.max(1, nBridge - 1));
        const bp = W(f, wid / 2 + apronW + 4);
        this.buildJetBridge(bp.x, slabTop, bp.z, bridgeRy, 34, {});
      }
      this._anchor('cargo', name + ' terminal', { x: tc.x, y: slabTop + 2, z: tc.z }, 80);
    }
    if (opts.parking) {
      // 停在航站楼侧面（沿跑道方向偏移）；外侧若是海/坡就向跑道方向收一点
      let pc = W(-len * 0.42, wid / 2 + apronW + 130);
      for (let k = 0; k < 6 && this._isWater(pc.x, pc.z); k++) {
        pc = W(-len * 0.42, wid / 2 + apronW + 130 - k * 22);
      }
      const py = Math.max(this._heightAt(pc.x, pc.z), slabTop - 1.5);
      this.buildParkingLot(pc.x, pc.z, ry, { width: 168, depth: 108, y: py });
      // 停车场联络路（接主路网）
      this.buildRoadRoute([
        [pc.x, pc.z],
        [(pc.x + x) / 2, (pc.z + z) / 2],
        [x, z],
      ], 18, { name: 'airport_access', step: 60 });
    }

    // 锚点
    const a = W(-len * 0.36, 0), b = W(len * 0.36, 0);
    this._anchor('landingPads', name + ' threshold 09', { x: a.x, y: slabTop + 1, z: a.z }, 60);
    this._anchor('landingPads', name + ' threshold 27', { x: b.x, y: slabTop + 1, z: b.z }, 60);
    this._anchor('landingPads', name + ' apron', { x: apronC.x, y: slabTop + 1, z: apronC.z }, 90);
    this._anchor('dropzones', name + ' runway', { x, y: slabTop + 2, z }, 120);
    this._anchor('cargo', name + ' apron cargo', { x: apronC.x, y: slabTop + 2, z: apronC.z }, 80);
    this._poi(name, x, slabTop + 6, z, 'airport', 260);
    return { x, z, y: slabTop, heading: ry, length: len, width: wid };
  }

  buildHangar(x, y, z, w, h, len, ry = 0) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.rotation.y = ry;
    this.root.add(g);
    const wall = this.mesh(this._G('unitBox'), this._mats.metalDark, 0, h / 2, 0, { sx: w, sy: h, sz: len, parent: g });
    wall.name = 'hangar';
    // 拱形屋顶（半圆柱，轴向 Z）
    const arch = this._G('harch', () => {
      const geo = new THREE.CylinderGeometry(1, 1, 1, 14, 1, false, 0, Math.PI);
      geo.rotateZ(Math.PI / 2);
      geo.rotateY(Math.PI / 2);
      return geo;
    });
    const roof = this.mesh(arch, this._mats.metal, 0, h, 0, { sx: w / 2, sy: len, sz: w / 2, parent: g });
    roof.name = 'hangar_roof';
    // 门（深色）
    const door = this.mesh(this._G('unitPlane'), this._mats.wreck, 0, h * 0.42, -len / 2 - 0.05, {
      sx: w * 0.72, sy: h * 0.8, parent: g,
    });
    door.name = 'hangar_door';
    this._stats.buildings++;
    this.addBoxCollider('hangar', x, y + h * 0.62, z, w / 2, h * 0.62 + w * 0.2, len / 2, {
      destructible: true, health: 900, mass: 9000, name: 'Hangar', object: wall, heading: ry, oriented: true,
    });
    return g;
  }

  buildControlTower(x, y, z, h = 38, ry = 0) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    this.root.add(g);
    const shaft = this.mesh(this._G('unitCyl'), this._mats.concrete, 0, h / 2, 0, { sx: 4.2, sy: h, sz: 4.2, parent: g });
    shaft.name = 'tower_shaft';
    const cabin = this.mesh(this._G('unitCyl'), this._mats.glassNeon, 0, h + 3.2, 0, { sx: 7.4, sy: 6, sz: 7.4, parent: g });
    cabin.name = 'tower_cabin';
    this.mesh(this._G('unitCyl6'), this._mats.metalDark, 0, h + 7, 0, { sx: 8, sy: 1.4, sz: 8, parent: g });
    const mast = this.cyl(0.32, 0.32, 12, this._mats.metal, 0, h + 13, 0, { parent: g, seg: 6 });
    mast.name = 'tower_mast';
    const rot = this.group(0, h + 15, 0, g);
    const bar = this.mesh(this._G('unitBox'), this._mats.metal, 0, 0, 0, { sx: 7, sy: 0.4, sz: 0.4, parent: rot });
    bar.name = 'radar_bar';
    this._spinners.push({ obj: rot, axis: 'y', speed: 0.9, phase: 0 });
    this.sphere(1.1, this._mats.beaconRed, 0, h + 19.5, 0, { parent: g });
    this._stats.buildings++;
    this.addBoxCollider('tower', x, y + h * 0.6, z, 4.6, h * 0.6 + 2, 4.6, {
      destructible: true, health: 700, mass: 7000, name: 'Control tower', object: shaft,
    });
    return g;
  }

  buildWindsock(x, y, z) {
    const g = this.group(x, y, z);
    g.name = 'windsock';
    const pole = this.cyl(0.22, 0.28, 12, this._mats.metal, 0, 6, 0, { parent: g, seg: 6 });
    pole.name = 'windsock_pole';
    const pivot = this.group(0, 11.4, 0, g);
    const sock = this.cone(1.5, 4.6, this._mat('sock', () => new THREE.MeshStandardMaterial({
      color: 0xff7b2b, roughness: 0.85, side: THREE.DoubleSide,
    })), 0, 0, -2.4, { parent: pivot, seg: 8 });
    sock.rotation.x = -Math.PI / 2;
    sock.name = 'windsock_cone';
    this._spinners.push({ obj: pivot, axis: 'y', speed: 0.12, phase: 1.2 });
    this.addSphereCollider('prop', x, y + 6, z, 0.6, { destructible: false, name: 'Windsock', object: pole });
    return g;
  }

  /** 补给箱（可摧毁的小型碰撞体）。 */
  buildCrate(x, y, z, ry = 0) {
    const m = this.box(3.4, 3.4, 3.4, this._mat('crate', () => new THREE.MeshStandardMaterial({
      map: this._tex.container(), color: 0xb98a4b, roughness: 0.85, metalness: 0.15,
    })), x, y + 1.7, z, { ry });
    m.name = 'crate';
    this.addBoxCollider('prop', x, y + 1.7, z, 1.8, 1.8, 1.8, {
      destructible: true, health: 60, mass: 400, name: 'Cargo crate', object: m,
    });
    return m;
  }

  // ===========================================================================
  // 城市
  // ===========================================================================

  /**
   * 单栋高楼：写实比例 + 亮窗自发光 + 屋顶设备 + 障碍灯。
   * @returns {THREE.Mesh} 主体
   */
  buildTower(x, z, w, d, h, styleIdx, opts = {}) {
    const baseY = opts.baseY !== undefined ? opts.baseY : this._heightAt(x, z) - 1.5;
    const geo = new THREE.BoxGeometry(w, h, d);
    scaleBoxUV(geo, w, h, d, opts.windowTile || 3.2);
    const mat = this._mats.buildings[(styleIdx + (opts.styleOffset || 0)) % this._mats.buildings.length];
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, baseY + h / 2, z);
    m.rotation.y = (this._rng() - 0.5) * 0.08;
    m.name = 'building';
    this.root.add(m);

    // 屋顶板 + 女儿墙 + 设备 + 障碍灯：全部塞进合并桶，最后每种材质只画一个 Mesh
    const topY = baseY + h;
    this._binAdd('roof', new THREE.BoxGeometry(w, 1.2, d).translate(x, topY + 0.6, z));
    this._binAdd('roof', new THREE.BoxGeometry(w + 0.6, 2.0, d + 0.6).translate(x, topY + 1.6, z));
    if (h > 30) {
      const cnt = 1 + Math.floor(this._rng() * 3);
      for (let i = 0; i < cnt; i++) {
        const bw = 1.6 + this._rng() * 3.2;
        this._binAdd('roof', new THREE.BoxGeometry(bw, bw * 0.8, bw * 0.8).translate(
          x + (this._rng() - 0.5) * (w - bw - 1), topY + 1.4 + bw * 0.4, z + (this._rng() - 0.5) * (d - bw - 1)));
      }
      if (h > 70 && this._rng() < 0.7) {
        const ah = 6 + this._rng() * 10;
        this._binAdd('roof', new THREE.CylinderGeometry(0.24, 0.34, ah, 5).translate(x, topY + ah / 2 + 1.6, z));
        this._binAdd('beacon', new THREE.SphereGeometry(0.9, 8, 6).translate(x, topY + ah + 2, z));
      }
    }
    this._stats.buildings++;
    const col = this.addBoxCollider('building', x, baseY + h / 2, z, w / 2 * 1.06, h / 2, d / 2 * 1.06, {
      destructible: true, health: 400 + h * 12, mass: w * d * h * 0.32,
      name: (opts.name || 'Building') + ' ' + Math.round(h) + 'm', object: m,
      isBox: true,
    });
    if (opts.anchor) this._poi(opts.name || 'Rooftop', x, baseY + h + 2, z, 'rooftop', 40);
    return m;
  }

  /**
   * 建一片城市（网格街区 + 高楼 + 路灯 + 停车 + 霓虹）。
   * @param {number} cx @param {number} cz @param {number} radius 半径（米）
   */
  buildCity(cx, cz, radius, opts = {}) {
    const rng = this._rng;
    const block = opts.block || 128;         // 街区尺寸
    const street = opts.street || 30;        // 街道宽
    const cell = block + street;
    const minH = opts.minHeight || 34;
    const maxH = opts.maxHeight || 180;
    const baseY = opts.baseY !== undefined ? opts.baseY : this._heightAt(cx, cz);
    this._reserve(cx, cz, radius + 40);

    const half = Math.max(1, Math.round(radius / cell));
    const streetGeos = [];
    const paveGeos = [];

    // 街道：整个城区拉通的长条（贴合地形）
    for (let i = -half; i <= half; i++) {
      const off = i * cell;
      // 沿 Z 向街道
      const ptsZ = [];
      for (let k = -half; k <= half; k += 1) ptsZ.push([cx + off, cz + k * cell * 0.5]);
      streetGeos.push(this.ribbonGeometry(ptsZ, street, { lift: 0.12, uvScale: 9 }));
      // 沿 X 向街道
      const ptsX = [];
      for (let k = -half; k <= half; k += 1) ptsX.push([cx + k * cell * 0.5, cz + off]);
      streetGeos.push(this.ribbonGeometry(ptsX, street, { lift: 0.12, uvScale: 9 }));
    }
    this.mergedMesh(streetGeos, this._mats.asphalt, 'city_streets');

    // 中央虚线（沿两条主轴，省 draw call）
    const dashMat = this._mat('roadDash', () => new THREE.MeshStandardMaterial({
      map: this._tex.get('dash', 16, 64, (ctx, w, h) => {
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#e8ecef'; ctx.fillRect(0, 6, w, 30);
      }, { clamp: false }),
      color: 0xffffff, roughness: 0.7, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide,
    }));
    const dashGeos = [];
    for (let i = -half; i <= half; i++) {
      const off = i * cell;
      const pz = [], px = [];
      for (let k = -half; k <= half; k += 0.5) {
        pz.push([cx + off, cz + k * cell * 0.5]);
        px.push([cx + k * cell * 0.5, cz + off]);
      }
      dashGeos.push(this.ribbonGeometry(pz, 0.42, { lift: 0.2, uvScale: 6 }));
      dashGeos.push(this.ribbonGeometry(px, 0.42, { lift: 0.2, uvScale: 6 }));
    }
    this.mergedMesh(dashGeos, dashMat, 'city_dash');

    // 人行道（街区四周的浅色边条）
    for (let ix = -half; ix <= half; ix++) {
      for (let iz = -half; iz <= half; iz++) {
        const bx = cx + ix * cell, bz = cz + iz * cell;
        const dist = Math.hypot(bx - cx, bz - cz);
        if (dist > radius) continue;
        const y = this._heightAt(bx, bz);
        paveGeos.push(new THREE.BoxGeometry(block, 0.5, block).translate(bx, y + 0.3, bz));
      }
    }
    this.mergedMesh(paveGeos, this._mats.pavement, 'city_sidewalk');

    // 楼房：每个街区 1~4 栋，靠近中心越高
    const towerList = [];
    for (let ix = -half; ix <= half; ix++) {
      for (let iz = -half; iz <= half; iz++) {
        const bx = cx + ix * cell, bz = cz + iz * cell;
        const dist = Math.hypot(bx - cx, bz - cz);
        if (dist > radius) continue;
        const y = this._heightAt(bx, bz);
        const cityness = 1 - clamp(dist / (radius + 1), 0, 1);
        const n = rng() < 0.22 ? 0 : (rng() < 0.55 ? 1 : (rng() < 0.8 ? 2 : 3));
        if (n === 0) {
          // 广场/公园
          if (rng() < 0.5) this._plaza(bx, bz, y, block * 0.6);
          continue;
        }
        for (let k = 0; k < n; k++) {
          const t = clamp(cityness * (0.5 + rng() * 0.9), 0, 1);
          const h = lerp(minH, maxH, t * t) * (0.7 + rng() * 0.6);
          const w = block * (0.24 + rng() * 0.2);
          const d = block * (0.24 + rng() * 0.2);
          const ox = (rng() - 0.5) * (block - w - 8);
          const oz = (rng() - 0.5) * (block - d - 8);
          const style = (ix + iz + k + 8) % 4;
          this.buildTower(bx + ox, bz + oz, w, d, h, style, { baseY: y - 1.5, name: opts.towerName || 'Tower' });
          towerList.push({ x: bx + ox, z: bz + oz, w, d, h, top: y - 1.5 + h });
        }
      }
    }
    this._towers = towerList;
    this._stats.towers = (this._stats.towers || 0) + towerList.length;

    // 路灯（实例化，最多 ~220 根）
    const lampPts = [];
    for (let i = -half; i <= half; i++) {
      for (let k = -half; k <= half; k += 0.5) {
        lampPts.push([cx + i * cell + street * 0.42, cz + k * cell * 0.5]);
        lampPts.push([cx + k * cell * 0.5, cz + i * cell + street * 0.42]);
      }
    }
    this.buildStreetlights(lampPts, 1, 26);

    // 停车（实例化小车）
    this.buildParkedCars(lampPts, Math.round(90 * this.density), 22);

    // 霓虹招牌（挂在高楼上）+ 少量广告牌朝向相机
    const neonNames = Object.keys(this._mats.neon);
    for (let i = 0; i < Math.min(6, neonNames.length); i++) {
      const a = (i / 6) * Math.PI * 2 + rng();
      const r = radius * (0.3 + rng() * 0.5);
      const nx = cx + Math.cos(a) * r, nz = cz + Math.sin(a) * r;
      const ny = this._heightAt(nx, nz) + 40 + rng() * 90;
      this.buildNeonSign(nx, ny, nz, neonNames[i], 1);
    }
    // 城区氛围灯（最多 2 盏，远距离小强度）
    if (this._lights < 3) {
      const warm = new THREE.PointLight(0xffb066, 900, radius * 1.4, 2);
      warm.position.set(cx, baseY + 90, cz);
      this.addLight(warm);
    }
    if (this._lights < 3 && radius > 400) {
      const cool = new THREE.PointLight(0x66d8ff, 900, radius * 1.4, 2);
      cool.position.set(cx + radius * 0.5, baseY + 120, cz - radius * 0.4);
      this.addLight(cool);
    }
    this._anchor('dropzones', 'city plaza', { x: cx, y: baseY + 4, z: cz }, 140);
    this._poi('City center', cx, baseY + 20, cz, 'city', radius * 0.9);
    return { x: cx, z: cz, baseY, radius, towers: towerList };
  }

  _plaza(x, z, y, size) {
    this._binAdd('pave', new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2).translate(x, y + 0.45, z));
    // 花坛（合并）+ 花坛绿植
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const px = x + Math.cos(a) * size * 0.32, pz = z + Math.sin(a) * size * 0.32;
      this._binAdd('planter', new THREE.CylinderGeometry(1, 1, 1, 6)
        .scale(size * 0.16, 1.4, size * 0.16).translate(px, y + 1.1, pz));
      this._binAdd('foliage', { geo: new THREE.IcosahedronGeometry(size * 0.09, 0).translate(px, y + 3.2, pz), color: 0x3d6b33 });
    }
  }

  /** 霓虹招牌（自发光；可选 billboard 朝向相机，可挂到任意父节点）。 */
  buildNeonSign(x, y, z, text, scale = 1, opts = {}) {
    const mat = this._mats.neon[text] || this._mats.neon.HOTEL;
    if (!mat) return null;
    const w = (opts.width || 22) * scale;
    const h = (opts.height || 6) * scale;
    const m = this.mesh(this._G('unitPlane'), mat, x, y, z, {
      sx: w, sy: h, ry: opts.ry || 0, rx: opts.rx || 0, parent: opts.parent,
    });
    m.name = 'neon_' + text;
    if (opts.billboard) this._billboards.push({ obj: m, flip: !!opts.flip });
    // 支架
    if (opts.frame) {
      this.box(w * 1.04, h * 1.1, 0.5, this._mats.metalDark, x, y, z,
        { ry: opts.ry || 0, parent: opts.parent });
    }
    return m;
  }

  /**
   * 实例化路灯：灯杆 + 自发光灯头。沿给定点列按步长取样，均匀铺开。
   * @param {Array} points 候选点（[x,z] 或 {x,z}）
   * @param {number} spacing 取样密度（>=1，越大越稀）
   * @param {number} maxCount 上限
   * @param {boolean} [cool] 用冷白光（雪原/高空）
   */
  buildStreetlights(points, spacing = 1, maxCount = 220, cool = false) {
    if (!points.length) return null;
    const stride = Math.max(Math.round(spacing), Math.ceil(points.length / Math.max(1, maxCount)));
    const chosen = [];
    for (let i = 0; i < points.length && chosen.length < maxCount; i += stride) {
      const p = points[i];
      const px = Array.isArray(p) ? p[0] : p.x;
      const pz = Array.isArray(p) ? p[1] : p.z;
      if (this._isWater(px, pz)) continue;
      chosen.push({ x: px, z: pz, y: this._heightAt(px, pz) });
    }
    if (!chosen.length) return null;
    const poles = this.instance('streetlight', this._mats.treeLeaf, chosen.length, { name: 'streetlights' });
    const glow = this.instance('unitBox', cool ? this._mats.lampGlowCool : this._mats.lampGlow, chosen.length,
      { name: 'streetlight_glow' });
    for (let i = 0; i < chosen.length; i++) {
      const c = chosen[i];
      const ry = this._rng() * 6.28;
      this.setInstance(poles, i, c.x, c.y - 0.2, c.z, ry, 1);
      // 灯头在灯臂末端（几何里灯臂朝 +X，末端 x≈2.05，高 8.5）
      const hx = c.x + Math.cos(ry) * 2.0;
      const hz = c.z - Math.sin(ry) * 2.0;
      this.setInstance(glow, i, hx, c.y + 8.35, hz, ry, 1.5, 0, undefined, 0.7);
    }
    this.finishInstance(poles);
    this.finishInstance(glow);
    return poles;
  }

  /** 实例化停车（废车/轿车）。 */
  buildParkedCars(points, count, spread = 20) {
    if (!points.length || count <= 0) return null;
    const geo = this._G('carGeo', () => mergeGeos([
      { geo: new THREE.BoxGeometry(1.9, 0.85, 4.4), matrix: mat4(0, 0.75, 0), color: 0xdddddd },
      { geo: new THREE.BoxGeometry(1.7, 0.7, 2.2), matrix: mat4(0, 1.45, 0.15), color: 0x88ccff },
      { geo: new THREE.BoxGeometry(0.34, 0.62, 0.62), matrix: mat4(0.95, 0.36, 1.5), color: 0x1a1a1a },
      { geo: new THREE.BoxGeometry(0.34, 0.62, 0.62), matrix: mat4(-0.95, 0.36, 1.5), color: 0x1a1a1a },
      { geo: new THREE.BoxGeometry(0.34, 0.62, 0.62), matrix: mat4(0.95, 0.36, -1.5), color: 0x1a1a1a },
      { geo: new THREE.BoxGeometry(0.34, 0.62, 0.62), matrix: mat4(-0.95, 0.36, -1.5), color: 0x1a1a1a },
    ]));
    const mat = this._mat('carPaint', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.45 }));
    const im = this.instance(geo, mat, count, { name: 'cars' });
    const tints = [0xffffff, 0x88ddff, 0xffcc66, 0xff7766, 0x99ffaa, 0xbbbbbb, 0x333333];
    let placed = 0;
    for (let i = 0; i < count; i++) {
      const p = points[Math.floor(this._rng() * points.length)];
      const px = (Array.isArray(p) ? p[0] : p.x) + (this._rng() - 0.5) * spread;
      const pz = (Array.isArray(p) ? p[1] : p.z) + (this._rng() - 0.5) * spread;
      if (this._isWater(px, pz)) continue;
      this.setInstance(im, placed, px, this._heightAt(px, pz) + 0.1, pz, this._rng() * 6.28, 1,
        (this._rng() - 0.5) * 0.05, tints[i % tints.length]);
      placed++;
    }
    im.count = placed;
    this.finishInstance(im);
    return im;
  }

  // ===========================================================================
  // 植被（全部实例化）
  // ===========================================================================

  /**
   * 撒树。
   * @param {number} count density=1 时的数量
   * @param {object} opts { types:['conifer','broadleaf','palm','dead'], minH, maxH, snow, colliders }
   */
  buildTrees(count, opts = {}) {
    const types = (opts.types && opts.types.length ? opts.types : ['conifer']).filter(Boolean);
    const keyOf = { conifer: 'treeConifer', broadleaf: 'treeBroadleaf', palm: 'treePalm', dead: 'treeDead' };
    const total = Math.max(0, Math.round(count * (0.3 + this.density * 0.9)));
    if (total <= 0) return null;
    const mat = opts.snow ? this._mats.treeLeafSnow : this._mats.treeLeaf;
    const perType = Math.ceil(total / types.length);
    const meshes = [];
    let placedTotal = 0;
    for (const ty of types) {
      const key = keyOf[ty] || 'treeConifer';
      const im = this.instance(key, mat, perType, { name: 'trees_' + ty });
      let placed = 0;
      let guard = 0;
      while (placed < perType && guard < perType * 8) {
        guard++;
        const p = this._randomLandPoint();
        if (!p) break;
        if (this._isReserved(p.x, p.z)) continue;
        if (this._isWater(p.x, p.z)) continue;
        const y = this._heightAt(p.x, p.z);
        let h, w;
        if (ty === 'palm') { h = 8 + this._rng() * 7; w = 0.8 + this._rng() * 0.3; }
        else if (ty === 'dead') { h = 4 + this._rng() * 6; w = 0.8 + this._rng() * 0.5; }
        else if (ty === 'conifer') { h = (opts.minH || 6) + this._rng() * ((opts.maxH || 20) - (opts.minH || 6)); w = 0.8 + this._rng() * 0.35; }
        else { h = (opts.minH || 5) + this._rng() * ((opts.maxH || 14) - (opts.minH || 5)); w = 0.85 + this._rng() * 0.4; }
        const tint = 0.78 + this._rng() * 0.42;
        this._tcol.setRGB(tint * (0.92 + this._rng() * 0.16), tint, tint * (0.9 + this._rng() * 0.2));
        this.setInstance(im, placed, p.x, y - 0.35, p.z, this._rng() * 6.28, h * w,
          (this._rng() - 0.5) * 0.07, this._tcol, h);
        placed++;
      }
      im.count = placed;
      this.finishInstance(im);
      placedTotal += placed;
      meshes.push(im);
    }
    this._stats.trees += placedTotal;

    // 灌木
    if (opts.bushes !== false) {
      const bc = Math.min(600, Math.round(total * 0.25));
      const bim = this.instance('bush', mat, bc, { name: 'bushes' });
      let bp = 0, guard = 0;
      while (bp < bc && guard < bc * 6) {
        guard++;
        const p = this._randomLandPoint();
        if (!p || this._isWater(p.x, p.z) || this._isReserved(p.x, p.z)) continue;
        const g2 = 0.8 + this._rng() * 0.5;
        this._tcol.setRGB(g2, g2, g2);
        this.setInstance(bim, bp, p.x, this._heightAt(p.x, p.z) - 0.1, p.z, this._rng() * 6.28,
          1 + this._rng() * 1.4, 0, this._tcol);
        bp++;
      }
      bim.count = bp;
      this.finishInstance(bim);
      meshes.push(bim);
    }

    // 少量“巨树”参与碰撞（树的碰撞体只给大树，避免数百个碰撞体）
    if (opts.colliders) {
      const gc = Math.min(8, Math.max(2, Math.round(opts.colliders * this.density)));
      for (let i = 0; i < gc; i++) {
        const p = this._randomLandPoint();
        if (!p || this._isWater(p.x, p.z) || this._isReserved(p.x, p.z)) continue;
        const key = keyOf[types[i % types.length]] || 'treeConifer';
        const h = 26 + this._rng() * 16;
        const m = this.mesh(this._G(key), mat, p.x, this._heightAt(p.x, p.z) - 0.4, p.z,
          { s: h, ry: this._rng() * 6.28 });
        m.name = 'giant_tree';
        this.addSphereCollider('tree', p.x, this._heightAt(p.x, p.z) + h * 0.4, p.z, h * 0.22, {
          destructible: true, health: 120, mass: 2000, name: 'Giant tree',
        });
      }
    }
    return meshes;
  }

  // ===========================================================================
  // 其他通用设施
  // ===========================================================================

  /** 雷达站：底座 + 可旋转抛物面天线。 */
  buildRadarStation(x, z, opts = {}) {
    const y = opts.y !== undefined ? opts.y : this._heightAt(x, z);
    const scale = opts.scale || 1;
    const g = this.group(x, y, z);
    g.name = 'radar_station';
    const base = this.mesh(this._G('unitCyl'), this._mats.concrete, 0, 3 * scale, 0, { sx: 9 * scale, sy: 6 * scale, sz: 9 * scale, parent: g });
    base.name = 'radar_base';
    const mast = this.cyl(1.1, 1.4, 12 * scale, this._mats.metal, 0, 11 * scale, 0, { parent: g, seg: 8 });
    mast.name = 'radar_mast';
    const head = this.group(0, 17 * scale, 0, g);
    // 抛物面：球缺（用半球压扁）
    const dish = this.mesh(this._G('dish'), this._mats.metal, 0, 0, 0, { s: 7 * scale, parent: head });
    dish.name = 'radar_dish';
    dish.rotation.x = 0.38;
    // 馈源
    this.cyl(0.22, 0.22, 5 * scale, this._mats.metalDark, 0, 0, 5 * scale, { parent: head, seg: 6 }).rotation.x = Math.PI / 2;
    this._spinners.push({ obj: head, axis: 'y', speed: opts.speed || 0.35, phase: this._rng() * 6.28 });
    this.addSphereCollider('tower', x, y + 8 * scale, z, 5 * scale, {
      destructible: true, health: 400, mass: 5000, name: opts.name || 'Radar station', object: base,
    });
    this.addBoxCollider('prop', x, y + 2 * scale, z, 9 * scale, 3 * scale, 9 * scale, {
      destructible: false, name: 'Radar pad',
    });
    this._poi(opts.name || 'Radar station', x, y + 18 * scale, z, 'radar', 60);
    return g;
  }

  /** 码头：栈桥 + 系船柱 + 小艇 + 起重机。 */
  buildDock(x, z, heading = 0, opts = {}) {
    const len = opts.length || 180;
    const wid = opts.width || 26;
    const sin = Math.sin(heading), cos = Math.cos(heading);
    const W = (f, r) => ({ x: x - f * sin + r * cos, z: z - f * cos - r * sin });
    const deckY = this.seaLevel + (opts.deckHeight || 3.6);
    const c = W(len * 0.5, 0);
    const deck = this.box(wid, 1.2, len, this._mats.wood, c.x, deckY, c.z, { ry: heading });
    deck.name = 'dock';
    this.addBoxCollider('prop', c.x, deckY, c.z, wid / 2, 0.6, len / 2, {
      destructible: false, name: 'Dock', object: deck, heading, oriented: true,
      surfaceY: deckY + 0.6,
    });
    // 桩
    const pileGeos = [];
    for (let i = 0; i < Math.floor(len / 16); i++) {
      for (const side of [-1, 1]) {
        const p = W(i * 16 + 6, side * (wid / 2 - 1.5));
        pileGeos.push(new THREE.CylinderGeometry(0.65, 0.65, 12, 7).translate(p.x, deckY - 5, p.z));
      }
    }
    this.mergedMesh(pileGeos, this._mats.wood, 'dock_piles');
    // 系船柱 + 集装箱
    for (let i = 0; i < 6; i++) {
      const p = W(i * 28 + 10, (i % 2 ? 1 : -1) * (wid / 2 - 2));
      this.cyl(0.8, 0.9, 1.6, this._mats.metalDark, p.x, deckY + 1.4, p.z, { seg: 8 });
    }
    for (let i = 0; i < 5; i++) {
      const p = W(20 + i * 26, -wid * 0.28);
      this.buildCrate(p.x, deckY + 0.6, p.z, this._rng() * 0.8);
    }
    // 起重机（可旋转）
    const cp = W(len * 0.85, wid * 0.1);
    const crane = this.group(cp.x, deckY + 0.6, cp.z);
    const cbase = this.box(7, 3, 9, this._mats.hullRed, 0, 1.5, 0, { parent: crane });
    const arm = this.group(0, 3, 0, crane);
    this.box(3, 24, 3, this._mats.hullRed, 0, 12, 0, { parent: arm, rx: 0.25 });
    this.box(34, 1.4, 1.4, this._mats.hullRed, -14, 23, 0, { parent: arm, rz: 0.12 });
    this._spinners.push({ obj: arm, axis: 'y', speed: 0.16, phase: 0 });
    this.addBoxCollider('prop', cp.x, deckY + 4, cp.z, 4, 4, 5, {
      destructible: true, health: 500, mass: 9000, name: 'Dock crane', object: cbase,
    });
    // 小艇
    if (this.water) {
      for (let i = 0; i < 2; i++) {
        const p = W(len * (0.3 + i * 0.4), wid * 0.75);
        this.buildBoat(p.x, this.seaLevel, p.z, heading + Math.PI / 2, 1);
      }
    }
    this._anchor('cargo', 'Dock', { x: c.x, y: deckY + 2, z: c.z }, 70);
    this._poi('Harbour dock', c.x, deckY + 10, c.z, 'dock', 110);
    return deck;
  }

  /** 小船（非碰撞体的装饰艇）。 */
  buildBoat(x, y, z, heading = 0, scale = 1) {
    const g = this.group(x, y, z);
    g.rotation.y = heading;
    const hull = this.mesh(this._G('unitCapsule'), this._mats.paintWhite, 0, 0.9 * scale, 0,
      { sx: 1.6 * scale, sy: 1.1 * scale, sz: 1.4 * scale, rx: Math.PI / 2, parent: g });
    hull.name = 'boat';
    this.mesh(this._G('unitBox'), this._mats.wood, 0, 1.5 * scale, -0.6 * scale, { sx: 2.2 * scale, sy: 0.35 * scale, sz: 1.6 * scale, parent: g });
    this.mesh(this._G('unitBox'), this._mats.glass, 0, 2.1 * scale, 1.2 * scale, { sx: 1.4 * scale, sy: 0.9 * scale, sz: 1 * scale, parent: g });
    this._bobbers.push({
      obj: g, colliders: [], baseY: y, amp: 0.35 * scale,
      speed: 0.9, phase: this._rng() * 6.28, roll: 0.05, pitch: 0.03,
    });
    return g;
  }

  /** 桥梁：桥面 + 桥墩 + 拉索。 */
  buildBridge(x, z, heading, opts = {}) {
    const len = opts.length || 420;
    const wid = opts.width || 26;
    const sin = Math.sin(heading), cos = Math.cos(heading);
    const W = (f, r) => ({ x: x - f * sin + r * cos, z: z - f * cos - r * sin });
    // 桥面高度：至少 clearance，但必须高过沿线地形（否则桥会插进山里）
    let deckY = this.seaLevel + (opts.clearance || 42);
    let maxGround = -Infinity;
    for (let i = 0; i <= Math.max(8, Math.ceil(len / 30)); i++) {
      const f = (i / Math.max(8, Math.ceil(len / 30)) - 0.5) * len;
      const px = x - f * sin, pz = z - f * cos;
      const h = this._heightAt(px, pz);
      if (h > maxGround) maxGround = h;
    }
    deckY = Math.max(deckY, maxGround + 9);
    const c = W(0, 0);
    const deck = this.box(wid, 3, len, this._mats.concrete, c.x, deckY, c.z, { ry: heading });
    deck.name = 'bridge_deck';
    this.addBoxCollider('prop', c.x, deckY, c.z, wid / 2, 1.5, len / 2, {
      destructible: false, name: 'Cable bridge deck', object: deck, heading, oriented: true,
      surfaceY: deckY + 1.5,
    });
    // 桥墩
    for (const f of [-len * 0.32, 0, len * 0.32]) {
      const p = W(f, 0);
      const gh = Math.max(2, deckY - this.seaLevel + 6);
      const pier = this.box(9, gh, 16, this._mats.concrete, p.x, deckY - 1.5 - gh / 2, p.z, { ry: heading });
      pier.name = 'bridge_pier';
      this.addBoxCollider('prop', p.x, deckY - 1.5 - gh / 2, p.z, 4.5, gh / 2, 8, {
        destructible: true, health: 1200, mass: 20000, name: 'Bridge pier', object: pier, heading, oriented: true,
      });
    }
    // 桥塔 + 拉索（用细柱近似）
    const cabGeos = [];
    for (const f of [-len * 0.32, len * 0.32]) {
      const p = W(f, 0);
      cabGeos.push(new THREE.CylinderGeometry(1.6, 2.4, (opts.pylon || 70), 8).translate(p.x, deckY + (opts.pylon || 70) / 2, p.z));
      for (let i = 1; i <= 6; i++) {
        for (const side of [-1, 1]) {
          const a = W(f + side * i * (len * 0.045), side * wid * 0.42);
          const top = { x: p.x, z: p.z };
          const dx = a.x - top.x, dz = a.z - top.z, dy = deckY + 2 - (deckY + (opts.pylon || 70) * 0.92);
          const dl = Math.hypot(dx, dy, dz);
          const q = new THREE.Quaternion().setFromUnitVectors(
            new THREE.Vector3(0, 1, 0),
            new THREE.Vector3(dx / dl, dy / dl, dz / dl),
          );
          const mm = new THREE.Matrix4().compose(
            new THREE.Vector3((a.x + top.x) / 2, (deckY + 2 + deckY + (opts.pylon || 70) * 0.92) / 2, (a.z + top.z) / 2),
            q, new THREE.Vector3(1, 1, 1),
          );
          cabGeos.push(new THREE.CylinderGeometry(0.22, 0.22, dl, 4).applyMatrix4(mm));
        }
      }
    }
    this.mergedMesh(cabGeos, this._mats.metalDark, 'bridge_cables');
    // 桥面栏杆（先旋转再平移到世界坐标）
    const railGeos = [];
    for (const side of [-1, 1]) {
      const p = W(0, side * (wid / 2 - 0.6));
      const g2 = new THREE.BoxGeometry(0.5, 1.6, len);
      g2.applyMatrix4(mat4(0, 0, 0, 0, heading, 0));
      g2.translate(p.x, deckY + 2.3, p.z);
      railGeos.push(g2);
    }
    this.mergedMesh(railGeos, this._mats.metalDark, 'bridge_rails');
    this._poi('Bridge', c.x, deckY + 10, c.z, 'bridge', 120);
    return deck;
  }

  /** 灯塔：可旋转灯室 + 光晕精灵。 */
  buildLighthouse(x, z, opts = {}) {
    const y = opts.y !== undefined ? opts.y : Math.max(this._heightAt(x, z), this.seaLevel);
    const h = opts.height || 34;
    const g = this.group(x, y, z);
    g.name = 'lighthouse';
    const base = this.cyl(5.4, 7, 5, this._mats.concrete, 0, 2.5, 0, { parent: g, seg: 14 });
    const tower = this.cyl(2.6, 5.2, h, this._mats.paintWhite, 0, 5 + h / 2, 0, { parent: g, seg: 14 });
    tower.name = 'lighthouse_tower';
    // 红环
    for (let i = 0; i < 3; i++) {
      this.cyl(lerp(2.6, 5.2, (i * 2 + 1) / 6) + 0.12, lerp(2.6, 5.2, (i * 2 + 1) / 6) + 0.14, h * 0.16,
        this._mats.paintRed, 0, 5 + h * (0.2 + i * 0.3), 0, { parent: g, seg: 14 });
    }
    const gallery = this.cyl(4.6, 4.6, 1.2, this._mats.metalDark, 0, 5 + h, 0, { parent: g, seg: 14 });
    gallery.name = 'gallery';
    const lamp = this.mesh(this._G('unitCyl'), this._mats.glassNeon, 0, 7 + h, 0, { sx: 3, sy: 4, sz: 3, parent: g });
    lamp.name = 'lamp_room';
    this.cone(4, 5, this._mats.paintRed, 0, 9.5 + h, 0, { parent: g, seg: 14 });
    const spr = new THREE.Sprite(this._mats.sprCool);
    spr.scale.setScalar(90);
    spr.position.set(0, 7 + h, 0);
    g.add(spr);
    this._spinners.push({ obj: lamp, axis: 'y', speed: 1.1, phase: 0 });
    const beam = this.mesh(this._G('unitBox'), this._mats.glassNeon, 0, 7 + h, 0,
      { sx: 120, sy: 6, sz: 3, parent: g });
    beam.name = 'light_beam';
    this._spinners.push({ obj: beam, axis: 'y', speed: 1.1, phase: 0 });
    this.addBoxCollider('tower', x, y + (5 + h) / 2, z, 4.4, (5 + h) / 2 + 1, 4.4, {
      destructible: true, health: 900, mass: 12000, name: 'Lighthouse', object: tower,
    });
    this._poi('Lighthouse', x, y + h + 12, z, 'lighthouse', 70);
    return g;
  }

  /** 广告牌（朝相机）。 */
  buildBillboard(x, z, text, opts = {}) {
    const y = opts.y !== undefined ? opts.y : this._heightAt(x, z);
    const h = opts.height || 16;
    const legs = this.mergedMesh([
      new THREE.CylinderGeometry(0.6, 0.7, h, 6).translate(x - 5, y + h / 2, z),
      new THREE.CylinderGeometry(0.6, 0.7, h, 6).translate(x + 5, y + h / 2, z),
    ], this._mats.metalDark, 'billboard_legs');
    if (legs) legs.name = 'billboard_legs';
    const sign = this.buildNeonSign(x, y + h + 5, z, text, 1.4, { billboard: true, width: 24, height: 9, frame: false });
    if (sign) this.box(26, 10.5, 0.6, this._mats.metalDark, x, y + h + 5, z, { parent: this.root });
    return sign;
  }

  // ===========================================================================
  // 船只（驱逐舰 / 巡洋舰 / 航母 / 海盗船 / 沉船）
  // ===========================================================================

  /** 船体平面轮廓（X=船宽，Y=船长，船首在 +Y）。 */
  _hullShape(len, beam) {
    const B = beam / 2;
    const stern = -len * 0.5, bow = len * 0.5;
    const s = new THREE.Shape();
    s.moveTo(-B * 0.86, stern);
    s.lineTo(B * 0.86, stern);
    s.lineTo(B, stern + len * 0.22);
    s.lineTo(B * 0.96, bow - len * 0.3);
    s.quadraticCurveTo(B * 0.72, bow - len * 0.07, 0, bow);
    s.quadraticCurveTo(-B * 0.72, bow - len * 0.07, -B * 0.96, bow - len * 0.3);
    s.lineTo(-B, stern + len * 0.22);
    s.closePath();
    return s;
  }

  /** 船体几何：底面 y=-height/2，顶面 y=+height/2，船首朝 -Z。 */
  _hullGeo(len, beam, height) {
    return this._G(`hull_${Math.round(len)}_${Math.round(beam)}_${Math.round(height)}`, () => {
      const g = new THREE.ExtrudeGeometry(this._hullShape(len, beam), {
        depth: height, bevelEnabled: false, curveSegments: 6, steps: 1,
      });
      g.translate(0, 0, -height / 2);
      g.rotateX(-Math.PI / 2);
      g.computeVertexNormals();
      return g;
    });
  }

  /**
   * 造一艘船。
   * @param {'destroyer'|'cruiser'|'carrier'|'pirate'|'wreck'} kind
   * @param {number} x @param {number} z @param {number} heading 0 = 船首朝 -Z
   */
  buildShip(kind, x, z, heading = 0, opts = {}) {
    const spec = {
      destroyer: { len: 132, beam: 15, h: 16, draft: 7, mat: 'hullGray', health: 2600, mass: 30000 },
      cruiser: { len: 186, beam: 19, h: 18, draft: 7.5, mat: 'hullGray', health: 4200, mass: 60000 },
      carrier: { len: 300, beam: 38, h: 24, draft: 8, mat: 'hullGray', health: 12000, mass: 180000 },
      pirate: { len: 92, beam: 21, h: 13, draft: 5, mat: 'wood', health: 1200, mass: 9000 },
      wreck: { len: 150, beam: 20, h: 16, draft: 9, mat: 'rust', health: 800, mass: 20000 },
    }[kind] || null;
    if (!spec) return null;

    // 船体几何以船体中心为原点（总高 h）：吃水 draft => 中心高度 = h/2 - draft
    const y0 = this.seaLevel + spec.h * 0.5 - spec.draft;
    const g = this.group(x, y0, z);
    g.rotation.y = heading;
    g.name = 'ship_' + kind;
    if (kind === 'wreck') g.rotation.z = 0.42;

    const hullMat = this._mats[spec.mat] || this._mats.hullGray;
    const hull = this.mesh(this._hullGeo(spec.len, spec.beam, spec.h), hullMat, 0, 0, 0, { parent: g });
    hull.name = 'hull';
    // 水线红漆
    if (kind !== 'pirate' && kind !== 'wreck') {
      const wl = this.mesh(this._hullGeo(spec.len * 1.002, spec.beam * 1.004, spec.h * 0.34), this._mats.hullRed, 0, -spec.h * 0.33, 0, { parent: g });
      wl.name = 'waterline';
    }
    // 甲板面
    const deckMat = this._mats.concrete;
    const deck = this.mesh(this._G('unitBox'), deckMat, 0, spec.h / 2 - 0.2, 0,
      { sx: spec.beam * 0.9, sy: 0.5, sz: spec.len * 0.94, parent: g });
    deck.name = 'deck';

    const deckTop = spec.h / 2;
    if (kind === 'carrier') {
      this._buildCarrierTop(g, spec, deckTop);
    } else if (kind === 'pirate') {
      this._buildPirateTop(g, spec, deckTop);
    } else if (kind === 'wreck') {
      this.mesh(this._G('unitBox'), this._mats.rust, 0, deckTop + 2, spec.len * 0.18,
        { sx: spec.beam * 0.5, sy: 4, sz: spec.len * 0.3, rz: 0.3, parent: g });
    } else {
      this._buildWarshipTop(g, spec, deckTop, kind);
    }

    // 碰撞体：球链（对旋转不敏感），浮动，可摧毁
    const rad = Math.max(6, spec.beam * 0.52);
    const floating = kind !== 'wreck';
    const colOpts = {
      destructible: true, health: spec.health, mass: spec.mass,
      name: opts.name || (kind.charAt(0).toUpperCase() + kind.slice(1)),
      object: g, floating, bobAmp: 0.75, bobSpeed: 0.62, bobRoll: 0.022, bobPitch: 0.01,
    };
    const cols = this.addCapsuleSpheres(kind === 'carrier' ? 'carrier' : 'ship',
      x, y0 + spec.h * 0.1, z, heading, spec.len * 0.37, rad, colOpts);
    if (kind === 'carrier') {
      // 斜角甲板横向很宽：再加两排球覆盖甲板
      const side = spec.beam * 0.85;
      this.addCapsuleSpheres('carrier', x + Math.cos(heading) * side, y0 + spec.h * 0.6, z - Math.sin(heading) * side,
        heading, spec.len * 0.3, rad * 0.9, colOpts);
    }

    const label = colOpts.name;
    this._anchor('targets', label, { x, y: y0 + spec.h * 0.5, z }, spec.len * 0.45);
    this._anchor('cargo', label + ' deck', { x, y: y0 + spec.h * 0.5, z }, spec.beam * 0.8);
    if (opts.poi !== false) this._poi(label, x, y0 + spec.h * 0.5 + 8, z, 'ship', spec.len * 0.4);
    this._stats.buildings++;
    return g;
  }

  /** 军舰上层建筑：舰桥 / 烟囱 / 桅杆 / 主炮。 */
  _buildWarshipTop(g, spec, deckTop, kind) {
    const L = spec.len, B = spec.beam;
    // 舰桥（阶梯式）
    this.mesh(this._G('unitBox'), this._mats.hullGray, 0, deckTop + 5, L * 0.06,
      { sx: B * 0.72, sy: 10, sz: L * 0.16, parent: g });
    const bridge = this.mesh(this._G('unitBox'), this._mats.hullGray, 0, deckTop + 12, L * 0.1,
      { sx: B * 0.55, sy: 7, sz: L * 0.1, parent: g });
    bridge.name = 'bridge';
    // 玻璃观察窗
    this.mesh(this._G('unitBox'), this._mats.glassNeon, 0, deckTop + 14, L * 0.06,
      { sx: B * 0.5, sy: 2.2, sz: 1.2, parent: g });
    // 烟囱
    for (let i = 0; i < (kind === 'cruiser' ? 2 : 1); i++) {
      const f = L * (0.16 + i * 0.14);
      this.cyl(B * 0.18, B * 0.22, 11, this._mats.hullDark, 0, deckTop + 8, f, { parent: g, seg: 10, rx: -0.08 });
      this.mesh(this._G('unitBox'), this._mats.hullDark, 0, deckTop + 14, f, { sx: B * 0.24, sy: 1, sz: B * 0.24, parent: g });
    }
    // 主桅 + 旋转雷达
    const mastZ = L * 0.2;
    this.cyl(0.6, 0.9, 22, this._mats.metal, 0, deckTop + 20, mastZ, { parent: g, seg: 6 });
    const rot = this.group(0, deckTop + 31, mastZ, g);
    this.mesh(this._G('unitBox'), this._mats.metal, 0, 0, 0, { sx: 9, sy: 0.5, sz: 0.6, parent: rot });
    this._spinners.push({ obj: rot, axis: 'y', speed: 0.8, phase: this._rng() * 6.28 });
    // 主炮塔（前 1~2 座 + 后 1 座），可缓慢转向
    const guns = kind === 'cruiser' ? [[-0.34, 2], [0.3, 1]] : [[-0.34, 1], [0.34, 1]];
    for (const [f, ] of guns) {
      const zz = L * f;
      const head = this.group(0, deckTop + 2.2, zz, g);
      this.mesh(this._G('unitCyl'), this._mats.hullGray, 0, 0, 0, { sx: B * 0.2, sy: 2.2, sz: B * 0.2, parent: head, seg: 12 });
      for (const off of [-0.9, 0.9]) {
        const barrel = this.cyl(0.32, 0.34, 9, this._mats.hullDark, off, 1.4, -5, { parent: head, seg: 6 });
        barrel.rotation.x = Math.PI / 2;
      }
      this._spinners.push({ obj: head, axis: 'y', speed: 0.07 * (f < 0 ? 1 : -1), phase: this._rng() * 6.28 });
    }
    // 反舰导弹箱 / 深弹
    for (const side of [-1, 1]) {
      this.mesh(this._G('unitBox'), this._mats.metalDark, side * B * 0.34, deckTop + 3, L * 0.02,
        { sx: B * 0.16, sy: 5, sz: L * 0.12, parent: g, rz: side * 0.5 });
    }
    // 舰尾直升机甲板标记
    const pad = this.mesh(this._G('unitCyl'), this._mats.paintWhite, 0, deckTop + 0.3, L * 0.4,
      { sx: B * 0.3, sy: 0.2, sz: B * 0.3, parent: g, seg: 16 });
    pad.name = 'helipad';
    this.sphere(1.4, this._mats.beaconWhite, 0, deckTop + 27, mastZ, { parent: g });
  }

  /** 航母甲板：斜角甲板贴图 + 舰岛 + 拦阻索 + 弹射器。 */
  _buildCarrierTop(g, spec, deckTop) {
    const L = spec.len, B = spec.beam;
    const deckW = B * 2.1, deckL = L * 1.12;
    const plate = this.mesh(this._G('unitBox'), this._mats.hullGray, B * 0.18, deckTop + 0.8, 0,
      { sx: deckW, sy: 1.8, sz: deckL, parent: g });
    plate.name = 'flight_deck';
    // 甲板贴图（U 沿舰长方向）
    const dGeo = new THREE.PlaneGeometry(deckL, deckW);
    dGeo.rotateX(-Math.PI / 2);
    dGeo.rotateY(Math.PI / 2);
    const dMat = this._mat('carrierDeck', () => new THREE.MeshStandardMaterial({
      map: this._tex.carrierDeck(spec.len, deckW, 'TINY'), color: 0xffffff, roughness: 0.85, metalness: 0.08,
    }));
    const dm = new THREE.Mesh(dGeo, dMat);
    dm.position.set(B * 0.18, deckTop + 1.74, 0);
    dm.name = 'deck_marks';
    g.add(dm);
    // 拦阻索
    const wires = [];
    for (let i = 0; i < 4; i++) {
      const w = new THREE.CylinderGeometry(0.16, 0.16, deckW * 0.8, 5);
      w.rotateZ(Math.PI / 2);
      w.translate(B * 0.18, deckTop + 2.0, -L * 0.02 + i * 12);
      wires.push(w);
    }
    this.mergedMesh(wires, this._mats.metalDark, 'arrestor_wires', g);
    // 舰岛（右舷）
    const isl = this.mesh(this._G('unitBox'), this._mats.hullDark, B * 0.78, deckTop + 8, L * 0.1,
      { sx: B * 0.34, sy: 14, sz: L * 0.2, parent: g });
    isl.name = 'island';
    this.mesh(this._G('unitBox'), this._mats.glassNeon, B * 0.78, deckTop + 13, L * 0.1,
      { sx: B * 0.36, sy: 2.4, sz: L * 0.16, parent: g });
    this.cyl(0.5, 0.8, 18, this._mats.metal, B * 0.78, deckTop + 24, L * 0.14, { parent: g, seg: 6 });
    const rot = this.group(B * 0.78, deckTop + 33, L * 0.14, g);
    this.mesh(this._G('unitBox'), this._mats.metal, 0, 0, 0, { sx: 12, sy: 0.6, sz: 0.8, parent: rot });
    this._spinners.push({ obj: rot, axis: 'y', speed: 0.55, phase: 0 });
    // 舰载机（静态摆件）
    for (let i = 0; i < 3; i++) {
      const ac = this.mesh(this._G('miniCraft'), this._mats.craftBody, -B * 0.55 + i * 8 - 8, deckTop + 4.2,
        L * 0.12 + i * 22, { parent: g, ry: -0.4, s: 1.6 });
      ac.name = 'deck_aircraft';
    }
    // 弹射器蒸汽/升降机
    this.mesh(this._G('unitBox'), this._mats.paintWhite, B * 0.18, deckTop + 1.9, -L * 0.36,
      { sx: 2.2, sy: 0.3, sz: 60, parent: g });
  }

  /** 海盗船上层：三桅 + 帆 + 索具 + 旗帜。 */
  _buildPirateTop(g, spec, deckTop) {
    const L = spec.len, B = spec.beam;
    const sailMat = this._mats.sail;
    // 艉楼 / 艏楼
    this.mesh(this._G('unitBox'), this._mats.wood, 0, deckTop + 3, L * 0.36,
      { sx: B * 0.8, sy: 6, sz: L * 0.24, parent: g });
    this.mesh(this._G('unitBox'), this._mats.wood, 0, deckTop + 2, -L * 0.36,
      { sx: B * 0.6, sy: 4, sz: L * 0.16, parent: g });
    const mastGeos = [];
    const masts = [[-L * 0.3, 30], [0, 36], [L * 0.28, 28]];
    for (const [mz, mh] of masts) {
      mastGeos.push(new THREE.CylinderGeometry(0.7, 1.0, mh, 7).translate(0, deckTop + mh / 2, mz));
      mastGeos.push(new THREE.CylinderGeometry(0.3, 0.3, B * 0.9, 5)
        .rotateZ(Math.PI / 2).translate(0, deckTop + mh * 0.8, mz));
      // 帆：上下两根横桁之间的布面
      const sail = new THREE.PlaneGeometry(B * 0.85, mh * 0.46);
      sail.rotateY(Math.PI / 2);
      sail.translate(0, deckTop + mh * 0.55, mz);
      const sailMesh = new THREE.Mesh(sail, sailMat);
      sailMesh.name = 'sail';
      g.add(sailMesh);
      const sail2 = new THREE.PlaneGeometry(B * 0.6, mh * 0.3);
      sail2.rotateY(Math.PI / 2);
      sail2.translate(0, deckTop + mh * 0.9, mz);
      const sm2 = new THREE.Mesh(sail2, sailMat);
      sm2.name = 'sail';
      g.add(sm2);
    }
    this.mergedMesh(mastGeos, this._mats.wood, 'masts', g);
    // 索具
    const rig = [];
    for (let i = 0; i < 6; i++) {
      const z0 = -L * 0.42 + i * (L * 0.17);
      for (const side of [-1, 1]) {
        const top = new THREE.Vector3(0, deckTop + 30, z0);
        const bot = new THREE.Vector3(side * B * 0.55, deckTop + 1, z0 + (this._rng() - 0.5) * 10);
        const d = new THREE.Vector3().subVectors(top, bot);
        const dl = d.length();
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3().addVectors(top, bot).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1),
        );
        rig.push(new THREE.CylinderGeometry(0.07, 0.07, dl, 3).applyMatrix4(m));
      }
    }
    this.mergedMesh(rig, this._mats.metalDark, 'rigging', g);
    // 旗帜（海盗旗）
    const flagMat = this._mat('jollyRoger', () => new THREE.MeshStandardMaterial({
      map: this._tex.flag('#1a1a1a', '#e8e8e8'), color: 0xffffff, roughness: 0.9, side: THREE.DoubleSide,
    }));
    this.mesh(this._G('unitPlane'), flagMat, 0, deckTop + 33, 0, { sx: 8, sy: 5.4, parent: g });
    // 甲板炮
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const b = this.cyl(0.3, 0.34, 3.6, this._mats.metalDark, side * B * 0.4, deckTop + 1.6, -L * 0.2 + i * 14,
          { parent: g, seg: 6 });
        b.rotation.x = Math.PI / 2;
      }
    }
  }

  // ===========================================================================
  // 油井 / 钻井平台 / 海怪
  // ===========================================================================

  /** 海上钻井平台：四条腿 + 甲板 + 井架 + 火炬 + 直升机坪。 */
  buildOilRig(x, z, opts = {}) {
    const g = this.group(x, this.seaLevel, z);   // 组原点在水平面，所有局部 y = 海拔高度
    g.name = 'oil_rig';
    const deckY = opts.deckHeight || 26;
    const seabedLocal = Math.min(this._heightAt(x, z), this.seaLevel - 4) - this.seaLevel;
    const legLen = deckY - seabedLocal + 6;
    const legGeos = [];
    const braceGeos = [];
    const R = 18;
    const mkSeg = (a, b, r, out) => {
      const dir = new THREE.Vector3().subVectors(b, a);
      const dl = dir.length() || 1;
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      out.push(new THREE.CylinderGeometry(r, r, dl, 5).applyMatrix4(
        new THREE.Matrix4().compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1))));
    };
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const px = sx * R, pz = sz * R;
        legGeos.push(new THREE.CylinderGeometry(2.2, 3.0, legLen, 9).translate(px, seabedLocal + legLen / 2, pz));
        for (let k = 0; k < 4; k++) {
          const y0 = seabedLocal + 4 + k * (legLen - 8) / 4;
          const y1 = y0 + (legLen - 8) / 4;
          mkSeg(new THREE.Vector3(px, y0, pz), new THREE.Vector3(-px, y1, pz), 0.5, braceGeos);
          mkSeg(new THREE.Vector3(px, y0, pz), new THREE.Vector3(px, y1, -pz), 0.5, braceGeos);
        }
      }
    }
    this.mergedMesh(legGeos, this._mats.metalDark, 'rig_legs', g);
    this.mergedMesh(braceGeos, this._mats.metalDark, 'rig_braces', g);

    const deck = this.box(46, 3, 46, this._mats.metal, 0, deckY, 0, { parent: g });
    deck.name = 'rig_deck';
    this.addBoxCollider('prop', x, this.seaLevel + deckY, z, 23, 2, 23, {
      destructible: true, health: 2200, mass: 40000, name: 'Oil rig deck', object: deck,
    });
    // 上层平台 + 生活区
    this.mesh(this._G('unitBox'), this._mats.metal, 0, deckY + 8, 8, { sx: 26, sy: 6, sz: 20, parent: g });
    this.mesh(this._G('unitBox'), this._mats.hullRed, 0, deckY + 12, 8, { sx: 8, sy: 4, sz: 8, parent: g });
    // 井架
    const derrick = [];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        mkSeg(new THREE.Vector3(sx * 6, deckY + 1.5, sz * 6), new THREE.Vector3(sx * 2, deckY + 43, sz * 2), 0.45, derrick);
      }
    }
    for (let k = 1; k <= 5; k++) {
      const t = k / 6, r = 6 * (1 - t) + 2 * t, yy = deckY + 1.5 + 42 * t;
      derrick.push(new THREE.BoxGeometry(r * 2, 0.5, 0.5).translate(0, yy, -r));
      derrick.push(new THREE.BoxGeometry(r * 2, 0.5, 0.5).translate(0, yy, r));
      derrick.push(new THREE.BoxGeometry(0.5, 0.5, r * 2).translate(-r, yy, 0));
      derrick.push(new THREE.BoxGeometry(0.5, 0.5, r * 2).translate(r, yy, 0));
    }
    this.mergedMesh(derrick, this._mats.metal, 'derrick', g);
    // 起重机（旋转）
    const cr = this.group(0, deckY + 2, -14, g);
    this.box(6, 6, 8, this._mats.hullRed, 0, 3, 0, { parent: cr });
    const jib = this.group(0, 6, 0, cr);
    this.box(30, 1.6, 1.6, this._mats.hullRed, 13, 0.6, 0, { parent: jib, rz: 0.1 });
    this._spinners.push({ obj: jib, axis: 'y', speed: 0.12, phase: 0 });
    // 火炬臂 + 常驻火焰
    const flare = this.cyl(0.8, 1.0, 26, this._mats.metalDark, 0, deckY + 12, -20, { parent: g, seg: 6 });
    flare.rotation.x = -0.5;
    const fMat = this._mats.flameOuter.clone();
    this._matsOwned.push(fMat);
    const flame = this.cone(3.2, 12, fMat, 0, deckY + 22, -26, { parent: g, seg: 8 });
    this._flames.push({ mesh: flame, base: 3.2, phase: this._rng() * 6.28, speed: 7, mat: fMat });
    const spr = new THREE.Sprite(this._mats.sprFlame);
    spr.scale.setScalar(34);
    spr.position.set(0, deckY + 24, -26);
    g.add(spr);
    // 直升机坪（局部坐标）
    this.buildHelipad(-14, deckY + 1.5, 14, { parent: g, radius: 9, anchor: false });
    this._anchor('landingPads', 'Oil rig pad', { x: x - 14, y: this.seaLevel + deckY + 2.5, z: z + 14 }, 16);
    this._poi('Oil rig', x, this.seaLevel + deckY + 16, z, 'rig', 90);
    this._anchor('cargo', 'Oil rig', { x, y: this.seaLevel + deckY + 3, z }, 50);
    return g;
  }

  /** 沙漠抽油机（游梁摆动）。 */
  buildPumpjack(x, y, z, ry = 0) {
    const g = this.group(x, y, z);
    g.rotation.y = ry;
    g.name = 'pumpjack';
    this.box(9, 3, 6, this._mats.metalDark, 0, 1.5, 0, { parent: g });
    // A 型支架
    const legs = [];
    for (const sz of [-1, 1]) {
      legs.push(new THREE.CylinderGeometry(0.35, 0.4, 11, 5).rotateX(sz * 0.22).translate(0, 7.2, sz * 2.4));
    }
    this.mergedMesh(legs, this._mats.metal, 'pump_legs', g);
    const beam = this.group(0, 11, 0, g);
    this.box(20, 1.2, 1.6, this._mats.metal, 3, 0, 0, { parent: beam });
    this._swayers.push({ obj: beam, axis: 'z', base: 0, amp: 0.12, speed: 1.6, phase: this._rng() * 6.28 });
    // 驴头 + 配重
    this.mesh(this._G('unitCyl'), this._mats.metalDark, -7, 12.6, 0, { sx: 2.2, sy: 1.4, sz: 2.2, parent: g, seg: 10 });
    this.mesh(this._G('unitCyl'), this._mats.metalDark, 13, 10.2, 0, { sx: 3.4, sy: 1.2, sz: 3.4, parent: g, seg: 12, rz: 0.6 });
    this.mesh(this._G('unitCyl6'), this._mats.metalDark, 0, 4, 0, { sx: 4, sy: 6, sz: 4, parent: g });
    this.addBoxCollider('prop', x, y + 2, z, 5, 3, 4, {
      destructible: true, health: 220, mass: 6000, name: 'Pumpjack', object: g, ry,
    });
    return g;
  }

  /** 沙漠井架（静态塔）。 */
  buildDerrick(x, y, z) {
    const parts = [];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const dir = new THREE.Vector3(-sx * 3, 30, -sz * 3);
        const dl = dir.length();
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
        parts.push(new THREE.CylinderGeometry(0.3, 0.3, dl, 5).applyMatrix4(
          new THREE.Matrix4().compose(new THREE.Vector3(sx * 4.5, y + 15, sz * 4.5), q, new THREE.Vector3(1, 1, 1))));
      }
    }
    for (let k = 1; k <= 6; k++) {
      const t = k / 7, r = 4.5 * (1 - t) + 1.2 * t, yy = y + 30 * t;
      parts.push(new THREE.BoxGeometry(r * 2, 0.35, 0.35).translate(x, yy, z - r));
      parts.push(new THREE.BoxGeometry(r * 2, 0.35, 0.35).translate(x, yy, z + r));
      parts.push(new THREE.BoxGeometry(0.35, 0.35, r * 2).translate(x - r, yy, z));
      parts.push(new THREE.BoxGeometry(0.35, 0.35, r * 2).translate(x + r, yy, z));
    }
    this.mergedMesh(parts, this._mats.metal, 'derrick');
    const base = this.box(11, 2, 11, this._mats.concrete, x, y + 1, z);
    this.addBoxCollider('prop', x, y + 15, z, 5, 15, 5, {
      destructible: true, health: 500, mass: 12000, name: 'Derrick', object: base,
    });
    return base;
  }

  /** 巨型海怪（触手雕塑，静态）。 */
  buildKraken(x, z, opts = {}) {
    const y = this.seaLevel;
    const g = this.group(x, y, z);
    g.name = 'kraken';
    const flesh = this._mat('flesh', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.05 }));
    const scale = opts.scale || 1;
    // 半潜的头部
    const headGeo = mergeGeos([
      { geo: new THREE.SphereGeometry(1, 16, 12), matrix: mat4(0, 0, 0, 0, 0, 0, 30, 22, 34), color: 0x4b2b45 },
      { geo: new THREE.ConeGeometry(1, 1, 10), matrix: mat4(0, -14, 0, Math.PI, 0, 0, 16, 22, 16), color: 0x3d2238 },
      { geo: new THREE.SphereGeometry(1, 10, 8), matrix: mat4(0, 9, -22, 0, 0, 0, 12, 9, 10), color: 0x552f4d },
    ]);
    const head = new THREE.Mesh(headGeo, flesh);
    head.position.y = -2 * scale;
    head.scale.setScalar(scale);
    g.add(head);
    // 眼睛（自发光）
    for (const side of [-1, 1]) {
      this.sphere(3.4 * scale, this._mats.beaconWhite, side * 9 * scale, 6 * scale, -30 * scale, { parent: g });
      this.sphere(2.2 * scale, this._mat('eyeDark', () => new THREE.MeshStandardMaterial({
        color: 0x0a0a12, emissive: 0x2255ff, emissiveIntensity: 1.4, roughness: 0.2,
      })), side * 9 * scale, 6 * scale, -32 * scale, { parent: g });
    }
    // 触手 ×6
    const segs = 11;
    for (let a = 0; a < 6; a++) {
      const az = (a / 6) * Math.PI * 2 + 0.3;
      const parts = [];
      let prev = null;
      for (let k = 0; k <= segs; k++) {
        const t = k / segs;
        const px = 14 + 62 * t + 12 * t * t;
        const py = 8 + 46 * Math.sin(Math.PI * t * 0.85) - 42 * t * t;
        const r = 6.4 * (1 - t) + 1.1;
        const p = new THREE.Vector3(px, py, 0);
        if (prev) {
          const mid = new THREE.Vector3().addVectors(prev.p, p).multiplyScalar(0.5);
          const dir = new THREE.Vector3().subVectors(p, prev.p);
          const dl = dir.length();
          const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
          parts.push({
            geo: new THREE.CylinderGeometry(prev.r, r, dl, 7),
            matrix: new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1)),
            color: k % 2 ? 0x4b2b45 : 0x5d3552,
          });
          if (k % 2 === 0) {
            parts.push({
              geo: new THREE.SphereGeometry(1, 6, 5),
              matrix: mat4(mid.x + r * 0.7, mid.y - r * 0.4, mid.z, 0, 0, 0, r * 0.34, r * 0.34, r * 0.34),
              color: 0x8a5a78,
            });
          }
        }
        prev = { p, r };
      }
      const geo = mergeGeos(parts);
      geo.scale(scale, scale, scale);
      geo.applyMatrix4(new THREE.Matrix4().makeRotationY(az));
      const t = new THREE.Mesh(geo, flesh);
      t.name = 'tentacle';
      g.add(t);
    }
    // 碰撞（少数球体，静态但可摧毁以制造“打海怪”的爽感）
    this.addSphereCollider('prop', x, y + 10 * scale, z, 30 * scale, {
      destructible: true, health: 4000, mass: 99999, name: 'Kraken', object: g,
    });
    for (let a = 0; a < 4; a++) {
      const az = (a / 4) * Math.PI * 2 + 0.3;
      this.addSphereCollider('prop', x + Math.cos(az) * 60 * scale, y + 22 * scale, z + Math.sin(az) * 60 * scale, 14 * scale, {
        destructible: false, name: 'Kraken tentacle',
      });
    }
    this._poi('The Kraken', x, y + 46 * scale, z, 'kraken', 120);
    return g;
  }

  // ===========================================================================
  // 浮空 / 空中奇观
  // ===========================================================================

  /** 热气球（会上下浮沉）。 */
  buildBalloon(x, y, z, opts = {}) {
    const R = opts.radius || 11;
    const g = this.group(x, y, z);
    g.name = 'balloon';
    const stripeTex = this._tex.get('balloonStripe' + (opts.style || 0), 128, 128, (ctx, w, h) => {
      const cols = [['#e8503a', '#f7e7c0'], ['#2f8fd8', '#eef7ff'], ['#f2c14e', '#4a2d1a'], ['#6ab04c', '#f3ffe0']][(opts.style || 0) % 4];
      for (let i = 0; i < 12; i++) {
        ctx.fillStyle = cols[i % 2];
        ctx.fillRect((i * w) / 12, 0, w / 12 + 1, h);
      }
      speckle(ctx, w, h, 300, ['#000000'], 0.06, 2);
    }, { clamp: true });
    const envMat = this._mat('balloonEnv' + (opts.style || 0), () => new THREE.MeshStandardMaterial({
      map: stripeTex, color: 0xffffff, roughness: 0.85, metalness: 0.02, side: THREE.DoubleSide,
    }));
    const env = this.sphere(R, envMat, 0, 0, 0, { parent: g });
    env.scale.set(R, R * 1.22, R);
    env.name = 'envelope';
    // 吊篮 + 绳索
    const basket = this.box(R * 0.42, R * 0.34, R * 0.42, this._mats.wood, 0, -R * 1.62, 0, { parent: g });
    basket.name = 'basket';
    const ropes = [];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        ropes.push(new THREE.CylinderGeometry(0.08, 0.08, R * 0.8, 3)
          .translate(sx * R * 0.3, -R * 1.05, sz * R * 0.3));
      }
    }
    this.mergedMesh(ropes, this._mats.metalDark, 'balloon_ropes', g);
    // 燃烧器火焰
    const fMat = this._mats.flameCore.clone();
    this._matsOwned.push(fMat);
    const fl = this.cone(R * 0.22, R * 0.5, fMat, 0, -R * 1.1, 0, { parent: g, seg: 7 });
    this._flames.push({ mesh: fl, base: R * 0.22, phase: this._rng() * 6.28, speed: 11, mat: fMat });
    const spr = new THREE.Sprite(this._mats.sprFlame);
    spr.scale.setScalar(R * 2.4);
    spr.position.set(0, -R * 1.05, 0);
    g.add(spr);
    this._bobbers.push({
      obj: g, colliders: [], baseY: y, amp: 1.6, speed: 0.42,
      phase: this._rng() * 6.28, roll: 0.03, pitch: 0.02,
    });
    this.addSphereCollider('prop', x, y, z, R * 1.1, {
      destructible: true, health: 160, mass: 900, name: 'Hot air balloon', object: g, floating: true,
    });
    this._poi('Hot air balloon', x, y, z, 'balloon', 40);
    return g;
  }

  /** 巨型飞艇（会缓慢浮沉，螺旋桨旋转）。 */
  buildAirship(x, y, z, heading = 0, opts = {}) {
    const R = opts.radius || 26;
    const L = opts.length || 150;
    const g = this.group(x, y, z);
    g.rotation.y = heading;
    g.name = 'airship';
    const hullGeoT = this._G('airshipHull', () => {
      const pts = [];
      for (let i = 0; i <= 14; i++) {
        const t = i / 14;
        const rr = Math.pow(Math.sin(Math.PI * (0.06 + t * 0.88)), 0.7);
        pts.push(new THREE.Vector2(Math.max(0.4, rr), (t - 0.5)));
      }
      const geo = new THREE.LatheGeometry(pts, 18);
      geo.rotateX(-Math.PI / 2);
      return geo;
    });
    const skin = this._mat('airshipSkin', () => new THREE.MeshStandardMaterial({
      color: 0xdfe6ed, roughness: 0.6, metalness: 0.25,
    }));
    const hull = this.mesh(hullGeoT, skin, 0, 0, 0, { sx: R, sy: R, sz: L, parent: g });
    hull.name = 'airship_hull';
    // 尾翼
    for (let i = 0; i < 3; i++) {
      const fin = this.mesh(this._G('unitBox'), this._mats.hullRed, 0, Math.sin(i * 2.1) * R * 0.7, L * 0.42,
        { sx: 1.2, sy: R * 0.9, sz: L * 0.14, parent: g, rz: i * 2.1, ry: i === 2 ? Math.PI / 2 : 0 });
      fin.name = 'fin';
    }
    // 吊舱
    const gon = this.box(9, 7, 26, this._mats.metal, 0, -R * 1.15, 0, { parent: g });
    gon.name = 'gondola';
    this.mesh(this._G('unitBox'), this._mats.glassNeon, 0, -R * 1.15, -12, { sx: 8, sy: 2.4, sz: 2, parent: g });
    // 发动机 + 螺旋桨（旋转）
    for (const sz of [-1, 1]) {
      for (const sx of [-1, 1]) {
        const pod = this.mesh(this._G('unitCyl'), this._mats.metalDark, sx * R * 0.5, -R * 0.5, sz * 22,
          { sx: 2.4, sy: 6, sz: 2.4, parent: g, rz: Math.PI / 2 });
        pod.name = 'engine';
        const prop = this.group(sx * R * 0.5 + sx * 3.2, -R * 0.5, sz * 22, g);
        for (let b = 0; b < 3; b++) {
          this.mesh(this._G('unitBox'), this._mats.metalDark, 0, 0, 0,
            { sx: 0.4, sy: 7, sz: 0.9, parent: prop, rz: (b / 3) * Math.PI * 2 });
        }
        prop.rotation.z = Math.PI / 2;
        this._spinners.push({ obj: prop, axis: 'z', speed: 9 + this._rng() * 3, phase: 0 });
      }
    }
    // 侧面霓虹招牌（挂到飞艇组上）
    const sign = this.buildNeonSign(0, 0, 0, 'SKYPARK', 1.2, {
      ry: -Math.PI / 2, width: 58, height: 13, parent: g, frame: false,
    });
    if (sign) sign.position.set(R * 0.98, 2, 0);
    this._bobbers.push({
      obj: g, colliders: [], baseY: y, amp: 3.2, speed: 0.28,
      phase: this._rng() * 6.28, roll: 0.012, pitch: 0.01,
    });
    this.addCapsuleSpheres('prop', x, y, z, heading, L * 0.38, R * 0.9, {
      destructible: true, health: 2600, mass: 60000, name: 'Airship', object: g,
      floating: true, bobAmp: 3.2, bobSpeed: 0.28, bobRoll: 0.012, bobPitch: 0.01,
    });
    this._poi('Airship', x, y + R, z, 'airship', 120);
    this._anchor('landingPads', 'Airship deck', { x, y: y - R * 1.15, z }, 26);
    this._stats.buildings++;
    return g;
  }

  /** 浮空岛：顶部草皮 + 倒锥形岩体 + 树木。 */
  buildFloatingIsland(x, y, z, size, opts = {}) {
    const g = this.group(x, y, z);
    g.name = 'sky_island';
    const rockMat = this._mat('skyRock', () => new THREE.MeshStandardMaterial({
      map: this._tex.rust(), color: 0x6b6259, roughness: 0.95, metalness: 0.05,
    }));
    const top = this.mesh(this._G('unitCyl'), this._mats.grass, 0, 0, 0, { sx: size, sy: size * 0.16, sz: size, parent: g, seg: 18 });
    top.name = 'island_top';
    // 倒锥岩体
    const under = this._G('skyRock' + Math.round(size), () => {
      const pts = [];
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        const r = size * (1 - t) * (1 - 0.25 * Math.sin(t * 3.1)) + 1;
        pts.push(new THREE.Vector2(Math.max(0.6, r), -t * size * 1.5));
      }
      return new THREE.LatheGeometry(pts, 14);
    });
    this.mesh(under, rockMat, 0, -size * 0.08, 0, { parent: g });
    // 顶部岩石 + 树木
    for (let i = 0; i < 4; i++) {
      const a = this._rng() * 6.28, r = size * (0.3 + this._rng() * 0.6);
      this.mesh(this._G('icosa'), rockMat, Math.cos(a) * r, size * 0.1, Math.sin(a) * r,
        { s: size * (0.06 + this._rng() * 0.08), parent: g, ry: this._rng() * 3 });
    }
    const n = opts.trees === undefined ? 7 : opts.trees;
    if (n > 0) {
      const im = new THREE.InstancedMesh(this._G('treeConifer'), this._mats.treeLeaf, n);
      im.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      im.name = 'island_trees';
      g.add(im);
      this._instanced.push(im);
      for (let i = 0; i < n; i++) {
        const a = this._rng() * 6.28, r = size * (0.15 + this._rng() * 0.6);
        const h = 8 + this._rng() * 12;
        this._tcol.setRGB(0.85 + this._rng() * 0.3, 0.9 + this._rng() * 0.2, 0.85 + this._rng() * 0.3);
        this.setInstance(im, i, Math.cos(a) * r, size * 0.08 - 0.4, Math.sin(a) * r, this._rng() * 6.28, h * 0.9,
          0, this._tcol, h);
      }
      this.finishInstance(im);
    }
    if (opts.pond) {
      this.mesh(this._G('unitCyl'), this._mat('skyWater', () => new THREE.MeshStandardMaterial({
        color: 0x2f7fd0, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.75,
      })), size * 0.28, size * 0.07, 0, { parent: g, seg: 16 });
    }
    if (opts.structures) {
      // 小房子/观景台
      this.box(size * 0.22, size * 0.16, size * 0.22, this._mats.paintWhite, size * 0.3, size * 0.14, size * 0.3, { parent: g });
      this.cone(size * 0.2, size * 0.12, this._mats.hullRed, size * 0.3, size * 0.27, size * 0.3, { parent: g, seg: 8 });
    }
    if (opts.bob !== false) {
      this._bobbers.push({
        obj: g, colliders: [], baseY: y, amp: opts.bob || 1.2, speed: 0.24,
        phase: this._rng() * 6.28, roll: 0.006, pitch: 0.005,
      });
    }
    // 岛顶实际位于圆柱顶面 y + 0.08*size。旧盒体以 y 为中心、高度只有
    // 0.4*size，顶面却高出草坪 0.12*size：出生点按地形放置后会直接埋进盒体，
    // 被机身碰撞弹成“原地爆炸”。碰撞体对齐为顶部岩层，并把真实顶面作为单向
    // 承载面交给起落架；倒锥最深处会和低空地形相交，不能粗暴包成整根大盒子，
    // 否则天空公园地面出生点会被悬岛的虚拟体积从地下弹走。
    const topY = y + size * 0.08;
    const bottomY = y - size * 0.16;
    this.addBoxCollider('rock', x, (topY + bottomY) * 0.5, z, size * 0.92, (topY - bottomY) * 0.5, size * 0.92, {
      destructible: false, name: 'Sky island', object: g, surfaceY: topY, oneWayTop: true,
    });
    this._anchor('landingPads', opts.name || 'Sky island', { x, y: topY, z }, Math.max(14, size * 0.6));
    if (opts.poi !== false) this._poi(opts.name || 'Sky island', x, y + size * 0.3, z, 'island', size * 0.8);
    return g;
  }

  /** 云门（大圆环 + 云团，可作竞速门）。 */
  buildCloudGate(x, y, z, r = 60, opts = {}) {
    const g = this.group(x, y, z);
    g.rotation.y = opts.ry || 0;
    g.name = 'cloud_gate';
    const cloudMat = this._mat('cloud', () => new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1.0, metalness: 0.0, transparent: true, opacity: 0.62,
      depthWrite: false,
    }));
    const ring = this.mesh(this._G('torus' + Math.round(r), () => new THREE.TorusGeometry(1, 0.09, 8, 28)),
      cloudMat, 0, 0, 0, { s: r, parent: g });
    ring.name = 'cloud_ring';
    // 云团（合并减少 draw call）
    const puffs = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const rr = r * (0.98 + this._rng() * 0.16);
      puffs.push({
        geo: new THREE.SphereGeometry(1, 6, 5),
        matrix: mat4(Math.cos(a) * rr, Math.sin(a) * rr, (this._rng() - 0.5) * r * 0.18, 0, 0, 0,
          r * (0.1 + this._rng() * 0.1), r * (0.08 + this._rng() * 0.08), r * (0.1 + this._rng() * 0.12)),
        color: 0xffffff,
      });
    }
    const puffMesh = new THREE.Mesh(mergeGeos(puffs), cloudMat);
    puffMesh.name = 'cloud_puffs';
    g.add(puffMesh);
    this.addSphereCollider('gate', x, y, z, r * 0.9, {
      sensor: true, name: opts.name || 'Cloud gate', object: g,
    });
    this._anchor('checkpoints', opts.name || 'Cloud gate', { x, y, z }, r);
    return g;
  }

  // ===========================================================================
  // 冰雪 / 荒漠 / 废土 / 城市专用设施
  // ===========================================================================

  /** 冰屋（半球 + 门洞）。 */
  buildIgloo(x, z, r = 9, ry = 0) {
    const y = this._heightAt(x, z);
    const g = this.group(x, y, z);
    g.rotation.y = ry;
    g.name = 'igloo';
    const iceMat = this._mat('iglooIce', () => new THREE.MeshStandardMaterial({
      map: this._tex.ice(), color: 0xf2fbff, roughness: 0.45, metalness: 0.05,
    }));
    const dome = this.mesh(this._G('dome'), iceMat, 0, 0, 0, { sx: r, sy: r * 0.8, sz: r, parent: g });
    dome.name = 'igloo_dome';
    const door = this.cyl(r * 0.22, r * 0.24, r * 0.7, this._mats.wreck, 0, r * 0.2, -r * 0.82,
      { parent: g, seg: 10, rx: Math.PI / 2 });
    door.name = 'igloo_door';
    this.cyl(0.6, 0.7, r * 0.8, this._mats.wreck, r * 0.5, r * 0.85, 0, { parent: g, seg: 6 });
    this.addSphereCollider('rock', x, y + r * 0.35, z, r * 0.85, {
      destructible: true, health: 300, mass: 4000, name: 'Igloo', object: dome,
    });
    return g;
  }

  /** 雷达穹顶（雪原/基地）：半球罩 + 旋转天线。 */
  buildRadarDome(x, z, opts = {}) {
    const y = opts.y !== undefined ? opts.y : this._heightAt(x, z);
    const r = opts.radius || 16;
    const g = this.group(x, y, z);
    g.name = 'radar_dome';
    this.box(r * 2.6, 2.4, r * 2.6, this._mats.concreteDark, 0, 1.2, 0, { parent: g });
    const dome = this.mesh(this._G('dome'), this._mat('domeMat', () => new THREE.MeshStandardMaterial({
      map: this._tex.metal(), color: 0xdfe9f2, roughness: 0.55, metalness: 0.25,
    })), 0, 2.4, 0, { sx: r, sy: r * 0.82, sz: r, parent: g });
    dome.name = 'dome';
    // 罩内旋转天线（半透明罩下可见）
    const head = this.group(0, 3.4, 0, g);
    const dish = this.mesh(this._G('dish'), this._mats.metal, 0, r * 0.35, 0, { s: r * 0.42, parent: head });
    dish.rotation.x = 0.5;
    this._spinners.push({ obj: head, axis: 'y', speed: 0.5, phase: 0 });
    this.sphere(1.2, this._mats.beaconRed, 0, r * 0.9 + 2.4, 0, { parent: g });
    this.addSphereCollider('tower', x, y + r * 0.4, z, r * 0.95, {
      destructible: true, health: 900, mass: 20000, name: opts.name || 'Radar dome', object: dome,
    });
    this._poi(opts.name || 'Radar dome', x, y + r, z, 'radar', r * 2);
    return g;
  }

  /** 单独摆放的坠机残骸（可摧毁）。 */
  buildWreckPlane(x, y, z, ry = 0, scale = 1, opts = {}) {
    const g = this.group(x, y, z);
    g.rotation.y = ry;
    g.rotation.z = (this._rng() - 0.5) * 0.7;
    g.rotation.x = (this._rng() - 0.5) * 0.25;
    g.name = 'wreck_plane';
    const body = this.mesh(this._G('wreckCraft'), this._rng() < 0.5 ? this._mats.scrap : this._mats.rust,
      0, opts.buried ? -1.6 : 0, 0, { s: scale, parent: g });
    body.name = 'wreck_body';
    if (opts.collider !== false) {
      this.addBoxCollider('prop', x, y + 2 * scale, z, 8 * scale, 2.4 * scale, 4 * scale, {
        destructible: true, health: 240, mass: 5000, name: 'Aircraft wreck', object: body,
      });
    }
    return g;
  }

  /** 起重机（可旋转，用于飞机坟场/码头）。 */
  buildCrane(x, z, opts = {}) {
    const y = opts.y !== undefined ? opts.y : this._heightAt(x, z);
    const h = opts.height || 34;
    const g = this.group(x, y, z);
    g.name = 'crane';
    const tower = this.box(9, h, 9, this._mats.paintYellow, 0, h / 2, 0, { parent: g });
    tower.name = 'crane_tower';
    const jib = this.group(0, h, 0, g);
    this.box(46, 2.4, 3, this._mats.paintYellow, 12, 0, 0, { parent: jib });
    this.box(3, 2.4, 16, this._mats.paintYellow, -12, 0, 0, { parent: jib });
    this.cyl(0.4, 0.4, 14, this._mats.metalDark, 20, -7, 0, { parent: jib, seg: 5 });
    this.box(3, 2, 3, this._mats.metalDark, 20, -14, 0, { parent: jib });
    this._spinners.push({ obj: jib, axis: 'y', speed: opts.speed || 0.18, phase: this._rng() * 6.28 });
    this.addBoxCollider('prop', x, y + h / 2, z, 4.5, h / 2, 4.5, {
      destructible: true, health: 600, mass: 30000, name: 'Crane', object: tower,
    });
    return g;
  }

  /** 铁丝网围栏：实例化立柱 + 线缆。 */
  buildFence(pts, opts = {}) {
    if (!pts || pts.length < 2) return null;
    const spacing = opts.spacing || 7;
    const postPts = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = Array.isArray(pts[i]) ? { x: pts[i][0], z: pts[i][1] } : pts[i];
      const b = Array.isArray(pts[i + 1]) ? { x: pts[i + 1][0], z: pts[i + 1][1] } : pts[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const dl = Math.hypot(dx, dz);
      const n = Math.max(1, Math.round(dl / spacing));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        postPts.push({ x: a.x + dx * t, z: a.z + dz * t });
      }
    }
    postPts.push(Array.isArray(pts[pts.length - 1])
      ? { x: pts[pts.length - 1][0], z: pts[pts.length - 1][1] } : pts[pts.length - 1]);
    const im = this.instance('fencePost', this._mats.treeLeaf, postPts.length, { name: 'fence_posts' });
    const ys = [];
    for (let i = 0; i < postPts.length; i++) {
      const p = postPts[i];
      const y = this._heightAt(p.x, p.z);
      ys.push(y);
      this.setInstance(im, i, p.x, y - 0.2, p.z, 0, 1, 0, undefined, opts.tall ? 1.4 : 1);
    }
    this.finishInstance(im);
    // 线缆（4 道 + 斜向刺铁丝）
    const verts = [];
    for (let i = 0; i < postPts.length - 1; i++) {
      const a = postPts[i], b = postPts[i + 1];
      const ya = ys[i], yb = ys[i + 1];
      for (const hh of [0.9, 1.7, 2.5, 3.0]) {
        verts.push(a.x, ya + hh, a.z, b.x, yb + hh, b.z);
      }
      verts.push(a.x, ya + 0.9, a.z, b.x, yb + 2.9, b.z);
      verts.push(a.x, ya + 2.9, a.z, b.x, yb + 0.9, b.z);
    }
    if (verts.length) {
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      const lm = new THREE.LineBasicMaterial({ color: 0x6a6f76 });
      this._matsOwned.push(lm);
      const lines = new THREE.LineSegments(lg, lm);
      lines.name = 'fence_wire';
      this.root.add(lines);
    }
    return im;
  }

  /** 集装箱迷宫（实例化 + 少量碰撞体）。 */
  buildContainerYard(x, z, opts = {}) {
    const rows = opts.rows || 7;
    const cols = opts.cols || 7;
    const gap = opts.gap || 26;
    const y = opts.y !== undefined ? opts.y : this._heightAt(x, z);
    const cGeo = this._G('containerGeo', () => {
      const g = new THREE.BoxGeometry(1, 1, 1);
      return g;
    });
    const tints = [0xd94f3d, 0x3d7fd9, 0xd9a83d, 0x46a04a, 0xb8bcc2, 0x8a5ad9, 0xd95a9e];
    const maxN = rows * cols * 3;
    const im = this.instance(cGeo, this._mat('containerMat', () => new THREE.MeshStandardMaterial({
      map: this._tex.container(), color: 0xffffff, roughness: 0.7, metalness: 0.35,
    })), maxN, { name: 'containers' });
    let n = 0;
    let colliders = 0;
    const maxCol = opts.colliders === undefined ? 26 : opts.colliders;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (this._rng() < 0.22) continue;
        const stack = 1 + Math.floor(this._rng() * 3);
        const ry = (this._rng() < 0.25 ? Math.PI / 2 : 0) + (this._rng() - 0.5) * 0.06;
        const cx = x + (c - cols / 2) * gap + (this._rng() - 0.5) * 2;
        const cz = z + (r - rows / 2) * gap + (this._rng() - 0.5) * 2;
        const cy = this._heightAt(cx, cz);
        for (let s = 0; s < stack; s++) {
          if (n >= maxN) break;
          this.setInstanceXYZ(im, n, cx, cy + 1.35 + s * 2.9, cz, ry, 12, 2.8, 2.6, 0, tints[(r + c + s) % tints.length]);
          n++;
        }
        if (colliders < maxCol && stack >= 2) {
          colliders++;
          const rot90 = Math.abs(Math.sin(ry)) > 0.7;
          this.addBoxCollider('prop', cx, cy + stack * 1.45, cz,
            rot90 ? 1.6 : 6.4, stack * 1.45, rot90 ? 6.4 : 1.6, {
              destructible: true, health: 120 * stack, mass: 2000 * stack,
              name: 'Container stack', object: null,
            });
        }
      }
    }
    im.count = n;
    this.finishInstance(im);
    this._anchor('cargo', opts.name || 'Container yard', { x, y: y + 3, z }, Math.max(40, gap * 1.5));
    this._poi(opts.name || 'Container yard', x, y + 8, z, 'cargo', gap * 2);
    return im;
  }

  /** 废料堆（实例化碎片）。 */
  buildScrapPile(x, z, r = 22, count = 60, y) {
    const yy = y !== undefined ? y : this._heightAt(x, z);
    const debris = this._G('debrisGeo', () => mergeGeos([
      { geo: new THREE.BoxGeometry(1, 0.3, 0.6), matrix: mat4(0, 0, 0), color: 0x9aa0a8 },
      { geo: new THREE.CylinderGeometry(0.12, 0.12, 1.6, 5), matrix: mat4(0, 0.2, 0, 0, 0, Math.PI / 2), color: 0x7c828a },
      { geo: new THREE.BoxGeometry(0.5, 0.5, 0.5), matrix: mat4(0.4, 0.1, 0.2, 0.4, 0.6, 0.2), color: 0x8a9098 },
    ]));
    const mat = this._mat('debrisMat', () => new THREE.MeshStandardMaterial({
      vertexColors: true, map: this._tex.rust(), roughness: 0.92, metalness: 0.4,
    }));
    const im = this.instance(debris, mat, count, { name: 'scrap' });
    for (let i = 0; i < count; i++) {
      const a = this._rng() * 6.28;
      const rr = Math.sqrt(this._rng()) * r;
      const px = x + Math.cos(a) * rr, pz = z + Math.sin(a) * rr;
      const t = clamp(1 - rr / r, 0, 1);
      this.setInstance(im, i, px, this._heightAt(px, pz) + t * r * 0.14, pz, this._rng() * 6.28,
        2 + this._rng() * 3, (this._rng() - 0.5) * 0.5);
    }
    this.finishInstance(im);
    this.addSphereCollider('rock', x, yy + r * 0.1, z, r * 0.7, {
      destructible: true, health: 400, mass: 15000, name: 'Scrap pile', object: im,
    });
    return im;
  }

  /** 体育场（椭圆看台 + 草皮 + 灯塔）。 */
  buildStadium(x, z, opts = {}) {
    const y = opts.y !== undefined ? opts.y : this._heightAt(x, z);
    const R = opts.radius || 150;
    const g = this.group(x, y, z);
    g.name = 'stadium';
    // 场地
    const pitch = this.mesh(this._G('unitCyl'), this._mats.grass, 0, 0.4, 0, { sx: R * 0.62, sy: 0.8, sz: R * 0.44, parent: g, seg: 22 });
    pitch.name = 'pitch';
    this.mesh(this._G('unitBox'), this._mats.paintWhite, 0, 0.85, 0, { sx: R * 0.9, sy: 0.06, sz: 0.7, parent: g });
    // 看台：两圈错台
    for (let tier = 0; tier < 3; tier++) {
      const rr = R * (0.72 + tier * 0.11);
      const hh = 6 + tier * 6;
      const stand = this.mesh(this._G('unitCyl'),
        this._mat('stand' + tier, () => new THREE.MeshStandardMaterial({
          map: this._tex.concrete(), color: tier % 2 ? 0xb9bec4 : 0x9aa0a6, roughness: 0.9,
        })), 0, 1 + tier * 6, 0, { sx: rr, sy: hh, sz: rr * 0.72, parent: g, seg: 30 });
      stand.name = 'stand';
    }
    // 顶棚环
    this.mesh(this._G('unitCyl'), this._mats.paintWhite, 0, 21, 0, { sx: R * 1.02, sy: 1.2, sz: R * 0.76, parent: g, seg: 30 });
    // 灯塔 ×4
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const px = Math.cos(a) * R * 1.02, pz = Math.sin(a) * R * 0.76;
      this.cyl(0.8, 1.1, 34, this._mats.metal, px, 17, pz, { parent: g, seg: 6 });
      const lamp = this.box(9, 4, 1.4, this._mats.lampGlowCool, px, 34, pz, { parent: g, ry: -a });
      lamp.name = 'floodlight';
      this.addSphereCollider('tower', x + px, y + 17, z + pz, 2.2, {
        destructible: true, health: 300, mass: 6000, name: 'Floodlight mast', object: lamp,
      });
    }
    this.addBoxCollider('building', x, y + 10, z, R * 1.05, 11, R * 0.8, {
      destructible: false, name: 'Stadium', object: g,
    });
    this._poi('Stadium', x, y + 24, z, 'stadium', R * 1.1);
    this._anchor('landingPads', 'Stadium pitch', { x, y: y + 2, z }, R * 0.4);
    this._anchor('dropzones', 'Stadium', { x, y: y + 60, z }, R * 0.9);
    this._stats.buildings += 3;
    if (this._lights < 3) {
      const l = new THREE.PointLight(0xd8f0ff, 700, R * 3, 2);
      l.position.set(x, y + 36, z);
      this.addLight(l);
    }
    return g;
  }

  /** 楼顶/地面直升机坪（黄色 H）。 */
  buildHelipad(x, y, z, opts = {}) {
    const parent = opts.parent || this.root;
    const r = opts.radius || 12;
    const padGeo = this._G('helipadGeo' + Math.round(r), () => new THREE.CylinderGeometry(1, 1, 0.35, 22));
    const mat = this._mat('helipadMat', () => new THREE.MeshStandardMaterial({
      map: this._tex.get('helipadTex', 256, 256, (ctx, w, h) => {
        ctx.fillStyle = '#3a3f45'; ctx.fillRect(0, 0, w, h);
        speckle(ctx, w, h, 1200, ['#565b62', '#22252a'], 0.25, 2);
        ctx.strokeStyle = '#f2c14e'; ctx.lineWidth = 14;
        ctx.beginPath(); ctx.arc(w / 2, h / 2, w * 0.4, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#f2c14e';
        ctx.fillRect(w * 0.32, h * 0.3, 16, h * 0.4);
        ctx.fillRect(w * 0.6, h * 0.3, 16, h * 0.4);
        ctx.fillRect(w * 0.32, h * 0.46, w * 0.28 + 16, 16);
      }, { clamp: true }),
      color: 0xffffff, roughness: 0.85, metalness: 0.05,
    }));
    const pad = this.mesh(padGeo, mat, x, y + 0.2, z, { sx: r, sz: r, parent });
    pad.name = 'helipad';
    // 边灯（自发光小球）
    const lights = [];
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      lights.push({ geo: new THREE.SphereGeometry(0.5, 6, 5), matrix: mat4(x + Math.cos(a) * r * 0.95, y + 0.5, z + Math.sin(a) * r * 0.95), color: 0xffffff });
    }
    const lm = new THREE.Mesh(mergeGeos(lights), this._mats.lampGlow);
    lm.name = 'helipad_lights';
    (opts.parent || this.root).add(lm);
    if (opts.anchor !== false) {
      this._anchor('landingPads', opts.name || 'Helipad', { x, y: y + 1, z }, r);
    }
    return pad;
  }

  /** 高架路（固定高度 + 桥墩）。 */
  buildElevatedRoad(pts, opts = {}) {
    const alt = opts.altitude !== undefined ? opts.altitude : this._heightAt(pts[0][0], pts[0][1]) + 18;
    const width = opts.width || 24;
    const g = this.ribbonGeometry(pts, width, { altitude: alt, uvScale: 9, closed: !!opts.closed });
    const deck = new THREE.Mesh(g, this._mats.asphalt);
    deck.name = 'elevated_road';
    this.root.add(deck);
    this._stats.roads++;
    // 桥墩 + 护栏
    const pillars = [];
    const rails = [];
    const P = pts.map((p) => (Array.isArray(p) ? { x: p[0], z: p[1] } : p));
    const segmentCount = opts.closed ? P.length : P.length - 1;
    for (let i = 0; i < segmentCount; i++) {
      const a = P[i];
      const next = P[(i + 1) % P.length];
      const dx = next.x - a.x, dz = next.z - a.z;
      const dl = Math.hypot(dx, dz) || 1;
      const nx = -dz / dl, nz = dx / dl;
      const mx = (a.x + next.x) / 2, mz = (a.z + next.z) / 2;
      const ground = this._heightAt(mx, mz);
      const ph = Math.max(2, alt - ground);
      pillars.push(new THREE.CylinderGeometry(2.6, 3.4, ph, 8).translate(mx, ground + ph / 2, mz));
      const ang = Math.atan2(dx, dz);
      for (const side of [-1, 1]) {
        const rx = mx + nx * side * (width / 2 - 0.8), rz = mz + nz * side * (width / 2 - 0.8);
        const rg = new THREE.BoxGeometry(0.5, 1.6, dl + 0.5);
        rg.applyMatrix4(mat4(0, 0, 0, 0, ang, 0));
        rg.translate(rx, alt + 1.4, rz);
        rails.push(rg);
      }
    }
    this.mergedMesh(pillars, this._mats.concreteDark, 'viaduct_pillars');
    this.mergedMesh(rails, this._mats.paintWhite, 'viaduct_rails');
    // 每个路段一个朝向正确的薄盒；旧版沿世界 Z 放置长 AABB，弯道处会漏碰撞。
    for (let i = 0; i < segmentCount; i++) {
      const a = P[i], b = P[(i + 1) % P.length];
      const dx = b.x - a.x, dz = b.z - a.z;
      const length = Math.hypot(dx, dz);
      if (length < 1e-3) continue;
      this.addBoxCollider('prop', (a.x + b.x) * 0.5, alt - 0.8, (a.z + b.z) * 0.5,
        width / 2, 0.8, length / 2 + 0.75, {
          destructible: false, name: 'Viaduct', heading: Math.atan2(dx, dz), oriented: true, surfaceY: alt,
        });
    }
    return deck;
  }

  /** 金字塔 + 方尖碑 + 遗迹柱。 */
  buildPyramid(x, z, size = 90, ry = 0) {
    const y = this._heightAt(x, z);
    const g = this.group(x, y, z);
    g.rotation.y = ry;
    g.name = 'pyramid';
    const stone = this._mat('sandstone', () => new THREE.MeshStandardMaterial({
      map: this._tex.sand(), color: 0xe0c48c, roughness: 0.95, metalness: 0.02,
    }));
    const main = this.mesh(this._G('unitCone4'), stone, 0, size * 0.3, 0,
      { sx: size * 0.5, sy: size * 0.6, sz: size * 0.5, parent: g, ry: Math.PI / 4 });
    main.name = 'pyramid_main';
    // 分层（台阶感）
    for (let i = 1; i <= 4; i++) {
      const t = i / 5;
      this.mesh(this._G('unitCone4'), stone, 0, size * 0.6 * (1 - t) * 0.5 + size * 0.3, 0,
        { sx: size * 0.5 * (1 - t * 0.9), sy: size * 0.6 * (1 - t * 0.9), sz: size * 0.5 * (1 - t * 0.9), parent: g, ry: Math.PI / 4 });
    }
    // 金字塔碰撞：球近似
    this.addSphereCollider('rock', x, y + size * 0.22, z, size * 0.55, {
      destructible: false, name: 'Pyramid', object: main,
    });
    this._poi('Pyramid', x, y + size * 0.55, z, 'pyramid', size);
    return g;
  }

  /** 遗迹柱廊。 */
  buildRuins(x, z, r = 60, count = 14) {
    const y = this._heightAt(x, z);
    const im = this.instance(this._G('unitCyl'), this._mat('sandstone', () => new THREE.MeshStandardMaterial({
      map: this._tex.sand(), color: 0xe0c48c, roughness: 0.95, metalness: 0.02,
    })), count, { name: 'ruins_columns' });
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const rr = r * (0.8 + this._rng() * 0.3);
      const px = x + Math.cos(a) * rr, pz = z + Math.sin(a) * rr;
      const h = 10 + this._rng() * 14;
      this.setInstance(im, i, px, this._heightAt(px, pz) + h / 2 - 1, pz, this._rng() * 6.28, 1.6,
        (this._rng() - 0.5) * 0.12, 0xffffff, h);
      if (i % 3 === 0) {
        this.addBoxCollider('prop', px, this._heightAt(px, pz) + h / 2, pz, 1.8, h / 2, 1.8, {
          destructible: true, health: 260, mass: 8000, name: 'Ancient column',
        });
      }
    }
    this.finishInstance(im);
    // 倒下的柱子
    for (let i = 0; i < 5; i++) {
      const a = this._rng() * 6.28, rr = r * (0.3 + this._rng() * 0.6);
      const px = x + Math.cos(a) * rr, pz = z + Math.sin(a) * rr;
      this.cyl(1.6, 1.6, 14 + this._rng() * 8, this._mats.sand, px, this._heightAt(px, pz) + 1.6, pz,
        { seg: 12, rz: Math.PI / 2, ry: this._rng() * 3 });
    }
    this._poi('Ancient ruins', x, y + 10, z, 'ruins', r);
    return im;
  }

  /** 绿洲（浅水 + 棕榈）。 */
  buildOasis(x, z, r = 60) {
    const y = this._heightAt(x, z);
    const g = this.group(x, y, z);
    g.name = 'oasis';
    const water = this.mesh(this._G('unitCyl'), this._mat('oasisWater', () => new THREE.MeshStandardMaterial({
      color: 0x2f9fd0, roughness: 0.08, metalness: 0.35, transparent: true, opacity: 0.82,
    })), 0, 0.6, 0, { sx: r, sy: 1.2, sz: r * 0.7, parent: g, seg: 20 });
    water.name = 'oasis_water';
    // 棕榈
    const n = 9;
    const im = new THREE.InstancedMesh(this._G('treePalm'), this._mats.treeLeaf, n);
    im.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    im.name = 'oasis_palms';
    g.add(im);
    this._instanced.push(im);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + this._rng();
      const rr = r * (1.15 + this._rng() * 0.35);
      const h = 12 + this._rng() * 6;
      this.setInstance(im, i, Math.cos(a) * rr, -0.3, Math.sin(a) * rr * 0.72, this._rng() * 6.28, h * 0.85, 0, undefined, h);
    }
    this.finishInstance(im);
    this._poi('Oasis', x, y + 6, z, 'oasis', r);
    this._anchor('landingPads', 'Oasis shore', { x: x + r * 1.4, y: y + 2, z }, 24);
    return g;
  }

  /** 沙漠平顶房（土黄色）。 */
  buildDesertHouse(x, z, w = 16, d = 14, h = 7, ry = 0) {
    const y = this._heightAt(x, z);
    const g = this.group(x, y, z);
    g.rotation.y = ry;
    g.name = 'desert_house';
    const mud = this._mat('mud', () => new THREE.MeshStandardMaterial({
      map: this._tex.sand(), color: 0xc9a06a, roughness: 0.96, metalness: 0.0,
    }));
    const body = this.box(w, h, d, mud, 0, h / 2, 0, { parent: g });
    body.name = 'house';
    // 穹顶 / 女儿墙
    if (this._rng() < 0.55) {
      this.mesh(this._G('dome'), mud, w * 0.2, h, d * 0.15, { sx: w * 0.22, sy: w * 0.2, sz: w * 0.22, parent: g });
    } else {
      this.box(w + 0.8, 1.4, d + 0.8, mud, 0, h + 0.7, 0, { parent: g });
    }
    // 门 + 小窗
    this.mesh(this._G('unitPlane'), this._mats.wreck, 0, h * 0.35, -d / 2 - 0.06, { sx: 3, sy: 4.4, parent: g });
    for (const side of [-1, 1]) {
      this.mesh(this._G('unitPlane'), this._mats.glassNeon, side * w * 0.3, h * 0.62, -d / 2 - 0.06,
        { sx: 1.6, sy: 1.6, parent: g });
    }
    // 木杆遮阳
    this.cyl(0.16, 0.16, 5, this._mats.wood, w * 0.4, 2.5, -d * 0.6, { parent: g, seg: 6 });
    this.box(w * 0.5, 0.2, d * 0.4, this._mats.wood, w * 0.4, 5, -d * 0.6, { parent: g });
    this._stats.buildings++;
    this.addBoxCollider('building', x, y + h / 2, z, w / 2, h / 2, d / 2, {
      destructible: true, health: 260, mass: w * d * h * 1.8, name: 'Desert house', object: body, ry,
    });
    return g;
  }

  /** 浮冰群（雪原/冰海）。 */
  buildIceField(x, z, r = 400, count = 26) {
    const im = this.instance(this._G('iceBerg', () => mergeGeos([
      { geo: new THREE.IcosahedronGeometry(1, 0), matrix: mat4(0, 0, 0, 0, 0, 0, 1, 0.5, 1), color: 0xffffff },
      { geo: new THREE.ConeGeometry(0.5, 0.9, 5), matrix: mat4(0.2, 0.5, 0.1, 0.3, 0.4, 0.2), color: 0xf2fbff },
    ])), this._mat('iceMat', () => new THREE.MeshStandardMaterial({
      vertexColors: true, map: this._tex.ice(), roughness: 0.3, metalness: 0.05,
    })), count, { name: 'ice_floes' });
    for (let i = 0; i < count; i++) {
      const a = this._rng() * 6.28, rr = Math.sqrt(this._rng()) * r;
      const px = x + Math.cos(a) * rr, pz = z + Math.sin(a) * rr;
      this.setInstance(im, i, px, this.seaLevel - 1.5, pz, this._rng() * 6.28, 14 + this._rng() * 40,
        (this._rng() - 0.5) * 0.2);
    }
    this.finishInstance(im);
    return im;
  }

  // ===========================================================================
  // 赛道 / 竞速圆环 / 收集物（kit 共用）
  // ===========================================================================

  /** 折线加密：长直线段会穿山，按 step 米插值，让道路贴合地形。 */
  _densify(pts, step = 90) {
    if (!pts || pts.length < 2) return pts || [];
    const P = pts.map((p) => (Array.isArray(p) ? { x: p[0], z: p[1] } : { x: p.x, z: p.z }));
    const out = [P[0]];
    for (let i = 1; i < P.length; i++) {
      const a = P[i - 1], b = P[i];
      const dl = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.max(1, Math.ceil(dl / step));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        out.push({ x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t) });
      }
    }
    return out;
  }

  /** 偏移折线（用于赛道红白路缘）。 */
  _offsetPolyline(pts, d) {
    const n = pts.length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
      let dx = b[0] - a[0], dz = b[1] - a[1];
      const dl = Math.hypot(dx, dz) || 1;
      dx /= dl; dz /= dl;
      out.push([pts[i][0] - dz * d, pts[i][1] + dx * d]);
    }
    return out;
  }

  /**
   * 生成一条有序闭合的空中竞速环赛道（环半径默认 35m，环面垂直于飞行方向）。
   * @param {number} cx @param {number} cz 环路中心
   */
  makeAirCircuit(cx, cz, radius, opts = {}) {
    const count = opts.count || 12;
    const alt0 = opts.altitude !== undefined ? opts.altitude : this.seaLevel + 220;
    const variance = opts.variance !== undefined ? opts.variance : 90;
    let pts = opts.points || null;
    if (!pts) {
      pts = [];
      const n = Math.max(6, Math.round(count * 0.75));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const rr = radius * (0.8 + 0.22 * Math.sin(a * 2.3 + 1.1));
        const alt = alt0 + Math.sin(a * 1.7 + 0.6) * variance + Math.cos(a * 3.1) * variance * 0.45;
        pts.push([cx + Math.cos(a) * rr, alt, cz + Math.sin(a) * rr]);
      }
    }
    return this.makeRingCircuit(pts, count, opts.ringRadius || 35);
  }

  /** 地面赛道：闭环沥青 + 红白路缘 + 看台 + 起点龙门架 + 塔台 + 护栏。 */
  buildRaceTrack(cx, cz, opts = {}) {
    const baseY = opts.y !== undefined ? opts.y : this._heightAt(cx, cz);
    const A = opts.a || 620, B = opts.b || 400, width = opts.width || 26;
    const n = opts.segments || 34;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      const wob = 1 + 0.15 * Math.sin(t * 3 + 0.4) + 0.07 * Math.cos(t * 5 + 1.2);
      pts.push([cx + Math.cos(t) * A * wob, cz + Math.sin(t) * B * wob]);
    }
    this._reserve(cx, cz, Math.max(A, B) * 0.75);

    // 沥青主路
    const road = this.ribbon(pts, width, this._mats.asphalt,
      { lift: 0.2, uvScale: 10, closed: true, name: 'race_track' });
    // 红白路缘（内外两侧）
    const curbMat = this._mats.hazard;
    this.ribbon(this._offsetPolyline(pts, width / 2 + 1.4), 2.6, curbMat,
      { lift: 0.26, uvScale: 5, closed: true, name: 'curb_outer' });
    this.ribbon(this._offsetPolyline(pts, -(width / 2 + 1.4)), 2.6, curbMat,
      { lift: 0.26, uvScale: 5, closed: true, name: 'curb_inner' });
    // 维修通道
    this.ribbon(this._offsetPolyline(pts, -(width / 2 + 16)), 11, this._mats.concrete,
      { lift: 0.18, uvScale: 8, closed: true, name: 'pit_lane' });

    // 护栏（实例化）
    const outer = this._offsetPolyline(pts, width / 2 + 7);
    const im = this.instance('unitBox', this._mat('barrier', () => new THREE.MeshStandardMaterial({
      map: this._tex.hazard('#e03a3a', '#f2f2f2'), color: 0xffffff, roughness: 0.7,
    })), outer.length, { name: 'track_barriers' });
    for (let i = 0; i < outer.length; i++) {
      const p = outer[i];
      this.setInstance(im, i, p[0], this._heightAt(p[0], p[1]) + 0.7, p[1],
        Math.atan2(outer[(i + 1) % outer.length][0] - outer[(i - 1 + outer.length) % outer.length][0],
          outer[(i + 1) % outer.length][1] - outer[(i - 1 + outer.length) % outer.length][1]),
        1.2, 0, undefined, 1.4);
    }
    this.finishInstance(im);

    // 起点/终点线（黑白格）
    const checker = this._mat('checker', () => new THREE.MeshStandardMaterial({
      map: this._tex.get('checker', 64, 64, (ctx, w, h) => {
        const s = 8;
        for (let y = 0; y < h; y += s) {
          for (let x = 0; x < w; x += s) {
            ctx.fillStyle = ((x / s + y / s) % 2) ? '#f2f2f2' : '#141414';
            ctx.fillRect(x, y, s, s);
          }
        }
      }, { clamp: false }),
      color: 0xffffff, roughness: 0.8,
    }));
    const s0 = pts[0];
    const s1 = pts[1];
    const lineAng = Math.atan2(s1[1] - s0[1], s1[0] - s0[0]);
    const across = Math.PI / 2 - lineAng;   // 使局部 X 横跨赛道
    const startLine = this.plane(width, 6, checker, s0[0], this._heightAt(s0[0], s0[1]) + 0.3, s0[1],
      { ry: across, rx: -Math.PI / 2 });
    startLine.name = 'start_line';

    // 起点龙门架
    const gantry = this.group(s0[0], baseY, s0[1]);
    gantry.rotation.y = across;
    gantry.name = 'start_gantry';
    for (const side of [-1, 1]) {
      this.box(2.2, 16, 2.2, this._mats.metalDark, side * (width / 2 + 1), 8, 0, { parent: gantry });
      this.addBoxCollider('tower', s0[0] + Math.cos(across) * side * (width / 2 + 1),
        baseY + 8, s0[1] - Math.sin(across) * side * (width / 2 + 1), 2, 8, 2, {
          destructible: true, health: 400, mass: 4000, name: 'Gantry pylon',
        });
    }
    this.box(width + 6, 3, 2.6, this._mats.metalDark, 0, 16.5, 0, { parent: gantry });
    this.buildNeonSign(0, 16.5, -1.6, 'RACE', 1.5, { parent: gantry, width: 24, height: 5.5 });
    this.buildNeonSign(0, 16.5, 1.6, 'RACE', 1.5, { parent: gantry, width: 24, height: 5.5, ry: Math.PI });
    this._anchor('checkpoints', 'Start / Finish', { x: s0[0], y: baseY + 6, z: s0[1] }, 40);

    // 看台（三处）+ 人群（世界坐标写入同一个实例网格）
    const crowd = this.instance('unitBox', this._mat('crowd', () => new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.9, metalness: 0.0,
    })), 420, { name: 'crowd' });
    const tints = [0xffd166, 0xef476f, 0x06d6a0, 0x118ab2, 0xffffff, 0xff9f43, 0x8338ec];
    let ci = 0;
    for (let s = 0; s < 3; s++) {
      const idx = Math.floor((s + 0.5) * (pts.length / 3));
      const p = pts[idx % pts.length];
      const q = pts[(idx + 1) % pts.length];
      const ang = Math.atan2(q[1] - p[1], q[0] - p[0]);
      const nx = -Math.sin(ang), nz = Math.cos(ang);          // 赛道外法线
      const gx = p[0] + nx * (width / 2 + 34);
      const gz = p[1] + nz * (width / 2 + 34);
      const gy = this._heightAt(gx, gz);
      const stand = this.group(gx, gy, gz);
      stand.rotation.y = ang;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      for (let tier = 0; tier < 4; tier++) {
        this.box(70, 3, 7, this._mats.concreteDark, 0, 2 + tier * 3, tier * 6, { parent: stand });
        for (let k = 0; k < 34; k++) {
          if (ci >= 420) break;
          const lx = this._rng() * 66 - 33;
          const lz = tier * 6 - 1;
          // 局部 -> 世界（绕 Y 旋转 ang）
          this.setInstance(crowd, ci, gx + lx * ca + lz * sa, gy + 4 + tier * 3, gz - lx * sa + lz * ca,
            ang, 0.55, 0, tints[(ci + tier) % tints.length], 0.9);
          ci++;
        }
      }
      this.addBoxCollider('building', gx, gy + 6, gz, 36, 7, 14, {
        destructible: false, name: 'Grandstand', object: stand,
      });
    }
    crowd.count = ci;
    this.finishInstance(crowd);

    // 控制塔 + 维修楼
    const tp = pts[Math.floor(pts.length * 0.06)];
    this.buildControlTower(tp[0] + 60, this._heightAt(tp[0] + 60, tp[1] + 60), tp[1] + 60, 34);
    this.box(60, 10, 22, this._mats.paintWhite, cx, baseY + 5, cz + 40, {});
    this._anchor('landingPads', 'Pit lane', { x: cx, y: baseY + 2, z: cz + 40 }, 34);
    this._anchor('dropzones', 'Race track', { x: cx, y: baseY + 120, z: cz }, Math.max(A, B) * 0.8);
    this._poi('Raceway', cx, baseY + 30, cz, 'raceway', Math.max(A, B));
    this._stats.roads += 4;
    return { x: cx, z: cz, y: baseY, points: pts };
  }

  /** 最高点采样（山顶收集物用）。 */
  _highestPoint(range = 3200, samples = 140) {
    let best = null;
    for (let i = 0; i < samples; i++) {
      const x = (this._rng() - 0.5) * range * 2;
      const z = (this._rng() - 0.5) * range * 2;
      if (this._isWater(x, z)) continue;
      const y = this._heightAt(x, z);
      if (!best || y > best.y) best = { x, y, z };
    }
    return best || { x: 0, y: this.seaLevel, z: 0 };
  }

  /** 找一段可跨越的水域：返回 {x, z, heading, length}（heading 为桥的纵向）。 */
  _crossing(x, z) {
    let best = { heading: 0, length: 0 };
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI;
      const dx = Math.sin(a), dz = Math.cos(a);
      let run = 0, run2 = 0;
      for (let d = 30; d < 1000; d += 30) {
        if (!this._isWater(x + dx * d, z + dz * d)) break;
        run = d;
      }
      for (let d = 30; d < 1000; d += 30) {
        if (!this._isWater(x - dx * d, z - dz * d)) break;
        run2 = d;
      }
      const total = run + run2;
      if (total > best.length) {
        const shift = (run - run2) * 0.5;
        best = {
          heading: a, length: Math.max(120, total + 160),
          x: x + dx * shift, z: z + dz * shift,
        };
      }
    }
    if (!best.length) { best.length = 320; best.x = x; best.z = z; }
    return best;
  }

  /**
   * 撒收集物：楼顶 / 山顶 / 水下 / 低空。
   * @returns {Array<object>}
   */
  _scatterCollectibles(n = 8, opts = {}) {
    const kinds = opts.kinds || ['star', 'coin', 'craft'];
    // 只挑“有高度”的兴趣点（city 这类地面点会导致收集物卡在楼里）
    const roofPois = this._pois.filter((p) => (
      p.kind === 'rooftop' || p.kind === 'radar' || p.kind === 'stadium'
      || p.kind === 'dock' || p.kind === 'rig' || p.kind === 'ship'
      || p.kind === 'island' || p.kind === 'airship' || p.kind === 'lighthouse'
    ));
    const hi = this._highestPoint(this._worldSize() * 0.42, 150);
    const out = [];
    for (let i = 0; i < n; i++) {
      const kind = kinds[i % kinds.length];
      const mode = i % 4;
      let x, y, z, name;
      if (mode === 0 && roofPois.length) {
        const p = roofPois[i % roofPois.length];
        x = p.position.x + (this._rng() - 0.5) * 30;
        z = p.position.z + (this._rng() - 0.5) * 30;
        y = p.position.y + 14 + this._rng() * 22;
        name = 'Rooftop cache';
      } else if (mode === 1) {
        x = hi.x + (this._rng() - 0.5) * 260;
        z = hi.z + (this._rng() - 0.5) * 260;
        y = this._heightAt(x, z) + 34 + this._rng() * 50;
        name = 'Summit cache';
      } else if (mode === 2) {
        let wx = 0, wz = 0, found = false;
        for (let k = 0; k < 50; k++) {
          const a = this._rng() * 6.28;
          const r = 300 + this._rng() * this._worldSize() * 0.28;
          const px = Math.cos(a) * r, pz = Math.sin(a) * r;
          if (this._isWater(px, pz) && this._heightAt(px, pz) < this.seaLevel - 14) { wx = px; wz = pz; found = true; break; }
        }
        if (found) {
          x = wx; z = wz; y = this.seaLevel - 11;
          name = 'Sunken cache';
        } else {
          // 没找到深水就退化为低空收集物（避免埋在地下）
          const q = this._randomLandPoint() || hi;
          x = q.x; z = q.z; y = this._heightAt(q.x, q.z) + 22 + this._rng() * 30;
          name = 'Low pass cache';
        }
      } else {
        const p = this._randomLandPoint() || hi;
        x = p.x; z = p.z;
        y = this._heightAt(p.x, p.z) + 20 + this._rng() * 34;
        name = 'Low pass cache';
      }
      out.push(this.addCollectible(kind, x, y, z, name + ' #' + (i + 1)));
    }
    return out;
  }

  /** 沿一条线均匀撒炮塔。 */
  _addTurretsAlong(pts, count, opts = {}) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const p = pts[i % pts.length];
      const x = (Array.isArray(p) ? p[0] : p.x) + (this._rng() - 0.5) * (opts.spread || 60);
      const z = (Array.isArray(p) ? p[1] : p.z) + (this._rng() - 0.5) * (opts.spread || 60);
      const y = opts.y !== undefined ? opts.y : this._heightAt(x, z);
      out.push(this.addTurret(x, y, z, { name: opts.name || 'AA Turret', range: opts.range || 1200 }));
    }
    return out;
  }

  // ===========================================================================
  // 真实世界扩展（New Yoke / Middleton / Cochran，仅 archipelago 使用）
  //   · 雪山 + 盘山公路（发夹弯）+ 隧道
  //   · 金门式悬索桥（主缆/吊索/桥塔/桥面平台）
  //   · Cochran 航站楼 + 廊桥 + 停车场 + 滑行道
  //   · Vetusta 山顶城堡（城墙/雉堞/角楼/主楼）
  //   · 港湾礁石、悬崖海岸
  // ===========================================================================

  // ------------------------------ 雪山 ------------------------------

  /**
   * 生成一座可解析求高度的圆锥雪山参数。
   * 半径/高度只随方位角做正弦扰动 => 表面高度可以精确反算，
   * 盘山公路才能严丝合缝地贴在山上（而不是悬空/埋进山体）。
   */
  _makePeak(x, z, r, h, seed) {
    const rng = makeRNG(seed);
    const prof = {
      a1: 2 + Math.floor(rng() * 3), a2: 5 + Math.floor(rng() * 4),
      p1: rng() * 6.28, p2: rng() * 6.28,
      amp1: 0.05 + rng() * 0.07, amp2: 0.03 + rng() * 0.05,
      ha1: 2 + Math.floor(rng() * 2), hp: rng() * 6.28,
      hamp: 0.015 + rng() * 0.025,
    };
    const base = this._heightAt(x, z) - Math.min(26, h * 0.07);
    return {
      x, z, r, h, y: base, summit: base + h, seed, prof,
      radFn: (a) => 1 + prof.amp1 * Math.sin(a * prof.a1 + prof.p1) + prof.amp2 * Math.sin(a * prof.a2 + prof.p2),
      yFn: (a) => 1 + prof.hamp * Math.sin(a * prof.ha1 + prof.hp),
    };
  }

  /** 雪山表面高度；点在锥体之外返回 null。 */
  mountainSurfaceY(peak, x, z) {
    const dx = x - peak.x, dz = z - peak.z;
    const d = Math.hypot(dx, dz);
    const a = Math.atan2(dz, dx);
    const rr = peak.r * peak.radFn(a);
    if (d >= rr) return null;
    return peak.y + peak.h * (1 - d / rr) * peak.yFn(a);
  }

  /** 低多边形雪山几何（顶点色 = 岩石 / 雪线），世界坐标，可直接合并。 */
  _mountainGeo(peak, seg = 24, rings = 8) {
    const verts = [], cols = [];
    const rock = new THREE.Color(0x585550), rockDark = new THREE.Color(0x3c3a37);
    const snow = new THREE.Color(0xf4f8fc);
    const tmp = new THREE.Color();
    const ringArr = [];
    for (let k = 1; k <= rings; k++) {
      const t = k / (rings + 1);
      const ring = [];
      for (let j = 0; j < seg; j++) {
        const a = (j / seg) * Math.PI * 2;
        const rr = peak.r * peak.radFn(a) * (1 - t);
        ring.push({
          x: peak.x + Math.cos(a) * rr,
          y: peak.y + peak.h * t * peak.yFn(a),
          z: peak.z + Math.sin(a) * rr,
          a, t,
        });
      }
      ringArr.push(ring);
    }
    const apex = { x: peak.x, y: peak.summit, z: peak.z, a: 0, t: 1 };
    const push = (v) => {
      verts.push(v.x, v.y, v.z);
      // 雪线以上渐白，边界带一点方位噪声，避免死板
      const wobble = 0.5 + 0.5 * Math.sin(v.a * 5.3 + peak.seed * 0.7);
      const mix = clamp((v.t - (0.46 + wobble * 0.1)) / 0.2, 0, 1);
      tmp.copy(v.t < 0.16 ? rockDark : rock).lerp(snow, mix);
      cols.push(tmp.r, tmp.g, tmp.b);
    };
    const tri = (a, b, c) => { push(a); push(b); push(c); };
    for (let j = 0; j < seg; j++) tri(apex, ringArr[0][(j + 1) % seg], ringArr[0][j]);
    for (let k = 0; k + 1 < ringArr.length; k++) {
      const A = ringArr[k], B = ringArr[k + 1];
      for (let j = 0; j < seg; j++) {
        const j2 = (j + 1) % seg;
        tri(A[j], B[j], B[j2]);
        tri(A[j], B[j2], A[j2]);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }

  /**
   * 中部雪山山脉（New Yoke 的地标）：数座雪峰沿一条走向排列，合并成 1 个 Mesh。
   * @returns {Array<object>} peaks（供盘山公路使用）
   */
  buildSnowRange(cx, cz, opts = {}) {
    const count = opts.count || 5;
    const dir = opts.dir !== undefined ? opts.dir : 0.42;      // 山脉走向
    const length = opts.length || 2900;
    const geos = [];
    const peaks = [];
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      const f = (t - 0.5) * length;
      const side = (this._rng() - 0.5) * (opts.spread || 520);
      const x = cx - Math.sin(dir) * f + Math.cos(dir) * side;
      const z = cz - Math.cos(dir) * f - Math.sin(dir) * side;
      const r = (opts.minR || 230) + this._rng() * ((opts.maxR || 430) - (opts.minR || 230));
      const h = (opts.minH || 250) + this._rng() * ((opts.maxH || 470) - (opts.minH || 250));
      const peak = this._makePeak(x, z, r, h, (this.seed + i * 977) | 0);
      peaks.push(peak);
      geos.push(this._mountainGeo(peak, opts.seg || 24, opts.rings || 8));
      // 山体碰撞：粗球即可（撞山 = 坠毁）
      this.addSphereCollider('rock', x, peak.y + h * 0.3, z, r * 0.55, {
        destructible: false, name: 'Snowy peak',
      });
      this._reserve(x, z, r * 0.85);
    }
    const mat = this._mat('snowRock', () => new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.95, metalness: 0.02, flatShading: true,
    }));
    const mesh = this.mergedMesh(geos, mat, 'snow_range');
    if (mesh) mesh.name = 'snow_range';
    this._stats.buildings += peaks.length;
    const mid = peaks[Math.floor(peaks.length / 2)];
    this._poi('New Yoke Mountains', mid.x, mid.y + mid.h * 0.8, mid.z, 'mountain', mid.r * 2.2);
    return peaks;
  }

  // ------------------------------ 盘山公路 + 隧道 ------------------------------

  /**
   * 盘山公路：沿雪峰侧翼左右折返爬升（发夹弯），路面/路肩/护栏桩全部程序化。
   * @returns {{pts:Array, tunnel:object|null}}
   */
  buildMountainRoad(peak, opts = {}) {
    const legs = opts.legs || 6;
    const steps = opts.steps || 8;
    const sweep = opts.sweep || 1.35;                  // 每段方位角扫掠（左右折返）
    const groundY = (x, z) => Math.max(this._heightAt(x, z), this.seaLevel);
    const surfY = (x, z) => {
      const sy = this.mountainSurfaceY(peak, x, z);
      return sy === null ? groundY(x, z) : Math.max(sy, groundY(x, z));
    };
    let az = opts.angle !== undefined ? opts.angle : 0.7;
    let d = peak.r * (opts.startRadius || 1.45);
    const dEnd = peak.r * (opts.endRadius || 0.2);
    const pts = [];
    const sx = peak.x + Math.cos(az) * d, sz = peak.z + Math.sin(az) * d;
    pts.push([sx, surfY(sx, sz) + 0.35, sz]);
    for (let i = 0; i < legs; i++) {
      const sign = (i % 2 === 0) ? 1 : -1;
      const az0 = az, az1 = az + sign * sweep;
      const d0 = d, d1 = lerp(d, dEnd, (i + 1) / legs);
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        const aa = lerp(az0, az1, t);
        const dd = lerp(d0, d1, t);
        const px = peak.x + Math.cos(aa) * dd;
        const pz = peak.z + Math.sin(aa) * dd;
        pts.push([px, surfY(px, pz) + 0.35, pz]);
      }
      az = az1; d = d1;
    }
    // 路肩（先铺，稍低） + 沥青路面 + 中线虚线
    this.ribbon(pts, 18, this._mat('gravel', () => new THREE.MeshStandardMaterial({
      map: this._tex.sand(), color: 0x9a9187, roughness: 0.98, metalness: 0.02,
    })), { lift: 0.02, uvScale: 12, name: 'mountain_road_shoulder' });
    const road = this.ribbon(pts, 9.5, this._mats.asphalt,
      { lift: 0.14, uvScale: 8, name: 'mountain_road', centerLine: true, dashScale: 5 });
    // 外侧护栏桩（实例化）
    const n = pts.length;
    const im = this.instance('fencePost', this._mats.treeLeaf, n, { name: 'mountain_guard' });
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
      let dx = b[0] - a[0], dz = b[2] - a[2];
      const dl = Math.hypot(dx, dz) || 1;
      dx /= dl; dz /= dl;
      const side = 7.6;
      const px = pts[i][0] - dz * side, pz = pts[i][2] + dx * side;
      const py = surfY(px, pz);
      this.setInstance(im, i, px, py - 0.5, pz, Math.atan2(dx, dz), 0.5, 0, undefined, 0.55);
    }
    this.finishInstance(im);
    // 隧道位置：取路径 55% 处（那里正好是山肩）
    const ti = Math.floor(n * 0.55);
    const tp = pts[ti], tq = pts[Math.min(n - 1, ti + 1)];
    const tunnel = {
      x: tp[0], y: tp[1] - 0.14, z: tp[2],
      heading: Math.atan2(tq[0] - tp[0], tq[2] - tp[2]) + Math.PI / 2,
    };
    this._poi('Mountain switchbacks', pts[Math.floor(n * 0.25)][0], pts[Math.floor(n * 0.25)][1] + 8,
      pts[Math.floor(n * 0.25)][2], 'mountain_road', 80);
    return { pts, road, tunnel, peak };
  }

  /** 山体隧道：两侧岩体 + 顶部岩帽 + 门洞 + 内壁（飞机可以从洞里穿过）。 */
  buildTunnel(x, z, y, heading, opts = {}) {
    const len = opts.length || 96;
    const r = opts.radius || 9;
    const g = this.group(x, y, z);
    g.rotation.y = heading;
    g.name = 'tunnel';
    const rockMat = this._mat('tunnelRock', () => new THREE.MeshStandardMaterial({
      vertexColors: true, map: this._tex.rust(), color: 0x8d897f, roughness: 0.96, metalness: 0.04, flatShading: true,
    }));
    const innerMat = this._mat('tunnelInner', () => new THREE.MeshStandardMaterial({
      color: 0x2c2c31, roughness: 0.95, metalness: 0.05, side: THREE.BackSide,
    }));
    // 洞身（半圆拱，内表面可见）
    const arch = this._G('tunnelArch', () => {
      const geo = new THREE.CylinderGeometry(1, 1, 1, 14, 1, true, 0, Math.PI);
      geo.rotateZ(Math.PI / 2);
      geo.rotateY(Math.PI / 2);
      return geo;
    });
    const tube = this.mesh(arch, innerMat, 0, 0, 0, { sx: r, sy: len, sz: r, parent: g });
    tube.name = 'tunnel_bore';
    // 岩体：两侧块体 + 顶部岩帽（都不侵入 |x|<r+2 / y<r 的通道）
    const geos = [];
    const rockPart = (px, py, pz, sx, sy, sz, col) => geos.push({
      geo: new THREE.IcosahedronGeometry(1, 0),
      matrix: mat4(px, py, pz, (this._rng() - 0.5) * 0.5, this._rng() * 6.28, (this._rng() - 0.5) * 0.5, sx, sy, sz),
      color: col,
    });
    for (const side of [-1, 1]) {
      for (let i = 0; i < 5; i++) {
        const pz = (i / 4 - 0.5) * len * 0.86;
        rockPart(side * (r + 12 + this._rng() * 8), 3 + this._rng() * 6, pz, 16 + this._rng() * 8, 12 + this._rng() * 8, 14, 0x6f6b62);
        rockPart(side * (r + 8 + this._rng() * 4), 12 + this._rng() * 4, pz + 6, 12, 12, 12, 0x7a766c);
      }
    }
    for (let i = 0; i < 6; i++) {
      const px = (i / 5 - 0.5) * 2 * (r + 14);
      rockPart(px, r + 12 + this._rng() * 5, (this._rng() - 0.5) * len * 0.7, 16, 12 + this._rng() * 6, 16, 0x67635a);
      rockPart(px * 0.7, r + 24 + this._rng() * 6, (this._rng() - 0.5) * len * 0.5, 20, 13, 20, 0x5d5a52);
    }
    const rockMesh = this.mergedMesh(geos, rockMat, 'tunnel_rock', g);
    if (rockMesh) rockMesh.name = 'tunnel_rock';
    // 门洞（两端）：石砌门框
    const stoneMat = this._mat('castleStone', () => new THREE.MeshStandardMaterial({
      map: this._tex.stoneWall('#8b8375'), color: 0xffffff, roughness: 0.95, metalness: 0.03,
    }));
    const portal = [];
    for (const end of [-1, 1]) {
      const pz = end * len * 0.47;
      portal.push({ geo: new THREE.BoxGeometry(4, 16, 5), matrix: mat4(-(r + 2), 8, pz), color: 0xffffff });
      portal.push({ geo: new THREE.BoxGeometry(4, 16, 5), matrix: mat4(r + 2, 8, pz), color: 0xffffff });
      portal.push({ geo: new THREE.BoxGeometry(2 * r + 10, 4, 6), matrix: mat4(0, r + 3.5, pz), color: 0xffffff });
    }
    this.mergedMesh(portal, stoneMat, 'tunnel_portal', g);
    // 洞内灯带（自发光，强化“能穿过去”的观感）
    for (const end of [-1, 1]) {
      this.mesh(this._G('unitBox'), this._mats.lampGlow, 0, r - 1.4, end * len * 0.28,
        { sx: 5, sy: 0.4, sz: 1.2, parent: g });
    }
    // 碰撞：只挡两侧岩体，通道留空
    const cw = Math.sin(heading), cc = Math.cos(heading);
    for (const side of [-1, 1]) {
      const ox = side * (r + 14), oz = 0;
      this.addBoxCollider('rock', x + ox * cc + oz * cw, y + 8, z - ox * cw + oz * cc, 12, 12, len * 0.5, {
        destructible: false, name: 'Tunnel rock',
      });
    }
    this._poi('Mountain tunnel', x, y + r + 6, z, 'tunnel', 60);
    return g;
  }

  // ------------------------------ 礁石 / 悬崖 ------------------------------

  /** 港湾礁石群：露出水面的岩石（实例化）+ 浅滩色 + 浪花，含少量碰撞体。 */
  buildReef(cx, cz, radius = 300, count = 48, opts = {}) {
    const proto = this._G('reefRockGeo', () => mergeGeos([
      { geo: new THREE.IcosahedronGeometry(1, 0), matrix: mat4(0, 0.7, 0, 0.3, 0.4, 0.2, 1, 1.6, 1), color: 0x7d7a72 },
      { geo: new THREE.IcosahedronGeometry(1, 0), matrix: mat4(0.85, 0.35, 0.2, 0.1, 1.2, 0.5, 0.7, 0.8, 0.7), color: 0x8d8a80 },
      { geo: new THREE.ConeGeometry(1, 1.7, 5), matrix: mat4(-0.45, 1.25, -0.3, 0.2, 0.5, 0.1, 0.5, 0.95, 0.5), color: 0x6d6a62 },
    ]));
    const rockMat = this._mat('reefRock', () => new THREE.MeshStandardMaterial({
      vertexColors: true, map: this._tex.rust(), color: 0x928f86, roughness: 0.95, metalness: 0.05, flatShading: true,
    }));
    const im = this.instance(proto, rockMat, count, { name: 'reef_rocks' });
    const big = [];
    let n = 0;
    for (let i = 0; i < count; i++) {
      const a = this._rng() * 6.283;
      const rr = Math.sqrt(this._rng()) * radius;
      const px = cx + Math.cos(a) * rr, pz = cz + Math.sin(a) * rr;
      if (!this._isWater(px, pz)) continue;                 // 礁石只长在水里
      const t = 1 - rr / radius;
      const s = 3.2 + this._rng() * 6.5 * (0.55 + t);
      this.setInstanceXYZ(im, n, px, this.seaLevel - s * 0.4, pz, this._rng() * 6.28,
        s * (0.7 + this._rng() * 0.7), s, s * (0.7 + this._rng() * 0.7), (this._rng() - 0.5) * 0.35);
      if (i % 9 === 0) big.push({ x: px, z: pz, r: s * 0.9 });
      n++;
    }
    im.count = n;
    this.finishInstance(im);
    // 浅滩色（两层半透明水色盘，避免与地形水面 z-fighting）
    this.mesh(this._G('unitCyl'), this._mat('shallowDeep', () => new THREE.MeshStandardMaterial({
      color: 0x1f8fa8, transparent: true, opacity: 0.42, roughness: 0.12, metalness: 0.3, depthWrite: false,
    })), cx, this.seaLevel + 0.22, cz, { sx: radius * 1.06, sy: 0.4, sz: radius * 1.06, seg: 24 });
    this.mesh(this._G('unitCyl'), this._mat('shallow', () => new THREE.MeshStandardMaterial({
      color: 0x45d6dc, transparent: true, opacity: 0.4, roughness: 0.1, metalness: 0.25, depthWrite: false,
    })), cx, this.seaLevel + 0.34, cz, { sx: radius * 0.62, sy: 0.4, sz: radius * 0.62, seg: 22 });
    // 浪花圆环（合并成 1 个 Mesh）
    if (big.length) {
      const foam = [];
      for (const b of big) {
        for (const rr of [b.r * 1.25, b.r * 1.6]) {
          foam.push({ geo: new THREE.RingGeometry(rr * 0.82, rr, 12, 1), matrix: mat4(b.x, this.seaLevel + 0.5, b.z, -Math.PI / 2, 0, 0), color: 0xffffff });
        }
      }
      const fm = this._G('foamMat', () => new THREE.MeshBasicMaterial({
        color: 0xdff6ff, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false,
      }));
      this.mergedMesh(foam, fm, 'reef_foam');
    }
    // 碰撞：大礁石
    for (const b of big.slice(0, opts.colliders || 6)) {
      this.addSphereCollider('rock', b.x, this.seaLevel + 1.5, b.z, Math.max(3.5, b.r), {
        destructible: false, name: 'Reef rock',
      });
    }
    this._poi(opts.name || 'Harbour reef', cx, this.seaLevel + 16, cz, 'reef', radius);
    this._anchor('dropzones', opts.name || 'Harbour reef', { x: cx, y: this.seaLevel + 90, z: cz }, radius * 0.8);
    return im;
  }

  /** 悬崖海岸（Middleton 特色）：沿岸一排竖直岩壁 + 海蚀柱，合并渲染。 */
  buildCliffCoast(cx, cz, opts = {}) {
    // 找水的方向，让悬崖面朝海
    let wx = 0, wz = 0, wet = 0;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * 6.283;
      const d = 150 + 80 * (k % 3);
      if (this._isWater(cx + Math.cos(a) * d, cz + Math.sin(a) * d)) { wx += Math.cos(a); wz += Math.sin(a); wet++; }
    }
    let dirX = 0, dirZ = 1;
    if (wet) {
      const l = Math.hypot(wx, wz) || 1;
      dirX = wx / l; dirZ = wz / l;
    }
    const alongX = -dirZ, alongZ = dirX;
    const count = opts.count || 7;
    const spacing = opts.spacing || 95;
    const geos = [];
    const tops = [];
    for (let i = 0; i < count; i++) {
      const f = (i - (count - 1) / 2) * spacing;
      const bx = cx + alongX * f - dirX * (opts.inset || 30);
      const bz = cz + alongZ * f - dirZ * (opts.inset || 30);
      const gy = Math.max(this._heightAt(bx, bz), this.seaLevel);
      const h = (opts.height || 52) + this._rng() * (opts.vary || 46);
      const ry = Math.atan2(alongX, alongZ);
      for (let k = 0; k < 4; k++) {
        const bh = h * (0.55 + this._rng() * 0.6);
        const bw = spacing * (0.75 + this._rng() * 0.55);
        geos.push({
          geo: new THREE.BoxGeometry(bw, bh, 38 + this._rng() * 34),
          matrix: mat4(bx + (this._rng() - 0.5) * 16, gy - 8 + bh / 2 + k * 3, bz + (this._rng() - 0.5) * 18 + k * 4,
            (this._rng() - 0.5) * 0.08, ry + (this._rng() - 0.5) * 0.18, (this._rng() - 0.5) * 0.06),
          color: k % 2 ? 0x6e6a62 : 0x7d7970,
        });
      }
      tops.push({ x: bx, z: bz, y: gy + h * 0.55 });
      if (i % 2 === 0) {
        this.addBoxCollider('rock', bx, gy + h * 0.3, bz, spacing * 0.42, h * 0.45, 26, {
          destructible: false, name: 'Sea cliff',
        });
      }
      this._reserve(bx, bz, spacing * 0.5);
    }
    // 海蚀柱（水中的石柱）
    const stacks = [];
    for (let i = 0; i < 5; i++) {
      const f = (i / 4 - 0.5) * spacing * 2.4;
      const sx2 = cx + alongX * f + dirX * (140 + this._rng() * 120);
      const sz2 = cz + alongZ * f + dirZ * (140 + this._rng() * 120);
      if (!this._isWater(sx2, sz2)) continue;
      const sh = 26 + this._rng() * 34;
      stacks.push({
        geo: new THREE.ConeGeometry(9 + this._rng() * 7, sh, 7),
        matrix: mat4(sx2, this.seaLevel - 6 + sh / 2, sz2, (this._rng() - 0.5) * 0.1, this._rng() * 6.28, (this._rng() - 0.5) * 0.1),
        color: 0x6a665e,
      });
      this.addSphereCollider('rock', sx2, this.seaLevel + sh * 0.25, sz2, 8 + this._rng() * 4, {
        destructible: false, name: 'Sea stack',
      });
    }
    const mat = this._mat('cliffRock', () => new THREE.MeshStandardMaterial({
      vertexColors: true, map: this._tex.rust(), color: 0x9b978d, roughness: 0.96, metalness: 0.03, flatShading: true,
    }));
    const mesh = this.mergedMesh(geos.concat(stacks), mat, 'cliffs');
    if (mesh) mesh.name = 'middleton_cliffs';
    const top = tops[Math.floor(tops.length / 2)] || { x: cx, y: this.seaLevel, z: cz };
    this._poi(opts.name || 'Middleton Cliffs', top.x, top.y + 20, top.z, 'cliffs', spacing * count * 0.5);
    return { mesh, tops, dirX, dirZ, alongX, alongZ };
  }

  // ------------------------------ 金门式悬索桥 ------------------------------

  /**
   * 悬索桥（Golden Gate 式）。桥塔有碰撞体；桥面是可降落平台（box, destructible:false）；
   * 主缆用抛物线悬链 + TubeGeometry，吊索/栏杆立柱用 InstancedMesh。
   * 局部坐标：Z 轴 = 桥走向（与 heading 一致），X = 横桥方向。
   */
  buildSuspensionBridge(x, z, heading, opts = {}) {
    const span = clamp(opts.span || 1500, 500, 3200);          // 主跨（两塔之间）
    const width = opts.width || 30;
    const deckY = opts.deck !== undefined ? opts.deck : this.seaLevel + 68;
    const towerH = opts.towerHeight !== undefined ? opts.towerHeight : this.seaLevel + 210;
    const clearance = opts.clearance || 9;                     // 主缆最低点离桥面
    const sideSpan = opts.side !== undefined ? opts.side : span * 0.34;
    const halfTower = span / 2;
    const halfDeck = halfTower + sideSpan;
    const sag = opts.sag !== undefined ? opts.sag : Math.max(18, (towerH - deckY) - clearance);
    const sin = Math.sin(heading), cos = Math.cos(heading);
    const L2W = (lx, lz) => ({ x: x + lx * cos + lz * sin, z: z - lx * sin + lz * cos });
    const g = this.group(x, 0, z);
    g.rotation.y = heading;
    g.name = 'suspension_bridge';

    const steel = this._mat('bridgeSteel', () => new THREE.MeshStandardMaterial({
      map: this._tex.metal(), color: 0xb9bec6, roughness: 0.55, metalness: 0.6,
    }));
    const steelDark = this._mat('bridgeSteelDark', () => new THREE.MeshStandardMaterial({
      map: this._tex.metal(), color: 0x6d737b, roughness: 0.6, metalness: 0.55,
    }));
    const deckMat = this._mat('bridgeDeck', () => new THREE.MeshStandardMaterial({
      map: this._tex.roadDeck(2 * halfDeck), color: 0xffffff, roughness: 0.85, metalness: 0.06,
    }));

    // ---- 主缆高度函数（主跨抛物线 + 边跨下斜，塔顶为最高点） ----
    const cableY = (lz) => {
      const az = Math.abs(lz);
      if (az <= halfTower) {
        const u = (lz + halfTower) / (2 * halfTower);
        return towerH - sag * (1 - Math.pow(2 * u - 1, 2));
      }
      const t = clamp((az - halfTower) / Math.max(1, halfDeck - halfTower), 0, 1);
      return lerp(towerH, deckY + 5, t) - Math.sin(t * Math.PI) * sideSpan * 0.05;
    };

    // ---- 桥面：结构箱梁 + 带车道标线的顶面 ----
    const deckLen = 2 * halfDeck;
    this.box(width, 3.2, deckLen, steelDark, 0, deckY - 1.6, 0, { parent: g });
    this.plane(width - 1.2, deckLen, deckMat, 0, deckY + 0.05, 0, { parent: g });
    // 桥面下的纵向桁架 + 横梁（实例化）
    this.mergedMesh([
      new THREE.BoxGeometry(1.6, 3, deckLen).translate(-(width / 2 - 2.5), deckY - 4.2, 0),
      new THREE.BoxGeometry(1.6, 3, deckLen).translate(width / 2 - 2.5, deckY - 4.2, 0),
    ], steel, 'bridge_girders', g);
    const nBeam = Math.max(8, Math.round(deckLen / 26));
    const beams = this.instanceIn(g, 'unitBox', steel, nBeam, { name: 'bridge_beams' });
    for (let i = 0; i < nBeam; i++) {
      const lz = lerp(-halfDeck + 6, halfDeck - 6, i / (nBeam - 1));
      this.setInstanceXYZ(beams, i, 0, deckY - 4.6, lz, 0, width - 3, 1.4, 1.2);
    }
    this.finishInstance(beams);
    // 栏杆：长扶手（合并）+ 立柱（实例化）
    this.mergedMesh([
      new THREE.BoxGeometry(0.6, 0.35, deckLen).translate(-(width / 2 - 0.8), deckY + 1.9, 0),
      new THREE.BoxGeometry(0.6, 0.35, deckLen).translate(width / 2 - 0.8, deckY + 1.9, 0),
      new THREE.BoxGeometry(0.4, 0.25, deckLen).translate(-(width / 2 - 0.8), deckY + 1.0, 0),
      new THREE.BoxGeometry(0.4, 0.25, deckLen).translate(width / 2 - 0.8, deckY + 1.0, 0),
    ], steel, 'bridge_rails', g);
    const nPost = Math.max(10, Math.round(deckLen / 12));
    const posts = this.instanceIn(g, 'unitBox', steel, nPost * 2, { name: 'bridge_rail_posts' });
    for (let i = 0; i < nPost; i++) {
      const lz = lerp(-halfDeck + 4, halfDeck - 4, i / (nPost - 1));
      this.setInstanceXYZ(posts, i * 2, -(width / 2 - 0.8), deckY + 1.1, lz, 0, 0.5, 2.2, 0.5);
      this.setInstanceXYZ(posts, i * 2 + 1, width / 2 - 0.8, deckY + 1.1, lz, 0, 0.5, 2.2, 0.5);
    }
    this.finishInstance(posts);

    // ---- 桥塔（4 条塔腿 + 横撑，合并成 1 个 Mesh） ----
    const towerParts = [];
    const legBase = this.seaLevel - 12;
    const legTop = towerH + 4;
    const legH = legTop - legBase;
    for (const tz of [-halfTower, halfTower]) {
      for (const tx of [-(width / 2 + 3.5), width / 2 + 3.5]) {
        towerParts.push({
          geo: new THREE.CylinderGeometry(3.4, 6.2, legH, 4),
          matrix: mat4(tx, legBase + legH / 2, tz, 0, Math.PI / 4, 0),
          color: 0xffffff,
        });
      }
      for (let k = 0; k < 5; k++) {
        const y = legBase + legH * (0.28 + k * 0.16);
        towerParts.push({ geo: new THREE.BoxGeometry(width + 7, 2.6, 4), matrix: mat4(0, y, tz), color: 0xffffff });
        towerParts.push({ geo: new THREE.BoxGeometry(1.6, 9.5, 3), matrix: mat4(-(width / 2 + 3.5) * 0.5, y + 5, tz, 0, 0, 0.5), color: 0xffffff });
        towerParts.push({ geo: new THREE.BoxGeometry(1.6, 9.5, 3), matrix: mat4((width / 2 + 3.5) * 0.5, y + 5, tz, 0, 0, -0.5), color: 0xffffff });
      }
      towerParts.push({ geo: new THREE.BoxGeometry(width * 0.55, 4, 9), matrix: mat4(0, towerH + 1.5, tz), color: 0xffffff });
    }
    this.mergedMesh(towerParts, steel, 'bridge_towers', g);

    // ---- 主缆（两条，TubeGeometry） + 吊索（实例化） ----
    const cableR = clamp(span / 900, 0.8, 2.2);
    const cableGeos = [];
    for (const cx2 of [-(width / 2 + 1.2), width / 2 + 1.2]) {
      const cpts = [];
      const nSample = 64;
      for (let i = 0; i <= nSample; i++) {
        const lz = lerp(-halfDeck * 0.97, halfDeck * 0.97, i / nSample);
        cpts.push(new THREE.Vector3(cx2, cableY(lz), lz));
      }
      const curve = new THREE.CatmullRomCurve3(cpts);
      cableGeos.push(new THREE.TubeGeometry(curve, 72, cableR, 6, false));
      // 锚碇处加粗的索靴
      cableGeos.push(new THREE.BoxGeometry(3, 5, 6).translate(cx2, deckY + 4, -halfDeck * 0.97));
      cableGeos.push(new THREE.BoxGeometry(3, 5, 6).translate(cx2, deckY + 4, halfDeck * 0.97));
    }
    this.mergedMesh(cableGeos, steelDark, 'bridge_cables', g);

    const nSus = Math.max(8, Math.floor(deckLen / 18));
    const susp = this.instanceIn(g, 'unitCyl6', steelDark, nSus * 2, { name: 'bridge_suspenders' });
    let si = 0;
    const deckTop = deckY + 1.7;
    for (let i = 0; i < nSus; i++) {
      const lz = lerp(-halfDeck * 0.95, halfDeck * 0.95, i / (nSus - 1));
      if (Math.abs(Math.abs(lz) - halfTower) < 14) continue;      // 塔身处跳过
      const cy = cableY(lz);
      const len = cy - deckTop;
      if (len < 3) continue;
      for (const cx2 of [-(width / 2 + 1.2), width / 2 + 1.2]) {
        this.setInstanceXYZ(susp, si++, cx2, deckTop + len / 2, lz, 0, cableR * 0.42, len, cableR * 0.42);
      }
    }
    susp.count = si;
    this.finishInstance(susp);

    // ---- 锚碇 + 引桥（两侧下坡引道 + 桥墩） ----
    let rampFootA = null, rampFootB = null;
    for (const end of [-1, 1]) {
      const lz = end * halfDeck * 0.99;
      const w = L2W(0, lz);
      const gy = Math.max(this._heightAt(w.x, w.z), this.seaLevel - 2);
      const top = deckY + 4;
      const bh = Math.max(6, top - (gy - 12));
      this.box(30, bh, 34, this._mats.concrete, 0, top - bh / 2, lz, { parent: g });
      this.addBoxCollider('prop', w.x, top - bh / 2, w.z, 15, bh / 2, 17, {
        destructible: false, name: 'Bridge anchorage', heading, oriented: true,
      });
      // 引道：从桥面高度降到地面
      const ramp = [];
      const rampSamples = [];
      const rampLen = 620;
      let foot = null;
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        const f = lz + end * (10 + t * rampLen);
        const p = L2W(0, f);
        const gy2 = Math.max(this._heightAt(p.x, p.z), this.seaLevel);
        const y = lerp(deckY - 2, gy2, Math.pow(t, 0.7));
        ramp.push([p.x, y, p.z]);
        rampSamples.push({ f, y });
        if (i === 10) foot = { x: p.x, z: p.z };
      }
      if (end < 0) rampFootA = foot; else rampFootB = foot;
      this.ribbon(ramp, width - 6, this._mats.asphalt, { lift: 0.2, uvScale: 9, name: 'bridge_ramp', centerLine: true, dashScale: 5 });
      // 逐段登记斜坡面；按局部 Z 方向插值高度，飞机不会在水面上穿过引桥。
      for (let i = 0; i < rampSamples.length - 1; i++) {
        const a = rampSamples[i], b = rampSamples[i + 1];
        const df = b.f - a.f;
        const segLen = Math.abs(df);
        const fm = (a.f + b.f) * 0.5;
        const center = L2W(0, fm);
        const midY = (a.y + b.y) * 0.5;
        const halfY = Math.max(0.6, Math.abs(b.y - a.y) * 0.5 + 0.25);
        this.addBoxCollider('runway', center.x, midY, center.z,
          (width - 6) / 2, halfY, segLen / 2 + 0.75, {
            destructible: false, name: 'Bridge ramp', heading, oriented: true,
            surfaceY: midY + 0.2, surfaceSlope: df ? (b.y - a.y) / df : 0,
          });
      }
      // 引桥桥墩
      const piers = [];
      for (let i = 2; i <= 8; i++) {
        const t = i / 10;
        const f = lz + end * (10 + t * rampLen);
        const p = L2W(0, f);
        const gy2 = Math.max(this._heightAt(p.x, p.z), this.seaLevel);
        const y = lerp(deckY - 2, gy2, Math.pow(t, 0.7));
        const ph = Math.max(2, y - gy2);
        piers.push(new THREE.CylinderGeometry(3.2, 4.2, ph, 8).translate(p.x, gy2 + ph / 2, p.z));
      }
      this.mergedMesh(piers, this._mats.concreteDark, 'bridge_ramp_piers');
    }

    // ---- 碰撞：桥面平台（局部尺寸 + heading；runway 类型仅跳过机身障碍碰撞） ----
    const axisAligned = Math.abs(sin) < 0.02 || Math.abs(cos) < 0.02;
    const deckHalfY = 1.6;
    const deckCenterY = deckY - deckHalfY;
    if (axisAligned) {
      this.addBoxCollider('runway', x, deckCenterY, z, width / 2, deckHalfY, halfDeck, {
        destructible: false, name: 'Bridge deck', heading, oriented: true,
        surfaceY: deckY + 0.05,
      });
    } else {
      // 斜向桥拆成重叠的窄段，既缩小子弹粗筛范围，也保留精确的平台占地。
      const seg = 18;
      const segHalf = halfDeck / seg;
      for (let i = 0; i < seg; i++) {
        const lz = -halfDeck + segHalf * (2 * i + 1);
        const p = L2W(0, lz);
        this.addBoxCollider('runway', p.x, deckCenterY, p.z,
          width / 2,
          deckHalfY,
          segHalf + 0.75,
          { destructible: false, name: 'Bridge deck segment', heading, oriented: true, surfaceY: deckY + 0.05 });
      }
    }
    const towerW = width / 2 + 3.5;
    for (const tz of [-halfTower, halfTower]) {
      for (const tx of [-towerW, towerW]) {
        const p = L2W(tx, tz);
        this.addBoxCollider('tower', p.x, this.seaLevel + (towerH - this.seaLevel) * 0.5, p.z, 5, (towerH - this.seaLevel) * 0.5, 5, {
          destructible: false, name: 'Bridge tower',
        });
      }
    }
    // ---- 锚点 ----
    const name = opts.name || 'Golden Gate Bridge';
    this._poi(name, x, deckY + 26, z, 'bridge', Math.max(120, span * 0.4));
    this._anchor('landingPads', name + ' deck', { x, y: deckY + 2.2, z }, Math.min(70, halfDeck * 0.5));
    this._anchor('dropzones', name + ' underpass', { x, y: this.seaLevel + 14, z }, Math.min(200, span * 0.5));
    this._stats.buildings += 2;
    return {
      x, z, heading, span, width, deckY, towerH, halfDeck, halfTower,
      length: deckLen, axisAligned,
      endA: L2W(0, -halfDeck * 0.99), endB: L2W(0, halfDeck * 0.99),
      rampFootA, rampFootB,
    };
  }

  // ------------------------------ Cochran 航站楼 / 停车场 / 滑行道 ------------------------------

  /** 航站楼（含玻璃幕墙、屋顶设备、霓虹招牌）。局部 = 世界（贴着机场底板）。 */
  buildTerminal(x, y, z, ry, opts = {}) {
    const len = opts.length || 240;
    const depth = opts.depth || 46;
    const h = opts.height || 20;
    const g = this.group(x, y, z);
    g.rotation.y = ry;
    g.name = 'terminal';
    // 主体（外墙用混凝土贴图并按尺寸平铺 UV）
    const bodyGeo = new THREE.BoxGeometry(len, h, depth);
    scaleBoxUV(bodyGeo, len, h, depth, 6);
    const body = new THREE.Mesh(bodyGeo, this._mats.concrete);
    body.position.y = h / 2;
    body.name = 'terminal_hall';
    g.add(body);
    // 屋顶（金属）+ 设备
    const roof = [];
    roof.push({ geo: new THREE.BoxGeometry(len + 6, 2.4, depth + 6), matrix: mat4(0, h + 1, 0), color: 0xffffff });
    roof.push({ geo: new THREE.BoxGeometry(len * 0.75, 3.4, depth * 0.6), matrix: mat4(0, h + 3.4, 0), color: 0xffffff });
    for (let i = 0; i < 5; i++) {
      roof.push({
        geo: new THREE.BoxGeometry(5 + this._rng() * 5, 2.6, 4 + this._rng() * 4),
        matrix: mat4((this._rng() - 0.5) * len * 0.8, h + 5.6, (this._rng() - 0.5) * depth * 0.5),
        color: 0xffffff,
      });
    }
    this.mergedMesh(roof, this._mats.metal, 'terminal_roof', g);
    // 面向停机坪的玻璃幕墙（局部 -Z 侧，法线朝外）
    this.mesh(this._G('unitPlane'), this._mats.glassNeon, 0, h * 0.52, -depth / 2 - 0.1, {
      sx: len * 0.94, sy: h * 0.74, ry: Math.PI, parent: g,
    });
    const mull = [];
    const nm = Math.floor(len / 12);
    for (let i = 0; i <= nm; i++) {
      mull.push(new THREE.BoxGeometry(0.6, h * 0.8, 0.9).translate(-len / 2 + (i / nm) * len, h * 0.5, -depth / 2 - 0.2));
    }
    this.mergedMesh(mull, this._mats.metalDark, 'terminal_mullions', g);
    // 屋顶霓虹
    this.buildNeonSign(0, h + 6.5, -depth / 2 - 0.4, 'COCHRAN', 1.5, { parent: g, width: 66, height: 13, frame: false });
    // 两端指廊
    this.box(len * 0.16, h * 0.8, depth * 1.9, this._mats.concrete, -len / 2 - len * 0.06, h * 0.4, depth * 0.35, { parent: g });
    this.box(len * 0.16, h * 0.8, depth * 1.9, this._mats.concrete, len / 2 + len * 0.06, h * 0.4, depth * 0.35, { parent: g });
    // 碰撞
    const c = Math.cos(ry), sn = Math.sin(ry);
    const L2W = (lx, lz) => ({ x: x + lx * c + lz * sn, z: z - lx * sn + lz * c });
    const wc = L2W(0, 0);
    // 沿长度拆成 5 段，旋转后的 AABB 才不会包出一大圈不可见墙
    const segN = 5;
    const segHalf = len / (segN * 2);
    for (let i = 0; i < segN; i++) {
      const p = L2W((i - (segN - 1) / 2) * segHalf * 2, 0);
      this.addBoxCollider('building', p.x, y + h * 0.5, p.z,
        Math.abs(c) * segHalf + Math.abs(sn) * depth / 2, h * 0.5,
        Math.abs(sn) * segHalf + Math.abs(c) * depth / 2,
        {
          destructible: true, health: 340, mass: len * depth * h * 1.6 / segN,
          name: 'Cochran Terminal', object: i === 2 ? body : null,
        });
    }
    this._stats.buildings++;
    this._anchor('cargo', 'Cochran Terminal', { x: wc.x, y: y + 2, z: wc.z }, 60);
    return { group: g, L2W, len, depth, h, x, y, z, ry };
  }

  /** 登机廊桥（可旋转的两节伸缩筒 + 端头小屋）。 */
  buildJetBridge(x, y, z, ry, len = 34, opts = {}) {
    const g = this.group(x, y, z);
    g.rotation.y = ry;
    g.name = 'jet_bridge';
    // 同一材质的零件合并，减少 draw call
    this.mergedMesh([
      { geo: new THREE.CylinderGeometry(2.6, 2.6, len, 10), matrix: mat4(0, 6.6, len / 2, Math.PI / 2, 0, 0), color: 0xffffff },
      { geo: new THREE.CylinderGeometry(1.9, 1.9, len * 0.5, 10), matrix: mat4(0, 6.6, len, Math.PI / 2, 0, 0), color: 0xffffff },
      { geo: new THREE.BoxGeometry(6, 2.2, 6), matrix: mat4(0, 8.4, 0), color: 0xffffff },
    ], this._mats.metal, 'jet_bridge_tube', g);
    const darkParts = [
      { geo: new THREE.BoxGeometry(7.6, 6, 7.6), matrix: mat4(0, 3.4, len * 1.28), color: 0xffffff },
    ];
    for (const f of [0.2, 0.75]) {
      darkParts.push({ geo: new THREE.CylinderGeometry(0.9, 0.9, 6.6, 8), matrix: mat4(0, 3.3, len * f), color: 0xffffff });
    }
    const cab = this.mergedMesh(darkParts, this._mats.metalDark, 'jet_bridge_frame', g);
    this.mesh(this._G('unitPlane'), this._mats.glassNeon, 0, 4.4, len * 1.28 - 3.85, { sx: 6.4, sy: 2.6, parent: g });
    const c = Math.cos(ry), sn = Math.sin(ry);
    const cx2 = x + (len * 1.28) * sn, cz2 = z + (len * 1.28) * c;
    this.addBoxCollider('prop', cx2, y + 3.4, cz2, 4, 3.4, 4, {
      destructible: true, health: 120, mass: 1500, name: 'Jet bridge', object: cab,
    });
    return g;
  }

  /** 停车场：铺装 + 车位白线 + 实例化小汽车 + 灯杆。 */
  buildParkingLot(x, z, ry, opts = {}) {
    const w = opts.width || 150;
    const d = opts.depth || 90;
    const y = opts.y !== undefined ? opts.y : this._heightAt(x, z);
    const g = this.group(x, y, z);
    g.rotation.y = ry;
    g.name = 'parking';
    this.box(w, 0.5, d, this._mats.pavement, 0, 0.25, 0, { parent: g });
    // 车位线（4 排）
    const lines = [];
    const rows = 4;
    for (let r = 0; r < rows; r++) {
      const lz = (r / (rows - 1) - 0.5) * d * 0.78;
      lines.push(new THREE.BoxGeometry(w * 0.9, 0.06, 0.35).translate(0, 0.52, lz));
      const nn = Math.floor(w / 14);
      for (let i = 0; i <= nn; i++) {
        lines.push(new THREE.BoxGeometry(0.35, 0.06, d * 0.16).translate(-w * 0.45 + (i / nn) * w * 0.9, 0.52, lz));
      }
    }
    this.mergedMesh(lines, this._mats.paintWhite, 'parking_lines', g);
    this.addBoxCollider('runway', x, y + 0.25, z, w / 2, 0.25, d / 2, {
      destructible: false, name: 'Parking apron', heading: ry, oriented: true,
      surfaceY: y + 0.5,
    });
    // 小汽车（世界坐标实例化）
    const pts = [];
    for (let i = 0; i < 40; i++) {
      const lx = (this._rng() - 0.5) * w * 0.88;
      const lz = (this._rng() - 0.5) * d * 0.82;
      pts.push([x + lx * Math.cos(ry) + lz * Math.sin(ry), z - lx * Math.sin(ry) + lz * Math.cos(ry)]);
    }
    this.buildParkedCars(pts, 34, 9);
    // 灯杆
    const lampPts = [];
    for (let i = 0; i < 4; i++) {
      const lx = ((i % 2) - 0.5) * w * 0.8;
      const lz = (Math.floor(i / 2) - 0.5) * d * 0.8;
      lampPts.push([x + lx * Math.cos(ry) + lz * Math.sin(ry), z - lx * Math.sin(ry) + lz * Math.cos(ry)]);
    }
    this.buildStreetlights(lampPts, 1, 8);
    this._poi('Cochran parking', x, y + 10, z, 'parking', Math.max(w, d) * 0.6);
    return g;
  }

  /** 平行滑行道 + 联络道（画在机场底板上）。 */
  buildTaxiway(x, z, heading, opts = {}) {
    const len = opts.length || 1200;
    const wid = opts.width || 18;
    const slabTop = opts.y !== undefined ? opts.y : this._heightAt(x, z) + 0.35;
    const rwyHalf = opts.runwayWidth ? opts.runwayWidth / 2 : 30;
    const off = rwyHalf + (opts.offset || 46);
    const sin = Math.sin(heading), cos = Math.cos(heading);
    const W = (f, r) => ({ x: x - f * sin + r * cos, z: z - f * cos - r * sin });
    const c = W(0, off);
    // 滑行道
    const taxiway = this.box(wid + 6, 0.5, len, this._mats.asphalt, c.x, slabTop + 0.05, c.z, { ry: heading });
    taxiway.name = 'taxiway';
    this.addBoxCollider('runway', c.x, taxiway.position.y, c.z, (wid + 6) / 2, 0.25, len / 2, {
      destructible: false, name: 'Taxiway', heading, oriented: true,
      surfaceY: taxiway.position.y + 0.25,
    });
    // 黄中线（合并）
    const lines = [];
    for (let i = 0; i < 6; i++) {
      const f = -len * 0.42 + i * (len * 0.168);
      const p = W(f, off);
      lines.push(new THREE.BoxGeometry(wid + 4, 0.06, 1).translate(p.x, slabTop + 0.34, p.z));
    }
    // 联络道（3 条，从滑行道通到跑道；合并成一个 Mesh）
    const connectors = [];
    for (let i = 0; i < 3; i++) {
      const f = -len * 0.3 + i * (len * 0.3);
      const p = W(f, off * 0.5);
      lines.push(new THREE.BoxGeometry(1.2, 0.06, 0.5).translate(p.x, slabTop + 0.34, p.z));
      const g2 = new THREE.BoxGeometry(off * 0.9, 0.5, 16);
      g2.applyMatrix4(mat4(0, 0, 0, 0, heading, 0));
      g2.translate(p.x, slabTop + 0.05, p.z);
      connectors.push(g2);
      this.addBoxCollider('runway', p.x, slabTop + 0.05, p.z, off * 0.45, 0.25, 8, {
        destructible: false, name: 'Taxiway connector', heading, oriented: true,
        surfaceY: slabTop + 0.3,
      });
    }
    this.mergedMesh(connectors, this._mats.asphalt, 'taxiway_connectors');
    this.mergedMesh(lines, this._mats.paintYellow, 'taxiway_lines');
    this._anchor('landingPads', 'Cochran taxiway', { x: c.x, y: slabTop + 1, z: c.z }, 40);
    return { x: c.x, z: c.z, y: slabTop, off };
  }

  // ------------------------------ 山顶城堡 ------------------------------

  /**
   * 山丘（城堡的地基）：平滑土丘 + 顶部平台，整座丘是一个可降落的 box 平台。
   * @returns {{top:number, x:number, z:number, radius:number}}
   */
  buildHillMound(x, z, radius, height, opts = {}) {
    const base = this._heightAt(x, z) - 2;
    const seg = 22, rings = 6;
    const verts = [], cols = [];
    const grass = new THREE.Color(0x4d6c3c), rock = new THREE.Color(0x6f6a5d);
    const tmp = new THREE.Color();
    const radFn = (a) => 1 + 0.10 * Math.sin(a * 3 + 0.7) + 0.05 * Math.sin(a * 7 + 2.1);
    const ringArr = [];
    for (let k = 1; k <= rings; k++) {
      const t = k * 0.14;                         // 0.14..0.84
      const ring = [];
      for (let j = 0; j < seg; j++) {
        const a = (j / seg) * Math.PI * 2;
        const rr = radius * radFn(a) * Math.pow(1 - t, 0.62);
        ring.push({ x: x + Math.cos(a) * rr, y: base + height * Math.sin(t * Math.PI * 0.62), z: z + Math.sin(a) * rr, t });
      }
      ringArr.push(ring);
    }
    const top = { x, y: base + height * 0.95, z, t: 1 };
    const push = (v) => {
      verts.push(v.x, v.y, v.z);
      tmp.copy(v.t < 0.4 ? grass : rock);
      cols.push(tmp.r, tmp.g, tmp.b);
    };
    const tri = (a, b, c) => { push(a); push(b); push(c); };
    for (let j = 0; j < seg; j++) tri(top, ringArr[rings - 1][(j + 1) % seg], ringArr[rings - 1][j]);
    for (let k = 0; k + 1 < ringArr.length; k++) {
      const A = ringArr[k], B = ringArr[k + 1];
      for (let j = 0; j < seg; j++) {
        const j2 = (j + 1) % seg;
        tri(A[j], B[j], B[j2]);
        tri(A[j], B[j2], A[j2]);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, this._mat('hillRock', () => new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.96, metalness: 0.02, flatShading: true,
    })));
    mesh.name = 'castle_hill';
    this.root.add(mesh);
    // 顶部平台（草皮）
    this.mesh(this._G('unitCyl'), this._mats.grass, x, top.y - 1.2, z, { sx: radius * 0.34, sy: 2.6, sz: radius * 0.34, seg: 20 });
    // 整座山丘作为一个可降落的平台
    const hh = (top.y - (base - 4)) / 2;
    this.addBoxCollider('rock', x, top.y - hh, z, radius * 0.72, hh, radius * 0.72, {
      destructible: false, name: 'Castle hill', heading: 0,
    });
    this._reserve(x, z, radius * 1.05);
    return { top: top.y + 0.4, x, z, radius };
  }

  /** 石砌城堡：城墙 + 雉堞（实例化）+ 角楼 + 门楼 + 主楼 + 旗杆。 */
  buildCastle(x, z, topY, opts = {}) {
    const W = opts.size || 150;
    const D = opts.depth || 120;
    const wallH = opts.wallHeight || 15;
    const wallT = 5.5;
    const ry = opts.ry || 0;
    const g = this.group(x, topY, z);
    g.rotation.y = ry;
    g.name = 'castle';
    const stone = this._mat('castleStone', () => new THREE.MeshStandardMaterial({
      map: this._tex.stoneWall('#8b8375'), color: 0xffffff, roughness: 0.95, metalness: 0.03,
    }));
    const stoneDark = this._mat('castleStoneDark', () => new THREE.MeshStandardMaterial({
      map: this._tex.stoneWall('#6e675b'), color: 0xffffff, roughness: 0.96, metalness: 0.03,
    }));
    const roofMat = this._mat('castleRoof', () => new THREE.MeshStandardMaterial({
      color: 0x6f3a33, roughness: 0.82, metalness: 0.06,
    }));
    // 城墙（4 段，UV 按尺寸平铺）
    const walls = [];
    const mkWall = (w, h, d, tx, ty, tz) => {
      const geo = new THREE.BoxGeometry(w, h, d);
      scaleBoxUV(geo, w, h, d, 7);
      geo.translate(tx, ty, tz);
      walls.push(geo);
    };
    mkWall(W, wallH, wallT, 0, wallH / 2, -D / 2);
    mkWall(W, wallH, wallT, 0, wallH / 2, D / 2);
    mkWall(wallT, wallH, D, -W / 2, wallH / 2, 0);
    mkWall(wallT, wallH, D, W / 2, wallH / 2, 0);
    this.mergedMesh(walls, stone, 'castle_walls', g);
    // 雉堞（实例化）
    const step = 6.5;
    const crenCount = Math.ceil(W / step) * 2 + Math.ceil(D / step) * 2 + 8;
    const cre = this.instanceIn(g, 'unitBox', stoneDark, crenCount, { name: 'castle_crenels' });
    let ci = 0;
    for (let s = 0; s < 4; s++) {
      const len = (s < 2) ? W : D;
      const nn = Math.floor(len / step);
      for (let i = 0; i < nn; i++) {
        const f = (i + 0.5) * step - len / 2;
        let px, pz;
        if (s === 0) { px = f; pz = -D / 2; }
        else if (s === 1) { px = f; pz = D / 2; }
        else if (s === 2) { px = -W / 2; pz = f; }
        else { px = W / 2; pz = f; }
        if (ci < crenCount) this.setInstanceXYZ(cre, ci++, px, wallH + 1.7, pz, 0, 3.4, 3.4, wallT * 0.8);
      }
    }
    cre.count = ci;
    this.finishInstance(cre);
    // 4 座角楼（圆柱 + 锥顶）
    const towers = [], roofs = [];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const tx = sx * W / 2, tz = sz * D / 2;
        towers.push(new THREE.CylinderGeometry(10, 11.5, wallH + 14, 12).translate(tx, (wallH + 14) / 2, tz));
        roofs.push(new THREE.ConeGeometry(12.5, 14, 12).translate(tx, wallH + 14 + 7, tz));
      }
    }
    this.mergedMesh(towers, stone, 'castle_towers', g);
    this.mergedMesh(roofs, roofMat, 'castle_roofs', g);
    // 门楼（南墙） + 吊桥
    this.box(30, wallH + 12, 26, stone, 0, (wallH + 12) / 2, D / 2, { parent: g });
    this.mesh(this._G('unitBox'), this._mats.wreck, 0, wallH * 0.34, D / 2 + 13.3, { sx: 11, sy: wallH * 0.62, sz: 1, parent: g });
    this.mergedMesh([
      new THREE.CylinderGeometry(12, 12, 2.4, 12).rotateX(Math.PI / 2).translate(0, wallH * 0.85, D / 2 - 13.6),
    ], stoneDark, 'castle_gate_arch', g);
    this.box(12, 1.2, 16, this._mats.wood, 0, 0.6, D / 2 + 22, { parent: g });
    // 主楼（keep）：方塔 + 四角小塔 + 雉堞 + 窗
    const kh = 40, kw = 38, kd = 32;
    const keepGeo = new THREE.BoxGeometry(kw, kh, kd);
    scaleBoxUV(keepGeo, kw, kh, kd, 7);
    keepGeo.translate(0, kh / 2, 0);
    const keep = new THREE.Mesh(keepGeo, stone);
    keep.name = 'castle_keep';
    g.add(keep);
    const keepParts = [];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        keepParts.push(new THREE.CylinderGeometry(6.5, 7, kh + 12, 10).translate(sx * kw / 2, (kh + 12) / 2, sz * kd / 2));
        keepParts.push(new THREE.ConeGeometry(8, 10, 10).translate(sx * kw / 2, kh + 12 + 5, sz * kd / 2));
      }
    }
    this.mergedMesh(keepParts, stoneDark, 'keep_turrets', g);
    // 主楼雉堞
    const kc = this.instanceIn(g, 'unitBox', stoneDark, 40, { name: 'keep_crenels' });
    let ki = 0;
    for (const [len, axis, off] of [[kw, 'x', kd / 2], [kw, 'x', -kd / 2], [kd, 'z', kw / 2], [kd, 'z', -kw / 2]]) {
      const nn = Math.floor(len / 7);
      for (let i = 0; i < nn; i++) {
        const f = (i + 0.5) * 7 - len / 2;
        const px = axis === 'x' ? f : off;
        const pz = axis === 'x' ? off : f;
        if (ki < 40) this.setInstanceXYZ(kc, ki++, px, kh + 1.6, pz, 0, 3.4, 3.2, 3.4);
      }
    }
    kc.count = ki;
    this.finishInstance(kc);
    // 主楼发光窗（夜景）
    for (let i = 0; i < 6; i++) {
      const sz = i < 3 ? -kd / 2 - 0.06 : kd / 2 + 0.06;
      const f = ((i % 3) - 1) * kw * 0.28;
      this.mesh(this._G('unitPlane'), this._mats.glassNeon, f, 12 + (i % 2) * 16, sz,
        { sx: 5, sy: 7, ry: i < 3 ? Math.PI : 0, parent: g });
    }
    // 旗杆 + 旗帜
    const flagMat = this._mat('castleFlag', () => new THREE.MeshStandardMaterial({
      map: this._tex.flag('#f2f4f6', '#8c3b31'), color: 0xffffff, roughness: 0.9, side: THREE.DoubleSide,
    }));
    this.cyl(0.4, 0.5, 22, this._mats.metalDark, 0, kh + 12 + 11, 0, { parent: g, seg: 6 });
    const flag = this.mesh(this._G('unitPlane'), flagMat, 6, kh + 12 + 19, 0, { sx: 11, sy: 7, parent: g });
    flag.name = 'castle_flag';
    this._swayers.push({ obj: flag, axis: 'y', base: 0, amp: 0.16, speed: 1.3, phase: this._rng() * 6.28 });
    // 碰撞：4 段城墙 + 4 角楼 + 主楼
    const c = Math.cos(ry), sn = Math.sin(ry);
    const L2W = (lx, lz) => ({ x: x + lx * c + lz * sn, z: z - lx * sn + lz * c });
    const segs = [
      [0, -D / 2, W / 2, wallT / 2], [0, D / 2, W / 2, wallT / 2],
      [-W / 2, 0, wallT / 2, D / 2], [W / 2, 0, wallT / 2, D / 2],
    ];
    for (const [lx, lz, hx2, hz2] of segs) {
      const p = L2W(lx, lz);
      this.addBoxCollider('building', p.x, topY + wallH / 2, p.z,
        hx2, wallH / 2, hz2,
        { destructible: true, health: 1200, mass: 40000, name: 'Castle wall', heading: ry, oriented: true });
    }
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const p = L2W(sx * W / 2, sz * D / 2);
        this.addSphereCollider('tower', p.x, topY + (wallH + 14) * 0.5, p.z, 11.5, {
          destructible: true, health: 2000, mass: 90000, name: 'Castle tower',
        });
      }
    }
    const kc2 = L2W(0, 0);
    this.addBoxCollider('building', kc2.x, topY + kh / 2, kc2.z, kw * 0.78, kh / 2, kd * 0.78, {
      destructible: true, health: 4200, mass: 260000, name: 'Castle keep', object: keep, heading: ry, oriented: true,
    });
    this._stats.buildings += 5;
    this._poi(opts.name || 'Vetusta Castle', x, topY + 58, z, 'castle', Math.max(W, D) * 0.9);
    this._anchor('landingPads', 'Castle courtyard', { x, y: topY + 1.5, z }, Math.min(W, D) * 0.28);
    this._anchor('targets', 'Castle keep', { x, y: topY + 24, z }, 30);
    return g;
  }

  // ------------------------------ 桥梁/道路工具 ------------------------------

  /**
   * 按航点铺路：加密 -> 遇水域/禁区自动断开 -> 每段一条 ribbon（带中线虚线）。
   * @returns {Array<{from:object,to:object}>}
   */
  buildRoadRoute(waypoints, width, opts = {}) {
    const dense = this._densify(waypoints, opts.step || 85);
    const runs = [];
    let cur = [];
    for (const p of dense) {
      const ok = !this._isWater(p.x, p.z) && !this._isReserved(p.x, p.z);
      if (ok) {
        cur.push(p);
      } else if (cur.length > 1) {
        runs.push(cur); cur = [];
      } else {
        cur = [];
      }
    }
    if (cur.length > 1) runs.push(cur);
    const out = [];
    for (const run of runs) {
      const m = this.ribbon(run, width, this._mats.asphalt, {
        lift: 0.16, uvScale: 9, name: opts.name || 'road', centerLine: true, dashScale: opts.dashScale || 6,
      });
      if (m) out.push({ from: run[0], to: run[run.length - 1], mesh: m });
    }
    return out;
  }

  /**
   * 找一条“陆地-水-陆地”的跨海通道（金门大桥用）。
   * 先只试正东/正西/正南/正北：桥面 AABB 精确 => 平台判定最准；找不到再退化为 12 个方向。
   */
  _findStrait(cx, cz, opts = {}) {
    const minSpan = opts.minSpan || 700;
    const maxSpan = opts.maxSpan || 3200;
    const target = opts.target || 1500;
    const maxDist = opts.maxDist || 7000;
    const step = 40;
    // 起点集合：主基准点 + 周围一圈（这样更容易找到“正方向”的海峡）
    const starts = [{ x: cx, z: cz }];
    const ringR = opts.ringR || 1700;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      for (const rr of [ringR * 0.8, ringR * 1.5]) {
        starts.push({ x: cx + Math.cos(a) * rr, z: cz + Math.sin(a) * rr });
      }
    }
    const scan = (angles, axisOnly, over) => {
      let best = null;
      const mn = over && over.minSpan !== undefined ? over.minSpan : minSpan;
      const mx = over && over.maxSpan !== undefined ? over.maxSpan : maxSpan;
      const tg = over && over.target !== undefined ? over.target : target;
      for (const st of starts) {
        if (this._isWater(st.x, st.z)) continue;        // 桥头必须在陆地上
        for (const a of angles) {
          const dx = Math.sin(a), dz = Math.cos(a);
          let s0 = -1, s1 = -1;
          for (let d = 100; d <= maxDist; d += step) {
            const wet = this._isWater(st.x + dx * d, st.z + dz * d);
            if (wet && s0 < 0) s0 = d;
            else if (s0 > 0 && !wet) { s1 = d; break; }
          }
          if (s0 < 0 || s1 < 0) continue;
          const span = s1 - s0;
          if (span < mn || span > mx) continue;
          const far = s1 + 260;                       // 对岸必须还有一段陆地
          const fx = st.x + dx * far, fz = st.z + dz * far;
          if (this._isWater(fx, fz)) continue;
          // 桥面横跨整条水道（含边跨），沿线地形不能高过桥面
          const half = span * 0.84;
          const mid = s0 + span * 0.5;
          let maxGround = -Infinity;
          const nS = Math.max(16, Math.ceil((half * 2) / 42));
          for (let k = 0; k <= nS; k++) {
            const d2 = mid + (k / nS - 0.5) * half * 2;
            const h2 = this._heightAt(st.x + dx * d2, st.z + dz * d2);
            if (h2 > maxGround) maxGround = h2;
          }
          if (maxGround > this.seaLevel + 100) continue;   // 太高的岸不适合架桥
          const west = -dx;                           // 越偏西越贴合“Middleton 在正西”
          const axis = Math.abs(Math.sin(2 * a)) < 0.05;
          const dist = Math.hypot(st.x - cx, st.z - cz);
          const score = Math.abs(span - tg) / tg - west * 0.5 - (axis ? 0.5 : 0)
            + (dist / Math.max(1, ringR)) * 0.4
            + Math.max(0, maxGround - (this.seaLevel + 45)) / 30;
          if (!best || score < best.score) {
            best = {
              score, span, heading: a, axisAligned: axisOnly || axis, maxGround,
              startX: st.x + dx * s0, startZ: st.z + dz * s0,
              endX: st.x + dx * s1, endZ: st.z + dz * s1,
              farX: fx, farZ: fz,
              x: st.x + dx * (s0 + span * 0.5), z: st.z + dz * (s0 + span * 0.5),
            };
          }
        }
      }
      return best;
    };
    const axes = [Math.PI * 1.5, Math.PI, 0, Math.PI * 0.5];     // 西 -> 东 -> 北 -> 南
    // 第一轮：正方向（桥面 AABB 精确，平台判定最准）；放宽跨度要求提高命中率
    let best = scan(axes, true, { minSpan: 420, maxSpan: 4400, target });
    if (!best) {
      const all = [];
      for (let k = 0; k < 12; k++) all.push((k / 12) * Math.PI * 2);
      best = scan(all, false);
      // 斜向命中后尝试吸附到最近的正方向：能得到精确 AABB 就用吸附结果
      if (best) {
        const snapped = Math.round(best.heading / (Math.PI / 2)) * (Math.PI / 2);
        if (Math.abs(Math.sin(snapped) * Math.cos(snapped)) < 0.02) {
          const alt = scan([snapped], true, { minSpan: 420, maxSpan: 4400, target });
          if (alt) best = alt;
        }
      }
    }
    return best;
  }

  // ===========================================================================
  // 九个 kit
  // ===========================================================================

  /**
   * 群岛（贴原版真实世界设定）：
   *  New Yoke 主岛：Wright 机场 + Cochran 大型民用机场（航站楼/廊桥/停车场/滑行道）
   *    + Bandit 机场 + 中部雪山山脉 + 盘山公路（发夹弯）与隧道 + 大片道路网；
   *  Vetusta 城 + 山顶石砌城堡；港湾码头 + 礁石群；
   *  Middleton 悬崖海岸（金门式悬索桥的对岸）；12 环空中赛道保持不变。
   */
  _kitArchipelago() {
    const p = this._primary();
    const sea = this.seaLevel;

    // ---- 1) 先找海峡并架金门式大桥：对岸就是 Middleton ----
    const strait = this._findStrait(p.x, p.z, { minSpan: 700, maxSpan: 3200, target: 1500, maxDist: 7000 });
    let bridge = null;
    if (strait) {
      // 岸线高时把桥面抬高一点，保证整条桥面都在地形之上（默认仍是 66~80m）
      const deckY = clamp(Math.max(sea + 66, (strait.maxGround || sea) + 24), sea + 66, sea + 128);
      bridge = this.buildSuspensionBridge(strait.x, strait.z, strait.heading, {
        span: clamp(strait.span, 700, 2200),
        name: 'Golden Gate Bridge',
        deck: deckY,
      });
    }

    // ---- 2) 三座机场：Wright（出生主跑道）/ Bandit（小）/ Cochran（大型民用）----
    // Wright 出生跑道：长度适配地形平整区半径，避免长跑道切进山体/伸进海里
    const wreg = this._regionAt(p.x, p.z);
    let wLen = wreg && wreg.radius ? clamp(wreg.radius * 2.6, 820, 1300) : 1200;
    let wlvl = this._levelRunwayAround(p.x, p.z, wLen, 48, p.heading, p.y);
    // 地形太陡时逐步缩短出生跑道（短场跑道总比埋进山里好）
    for (const shorter of [0.78, 0.58, 0.42]) {
      if (wlvl.poke < 22 || wLen * shorter < 520) break;
      wLen = Math.max(520, Math.round(wLen * shorter));
      wlvl = this._levelRunwayAround(p.x, p.z, wLen, 48, p.heading, p.y);
    }
    this.buildAirport(wlvl.x, wlvl.z, p.heading, {
      length: wLen, width: 48, y: p.y, name: 'Wright Airfield', label: '09', skirt: true,
    });
    const fB = this._findAirportSpot(p.x - 2600, p.z - 2200, 900, 330, { searchR: 2400 });
    this.buildAirport(fB.x, fB.z, p.heading + 1.25, {
      length: 900, width: 40, name: 'Bandit Field', label: '31', autoLevel: true,
    });
    // Cochran：1.9km 跑道，选最平的地块 + 高原式底板 + 放坡裙边
    const fC = this._findAirportSpot(p.x + 3400, p.z - 1200, 1900, 600, { searchR: 3600 });
    const cochran = this.buildAirport(fC.x, fC.z, p.heading + 0.7, {
      length: 1900, width: 60, name: 'Cochran Airport', label: '27',
      autoLevel: true, terminal: true, parking: true, taxiway: true, gates: 4, apron: 300,
    });

    // ---- 3) Vetusta 城 + 山顶城堡（城市天际线）----
    const cf = this._findFlatSpot(p.x - 2800, p.z + 1400, 2200, 500, true);
    const city = this.buildCity(cf.x, cf.z, 560, { maxHeight: 168, towerName: 'Vetusta Tower' });
    const tall = (city.towers || []).slice().sort((a, b) => b.h - a.h).slice(0, 3);
    for (let i = 0; i < tall.length; i++) {
      const t = tall[i];
      this.buildHelipad(t.x, t.top + 2, t.z, { radius: Math.min(12, t.w * 0.42), name: 'Vetusta rooftop pad' });
      this._poi('Vetusta rooftop', t.x, t.top + 3, t.z, 'rooftop', 40);
    }
    const ch = this._findFlatSpot(cf.x - 950, cf.z + 850, 800, 240, true);
    const mound = this.buildHillMound(ch.x, ch.z, 200, 84, {});
    this.buildCastle(ch.x, ch.z, mound.top, { size: 152, depth: 124, ry: 0.42 });
    this.buildRoadRoute([[cf.x, cf.z], [(cf.x + ch.x) / 2, (cf.z + ch.z) / 2], [ch.x, ch.z]], 20,
      { name: 'castle_road', step: 55 });

    // ---- 4) 中部雪山山脉 + 盘山公路 + 隧道 ----
    const mr = this._findFlatSpot(p.x + 300, p.z + 3300, 2000, 700, true);
    const peaks = this.buildSnowRange(mr.x, mr.z, {
      count: 5, length: 3100, spread: 620, minR: 240, maxR: 430, minH: 270, maxH: 480,
    });
    const roadPeak = peaks.reduce((a, b) => (b.r > a.r ? b : a), peaks[0]);
    const mroad = this.buildMountainRoad(roadPeak, { legs: 6, sweep: 1.4, angle: 1.05 });
    if (mroad && mroad.tunnel) {
      this.buildTunnel(mroad.tunnel.x, mroad.tunnel.z, mroad.tunnel.y, mroad.tunnel.heading,
        { length: 100, radius: 9.5 });
    }

    // ---- 5) 港湾：码头 + 礁石群 + 灯塔 + 小桥 ----
    const ws = this._findWaterSpot(p.x - 1500, p.z - 1200, 3400);
    this.buildDock(ws.x, ws.z, p.heading + 0.4, { length: 200, width: 28 });
    const reefSpot = this._isWater(ws.x + 420, ws.z + 260)
      ? { x: ws.x + 420, z: ws.z + 260 }
      : this._findWaterSpot(ws.x + 320, ws.z + 220, 1800);
    this.buildReef(reefSpot.x, reefSpot.z, 300, 52, { name: 'New Yoke reef' });
    const ls = this._findWaterSpot(p.x + 2400, p.z + 2400, 3000);
    if (this._heightAt(ls.x, ls.z) < sea - 25) {
      this.buildReef(ls.x, ls.z, 90, 14, { name: 'Lighthouse reef', colliders: 2 });
    }
    this.buildLighthouse(ls.x, ls.z);
    const bws = this._findWaterSpot(cf.x + 1500, cf.z - 900, 2600);
    const farFromBig = !bridge || Math.hypot(bws.x - bridge.x, bws.z - bridge.z) > 1300;
    if (farFromBig) {
      const cross = this._crossing(bws.x, bws.z);
      this.buildBridge(cross.x, cross.z, cross.heading, { length: cross.length, width: 24, clearance: 44 });
    }

    // ---- 6) Middleton 岛：悬崖海岸 + 灯塔 + 停机坪 ----
    if (bridge && strait) {
      const cliffs = this.buildCliffCoast(strait.farX, strait.farZ, {
        count: 7, spacing: 100, height: 56, vary: 48, name: 'Middleton Cliffs',
      });
      const top = cliffs.tops[Math.floor(cliffs.tops.length / 2)] || { x: strait.farX, y: sea, z: strait.farZ };
      const inland = { x: top.x - cliffs.dirX * 170, z: top.z - cliffs.dirZ * 170 };
      const iy = Math.max(this._heightAt(inland.x, inland.z), sea);
      this.buildLighthouse(inland.x, inland.z, { height: 34 });
      this.buildHelipad(inland.x + 80, iy + 1.5, inland.z + 60, { radius: 14, name: 'Middleton pad' });
      this.buildStreetlights([[inland.x, inland.z], [inland.x + 80, inland.z + 60]], 1, 4);
      this._anchor('landingPads', 'Middleton cliff top', { x: inland.x + 80, y: iy + 2, z: inland.z + 60 }, 26);
      this._poi('Middleton Cliffs', top.x, top.y + 24, top.z, 'island', 420);
    }

    // ---- 7) 雷达站 + 环岛 ----
    const rf = this._findFlatSpot(p.x + 900, p.z + 1300, 1400, 110, true);
    this.buildRadarStation(rf.x, rf.z, { scale: 1.15, name: 'New Yoke Radar' });
    const rb = this._findFlatSpot(p.x + 260, p.z + 200, 1400, 70, true);
    this._roundabout(rb.x, rb.z);

    // ---- 8) 道路网（遇水域/禁区自动断开）----
    this.buildRoadRoute([[p.x, p.z], [cf.x, cf.z]], 30, { name: 'road_wright_city', step: 90 });
    this.buildRoadRoute([[cf.x, cf.z], [fB.x, fB.z]], 26, { name: 'road_city_bandit', step: 90 });
    this.buildRoadRoute([[p.x, p.z], [cochran.x, cochran.z]], 30, { name: 'road_wright_cochran', step: 90 });
    this.buildRoadRoute([[cochran.x, cochran.z], [cf.x, cf.z]], 26, { name: 'road_cochran_city', step: 90 });
    this.buildRoadRoute([[p.x, p.z], [ws.x, ws.z]], 26, { name: 'road_harbour', step: 90 });
    this.buildRoadRoute([[p.x, p.z], [rf.x, rf.z], [mr.x, mr.z]], 24, { name: 'road_mountain', step: 85 });
    if (mroad && mroad.pts.length) {
      const base = mroad.pts[0];
      this.buildRoadRoute([[p.x, p.z], [base[0], base[2]]], 20, { name: 'road_switchback_access', step: 70 });
    }
    const ring = [];
    for (let i = 0; i < 30; i++) {
      const a = (i / 30) * Math.PI * 2;
      ring.push([p.x + Math.cos(a) * 2500, p.z + Math.sin(a) * 2500]);
    }
    ring.push(ring[0]);
    this.buildRoadRoute(ring, 24, { name: 'ring_road', step: 120 });
    if (bridge) {
      const foot = (Math.hypot(bridge.rampFootA.x - p.x, bridge.rampFootA.z - p.z)
        < Math.hypot(bridge.rampFootB.x - p.x, bridge.rampFootB.z - p.z)) ? bridge.rampFootA : bridge.rampFootB;
      this.buildRoadRoute([foot, [(foot.x + p.x) / 2, (foot.z + p.z) / 2], [p.x, p.z]], 26,
        { name: 'road_bridge_approach', step: 90 });
    }
    // 环岛路灯
    const lampPts = [];
    for (let i = 0; i < 140; i++) {
      const a = (i / 140) * Math.PI * 2;
      const lx = p.x + Math.cos(a) * 2500, lz = p.z + Math.sin(a) * 2500;
      if (!this._isWater(lx, lz)) lampPts.push([lx, lz]);
    }
    for (let i = 0; i < 40; i++) {
      const t = i / 40;
      const lx = lerp(p.x, cochran.x, t), lz = lerp(p.z, cochran.z, t);
      if (!this._isWater(lx, lz)) lampPts.push([lx, lz]);
    }
    this.buildStreetlights(lampPts, 3, 130);

    // ---- 9) 植被 + 空中环赛道（12 环，保持不变）+ 炮塔 + 收集物 ----
    this.buildTrees(2800, { types: ['broadleaf', 'palm', 'conifer'], colliders: 6, maxH: 22 });
    this.makeAirCircuit(p.x, p.z, 2200, { count: 12, altitude: sea + 240, variance: 110 });
    this._addTurretsAlong([
      [p.x + 420, p.z + 160], [cf.x - 260, cf.z + 120], [ws.x + 90, ws.z - 60],
    ], 2, { name: 'Archipelago AA' });
    this._scatterCollectibles(10);
  }

  /** 环岛（转盘道 + 中心喷泉）。 */
  _roundabout(x, z) {
    const n = 22, R = 44;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push([x + Math.cos(a) * R, z + Math.sin(a) * R]);
    }
    this.ribbon(pts, 22, this._mats.asphalt, { lift: 0.2, uvScale: 8, closed: true, name: 'roundabout' });
    const y = this._heightAt(x, z);
    this.plane(R * 1.1, R * 1.1, this._mats.grass, x, y + 0.5, z);
    this.cyl(9, 11, 2.4, this._mats.concrete, x, y + 1.4, z, { seg: 18 });
    this.cyl(7.4, 7.4, 0.6, this._mat('fountain', () => new THREE.MeshStandardMaterial({
      color: 0x2f9fd0, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.8,
    })), x, y + 2.6, z, { seg: 18 });
    this.cyl(1.2, 1.6, 6, this._mats.concrete, x, y + 5, z, { seg: 10 });
    this.sphere(2.2, this._mats.metalDark, x, y + 8.4, z);
    this._poi('Roundabout', x, y + 10, z, 'roundabout', 60);
    return { x, z };
  }

  /** 空中公园：浮动公园岛 + 白色塔群 + 热气球 + 观景台。 */
  _kitSkypark() {
    const p = this._primary();
    const y1 = this.seaLevel + 520;
    // 公园岛
    const park = this.buildFloatingIsland(p.x, y1, p.z, 250, {
      trees: 14, pond: true, structures: true, bob: 1.5, name: 'Sky Park', poi: true,
    });
    this.buildNeonSign(0, 250 * 0.08 + 12, -250 * 0.94, 'SKYPARK', 1.6, { parent: park, width: 70, height: 16, frame: true });
    // 城市岛（白色塔群）
    const y2 = this.seaLevel + 700;
    const cityX = p.x + 720, cityZ = p.z - 320;
    const isl = this.buildFloatingIsland(cityX, y2, cityZ, 360, {
      trees: 6, structures: false, bob: 1.1, name: 'Sky Park City', poi: true,
    });
    const deckY = y2 + 360 * 0.08;   // 岛面高度
    // 白色塔群（SP1 Sky Park City 风格：白色塔身 + 环形观景平台 + 发光带）
    const n = 12;
    let tallest = null;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + this._rng() * 0.2;
      const rr = i === 0 ? 0 : 60 + this._rng() * 210;
      const tx = cityX + Math.cos(a) * rr, tz = cityZ + Math.sin(a) * rr;
      const h = i === 0 ? 300 : 90 + this._rng() * 150;
      const w = 22 + this._rng() * 16;
      const t = this.buildWhiteTower(tx, tz, deckY, w, h, i);
      if (!tallest || h > tallest.h) tallest = { x: tx, z: tz, h, w, item: t };
      this.addBoxCollider('building', tx, deckY + h / 2, tz, w * 0.62, h / 2, w * 0.62, {
        destructible: true, health: 500 + h * 10, mass: w * w * h * 0.3, name: 'Sky tower ' + Math.round(h) + 'm',
      });
    }
    // 观景台（最高塔顶）
    if (tallest) {
      const topY = deckY + tallest.h;
      const ring = this.mesh(this._G('unitCyl'), this._mats.paintWhite, tallest.x, topY + 2, tallest.z,
        { sx: tallest.w * 0.9, sy: 4, sz: tallest.w * 0.9, seg: 20 });
      ring.name = 'observation_deck';
      this.mesh(this._G('unitCyl'), this._mats.glass, tallest.x, topY + 6, tallest.z,
        { sx: tallest.w * 0.92, sy: 4, sz: tallest.w * 0.92, seg: 20 });
      this.buildHelipad(tallest.x, topY + 4, tallest.z, { radius: 13, name: 'Sky Park City helipad' });
      this._poi('Observation deck', tallest.x, topY + 10, tallest.z, 'rooftop', 40);
      // 塔顶航空障碍灯
      this.cyl(0.6, 0.9, 26, this._mats.metal, tallest.x, topY + 24, tallest.z, { seg: 5 });
      this.sphere(1.6, this._mats.beaconRed, tallest.x, topY + 38, tallest.z);
      if (this._lights < 3) {
        const l = new THREE.PointLight(0x9fe8ff, 1200, 1400, 2);
        l.position.set(tallest.x, topY + 20, tallest.z);
        this.addLight(l);
      }
    }
    // 小岛（公园点缀）
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.6;
      this.buildFloatingIsland(p.x + Math.cos(a) * 1200, this.seaLevel + 420 + i * 90, p.z + Math.sin(a) * 1200,
        80 + i * 20, { trees: 5, pond: i === 0, bob: 1.8, name: 'Sky islet ' + (i + 1) });
    }
    // 热气球
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const rr = 300 + this._rng() * 700;
      this.buildBalloon(p.x + Math.cos(a) * rr, this.seaLevel + 300 + this._rng() * 500, p.z + Math.sin(a) * rr,
        { radius: 10 + this._rng() * 5, style: i });
    }
    // 云门（检查点）
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      this.buildCloudGate(p.x + Math.cos(a) * 900, this.seaLevel + 520 + i * 60, p.z + Math.sin(a) * 900,
        52, { ry: -a, name: 'Sky gate ' + (i + 1) });
    }
    // 岛上的树 + 地面植被
    this.buildTrees(1500, { types: ['conifer', 'broadleaf'], colliders: 4 });
    this._scatterCollectibles(8);
  }

  /** 白色科幻塔（SP1 风格：收分塔身 + 发光带 + 顶部天线）。 */
  buildWhiteTower(x, z, baseY, w, h, idx = 0) {
    const g = this.group(x, baseY, z);
    g.name = 'white_tower';
    const geo = this._G(`wtower_${Math.round(w)}_${Math.round(h)}`, () => (
      new THREE.CylinderGeometry(w * 0.42, w * 0.62, h, 8)
    ));
    const body = new THREE.Mesh(geo, this._mats.paintWhite);
    body.position.y = h / 2;
    body.name = 'tower_body';
    g.add(body);
    // 发光窗带
    for (let i = 1; i <= 5; i++) {
      const yy = (h / 6) * i;
      this.mesh(this._G('unitCyl'), this._mats.glassNeon, 0, yy, 0,
        { sx: w * (0.5 - i * 0.012), sy: h * 0.035, sz: w * (0.5 - i * 0.012), parent: g, seg: 8 });
    }
    // 塔顶平台 + 天线 + 障碍灯
    this.mesh(this._G('unitCyl'), this._mats.paintWhite, 0, h + 3, 0, { sx: w * 0.5, sy: 6, sz: w * 0.5, parent: g, seg: 8 });
    this.cyl(0.4, 0.7, h * 0.12, this._mats.metal, 0, h + 8 + h * 0.06, 0, { parent: g, seg: 5 });
    this.sphere(1.0, idx % 2 ? this._mats.beaconRed : this._mats.beaconWhite, 0, h + 12 + h * 0.12, 0, { parent: g });
    this._stats.buildings++;
    return g;
  }

  /** 雪原：冰屋 + 雷达穹顶 + 坠机残骸 + 二战舰队。 */
  _kitSnowstone() {
    const p = this._primary();
    // 雪地营地
    this._reserve(p.x, p.z, 700);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + this._rng();
      const rr = 90 + this._rng() * 320;
      const x = p.x + Math.cos(a) * rr, z = p.z + Math.sin(a) * rr;
      if (this._isWater(x, z)) continue;
      this.buildIgloo(x, z, 8 + this._rng() * 5, this._rng() * 6.28);
    }
    // 雪地跑道 + 塔台
    const strip = this._findFlatSpot(p.x + 900, p.z - 700, 1600, 300);
    this.buildAirport(strip.x, strip.z, p.heading, {
      length: 1100, width: 44, y: strip.y, name: 'Snowstone Strip', label: '18',
    });
    // 雷达穹顶 ×2
    const rf = this._findFlatSpot(p.x - 900, p.z + 600, 1500, 120);
    this.buildRadarDome(rf.x, rf.z, { radius: 16, name: 'Snowstone Dome' });
    const rf2 = this._findFlatSpot(p.x - 1500, p.z - 400, 1500, 110);
    this.buildRadarDome(rf2.x, rf2.z, { radius: 12, name: 'Aux Dome' });
    // 坠机残骸
    for (let i = 0; i < 6; i++) {
      const q = this._randomLandPoint();
      if (!q) break;
      this.buildWreckPlane(q.x, this._heightAt(q.x, q.z) - 1.5, q.z, this._rng() * 6.28, 1.4, { buried: true });
    }
    // 二战舰队（3 艘）
    const ws = this._findWaterSpot(p.x + 1900, p.z + 1400, 3200);
    this.buildShip('destroyer', ws.x - 260, ws.z + 60, 0.5, { name: 'DD-451' });
    this.buildShip('cruiser', ws.x + 40, ws.z + 220, 0.35, { name: 'CA-38' });
    this.buildShip('carrier', ws.x + 70, ws.z - 320, 0.62, { name: 'USS Snowstone' });
    this.buildShip('wreck', ws.x - 420, ws.z + 420, 1.1, { name: 'Frozen Hulk' });
    // 灯塔 + 浮冰 + 油井平台
    const ls = this._findWaterSpot(p.x - 2200, p.z - 1600, 3000);
    this.buildLighthouse(ls.x, ls.z, { height: 38 });
    this.buildIceField(ls.x, ls.z, 700, 30);
    // 油井平台（海上）
    const rs = this._findWaterSpot(p.x + 2600, p.z - 2000, 3200);
    this.buildOilRig(rs.x, rs.z, { deckHeight: 28 });
    // 油井平台附近的炮塔 + 岸防炮
    this._addTurretsAlong([[strip.x + 240, strip.z + 180], [ws.x - 200, ws.z + 200]], 2, { name: 'Snowstone AA' });
    // 雪松
    this.buildTrees(1600, { types: ['conifer'], snow: true, colliders: 5, maxH: 24 });
    this._scatterCollectibles(8);
  }

  /** 沙漠：小镇 + 绿洲 + 金字塔 + 海盗船 + 油井。 */
  _kitMaywar() {
    const p = this._primary();
    const town = this._findFlatSpot(p.x, p.z, 1400, 260);
    this._reserve(town.x, town.z, 420);
    // 小镇：土黄平顶房 + 集市
    for (let i = 0; i < 14; i++) {
      const a = this._rng() * Math.PI * 2;
      const rr = 60 + this._rng() * 230;
      const x = town.x + Math.cos(a) * rr, z = town.z + Math.sin(a) * rr;
      if (this._isWater(x, z)) continue;
      this.buildDesertHouse(x, z, 14 + this._rng() * 14, 12 + this._rng() * 12, 6 + this._rng() * 5, this._rng() * 6.28);
    }
    // 集市大棚
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const x = town.x + Math.cos(a) * 46, z = town.z + Math.sin(a) * 46;
      const y = this._heightAt(x, z);
      const stall = this.group(x, y, z);
      stall.rotation.y = a;
      this.box(7, 0.3, 5, this._rng() < 0.5 ? this._mats.paintRed : this._mats.hullRed, 0, 3.4, 0,
        { parent: stall, rz: 0.05 });
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        this.cyl(0.12, 0.12, 3.4, this._mats.wood, sx * 3, 1.7, sz * 2, { parent: stall, seg: 5 });
      }
      this.buildCrate(x + 2, y, z + 2, this._rng());
    }
    // 绿洲 ×2
    const o1 = this._findFlatSpot(p.x + 1200, p.z + 800, 1400, 200);
    this.buildOasis(o1.x, o1.z, 60);
    const o2 = this._findFlatSpot(p.x - 1400, p.z - 900, 1600, 160);
    this.buildOasis(o2.x, o2.z, 44);
    // 金字塔 + 遗迹
    const pf = this._findFlatSpot(p.x - 900, p.z + 1500, 1600, 260);
    this.buildPyramid(pf.x, pf.z, 110, 0.3);
    this.buildPyramid(pf.x + 210, pf.z + 130, 62, 0.9);
    const rf = this._findFlatSpot(p.x + 1800, p.z - 700, 1600, 200);
    this.buildRuins(rf.x, rf.z, 90, 18);
    // 海盗船（若附近有水域）
    const ws = this._findWaterSpot(p.x + 2400, p.z + 1800, 3600);
    const onWater = this._isWater(ws.x, ws.z);
    this.buildShip('pirate', ws.x, ws.z, 0.9, { name: 'Black Sand' });
    // 沙漠跑道（土跑道）
    const strip = this._findFlatSpot(p.x + 600, p.z - 1200, 1600, 320);
    this.buildAirport(strip.x, strip.z, p.heading + 0.6, {
      length: 900, width: 38, y: strip.y, name: 'Maywar Field', label: '36',
    });
    // 油井：抽油机 + 井架 + 油罐
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.5;
      const rr = 500 + this._rng() * 400;
      const x = town.x + Math.cos(a) * rr, z = town.z + Math.sin(a) * rr;
      if (this._isWater(x, z)) continue;
      const y = this._heightAt(x, z);
      this.buildPumpjack(x, y, z, this._rng() * 6.28);
      if (i % 2 === 0) this.buildDerrick(x + 60, y, z + 50);
      const tank = this.cyl(7, 7, 9, this._mats.rust, x - 34, y + 4.5, z + 20, { seg: 12 });
      this.sphere(7, this._mats.metalDark, x - 34, y + 9, z + 20, { sy: 0.3 });
      this.addSphereCollider('prop', x - 34, y + 5, z + 20, 7.4, {
        destructible: true, health: 400, mass: 8000, name: 'Oil tank', object: tank,
      });
    }
    // 炮塔 + 植被（枯树/棕榈）
    this._addTurretsAlong([[town.x + 160, town.z + 160], [pf.x - 120, pf.z + 120]], 2, { name: 'Maywar AA' });
    this.buildTrees(1500, { types: ['dead', 'palm'], colliders: 4, maxH: 12 });
    if (onWater) this.buildDock(ws.x, ws.z, 1.4, { length: 140, width: 20 });
    this._scatterCollectibles(8);
  }

  /** 纯城市：密集高楼 + 高架路 + 体育场 + 楼顶直升机坪 + 霓虹。 */
  _kitVetusta() {
    const p = this._primary();
    const cf = this._findFlatSpot(p.x, p.z, 1200, 620);
    const city = this.buildCity(cf.x, cf.z, 900, {
      block: 112, street: 30, minHeight: 38, maxHeight: 188, towerName: 'Vetusta Tower',
    });
    // 高架环路
    const vp = [];
    const n = 20;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = 560 * (1 + 0.1 * Math.sin(a * 2.4));
      vp.push([cf.x + Math.cos(a) * rr, cf.z + Math.sin(a) * rr * 0.8]);
    }
    this.buildElevatedRoad(vp, { altitude: city.baseY + 24, width: 26, closed: true });
    // 体育场
    const sf = this._findFlatSpot(cf.x - 900, cf.z + 800, 900, 220);
    this.buildStadium(sf.x, sf.z, { radius: 140, y: sf.y });
    // 楼顶直升机坪（最高的几栋）
    const towers = (city.towers || []).slice().sort((a, b) => b.h - a.h).slice(0, 6);
    for (let i = 0; i < towers.length; i++) {
      const t = towers[i];
      this.buildHelipad(t.x, t.top + 2, t.z, { radius: Math.min(13, t.w * 0.42), name: 'Rooftop pad' });
      if (i < 4) this._poi('Vetusta rooftop', t.x, t.top + 2, t.z, 'rooftop', 40);
    }
    // 霓虹 + 广告牌（挂在楼身 40% 高度处）
    const names = Object.keys(this._mats.neon);
    for (let i = 0; i < names.length; i++) {
      const t = towers[i % Math.max(1, towers.length)] || { x: cf.x, z: cf.z, top: city.baseY + 60, h: 60, w: 40 };
      this.buildNeonSign(t.x + 14, t.top - t.h * 0.42, t.z + 14, names[i], 1.3,
        { ry: this._rng() * 6.28, frame: true, billboard: i < 2 });
    }
    this.buildBillboard(cf.x + 260, cf.z - 260, 'HOTEL', { y: city.baseY + 30, height: 26 });
    this.buildBillboard(cf.x - 280, cf.z + 240, 'CASINO', { y: city.baseY + 30, height: 26 });
    // 中央公园
    this._plaza(cf.x, cf.z, city.baseY, 120);
    // 少量行道树 + 街道灯已由 buildCity 生成
    this.buildTrees(700, { types: ['broadleaf'], colliders: 3, minH: 6, maxH: 14, bushes: false });
    // 炮塔
    this._addTurretsAlong([[cf.x + 300, cf.z + 300], [sf.x, sf.z - 200]], 2, { name: 'Vetusta AA' });
    this._scatterCollectibles(10);
    // 城区不需要额外天空环
  }

  /** 竞速：地面闭环赛道 + 12 个空中圆环 + 看台 + 塔台。 */
  _kitRaceway() {
    const p = this._primary();
    const tf = this._findFlatSpot(p.x, p.z, 1500, 700);
    const track = this.buildRaceTrack(tf.x, tf.z, { a: 620, b: 400, width: 26, y: tf.y, segments: 36 });
    // 空中环赛道（12 环，半径 35m，绕地面赛道上方一圈）
    this.makeAirCircuit(tf.x, tf.z, 900, {
      count: 12, altitude: tf.y + 150, variance: 70, ringRadius: 35,
    });
    // 起终点附近的看台/塔台/维修道已由 buildRaceTrack 生成；这里补充植被与灯
    const lampPts = [];
    for (let i = 0; i < track.points.length; i += 1) {
      const a = track.points[i], b = track.points[(i + 1) % track.points.length];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const dl = Math.hypot(dx, dz) || 1;
      lampPts.push([a[0] - (dz / dl) * 22, a[1] + (dx / dl) * 22]);
    }
    this.buildStreetlights(lampPts, 2, 120);
    this.buildTrees(1200, { types: ['broadleaf', 'conifer'], colliders: 4 });
    // 加油区 + 集装箱
    this.buildContainerYard(tf.x + 640, tf.z + 40, { rows: 3, cols: 4, gap: 24, y: tf.y, colliders: 6, name: 'Paddock' });
    this._scatterCollectibles(8);
  }

  /** 海军：USS Tiny 航母 + 二战舰队 + 海盗船 + 灯塔 + 钻井平台 + 海怪。 */
  _kitNaval() {
    const p = this._primary();
    // 陆地机场（起飞点）
    const strip = this._findFlatSpot(p.x, p.z, 1500, 320);
    this.buildAirport(strip.x, strip.z, p.heading, {
      length: 1100, width: 44, y: strip.y, name: 'Naval Air Station', label: '27',
    });
    // 舰队集结海域
    const ws = this._findWaterSpot(strip.x + 2200, strip.z + 1400, 3600);
    this.buildShip('carrier', ws.x, ws.z, 1.15, { name: 'USS Tiny' });
    // 甲板炮塔：航母局部坐标 (前向 f, 右向 r) -> 世界；甲板高度 = 吃水修正后的飞行甲板
    const ch = 1.15, cs = Math.sin(ch), cc = Math.cos(ch);
    const deckY = this.seaLevel + (24 - 8) + 2.2;
    const onDeck = (f, r) => ({ x: ws.x - cs * f + cc * r, z: ws.z - cc * f - cs * r });
    const t1 = onDeck(0, 30), t2 = onDeck(-150, 30);
    this.addTurret(t1.x, deckY, t1.z, { name: 'Carrier CIWS', range: 900 });
    this.addTurret(t2.x, deckY, t2.z, { name: 'Carrier CIWS', range: 900 });
    this.buildShip('destroyer', ws.x - 520, ws.z + 260, 0.8, { name: 'USS Tiny escort' });
    this.buildShip('cruiser', ws.x + 380, ws.z + 300, 1.35, { name: 'USS Tiny cruiser' });
    this.buildShip('destroyer', ws.x + 220, ws.z - 420, 0.4, { name: 'USS Tiny picket' });
    // 海盗船 + 灯塔 + 钻井平台 + 海怪
    const pws = this._findWaterSpot(strip.x - 1800, strip.z + 900, 3000);
    this.buildShip('pirate', pws.x, pws.z, 2.1, { name: 'Black Tide' });
    const ls = this._findWaterSpot(strip.x + 900, strip.z - 1500, 3000);
    this.buildLighthouse(ls.x, ls.z, { height: 36 });
    const rig = this._findWaterSpot(strip.x - 900, strip.z - 900, 3000);
    this.buildOilRig(rig.x, rig.z, { deckHeight: 24 });
    const kx = this._findWaterSpot(strip.x + 2700, strip.z - 1200, 3600);
    this.buildKraken(kx.x, kx.z, { scale: 1.15 });
    // 码头（后方补给，必须落在水面上）
    const dockAt = this._findWaterSpot(strip.x + 60, strip.z - 900, 3000);
    this.buildDock(dockAt.x, dockAt.z, p.heading + Math.PI, { length: 180, width: 26 });
    // 岸防炮塔
    this._addTurretsAlong([[strip.x - 200, strip.z + 160], [strip.x + 220, strip.z - 160]], 2, { name: 'Shore battery' });
    this.buildTrees(900, { types: ['palm', 'broadleaf'], colliders: 3 });
    this._scatterCollectibles(9);
  }

  /** 飞机坟场：50+ 废弃机体 + 废料 + 起重机 + 铁丝网 + 集装箱迷宫。 */
  _kitBoneyard() {
    const p = this._primary();
    const f = this._findFlatSpot(p.x, p.z, 1400, 420);
    this._reserve(f.x, f.z, 520);
    // 简跑道
    this.buildAirport(f.x, f.z, p.heading, {
      length: 1000, width: 38, y: f.y, name: 'Boneyard Strip', label: '09',
    });
    // 废弃机体（一条条停放的实例化机队）
    const nWreck = Math.round(56 * (0.6 + this.density * 0.7));
    const mat = this._mat('wreckMat', () => new THREE.MeshStandardMaterial({
      vertexColors: true, map: this._tex.rust(), roughness: 0.9, metalness: 0.35, color: 0xc9ced4,
    }));
    const im = this.instance('wreckCraft', mat, nWreck, { name: 'aircraft_wrecks' });
    for (let i = 0; i < nWreck; i++) {
      const row = i % 6;
      const col = Math.floor(i / 6);
      const x = f.x - 300 + row * 42 + (this._rng() - 0.5) * 6;
      const z = f.z + 180 + col * 46 + (this._rng() - 0.5) * 6;
      const y = this._heightAt(x, z);
      const buried = this._rng() < 0.3;
      this.setInstance(im, i, x, y + (buried ? -1.6 : -0.2), z, Math.PI / 2 + (this._rng() - 0.5) * 0.18,
        0.9 + this._rng() * 0.3, (this._rng() - 0.5) * 0.12);
      if (i % 5 === 0) {
        this.addBoxCollider('prop', x, y + 2, z, 4.5, 2.4, 7, {
          destructible: true, health: 220, mass: 4000, name: 'Aircraft wreck',
        });
      }
    }
    this.finishInstance(im);
    this._stats.aircraft = (this._stats.aircraft || 0) + nWreck;
    // 散落的机翼/尾翼
    const scrap = this._G('partGeo', () => mergeGeos([
      { geo: new THREE.BoxGeometry(11, 0.25, 2), matrix: mat4(0, 0, 0), color: 0xb9bec4 },
      { geo: new THREE.BoxGeometry(0.22, 2, 1.4), matrix: mat4(0, 1, 3), color: 0xa9aeb4 },
    ]));
    const pim = this.instance(scrap, mat, 40, { name: 'wreck_parts' });
    for (let i = 0; i < 40; i++) {
      const x = f.x + (this._rng() - 0.5) * 520, z = f.z + (this._rng() - 0.5) * 520;
      this.setInstance(pim, i, x, this._heightAt(x, z) + 0.3, z, this._rng() * 6.28, 1 + this._rng() * 0.6,
        (this._rng() - 0.5) * 0.4);
    }
    this.finishInstance(pim);
    // 废料堆
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      this.buildScrapPile(f.x + Math.cos(a) * 380, f.z + Math.sin(a) * 340, 26 + this._rng() * 14, 60);
    }
    // 起重机
    this.buildCrane(f.x - 260, f.z - 200, { height: 36 });
    this.buildCrane(f.x + 320, f.z + 240, { height: 30, speed: -0.2 });
    // 集装箱迷宫
    this.buildContainerYard(f.x + 300, f.z - 260, { rows: 6, cols: 6, gap: 26, colliders: 24, name: 'Boneyard containers' });
    // 铁丝网围栏（矩形）
    const R = 520;
    this.buildFence([
      [f.x - R, f.z - R], [f.x + R, f.z - R], [f.x + R, f.z + R], [f.x - R, f.z + R], [f.x - R, f.z - R],
    ], { spacing: 8 });
    // 炮塔（靶场）
    this._addTurretsAlong([[f.x - 380, f.z + 380], [f.x + 380, f.z - 380]], 3, { name: 'Boneyard AA', spread: 40 });
    // 枯树 + 灌木
    this.buildTrees(1000, { types: ['dead'], colliders: 3, maxH: 12 });
    this._scatterCollectibles(9);
  }

  /** 高空：多个浮空岛 + 巨型飞艇 + 气球 + 云门。 */
  _kitStratos() {
    const p = this._primary();
    const alt0 = this.seaLevel + 820;
    // 主岛（有机场平台）
    const main = this.buildFloatingIsland(p.x, alt0, p.z, 300, {
      trees: 16, pond: true, structures: true, bob: 1.4, name: 'Stratos Hub',
    });
    this.buildHelipad(0, 300 * 0.08 + 1, 0, { parent: main, radius: 18, anchor: false });
    this._anchor('landingPads', 'Stratos Hub pad', { x: p.x, y: alt0 + 300 * 0.08 + 2, z: p.z }, 22);
    this.buildNeonSign(0, 300 * 0.08 + 13, -300 * 0.94, 'STRATOS', 1.5, { parent: main, width: 80, height: 18, frame: true });
    // 其他浮岛
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.3;
      const rr = 700 + this._rng() * 1600;
      const size = 70 + this._rng() * 150;
      const alt = alt0 + (this._rng() - 0.35) * 700;
      const ix = p.x + Math.cos(a) * rr, iz = p.z + Math.sin(a) * rr;
      this.buildFloatingIsland(ix, alt, iz, size, {
        trees: 4 + Math.floor(this._rng() * 8), pond: this._rng() < 0.4,
        structures: this._rng() < 0.5, bob: 0.8 + this._rng() * 1.4, name: 'Stratos isle ' + (i + 1),
      });
      void ix; void iz;
    }
    // 巨型飞艇 ×2
    this.buildAirship(p.x + 400, alt0 + 320, p.z - 300, 0.6, { radius: 30, length: 190 });
    this.buildAirship(p.x - 900, alt0 + 120, p.z + 700, -1.1, { radius: 22, length: 140 });
    // 热气球
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.8;
      const rr = 350 + this._rng() * 900;
      this.buildBalloon(p.x + Math.cos(a) * rr, alt0 + (this._rng() - 0.4) * 400, p.z + Math.sin(a) * rr,
        { radius: 9 + this._rng() * 6, style: i });
    }
    // 云门 ×5 作为检查点
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      this.buildCloudGate(p.x + Math.cos(a) * 1500, alt0 + 120 + i * 40, p.z + Math.sin(a) * 1500,
        60, { ry: -a + Math.PI / 2, name: 'Stratos gate ' + (i + 1) });
    }
    // 地面参照物：海岸灯塔 + 码头（从高空俯视时提供尺度感）
    const ls = this._findWaterSpot(p.x + 2400, p.z + 1800, 3400);
    this.buildLighthouse(ls.x, ls.z, { height: 42 });
    this.buildDock(ls.x, ls.z, 0.6, { length: 160, width: 24 });
    // 地面植被（低空观赏）
    this.buildTrees(1200, { types: ['conifer', 'broadleaf'], colliders: 4 });
    this._scatterCollectibles(10);
  }
}
