/**
 * 风场（Wind Field）
 * ------------------------------------------------------------------
 * 给飞行器提供「随位置和时间变化」的真实气流，而不是一个到处都一样的常量风。
 * 四层叠加（全部零分配，热路径只做几次算术）：
 *
 *   1. 基础风   —— 地图设定的风向/风速，随高度缓慢右偏（埃克曼螺旋的简化：地转风）
 *   2. 边界层   —— 贴地风被地面摩擦削弱（1/7 次幂律），120m 以上才接近自由大气
 *   3. 地形气流 —— 迎风坡上升、背风坡下沉（+ 山体绕流的侧向偏转），滑翔机能真正“骑”上去
 *   4. 阵风湍流 —— 多层正弦/噪声叠加，随高度增强；低空偶发下击暴流式的强阵风
 *
 * 用法：
 *   const w = new WindField(terrain, { speed, dir, gust, turbulence });
 *   w.update(dt);
 *   w.sample(x, y, z, w);        // 写入 out，返回 out
 *   w.horizontal  -> 地面风速（HUD/风袋用）
 *   w.heading     -> 风来向（弧度）
 */
import * as THREE from 'three';
import { clamp, clamp01 } from '../core/util.js';

/** 边界层厚度（米）：这个高度以上风速不再随高度增加 */
const BL_TOP = 120;
/** 山体爬坡气流的经验系数：w = k * U·∇h */
const SLOPE_LIFT = 0.55;
/** 山体高度对爬坡气流的饱和（太陡的山不会给出无限升力） */
const SLOPE_MAX = 9;

const _n = new THREE.Vector3();

export class WindField {
  /**
   * @param {object} terrain 地形（需要有 heightAt / normalAt；可为空）
   * @param {object} opts { speed: 地面风速 m/s, dir: 风来向(弧度), gust: 0..1, turbulence: 0..1,
   *                        veer: 高度每 1000m 右偏角度(弧度), seed }
   */
  constructor(terrain, opts = {}) {
    this.terrain = terrain || null;
    this.baseSpeed = clamp(opts.speed ?? 5, 0, 40);
    this.baseDir = opts.dir ?? 0.6;              // 风向（风的来向）
    this.gust = clamp01(opts.gust ?? 0.35);
    this.turbulence = clamp01(opts.turbulence ?? 0.3);
    this.veer = opts.veer ?? 0.32;               // 地转风随高度右偏
    this.time = 0;
    this.seed = opts.seed ?? 7.13;

    this.dir = this.baseDir;
    this.speed = this.baseSpeed;
    this.gustPhase = 0;
    /** 本帧的地面风（HUD 用） */
    this.horizontal = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this.blend = opts.blend ?? 1;                // 0 = 无风（调试用）
    this._refresh(0);
  }

  /** 每帧推进（dt 秒） */
  update(dt) {
    this.time += dt;
    this._refresh(dt);
  }

  /** 风向缓慢摆动 + 阵风包络（一次/帧，采样时不再重复计算） */
  _refresh(dt) {
    this.dir = this.baseDir + Math.sin(this.time * 0.037 + this.seed) * 0.22
      + Math.sin(this.time * 0.0113 + this.seed * 2.7) * 0.35;
    this.gustPhase = Math.sin(this.time * 0.53 + this.seed) * 0.6
      + Math.sin(this.time * 1.27 + this.seed * 3.1) * 0.4;
    // 阵风包络：偶发强阵风（0.93~1.0 的慢包络把“阵风簇”聚在一起）
    const burst = clamp01(Math.sin(this.time * 0.081 + this.seed * 1.7) * 0.5 + 0.5);
    const gustMul = 1 + this.gust * (this.gustPhase * 0.35 + burst * 0.55);
    this.speed = this.baseSpeed * gustMul;
    // 地面风矢量（机头朝 -Z 为北；水平风 = 风的去向矢量）
    this.horizontal.set(-Math.sin(this.dir), 0, Math.cos(this.dir)).multiplyScalar(this.speed);
  }

  /**
   * 采样某点的风矢量（世界坐标，m/s）。
   * @param {number} x @param {number} y @param {number} z
   * @param {THREE.Vector3} out
   */
  sample(x, y, z, out) {
    out.set(0, 0, 0);
    if (this.blend <= 0.001 || this.baseSpeed <= 0.01) return out;
    const t = this.time;
    const gx = x * 0.00058, gz = z * 0.00058;   // 大尺度阵风的空间频率

    // ---- 1/2. 基础风 + 边界层 + 地转风右偏 ----
    let ground = 0;
    if (this.terrain) ground = this.terrain.heightAt(x, z) || 0;
    const h = Math.max(0, y - ground);
    // 边界层剖面：贴地 45% 风速，120m 以上满速（1/7 次幂律）
    const bl = 0.45 + 0.55 * Math.pow(clamp01(h / BL_TOP), 1 / 7);
    const s = this.speed * bl;
    const d = this.dir + this.veer * clamp(h, 0, 3000) / 1000;
    // 约定：机头朝 -Z 为北（heading 0），dir 为「风的来向」（0=正北风）
    // 北风从 -Z 吹向 +Z，东风从 +X 吹向 -X
    out.x = -Math.sin(d) * s;
    out.z = Math.cos(d) * s;

    // ---- 3. 地形气流：迎风坡上升 / 背风坡下沉 + 绕流侧偏 ----
    if (this.terrain && h < 900) {
      const n = this.terrain.normalAt(x, z, _n);
      const ux = out.x, uz = out.z;
      const decay = Math.exp(-h / 420);
      // 垂直分量：连续性方程 w = U·∇h = -(u·n_xy)/n_y（迎风坡上升、背风坡下沉）
      const lift = clamp(-(ux * n.x + uz * n.z) / Math.max(0.25, n.y) * SLOPE_LIFT, -SLOPE_MAX, SLOPE_MAX) * decay;
      out.y += lift;
      // 水平分量：山体侧向绕流（气流沿等高线偏转，绕开山体）
      const side = clamp(-(ux * n.z - uz * n.x) * 0.35, -0.6, 0.6) * decay;
      out.x += -uz * side * 0.15;
      out.z += ux * side * 0.15;
    }

    // ---- 4. 阵风湍流（空间+时间噪声，低空更抖） ----
    const turbAmp = this.baseSpeed * this.turbulence * (0.35 + 0.65 * Math.exp(-h / 700));
    if (turbAmp > 0.02) {
      const k = 0.9;
      out.x += turbAmp * (Math.sin(t * 1.7 + gx * 3.1 + gz * 1.3) * 0.5 + Math.sin(t * 3.9 + gz * 4.7) * 0.3);
      out.y += turbAmp * k * (Math.sin(t * 2.3 + gx * 2.7 - gz * 2.2) * 0.5 + Math.sin(t * 5.1 + gx * 5.3) * 0.25);
      out.z += turbAmp * (Math.sin(t * 1.9 - gx * 1.7 + gz * 3.3) * 0.5 + Math.sin(t * 4.3 - gz * 5.1) * 0.3);
      // 低空热浪/下击暴流：偶尔来一下垂直冲击
      if (h < 400) {
        const thermal = Math.sin(t * 0.23 + gx * 41) * Math.sin(t * 0.17 + gz * 37);
        if (thermal > 0.72) out.y += turbAmp * (thermal - 0.72) * 3.2;
      }
    }

    return out.multiplyScalar(this.blend);
  }

  /** 风来向（弧度，HUD 风袋用） */
  get heading() { return Math.atan2(-this.horizontal.x, -this.horizontal.z); }
  /** 地面风速（m/s） */
  get groundSpeed() { return this.horizontal.length(); }

  /**
   * 从地图定义生成风场参数（没有显式配置时按地图气质给一套合理的默认值）。
   * @param {object} mapDef
   * @param {object} terrain
   */
  static fromMap(mapDef, terrain) {
    const cfg = mapDef?.wind || {};
    const presets = {
      archipelago: { speed: 7, dir: 1.05, gust: 0.35, turbulence: 0.22 },
      skypark: { speed: 9, dir: 2.1, gust: 0.3, turbulence: 0.2 },
      snowstone: { speed: 12, dir: 0.4, gust: 0.5, turbulence: 0.45 },   // 暴风雪：大风 + 强湍流
      maywar: { speed: 9, dir: 1.6, gust: 0.45, turbulence: 0.4 },
      vetusta: { speed: 8, dir: 2.6, gust: 0.4, turbulence: 0.3 },
      raceway: { speed: 6, dir: 0.2, gust: 0.3, turbulence: 0.18 },
      naval: { speed: 11, dir: 3.0, gust: 0.5, turbulence: 0.35 },        // 海上：海风
      boneyard: { speed: 10, dir: 1.9, gust: 0.5, turbulence: 0.45 },     // 沙漠：热浪
      stratos: { speed: 5, dir: 0.9, gust: 0.25, turbulence: 0.15 },      // 高空：平稳
    };
    const p = presets[mapDef?.id] || { speed: 6, dir: 0.8, gust: 0.35, turbulence: 0.25 };
    const weatherK = mapDef?.weather === 'snow' ? 1.35 : mapDef?.weather === 'rain' ? 1.2 : 1;
    return new WindField(terrain, {
      speed: (cfg.speed ?? p.speed) * weatherK,
      dir: cfg.dir ?? p.dir,
      gust: cfg.gust ?? p.gust,
      turbulence: cfg.turbulence ?? p.turbulence,
      seed: (mapDef?.id?.length || 3) * 1.37 + 0.5,
      blend: cfg.blend ?? 1,
    });
  }
}

/** 供 HUD 用的风向/风速文字（如 "7 m/s · 东北风"） */
export function windLabel(field) {
  if (!field || field.groundSpeed < 0.2) return '无风';
  const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  const deg = ((field.dir * 180 / Math.PI) % 360 + 360) % 360;   // dir 本身就是来向
  const idx = Math.round(deg / 45) % 8;
  const spd = field.groundSpeed;
  return `${spd.toFixed(spd < 10 ? 1 : 0)} m/s · ${dirs[idx]}风`;
}