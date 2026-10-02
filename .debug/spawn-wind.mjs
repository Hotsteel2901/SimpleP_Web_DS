// 出生点（机场）附近的风场采样，确认跑道附近风况合理
import * as THREE from 'three';
import { Game } from '../src/game/game.js';
import { getMap } from '../src/world/maps.js';

const canvas = { clientWidth: 1280, clientHeight: 720, addEventListener() { }, style: {} };
const game = new Game(canvas, { headless: true, quality: 0, shadows: false });
await game.loadWorld(getMap('archipelago'), { quality: 0, onProgress: () => { } });
const sp = game._spawnPoint('main');
const gy = game.terrain.heightAt(sp.position.x, sp.position.z);
console.log(`出生点 ${sp.name} (${sp.position.x.toFixed(0)},${sp.position.z.toFixed(0)}) 地面高度=${gy.toFixed(1)} heading=${(sp.heading || 0).toFixed(2)}`);
const out = new THREE.Vector3();
for (const dt of [0, 1, 2]) {
  if (dt) game.update(dt);
  console.log(`t=${dt}s:`);
  for (const [dx, dz, tag] of [[0, 0, '跑道中心'], [150, 0, '东150m'], [-150, 0, '西150m'], [0, 200, '南200m'], [0, -200, '北200m']]) {
    game.windField.sample(sp.position.x + dx, gy + 2, sp.position.z + dz, out);
    game.windField.sample(sp.position.x + dx, gy + 120, sp.position.z + dz, out);
    const wind120 = out.clone();
    game.windField.sample(sp.position.x + dx, gy + 2, sp.position.z + dz, out);
    const n = game.terrain.normalAt(sp.position.x + dx, sp.position.z + dz, new THREE.Vector3());
    console.log(`  ${tag.padEnd(8)} 地面风=(${out.x.toFixed(1)},${out.y.toFixed(1)},${out.z.toFixed(1)}) |${out.length().toFixed(1)}|  120m风=(${wind120.x.toFixed(1)},${wind120.y.toFixed(1)},${wind120.z.toFixed(1)}) |${wind120.length().toFixed(1)}|  地形法线=(${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)})`);
  }
}