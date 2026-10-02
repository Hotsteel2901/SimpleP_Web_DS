import * as THREE from 'three';
import { Aircraft } from '../src/flight/aircraft.js';
import { solveWing, airDensity } from '../src/flight/physics.js';
import { stockCrafts } from '../src/build/crafts.js';

const craft = stockCrafts()[Number(process.argv[2] || 0)];
const ac = new Aircraft(craft, { position: new THREE.Vector3(0, 300, 0), isPlayer: true, assist: 0 });
ac.controls.assist = 0;
ac.inputTarget.throttle = 0.6;
ac.body.velocity.set(0, 0, -60);
const env = {
  terrain: { heightAt: () => 0, isWater: () => false, normalAt: () => new THREE.Vector3(0, 1, 0), regionAt: () => null, built: true },
  landmarks: null, gravity: 9.81, wind: new THREE.Vector3(), projectiles: null, onEvent: () => {},
};
console.log(`${craft.name}: mass=${ac.body.mass.toFixed(0)}kg COM.z=${ac.stats.com.z.toFixed(2)} 配平=${ac.pitchTrim.toFixed(3)} I=(${ac.body.inertia.x.toFixed(0)},${ac.body.inertia.y.toFixed(0)},${ac.body.inertia.z.toFixed(0)})`);

const out = { forceLocal: new THREE.Vector3(), alpha: 0, cl: 0, cd: 0, stall: false, q: 0 };
const bv = new THREE.Vector3();
function diagnose(tag) {
  const body = ac.body;
  const density = airDensity(body.position.y);
  const ctl = { pitch: 0, roll: 0, yaw: 0, flap: 0, airbrake: 0 };
  let mx = 0, my = 0, mz = 0, ly = 0;
  for (const s of ac.surfaces) {
    if (s.detached) continue;
    body.bodyVelocityAt(s.position, bv);
    const res = solveWing(s, bv, density, ctl, out);
    const f = res.forceLocal;
    mx += s.position.y * f.z - s.position.z * f.y;
    my += s.position.z * f.x - s.position.x * f.z;
    mz += s.position.x * f.y - s.position.y * f.x;
    ly += f.y;
  }
  const e = new THREE.Euler().setFromQuaternion(body.quaternion, 'YXZ');
  const vLocal = body.worldToBody(body.velocity, new THREE.Vector3());
  const beta = Math.atan2(vLocal.x, -vLocal.z) * 57.3;
  const wLocal = body.angularVelocity.clone().applyQuaternion(body.quaternion.clone().invert());
  console.log(`${tag}: y=${body.position.y.toFixed(0)} V=${body.velocity.length().toFixed(1)} pitch=${(e.x * 57.3).toFixed(1)} roll=${(e.z * 57.3).toFixed(1)} β=${beta.toFixed(2)}° | 气动力矩(机体系) 俯仰=${mx.toFixed(0)} 偏航=${my.toFixed(0)} 滚转=${mz.toFixed(0)} | ω=(${wLocal.x.toFixed(3)},${wLocal.y.toFixed(3)},${wLocal.z.toFixed(3)}) 升力=${ly.toFixed(0)}`);
}

const dt = 1 / 120;
const marks = [0, 0.5, 1, 2, 5, 10, 20];
let mi = 0;
diagnose('t=0');
for (let i = 1; i <= 120 * 20; i++) {
  ac.controls.assist = 0;
  ac.update(dt, env);
  const t = i * dt;
  if (mi < marks.length && t >= marks[mi]) { diagnose(`t=${marks[mi]}s`); mi++; }
}
// 滚转阻尼测试：给定机体滚转率，看气动滚转力矩是否反向（干净姿态：水平 + 正对气流）
const saveQ = ac.body.quaternion.clone(), saveW = ac.body.angularVelocity.clone(), saveV = ac.body.velocity.clone();
ac.body.quaternion.identity();
ac.body.velocity.set(0, 0, -60);
for (const p of [-1, 0, 1]) {
  ac.body.angularVelocity.set(0, 0, p);
  const density = airDensity(ac.body.position.y);
  const ctl = { pitch: 0, roll: 0, yaw: 0, flap: 0, airbrake: 0 };
  let mz = 0;
  const detail = [];
  for (const s of ac.surfaces) {
    if (s.detached) continue;
    ac.body.bodyVelocityAt(s.position, bv);
    const res = solveWing(s, bv, density, ctl, out);
    const f = res.forceLocal;
    const tz = s.position.x * f.y - s.position.y * f.x;
    mz += tz;
    detail.push(`${s.part.def}${s.isAileron ? '*' : ''}@${s.position.x.toFixed(1)} CL=${res.cl.toFixed(3)} Mz=${tz.toFixed(0)}`);
  }
  console.log(`  滚转率 p=${p} -> 总滚转力矩=${mz.toFixed(0)} N·m (期望 p>0 时为负)`);
  if (p === 1) console.log('     ' + detail.join('\n     '));
}
ac.body.quaternion.copy(saveQ); ac.body.angularVelocity.copy(saveW); ac.body.velocity.copy(saveV);
// 侧滑稳定性：给定 β，看滚转/偏航力矩
for (const beta of [-0.1, 0.1]) {
  ac.body.quaternion.identity();
  ac.body.velocity.set(Math.sin(beta) * 60, 0, -Math.cos(beta) * 60);
  const density = airDensity(ac.body.position.y);
  const ctl = { pitch: 0, roll: 0, yaw: 0, flap: 0, airbrake: 0 };
  let mz = 0, my = 0;
  for (const s of ac.surfaces) {
    if (s.detached) continue;
    ac.body.bodyVelocityAt(s.position, bv);
    const res = solveWing(s, bv, density, ctl, out);
    const f = res.forceLocal;
    mz += s.position.x * f.y - s.position.y * f.x;
    my += s.position.z * f.x - s.position.x * f.z;
  }
  console.log(`  β=${(beta * 57.3).toFixed(1)}° -> 滚转力矩=${mz.toFixed(0)} (期望与 β 反号)  偏航力矩=${my.toFixed(0)} (期望与 β 同号=风标稳定)`);
}
ac.body.quaternion.copy(saveQ); ac.body.velocity.copy(saveV);