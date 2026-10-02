// 全机型配平/稳定性体检：巡航残差力矩、俯仰阻尼、滚转阻尼、风标稳定性、操纵功率
import * as THREE from 'three';
import { Aircraft } from '../src/flight/aircraft.js';
import { solveWing, airDensity } from '../src/flight/physics.js';
import { stockCrafts } from '../src/build/crafts.js';

const out = { forceLocal: new THREE.Vector3(), alpha: 0, cl: 0, cd: 0, stall: false, q: 0 };
const bv = new THREE.Vector3();
const flat = { heightAt: () => 0, isWater: () => false, normalAt: () => new THREE.Vector3(0, 1, 0), regionAt: () => null, built: true };

for (const craft of stockCrafts()) {
  if (craft.type !== 'plane') continue;
  const ac = new Aircraft(craft, { position: new THREE.Vector3(0, 300, 0), isPlayer: true, assist: 0 });
  const body = ac.body;
  const V = 60, rho = 1.225;
  const ctl = { pitch: ac.pitchTrim, roll: ac.rollTrim || 0, yaw: ac.yawTrim || 0, flap: 0, airbrake: 0 };
  const ctl0 = { pitch: ac.pitchTrim, roll: ac.rollTrim || 0, yaw: ac.yawTrim || 0, flap: 0, airbrake: 0 };

  // 在给定姿态下积分气动力/力矩（不含重力/推力/螺旋桨）
  const probe = (quat, vel, c) => {
    body.quaternion.copy(quat); body.velocity.copy(vel);
    const density = rho;
    let mx = 0, my = 0, mz = 0, ly = 0, fx = 0, fz = 0;
    // 下洗
    let clS = 0, aS = 0;
    body.bodyVelocityAt(new THREE.Vector3(), bv);
    for (const s of ac.surfaces) { if (!s.isWing) continue; body.bodyVelocityAt(s.position, bv); const r = solveWing(s, bv, density, c, out); clS += r.cl * s.area; aS += s.area; }
    const dw = -Math.max(-1.4, Math.min(1.4, aS ? clS / aS : 0)) * 0.11;
    for (const s of ac.surfaces) {
      if (s.detached) continue;
      s.alphaOffset = (s.isWing || s.isAileron) ? 0 : (s.position.z >= ac.wingACz ? dw : -dw * 0.5) + (s.incidence || 0);
      body.bodyVelocityAt(s.position, bv);
      const r = solveWing(s, bv, density, c, out);
      const f = r.forceLocal;
      mx += s.position.y * f.z - s.position.z * f.y;
      my += s.position.z * f.x - s.position.x * f.z;
      mz += s.position.x * f.y - s.position.y * f.x;
      ly += f.y; fx += f.x; fz += f.z;
    }
    return { mx, my, mz, ly, fx, fz };
  };

  const q0 = new THREE.Quaternion();
  const cruise = new THREE.Vector3(0, 0, -V);
  const base = probe(q0, cruise, ctl);
  const W = body.mass * 9.81;

  // 俯仰阻尼：绕 +X 角速度
  const wSave = body.angularVelocity.clone();
  body.angularVelocity.set(0.5, 0, 0);
  const withQ = probe(q0, cruise, ctl);
  body.angularVelocity.set(0, 0, 0);
  // 滚转阻尼
  body.angularVelocity.set(0, 0, 0.5);
  const withP = probe(q0, cruise, ctl);
  body.angularVelocity.set(0, 0, 0);
  // 侧滑
  const beta = 0.1;
  const slipV = new THREE.Vector3(Math.sin(beta) * V, 0, -Math.cos(beta) * V);
  const withBeta = probe(q0, slipV, ctl);
  body.angularVelocity.copy(wSave);

  // 俯仰操纵功率（+1 全拉杆）
  const pCtl = { ...ctl, pitch: Math.min(1, ac.pitchTrim + 1) };
  const pitchUp = probe(q0, cruise, pCtl);
  // 滚转操纵功率
  const rCtl = { ...ctl, roll: 1 };
  const rollR = probe(q0, cruise, rCtl);

  const clampv = (x) => Math.abs(x) < 1e-9 ? 0 : x;
  console.log(`${craft.name.padEnd(13)} m=${body.mass.toFixed(0).padStart(5)} I=(${body.inertia.x.toFixed(0)},${body.inertia.y.toFixed(0)},${body.inertia.z.toFixed(0)}) 配平(${ctl.pitch.toFixed(2)},${ctl.yaw.toFixed(2)},${(ac.rollTrim || 0).toFixed(3)})`);
  console.log(`   巡航残差 τ=(${clampv(base.mx).toFixed(0)},${clampv(base.my).toFixed(0)},${clampv(base.mz).toFixed(0)}) 升力=${base.ly.toFixed(0)}/${W.toFixed(0)}N  角速度:%/s=(${(clampv(base.mx) / body.inertia.x * 57.3).toFixed(2)},${(clampv(base.my) / body.inertia.y * 57.3).toFixed(2)},${(clampv(base.mz) / body.inertia.z * 57.3).toFixed(2)})`);
  const dq = (withQ.mx - base.mx) / 0.5, dp = (withP.mz - base.mz) / 0.5;
  console.log(`   俯仰阻尼=${dq.toFixed(0)} (期望<0) 时间常数=${(-body.inertia.x / dq).toFixed(2)}s | 滚转阻尼=${dp.toFixed(0)} (期望<0) 时间常数=${(-body.inertia.z / dp).toFixed(2)}s`);
  console.log(`   侧滑β=5.7°: 滚转=${withBeta.mz.toFixed(0)}(期望<0) 偏航=${withBeta.my.toFixed(0)}(期望>0) 侧力=${withBeta.fx.toFixed(0)}`);
  console.log(`   全拉杆: Δτ俯仰=${(pitchUp.mx - base.mx).toFixed(0)} → 角加速度 ${((pitchUp.mx - base.mx) / body.inertia.x).toFixed(2)} rad/s² (${((pitchUp.mx - base.mx) / body.inertia.x * V).toFixed(1)}°/s²·V) 过载${((pitchUp.ly - base.ly) / W).toFixed(2)}g`);
  console.log(`   全压杆: Δτ滚转=${(rollR.mz - base.mz).toFixed(0)} → 滚转角加速度 ${((rollR.mz - base.mz) / body.inertia.z).toFixed(2)} rad/s²`);
}