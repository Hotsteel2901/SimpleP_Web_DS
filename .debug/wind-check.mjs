// 风场体检：边界层剖面 / 地形爬坡气流 / 阵风湍流 / 时间变化
import * as THREE from 'three';
import { WindField, windLabel } from '../src/world/wind.js';
import { getMap } from '../src/world/maps.js';

// 造一个孤立山丘地形用于验证爬坡气流
const hill = (x, z) => {
  const d = Math.hypot(x, z);
  return 240 * Math.exp(-(d * d) / (2 * 320 * 320));
};
const terrain = {
  heightAt: (x, z) => hill(x, z),
  normalAt: (x, z, out = new THREE.Vector3()) => {
    const e = 4;
    const dx = (hill(x + e, z) - hill(x - e, z)) / (2 * e);
    const dz = (hill(x, z + e) - hill(x, z - e)) / (2 * e);
    return out.set(-dx, 1, -dz).normalize();
  },
};

const w = new WindField(terrain, { speed: 10, dir: 0, gust: 0.3, turbulence: 0.25, seed: 1 });
const out = new THREE.Vector3();
console.log(`基础风：${w.baseSpeed} m/s，来向 ${(w.baseDir * 57.3).toFixed(0)}°（0=北风，风从 -Z 来）`);
console.log('\n--- 1) 高度剖面（远离山体的平地 x=-1600）---');
for (const h of [0, 5, 20, 60, 120, 300, 1000, 3000]) {
  w.sample(-1600, h, 0, out);
  console.log(`  h=${String(h).padStart(4)}m  风速=${out.length().toFixed(1).padStart(5)} m/s  水平=${Math.hypot(out.x, out.z).toFixed(1).padStart(5)}  垂直=${out.y.toFixed(2).padStart(6)}  风向=${(Math.atan2(-out.x, -out.z) * 57.3).toFixed(0)}°`);
}
console.log('\n--- 2) 地形爬坡气流（10 m/s 北风：从 -Z 来、吹向 +Z，北坡 -Z 侧迎风）---');
for (const [x, z, tag] of [[0, -380, '北坡迎风'], [0, -200, '半山腰'], [0, 0, '山顶'], [0, 300, '南坡背风'], [400, 0, '东侧绕流']]) {
  w.sample(x, hill(x, z) + 30, z, out);
  console.log(`  ${tag.padEnd(6)} (${String(x).padStart(4)},${String(z).padStart(4)}) AGL30m  垂直风=${out.y.toFixed(2).padStart(6)} m/s  水平=${Math.hypot(out.x, out.z).toFixed(1)}`);
}
console.log('\n--- 3) 阵风湍流随时间变化（100m 高度同一点，每 2 秒）---');
let minV = 1e9, maxV = -1e9, sum = 0, n = 0;
for (let t = 0; t < 60; t += 0.1) {
  w.update(0.1);
  w.sample(300, 100, 300, out);
  const v = out.length();
  minV = Math.min(minV, v); maxV = Math.max(maxV, v); sum += v; n++;
  if (Math.abs(t % 10) < 0.05) console.log(`  t=${t.toFixed(0).padStart(3)}s 风速=${v.toFixed(1)} m/s 垂直=${out.y.toFixed(2)}`);
}
console.log(`  60秒统计：平均 ${(sum / n).toFixed(1)} m/s，最小 ${minV.toFixed(1)}，最大 ${maxV.toFixed(1)}（阵风幅度 ${((maxV - minV) / (sum / n) * 100).toFixed(0)}%）`);

console.log('\n--- 4) 各地图风况 ---');
const m = new THREE.Vector3();
for (const id of ['archipelago', 'snowstone', 'naval', 'strata', 'boneyard']) {
  const def = getMap(id);
  if (!def) continue;
  const f = WindField.fromMap(def, null);
  f.sample(0, 300, 0, m);
  console.log(`  ${def.name.padEnd(8)} ${windLabel(f).padEnd(18)} 300m 高空风速=${m.length().toFixed(1)} m/s 湍流=${def.wind?.turbulence ?? '(预设)'}`);
}