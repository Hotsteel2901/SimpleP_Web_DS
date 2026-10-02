// 阻尼验证：给一个俯仰扰动，看角速度包络衰减
import * as THREE from 'three';
import { Aircraft } from '../src/flight/aircraft.js';
import { stockCrafts } from '../src/build/crafts.js';

const flat = { heightAt: () => 0, isWater: () => false, normalAt: () => new THREE.Vector3(0, 1, 0), regionAt: () => null, built: true };
const env = () => ({ terrain: flat, landmarks: null, gravity: 9.81, wind: new THREE.Vector3(), projectiles: null, onEvent: () => {} });
const dt = 1 / 120;
const inv = new THREE.Quaternion();

for (const craft of stockCrafts()) {
  if (craft.type !== 'plane') continue;
  const ac = new Aircraft(craft, { position: new THREE.Vector3(0, 800, 0), isPlayer: true, assist: 0 });
  ac.body.velocity.set(0, 0, -60);
  ac.inputTarget.throttle = 0.75;
  const e = env();
  for (let i = 0; i < 120 * 3; i++) ac.update(dt, e);
  ac.body.angularVelocity.set(0.5, 0, 0).applyQuaternion(ac.body.quaternion);
  const trace = [];
  for (let s = 0; s < 8; s++) {
    let peak = 0;
    for (let i = 0; i < 120; i++) {
      ac.update(dt, e);
      const w = ac.body.angularVelocity.clone().applyQuaternion(inv.copy(ac.body.quaternion).invert());
      peak = Math.max(peak, Math.abs(w.x));
    }
    trace.push(peak);
  }
  const decay = trace[0] > 0.01 ? trace[2] / trace[0] : 0;
  console.log(`${craft.name.padEnd(13)} ωx峰值(每秒)=${trace.map((v) => v.toFixed(2)).join(' ')}  2s衰减=${(decay * 100).toFixed(0)}% ${decay < 0.45 ? '✅' : '⚠️'}`);
}