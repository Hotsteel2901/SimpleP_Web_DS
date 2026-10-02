// 重置后起飞追踪：滑跑 → 抬轮 → 离地
import * as THREE from 'three';
import { Game } from '../src/game/game.js';
import { stockCrafts } from '../src/build/crafts.js';
import { getMap } from '../src/world/maps.js';

const canvas = { clientWidth: 1280, clientHeight: 720, addEventListener() { }, style: {} };
const crafts = stockCrafts();
const game = new Game(canvas, { headless: true, quality: 0, shadows: false, enemyCrafts: crafts.slice(1, 3) });
await game.loadWorld(getMap('archipelago'), { quality: 0, onProgress: () => { } });
game.spawnPlayerAircraft(crafts[0], { air: true, height: 400, speed: 120, assist: 0.6 });
game.startMission({ mode: 'free' });
const p = game.player;
const dt = 1 / 60;
// 先撞毁再重置（与 tests/reset-test.mjs 一致）
p.body.position.set(p.body.position.x, (game.terrain.heightAt(p.body.position.x, p.body.position.z) || 0) + 30, p.body.position.z);
p.body.velocity.set(0, -60, 0);
for (let i = 0; i < 90 && !p.destroyed; i++) game.update(dt);
game.resetPlayerToSpawn('main');
console.log('重置后：destroyed=', p.destroyed, 'health=', p.health.toFixed(2), 'AGL=', (p.body.position.y - game.terrain.heightAt(p.body.position.x, p.body.position.z)).toFixed(2), 'trim=', p.pitchTrim.toFixed(2));
p.inputTarget.throttle = 1;
for (let i = 0; i < 60 * 40; i++) {
  if (p.state.speed > 28) { const g = Math.min(1, Math.pow(45 / Math.max(12, p.state.speed), 1.4)); p.inputTarget.pitch = Math.min(1, (12 - p.state.pitch) / 12 * g); }
  game.update(dt);
  if (i % 30 === 0) {
    const eu = new THREE.Euler().setFromQuaternion(p.body.quaternion, 'YXZ');
    console.log(`t=${(i * dt).toFixed(1)} V=${p.state.speed.toFixed(1)} AGL=${p.state.altitudeAGL.toFixed(1)} pitch=${p.state.pitch.toFixed(1)} roll=${p.state.roll.toFixed(1)} in.pitch=${p.inputTarget.pitch.toFixed(2)} ctl.pitch=${p.controls.pitch.toFixed(2)} trim=${p.pitchTrim.toFixed(2)} g=${p.state.gForce.toFixed(2)} G=${p.groundContact ? 'Y' : '.'} hlt=${p.health.toFixed(2)} ${p.destroyed ? 'DESTROYED ' + p.destroyCause : ''}`);
  }
  if (p.destroyed || p.state.altitudeAGL > 40) break;
}