/**
 * 库存机型（Stock Crafts）
 * 用辅助函数拼装，全部为程序化零件。
 */
import { makePart, PART_DEFS, partMass } from './parts.js';

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
 * 自动配平：把主翼气动中心放到重心之后（静态稳定），再把主起落架放到重心之后（可抬轮）。
 * 玩家自建机型也可在机库里点“自动配平”调用。
 */
export function autoBalance(parts) {
  for (let iter = 0; iter < 4; iter++) {
    // 1) 主翼：整体平移，使气动中心落在重心之后 0.26m（静态稳定）
    const com = computeCOM(parts);
    const wings = parts.filter((p) => PART_DEFS[p.def]?.mainWing);
    if (wings.length) {
      const avg = wings.reduce((a, w) => a + w.pos[2], 0) / wings.length;
      const d = (com.z + 0.26) - avg;
      for (const w of wings) w.pos[2] += d * 0.9;
    }
    // 2) 主起落架：整体平移（保留多轮相对位置），使主轮平均位于重心之后 0.5m
    const com2 = computeCOM(parts);
    const gear = parts.filter((p) => PART_DEFS[p.def]?.gear);
    if (gear.length >= 2) {
      const zs = gear.map((g) => g.pos[2]);
      if (Math.max(...zs) - Math.min(...zs) >= 1.2) {
        const noseZ = Math.min(...zs);
        const mains = gear.filter((g) => g.pos[2] > noseZ + 1e-3);
        if (mains.length) {
          const avg = mains.reduce((a, g) => a + g.pos[2], 0) / mains.length;
          const d = (com2.z + 0.5) - avg;
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
  // 高单翼
  P('wing', [1.95, 1.4, -0.95], [2, 0, 0], { size: [7.8, 0.26, 1.85], props: { taper: 0.82, dihedral: 3, thick: 0.13, camber: 0.03, sweep: 0 } }),
  P('tailplane', [0.65, 1.0, 3.1], [0, 0, 0], { size: [1.3, 0.16, 1.05], props: { taper: 0.6, sweep: 0.4 } }),
  P('fin', [0, 1.5, 3.2], [0, 0, 0], { size: [1.3, 0.16, 1.0], props: { taper: 0.55, sweep: 1.1 } }),
  P('gear_fixed', [0, -0.05, -3.1], [0, 0, 0], { props: { wheelSize: 0.4 } }),
  P('gear_fixed', [0.85, 0.05, -0.35], [0, 0, 0], { props: { wheelSize: 0.52 } }),
  P('seat', [0, 0.8, -2.0]),
  P('fuel_tank', [0, 0.6, 1.7], [0, 0, 0], { size: [0.95, 0.7, 1.4], props: { capacity: 150 } }),
  P('light', [1.7, 1.25, -0.4]),
]);

/* ================================================================== 2. 喷气机 */
const simpleJetParts = () => sym([
  P('cockpit_jet', [0, 0.35, -2.4], [0, 0, 0], { size: [1.2, 1.2, 3.0], color: '#c9d3dd' }),
  P('nose_cone', [0, 0.35, -4.4], [0, 0, 0], { size: [1.15, 1.15, 1.4], color: '#c9d3dd' }),
  P('fuselage_round', [0, 0.35, 0.4], [0, 0, 0], { size: [1.35, 1.35, 3.0], color: '#c9d3dd' }),
  P('tail_cone', [0, 0.35, 3.2], [0, 0, 0], { size: [1.2, 1.2, 2.2], color: '#c9d3dd' }),
  // 后掠翼
  P('wing', [2.6, 0.25, 0.6], [0, 0, 0], { size: [7.2, 0.24, 2.1], props: { taper: 0.5, sweep: 1.6, dihedral: 2, thick: 0.1, camber: 0.015 } }),
  P('tailplane', [0.75, 0.5, 3.6], [0, 0, 0], { size: [1.5, 0.18, 1.4], props: { taper: 0.5, sweep: 1.4 } }),
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
  P('wing', [1.9, 1.55, -0.6], [0, 0, 0], { size: [5.6, 0.24, 1.3], props: { taper: 0.9, dihedral: 2, camber: 0.04, thick: 0.14 } }),
  P('wing', [1.9, 0.55, -0.4], [0, 0, 0], { size: [5.2, 0.24, 1.2], props: { taper: 0.9, dihedral: 2, camber: 0.04, thick: 0.14 } }),
  P('boom', [0.85, 1.05, -0.5], [0, 0, 0], { size: [0.1, 1.0, 0.1] }),
  P('tailplane', [0.6, 1.0, 3.1], [0, 0, 0], { size: [1.2, 0.16, 0.95], props: { taper: 0.6 } }),
  P('fin', [0, 1.5, 3.2], [0, 0, 0], { size: [1.2, 0.16, 1.0], props: { taper: 0.6, sweep: 0.6 } }),
  P('gear_fixed', [0, 0.0, -2.2], [0, 0, 0], { props: { wheelSize: 0.4 } }),
  P('gear_fixed', [0.75, 0.1, -0.2], [0, 0, 0], { props: { wheelSize: 0.5 } }),
  P('gear_fixed', [0, 0.15, 2.9], [0, 0, 0], { props: { wheelSize: 0.26 } }),
  P('seat', [0, 0.8, -1.0]),
  P('fuel_tank', [0, 0.6, 1.6], [0, 0, 0], { size: [0.85, 0.7, 1.4], props: { capacity: 200 } }),
]);

/* ================================================================== 4. 战斗机 */
const fighterParts = () => sym([
  P('cockpit_jet', [0, 0.4, -2.2], [0, 0, 0], { size: [1.15, 1.15, 3.2], color: '#4a5560' }),
  P('nose_cone', [0, 0.4, -4.3], [0, 0, 0], { size: [1.0, 1.0, 1.6], color: '#4a5560' }),
  P('fuselage_round', [0, 0.4, 0.6], [0, 0, 0], { size: [1.5, 1.3, 3.6], color: '#4a5560' }),
  P('tail_cone', [0, 0.4, 3.4], [0, 0, 0], { size: [1.35, 1.15, 2.2], color: '#4a5560' }),
  P('wing_delta', [2.6, 0.15, 1.0], [0, 0, 0], { size: [6.6, 0.24, 6.0], props: { taper: 0.12, sweep: 2.4, thick: 0.08 } }),
  P('elevator', [1.6, 0.12, 2.6], [0, 0, 0], { size: [1.9, 0.1, 0.7] }),
  P('canard', [1.1, 0.5, -3.2], [0, 0, 0], { size: [2.4, 0.14, 1.1], props: { taper: 0.55, sweep: 1.2 } }),
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
  P('wing', [6.0, 2.3, -0.6], [0, 0, 0], { size: [13, 0.4, 3.2], props: { taper: 0.6, sweep: 0.6, dihedral: 3, thick: 0.14, camber: 0.02 } }),
  P('tailplane', [1.35, 2.1, 5.6], [0, 0, 0], { size: [2.7, 0.28, 1.9], props: { taper: 0.6, sweep: 0.9 } }),
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
  P('wing', [2.0, 1.8, -0.6], [3, 0, 0], { size: [8.0, 0.3, 1.7], props: { taper: 0.8, dihedral: 2, camber: 0.035, thick: 0.14 } }),
  P('tailplane', [0.7, 1.45, 3.2], [0, 0, 0], { size: [1.4, 0.18, 1.05], props: { taper: 0.6 } }),
  P('fin', [0, 2.0, 3.3], [0, 0, 0], { size: [1.4, 0.18, 1.1], props: { taper: 0.55, sweep: 1.0 } }),
  P('float', [1.4, -0.4, -0.4], [0, 0, 0], { size: [0.55, 0.5, 3.0], color: '#dfe6ec' }),
  P('boom', [0.9, 0.6, -0.6], [0, 0, 0], { size: [0.1, 1.0, 0.1] }),
  P('fuel_tank', [0, 1.05, 1.8], [0, 0, 0], { size: [1.0, 0.8, 1.6], props: { capacity: 300 } }),
  P('seat', [0, 1.25, -1.7]),
]);

/* ================================================================== 7. 滑翔机 */
const gliderParts = () => sym([
  P('cockpit_bubble', [0, 0.4, -1.0], [0, 0, 0], { size: [0.95, 1.0, 2.4], color: '#eef3f7' }),
  P('nose_cone', [0, 0.4, -2.6], [0, 0, 0], { size: [0.8, 0.8, 1.4], color: '#eef3f7' }),
  P('boom', [0, 0.5, 1.6], [0, 0, 0], { size: [0.22, 0.22, 4.0] }),
  P('wing', [4.2, 0.9, -0.8], [0, 0, 0], { size: [17, 0.22, 1.5], props: { taper: 0.55, dihedral: 4, thick: 0.1, camber: 0.03, sweep: 0.3 } }),
  P('tailplane', [0.65, 0.6, 3.5], [0, 0, 0], { size: [1.3, 0.14, 0.95], props: { taper: 0.6 } }),
  P('fin', [0, 1.1, 3.5], [0, 0, 0], { size: [1.2, 0.14, 1.0], props: { taper: 0.5, sweep: 1.2 } }),
  P('gear_fixed', [0, -0.1, -1.4], [0, 0, 0], { props: { wheelSize: 0.3 } }),
  P('ski', [0.7, -0.3, 0.2]),
  P('seat', [0, 0.5, -1.1]),
  P('weight', [0, 0.3, -2.0], [0, 0, 0], { props: { mass: 60 } }),
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
  P('wing', [1.9, 0.2, -0.1], [0, 0, 0], { size: [5.2, 0.22, 2.0], props: { taper: 0.6, sweep: 0.8, thick: 0.1, dihedral: 2 } }),
  P('fin', [0, 1.1, 1.8], [0, 0, 0], { size: [1.2, 0.16, 1.2], props: { taper: 0.5, sweep: 1.4 } }),
  P('rocket', [0.7, 0.4, 2.2], [0, 0, 0], { props: { boost: 1.4 } }),
  P('rocket', [0, 0.4, 2.2], [0, 0, 0], { props: { boost: 1.4 } }),
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
