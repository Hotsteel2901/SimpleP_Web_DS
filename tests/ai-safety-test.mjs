/**
 * AI 地形预判回归：面对前方山脊时必须在脚下仍有充足高度时提前拉起。
 * 用法：node tests/ai-safety-test.mjs
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Aircraft } from '../src/flight/aircraft.js';
import { AIPilot } from '../src/flight/ai.js';
import { stockCrafts } from '../src/build/crafts.js';

const craft = stockCrafts().find((c) => c.name === 'Sky Trainer') || stockCrafts()[0];

function makeAircraft() {
  const ac = new Aircraft(craft, {
    position: new THREE.Vector3(0, 500, 0), heading: 0, isPlayer: true, assist: 0.5,
  });
  // heading=0 时机头为 -Z；以约 120m/s 朝前方山脊飞行。
  ac.body.velocity.set(0, -5, -120);
  return ac;
}

// 前方约 350m 开始急剧上升的山脊。当前 AGL=500m，旧实现只检查脚下，
// 不会触发保护；新实现用速度方向上的预测高度提前拉起。
const ridgeTerrain = {
  heightAt(x, z) {
    if (z >= -280) return 0;
    return Math.min(490, (Math.abs(z) - 280) * 2.1);
  },
};

{
  const ac = makeAircraft();
  const ai = new AIPilot(ac, {
    skill: 0.75, behavior: 'patrol', waypoints: [new THREE.Vector3(0, 500, -2200)],
  });
  ai.update(1 / 60, { terrain: ridgeTerrain, landmarks: null, aircraft: [ac] });
  assert.equal(ai.state, 'pullup', '前方山脊应触发地形规避状态');
  assert.ok(ac.inputTarget.pitch > 0.9, `应全力拉起，实际 pitch=${ac.inputTarget.pitch.toFixed(2)}`);
  assert.equal(ac.inputTarget.throttle, 1, '地形规避时应使用全油门');
}

{
  const ac = makeAircraft();
  const ai = new AIPilot(ac, {
    skill: 0.75, behavior: 'patrol', waypoints: [new THREE.Vector3(0, 500, -2200)],
  });
  ai.update(1 / 60, { terrain: { heightAt: () => 0 }, landmarks: null, aircraft: [ac] });
  assert.notEqual(ai.state, 'pullup', '平坦且安全的航路不应误触发地形规避');
  assert.ok(ac.inputTarget.pitch < 0.9, '平坦航路不应强制满拉杆');
}

console.log('AI 地形预判回归：通过');
