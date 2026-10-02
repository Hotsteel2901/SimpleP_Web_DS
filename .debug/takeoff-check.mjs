// 玩家视角起飞模拟：assist=0.5（默认设置）+ 简易飞行员，检查 8 架飞机能否正常起飞并爬升
import * as THREE from 'three';
import { Aircraft } from '../src/flight/aircraft.js';
import { stockCrafts } from '../src/build/crafts.js';

const flat = {
  heightAt: () => 0, isWater: () => false, normalAt: () => new THREE.Vector3(0, 1, 0), regionAt: () => null, built: true,
};
const env = () => ({
  terrain: flat, landmarks: null, gravity: 9.81, wind: new THREE.Vector3(), projectiles: null, onEvent: () => {},
});
const dt = 1 / 120;

for (const craft of stockCrafts()) {
  if (craft.type !== 'plane') continue;
  const ac = new Aircraft(craft, { position: new THREE.Vector3(0, 500, 0), isPlayer: true, assist: 0.5 });
  ac.placeOnGround(flat, 0, 0, 0);
  ac.inputTarget.throttle = 1;
  const e = env();
  const vs = Math.sqrt(2 * ac.body.mass * 9.81 / (1.225 * Math.max(1, ac.surfaces.filter(s => s.isWing).reduce((a, s) => a + s.area, 0)) * 1.2));
  const rotSpd = Math.max(18, vs * 1.12);
  let maxY = 0, t0 = 0;
  for (let i = 0; i < 120 * 60; i++) {
    // 简易飞行员：抬轮后保持 10° 俯仰
    if (ac.state.speed > rotSpd) {
      const err = (10 - ac.state.pitch) / 12;
      ac.inputTarget.pitch = Math.max(-1, Math.min(1, err * 1.4));
    }
    ac.inputTarget.roll = 0;
    ac.update(dt, e);
    maxY = Math.max(maxY, ac.body.position.y);
    if (ac.body.position.y > 100) { t0 = i * dt; break; }
    if (ac.destroyed) break;
  }
  const s = ac.state;
  console.log(`${craft.name.padEnd(14)} 失速${vs.toFixed(0)}m/s 抬轮${rotSpd.toFixed(0)}m/s 配平(${ac.pitchTrim.toFixed(2)},${(ac.yawTrim || 0).toFixed(2)}) 结果=${ac.destroyed ? '坠毁' : (ac.body.position.y > 100 ? `爬升到100m用时${t0.toFixed(1)}s` : `最高${maxY.toFixed(1)}m (末速${s.speed.toFixed(0)})`)} 滚转${s.roll.toFixed(0)}° 健康${(s.health01 * 100).toFixed(0)}%`);
}