/**
 * 刚体物理 + 气动求解器
 * ------------------------------------------------------------------
 * 单位：米 / 秒 / 千克 / 牛顿。世界 Y 向上。
 * 设计目标：稳定、可预测、足够真实的简化气动（升力线 + 失速 + 诱导阻力）。
 */
import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep } from '../core/util.js';

/* ------------------------------------------------------------------ 大气 */
export const SEA_LEVEL_DENSITY = 1.225;
/** 标准大气密度（kg/m³），高度单位米 */
export function airDensity(altitude) {
  const h = clamp(altitude, -500, 30000);
  if (h < 11000) return SEA_LEVEL_DENSITY * Math.pow(1 - 2.25577e-5 * h, 4.25588);
  return 0.3639 * Math.exp(-(h - 11000) / 6341.6);
}
/** 温度（摄氏） */
export function airTemperature(altitude) {
  const h = clamp(altitude, -500, 30000);
  return h < 11000 ? 15.04 - 0.00649 * h : -56.5;
}

/* ------------------------------------------------------------------ 刚体 */
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _m1 = new THREE.Matrix3(), _m2 = new THREE.Matrix3(), _m4 = new THREE.Matrix4();

export class RigidBody {
  /**
   * @param {object} o
   *  mass, position, quaternion, velocity, angularVelocity,
   *  inertia: THREE.Vector3 体坐标系主惯性矩 (Ixx, Iyy, Izz)
   *  linearDamping, angularDamping, gravityScale
   */
  constructor(o = {}) {
    this.mass = o.mass ?? 1000;
    this.invMass = 1 / Math.max(1e-6, this.mass);
    this.position = o.position ? o.position.clone() : new THREE.Vector3();
    this.quaternion = o.quaternion ? o.quaternion.clone() : new THREE.Quaternion();
    this.velocity = o.velocity ? o.velocity.clone() : new THREE.Vector3();
    this.angularVelocity = o.angularVelocity ? o.angularVelocity.clone() : new THREE.Vector3();
    this.inertia = o.inertia ? o.inertia.clone() : new THREE.Vector3(1000, 1000, 1000);
    this.linearDamping = o.linearDamping ?? 0.0;
    this.angularDamping = o.angularDamping ?? 0.06;
    this.gravityScale = o.gravityScale ?? 1;
    this.force = new THREE.Vector3();
    this.torque = new THREE.Vector3();
    this.invInertiaWorld = new THREE.Matrix3();
    this.inertiaWorld = new THREE.Matrix3();
    this.updateInertia();
  }
  setMass(m) { this.mass = Math.max(1e-6, m); this.invMass = 1 / this.mass; }
  setInertia(i) { this.inertia.copy(i); this.updateInertia(); }
  updateInertia() {
    _m4.makeRotationFromQuaternion(this.quaternion);
    const r = _m4.elements;
    const ix = Math.max(1e-3, this.inertia.x), iy = Math.max(1e-3, this.inertia.y), iz = Math.max(1e-3, this.inertia.z);
    // R * diag(I) * R^T —— 列主序 4x4：R[row][col] = e[col*4+row]
    const d = [ix, iy, iz];
    const out = this.inertiaWorld.elements, inv = this.invInertiaWorld.elements;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += r[k * 4 + i] * d[k] * r[k * 4 + j];
        out[j * 3 + i] = s;
      }
    }
    // 求逆（对称正定，用伴随矩阵）。Matrix3.elements 列主序：out[col*3+row]
    const a = out[0], b = out[3], c = out[6], e2 = out[1], f = out[4], g = out[7], h = out[2], i2 = out[5], j2 = out[8];
    const A = f * j2 - g * i2, B = -(e2 * j2 - g * h), C = e2 * i2 - f * h;
    const det = a * A + b * B + c * C;
    const id = 1 / (Math.abs(det) < 1e-9 ? 1e-9 : det);
    inv[0] = A * id; inv[3] = B * id; inv[6] = C * id;
    inv[1] = -(b * j2 - c * i2) * id; inv[4] = (a * j2 - c * h) * id; inv[7] = -(a * i2 - b * h) * id;
    inv[2] = (b * g - c * f) * id; inv[5] = -(a * g - c * e2) * id; inv[8] = (a * f - b * e2) * id;
  }
  /** 施加世界坐标力（作用于世界点 point，产生力矩） */
  applyForce(force, point) {
    this.force.add(force);
    if (point) {
      _v1.subVectors(point, this.position);
      _v2.crossVectors(_v1, force);
      this.torque.add(_v2);
    }
  }
  /** 施加世界坐标力矩 */
  applyTorque(t) { this.torque.add(t); }
  /** 清除累积的力/力矩（重力不在此列） */
  clearForces() { this.force.set(0, 0, 0); this.torque.set(0, 0, 0); }

  /** 世界速度 -> 机体坐标 */
  worldToBody(v, out = _v1) { return out.copy(v).applyQuaternion(_q1.copy(this.quaternion).invert()); }
  /** 机体坐标 -> 世界 */
  bodyToWorld(v, out = _v1) { return out.copy(v).applyQuaternion(this.quaternion); }

  /** 机体坐标系下某点的相对气流速度（含旋转贡献） */
  bodyVelocityAt(localPoint, out) {
    // v_world + ω × r_world
    _v3.copy(localPoint).applyQuaternion(this.quaternion); // r_world
    _v4.crossVectors(this.angularVelocity, _v3);
    _v2.copy(this.velocity).add(_v4);
    return out.copy(_v2).applyQuaternion(_q1.copy(this.quaternion).invert());
  }

  /** 应用世界坐标冲量（用于碰撞） */
  applyImpulse(impulse, point) {
    this.velocity.addScaledVector(impulse, this.invMass);
    if (point) {
      _v1.subVectors(point, this.position);
      _v2.crossVectors(_v1, impulse);
      const dw = _v2.applyMatrix3(this.invInertiaWorld);
      this.angularVelocity.add(dw);
    }
  }

  addGravity(gravity, dt) {
    this.force.y -= this.mass * gravity * this.gravityScale;
  }

  integrate(dt) {
    if (dt <= 0) return;
    // 线性
    this.velocity.addScaledVector(this.force, this.invMass * dt);
    if (this.linearDamping > 0) this.velocity.multiplyScalar(1 / (1 + this.linearDamping * dt));
    this.position.addScaledVector(this.velocity, dt);
    // 角向：τ - ω×(Iω)
    _v1.copy(this.angularVelocity).applyMatrix3(this.inertiaWorld); // Iω (世界)
    _v2.crossVectors(this.angularVelocity, _v1);
    _v3.copy(this.torque).sub(_v2);
    _v3.applyMatrix3(this.invInertiaWorld);
    this.angularVelocity.addScaledVector(_v3, dt);
    if (this.angularDamping > 0) this.angularVelocity.multiplyScalar(1 / (1 + this.angularDamping * dt));
    this.angularVelocity.clampLength(0, 30);
    // 四元数
    _q1.set(this.angularVelocity.x * dt * 0.5, this.angularVelocity.y * dt * 0.5, this.angularVelocity.z * dt * 0.5, 0);
    _q1.multiply(this.quaternion);
    this.quaternion.x += _q1.x; this.quaternion.y += _q1.y; this.quaternion.z += _q1.z; this.quaternion.w += _q1.w;
    this.quaternion.normalize();
    this.updateInertia();
  }
  get speed() { return this.velocity.length(); }
  get kineticEnergy() { return 0.5 * this.mass * this.velocity.lengthSq(); }
}

/* ------------------------------------------------------------------ 气动 */
/**
 * 翼面气动中心（焦点）相对「零件原点」的 z 偏移，单位米。
 * ------------------------------------------------------------------
 * 零件原点在翼根弦的中点（见 build/parts.js 的 wingGeometry 约定），而真实升力作用在
 * 平均气动弦（MAC）的 1/4 处 —— 对带收缩比 / 后掠的翼面，这两点差得很远：
 *   · 矩形翼（λ=1, 无后掠）：Δz = -0.25c
 *   · 三角翼（λ=0.12, 后掠 2.4m）：Δz ≈ -0.18c
 * 用错位置会让整机中性点评估差出 0.5m 量级，配平舵量与静稳定性全跑偏
 * （现象就是「机翼看着装错地方」「一松手就抬头/低头」）。
 * @param {number} chord 翼根弦长
 * @param {number} taper 收缩比（1 = 矩形）
 * @param {number} sweep 翼尖后掠量（米）
 */
export function acOffset(chord, taper = 1, sweep = 0) {
  const lam = clamp(taper, 0.05, 1);
  const mac = (2 / 3) * chord * (1 + lam + lam * lam) / (1 + lam);
  const zLE = sweep * (1 + 2 * lam) / (3 * (1 + lam));   // MAC 前缘相对翼根前缘的后移
  const acNormal = zLE + 0.25 * mac;                     // 常规翼：1/4 MAC（相对翼根前缘）
  // 三角翼/小展弦比：前缘涡提供额外升力，焦点明显后移到 0.4~0.5 根弦
  const slender = clamp((0.45 - lam) / 0.4, 0, 1);
  const ac = lerp(acNormal, 0.45 * chord, slender * 0.7);
  return ac - 0.5 * chord;
}

/**
 * 翼面气动求解。
 * @param {object} s 翼面描述（机体坐标系）
 *   { area, span, chord, thick, cd0, control, controlSign, position(THREE.Vector3 机体),
 *     normal(THREE.Vector3 机体单位法线), chordDir(THREE.Vector3 机体单位弦向), spanDir(THREE.Vector3 机体展向) }
 * @param {THREE.Vector3} vLocal 该点机体坐标系相对气流速度
 * @param {number} density 空气密度
 * @param {object} ctl 控制输入 { pitch, roll, yaw, flap, airbrake, speed }
 * @param {object} out 复用的输出对象 { forceLocal:Vector3, alpha, cl, cd, stall, q }
 */
export function solveWing(s, vLocal, density, ctl, out) {
  const f = out.forceLocal.set(0, 0, 0);
  const u = vLocal.dot(s.chordDir);   // 弦向分量（前飞为负）
  const w = vLocal.dot(s.normal);     // 法向分量
  const side = vLocal.dot(s.spanDir);
  const V2 = u * u + w * w + side * side * 0.35;
  const V = Math.sqrt(V2);
  out.q = 0.5 * density * V2;
  out.alpha = 0; out.cl = 0; out.cd = 0; out.stall = false;
  if (V < 0.6) return out; // 静止时无气动力

  const alpha = Math.atan2(-w, -u) + (s.alphaOffset || 0);
  out.alpha = alpha;
  const AR = clamp(s.span * s.span / Math.max(1e-4, s.area), 1.2, 12);
  const aLift = (2 * Math.PI * AR) / (AR + 2) * (s.liftScale ?? 1);
  const thick = s.thick ?? 0.12;
  const aStall = clamp(0.22 + thick * 0.55, 0.16, 0.34);

  // 控制面偏转产生的附加升力
  let dCL = 0;
  let flapDrag = 0;
  if (s.control) {
    // 舵面效率：面积越大越接近 1（真实舵面占翼面 20~30% 时效率很高）
    const eff = 0.7 + 0.3 * clamp01(s.area / 1.5);
    if (s.control === 'elevator') dCL += -ctl.pitch * 1.15 * (s.pitchDir ?? s.controlDir ?? 1);
    else if (s.control === 'aileron') dCL += ctl.roll * 0.75 * (s.rollDir ?? s.controlDir ?? 1);
    else if (s.control === 'rudder') dCL += ctl.yaw * 0.85 * (s.rudderDir ?? s.controlDir ?? 1);
    else if (s.control === 'flap') { dCL += (ctl.flap ?? 0) * 1.05; flapDrag = (ctl.flap ?? 0) * 0.09; }
    else if (s.control === 'elevon') dCL += (-ctl.pitch * 0.85 * (s.pitchDir ?? 1) + ctl.roll * 0.5 * (s.rollDir ?? 1));
    else if (s.control === 'airbrake') { dCL *= 0; flapDrag = (ctl.airbrake ?? 0) * 1.4; }
    dCL *= eff;
  }

  const aAbs = Math.abs(alpha);
  let CL;
  if (aAbs <= aStall) {
    CL = aLift * alpha;
  } else {
    const CLmax = aLift * aStall;
    const t = smoothstep(aStall, aStall + 0.4, aAbs);
    const flat = 2 * Math.sin(alpha) * Math.cos(alpha);
    CL = lerp(Math.sign(alpha) * CLmax, flat, t * 0.92);
    out.stall = true;
  }
  CL += dCL;
  CL = clamp(CL, -2.6, 2.6);
  out.cl = CL;

  let CD = (s.cd0 ?? 0.012) + (CL * CL) / (Math.PI * AR * 0.82) + flapDrag;
  if (aAbs > aStall) CD += (aAbs - aStall) * 1.35 * Math.abs(CL) + 0.06;
  if (s.control === 'rudder') CD += Math.abs(ctl.yaw) * 0.006;
  out.cd = CD;

  // 迎风方向（弦向-法向平面内）与升力方向
  _v1.set(0, 0, 0).addScaledVector(s.chordDir, u).addScaledVector(s.normal, w);
  if (_v1.lengthSq() > 1e-9) _v1.normalize(); else _v1.set(0, 0, -1);
  _v2.crossVectors(s.spanDir, _v1); // 升力方向
  if (_v2.lengthSq() < 1e-9) _v2.set(0, 1, 0); else _v2.normalize();

  const qS = out.q * s.area;
  f.addScaledVector(_v2, qS * CL);
  f.addScaledVector(_v1, -qS * CD);
  // 侧滑侧力（机身/垂尾的展向阻力）
  const beta = Math.atan2(side, Math.max(1e-4, -u));
  f.addScaledVector(s.spanDir, -qS * clamp(beta, -0.6, 0.6) * (s.sideForce ?? 1.1));
  return out;
}

/* ------------------------------------------------------------------ 碰撞 */
/**
 * 球（飞机包围球）与旋转盒（地标建筑）的近似碰撞。
 * 用 AABB 简化：先把球心变换到盒体局部坐标，做 clamp 最近点检测。
 * @returns {null|{normal:THREE.Vector3, depth:number, point:THREE.Vector3}}
 */
const _boxInv = new THREE.Matrix4(), _localP = new THREE.Vector3(), _closest = new THREE.Vector3();
export function sphereVsOBB(center, radius, box) {
  const { center: bc, halfExtents: he, quaternion } = box;
  if (!he) return null;
  _boxInv.makeRotationFromQuaternion(quaternion || _qi).setPosition(bc);
  _boxInv.invert();
  _localP.copy(center).applyMatrix4(_boxInv);
  const cx = clamp(_localP.x, -he.x, he.x), cy = clamp(_localP.y, -he.y, he.y), cz = clamp(_localP.z, -he.z, he.z);
  _closest.set(cx, cy, cz);
  const inside = (Math.abs(_localP.x) < he.x && Math.abs(_localP.y) < he.y && Math.abs(_localP.z) < he.z);
  let normalLocal, depth;
  if (inside) {
    // 找到最近的面
    const dx = he.x - Math.abs(_localP.x), dy = he.y - Math.abs(_localP.y), dz = he.z - Math.abs(_localP.z);
    if (dx < dy && dx < dz) { normalLocal = new THREE.Vector3(Math.sign(_localP.x), 0, 0); depth = dx + radius; }
    else if (dy < dz) { normalLocal = new THREE.Vector3(0, Math.sign(_localP.y), 0); depth = dy + radius; }
    else { normalLocal = new THREE.Vector3(0, 0, Math.sign(_localP.z)); depth = dz + radius; }
  } else {
    const d = _closest.distanceTo(_localP);
    if (d > radius) return null;
    normalLocal = _closest.clone().sub(_localP).normalize();
    depth = radius - d;
  }
  const normal = normalLocal.clone().applyQuaternion(quaternion || _qi);
  const point = _closest.clone().applyMatrix4(_boxInv.clone().invert());
  return { normal, depth, point };
}
const _qi = new THREE.Quaternion();

/**
 * 通用球-盒碰撞响应：把冲量施加到刚体上，返回撞击强度（用于伤害/音效）。
 */
export function resolveSphereBox(body, center, radius, box, restitution = 0.28, friction = 0.6) {
  const hit = sphereVsOBB(center, radius, box);
  if (!hit) return 0;
  const r = _v1.copy(hit.point).sub(body.position); // 力臂
  const velAtPoint = _v2.copy(body.velocity).add(_v3.crossVectors(body.angularVelocity, r));
  const vn = velAtPoint.dot(hit.normal);
  if (vn > 0.05) return 0; // 正在分离
  const invI = body.invInertiaWorld;
  // 有效质量
  _v3.crossVectors(r, hit.normal);
  const angularTerm = _v3.applyMatrix3(invI).cross(r).dot(hit.normal);
  const invMassEff = body.invMass + angularTerm;
  const j = -(1 + restitution) * vn / Math.max(1e-6, invMassEff);
  const impulse = _v4.copy(hit.normal).multiplyScalar(j);
  body.applyImpulse(impulse, hit.point);
  // 切向摩擦
  const velAtPoint2 = new THREE.Vector3().copy(body.velocity).add(new THREE.Vector3().crossVectors(body.angularVelocity, r));
  const tangential = velAtPoint2.addScaledVector(hit.normal, -velAtPoint2.dot(hit.normal));
  if (tangential.lengthSq() > 1e-6) {
    tangential.normalize();
    const jt = clamp(-velAtPoint2.length() * 0.6, -Math.abs(j) * friction, Math.abs(j) * friction);
    body.applyImpulse(tangential.multiplyScalar(jt), hit.point);
  }
  // 位置修正
  body.position.addScaledVector(hit.normal, hit.depth * 0.9);
  return Math.abs(vn);
}

/* ------------------------------------------------------------------ 简单 PID 控制器（AI 用） */
export class PID {
  constructor(kp = 1, ki = 0, kd = 0.12) { this.kp = kp; this.ki = ki; this.kd = kd; this.i = 0; this.prev = 0; }
  update(err, dt, limit = 1) {
    this.i = clamp(this.i + err * dt, -1, 1);
    const d = (err - this.prev) / Math.max(1e-4, dt);
    this.prev = err;
    return clamp(this.kp * err + this.ki * this.i + this.kd * d, -limit, limit);
  }
  reset() { this.i = 0; this.prev = 0; }
}
