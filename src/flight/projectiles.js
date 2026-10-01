/**
 * 弹药 / 爆炸 / 干扰弹系统（ProjectileManager）
 * ------------------------------------------------------------------
 * 统一管理：机炮曳光弹、制导导弹、炸弹、干扰弹、爆炸特效与伤害结算。
 *
 * 设计要点：
 *  1) 一切对象池化 + 预分配；update() 内不新建数组/对象（命中事件对象除外），
 *     超过上限时按「最旧优先」回收，保证长局内存稳定。
 *  2) 子弹是高速近即时弹道：每帧对 [上一帧位置, 本帧位置] 线段做扫掠，
 *     与飞机包围球、地标碰撞体（空间哈希加速）、地形高度（步进 + 二分）取最早命中点，
 *     所以 900 m/s 也不会穿模。
 *  3) 导弹：预测拦截点（迭代求解）+ 转向角速度限制 + 0.6s 锁定延迟 + 8m 近炸引信，
 *     寿命 22s，会撞地形与建筑。
 *  4) explosion() 只做视觉；内部 _explodeAt() 另外结算范围伤害。
 *  5) scene 为空（或没有 add 方法）时进入「无渲染」模式：物理与伤害照常运行，跳过全部绘制。
 *
 * 单位：米 / 秒；Y 轴向上；机头朝 -Z（见 docs/ARCH.md 约定）。
 * 事件：opts.onEvent(type, data)，type ∈ 'hit' | 'kill' | 'explosion' | 'lock'。
 *       注意：事件数据里的 position 是即时快照（Vector3），需要留存请自行 clone。
 */
import * as THREE from 'three';
import { clamp, clamp01 } from '../core/util.js';
import { audio } from '../audio/audio.js';

/* ================================================================ 常量 */
const GRAVITY = 9.81;
/** 机头朝向（ARCH 约定：-Z）；导弹/炸弹模型也按此方向建模 */
const FORWARD = new THREE.Vector3(0, 0, -1);
/** 零向量（只读，勿修改） */
const ZERO = new THREE.Vector3();

/* 池容量（硬上限，可被 opts 覆盖为更小值） */
const MAX_BULLETS = 600;
const MAX_MISSILES = 60;
const MAX_BOMBS = 40;
const MAX_FLARES = 200;
const MAX_EXPLOSIONS = 60;
const MAX_SPARKS = 1400;
const MAX_SMOKE = 1400;
const MAX_FLARE_FX = 800;

/* 子弹 */
const BULLET_LIFE = 1.6;          // 存活时间（秒），结束后曳光淡出
const BULLET_FADE = 0.5;          // 最后 0.5s 淡出
const DEFAULT_BULLET_SPEED = 900;
const DEFAULT_BULLET_DAMAGE = 12;

/* 导弹 */
const MISSILE_LIFE = 22;
const MISSILE_LOCK_DELAY = 0.6;   // 导引头锁定延迟
const MISSILE_TURN_RATE = 2.5;    // rad/s
const MISSILE_BURN = 6;           // 发动机工作时间（秒）
const MISSILE_ACCEL = 150;        // m/s²
const MISSILE_MAX_SPEED = 520;    // m/s
const MISSILE_FUSE = 8;           // 近炸引信半径（米，按目标表面距离计）
const MISSILE_DAMAGE = 700;       // 强杀伤：8m 引信 ≈ 30% 结构损伤，贴脸 ≈ 70%
const MISSILE_BLAST_RADIUS = 18;
const MISSILE_SEEK_RANGE = 9000;  // 导引头搜索距离

/* 炸弹 */
const BOMB_LIFE = 30;
const BOMB_DRAG = 0.05;           // 小阻力（线性系数）
const BOMB_DAMAGE = 600;
const BOMB_BLAST_RADIUS = 25;

/* ================================================================ 模块级临时变量（禁止在 update 中 new） */
const _b0 = new THREE.Vector3(), _b1 = new THREE.Vector3(), _b2 = new THREE.Vector3();
const _m0 = new THREE.Vector3(), _m1 = new THREE.Vector3(), _m2 = new THREE.Vector3();
const _m3 = new THREE.Vector3(), _m4 = new THREE.Vector3(), _m5 = new THREE.Vector3();
const _d0 = new THREE.Vector3(), _d1 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();

/* ================================================================ 纯函数几何工具（不分配、可重入） */

/**
 * 线段 vs 球：返回首个交点参数 t∈[0,1]，无交返回 -1（起点在球内返回 0）。
 */
function segSphereT(ax, ay, az, bx, by, bz, cx, cy, cz, r) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const fx = ax - cx, fy = ay - cy, fz = az - cz;
  const a = dx * dx + dy * dy + dz * dz;
  if (a < 1e-12) return (fx * fx + fy * fy + fz * fz) <= r * r ? 0 : -1;
  const b = 2 * (fx * dx + fy * dy + fz * dz);
  const c = fx * fx + fy * fy + fz * fz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  const inv = 1 / (2 * a);
  const t1 = (-b - sq) * inv;
  const t2 = (-b + sq) * inv;
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t1 < 0 && t2 > 0) return 0;   // 起点在球内
  return -1;
}

/**
 * 线段 vs 轴对齐盒（pad 为额外膨胀量，可当"粗碰撞半径"用）。
 * 返回首个交点参数 t∈[0,1]，无交返回 -1。
 */
function segAabbT(ax, ay, az, bx, by, bz, cx, cy, cz, hx, hy, hz, pad) {
  let tmin = 0, tmax = 1;
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  // X 轴
  {
    const mn = cx - hx - pad, mx = cx + hx + pad;
    if (Math.abs(dx) < 1e-9) { if (ax < mn || ax > mx) return -1; }
    else {
      let t1 = (mn - ax) / dx, t2 = (mx - ax) / dx;
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
  }
  // Y 轴
  {
    const mn = cy - hy - pad, mx = cy + hy + pad;
    if (Math.abs(dy) < 1e-9) { if (ay < mn || ay > mx) return -1; }
    else {
      let t1 = (mn - ay) / dy, t2 = (mx - ay) / dy;
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
  }
  // Z 轴
  {
    const mn = cz - hz - pad, mx = cz + hz + pad;
    if (Math.abs(dz) < 1e-9) { if (az < mn || az > mx) return -1; }
    else {
      let t1 = (mn - az) / dz, t2 = (mx - az) / dz;
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
  }
  return tmin;
}

/** 点到碰撞体表面的距离（球/盒；盒按 AABB 处理，忽略可能的旋转） */
function pointColliderDist(px, py, pz, c) {
  const ctr = c.center;
  if (!ctr) return Infinity;
  if (c.shape === 'sphere') {
    const dx = px - ctr.x, dy = py - ctr.y, dz = pz - ctr.z;
    return Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) - (c.radius || 0));
  }
  const h = c.halfExtents;
  if (!h) {
    const dx = px - ctr.x, dy = py - ctr.y, dz = pz - ctr.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  const dx = Math.max(0, Math.abs(px - ctr.x) - h.x);
  const dy = Math.max(0, Math.abs(py - ctr.y) - h.y);
  const dz = Math.max(0, Math.abs(pz - ctr.z) - h.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * 程序化径向渐变贴图（避免 document/canvas，Node 下也可运行）。
 * 用于让点精灵呈现柔和的圆形光斑。
 */
function makeRadialTexture(size = 32) {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c, dy = (y - c) / c;
      const d = Math.sqrt(dx * dx + dy * dy);
      const a = clamp01(1 - d);
      const i = (y * size + x) * 4;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
      data[i + 3] = Math.round(255 * a * a * (3 - 2 * a));
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/* ================================================================ 点精灵粒子场 */
/**
 * 定长粒子池：结构数组（Float32Array）存储，活跃粒子紧凑存放在 [0, count)。
 * 属性直接写进 GPU BufferAttribute，alpha 走顶点色第 4 分量（three 的 vertexAlphas）。
 */
class ParticleField {
  /**
   * @param {number} cap 容量
   * @param {object} o { size, additive, tex, opacity, fadeSq, renderOrder, name }
   */
  constructor(cap, o = {}) {
    this.cap = cap;
    this.count = 0;
    this.ring = 0;
    this.fadeSq = !!o.fadeSq;

    this.px = new Float32Array(cap); this.py = new Float32Array(cap); this.pz = new Float32Array(cap);
    this.vx = new Float32Array(cap); this.vy = new Float32Array(cap); this.vz = new Float32Array(cap);
    this.life = new Float32Array(cap); this.maxLife = new Float32Array(cap);
    this.cr = new Float32Array(cap); this.cg = new Float32Array(cap); this.cb = new Float32Array(cap);
    this.grav = new Float32Array(cap); this.drag = new Float32Array(cap);

    this.posArr = new Float32Array(cap * 3);
    this.colArr = new Float32Array(cap * 4);
    for (let i = 0; i < cap; i++) this.posArr[i * 3 + 1] = -1e6;   // 初始藏到远处

    this.geometry = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.posArr, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.colArr, 4).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.aPos);
    this.geometry.setAttribute('color', this.aCol);

    this.material = new THREE.PointsMaterial({
      size: o.size ?? 1,
      sizeAttenuation: true,
      transparent: true,
      vertexColors: true,
      depthWrite: false,
      opacity: o.opacity ?? 1,
      map: o.tex || null,
      blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = o.renderOrder ?? 6;
    if (o.name) this.points.name = o.name;
  }

  /** 发射一颗粒子（池满时环形覆盖最旧槽位） */
  spawn(x, y, z, vx, vy, vz, life, r, g, b, grav = 0, drag = 0) {
    let i;
    if (this.count < this.cap) i = this.count++;
    else { i = this.ring; this.ring = (this.ring + 1) % this.cap; }
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = life; this.maxLife[i] = life;
    this.cr[i] = r; this.cg[i] = g; this.cb[i] = b;
    this.grav[i] = grav; this.drag[i] = drag;
    const p3 = i * 3, c4 = i * 4;
    this.posArr[p3] = x; this.posArr[p3 + 1] = y; this.posArr[p3 + 2] = z;
    this.colArr[c4] = r; this.colArr[c4 + 1] = g; this.colArr[c4 + 2] = b; this.colArr[c4 + 3] = 1;
  }

  /** 把 from 槽位的数据搬到 to（swap-remove 用） */
  _move(from, to) {
    this.px[to] = this.px[from]; this.py[to] = this.py[from]; this.pz[to] = this.pz[from];
    this.vx[to] = this.vx[from]; this.vy[to] = this.vy[from]; this.vz[to] = this.vz[from];
    this.life[to] = this.life[from]; this.maxLife[to] = this.maxLife[from];
    this.cr[to] = this.cr[from]; this.cg[to] = this.cg[from]; this.cb[to] = this.cb[from];
    this.grav[to] = this.grav[from]; this.drag[to] = this.drag[from];
  }

  update(dt) {
    let i = 0;
    while (i < this.count) {
      const l = this.life[i] - dt;
      if (l <= 0) {
        const p3 = i * 3, c4 = i * 4;
        this.posArr[p3 + 1] = -1e6;
        this.colArr[c4 + 3] = 0;
        const last = --this.count;
        if (i !== last) this._move(last, i);
        continue;
      }
      this.life[i] = l;
      let vx = this.vx[i], vy = this.vy[i], vz = this.vz[i];
      const gr = this.grav[i];
      if (gr !== 0) vy -= gr * dt;
      const dr = this.drag[i];
      if (dr > 0) {
        const d = Math.max(0, 1 - dr * dt);
        vx *= d; vy *= d; vz *= d;
      }
      this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
      const nx = this.px[i] + vx * dt, ny = this.py[i] + vy * dt, nz = this.pz[i] + vz * dt;
      this.px[i] = nx; this.py[i] = ny; this.pz[i] = nz;
      const p3 = i * 3, c4 = i * 4;
      this.posArr[p3] = nx; this.posArr[p3 + 1] = ny; this.posArr[p3 + 2] = nz;
      let fade = l / this.maxLife[i];
      if (fade < 0) fade = 0; else if (fade > 1) fade = 1;
      if (this.fadeSq) fade *= fade;
      this.colArr[c4] = this.cr[i];
      this.colArr[c4 + 1] = this.cg[i];
      this.colArr[c4 + 2] = this.cb[i];
      this.colArr[c4 + 3] = fade;
      i++;
    }
    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
  }

  reset() {
    this.count = 0;
    this.ring = 0;
    for (let i = 0; i < this.cap; i++) {
      this.colArr[i * 4 + 3] = 0;
      this.posArr[i * 3 + 1] = -1e6;
    }
    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* ================================================================ 地标碰撞体空间哈希 */
/**
 * 均匀网格哈希：每帧重建（O(碰撞体数)），用于子弹/导弹/炸弹快速筛选候选碰撞体。
 * 单元格内的数组从对象池复用，稳定后不再产生新分配。
 */
class ColliderHash {
  constructor(cell = 64) {
    this.cell = cell;
    this.map = new Map();
    this.pool = [];
    this.used = 0;
    this.global = [];    // 超大碰撞体（跨格太多）→ 全查询
    this.frame = 0;
  }

  begin() {
    this.map.clear();
    this.used = 0;
    this.global.length = 0;
    this.frame++;
  }

  _bucket(key) {
    let a = this.map.get(key);
    if (a === undefined) {
      if (this.used < this.pool.length) { a = this.pool[this.used]; this.used++; a.length = 0; }
      else { a = []; this.pool.push(a); this.used = this.pool.length; }
      this.map.set(key, a);
    }
    return a;
  }

  _key(ix, iy, iz) {
    return (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791);
  }

  insert(c) {
    if (!c || c.destroyed || !c.center) return;
    const cs = this.cell;
    const p = c.center;
    let minx, miny, minz, maxx, maxy, maxz;
    if (c.shape === 'sphere') {
      const r = c.radius || 0;
      minx = p.x - r; maxx = p.x + r;
      miny = p.y - r; maxy = p.y + r;
      minz = p.z - r; maxz = p.z + r;
    } else {
      const h = c.halfExtents;
      if (!h) return;
      if (c.quaternion) {
        // 有旋转的盒子：退化为包围球（地标接口通常给 AABB，这里只做兜底）
        const r = h.length();
        minx = p.x - r; maxx = p.x + r;
        miny = p.y - r; maxy = p.y + r;
        minz = p.z - r; maxz = p.z + r;
      } else {
        minx = p.x - h.x; maxx = p.x + h.x;
        miny = p.y - h.y; maxy = p.y + h.y;
        minz = p.z - h.z; maxz = p.z + h.z;
      }
    }
    const ix0 = Math.floor(minx / cs), ix1 = Math.floor(maxx / cs);
    const iy0 = Math.floor(miny / cs), iy1 = Math.floor(maxy / cs);
    const iz0 = Math.floor(minz / cs), iz1 = Math.floor(maxz / cs);
    const nx = ix1 - ix0 + 1, ny = iy1 - iy0 + 1, nz = iz1 - iz0 + 1;
    if (nx * ny * nz > 512) { this.global.push(c); return; }   // 超大物体不做网格
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          this._bucket(this._key(ix, iy, iz)).push(c);
        }
      }
    }
  }

  /**
   * 查询 AABB 范围内的候选碰撞体。
   * @param {Array} out 预分配数组，结果写入 out[0..out.n)
   */
  query(minx, miny, minz, maxx, maxy, maxz, out) {
    out.n = 0;
    if (!Number.isFinite(minx) || !Number.isFinite(miny) || !Number.isFinite(minz) ||
        !Number.isFinite(maxx) || !Number.isFinite(maxy) || !Number.isFinite(maxz)) return 0;
    for (let i = 0; i < this.global.length; i++) this._push(this.global[i], out);
    const cs = this.cell;
    const ix0 = Math.floor(minx / cs), ix1 = Math.floor(maxx / cs);
    const iy0 = Math.floor(miny / cs), iy1 = Math.floor(maxy / cs);
    const iz0 = Math.floor(minz / cs), iz1 = Math.floor(maxz / cs);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const a = this.map.get(this._key(ix, iy, iz));
          if (!a) continue;
          for (let k = 0; k < a.length; k++) this._push(a[k], out);
        }
      }
    }
    return out.n;
  }

  _push(c, out) {
    if (!c || c.destroyed) return;
    if (c._pmStamp === this.frame) return;   // 同帧去重
    c._pmStamp = this.frame;
    if (out.n < out.length) out[out.n] = c;
    out.n++;
  }
}

/* ================================================================ 管理器 */
export class ProjectileManager {
  /**
   * @param {THREE.Scene|null} scene 场景（可为 null → 无渲染模式）
   * @param {object} [opts] { onEvent, audio?:boolean, gravity?:number,
   *                          bulletCap, missileCap, bombCap, flareCap, explosionCap,
   *                          missileTurnRate, missileLockDelay, bombBlastRadius, bombDamage }
   */
  constructor(scene, opts = {}) {
    const o = opts || {};
    this.opts = o;
    this.onEvent = typeof o.onEvent === 'function' ? o.onEvent : null;
    this.gravity = Number.isFinite(o.gravity) ? o.gravity : GRAVITY;
    this._audioEnabled = o.audio !== false;
    this._scene = (scene && typeof scene.add === 'function') ? scene : null;
    this._visuals = !!this._scene;
    this._ctx = null;
    this._hashReady = false;
    this._impactAudioCd = 0;
    this._missileDamage = Number.isFinite(o.missileDamage) ? o.missileDamage : MISSILE_DAMAGE;
    this._missileRadius = Number.isFinite(o.missileBlastRadius) ? o.missileBlastRadius : MISSILE_BLAST_RADIUS;
    this._missileFuse = Number.isFinite(o.missileFuse) ? o.missileFuse : MISSILE_FUSE;
    this._curBullet = 0; this._curMissile = 0; this._curBomb = 0; this._curFlare = 0; this._curBlast = 0;

    /* ---------------- 根节点 ---------------- */
    this.root = new THREE.Group();
    this.root.name = 'projectiles';
    if (this._visuals) this._scene.add(this.root);

    /* ---------------- 共享资源 ---------------- */
    this._tex = makeRadialTexture(32);

    this._sparks = new ParticleField(MAX_SPARKS, {
      size: 0.6, additive: true, tex: this._tex, fadeSq: true, renderOrder: 8, name: 'pm_sparks',
    });
    this._smoke = new ParticleField(MAX_SMOKE, {
      size: 3.4, additive: false, tex: this._tex, opacity: 0.5, renderOrder: 5, name: 'pm_smoke',
    });
    this._flareFx = new ParticleField(MAX_FLARE_FX, {
      size: 2.4, additive: true, tex: this._tex, renderOrder: 9, name: 'pm_flares',
    });
    this.root.add(this._sparks.points, this._smoke.points, this._flareFx.points);

    /* ---------------- 曳光弹（一个 LineSegments 承载全部子弹） ---------------- */
    this._tracerPos = new Float32Array(MAX_BULLETS * 6);
    this._tracerCol = new Float32Array(MAX_BULLETS * 8);
    this._tracerGeom = new THREE.BufferGeometry();
    this._tracerAttrPos = new THREE.BufferAttribute(this._tracerPos, 3).setUsage(THREE.DynamicDrawUsage);
    this._tracerAttrCol = new THREE.BufferAttribute(this._tracerCol, 4).setUsage(THREE.DynamicDrawUsage);
    this._tracerGeom.setAttribute('position', this._tracerAttrPos);
    this._tracerGeom.setAttribute('color', this._tracerAttrCol);
    this._tracerMat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, color: 0xffffff,
    });
    this._tracer = new THREE.LineSegments(this._tracerGeom, this._tracerMat);
    this._tracer.frustumCulled = false;
    this._tracer.renderOrder = 7;
    this._tracer.name = 'pm_tracers';
    this.root.add(this._tracer);

    /* ---------------- 子弹池 ---------------- */
    const bulletCap = Math.min(MAX_BULLETS, Math.max(16, o.bulletCap ?? MAX_BULLETS));
    this._bullets = new Array(bulletCap);
    for (let i = 0; i < bulletCap; i++) {
      this._bullets[i] = {
        active: false, life: 0, damage: 0, speed: 0, owner: null,
        pos: new THREE.Vector3(), prev: new THREE.Vector3(),
        vel: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1),
      };
    }

    /* ---------------- 导弹池（小机体 + 尾翼 + 尾烟粒子） ---------------- */
    const mg = this._buildMissileAssets();
    this._missileAssets = mg;
    const missileCap = Math.min(MAX_MISSILES, Math.max(4, o.missileCap ?? MAX_MISSILES));
    this._missiles = new Array(missileCap);
    for (let i = 0; i < missileCap; i++) {
      const mesh = this._buildMissileMesh(mg);
      this.root.add(mesh);
      this._missiles[i] = {
        active: false, age: 0, life: MISSILE_LIFE,
        lockDelay: MISSILE_LOCK_DELAY, turnRate: MISSILE_TURN_RATE,
        accel: MISSILE_ACCEL, maxSpeed: MISSILE_MAX_SPEED, burnTime: MISSILE_BURN,
        speed: 0, smokeT: 0, retarget: 0, locked: false,
        target: null, targets: null, owner: null,
        pos: new THREE.Vector3(), prev: new THREE.Vector3(),
        vel: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1), mesh,
      };
    }

    /* ---------------- 炸弹池 ---------------- */
    const bg = this._buildBombAssets();
    this._bombAssets = bg;
    const bombCap = Math.min(MAX_BOMBS, Math.max(4, o.bombCap ?? MAX_BOMBS));
    this._bombs = new Array(bombCap);
    for (let i = 0; i < bombCap; i++) {
      const mesh = this._buildBombMesh(bg);
      this.root.add(mesh);
      this._bombs[i] = {
        active: false, age: 0, damage: BOMB_DAMAGE, radius: BOMB_BLAST_RADIUS, owner: null,
        pos: new THREE.Vector3(), prev: new THREE.Vector3(),
        vel: new THREE.Vector3(), mesh,
      };
    }

    /* ---------------- 干扰弹池 ---------------- */
    const flareCap = Math.min(MAX_FLARES, Math.max(8, o.flareCap ?? MAX_FLARES));
    this._flares = new Array(flareCap);
    for (let i = 0; i < flareCap; i++) {
      this._flares[i] = {
        active: false, life: 0, emitT: 0,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      };
    }

    /* ---------------- 爆炸池 ---------------- */
    this._blastGeom = new THREE.SphereGeometry(1, 12, 8);
    const blastCap = Math.min(MAX_EXPLOSIONS, Math.max(4, o.explosionCap ?? MAX_EXPLOSIONS));
    this._explosions = new Array(blastCap);
    for (let i = 0; i < blastCap; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffb050, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const mesh = new THREE.Mesh(this._blastGeom, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 4;
      this.root.add(mesh);
      this._explosions[i] = {
        active: false, t: 0, life: 1, scale: 1, maxRadius: 6, smokeT: 0,
        pos: new THREE.Vector3(), mesh, mat,
      };
    }

    /* ---------------- 碰撞体哈希 ---------------- */
    this._hash = new ColliderHash(o.colliderCell ?? 64);
    this._query = new Array(2048);
    this._query.n = 0;
  }

  /* ============================================================ 资源构建 */
  /** 导弹共享几何/材质 */
  _buildMissileAssets() {
    const gBody = new THREE.CylinderGeometry(0.1, 0.1, 0.9, 8);
    gBody.rotateX(Math.PI / 2);                       // 轴向对齐 Z
    const gNose = new THREE.ConeGeometry(0.1, 0.3, 8);
    gNose.rotateX(-Math.PI / 2);                      // 尖端朝 -Z
    gNose.translate(0, 0, -0.6);
    const gFin = new THREE.BoxGeometry(0.02, 0.3, 0.2);
    const mat = new THREE.MeshStandardMaterial({ color: 0xb9bec7, metalness: 0.45, roughness: 0.5 });
    return { gBody, gNose, gFin, mat };
  }

  _buildMissileMesh(a) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(a.gBody, a.mat);
    const nose = new THREE.Mesh(a.gNose, a.mat);
    const fin1 = new THREE.Mesh(a.gFin, a.mat);
    fin1.position.z = 0.42;
    const fin2 = new THREE.Mesh(a.gFin, a.mat);
    fin2.position.z = 0.42;
    fin2.rotation.z = Math.PI / 2;
    g.add(body, nose, fin1, fin2);
    g.visible = false;
    return g;
  }

  /** 炸弹共享几何/材质 */
  _buildBombAssets() {
    const gBody = new THREE.CapsuleGeometry(0.22, 0.5, 4, 8);
    gBody.rotateX(Math.PI / 2);                       // 轴向对齐 Z
    const gFin = new THREE.BoxGeometry(0.02, 0.32, 0.16);
    const mat = new THREE.MeshStandardMaterial({ color: 0x4d5340, metalness: 0.25, roughness: 0.75 });
    return { gBody, gFin, mat };
  }

  _buildBombMesh(a) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(a.gBody, a.mat);
    const fin1 = new THREE.Mesh(a.gFin, a.mat);
    fin1.position.z = 0.34;
    const fin2 = new THREE.Mesh(a.gFin, a.mat);
    fin2.position.z = 0.34;
    fin2.rotation.z = Math.PI / 2;
    g.add(body, fin1, fin2);
    g.visible = false;
    return g;
  }

  /* ============================================================ 公共 API */

  /**
   * 发射曳光弹（高速近即时弹道，每帧线段扫掠）。
   * @param {THREE.Vector3} position 枪口世界坐标
   * @param {THREE.Vector3} direction 归一化与否均可
   * @param {THREE.Vector3} ownerVelocity 载机速度（继承 50%，兼顾手感与真实）
   * @param {number} speed m/s
   * @param {number} damage 伤害值
   * @param {object} owner 发射者（Aircraft 或 null）
   */
  spawnBullet(position, direction, ownerVelocity, speed, damage, owner) {
    if (!position || !direction) return;
    const i = this._acquire(this._bullets, '_curBullet');
    const b = this._bullets[i];
    b.active = true;
    b.life = BULLET_LIFE;
    b.damage = Number.isFinite(damage) ? damage : DEFAULT_BULLET_DAMAGE;
    b.owner = owner || null;
    b.pos.copy(position);
    b.prev.copy(position);
    _b0.copy(direction);
    if (_b0.lengthSq() > 1e-8) _b0.normalize(); else _b0.set(0, 0, -1);
    b.dir.copy(_b0);
    b.vel.copy(_b0).multiplyScalar(Number.isFinite(speed) ? speed : DEFAULT_BULLET_SPEED);
    if (ownerVelocity) b.vel.addScaledVector(ownerVelocity, 0.5);
    b.speed = b.vel.length();
  }

  /**
   * 发射制导导弹。
   * @param {THREE.Vector3} position 挂架世界坐标
   * @param {THREE.Vector3} direction 初始指向
   * @param {THREE.Vector3} ownerVelocity 载机速度
   * @param {object} owner 发射者
   * @param {object[]} targets 候选目标（Aircraft 之类；为空则回退到 ctx.aircraft）
   */
  spawnMissile(position, direction, ownerVelocity, owner, targets) {
    if (!position || !direction) return;
    const o = this.opts;
    const i = this._acquire(this._missiles, '_curMissile');
    const m = this._missiles[i];
    m.active = true;
    m.age = 0;
    m.life = Number.isFinite(o.missileLife) ? o.missileLife : MISSILE_LIFE;
    m.lockDelay = Number.isFinite(o.missileLockDelay) ? o.missileLockDelay : MISSILE_LOCK_DELAY;
    m.turnRate = Number.isFinite(o.missileTurnRate) ? o.missileTurnRate : MISSILE_TURN_RATE;
    m.accel = Number.isFinite(o.missileAccel) ? o.missileAccel : MISSILE_ACCEL;
    m.maxSpeed = Number.isFinite(o.missileMaxSpeed) ? o.missileMaxSpeed : MISSILE_MAX_SPEED;
    m.burnTime = Number.isFinite(o.missileBurn) ? o.missileBurn : MISSILE_BURN;
    m.smokeT = 0;
    m.retarget = 0;
    m.locked = false;
    m.target = null;
    m.targets = (targets && targets.length) ? targets : null;
    m.owner = owner || null;
    m.pos.copy(position);
    m.prev.copy(position);
    _m0.copy(direction);
    if (_m0.lengthSq() > 1e-8) _m0.normalize(); else _m0.set(0, 0, -1);
    m.speed = 90;
    m.vel.copy(_m0).multiplyScalar(m.speed);
    if (ownerVelocity) m.vel.addScaledVector(ownerVelocity, 0.85);
    // 实际发射方向取合速度方向（否则会丢掉载机速度带来的横向分量，导致"打偏"）
    m.dir.copy(m.vel);
    if (m.dir.lengthSq() > 1e-8) m.dir.normalize(); else m.dir.copy(_m0);
    m.speed = m.vel.length();
    if (this._visuals) {
      m.mesh.visible = true;
      m.mesh.position.copy(m.pos);
      m.mesh.quaternion.setFromUnitVectors(FORWARD, m.dir);
    }
  }

  /**
   * 投掷炸弹（弹道 + 小阻力，落地大爆炸 + 25m 范围伤害）。
   * @param {THREE.Vector3} position 挂点世界坐标
   * @param {THREE.Vector3} ownerVelocity 载机速度
   * @param {object} owner 投弹者
   * @param {number} [damage] 中心伤害（默认 600）
   */
  spawnBomb(position, ownerVelocity, owner, damage) {
    if (!position) return;
    const o = this.opts;
    const i = this._acquire(this._bombs, '_curBomb');
    const b = this._bombs[i];
    b.active = true;
    b.age = 0;
    b.damage = Number.isFinite(damage) ? damage : (Number.isFinite(o.bombDamage) ? o.bombDamage : BOMB_DAMAGE);
    b.radius = Number.isFinite(o.bombBlastRadius) ? o.bombBlastRadius : BOMB_BLAST_RADIUS;
    b.owner = owner || null;
    b.pos.copy(position);
    b.prev.copy(position);
    b.vel.copy(ownerVelocity || ZERO);
    if (this._visuals) {
      b.mesh.visible = true;
      b.mesh.position.copy(b.pos);
    }
  }

  /**
   * 发射干扰弹（主要在视觉上好看；flareCount 供 AI 规避逻辑使用）。
   */
  spawnFlare(position, ownerVelocity) {
    if (!position) return;
    const i = this._acquire(this._flares, '_curFlare');
    const f = this._flares[i];
    f.active = true;
    f.life = 4.5;
    f.emitT = 0;
    f.pos.copy(position);
    f.vel.copy(ownerVelocity || ZERO);
    f.vel.x += (Math.random() - 0.5) * 6;
    f.vel.y += (Math.random() - 0.5) * 5;
    f.vel.z += (Math.random() - 0.5) * 6;
  }

  /**
   * 纯视觉爆炸（不造成伤害）。范围伤害请走内部 _explodeAt。
   * @param {THREE.Vector3} position
   * @param {number} [scale] 尺寸倍率（1 ≈ 半径 4.5m 火球）
   */
  explosion(position, scale = 1) {
    if (!position) return;
    const s = (Number.isFinite(scale) && scale > 0) ? scale : 1;
    this._spawnBlast(position, s);
    this._sfx(s >= 2 ? 'explosion_big' : 'explosion', position);
    this._emit('explosion', {
      cause: 'visual', position: this._evtPoint(position), scale: s,
      radius: 0, damage: 0, owner: null, hits: 0,
    });
  }

  /**
   * 主循环。
   * @param {number} dt 秒
   * @param {object} ctx { terrain, landmarks, aircraft: Aircraft[] }
   */
  update(dt, ctx) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const step = dt > 0.1 ? 0.1 : dt;   // 掉帧保护（防止一帧跳太远）
    this._ctx = ctx || null;
    const terrain = (this._ctx && this._ctx.terrain) || null;
    const landmarks = (this._ctx && this._ctx.landmarks) || null;
    const aircraft = (this._ctx && Array.isArray(this._ctx.aircraft)) ? this._ctx.aircraft : null;
    this._impactAudioCd = Math.max(0, this._impactAudioCd - step);

    /* 地标碰撞体空间哈希：每帧重建，O(碰撞体数)，稳定后无新分配 */
    this._hashReady = false;
    const cols = landmarks && landmarks.colliders;
    if (cols && cols.length) {
      this._hash.begin();
      for (let i = 0; i < cols.length; i++) this._hash.insert(cols[i]);
      this._hashReady = true;
    }

    this._updateBullets(step, terrain, aircraft);
    this._updateMissiles(step, terrain, aircraft);
    this._updateBombs(step, terrain, aircraft);
    this._updateFlares(step, terrain);
    this._updateBlasts(step);

    if (this._visuals) {
      this._syncTracers();
      this._sparks.update(step);
      this._smoke.update(step);
      this._flareFx.update(step);
    }
  }

  /** 清空全部弹药与特效（保留池与资源）。 */
  clear() {
    for (let i = 0; i < this._bullets.length; i++) this._bullets[i].active = false;
    for (let i = 0; i < this._missiles.length; i++) { const m = this._missiles[i]; m.active = false; if (m.mesh) m.mesh.visible = false; }
    for (let i = 0; i < this._bombs.length; i++) { const b = this._bombs[i]; b.active = false; if (b.mesh) b.mesh.visible = false; }
    for (let i = 0; i < this._flares.length; i++) this._flares[i].active = false;
    for (let i = 0; i < this._explosions.length; i++) { const e = this._explosions[i]; e.active = false; e.mesh.visible = false; }
    this._sparks.reset();
    this._smoke.reset();
    this._flareFx.reset();
    if (this._visuals) this._syncTracers();
    this._ctx = null;
    this._hashReady = false;
  }

  /** 当前存活弹药总数（子弹 + 导弹 + 炸弹 + 干扰弹）。 */
  get count() {
    let n = 0;
    for (let i = 0; i < this._bullets.length; i++) if (this._bullets[i].active) n++;
    for (let i = 0; i < this._missiles.length; i++) if (this._missiles[i].active) n++;
    for (let i = 0; i < this._bombs.length; i++) if (this._bombs[i].active) n++;
    for (let i = 0; i < this._flares.length; i++) if (this._flares[i].active) n++;
    return n;
  }

  /** 当前存活干扰弹数量（AI 规避逻辑用）。 */
  get flareCount() {
    let n = 0;
    for (let i = 0; i < this._flares.length; i++) if (this._flares[i].active) n++;
    return n;
  }

  /** 释放全部 GPU 资源并脱离场景。 */
  dispose() {
    this.clear();
    if (this.root.parent) this.root.removeFromParent();
    this._tracerGeom.dispose();
    this._tracerMat.dispose();
    this._sparks.dispose();
    this._smoke.dispose();
    this._flareFx.dispose();
    this._blastGeom.dispose();
    for (let i = 0; i < this._explosions.length; i++) this._explosions[i].mat.dispose();
    if (this._missileAssets) { this._missileAssets.gBody.dispose(); this._missileAssets.gNose.dispose(); this._missileAssets.gFin.dispose(); this._missileAssets.mat.dispose(); }
    if (this._bombAssets) { this._bombAssets.gBody.dispose(); this._bombAssets.gFin.dispose(); this._bombAssets.mat.dispose(); }
    if (this._tex) this._tex.dispose();
    this._scene = null;
    this._visuals = false;
  }

  /* ============================================================ 内部工具 */

  /**
   * 取池中空槽；池满时从游标处拿最旧的一个（近似 oldest-first 回收）。
   * @param {string} key 管理器中记录游标的属性名
   */
  _acquire(pool, key) {
    const n = pool.length;
    let c = this[key] % n;
    for (let i = 0; i < n; i++) {
      const k = (c + i) % n;
      if (!pool[k].active) { this[key] = (k + 1) % n; return k; }
    }
    this[key] = (c + 1) % n;
    return c;
  }

  /** 事件回调（异常不进入物理循环） */
  _emit(type, data) {
    const fn = this.onEvent;
    if (!fn) return;
    try { fn(type, data); } catch (e) { /* 忽略回调异常 */ }
  }

  /** 事件用的位置快照（Vector3），避免内部临时向量被复用后产生歧义 */
  _evtPoint(p) {
    return new THREE.Vector3(p.x, p.y, p.z);
  }

  /** 播放一次性音效（内部会做 ready 检查，未初始化时为 no-op） */
  _sfx(name, position) {
    if (!this._audioEnabled) return;
    if (!audio || typeof audio.sfx !== 'function' || !audio.ready) return;
    audio.sfx(name, position ? { position } : undefined);
  }

  /** 子弹/破片撞击音（带最小间隔，避免机枪扫射时刷屏） */
  _impactSfx(position, water) {
    if (this._impactAudioCd > 0) return;
    this._impactAudioCd = 0.07;
    this._sfx(water ? 'splash' : 'thud', position);
  }

  /**
   * 目标是否可被伤害/追踪：存在、未死、非自己、非同队。
   */
  _validTarget(t, owner) {
    if (!t || t === owner) return false;
    if (t.destroyed || t.alive === false) return false;
    if (!t.body || !t.body.position) return false;
    if (owner && owner.team != null && t.team != null && t.team === owner.team) return false;
    return true;
  }

  /**
   * 结算对飞机的伤害并派发 hit/kill 事件。
   * @returns {boolean} 是否真的造成了伤害
   */
  _damageAircraft(target, dmg, point, cause, owner) {
    if (!target || typeof target.applyDamage !== 'function') return false;
    if (target.destroyed || target.alive === false) return false;
    if (owner && owner.team != null && target.team != null && target.team === owner.team) return false;
    if (!(dmg > 0)) return false;
    target.applyDamage(dmg, point, cause);
    const killed = !!target.destroyed;
    const data = {
      cause, kind: 'aircraft', target, owner, damage: dmg,
      position: this._evtPoint(point),
    };
    this._emit('hit', data);
    if (killed) {
      this._emit('kill', {
        cause, kind: 'aircraft', target, owner, damage: dmg, position: data.position,
      });
    }
    return true;
  }

  /** 地对地/对建筑伤害（走 landmarks.damage） */
  _damageCollider(collider, dmg, point, cause, owner) {
    const lm = this._ctx && this._ctx.landmarks;
    if (!lm || typeof lm.damage !== 'function' || !collider || collider.destroyed || !collider.destructible) return false;
    if (!(dmg > 0)) return false;
    const destroyed = lm.damage(collider, dmg);
    this._emit('hit', { cause, kind: 'landmark', target: collider, owner, damage: dmg, position: this._evtPoint(point) });
    if (destroyed) this._emit('kill', { cause, kind: 'landmark', target: collider, owner, damage: dmg, position: this._evtPoint(point) });
    return true;
  }

  /** 线段扫掠地形：返回最早交点参数 t∈[0,1]，无交返回 -1（步进 + 二分细化） */
  _terrainT(p0, p1, terrain) {
    const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-4) {
      return (p0.y <= terrain.heightAt(p0.x, p0.z)) ? 0 : -1;
    }
    const steps = Math.max(1, Math.min(8, Math.ceil(len / 8)));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = p0.x + dx * t, y = p0.y + dy * t, z = p0.z + dz * t;
      if (y <= terrain.heightAt(x, z)) {
        let lo = (s - 1) / steps, hi = t;
        for (let it = 0; it < 3; it++) {
          const mid = (lo + hi) * 0.5;
          const mx = p0.x + dx * mid, my = p0.y + dy * mid, mz = p0.z + dz * mid;
          if (my <= terrain.heightAt(mx, mz)) hi = mid; else lo = mid;
        }
        return hi;
      }
    }
    return -1;
  }

  /* ============================================================ 子弹 */
  _updateBullets(dt, terrain, aircraft) {
    const pool = this._bullets;
    const hi = this._hash;
    const q = this._query;
    for (let i = 0; i < pool.length; i++) {
      const b = pool[i];
      if (!b.active) continue;
      b.life -= dt;
      if (b.life <= 0) { b.active = false; continue; }

      b.prev.copy(b.pos);
      b.pos.addScaledVector(b.vel, dt);

      let hitT = 2;
      let kind = 0;              // 0 无 / 1 飞机 / 2 地标 / 3 地形
      let target = null;
      let collider = null;

      /* --- 飞机（包围球） --- */
      if (aircraft) {
        for (let k = 0; k < aircraft.length; k++) {
          const a = aircraft[k];
          if (!this._validTarget(a, b.owner)) continue;
          const p = a.body.position;
          const r = a.radius || 3;
          const t = segSphereT(b.prev.x, b.prev.y, b.prev.z, b.pos.x, b.pos.y, b.pos.z, p.x, p.y, p.z, r);
          if (t >= 0 && t < hitT) { hitT = t; kind = 1; target = a; collider = null; }
        }
      }

      /* --- 地标碰撞体（空间哈希粗筛 + 精确线段测试） --- */
      if (this._hashReady) {
        const minx = Math.min(b.prev.x, b.pos.x) - 1.5;
        const miny = Math.min(b.prev.y, b.pos.y) - 1.5;
        const minz = Math.min(b.prev.z, b.pos.z) - 1.5;
        const maxx = Math.max(b.prev.x, b.pos.x) + 1.5;
        const maxy = Math.max(b.prev.y, b.pos.y) + 1.5;
        const maxz = Math.max(b.prev.z, b.pos.z) + 1.5;
        hi.query(minx, miny, minz, maxx, maxy, maxz, q);
        for (let k = 0; k < q.n; k++) {
          const c = q[k];
          const ctr = c.center;
          let t;
          if (c.shape === 'sphere') {
            t = segSphereT(b.prev.x, b.prev.y, b.prev.z, b.pos.x, b.pos.y, b.pos.z, ctr.x, ctr.y, ctr.z, c.radius || 0);
          } else {
            const h = c.halfExtents;
            if (!h) continue;
            t = segAabbT(b.prev.x, b.prev.y, b.prev.z, b.pos.x, b.pos.y, b.pos.z, ctr.x, ctr.y, ctr.z, h.x, h.y, h.z, 0);
          }
          if (t >= 0 && t < hitT) { hitT = t; kind = 2; collider = c; target = null; }
        }
      }

      /* --- 地形 --- */
      if (terrain) {
        const t = this._terrainT(b.prev, b.pos, terrain);
        if (t >= 0 && t < hitT) { hitT = t; kind = 3; collider = null; target = null; }
      }

      if (hitT > 1) continue;

      /* --- 命中结算 --- */
      _b1.copy(b.prev).lerp(b.pos, clamp01(hitT));
      b.active = false;
      if (kind === 1) {
        this._sparkBurst(_b1, 4, 14, 1.0, 0.82, 0.4, 0.26);
        this._damageAircraft(target, b.damage, _b1, 'bullet', b.owner);
      } else if (kind === 2) {
        this._sparkBurst(_b1, 5, 16, 1.0, 0.78, 0.35, 0.3);
        this._impactSfx(_b1, false);
        if (collider && collider.destructible) this._damageCollider(collider, b.damage, _b1, 'bullet', b.owner);
      } else if (kind === 3) {
        const water = !!(terrain && terrain.isWater(_b1.x, _b1.z));
        if (water) this._sparkBurst(_b1, 4, 9, 0.75, 0.9, 1.0, 0.3);
        else this._sparkBurst(_b1, 4, 11, 0.7, 0.62, 0.45, 0.35);
        this._impactSfx(_b1, water);
      }
    }
  }

  /** 一次性火花爆发（用于子弹着弹/爆炸碎片） */
  _sparkBurst(p, n, spd, r, g, b, life) {
    if (!this._visuals) return;
    const f = this._sparks;
    for (let k = 0; k < n; k++) {
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const s = Math.sqrt(Math.max(0, 1 - u * u));
      const sp = spd * (0.4 + Math.random() * 0.8);
      f.spawn(
        p.x, p.y, p.z,
        s * Math.cos(th) * sp, u * sp * 0.7 + spd * 0.25, s * Math.sin(th) * sp,
        life * (0.6 + Math.random() * 0.7), r, g, b, 9.81, 1.6,
      );
    }
  }

  /** 一团烟（导弹尾烟 / 爆炸烟球 / 干扰弹烟） */
  _smokePuff(x, y, z, vx, vy, vz, life, shade) {
    if (!this._visuals) return;
    this._smoke.spawn(
      x, y, z, vx, vy, vz, life,
      shade, shade, shade * 1.02, -0.7, 1.3,
    );
  }

  /* ============================================================ 导弹 */
  _updateMissiles(dt, terrain, aircraft) {
    const pool = this._missiles;
    for (let i = 0; i < pool.length; i++) {
      const m = pool[i];
      if (!m.active) continue;
      m.age += dt;
      if (m.age > m.life) { this._detonateMissile(m, false, terrain, aircraft); continue; }
      m.prev.copy(m.pos);

      /* --- 导引头：锁定延迟之后才允许获取目标并制导 --- */
      if (m.age >= m.lockDelay) {
        if (m.target && !this._validTarget(m.target, m.owner)) m.target = null;
        m.retarget -= dt;
        if (!m.target && m.retarget <= 0) {
          m.retarget = 0.5;
          const t = this._pickTarget(m, aircraft);
          if (t) {
            m.target = t;
            if (!m.locked) {
              m.locked = true;
              this._emit('lock', { cause: 'lock', owner: m.owner, target: t, position: this._evtPoint(m.pos) });
              this._sfx('lock', m.pos);
            }
          }
        }
      }

      /* --- 制导律：预测拦截点 + 角速度限制转向 --- */
      const tgt = m.target;
      if (tgt && m.age >= m.lockDelay && tgt.body) {
        const tp = tgt.body.position;
        const tv = tgt.body.velocity || ZERO;
        this._predictIntercept(m.pos, tp, tv, m.speed, _m2);
        _m3.copy(_m2).sub(m.pos);
        const dl = _m3.length();
        if (dl > 1e-3) {
          _m3.multiplyScalar(1 / dl);
          _m0.copy(m.vel).multiplyScalar(1 / Math.max(1e-3, m.speed));
          let dot = _m0.dot(_m3);
          if (dot > 1) dot = 1; else if (dot < -1) dot = -1;
          const ang = Math.acos(dot);
          const maxTurn = m.turnRate * dt;
          if (ang > maxTurn) {
            _m4.crossVectors(_m0, _m3);
            if (_m4.lengthSq() < 1e-8) {
              // 完全反向：任取一个垂直轴
              _m4.set(0, 1, 0).cross(_m0);
              if (_m4.lengthSq() < 1e-8) _m4.set(1, 0, 0);
            }
            _m4.normalize();
            _q0.setFromAxisAngle(_m4, maxTurn);
            _m0.applyQuaternion(_q0).normalize();
          } else {
            _m0.copy(_m3);
          }
          m.dir.copy(_m0);
        }
      }

      /* --- 速度：燃烧段加速，之后缓慢掉速 --- */
      if (m.age < m.burnTime) m.speed = Math.min(m.maxSpeed, m.speed + m.accel * dt);
      else m.speed = Math.max(140, m.speed - 8 * dt);
      m.vel.copy(m.dir).multiplyScalar(m.speed);
      m.pos.addScaledVector(m.vel, dt);

      /* --- 命中判定 --- */
      const list = m.targets || aircraft;
      let hitT = 2;
      let hitAc = null;
      let hitCol = null;

      // 直击飞机（含近炸引信）
      if (list) {
        for (let k = 0; k < list.length; k++) {
          const a = list[k];
          if (!this._validTarget(a, m.owner)) continue;
          const p = a.body.position;
          const r = (a.radius || 3) + 0.8;
          const t = segSphereT(m.prev.x, m.prev.y, m.prev.z, m.pos.x, m.pos.y, m.pos.z, p.x, p.y, p.z, r);
          if (t >= 0 && t < hitT) { hitT = t; hitAc = a; hitCol = null; }
        }
        if (!hitAc) {
          for (let k = 0; k < list.length; k++) {
            const a = list[k];
            if (!this._validTarget(a, m.owner)) continue;
            const d = a.body.position.distanceTo(m.pos) - (a.radius || 3);
            if (d <= this._missileFuse) { hitAc = a; hitT = 1; break; }
          }
        }
      }

      // 地标
      if (!hitAc && this._hashReady) {
        const pad = 0.8;
        const minx = Math.min(m.prev.x, m.pos.x) - pad;
        const miny = Math.min(m.prev.y, m.pos.y) - pad;
        const minz = Math.min(m.prev.z, m.pos.z) - pad;
        const maxx = Math.max(m.prev.x, m.pos.x) + pad;
        const maxy = Math.max(m.prev.y, m.pos.y) + pad;
        const maxz = Math.max(m.prev.z, m.pos.z) + pad;
        this._hash.query(minx, miny, minz, maxx, maxy, maxz, this._query);
        const q = this._query;
        for (let k = 0; k < q.n; k++) {
          const c = q[k];
          const ctr = c.center;
          let t;
          if (c.shape === 'sphere') {
            t = segSphereT(m.prev.x, m.prev.y, m.prev.z, m.pos.x, m.pos.y, m.pos.z, ctr.x, ctr.y, ctr.z, c.radius || 0);
          } else {
            const h = c.halfExtents;
            if (!h) continue;
            t = segAabbT(m.prev.x, m.prev.y, m.prev.z, m.pos.x, m.pos.y, m.pos.z, ctr.x, ctr.y, ctr.z, h.x, h.y, h.z, pad);
          }
          if (t >= 0 && t < hitT) { hitT = t; hitCol = c; hitAc = null; }
        }
      }

      // 地形
      if (!hitAc && !hitCol && terrain) {
        const t = this._terrainT(m.prev, m.pos, terrain);
        if (t >= 0 && t < hitT) hitT = t;
      }

      if (hitT <= 1) {
        _m1.copy(m.prev).lerp(m.pos, clamp01(hitT));
        m.pos.copy(_m1);
        this._detonateMissile(m, true, terrain, aircraft);
        continue;
      }

      /* --- 视觉：姿态 + 尾焰 + 尾烟 --- */
      if (this._visuals) {
        m.mesh.position.copy(m.pos);
        m.mesh.quaternion.setFromUnitVectors(FORWARD, m.dir);
        const tailZ = 0.5;
        m.smokeT -= dt;
        if (m.smokeT <= 0) {
          m.smokeT = 0.03;
          const sh = 0.55 + Math.random() * 0.12;
          this._smokePuff(
            m.pos.x - m.dir.x * tailZ, m.pos.y - m.dir.y * tailZ, m.pos.z - m.dir.z * tailZ,
            m.vel.x * 0.04 + (Math.random() - 0.5) * 1.2,
            m.vel.y * 0.04 + (Math.random() - 0.5) * 1.2,
            m.vel.z * 0.04 + (Math.random() - 0.5) * 1.2,
            1.3 + Math.random() * 1.1, sh,
          );
        }
        if (m.age < m.burnTime) {
          this._flareFx.spawn(
            m.pos.x - m.dir.x * 0.5, m.pos.y - m.dir.y * 0.5, m.pos.z - m.dir.z * 0.5,
            0, 0, 0, 0.09 + Math.random() * 0.05, 1.0, 0.72, 0.3, 0, 0,
          );
        }
      }
    }
  }

  /** 迭代求解预测拦截点（3 次足够收敛） */
  _predictIntercept(from, tPos, tVel, speed, out) {
    out.copy(tPos);
    const sp = Math.max(60, speed);
    for (let i = 0; i < 3; i++) {
      _m5.copy(out).sub(from);
      const d = _m5.length();
      out.copy(tPos).addScaledVector(tVel, d / sp);
    }
    return out;
  }

  /** 选最近的合法目标（跳过同队/已死/自己） */
  _pickTarget(m, aircraft) {
    const list = m.targets || aircraft;
    if (!list) return null;
    let best = null;
    let bestD = MISSILE_SEEK_RANGE * MISSILE_SEEK_RANGE;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!this._validTarget(t, m.owner)) continue;
      const d = t.body.position.distanceToSquared(m.pos);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  /** 导弹战斗部起爆（视觉 + 范围伤害） */
  _detonateMissile(m, impacted, terrain, aircraft) {
    if (!m.active) return;
    m.active = false;
    if (m.mesh) m.mesh.visible = false;
    const water = !!(impacted && terrain && terrain.isWater(m.pos.x, m.pos.z));
    this._explodeAt(m.pos, 1.8, this._missileDamage, this._missileRadius, m.owner, 'missile', aircraft);
    if (water) this._sfx('splash', m.pos);
  }

  /* ============================================================ 炸弹 */
  _updateBombs(dt, terrain, aircraft) {
    const pool = this._bombs;
    for (let i = 0; i < pool.length; i++) {
      const b = pool[i];
      if (!b.active) continue;
      b.age += dt;
      if (b.age > BOMB_LIFE) { b.active = false; if (b.mesh) b.mesh.visible = false; continue; }

      b.prev.copy(b.pos);
      b.vel.y -= this.gravity * dt;
      const dg = Math.max(0, 1 - BOMB_DRAG * dt);
      b.vel.multiplyScalar(dg);
      b.pos.addScaledVector(b.vel, dt);

      let hitT = 2;
      let col = null;

      /* 直击飞机 */
      if (aircraft) {
        for (let k = 0; k < aircraft.length; k++) {
          const a = aircraft[k];
          if (!this._validTarget(a, b.owner)) continue;
          const p = a.body.position;
          const r = (a.radius || 3) + 0.6;
          const t = segSphereT(b.prev.x, b.prev.y, b.prev.z, b.pos.x, b.pos.y, b.pos.z, p.x, p.y, p.z, r);
          if (t >= 0 && t < hitT) { hitT = t; col = null; }
        }
      }

      /* 地标 */
      if (this._hashReady) {
        const minx = Math.min(b.prev.x, b.pos.x) - 1.2;
        const miny = Math.min(b.prev.y, b.pos.y) - 1.2;
        const minz = Math.min(b.prev.z, b.pos.z) - 1.2;
        const maxx = Math.max(b.prev.x, b.pos.x) + 1.2;
        const maxy = Math.max(b.prev.y, b.pos.y) + 1.2;
        const maxz = Math.max(b.prev.z, b.pos.z) + 1.2;
        this._hash.query(minx, miny, minz, maxx, maxy, maxz, this._query);
        const q = this._query;
        for (let k = 0; k < q.n; k++) {
          const c = q[k];
          const ctr = c.center;
          let t;
          if (c.shape === 'sphere') {
            t = segSphereT(b.prev.x, b.prev.y, b.prev.z, b.pos.x, b.pos.y, b.pos.z, ctr.x, ctr.y, ctr.z, c.radius || 0);
          } else {
            const h = c.halfExtents;
            if (!h) continue;
            t = segAabbT(b.prev.x, b.prev.y, b.prev.z, b.pos.x, b.pos.y, b.pos.z, ctr.x, ctr.y, ctr.z, h.x, h.y, h.z, 0);
          }
          if (t >= 0 && t < hitT) { hitT = t; col = c; }
        }
      }

      /* 地形 */
      if (terrain) {
        const t = this._terrainT(b.prev, b.pos, terrain);
        if (t >= 0 && t < hitT) { hitT = t; col = null; }
      }

      if (hitT <= 1) {
        _d1.copy(b.prev).lerp(b.pos, clamp01(hitT));
        b.active = false;
        if (b.mesh) b.mesh.visible = false;
        const water = !!(terrain && terrain.isWater(_d1.x, _d1.z));
        const scale = clamp(b.radius / BOMB_BLAST_RADIUS, 1.2, 3) * 1.7;
        this._explodeAt(_d1, scale, b.damage, b.radius, b.owner, 'bomb', aircraft);
        if (water) this._sfx('splash', _d1);
        continue;
      }

      if (this._visuals) {
        b.mesh.position.copy(b.pos);
        _d0.copy(b.vel);
        if (_d0.lengthSq() > 1e-6) {
          _d0.normalize();
          b.mesh.quaternion.setFromUnitVectors(FORWARD, _d0);
        }
      }
    }
  }

  /* ============================================================ 干扰弹 */
  _updateFlares(dt, terrain) {
    const pool = this._flares;
    for (let i = 0; i < pool.length; i++) {
      const f = pool[i];
      if (!f.active) continue;
      f.life -= dt;
      if (f.life <= 0) { f.active = false; continue; }

      f.vel.y -= this.gravity * 0.8 * dt;
      const d = Math.max(0, 1 - 0.9 * dt);
      f.vel.multiplyScalar(d);
      f.pos.addScaledVector(f.vel, dt);

      if (terrain) {
        const gh = terrain.heightAt(f.pos.x, f.pos.z);
        if (f.pos.y <= gh) {
          f.active = false;
          this._smokePuff(f.pos.x, gh + 0.4, f.pos.z, 0, 0.6, 0, 0.9, 0.3);
          continue;
        }
      }

      if (this._visuals) {
        f.emitT -= dt;
        if (f.emitT <= 0) {
          f.emitT = 0.045;
          const k = 0.7 + Math.random() * 0.3;
          this._flareFx.spawn(
            f.pos.x, f.pos.y, f.pos.z,
            f.vel.x * 0.5 + (Math.random() - 0.5), f.vel.y * 0.5 - 1.2, f.vel.z * 0.5 + (Math.random() - 0.5),
            0.30, 1.0 * k, 0.66 * k, 0.24 * k, 0.4, 0.6,
          );
          if (Math.random() < 0.3) {
            this._smokePuff(
              f.pos.x, f.pos.y + 0.3, f.pos.z,
              (Math.random() - 0.5) * 1.2, 0.6 + Math.random(), (Math.random() - 0.5) * 1.2,
              1.0 + Math.random(), 0.32,
            );
          }
        }
      }
    }
  }

  /* ============================================================ 爆炸 */
  /**
   * 视觉爆炸 + 范围伤害（内部使用）。
   * @param {THREE.Vector3} pos
   * @param {number} scale 尺寸倍率
   * @param {number} damage 中心伤害
   * @param {number} radius 伤害半径（米）
   * @param {object} owner 伤害来源
   * @param {string} cause 'bomb' | 'missile' | ...
   * @param {object[]|null} aircraftList 参与范围伤害的飞机
   */
  _explodeAt(pos, scale, damage, radius, owner, cause, aircraftList) {
    this._spawnBlast(pos, scale);
    this._sfx(scale >= 2 ? 'explosion_big' : 'explosion', pos);
    const hits = this._radialDamage(pos, damage, radius, owner, cause, aircraftList);
    this._emit('explosion', {
      cause, position: this._evtPoint(pos), scale, radius, damage, owner, hits,
    });
  }

  /** 范围伤害（飞机 + 可破坏地标），返回命中数量 */
  _radialDamage(pos, damage, radius, owner, cause, aircraftList) {
    let hits = 0;
    if (!(damage > 0) || !(radius > 0)) return hits;

    const list = aircraftList || (this._ctx && this._ctx.aircraft) || null;
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (!this._validTarget(a, owner)) continue;
        const p = a.body.position;
        const d = Math.max(0, pos.distanceTo(p) - (a.radius || 3));
        if (d >= radius) continue;
        const k = 1 - d / radius;
        const dmg = damage * k * (0.35 + 0.65 * k);
        if (dmg < 1) continue;
        if (this._damageAircraft(a, dmg, pos, cause, owner)) hits++;
      }
    }

    const lm = this._ctx && this._ctx.landmarks;
    if (lm && lm.colliders) {
      const cols = lm.colliders;
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        if (!c || c.destroyed || !c.destructible || !c.center) continue;
        const d = pointColliderDist(pos.x, pos.y, pos.z, c);
        if (d >= radius) continue;
        const k = 1 - d / radius;
        const dmg = damage * k * (0.35 + 0.65 * k);
        if (dmg < 1) continue;
        if (this._damageCollider(c, dmg, pos, cause, owner)) hits++;
      }
    }
    return hits;
  }

  /** 生成一次爆炸特效（火球 + 火花 + 烟球） */
  _spawnBlast(pos, scale) {
    const i = this._acquire(this._explosions, '_curBlast');
    const e = this._explosions[i];
    e.active = true;
    e.t = 0;
    e.scale = scale;
    e.life = 0.5 + 0.22 * scale;
    e.maxRadius = 4.5 * scale;
    e.smokeT = 0;
    e.pos.copy(pos);

    if (!this._visuals) return;

    e.mesh.visible = true;
    e.mesh.position.copy(pos);
    e.mesh.scale.setScalar(0.2);
    e.mat.opacity = 1;
    e.mat.color.setRGB(1, 0.82, 0.42);

    /* 火花碎片 */
    const ns = Math.min(56, Math.round(14 + 12 * scale));
    const spd = 6 + 16 * scale;
    for (let k = 0; k < ns; k++) {
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const s = Math.sqrt(Math.max(0, 1 - u * u));
      const sp = spd * (0.35 + Math.random() * 0.65);
      this._sparks.spawn(
        pos.x, pos.y, pos.z,
        s * Math.cos(th) * sp, u * sp * 0.6 + 2 + scale * 2, s * Math.sin(th) * sp,
        0.3 + Math.random() * 0.5, 1.0, 0.62 + Math.random() * 0.25, 0.22, 9.81, 1.4,
      );
    }
    /* 烟球 */
    const np = Math.min(28, Math.round(6 + 5 * scale));
    for (let k = 0; k < np; k++) {
      this._smokePuff(
        pos.x + (Math.random() - 0.5) * scale * 2, pos.y + Math.random() * scale * 1.6, pos.z + (Math.random() - 0.5) * scale * 2,
        (Math.random() - 0.5) * 3, 1 + Math.random() * 3, (Math.random() - 0.5) * 3,
        1.4 + Math.random() * 1.6, 0.16 + Math.random() * 0.1,
      );
    }
  }

  /** 爆炸动画（膨胀 + 淡出 + 余烟） */
  _updateBlasts(dt) {
    const pool = this._explosions;
    for (let i = 0; i < pool.length; i++) {
      const e = pool[i];
      if (!e.active) continue;
      e.t += dt;
      const k = e.t / e.life;
      if (k >= 1) {
        e.active = false;
        e.mesh.visible = false;
        continue;
      }
      if (!this._visuals) continue;
      const r = e.maxRadius * (1 - (1 - k) * (1 - k));   // 先快后慢地膨胀
      e.mesh.scale.setScalar(Math.max(0.05, r));
      e.mat.opacity = Math.pow(1 - k, 1.6);
      e.mat.color.setRGB(1, 0.78 - 0.62 * k, 0.4 - 0.34 * k);
      e.smokeT -= dt;
      if (e.smokeT <= 0 && k < 0.6) {
        e.smokeT = 0.05;
        this._smokePuff(
          e.pos.x + (Math.random() - 0.5) * r * 0.8,
          e.pos.y + r * 0.4 + Math.random() * 2,
          e.pos.z + (Math.random() - 0.5) * r * 0.8,
          (Math.random() - 0.5) * 2, 1.5 + Math.random() * 2, (Math.random() - 0.5) * 2,
          1.2 + Math.random(), 0.2,
        );
      }
    }
  }

  /* ============================================================ 曳光弹绘制 */
  /** 把全部子弹的线段端点/颜色写进共享 buffer（每帧一次，O(子弹池)） */
  _syncTracers() {
    const pos = this._tracerPos;
    const col = this._tracerCol;
    const pool = this._bullets;
    for (let i = 0; i < pool.length; i++) {
      const b = pool[i];
      const o = i * 6, c4 = i * 8;
      if (!b.active) {
        pos[o] = 0; pos[o + 1] = 0; pos[o + 2] = 0;
        pos[o + 3] = 0; pos[o + 4] = 0; pos[o + 5] = 0;
        col[c4] = 0; col[c4 + 1] = 0; col[c4 + 2] = 0; col[c4 + 3] = 0;
        continue;
      }
      const fade = clamp01(b.life / BULLET_FADE);
      const len = clamp(b.speed * 0.03, 4, 40);
      _b2.copy(b.vel);
      if (_b2.lengthSq() > 1e-8) _b2.normalize(); else _b2.copy(b.dir);
      pos[o] = b.pos.x - _b2.x * len;
      pos[o + 1] = b.pos.y - _b2.y * len;
      pos[o + 2] = b.pos.z - _b2.z * len;
      pos[o + 3] = b.pos.x;
      pos[o + 4] = b.pos.y;
      pos[o + 5] = b.pos.z;
      col[c4] = 1.0; col[c4 + 1] = 0.86; col[c4 + 2] = 0.4;
      col[c4 + 3] = fade * fade;
    }
    this._tracerAttrPos.needsUpdate = true;
    this._tracerAttrCol.needsUpdate = true;
  }
}
