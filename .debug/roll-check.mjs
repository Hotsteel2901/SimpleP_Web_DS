import * as THREE from 'three';
import { Aircraft } from '../src/flight/aircraft.js';
import { stockCrafts } from '../src/build/crafts.js';

const craft = stockCrafts()[Number(process.argv[2] || 0)];
const ac = new Aircraft(craft, { position: new THREE.Vector3(0, 500, 0), isPlayer: true, assist: 0 });
ac.controls.assist = 0;
// 直接在 300m 空中、60m/s 平飞，自己控制俯仰保持姿态，观察滚转从哪来
ac.body.position.set(0, 300, 0);
ac.body.velocity.set(0, 0, -60);
ac.inputTarget.throttle = 0.6;
const env = {
  terrain: { heightAt: () => 0, isWater: () => false, normalAt: () => new THREE.Vector3(0, 1, 0), regionAt: () => null, built: true },
  landmarks: null, gravity: 9.81, wind: new THREE.Vector3(), projectiles: null, onEvent: () => {},
};
const dt = 1 / 120;
const e = new THREE.Euler();
const qi = new THREE.Quaternion();
console.log(`${craft.name} 配平=${ac.pitchTrim.toFixed(3)}`);
for (let i = 1; i <= 120 * 15; i++) {
  ac.controls.assist = 0;
  // 简易俯仰保持：让 pitch 回到 3°
  e.setFromQuaternion(ac.body.quaternion, 'YXZ');
  const perr = (3 - e.x * 57.3) / 20;
  ac.inputTarget.pitch = Math.max(-1, Math.min(1, perr));
  ac.update(dt, env);
  if (i % 120 === 0) {
    const b = ac.body;
    e.setFromQuaternion(b.quaternion, 'YXZ');
    qi.copy(b.quaternion).invert();
    const v = b.velocity.clone().applyQuaternion(qi);
    const beta = Math.atan2(v.x, -v.z) * 57.3;
    const tau = b.torque.clone().applyQuaternion(qi);   // 世界力矩 -> 机体系
    const w = b.angularVelocity.clone().applyQuaternion(qi);
    // 只有气动力矩：用真正的求解器复算（含下洗）
    const { solveWing, airDensity } = await import('../src/flight/physics.js');
    const bv2 = new THREE.Vector3();
    let az = 0, ax = 0, ay = 0;
    for (const s of ac.surfaces) {
      if (s.detached) continue;
      b.bodyVelocityAt(s.position, bv2);
      const res = solveWing(s, bv2, airDensity(b.position.y), { pitch: 0, roll: 0, yaw: 0, flap: 0, airbrake: 0 }, ac._wingOut);
      const f = res.forceLocal;
      az += s.position.x * f.y - s.position.y * f.x;
      ax += s.position.y * f.z - s.position.z * f.y;
      ay += s.position.z * f.x - s.position.x * f.z;
    }
    console.log(`t=${(i * dt).toFixed(0)} y=${b.position.y.toFixed(0)} V=${b.velocity.length().toFixed(1)} pitch=${(e.x * 57.3).toFixed(1)} roll=${(e.z * 57.3).toFixed(1)} hdg=${(-e.y * 57.3).toFixed(1)} β=${beta.toFixed(2)} | 总力矩=(${tau.x.toFixed(0)},${tau.y.toFixed(0)},${tau.z.toFixed(0)}) 气动力矩=(${ax.toFixed(0)},${ay.toFixed(0)},${az.toFixed(0)}) ωz=${w.z.toFixed(3)}`);
    if (i === 120 * 8) {
      for (const s of ac.surfaces) {
        if (s.detached) continue;
        b.bodyVelocityAt(s.position, bv2);
        const vv = bv2.clone();
        const res = solveWing(s, bv2, airDensity(b.position.y), { pitch: 0, roll: 0, yaw: 0, flap: 0, airbrake: 0 }, ac._wingOut);
        const f = res.forceLocal;
        const tz = s.position.x * f.y - s.position.y * f.x;
        console.log(`    ${(s.part.def + (s.isAileron ? '*' : '')).padEnd(12)} x=${s.position.x.toFixed(2)} v=(${vv.x.toFixed(2)},${vv.y.toFixed(2)},${vv.z.toFixed(2)}) CL=${res.cl.toFixed(3)} Mz=${tz.toFixed(0)}`);
      }
      // 同一姿态下的滚转阻尼：改变机体滚转率，看气动滚转力矩斜率
      const saveW2 = b.angularVelocity.clone();
      for (const p of [-0.2, -0.1, 0, 0.1, 0.2]) {
        b.angularVelocity.copy(saveW2).addScaledVector(b.bodyToWorldVector ? b.bodyToWorldVector(new THREE.Vector3(0, 0, 1), new THREE.Vector3()) : new THREE.Vector3(0, 0, 1).applyQuaternion(b.quaternion), p);
        let mz = 0;
        for (const s of ac.surfaces) {
          if (s.detached) continue;
          b.bodyVelocityAt(s.position, bv2);
          const res = solveWing(s, bv2, airDensity(b.position.y), { pitch: 0, roll: 0, yaw: 0, flap: 0, airbrake: 0 }, ac._wingOut);
          const f = res.forceLocal;
          mz += s.position.x * f.y - s.position.y * f.x;
        }
        console.log(`    Δ机体滚转率=${p.toFixed(2)} -> 气动滚转力矩=${mz.toFixed(0)}`);
      }
      b.angularVelocity.copy(saveW2);
    }
  }
}