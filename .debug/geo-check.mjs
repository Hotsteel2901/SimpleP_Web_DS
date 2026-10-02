import * as THREE from 'three';
import { wingGeometry, makePart, buildControlSurface } from '../src/build/parts.js';

const span = 7.8, chord = 1.85;
const g = wingGeometry(span, chord, 0.13, 0.82, 0, 3, 0.03);
g.computeBoundingBox();
const bb = g.boundingBox;
console.log('wing bbox min', bb.min.toArray().map(v => +v.toFixed(3)));
console.log('wing bbox max', bb.max.toArray().map(v => +v.toFixed(3)));

const pos = g.attributes.position;
const bins = new Map();
for (let i = 0; i < pos.count; i++) {
  const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
  if (Math.abs(x) < span * 0.48) continue;  // 只有翼尖端盖有顶点（挤出体沿展向无细分）
  const k = Math.round(z * 20) / 20;
  const cur = bins.get(k) || { minY: Infinity, maxY: -Infinity };
  cur.minY = Math.min(cur.minY, y); cur.maxY = Math.max(cur.maxY, y);
  bins.set(k, cur);
}
const rows = [...bins.entries()].sort((a, b) => a[0] - b[0]);
console.log('\nroot section thickness (z, thick):');
for (const [z, v] of rows) console.log(`  z=${z.toFixed(2).padStart(6)}  thick=${(v.maxY - v.minY).toFixed(4)}`);

const tipZ = [], rootZ = [];
for (let i = 0; i < pos.count; i++) {
  const x = pos.getX(i), z = pos.getZ(i);
  if (x > span * 0.48) tipZ.push(z);
  if (Math.abs(x) < span * 0.03) rootZ.push(z);
}
console.log('\ntip z range', Math.min(...tipZ).toFixed(3), Math.max(...tipZ).toFixed(3));
console.log('root z range', Math.min(...rootZ).toFixed(3), Math.max(...rootZ).toFixed(3));

const p = makePart('wing', [0, 0, 0], [0, 0, 0], { size: [span, 0.26, chord], props: { taper: 0.82 } });
const cs = buildControlSurface(p);
if (cs) {
  const inner = cs.children[0];
  console.log('\naileron hinge group.position.z =', cs.position.z.toFixed(3), ' mesh.position.z =', inner.position.z.toFixed(3));
  inner.geometry.computeBoundingBox();
  const cb = inner.geometry.boundingBox;
  console.log('aileron geo z range (rel hinge)', cb.min.z.toFixed(3), cb.max.z.toFixed(3));
  console.log('=> aileron z range (part space)', (cs.position.z + inner.position.z + cb.min.z).toFixed(3), (cs.position.z + inner.position.z + cb.max.z).toFixed(3));
}
console.log('\nwing z range (part space)', bb.min.z.toFixed(3), bb.max.z.toFixed(3), ' [nose = -Z, smaller z = further forward]');