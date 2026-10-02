// 滑跑起飞过程中的滚转来源追踪
import * as THREE from 'three';
import { Aircraft } from '../src/flight/aircraft.js';
import { stockCrafts } from '../src/build/crafts.js';

const flat = { heightAt: () => 0, isWater: () => false, normalAt: () => new THREE.Vector3(0, 1, 0), regionAt: () => null, built: true };
const env = () => ({ terrain: flat, landmarks: null, gravity: 9.81, wind: new THREE.Vector3(), projectiles: null, onEvent: () => {} });
const craft = stockCrafts()[Number(process.argv[2] || 0)];
const ac = new Aircraft(craft, { position: new THREE.Vector3(0, 500, 0), isPlayer: true, assist: Number(process.argv[3] ?? 0) });
ac.placeOnGround(flat, 0, 0, 0);
ac.inputTarget.throttle = 1;
const e = env();
const dt = 1 / 120;
const eu = new THREE.Euler(), qi = new THREE.Quaternion();
const vs = Math.sqrt(2 * ac.body.mass * 9.81 / (1.225 * Math.max(1, ac.surfaces.filter(s => s.isWing).reduce((a, s) => a + s.area, 0)) * 1.2));
console.log(`${craft.name} 失速≈${vs.toFixed(0)} 配平(${ac.pitchTrim.toFixed(2)},${(ac.yawTrim || 0).toFixed(2)}) 辅助=${ac.assist}`);
for (let i = 0; i < 120 * 30; i++) {
  if (ac.state.speed > vs * 1.12) {
    const err = (10 - ac.state.pitch) / 12;
    ac.inputTarget.pitch = Math.max(-1, Math.min(1, err * 1.4));
  }
  ac.update(dt, e);
  if (i % 60 === 0) {
    const b = ac.body;
    eu.setFromQuaternion(b.quaternion, 'YXZ');
    qi.copy(b.quaternion).invert();
    const v = b.velocity.clone().applyQuaternion(qi);
    const tau = b.torque.clone().applyQuaternion(qi);
    console.log(`t=${(i * dt).toFixed(0)} V=${b.velocity.length().toFixed(0)} y=${b.position.y.toFixed(1)} pitch=${(eu.x * 57.3).toFixed(0)} eulerRoll=${(eu.z * 57.3).toFixed(0)} bank=${(Math.asin(new THREE.Vector3(1, 0, 0).applyQuaternion(b.quaternion).y) * 57.3).toFixed(0)} hdg=${(-eu.y * 57.3).toFixed(0)} β=${(Math.atan2(v.x, -v.z) * 57.3).toFixed(2)} G=${ac.groundContact ? 'Y' : '.'} τ=(${tau.x.toFixed(0)},${tau.y.toFixed(0)},${tau.z.toFixed(0)}) ω=(${(b.angularVelocity.clone().applyQuaternion(qi).x).toFixed(3)},${(b.angularVelocity.clone().applyQuaternion(qi).y).toFixed(3)},${(b.angularVelocity.clone().applyQuaternion(qi).z).toFixed(3)})`);
  }
  if (i === 120 * 22) {
    const { solveWing, airDensity } = await import('../src/flight/physics.js');
    const b = ac.body, bv3 = new THREE.Vector3();
    const saveW = b.angularVelocity.clone();
    const zAxis = new THREE.Vector3(0, 0, 1).applyQuaternion(b.quaternion);
    console.log('   —— 当前状态下改变机体滚转率，看气动滚转力矩 ——');
    for (const p of [-0.1, 0, 0.1]) {
      b.angularVelocity.copy(saveW).addScaledVector(zAxis, p / 57.3 * 57.3);
      let mz = 0, my = 0, mx = 0;
      for (const s of ac.surfaces) {
        if (s.detached) continue;
        b.bodyVelocityAt(s.position, bv3);
        solveWing(s, bv3, airDensity(b.position.y), { pitch: 0, roll: 0, yaw: 0, flap: 0, airbrake: 0 }, ac._wingOut);
        const f = ac._wingOut.forceLocal;
        mz += s.position.x * f.y - s.position.y * f.x;
        mx += s.position.y * f.z - s.position.z * f.y;
        my += s.position.z * f.x - s.position.x * f.z;
      }
      console.log(`   Δroll=${p} -> 气动滚转=${mz.toFixed(0)} 俯仰=${mx.toFixed(0)} 偏航=${my.toFixed(0)}`);
    }
    b.angularVelocity.copy(saveW);
  }
  if (ac.destroyed) { console.log('坠毁'); break; }
}