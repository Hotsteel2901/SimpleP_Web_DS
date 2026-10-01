/**
 * 重置（Recover / 回到出生点）回归测试
 * ------------------------------------------------------------------
 * 要求：点重置 = 飞机**完全修复**并回到出生点，无论之前是擦伤、掉件，
 *       还是已经炸成碎片 —— 都能立刻重新起飞，屏幕不再闪损毁红光。
 * 用法： node tests/reset-test.mjs
 */
import * as THREE from 'three';
import { Game } from '../src/game/game.js';
import { stockCrafts } from '../src/build/crafts.js';
import { getMap } from '../src/world/maps.js';

let fails = 0;
const ok = (cond, name, extra = '') => { if (cond) console.log('✅', name, extra); else { fails++; console.log('❌', name, extra); } };

const canvas = { clientWidth: 1280, clientHeight: 720, addEventListener() { }, style: {} };
const crafts = stockCrafts();
const game = new Game(canvas, { headless: true, quality: 0, shadows: false, enemyCrafts: crafts.slice(1, 3) });
await game.loadWorld(getMap('archipelago'), { quality: 0, onProgress: () => { } });
game.spawnPlayerAircraft(crafts[0], { air: true, height: 400, speed: 120, assist: 0.6 });
game.startMission({ mode: 'free' });
const p = game.player;
const dt = 1 / 60;

/* ---------------------------------------------------------------- 1. 撞毁 */
// 给一个极高的垂直速度直接砸地 → 应当整机爆炸
p.body.position.set(p.body.position.x, (game.terrain.heightAt(p.body.position.x, p.body.position.z) || 0) + 30, p.body.position.z);
p.body.velocity.set(0, -60, 0);
for (let i = 0; i < 90 && !p.destroyed; i++) game.update(dt);
ok(p.destroyed === true, '高速撞地后整机损毁', `(cause=${p.destroyCause})`);
ok(p.health < 0.05, '损毁后健康归零', `(health=${p.health.toFixed(3)})`);
ok((p.debris?.length || 0) > 0, '产生了碎片', `(${p.debris?.length} 块)`);
ok(p.group.visible === false, '机体本体已隐藏（只剩碎片）');

const debrisBefore = (p.debris || []).map((d) => d.mesh);
ok(debrisBefore.every((m) => m.parent && m.parent !== p.visual), '碎片已挂到场景根，世界坐标正确');

/* ---------------------------------------------------------------- 2. 重置 = 完整修复 */
game.resetPlayerToSpawn('main');

ok(p.destroyed === false, '重置后不再处于损毁状态');
ok(Math.abs(p.health - 1) < 1e-6, '重置后健康度 = 1（不再闪红光）', `(health=${p.health.toFixed(3)})`);
ok(p.group.visible === true, '机体本体重新显示');
ok((p.debris?.length || 0) === 0, '碎片被清理');
ok(debrisBefore.every((m) => !m.parent || m.parent === p.visual), '所有零件模型都回到机体上');
ok(p.partState.every((ps) => ps.hp === ps.maxHp && !ps.dead), '所有零件满血复活');

// 位置：应当回到出生点附近并且稳稳停在地面上
const sp = game._spawnPoint('main');
const d = Math.hypot(p.body.position.x - sp.position.x, p.body.position.z - sp.position.z);
ok(d < 60, '位置回到出生点', `(偏差 ${d.toFixed(1)} m)`);
const agl = p.body.position.y - game.terrain.heightAt(p.body.position.x, p.body.position.z);
ok(agl > 0.2 && agl < 8, '停在跑道地面上（不是穿地也不是悬空）', `(AGL ${agl.toFixed(2)} m)`);
ok(Math.abs(p.body.velocity.length()) < 6, '速度归零', `(${p.body.velocity.length().toFixed(2)} m/s)`);

// 子系统：动力/武器/燃油/起落架 全部恢复
ok(p.engines.length === crafts[0].parts.filter((x) => x.def.startsWith('engine')).length, '发动机全部回来了', `(${p.engines.length} 台)`);
ok(p.engines.every((e) => e.health01 === 1), '发动机健康恢复');
ok(p.gears.length > 0, '起落架恢复', `(${p.gears.length} 个接触点)`);
ok(p.fuel >= p.fuelCapacity * 0.99, '燃油加满', `(${p.fuel.toFixed(0)} L)`);
ok(Math.abs(p.body.mass - p.dryMass) < p.fuelCapacity * 0.85 + 5, '质量恢复（含满油）', `(${p.body.mass.toFixed(0)} kg)`);

/* ---------------------------------------------------------------- 3. 重置后能正常起飞 */
p.inputTarget.throttle = 1;
let tookOff = false;
for (let i = 0; i < 60 * 40; i++) {
  if (p.state.speed > 28) { const g = Math.min(1, Math.pow(45 / Math.max(12, p.state.speed), 1.4)); p.inputTarget.pitch = Math.min(1, (12 - p.state.pitch) / 12 * g); }
  game.update(dt);
  if (p.state.altitudeAGL > 40) { tookOff = true; break; }
}
ok(tookOff, '重置后能重新起飞', `(高度 ${p.state.altitudeAGL.toFixed(0)} m, 速度 ${p.state.speed.toFixed(0)} m/s)`);
ok(p.health > 0.9, '重新起飞过程没有异常掉血', `(health=${p.health.toFixed(3)})`);

/* ---------------------------------------------------------------- 4. 空中重置 */
p.body.position.set(0, 1200, 0);
p.body.velocity.set(0, -40, -80);
game.update(dt);
game.resetPlayerToSpawn('main');
ok(p.health === 1 && !p.destroyed, '空中重置同样完整修复');
const agl2 = p.body.position.y - game.terrain.heightAt(p.body.position.x, p.body.position.z);
ok(agl2 > 0.2 && agl2 < 8, '空中重置后落回跑道', `(AGL ${agl2.toFixed(2)} m)`);

game.dispose();
console.log(fails ? `\n❌ ${fails} 项失败` : '\n✅ 重置/修复全部通过');
process.exit(fails ? 1 : 0);
