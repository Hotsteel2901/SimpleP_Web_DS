import * as THREE from 'three';
import { Aircraft } from '../src/flight/aircraft.js';
import { solveWing, airDensity } from '../src/flight/physics.js';
import { stockCrafts } from '../src/build/crafts.js';

const craft = stockCrafts()[Number(process.argv[2] || 0)];
const ac = new Aircraft(craft, { position: new THREE.Vector3(0, 500, 0), isPlayer: true, assist: 0 });
ac.controls.assist = 0;
ac.placeOnGround({ heightAt: () => 0, isWater: () => false, normalAt: () => new THREE.Vector3(0, 1, 0) }, 0, 0, 0);
ac.inputTarget.throttle = 1;
const env = {
  terrain: { heightAt: () => 0, isWater: () => false, normalAt: () => new THREE.Vector3(0, 1, 0), regionAt: () => null, built: true },
  landmarks: null, gravity: 9.81, wind: new THREE.Vector3(), projectiles: null, onEvent: () => {},
};
const dt = 1 / 120;
const e = new THREE.Euler();
console.log(`${craft.name} 配平=${ac.pitchTrim.toFixed(3)}`);
const step = 24;
for (let i = 1; i <= 120 * 25; i++) {
  ac.controls.assist = 0;
  // 速度超过 0.6*失速速度后开始拉杆（模拟飞行员抬轮）
  if (ac.state.speed > 0.6 * Math.sqrt(2 * ac.body.mass * 9.81 / (1.225 * Math.max(1, ac.surfaces.filter(s => s.isWing).reduce((a, s) => a + s.area, 0)) * 1.2))) {
    ac.inputTarget.pitch = 1;
  }
  ac.update(dt, env);
  if (i % step === 0) {
    const b = ac.body;
    e.setFromQuaternion(b.quaternion, 'YXZ');
    const v = b.velocity.clone().applyQuaternion(b.quaternion.clone().invert());
    const beta = Math.atan2(v.x, -v.z) * 57.3;
    // 各轮的地面法向力/侧向力近似：直接看轮胎接触与压缩
    const gs = ac.gears.map((g) => `${g.part.def.slice(0, 4)}@x${g.position.x.toFixed(1)}z${g.position.z.toFixed(1)} c=${(g.compression * 100).toFixed(0)}%`).join(' ');
    console.log(`t=${(i * dt).toFixed(1)} V=${b.velocity.length().toFixed(1)} hdg=${(-e.y * 57.3).toFixed(1)} roll=${(e.z * 57.3).toFixed(1)} pitch=${(e.x * 57.3).toFixed(1)} β=${beta.toFixed(2)} ωy=${b.angularVelocity.y.toFixed(3)} ωz=${b.angularVelocity.z.toFixed(3)} G=${ac.groundContact ? 'Y' : '.'}`);
    if (i / step % 4 === 0) console.log('    ' + gs);
  }
}