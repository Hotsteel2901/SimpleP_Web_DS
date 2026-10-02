/**
 * 命令行物理测试：验证气动、起飞、操纵响应。
 * 运行： node tests/flight-test.mjs [craftIndex]
 */
import * as THREE from 'three';
import { Aircraft, computeCraftStats } from '../src/flight/aircraft.js';
import { stockCrafts } from '../src/build/crafts.js';

const craftArg = process.argv[2];
const crafts = stockCrafts();
const idx = craftArg != null && craftArg !== '' ? Number(craftArg) : 0;

function flatTerrain(y = 0) {
  return {
    heightAt: () => y,
    isWater: () => false,
    normalAt: () => new THREE.Vector3(0, 1, 0),
    regionAt: () => null,
    built: true,
  };
}
const env = () => ({
  terrain: flatTerrain(0),
  landmarks: null,
  gravity: 9.81,
  wind: new THREE.Vector3(0, 0, 0),
  projectiles: null,
  onEvent: () => {},
});

function run(craft, { seconds = 20, throttle = 1, controls = {}, startY = null, startSpeed = 0, heading = 0, log = false, airborne = false, rotateAt = null, pitchInput = 0.75, targetPitch = 10, assist = 0 } = {}) {
  const ac = new Aircraft(craft, { position: new THREE.Vector3(0, 500, 0), heading, isPlayer: true, assist });
  if (startY == null) ac.placeOnGround(flatTerrain(0), 0, 0, heading);
  const y = startY != null ? startY : ac.body.position.y;
  if (airborne) {
    ac.body.velocity.set(0, 0, -startSpeed);
    ac.body.position.y = y;
  }
  ac.controls.assist = assist;
  ac.inputTarget.throttle = throttle;
  Object.assign(ac.inputTarget, controls);
  const e = env();
  const dt = 1 / 120;
  const hist = [];
  const steps = Math.round(seconds / dt);
  const rotate = rotateAt != null;
  for (let i = 0; i < steps; i++) {
    for (const k in controls) if (typeof controls[k] === 'number') ac.inputTarget[k] = controls[k];
    // 简化飞行员：抬轮后保持目标俯仰角（P 控制）
    if (rotate && !airborne) {
      if (ac.state.speed > rotateAt) {
        // 增益随动压下降（真实液压助力也做不到全速段等增益）
        const gain = Math.min(1, Math.pow(45 / Math.max(12, ac.state.speed), 1.4));
        const err = (targetPitch - ac.state.pitch) / 12 * gain;
        ac.inputTarget.pitch = Math.max(-1, Math.min(1, err));
      }
    }
    ac.controls.assist = assist;
    ac.update(dt, e);
    if (i % Math.round(0.5 / dt) === 0 || i === steps - 1) {
      const s = ac.state;
      const row = {
        t: +(i * dt).toFixed(2), y: +s.altitudeASL.toFixed(1), spd: +s.speed.toFixed(1),
        aoa: +s.aoa.toFixed(3), pitch: +s.pitch.toFixed(1), roll: +s.roll.toFixed(1), hdg: +s.heading.toFixed(1),
        g: +s.gForce.toFixed(2), thr: +s.thrust.toFixed(0), lift: +s.lift.toFixed(0), fuel: +s.fuel01.toFixed(2),
        stall: s.stall ? 'Y' : '.', hlt: +s.health01.toFixed(2), grounded: ac.groundContact ? 'G' : '.',
        vy: +s.verticalSpeed.toFixed(1),
      };
      hist.push(row);
      if (log === true) console.log(row);
    }
    if (Number.isNaN(ac.body.position.x)) { console.log('!!! NaN at t=', (i * dt).toFixed(2)); break; }
  }
  return { ac, hist };
}

const line = (r) => `t=${String(r.t).padStart(5)} y=${String(r.y).padStart(8)} spd=${String(r.spd).padStart(6)} aoa=${String(r.aoa).padStart(6)} pitch=${String(r.pitch).padStart(6)} roll=${String(r.roll).padStart(6)} hdg=${String(r.hdg).padStart(5)} g=${String(r.g).padStart(5)} ${r.stall}${r.grounded} hlt=${r.hlt}`;

console.log('=========== 机型列表 ===========');
crafts.forEach((c, i) => {
  const st = computeCraftStats(c);
  console.log(`${String(i).padStart(2)}  ${c.name.padEnd(14)} ${c.type.padEnd(7)} 零件${String(st.partCount).padStart(3)} 质量${st.mass.toFixed(0).padStart(5)}kg 翼面积${st.wingArea.toFixed(1).padStart(6)}m² 翼载${(st.wingLoading === Infinity ? '--' : st.wingLoading.toFixed(1)).padStart(6)} 推力${st.thrust.toFixed(0).padStart(6)}N 推重比${(st.thrust / (st.mass * 9.81)).toFixed(2)} 油${st.fuel.toFixed(0)}L 质心(${st.com.x.toFixed(2)},${st.com.y.toFixed(2)},${st.com.z.toFixed(2)}) 尺寸(${st.size.x.toFixed(1)},${st.size.y.toFixed(1)},${st.size.z.toFixed(1)})`);
});

const craft = crafts[Number.isFinite(idx) ? idx : 0];
console.log(`\n=========== 测试机型: ${craft.name} (${craft.type}) ===========`);

if (craft.type === 'plane') {
  const rocketish = craft.parts.some((p) => p.def === 'rocket');
  console.log('\n--- 1) 地面滑跑起飞（全油门 + 抬轮）---');
  const st0 = computeCraftStats(craft);
  const w0 = st0.mass * 9.81;
  const vs = st0.wingArea > 0.5 ? Math.sqrt(2 * w0 / (1.225 * st0.wingArea * 1.25)) : 0;
  const rotateAt = Math.max(18, vs * 1.12);
  console.log(`(估算失速速度 ${vs.toFixed(1)} m/s, 抬轮速度 ${rotateAt.toFixed(1)} m/s)`);
  const r1 = run(craft, { seconds: 45, throttle: 1, rotateAt, targetPitch: 12 });
  r1.hist.forEach((r) => console.log(line(r)));
  const last = r1.hist[r1.hist.length - 1];
  console.log((last.y > 30 ? '✅ 成功起飞并爬升' : (last.y > 3 ? '⚠️ 离地但爬升不足' : '❌ 未能起飞')) + `  (末速 ${last.spd} m/s, 高度 ${last.y} m, 油量 ${last.fuel})`);

  console.log('\n--- 2) 空中配平（设计巡航速度平飞，无输入 30s）---');
  // 用机型自己的设计巡航速度起测，而不是硬编码 60m/s —— 后者对高速喷气机
  // 是「离配平点很远」的状态，测出来的漂移反映不了配平质量。
  const aero2 = new Aircraft(craft, { position: new THREE.Vector3(0, 1500, 0), isPlayer: true, assist: 0.5 })._analyzeAero();
  const cruiseV = aero2.V > 30 ? aero2.V : 60;
  const r2 = run(craft, { seconds: 30, throttle: 1, startY: 1500, startSpeed: cruiseV, airborne: true, assist: 0.5 });
  const h2 = r2.hist[r2.hist.length - 1];
  const dy = h2.y - r2.hist[0].y;
  const droll = h2.roll - r2.hist[0].roll;
  const dspd = h2.spd - r2.hist[0].spd;
  console.log(`Δ高度=${dy.toFixed(1)}m  Δ速度=${dspd.toFixed(1)}m/s  Δ滚转=${droll.toFixed(1)}°`);
  // 火箭机（Comet）靠燃料燃烧飞行，不存在气动巡航配平点，豁免
  if (rocketish) {
    console.log('⚠️ 火箭机：跳过配平稳态断言（设计为燃烧/滑翔）');
  } else if (Math.abs(dy) < 150 && Math.abs(droll) < 15) {
    console.log('✅ 松手后能自行收敛（高度/滚转稳定）');
  } else {
    console.log(`❌ 松手后失衡：高度漂 ${dy.toFixed(1)}m、滚转漂 ${droll.toFixed(1)}°（阈值 150m / 15°）`);
  }

  // 操纵响应：直接检查 1 秒后角速度符号（机体轴）
  const rot = (controls, secs = 1.2) => {
    const ac2 = new Aircraft(craft, { position: new THREE.Vector3(0, 800, 0), isPlayer: true, assist: 0 });
    ac2.body.velocity.set(0, 0, -110);
    ac2.body.quaternion.identity();
    ac2.body.position.set(0, 800, 0);
    ac2.inputTarget.throttle = 0.8;
    const e2 = env();
    const inv = new THREE.Quaternion();
    let w = new THREE.Vector3();
    const dt = 1 / 120;
    for (let i = 0; i < secs / dt; i++) {
      for (const k in controls) ac2.inputTarget[k] = controls[k];
      ac2.update(dt, e2);
      inv.copy(ac2.body.quaternion).invert();
      w = ac2.body.angularVelocity.clone().applyQuaternion(inv);
    }
    return { wx: w.x, wy: w.y, wz: w.z, ac: ac2 };
  };
  console.log('\n--- 3) 拉杆（+1 pitch，期望机体角速度 +X）---');
  const p3 = rot({ pitch: 1 });
  console.log(`wx=${p3.wx.toFixed(4)}  ` + (p3.wx > 0.05 ? '✅ 抬头响应正确' : '❌ 抬头方向错误或无响应'));
  console.log('--- 4) 右滚（+1 roll，期望机体角速度 -Z）---');
  const p4 = rot({ roll: 1 });
  console.log(`wz=${p4.wz.toFixed(4)}  ` + (p4.wz < -0.05 ? '✅ 右滚响应正确' : '❌ 滚转方向错误或无响应'));
  console.log('--- 5) 右舵（+1 yaw，期望机体角速度 -Y）---');
  const p5 = rot({ yaw: 1 });
  console.log(`wy=${p5.wy.toFixed(4)}  ` + (p5.wy < -0.02 ? '✅ 右偏航正确' : '❌ 偏航方向错误或无响应'));
}
