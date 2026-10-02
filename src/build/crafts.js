/**
 * 库存机型（Stock Crafts）
 * 用辅助函数拼装，全部为程序化零件。
 */
import { makePart, PART_DEFS, partMass, partFeatures } from './parts.js';
import { acOffset } from '../flight/physics.js';

const P = (def, pos, rot = [0, 0, 0], opts = {}) => makePart(def, pos, rot, opts);

/** 左右镜像：X!=0 的零件复制一份并镜像旋转 */
function sym(parts) {
  const out = [];
  for (const p of parts) {
    out.push(p);
    if (Math.abs(p.pos[0]) > 1e-4) {
      const m = JSON.parse(JSON.stringify(p));
      m.uid = (makePart._n = (makePart._n || 0) + 1);
      m.pos[0] = -p.pos[0];
      m.rot = [p.rot[0], -p.rot[1], -p.rot[2]];
      out.push(m);
    }
  }
  return out;
}

/**
 * 自动配平起落架：把主起落架移到重心之后（保证地面俯仰稳定、可抬轮）。
 * 仅用于库存机型；玩家自建机型不做修改。
 */
/** 计算质量重心 */
export function computeCOM(parts) {
  const com = { x: 0, y: 0, z: 0 };
  let mt = 0;
  for (const p of parts) { const m = partMass(p); mt += m; com.x += p.pos[0] * m; com.y += p.pos[1] * m; com.z += p.pos[2] * m; }
  if (mt > 0) { com.x /= mt; com.y /= mt; com.z /= mt; }
  return com;
}

/**
 * 估算全机中性点（相对重心，+z 为机尾方向）。
 * 用升力线斜率 a = 2πAR/(AR+2) 对「机翼 + 平尾」做加权平均 —— 与 flight/physics.js
 * 的 solveWing 一致，所以和实际飞行时的静稳定性对得上。
 * 垂直尾翼（上反角 90°）不参与俯仰，直接跳过。
 */
function neutralPoint(parts, com) {
  let num = 0, den = 0, area = 0, macSum = 0;
  for (const p of parts) {
    const a = partFeatures(p).aero;
    if (!a || (a.type !== 'wing' && a.type !== 'plate')) continue;
    if (!a.span || !a.chord || !a.area) continue;
    if (Math.abs(a.dihedral ?? 0) > 45) continue;                    // 垂尾
    const ar = Math.max(1.2, Math.min(12, a.span * a.span / Math.max(1e-4, a.area)));
    const slope = (2 * Math.PI * ar) / (ar + 2);
    // 平尾处在机翼下洗里，效率打折
    const isTail = p.pos[2] > com.z + 0.3 && !PART_DEFS[p.def]?.mainWing;
    const eta = isTail ? 0.9 : 1;
    // 焦点在 1/4 平均气动弦，与实际气动模型（acOffset）一致
    num += slope * a.area * eta * (p.pos[2] + acOffset(a.chord, a.taper ?? 1, a.sweep ?? 0) - com.z);
    den += slope * a.area * eta;
    if (PART_DEFS[p.def]?.mainWing) { area += a.area; macSum += a.area * a.chord; }
  }
  if (den < 1e-3) return { x: 0, mac: 1, area: 0 };
  return { x: num / den, mac: area > 0 ? macSum / area : 1, area };
}

/**
 * 自动配平：把整机中性点放到重心之后约 15% 平均气动弦（真实飞机的静稳定余度区间），
 * 再把主起落架放到重心之后（保证地面俯仰稳定、可抬轮）。
 * 玩家自建机型也可在机库里点“自动配平”调用。
 */
export function autoBalance(parts) {
  for (let iter = 0; iter < 5; iter++) {
    // 1) 主翼：整体平移，使中性点落在目标静稳定余度上。
    //    限幅 ±0.6m/次：否则重心偏后的机型会把机翼整个搬到机尾（结构就明显不对了）
    const com = computeCOM(parts);
    const wings = parts.filter((p) => PART_DEFS[p.def]?.mainWing);
    if (wings.length) {
      const np = neutralPoint(parts, com);           // np.x 为相对重心的中性点（+ 为机尾方向）
      // 目标静稳定余度：12% 平均气动弦（真实飞机 10~20% 的常规区间）
      const target = 0.12 * np.mac;
      const d = Math.max(-0.5, Math.min(0.5, (target - np.x) * 0.6));
      if (Math.abs(d) > 0.002) for (const w of wings) w.pos[2] += d;
    }
    // 2) 主起落架：整体平移（保留多轮相对位置）
    //    前三点式（有前轮）=> 主轮移到重心之后 0.5m（可抬轮）
    //    后三点式（只有尾轮）=> 主轮留在重心稍前 0.25m（尾轮着地、抬头姿态）
    const com2 = computeCOM(parts);
    const gear = parts.filter((p) => PART_DEFS[p.def]?.gear);
    if (gear.length >= 2) {
      const zs = gear.map((g) => g.pos[2]);
      if (Math.max(...zs) - Math.min(...zs) >= 1.2) {
        const mains = gear.filter((g) => Math.abs(g.pos[0]) > 0.25);
        if (mains.length) {
          const mainZ = mains.reduce((a, g) => a + g.pos[2], 0) / mains.length;
          const hasNose = gear.some((g) => g.pos[2] < mainZ - 0.6);
          const target = hasNose ? com2.z + 0.5 : com2.z - 0.25;
          const d = target - mainZ;
          for (const g of mains) g.pos[2] += d * 0.9;
        }
      }
    }
  }
  return parts;
}

export function autoTrimGear(parts) {
  const com = { x: 0, y: 0, z: 0 };
  let mt = 0;
  for (const p of parts) { const m = partMass(p); mt += m; com.x += p.pos[0] * m; com.y += p.pos[1] * m; com.z += p.pos[2] * m; }
  if (mt <= 0) return parts;
  com.x /= mt; com.y /= mt; com.z /= mt;
  const gear = parts.filter((p) => PART_DEFS[p.def]?.gear);
  if (gear.length < 2) return parts;
  const zs = gear.map((p) => p.pos[2]);
  const span = Math.max(...zs) - Math.min(...zs);
  if (span < 1.2) return parts; // 浮筒/雪橇等长条支撑，不需要
  const noseZ = Math.min(...zs);
  for (const p of gear) {
    if (p.pos[2] <= noseZ + 1e-3) continue;      // 前轮保持
    p.pos[2] = com.z + 0.5;                       // 主轮移到重心后 0.5m
  }
  return parts;
}

let craftIdSeq = 0;
/** 定义机型 */
export function defineCraft(name, parts, opts = {}) {
  if (opts.trimGear !== false) autoBalance(parts);
  return {
    id: opts.id || 'craft_' + (++craftIdSeq) + '_' + Math.random().toString(36).slice(2, 7),
    name,
    desc: opts.desc || '',
    parts,
    type: opts.type || 'plane',
    builtin: !!opts.builtin,
    paint: opts.paint || null,
    unlockCost: opts.unlockCost ?? 0,
  };
}

/* ================================================================== 1. 教练机 */
const skyTrainerParts = () => sym([
  P('cockpit_prop', [0, 0.65, -1.9], [0, 0, 0], { size: [1.2, 1.3, 2.2], color: '#e8eef3' }),
  P('engine_prop', [0, 0.7, -3.45], [0, 0, 0], { props: { cylinders: 4, power: 1.4 } }),
  P('nose_cone', [0, 0.7, -4.25], [0, 0, 0], { size: [0.75, 0.75, 0.9], color: '#2b3440' }),
  P('propeller', [0, 0.7, -4.75], [0, 0, 0], { size: [0.16, 2.3, 2.3], props: { blades: 2 } }),
  P('fuselage_block', [0, 0.6, 0.6], [0, 0, 0], { size: [1.15, 1.15, 2.5], color: '#e8eef3' }),
  P('tail_cone', [0, 0.6, 2.7], [0, 0, 0], { size: [0.9, 0.9, 1.7], color: '#e8eef3' }),
  // 高单翼（整片翼，展向对称于机身中线，不再镜像复制）
  P('wing', [0, 1.4, -0.95], [2, 0, 0], { size: [7.8, 0.26, 1.85], props: { taper: 0.82, dihedral: 3, thick: 0.13, camber: 0.03, sweep: 0 } }),
  P('tailplane', [0, 1.0, 3.1], [0, 0, 0], { size: [2.6, 0.16, 1.05], props: { taper: 0.6, sweep: 0.4 } }),
  P('fin', [0, 1.5, 3.2], [0, 0, 0], { size: [1.3, 0.16, 1.0], props: { taper: 0.55, sweep: 1.1 } }),
  P('gear_fixed', [0, -0.05, -3.1], [0, 0, 0], { props: { wheelSize: 0.4 } }),
  P('gear_fixed', [0.85, 0.05, -0.35], [0, 0, 0], { props: { wheelSize: 0.52 } }),
  P('seat', [0, 0.8, -2.0]),
  P('fuel_tank', [0, 0.6, 1.7], [0, 0, 0], { size: [0.95, 0.7, 1.4], props: { capacity: 150 } }),
  P('light', [3.7, 1.5, -0.95]),
]);

/* ================================================================== 2. 喷气机 */
const simpleJetParts = () => sym([
  P('cockpit_jet', [0, 0.35, -2.4], [0, 0, 0], { size: [1.2, 1.2, 3.0], color: '#c9d3dd' }),
  P('nose_cone', [0, 0.35, -4.4], [0, 0, 0], { size: [1.15, 1.15, 1.4], color: '#c9d3dd' }),
  P('fuselage_round', [0, 0.35, 0.4], [0, 0, 0], { size: [1.35, 1.35, 3.0], color: '#c9d3dd' }),
  P('tail_cone', [0, 0.35, 3.2], [0, 0, 0], { size: [1.2, 1.2, 2.2], color: '#c9d3dd' }),
  // 后掠翼（整片）
  P('wing', [0, 0.25, 0.6], [0, 0, 0], { size: [7.2, 0.24, 2.1], props: { taper: 0.5, sweep: 1.6, dihedral: 2, thick: 0.1, camber: 0.015 } }),
  P('tailplane', [0, 0.5, 3.6], [0, 0, 0], { size: [3.0, 0.18, 1.4], props: { taper: 0.5, sweep: 1.4 } }),
  P('fin', [0, 1.4, 3.8], [0, 0, 0], { size: [1.8, 0.18, 1.5], props: { taper: 0.5, sweep: 1.8 } }),
  P('engine_jet', [0, 0.35, 4.3], [0, 0, 0], { props: { power: 1.0 } }),
  P('gear_retract', [0, -0.35, -3.6], [0, 0, 0], { props: { wheelSize: 0.45 } }),
  P('gear_retract', [1.0, -0.4, 0.6], [0, 0, 0], { props: { wheelSize: 0.55 } }),
  P('cannon', [0.85, 0.05, -4.2], [0, 0, 0], { props: { caliber: 20 } }),
  P('fuel_tank', [0, 0.35, 1.4], [0, 0, 0], { size: [1.1, 0.9, 2.0], props: { capacity: 480 } }),
]);

/* ================================================================== 3. 双翼机 */
const biplaneParts = () => sym([
  P('cockpit_open', [0, 0.7, -1.0], [0, 0, 0], { size: [1.1, 0.9, 1.8], color: '#b23b3b' }),
  P('engine_prop', [0, 0.75, -2.4], [0, 0, 0], { props: { cylinders: 9, power: 1.1 } }),
  P('nose_cone', [0, 0.75, -3.1], [0, 0, 0], { size: [0.8, 0.8, 0.7], color: '#3d4653' }),
  P('propeller', [0, 0.75, -3.5], [0, 0, 0], { size: [0.16, 2.6, 2.6], props: { blades: 2 } }),
  P('fuselage_half', [0, 0.65, 0.6], [0, 0, 0], { size: [1.0, 0.9, 3.2], color: '#c98a3b' }),
  P('tail_cone', [0, 0.65, 2.6], [0, 0, 0], { size: [0.75, 0.75, 1.4], color: '#c98a3b' }),
  P('wing', [0, 1.55, -0.6], [0, 0, 0], { size: [5.6, 0.24, 1.3], props: { taper: 0.9, dihedral: 2, camber: 0.04, thick: 0.14 } }),
  P('wing', [0, 0.55, -0.4], [0, 0, 0], { size: [5.2, 0.24, 1.2], props: { taper: 0.9, dihedral: 2, camber: 0.04, thick: 0.14 } }),
  P('boom', [0.85, 1.05, -0.5], [0, 0, 0], { size: [0.1, 1.0, 0.1] }),
  P('tailplane', [0, 1.0, 3.1], [0, 0, 0], { size: [2.4, 0.16, 0.95], props: { taper: 0.6 } }),
  P('fin', [0, 1.5, 3.2], [0, 0, 0], { size: [1.2, 0.16, 1.0], props: { taper: 0.6, sweep: 0.6 } }),
  P('gear_fixed', [0.75, 0.1, -0.2], [0, 0, 0], { props: { wheelSize: 0.5 } }),
  P('gear_fixed', [0, 0.5, 2.9], [0, 0, 0], { props: { wheelSize: 0.18 } }),   // 后三点式：主轮 + 短尾轮（抬头姿态）
  P('seat', [0, 0.8, -1.0]),
  P('fuel_tank', [0, 0.6, 1.6], [0, 0, 0], { size: [0.85, 0.7, 1.4], props: { capacity: 200 } }),
]);

/* ================================================================== 4. 战斗机 */
const fighterParts = () => sym([
  P('cockpit_jet', [0, 0.4, -2.2], [0, 0, 0], { size: [1.15, 1.15, 3.2], color: '#4a5560' }),
  P('nose_cone', [0, 0.4, -4.3], [0, 0, 0], { size: [1.0, 1.0, 1.6], color: '#4a5560' }),
  P('fuselage_round', [0, 0.4, 0.6], [0, 0, 0], { size: [1.5, 1.3, 3.6], color: '#4a5560' }),
  P('tail_cone', [0, 0.4, 3.4], [0, 0, 0], { size: [1.35, 1.15, 2.2], color: '#4a5560' }),
  // 三角翼后缘的升降副翼（要有足够的尾容量才压得住三角翼），鸭翼离重心近一些：
// 鸭翼在重心之前 4m 时会大幅削弱静稳定性，把机翼逼到机尾去（结构就不对了）
  P('wing_delta', [0, 0.15, 1.8], [0, 0, 0], { size: [6.6, 0.24, 6.0], props: { taper: 0.12, sweep: 2.4, thick: 0.08 } }),
  P('elevator', [0, 0.12, 4.3], [0, 0, 0], { size: [4.4, 0.12, 1.0] }),   // 三角翼后缘的升降副翼
  P('canard', [0, 0.5, -2.5], [0, 0, 0], { size: [2.2, 0.14, 0.85], props: { taper: 0.55, sweep: 1.2 } }),
  P('fin', [0, 1.5, 3.6], [0, 0, 0], { size: [2.0, 0.18, 1.8], props: { taper: 0.45, sweep: 2.0 } }),
  P('engine_jet', [0, 0.4, 4.6], [0, 0, 0], { props: { power: 1.6 } }),
  P('gear_retract', [0, -0.35, -3.4], [0, 0, 0], { props: { wheelSize: 0.42 } }),
  P('gear_retract', [1.15, -0.45, 0.9], [0, 0, 0], { props: { wheelSize: 0.58 } }),
  P('cannon', [1.0, 0.0, -4.0], [0, 0, 0], { props: { caliber: 30 } }),
  P('missile_rail', [1.7, -0.35, 0.2], [0, 0, 0], { props: { missiles: 2 } }),
  P('flare', [0, 0.1, 3.0]),
  P('fuel_tank', [0, 0.4, 1.4], [0, 0, 0], { size: [1.3, 1.0, 2.4], props: { capacity: 420 } }),
]);

/* ================================================================== 5. 货运机 */
const cargoParts = () => sym([
  P('cockpit_jet', [0, 1.5, -6.0], [0, 0, 0], { size: [1.6, 1.6, 3.4], color: '#d8dde2' }),
  P('nose_cone', [0, 1.5, -8.2], [0, 0, 0], { size: [1.5, 1.5, 1.4], color: '#d8dde2' }),
  P('fuselage_block', [0, 1.5, -3.0], [0, 0, 0], { size: [2.0, 2.0, 3.2], color: '#d8dde2' }),
  P('fuselage_block', [0, 1.5, 0.4], [0, 0, 0], { size: [2.0, 2.0, 3.6], color: '#d8dde2' }),
  P('fuselage_block', [0, 1.5, 3.6], [0, 0, 0], { size: [1.8, 1.8, 3.0], color: '#d8dde2' }),
  P('tail_cone', [0, 1.7, 6.0], [0, 0, 0], { size: [1.6, 1.6, 2.2], color: '#d8dde2' }),
  P('wing', [0, 2.3, -0.6], [0, 0, 0], { size: [13, 0.4, 3.2], props: { taper: 0.6, sweep: 0.6, dihedral: 3, thick: 0.14, camber: 0.02 } }),
  P('tailplane', [0, 2.1, 5.6], [0, 0, 0], { size: [5.4, 0.28, 1.9], props: { taper: 0.6, sweep: 0.9 } }),
  P('fin', [0, 3.6, 5.8], [0, 0, 0], { size: [3.0, 0.26, 2.4], props: { taper: 0.55, sweep: 1.2 } }),
  P('engine_turboprop', [2.6, 2.1, -1.4], [0, 0, 0], { props: { power: 2.4 } }),
  P('propeller', [2.6, 2.1, -2.6], [0, 0, 0], { size: [0.3, 4.0, 4.0], props: { blades: 4 } }),
  P('gear_retract', [0, -0.6, -5.7], [0, 0, 0], { props: { wheelSize: 0.6 } }),
  P('gear_retract', [1.7, -0.7, 0.6], [0, 0, 0], { props: { wheelSize: 0.9 } }),
  P('gear_retract', [1.7, -0.7, 1.3], [0, 0, 0], { props: { wheelSize: 0.9 } }),
  P('cargo_box', [0, 1.5, 0.4], [0, 0, 0], { size: [1.7, 1.7, 3.0] }),
  P('fuel_tank', [0, 1.5, 3.4], [0, 0, 0], { size: [1.6, 1.4, 2.6], props: { capacity: 900 } }),
]);

/* ================================================================== 6. 水上飞机 */
const seaplaneParts = () => sym([
  P('cockpit_prop', [0, 1.1, -1.6], [0, 0, 0], { size: [1.25, 1.35, 2.4], color: '#e6f0f5' }),
  P('engine_prop', [0, 1.15, -3.2], [0, 0, 0], { props: { cylinders: 6, power: 1.0 } }),
  P('nose_cone', [0, 1.15, -4.0], [0, 0, 0], { size: [0.85, 0.85, 0.9], color: '#2b3440' }),
  P('propeller', [0, 1.15, -4.5], [0, 0, 0], { size: [0.18, 2.7, 2.7], props: { blades: 3 } }),
  P('fuselage_block', [0, 1.05, 0.7], [0, 0, 0], { size: [1.25, 1.25, 2.8], color: '#e6f0f5' }),
  P('tail_cone', [0, 1.05, 2.8], [0, 0, 0], { size: [0.95, 0.95, 1.8], color: '#e6f0f5' }),
  P('wing', [0, 1.8, -0.6], [3, 0, 0], { size: [9.6, 0.3, 1.9], props: { taper: 0.8, dihedral: 2, camber: 0.035, thick: 0.14 } }),
  P('tailplane', [0, 1.45, 3.2], [0, 0, 0], { size: [3.2, 0.18, 1.05], props: { taper: 0.6 } }),
  P('fin', [0, 2.0, 3.3], [0, 0, 0], { size: [1.4, 0.18, 1.1], props: { taper: 0.55, sweep: 1.0 } }),
  P('float', [1.4, -0.4, -1.1], [0, 0, 0], { size: [0.55, 0.5, 3.0], color: '#dfe6ec' }),
  P('boom', [0.9, 0.6, -0.6], [0, 0, 0], { size: [0.1, 1.0, 0.1] }),
  P('fuel_tank', [0, 1.05, 1.8], [0, 0, 0], { size: [1.0, 0.8, 1.6], props: { capacity: 200 } }),
  P('seat', [0, 1.25, -1.7]),
]);

/* ================================================================== 7. 滑翔机 */
const gliderParts = () => sym([
  P('cockpit_bubble', [0, 0.4, -1.0], [0, 0, 0], { size: [0.95, 1.0, 2.4], color: '#eef3f7' }),
  P('nose_cone', [0, 0.4, -2.6], [0, 0, 0], { size: [0.8, 0.8, 1.4], color: '#eef3f7' }),
  P('boom', [0, 0.5, 1.6], [0, 0, 0], { size: [0.22, 0.22, 4.0] }),
  P('wing', [0, 0.9, -0.8], [0, 0, 0], { size: [17, 0.22, 1.5], props: { taper: 0.55, dihedral: 4, thick: 0.1, camber: 0.03, sweep: 0.3 } }),
  P('tailplane', [0, 0.6, 3.5], [0, 0, 0], { size: [2.6, 0.14, 0.95], props: { taper: 0.6 } }),
  P('fin', [0, 1.1, 3.5], [0, 0, 0], { size: [1.2, 0.14, 1.0], props: { taper: 0.5, sweep: 1.2 } }),
  P('gear_fixed', [0, -0.1, -1.4], [0, 0, 0], { props: { wheelSize: 0.3 } }),
  P('ski', [0.7, -0.3, 0.2]),
  P('seat', [0, 0.5, -1.1]),
  P('weight', [0, 0.3, -2.0], [0, 0, 0], { props: { mass: 60 } }),
  // 自持动力（可自行起飞，不必靠拖曳）
  P('engine_electric', [0, 0.55, 2.05], [0, 0, 0], { props: { power: 1.8 } }),
  P('propeller', [0, 0.55, 2.5], [0, 0, 0], { size: [0.16, 1.6, 1.6], props: { blades: 2 } }),
  P('battery', [0, 0.5, 0.9], [0, 0, 0], { props: { capacity: 60 } }),
]);

/* ================================================================== 8. 汽车 */
export const carParts = () => [
  P('fuselage_block', [0, 0.75, 0], [0, 0, 0], { size: [1.9, 0.7, 4.2], color: '#c0392b' }),
  P('fuselage_block', [0, 1.35, 0.2], [0, 0, 0], { size: [1.7, 0.6, 2.0], color: '#2c3e50' }),
  P('engine_prop', [0, 0.7, -2.2], [0, 0, 0], { size: [1.0, 0.8, 1.0], props: { cylinders: 8, power: 1.4 } }),
  P('transmission', [0, 0.7, 0.6], [0, 0, 0], { props: { gears: 4 } }),
  P('fuel_tank', [0, 0.7, 1.8], [0, 0, 0], { size: [1.6, 0.6, 1.0], props: { capacity: 200 } }),
  P('wheel', [0.95, 0.35, -1.5], [0, 0, 0], { props: { size: 0.7 } }),
  P('wheel', [-0.95, 0.35, -1.5], [0, 0, 0], { props: { size: 0.7 } }),
  P('wheel', [0.95, 0.35, 1.5], [0, 0, 0], { props: { size: 0.7 } }),
  P('wheel', [-0.95, 0.35, 1.5], [0, 0, 0], { props: { size: 0.7 } }),
  P('light', [0.7, 0.85, -2.1]),
  P('light', [-0.7, 0.85, -2.1]),
  P('seat', [0, 1.2, 0.4]),
];

/* ================================================================== 9. 叉车 */
export const forkliftParts = () => [
  P('fuselage_block', [0, 0.8, 0.2], [0, 0, 0], { size: [1.5, 0.8, 2.4], color: '#f1c40f' }),
  P('fuselage_block', [0, 1.6, 0.9], [0, 0, 0], { size: [1.3, 0.8, 1.0], color: '#2c3e50' }),
  P('engine_electric', [0, 0.8, 1.2], [0, 0, 0], { props: { power: 0.7 } }),
  P('battery', [0, 0.8, -0.4], [0, 0, 0], { props: { capacity: 80 } }),
  P('transmission', [0, 0.6, 0.4], [0, 0, 0], { props: { gears: 2 } }),
  P('boom', [0, 1.0, -1.6], [0, 0, 0], { size: [0.14, 0.14, 1.6] }),
  P('boom', [0, 0.2, -2.3], [0, 0, 0], { size: [0.1, 0.1, 1.2] }),
  P('fuselage_half', [0, 0.2, -2.95], [0, 0, 0], { size: [1.2, 0.1, 0.9], color: '#7f8c8d' }),
  P('wheel', [0.8, 0.35, -1.4], [0, 0, 0], { props: { size: 0.7 } }),
  P('wheel', [-0.8, 0.35, -1.4], [0, 0, 0], { props: { size: 0.7 } }),
  P('wheel', [0.8, 0.3, 1.2], [0, 0, 0], { props: { size: 0.6 } }),
  P('wheel', [-0.8, 0.3, 1.2], [0, 0, 0], { props: { size: 0.6 } }),
  P('seat', [0, 1.3, 0.3]),
];

/* ================================================================== 10. 快艇 */
export const boatParts = () => [
  P('fuselage_half', [0, 0.3, 0], [0, 0, 0], { size: [1.8, 0.9, 5.0], color: '#ffffff' }),
  P('nose_cone', [0, 0.3, -3.1], [0, 0, 0], { size: [1.7, 0.9, 1.4], color: '#ffffff' }),
  P('fuselage_block', [0, 0.8, 0.6], [0, 0, 0], { size: [1.4, 0.7, 1.6], color: '#2266aa' }),
  P('engine_prop', [0, 0.7, 2.2], [0, 0, 0], { props: { cylinders: 8, power: 1.6 } }),
  P('propeller', [0, 0.2, 2.7], [0, 0, 0], { size: [0.2, 1.0, 1.0], props: { blades: 3 } }),
  P('float', [0, -0.2, 0.2], [0, 0, 0], { size: [1.6, 0.6, 4.4] }),
  P('fuel_tank', [0, 0.6, 1.4], [0, 0, 0], { size: [1.2, 0.6, 1.0], props: { capacity: 200 } }),
  P('seat', [0, 1.0, 0.2]),
  P('light', [0, 0.9, -3.4]),
];

/* ================================================================== 11. 火箭机 */
const rocketParts = () => sym([
  P('cockpit_jet', [0, 0.4, -1.6], [0, 0, 0], { size: [1.0, 1.0, 2.6], color: '#dfe6ec' }),
  P('nose_cone', [0, 0.4, -3.4], [0, 0, 0], { size: [1.0, 1.0, 1.6], color: '#dfe6ec' }),
  P('fuselage_round', [0, 0.4, 0.8], [0, 0, 0], { size: [1.1, 1.1, 2.6], color: '#dfe6ec' }),
  // 主翼放在重心附近：3 台助推器共 360kg（占全机一半），若挂在机尾会把重心拖到机翼之后，
  // 机翼被迫后移、尾臂只剩 1.5m —— 静态稳定与抬头力矩都不够，飞行时必然失控。
  // 助推器改挂机腹中段（真实火箭机的布局），重心自然落在机翼上。
  P('wing', [0, 0.2, -0.1], [0, 0, 0], { size: [5.2, 0.22, 2.0], props: { taper: 0.6, sweep: 0.8, thick: 0.1, dihedral: 2 } }),
  P('tailplane', [0, 0.35, 2.6], [0, 0, 0], { size: [2.2, 0.14, 0.9], props: { taper: 0.6, sweep: 0.6 } }),   // 俯仰舵面（否则火箭机没有抬头力矩）
  P('fin', [0, 1.1, 1.8], [0, 0, 0], { size: [1.2, 0.16, 1.2], props: { taper: 0.5, sweep: 1.4 } }),
  P('rocket', [0.78, -0.05, 0.1], [0, 0, 0], { props: { boost: 2.1 } }),
  P('rocket', [-0.78, -0.05, 0.1], [0, 0, 0], { props: { boost: 2.1 } }),
  P('gear_fixed', [0.7, 0.15, -0.6], [0, 0, 0], { props: { wheelSize: 0.3 } }),
  P('gear_fixed', [0, 0.15, -2.6], [0, 0, 0], { props: { wheelSize: 0.26 } }),
  P('parachute', [0, 0.4, 2.6]),
]);

/* ================================================================== 12. Major Chad */
export const chadParts = () => [
  P('pilot_chad', [0, 0.9, 0]),
  P('parachute', [0, 1.75, 0.2]),
];

/* ================================================================== 导出 */
export function stockCrafts() {
  return [
    defineCraft('Sky Trainer', skyTrainerParts(), { builtin: true, type: 'plane', desc: '经典高单翼教练机，稳定易飞，适合新手。' }),
    defineCraft('Simple Jet', simpleJetParts(), { builtin: true, type: 'plane', desc: '单发后掠翼喷气机，速度与操控均衡。' }),
    defineCraft('Barnstormer', biplaneParts(), { builtin: true, type: 'plane', desc: '双翼特技机，低速机动性极佳。' }),
    defineCraft('Warhound', fighterParts(), { builtin: true, type: 'plane', desc: '三角翼战斗机，带机炮与导弹挂架。' }),
    defineCraft('Skyfreighter', cargoParts(), { builtin: true, type: 'plane', desc: '双发涡桨货运机，载重大、航程远。' }),
    defineCraft('Seagull', seaplaneParts(), { builtin: true, type: 'plane', desc: '水上飞机，可在海面与湖泊起降。' }),
    defineCraft('Zephyr', gliderParts(), { builtin: true, type: 'plane', desc: '无动力滑翔机，靠气流翱翔。' }),
    defineCraft('Comet', rocketParts(), { builtin: true, type: 'plane', desc: '火箭动力实验机，可突破音障。' }),
    defineCraft('Pickup', carParts(), { builtin: true, type: 'car', desc: '四轮驱动越野车，可换挡漂移。' }),
    defineCraft('Forklift', forkliftParts(), { builtin: true, type: 'car', desc: '电动叉车，低速高扭矩。' }),
    defineCraft('Speedboat', boatParts(), { builtin: true, type: 'boat', desc: '快艇，在水面高速滑行。' }),
    defineCraft('Major Chad', chadParts(), { builtin: true, type: 'mascot', desc: '可操作吉祥物，用脚丈量世界。' }),
  ];
}

/** 隐藏在地图中的可收集机型（40+ 随机生成风格） */
export function hiddenCraftNames() {
  return ['Lost Cub', 'Coral Spy', 'Icy Dart', 'Dune Bug', 'Rust Bucket', 'Neon Ray', 'Ghost Wing', 'Twin Comet',
    'Old Faithful', 'Sea Hawk', 'Sand Flea', 'Polar Star', 'Sky Mule', 'Turbo Snail', 'Starling', 'Wasp',
    'Copperhead', 'Vulture', 'Manta', 'Kestrel', 'Pelican', 'Firefly', 'Bumblebee', 'Hornet', 'Albatross',
    'Peregrine', 'Nighthawk', 'Osprey', 'Harrier', 'Condor', 'Merlin', 'Sparrowhawk', 'Talon', 'Whirlwind',
    'Cyclone', 'Tempest', 'Mirage', 'Phantom', 'Spectre', 'Wraith', 'Valkyrie', 'Nomad'];
}
