/**
 * 无头全流程测试：真实地形/地标/AI/武器/任务，模拟 60 秒飞行。
 * 用法： node tests/headless.mjs [mapId] [mode]
 */
import * as THREE from 'three';
import { Game } from '../src/game/game.js';
import { stockCrafts } from '../src/build/crafts.js';
import { getMap } from '../src/world/maps.js';
import { AIPilot } from '../src/flight/ai.js';

const mapId = process.argv[2] || 'archipelago';
const mode = process.argv[3] || 'free';
const map = getMap(mapId);
const crafts = stockCrafts();

const canvas = { clientWidth: 1280, clientHeight: 720, addEventListener() { }, style: {} };
const game = new Game(canvas, { headless: true, quality: 0, shadows: false, enemyCrafts: crafts.filter((c) => ['Simple Jet', 'Warhound'].includes(c.name)) });

let errors = 0;
const t0 = Date.now();
await game.loadWorld(map, { quality: 0, onProgress: () => { } });
console.log(`世界加载完成 ${((Date.now() - t0) / 1000).toFixed(1)}s  碰撞体=${game.landmarks.colliders.length} 光环=${game.landmarks.raceRings.length} 收集物=${game.landmarks.collectibles.length}`);

const craft = crafts.find((c) => c.name === (mode === 'combat' ? 'Warhound' : 'Sky Trainer')) || crafts[0];
game.spawnPlayerAircraft(craft, { air: mode === 'race' || mode === 'combat', height: 500, speed: 140, assist: 0.5 });
const missionDef = map.missions.find((m) => m.mode === mode) || { mode };
game.startMission(missionDef);
console.log(`任务：${game.mission.name} — ${game.mission.objective}`);

const dt = 1 / 60;
const steps = 60 * 60;
const p = game.player;
// 用真实 AI 驾驶玩家飞机来跑任务（同时验证 AI 模块）
let pilot = null;
if (p) {
  pilot = new AIPilot(p, { skill: 0.75, behavior: 'patrol', cruiseAlt: 320 });
  p.pilot = null; // 玩家的输入由测试接管
  if (mode === 'race') pilot.setWaypoints(game.mission.rings.map((r) => r.position));
  else if (mode === 'combat') { pilot.behavior = 'dogfight'; }
  else if (mode === 'strike' || mode === 'missile') { pilot.behavior = 'groundAttack'; pilot.targetPoint = game.mission.tracked?.[0]?.center; }
  else {
    const sp = game._spawnPoint('main');
    pilot.setWaypoints([
      new THREE.Vector3(sp.position.x + 1800, 320, sp.position.z + 900),
      new THREE.Vector3(sp.position.x + 900, 420, sp.position.z - 1500),
      new THREE.Vector3(sp.position.x - 1400, 360, sp.position.z - 600),
      new THREE.Vector3(sp.position.x - 800, 300, sp.position.z + 1600),
    ]);
  }
  // 先滑跑起飞
  for (let i = 0; i < 60 * 22 && p.state.altitudeAGL < 60; i++) {
    p.inputTarget.throttle = 1;
    if (p.state.speed > 28) { const gain = Math.min(1, Math.pow(45 / Math.max(12, p.state.speed), 1.4)); p.inputTarget.pitch = Math.min(1, (12 - p.state.pitch) / 12 * gain); }
    game.update(dt);
  }
  console.log(`起飞完成：高度=${p.state.altitudeAGL.toFixed(0)}m 速度=${p.state.speed.toFixed(0)}m/s`);
}
for (let i = 0; i < steps; i++) {
  try {
    if (p && !p.destroyed && pilot) {
      if (mode === 'race') {
        const next = game.mission.rings?.[game.mission.next];
        if (next) pilot.setWaypoints([next.position]);
      } else if (mode === 'combat') {
        const foe = game.aircraft.find((a) => a.team === 1 && !a.destroyed);
        if (foe) { pilot.behavior = 'dogfight'; pilot.setTarget(foe); }
        else pilot.behavior = 'patrol';
      } else if (mode === 'strike' || mode === 'missile') {
        const t = game.mission.tracked?.find((c) => !c.destroyed);
        if (t) { pilot.behavior = 'groundAttack'; pilot.targetPoint = t.center; }
      }
      pilot.update(dt, { terrain: game.terrain, landmarks: game.landmarks, aircraft: game.aircraft });
      p.controls.fire1 = true;
    }
    game.update(dt);
    // 无头场景用 AI 接管玩家，飞行生存是有效性的一部分；过去这里只检查
    // JS 异常，因而“已坠毁但没有抛错”的空战回归会被误判为通过。
    if (p?.destroyed) {
      errors++;
      console.log(`❌ 玩家飞机坠毁 @ ${(i * dt).toFixed(1)}s（${p.destroyCause || 'unknown'}）`);
      break;
    }
    if (i % (60 * 15) === 0) {
      const s = p?.state;
      console.log(`  t=${(i * dt).toFixed(0)}s 高度=${s ? s.altitudeAGL.toFixed(0) : '--'}m 速度=${s ? s.speed.toFixed(0) : '--'}m/s 健康=${s ? s.health01.toFixed(2) : '--'} 弹药事件=${game.projectiles.count} 任务进度=${game.mission.progress.current}/${game.mission.progress.total}${game.mission.finished ? ' [已结束:' + (game.mission.success ? '成功' : '失败') + ']' : ''}`);
    }
    if (Number.isNaN(game.camera.position.x)) throw new Error('相机 NaN');
  } catch (e) {
    errors++;
    console.log('❌ 帧异常 @', (i * dt).toFixed(1), 's:', e.message);
    console.log(e.stack.split('\n').slice(1, 4).join('\n'));
    if (errors > 3) break;
  }
}
console.log(`\n结果：${errors === 0 ? '✅ 60 秒无异常' : '❌ ' + errors + ' 次异常'}  飞机数=${game.aircraft.length} 弹丸=${game.projectiles.count}`);
game.dispose();
process.exit(errors ? 1 : 0);
