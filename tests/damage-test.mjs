/**
 * 逐零件损毁模型测试（对齐原版：轻擦掉血、重撞断件、关键件没了就炸）
 * 用法： node tests/damage-test.mjs
 */
import * as THREE from 'three';
import { Aircraft, computeCraftStats } from '../src/flight/aircraft.js';
import { stockCrafts } from '../src/build/crafts.js';

const flat = (y = 0) => ({
  heightAt: () => y, isWater: () => false, normalAt: () => new THREE.Vector3(0, 1, 0), regionAt: () => null, built: true,
});
let fails = 0;
const ok = (cond, name, extra = '') => { if (cond) console.log('✅', name, extra); else { fails++; console.log('❌', name, extra); } };

const craft = stockCrafts()[0];   // Sky Trainer
const stats = computeCraftStats(craft);

function mk(y = 0) {
  const ac = new Aircraft(craft, { position: new THREE.Vector3(0, 500, 0), assist: 0 });
  ac.placeOnGround(flat(0), 0, 0, 0);
  return ac;
}

/* ---------------------------------------------------------------- 1. 血量表 */
{
  const ac = mk();
  ok(ac.partState.length === craft.parts.length, '每个零件都有独立血量', `(${ac.partState.length} 个)`);
  ok(ac.partState.every((p) => p.maxHp > 5 && p.hp === p.maxHp), '零件初始满血（小零件血量低但存在）');
  ok(ac.partState.some((p) => p.critical), '存在关键零件（座舱/座椅）');
  const total = ac.partState.reduce((a, p) => a + p.hp * p.mass, 0);
  ok(Math.abs(ac.health - 1) < 1e-6, '初始全局健康 = 1');
}

/* ---------------------------------------------------------------- 2. 正常着陆不掉血 */
{
  const ac = mk();
  for (const ps of ac.partState) ps.hp = ps.maxHp;
  ac.body.velocity.set(0, -2.0, -30);        // 2 m/s 下降率，正常着陆
  for (let i = 0; i < 120; i++) ac.update(1 / 120, { terrain: flat(0), landmarks: null, gravity: 9.81, wind: new THREE.Vector3(), projectiles: null });
  ok(ac.health > 0.97, '正常着陆几乎不掉血', `(health=${ac.health.toFixed(3)})`);
  ok(ac.partState.every((p) => !p.dead), '正常着陆没有零件脱落');
}

/* ---------------------------------------------------------------- 3. 轻擦：只有被撞的零件掉血 */
{
  const ac = mk();
  const before = ac.partState.map((p) => p.hp);
  const nose = new THREE.Vector3(0, ac.body.position.y - 1.2, 0).add(new THREE.Vector3(0, 0, -3)); // 机头下方
  ac.applyImpact(6, nose, 'ground');          // 6 m/s 侧向擦地
  const after = ac.partState.map((p) => p.hp);
  const hurt = after.filter((h, i) => h < before[i] - 1e-6).length;
  ok(hurt > 0 && hurt <= 6, '轻擦只让撞击点附近少数零件掉血', `(${hurt} 个零件)`);
  ok(!ac.destroyed, '轻擦不会直接炸掉');
  ok(ac.health < 1 && ac.health > 0.55, '轻擦后整体健康下降但不致命', `(health=${ac.health.toFixed(3)})`);
}

/* ---------------------------------------------------------------- 4. 重撞：断零件 */
{
  const ac = mk();
  const events = [];
  ac.onEvent = (t, d) => events.push(t);
  const p = new THREE.Vector3(0, ac.body.position.y, -3);
  ac.applyImpact(26, p, 'ground');            // 26 m/s 砸地
  ok(ac.health < 0.95, '重撞显著掉血', `(health=${ac.health.toFixed(3)})`);
  const dead = ac.partState.filter((x) => x.dead).length;
  ok(dead > 0, '重撞导致零件损毁', `(${dead} 个)`);
  ac.applyPendingDetach();
  ok(events.includes('partLost') || ac.destroyed, '重撞触发了零件脱落或整机损毁', `(事件: ${[...new Set(events)].join(',')})`);
  ok(ac.partState.filter((x) => x.dead).every((x) => !ac.partMeshes.get(x.uid)?.parent), '损毁零件的模型已从飞机上移除');
}

/* ---------------------------------------------------------------- 5. 部位判定：打机翼不掉尾翼 */
{
  const ac = mk();
  const wing = ac.partState.find((p) => p.defId === 'wing');
  const tail = ac.partState.find((p) => p.defId === 'tailplane' || p.defId === 'fin');
  const wp = wing.local.clone().applyQuaternion(ac.body.quaternion).add(ac.body.position);
  const wingHp0 = wing.hp, tailHp0 = tail.hp;
  for (let i = 0; i < 8; i++) ac.applyDamage(30, wp, 'bullet');
  ok(wing.hp < wingHp0, '命中的机翼掉血', `(${wingHp0.toFixed(0)} → ${wing.hp.toFixed(0)})`);
  ok(tail.hp >= tailHp0 - 1e-6, '未命中的尾翼不掉血');
}

/* ---------------------------------------------------------------- 6. 关键件损毁 = 整机损毁 */
{
  const ac = mk();
  const ck = ac.partState.find((p) => p.critical);
  const wp = ck.local.clone().applyQuaternion(ac.body.quaternion).add(ac.body.position);
  ac.applyDamage(ck.maxHp + 50, wp, 'missile');
  ok(ac.destroyed === true, '座舱被打掉 → 整机损毁', `(cause=${ac.destroyCause})`);
}

/* ---------------------------------------------------------------- 7. 单次巨力直接炸 */
{
  const ac = mk();
  ac.applyImpact(45, ac.body.position.clone(), 'ground');
  ok(ac.destroyed === true, '45 m/s 高速撞地直接爆炸');
}

/* ---------------------------------------------------------------- 8. 零件脱落的连带后果 */
{
  const ac = mk();
  const eng = ac.partState.find((p) => p.def.engine);
  ok(!!eng, '教练机有发动机零件');
  const massBefore = ac.body.mass;
  ac.detachPart(eng.uid);
  ok(ac.body.mass < massBefore, '掉了零件质量减少', `(${massBefore.toFixed(0)} → ${ac.body.mass.toFixed(0)} kg)`);
  const e = ac.engines.find((x) => x.part.uid === eng.uid);
  ok(!e || e.health01 === 0, '掉了发动机 → 该发动机失效');
}

/* ---------------------------------------------------------------- 9. reset 恢复 */
{
  const ac = mk();
  ac.applyImpact(30, ac.body.position.clone(), 'ground');
  ac.applyPendingDetach();
  ok(ac.health < 1, '撞过之后健康下降');
  const sp = ac.computeStaticPose();
  ac.reset(new THREE.Vector3(0, 400, 0), 0, 0);
  ok(ac.health === 1 && !ac.destroyed, 'reset 后恢复满血');
  ok(ac.partState.every((p) => p.hp === p.maxHp && !p.dead), 'reset 后所有零件满血且回来了');
}

/* ---------------------------------------------------------------- 10. 地面滑行不持续掉血 */
{
  const ac = mk();
  ac.inputTarget.throttle = 1;
  for (let i = 0; i < 120 * 12; i++) ac.update(1 / 120, { terrain: flat(0), landmarks: null, gravity: 9.81, wind: new THREE.Vector3(), projectiles: null });
  ok(ac.health > 0.9, '跑道滑行 12 秒几乎不掉血', `(health=${ac.health.toFixed(3)}, 速度=${ac.state.speed.toFixed(1)}m/s)`);
}

console.log(fails ? `\n❌ ${fails} 项失败` : '\n✅ 损毁模型全部通过');
process.exit(fails ? 1 : 0);
