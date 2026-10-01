/**
 * 通用工具：随机数、数学、格式化、程序化贴图、事件总线。
 * 无 three.js 依赖（贴图部分用到 Canvas）。
 */
import * as THREE from 'three';

/* ------------------------------------------------------------------ 随机数 */
/** 确定性 PRNG（mulberry32） */
export function makeRng(seed = 1) {
  let a = (seed >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 简单哈希噪声（用于贴图） */
export function hash2(x, y, seed = 1337) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/* ------------------------------------------------------------------ 数学 */
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => clamp(v, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (a, b, x) => { const t = clamp01(invLerp(a, b, x)); return t * t * (3 - 2 * t); };
export const damp = (cur, target, lambda, dt) => lerp(cur, target, 1 - Math.exp(-lambda * dt));
export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const wrapPi = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
export const deg = (r) => r * RAD2DEG;
export const rand = (rng, a, b) => a + rng() * (b - a);
export const randInt = (rng, a, b) => Math.floor(a + rng() * (b - a + 1));
export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];

/* ------------------------------------------------------------------ 格式化 */
export const fmt = (v, digits = 0) => (Number.isFinite(v) ? v.toFixed(digits) : '--');
export function fmtTime(sec) {
  if (!Number.isFinite(sec)) return '--:--';
  const neg = sec < 0; sec = Math.abs(sec);
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${neg ? '-' : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
/** m/s -> km/h */
export const msToKmh = (v) => v * 3.6;
/** m/s -> 节 */
export const msToKts = (v) => v * 1.94384;
/** 米 -> 英尺 */
export const mToFt = (v) => v * 3.28084;
export const msToMach = (v, altitude) => v / Math.max(1, soundSpeed(altitude));
/** 标准大气音速 */
export const soundSpeed = (alt) => 340.29 * Math.sqrt(Math.max(0.5, 1 - 2.25577e-5 * clamp(alt, -500, 20000)));

/* ------------------------------------------------------------------ 事件总线 */
export class Emitter {
  constructor() { this._m = new Map(); }
  on(ev, fn) { if (!this._m.has(ev)) this._m.set(ev, new Set()); this._m.get(ev).add(fn); return () => this.off(ev, fn); }
  off(ev, fn) { const s = this._m.get(ev); if (s) s.delete(fn); }
  emit(ev, ...args) { const s = this._m.get(ev); if (s) for (const f of [...s]) { try { f(...args); } catch (e) { console.error('[emitter]', ev, e); } } }
  clear() { this._m.clear(); }
}

/* ------------------------------------------------------------------ 程序化贴图（Canvas） */
function canvas(w, h) {
  if (typeof document === 'undefined' || !document.createElement) return null;
  try {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    if (!c.getContext || (!c.getContext('2d') && !c.getContext('webgl'))) return null;
    return c;
  } catch { return null; }
}
/** 取得 2D 上下文，失败返回 null（不要在无 Canvas 环境下抛异常） */
function ctx2d(c) {
  if (!c || !c.getContext) return null;
  try { return c.getContext('2d'); } catch { return null; }
}

/** 生成带噪点的地表细节贴图 */
export function makeDetailTexture(size = 256, opts = {}) {
  const c = canvas(size, size); if (!c) return null;
  const ctx = ctx2d(c); if (!ctx) return null;
  const img = ctx.createImageData(size, size);
  const seed = opts.seed ?? 7;
  const scale = opts.scale ?? 24;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 周期化噪声：让贴图可无缝平铺
      const u = x / size * scale, v = y / size * scale;
      let n = 0, amp = 1, f = 1;
      for (let o = 0; o < 4; o++) {
        n += amp * tileNoise(u * f, v * f, scale * f, seed + o * 31);
        amp *= 0.5; f *= 2;
      }
      const g = clamp(190 + (n - 0.5) * (opts.contrast ?? 70), 0, 255);
      const i = (y * size + x) * 4;
      img.data[i] = g * (opts.tint?.[0] ?? 1);
      img.data[i + 1] = g * (opts.tint?.[1] ?? 1);
      img.data[i + 2] = g * (opts.tint?.[2] ?? 1);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** 可平铺的 value noise */
function tileNoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
  const w = (a, b) => hash2(((a % period) + period) % period, ((b % period) + period) % period, seed);
  const n00 = w(xi, yi), n10 = w(xi + 1, yi), n01 = w(xi, yi + 1), n11 = w(xi + 1, yi + 1);
  return lerp(lerp(n00, n10, sx), lerp(n01, n11, sx), sy);
}

/** 生成建筑窗户贴图（带自发光格纹），返回 { map, emissive } */
export function makeWindowTexture(opts = {}) {
  const size = opts.size ?? 256;
  const cols = opts.cols ?? 8, rows = opts.rows ?? 12;
  const lit = opts.litColor ?? [255, 214, 140];
  const base = opts.baseColor ?? [42, 48, 58];
  const cm = canvas(size, size), ce = canvas(size, size);
  if (!cm || !ce) return { map: null, emissive: null };
  const gm = ctx2d(cm), ge = ctx2d(ce);
  if (!gm || !ge) return { map: null, emissive: null };
  gm.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`; gm.fillRect(0, 0, size, size);
  ge.fillStyle = '#000'; ge.fillRect(0, 0, size, size);
  const rng = makeRng(opts.seed ?? 3);
  const cw = size / cols, ch = size / rows;
  for (let r = 0; r < rows; r++) {
    for (let cI = 0; cI < cols; cI++) {
      const x = cI * cw + cw * 0.18, y = r * ch + ch * 0.18;
      const w = cw * 0.64, h = ch * 0.64;
      const on = rng() < (opts.litChance ?? 0.45);
      if (on) {
        const k = 0.6 + rng() * 0.4;
        const col = `rgb(${lit[0] * k | 0},${lit[1] * k | 0},${lit[2] * k | 0})`;
        gm.fillStyle = col; gm.fillRect(x, y, w, h);
        ge.fillStyle = col; ge.fillRect(x, y, w, h);
      } else {
        gm.fillStyle = `rgba(20,26,34,0.95)`; gm.fillRect(x, y, w, h);
      }
    }
  }
  // 楼层分割线
  gm.fillStyle = 'rgba(0,0,0,0.35)';
  for (let r = 1; r < rows; r++) gm.fillRect(0, r * ch - 1, size, 2);
  const mk = (cv, srgb) => { const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; };
  return { map: mk(cm, true), emissive: mk(ce, true) };
}

/** 生成天空渐变贴图（等距柱状投影，用作 scene.background） */
export function makeSkyTexture(topColor, midColor, bottomColor, size = 512) {
  const c = canvas(size, size / 2); if (!c) return null;
  const ctx = ctx2d(c); if (!ctx) return null;
  const g = ctx.createLinearGradient(0, 0, 0, c.height);
  g.addColorStop(0, topColor); g.addColorStop(0.5, midColor); g.addColorStop(1, bottomColor);
  ctx.fillStyle = g; ctx.fillRect(0, 0, c.width, c.height);
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 生成简单材质噪声贴图（用于金属/机身） */
export function makePaintTexture(color = '#c8d2dc', seed = 11, size = 128) {
  const c = canvas(size, size); if (!c) return null;
  const ctx = ctx2d(c); if (!ctx) return null;
  ctx.fillStyle = color; ctx.fillRect(0, 0, size, size);
  const rng = makeRng(seed);
  ctx.globalAlpha = 0.06;
  for (let i = 0; i < 700; i++) {
    ctx.fillStyle = rng() > 0.5 ? '#fff' : '#000';
    ctx.fillRect(rng() * size, rng() * size, 1 + rng() * 2, 1 + rng() * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ------------------------------------------------------------------ 其它 */
export function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

export function formatMass(kg) { return kg >= 1000 ? `${(kg / 1000).toFixed(2)} t` : `${kg.toFixed(0)} kg`; }
export function formatMoney(v) { return `$${Math.round(v).toLocaleString('en-US')}`; }

/** 按半径/高度建立世界坐标 AABB 与球体相交测试（供物理模块使用） */
export function sphereAabbOverlap(cx, cy, cz, r, minx, miny, minz, maxx, maxy, maxz) {
  const px = clamp(cx, minx, maxx), py = clamp(cy, miny, maxy), pz = clamp(cz, minz, maxz);
  const dx = cx - px, dy = cy - py, dz = cz - pz;
  return dx * dx + dy * dy + dz * dz <= r * r;
}

/** 对象池 */
export class Pool {
  constructor(factory, reset, size = 32) {
    this.factory = factory; this.reset = reset;
    this.free = []; this.used = [];
    for (let i = 0; i < size; i++) this.free.push(factory());
  }
  acquire() { const o = this.free.pop() || this.factory(); this.used.push(o); return o; }
  release(o) { const i = this.used.indexOf(o); if (i >= 0) this.used.splice(i, 1); this.reset?.(o); this.free.push(o); }
  releaseAll() { while (this.used.length) this.release(this.used[0]); }
}

/** localStorage 安全封装 */
export const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
