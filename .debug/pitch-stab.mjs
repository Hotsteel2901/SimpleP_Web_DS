// 俯仰静稳定性：扫迎角看俯仰力矩斜率（>0 = 不稳定）+ 估中性点/静稳定余度
import * as THREE from 'three';
import { Aircraft } from '../src/flight/aircraft.js';
import { solveWing } from '../src/flight/physics.js';
import { stockCrafts } from '../src/build/crafts.js';

const out = { forceLocal: new THREE.Vector3(), alpha: 0, cl: 0, cd: 0, stall: false, q: 0 };
const bv = new THREE.Vector3();
const V = 60, rho = 1.225;

for (const craft of stockCrafts()) {
  if (craft.type !== 'plane') continue;
  const ac = new Aircraft(craft, { position: new THREE.Vector3(0, 300, 0), isPlayer: true, assist: 0 });
  const body = ac.body;
  const ctl = { pitch: ac.pitchTrim, roll: ac.rollTrim || 0, yaw: ac.yawTrim || 0, flap: 0, airbrake: 0 };

  const probe = (alpha, c) => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(alpha, 0, 0, 'YXZ'));
    body.quaternion.copy(q);
    body.velocity.set(0, -Math.sin(alpha) * V, -Math.cos(alpha) * V);
    let mx = 0, my = 0, mz = 0, ly = 0;
    let clS = 0, aS = 0;
    for (const s of ac.surfaces) { if (!s.isWing) continue; body.bodyVelocityAt(s.position, bv); const r = solveWing(s, bv, rho, c, out); clS += r.cl * s.area; aS += s.area; }
    const dw = -Math.max(-1.4, Math.min(1.4, aS ? clS / aS : 0)) * 0.11;
    for (const s of ac.surfaces) {
      if (s.detached) continue;
      s.alphaOffset = (s.isWing || s.isAileron) ? 0 : (s.position.z >= ac.wingACz ? dw : -dw * 0.5) + (s.incidence || 0);
      body.bodyVelocityAt(s.position, bv);
      const r = solveWing(s, bv, rho, c, out);
      const f = r.forceLocal;
      mx += s.position.y * f.z - s.position.z * f.y;
      my += s.position.z * f.x - s.position.x * f.z;
      mz += s.position.x * f.y - s.position.y * f.x;
      ly += f.y;
    }
    return { mx, my, mz, ly };
  };

  const a0 = -0.05, a1 = 0.1;
  const m0 = probe(a0, ctl), m1 = probe(a1, ctl);
  const dMda = (m1.mx - m0.mx) / (a1 - a0);
  const dLda = (m1.ly - m0.ly) / (a1 - a0);
  const W = body.mass * 9.81;
  // 升力≈重力的迎角
  let aEq = 0, ly = 0;
  for (let i = 0; i < 24; i++) { const r = probe(aEq, ctl); ly = r.ly; aEq += (W - r.ly) / Math.max(1, dLda) * 0.6; aEq = Math.max(-0.3, Math.min(0.3, aEq)); }
  const eq = probe(aEq, ctl);
  // MAC 与中性点
  let sw = 0, swx = 0, mac = 0;
  for (const s of ac.surfaces) if (s.isWing) { sw += s.area; swx += s.area * s.position.z; mac += s.area * s.chord; }
  mac = sw > 0 ? mac / sw : 1;
  const xNP = sw > 0 ? swx / sw : 0;
  console.log(`${craft.name.padEnd(13)} ∂M/∂α=${dMda.toFixed(0)} N·m/rad ${dMda > 0 ? '❌不稳定' : '✅稳定'} | 平衡α=${(aEq * 57.3).toFixed(1)}° 残差τ=${eq.mx.toFixed(0)} 升力${eq.ly.toFixed(0)}/${W.toFixed(0)} | 主翼AC(相对重心)z=${xNP.toFixed(2)} 弦长${mac.toFixed(2)} | 静稳定余度≈${(-dMda / Math.max(1, dLda)).toFixed(2)}m = ${(-dMda / Math.max(1, dLda) / mac * 100).toFixed(0)}%MAC`);
}