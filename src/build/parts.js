/**
 * 零件库（Procedural Parts）
 * ------------------------------------------------------------------
 * 每个零件定义 = 元数据 + 程序化几何生成函数 + 气动/功能描述。
 * 零件实例（PartInstance）：
 *   { uid, def, pos:[x,y,z](米), rot:[rx,ry,rz](度), size:[w,h,l](米), color, props:{...} }
 * 约定：机头朝 -Z，Y 向上。
 */
import * as THREE from 'three';
import { clamp, DEG, makePaintTexture, makeWindowTexture } from '../core/util.js';

/* ================================================================== 分类 */
export const CATEGORIES = [
  { id: 'cockpit', name: '座舱', icon: '🪟' },
  { id: 'fuselage', name: '机身', icon: '🛩' },
  { id: 'wing', name: '机翼', icon: '✈' },
  { id: 'control', name: '控制面', icon: '🎛' },
  { id: 'power', name: '动力', icon: '⚙' },
  { id: 'gear', name: '起落架', icon: '🛞' },
  { id: 'fuel', name: '燃油', icon: '⛽' },
  { id: 'weapon', name: '武器', icon: '🚀' },
  { id: 'misc', name: '其它', icon: '🧰' },
];

/* ================================================================== 材质缓存 */
const matCache = new Map();
/** 取得（并缓存）一个标准材质。opts: {color, metalness, roughness, emissive, opacity, map} */
export function getMaterial(opts = {}) {
  const key = JSON.stringify(opts);
  if (matCache.has(key)) return matCache.get(key);
  const m = new THREE.MeshStandardMaterial({
    color: opts.color ?? 0xc9d3dd,
    metalness: opts.metalness ?? 0.45,
    roughness: opts.roughness ?? 0.45,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    transparent: (opts.opacity ?? 1) < 1,
    opacity: opts.opacity ?? 1,
    side: opts.side ?? THREE.FrontSide,
    flatShading: !!opts.flat,
  });
  if (opts.opacity != null && opts.opacity < 1) m.depthWrite = false;
  matCache.set(key, m);
  return m;
}
export function clearMaterialCache() { matCache.forEach((m) => m.dispose()); matCache.clear(); }

/* ================================================================== 几何工具 */
const box = (w, h, l) => new THREE.BoxGeometry(w, h, l);

/** NACA 四位翼型轮廓（x: 0..1 弦向，返回 {x,y} 上半/下半） */
function nacaProfile(thick = 0.12, camber = 0.02, camberPos = 0.4, steps = 14) {
  const yt = (x) => 5 * thick * (0.2969 * Math.sqrt(x) - 0.1260 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
  const yc = (x) => camber <= 0 ? 0 : (x < camberPos
    ? (camber / (camberPos ** 2)) * (2 * camberPos * x - x * x)
    : (camber / ((1 - camberPos) ** 2)) * ((1 - 2 * camberPos) + 2 * camberPos * x - x * x));
  const top = [], bot = [];
  for (let i = 0; i <= steps; i++) {
    const x = 0.5 - 0.5 * Math.cos((i / steps) * Math.PI); // 余弦分布，前后缘密
    const t = Math.max(0, yt(x)), c = yc(x);
    top.push(new THREE.Vector2(x, c + t));
    bot.push(new THREE.Vector2(x, c - t));
  }
  return { top, bot };
}

/**
 * 生成一片机翼/尾翼（NACA 翼型挤出）。
 * @returns {THREE.BufferGeometry} 弦向沿 Z、展向沿 X、厚度沿 Y
 */
export function wingGeometry(span, chord, thick = 0.12, taper = 1, sweep = 0, dihedral = 0, camber = 0.02) {
  const { top, bot } = nacaProfile(thick, camber);
  const shape = new THREE.Shape();
  shape.moveTo(top[0].x, top[0].y);
  for (let i = 1; i < top.length; i++) shape.lineTo(top[i].x, top[i].y);
  for (let i = bot.length - 1; i >= 0; i--) shape.lineTo(bot[i].x, bot[i].y);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: span, bevelEnabled: false, curveSegments: 2 });
  geo.translate(0, 0, -span / 2);
  geo.scale(chord, chord, 1);
  geo.rotateY(Math.PI / 2); // 弦向 -> Z, 展向 -> X
  geo.translate(0, 0, -chord * 0.25); // 气动中心大致在 25% 弦
  // 后掠 / 上反角 / 收缩：按展向位置变形顶点
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const s = span > 1e-6 ? Math.abs(x) / (span / 2) : 0; // 0 根部 -> 1 翼尖
    const taperF = 1 - (1 - taper) * s;
    const nz = z * taperF - sweep * s * (x >= 0 ? 1 : 1);
    const ny = y + Math.tan(dihedral * DEG) * Math.abs(x);
    pos.setXYZ(i, x, ny, nz);
  }
  geo.computeVertexNormals();
  return geo;
}

/** 圆锥/鼻锥 */
const noseCone = (r, l, seg = 14) => { const g = new THREE.ConeGeometry(r, l, seg); g.rotateX(-Math.PI / 2); return g; };
/** 圆筒（沿 Z 轴） */
const cyl = (r, l, seg = 14) => { const g = new THREE.CylinderGeometry(r, r, l, seg); g.rotateX(Math.PI / 2); return g; };

/* ================================================================== 零件定义 */
/**
 * 每个 def:
 *  id, name, cat, size:[w,h,l], mass(kg @ size), cost, hp, color,
 *  geo(size, props) -> THREE.BufferGeometry | THREE.BufferGeometry[]
 *  aero(size, props) -> { type, area, span, chord, cd0, control } | null
 *  engine/fuel/gear/weapon/float 等功能字段
 *  props: 该零件可调参数（供建造器 UI 使用）: [{key,label,min,max,step,default}]
 */
export const PART_DEFS = {
  /* ---------------------------------------------------------- 座舱 */
  cockpit_jet: {
    id: 'cockpit_jet', name: '喷气座舱', cat: 'cockpit', size: [1.1, 1.1, 2.6], mass: 80, cost: 1400, hp: 140, color: 0x2b3440,
    geo: (s) => {
      const g = box(s[0], s[1], s[2]);
      const glass = box(s[0] * 0.86, s[1] * 0.5, s[2] * 0.55);
      glass.translate(0, s[1] * 0.22, -s[2] * 0.2);
      return [g, glass];
    },
    glassIndex: 1,
    aero: (s) => ({ type: 'body', area: s[0] * s[1], cd0: 0.06 }),
  },
  cockpit_prop: {
    id: 'cockpit_prop', name: '螺旋桨座舱', cat: 'cockpit', size: [1.2, 1.3, 2.2], mass: 85, cost: 1200, hp: 130, color: 0x3a4652,
    geo: (s) => [box(s[0], s[1], s[2]), (() => { const g = cyl(s[0] * 0.42, s[0] * 0.9, 12); g.rotateZ(Math.PI / 2); g.translate(0, s[1] * 0.55, 0); return g; })()],
    aero: (s) => ({ type: 'body', area: s[0] * s[1], cd0: 0.07 }),
  },
  cockpit_open: {
    id: 'cockpit_open', name: '敞篷座舱', cat: 'cockpit', size: [1.0, 0.8, 1.6], mass: 48, cost: 600, hp: 80, color: 0x4a5560,
    geo: (s) => [box(s[0], s[1] * 0.7, s[2]), (() => { const g = box(s[0] * 0.9, s[1] * 0.5, s[2] * 0.5); g.translate(0, s[1] * 0.5, s[2] * 0.1); return g; })()],
    aero: (s) => ({ type: 'body', area: s[0] * s[1] * 0.7, cd0: 0.12 }),
  },
  cockpit_bubble: {
    id: 'cockpit_bubble', name: '气泡座舱', cat: 'cockpit', size: [1.3, 1.2, 2.2], mass: 92, cost: 1800, hp: 150, color: 0x39424e,
    geo: (s) => [box(s[0], s[1] * 0.8, s[2]), (() => { const g = new THREE.SphereGeometry(Math.min(s[0], s[2]) * 0.55, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2); g.scale(1, 0.75, 1.15); g.translate(0, s[1] * 0.4, 0); return g; })()],
    glassIndex: 1,
    aero: (s) => ({ type: 'body', area: s[0] * s[1], cd0: 0.055 }),
  },

  /* ---------------------------------------------------------- 机身 */
  fuselage_block: {
    id: 'fuselage_block', name: '方形机身', cat: 'fuselage', size: [1.2, 1.2, 2.0], mass: 55, cost: 320, hp: 200, color: 0xd7dde3,
    geo: (s) => box(s[0], s[1], s[2]),
    aero: (s) => ({ type: 'body', area: s[0] * s[1], cd0: 0.05 }),
  },
  fuselage_round: {
    id: 'fuselage_round', name: '圆形机身', cat: 'fuselage', size: [1.2, 1.2, 2.4], mass: 52, cost: 340, hp: 190, color: 0xdfe4ea,
    geo: (s) => { const g = cyl(Math.min(s[0], s[1]) / 2, s[2], 16); g.scale(1, 1, 1); return g; },
    aero: (s) => ({ type: 'body', area: Math.PI / 4 * Math.min(s[0], s[1]) ** 2, cd0: 0.04 }),
  },
  nose_cone: {
    id: 'nose_cone', name: '机鼻锥', cat: 'fuselage', size: [1.1, 1.1, 1.6], mass: 55, cost: 240, hp: 120, color: 0xe6ebf0,
    geo: (s) => noseCone(Math.max(s[0], s[1]) / 2, s[2], 16),
    aero: (s) => ({ type: 'body', area: Math.PI / 4 * Math.max(s[0], s[1]) ** 2, cd0: 0.03 }),
  },
  tail_cone: {
    id: 'tail_cone', name: '尾锥', cat: 'fuselage', size: [1.0, 1.0, 1.8], mass: 45, cost: 200, hp: 110, color: 0xe6ebf0,
    geo: (s) => { const g = noseCone(Math.max(s[0], s[1]) / 2, s[2], 16); g.rotateX(Math.PI); return g; },
    aero: (s) => ({ type: 'body', area: 0.8 * (s[0] * s[1]), cd0: 0.08 }),
  },
  fuselage_half: {
    id: 'fuselage_half', name: '半高机身', cat: 'fuselage', size: [1.4, 0.6, 2.0], mass: 60, cost: 260, hp: 160, color: 0xd7dde3,
    geo: (s) => box(s[0], s[1], s[2]),
    aero: (s) => ({ type: 'body', area: s[0] * s[1], cd0: 0.06 }),
  },
  boom: {
    id: 'boom', name: '尾撑杆', cat: 'fuselage', size: [0.3, 0.3, 3.0], mass: 26, cost: 120, hp: 90, color: 0xb9c2cc,
    geo: (s) => cyl(Math.min(s[0], s[1]) / 2, s[2], 10),
    aero: (s) => ({ type: 'body', area: 0.09, cd0: 0.04 }),
  },

  /* ---------------------------------------------------------- 机翼 */
  wing: {
    id: 'wing', name: '机翼', cat: 'wing', size: [6, 0.22, 1.4], mass: 62, cost: 700, hp: 130, color: 0xe4e9ee,
    mainWing: true,
    props: [
      { key: 'taper', label: '收缩比', min: 0.2, max: 1, step: 0.05, default: 0.75 },
      { key: 'sweep', label: '后掠', min: -2, max: 3, step: 0.1, default: 0 },
      { key: 'dihedral', label: '上反角(°)', min: -15, max: 25, step: 1, default: 4 },
      { key: 'thick', label: '翼型厚度', min: 0.06, max: 0.2, step: 0.01, default: 0.12 },
      { key: 'camber', label: '弯度', min: 0, max: 0.08, step: 0.005, default: 0.02 },
    ],
    geo: (s, p) => wingGeometry(s[0], s[2], p.thick ?? 0.12, p.taper ?? 0.75, p.sweep ?? 0, p.dihedral ?? 4, p.camber ?? 0.02),
    aero: (s, p) => ({ type: 'wing', span: s[0], chord: s[2], area: s[0] * s[2] * (1 + (p.taper ?? 0.75)) / 2, cd0: 0.012, thick: p.thick ?? 0.12, taper: p.taper ?? 0.75, sweep: p.sweep ?? 0, dihedral: p.dihedral ?? 4, control: null }),
    // 视觉控制面
    surface: { chordFrac: 0.3, spanFrac: 0.9, type: 'aileron' },
  },
  wing_delta: {
    id: 'wing_delta', name: '三角翼', cat: 'wing', size: [6, 0.2, 3.2], mass: 78, cost: 820, hp: 130, color: 0xe4e9ee,
    mainWing: true,
    props: [
      { key: 'taper', label: '收缩比', min: 0.05, max: 0.6, step: 0.05, default: 0.15 },
      { key: 'sweep', label: '后掠', min: 1, max: 4, step: 0.1, default: 2.2 },
      { key: 'dihedral', label: '上反角(°)', min: -10, max: 10, step: 1, default: 0 },
      { key: 'thick', label: '翼型厚度', min: 0.05, max: 0.16, step: 0.01, default: 0.08 },
    ],
    geo: (s, p) => wingGeometry(s[0], s[2], p.thick ?? 0.08, p.taper ?? 0.15, p.sweep ?? 2.2, p.dihedral ?? 0, 0.01),
    aero: (s, p) => ({ type: 'wing', span: s[0], chord: s[2], area: s[0] * s[2] * 0.45, cd0: 0.014, thick: p.thick ?? 0.08, taper: p.taper ?? 0.15, sweep: p.sweep ?? 2.2, dihedral: p.dihedral ?? 0, control: null }),
    // 三角翼自身不产俯仰力矩（由升降副翼零件负责），保留 null
    surface: { chordFrac: 0.28, spanFrac: 0.85, type: 'elevon' },
  },
  tailplane: {
    id: 'tailplane', name: '水平尾翼', cat: 'wing', size: [2.6, 0.16, 1.0], mass: 20, cost: 260, hp: 80, color: 0xe4e9ee,
    props: [
      { key: 'taper', label: '收缩比', min: 0.3, max: 1, step: 0.05, default: 0.6 },
      { key: 'sweep', label: '后掠', min: -1, max: 2, step: 0.1, default: 0.5 },
      { key: 'thick', label: '翼型厚度', min: 0.06, max: 0.2, step: 0.01, default: 0.12 },
    ],
    geo: (s, p) => wingGeometry(s[0], s[2], p.thick ?? 0.12, p.taper ?? 0.6, p.sweep ?? 0.5, 0, 0),
    aero: (s, p) => ({ type: 'wing', span: s[0], chord: s[2], area: s[0] * s[2] * (1 + (p.taper ?? 0.6)) / 2, cd0: 0.014, thick: p.thick ?? 0.12, taper: p.taper ?? 0.6, sweep: p.sweep ?? 0.5, dihedral: 0, control: 'elevator' }),
    surface: { chordFrac: 0.35, spanFrac: 0.95, type: 'elevator' },
  },
  fin: {
    id: 'fin', name: '垂直尾翼', cat: 'wing', size: [1.5, 0.16, 1.2], mass: 17, cost: 240, hp: 80, color: 0xe4e9ee,
    props: [
      { key: 'taper', label: '收缩比', min: 0.3, max: 1, step: 0.05, default: 0.55 },
      { key: 'sweep', label: '后掠', min: 0, max: 2.5, step: 0.1, default: 1.0 },
      { key: 'thick', label: '翼型厚度', min: 0.06, max: 0.2, step: 0.01, default: 0.1 },
    ],
    geo: (s, p) => { const g = wingGeometry(s[0], s[2], p.thick ?? 0.1, p.taper ?? 0.55, p.sweep ?? 1.0, 0, 0); g.rotateZ(Math.PI / 2); return g; },
    aero: (s, p) => ({ type: 'wing', span: s[0], chord: s[2], area: s[0] * s[2] * (1 + (p.taper ?? 0.55)) / 2, cd0: 0.014, thick: p.thick ?? 0.1, taper: p.taper ?? 0.55, sweep: p.sweep ?? 1.0, dihedral: 90, control: 'rudder' }),
    surface: { chordFrac: 0.35, spanFrac: 0.95, type: 'rudder' },
  },
  canard: {
    id: 'canard', name: '鸭翼', cat: 'wing', size: [2.2, 0.14, 0.9], mass: 16, cost: 300, hp: 75, color: 0xe4e9ee,
    props: [
      { key: 'taper', label: '收缩比', min: 0.3, max: 1, step: 0.05, default: 0.6 },
      { key: 'sweep', label: '后掠', min: 0, max: 2, step: 0.1, default: 1.0 },
    ],
    geo: (s, p) => wingGeometry(s[0], s[2], 0.1, p.taper ?? 0.6, p.sweep ?? 1.0, 0, 0.02),
    aero: (s, p) => ({ type: 'wing', span: s[0], chord: s[2], area: s[0] * s[2] * 0.8, cd0: 0.014, thick: 0.1, taper: p.taper ?? 0.6, sweep: p.sweep ?? 1.0, dihedral: 0, control: 'elevator' }),
    surface: { chordFrac: 0.32, spanFrac: 0.9, type: 'elevator' },
  },

  /* ---------------------------------------------------------- 控制面（独立） */
  aileron: {
    id: 'aileron', name: '副翼', cat: 'control', size: [1.4, 0.1, 0.5], mass: 16, cost: 120, hp: 45, color: 0xcfd8e0,
    geo: (s) => wingGeometry(s[0], s[2], 0.1, 1, 0, 0, 0),
    aero: (s) => ({ type: 'wing', span: s[0], chord: s[2], area: s[0] * s[2], cd0: 0.02, thick: 0.1, taper: 1, sweep: 0, dihedral: 0, control: 'aileron' }),
    surface: { chordFrac: 0.6, spanFrac: 1, type: 'aileron' },
  },
  elevator: {
    id: 'elevator', name: '升降舵', cat: 'control', size: [1.6, 0.1, 0.5], mass: 16, cost: 120, hp: 45, color: 0xcfd8e0,
    geo: (s) => wingGeometry(s[0], s[2], 0.1, 1, 0, 0, 0),
    aero: (s) => ({ type: 'wing', span: s[0], chord: s[2], area: s[0] * s[2], cd0: 0.02, thick: 0.1, taper: 1, sweep: 0, dihedral: 0, control: 'elevator' }),
    surface: { chordFrac: 0.6, spanFrac: 1, type: 'elevator' },
  },
  rudder: {
    id: 'rudder', name: '方向舵', cat: 'control', size: [1.2, 0.1, 0.6], mass: 14, cost: 120, hp: 45, color: 0xcfd8e0,
    geo: (s) => { const g = wingGeometry(s[0], s[2], 0.1, 1, 0, 0, 0); g.rotateZ(Math.PI / 2); return g; },
    aero: (s) => ({ type: 'wing', span: s[0], chord: s[2], area: s[0] * s[2], cd0: 0.02, thick: 0.1, taper: 1, sweep: 0, dihedral: 90, control: 'rudder' }),
    surface: { chordFrac: 0.6, spanFrac: 1, type: 'rudder' },
  },
  flap: {
    id: 'flap', name: '襟翼', cat: 'control', size: [1.6, 0.1, 0.55], mass: 18, cost: 140, hp: 45, color: 0xcfd8e0,
    geo: (s) => wingGeometry(s[0], s[2], 0.12, 1, 0, 0, 0.03),
    aero: (s) => ({ type: 'wing', span: s[0], chord: s[2], area: s[0] * s[2], cd0: 0.02, thick: 0.12, taper: 1, sweep: 0, dihedral: 0, control: 'flap' }),
    surface: { chordFrac: 0.55, spanFrac: 1, type: 'flap' },
  },
  airbrake: {
    id: 'airbrake', name: '减速板', cat: 'control', size: [1.2, 0.08, 0.8], mass: 20, cost: 180, hp: 50, color: 0x8d99a6,
    geo: (s) => box(s[0], s[1], s[2]),
    aero: (s) => ({ type: 'plate', span: s[0], chord: s[2], area: s[0] * s[2], cd0: 0.9, control: 'airbrake' }),
  },

  /* ---------------------------------------------------------- 动力 */
  engine_prop: {
    id: 'engine_prop', name: '活塞发动机', cat: 'power', size: [0.9, 0.9, 1.2], mass: 155, cost: 2600, hp: 120, color: 0x2f3742,
    props: [
      { key: 'cylinders', label: '气缸数', min: 2, max: 12, step: 1, default: 4 },
      { key: 'power', label: '排量/功率', min: 0.5, max: 2.5, step: 0.05, default: 1 },
    ],
    geo: (s, p) => {
      const parts = [cyl(Math.min(s[0], s[1]) * 0.45, s[2], 12)];
      const n = Math.round(clamp(p.cylinders ?? 4, 2, 12));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const g = new THREE.CylinderGeometry(s[0] * 0.1, s[0] * 0.1, s[1] * 0.55, 6);
        g.translate(Math.cos(a) * s[0] * 0.42, 0, Math.sin(a) * s[0] * 0.42);
        parts.push(g);
      }
      return parts;
    },
    engine: (s, p) => { const pw = 90000 * (p.power ?? 1) * (1 + (p.cylinders ?? 4) * 0.05); return { type: 'prop', power: pw, staticThrust: pw / 32, vMax: 108, maxRpm: 2800, propRadius: 1.0, fuelRate: 0.012 * (p.power ?? 1) }; },
  },
  engine_jet: {
    id: 'engine_jet', name: '涡喷发动机', cat: 'power', size: [0.95, 0.95, 2.4], mass: 320, cost: 5200, hp: 150, color: 0x39424e,
    props: [{ key: 'power', label: '推力等级', min: 0.4, max: 3, step: 0.05, default: 1 }],
    geo: (s) => {
      const r = Math.min(s[0], s[1]) / 2;
      const parts = [cyl(r, s[2], 16), (() => { const g = new THREE.TorusGeometry(r * 0.98, r * 0.14, 8, 18); return g; })()];
      const inner = cyl(r * 0.72, s[2] * 1.04, 14);
      parts.push(inner);
      return parts;
    },
    engine: (s, p) => { const t = 26000 * (p.power ?? 1); return { type: 'jet', thrust: t, staticThrust: t, vMax: 360, maxRpm: 1, fuelRate: 0.02 * (p.power ?? 1) }; },
  },
  engine_turboprop: {
    id: 'engine_turboprop', name: '涡桨发动机', cat: 'power', size: [0.9, 0.9, 2.0], mass: 260, cost: 4400, hp: 140, color: 0x39424e,
    props: [{ key: 'power', label: '功率等级', min: 0.5, max: 2.5, step: 0.05, default: 1 }],
    geo: (s) => [cyl(Math.min(s[0], s[1]) / 2, s[2], 14), noseCone(Math.min(s[0], s[1]) / 2 * 0.8, s[2] * 0.4, 12)],
    engine: (s, p) => { const pw = 160000 * (p.power ?? 1); return { type: 'turboprop', power: pw, staticThrust: pw / 30, vMax: 155, maxRpm: 2000, propRadius: 1.4, fuelRate: 0.016 * (p.power ?? 1) }; },
  },
  engine_electric: {
    id: 'engine_electric', name: '电动机', cat: 'power', size: [0.5, 0.5, 0.7], mass: 60, cost: 1800, hp: 80, color: 0x2a3340,
    props: [{ key: 'power', label: '功率等级', min: 0.4, max: 2, step: 0.05, default: 1 }],
    geo: (s) => cyl(Math.min(s[0], s[1]) / 2, s[2], 12),
    engine: (s, p) => { const pw = 45000 * (p.power ?? 1); return { type: 'electric', power: pw, staticThrust: pw / 40, vMax: 82, maxRpm: 3000, propRadius: 0.8, fuelRate: 0.004, battery: 200 }; },
  },
  propeller: {
    id: 'propeller', name: '螺旋桨', cat: 'power', size: [0.25, 1.2, 1.2], mass: 34, cost: 420, hp: 60, color: 0x22262c,
    props: [{ key: 'blades', label: '桨叶数', min: 2, max: 6, step: 1, default: 3 }],
    geo: (s, p) => {
      const n = Math.round(clamp(p.blades ?? 3, 2, 6));
      const arr = [cyl(s[0] * 0.5, s[0] * 1.2, 8)];
      for (let i = 0; i < n; i++) {
        const g = wingGeometry(s[1], s[1] * 0.22, 0.12, 0.6, 0, 0, 0.04);
        g.rotateZ((i / n) * Math.PI * 2);
        g.scale(1, 1, 1);
        arr.push(g);
      }
      return arr;
    },
    isPropeller: true,
  },
  ducted_fan: {
    id: 'ducted_fan', name: '涵道风扇', cat: 'power', size: [1.3, 1.3, 0.6], mass: 70, cost: 900, hp: 70, color: 0x2b333d,
    geo: (s) => [cyl(Math.min(s[0], s[1]) / 2, s[2], 16), (() => { const g = new THREE.TorusGeometry(Math.min(s[0], s[1]) / 2, 0.07, 8, 20); return g; })()],
    isPropeller: true, fanThrust: 9000,
  },
  transmission: {
    id: 'transmission', name: '变速箱', cat: 'power', size: [0.6, 0.6, 0.8], mass: 90, cost: 1400, hp: 90, color: 0x3d4653,
    props: [{ key: 'gears', label: '档位数', min: 1, max: 6, step: 1, default: 3 }],
    geo: (s) => box(s[0], s[1], s[2]),
    transmission: (s, p) => ({ gears: Math.round(p.gears ?? 3) }),
  },
  rocket: {
    id: 'rocket', name: '火箭助推器', cat: 'power', size: [0.5, 0.5, 1.6], mass: 120, cost: 1500, hp: 70, color: 0x9aa4ae,
    props: [{ key: 'boost', label: '推力', min: 0.5, max: 3, step: 0.1, default: 1 }],
    geo: (s) => [cyl(Math.min(s[0], s[1]) / 2, s[2], 12), noseCone(Math.min(s[0], s[1]) / 2, s[2] * 0.5, 12)],
    engine: (s, p) => { const t = 24000 * (p.boost ?? 1); return { type: 'rocket', thrust: t, staticThrust: t, vMax: 400, fuelRate: 0.14, burnTime: 14 }; },
  },

  /* ---------------------------------------------------------- 起落架 */
  gear_fixed: {
    id: 'gear_fixed', name: '固定起落架', cat: 'gear', size: [0.16, 0.7, 0.16], mass: 22, cost: 260, hp: 60, color: 0x8b95a1,
    props: [{ key: 'wheelSize', label: '机轮直径', min: 0.24, max: 0.9, step: 0.02, default: 0.44 }],
    geo: (s, p) => {
      const wr = (p.wheelSize ?? 0.44) / 2;
      const strut = box(s[0], s[1] * 0.78, s[2]);
      strut.translate(0, s[1] * 0.11, 0);
      const axle = box(s[0] * 0.5, s[0] * 0.5, s[2] * 2.2);
      axle.translate(0, -s[1] * 0.39, 0);
      const wheel = new THREE.CylinderGeometry(wr, wr, s[0] * 1.5, 14);
      wheel.rotateZ(Math.PI / 2);
      wheel.translate(0, -s[1] * 0.39, 0);
      return [strut, axle, wheel];
    },
    gear: (s, p) => ({ radius: s[1] * 0.39 + (p.wheelSize ?? 0.44) / 2, travel: 0.26, stiffness: 34000, damping: 6800, retractable: false }),
  },
  gear_retract: {
    id: 'gear_retract', name: '可收放起落架', cat: 'gear', size: [0.18, 0.9, 0.18], mass: 34, cost: 720, hp: 70, color: 0x79838f,
    props: [{ key: 'wheelSize', label: '机轮直径', min: 0.24, max: 1.0, step: 0.02, default: 0.5 }],
    geo: (s, p) => {
      const wr = (p.wheelSize ?? 0.5) / 2;
      const strut = box(s[0], s[1] * 0.8, s[2]);
      strut.translate(0, s[1] * 0.1, 0);
      const door = box(s[0] * 0.5, s[1] * 0.8, s[2] * 0.4);
      door.translate(s[0] * 0.7, s[1] * 0.1, 0);
      const wheel = new THREE.CylinderGeometry(wr, wr, s[0] * 1.5, 14);
      wheel.rotateZ(Math.PI / 2);
      wheel.translate(0, -s[1] * 0.4, 0);
      return [strut, door, wheel];
    },
    gear: (s, p) => ({ radius: s[1] * 0.4 + (p.wheelSize ?? 0.5) / 2, travel: 0.34, stiffness: 42000, damping: 8200, retractable: true }),
  },
  wheel: {
    id: 'wheel', name: '轮胎', cat: 'gear', size: [0.22, 0.6, 0.6], mass: 26, cost: 180, hp: 60, color: 0x1b1e22,
    props: [{ key: 'size', label: '轮胎直径', min: 0.3, max: 1.6, step: 0.05, default: 0.6 }],
    geo: (s, p) => { const r = (p.size ?? 0.6) / 2; const g = new THREE.CylinderGeometry(r, r, s[0], 16); g.rotateZ(Math.PI / 2); return g; },
    gear: (s, p) => ({ radius: (p.size ?? 0.6) / 2, travel: 0.18, stiffness: 26000, damping: 5200, retractable: false, powered: true }),
  },
  ski: {
    id: 'ski', name: '雪橇', cat: 'gear', size: [0.3, 0.12, 1.6], mass: 24, cost: 200, hp: 55, color: 0xb6c0cb,
    geo: (s) => { const g = box(s[0], s[1], s[2]); const tip = noseCone(s[0] * 0.6, s[2] * 0.3, 8); tip.rotateX(-Math.PI / 2); tip.translate(0, 0, -s[2] * 0.6); return [g, tip]; },
    gear: (s) => ({ radius: 0.2, travel: 0.24, stiffness: 34000, damping: 6000, retractable: false, ski: true }),
  },
  float: {
    id: 'float', name: '浮筒', cat: 'gear', size: [0.6, 0.5, 2.6], mass: 60, cost: 640, hp: 90, color: 0xdadfe5,
    geo: (s) => { const g = cyl(Math.min(s[0], s[1]) / 2, s[2], 12); g.scale(1, 1, 1); const nose = noseCone(Math.min(s[0], s[1]) / 2, s[2] * 0.45, 12); nose.translate(0, 0, -s[2] * 0.7); return [g, nose]; },
    gear: (s) => ({ radius: 0.26, travel: 0.3, stiffness: 46000, damping: 8600, retractable: false, float: true }),
  },

  /* ---------------------------------------------------------- 燃油 */
  fuel_tank: {
    id: 'fuel_tank', name: '油箱', cat: 'fuel', size: [1.0, 0.7, 1.6], mass: 26, cost: 300, hp: 110, color: 0xb0b8c0,
    props: [{ key: 'capacity', label: '容量(L)', min: 40, max: 2000, step: 20, default: 300 }],
    geo: (s) => box(s[0], s[1], s[2]),
    fuel: (s, p) => ({ capacity: p.capacity ?? 300 }),
    aero: (s) => ({ type: 'body', area: s[0] * s[1], cd0: 0.05 }),
  },
  drop_tank: {
    id: 'drop_tank', name: '副油箱', cat: 'fuel', size: [0.6, 0.6, 2.0], mass: 30, cost: 260, hp: 70, color: 0xc4ccd4,
    props: [{ key: 'capacity', label: '容量(L)', min: 50, max: 800, step: 10, default: 300 }],
    geo: (s) => cyl(Math.min(s[0], s[1]) / 2, s[2], 12),
    fuel: (s, p) => ({ capacity: p.capacity ?? 300, jettison: true }),
  },
  battery: {
    id: 'battery', name: '电池组', cat: 'fuel', size: [0.7, 0.5, 1.0], mass: 80, cost: 900, hp: 90, color: 0x2f3b47,
    props: [{ key: 'capacity', label: '电量(kWh)', min: 20, max: 400, step: 10, default: 120 }],
    geo: (s) => box(s[0], s[1], s[2]),
    fuel: (s, p) => ({ capacity: (p.capacity ?? 120) * 0.6, electric: true }),
  },

  /* ---------------------------------------------------------- 武器 */
  cannon: {
    id: 'cannon', name: '机炮', cat: 'weapon', size: [0.24, 0.24, 2.0], mass: 90, cost: 1200, hp: 60, color: 0x2b2f34,
    props: [{ key: 'caliber', label: '口径(mm)', min: 12, max: 40, step: 1, default: 20 }],
    geo: (s) => [cyl(s[0] * 0.5, s[2], 10), (() => { const g = cyl(s[0] * 0.75, s[2] * 0.4, 10); g.translate(0, 0, s[2] * 0.3); return g; })()],
    weapon: (s, p) => ({ type: 'gun', rpm: 900, speed: 900, damage: 6 + (p.caliber ?? 20) * 0.5, spread: 0.006, ammo: 1200 }),
  },
  machine_gun: {
    id: 'machine_gun', name: '机枪', cat: 'weapon', size: [0.16, 0.16, 1.2], mass: 32, cost: 520, hp: 40, color: 0x33383e,
    geo: (s) => cyl(s[0] * 0.5, s[2], 8),
    weapon: (s) => ({ type: 'gun', rpm: 1400, speed: 850, damage: 4, spread: 0.012, ammo: 2000 }),
  },
  missile_rail: {
    id: 'missile_rail', name: '导弹挂架', cat: 'weapon', size: [0.3, 0.2, 1.6], mass: 34, cost: 500, hp: 50, color: 0x555f6b,
    props: [{ key: 'missiles', label: '挂弹数', min: 1, max: 4, step: 1, default: 2 }],
    geo: (s, p) => {
      const arr = [box(s[0], s[1], s[2])];
      const n = Math.round(clamp(p.missiles ?? 2, 1, 4));
      for (let i = 0; i < n; i++) {
        const m = new THREE.Group();
        const body = cyl(0.09, 1.4, 8); body.translate(0, 0, 0);
        arr.push(body);
      }
      return arr;
    },
    weapon: (s, p) => ({ type: 'missile', count: Math.round(p.missiles ?? 2), damage: 90, guidance: 'ir', speed: 320, life: 22 }),
  },
  bomb: {
    id: 'bomb', name: '炸弹', cat: 'weapon', size: [0.36, 0.36, 1.3], mass: 140, cost: 900, hp: 60, color: 0x4e5660,
    props: [{ key: 'count', label: '数量', min: 1, max: 6, step: 1, default: 2 }],
    geo: (s) => [cyl(Math.min(s[0], s[1]) / 2, s[2], 10), (() => { const g = noseCone(Math.min(s[0], s[1]) / 2, s[2] * 0.4, 10); g.translate(0, 0, -s[2] * 0.65); return g; })()],
    weapon: (s, p) => ({ type: 'bomb', count: Math.round(p.count ?? 2), damage: 160 }),
  },
  flare: {
    id: 'flare', name: '干扰弹发射器', cat: 'weapon', size: [0.3, 0.3, 0.6], mass: 28, cost: 700, hp: 45, color: 0x4a525c,
    geo: (s) => box(s[0], s[1], s[2]),
    weapon: (s) => ({ type: 'flare', count: 24 }),
  },

  /* ---------------------------------------------------------- 其它 */
  decoupler: {
    id: 'decoupler', name: '分离器', cat: 'misc', size: [1.0, 1.0, 0.25], mass: 26, cost: 300, hp: 80, color: 0xffb347,
    geo: (s) => box(s[0], s[1], s[2]),
    decoupler: true,
  },
  parachute: {
    id: 'parachute', name: '降落伞', cat: 'misc', size: [0.3, 0.3, 0.5], mass: 18, cost: 320, hp: 40, color: 0xd9dee3,
    geo: (s) => cyl(s[0] * 0.5, s[2], 8),
    chute: { drag: 900 },
  },
  cargo_box: {
    id: 'cargo_box', name: '货箱', cat: 'misc', size: [1.1, 1.0, 1.4], mass: 120, cost: 200, hp: 120, color: 0x9c7b4a,
    geo: (s) => box(s[0], s[1], s[2]),
    cargo: true, aero: (s) => ({ type: 'body', area: s[0] * s[1], cd0: 0.3 }),
  },
  seat: {
    id: 'seat', name: '座椅/飞行员', cat: 'misc', size: [0.5, 0.9, 0.5], mass: 85, cost: 150, hp: 50, color: 0x2f6f4f,
    geo: (s) => [box(s[0], s[1] * 0.4, s[2]), (() => { const g = box(s[0] * 0.9, s[1] * 0.55, s[2] * 0.3); g.translate(0, s[1] * 0.4, s[2] * 0.3); return g; })()],
    pilot: true,
  },
  light: {
    id: 'light', name: '航行灯', cat: 'misc', size: [0.16, 0.16, 0.16], mass: 4, cost: 90, hp: 15, color: 0xfff2b0,
    geo: (s) => new THREE.SphereGeometry(Math.max(s[0], s[1]) * 0.5, 10, 8),
    light: true,
  },
  antenna: {
    id: 'antenna', name: '天线', cat: 'misc', size: [0.08, 0.9, 0.08], mass: 6, cost: 70, hp: 20, color: 0x9aa3ad,
    geo: (s) => cyl(s[0] * 0.5, s[1], 6),
  },
  radar: {
    id: 'radar', name: '雷达罩', cat: 'misc', size: [0.8, 0.5, 0.8], mass: 32, cost: 800, hp: 60, color: 0xbfc7cf,
    geo: (s) => { const g = new THREE.SphereGeometry(Math.min(s[0], s[2]) * 0.5, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2); g.scale(1, 0.6, 1); return g; },
    radar: true,
  },
  weight: {
    id: 'weight', name: '配重块', cat: 'misc', size: [0.5, 0.3, 0.5], mass: 200, cost: 60, hp: 80, color: 0x6d7681,
    props: [{ key: 'mass', label: '质量(kg)', min: 10, max: 800, step: 10, default: 200 }],
    geo: (s) => box(s[0], s[1], s[2]),
  },
  pilot_chad: {
    id: 'pilot_chad', name: 'Major Chad', cat: 'misc', size: [0.6, 1.8, 0.6], mass: 92, cost: 0, hp: 60, color: 0x3a7d4f,
    geo: (s) => {
      const parts = [];
      const torso = box(s[0] * 0.9, s[1] * 0.34, s[2] * 0.7); torso.translate(0, s[1] * 0.12, 0); parts.push(torso);
      const head = new THREE.SphereGeometry(s[0] * 0.42, 12, 10); head.translate(0, s[1] * 0.36, 0); parts.push(head);
      const legL = box(s[0] * 0.3, s[1] * 0.4, s[2] * 0.3); legL.translate(-s[0] * 0.22, -s[1] * 0.3, 0); parts.push(legL);
      const legR = box(s[0] * 0.3, s[1] * 0.4, s[2] * 0.3); legR.translate(s[0] * 0.22, -s[1] * 0.3, 0); parts.push(legR);
      const armL = box(s[0] * 0.2, s[1] * 0.32, s[2] * 0.22); armL.translate(-s[0] * 0.58, s[1] * 0.12, 0); parts.push(armL);
      const armR = box(s[0] * 0.2, s[1] * 0.32, s[2] * 0.22); armR.translate(s[0] * 0.58, s[1] * 0.12, 0); parts.push(armR);
      return parts;
    },
    pilot: true, isChad: true,
  },
};

/** 便捷：取得某个零件的默认属性 */
export function defaultProps(defId) {
  const d = PART_DEFS[defId]; const o = {};
  (d?.props || []).forEach((p) => { o[p.key] = p.default; });
  return o;
}

/** 创建一个零件实例 */
export function makePart(defId, pos = [0, 0, 0], rot = [0, 0, 0], opts = {}) {
  const d = PART_DEFS[defId];
  if (!d) throw new Error('未知零件: ' + defId);
  return {
    uid: opts.uid ?? (makePart._n = (makePart._n || 0) + 1),
    def: defId,
    pos: pos.slice(), rot: rot.slice(),
    size: (opts.size ?? d.size).slice(),
    color: opts.color ?? '#' + new THREE.Color(d.color).getHexString(),
    props: { ...defaultProps(defId), ...(opts.props || {}) },
    attachedTo: opts.attachedTo ?? null,
  };
}

/** 零件质量（kg），考虑尺寸与 props */
export function partMass(part) {
  const d = PART_DEFS[part.def]; if (!d) return 0;
  let m = d.mass;
  const base = d.size;
  if (d.cat === 'wing' || d.cat === 'control') {
    // 翼面按平面面积缩放（包围盒体积会严重高估）
    m *= (part.size[0] * part.size[2]) / Math.max(1e-6, base[0] * base[2]);
  } else {
    m *= (part.size[0] * part.size[1] * part.size[2]) / Math.max(1e-6, base[0] * base[1] * base[2]);
  }
  if (d.props?.some((p) => p.key === 'mass')) m = part.props.mass ?? m;
  if (d.fuel) m += (part.props.capacity ?? 300) * 0.8; // 满油
  if (d.weapon?.type === 'missile') m += (part.props.missiles ?? 2) * 90;
  if (d.weapon?.type === 'bomb') m += (part.props.count ?? 2) * 140;
  return Math.max(1, m);
}
export function partCost(part) {
  const d = PART_DEFS[part.def]; if (!d) return 0;
  let c = d.cost;
  if (d.engine) c *= (part.props.power ?? part.props.boost ?? 1);
  if (d.fuel) c += (part.props.capacity ?? 300) * 1.2;
  if (d.weapon) c += ((part.props.missiles ?? part.props.count ?? 0) * 400);
  return Math.round(c);
}

/** 生成零件网格（不加入场景），返回 THREE.Group */
export function buildPartMesh(part, opts = {}) {
  const d = PART_DEFS[part.def];
  const group = new THREE.Group();
  group.name = 'part:' + part.def + ':' + part.uid;
  if (!d) return group;
  let geos = [];
  try { geos = d.geo(part.size, part.props) || []; } catch (e) { console.warn('[parts] geo 失败', part.def, e); geos = [box(...part.size)]; }
  if (!Array.isArray(geos)) geos = [geos];

  const color = new THREE.Color(part.color || '#c9d3dd');
  geos.forEach((g, i) => {
    if (!g) return;
    let mat;
    if (d.glassIndex === i) {
      mat = getMaterial({ color: 0x88c4e0, metalness: 0.1, roughness: 0.05, opacity: 0.4, side: THREE.DoubleSide });
    } else if (d.light && i === 0) {
      mat = new THREE.MeshStandardMaterial({ color: color, emissive: color, emissiveIntensity: 2.2, metalness: 0.2, roughness: 0.3 });
    } else if (d.isPropeller && i > 0) {
      mat = getMaterial({ color: 0x1c2026, metalness: 0.5, roughness: 0.4 });
    } else if (opts.painted !== false) {
      mat = getMaterial({ color: color.getHex(), metalness: 0.42, roughness: 0.42 });
    } else {
      mat = getMaterial({ color: 0xbfc7cf, metalness: 0.6, roughness: 0.4 });
    }
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = opts.shadows !== false;
    mesh.receiveShadow = true;
    mesh.userData.partIndex = i;
    group.add(mesh);
  });
  group.userData.part = part;
  return group;
}

/** 取得零件的功能描述聚合 */
export function partFeatures(part) {
  const d = PART_DEFS[part.def]; if (!d) return {};
  return {
    mainWing: !!d.mainWing,
    aero: d.aero ? d.aero(part.size, part.props) : null,
    engine: d.engine ? d.engine(part.size, part.props) : null,
    fuel: d.fuel ? d.fuel(part.size, part.props) : null,
    gear: d.gear ? d.gear(part.size, part.props) : null,
    weapon: d.weapon ? d.weapon(part.size, part.props) : null,
    chute: d.chute || null,
    decoupler: !!d.decoupler,
    cargo: !!d.cargo,
    pilot: !!d.pilot,
    transmission: d.transmission ? d.transmission(part.size, part.props) : null,
  };
}

/** 渲染机翼的可动控制面（视觉），返回 { mesh, axis, hinge } 或 null */
export function buildControlSurface(part) {
  const d = PART_DEFS[part.def];
  if (!d?.surface) return null;
  const { chordFrac, spanFrac, type } = d.surface;
  const span = part.size[0] * spanFrac, chord = part.size[2] * chordFrac;
  const isVertical = type === 'rudder';
  const geo = wingGeometry(span, chord, 0.12, 0.9, 0, 0, 0.01);
  const mat = getMaterial({ color: new THREE.Color(part.color || '#cfd8e0').multiplyScalar(0.85).getHex(), metalness: 0.5, roughness: 0.4 });
  const mesh = new THREE.Mesh(geo, mat);
  // 铰链位于.75 弦处
  const hinge = new THREE.Group();
  mesh.position.z = part.size[2] * (0.5 - chordFrac / 2) - part.size[2] * 0.25;
  hinge.add(mesh);
  if (isVertical) hinge.rotation.y = Math.PI / 2;
  hinge.userData.controlType = type;
  return hinge;
}
