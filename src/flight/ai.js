/**
 * AI 飞行员
 * ------------------------------------------------------------------
 * 用简单的“指向-油门”控制器完成：
 *   巡航（跟随航路点）/ 追击（咬尾空战）/ 对地攻击 / 规避机动 / 编队
 * 通过 Aircraft.inputTarget 操纵，与玩家共用同一套飞行动力学。
 */
import * as THREE from 'three';
import { clamp, clamp01, damp, TAU } from '../core/util.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class AIPilot {
  /**
   * @param {import('./aircraft.js').Aircraft} aircraft
   * @param {object} opts { skill:0..1, team, aggression, waypoints, name }
   */
  constructor(aircraft, opts = {}) {
    this.ac = aircraft;
    this.skill = clamp01(opts.skill ?? 0.5);
    this.aggression = clamp01(opts.aggression ?? 0.6);
    this.behavior = opts.behavior || 'patrol';
    this.waypoints = (opts.waypoints || []).map((p) => (p.isVector3 ? p.clone() : new THREE.Vector3(p.x, p.y, p.z)));
    this.wpIndex = 0;
    this.target = opts.target || null;          // Aircraft 或 {position}
    this.targetPoint = opts.targetPoint || null;
    this.homePoint = opts.homePoint || null;
    this.cruiseAlt = opts.cruiseAlt ?? 450;
    this.cruiseSpeed = opts.cruiseSpeed ?? 150;
    this.state = 'cruise';
    this.timer = 0;
    this.stuckTimer = 0;
    this.lastPos = new THREE.Vector3();
    this.jitter = Math.random() * 10;
    this.fireCooldown = 0;
    this.orbitAngle = Math.random() * TAU;
    this.evadeDir = Math.random() < 0.5 ? 1 : -1;
    this.waypointRadius = opts.waypointRadius ?? 120;
  }

  setTarget(t) { this.target = t || null; }
  setWaypoints(list) { this.waypoints = (list || []).map((p) => (p.isVector3 ? p.clone() : new THREE.Vector3(p.x, p.y, p.z))); this.wpIndex = 0; }

  /** 主更新 */
  update(dt, world = {}) {
    const ac = this.ac;
    if (!ac || ac.destroyed) return;
    this.timer += dt;
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    const terrain = world.terrain;
    const agl = terrain ? ac.body.position.y - terrain.heightAt(ac.body.position.x, ac.body.position.z) : ac.body.position.y;

    // 更新目标有效性
    if (this.target && (this.target.destroyed || this.target.alive === false)) this.target = null;

    let desired = _v.set(0, 0, 0);
    let throttle = 1;
    let fire = false;

    const mode = this.behavior;
    if (mode === 'dogfight' && this.target) {
      const r = this._dogfight(dt, this.target, _v);
      throttle = r.throttle; fire = r.fire;
      desired = r.dir;
    } else if (mode === 'groundAttack' && (this.targetPoint || this.target)) {
      const tp = this.targetPoint || this.target.body?.position || this.target.position;
      const r = this._groundAttack(dt, tp, _v);
      throttle = r.throttle; fire = r.fire;
      desired = r.dir;
    } else {
      const r = this._patrol(dt, terrain, _v);
      throttle = r.throttle;
      desired = r.dir;
    }

    // 地形规避：除了看高度，还要看「还有几秒撞地」（俯冲速度大时 AGL 再高也来不及）
    const minAgl = 90 + (1 - this.skill) * 90;
    const vs = ac.body.velocity.y;
    const tti = vs < -1 ? agl / -vs : Infinity;
    const pullup = (agl < minAgl && vs < 6) || tti < 4.5 || (agl < 220 && vs < -25);
    if (pullup) {
      desired = _v2.copy(desired).normalize().add(_v3.set(0, 1.4, 0)).normalize();
      throttle = 1;
      this.state = 'pullup';
    }

    this._steer(desired, dt);
    // 保命机动不受过载限制器的约束（否则高速俯冲时 AI 拉不起来，一头扎进地里）
    if (pullup) {
      ac.inputTarget.pitch = 1;
      ac.inputTarget.roll = damp(ac.inputTarget.roll || 0, 0, 3, dt);
    }
    ac.inputTarget.throttle = clamp01(throttle);
    ac.controls.fire1 = fire;
    ac.controls.fire2 = false;
    // 起落架自动收放
    if (agl > 60 && ac.controls.gear) ac.controls.gear = false;
    else if (agl < 25 && !ac.controls.gear && Math.abs(ac.state.verticalSpeed) < 6) ac.controls.gear = true;

    this.lastPos.copy(ac.body.position);
  }

  /* ---------------------------------------------------------------- 行为 */
  _patrol(dt, terrain, out) {
    let target = null;
    if (this.waypoints.length) {
      const wp = this.waypoints[this.wpIndex];
      const d = wp.distanceTo(this.ac.body.position);
      if (d < this.waypointRadius) this.wpIndex = (this.wpIndex + 1) % this.waypoints.length;
      target = this.waypoints[this.wpIndex];
    } else if (this.homePoint) {
      target = this.homePoint;
      const d = target.distanceTo(this.ac.body.position);
      if (d < 300) {
        // 盘旋
        this.orbitAngle += dt * 0.35;
        target = _v2.copy(this.homePoint).add(_v3.set(Math.cos(this.orbitAngle) * 400, 0, Math.sin(this.orbitAngle) * 400));
      }
    } else {
      out.set(this.ac.body.velocity.x, 0, this.ac.body.velocity.z);
      if (out.lengthSq() < 1) out.set(0, 0, -1);
      out.normalize();
      return { dir: out, throttle: 0.7 };
    }
    out.copy(target).sub(this.ac.body.position);
    // 速度保持：巡航速度与当前速度的误差决定油门
    const desiredSpeed = this.cruiseSpeed ?? 150;
    const err = (desiredSpeed - this.ac.state.speed) / 55;
    return { dir: out, throttle: clamp01(0.6 + err) };
  }

  _dogfight(dt, target, out) {
    const ac = this.ac;
    const tp = target.body ? target.body.position : target.position;
    const tv = target.body ? target.body.velocity : (target.velocity || _v3.set(0, 0, 0));
    const toT = _v2.copy(tp).sub(ac.body.position);
    const dist = toT.length();
    const fwd = _v3.set(0, 0, -1).applyQuaternion(ac.body.quaternion);

    // 领先追逐：预测交汇点
    const speed = Math.max(30, ac.state.speed);
    const tLead = clamp(dist / speed, 0, 4) * (0.4 + this.skill * 0.6);
    const aim = toT.clone().addScaledVector(tv, tLead);
    out.copy(aim);

    // 攻击判定：目标在机头 ±12° 内且距离 < 900
    const dirToT = toT.clone().normalize();
    const cosA = fwd.dot(dirToT);
    const inCone = cosA > Math.cos(0.21);
    const inRange = dist < 1000 && dist > 60;
    let fire = false;
    if (inCone && inRange && this.fireCooldown <= 0) {
      fire = true;
      this.fireCooldown = 0.06;
      // 近距发射导弹
      if (dist > 250 && dist < 1400 && cosA > 0.985 && this.timer > 3) {
        ac.controls.fire2 = true;
        if (this.fireCooldown <= 0) this.fireCooldown = 0.2;
      }
    }
    // 被打伤或处于劣势时脱离
    if (ac.health < 0.45 && Math.random() < 0.004) { this.state = 'evade'; this.timer = 0; }

    // 追击：优先保住能量
    const want = dist > 700 ? 175 : (dist < 200 ? 120 : 150);
    let throttle = clamp01(0.62 + (want - ac.state.speed) / 55);
    return { dir: out, throttle, fire };
  }

  _groundAttack(dt, tp, out) {
    const ac = this.ac;
    const toT = _v2.copy(tp).sub(ac.body.position);
    const dist = toT.length();
    const agl = ac.body.velocity.y;
    const alt = ac.body.position.y - tp.y;
    // 俯冲投弹后拉起
    if (this.state !== 'egress' && alt < 260 && dist < 1100) {
      this.state = 'dive';
      out.copy(toT).addScaledVector(_v3.set(0, 1, 0), 30);
      const fire = ac.controls.dropBomb = dist < 420 && alt > 60 && alt < 260;
      if (alt < 130) { this.state = 'egress'; this.timer = 0; }
      return { dir: out, throttle: 0.85, fire };
    }
    if (this.state === 'egress' && this.timer < 5) {
      out.copy(ac.body.velocity).normalize().add(_v3.set(0, 1.2, 0));
      ac.controls.dropBomb = false;
      return { dir: out, throttle: 1, fire: false };
    }
    // 重新进入攻击航路（绕到目标后方并爬升）
    this.orbitAngle += dt * 0.5 * this.evadeDir;
    const approach = _v3.copy(tp)
      .add(_v2.set(Math.cos(this.orbitAngle) * 1200, 420, Math.sin(this.orbitAngle) * 1200));
    out.copy(approach).sub(ac.body.position);
    if (dist < 1500 && alt > 350) { this.state = 'dive'; }
    ac.controls.dropBomb = false;
    return { dir: out, throttle: 0.95, fire: false };
  }

  /* ---------------------------------------------------------------- 操纵 */
  /** 把“期望方向”转成舵面输入 */
  _steer(desired, dt) {
    const ac = this.ac;
    if (desired.lengthSq() < 1e-6) desired.set(0, 0, -1);
    desired.normalize();
    // 转到机体坐标
    _q.copy(ac.body.quaternion).invert();
    const local = _v.copy(desired).applyQuaternion(_q); // x=右, y=上, z=后
    // 误差
    const errX = local.x;                       // 目标在右侧 -> 右滚
    const errY = local.y;                       // 目标在上方 -> 抬头
    const fwdDot = -local.z;                    // 1 = 正前方
    const skill = this.skill;

    // 滚转：让机腹朝向目标方向（先滚转再拉杆）
    let rollCmd = clamp(errX * (2.4 + skill), -1, 1);
    // 正后方/正前方时避免滚转震荡
    if (fwdDot < -0.6) rollCmd = clamp(errX * 3.2, -1, 1);

    // 俯仰：距离越远越柔和
    let pitchCmd = clamp(errY * (2.2 + skill * 1.4) + (fwdDot < 0 ? 0.4 : 0), -1, 1);
    // 过载保护
    if (ac.state.gForce > 7.5) pitchCmd = clamp(pitchCmd, -0.2, 0.35);
    if (ac.state.stall) pitchCmd = Math.min(pitchCmd, 0);

    // 侧滑抑制：用方向舵协调转弯
    const slip = ac.state.slip || 0;
    let yawCmd = clamp(-slip * 2.0 - errX * 0.35, -1, 1);

    // 平滑（模拟人的反应速度）
    const react = 4 + skill * 6;
    ac.inputTarget.pitch = damp(ac.inputTarget.pitch || 0, pitchCmd, react, dt);
    ac.inputTarget.roll = damp(ac.inputTarget.roll || 0, rollCmd, react, dt);
    ac.inputTarget.yaw = damp(ac.inputTarget.yaw || 0, yawCmd, react * 0.7, dt);
  }
}

/** 生成一支 AI 编队 */
export function makeAIPilots(aircraftList, opts = {}) {
  return aircraftList.map((ac, i) => new AIPilot(ac, {
    skill: opts.skill ?? 0.5,
    behavior: opts.behavior || 'patrol',
    waypoints: opts.waypoints,
    targetPoint: opts.targetPoint,
    homePoint: opts.homePoint,
    cruiseAlt: opts.cruiseAlt,
  }));
}
