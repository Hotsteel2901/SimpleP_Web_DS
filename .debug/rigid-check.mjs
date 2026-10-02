import * as THREE from 'three';
import { RigidBody } from '../src/flight/physics.js';

const rb = new RigidBody({ mass: 1000 });
rb.angularVelocity.set(0, 0, 1);   // 绕 +Z 滚转（右翼应向上）
const out = new THREE.Vector3();
for (const p of [[1, 0, 0], [-1, 0, 0]]) {
  rb.bodyVelocityAt(new THREE.Vector3(...p), out);
  console.log(`r=(${p}) ω=(0,0,1) -> v=(${out.x.toFixed(2)}, ${out.y.toFixed(2)}, ${out.z.toFixed(2)})`);
}
rb.angularVelocity.set(0, 1, 0);
rb.bodyVelocityAt(new THREE.Vector3(0, 0, -1), out);
console.log(`机头 r=(0,0,-1) ω=(0,1,0) -> v=(${out.x.toFixed(2)}, ${out.y.toFixed(2)}, ${out.z.toFixed(2)})  (偏航右应为 +X?)`);